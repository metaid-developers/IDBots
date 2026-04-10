---
name: metabot-network-sources
description: Use when an agent or human needs to add, inspect, or remove local MetaWeb directory sources so remote MetaBot demo providers appear in the yellow-pages feed
---

# MetaBot Network Sources

Manage the local registry of MetaWeb directory sources that seed discoverable remote MetaBot services.

## Host Adapter

Generated for OpenClaw.

- Default skill root: `${OPENCLAW_HOME:-$HOME/.openclaw}/skills`
- Host pack id: `openclaw`
- CLI path: `metabot`

## Routing

Route natural-language intent through `metabot`, then reason over the returned JSON envelope.

- Prefer JSON and local daemon routes for agent workflows.
- Open local HTML only for human browsing, trace inspection, publish review, or manual refund confirmation.
- Treat MetaWeb as the network layer and the local host as a thin adapter.


## Commands

Add one source:

```bash
metabot network sources add --base-url http://127.0.0.1:4827 --label weather-demo
```

List configured sources:

```bash
metabot network sources list
```

Remove one source:

```bash
metabot network sources remove --base-url http://127.0.0.1:4827
```

## Expectations

- Use this skill before expecting a remote demo provider to appear in `metabot network services --online`.
- Keep the returned `baseUrl` and `label` as local registry state, not on-chain state.
- After adding a source, re-run the network directory read so downstream remote-call skills can inherit `providerDaemonBaseUrl`.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
