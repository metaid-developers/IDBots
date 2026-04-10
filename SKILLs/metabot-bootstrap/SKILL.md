---
name: metabot-bootstrap
description: Use when a host agent needs to create the first local MetaBot from only a human-provided name and let the validated bootstrap flow finish the rest
---

# MetaBot Bootstrap

Create a local MetaBot with the existing IDBots bootstrap semantics, but expose it through the public `metabot` interface.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Command

```bash
{{METABOT_CLI}} identity create --name "Alice"
{{METABOT_CLI}} doctor
```

## Expected Flow

- Ask the human for one MetaBot name.
- Let identity derivation, subsidy request, and required chain sync follow the validated bootstrap path.
- If the runtime returns `waiting`, poll with the host's normal follow-up behavior.
- If the runtime returns `manual_action_required`, surface the local UI URL instead of improvising steps.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
