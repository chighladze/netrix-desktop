---
name: react-frontend
description: 'Use when: changing Netrix frontend React, TypeScript, Zustand state, Tailwind UI, xterm components, SFTP browser, settings, or network map views.'
---

# React Frontend

## Purpose

Guide frontend work in `frontend/`, a React 18 + TypeScript + Vite + Tailwind desktop UI.

## Rules

- Use `authenticatedFetch` for normal backend HTTP requests.
- Use `getApiBase`, `getWsBase`, and `getApiToken` instead of hard-coded backend details.
- Keep shared state in Zustand; keep purely local interaction state in components.
- Keep preference defaults/validation in `features/settings/settings.ts`. Persist before applying store updates; legacy theme/font actions must use the same snapshot. Highlight rules belong to the SQLite API and must survive appearance resets without being copied into local preferences.
- Do not store credentials in localStorage.
- Preserve the dense desktop operations UI style.
- Preserve the original Netrix artwork in `frontend/public/icon.png`. Improve its size, spacing and presentation without replacing the mark unless the user explicitly requests a new logo.

## Architecture Guidance

- `App.tsx` coordinates windows and view selection.
- `store.ts` owns shared app state and persisted settings.
- `TerminalCanvas.tsx` owns the production terminal WebSocket/xterm flow.
- `SftpBrowser.tsx`, `NetworkMap.tsx`, `UtilitiesHub.tsx`, and settings components own feature views.

## Coding Standards

- Keep TypeScript strict and add explicit interfaces for API payloads.
- Map backend snake_case fields carefully.
- Dispose xterm instances and close sockets on terminal tab cleanup.
- Surface backend `detail` messages in UI errors where possible.

## Anti-Patterns

- Duplicating API token or port discovery logic.
- Adding another global store for app state.
- Swallowing failed optimistic updates without rollback when state would become misleading.
- Putting credential plaintext in logs, localStorage, URL params, or persistent snapshots.

## Example

For a new backend endpoint: add a typed frontend payload/response, call it through `authenticatedFetch`, update Zustand only if multiple components need the state, and validate with `npm run typecheck --prefix frontend` plus `npm run build --prefix frontend`.
