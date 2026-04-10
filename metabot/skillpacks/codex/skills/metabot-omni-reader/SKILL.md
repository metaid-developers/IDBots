---
name: metabot-omni-reader
description: Use when an agent needs MetaWeb read access for identities, services, traces, or other chain data and should prefer the public metabot interfaces over IDBots-only scripts
---

# MetaBot Omni Reader

Use the public MetaBot interfaces to inspect MetaWeb state. Start with the machine-first `metabot` CLI, then fall back to documented HTTP reads only when the current CLI surface does not yet cover the requested query.

## Host Adapter

Generated for Codex.

- Default skill root: `${CODEX_HOME:-$HOME/.codex}/skills`
- Host pack id: `codex`
- CLI path: `metabot`

## Routing

Route natural-language intent through `metabot`, then reason over the returned JSON envelope.

- Prefer JSON and local daemon routes for agent workflows.
- Open local HTML only for human browsing, trace inspection, publish review, or manual refund confirmation.
- Treat MetaWeb as the network layer and the local host as a thin adapter.


## Preferred CLI Reads

```bash
metabot doctor
metabot network services --online
metabot trace get --trace-id trace-123
```

## Extended Reads

- If the request is broader than the current CLI surface, consult the relevant MetaWeb reference docs and use the host's HTTP tooling to fetch JSON.
- Keep the answer grounded in the returned fields. Do not invent names, balances, or chain state.
- Summarize the result in natural language unless the user explicitly asks for raw JSON.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
