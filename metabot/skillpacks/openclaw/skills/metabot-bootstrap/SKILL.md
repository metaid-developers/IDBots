---
name: metabot-bootstrap
description: Use when a host agent needs to create the first local MetaBot from only a human-provided name and let the validated bootstrap flow finish the rest
---

# MetaBot Bootstrap

Create a local MetaBot with the existing IDBots bootstrap semantics, but expose it through the public `metabot` interface.

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


## Command

```bash
metabot identity create --name "Alice"
metabot doctor
```

## Expected Flow

- Ask the human for one MetaBot name.
- Let identity derivation, subsidy request, and required chain sync follow the validated bootstrap path.
- If the runtime returns `waiting`, poll with the host's normal follow-up behavior.
- If the runtime returns `manual_action_required`, surface the local UI URL instead of improvising steps.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
