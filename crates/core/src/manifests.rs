use crate::{validate_nar_hash, Error, ENCODING_ID, MAX_NAR_SIZE};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UploadStatus {
    Created,
    Uploading,
    Completing,
    Queued,
    Processing,
    Publishing,
    Ready,
    Failed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkManifest {
    pub encoding_id: String,
    pub nar_hash: String,
    pub nar_size: u64,
    pub file_hash: String,
    pub file_size: u64,
    pub chunks: Vec<ChunkRef>,
    pub processing_version: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChunkRef {
    pub raw_hash: String,
    pub raw_size: u64,
    pub compressed_hash: String,
    pub compressed_size: u64,
    pub key: String,
}

impl ChunkManifest {
    pub fn validate(&self) -> Result<(), Error> {
        if self.encoding_id != ENCODING_ID {
            return Err(Error::InvalidEncoding);
        }
        validate_nar_hash(&self.nar_hash)?;
        validate_nar_hash(&self.file_hash)?;
        if self.nar_size > MAX_NAR_SIZE {
            return Err(Error::ManifestTooLarge);
        }
        if self.chunks.is_empty() {
            return Err(Error::InvalidChunkManifest);
        }
        for chunk in &self.chunks {
            validate_nar_hash(&chunk.raw_hash)?;
            validate_nar_hash(&chunk.compressed_hash)?;
            if chunk.raw_size == 0
                || chunk.compressed_size == 0
                || chunk.key != format!("chunks/{}/{}.zst", self.encoding_id, chunk.raw_hash)
            {
                return Err(Error::InvalidChunkManifest);
            }
        }
        let raw_size = self.chunks.iter().map(|chunk| chunk.raw_size).sum::<u64>();
        let compressed_size = self
            .chunks
            .iter()
            .map(|chunk| chunk.compressed_size)
            .sum::<u64>();
        if raw_size != self.nar_size || compressed_size != self.file_size {
            return Err(Error::InvalidChunkManifest);
        }
        Ok(())
    }

    pub fn canonical_json(&self) -> Result<Vec<u8>, serde_json::Error> {
        serde_json::to_vec(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessJob {
    pub job_id: String,
    pub staging_key: String,
    pub nar_hash: String,
    pub nar_size: u64,
    pub encoding_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessResult {
    pub manifest_key: String,
    pub manifest: ChunkManifest,
    pub deduplicated: bool,
}
