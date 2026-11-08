//! `push`: uploads the closure of some installables, skipping paths the server
//! already has and, by default, paths signed by the cache's upstream caches.

use anyhow::{Context as _, Result};
use cf_nix_cache_core::{
    contracts::{api as contract, responses::CacheUpstreamsResponse},
    CacheName, MissingPathsResponse, UploadStatus,
};
use reqwest::Method;
use std::{
    collections::{BTreeMap, BTreeSet},
    future::Future,
    num::NonZeroUsize,
    sync::Arc,
};
use tokio::task::JoinSet;

use crate::{
    client::Api,
    encoded_upload::{
        is_server_too_old, upload_encoded, upload_encoded_batch, BATCH_NAR_SIZE, BATCH_PATHS,
    },
    nix::{path_info, signed_by_upstream, store_hash, PathInfo},
    upload::wait_for_state,
};

pub(super) async fn push(
    api: Api,
    cache: CacheName,
    installables: Vec<String>,
    jobs: NonZeroUsize,
    ignore_upstream_cache_filter: bool,
) -> Result<()> {
    let mut map = path_info(&installables)?;
    let all_paths = map.len();
    if !ignore_upstream_cache_filter {
        let upstreams = upstream_key_names(&api, &cache).await?;
        map.retain(|_, info| !signed_by_upstream(info, &upstreams));
    }
    let in_upstream = all_paths - map.len();
    let considered = map.len();
    let hashes = map
        .keys()
        .map(|path| store_hash(path))
        .collect::<Result<Vec<_>>>()?;
    let mut missing = BTreeSet::new();
    let mut pending = BTreeMap::new();
    for batch in hashes.chunks(100) {
        let body = contract::MissingPaths {
            store_hashes: batch
                .iter()
                .map(|hash| hash.parse())
                .collect::<Result<_, _>>()?,
        };
        let result: MissingPathsResponse = api
            .request(
                Method::POST,
                &format!("/api/caches/{cache}/missing"),
                Some(&body),
            )
            .await?;
        missing.extend(result.missing);
        pending.extend(
            result
                .pending
                .into_iter()
                .map(|upload| (upload.store_hash, upload.upload_id)),
        );
    }
    let mut uploads = Vec::new();
    let mut waits = Vec::new();
    for (path, info) in map {
        let hash = store_hash(&path)?;
        if missing.contains(&hash) {
            uploads.push((path, info));
        } else if let Some(id) = pending.remove(&hash) {
            waits.push(Work::Wait(path, info, id));
        } else {
            println!("already cached {path}");
        }
    }
    let total = uploads.len() + waits.len();
    println!(
        "pushing {total} paths to \"{cache}\" ({} already cached, {in_upstream} in upstream, {} already being uploaded)",
        considered - total,
        waits.len(),
    );
    let work = plan(uploads, waits);
    let context = Arc::new(Context { api, cache });
    let failures = run_concurrently(work, jobs, move |work| {
        let context = Arc::clone(&context);
        async move { context.run(work).await }
    })
    .await;
    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("{failure:#}");
        }
        anyhow::bail!("{} of {total} uploads failed", failures.len());
    }
    Ok(())
}

enum Work {
    One(String, PathInfo),
    /// Small paths that are uploaded together.
    Batch(Vec<(String, PathInfo)>),
    /// A path another push is uploading.
    Wait(String, PathInfo, String),
}

/// Large paths first, so that they do not start last and finish alone.
fn plan(mut uploads: Vec<(String, PathInfo)>, waits: Vec<Work>) -> Vec<Work> {
    uploads.sort_by_key(|(_, info)| std::cmp::Reverse(info.nar_size));
    let split = uploads.partition_point(|(_, info)| info.nar_size >= BATCH_NAR_SIZE);
    let small = uploads.split_off(split);
    let mut work: Vec<Work> = uploads
        .into_iter()
        .map(|(path, info)| Work::One(path, info))
        .collect();
    work.extend(
        small
            .chunks(BATCH_PATHS)
            .map(|batch| Work::Batch(batch.to_vec())),
    );
    work.extend(waits);
    work
}

struct Context {
    api: Api,
    cache: CacheName,
}

