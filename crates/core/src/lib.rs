//! Shared protocol types for the CLI and processor: validated identifiers
//! (`identifiers`), chunk manifests and processor jobs (`processing`), and
//! hand-written API response shapes (`wire`). Request DTOs and the processor's
//! HTTP boundary are schema-generated in `contracts`.
//!
//! The response shapes are not free of semantic validation: fields typed with
//! a validating identifier, such as `CacheConfig::name`, reject invalid values
//! during deserialization.

mod error;
mod identifiers;
mod processing;
mod wire;

pub use cf_nix_cache_contracts as contracts;
pub use error::Error;
pub use identifiers::{nix_base32, validate_store_hash, CacheName, StorePathName};
pub use processing::{ChunkManifest, ChunkRef, ProcessJob, ProcessResult};
pub use wire::{
    AuditEvent, CacheConfig, CacheLifecycle, CreateTokenResponse, InitiateUploadResponse,
    MissingPathsResponse, PageResponse, Role, TokenGrant, TokenSummary, UploadPart,
    UploadStateResponse, UploadStatus,
};

pub const MAX_NAR_SIZE: u64 = 10 * 1024 * 1024 * 1024;
pub const MAX_COMPRESSED_SIZE: u64 = 12 * 1024 * 1024 * 1024;
pub const MULTIPART_PART_SIZE: u64 = 64 * 1024 * 1024;
/// Encoding profile id; it names the chunking and compression parameters
/// below, and appears in R2 keys, so the two must never drift apart.
pub const ENCODING_ID: &str = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
pub const CHUNK_MIN_SIZE: usize = 1024 * 1024;
pub const CHUNK_AVG_SIZE: usize = 4 * 1024 * 1024;
pub const CHUNK_MAX_SIZE: usize = 16 * 1024 * 1024;
/// zstd level of each encoded chunk frame (also used for staging uploads).
pub const ZSTD_LEVEL: i32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_id_names_its_parameters() {
        const MIB: usize = 1024 * 1024;
        assert_eq!(
            ENCODING_ID,
            format!(
                "fastcdc-v2020-min{}m-avg{}m-max{}m-zstd{}-v1",
                CHUNK_MIN_SIZE / MIB,
                CHUNK_AVG_SIZE / MIB,
                CHUNK_MAX_SIZE / MIB,
                ZSTD_LEVEL
            )
        );
    }
}
