use cf_nix_cache_core::{contracts::api as contract, CacheName};
use clap::{Parser, Subcommand, ValueEnum};
use std::num::NonZeroUsize;

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
        #[arg(long, env = "CF_NIX_CACHE_BOOTSTRAP_SECRET", hide_env_values = true)]
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
        /// Store paths to upload at the same time.
        #[arg(long, short, default_value = "16")]
        jobs: NonZeroUsize,
        /// Also upload paths signed by the cache's upstream caches.
        #[arg(long)]
        ignore_upstream_cache_filter: bool,
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
    /// Inspect or start garbage collection, which otherwise runs on a schedule.
    Gc {
        #[command(subcommand)]
        command: GcCommand,
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
        /// The signing key name of an upstream cache. Push skips paths signed
        /// with this key. Repeat for several; defaults to cache.nixos.org-1.
        #[arg(long = "upstream-cache-key-name", value_name = "NAME")]
        upstream_cache_key_names: Vec<String>,
    },
    Info {
        name: CacheName,
    },
    Configure {
        name: CacheName,
        /// Whether pulling needs no token: --public or --public=false.
        #[arg(
            long,
            required = true,
            action = clap::ArgAction::Set,
            num_args = 0..=1,
            default_missing_value = "true",
            require_equals = true,
        )]
        public: bool,
    },
    /// Evict paths not accessed for this many days during garbage collection.
    /// 0 keeps paths indefinitely.
    Retention {
        name: CacheName,
        days: u64,
    },
    /// Replace the signing key names of upstream caches. Push skips paths
    /// signed with these keys.
    Upstreams {
        name: CacheName,
        #[arg(value_name = "KEY_NAME", required_unless_present = "none")]
        key_names: Vec<String>,
        /// Have no upstream caches, so that push uploads every path.
        #[arg(long, conflicts_with = "key_names")]
        none: bool,
    },
    Delete {
        name: CacheName,
    },
}

#[derive(Subcommand)]
pub(crate) enum GcCommand {
    /// Start a run now. It does nothing if one is already running.
    Run {
        /// Report what would be evicted and deleted without changing anything.
        #[arg(long)]
        dry_run: bool,
        /// Keep unreferenced objects newer than this. Defaults to one day.
        #[arg(long)]
        grace: Option<humantime::Duration>,
    },
    Status,
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

fn parse_grant(value: &str) -> Result<contract::Grant, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn configure(extra: &[&str]) -> std::result::Result<bool, clap::Error> {
        let args = ["cf-nix-cache", "cache", "configure", "team"]
            .iter()
            .chain(extra);
        match Args::try_parse_from(args)?.command {
            CommandKind::Cache {
                command: CacheCommand::Configure { public, .. },
            } => Ok(public),
            _ => unreachable!(),
        }
    }

    #[test]
    fn configure_requires_an_explicit_visibility() {
        assert!(configure(&[]).is_err());
        assert!(configure(&["--public"]).unwrap());
        assert!(configure(&["--public=true"]).unwrap());
        assert!(!configure(&["--public=false"]).unwrap());
    }
}
