use crate::{default_encoding_id, CacheName, UploadStatus};
use serde::{Deserialize, Serialize};
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
pub struct MissingPathsResponse {
    pub missing: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UploadStateResponse {
    pub id: String,
    pub status: UploadStatus,
    pub error: Option<String>,
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
