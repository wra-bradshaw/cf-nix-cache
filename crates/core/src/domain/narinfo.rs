use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use serde::{Deserialize, Serialize};
use std::fmt::Write;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NarInfo {
    pub store_path: String,
    pub url: String,
    pub compression: String,
    pub file_hash: String,
    pub file_size: u64,
    pub nar_hash: String,
    pub nar_size: u64,
    #[serde(default)]
    pub references: Vec<String>,
    pub deriver: Option<String>,
    pub ca: Option<String>,
    pub signature: Option<String>,
}

impl NarInfo {
    pub fn fingerprint(&self) -> String {
        let references = self
            .references
            .iter()
            .map(|reference| {
                if reference.starts_with('/') {
                    reference.clone()
                } else {
                    format!("/nix/store/{reference}")
                }
            })
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "1;{};{};{};{}",
            self.store_path, self.nar_hash, self.nar_size, references
        )
    }

    pub fn sign(&mut self, key_name: &str, key: &SigningKey) {
        self.signature = Some(format!(
            "{}:{}",
            key_name,
            STANDARD.encode(key.sign(self.fingerprint().as_bytes()).to_bytes())
        ));
    }

    pub fn render(&self) -> String {
        let mut out = String::new();
        macro_rules! line {
            ($k:literal, $v:expr) => {
                let _ = writeln!(out, "{}: {}", $k, $v);
            };
        }
        line!("StorePath", self.store_path);
        line!("URL", self.url);
        line!("Compression", self.compression);
        line!("FileHash", self.file_hash);
        line!("FileSize", self.file_size);
        line!("NarHash", self.nar_hash);
        line!("NarSize", self.nar_size);
        line!("References", self.references.join(" "));
        if let Some(v) = &self.deriver {
            line!("Deriver", v);
        }
        if let Some(v) = &self.ca {
            line!("CA", v);
        }
        if let Some(v) = &self.signature {
            line!("Sig", v);
        }
        out
    }
}
