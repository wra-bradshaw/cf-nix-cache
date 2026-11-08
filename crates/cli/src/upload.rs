//! Helpers shared by uploads: the path metadata the server publishes, and
//! waiting for an upload to finish.

use crate::protocol::{
    contracts::api as contract, CacheName, StorePathName, UploadStateResponse, UploadStatus,
};
use crate::{
    client::{api_path, Api},
    nix::{basename, nix_hash, store_hash, PathInfo},
};
use anyhow::{anyhow, bail, Context, Result};
use std::{
    fmt::Display,
    num::NonZeroU64,
    time::{Duration, Instant},
};

/// Validates the basename of `path` as a store path name and converts it to
/// the contract type `T`.
fn store_path_name<T>(path: &str) -> Result<T>
where
    T: TryFrom<String>,
    T::Error: Display,
{
    let name: StorePathName = basename(path)?.parse()?;
    T::try_from(name.to_string()).map_err(|error| anyhow!("{error}"))
}

/// Builds the upload manifest for `path` from its `nix path-info` entry.
pub(crate) fn manifest(
    cache: &CacheName,
    path: &str,
    info: &PathInfo,
) -> Result<contract::Manifest> {
    Ok(contract::Manifest {
        ca: info.ca.as_deref().map(str::parse).transpose()?,
        cache: cache.to_string().parse()?,
        deriver: info.deriver.as_deref().map(store_path_name).transpose()?,
        nar_hash: nix_hash(&info.nar_hash)?.parse()?,
        nar_size: NonZeroU64::new(info.nar_size).context("narSize is zero")?,
        references: info
            .references
            .iter()
            .map(|reference| store_path_name(reference))
            .collect::<Result<_>>()?,
        store_hash: store_hash(path)?.parse()?,
        store_path: path.parse()?,
    })
}

/// Polls an upload until it is READY, FAILED or ABORTED.
pub(crate) async fn wait_for_state(api: &Api, id: &str, path: &str) -> Result<UploadStateResponse> {
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    let mut delay = Duration::from_secs(2);
    loop {
        if Instant::now() >= deadline {
            bail!("verification timed out for {path}");
        }
        tokio::time::sleep(delay).await;
        let state: UploadStateResponse = api.get(&api_path(&["uploads", id])).await?;
        if matches!(
            state.status,
            UploadStatus::Ready | UploadStatus::Failed | UploadStatus::Aborted
        ) {
            return Ok(state);
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
}
