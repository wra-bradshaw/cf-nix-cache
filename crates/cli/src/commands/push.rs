use crate::protocol::{
    contracts::{api as contract, responses::CacheUpstreamsResponse},
    CacheName, MissingPathsResponse,
};
use anyhow::{Context as _, Result};
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
    encoded_upload::{upload_encoded, upload_encoded_batch, BATCH_NAR_SIZE, BATCH_PATHS},
    nix::{path_info, signed_by_upstream, store_hash, PathInfo},
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
    let mut pending = BTreeSet::new();
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
        pending.extend(result.pending.into_iter().map(|upload| upload.store_hash));
    }
    let (uploads, in_flight) = plan_paths(map, &missing, &pending)?;
    let total = uploads.len();
    println!(
        "pushing {total} paths to \"{cache}\" ({} already cached, {in_upstream} in upstream, {in_flight} already being uploaded)",
        considered - total,
    );
    let work = plan(uploads);
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

fn plan_paths(
    map: BTreeMap<String, PathInfo>,
    missing: &BTreeSet<String>,
    pending: &BTreeSet<String>,
) -> Result<(Vec<(String, PathInfo)>, usize)> {
    let mut uploads = Vec::new();
    let mut in_flight = 0;
    for (path, info) in map {
        let hash = store_hash(&path)?;
        if missing.contains(&hash) {
            uploads.push((path, info));
        } else if pending.contains(&hash) {
            in_flight += 1;
            uploads.push((path, info));
        } else {
            println!("already cached {path}");
        }
    }
    Ok((uploads, in_flight))
}

enum Work {
    One(String, PathInfo),
    Batch(Vec<(String, PathInfo)>),
}

/// Large paths first, so that they do not start last and finish alone.
fn plan(mut uploads: Vec<(String, PathInfo)>) -> Vec<Work> {
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
    work
}

struct Context {
    api: Api,
    cache: CacheName,
}

impl Context {
    async fn run(&self, work: Work) -> Vec<anyhow::Error> {
        match work {
            Work::One(path, info) => self.one(&path, &info).await.err().into_iter().collect(),
            Work::Batch(items) => self.batch(items).await,
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
            // One bad path fails a whole batch; retry one by one.
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
    let response = api
        .get::<CacheUpstreamsResponse>(&format!("/api/caches/{cache}/upstreams"))
        .await?;
    Ok(response
        .upstream_cache_key_names
        .into_iter()
        .map(String::from)
        .collect())
}

/// A failure does not stop the rest; every completed upload saves a retry.
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

    fn info() -> PathInfo {
        serde_json::from_value(serde_json::json!({
            "narHash": "sha256-abc",
            "narSize": 1,
            "references": [],
        }))
        .unwrap()
    }

    fn store_path(hash: &str, name: &str) -> String {
        format!("/nix/store/{hash}-{name}")
    }

    #[test]
    fn pending_paths_are_uploaded_like_missing_ones() {
        let (missing_hash, pending_hash, cached_hash) =
            ("0".repeat(32), "1".repeat(32), "2".repeat(32));
        let (missing_path, pending_path, cached_path) = (
            store_path(&missing_hash, "missing"),
            store_path(&pending_hash, "pending"),
            store_path(&cached_hash, "cached"),
        );
        let map = [
            (missing_path.clone(), info()),
            (pending_path.clone(), info()),
            (cached_path, info()),
        ]
        .into_iter()
        .collect();
        let missing = BTreeSet::from([missing_hash]);
        let pending = BTreeSet::from([pending_hash]);

        let (uploads, in_flight) = plan_paths(map, &missing, &pending).unwrap();

        assert_eq!(in_flight, 1);
        assert_eq!(uploads.len(), 2);
        assert!(uploads.iter().any(|(path, _)| path == &missing_path));
        assert!(uploads.iter().any(|(path, _)| path == &pending_path));
    }

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
