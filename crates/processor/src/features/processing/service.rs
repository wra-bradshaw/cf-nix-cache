use anyhow::{anyhow, Context, Result};
use async_compression::tokio::bufread::ZstdDecoder;
use cf_nix_cache_core::{
    nix_base32, ChunkManifest, ChunkRef, ProcessJob, ProcessResult, MAX_COMPRESSED_SIZE,
    MAX_NAR_SIZE,
};
use fastcdc::v2020::AsyncStreamCDC;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

use super::{
    nar::{LimitedReader, NarValidator},
    object_store::ObjectStore,
};

const MIN_CHUNK: usize = 1024 * 1024;
const AVG_CHUNK: usize = 4 * 1024 * 1024;
const MAX_CHUNK: usize = 16 * 1024 * 1024;

#[derive(Debug, Error)]
pub(crate) enum ProcessFailure {
    #[error("{0}")]
    Permanent(String),
    #[error(transparent)]
    Retryable(#[from] anyhow::Error),
}

#[derive(Debug, Error)]
#[error("{0}")]
struct PermanentInput(String);

pub(crate) async fn process_job<S: ObjectStore>(
    store: &S,
    job: &ProcessJob,
) -> std::result::Result<ProcessResult, ProcessFailure> {
    process_job_inner(store, job).await.map_err(|error| {
        if let Some(permanent) = error.downcast_ref::<PermanentInput>() {
            ProcessFailure::Permanent(permanent.0.clone())
        } else {
            ProcessFailure::Retryable(error)
        }
    })
}

async fn process_job_inner<S: ObjectStore>(store: &S, job: &ProcessJob) -> Result<ProcessResult> {
    // Validate the complete archive before creating any permanent objects.
    // The previous single-pass implementation could leave content-addressed
    // chunks behind for malformed input whose hash or NAR structure was only
    // discovered at the end of the stream.
    let (nar_hash, raw_size) = validate_nar(store, job).await?;
    if nar_hash != job.nar_hash || raw_size != job.nar_size {
        return Err(anyhow!(PermanentInput(
            "validated NAR does not match declared hash or size".into()
        )));
    }

    let source = LimitedReader::new(store.get(&job.staging_key).await?, MAX_COMPRESSED_SIZE);
    let mut decoder = ZstdDecoder::new(BufReader::new(source));
    let mut chunker = AsyncStreamCDC::new(&mut decoder, MIN_CHUNK, AVG_CHUNK, MAX_CHUNK);
    let mut chunks = Box::pin(chunker.as_stream());
    let mut file_hash = Sha256::new();
    let mut file_size = 0u64;
    let mut chunked_raw_size = 0u64;
    let mut refs = Vec::new();

    while let Some(chunk) = chunks.next().await {
        let bytes = chunk
            .map_err(|error| {
                anyhow!(PermanentInput(format!(
                    "invalid compressed NAR stream: {error}"
                )))
            })?
            .data;
        chunked_raw_size += bytes.len() as u64;
        let compressed = tokio::task::spawn_blocking({
            let input = bytes.clone();
            move || zstd::encode_all(Cursor::new(input), 3)
        })
        .await
        .context("waiting for zstd compression")?
        .map_err(|error| {
            anyhow!(PermanentInput(format!(
                "unable to compress NAR chunk: {error}"
            )))
        })?;
        let raw_digest = sha256_nix(&bytes);
        let compressed_digest = sha256_nix(&compressed);
        file_hash.update(&compressed);
        file_size += compressed.len() as u64;
        let key = format!("chunks/{}/{raw_digest}.zst", job.encoding_id);
        store
            .put_if_absent(&key, compressed.clone(), "application/zstd")
            .await?;
        refs.push(ChunkRef {
            raw_hash: raw_digest,
            raw_size: bytes.len() as u64,
            compressed_hash: compressed_digest,
            compressed_size: compressed.len() as u64,
            key,
        });
    }
    drop(chunks);
    drop(chunker);
    if chunked_raw_size != raw_size {
        return Err(anyhow!(PermanentInput(
            "staging object changed during processing".into()
        )));
    }
    if refs.is_empty() {
        return Err(anyhow!(PermanentInput(
            "validated NAR produced no chunks".into()
        )));
    }
    let manifest = ChunkManifest {
        encoding_id: job.encoding_id.clone(),
        nar_hash: nar_hash.clone(),
        nar_size: raw_size,
        file_hash: format!("sha256:{}", nix_base32(&file_hash.finalize())),
        file_size,
        chunks: refs,
        processing_version: env!("CARGO_PKG_VERSION").into(),
        created_at: now_seconds(),
    };
    manifest
        .validate()
        .map_err(|error| anyhow!(PermanentInput(error.to_string())))?;
    let manifest_key = format!("manifests/{}/{nar_hash}.json", job.encoding_id);
    let created = store
        .put_if_absent(
            &manifest_key,
            manifest.canonical_json()?,
            "application/json",
        )
        .await?;
    let stored_manifest = if created {
        manifest
    } else {
        let mut body = store.get(&manifest_key).await?;
        let mut bytes = Vec::new();
        body.read_to_end(&mut bytes)
            .await
            .context("reading deduplicated manifest")?;
        let existing: ChunkManifest = serde_json::from_slice(&bytes).map_err(|error| {
            anyhow!(PermanentInput(format!(
                "stored manifest is invalid: {error}"
            )))
        })?;
        existing
            .validate()
            .map_err(|error| anyhow!(PermanentInput(error.to_string())))?;
        existing
    };
    Ok(ProcessResult {
        manifest_key,
        manifest: stored_manifest,
        deduplicated: !created,
    })
}

async fn validate_nar<S: ObjectStore>(store: &S, job: &ProcessJob) -> Result<(String, u64)> {
    let source = LimitedReader::new(store.get(&job.staging_key).await?, MAX_COMPRESSED_SIZE);
    let mut decoder = ZstdDecoder::new(BufReader::new(source));
    let mut validator = NarValidator::spawn();
    let mut raw_hash = Sha256::new();
    let mut raw_size = 0u64;
    let mut buffer = vec![0u8; 1024 * 1024];

    loop {
        let read = decoder.read(&mut buffer).await.map_err(|error| {
            anyhow!(PermanentInput(format!(
                "invalid compressed NAR stream: {error}"
            )))
        })?;
        if read == 0 {
            break;
        }
        raw_size += read as u64;
        if raw_size > MAX_NAR_SIZE {
            return Err(anyhow!(PermanentInput(
                "decoded NAR exceeds the configured limit".into()
            )));
        }
        raw_hash.update(&buffer[..read]);
        validator
            .writer
            .write_all(&buffer[..read])
            .await
            .map_err(|error| anyhow!(PermanentInput(format!("invalid NAR archive: {error}"))))?;
    }
    validator
        .finish()
        .await
        .map_err(|error| anyhow!(PermanentInput(format!("invalid NAR archive: {error}"))))?;
    Ok((
        format!("sha256:{}", nix_base32(&raw_hash.finalize())),
        raw_size,
    ))
}

fn sha256_nix(bytes: &[u8]) -> String {
    format!("sha256:{}", nix_base32(&Sha256::digest(bytes)))
}
fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::features::processing::object_store::ObjectBody;
    use async_trait::async_trait;
    use cf_nix_cache_core::ENCODING_ID;
    use std::{
        collections::HashMap,
        io::Cursor,
        sync::{Arc, Mutex},
    };

