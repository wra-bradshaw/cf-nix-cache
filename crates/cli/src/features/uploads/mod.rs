use crate::{
    features::nix::{basename, make_nar, nix_hash, store_hash},
    infrastructure::client::{upload_part_with_retry, Api},
};
use anyhow::{bail, Context, Result};
use cf_nix_cache_core::{
    CompleteUploadRequest, CompletedPart, InitiateUploadRequest, InitiateUploadResponse,
    StorePathName, UploadManifest, UploadStateResponse, UploadStatus,
};
use reqwest::Method;
use serde_json::Value;
use std::{
    io::{Read, Seek, SeekFrom},
    time::{Duration, Instant},
};

pub(crate) async fn upload_path(api: &Api, cache: &str, path: &str, info: &Value) -> Result<()> {
    let mut file = make_nar(path)?;
    let size = file.as_file().metadata()?.len();
    let part_size = cf_nix_cache_core::MULTIPART_PART_SIZE;
    let store_hash = store_hash(path)?;
    let refs = info
        .get("references")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(|value| {
            basename(value)?
                .parse::<StorePathName>()
                .map_err(|error| anyhow::anyhow!(error))
        })
        .collect::<Result<Vec<_>>>()?;
    let manifest = UploadManifest {
        cache: cache.parse()?,
        store_hash,
        store_path: path.into(),
        nar_hash: nix_hash(
            info.get("narHash")
                .and_then(Value::as_str)
                .context("missing narHash")?,
        )?,
        nar_size: info
            .get("narSize")
            .and_then(Value::as_u64)
            .context("missing narSize")?,
        references: refs,
        deriver: info
            .get("deriver")
            .and_then(Value::as_str)
            .map(|value| {
                basename(value)?
                    .parse::<StorePathName>()
                    .map_err(|error| anyhow::anyhow!(error))
            })
            .transpose()?,
        ca: info.get("ca").and_then(Value::as_str).map(str::to_owned),
    };
    let init: InitiateUploadResponse = api
        .request(
            Method::POST,
            "/api/uploads",
            Some(serde_json::to_value(InitiateUploadRequest {
                manifest,
                compressed_size: size,
            })?),
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
                Some(serde_json::to_value(CompleteUploadRequest {
                    parts: vec![],
                })?),
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
        completed.push(CompletedPart {
            part_number: part.part_number,
            etag,
        });
    }
    let _: UploadStateResponse = api
        .request(
            Method::POST,
            &format!("/api/uploads/{}/complete", init.id),
            Some(serde_json::to_value(CompleteUploadRequest {
                parts: completed,
            })?),
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
        let state: UploadStateResponse = api
            .request(Method::GET, &format!("/api/uploads/{id}"), None)
            .await?;
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
