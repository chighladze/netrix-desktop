---
name: network-tools
description: 'Use when: changing Netrix Utility Hub network tools, TCP scan, TLS inspection, target validation, rate limiting, authorization warnings, or related frontend controls.'
---

# Network Tools

## Purpose

Guide changes to TCP scan and TLS inspection features.

## Rules

- Keep tools authenticated and localhost-only.
- Keep target validation against empty, too-long, or shell-metacharacter-containing hosts.
- Preserve max ports, timeout bounds, concurrency bounds, and rate limits.
- Start quotas do not replace active-work limits. Preserve router-local limits (four scans, eight TLS inspections, 256 TCP probes), five-second DNS wait and 60-second total scan deadline. TLS timeout includes DNS/connect/handshake. Never detach per-port tasks from their request.
- Keep user-facing authorization messaging.

## Architecture Guidance

- Backend implementation is `backend-rs/src/routers/network_tools.rs`.
- Frontend controls live in `frontend/src/components/UtilitiesHub.tsx`.
- Frontend view request ownership lives in `features/utilities/useNetworkTool.ts`: abort/ignore obsolete responses and dispose deadline timers. Do not advertise HTTP abort as guaranteed server cancellation without a server job/cancel protocol.
- TCP scan resolves the target then connects with bounded concurrency.
- TLS inspect uses rustls roots and x509-parser to return certificate metadata.

## Coding Standards

- Validate before DNS or network activity.
- Keep default scan small (`22,80,443`) and timeout conservative.
- Return structured JSON suitable for the Utility Hub.
- Add tests for new bounds or parser behavior.
- Keep DevTool transforms in the dedicated local runner. Interactive terminal keystrokes have already been forwarded before Enter; interception is not a private local-input mechanism. JSON/SQL display helpers must preserve original data tokens or reject ambiguity.

## Anti-Patterns

- Allowing unbounded ranges or concurrency.
- Shelling out to system tools for scans.
- Removing the authorized-use note.
- Logging full target lists in a way that could expose sensitive infrastructure inventories.

## Example

If adding UDP or banner grabbing, define hard limits first, document the security impact, add backend validation tests, and update the Utility Hub UI with clear progress/error states.
