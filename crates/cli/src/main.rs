use anyhow::{Context, Result};
use cf_nix_cache_core::{CreateTokenRequest, TokenGrant};
use clap::Parser;

mod features;
mod infrastructure;

use features::commands::handlers;
use features::commands::{Args, CommandKind, TokenOutput};
use infrastructure::client::{bootstrap, config_path, load_config, save_config, Api};

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
        let grants = grants
            .iter()
            .cloned()
            .map(|(cache, role)| TokenGrant {
                cache,
                role: role.into(),
            })
            .collect();
        let mut body = serde_json::to_value(CreateTokenRequest {
            subject: subject.clone(),
            valid_for_seconds: valid_for.as_secs(),
            grants,
        })?;
        body["secret"] = serde_json::Value::String(secret.clone());
        let response = bootstrap(endpoint, body).await?;
        match output {
            TokenOutput::Token => println!("{}", response.token),
            TokenOutput::Json => println!("{}", serde_json::to_string_pretty(&response)?),
        }
        return Ok(());
    }
    let api = Api::new(args.endpoint, &config)?;
    handlers::run(args.command, api).await
}
