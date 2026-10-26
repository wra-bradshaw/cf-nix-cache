use anyhow::{bail, Context, Result};
use cf_nix_cache_core::{contracts::api as contract, CreateTokenResponse};
use reqwest::{Client, Method, Response, Url};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, RequestBuilder};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;
use uuid::Uuid;

use crate::config::Config;

pub(crate) struct Api {
    client: ClientWithMiddleware,
    retry_client: ClientWithMiddleware,
    pub(crate) endpoint: String,
    token: Option<String>,
}

impl Api {
    pub(crate) fn new(args_endpoint: Option<String>, config: &Config) -> Result<Self> {
        // Both middleware stacks share one connection pool.
        let http = Client::new();
        let policy = ExponentialBackoff::builder()
            .retry_bounds(Duration::from_millis(250), Duration::from_secs(4))
            .build_with_max_retries(3);
        Ok(Self {
            client: ClientBuilder::new(http.clone()).build(),
            retry_client: ClientBuilder::new(http)
                .with(RetryTransientMiddleware::new_with_policy(policy))
                .build(),
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

    /// An unauthenticated request to an API path, on the retrying client when
    /// the operation is safe to repeat, with a fresh idempotency key on writes.
    fn builder(&self, method: Method, path: &str) -> RequestBuilder {
        let client = if retry_safe(&method, path) {
            &self.retry_client
        } else {
            &self.client
        };
        let write = matches!(
            method,
            Method::POST | Method::PUT | Method::PATCH | Method::DELETE
        );
        let request = client.request(method, format!("{}{path}", self.endpoint));
        if write {
            request.header("Idempotency-Key", new_idempotency_key())
        } else {
            request
        }
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
        let mut request = self.builder(method, path).bearer_auth(self.token()?);
        if let Some(body) = body {
            request = request.json(body);
        }
        Ok(send_checked(request).await?.json().await?)
    }

    pub(crate) async fn empty(&self, method: Method, path: &str) -> Result<()> {
        send_checked(self.builder(method, path).bearer_auth(self.token()?)).await?;
        Ok(())
    }

    pub(crate) async fn text(&self, path: &str) -> Result<String> {
        Ok(send_checked(self.builder(Method::GET, path))
            .await?
            .text()
            .await?)
    }

    /// Exchanges the one-time bootstrap secret for a token; needs no login.
    pub(crate) async fn bootstrap(
        &self,
        body: &contract::BootstrapRequest,
    ) -> Result<CreateTokenResponse> {
        let request = self.builder(Method::POST, "/api/bootstrap").json(body);
        Ok(send_checked(request).await?.json().await?)
    }

    /// Uploads one multipart part to its presigned `url`, returning its ETag.
    pub(crate) async fn upload_part(&self, url: &str, bytes: Vec<u8>) -> Result<String> {
        let request = self
            .retry_client
            .put(url)
            .bearer_auth(self.token()?)
            .header("Idempotency-Key", new_idempotency_key())
            .body(bytes);
        send_checked(request)
            .await?
            .headers()
            .get("etag")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
            .context("S3 response omitted ETag")
    }
}

/// Sends `request`, turning a non-success status into an error that
/// includes the response body.
async fn send_checked(request: RequestBuilder) -> Result<Response> {
    let response = request.send().await?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    bail!("API returned {status}: {body}")
}

/// `/api/{segments}`, percent-encoding each segment (for server- or
/// user-supplied ids such as token jtis and upload ids).
pub(crate) fn api_path(segments: &[&str]) -> String {
    let mut url = Url::parse("https://invalid.example/api").expect("static URL");
    url.path_segments_mut()
        .expect("static URL has a path")
        .extend(segments);
    url.path().to_owned()
}

fn retry_safe(method: &Method, path: &str) -> bool {
    method == Method::GET
        || method == Method::HEAD
        || method == Method::PATCH
        || method == Method::DELETE
        || path.ends_with("/missing")
        || path.starts_with("/api/uploads/")
        || path == "/api/uploads"
        || path == "/api/bootstrap"
}

/// A key identifies one user-intended operation, not the content of a
/// request forever. The retry middleware reuses the request (and this
/// header) for transient retries, while a later CLI invocation gets a new
/// operation and can legitimately upload or issue an identical resource.
fn new_idempotency_key() -> String {
    Uuid::new_v4().simple().to_string()
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
        assert!(retry_safe(&Method::POST, "/api/bootstrap"));
        assert!(!retry_safe(&Method::POST, "/api/caches"));
        assert!(!retry_safe(&Method::POST, "/api/tokens"));
    }

    #[test]
    fn api_paths_percent_encode_segments() {
        assert_eq!(api_path(&["uploads", "u1"]), "/api/uploads/u1");
        assert_eq!(
            api_path(&["tokens", "a/b c?#"]),
            "/api/tokens/a%2Fb%20c%3F%23"
        );
        assert_eq!(
            api_path(&["uploads", "../x", "complete"]),
            "/api/uploads/..%2Fx/complete"
        );
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
