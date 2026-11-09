use crate::protocol::contracts::api as contract;
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::Value;
use std::num::NonZeroU64;

use crate::{
    args::{Args, CommandKind, TokenOutput, WatchCommand},
    client::Api,
    config::{config_path, save_config, Config},
};

mod admin;
mod configure_nix;
mod gc;
mod push;
mod watch;

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
        CommandKind::Watch { command } => match command {
            WatchCommand::Run(watch) => {
                watch::run(
                    api()?,
                    watch.cache,
                    watch.spool,
                    watch.jobs,
                    watch.interval.into(),
                )
                .await
            }
            WatchCommand::Start(watch) => {
                api()?;
                let mut run_args = Vec::new();
                if let Some(endpoint) = &args.endpoint {
                    run_args.extend(["--endpoint".into(), endpoint.clone()]);
                }
                run_args.extend([
                    "watch".into(),
                    "run".into(),
                    watch.cache.to_string(),
                    "--spool".into(),
                    watch.spool.display().to_string(),
                    "--jobs".into(),
                    watch.jobs.to_string(),
                    "--interval".into(),
                    watch.interval.to_string(),
                ]);
                watch::start(&run_args, &watch.spool)
            }
            WatchCommand::Stop { spool } => watch::stop(&spool).await,
        },
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

fn valid_for_seconds(valid_for: humantime::Duration) -> Result<NonZeroU64> {
    NonZeroU64::new(valid_for.as_secs())
        .ok_or_else(|| anyhow::anyhow!("--valid-for must be at least one second"))
}
