use crate::protocol::contracts::api as contract;
use anyhow::{Context, Result};
use reqwest::{Client, Method, Response, Url};
use reqwest_middleware::{ClientBuilder, ClientWithMiddleware, RequestBuilder};
use reqwest_retry::{policies::ExponentialBackoff, RetryTransientMiddleware};
use serde::{de::DeserializeOwned, Serialize};
use std::time::Duration;
use uuid::Uuid;

use crate::{args::PageArgs, config::Config};

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
    /// DELETE mints a key like POST/PUT/PATCH: the server requires an
    /// `Idempotency-Key` on every mutating route, including DELETE, and the
    /// retry middleware reuses that same key across transient retries.
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

    /// Like [`Api::request`], with an idempotency key the caller keeps, so
    /// that it can repeat the operation after a failure the client does not
    /// retry by itself.
    ///
    /// The caller must pass a POST path allowlisted by [`retry_safe`]: this
    /// always uses the retrying client, so a non-allowlisted path would
    /// retry an operation the server does not dedupe. A non-allowlisted
    /// path is rejected with an error (not just `debug_assert!`, which is
    /// stripped in release builds).
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

    /// Sends one compressed chunk of a client-encoded upload.
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

    /// Posts a multipart/form-data body: a JSON `request` field, then one
    /// file field per `(name, bytes)`.
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

    /// Exchanges an unused bootstrap secret for a token; needs no login.
    pub(crate) async fn bootstrap(
        &self,
        body: &contract::BootstrapRequest,
    ) -> Result<serde_json::Value> {
        let request = self.builder(Method::POST, "/api/bootstrap").json(body);
        Ok(send_checked(request).await?.json().await?)
    }
}

/// Sends `request`, turning a non-success status into a typed error. The
/// Worker renders `{code, message}`, which callers match on instead of
/// grepping the rendered message.
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

/// A failed API call. Display keeps the old `API returned {status}: ...`
/// shape; match on `status` and `code` instead of the message.
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

/// `/api/{segments}`, percent-encoding each segment (for server- or
/// user-supplied ids such as token jtis and upload ids).
pub(crate) fn api_path(segments: &[&str]) -> String {
    let mut url = Url::parse("https://invalid.example/api").expect("static URL");
    url.path_segments_mut()
        .expect("static URL has a path")
        .extend(segments);
    url.path().to_owned()
}

/// `base` with the query string for a `--limit`/`--cursor` page request.
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

/// Only idempotent operations run on the retrying client. Reads are safe by
/// method; DELETE is safe by method. The only POST/PUT/PATCH routes allowed
/// here are the ones the CLI actually uses, each safe to repeat under one
/// idempotency key: opening an upload (`POST /api/uploads`,
/// `POST /api/uploads/encoded`, `POST /api/uploads/encoded/batch`), chunk
/// PUTs (which are additionally content-addressed), completing one upload or
/// a batch (`POST /api/uploads/{id}/complete`,
/// `POST /api/uploads/encoded/batch/complete`), the missing-paths check
/// (`POST /api/caches/{name}/missing`), cache-config writes
/// (`PATCH /api/caches/{name}/config`, where sending the same body twice is
/// the same operation), and the bootstrap exchange (`POST /api/bootstrap`,
/// which runs once per secret and reuses its key on retry). Every entry is an
/// exact method-plus-path match: a future route under `/api/uploads/` (or a
/// new PATCH route) must opt in here rather than inheriting retries.
/// [`Api::builder`] mints a fresh key per call and the retry middleware reuses
/// that same key (with the same body) across transient retries, so the server
/// dedupes repeats via its idempotency-key contract (upload-session and
/// allocation rows keyed by the operation key; config writes keyed the same
/// way; cache-deletion, token-revocation, and path-deletion operations keyed
/// the same way, while upload abort validates the key without replaying it).
/// DELETE rides the retrying client as safe by method and still carries a key
/// because the server requires one on every mutating route. Do not add a new POST/PUT/PATCH route here without confirming the
/// server treats a repeated key as the same operation; when in doubt, leave it
/// on the non-retrying client.
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

/// `prefix` plus one non-empty segment plus `suffix`, with nothing else, so a
/// deeper (or future) route does not match by accident.
fn single_child(path: &str, prefix: &str, suffix: &str) -> bool {
    let Some(rest) = path.strip_prefix(prefix) else {
        return false;
    };
    let Some(middle) = rest.strip_suffix(suffix) else {
        return false;
    };
    !middle.is_empty() && !middle.contains('/')
}

/// `POST /api/caches/{name}/missing`: the CLI's missing-paths check, where
/// the name is one percent-encoded segment.
fn is_cache_missing(path: &str) -> bool {
    single_child(path, "/api/caches/", "/missing")
}

/// `POST /api/uploads/{id}/complete`: completing one upload.
fn is_upload_complete(path: &str) -> bool {
    single_child(path, "/api/uploads/", "/complete")
}

/// `PUT /api/uploads/{id}/chunks/{hash}`: one content-addressed chunk, where
/// the id and hash are each one percent-encoded segment.
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

/// `PATCH /api/caches/{name}/config`: setting the cache config.
fn is_cache_config(path: &str) -> bool {
    single_child(path, "/api/caches/", "/config")
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
        assert!(retry_safe(&Method::POST, "/api/bootstrap"));
        assert!(!retry_safe(&Method::POST, "/api/caches"));
        assert!(!retry_safe(&Method::POST, "/api/tokens"));
        // A bare upload id is not a route: the `/api/uploads/` prefix alone
        // must not opt future routes into retries.
        assert!(!retry_safe(&Method::POST, "/api/uploads/u1"));
        assert!(!retry_safe(&Method::POST, "/api/uploads/future-route"));
        assert!(!retry_safe(&Method::POST, "/api/other/missing"));
    }

    #[test]
    fn patch_config_and_batch_complete_are_retry_safe() {
        // PATCH only configures caches (public, retention, upstreams): sending
        // the same body twice is the same operation, and the retry middleware
        // reuses the one idempotency key minted by `builder`, so the server
        // dedupes the repeat.
        assert!(retry_safe(&Method::PATCH, "/api/caches/a/config"));
        // A PATCH anywhere else (or a POST to the config path) is not
        // allowlisted: the old blanket `method == PATCH` is gone.
        assert!(!retry_safe(&Method::PATCH, "/api/caches/a/upstreams"));
        assert!(!retry_safe(&Method::PATCH, "/api/tokens"));
        assert!(!retry_safe(&Method::PATCH, "/api/uploads/u1/complete"));
        assert!(!retry_safe(&Method::POST, "/api/caches/a/config"));
        // Single and batch completions ride the retrying client for the same
        // reason: batch-complete posts its chunk bodies together with the
        // completion, so a transient retry repeats the identical request
        // (same key, same bodies) instead of uploading bodies twice under two
        // keys. Pin the paths the CLI actually uses.
        assert!(retry_safe(&Method::POST, "/api/uploads/u1/complete"));
        assert!(retry_safe(
            &Method::POST,
            "/api/uploads/encoded/batch/complete"
        ));
        assert!(retry_safe(&Method::PUT, "/api/uploads/u1/chunks/sha256:x"));
        // Exact shapes only: deeper or partial upload paths do not match.
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
