use crate::{validate_store_hash, Error};
use serde::{Deserialize, Serialize};
use std::str::FromStr;

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
