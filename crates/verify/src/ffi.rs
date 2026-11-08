//! The WebAssembly interface, kept to plain integers and pointers so the
//! Worker needs no generated bindings (see `packages/worker/src/features/
//! uploads/verifier.ts`). JavaScript writes a chunk into the handle's input
//! buffer, calls a function, and reads the handle's output buffer: the decoded
//! chunk on success (status 0), a UTF-8 message for invalid content (status 1).

use crate::{Invalid, Verifier, CHUNK_MAX_COMPRESSED_SIZE};

pub struct Handle {
    verifier: Option<Verifier>,
    input: Vec<u8>,
    output: Vec<u8>,
}

impl Handle {
    fn respond(&mut self, result: Result<(), Invalid>) -> u32 {
        match result {
            Ok(()) => 0,
            Err(Invalid(message)) => {
                self.output = message.into_bytes();
                1
            }
        }
    }
}

/// # Safety
/// Every `handle` below must come from `verifier_new` and not yet be freed.
/// A null handle is rejected without dereferencing it: functions returning a
/// pointer return null, `verifier_output_len` returns the length of
/// [`NULL_HANDLE_MESSAGE`], `verifier_free` does nothing, and
/// `verifier_chunk`/`verifier_finish` return 1 (invalid content) so the
/// caller treats it as a clean error rather than trapping on undefined
/// behavior. The output functions report [`NULL_HANDLE_MESSAGE`] for a null
/// handle (there is no handle to store a message in), so a null handle still
/// yields a distinct message instead of an empty one. The TypeScript wrapper
/// (`verifier.ts`) maps that distinct empty-output path to a retryable
/// `Error` rather than `InvalidEncodingError`: a null handle is a
/// wrapper/wasm mismatch, not unacceptable content (and is unreachable
/// through the wrapper, whose constructor rejects a null `verifier_new`).
unsafe fn handle<'a>(handle: *mut Handle) -> Option<&'a mut Handle> {
    if handle.is_null() {
        None
    } else {
        Some(&mut *handle)
    }
}

/// Reported through `verifier_output`/`verifier_output_len` when a null
/// handle reaches `verifier_chunk`/`verifier_finish`. There is no handle to
/// store a message in, so it lives in a static buffer; without it a null
/// handle would surface as an empty message.
static NULL_HANDLE_MESSAGE: &[u8] = b"verifier is not initialized";

#[no_mangle]
pub extern "C" fn verifier_new() -> *mut Handle {
    Box::into_raw(Box::new(Handle {
        verifier: Some(Verifier::new()),
        input: Vec::new(),
        output: Vec::new(),
    }))
}

/// # Safety
/// See [`handle`]; the handle must not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn verifier_free(handle: *mut Handle) {
    if handle.is_null() {
        return;
    }
    drop(Box::from_raw(handle));
}

/// Sizes the input buffer for a chunk of `len` bytes and returns where to
/// write it, or null when `len` is 0 or exceeds
/// `CHUNK_MAX_COMPRESSED_SIZE` (a null handle also yields null; see
/// [`handle`]). Empty input is rejected here so a
/// zero-length write cannot produce an empty-`Vec` dangling pointer, and
/// oversize input is rejected before any allocation. Both cases
/// intentionally report null through the same pointer: the FFI has no other
/// error channel here (returning distinct sentinels would change the stable
/// ABI for no behavioral gain, since the lengths are already known to the
/// caller). The caller must therefore treat null as "empty or too large"
/// and check the length itself to tell them apart (see `verifier.ts`, whose
/// pre-check rejects empty and oversize input with distinct messages before
/// reaching wasm, and whose `nullInputMessage` names the two cases, so its
/// direct callers never see null for empty input).
/// Direct users of this wasm interface bypassing `verifier.ts` see null for
/// either case and must check the length they passed in (0 means empty,
/// otherwise too large) to disambiguate.
///
/// # Safety
/// See [`handle`]. The pointer is valid until the next call on the handle.
#[no_mangle]
pub unsafe extern "C" fn verifier_input(handle: *mut Handle, len: usize) -> *mut u8 {
    let Some(handle) = self::handle(handle) else {
        return std::ptr::null_mut();
    };
    if len == 0 || len > CHUNK_MAX_COMPRESSED_SIZE {
        return std::ptr::null_mut();
    }
    handle.input.resize(len, 0);
    handle.input.as_mut_ptr()
}

/// Decodes the chunk in the input buffer into the output buffer. With
/// `whole_nar` set it is also the next chunk of the NAR.
///
/// # Safety
/// See [`handle`].
#[no_mangle]
pub unsafe extern "C" fn verifier_chunk(
    handle: *mut Handle,
    raw_size: usize,
    whole_nar: u32,
) -> u32 {
    let Some(handle) = self::handle(handle) else {
        return 1;
    };
    let Handle {
        verifier,
        input,
        output,
    } = handle;
    let result = match verifier.as_mut() {
        None => Err(Invalid("verifier is already finished".into())),
        Some(verifier) => verifier.chunk(input, raw_size, whole_nar != 0, output),
    };
    handle.respond(result)
}

