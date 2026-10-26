use anyhow::{bail, Context, Result};
use cf_nix_cache_core::{validate_store_hash, ZSTD_LEVEL};
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Stdio},
};
use tempfile::NamedTempFile;

pub(crate) fn command_json(mut command: Command) -> Result<Value> {
    let output = command.output()?;
    if !output.status.success() {
        bail!(
            "command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(serde_json::from_slice(&output.stdout)?)
}

pub(crate) fn nix_hash(hash: &str) -> Result<String> {
    if hash.starts_with("sha256:") {
        return Ok(hash.into());
    }
    let output = Command::new("nix")
        .args([
            "hash",
            "convert",
            "--hash-algo",
            "sha256",
            "--to",
            "nix32",
            hash,
        ])
        .output()?;
    if !output.status.success() {
        bail!(
            "nix hash convert failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    Ok(format!(
        "sha256:{}",
        String::from_utf8(output.stdout)?.trim()
    ))
}

pub(crate) fn basename(path: &str) -> Result<String> {
    Ok(Path::new(path)
        .file_name()
        .context("invalid store path")?
        .to_string_lossy()
        .into())
}

pub(crate) fn store_hash(path: &str) -> Result<String> {
    let name = basename(path)?;
    let hash = name
        .get(..32)
        .map(str::to_owned)
        .context("store path does not contain a 32-character Nix store hash")?;
    validate_store_hash(&hash).map_err(|_| anyhow::anyhow!("invalid Nix store hash in {path}"))?;
    Ok(hash)
}

pub(crate) fn make_nar(path: &str) -> Result<NamedTempFile> {
    let mut child = Command::new("nix-store")
        .args(["--dump", path])
        .stdout(Stdio::piped())
        .spawn()?;
    let mut encoder = zstd::Encoder::new(NamedTempFile::new()?, ZSTD_LEVEL)?;
    std::io::copy(
        child
            .stdout
            .as_mut()
            .context("nix-store did not provide stdout")?,
        &mut encoder,
    )?;
    let file = encoder.finish()?;
    if !child.wait()?.success() {
        bail!("nix-store --dump failed for {path}");
    }
    Ok(file)
}
