//! `configure-nix`: prints the Nix settings for using a cache.

use anyhow::{Context, Result};
use cf_nix_cache_core::CacheName;
use etcetera::BaseStrategy;
use reqwest::Url;
use std::path::Path;

use crate::client::Api;

pub(super) async fn configure_nix(api: Api, cache: CacheName) -> Result<()> {
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
