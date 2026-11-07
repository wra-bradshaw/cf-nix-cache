use anyhow::{Context, Result};
use cf_nix_cache_core::{
    contracts::api as contract, AuditEvent, CacheConfig, CacheName, CreateTokenResponse,
    MissingPathsResponse, PageResponse, TokenSummary, ENCODING_ID,
};
use etcetera::BaseStrategy;
use reqwest::{Method, Url};
use serde::Serialize;
use serde_json::Value;
use std::{
    future::Future,
    num::{NonZeroU64, NonZeroUsize},
    path::Path,
    process::Command,
    sync::Arc,
};
use tokio::task::JoinSet;

use crate::{
    args::{
        page_path, valid_for_seconds, Args, AuditCommand, CacheCommand, CommandKind, TokenCommand,
        TokenOutput, UploadCommand,
    },
    client::{api_path, Api},
    config::{config_path, save_config, Config},
    nix::{command_json, store_hash},
    upload::upload_path,
};

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
        CommandKind::Cache { command } => cache(api()?, command).await,
        CommandKind::Token { command } => token(api()?, command).await,
        CommandKind::Audit { command } => audit(api()?, command).await,
        CommandKind::Upload { command } => upload(api()?, command).await,
        CommandKind::Push {
            cache,
            installables,
            jobs,
        } => push(api()?, cache, installables, jobs).await,
        CommandKind::ConfigureNix { cache } => configure_nix(api()?, cache).await,
    }
}

