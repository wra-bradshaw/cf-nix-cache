//! Thin API wrappers: the cache, token, audit, and upload admin subcommands.

use anyhow::{Context, Result};
use cf_nix_cache_core::{
    contracts::api as contract, AuditEvent, CacheConfig, PageResponse, TokenSummary, ENCODING_ID,
};
use reqwest::Method;
use std::num::NonZeroU64;

use super::{print_json, print_token, valid_for_seconds};
use crate::{
    args::{AuditCommand, CacheCommand, TokenCommand, UploadCommand},
    client::{api_path, page_path, Api},
};

pub(super) async fn cache(api: Api, command: CacheCommand) -> Result<()> {
    match command {
        CacheCommand::List(page) => print_json(
            &api.get::<PageResponse<CacheConfig>>(&page_path("/api/caches", &page)?)
                .await?,
        ),
        CacheCommand::Create {
            name,
            public,
            quota_bytes,
            upstream_cache_key_names,
        } => {
            let body = contract::CreateCache {
                encoding_id: Some(ENCODING_ID.into()),
                name: name.to_string().parse()?,
                public,
                quota_bytes: NonZeroU64::new(quota_bytes)
                    .context("--quota-bytes must be positive")?,
                upstream_cache_key_names: upstream_cache_key_names
                    .iter()
                    .map(|name| name.parse())
                    .collect::<Result<_, _>>()?,
            };
            print_json(
                &api.request::<CacheConfig, _>(Method::POST, "/api/caches", Some(&body))
                    .await?,
            )
        }
        CacheCommand::Info { name } => print_json(
            &api.get::<CacheConfig>(&format!("/api/caches/{name}"))
                .await?,
        ),
        CacheCommand::Configure { name, public } => print_json(
            &api.request::<CacheConfig, _>(
                Method::PATCH,
                &format!("/api/caches/{name}/config"),
                Some(&contract::ConfigureCache {
                    public: Some(public),
                    retention_days: None,
                    upstream_cache_key_names: Vec::new(),
                }),
            )
            .await?,
        ),
        CacheCommand::Retention { name, days } => print_json(
            &api.request::<CacheConfig, _>(
                Method::PATCH,
                &format!("/api/caches/{name}/config"),
                Some(&contract::ConfigureCache {
                    public: None,
                    retention_days: Some(i64::try_from(days)?),
                    upstream_cache_key_names: Vec::new(),
                }),
            )
            .await?,
        ),
        CacheCommand::Upstreams {
            name,
            key_names,
            none: _,
        } => print_json(
            &api.request::<CacheConfig, _>(
                Method::PATCH,
                &format!("/api/caches/{name}/config"),
                // Not the generated DTO, which omits an empty list: clearing
                // the list would then send an empty, rejected request.
                Some(&serde_json::json!({ "upstream_cache_key_names": key_names })),
            )
            .await?,
        ),
        CacheCommand::Delete { name } => {
            api.empty(Method::DELETE, &format!("/api/caches/{name}"))
                .await
        }
    }
}

pub(super) async fn token(api: Api, command: TokenCommand) -> Result<()> {
    match command {
        TokenCommand::List(page) => print_json(
            &api.get::<PageResponse<TokenSummary>>(&page_path("/api/tokens", &page)?)
                .await?,
        ),
        TokenCommand::Create {
            subject,
            grants,
            valid_for,
            output,
        } => {
            let body = contract::TokenRequest {
                grants,
                subject: subject.parse()?,
                valid_for_seconds: valid_for_seconds(valid_for)?,
            };
            print_token(
                &api.request(Method::POST, "/api/tokens", Some(&body))
                    .await?,
                output,
            )
        }
        TokenCommand::Revoke { jti } => {
            api.empty(Method::DELETE, &api_path(&["tokens", &jti]))
                .await
        }
    }
}

pub(super) async fn audit(api: Api, command: AuditCommand) -> Result<()> {
    match command {
        AuditCommand::List(page) => print_json(
            &api.get::<PageResponse<AuditEvent>>(&page_path("/api/audit", &page)?)
                .await?,
        ),
    }
}

pub(super) async fn upload(api: Api, command: UploadCommand) -> Result<()> {
    match command {
        UploadCommand::Cancel { id } => {
            api.empty(Method::DELETE, &api_path(&["uploads", &id]))
                .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_configure_dto_cannot_express_an_empty_list() {
        let body = contract::ConfigureCache {
            public: None,
            retention_days: None,
            upstream_cache_key_names: Vec::new(),
        };
        assert_eq!(serde_json::to_value(body).unwrap(), serde_json::json!({}));
    }
}
