use crate::{default_encoding_id, CacheName, UploadManifest, UploadStatus};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Pull,
    Push,
    Admin,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenGrant {
    pub cache: String,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum CacheLifecycle {
    Creating,
    Active,
    Deleting,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CacheConfig {
    pub id: String,
    pub name: CacheName,
    #[serde(default)]
    pub public: bool,
    pub quota_bytes: u64,
    #[serde(default)]
    pub logical_bytes: u64,
    #[serde(default = "default_encoding_id")]
    pub encoding_id: String,
    pub created_at: u64,
    pub lifecycle: CacheLifecycle,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateCacheRequest {
    pub name: CacheName,
    #[serde(default)]
    pub public: bool,
    pub quota_bytes: u64,
    #[serde(default = "default_encoding_id")]
    pub encoding_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigureCacheRequest {
    pub public: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingPathsRequest {
    pub store_hashes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingPathsResponse {
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InitiateUploadRequest {
    pub manifest: UploadManifest,
    pub compressed_size: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadPart {
    pub part_number: i32,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InitiateUploadResponse {
    pub id: String,
    pub status: UploadStatus,
    pub error: Option<String>,
    pub parts: Vec<UploadPart>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CompletedPart {
    pub part_number: i32,
    pub etag: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteUploadRequest {
    #[serde(default)]
    pub parts: Vec<CompletedPart>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadStateResponse {
    pub id: String,
    pub status: UploadStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CreateTokenRequest {
    pub subject: String,
    pub valid_for_seconds: u64,
    pub grants: Vec<TokenGrant>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTokenResponse {
    pub id: String,
    pub token: String,
    pub expires_at: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenSummary {
    pub id: String,
    pub subject: String,
    pub grants: Vec<TokenGrant>,
    pub issued_at: usize,
    pub expires_at: usize,
    pub revoked: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEvent {
    pub id: String,
    pub timestamp: u64,
    pub actor: String,
    pub action: String,
    pub resource: String,
    pub outcome: String,
    #[serde(default)]
    pub metadata: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PageResponse<T> {
    pub items: Vec<T>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiError {
    pub code: String,
    pub message: String,
    pub request_id: String,
}

/// Re-serialize JSON requests through the schema-generated DTOs. Domain
/// structs remain convenient for CLI/application code, while the actual
/// outbound wire value is checked against the same schemas used by Worker
/// validation.
pub fn canonical_api_request(path: &str, value: Value) -> Result<Value, serde_json::Error> {
    fn round_trip<T>(value: Value) -> Result<Value, serde_json::Error>
    where
        T: DeserializeOwned + Serialize,
    {
        serde_json::to_value(serde_json::from_value::<T>(value)?)
    }

    use crate::contracts::api;
    if path == "/api/bootstrap" {
        return round_trip::<api::BootstrapRequest>(value);
    }
    if path == "/api/caches" {
        return round_trip::<api::CreateCache>(value);
    }
    if path.ends_with("/config") {
        return round_trip::<api::ConfigureCache>(value);
    }
    if path.ends_with("/missing") {
        return round_trip::<api::MissingPaths>(value);
    }
    if path == "/api/tokens" {
        return round_trip::<api::TokenRequest>(value);
    }
    if path == "/api/uploads" {
        return round_trip::<api::UploadRequest>(value);
    }
    if path.starts_with("/api/uploads/") && path.ends_with("/complete") {
        return round_trip::<api::CompleteUpload>(value);
    }
    Ok(value)
}
