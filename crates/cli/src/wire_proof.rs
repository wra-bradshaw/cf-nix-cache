//! TEMPORARY: proves typed contract bodies serialize byte-identically to the
//! old domain-DTO -> canonical_api_request path. Deleted with that path.
use crate::{args::parse_grant, upload::manifest};
use cf_nix_cache_core::{self as core, canonical_api_request, contracts::api as contract};
use serde::Serialize;
use std::num::NonZeroU64;

fn old(path: &str, value: impl Serialize) -> String {
    let value = canonical_api_request(path, serde_json::to_value(value).unwrap()).unwrap();
    String::from_utf8(serde_json::to_vec(&value).unwrap()).unwrap()
}

fn new(value: impl Serialize) -> String {
    String::from_utf8(serde_json::to_vec(&value).unwrap()).unwrap()
}

fn nz(value: u64) -> NonZeroU64 {
    NonZeroU64::new(value).unwrap()
}

fn old_grants() -> Vec<core::TokenGrant> {
    vec![
        core::TokenGrant {
            cache: "*".into(),
            role: core::Role::Admin,
        },
        core::TokenGrant {
            cache: "team".into(),
            role: core::Role::Pull,
        },
    ]
}

fn new_grants() -> Vec<contract::Grant> {
    vec![
        parse_grant("*=admin").unwrap(),
        parse_grant("team=pull").unwrap(),
    ]
}

#[test]
fn create_and_configure_cache() {
    for public in [false, true] {
        let a = old(
            "/api/caches",
            core::CreateCacheRequest {
                name: "team-cache_1".parse().unwrap(),
                public,
                quota_bytes: 1 << 40,
                encoding_id: core::ENCODING_ID.into(),
            },
        );
        let b = new(contract::CreateCache {
            encoding_id: Some(core::ENCODING_ID.into()),
            name: "team-cache_1".parse().unwrap(),
            public,
            quota_bytes: nz(1 << 40),
        });
        assert_eq!(a, b);
        let a = old(
            "/api/caches/team/config",
            core::ConfigureCacheRequest { public },
        );
        assert_eq!(a, new(contract::ConfigureCache { public }));
    }
}

#[test]
fn missing_paths() {
    let hashes = vec!["0".repeat(32), "z".repeat(32)];
    let a = old(
        "/api/caches/team/missing",
        core::MissingPathsRequest {
            store_hashes: hashes.clone(),
        },
    );
    let b = new(contract::MissingPaths {
        store_hashes: hashes.iter().map(|h| h.parse().unwrap()).collect(),
    });
    assert_eq!(a, b);
}

#[test]
fn token_and_bootstrap() {
    let request = core::CreateTokenRequest {
        subject: "ci".into(),
        valid_for_seconds: 3600,
        grants: old_grants(),
    };
    let a = old("/api/tokens", &request);
    let b = new(contract::TokenRequest {
        grants: new_grants(),
        subject: "ci".parse().unwrap(),
        valid_for_seconds: nz(3600),
    });
    assert_eq!(a, b);

    // Old bootstrap: CreateTokenRequest JSON with "secret" spliced in.
    let mut body = serde_json::to_value(&request).unwrap();
    body["secret"] = "s3cr3t".into();
    let a = old("/api/bootstrap", body);
    let b = new(contract::BootstrapRequest {
        grants: new_grants(),
        secret: "s3cr3t".parse().unwrap(),
        subject: "ci".parse().unwrap(),
        valid_for_seconds: nz(3600),
    });
    assert_eq!(a, b);
}

#[test]
fn upload_requests() {
    let hash = "0".repeat(32);
    let path = format!("/nix/store/{hash}-hello-2.12");
    let reference = format!("{}-glibc-2.39", "1".repeat(32));
    let deriver = format!("{}-hello-2.12.drv", "2".repeat(32));
    let nar_hash = format!("sha256:{}", "3".repeat(52));
    let full = serde_json::json!({
        "narHash": nar_hash,
        "narSize": 4096,
        "references": [format!("/nix/store/{reference}"), path.clone()],
        "deriver": format!("/nix/store/{deriver}"),
        "ca": "fixed:r:sha256:abc",
    });
    let bare = serde_json::json!({ "narHash": nar_hash, "narSize": 1, "references": [] });
    for (info, references, deriver, ca, nar_size) in [
        (
            &full,
            vec![
                reference.parse().unwrap(),
                format!("{hash}-hello-2.12").parse().unwrap(),
            ],
            Some(deriver.parse().unwrap()),
            Some("fixed:r:sha256:abc".to_owned()),
            4096,
        ),
        (&bare, vec![], None, None, 1),
    ] {
        let a = old(
            "/api/uploads",
            core::InitiateUploadRequest {
                manifest: core::UploadManifest {
                    cache: "team".parse().unwrap(),
                    store_hash: hash.clone(),
                    store_path: path.clone(),
                    nar_hash: nar_hash.clone(),
                    nar_size,
                    references,
                    deriver,
                    ca,
                },
                compressed_size: 777,
            },
        );
        let b = new(contract::UploadRequest {
            compressed_size: nz(777),
            manifest: manifest("team", &path, info).unwrap(),
        });
        assert_eq!(a, b);
    }
}

#[test]
fn complete_upload() {
    let a = old(
        "/api/uploads/u1/complete",
        core::CompleteUploadRequest { parts: vec![] },
    );
    assert_eq!(a, new(contract::CompleteUpload { parts: vec![] }));
    let a = old(
        "/api/uploads/u1/complete",
        core::CompleteUploadRequest {
            parts: vec![
                core::CompletedPart {
                    part_number: 1,
                    etag: "\"e1\"".into(),
                },
                core::CompletedPart {
                    part_number: 2,
                    etag: "\"e2\"".into(),
                },
            ],
        },
    );
    let b = new(contract::CompleteUpload {
        parts: vec![
            contract::CompleteUploadPartsItem {
                etag: "\"e1\"".parse().unwrap(),
                part_number: nz(1),
            },
            contract::CompleteUploadPartsItem {
                etag: "\"e2\"".parse().unwrap(),
                part_number: nz(2),
            },
        ],
    });
    assert_eq!(a, b);
    println!("{b}");
}
