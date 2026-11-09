use crate::protocol::contracts::api as contract;
use anyhow::{Context, Result};
use reqwest::{Client, Method, Response, Url};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, RequestBuilder};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;
use uuid::Uuid;

use crate::{args::PageArgs, config::Config};

#[derive(Clone)]
pub(crate) struct Api {
    client: ClientWithMiddleware,
    retry_client: ClientWithMiddleware,
    pub(crate) endpoint: String,
    token: Option<String>,
}

impl Api {
    pub(crate) fn new(args_endpoint: Option<String>, config: &Config) -> Result<Self> {
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

    fn token(&self) -> Result<&str> {
        self.token
            .as_deref()
            .context("not logged in; set CF_NIX_CACHE_TOKEN or run login")
    }

    /// Runs on the retrying client when safe to repeat, with a fresh idempotency key on writes.
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

    /// With a caller-kept idempotency key. The path must be allowlisted by [`retry_safe`].
    pub(crate) async fn request_with_key<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        key: &str,
        body: &B,
    ) -> Result<T> {
        if !retry_safe(&Method::POST, path) {
            anyhow::bail!("request_with_key requires a retry-safe POST path: {path}");
        }
        let request = self
            .retry_client
            .post(format!("{}{path}", self.endpoint))
            .bearer_auth(self.token()?)
            .header("Idempotency-Key", key)
            .json(body);
        Ok(send_checked(request).await?.json().await?)
    }

    pub(crate) async fn put_chunk(
        &self,
        upload: &str,
        raw_hash: &str,
        bytes: Vec<u8>,
    ) -> Result<()> {
        let request = self
            .builder(
                Method::PUT,
                &api_path(&["uploads", upload, "chunks", raw_hash]),
            )
            .bearer_auth(self.token()?)
            .header(reqwest::header::CONTENT_TYPE, "application/zstd")
            .body(bytes);
        send_checked(request).await?;
        Ok(())
    }

    pub(crate) async fn post_form<T: DeserializeOwned, B: Serialize>(
        &self,
        path: &str,
        request: &B,
        files: Vec<(String, Vec<u8>)>,
    ) -> Result<T> {
        let boundary = format!("cf-nix-cache-{}", new_idempotency_key());
        let body = form_body(&boundary, &serde_json::to_vec(request)?, files);
        let request = self
            .builder(Method::POST, path)
            .bearer_auth(self.token()?)
            .header(
                reqwest::header::CONTENT_TYPE,
                format!("multipart/form-data; boundary={boundary}"),
            )
            .body(body);
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

    pub(crate) async fn bootstrap(
        &self,
        body: &contract::BootstrapRequest,
    ) -> Result<serde_json::Value> {
        let request = self.builder(Method::POST, "/api/bootstrap").json(body);
        Ok(send_checked(request).await?.json().await?)
    }
}

/// Callers match on `{code, message}` instead of the rendered message.
async fn send_checked(request: RequestBuilder) -> Result<Response> {
    let response = request.send().await?;
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    let contract: ErrorBody = serde_json::from_str(&body).unwrap_or_default();
    Err(ApiError {
        status: status.as_u16(),
        code: contract.code,
        message: contract.message.unwrap_or(body),
    }
    .into())
}

/// Match on `status` and `code` instead of the message.
#[derive(Debug, Clone)]
pub(crate) struct ApiError {
    pub(crate) status: u16,
    pub(crate) code: Option<String>,
    pub(crate) message: String,
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "API returned {}: {}", self.status, self.message)
    }
}

impl std::error::Error for ApiError {}

