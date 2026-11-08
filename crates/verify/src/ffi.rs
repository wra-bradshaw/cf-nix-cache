//! Plain-integer wasm interface: status 0 is the decoded chunk, 1 is a UTF-8 message.

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
/// Null is rejected without dereferencing it.
unsafe fn handle<'a>(handle: *mut Handle) -> Option<&'a mut Handle> {
    if handle.is_null() {
        None
    } else {
        Some(&mut *handle)
    }
}

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

/// Returns where to write `len` bytes, or null for empty, oversize, or
/// null-handle input. Null covers both empty and too large, so check `len`
/// to tell them apart.
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

/// Output is the NAR size as u64 LE.
///
/// # Safety
/// See [`handle`].
#[no_mangle]
pub unsafe extern "C" fn verifier_finish(handle: *mut Handle) -> u32 {
    let Some(handle) = self::handle(handle) else {
        return 1;
    };
    // Restore on `Err` so a failed finish does not seal.
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

/// Null when there is no output yet; only dereference when
/// `verifier_output_len` is non-zero.
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
            assert_eq!(push(handle, &nar, false), 0);
            assert_eq!(verifier_finish(handle), 1);
            assert!(output_text(handle).contains("truncated"));
            assert_eq!(push(handle, &nar, true), 0);
            assert_eq!(verifier_finish(handle), 0);
            assert_eq!(output_bytes(handle).len(), 8);
            assert_eq!(verifier_finish(handle), 1);
            assert!(output_text(handle).contains("already finished"));
            assert_eq!(push(handle, &nar, true), 1);
            assert!(output_text(handle).contains("already finished"));
            verifier_free(handle);
        }
    }
}
