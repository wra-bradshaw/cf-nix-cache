//! Shared protocol primitives split into identifiers, manifests, and wire
//! exports. Wire DTOs are deliberately kept separate from semantic
//! validation and application policy.

mod error;
mod identifiers;
mod manifests;
mod wire;

pub use cf_nix_cache_contracts as contracts;
pub use error::Error;
pub use identifiers::*;
pub use manifests::*;
pub use wire::*;

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
pub(crate) fn default_encoding_id() -> String {
    ENCODING_ID.into()
}

pub fn nix_base32(bytes: &[u8]) -> String {
    nix_base32::to_nix_base32(bytes)
}

/// The Nix base32 alphabet (no `e`, `o`, `u`, or `t`).
const NIX32_ALPHABET: &[u8] = b"0123456789abcdfghijklmnpqrsvwxyz";

fn is_nix32(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| NIX32_ALPHABET.contains(&b))
}

pub fn validate_store_hash(value: &str) -> Result<(), Error> {
    is_nix32(value, 32)
        .then_some(())
        .ok_or(Error::InvalidStoreHash)
}

pub fn validate_nar_hash(value: &str) -> Result<(), Error> {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hash| is_nix32(hash, 52))
        .then_some(())
        .ok_or(Error::InvalidNarHash)
}

#[cfg(test)]
mod tests;
