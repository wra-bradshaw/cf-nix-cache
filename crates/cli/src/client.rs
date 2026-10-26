use anyhow::{bail, Context, Result};
use cf_nix_cache_core::{contracts::api as contract, CreateTokenResponse};
use reqwest::{Client, Method};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;
use uuid::Uuid;

use crate::config::Config;

fn retrying_client() -> ClientWithMiddleware {
    let policy = ExponentialBackoff::builder()
        .retry_bounds(Duration::from_millis(250), Duration::from_secs(4))
        .build_with_max_retries(3);
    ClientBuilder::new(Client::new())
        .with(RetryTransientMiddleware::new_with_policy(policy))
        .build()
}

pub(crate) struct Api {
    client: ClientWithMiddleware,
    retry_client: ClientWithMiddleware,
    pub(crate) endpoint: String,
    token: Option<String>,
}

pub(crate) async fn bootstrap(
    endpoint: String,
    body: &contract::BootstrapRequest,
) -> Result<CreateTokenResponse> {
    let endpoint = endpoint.trim_end_matches('/');
    let url = format!("{endpoint}/api/bootstrap");
    let client = retrying_client();
    let key = new_idempotency_key();
    let response = client
        .post(&url)
        .header("Idempotency-Key", key)
        .json(body)
        .send()
        .await?;
    let status = response.status();
    let bytes = response.bytes().await?;
    if !status.is_success() {
        bail!(
            "bootstrap API returned {status}: {}",
            String::from_utf8_lossy(&bytes)
        );
    }
    Ok(serde_json::from_slice(&bytes)?)
}

impl Api {
    pub(crate) fn new(args_endpoint: Option<String>, config: &Config) -> Result<Self> {
        Ok(Self {
            client: ClientBuilder::new(Client::new()).build(),
            retry_client: retrying_client(),
            endpoint: args_endpoint
                .or_else(|| config.endpoint.clone())
                .context("--endpoint is required")?
                .trim_end_matches('/')
                .into(),
            token: std::env::var("CF_NIX_CACHE_TOKEN")
                .ok()
                .filter(|token| !token.is_empty())
                .or_else(|| config.token.clone()),
        })
    }

    /// The bearer token; only commands that call authenticated routes need it.
    fn token(&self) -> Result<&str> {
        self.token
            .as_deref()
            .context("not logged in; set CF_NIX_CACHE_TOKEN or run login")
    }

    pub(crate) async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        self.request(Method::GET, path, None::<&()>).await
    }

    /// Sends `body`, a generated contract DTO, as JSON.
    pub(crate) async fn request<T: DeserializeOwned, B: Serialize>(
        &self,
        method: Method,
        path: &str,
        body: Option<&B>,
    ) -> Result<T> {
        let retry_safe = retry_safe(&method, path);
        let mut request = if retry_safe {
            self.retry_client
                .request(method.clone(), format!("{}{}", self.endpoint, path))
        } else {
            self.client
                .request(method.clone(), format!("{}{}", self.endpoint, path))
        }
        .bearer_auth(self.token()?);
        if matches!(
            method,
            Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        ) {
            request = request.header("Idempotency-Key", new_idempotency_key());
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await?;
        let status = response.status();
        let bytes = response.bytes().await?;
        if !status.is_success() {
            bail!("API returned {status}: {}", String::from_utf8_lossy(&bytes));
        }
        Ok(serde_json::from_slice(&bytes)?)
    }

    pub(crate) async fn text(&self, path: &str) -> Result<String> {
        let response = self
            .retry_client
            .get(format!("{}{}", self.endpoint, path))
            .send()
            .await?;
        if !response.status().is_success() {
            bail!("API returned {}", response.status());
        }
        Ok(response.text().await?)
    }

    pub(crate) async fn empty(&self, method: Method, path: &str) -> Result<()> {
        let key = new_idempotency_key();
        let request = if retry_safe(&method, path) {
            self.retry_client
                .request(method.clone(), format!("{}{}", self.endpoint, path))
        } else {
            self.client
                .request(method.clone(), format!("{}{}", self.endpoint, path))
        };
        let response = request
            .bearer_auth(self.token()?)
            .header("Idempotency-Key", key)
            .send()
            .await?;
        if !response.status().is_success() {
            bail!(
                "API returned {}: {}",
                response.status(),
                response.text().await?
            );
        }
        Ok(())
    }
}

fn retry_safe(method: &Method, path: &str) -> bool {
    method == Method::GET
        || method == Method::HEAD
        || method == Method::PATCH
        || method == Method::DELETE
        || path.ends_with("/missing")
        || path.starts_with("/api/uploads/")
        || path == "/api/uploads"
}

/// A key identifies one user-intended operation, not the content of a
/// request forever. The retry middleware reuses the request (and this
/// header) for transient retries, while a later CLI invocation gets a new
/// operation and can legitimately upload or issue an identical resource.
fn new_idempotency_key() -> String {
    Uuid::new_v4().simple().to_string()
}

pub(crate) async fn upload_part_with_retry(
    api: &Api,
    url: &str,
    bytes: Vec<u8>,
    part: i32,
) -> Result<String> {
    let response = api
        .retry_client
        .put(url)
        .bearer_auth(api.token()?)
        .header("Idempotency-Key", new_idempotency_key())
        .body(bytes)
        .send()
        .await?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        bail!("upload part {part} failed: {status}: {body}");
    }
    response
        .headers()
        .get("etag")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
        .context("S3 response omitted ETag")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retries_only_safe_or_explicitly_idempotent_operations() {
        assert!(retry_safe(&Method::GET, "/api/caches/a/info"));
        assert!(retry_safe(&Method::POST, "/api/caches/a/missing"));
        assert!(retry_safe(&Method::POST, "/api/uploads"));
        assert!(retry_safe(&Method::POST, "/api/uploads/u1"));
        assert!(!retry_safe(&Method::POST, "/api/caches"));
        assert!(!retry_safe(&Method::POST, "/api/tokens"));
    }

    #[test]
    fn each_cli_invocation_gets_a_fresh_operation_key() {
        let first = new_idempotency_key();
        let second = new_idempotency_key();
        assert_ne!(first, second);
        assert_eq!(first.len(), 32);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
    }
}
