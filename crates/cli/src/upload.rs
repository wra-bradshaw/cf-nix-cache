use crate::{
    client::{api_path, Api},
    nix::{basename, make_nar, nix_hash, store_hash},
};
use anyhow::{anyhow, bail, Context, Result};
use cf_nix_cache_core::{
    contracts::api as contract, CacheName, InitiateUploadResponse, StorePathName,
    UploadStateResponse, UploadStatus,
};
use reqwest::Method;
use serde_json::Value;
use std::{
    fmt::Display,
    io::{Read, Seek, SeekFrom},
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
pub(crate) fn manifest(cache: &CacheName, path: &str, info: &Value) -> Result<contract::Manifest> {
    let field = |name: &str| info.get(name).and_then(Value::as_str);
    Ok(contract::Manifest {
        ca: field("ca").map(str::parse).transpose()?,
        cache: cache.to_string().parse()?,
        deriver: field("deriver").map(store_path_name).transpose()?,
        nar_hash: nix_hash(field("narHash").context("missing narHash")?)?.parse()?,
        nar_size: info
            .get("narSize")
            .and_then(Value::as_u64)
            .and_then(NonZeroU64::new)
            .context("missing narSize")?,
        references: info
            .get("references")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(store_path_name)
            .collect::<Result<_>>()?,
        store_hash: store_hash(path)?.parse()?,
        store_path: path.parse()?,
    })
}

pub(crate) async fn upload_path(
    api: &Api,
    cache: &CacheName,
    path: &str,
    info: &Value,
) -> Result<()> {
    let mut file = make_nar(path)?;
    let size = file.as_file().metadata()?.len();
    let part_size = cf_nix_cache_core::MULTIPART_PART_SIZE;
    let manifest = manifest(cache, path, info)?;
    let init: InitiateUploadResponse = api
        .request(
            Method::POST,
            "/api/uploads",
            Some(&contract::UploadRequest {
                compressed_size: NonZeroU64::new(size).context("compressed NAR is empty")?,
                manifest,
            }),
        )
        .await?;
    match init.status {
        UploadStatus::Ready => {
            println!("already uploaded {path}");
            return Ok(());
        }
        UploadStatus::Queued | UploadStatus::Processing | UploadStatus::Publishing => {
            return wait_for_upload(api, &init.id, path).await;
        }
        UploadStatus::Uploading => {}
        status => bail!("upload {} is not uploadable: {status:?}", init.id),
    }
    let expected_parts = size.div_ceil(part_size);
    if init.parts.len() as u64 != expected_parts {
        bail!(
            "server returned {} upload parts for a {size}-byte NAR; expected {expected_parts}",
            init.parts.len()
        );
    }
    let mut completed = Vec::new();
    for part in init.parts {
        let (offset, len) = part_range(part.part_number, part_size, size)?;
        let mut bytes = vec![0; usize::try_from(len)?];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)?;
        let etag = api
            .upload_part(&part.url, bytes)
            .await
            .with_context(|| format!("upload part {} failed", part.part_number))?;
        completed.push(contract::CompleteUploadPartsItem {
            etag: etag.parse()?,
            part_number: NonZeroU64::new(part.part_number as u64)
                .context("part numbers start at 1")?,
        });
    }
    let _: UploadStateResponse = api
        .request(
            Method::POST,
            &api_path(&["uploads", &init.id, "complete"]),
            Some(&contract::CompleteUpload { parts: completed }),
        )
        .await?;
    wait_for_upload(api, &init.id, path).await
}

/// The `(offset, len)` byte range of 1-based `part_number` in a `size`-byte
/// file split into `part_size` parts.
fn part_range(part_number: i32, part_size: u64, size: u64) -> Result<(u64, u64)> {
    let index = u64::try_from(part_number)
        .ok()
        .and_then(|number| number.checked_sub(1))
        .context("upload part numbers start at 1")?;
    let offset = index
        .checked_mul(part_size)
        .filter(|offset| *offset < size)
        .with_context(|| format!("upload part {part_number} is past the end of the NAR"))?;
    Ok((offset, (size - offset).min(part_size)))
}

async fn wait_for_upload(api: &Api, id: &str, path: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    let mut delay = Duration::from_secs(2);
    loop {
        if Instant::now() >= deadline {
            bail!("verification timed out for {path}");
        }
        tokio::time::sleep(delay).await;
        let state: UploadStateResponse = api.get(&api_path(&["uploads", id])).await?;
        match state.status {
            UploadStatus::Ready => break,
            UploadStatus::Failed | UploadStatus::Aborted => {
                bail!("verification failed: {}", state.error.unwrap_or_default())
            }
            _ => {}
        }
        delay = (delay * 2).min(Duration::from_secs(30));
    }
    println!("uploaded {path}");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn part_ranges_are_checked() {
        assert_eq!(part_range(1, 64, 100).unwrap(), (0, 64));
        assert_eq!(part_range(2, 64, 100).unwrap(), (64, 36));
        assert_eq!(part_range(1, 64, 64).unwrap(), (0, 64));
        assert!(part_range(2, 64, 64).is_err());
        assert!(part_range(0, 64, 100).is_err());
        assert!(part_range(-1, 64, 100).is_err());
        assert!(part_range(i32::MAX, u64::MAX, 100).is_err());
    }
}
