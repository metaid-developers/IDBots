---
name: metabot-post-skillservice
description: Use when a local MetaBot should publish one paid capability to MetaWeb so other MetaBots can discover and call it
---

# MetaBot Publish Service

Publish a local capability as a MetaWeb service while preserving the current provider identity, price, and availability semantics already validated in IDBots.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Command

Prepare a publish payload file:

```json
{
  "serviceName": "tarot-reading-service",
  "displayName": "Tarot Reading",
  "description": "One-shot tarot reading over MetaWeb.",
  "providerSkill": "metabot-tarot-reading",
  "price": "0.00005",
  "currency": "SPACE",
  "outputType": "text",
  "serviceIconUri": "metafile://pinid"
}
```

Then call:

```bash
{{METABOT_CLI}} services publish --payload-file payload.json
```

## Required Semantics

- Preserve the provider `globalMetaId` as the on-chain service identity.
- Preserve price and currency as explicit payload fields.
- Preserve the current available vs revoked lifecycle instead of inventing marketplace-only states.
- If an icon or skill document must be stored on-chain first, publish that asset before calling this skill.

## Result Handling

- `success`: keep the returned service pin id and present it as the discovery handle.
- `failed`: stop and surface the exact failure code.
- `manual_action_required`: surface the local UI URL and wait.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
