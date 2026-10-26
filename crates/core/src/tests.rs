use super::*;
#[test]
fn validates_names() {
    assert!("team-cache_1".parse::<CacheName>().is_ok());
    assert!("Bad/cache".parse::<CacheName>().is_err());
    assert!(serde_json::from_str::<CacheName>(r#""Bad/cache""#).is_err());
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
