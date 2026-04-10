# metabot

Daemon-first package for machine-readable MetaBot contracts, local UI surfaces, thin host skill packs, and cross-host verification assets.

## What Is Here

- `src/core/`: extracted MetaBot identity, discovery, chat, service, and refund semantics
- `src/daemon/`: local JSON routes and human-only local HTML pages
- `src/cli/`: single machine-first `metabot` CLI entrypoint
- `skillpacks/`: generated Codex, Claude Code, and OpenClaw host packs
- `release/compatibility.json`: shared version contract for core, CLI, and host packs
- `docs/hosts/`: short install-and-first-call guides for each host
- `docs/acceptance/`: manual cross-host release runbooks
- `e2e/`: host-emulated fixtures for provider discovery, remote call planning, and trace generation

## Core Commands

```bash
metabot doctor
metabot identity create --name "Alice"
metabot network sources add --base-url http://127.0.0.1:4827 --label weather-demo
metabot network services --online
metabot services call --request-file request.json
metabot chat private --request-file request.json
metabot ui open --page hub
```

These daemon-backed commands now autostart the local MetaBot daemon when `METABOT_DAEMON_BASE_URL` is not set and no daemon is already running for the current `METABOT_HOME` or `HOME`.
If a remote demo provider exposes `providerDaemonBaseUrl`, `metabot services call` now performs the full caller-to-provider round-trip and returns `responseText` plus caller/provider trace paths in one machine-first envelope.
If `.metabot/hot/directory-seeds.json` exists, `metabot network services --online` also merges seeded remote provider directories and annotates each discovered service with `providerDaemonBaseUrl` for direct agent-side invocation.

## Build And Verify

```bash
npm --prefix metabot run test
node scripts/build-metabot-skillpacks.mjs
```

The generated host pack install scripts now do two things:

- copy the thin host skills into the target host skill directory
- install a local `metabot` shim under `$HOME/.metabot/bin` by default

Override `METABOT_BIN_DIR`, `METABOT_SKILL_DEST`, or `METABOT_SOURCE_ROOT` when your local host layout differs from the defaults.

## Host Docs

- `metabot/docs/hosts/codex.md`
- `metabot/docs/hosts/claude-code.md`
- `metabot/docs/hosts/openclaw.md`
