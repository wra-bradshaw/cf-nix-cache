use anyhow::Result;
use clap::Parser;

mod args;
mod client;
mod commands;
mod config;
mod encode;
mod encoded_upload;
mod nix;
mod upload;

#[tokio::main]
async fn main() -> Result<()> {
    commands::run(args::Args::parse(), config::load_config()?).await
}
