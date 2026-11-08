//! Client-encoded uploads: the CLI chunks and compresses each NAR, the server
//! says which chunks it lacks, and only those are sent. The server then checks
//! the stored chunks and publishes the path.

use crate::protocol::{
    contracts::api as contract, CacheName, EncodedCompleteBatchResponse,
    EncodedUploadBatchResponse, EncodedUploadResponse, UploadStateResponse, UploadStatus,
    CHUNK_MIN_SIZE, ENCODING_ID,
};
use crate::{
    client::{api_path, Api, ApiError},
    encode::{encode_path, EncodedNar},
    nix::{nix_hash, PathInfo},
    upload::{manifest, wait_for_state},
};
use anyhow::{bail, Context, Result};
use futures::{StreamExt, TryStreamExt};
use reqwest::Method;
use std::{
    collections::BTreeMap,
    num::NonZeroU64,
    time::{Duration, Instant},
};
use uuid::Uuid;

/// Paths below this NAR size are one chunk, and are uploaded in batches.
pub(crate) const BATCH_NAR_SIZE: u64 = CHUNK_MIN_SIZE as u64;
/// Paths in one batch.
pub(crate) const BATCH_PATHS: usize = 32;
/// Chunks of one path uploaded at a time.
const CHUNK_CONCURRENCY: usize = 6;
/// Paths of one batch encoded at a time.
const ENCODE_CONCURRENCY: usize = 8;
/// Garbage collection closes the upload gate for minutes at most.
const GATE_WAIT: Duration = Duration::from_secs(30 * 60);

fn gate_closed(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<ApiError>(),
        Some(api) if api.status == 503 && api.code.as_deref() == Some("gc_in_progress")
    )
}

