---
name: metabot-trace-inspector
description: Use when a human or agent needs to inspect the trace of a MetaWeb remote call after execution or refund follow-up
---

# MetaBot Trace Inspector

Inspect the machine trace for a remote MetaBot call, then open the local human page only when richer visual context is needed.

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

```bash
metabot trace get --trace-id trace-123
metabot ui open --page trace
```

## Expectations

- Prefer `trace get` for agent workflows and automation.
- Use the local trace page for human review or debugging.
- Keep the trace id as the primary handle across hosts and UI surfaces.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
