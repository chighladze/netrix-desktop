# Temporary RSA dependency compatibility patch

Source: the crates.io `russh 0.65.1` archive (Apache-2.0). Licenses and upstream implementation are retained. The two key-format modules
replace the deprecated `rsa::RsaPrivateKey` alias with `rsa::PrivateKey` and
select `pkcs1::RsaPrivateKeyRef` explicitly for the newly generic DER type;
no cryptographic operations or algorithms change. `Cargo.toml` and `Cargo.toml.orig`
change only dependency pins: `rsa =0.10.0-rc.18` to `=0.10.0`, its required
`pkcs1 =0.8.0-rc.4` to `=0.8.0`, and (in the normalized manifest)
`ssh-key =0.7.0-rc.11` to `=0.7.0-rc.12`. The latter is the compatible upstream RSA 0.10 integration.
The upstream package lockfile and Cargo cache markers are omitted.

RustSec updated [RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html)
on 2026-11-08: RSA >=0.10.0 is patched. As of 2026-11-12 the latest published
russh (0.65.1) still pins the affected prerelease. This patch selects the
published, checksummed fixed dependencies without modifying cryptography or
accepting the advisory. Remove it when a compatible russh release accepts these
versions. Validate encrypted RSA/Ed25519 private keys, SSH host-key rejection,
terminal sessions and tunnels with `cargo test --manifest-path backend-rs/Cargo.toml`.
