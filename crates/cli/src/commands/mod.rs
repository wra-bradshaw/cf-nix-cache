//! Command dispatch and the output helpers shared by the command flows.

use anyhow::{Context, Result};
use cf_nix_cache_core::contracts::api as contract;
use serde::Serialize;
use serde_json::Value;
use std::num::NonZeroU64;

use crate::{
    args::{Args, CommandKind, TokenOutput},
    client::Api,
    config::{config_path, save_config, Config},
};

mod admin;
mod configure_nix;
mod gc;
mod push;

pub(crate) async fn run(args: Args, config: Config) -> Result<()> {
    let api = || Api::new(args.endpoint.clone(), &config);
    match args.command {
        CommandKind::Login { token } => {
            save_config(&Config {
                endpoint: args.endpoint.clone().or_else(|| config.endpoint.clone()),
                token: Some(token),
            })?;
            println!("credentials saved to {}", config_path()?.display());
            Ok(())
        }
        CommandKind::Bootstrap {
            secret,
            subject,
            grants,
            valid_for,
            output,
        } => {
            let body = contract::BootstrapRequest {
                grants,
                secret: secret.parse()?,
                subject: subject.parse()?,
                valid_for_seconds: valid_for_seconds(valid_for)?,
            };
            print_token(&api()?.bootstrap(&body).await?, output)
        }
        CommandKind::Cache { command } => admin::cache(api()?, command).await,
        CommandKind::Token { command } => admin::token(api()?, command).await,
        CommandKind::Audit { command } => admin::audit(api()?, command).await,
        CommandKind::Upload { command } => admin::upload(api()?, command).await,
        CommandKind::Gc { command } => gc::gc(api()?, command).await,
        CommandKind::Push {
            cache,
            installables,
            jobs,
            ignore_upstream_cache_filter,
        } => {
            push::push(
                api()?,
                cache,
                installables,
                jobs,
                ignore_upstream_cache_filter,
            )
            .await
        }
        CommandKind::ConfigureNix { cache } => configure_nix::configure_nix(api()?, cache).await,
    }
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_token(response: &Value, output: TokenOutput) -> Result<()> {
    match output {
        TokenOutput::Token => println!(
            "{}",
            response["token"]
                .as_str()
                .context("server response has no token")?
        ),
        TokenOutput::Json => print_json(response)?,
    }
    Ok(())
}

/// Converts a `--valid-for` duration to the contract's whole seconds.
fn valid_for_seconds(valid_for: humantime::Duration) -> Result<NonZeroU64> {
    NonZeroU64::new(valid_for.as_secs())
        .ok_or_else(|| anyhow::anyhow!("--valid-for must be at least one second"))
}
