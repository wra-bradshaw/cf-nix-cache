use anyhow::{Context, Result};
use cf_nix_cache_core::{
    contracts::api as contract, AuditEvent, CacheConfig, CreateTokenResponse, MissingPathsResponse,
    PageResponse, TokenSummary, ENCODING_ID,
};
use reqwest::Method;
use std::{num::NonZeroU64, process::Command};

use crate::{
    args::{
        page_path, valid_for_seconds, AuditCommand, CacheCommand, CommandKind, TokenCommand,
        TokenOutput, UploadCommand,
    },
    client::Api,
    nix::{command_json, store_hash},
    upload::upload_path,
};

pub(crate) async fn run(command: CommandKind, api: Api) -> Result<()> {
    match command {
        CommandKind::Cache { command } => cache(api, command).await,
        CommandKind::Token { command } => token(api, command).await,
        CommandKind::Audit { command } => audit(api, command).await,
        CommandKind::Upload { command } => upload(api, command).await,
        CommandKind::Push {
            cache,
            installables,
        } => push(api, cache, installables).await,
        CommandKind::ConfigureNix { cache } => configure_nix(api, cache).await,
        CommandKind::Bootstrap { .. } | CommandKind::Login { .. } => {
            unreachable!("handled before API construction")
        }
    }
}

async fn cache(api: Api, command: CacheCommand) -> Result<()> {
    match command {
        CacheCommand::List(page) => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.get::<PageResponse<CacheConfig>>(&page_path("/api/caches", &page)?)
                    .await?
            )?
        ),
        CacheCommand::Create {
            name,
            public,
            quota_bytes,
        } => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.request::<CacheConfig, _>(
                    Method::POST,
                    "/api/caches",
                    Some(&contract::CreateCache {
                        encoding_id: Some(ENCODING_ID.into()),
                        name: name.parse()?,
                        public,
                        quota_bytes: NonZeroU64::new(quota_bytes)
                            .context("--quota-bytes must be positive")?,
                    })
                )
                .await?
            )?
        ),
        CacheCommand::Info { name } => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.get::<CacheConfig>(&format!("/api/caches/{name}"))
                    .await?
            )?
        ),
        CacheCommand::Configure { name, public } => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.request::<CacheConfig, _>(
                    Method::PATCH,
                    &format!("/api/caches/{name}/config"),
                    Some(&contract::ConfigureCache { public })
                )
                .await?
            )?
        ),
        CacheCommand::Delete { name } => {
            api.empty(Method::DELETE, &format!("/api/caches/{name}"))
                .await?
        }
    }
    Ok(())
}

async fn token(api: Api, command: TokenCommand) -> Result<()> {
    match command {
        TokenCommand::List(page) => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.get::<PageResponse<TokenSummary>>(&page_path("/api/tokens", &page)?)
                    .await?
            )?
        ),
        TokenCommand::Create {
            subject,
            grants,
            valid_for,
            output,
        } => {
            let value: CreateTokenResponse = api
                .request(
                    Method::POST,
                    "/api/tokens",
                    Some(&contract::TokenRequest {
                        grants,
                        subject: subject.parse()?,
                        valid_for_seconds: valid_for_seconds(valid_for)?,
                    }),
                )
                .await?;
            match output {
                TokenOutput::Token => println!("{}", value.token),
                TokenOutput::Json => println!("{}", serde_json::to_string_pretty(&value)?),
            }
        }
        TokenCommand::Revoke { jti } => {
            api.empty(Method::DELETE, &format!("/api/tokens/{jti}"))
                .await?
        }
    }
    Ok(())
}

async fn audit(api: Api, command: AuditCommand) -> Result<()> {
    match command {
        AuditCommand::List(page) => println!(
            "{}",
            serde_json::to_string_pretty(
                &api.get::<PageResponse<AuditEvent>>(&page_path("/api/audit", &page)?)
                    .await?
            )?
        ),
    }
    Ok(())
}

async fn upload(api: Api, command: UploadCommand) -> Result<()> {
    match command {
        UploadCommand::Cancel { id } => {
            api.empty(Method::DELETE, &format!("/api/uploads/{id}"))
                .await?
        }
    }
    Ok(())
}

async fn push(api: Api, cache: String, installables: Vec<String>) -> Result<()> {
    let mut command = Command::new("nix");
    command
        .args(["path-info", "--json", "--recursive"])
        .args(&installables);
    let value = command_json(command)?;
    let map = value
        .as_object()
        .context("unexpected nix path-info response")?;
    let hashes = map
        .keys()
        .map(|path| store_hash(path))
        .collect::<Result<Vec<_>>>()?;
    let mut missing = std::collections::BTreeSet::new();
    for batch in hashes.chunks(100) {
        let result: MissingPathsResponse = api
            .request(
                Method::POST,
                &format!("/api/caches/{cache}/missing"),
                Some(&contract::MissingPaths {
                    store_hashes: batch
                        .iter()
                        .map(|hash| hash.parse())
                        .collect::<Result<_, _>>()?,
                }),
            )
            .await?;
        missing.extend(result.missing);
    }
    for (path, info) in map {
        if missing.contains(&store_hash(path)?) {
            upload_path(&api, &cache, path, info).await?
        } else {
            println!("already cached {path}");
        }
    }
    Ok(())
}

async fn configure_nix(api: Api, cache: String) -> Result<()> {
    let public_key = api.text("/api/public-key").await?;
    let trusted_keys = public_key.split_whitespace().collect::<Vec<_>>().join(" ");
    println!("substituters = {}/cache/{cache}\ntrusted-public-keys = {trusted_keys}\nnetrc-file = ~/.config/nix/netrc\n\nnetrc entry:\nmachine {} login token password <token>", api.endpoint, api.endpoint.trim_start_matches("https://").split('/').next().unwrap_or(""));
    Ok(())
}
