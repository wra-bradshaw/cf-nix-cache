//! Shared protocol primitives split into identifiers, manifests, NAR metadata,
//! and wire exports. Wire DTOs are deliberately kept separate from semantic
//! validation and application policy.

mod domain;

pub use cf_nix_cache_contracts as contracts;
pub use domain::auth::TokenClaims;
pub use domain::identifiers::*;
pub use domain::manifests::*;
pub use domain::narinfo::NarInfo;
pub use domain::wire::*;

pub const MAX_NAR_SIZE: u64 = 10 * 1024 * 1024 * 1024;
pub const MAX_COMPRESSED_SIZE: u64 = 12 * 1024 * 1024 * 1024;
pub const MULTIPART_PART_SIZE: u64 = 64 * 1024 * 1024;
pub const CANONICAL_FORMAT_VERSION: u32 = 1;
pub const CANONICAL_COMPRESSION: &str = "zstd";
pub const CANONICAL_COMPRESSION_LEVEL: i32 = 3;
pub const ENCODING_ID: &str = "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1";
pub(crate) fn default_encoding_id() -> String {
    ENCODING_ID.into()
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Error {
    #[error("cache names must be 1-64 lowercase letters, digits, '-' or '_'")]
    InvalidCacheName,
    #[error("invalid upload transition from {0:?} to {1:?}")]
    InvalidTransition(UploadStatus, UploadStatus),
    #[error("NAR exceeds the configured 10 GiB limit")]
    NarTooLarge,
    #[error("store hashes must be 32 lowercase Nix base32 characters")]
    InvalidStoreHash,
    #[error("NAR hashes must be sha256:<52 lowercase Nix base32 characters>")]
    InvalidNarHash,
    #[error("store path does not contain the declared store hash")]
    StorePathHashMismatch,
    #[error("invalid store path")]
    InvalidStorePath,
    #[error("invalid reference path")]
    InvalidReference,
    #[error("store path names must contain a 32-character Nix hash, '-', and a non-empty name")]
    InvalidStorePathName,
    #[error("idempotency keys must be 1-128 printable characters")]
    InvalidIdempotencyKey,
    #[error("token subject must be 1-256 characters")]
    InvalidTokenSubject,
    #[error("token grant contains an invalid cache or role")]
    InvalidTokenGrant,
    #[error("token claims contain an invalid identifier or issuer")]
    InvalidTokenClaims,
    #[error("store path metadata contains invalid characters or is too large")]
    InvalidStoreMetadata,
    #[error("manifest contains too many references or is too large")]
    ManifestTooLarge,
    #[error("unsupported encoding profile")]
    InvalidEncoding,
}

pub fn nix_base32(bytes: &[u8]) -> String {
    nix_base32::to_nix_base32(bytes)
}

pub fn validate_idempotency_key(value: &str) -> Result<(), Error> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
    {
        return Err(Error::InvalidIdempotencyKey);
    }
    Ok(())
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