/// Ends the NAR, which must be complete. Output: its size, as a u64 LE.
///
/// # Safety
/// See [`handle`].
#[no_mangle]
pub unsafe extern "C" fn verifier_finish(handle: *mut Handle) -> u32 {
    let Some(handle) = self::handle(handle) else {
        return 1;
    };
    // `take` so a sealed handle reports "already finished" via `None`.
    // A failed finish must not seal (see `Verifier::finish`), so the
    // verifier is restored on `Err`; otherwise the next call would
    // misreport an unfinished NAR as finished.
    let Some(mut verifier) = handle.verifier.take() else {
        return handle.respond(Err(Invalid("verifier is already finished".into())));
    };
    let result = verifier.finish().map(|size| {
        handle.output = size.to_le_bytes().to_vec();
    });
    if result.is_err() {
        handle.verifier = Some(verifier);
    }
    handle.respond(result)
}

/// The handle's output buffer: the decoded chunk on success (status 0), a
/// UTF-8 message for invalid content (status 1). Returns null when there is
/// no output yet; the caller must only dereference it when
/// `verifier_output_len` is non-zero. For a null handle it points at
/// [`NULL_HANDLE_MESSAGE`], so the null-handle rejection in
/// `verifier_chunk`/`verifier_finish` still yields a distinct message.
///
/// # Safety
/// See [`handle`]. The pointer is valid until the next call on the handle.
#[no_mangle]
pub unsafe extern "C" fn verifier_output(handle: *mut Handle) -> *const u8 {
    let Some(handle) = self::handle(handle) else {
        return NULL_HANDLE_MESSAGE.as_ptr();
    };
    let output = &handle.output;
    if output.is_empty() {
        std::ptr::null()
    } else {
        output.as_ptr()
    }
}

/// # Safety
/// See [`handle`].
#[no_mangle]
pub unsafe extern "C" fn verifier_output_len(handle: *mut Handle) -> usize {
    let Some(handle) = self::handle(handle) else {
        return NULL_HANDLE_MESSAGE.len();
    };
    handle.output.len()
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

    /// Pushes one chunk through the C interface; returns the status code.
    unsafe fn push(handle: *mut Handle, raw: &[u8], whole_nar: bool) -> u32 {
        let compressed = compress(raw);
        let pointer = verifier_input(handle, compressed.len());
        assert!(!pointer.is_null());
        std::ptr::copy_nonoverlapping(compressed.as_ptr(), pointer, compressed.len());
        verifier_chunk(handle, raw.len(), u32::from(whole_nar))
    }

    unsafe fn output_bytes(handle: *mut Handle) -> Vec<u8> {
        let len = verifier_output_len(handle);
        if len == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(verifier_output(handle), len).to_vec()
        }
    }

    unsafe fn output_text(handle: *mut Handle) -> String {
        String::from_utf8(output_bytes(handle)).unwrap()
    }

    #[test]
    fn null_handle_reports_a_distinct_message() {
        unsafe {
            assert_eq!(verifier_chunk(std::ptr::null_mut(), 1, 1), 1);
            assert_eq!(verifier_finish(std::ptr::null_mut()), 1);
            let len = verifier_output_len(std::ptr::null_mut());
            assert!(len > 0);
            let bytes = std::slice::from_raw_parts(verifier_output(std::ptr::null_mut()), len);
            assert!(
                String::from_utf8_lossy(bytes).contains("not initialized"),
                "unexpected null-handle message: {bytes:?}"
            );
        }
    }

    #[test]
    fn invalid_nar_poison_propagates_through_ffi() {
        unsafe {
            let handle = verifier_new();
            assert!(!handle.is_null());
            // An invalid NAR chunk poisons the handle (see
            // `failed_nar_push_poisons_the_verifier` in `lib.rs`): the next
            // chunk and `finish` must report "poisoned" rather than accepting
            // more input or the truncated NAR.
            let junk = b"definitely not a NAR".to_vec();
            assert_eq!(push(handle, &junk, true), 1);
            assert!(output_text(handle).contains("invalid NAR"));
            let nar = file_nar(b"hello");
            assert_eq!(push(handle, &nar, true), 1);
            assert!(output_text(handle).contains("poisoned"));
            assert_eq!(verifier_finish(handle), 1);
            assert!(output_text(handle).contains("poisoned"));
            verifier_free(handle);
        }
    }

    #[test]
    fn failed_finish_does_not_consume_the_handle() {
        unsafe {
            let handle = verifier_new();
            assert!(!handle.is_null());
            let nar = file_nar(b"hello");
            // Without `whole_nar` nothing reaches the NAR validator, so the
            // NAR is still truncated and `finish` must fail.
            assert_eq!(push(handle, &nar, false), 0);
            assert_eq!(verifier_finish(handle), 1);
            assert!(output_text(handle).contains("truncated"));
            // The handle must still accept the NAR after the failed finish;
            // before the restore fix this reported "already finished".
            assert_eq!(push(handle, &nar, true), 0);
            assert_eq!(verifier_finish(handle), 0);
            assert_eq!(output_bytes(handle).len(), 8);
            // A successful finish seals the handle instead.
            assert_eq!(verifier_finish(handle), 1);
            assert!(output_text(handle).contains("already finished"));
            assert_eq!(push(handle, &nar, true), 1);
            assert!(output_text(handle).contains("already finished"));
            verifier_free(handle);
        }
    }
}
