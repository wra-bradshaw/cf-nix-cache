use anyhow::Result;
use clap::{Parser, Subcommand, ValueEnum};
use reqwest::Url;

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
        grants: Vec<(String, CliRole)>,
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
        cache: String,
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
        cache: String,
    },
}

#[derive(Subcommand)]
pub(crate) enum CacheCommand {
    List(PageArgs),
    Create {
        name: String,
        #[arg(long)]
        public: bool,
        #[arg(long)]
        quota_bytes: u64,
    },
    Info {
        name: String,
    },
    Configure {
        name: String,
        #[arg(long)]
        public: bool,
    },
    Delete {
        name: String,
    },
}

#[derive(Clone, ValueEnum)]
pub(crate) enum CliRole {
    Pull,
    Push,
    Admin,
}
impl From<CliRole> for cf_nix_cache_core::Role {
    fn from(value: CliRole) -> Self {
        match value {
            CliRole::Pull => Self::Pull,
            CliRole::Push => Self::Push,
            CliRole::Admin => Self::Admin,
        }
    }
}

#[derive(Subcommand)]
pub(crate) enum TokenCommand {
    List(PageArgs),
    Create {
        #[arg(long)]
        subject: String,
        #[arg(long = "grant", value_parser = parse_grant, required = true)]
        grants: Vec<(String, CliRole)>,
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

pub(crate) fn parse_grant(value: &str) -> std::result::Result<(String, CliRole), String> {
    let (cache, role) = value.split_once('=').ok_or("grant must be CACHE=ROLE")?;
    let role = match role {
        "pull" => CliRole::Pull,
        "push" => CliRole::Push,
        "admin" => CliRole::Admin,
        _ => return Err("role must be pull, push, or admin".into()),
    };
    Ok((cache.into(), role))
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
