#[derive(Debug, thiserror::Error, PartialEq)]
pub enum Error {
    #[error("cache names must be 1-64 lowercase letters, digits, '-' or '_'")]
    InvalidCacheName,
    #[error("store hashes must be 32 lowercase Nix base32 characters")]
    InvalidStoreHash,
    #[error("NAR hashes must be sha256:<52 lowercase Nix base32 characters>")]
    InvalidNarHash,
    #[error("store path names must contain a 32-character Nix hash, '-', and a non-empty name")]
    InvalidStorePathName,
    #[error("manifest contains too many references or is too large")]
    ManifestTooLarge,
    #[error("unsupported encoding profile")]
    InvalidEncoding,
    #[error("chunk manifest is inconsistent with its chunks")]
    InvalidChunkManifest,
}