#[derive(serde::Deserialize, Default)]
struct ErrorBody {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

fn form_body(boundary: &str, request: &[u8], files: Vec<(String, Vec<u8>)>) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(
        format!("--{boundary}\r\ncontent-disposition: form-data; name=\"request\"\r\ncontent-type: application/json\r\n\r\n")
            .as_bytes(),
    );
    body.extend(request);
    for (name, bytes) in files {
        body.extend(
            format!(
                "\r\n--{boundary}\r\ncontent-disposition: form-data; name=\"{name}\"; filename=\"chunk\"\r\ncontent-type: application/zstd\r\n\r\n"
            )
            .as_bytes(),
        );
        body.extend(bytes);
    }
    body.extend(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// Percent-encodes each segment of `/api/{segments}`.
pub(crate) fn api_path(segments: &[&str]) -> String {
    let mut url = Url::parse("https://invalid.example/api").expect("static URL");
    url.path_segments_mut()
        .expect("static URL has a path")
        .extend(segments);
    url.path().to_owned()
}

pub(crate) fn page_path(base: &str, page: &PageArgs) -> Result<String> {
    if !(1..=100).contains(&page.limit) {
        anyhow::bail!("limit must be between 1 and 100");
    }
    let mut url = Url::parse(&format!("https://invalid.example{base}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("limit", &page.limit.to_string());
        if let Some(cursor) = &page.cursor {
            query.append_pair("cursor", cursor);
        }
    }
    let query = url.query().unwrap_or_default();
    Ok(format!("{}?{query}", url.path()))
}

/// Only idempotent operations ride the retrying client, each safe to repeat
/// under one idempotency key. Every entry is an exact method-plus-path match.
/// Do not add a POST/PUT/PATCH route without confirming the server dedupes a
/// repeated key; when in doubt, leave it on the non-retrying client.
fn retry_safe(method: &Method, path: &str) -> bool {
    if method == Method::GET || method == Method::HEAD || method == Method::DELETE {
        return true;
    }
    if method == Method::POST {
        return path == "/api/uploads"
            || path == "/api/uploads/encoded"
            || path == "/api/uploads/encoded/batch"
            || path == "/api/uploads/encoded/batch/complete"
            || path == "/api/bootstrap"
            || is_cache_missing(path)
            || is_upload_complete(path);
    }
    if method == Method::PUT {
        return is_chunk_put(path);
    }
    if method == Method::PATCH {
        return is_cache_config(path);
    }
    false
}

/// Exact prefix plus one segment plus suffix, so future routes do not match by accident.
fn single_child(path: &str, prefix: &str, suffix: &str) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    let Some(middle) = rest.strip_suffix(suffix) else {
        return false;
    };
    !middle.is_empty() && !middle.contains('/')
}

fn is_cache_missing(path: &str) -> bool {
    single_child(path, "/api/caches/", "/missing")
}

fn is_upload_complete(path: &str) -> bool {
    single_child(path, "/api/uploads/", "/complete")
}

fn is_chunk_put(path: &str) -> bool {
    let Some(rest) = path.strip_prefix("/api/uploads/") else {
        return false;
    };
    let mut parts = rest.split('/');
    matches!(
        (
            parts.next(),
            parts.next(),
            parts.next(),
            parts.next()
        ),
        (Some(id), Some("chunks"), Some(hash), None) if !id.is_empty() && !hash.is_empty()
    )
}

fn is_cache_config(path: &str) -> bool {
    single_child(path, "/api/caches/", "/config")
}

/// One key per user operation; retries reuse it, later invocations mint a new one.
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
        assert!(retry_safe(&Method::POST, "/api/bootstrap"));
        assert!(!retry_safe(&Method::POST, "/api/caches"));
        assert!(!retry_safe(&Method::POST, "/api/tokens"));
        assert!(!retry_safe(&Method::POST, "/api/uploads/u1"));
        assert!(!retry_safe(&Method::POST, "/api/uploads/future-route"));
        assert!(!retry_safe(&Method::POST, "/api/other/missing"));
    }

    #[test]
    fn patch_config_and_batch_complete_are_retry_safe() {
        assert!(retry_safe(&Method::PATCH, "/api/caches/a/config"));
        assert!(!retry_safe(&Method::PATCH, "/api/caches/a/upstreams"));
        assert!(!retry_safe(&Method::PATCH, "/api/tokens"));
        assert!(!retry_safe(&Method::PATCH, "/api/uploads/u1/complete"));
        assert!(!retry_safe(&Method::POST, "/api/caches/a/config"));
        assert!(retry_safe(&Method::POST, "/api/uploads/u1/complete"));
        assert!(retry_safe(
            &Method::POST,
            "/api/uploads/encoded/batch/complete"
        ));
        assert!(retry_safe(&Method::PUT, "/api/uploads/u1/chunks/sha256:x"));
        assert!(!retry_safe(&Method::PUT, "/api/uploads/u1/chunks"));
        assert!(!retry_safe(&Method::PUT, "/api/uploads/u1/chunks/a/b"));
        assert!(!retry_safe(&Method::POST, "/api/uploads/u1/complete/extra"));
        assert!(!retry_safe(&Method::POST, "/api/caches/a/missing/extra"));
    }

    #[test]
    fn form_bodies_frame_each_field() {
        let body = form_body("b", b"{}", vec![("sha256:x".into(), vec![1, 2])]);
        assert_eq!(
            body,
            b"--b\r\ncontent-disposition: form-data; name=\"request\"\r\ncontent-type: application/json\r\n\r\n{}\r\n--b\r\ncontent-disposition: form-data; name=\"sha256:x\"; filename=\"chunk\"\r\ncontent-type: application/zstd\r\n\r\n\x01\x02\r\n--b--\r\n"
        );
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
