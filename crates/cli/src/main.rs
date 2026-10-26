use anyhow::{Context, Result};
use cf_nix_cache_core::contracts::api as contract;
use clap::Parser;

mod args;
mod client;
mod config;
mod handlers;
mod nix;
mod upload;
#[cfg(test)]
mod wire_proof;

use args::{Args, CommandKind, TokenOutput};
use client::{bootstrap, Api};
use config::{config_path, load_config, save_config};

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let mut config = load_config()?;
    if let CommandKind::Login { token } = &args.command {
        config.token = Some(token.clone());
        if let Some(endpoint) = args.endpoint {
            config.endpoint = Some(endpoint);
        }
        save_config(&config)?;
        println!("credentials saved to {}", config_path()?.display());
        return Ok(());
    }
    if let CommandKind::Bootstrap {
        subject,
        secret,
        grants,
        valid_for,
        output,
    } = &args.command
    {
        let endpoint = args
            .endpoint
            .clone()
            .or_else(|| config.endpoint.clone())
            .context("--endpoint is required")?;
        let body = contract::BootstrapRequest {
            grants: grants.clone(),
            secret: secret.parse()?,
            subject: subject.parse()?,
            valid_for_seconds: args::valid_for_seconds(*valid_for)?,
        };
        let response = bootstrap(endpoint, &body).await?;
        match output {
            TokenOutput::Token => println!("{}", response.token),
            TokenOutput::Json => println!("{}", serde_json::to_string_pretty(&response)?),
        }
        return Ok(());
    }
    let api = Api::new(args.endpoint, &config)?;
    handlers::run(args.command, api).await
}
