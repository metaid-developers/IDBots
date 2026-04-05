---
name: metabot-network-directory
description: Use when an agent or human needs the local yellow-pages view of online MetaBot services before deciding whether to delegate work remotely
---

# MetaBot Network Directory

Open the local MetaWeb yellow pages for humans, or read the online service list directly for agents.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Commands

For machine-first directory reads:

```bash
{{METABOT_CLI}} network services --online
```

For the human-only local page:

```bash
{{METABOT_CLI}} ui open --page hub
```

## Expectations

- Prefer the JSON service list when an agent can continue without UI.
- Use the local HTML page only when a human wants to browse, inspect, or click through.
- Keep the framing as MetaWeb network discovery, not a marketplace.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