    #[derive(Clone, Default)]
    struct MemoryStore {
        objects: Arc<Mutex<HashMap<String, Vec<u8>>>>,
        writes: Arc<Mutex<Vec<String>>>,
    }

    #[async_trait]
    impl ObjectStore for MemoryStore {
        async fn get(&self, key: &str) -> Result<ObjectBody> {
            let bytes = self
                .objects
                .lock()
                .unwrap()
                .get(key)
                .cloned()
                .context("missing object")?;
            Ok(Box::pin(Cursor::new(bytes)))
        }

        async fn put_if_absent(
            &self,
            key: &str,
            body: Vec<u8>,
            _content_type: &str,
        ) -> Result<bool> {
            self.writes.lock().unwrap().push(key.to_owned());
            self.objects
                .lock()
                .unwrap()
                .entry(key.to_owned())
                .or_insert(body);
            Ok(true)
        }
    }

    #[tokio::test]
    async fn malformed_nar_does_not_write_permanent_chunks() {
        let compressed = zstd::encode_all(Cursor::new(b"not a NAR"), 3).unwrap();
        let store = MemoryStore::default();
        store
            .objects
            .lock()
            .unwrap()
            .insert("staging/job.nar.zst".into(), compressed);
        let job = ProcessJob {
            job_id: "job".into(),
            staging_key: "staging/job.nar.zst".into(),
            nar_hash: "sha256:0000000000000000000000000000000000000000000000000000".into(),
            nar_size: 9,
            encoding_id: ENCODING_ID.into(),
        };

        let result = process_job(&store, &job).await;
        assert!(matches!(result, Err(ProcessFailure::Permanent(_))));
        assert!(store.writes.lock().unwrap().is_empty());
    }
}
