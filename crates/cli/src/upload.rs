use crate::{
    client::{upload_part_with_retry, Api},
    nix::{basename, make_nar, nix_hash, store_hash},
};
use anyhow::{anyhow, bail, Context, Result};
use cf_nix_cache_core::{
    contracts::api as contract, InitiateUploadResponse, StorePathName, UploadStateResponse,
    UploadStatus,
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
pub(crate) fn manifest(cache: &str, path: &str, info: &Value) -> Result<contract::Manifest> {
    let field = |name: &str| info.get(name).and_then(Value::as_str);
    Ok(contract::Manifest {
        ca: field("ca").map(str::parse).transpose()?,
        cache: cache.parse()?,
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

pub(crate) async fn upload_path(api: &Api, cache: &str, path: &str, info: &Value) -> Result<()> {
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
    if matches!(init.status, UploadStatus::Ready) {
        println!("already uploaded {path}");
        return Ok(());
    }
    if matches!(init.status, UploadStatus::Completing) {
        let _: UploadStateResponse = api
            .request(
                Method::POST,
                &format!("/api/uploads/{}/complete", init.id),
                Some(&contract::CompleteUpload { parts: vec![] }),
            )
            .await?;
        return wait_for_upload(api, &init.id, path).await;
    }
    if matches!(
        init.status,
        UploadStatus::Queued | UploadStatus::Processing | UploadStatus::Publishing
    ) {
        return wait_for_upload(api, &init.id, path).await;
    }
    if !matches!(
        init.status,
        UploadStatus::Uploading | UploadStatus::Completing
    ) {
        bail!("upload {} is not uploadable: {:?}", init.id, init.status);
    }
    let mut completed = Vec::new();
    for part in init.parts {
        let offset = (part.part_number as u64 - 1) * part_size;
        let len = (size - offset).min(part_size) as usize;
        let mut bytes = vec![0; len];
        file.seek(SeekFrom::Start(offset))?;
        file.read_exact(&mut bytes)?;
        let etag = upload_part_with_retry(api, &part.url, bytes, part.part_number).await?;
        completed.push(contract::CompleteUploadPartsItem {
            etag: etag.parse()?,
            part_number: NonZeroU64::new(part.part_number as u64)
                .context("part numbers start at 1")?,
        });
    }
    let _: UploadStateResponse = api
        .request(
            Method::POST,
            &format!("/api/uploads/{}/complete", init.id),
            Some(&contract::CompleteUpload { parts: completed }),
        )
        .await?;
    wait_for_upload(api, &init.id, path).await
}

async fn wait_for_upload(api: &Api, id: &str, path: &str) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(60 * 60);
    let mut delay = Duration::from_secs(2);
    loop {
        if Instant::now() >= deadline {
            bail!("verification timed out for {path}");
        }
        tokio::time::sleep(delay).await;
        let state: UploadStateResponse = api.get(&format!("/api/uploads/{id}")).await?;
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
