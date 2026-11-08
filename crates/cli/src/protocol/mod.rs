//! Protocol types for the CLI: validated identifiers (`identifiers`) and the
//! API responses it acts on (`wire`). Request DTOs are schema-generated in
//! `contracts`.

mod identifiers;
mod wire;

pub use cf_nix_cache_contracts as contracts;
pub use identifiers::{nix_base32, validate_store_hash, CacheName, StorePathName};
pub use wire::{
    EncodedCompleteBatchResponse, EncodedUploadBatchResponse, EncodedUploadResponse,
    MissingPathsResponse, UploadStateResponse, UploadStatus,
};

/// Encoding profile id; it names the chunking and compression parameters
/// below, and appears in R2 keys, so the two must never drift apart.
/// Canonical values, duplicated in `crates/verify/src/lib.rs`
/// (`CHUNK_MAX_RAW_SIZE`), `packages/worker/src/features/uploads/encoding.ts`
/// (`CHUNK_MAX_RAW_SIZE`, `CHUNK_MAX_COMPRESSED_SIZE`), and
/// `bench/verify-worker/upload-nar.mts` (see `encoding_constants_stay_in_sync`
/// in the verify crate). The single cross-crate gate is the
/// `check-encoding-constants` CI step, which runs
/// `bench/verify-worker/upload-nar.mts --check-drift`: that script
/// re-reads this file, `crates/verify/src/lib.rs`,
/// `packages/worker/src/features/uploads/encoding.ts`, and
/// `packages/worker/src/features/cache/types.ts` and fails on any drift, so
/// a joint drift of the hardcoded literals cannot pass CI even though each
/// crate's own test would.
pub const ENCODING_ID: &str = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
pub const CHUNK_MIN_SIZE: usize = 1024 * 1024;
pub const CHUNK_AVG_SIZE: usize = 4 * 1024 * 1024;
pub const CHUNK_MAX_SIZE: usize = 16 * 1024 * 1024;
/// zstd level of each encoded chunk frame.
pub const ZSTD_LEVEL: i32 = 3;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoding_id_names_its_parameters() {
        const MIB: usize = 1024 * 1024;
        // Canonical values; must match CHUNK_MAX_RAW_SIZE /
        // CHUNK_MAX_COMPRESSED_SIZE in crates/verify/src/lib.rs (see
        // encoding_constants_stay_in_sync there), CHUNK_MAX_RAW_SIZE /
        // CHUNK_MAX_COMPRESSED_SIZE in
        // packages/worker/src/features/uploads/encoding.ts and the verifier
        // limits in packages/worker/src/features/uploads/verifier.ts, and
        // ENCODING_ID / CHUNK in bench/verify-worker/upload-nar.mts. The
        // verify crate stays free of the CLI's tokio dependency, so the
        // values are duplicated here and tied by these hardcoded pins rather
        // than by import.
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

    /// Hardcoded copy of the verify crate's canonical raw maximum, without
    /// adding a dependency from the CLI to the verify crate (which must stay
    /// free of tokio). The value is therefore hardcoded in both crates: here
    /// and in `encoding_constants_stay_in_sync` in the verify crate. Each
    /// crate pins its own copy (`encoding_id_names_its_parameters` here
    /// asserts `CHUNK_MAX_SIZE` equals this function; the verify test
    /// asserts its constant equals 16 MiB), so a drift in either constant
    /// fails that crate's test. A joint drift of both literals would still
    /// pass both suites, so the `check-encoding-constants` CI step (which
    /// runs `bench/verify-worker/upload-nar.mts --check-drift` over this
    /// file and the verify crate) is the single cross-crate gate.
    fn cf_nix_verify_raw_max_for_test() -> usize {
        16 * 1024 * 1024
    }
}
