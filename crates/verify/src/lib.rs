mod ffi;
pub mod nar;

use nar::NarValidator;
use zstd_safe::DCtx;

/// Largest raw chunk the encoding produces. Canonical value; must stay in
/// sync with `CHUNK_MAX_SIZE` in `crates/cli/src/protocol/mod.rs`,
/// `CHUNK_MAX_RAW_SIZE` in `packages/worker/src/features/uploads/encoding.ts`,
/// and `CHUNK_MAX_RAW_SIZE` in `packages/worker/src/features/uploads/verifier.ts`.
/// The encoding id `fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1` names these
/// parameters (see `encoding_constants_stay_in_sync`).
pub const CHUNK_MAX_RAW_SIZE: usize = 16 * 1024 * 1024;
/// zstd's worst case for a `CHUNK_MAX_RAW_SIZE` frame, rounded up. Canonical
/// value; must stay in sync with `CHUNK_MAX_COMPRESSED_SIZE` in
/// `packages/worker/src/features/uploads/encoding.ts` and in
/// `packages/worker/src/features/uploads/verifier.ts`.
pub const CHUNK_MAX_COMPRESSED_SIZE: usize = 17 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invalid(pub String);

impl std::fmt::Display for Invalid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Invalid {}

impl From<nar::InvalidNar> for Invalid {
    fn from(error: nar::InvalidNar) -> Self {
        Invalid(format!("invalid NAR archive: {error}"))
    }
}

fn invalid<T>(message: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid(message.into()))
}

fn check_sizes(compressed: &[u8], raw_size: usize) -> Result<(), Invalid> {
    if compressed.is_empty() {
        return invalid("chunk is empty");
    }
    if raw_size == 0 || raw_size > CHUNK_MAX_RAW_SIZE {
        return invalid(format!("chunk size {raw_size} is out of range"));
    }
    if compressed.len() > CHUNK_MAX_COMPRESSED_SIZE {
        return invalid("chunk is too large");
    }
    Ok(())
}

/// Writes straight into a `raw_size` buffer, so a lying header cannot force over-allocation.
fn decode(
    context: &mut DCtx<'static>,
    compressed: &[u8],
    raw_size: usize,
    raw: &mut Vec<u8>,
) -> Result<(), Invalid> {
    // Every byte is overwritten, so a buffer is only zeroed when it grows.
    if raw.len() < raw_size {
        raw.resize(raw_size, 0);
    }
    raw.truncate(raw_size);
    let written = context
        .decompress(&mut raw[..], compressed)
        .map_err(|code| {
            // `dstSize_tooSmall` is the stable overflow signal across zstd versions.
            // SAFETY: `code` is a return value of `ZSTD_decompressDCtx`,
            // which `ZSTD_getErrorCode` accepts.
            let error = unsafe { zstd_safe::zstd_sys::ZSTD_getErrorCode(code) };
            if error == zstd_safe::zstd_sys::ZSTD_ErrorCode::ZSTD_error_dstSize_tooSmall {
                Invalid(format!("chunk decodes to more than {raw_size} bytes"))
            } else {
                Invalid(format!(
                    "chunk is not valid zstd: {}",
                    zstd_safe::get_error_name(code)
                ))
            }
        })?;
    if written != raw_size {
        raw.truncate(written);
        return invalid(format!("chunk decodes to {written} bytes, not {raw_size}"));
    }
    Ok(())
}

/// Checks one NAR's chunks in order. Hashing is left to the caller.
/// A failed NAR push poisons the verifier; a successful `finish` seals it.
pub struct Verifier {
    nar: NarValidator,
    nar_size: u64,
    context: DCtx<'static>,
    poisoned: bool,
    finished: bool,
}

impl Default for Verifier {
    fn default() -> Self {
        Self::new()
    }
}

impl Verifier {
    pub fn new() -> Self {
        Self {
            nar: NarValidator::new(),
            nar_size: 0,
            context: DCtx::create(),
            poisoned: false,
            finished: false,
        }
    }

    /// With `whole_nar` the chunk extends the NAR; without, it is checked alone.
    pub fn chunk(
        &mut self,
        compressed: &[u8],
        raw_size: usize,
        whole_nar: bool,
        raw: &mut Vec<u8>,
    ) -> Result<(), Invalid> {
        if self.finished {
            return invalid("verifier is already finished");
        }
        if self.poisoned {
            return invalid("verifier poisoned, discard");
        }
        check_sizes(compressed, raw_size)?;
        decode(&mut self.context, compressed, raw_size, raw)?;
        if whole_nar {
            if let Err(error) = self.nar.push(raw) {
                self.poisoned = true;
                return Err(error.into());
            }
            self.nar_size += raw_size as u64;
        }
        Ok(())
    }

