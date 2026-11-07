use anyhow::{bail, Context, Result};
use cf_nix_cache_core::{nix_base32, validate_store_hash, ZSTD_LEVEL};
use serde::Deserialize;
use std::{
    collections::BTreeMap,
    path::Path,
    process::{Command, Stdio},
};
use tempfile::NamedTempFile;

/// One entry of `nix path-info --json`. Every field the published narinfo
/// depends on is required, so that a change of format fails loudly rather than
/// signing a narinfo with missing references.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathInfo {
    pub(crate) nar_hash: String,
    pub(crate) nar_size: u64,
    pub(crate) references: Vec<String>,
    #[serde(default)]
    pub(crate) deriver: Option<String>,
    #[serde(default)]
    pub(crate) ca: Option<String>,
    /// Older Nix omits this when a path has no signatures.
    #[serde(default)]
    pub(crate) signatures: Vec<String>,
}

/// The closure of `installables`, keyed by store path.
pub(crate) fn path_info(installables: &[String]) -> Result<BTreeMap<String, PathInfo>> {
    let run = |format_flag: &[&str]| {
        Command::new("nix")
            .args(["path-info", "--json", "--recursive"])
            .args(format_flag)
            .args(installables)
            .output()
    };
    // Bare --json is deprecated, but older Nix doesn't know --json-format.
    let mut output = run(&["--json-format", "1"])?;
    if !output.status.success()
        && String::from_utf8_lossy(&output.stderr).contains("unrecognised flag")
    {
        output = run(&[])?;
    }
    if !output.status.success() {
        bail!(
            "command failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    serde_json::from_slice(&output.stdout).context("unexpected nix path-info response")
}

pub(crate) fn nix_hash(hash: &str) -> Result<String> {
    if hash.starts_with("sha256:") {
        return Ok(hash.into());
    }
    // The SRI form newer Nix reports, converted without running nix.
    if let Some(digest) = hash.strip_prefix("sha256-").and_then(decode_base64) {
        if digest.len() == 32 {
            return Ok(format!("sha256:{}", nix_base32(&digest)));
        }
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

/// Standard, padded base64.
fn decode_base64(text: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.trim_end_matches('=').bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
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

/// Whether any signature on a `nix path-info` entry uses an upstream key.
pub(crate) fn signed_by_upstream(info: &PathInfo, upstreams: &[String]) -> bool {
    info.signatures
        .iter()
        .filter_map(|signature| signature.split_once(':'))
        .any(|(name, _)| upstreams.iter().any(|upstream| upstream == name))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(signatures: &[&str]) -> PathInfo {
        serde_json::from_value(json!({
            "narHash": "sha256-abc",
            "narSize": 1,
            "references": [],
            "signatures": signatures,
        }))
        .unwrap()
    }

    #[test]
    fn converts_sri_hashes_without_nix() {
        // `nix hash convert --to nix32 sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=`
        assert_eq!(
            nix_hash("sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=").unwrap(),
            "sha256:0mdqa9w1p6cmli6976v4wi0sw9r4p5prkj7lzfd1877wk11c9c73",
        );
    }

    #[test]
    fn matches_upstream_key_names_exactly() {
        let upstreams = ["cache.nixos.org-1".to_string()];
        let signed = |signatures: &[&str]| signed_by_upstream(&info(signatures), &upstreams);
        assert!(signed(&["other-1:a", "cache.nixos.org-1:b"]));
        assert!(!signed(&["other-1:a"]));
        assert!(!signed(&["cache.nixos.org-10:a"]));
        assert!(!signed(&["cache.nixos.org-1"]));
        assert!(!signed(&[]));
        assert!(!signed_by_upstream(&info(&["other-1:a"]), &[]));
    }

    #[test]
    fn parses_format_1_path_info() {
        let parsed: BTreeMap<String, PathInfo> = serde_json::from_value(json!({
            "/nix/store/x-hello": {
                "ca": null,
                "deriver": "/nix/store/y-hello.drv",
                "narHash": "sha256-abc",
                "narSize": 113096,
                "references": ["/nix/store/z-dep"],
                "registrationTime": 1,
                "signatures": ["cache.nixos.org-1:a"],
                "ultimate": false,
                "valid": true,
            }
        }))
        .unwrap();
        let hello = &parsed["/nix/store/x-hello"];
        assert_eq!(hello.references, ["/nix/store/z-dep"]);
        assert_eq!(hello.deriver.as_deref(), Some("/nix/store/y-hello.drv"));
        assert_eq!(hello.ca, None);
    }

    #[test]
    fn missing_references_are_an_error_not_an_empty_closure() {
        let parsed = serde_json::from_value::<PathInfo>(json!({
            "narHash": "sha256-abc",
            "narSize": 1,
        }));
        assert!(parsed.is_err());
    }

    #[test]
    fn older_nix_may_omit_signatures() {
        let parsed: PathInfo = serde_json::from_value(json!({
            "narHash": "sha256-abc",
            "narSize": 1,
            "references": [],
        }))
        .unwrap();
        assert!(parsed.signatures.is_empty());
    }
}
