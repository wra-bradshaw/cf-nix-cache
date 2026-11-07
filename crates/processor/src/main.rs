//! HTTP bootstrap for the processor container. Processing lives in `pipeline`;
//! storage is an injected adapter, while NAR validation always runs in-process.

use anyhow::{Context, Result};
use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use cf_nix_cache_core::contracts::process_job::CfNixCacheProcessorJob;
use cf_nix_cache_core::{ProcessJob, ProcessResult};
use object_store::HttpObjectStore;
use serde::Serialize;
use std::sync::Arc;
use tokio::{net::TcpListener, sync::Semaphore};

mod nar;
mod object_store;
mod pipeline;

#[derive(Clone)]
struct AppState {
    store: HttpObjectStore,
    /// Containers are pooled, so one may receive several jobs at once. They
    /// queue here instead of sharing a small instance's memory.
    jobs: Arc<Semaphore>,
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
    let concurrency = match std::env::var("MAX_CONCURRENT_JOBS") {
        Ok(value) => value
            .parse::<usize>()
            .ok()
            .filter(|value| *value > 0)
            .context("MAX_CONCURRENT_JOBS must be a positive integer")?,
        Err(_) => 1,
    };
    let state = AppState {
        store: HttpObjectStore::new(&endpoint)?,
        jobs: Arc::new(Semaphore::new(concurrency)),
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
    // The HTTP boundary is the schemas/process-job.json DTO; convert it to
    // the domain job, which only accepts this build's encoding.
    let job = ProcessJob::try_from(contract)
        .map_err(|_| ProcessorRejection::permanent("unsupported processing contract"))?;
    let _permit = state.jobs.acquire().await.map_err(|error| {
        ProcessorRejection::from_failure(pipeline::ProcessFailure::Retryable(error.into()))
    })?;
    pipeline::process_job(&state.store, &job)
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
    fn from_failure(error: pipeline::ProcessFailure) -> Self {
        match error {
            pipeline::ProcessFailure::Permanent(message) => Self::permanent(message),
            pipeline::ProcessFailure::Retryable(error) => Self(
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
    use pipeline::ProcessFailure;

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
