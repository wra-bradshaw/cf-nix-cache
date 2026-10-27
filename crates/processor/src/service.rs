use anyhow::Context;
use async_compression::tokio::bufread::ZstdDecoder;
use cf_nix_cache_core::{
    nix_base32, ChunkManifest, ChunkRef, ProcessJob, ProcessResult, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE,
    CHUNK_MIN_SIZE, MAX_COMPRESSED_SIZE, MAX_NAR_SIZE, ZSTD_LEVEL,
};
use fastcdc::v2020::AsyncStreamCDC;
use futures::StreamExt;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

use crate::{
    nar::{LimitedReader, NarValidator},
    object_store::ObjectStore,
};

#[derive(Debug, Error)]
pub(crate) enum ProcessFailure {
    /// Invalid input; retrying the same job cannot succeed.
    #[error("{0}")]
    Permanent(String),
    /// Infrastructure failure; the Worker may retry the job.
    #[error(transparent)]
    Retryable(#[from] anyhow::Error),
}

impl ProcessFailure {
    fn permanent(message: impl Into<String>) -> Self {
        Self::Permanent(message.into())
    }
}

type Result<T, E = ProcessFailure> = std::result::Result<T, E>;

pub(crate) async fn process_job<S: ObjectStore>(
    store: &S,
    job: &ProcessJob,
) -> Result<ProcessResult> {
    // Validate the complete archive before creating any permanent objects,
    // so malformed input whose hash or NAR structure is only discovered at
    // the end of the stream cannot leave content-addressed chunks behind.
    let (nar_hash, raw_size) = validate_nar(store, job).await?;
    if nar_hash != job.nar_hash || raw_size != job.nar_size {
        return Err(ProcessFailure::permanent(
            "validated NAR does not match declared hash or size",
        ));
    }

    let source = LimitedReader::new(store.get(&job.staging_key).await?, MAX_COMPRESSED_SIZE);
    let mut decoder = ZstdDecoder::new(BufReader::new(source));
    let mut chunker =
        AsyncStreamCDC::new(&mut decoder, CHUNK_MIN_SIZE, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE);
    let mut chunks = Box::pin(chunker.as_stream());
    let mut file_hash = Sha256::new();
    let mut file_size = 0u64;
    let mut chunked_raw_size = 0u64;
    let mut refs = Vec::new();

    while let Some(chunk) = chunks.next().await {
        let bytes = chunk
            .map_err(|error| {
                ProcessFailure::permanent(format!("invalid compressed NAR stream: {error}"))
            })?
            .data;
        let raw_size = bytes.len() as u64;
        let raw_hash = sha256_nix(&bytes);
        chunked_raw_size += raw_size;
        let compressed =
            tokio::task::spawn_blocking(move || zstd::encode_all(bytes.as_slice(), ZSTD_LEVEL))
                .await
                .context("waiting for zstd compression")?
                .context("unable to compress NAR chunk")?;
        let compressed_hash = sha256_nix(&compressed);
        let compressed_size = compressed.len() as u64;
        file_hash.update(&compressed);
        file_size += compressed_size;
        let key = format!("chunks/{}/{raw_hash}.zst", job.encoding_id);
        store
            .put_if_absent(&key, compressed, "application/zstd")
            .await?;
        refs.push(ChunkRef {
            raw_hash,
            raw_size,
            compressed_hash,
            compressed_size,
            key,
        });
    }
    drop(chunks);
    drop(chunker);
    if chunked_raw_size != raw_size {
        return Err(ProcessFailure::permanent(
            "staging object changed during processing",
        ));
    }
    if refs.is_empty() {
        return Err(ProcessFailure::permanent(
            "validated NAR produced no chunks",
        ));
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
        .map_err(|error| ProcessFailure::permanent(error.to_string()))?;
    let manifest_key = format!("manifests/{}/{nar_hash}.json", job.encoding_id);
    let created = store
        .put_if_absent(
            &manifest_key,
            manifest
                .canonical_json()
                .context("serializing chunk manifest")?,
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
            ProcessFailure::permanent(format!("stored manifest is invalid: {error}"))
        })?;
        existing
            .validate()
            .map_err(|error| ProcessFailure::permanent(error.to_string()))?;
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
    let invalid_nar = |error: &dyn std::fmt::Display| {
        ProcessFailure::permanent(format!("invalid NAR archive: {error}"))
    };

    loop {
        let read = decoder.read(&mut buffer).await.map_err(|error| {
            ProcessFailure::permanent(format!("invalid compressed NAR stream: {error}"))
        })?;
        if read == 0 {
            break;
        }
        raw_size += read as u64;
        if raw_size > MAX_NAR_SIZE {
            return Err(ProcessFailure::permanent(
                "decoded NAR exceeds the configured limit",
            ));
        }
        raw_hash.update(&buffer[..read]);
        validator
            .writer
            .write_all(&buffer[..read])
            .await
            .map_err(|error| invalid_nar(&error))?;
    }
    validator
        .finish()
        .await
        .map_err(|error| invalid_nar(&error))?;
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
    use crate::object_store::memory::MemoryStore;
    use cf_nix_cache_core::ENCODING_ID;

    /// Chunk objects are keyed by the raw hash and written with put_if_absent,
    /// while manifests record the size and hash of freshly compressed bytes.
    /// Compressed output must therefore be byte-identical for the lifetime of
    /// ENCODING_ID; a libzstd change that alters it needs a new encoding id.
    #[test]
    fn compression_output_is_stable_for_the_encoding_profile() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let input: Vec<u8> = (0..1 << 20)
            .map(|index: u32| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                // Mix runs of text-like bytes with noise so both literal and
                // match encoding paths are exercised.
                if index % 4096 < 3072 {
                    b"/nix/store/cf-nix-cache-golden-input "[index as usize % 37]
                } else {
                    (state >> 56) as u8
                }
            })
            .collect();
        let compressed = zstd::encode_all(input.as_slice(), ZSTD_LEVEL).unwrap();
        assert_eq!(
            (compressed.len(), sha256_nix(&compressed)),
            (
                264_109,
                "sha256:1r75kjlcavpmzdp0kshxs921h98115mrjlr37hflkgk38zffmq1s".to_owned(),
            ),
        );
    }

    #[tokio::test]
    async fn malformed_nar_does_not_write_permanent_chunks() {
        let compressed = zstd::encode_all(&b"not a NAR"[..], 3).unwrap();
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