    /// Returns the NAR size. Seals the verifier.
    pub fn finish(&mut self) -> Result<u64, Invalid> {
        if self.finished {
            return invalid("verifier is already finished");
        }
        if self.poisoned {
            return invalid("verifier poisoned, discard");
        }
        self.nar.finish()?;
        self.finished = true;
        Ok(self.nar_size)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::nar::tests::{nar, Field};

    fn compress(raw: &[u8]) -> Vec<u8> {
        zstd::bulk::compress(raw, 3).unwrap()
    }

    fn file_nar(contents: &[u8]) -> Vec<u8> {
        nar(&[
            Field::S("nix-archive-1"),
            Field::S("("),
            Field::S("type"),
            Field::S("regular"),
            Field::S("contents"),
            Field::B(contents),
            Field::S(")"),
        ])
    }

    fn check_chunk(compressed: &[u8], raw_size: usize) -> Result<Vec<u8>, Invalid> {
        let mut raw = Vec::new();
        Verifier::new().chunk(compressed, raw_size, false, &mut raw)?;
        Ok(raw)
    }

    #[test]
    fn verifies_a_nar_split_into_chunks() {
        let contents: Vec<u8> = (0..5_000_000u32).map(|n| (n % 251) as u8).collect();
        let nar = file_nar(&contents);
        let mut verifier = Verifier::new();
        let mut decoded = Vec::new();
        let mut raw = Vec::new();
        for part in nar.chunks(1024 * 1024 + 3) {
            let compressed = compress(part);
            verifier
                .chunk(&compressed, part.len(), true, &mut raw)
                .unwrap();
            assert_eq!(raw, part);
            assert_eq!(check_chunk(&compressed, part.len()).unwrap(), part);
            decoded.extend_from_slice(&raw);
        }
        assert_eq!(verifier.finish().unwrap(), nar.len() as u64);
        assert_eq!(decoded, nar);
    }

    #[test]
    fn accepts_concatenated_frames() {
        let raw = file_nar(b"hello");
        let (left, right) = raw.split_at(16);
        let mut compressed = compress(left);
        compressed.extend(compress(right));
        assert_eq!(check_chunk(&compressed, raw.len()).unwrap(), raw);
    }

    #[test]
    fn rejects_bad_chunks() {
        let raw = file_nar(b"hello");
        let compressed = compress(&raw);
        let error = |compressed: &[u8], size: usize| check_chunk(compressed, size).unwrap_err().0;
        assert!(error(&compressed, raw.len() - 1).contains("more than"));
        assert!(error(&compressed, raw.len() + 1).contains("not"));
        assert!(error(b"not zstd at all", 4).contains("not valid zstd"));
        assert!(error(&compressed[..compressed.len() - 2], raw.len()).contains("not valid zstd"));
        assert!(error(&[], 4).contains("empty"));
        assert!(error(&compressed, 0).contains("out of range"));
        let mut huge = compressed.clone();
        huge[4] = 0xE0;
        huge.splice(5..5, [0, 0, 0, 0, 0, 1, 0, 0]);
        assert!(error(&huge, 4).contains("not valid zstd"));
    }

    #[test]
    fn rejects_an_invalid_or_incomplete_nar() {
        let mut raw = Vec::new();
        let junk = b"definitely not a NAR".to_vec();
        let error = Verifier::new()
            .chunk(&compress(&junk), junk.len(), true, &mut raw)
            .unwrap_err();
        assert!(error.0.contains("invalid NAR"));
        let nar = file_nar(b"hello");
        let mut verifier = Verifier::new();
        verifier
            .chunk(&compress(&nar[..24]), 24, true, &mut raw)
            .unwrap();
        assert!(verifier.finish().unwrap_err().0.contains("truncated"));
    }

    #[test]
    fn encoding_constants_stay_in_sync() {
        // Duplicated without a CLI dependency; `upload-nar.mts --check-drift` gates joint drift.
        const MIB: usize = 1024 * 1024;
        assert_eq!(CHUNK_MAX_RAW_SIZE, 16 * MIB);
        assert_eq!(CHUNK_MAX_COMPRESSED_SIZE, 17 * MIB);
        assert_eq!(
            "fastcdc-v2020-min1m-avg4m-max16m-zstd3-v1",
            format!(
                "fastcdc-v2020-min{}m-avg{}m-max{}m-zstd{}-v1",
                1,
                4,
                CHUNK_MAX_RAW_SIZE / MIB,
                3
            )
        );
    }

    #[test]
    fn failed_nar_push_poisons_the_verifier() {
        let nar = file_nar(b"hello");
        let mut verifier = Verifier::new();
        let mut raw = Vec::new();
        verifier
            .chunk(&compress(&nar[..24]), 24, true, &mut raw)
            .unwrap();
        let junk = b"definitely not a NAR".to_vec();
        let error = verifier
            .chunk(&compress(&junk), junk.len(), true, &mut raw)
            .unwrap_err();
        assert!(error.0.contains("invalid NAR"));
        let mut raw = Vec::new();
        let poisoned = verifier
            .chunk(&compress(&nar[..24]), 24, true, &mut raw)
            .unwrap_err();
        assert!(poisoned.0.contains("poisoned"));
        assert!(verifier.finish().unwrap_err().0.contains("poisoned"));
    }

    #[test]
    fn finish_seals_the_verifier() {
        let nar = file_nar(b"hello");
        let mut verifier = Verifier::new();
        let mut raw = Vec::new();
        verifier
            .chunk(&compress(&nar), nar.len(), true, &mut raw)
            .unwrap();
        assert_eq!(verifier.finish().unwrap(), nar.len() as u64);
        let sealed = verifier
            .chunk(&compress(&nar), nar.len(), true, &mut raw)
            .unwrap_err();
        assert!(sealed.0.contains("already finished"));
        assert!(verifier
            .finish()
            .unwrap_err()
            .0
            .contains("already finished"));
        let mut verifier = Verifier::new();
        verifier
            .chunk(&compress(&nar), nar.len(), false, &mut raw)
            .unwrap();
        assert!(verifier.finish().unwrap_err().0.contains("truncated"));
        verifier
            .chunk(&compress(&nar), nar.len(), true, &mut raw)
            .unwrap();
        assert_eq!(verifier.finish().unwrap(), nar.len() as u64);
    }
}
