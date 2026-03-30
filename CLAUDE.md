# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

IDBots is a local-first desktop platform for on-chain AI agents ("MetaBots") built on the MetaID protocol. It pairs an Electron 40 + React 18 desktop app with an embedded `man-p2p` P2P data-sync runtime.

## Commands

```bash
# Install (runs patch-package, electron-builder install-app-deps, SKILLs/web-search deps)
npm install

# Development (compiles Electron TS, builds skills, starts Vite on port 5175 + Electron)
npm run electron:dev

# Compile only the Electron main-process TypeScript
npm run compile:electron

# Build renderer + main bundles
npm run build

# Lint (must pass before any commit)
npm run lint

# Run all node-based tests
node --test tests/*.test.mjs

# Run a single test file (compile first if testing main-process code)
npm run compile:electron && node --test tests/<file>.test.mjs

# Grouped test suites
npm run test:memory    # memory-scoped CRUD, migration, prompt blocks
npm run test:wallet    # wallet service
npm run test:im-gateway # IM gateway connectivity

# Refresh bundled man-p2p binaries from sibling repo
npm run sync:man-p2p

# Package release artifacts
npm run dist:mac
npm run dist:win
```

## Architecture

### Process Model

Strict Electron IPC boundary — Node integration is disabled in the renderer.

- **Main process** (`src/main/`): orchestration, IPC handlers, SQLite persistence, subprocess management, wallet/MetaBot logic, IM gateways, runtime path resolution.
  - `main.ts` — app entrypoint, IPC handler registration (large file, ~226 KB).
  - `preload.ts` — contextBridge API exposed to renderer.
  - `coworkStore.ts` — cowork (chat/agent session) persistence and orchestration.
  - `sqliteStore.ts` — SQLite schema, migrations, all direct DB access.
  - `metabotStore.ts` — MetaBot CRUD and lifecycle.
  - `skillManager.ts` — skill loading, registration, execution bridge.
  - `serviceOrderStore.ts` — Gig Square service-order persistence.
  - `scheduledTaskStore.ts` — cron/scheduled task persistence.
  - `memory/` — scoped agent memory (per-bot, per-chat context recall).
  - `services/` — runtime services: P2P lifecycle, MetaID RPC, wallet, indexer proxy, cognitive orchestration, Gig Square, payment/settlement.
  - `im/` — IM gateway integrations (Telegram, Discord, Feishu, DingTalk, NIM, Xiaomifeng).
  - `libs/` — lower-level utilities: cowork runner/sandbox, Claude SDK bridge, runtime paths, wallet TX workers, app updater.

- **Renderer** (`src/renderer/`): React UI, client-side services, Redux state.
  - `App.tsx` — root component, routing, layout.
  - `components/` — UI surfaces: onboarding, MetaBots, cowork, skills, Gig Square, IM, P2P status, settings, scheduled tasks, update.
  - `services/` — API calls, LLM connection, encryption, i18n, MCP, theme, shortcuts.
  - `store/slices/` — Redux slices: cowork, IM, MCP, model, quickAction, scheduledTask, skill.
  - Path alias: `@/` → `src/renderer/` (configured in both Vite and tsconfig).

### Compilation

Two separate TypeScript configs:
- `tsconfig.json` — renderer (ESNext modules, bundler resolution, `noEmit`, includes `src/renderer`).
- `electron-tsconfig.json` — main process (CommonJS, node resolution, emits to `dist-electron/`, includes `src/main`).

### Skills System

`SKILLs/` contains bundled skill packages. Each skill is a self-contained directory with its own manifest. Skills are compiled via `npm run build:skills`. The registry is `SKILLs/skills.config.json`.

### Data Layer

- SQLite via `sql.js` (in-process, no native bindings). All schema and migrations live in `sqliteStore.ts`.
- Key tables: `metabots`, `metabot_wallets` (append-only, encrypted mnemonics), `llm_configs`, `cowork_sessions`, `cowork_messages`.
- Database schema changes require safe, idempotent migration paths — user databases persist across auto-updates.

### P2P Runtime

The `man-p2p` binary runs as a managed subprocess. Key services:
- `p2pIndexerService.ts` — subprocess lifecycle, health checks, status polling.
- `p2pConfigService.ts` — persisted P2P config.
- `localIndexerProxy.ts` — local-first HTTP/content fallback (local P2P first, remote MetaID fallback only when local misses).

## Key Rules

- **IPC boundary**: never bypass IPC. All renderer↔main communication goes through `preload.ts` contextBridge.
- **Local-first**: local P2P/API hit first, remote/MetaID fallback only when local semantics miss.
- **P2P truth model**: healthy + `peerCount === 0` → online peerless state (not "Connecting..."); startup failure → offline with error detail.
- **DB safety**: never delete/reset user data. Schema changes need idempotent first-run migrations. Treat user SQLite as persistent upgrade state.
- **i18n**: all user-facing strings must be internationalized (EN + ZH) via `src/renderer/services/i18n.ts`.
- **Theme**: use CSS variables (`var(--bg-main)`, `var(--bg-panel)`, `var(--text-primary)`, `var(--color-primary)`). Do not hardcode `dark:` Tailwind utilities.
- **Code comments**: English only.
- **Code style**: functional React with hooks, 2-space indent, single quotes, semicolons, strong TypeScript typing. Keep business logic in `services/` or Redux slices, not in UI components.
- **Commits**: `<type>: <short description>` where type is `feat`, `fix`, `refactor`, `docs`, or `chore`. Run `npm run lint` before committing.
- **Pre-commit verification**: before claiming work is done, always run: (1) `npm run compile:electron` — 0 errors, (2) `npm run build:skills` — 0 errors, (3) `npm run lint` — 0 errors/warnings, (4) `node --test tests/*.test.mjs` — all pass.
- **Worktree gotchas**: git worktrees have no `node_modules`. Before running `electron:dev` or `build:skills` in a worktree: (1) symlink node_modules from the main repo: `ln -s /path/to/main/repo/node_modules node_modules` (required for sql.js wasm, electron, and all runtime deps), (2) run `npm install --prefix SKILLs/web-search` for web-search skill dependencies, (3) `compile:electron` uses `npx -p typescript@5 tsc` to pin TS 5.x — do NOT use bare `tsc` or unpinned `npx -p typescript tsc` which may pull TS 6.x with breaking deprecation rules, (4) `tests/` is in `.gitignore` — use `git add -f tests/` to stage test files.
- **Branching**: `main` is the only long-lived branch. Merge with `--no-ff`. Delete branches after merge.
- **Dev port**: Vite dev server uses port 5175. If another process holds that port, Electron loads the wrong frontend.
- **Release validation**: always test with packaged builds, not just `electron:dev`.

## Additional Context

- `AGENTS.md` — extended repo guidance with known useful files and runtime rules.
- `localdocs/` — local-only working notes (disposable, not committed).
- `docs/superpowers/` — specs and plans from P2P/alpha integration work.