fn request(
    cache: &CacheName,
    path: &str,
    info: &PathInfo,
    encoded: &EncodedNar,
) -> Result<contract::EncodedUploadRequest> {
    Ok(contract::EncodedUploadRequest {
        manifest: manifest(cache, path, info)?,
        encoding_id: ENCODING_ID.into(),
        chunks: encoded
            .chunks
            .iter()
            .map(|chunk| {
                Ok(contract::EncodedChunk {
                    raw_hash: chunk.raw_hash.parse()?,
                    raw_size: NonZeroU64::new(chunk.raw_size).context("empty chunk")?,
                    compressed_hash: chunk.compressed_hash.parse()?,
                    compressed_size: NonZeroU64::new(chunk.compressed_size)
                        .context("empty chunk")?,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    })
}

async fn encode(path: &str, info: &PathInfo) -> Result<EncodedNar> {
    let (path, info) = (path.to_owned(), info.clone());
    tokio::task::spawn_blocking(move || {
        encode_path(&path, &nix_hash(&info.nar_hash)?, info.nar_size)
    })
    .await?
}

/// Opens an upload, waiting while garbage collection holds the upload gate.
/// The idempotency key is kept across those waits, so a retry resumes the
/// same upload.
async fn open<B: serde::Serialize, T: serde::de::DeserializeOwned>(
    api: &Api,
    path: &str,
    body: &B,
) -> Result<T> {
    let key = Uuid::new_v4().simple().to_string();
    let deadline = Instant::now() + GATE_WAIT;
    loop {
        match api.request_with_key(path, &key, body).await {
            Err(error) if gate_closed(&error) && Instant::now() < deadline => {
                eprintln!("garbage collection is running; waiting to upload");
                tokio::time::sleep(Duration::from_secs(30)).await;
            }
            result => return result,
        }
    }
}

/// Uploads one path's missing chunks and completes it.
pub(crate) async fn upload_encoded(
    api: &Api,
    cache: &CacheName,
    path: &str,
    info: &PathInfo,
) -> Result<()> {
    let encoded = encode(path, info).await?;
    let opened: EncodedUploadResponse = open(
        api,
        "/api/uploads/encoded",
        &request(cache, path, info, &encoded)?,
    )
    .await?;
    let state = if opened.merged || opened.status != UploadStatus::Uploading {
        UploadStateResponse {
            id: opened.id,
            status: opened.status,
            error: opened.error,
        }
    } else {
        let nar = &encoded;
        let id = opened.id.as_str();
        // Owned hashes: a borrowed one makes the future fail the Send check
        // that spawning the upload needs.
        futures::stream::iter(opened.missing_chunks.clone())
            .map(|hash| async move {
                let bytes = nar.chunk_bytes(&hash)?;
                api.put_chunk(id, &hash, bytes)
                    .await
                    .with_context(|| format!("uploading chunk {hash}"))
            })
            .buffer_unordered(CHUNK_CONCURRENCY)
            .try_collect::<Vec<()>>()
            .await?;
        drop(encoded);
        api.request(
            Method::POST,
            &api_path(&["uploads", &opened.id, "complete"]),
            None::<&()>,
        )
        .await?
    };
    finish(api, state, path, opened.missing_chunks.len()).await
}

async fn finish(api: &Api, state: UploadStateResponse, path: &str, sent: usize) -> Result<()> {
    let state = match state.status {
        UploadStatus::Ready | UploadStatus::Failed | UploadStatus::Aborted => state,
        _ => wait_for_state(api, &state.id, path).await?,
    };
    match state.status {
        UploadStatus::Ready if sent == 0 => println!("uploaded {path} (no new chunks)"),
        UploadStatus::Ready if sent == 1 => println!("uploaded {path} (1 new chunk)"),
        UploadStatus::Ready => println!("uploaded {path} ({sent} new chunks)"),
        _ => bail!(
            "upload {} ended {:?}: {}",
            state.id,
            state.status,
            state.error.unwrap_or_default()
        ),
    }
    Ok(())
}

/// Uploads several small paths in two requests: one to open them all, one to
/// send their missing chunks and complete them. Returns each path's outcome.
pub(crate) async fn upload_encoded_batch(
    api: &Api,
    cache: &CacheName,
    items: &[(String, PathInfo)],
) -> Result<Vec<(String, Result<()>)>> {
    // Each path waits on its own nix-store process, so encode them together.
    let mut running = tokio::task::JoinSet::new();
    let mut results = Vec::with_capacity(items.len());
    for (index, (path, info)) in items.iter().enumerate() {
        if running.len() == ENCODE_CONCURRENCY {
            results.push(running.join_next().await.expect("tasks are running")?);
        }
        let (path, info) = (path.clone(), info.clone());
        running.spawn(async move { (index, encode(&path, &info).await) });
    }
    while let Some(result) = running.join_next().await {
        results.push(result?);
    }
    results.sort_by_key(|(index, _)| *index);
    let mut encoded = Vec::with_capacity(items.len());
    let mut outcomes = Vec::new();
    for (index, result) in results {
        let (path, info) = &items[index];
        match result {
            Ok(nar) => encoded.push((path.as_str(), info, nar)),
            Err(error) => outcomes.push((path.clone(), Err(error))),
        }
    }
    if encoded.is_empty() {
        return Ok(outcomes);
    }
    let uploads = encoded
        .iter()
        .map(|(path, info, nar)| request(cache, path, info, nar))
        .collect::<Result<Vec<_>>>()?;
    let opened: EncodedUploadBatchResponse = open(
        api,
        "/api/uploads/encoded/batch",
        &contract::EncodedUploadBatch { uploads },
    )
    .await?;
    if opened.uploads.len() != encoded.len() {
        bail!(
            "server answered a batch of {} with {}",
            encoded.len(),
            opened.uploads.len()
        );
    }
    let mut ids = Vec::new();
    let mut files = BTreeMap::new();
    for ((_, _, nar), upload) in encoded.iter().zip(&opened.uploads) {
        if upload.merged || upload.status != UploadStatus::Uploading {
            continue;
        }
        ids.push(upload.id.clone());
        for hash in &upload.missing_chunks {
            if !files.contains_key(hash) {
                files.insert(hash.clone(), nar.chunk_bytes(hash)?);
            }
        }
    }
    let mut completed = BTreeMap::new();
    if !ids.is_empty() {
        let response: EncodedCompleteBatchResponse = api
            .post_form(
                "/api/uploads/encoded/batch/complete",
                &serde_json::json!({ "ids": ids }),
                files.into_iter().collect(),
            )
            .await?;
        for state in response.uploads {
            completed.insert(state.id.clone(), state);
        }
    }
    for ((path, _, _), upload) in encoded.iter().zip(opened.uploads) {
        let sent = upload.missing_chunks.len();
        let state = completed.remove(&upload.id).unwrap_or(UploadStateResponse {
            id: upload.id,
            status: upload.status,
            error: upload.error,
        });
        outcomes.push((path.to_string(), finish(api, state, path, sent).await));
    }
    Ok(outcomes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn api_error(status: u16, code: &str, message: &str) -> anyhow::Error {
        ApiError {
            status,
            code: Some(code.into()),
            message: message.into(),
        }
        .into()
    }

    #[test]
    fn gate_closed_matches_the_lease_error() {
        assert!(gate_closed(&api_error(503, "gc_in_progress", "")));
        assert!(!gate_closed(&api_error(503, "other", "")));
        assert!(!gate_closed(&api_error(409, "gc_in_progress", "")));
        assert!(!gate_closed(&anyhow::anyhow!("boom")));
    }
}
