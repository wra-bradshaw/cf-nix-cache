use crate::{validate_nar_hash, validate_store_hash, CacheName, Error, ENCODING_ID, MAX_NAR_SIZE};
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

impl UploadStatus {
    pub fn transition(self, next: Self) -> Result<Self, Error> {
        use UploadStatus::*;
        match (self, next) {
            (Created, Uploading | Aborted | Failed)
            | (Uploading, Completing | Aborted | Failed)
            | (Completing, Queued | Aborted | Failed)
            | (Queued, Processing | Aborted | Failed)
            | (Processing, Publishing | Failed)
            | (Publishing, Ready | Failed) => Ok(next),
            (a, b) if a == b => Ok(b),
            _ => Err(Error::InvalidTransition(self, next)),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UploadManifest {
    pub cache: CacheName,
    pub store_hash: String,
    pub store_path: String,
    pub nar_hash: String,
    pub nar_size: u64,
    #[serde(default)]
    pub references: Vec<crate::StorePathName>,
    #[serde(default)]
    pub deriver: Option<crate::StorePathName>,
    #[serde(default)]
    pub ca: Option<String>,
}

impl UploadManifest {
    pub fn validate(&self) -> Result<(), Error> {
        const MAX_REFERENCES: usize = 1_024;
        const MAX_METADATA_BYTES: usize = 256 * 1024;
        if self.nar_size > MAX_NAR_SIZE {
            return Err(Error::NarTooLarge);
        }
        if self.references.len() > MAX_REFERENCES
            || serde_json::to_vec(self)
                .map_err(|_| Error::ManifestTooLarge)?
                .len()
                > MAX_METADATA_BYTES
        {
            return Err(Error::ManifestTooLarge);
        }
        validate_store_hash(&self.store_hash)?;
        validate_nar_hash(&self.nar_hash)?;
        let basename = self.store_path.rsplit('/').next().unwrap_or_default();
        if !basename.starts_with(&format!("{}-", self.store_hash))
            || !self.store_path.starts_with("/nix/store/")
            || basename.len() <= self.store_hash.len() + 1
        {
            return Err(Error::StorePathHashMismatch);
        }
        if self.store_path.len() > 512 || self.store_path.chars().any(|c| c.is_control()) {
            return Err(Error::InvalidStoreMetadata);
        }
        for reference in &self.references {
            reference
                .to_string()
                .parse::<crate::StorePathName>()
                .map_err(|_| Error::InvalidReference)?;
        }
        if self
            .deriver
            .as_ref()
            .is_some_and(|value| value.to_string().chars().any(|c| c.is_control()))
            || self.ca.as_ref().is_some_and(|value| {
                value.len() > 512 || value.chars().any(|character| character.is_control())
            })
        {
            return Err(Error::InvalidStoreMetadata);
        }
        if self.store_path.matches('/').count() != 3 {
            return Err(Error::InvalidStorePath);
        }
        Ok(())
    }
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
        if self.nar_size > MAX_NAR_SIZE || self.chunks.is_empty() {
            return Err(Error::ManifestTooLarge);
        }
        for chunk in &self.chunks {
            validate_nar_hash(&chunk.raw_hash)?;
            validate_nar_hash(&chunk.compressed_hash)?;
            if chunk.raw_size == 0
                || chunk.compressed_size == 0
                || chunk.key != format!("chunks/{}/{}.zst", self.encoding_id, chunk.raw_hash)
            {
                return Err(Error::ManifestTooLarge);
            }
        }
        let raw_size = self.chunks.iter().map(|chunk| chunk.raw_size).sum::<u64>();
        let compressed_size = self
            .chunks
            .iter()
            .map(|chunk| chunk.compressed_size)
            .sum::<u64>();
        if raw_size != self.nar_size || compressed_size != self.file_size {
            return Err(Error::ManifestTooLarge);
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
