use anyhow::Context;
use async_compression::tokio::bufread::ZstdDecoder;
use cf_nix_cache_core::{
    nix_base32, ChunkManifest, ChunkRef, ProcessJob, ProcessResult, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE,
    CHUNK_MIN_SIZE, MAX_COMPRESSED_SIZE, MAX_NAR_SIZE, ZSTD_LEVEL,
};
use fastcdc::v2020::AsyncStreamCDC;
use futures::StreamExt;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt, BufReader};

use crate::{
    nar::{LimitedReader, NarValidator},
    object_store::{ObjectReadError, ObjectStore},
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

    /// A read through the decoder fails for one of two reasons: the connection
    /// to the store, which is worth retrying, or the content, which is not.
    fn from_stream(error: std::io::Error) -> Self {
        if error
            .get_ref()
            .is_some_and(|inner| inner.is::<ObjectReadError>())
        {
            Self::Retryable(anyhow::Error::new(error).context("reading staging object"))
        } else {
            Self::permanent(format!("invalid compressed NAR stream: {error}"))
        }
    }
}

type Result<T, E = ProcessFailure> = std::result::Result<T, E>;

pub(crate) async fn process_job<S: ObjectStore>(
    store: &S,
    job: &ProcessJob,
) -> Result<ProcessResult> {
    if let Some(list_key) = &job.chunks_key {
        return verify_chunk_list(store, job, list_key).await;
    }
    // Validate the complete archive before creating any permanent objects,
    // so malformed input whose hash or NAR structure is only discovered at
    // the end of the stream cannot leave content-addressed chunks behind.
    let (nar_hash, raw_size) = validate_nar(store, job).await?;
    if nar_hash != job.nar_hash || raw_size != job.nar_size {
        return Err(ProcessFailure::permanent(
            "validated NAR does not match declared hash or size",
        ));
    }

    let chunked = chunk_and_store(store, job).await?;
    if chunked.raw_size != raw_size || chunked.raw_hash != nar_hash {
        return Err(ProcessFailure::permanent(
            "staging object changed during processing",
        ));
    }
    if chunked.refs.is_empty() {
        return Err(ProcessFailure::permanent(
            "validated NAR produced no chunks",
        ));
    }
    publish_manifest(
        store,
        ChunkManifest {
            encoding_id: job.encoding_id.clone(),
            nar_hash,
            nar_size: raw_size,
            file_hash: chunked.file_hash,
            file_size: chunked.file_size,
            chunks: chunked.refs,
            processing_version: env!("CARGO_PKG_VERSION").into(),
            created_at: now_seconds(),
        },
    )
    .await
}

/// What [`chunk_and_store`] wrote. `file_hash` and `file_size` cover the
/// concatenated compressed chunks; `raw_size` and `raw_hash` cover what the
/// chunker actually read.
struct ChunkedNar {
    refs: Vec<ChunkRef>,
    raw_size: u64,
    raw_hash: String,
    file_hash: String,
    file_size: u64,
}

