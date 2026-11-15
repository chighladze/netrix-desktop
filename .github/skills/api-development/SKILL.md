---
name: api-development
description: 'Use when: adding or changing Netrix HTTP APIs, WebSocket APIs, DTOs, request validation, API errors, frontend API calls, or route documentation.'
---

# API Development

## Purpose

Guide changes to Netrix API contracts between frontend and backend.

## Rules

- Keep APIs token-authenticated.
- Use existing route domains and naming style.
- Use `AppError` for consistent status and `detail` JSON responses.
- Keep credential plaintext out of response DTOs.
- Update `docs/API_STRUCTURE.md` for route or payload changes.

## Architecture Guidance

- HTTP routes are mounted from `backend-rs/src/routers/*.rs`.
- WebSocket routes live in `routers/sessions.rs`.
- Frontend uses `frontend/src/api.ts` helpers and feature-local calls.
- Backend DTOs live in `models.rs`.

## Coding Standards

- Validate at the backend boundary.
- Keep query params bounded and documented.
- Use 201 for creates and 204 for empty deletes where practical.
- Preserve `__JSON__` control message convention for terminal WebSockets.

## Anti-Patterns

- Adding unauthenticated localhost endpoints.
- Returning raw SQL errors to the frontend.
- Adding frontend fetch calls without token headers.
- Encoding secrets into URLs. Quick-connect uses authenticated one-time tickets; preserve that boundary.

## Example

For a new SFTP action, add a backend route under `/sftp/hosts/{host_id}/...`, load vault credentials through existing helpers, update `SftpBrowser`, document the route, and add tests for auth, non-SSH hosts, and bounds.
