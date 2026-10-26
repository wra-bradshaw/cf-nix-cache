//! HTTP bootstrap for the processor container. Processing lives in `service`;
//! storage and NAR validation are injected adapters.

use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use cf_nix_cache_core::contracts::process_job::CfNixCacheProcessorJob;
use cf_nix_cache_core::{ProcessJob, ProcessResult, ENCODING_ID};
use object_store::HttpObjectStore;
use serde::Serialize;
use tokio::net::TcpListener;

mod nar;
mod object_store;
mod service;

#[derive(Clone)]
struct AppState {
    store: HttpObjectStore,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    code: &'static str,
    message: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    let endpoint =
        std::env::var("OBJECT_STORE_ENDPOINT").context("OBJECT_STORE_ENDPOINT is required")?;
    let state = AppState {
        store: HttpObjectStore::new(&endpoint)?,
    };
    let app = Router::new()
        .route("/ready", get(ready))
        .route("/process", post(process))
        .with_state(state);
    let port = std::env::var("PORT").unwrap_or_else(|_| "8080".into());
    axum::serve(TcpListener::bind(format!("0.0.0.0:{port}")).await?, app).await?;
    Ok(())
}

async fn ready() -> &'static str {
    "ready\n"
}

async fn process(
    State(state): State<AppState>,
    Json(contract): Json<CfNixCacheProcessorJob>,
) -> Result<Json<ProcessResult>, ProcessorRejection> {
    // Deserialize through the generated schema DTO first, then convert to
    // the semantic domain type used by the processor. This keeps the HTTP
    // boundary tied to schemas/process-job.json while preserving domain
    // validation and processing policy internally.
    let job: ProcessJob = serde_json::from_value(
        serde_json::to_value(contract)
            .map_err(|error| ProcessorRejection::permanent(error.to_string()))?,
    )
    .map_err(|error| ProcessorRejection::permanent(error.to_string()))?;
    if job.encoding_id != ENCODING_ID {
        return Err(ProcessorRejection::permanent(
            "unsupported processing contract",
        ));
    }
    service::process_job(&state.store, &job)
        .await
        .map(Json)
        .map_err(ProcessorRejection::from_failure)
}

struct ProcessorRejection(StatusCode, ErrorBody);
impl ProcessorRejection {
    fn permanent(message: impl Into<String>) -> Self {
        Self(
            StatusCode::UNPROCESSABLE_ENTITY,
            ErrorBody {
                code: "invalid_input",
                message: message.into(),
            },
        )
    }
    fn from_failure(error: service::ProcessFailure) -> Self {
        match error {
            service::ProcessFailure::Permanent(message) => Self::permanent(message),
            service::ProcessFailure::Retryable(error) => Self(
                StatusCode::SERVICE_UNAVAILABLE,
                ErrorBody {
                    code: "retryable_failure",
                    message: format!("{error:#}"),
                },
            ),
        }
    }
}
impl IntoResponse for ProcessorRejection {
    fn into_response(self) -> axum::response::Response {
        (self.0, Json(self.1)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use service::ProcessFailure;

    #[test]
    fn failures_map_to_status_and_code() {
        let permanent = ProcessorRejection::from_failure(ProcessFailure::Permanent(
            "trailing bytes after NAR archive".into(),
        ));
        assert_eq!(permanent.0, StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(permanent.1.code, "invalid_input");

        let retryable = ProcessorRejection::from_failure(ProcessFailure::Retryable(
            anyhow::anyhow!("object store unavailable"),
        ));
        assert_eq!(retryable.0, StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(retryable.1.code, "retryable_failure");
    }
}
