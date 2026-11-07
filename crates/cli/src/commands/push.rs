//! `push`: uploads the closure of some installables, skipping paths the server
//! already has and, by default, paths signed by the cache's upstream caches.

use anyhow::{Context, Result};
use cf_nix_cache_core::{
    contracts::{api as contract, responses::CacheUpstreamsResponse},
    CacheName, MissingPathsResponse,
};
use reqwest::Method;
use serde_json::Value;
use std::{future::Future, num::NonZeroUsize, process::Command, sync::Arc};
use tokio::task::JoinSet;

use crate::{
    client::Api,
    nix::{command_json, signed_by_upstream, store_hash},
    upload::upload_path,
};

pub(super) async fn push(
    api: Api,
    cache: CacheName,
    installables: Vec<String>,
    jobs: NonZeroUsize,
    ignore_upstream_cache_filter: bool,
) -> Result<()> {
    let mut command = Command::new("nix");
    command
        .args(["path-info", "--json", "--recursive"])
        .args(&installables);
    let Value::Object(mut map) = command_json(command)? else {
        anyhow::bail!("unexpected nix path-info response");
    };
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
    let mut missing = std::collections::BTreeSet::new();
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
    }
    let mut uploads = Vec::new();
    for (path, info) in map {
        if missing.contains(&store_hash(&path)?) {
            uploads.push((path, info));
        } else {
            println!("already cached {path}");
        }
    }
    let total = uploads.len();
    println!(
        "pushing {total} paths to \"{cache}\" ({} already cached, {in_upstream} in upstream)",
        considered - total
    );
    let api = Arc::new(api);
    let cache = Arc::new(cache);
    let failures = run_concurrently(uploads, jobs, move |(path, info)| {
        let api = Arc::clone(&api);
        let cache = Arc::clone(&cache);
        async move {
            upload_path(&api, &cache, &path, &info)
                .await
                .with_context(|| format!("failed to upload {path}"))
        }
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
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    let mut running = JoinSet::new();
    let mut failures = Vec::new();
    for item in items {
        if running.len() == limit.get() {
            collect_failure(running.join_next().await, &mut failures);
        }
        running.spawn(task(item));
    }
    while let Some(result) = running.join_next().await {
        collect_failure(Some(result), &mut failures);
    }
    failures
}

fn collect_failure(
    result: Option<Result<Result<()>, tokio::task::JoinError>>,
    failures: &mut Vec<anyhow::Error>,
) {
    match result {
        Some(Ok(Err(error))) => failures.push(error),
        Some(Err(error)) => failures.push(error.into()),
        Some(Ok(Ok(()))) | None => {}
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
                    Ok(())
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
                        anyhow::bail!("item {item} failed");
                    }
                    finished.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(failures.len(), 2);
        assert_eq!(finished.load(Ordering::SeqCst), 8);
    }
}
