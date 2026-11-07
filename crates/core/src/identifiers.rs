use crate::Error;
use serde::{Deserialize, Serialize};
use std::str::FromStr;

/// The Nix base32 alphabet (no `e`, `o`, `u`, or `t`).
const NIX32_ALPHABET: &[u8] = b"0123456789abcdfghijklmnpqrsvwxyz";

fn is_nix32(value: &str, len: usize) -> bool {
    value.len() == len && value.bytes().all(|b| NIX32_ALPHABET.contains(&b))
}

pub fn nix_base32(bytes: &[u8]) -> String {
    nix_base32::to_nix_base32(bytes)
}

pub fn validate_store_hash(value: &str) -> Result<(), Error> {
    is_nix32(value, 32)
        .then_some(())
        .ok_or(Error::InvalidStoreHash)
}

pub(crate) fn validate_nar_hash(value: &str) -> Result<(), Error> {
    value
        .strip_prefix("sha256:")
        .is_some_and(|hash| is_nix32(hash, 52))
        .then_some(())
        .ok_or(Error::InvalidNarHash)
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct CacheName(String);

impl<'de> Deserialize<'de> for CacheName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

impl FromStr for CacheName {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let valid = !value.is_empty()
            && value.len() <= 64
            && value
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_');
        valid
            .then(|| Self(value.into()))
            .ok_or(Error::InvalidCacheName)
    }
}

impl std::fmt::Display for CacheName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
#[serde(transparent)]
pub struct StorePathName(String);

impl<'de> Deserialize<'de> for StorePathName {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        value.parse().map_err(serde::de::Error::custom)
    }
}

impl FromStr for StorePathName {
    type Err = Error;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        let Some((hash, name)) = value.split_once('-') else {
            return Err(Error::InvalidStorePathName);
        };
        validate_store_hash(hash)?;
        if name.is_empty()
            || value.len() > 512
            || value.contains('/')
            || value.chars().any(|character| character.is_control())
        {
            return Err(Error::InvalidStorePathName);
        }
        Ok(Self(value.to_owned()))
    }
}

impl std::fmt::Display for StorePathName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_names() {
        assert!("team-cache_1".parse::<CacheName>().is_ok());
        assert!("Bad/cache".parse::<CacheName>().is_err());
        assert!(serde_json::from_str::<CacheName>(r#""Bad/cache""#).is_err());
    }

    #[test]
    fn references_use_nix_store_path_basenames() {
        let valid = format!("{}-glibc-2.39", "0".repeat(32));
        assert!(valid.parse::<StorePathName>().is_ok());
        assert!(format!("/nix/store/{valid}")
            .parse::<StorePathName>()
            .is_err());
        assert!(format!("{}-", "0".repeat(32))
            .parse::<StorePathName>()
            .is_err());
        assert!(format!("{}-bad/name", "0".repeat(32))
            .parse::<StorePathName>()
            .is_err());
    }

    #[test]
    fn validates_nar_hashes() {
        assert!(validate_nar_hash(&format!("sha256:{}", "0".repeat(52))).is_ok());
        assert!(validate_nar_hash("sha256:bad").is_err());
        assert!(validate_nar_hash(&format!("sha512:{}", "0".repeat(52))).is_err());
    }

    #[test]
    fn encodes_nix_base32() {
        assert_eq!(nix_base32(&[0; 32]), "0".repeat(52));
        let mut one = [0; 32];
        one[0] = 1;
        assert_eq!(
            nix_base32(&one),
            "0000000000000000000000000000000000000000000000000001"
        );
    }
}
