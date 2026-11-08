use crate::protocol::{nix_base32, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE, CHUNK_MIN_SIZE, ZSTD_LEVEL};
use anyhow::{bail, Context, Result};
use fastcdc::v2020::StreamCDC;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    process::{Command, Stdio},
};
use tempfile::NamedTempFile;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct EncodedChunk {
    pub(crate) raw_hash: String,
    pub(crate) raw_size: u64,
    pub(crate) compressed_hash: String,
    pub(crate) compressed_size: u64,
    offset: u64,
}

pub(crate) struct EncodedNar {
    file: NamedTempFile,
    pub(crate) chunks: Vec<EncodedChunk>,
    pub(crate) nar_hash: String,
    pub(crate) nar_size: u64,
}

impl EncodedNar {
    pub(crate) fn chunk_bytes(&self, raw_hash: &str) -> Result<Vec<u8>> {
        let chunk = self
            .chunks
            .iter()
            .find(|chunk| chunk.raw_hash == raw_hash)
            .with_context(|| format!("server asked for unknown chunk {raw_hash}"))?;
        let mut file = File::open(self.file.path())?;
        file.seek(SeekFrom::Start(chunk.offset))?;
        let mut bytes = vec![0; usize::try_from(chunk.compressed_size)?];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }
}

fn sha256_nix(bytes: &[u8]) -> String {
    format!("sha256:{}", nix_base32(&Sha256::digest(bytes)))
}

struct HashingReader<R> {
    inner: R,
    hash: Sha256,
    size: u64,
}

impl<R: Read> Read for HashingReader<R> {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let read = self.inner.read(buffer)?;
        self.hash.update(&buffer[..read]);
        self.size += read as u64;
        Ok(read)
    }
}

pub(crate) fn encode(nar: impl Read) -> Result<EncodedNar> {
    let mut reader = HashingReader {
        inner: nar,
        hash: Sha256::new(),
        size: 0,
    };
    let mut file = NamedTempFile::new()?;
    let mut chunks = Vec::new();
    let mut offset = 0u64;
    for chunk in StreamCDC::new(&mut reader, CHUNK_MIN_SIZE, CHUNK_AVG_SIZE, CHUNK_MAX_SIZE) {
        let data = chunk.context("reading NAR")?.data;
        let compressed = zstd::encode_all(data.as_slice(), ZSTD_LEVEL)?;
        file.write_all(&compressed)?;
        chunks.push(EncodedChunk {
            raw_hash: sha256_nix(&data),
            raw_size: data.len() as u64,
            compressed_hash: sha256_nix(&compressed),
            compressed_size: compressed.len() as u64,
            offset,
        });
        offset += compressed.len() as u64;
    }
    file.flush()?;
    if chunks.is_empty() {
        bail!("NAR is empty");
    }
    Ok(EncodedNar {
        file,
        chunks,
        nar_hash: format!("sha256:{}", nix_base32(&reader.hash.finalize())),
        nar_size: reader.size,
    })
}

pub(crate) fn encode_path(path: &str, nar_hash: &str, nar_size: u64) -> Result<EncodedNar> {
    let mut child = Command::new("nix-store")
        .args(["--dump", path])
        .stdout(Stdio::piped())
        .spawn()?;
    let encoded = encode(
        child
            .stdout
            .take()
            .context("nix-store did not provide stdout")?,
    );
    if !child.wait()?.success() {
        bail!("nix-store --dump failed for {path}");
    }
    let encoded = encoded?;
    if encoded.nar_hash != nar_hash || encoded.nar_size != nar_size {
        bail!(
            "the NAR of {path} does not match its recorded hash ({} {}, expected {nar_hash} {nar_size}); \
             the store path may be corrupt (try nix-store --verify --check-contents)",
            encoded.nar_hash,
            encoded.nar_size,
        );
    }
    Ok(encoded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_chunks_that_reassemble_to_the_nar() {
        let mut state = 7u64;
        let nar: Vec<u8> = (0..5 * CHUNK_MAX_SIZE / 2)
            .map(|_| {
                state = state.wrapping_mul(6364136223846793005).wrapping_add(1);
                (state >> 59) as u8
            })
            .collect();
        let encoded = encode(nar.as_slice()).unwrap();
        assert!(encoded.chunks.len() > 1);
        assert_eq!(encoded.nar_size, nar.len() as u64);
        assert_eq!(encoded.nar_hash, sha256_nix(&nar));
        let mut joined = Vec::new();
        for chunk in &encoded.chunks {
            assert!(chunk.raw_size <= CHUNK_MAX_SIZE as u64);
            let bytes = encoded.chunk_bytes(&chunk.raw_hash).unwrap();
            assert_eq!(sha256_nix(&bytes), chunk.compressed_hash);
            let raw = zstd::decode_all(bytes.as_slice()).unwrap();
            assert_eq!(sha256_nix(&raw), chunk.raw_hash);
            joined.extend(raw);
        }
        assert_eq!(joined, nar);
    }

    /// A zstd upgrade must not silently change output; correctness does not depend on it.
    #[test]
    fn compression_output_is_stable_for_the_encoding_profile() {
        let mut state = 0x2545_f491_4f6c_dd1d_u64;
        let input: Vec<u8> = (0..1 << 20)
            .map(|index: u32| {
                state = state
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                if index % 4096 < 3072 {
                    b"/nix/store/cf-nix-cache-golden-input "[index as usize % 37]
                } else {
                    (state >> 56) as u8
                }
            })
            .collect();
        let encoded = encode(input.as_slice()).unwrap();
        assert_eq!(encoded.chunks.len(), 1);
        assert_eq!(
            (
                encoded.chunks[0].compressed_size,
                encoded.chunks[0].compressed_hash.as_str()
            ),
            (
                264_109,
                "sha256:1r75kjlcavpmzdp0kshxs921h98115mrjlr37hflkgk38zffmq1s"
            ),
        );
    }

    #[test]
    fn a_small_nar_is_one_chunk() {
        let encoded = encode(&b"small"[..]).unwrap();
        assert_eq!(encoded.chunks.len(), 1);
        assert_eq!(encoded.chunks[0].raw_size, 5);
    }
}