impl Context {
    /// Every failure, one per path.
    async fn run(&self, work: Work) -> Vec<anyhow::Error> {
        match work {
            Work::One(path, info) => self.one(&path, &info).await.err().into_iter().collect(),
            Work::Batch(items) => self.batch(items).await,
            Work::Wait(path, info, id) => {
                match wait_for_state(&self.api, &id, &path).await {
                    Ok(state) if state.status == UploadStatus::Ready => {
                        println!("uploaded {path} (by another push)");
                        Vec::new()
                    }
                    // The other push failed, or its upload is gone: do it here.
                    _ => self.one(&path, &info).await.err().into_iter().collect(),
                }
            }
        }
    }

    async fn one(&self, path: &str, info: &PathInfo) -> Result<()> {
        upload_encoded(&self.api, &self.cache, path, info)
            .await
            .with_context(|| format!("failed to upload {path}"))
    }

    async fn batch(&self, items: Vec<(String, PathInfo)>) -> Vec<anyhow::Error> {
        let mut failures = Vec::new();
        match upload_encoded_batch(&self.api, &self.cache, &items).await {
            Ok(outcomes) => {
                for (path, outcome) in outcomes {
                    if let Err(error) = outcome {
                        failures.push(error.context(format!("failed to upload {path}")));
                    }
                }
                return failures;
            }
            Err(error) if is_server_too_old(&error) => {
                return items
                    .into_iter()
                    .map(|(path, _)| anyhow::anyhow!("failed to upload {path}: {error:#}"))
                    .collect();
            }
            // One bad path fails a whole batch; find it by going one by one.
            Err(error) => {
                eprintln!("batch upload failed, retrying its paths one by one: {error:#}")
            }
        }
        for (path, info) in items {
            if let Err(error) = self.one(&path, &info).await {
                failures.push(error);
            }
        }
        failures
    }
}

async fn upstream_key_names(api: &Api, cache: &CacheName) -> Result<Vec<String>> {
    match api
        .get::<CacheUpstreamsResponse>(&format!("/api/caches/{cache}/upstreams"))
        .await
    {
        Ok(response) => Ok(response
            .upstream_cache_key_names
            .into_iter()
            .map(String::from)
            .collect()),
        // An older server has no such route. Uploading everything is only
        // wasteful, and a missing cache still fails on the next request.
        Err(error) if error.to_string().starts_with("API returned 404") => {
            eprintln!("warning: server did not report upstream caches, so none are skipped");
            Ok(Vec::new())
        }
        Err(error) => Err(error),
    }
}

/// Runs `task` over `items` with at most `limit` running at once. A failure
/// does not stop the remaining items, since every completed upload is progress
/// that a retry does not have to repeat. Returns the errors.
async fn run_concurrently<T, F, Fut>(
    items: Vec<T>,
    limit: NonZeroUsize,
    task: F,
) -> Vec<anyhow::Error>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Vec<anyhow::Error>> + Send + 'static,
{
    let mut running = JoinSet::new();
    let mut failures = Vec::new();
    for item in items {
        if running.len() == limit.get() {
            collect_failures(running.join_next().await, &mut failures);
        }
        running.spawn(task(item));
    }
    while let Some(result) = running.join_next().await {
        collect_failures(Some(result), &mut failures);
    }
    failures
}

fn collect_failures(
    result: Option<Result<Vec<anyhow::Error>, tokio::task::JoinError>>,
    failures: &mut Vec<anyhow::Error>,
) {
    match result {
        Some(Ok(errors)) => failures.extend(errors),
        Some(Err(error)) => failures.push(error.into()),
        None => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn run_concurrently_uses_but_never_exceeds_the_limit() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let failures = run_concurrently(
            (0..20).collect(),
            NonZeroUsize::new(4).unwrap(),
            |_: i32| {
                let running = Arc::clone(&running);
                let peak = Arc::clone(&peak);
                async move {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    running.fetch_sub(1, Ordering::SeqCst);
                    Vec::new()
                }
            },
        )
        .await;
        assert!(failures.is_empty());
        assert_eq!(peak.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn run_concurrently_finishes_the_remaining_items_after_a_failure() {
        let finished = Arc::new(AtomicUsize::new(0));
        let failures = run_concurrently(
            (0..10).collect(),
            NonZeroUsize::new(2).unwrap(),
            |item: i32| {
                let finished = Arc::clone(&finished);
                async move {
                    if item % 5 == 0 {
                        return vec![anyhow::anyhow!("item {item} failed")];
                    }
                    finished.fetch_add(1, Ordering::SeqCst);
                    Vec::new()
                }
            },
        )
        .await;
        assert_eq!(failures.len(), 2);
        assert_eq!(finished.load(Ordering::SeqCst), 8);
    }
}
