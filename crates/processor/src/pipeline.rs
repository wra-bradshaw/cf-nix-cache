//! Verification of client-encoded uploads too large to check in a Worker
//! request: the chunks are already stored, and must decode to their keys and
//! concatenate to a valid NAR with the declared hash. Nothing is written but
//! the manifest, which is built from the stored bytes.

use anyhow::Context;
use cf_nix_cache_core::{
    nix_base32, ChunkManifest, ChunkRef, ProcessJob, ProcessResult, CHUNK_MAX_SIZE,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

    /// A read fails for one of two reasons: the connection to the store,
    /// which is worth retrying, or the content, which is not.
    fn from_stream(error: std::io::Error) -> Self {
        if error
            .get_ref()
            .is_some_and(|inner| inner.is::<ObjectReadError>())
        {
            Self::Retryable(anyhow::Error::new(error).context("reading a chunk"))
        } else {
            Self::permanent(format!("invalid chunk: {error}"))
        }
    }
}

type Result<T, E = ProcessFailure> = std::result::Result<T, E>;

pub(crate) async fn process_job<S: ObjectStore>(
    store: &S,
    job: &ProcessJob,
) -> Result<ProcessResult> {
    verify_chunk_list(store, job, &job.chunks_key).await
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
    use cf_nix_cache_core::{ENCODING_ID, ZSTD_LEVEL};

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
            chunks_key: "staging/job.chunks.json".into(),
            nar_hash: sha256_nix(raw),
            nar_size: raw.len() as u64,
            encoding_id: ENCODING_ID.into(),
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
        let job = job_for(raw);
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
    async fn a_second_upload_of_a_nar_keeps_the_stored_manifest() {
        let raw = nar(b"hello world");
        let store = MemoryStore::default();
        let job = encoded(&store, &raw, &[]);
        let first = process_job(&store, &job).await.unwrap();
        assert!(!first.deduplicated);
        let second = process_job(&store, &job).await.unwrap();
        assert!(second.deduplicated);
        assert_eq!(second.manifest, first.manifest);
    }

    /// Serves `prefix` of an object on the chosen read, then fails as
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
    async fn a_dropped_connection_is_retryable() {
        let raw = nar(b"hello world");
        let inner = MemoryStore::default();
        let job = encoded(&inner, &raw, &[]);
        let key = format!("chunks/{ENCODING_ID}/{}.zst", sha256_nix(&raw));
        let chunk = inner.objects.lock().unwrap()[&key].clone();
        // Read 0 is the chunk list, read 1 the chunk.
        let store = DroppingStore {
            inner,
            prefix: chunk[..chunk.len() / 2].to_vec(),
            drop_on_read: 1,
            reads: Default::default(),
        };
        let result = process_job(&store, &job).await;
        assert!(
            matches!(result, Err(ProcessFailure::Retryable(_))),
            "{result:?}"
        );
    }

    #[tokio::test]
    async fn a_truncated_chunk_is_permanent() {
        let raw = nar(b"hello world");
        let store = MemoryStore::default();
        let job = encoded(&store, &raw, &[]);
        let key = format!("chunks/{ENCODING_ID}/{}.zst", sha256_nix(&raw));
        {
            let mut objects = store.objects.lock().unwrap();
            let chunk = objects.get_mut(&key).unwrap();
            chunk.truncate(chunk.len() / 2);
        }
        let result = process_job(&store, &job).await;
        assert!(
            matches!(result, Err(ProcessFailure::Permanent(_))),
            "{result:?}"
        );
    }
}
