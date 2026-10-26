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
pub const ENCODING_ID: &str = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
pub(crate) fn default_encoding_id() -> String {
    ENCODING_ID.into()
}

pub fn nix_base32(bytes: &[u8]) -> String {
    nix_base32::to_nix_base32(bytes)
}

pub fn validate_store_hash(value: &str) -> Result<(), Error> {
    const NIX32: &[u8] = b"0123456789abcdfghijklmnpqrsvwxyz";
    (value.len() == 32 && value.bytes().all(|b| NIX32.contains(&b)))
        .then_some(())
        .ok_or(Error::InvalidStoreHash)
}

pub fn validate_nar_hash(value: &str) -> Result<(), Error> {
    let Some(hash) = value.strip_prefix("sha256:") else {
        return Err(Error::InvalidNarHash);
    };
    (hash.len() == 52
        && hash
            .bytes()
            .all(|b| b"0123456789abcdfghijklmnpqrsvwxyz".contains(&b)))
    .then_some(())
    .ok_or(Error::InvalidNarHash)
}

#[cfg(test)]
mod tests;