/// Re-reads the staging object, writing each compressed chunk to its permanent
/// content-addressed key.
async fn chunk_and_store<S: ObjectStore>(store: &S, job: &ProcessJob) -> Result<ChunkedNar> {
    let source = LimitedReader::new(store.get(&job.staging_key).await?, MAX_COMPRESSED_SIZE);
    let mut decoder = ZstdDecoder::new(BufReader::new(source));
    let mut chunker =
        AsyncStreamCDC::new(&mut decoder, CHUNK_MIN_SIZE, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE);
    let mut chunks = Box::pin(chunker.as_stream());
    let mut file_hash = Sha256::new();
    let mut file_size = 0u64;
    let mut chunked_raw_size = 0u64;
    let mut chunked_raw_hash = Sha256::new();
    let mut refs = Vec::new();

    while let Some(chunk) = chunks.next().await {
        let bytes = chunk
            .map_err(|error| ProcessFailure::from_stream(error.into()))?
            .data;
        let raw_size = bytes.len() as u64;
        let raw_hash = sha256_nix(&bytes);
        chunked_raw_size += raw_size;
        chunked_raw_hash.update(&bytes);
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
    Ok(ChunkedNar {
        refs,
        raw_size: chunked_raw_size,
        raw_hash: format!("sha256:{}", nix_base32(&chunked_raw_hash.finalize())),
        file_hash: format!("sha256:{}", nix_base32(&file_hash.finalize())),
        file_size,
    })
}

/// Writes `manifest` unless one already exists for this NAR, in which case the
/// stored manifest wins and the result is marked deduplicated.
async fn publish_manifest<S: ObjectStore>(
    store: &S,
    manifest: ChunkManifest,
) -> Result<ProcessResult> {
    manifest
        .validate()
        .map_err(|error| ProcessFailure::permanent(error.to_string()))?;
    let manifest_key = format!(
        "manifests/{}/{}.json",
        manifest.encoding_id, manifest.nar_hash
    );
    let created = store
        .put_if_absent(
            &manifest_key,
            serde_json::to_vec(&manifest).context("serializing chunk manifest")?,
            "application/json",
        )
        .await?;
    let stored_manifest = if created {
        manifest
    } else {
        read_stored_manifest(store, &manifest_key).await?
    };
    Ok(ProcessResult {
        manifest_key,
        manifest: stored_manifest,
        deduplicated: !created,
    })
}

async fn read_stored_manifest<S: ObjectStore>(store: &S, key: &str) -> Result<ChunkManifest> {
    let mut body = store.get(key).await?;
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
    Ok(existing)
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
        let read = decoder
            .read(&mut buffer)
            .await
            .map_err(ProcessFailure::from_stream)?;
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
        // The write fails because the validator has stopped, so what it found
        // is the real error and the broken pipe is only a symptom.
        if let Err(write_error) = validator.writer.write_all(&buffer[..read]).await {
            return Err(match validator.finish().await {
                Err(error) => invalid_nar(&error),
                Ok(()) => invalid_nar(&write_error),
            });
        }
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

/// The chunk list a client-encoded upload leaves in staging.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ChunkList {
    encoding_id: String,
    nar_hash: String,
    nar_size: u64,
    chunks: Vec<ListedChunk>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ListedChunk {
    raw_hash: String,
    raw_size: u64,
    key: String,
}

/// zstd's worst case for a `CHUNK_MAX_SIZE` frame, rounded up.
const CHUNK_MAX_COMPRESSED_SIZE: u64 = 17 * 1024 * 1024;

/// Verifies a client-encoded upload whose chunks are already stored: they
/// must decode to their keys and concatenate to a valid NAR with the declared
/// hash. Nothing is written but the manifest, which is built from the stored
/// bytes. Used for NARs too large to verify inside a Worker request.
async fn verify_chunk_list<S: ObjectStore>(
    store: &S,
    job: &ProcessJob,
    list_key: &str,
) -> Result<ProcessResult> {
    let mut body = store.get(list_key).await?;
    let mut bytes = Vec::new();
    body.read_to_end(&mut bytes)
        .await
        .map_err(|error| ProcessFailure::Retryable(anyhow::Error::new(error)))?;
    let list: ChunkList = serde_json::from_slice(&bytes)
        .map_err(|error| ProcessFailure::permanent(format!("invalid chunk list: {error}")))?;
    if list.encoding_id != job.encoding_id
        || list.nar_hash != job.nar_hash
        || list.nar_size != job.nar_size
    {
        return Err(ProcessFailure::permanent(
            "chunk list does not match the upload",
        ));
    }
    if list.chunks.is_empty()
        || list.chunks.iter().map(|chunk| chunk.raw_size).sum::<u64>() != list.nar_size
    {
        return Err(ProcessFailure::permanent(
            "chunk sizes do not add up to the NAR size",
        ));
    }

    let mut validator = NarValidator::spawn();
    let mut nar_hash = Sha256::new();
    let mut file_hash = Sha256::new();
    let mut file_size = 0u64;
    let mut refs = Vec::with_capacity(list.chunks.len());
    let invalid_nar = |error: &dyn std::fmt::Display| {
        ProcessFailure::permanent(format!("invalid NAR archive: {error}"))
    };
    for chunk in list.chunks {
        if chunk.raw_size == 0
            || chunk.raw_size > CHUNK_MAX_SIZE as u64
            || chunk.key != format!("chunks/{}/{}.zst", job.encoding_id, chunk.raw_hash)
        {
            return Err(ProcessFailure::permanent("invalid chunk in chunk list"));
        }
        let mut compressed = Vec::new();
        LimitedReader::new(store.get(&chunk.key).await?, CHUNK_MAX_COMPRESSED_SIZE)
            .read_to_end(&mut compressed)
            .await
            .map_err(ProcessFailure::from_stream)?;
        let capacity = chunk.raw_size as usize;
        let (compressed, raw) = tokio::task::spawn_blocking(move || {
            let raw = zstd::bulk::decompress(&compressed, capacity);
            (compressed, raw)
        })
        .await
        .context("waiting for zstd decompression")?;
        let raw = raw.map_err(|error| {
            ProcessFailure::permanent(format!("chunk {} is not valid zstd: {error}", chunk.key))
        })?;
        if raw.len() as u64 != chunk.raw_size || sha256_nix(&raw) != chunk.raw_hash {
            return Err(ProcessFailure::permanent(format!(
                "chunk {} does not match its key",
                chunk.key
            )));
        }
        nar_hash.update(&raw);
        file_hash.update(&compressed);
        file_size += compressed.len() as u64;
        if let Err(write_error) = validator.writer.write_all(&raw).await {
            return Err(match validator.finish().await {
                Err(error) => invalid_nar(&error),
                Ok(()) => invalid_nar(&write_error),
            });
        }
        refs.push(ChunkRef {
            raw_hash: chunk.raw_hash,
            raw_size: chunk.raw_size,
            compressed_hash: sha256_nix(&compressed),
            compressed_size: compressed.len() as u64,
            key: chunk.key,
        });
    }
    validator
        .finish()
        .await
        .map_err(|error| invalid_nar(&error))?;
    if format!("sha256:{}", nix_base32(&nar_hash.finalize())) != job.nar_hash {
        return Err(ProcessFailure::permanent(
            "chunks do not match the declared NAR hash",
        ));
    }
    publish_manifest(
        store,
        ChunkManifest {
            encoding_id: job.encoding_id.clone(),
            nar_hash: job.nar_hash.clone(),
            nar_size: job.nar_size,
            file_hash: format!("sha256:{}", nix_base32(&file_hash.finalize())),
            file_size,
            chunks: refs,
            processing_version: env!("CARGO_PKG_VERSION").into(),
            created_at: now_seconds(),
        },
    )
    .await
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
            chunks_key: None,
        };

        let result = process_job(&store, &job).await;
        assert!(matches!(result, Err(ProcessFailure::Permanent(_))));
        assert!(store.writes.lock().unwrap().is_empty());
    }

    /// A NAR holding one regular file.
    fn nar(contents: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        for field in [
            b"nix-archive-1".as_slice(),
            b"(",
            b"type",
            b"regular",
            b"contents",
            contents,
            b")",
        ] {
            out.extend((field.len() as u64).to_le_bytes());
            out.extend(field);
            out.extend(vec![0; (8 - field.len() % 8) % 8]);
        }
        out
    }

    fn job_for(raw: &[u8]) -> ProcessJob {
        ProcessJob {
            job_id: "job".into(),
            staging_key: "staging/job.nar.zst".into(),
            nar_hash: sha256_nix(raw),
            nar_size: raw.len() as u64,
            encoding_id: ENCODING_ID.into(),
            chunks_key: None,
        }
    }

    fn store_with(compressed: Vec<u8>) -> MemoryStore {
        let store = MemoryStore::default();
        store
            .objects
            .lock()
            .unwrap()
            .insert("staging/job.nar.zst".into(), compressed);
        store
    }

    #[tokio::test]
    async fn publishes_a_valid_nar_then_deduplicates_it() {
        let raw = nar(b"hello world");
        let store = store_with(zstd::encode_all(raw.as_slice(), ZSTD_LEVEL).unwrap());
        let job = job_for(&raw);

        let first = process_job(&store, &job).await.unwrap();
        assert!(!first.deduplicated);
        assert_eq!(first.manifest.nar_hash, job.nar_hash);
        assert_eq!(first.manifest.nar_size, job.nar_size);

        let second = process_job(&store, &job).await.unwrap();
        assert!(second.deduplicated);
        assert_eq!(second.manifest_key, first.manifest_key);
    }

    /// Serves `prefix` of the staging object on the chosen read, then fails as
    /// a dropped connection would.
    #[derive(Clone)]
    struct DroppingStore {
        inner: MemoryStore,
        prefix: Vec<u8>,
        drop_on_read: usize,
        reads: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }

    struct FailingReader;
    impl tokio::io::AsyncRead for FailingReader {
        fn poll_read(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            _: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::task::Poll::Ready(Err(std::io::Error::other(ObjectReadError(
                "connection reset".into(),
            ))))
        }
    }

    #[async_trait::async_trait]
    impl ObjectStore for DroppingStore {
        async fn get(&self, key: &str) -> anyhow::Result<crate::object_store::ObjectBody> {
            let read = self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if read != self.drop_on_read {
                return self.inner.get(key).await;
            }
            Ok(Box::pin(
                std::io::Cursor::new(self.prefix.clone()).chain(FailingReader),
            ))
        }

        async fn put_if_absent(
            &self,
            key: &str,
            body: Vec<u8>,
            content_type: &str,
        ) -> anyhow::Result<bool> {
            self.inner.put_if_absent(key, body, content_type).await
        }
    }

    #[tokio::test]
    async fn a_dropped_connection_is_retryable_in_both_passes() {
        let raw = nar(b"hello world");
        let compressed = zstd::encode_all(raw.as_slice(), ZSTD_LEVEL).unwrap();
        for drop_on_read in [0, 1] {
            let store = DroppingStore {
                inner: store_with(compressed.clone()),
                prefix: compressed[..compressed.len() / 2].to_vec(),
                drop_on_read,
                reads: Default::default(),
            };
            let result = process_job(&store, &job_for(&raw)).await;
            assert!(
                matches!(result, Err(ProcessFailure::Retryable(_))),
                "read {drop_on_read}: {result:?}",
            );
        }
    }

    /// Stores `raw` as client-encoded chunks split at `splits`, with a chunk
    /// list, and returns the job that verifies them.
    fn encoded(store: &MemoryStore, raw: &[u8], splits: &[usize]) -> ProcessJob {
        let mut chunks = Vec::new();
        let mut start = 0;
        for end in splits.iter().copied().chain([raw.len()]) {
            let bytes = &raw[start..end];
            start = end;
            let raw_hash = sha256_nix(bytes);
            let key = format!("chunks/{ENCODING_ID}/{raw_hash}.zst");
            store
                .objects
                .lock()
                .unwrap()
                .insert(key.clone(), zstd::encode_all(bytes, ZSTD_LEVEL).unwrap());
            chunks.push(serde_json::json!({
                "raw_hash": raw_hash, "raw_size": bytes.len(), "key": key,
            }));
        }
        let job = ProcessJob {
            chunks_key: Some("staging/job.chunks.json".into()),
            ..job_for(raw)
        };
        store.objects.lock().unwrap().insert(
            "staging/job.chunks.json".into(),
            serde_json::to_vec(&serde_json::json!({
                "encoding_id": ENCODING_ID,
                "nar_hash": job.nar_hash,
                "nar_size": job.nar_size,
                "chunks": chunks,
            }))
            .unwrap(),
        );
        job
    }

    #[tokio::test]
    async fn verifies_client_encoded_chunks_and_writes_only_the_manifest() {
        let raw = nar(&b"hello world ".repeat(100));
        let store = MemoryStore::default();
        let job = encoded(&store, &raw, &[40, 500]);
        let result = process_job(&store, &job).await.unwrap();
        assert_eq!(result.manifest.chunks.len(), 3);
        assert_eq!(result.manifest.nar_hash, job.nar_hash);
        assert_eq!(*store.writes.lock().unwrap(), vec![result.manifest_key]);
    }

    #[tokio::test]
    async fn rejects_client_encoded_chunks_that_are_not_the_nar() {
        let raw = b"not a NAR, but long enough".to_vec();
        let store = MemoryStore::default();
        let job = encoded(&store, &raw, &[10]);
        let result = process_job(&store, &job).await;
        assert!(
            matches!(result, Err(ProcessFailure::Permanent(_))),
            "{result:?}"
        );
        assert!(store.writes.lock().unwrap().is_empty());

        let raw = nar(b"hello");
        let store = MemoryStore::default();
        let job = ProcessJob {
            nar_hash: sha256_nix(b"something else"),
            ..encoded(&store, &raw, &[])
        };
        let result = process_job(&store, &job).await;
        assert!(
            matches!(result, Err(ProcessFailure::Permanent(_))),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn truncated_content_remains_permanent() {
        let raw = nar(b"hello world");
        let compressed = zstd::encode_all(raw.as_slice(), ZSTD_LEVEL).unwrap();
        let store = store_with(compressed[..compressed.len() / 2].to_vec());
        let result = process_job(&store, &job_for(&raw)).await;
        assert!(
            matches!(result, Err(ProcessFailure::Permanent(_))),
            "{result:?}"
        );
    }
}
