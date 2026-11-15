fn main() {
    let source = sqlcipher_src::source_dir();
    let mut native = cc::Build::new();
    native
        .warnings(false)
        .include(source)
        .include(source.join(sqlcipher_src::LIBTOMCRYPT_INCLUDE_DIR));
    // Supported upstream LibTomCrypt provider, with native OS entropy.
    // No WASM random shim, custom cipher, external DLL, or plaintext fallback.
    for flag in [
        "LTC_NOTHING",
        "LTC_NO_TEST",
        "LTC_RIJNDAEL",
        "LTC_CBC_MODE",
        "LTC_SHA1",
        "LTC_SHA256",
        "LTC_SHA512",
        "LTC_HASH_HELPERS",
        "LTC_HMAC",
        "LTC_PKCS_5",
        "LTC_FORTUNA",
        "LTC_RNG_GET_BYTES",
        "LTC_DEVRANDOM",
    ] {
        native.define(flag, None);
    }
    let mut crypto = native.clone();
    crypto
        .define("LTC_SOURCE", None)
        .files(
            sqlcipher_src::LIBTOMCRYPT_SOURCES
                .iter()
                // Upstream's generic RNG falls back to clock jitter on OS RNG
                // failure. Use the fail-closed Rust OS entropy bridge instead.
                .filter(|file| !file.ends_with("/rng_get_bytes.c"))
                .map(|file| source.join(file)),
        )
        .compile("netrix_tomcrypt");
    native
        .file(source.join(sqlcipher_src::SOURCE_FILE))
        .define("SQLITE_HAS_CODEC", "1")
        .define("SQLCIPHER_CRYPTO_LIBTOMCRYPT", "1")
        .define("SQLITE_EXTRA_INIT", "sqlcipher_extra_init")
        .define("SQLITE_EXTRA_SHUTDOWN", "sqlcipher_extra_shutdown")
        .define("SQLITE_THREADSAFE", "1")
        .define("SQLITE_TEMP_STORE", "3")
        .define("SQLITE_ENABLE_COLUMN_METADATA", None)
        .define("SQLITE_ENABLE_UNLOCK_NOTIFY", None)
        .define("SQLITE_ENABLE_API_ARMOR", None)
        .define("SQLITE_ENABLE_FTS5", None)
        .define("SQLITE_ENABLE_RTREE", None)
        .define("SQLITE_ENABLE_DBSTAT_VTAB", None)
        .define("SQLITE_USE_URI", None)
        .compile("sqlite3");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
    println!("cargo:include={}", source.display());
    println!("cargo:rerun-if-changed=build.rs");
}
