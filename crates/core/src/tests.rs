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
    assert_eq!(invalid.validate(), Err(Error::InvalidChunkManifest));
    let mut empty = manifest.clone();
    empty.chunks.clear();
    assert_eq!(empty.validate(), Err(Error::InvalidChunkManifest));
    let mut invalid_hash = manifest;
    invalid_hash.file_hash = format!("sha256:{}", "o".repeat(52));
    assert!(invalid_hash.validate().is_err());
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
}

#[test]
fn encoding_id_names_its_parameters() {
    const MIB: usize = 1024 * 1024;
    assert_eq!(
        ENCODING_ID,
        format!(
            "fastcdc-v2020-min{}m-avg{}m-max{}m-zstd{}-v1",
            CHUNK_MIN_SIZE / MIB,
            CHUNK_AVG_SIZE / MIB,
            CHUNK_MAX_SIZE / MIB,
            ZSTD_LEVEL
        )
    );
}

#[test]
fn validates_nar_hashes() {
    assert!(validate_nar_hash(&format!("sha256:{}", "0".repeat(52))).is_ok());
    assert!(validate_nar_hash("sha256:bad").is_err());
    assert!(validate_nar_hash(&format!("sha512:{}", "0".repeat(52))).is_err());
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
