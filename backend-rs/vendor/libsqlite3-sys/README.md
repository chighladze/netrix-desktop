# Netrix SQLCipher compatibility adapter

SQLx 0.8.6 requires libsqlite3-sys 0.30.1, whose bundled SQLCipher is obsolete.
This narrow local Cargo patch retains the unmodified MIT-licensed Rust ABI
bindings and error helpers from upstream libsqlite3-sys 0.30.1. Only the library
include and native build are adapted. The pinned, checksummed sqlcipher-src
420.0.0 package supplies SQLCipher 4.20.0 / SQLite 3.54.1 and its supported
LibTomCrypt 1.18.2 provider. No C implementation is copied or modified here.

Native OS entropy comes from a small Rust `getrandom` ABI bridge, replacing only
LibTomCrypt's generic `rng_get_bytes` entry point. OS RNG failure returns zero
bytes instead of falling back to clock jitter. Temporary SQLite storage is
memory-only. Runtime tests assert cipher/version availability, wrong-key rejection, encrypted WAL,
tamper rejection and complete migration roundtrips. Never substitute ordinary
SQLite or silently remove this patch. This adapter can be removed after an
SQLx release accepts a current libsqlite3-sys with the same SQLCipher baseline.

Sources: https://github.com/rusqlite/rusqlite (v0.32.1 libsqlite3-sys 0.30.1),
https://github.com/sqlcipher/sqlcipher/releases/tag/v4.20.0,
https://crates.io/crates/sqlcipher-src/420.0.0
