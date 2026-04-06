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
metabot network services --online
metabot services call --request-file request.json
metabot ui open --page hub
```

## Build And Verify

```bash
npm --prefix metabot run test
node scripts/build-metabot-skillpacks.mjs
```

## Host Docs

- `metabot/docs/hosts/codex.md`
- `metabot/docs/hosts/claude-code.md`
- `metabot/docs/hosts/openclaw.md`
