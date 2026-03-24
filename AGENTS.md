# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Start Here

Read in this order:

1. This `AGENTS.md`
2. `localdocs/README.md` if it exists locally
3. Relevant docs under `docs/superpowers/` when the task touches the current P2P / release baseline

Keep this file stable. Put fast-changing local context, current baselines, recent pitfalls, and reusable new-session prompts in `localdocs/`.

## Project Overview

**IDBots** is a local-first desktop MetaID / MetaBot platform built with Electron, React, and TypeScript.

The app has two major halves:
- **Main process**: orchestration, local services, wallet / MetaBot persistence, subprocess management, packaging/runtime path logic
- **Renderer**: onboarding, MetaBot management, cowork flows, skills, messaging, scheduled tasks, P2P status/settings UI

As of March 23, 2026, `main` includes the local-first `man-p2p` Alpha baseline used for packaged macOS and Windows releases. The expected healthy peerless UI state is `0 peers` with `p2p-only`, not `Connecting...`.

## Repository Layout

| Path | Role |
| --- | --- |
| `src/main/` | Electron main process entrypoints, IPC, services, SQLite-backed app logic |
| `src/main/services/` | Runtime services such as P2P, MetaID RPC, restore, proxying, orchestration |
| `src/main/im/` | Gateway integrations (Telegram, Discord, Feishu, DingTalk, NIM, etc.) |
| `src/renderer/` | React renderer UI and client-side services |
| `src/renderer/components/` | Main UI surfaces: onboarding, MetaBots, cowork, skills, IM, P2P, updates |
| `resources/man-p2p/` | Bundled `man-p2p` runtime binaries + manifest/config for packaging |
| `scripts/` | Build, packaging, sync, runtime bootstrap, CI helper scripts |
| `tests/` | Node-based tests for main-process services, packaging helpers, and P2P runtime contracts |
| `docs/superpowers/` | Specs, plans, acceptance notes from the recent P2P / alpha integration work |

## Build & Run Commands

```bash
# Install dependencies
npm install

# Main local dev loop
npm run electron:dev

# Compile Electron TypeScript only
npm run compile:electron

# Build renderer + main bundles
npm run build

# Refresh bundled man-p2p binaries from the sibling man-p2p repo/build output
npm run sync:man-p2p

# Package release artifacts
npm run dist:mac
npm run dist:win

# Run the node-based test suite
node --test tests/*.test.mjs
```

## Current Development Workflow

- If the task changes `man-p2p` behavior, make and verify the runtime change in the `man-p2p` repo first.
- After rebuilding the relevant binary, run `npm run sync:man-p2p` here to refresh `resources/man-p2p/`.
- Use `npm run electron:dev` for fast integration iteration.
- Use packaged app builds for alpha acceptance and release validation. Do not treat dev runtime behavior as sufficient release evidence.
- `electron:dev` assumes Vite owns port `5175`. If another repo already has that port open, Electron may load the wrong frontend.

## Important Runtime Rules

- Preserve local-first fallback behavior: local P2P/API hit first, remote/metaid fallback only when local semantics miss.
- Do not regress the P2P truth model:
  - healthy + `peerCount === 0` should render as online peerless state
  - startup failure should render offline with error detail
- Keep packaged runtime paths isolated from dev/runtime temp paths.
- Do not remove checked-in `resources/man-p2p/*` assets unless the packaging strategy is intentionally changed.
- The team preference is `main` as the only long-lived shared branch. Temporary branches should be short-lived and deleted after merge.

## Database Upgrade Safety

- Treat user-directory SQLite databases as persistent upgrade state. Auto-update does not replace or reset them.
- Any database schema change must include a safe, idempotent first-run migration path so upgraded users get required tables, columns, indexes, and defaults before new code depends on them.
- Any change to field meaning, data shape, or storage semantics must include an explicit migration or compatibility strategy for existing user data on first launch after upgrade.
- Do not delete, reset, or casually discard user data. Maintain old-user database continuity across releases unless a deliberate, well-documented migration plan says otherwise.

## Known Useful Files

- `src/main/services/p2pIndexerService.ts` — bundled subprocess lifecycle, health checks, status polling
- `src/main/services/localIndexerProxy.ts` — local-first HTTP/content fallback rules
- `src/main/services/p2pConfigService.ts` — persisted P2P config and runtime derivation
- `src/renderer/components/p2p/P2PStatusBadge.tsx` — sidebar runtime status UI
- `src/renderer/components/p2p/p2pStatusBadgeState.js` — display truth for peerless/online/offline states
- `scripts/sync-man-p2p-binary.mjs` — sync bridge from `man-p2p` into this repo
- `electron-builder.json` — packaging, icons, extraResources, platform settings
- `.github/workflows/build.yml` — release build and artifact publishing flow

## Key Documentation

- `README.md` — product/dev overview
- `docs/superpowers/specs/2026-03-20-p2p-blockchain-sync-design.md`
- `docs/superpowers/specs/2026-03-22-idbots-alpha-acceptance-runbook.md`
- `docs/superpowers/plans/2026-03-20-idbots-p2p-integration.md`
- `docs/superpowers/plans/2026-03-21-idbots-man-p2p-alpha-hardening.md`
