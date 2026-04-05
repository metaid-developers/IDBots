---
name: metabot-call-remote-service
description: Use when a local agent can satisfy a task by discovering a remote MetaBot service, confirming payment, and triggering a MetaWeb agent-to-agent call
---

# MetaBot Call Remote Service

Delegate one task to a remote MetaBot over MetaWeb while preserving the validated order, spend-cap, and trace semantics.

## Host Adapter

{{HOST_SKILLPACK_METADATA}}

## Routing

{{SYSTEM_ROUTING}}

## Command

Prepare a request file:

```json
{
  "request": {
    "servicePinId": "service-pin-id",
    "providerGlobalMetaId": "gm-provider",
    "userTask": "tell me tomorrow's fortune",
    "taskContext": "user asked for tomorrow fortune reading",
    "spendCap": {
      "amount": "0.00005",
      "currency": "SPACE"
    }
  }
}
```

Then call:

```bash
{{METABOT_CLI}} services call --request-file request.json
```

## Confirmation Contract

{{CONFIRMATION_CONTRACT}}

## Result Handling

- `success`: continue with the returned trace id and external conversation linkage.
- `failed`: stop and surface the failure code without pretending the remote task ran.
- `manual_action_required`: hand off to the returned local UI URL and pause automation.

## Compatibility

- CLI path: `{{METABOT_CLI}}`
- Compatibility manifest: `{{COMPATIBILITY_MANIFEST}}`
