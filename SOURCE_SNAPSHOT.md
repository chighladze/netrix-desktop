# Public source snapshot

The first public tree is based on Netrix **0.3.0-beta.8**, released on 2026-11-15.
It includes application source, tests, icons, vendored dependency patches,
lockfiles and the MIT license. Runtime source and lockfiles are copied unchanged
from the release source. Public developer docs, CI and its validation tests are
adapted for this repo.

Private Git history, internal release reports, local tools, personal workspaces,
credentials and unpublished development changes are not included. Later public
changes use normal reviewed commits; tags identify published source snapshots.

The existing Windows installer is distributed through
[netrix-releases](https://github.com/chighladze/netrix-releases/releases).
Source availability does not change its unsigned status or the documented gaps
in clean-Windows/manual acceptance testing.

Before the initial publication, the exported tree was scanned with Gitleaks
8.30.1. Reviewed exceptions in `.gitleaksignore` identify public upstream russh
test key material, the RFC 6455 sample WebSocket nonce and the static JWT decoder
example. They are fixture-specific exceptions, not exclusions of whole folders.
Never reuse demonstration/test keys or tokens for real systems.
