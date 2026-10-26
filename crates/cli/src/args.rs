use anyhow::Result;
use cf_nix_cache_core::{contracts::api as contract, CacheName};
use clap::{Parser, Subcommand, ValueEnum};
use reqwest::Url;
use std::num::NonZeroU64;

#[derive(Parser)]
#[command(
    version,
    about = "Publish and administer a Cloudflare Nix binary cache"
)]
pub(crate) struct Args {
    #[arg(long, env = "CF_NIX_CACHE_ENDPOINT")]
    pub(crate) endpoint: Option<String>,
    #[command(subcommand)]
    pub(crate) command: CommandKind,
}

#[derive(Subcommand)]
pub(crate) enum CommandKind {
    Bootstrap {
        #[arg(long, env = "CF_NIX_CACHE_BOOTSTRAP_SECRET")]
        secret: String,
        #[arg(long)]
        subject: String,
        #[arg(long = "grant", value_parser = parse_grant, required = true)]
        grants: Vec<contract::Grant>,
        #[arg(long)]
        valid_for: humantime::Duration,
        #[arg(long, value_enum, default_value = "token")]
        output: TokenOutput,
    },
    Login {
        #[arg(long)]
        token: String,
    },
    Cache {
        #[command(subcommand)]
        command: CacheCommand,
    },
    Push {
        cache: CacheName,
        #[arg(required = true)]
        installables: Vec<String>,
    },
    Token {
        #[command(subcommand)]
        command: TokenCommand,
    },
    Audit {
        #[command(subcommand)]
        command: AuditCommand,
    },
    Upload {
        #[command(subcommand)]
        command: UploadCommand,
    },
    ConfigureNix {
        cache: CacheName,
    },
}

#[derive(Subcommand)]
pub(crate) enum CacheCommand {
    List(PageArgs),
    Create {
        name: CacheName,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        quota_bytes: u64,
    },
    Info {
        name: CacheName,
    },
    Configure {
        name: CacheName,
        #[arg(long)]
        public: bool,
    },
    Delete {
        name: CacheName,
    },
}

#[derive(Subcommand)]
pub(crate) enum TokenCommand {
    List(PageArgs),
    Create {
        #[arg(long)]
        subject: String,
        #[arg(long = "grant", value_parser = parse_grant, required = true)]
        grants: Vec<contract::Grant>,
        #[arg(long)]
        valid_for: humantime::Duration,
        #[arg(long, value_enum, default_value = "token")]
        output: TokenOutput,
    },
    Revoke {
        jti: String,
    },
}

#[derive(clap::Args)]
pub(crate) struct PageArgs {
    #[arg(long, default_value_t = 50)]
    pub(crate) limit: usize,
    #[arg(long)]
    pub(crate) cursor: Option<String>,
}

#[derive(Subcommand)]
pub(crate) enum AuditCommand {
    List(PageArgs),
}

#[derive(Clone, Copy, ValueEnum)]
pub(crate) enum TokenOutput {
    Token,
    Json,
}

#[derive(Subcommand)]
pub(crate) enum UploadCommand {
    Cancel { id: String },
}

pub(crate) fn parse_grant(value: &str) -> std::result::Result<contract::Grant, String> {
    let (cache, role) = value.split_once('=').ok_or("grant must be CACHE=ROLE")?;
    Ok(contract::Grant {
        cache: cache
            .parse()
            .map_err(|_| "grant cache must be '*' or a cache name")?,
        role: role
            .parse()
            .map_err(|_| "role must be pull, push, or admin")?,
    })
}

/// Converts a `--valid-for` duration to the contract's whole seconds.
pub(crate) fn valid_for_seconds(valid_for: humantime::Duration) -> Result<NonZeroU64> {
    NonZeroU64::new(valid_for.as_secs())
        .ok_or_else(|| anyhow::anyhow!("--valid-for must be at least one second"))
}

pub(crate) fn page_path(base: &str, page: &PageArgs) -> Result<String> {
    if !(1..=100).contains(&page.limit) {
        anyhow::bail!("limit must be between 1 and 100");
    }
    let mut url = Url::parse(&format!("https://invalid.example{base}"))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("limit", &page.limit.to_string());
        if let Some(cursor) = &page.cursor {
            query.append_pair("cursor", cursor);
        }
    }
    let query = url.query().unwrap_or_default();
    Ok(format!("{}?{query}", url.path()))
}
