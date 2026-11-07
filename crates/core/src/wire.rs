//! The API responses the CLI acts on, limited to the fields it reads, so that a
//! newer server's additions don't break it. Commands that only show a response
//! print it unparsed. The tests tie these shapes to the schemas.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MissingPathsResponse {
    pub missing: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum UploadStatus {
    Created,
    Uploading,
    Completing,
    Queued,
    Processing,
    Publishing,
    Ready,
    Failed,
    Aborted,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::responses as generated;
    use serde::de::DeserializeOwned;
    use serde_json::{json, Value};

    /// `value` must be valid for the schema type `S` and readable as `W`.
    fn readable_from_schema<S: DeserializeOwned, W: DeserializeOwned>(value: Value) -> W {
        serde_json::from_value::<S>(value.clone()).expect("sample violates the schema");
        serde_json::from_value(value).expect("wire type cannot read a valid response")
    }

    #[test]
    fn reads_schema_valid_responses() {
        let state: UploadStateResponse = readable_from_schema::<generated::UploadStateResponse, _>(
            json!({ "id": "job", "status": "PUBLISHING", "error": null }),
        );
        assert_eq!(state.status, UploadStatus::Publishing);

        let init: InitiateUploadResponse =
            readable_from_schema::<generated::InitiateUploadResponse, _>(json!({
                "id": "job",
                "status": "UPLOADING",
                "error": null,
                "parts": [{ "part_number": 1, "url": "/api/uploads/job/parts/1" }],
            }));
        assert_eq!(init.parts[0].part_number, 1);

        let missing: MissingPathsResponse = readable_from_schema::<
            generated::MissingPathsResponse,
            _,
        >(json!({ "missing": ["0".repeat(32)] }));
        assert_eq!(missing.missing, ["0".repeat(32)]);
    }

    #[test]
    fn every_schema_upload_status_is_known() {
        for status in [
            "CREATED",
            "UPLOADING",
            "COMPLETING",
            "QUEUED",
            "PROCESSING",
            "PUBLISHING",
            "READY",
            "FAILED",
            "ABORTED",
        ] {
            let _: UploadStatus = serde_json::from_value(json!(status)).unwrap();
        }
    }
}
