use super::*;
#[test]
fn validates_names() {
    assert!("team-cache_1".parse::<CacheName>().is_ok());
    assert!("Bad/cache".parse::<CacheName>().is_err());
    assert!(serde_json::from_str::<CacheName>(r#""Bad/cache""#).is_err());
}
#[test]
fn enforces_transitions() {
    assert_eq!(
        UploadStatus::Uploading.transition(UploadStatus::Aborted),
        Ok(UploadStatus::Aborted)
    );
    assert_eq!(
        UploadStatus::Uploading.transition(UploadStatus::Completing),
        Ok(UploadStatus::Completing)
    );
    assert_eq!(
        UploadStatus::Completing.transition(UploadStatus::Queued),
        Ok(UploadStatus::Queued)
    );
    assert!(UploadStatus::Ready
        .transition(UploadStatus::Uploading)
        .is_err());
}

#[test]
fn validates_chunk_manifest_totals_and_encoding() {
    let manifest = ChunkManifest {
        encoding_id: ENCODING_ID.into(),
        nar_hash: format!("sha256:{}", "0".repeat(52)),
        nar_size: 3,
        file_hash: format!("sha256:{}", "1".repeat(52)),
        file_size: 4,
        chunks: vec![ChunkRef {
            raw_hash: format!("sha256:{}", "2".repeat(52)),
            raw_size: 3,
            compressed_hash: format!("sha256:{}", "3".repeat(52)),
            compressed_size: 4,
            key: format!("chunks/{}/sha256:{}.zst", ENCODING_ID, "2".repeat(52)),
        }],
        processing_version: "test".into(),
        created_at: 1,
    };
    assert!(manifest.validate().is_ok());
    let mut invalid = manifest.clone();
    invalid.file_size = 5;
    assert!(invalid.validate().is_err());
    let mut invalid_hash = manifest;
    invalid_hash.file_hash = format!("sha256:{}", "o".repeat(52));
    assert!(invalid_hash.validate().is_err());
}
#[test]
fn permissions_are_scoped() {
    let c = TokenClaims {
        sub: "me".into(),
        iat: 0,
        exp: 1,
        iss: "issuer".into(),
        aud: "audience".into(),
        jti: "id".into(),
        grants: vec![TokenGrant {
            cache: "foo".into(),
            role: Role::Pull,
        }],
    };
    assert!(c.allows("foo", Role::Pull));
    assert!(!c.allows("foo", Role::Push));
    assert!(!c.allows("bar", Role::Pull));
    assert!(!c.can_delegate(&[TokenGrant {
        cache: "foo".into(),
        role: Role::Pull
    }]));
    let admin = TokenClaims {
        grants: vec![TokenGrant {
            cache: "*".into(),
            role: Role::Admin,
        }],
        ..c
    };
    assert!(admin.can_delegate(&[TokenGrant {
        cache: "foo".into(),
        role: Role::Push
    }]));
}
#[test]
fn narinfo_format_and_fingerprint() {
    let n = NarInfo {
        store_path: "/nix/store/abc-x".into(),
        url: "nar/abc.nar".into(),
        compression: "zstd".into(),
        file_hash: "sha256:f".into(),
        file_size: 1,
        nar_hash: "sha256:n".into(),
        nar_size: 2,
        references: vec!["r".into()],
        deriver: None,
        ca: None,
        signature: None,
    };
    assert_eq!(
        n.fingerprint(),
        "1;/nix/store/abc-x;sha256:n;2;/nix/store/r"
    );
    assert!(n.render().contains("Compression: zstd\n"));
}

#[test]
fn validates_manifest_identity() {
    let manifest = UploadManifest {
        cache: "cache".parse().unwrap(),
        store_hash: "0".repeat(32),
        store_path: format!("/nix/store/{}-hello", "0".repeat(32)),
        nar_hash: format!("sha256:{}", "0".repeat(52)),
        nar_size: 1,
        references: vec![],
        deriver: None,
        ca: None,
    };
    assert!(manifest.validate().is_ok());
    assert!(validate_nar_hash("sha256:bad").is_err());
    assert!(UploadManifest {
        store_path: format!("/nix/store/{}other", "0".repeat(32)),
        ..manifest.clone()
    }
    .validate()
    .is_err());
    assert!(UploadManifest {
        store_path: format!("/nix/store/{}-hello\nSig: forged", "0".repeat(32)),
        ..manifest.clone()
    }
    .validate()
    .is_err());
}

#[test]
fn references_use_nix_store_path_basenames() {
    let valid = format!("{}-glibc-2.39", "0".repeat(32));
    assert!(valid.parse::<StorePathName>().is_ok());
    assert!(format!("/nix/store/{valid}")
        .parse::<StorePathName>()
        .is_err());
    assert!(format!("{}-", "0".repeat(32))
        .parse::<StorePathName>()
        .is_err());
    assert!(format!("{}-bad/name", "0".repeat(32))
        .parse::<StorePathName>()
        .is_err());
    let mut manifest = UploadManifest {
        cache: "cache".parse().unwrap(),
        store_hash: "0".repeat(32),
        store_path: format!("/nix/store/{}-hello", "0".repeat(32)),
        nar_hash: format!("sha256:{}", "0".repeat(52)),
        nar_size: 1,
        references: vec![valid.parse().unwrap()],
        deriver: None,
        ca: None,
    };
    assert!(manifest.validate().is_ok());
    manifest.references.clear();
    assert!(serde_json::from_value::<UploadManifest>(serde_json::json!({
        "cache": "cache",
        "store_hash": "0".repeat(32),
        "store_path": "/nix/store/00000000000000000000000000000000-hello",
        "nar_hash": format!("sha256:{}", "0".repeat(52)),
        "nar_size": 1,
        "references": [format!("/nix/store/{valid}")],
        "deriver": null,
        "ca": null
    }))
    .is_err());
}

#[test]
fn delegated_tokens_cannot_outlive_the_issuer() {
    let claims = TokenClaims {
        sub: "me".into(),
        iat: 10,
        exp: 20,
        iss: "issuer".into(),
        aud: "audience".into(),
        jti: "id".into(),
        grants: vec![TokenGrant {
            cache: "foo".into(),
            role: Role::Admin,
        }],
    };
    assert!(claims.can_delegate_until(
        &[TokenGrant {
            cache: "foo".into(),
            role: Role::Pull
        }],
        19,
        10
    ));
    assert!(!claims.can_delegate_until(
        &[TokenGrant {
            cache: "foo".into(),
            role: Role::Pull
        }],
        21,
        10
    ));
}

#[test]
fn upload_part_count_is_server_owned() {
    let request = InitiateUploadRequest {
        manifest: UploadManifest {
            cache: "cache".parse().unwrap(),
            store_hash: "0".repeat(32),
            store_path: format!("/nix/store/{}-hello", "0".repeat(32)),
            nar_hash: format!("sha256:{}", "0".repeat(52)),
            nar_size: 1,
            references: vec![],
            deriver: None,
            ca: None,
        },
        compressed_size: 1,
    };
    let encoded = serde_json::to_value(&request).unwrap();
    assert!(encoded.get("parts").is_none());
    let mut unknown_field = encoded;
    unknown_field["parts"] = 1.into();
    assert!(serde_json::from_value::<InitiateUploadRequest>(unknown_field).is_err());
}

#[test]
fn canonicalizes_cli_requests_through_generated_contracts() {
    let valid = canonical_api_request(
        "/api/caches",
        serde_json::json!({"name": "cache", "quota_bytes": 1}),
    )
    .unwrap();
    assert_eq!(valid["name"], "cache");
    assert!(canonical_api_request(
        "/api/caches",
        serde_json::json!({"name": "cache", "quota_bytes": 1, "unexpected": true}),
    )
    .is_err());
}

#[test]
fn encodes_nix_base32() {
    assert_eq!(nix_base32(&[0; 32]), "0".repeat(52));
    let mut one = [0; 32];
    one[0] = 1;
    assert_eq!(
        nix_base32(&one),
        "0000000000000000000000000000000000000000000000000001"
    );
}
