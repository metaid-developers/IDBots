---
name: metabot-trace-inspector
description: Use when a human or agent needs to inspect the trace of a MetaWeb remote call after execution or refund follow-up
---

# MetaBot Trace Inspector

Inspect the machine trace for a remote MetaBot call, then open the local human page only when richer visual context is needed.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Commands

```bash
{{METABOT_CLI}} trace get --trace-id trace-123
{{METABOT_CLI}} ui open --page trace
```

## Expectations

- Prefer `trace get` for agent workflows and automation.
- Use the local trace page for human review or debugging.
- Keep the trace id as the primary handle across hosts and UI surfaces.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
