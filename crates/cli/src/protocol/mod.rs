mod identifiers;
mod wire;

pub use cf_nix_cache_contracts as contracts;
pub use identifiers::{nix_base32, validate_store_hash, CacheName, StorePathName};
pub use wire::{
    EncodedCompleteBatchResponse, EncodedUploadBatchResponse, EncodedUploadResponse,
    MissingPathsResponse, UploadStateResponse, UploadStatus,
};

/// Encoding profile id; R2 keys embed it, so the two must never drift.
/// Canonical values duplicated across crates; `upload-nar.mts --check-drift` gates joint drift.
pub const ENCODING_ID: &str = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
pub const CHUNK_MIN_SIZE: usize = 1024 * 1024;
pub const CHUNK_AVG_SIZE: usize = 4 * 1024 * 1024;
pub const CHUNK_MAX_SIZE: usize = 16 * 1024 * 1024;
pub const ZSTD_LEVEL: i32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_id_names_its_parameters() {
        const MIB: usize = 1024 * 1024;
        assert_eq!(CHUNK_MIN_SIZE, MIB);
        assert_eq!(CHUNK_AVG_SIZE, 4 * MIB);
        assert_eq!(CHUNK_MAX_SIZE, 16 * MIB);
        assert_eq!(CHUNK_MAX_SIZE, cf_nix_verify_raw_max_for_test());
        assert_eq!(ZSTD_LEVEL, 3);
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
        assert_eq!(ENCODING_ID, "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1");
    }

    /// Hardcoded copy of the verify crate's maximum; the drift script is the cross-crate gate.
    fn cf_nix_verify_raw_max_for_test() -> usize {
        16 * 1024 * 1024
    }
}
