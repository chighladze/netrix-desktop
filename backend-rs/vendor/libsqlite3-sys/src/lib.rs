#![allow(non_snake_case, non_camel_case_types)]
#![cfg_attr(test, allow(deref_nullptr))] // https://github.com/rust-lang/rust-bindgen/issues/2066

pub use self::error::*;

/// OS entropy entry point consumed by the unmodified LibTomCrypt provider.
/// A failed OS RNG returns zero bytes; there is no clock-jitter fallback.
///
/// # Safety
/// The provider must supply a writable `length`-byte output buffer, or a null
/// pointer (which is rejected). This is the native LibTomCrypt callback ABI.
#[no_mangle]
pub unsafe extern "C" fn rng_get_bytes(
    output: *mut u8,
    length: std::os::raw::c_ulong,
    _callback: Option<unsafe extern "C" fn()>,
) -> std::os::raw::c_ulong {
    if output.is_null() || length == 0 {
        return 0;
    }
    let Ok(size) = usize::try_from(length) else {
        return 0;
    };
    // The caller's C ABI contract supplies a live writable buffer of this size.
    let buffer = unsafe { std::slice::from_raw_parts_mut(output, size) };
    if getrandom::fill(buffer).is_ok() {
        length
    } else {
        0
    }
}

use std::mem;

mod error;

#[must_use]
pub fn SQLITE_STATIC() -> sqlite3_destructor_type {
    None
}

#[must_use]
pub fn SQLITE_TRANSIENT() -> sqlite3_destructor_type {
    Some(unsafe { mem::transmute::<isize, unsafe extern "C" fn(*mut std::ffi::c_void)>(-1_isize) })
}

#[allow(dead_code, clippy::all)]
mod bindings {
    include!("bindings.rs");
}
pub use bindings::*;

impl Default for sqlite3_vtab {
    fn default() -> Self {
        unsafe { mem::zeroed() }
    }
}

impl Default for sqlite3_vtab_cursor {
    fn default() -> Self {
        unsafe { mem::zeroed() }
    }
}
