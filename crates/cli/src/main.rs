use anyhow::Result;
use clap::Parser;

mod args;
mod client;
mod config;
mod handlers;
mod nix;
mod upload;

#[tokio::main]
async fn main() -> Result<()> {
    handlers::run(args::Args::parse(), config::load_config()?).await
}
