//! `gc`: inspects or starts garbage collection on the server.

use crate::protocol::contracts::{
    api as contract,
    responses::{GcRunResponse, GcStatusResponse},
};
use anyhow::Result;
use reqwest::Method;

use super::print_json;
use crate::{args::GcCommand, client::Api};

pub(super) async fn gc(api: Api, command: GcCommand) -> Result<()> {
    match command {
        GcCommand::Run { dry_run, grace } => print_json(
            &api.request::<GcRunResponse, _>(
                Method::POST,
                "/api/gc",
                Some(&contract::GcRunRequest {
                    dry_run,
                    grace_seconds: grace
                        .map(|grace| i64::try_from(grace.as_secs()))
                        .transpose()?,
                }),
            )
            .await?,
        ),
        GcCommand::Status => print_json(&api.get::<GcStatusResponse>("/api/gc").await?),
    }
}
