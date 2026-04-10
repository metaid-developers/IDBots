---
name: metabot-network-directory
description: Use when an agent or human needs the local yellow-pages view of online MetaBot services before deciding whether to delegate work remotely
---

# MetaBot Network Directory

Open the local MetaWeb yellow pages for humans, or read the online service list directly for agents.

## Host Adapter

Generated for Claude Code.

- Default skill root: `${CLAUDE_HOME:-$HOME/.claude}/skills`
- Host pack id: `claude-code`
- CLI path: `metabot`

## Routing

Route natural-language intent through `metabot`, then reason over the returned JSON envelope.

- Prefer JSON and local daemon routes for agent workflows.
- Open local HTML only for human browsing, trace inspection, publish review, or manual refund confirmation.
- Treat MetaWeb as the network layer and the local host as a thin adapter.


## Commands

For machine-first directory reads:

```bash
metabot network services --online
```

For the human-only local page:

```bash
metabot ui open --page hub
```

## Expectations

- Prefer the JSON service list when an agent can continue without UI.
- If a service entry includes `providerDaemonBaseUrl`, keep it with the selected service so `metabot-call-remote-service` can execute the real demo round-trip.
- Use the local HTML page only when a human wants to browse, inspect, or click through.
- Keep the framing as MetaWeb network discovery, not a marketplace.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
