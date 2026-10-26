use anyhow::{Context, Result};
use etcetera::{choose_app_strategy, AppStrategy, AppStrategyArgs};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write, path::PathBuf};
use tempfile::NamedTempFile;

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct Config {
    pub(crate) endpoint: Option<String>,
    pub(crate) token: Option<String>,
}

pub(crate) fn config_path() -> Result<PathBuf> {
    let strategy = choose_app_strategy(AppStrategyArgs {
        top_level_domain: "dev".into(),
        author: "cf-nix-cache".into(),
        app_name: "cf-nix-cache".into(),
    })
    .context("unable to determine the platform configuration directory")?;
    Ok(strategy.in_config_dir("config.json"))
}

pub(crate) fn load_config() -> Result<Config> {
    let path = config_path()?;
    if path.exists() {
        Ok(serde_json::from_slice(&fs::read(path)?)?)
    } else {
        Ok(Config::default())
    }
}

pub(crate) fn save_config(config: &Config) -> Result<()> {
    let path = config_path()?;
    let parent = path.parent().context("config path has no parent")?;
    fs::create_dir_all(parent)?;
    let mut temporary = NamedTempFile::new_in(parent)?;
    temporary.write_all(&serde_json::to_vec_pretty(config)?)?;
    temporary.as_file().sync_all()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(temporary.path(), fs::Permissions::from_mode(0o600))?;
    }
    temporary.persist(&path).map_err(|error| error.error)?;
    Ok(())
}
