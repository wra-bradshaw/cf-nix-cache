use crate::UploadStatus;

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
