# Toolbox / Utilities implementation review

Reference: local Termos at a separately reviewed reference implementation. Source search found no dedicated Toolbox renderer, network-tool IPC handlers or local formatter/generator module there. Its tools icon asset alone is not an implemented feature. Netrix's Utilities Hub is an independent implementation; this review does not assume feature parity with the original Termius product.

## Actual capabilities

| Area | Current implementation | Scope and limitations |
| --- | --- | --- |
| JSON | Local validation, pretty/minified output; shared helper also used by local DevTool | Formatting changes whitespace only, preserving raw numbers, duplicate keys and string escapes. Limits: 256 KiB input, 128 nesting levels, 2 MiB output. Tabs now produce tab indentation. |
| SQL | Conservative local formatting with opaque strings, quoted identifiers, line/block comments and dollar-quoted strings | Preserves their original contents and comment boundaries. Refuses malformed/unclosed or dialect-ambiguous backslash-quote boundaries. 256 KiB limit. This is display formatting, not SQL validation or a complete dialect parser. |
| XML / HTML | Existing local token/regex helpers, escape/unescape | Simple input only; complex mixed content, CDATA, scripts and whitespace-sensitive markup need a separate preservation review. Do not claim lossless general formatting. |
| Text, encoders, hashes and password generation | Browser-only transformations, Web Crypto digests/randomness and existing clipboard helper | No backend request is needed for these operations. JWT decoding does not verify signatures. JSON repair remains an explicit heuristic. |
| IPv4 / subnet | Strict dotted-decimal parser, unsigned arithmetic, CIDR calculations including /0, /31 and /32 | Rejects missing, fractional, exponent/hexadecimal and ambiguous leading-zero octets. IPv6 subnet calculation is not implemented. |
| TCP scan | Authenticated Axum endpoint performs actual TCP connects to one resolved IP | Maximum 1024 distinct ports, four active scans and 256 active probes across scans. Port-based service names/risk hints do not identify the actual service or prove a vulnerability. No UDP/banner scan. |
| TLS inspector | Authenticated backend uses rustls public CA roots and name/chain verification, then x509-parser | Returns resolved IP, verified name, TLS/cipher, issuer/subject, validity and DNS/IP SANs. Self-signed, expired or mismatched certificates fail verification; no insecure fallback was added. |
| Cron | Numeric five-field parser supports wildcard/range/list steps, Sunday 0/7 and restricted day-field OR semantics | Local-time preview over the next 100 hours, up to eight matches. Names, Quartz syntax, seconds and timezone selection are unsupported. It does not schedule jobs. Calendar/DST behavior of a real remote scheduler still needs independent validation. |
| Converters and command builders | Browser-local timestamp/number/color/byte conversion and copied shell/SSH/log command suggestions | No generated command is automatically executed. They are not a full shell or SQL parser; dialect/edge-case review remains. A generated ProxyJump command does not enable jump-host transport inside Netrix. |
| Local DevTool Runner | Utilities > Terminal Kit exposes the existing browser command registry through a dedicated local field | Input/output stays in component memory and clears on Clear/unmount. No HTTP, SSH, localStorage history or OS shell execution. Input max 64 KiB; UUID count 1–1000. Inherited command names are rejected. |

Cron semantics follow [crontab(5)](https://man7.org/linux/man-pages/man5/crontab.5.html): wildcard/range steps are evaluated inside each field; 0 and 7 mean Sunday; when both day fields are restricted, either may match. Unsupported syntax reports an error instead of silently becoming an empty schedule.

## Network execution and request ownership

`backend-rs/src/routers/network_tools.rs` owns router-local rate limiters and semaphores through an Axum extension. Separate router/test instances do not share process-global quota. TCP starts retain the five-token bucket with 0.5 token/second refill; TLS retains ten tokens and one/second refill. Those start limits are separate from the four-scan/eight-inspection active limits. Target/port/timeout/concurrency validation precedes TCP quota acquisition and DNS. TLS server-name parsing precedes DNS/connect.

TCP per-port timeout remains 50–30000 ms and per-request concurrency 1–256. A complete scan, including DNS and permit waits, has a 60-second deadline. DNS wait is capped at five seconds. Probe futures belong to the request and use bounded `buffer_unordered`; there are no detached per-port `tokio::spawn` tasks. Dropping/expiring that future releases probes and permits. A scan exceeding the total budget returns an explicit error, not an apparently complete zero-open-port result. Port specifications are limited to 8192 bytes and reject ranges exceeding 1024 distinct ports during expansion. Embedded spaces do not silently combine digits.

TLS timeout 50–30000 ms now covers DNS, TCP and TLS together, rather than granting the full timeout again to each phase. Requests never disable certificate validation. Resolution still selects the first address returned by the OS; fallback/Happy Eyeballs and scoped IPv6 literals are not implemented. Dropping a Tokio DNS future stops waiting, but an underlying OS resolver call may finish later.

`features/utilities/useNetworkTool.ts` owns one input snapshot and AbortController per mounted tool. Editing a field clears previous results and aborts waiting for the old request; late responses/errors cannot replace the new view. Unmount and Stop waiting dispose the client request/deadline timer. Empty, fractional, zero or out-of-range numeric fields report an error instead of silently using a default. A browser wait is capped at 65 seconds.

Stop waiting is deliberately not called guaranteed server cancellation: an HTTP disconnect may leave the handler running until its bounded deadline. An explicit server job/cancel API remains future work. This limitation is shown next to the scanner controls.

## DevTool privacy correction

Previously, `TerminalCanvas` forwarded keystrokes over SSH and only intercepted a `devtool ...` line on Enter, while displaying “Local Execution”. That could send sensitive transform input to the connected host before local execution began. Local execution now lives in the dedicated Utilities field. The legacy line collector and terminal Enter interception have been removed so password input is not accumulated for history or prefix detection. All keystrokes entered into an interactive terminal, including `devtool ...`, travel to that terminal, so the runner must be used for local transforms. Input already sent in an earlier session cannot be recalled.

## Validation

Backend unit/HTTP tests use in-memory SQLite and loopback-only fixtures. They cover target/port rejection, auth, quota isolation from malformed requests, active limits, real open/refused ports, queued-probe drop and TLS stall timeout/socket closure. Frontend tests cover stale responses after abort, editing results, Stop waiting/unmount, timer cleanup, invalid numeric fields, visible backend errors, Cron rules, IPv4 rejection, lossless JSON/SQL cases and local DevTool privacy/bounds.

Focused commands:

```powershell
$env:CARGO_TARGET_DIR = "$PWD/backend-rs/target/validation"
cargo test --manifest-path backend-rs/Cargo.toml --lib routers::network_tools
cargo test --manifest-path backend-rs/Cargo.toml --test network_tools_tests
npm run test:run --prefix frontend -- src/features/utilities src/components/UtilitiesHub.test.tsx
```

Run the complete backend suite, Clippy, Rust formatting and frontend tests/typecheck/build after changes. Manual desktop layout, audio/clipboard and external-server interoperability are separate from these automated checks. No SQLite migration, backup format, Vault policy or Tauri permission change is required by this pass.
