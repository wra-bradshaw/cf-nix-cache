use crate::{
    contracts::process_job::CfNixCacheProcessorJob, identifiers::validate_nar_hash, Error,
    ENCODING_ID, MAX_NAR_SIZE,
};
use serde::{Deserialize, Serialize};

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
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcessJob {
    pub job_id: String,
    /// The upload's chunk list. The chunks are already stored; processing
    /// verifies them and writes the manifest.
    pub chunks_key: String,
    pub nar_hash: String,
    pub nar_size: u64,
    pub encoding_id: String,
}

/// The schema-generated job is the processor's HTTP boundary; this keeps
/// only the encoding this build implements.
impl TryFrom<CfNixCacheProcessorJob> for ProcessJob {
    type Error = Error;

    fn try_from(job: CfNixCacheProcessorJob) -> Result<Self, Error> {
        if job.encoding_id != ENCODING_ID {
            return Err(Error::InvalidEncoding);
        }
        Ok(Self {
            job_id: job.job_id.into(),
            chunks_key: job.chunks_key.into(),
            nar_hash: job.nar_hash.into(),
            nar_size: job.nar_size.get(),
            encoding_id: ENCODING_ID.into(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProcessResult {
    pub manifest_key: String,
    pub manifest: ChunkManifest,
    pub deduplicated: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_chunk_manifest_totals_and_encoding() {
        let manifest = ChunkManifest {
            encoding_id: ENCODING_ID.into(),
            nar_hash: format!("sha256:{}", "0".repeat(52)),
            nar_size: 3,
            file_hash: format!("sha256:{}", "1".repeat(52)),
            file_size: 4,
            chunks: vec![ChunkRef {
                raw_hash: format!("sha256:{}", "2".repeat(52)),
                raw_size: 3,
                compressed_hash: format!("sha256:{}", "3".repeat(52)),
                compressed_size: 4,
                key: format!("chunks/{}/sha256:{}.zst", ENCODING_ID, "2".repeat(52)),
            }],
            processing_version: "test".into(),
            created_at: 1,
        };
        assert!(manifest.validate().is_ok());
        let mut invalid = manifest.clone();
        invalid.file_size = 5;
        assert_eq!(invalid.validate(), Err(Error::InvalidChunkManifest));
        let mut empty = manifest.clone();
        empty.chunks.clear();
        assert_eq!(empty.validate(), Err(Error::InvalidChunkManifest));
        let mut invalid_hash = manifest;
        invalid_hash.file_hash = format!("sha256:{}", "o".repeat(52));
        assert!(invalid_hash.validate().is_err());
    }

    #[test]
    fn converts_contract_process_jobs() {
        let contract = |encoding_id: &str| {
            serde_json::from_value::<CfNixCacheProcessorJob>(serde_json::json!({
                "job_id": "job",
                "chunks_key": "staging/job.chunks.json",
                "nar_hash": format!("sha256:{}", "0".repeat(52)),
                "nar_size": 9,
                "encoding_id": encoding_id,
            }))
            .unwrap()
        };
        assert_eq!(
            ProcessJob::try_from(contract(ENCODING_ID)),
            Ok(ProcessJob {
                job_id: "job".into(),
                chunks_key: "staging/job.chunks.json".into(),
                nar_hash: format!("sha256:{}", "0".repeat(52)),
                nar_size: 9,
                encoding_id: ENCODING_ID.into(),
            })
        );
        assert_eq!(
            ProcessJob::try_from(contract("other-v1")),
            Err(Error::InvalidEncoding)
        );
    }
}