fn print_json(value: &impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn print_token(response: &CreateTokenResponse, output: TokenOutput) -> Result<()> {
    match output {
        TokenOutput::Token => println!("{}", response.token),
        TokenOutput::Json => print_json(response)?,
    }
    Ok(())
}

async fn cache(api: Api, command: CacheCommand) -> Result<()> {
    match command {
        CacheCommand::List(page) => print_json(
            &api.get::<PageResponse<CacheConfig>>(&page_path("/api/caches", &page)?)
                .await?,
        ),
        CacheCommand::Create {
            name,
            public,
            quota_bytes,
        } => {
            let body = contract::CreateCache {
                encoding_id: Some(ENCODING_ID.into()),
                name: name.to_string().parse()?,
                public,
                quota_bytes: NonZeroU64::new(quota_bytes)
                    .context("--quota-bytes must be positive")?,
            };
            print_json(
                &api.request::<CacheConfig, _>(Method::POST, "/api/caches", Some(&body))
                    .await?,
            )
        }
        CacheCommand::Info { name } => print_json(
            &api.get::<CacheConfig>(&format!("/api/caches/{name}"))
                .await?,
        ),
        CacheCommand::Configure { name, public } => print_json(
            &api.request::<CacheConfig, _>(
                Method::PATCH,
                &format!("/api/caches/{name}/config"),
                Some(&contract::ConfigureCache { public }),
            )
            .await?,
        ),
        CacheCommand::Delete { name } => {
            api.empty(Method::DELETE, &format!("/api/caches/{name}"))
                .await
        }
    }
}

async fn token(api: Api, command: TokenCommand) -> Result<()> {
    match command {
        TokenCommand::List(page) => print_json(
            &api.get::<PageResponse<TokenSummary>>(&page_path("/api/tokens", &page)?)
                .await?,
        ),
        TokenCommand::Create {
            subject,
            grants,
            valid_for,
            output,
        } => {
            let body = contract::TokenRequest {
                grants,
                subject: subject.parse()?,
                valid_for_seconds: valid_for_seconds(valid_for)?,
            };
            print_token(
                &api.request(Method::POST, "/api/tokens", Some(&body))
                    .await?,
                output,
            )
        }
        TokenCommand::Revoke { jti } => {
            api.empty(Method::DELETE, &api_path(&["tokens", &jti]))
                .await
        }
    }
}

async fn audit(api: Api, command: AuditCommand) -> Result<()> {
    match command {
        AuditCommand::List(page) => print_json(
            &api.get::<PageResponse<AuditEvent>>(&page_path("/api/audit", &page)?)
                .await?,
        ),
    }
}

async fn upload(api: Api, command: UploadCommand) -> Result<()> {
    match command {
        UploadCommand::Cancel { id } => {
            api.empty(Method::DELETE, &api_path(&["uploads", &id]))
                .await
        }
    }
}

async fn push(
    api: Api,
    cache: CacheName,
    installables: Vec<String>,
    jobs: NonZeroUsize,
) -> Result<()> {
    let mut command = Command::new("nix");
    command
        .args(["path-info", "--json", "--recursive"])
        .args(&installables);
    let Value::Object(map) = command_json(command)? else {
        anyhow::bail!("unexpected nix path-info response");
    };
    let hashes = map
        .keys()
        .map(|path| store_hash(path))
        .collect::<Result<Vec<_>>>()?;
    let mut missing = std::collections::BTreeSet::new();
    for batch in hashes.chunks(100) {
        let body = contract::MissingPaths {
            store_hashes: batch
                .iter()
                .map(|hash| hash.parse())
                .collect::<Result<_, _>>()?,
        };
        let result: MissingPathsResponse = api
            .request(
                Method::POST,
                &format!("/api/caches/{cache}/missing"),
                Some(&body),
            )
            .await?;
        missing.extend(result.missing);
    }
    let mut uploads = Vec::new();
    for (path, info) in map {
        if missing.contains(&store_hash(&path)?) {
            uploads.push((path, info));
        } else {
            println!("already cached {path}");
        }
    }
    let total = uploads.len();
    let api = Arc::new(api);
    let cache = Arc::new(cache);
    let failures = run_concurrently(uploads, jobs, move |(path, info)| {
        let api = Arc::clone(&api);
        let cache = Arc::clone(&cache);
        async move {
            upload_path(&api, &cache, &path, &info)
                .await
                .with_context(|| format!("failed to upload {path}"))
        }
    })
    .await;
    if !failures.is_empty() {
        for failure in &failures {
            eprintln!("{failure:#}");
        }
        anyhow::bail!("{} of {total} uploads failed", failures.len());
    }
    Ok(())
}

/// Runs `task` over `items` with at most `limit` running at once. A failure
/// does not stop the remaining items, since every completed upload is progress
/// that a retry does not have to repeat. Returns the errors.
async fn run_concurrently<T, F, Fut>(
    items: Vec<T>,
    limit: NonZeroUsize,
    task: F,
) -> Vec<anyhow::Error>
where
    F: Fn(T) -> Fut,
    Fut: Future<Output = Result<()>> + Send + 'static,
{
    let mut running = JoinSet::new();
    let mut failures = Vec::new();
    for item in items {
        if running.len() == limit.get() {
            collect_failure(running.join_next().await, &mut failures);
        }
        running.spawn(task(item));
    }
    while let Some(result) = running.join_next().await {
        collect_failure(Some(result), &mut failures);
    }
    failures
}

fn collect_failure(
    result: Option<Result<Result<()>, tokio::task::JoinError>>,
    failures: &mut Vec<anyhow::Error>,
) {
    match result {
        Some(Ok(Err(error))) => failures.push(error),
        Some(Err(error)) => failures.push(error.into()),
        Some(Ok(Ok(()))) | None => {}
    }
}

async fn configure_nix(api: Api, cache: CacheName) -> Result<()> {
    let public_keys = api.text("/api/public-key").await?;
    let user_config = etcetera::choose_base_strategy()
        .context("unable to determine the user configuration directory")?
        .config_dir()
        .join("nix");
    print!(
        "{}",
        nix_config(&api.endpoint, &cache, &public_keys, &user_config)?
    );
    Ok(())
}

/// Nix settings for using `cache`, for single-user and multi-user (daemon)
/// installs. `user_config` is the absolute per-user Nix config directory.
fn nix_config(
    endpoint: &str,
    cache: &CacheName,
    public_keys: &str,
    user_config: &Path,
) -> Result<String> {
    let host = Url::parse(endpoint)?
        .host_str()
        .context("endpoint has no host")?
        .to_owned();
    let substituter = format!("{endpoint}/cache/{cache}");
    let keys = public_keys.split_whitespace().collect::<Vec<_>>().join(" ");
    let settings = |netrc: &Path| {
        format!(
            "extra-substituters = {substituter}\n\
             extra-trusted-public-keys = {keys}\n\
             netrc-file = {}\n",
            netrc.display()
        )
    };
    Ok(format!(
        "# Single-user Nix: add to {}\n{}\n\
         # Multi-user Nix: add to /etc/nix/nix.conf, then restart nix-daemon.\n\
         # To let users opt in instead, write `trusted-substituters = {substituter}`\n\
         # in place of extra-substituters.\n{}\n\
         # Private caches only: add to the netrc-file above, with a pull token.\n\
         machine {host} login token password <token>\n",
        user_config.join("nix.conf").display(),
        settings(&user_config.join("netrc")),
        settings(Path::new("/etc/nix/netrc")),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[tokio::test]
    async fn run_concurrently_uses_but_never_exceeds_the_limit() {
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let failures = run_concurrently(
            (0..20).collect(),
            NonZeroUsize::new(4).unwrap(),
            |_: i32| {
                let running = Arc::clone(&running);
                let peak = Arc::clone(&peak);
                async move {
                    let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                    peak.fetch_max(now, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(10)).await;
                    running.fetch_sub(1, Ordering::SeqCst);
                    Ok(())
                }
            },
        )
        .await;
        assert!(failures.is_empty());
        assert_eq!(peak.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn run_concurrently_finishes_the_remaining_items_after_a_failure() {
        let finished = Arc::new(AtomicUsize::new(0));
        let failures = run_concurrently(
            (0..10).collect(),
            NonZeroUsize::new(2).unwrap(),
            |item: i32| {
                let finished = Arc::clone(&finished);
                async move {
                    if item % 5 == 0 {
                        anyhow::bail!("item {item} failed");
                    }
                    finished.fetch_add(1, Ordering::SeqCst);
                    Ok(())
                }
            },
        )
        .await;
        assert_eq!(failures.len(), 2);
        assert_eq!(finished.load(Ordering::SeqCst), 8);
    }

    #[test]
    fn nix_config_uses_extra_settings_and_absolute_paths() {
        let config = nix_config(
            "https://cache.example.com:8443/prefix",
            &"team".parse().unwrap(),
            "team-1:AAAA\nteam-2:BBBB\n",
            Path::new("/home/me/.config/nix"),
        )
        .unwrap();
        assert!(!config.contains('~'));
        assert!(!config.lines().any(|line| line.starts_with("substituters")));
        assert!(config.contains("# Single-user Nix: add to /home/me/.config/nix/nix.conf\n"));
        assert!(config
            .contains("extra-substituters = https://cache.example.com:8443/prefix/cache/team\n"));
        assert!(config.contains("extra-trusted-public-keys = team-1:AAAA team-2:BBBB\n"));
        assert!(config.contains("netrc-file = /home/me/.config/nix/netrc\n"));
        assert!(config.contains("netrc-file = /etc/nix/netrc\n"));
        assert!(config.contains("machine cache.example.com login token password <token>\n"));
    }
}
