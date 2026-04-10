---
name: metabot-call-remote-service
description: Use when a local agent can satisfy a task by discovering a remote MetaBot service, confirming payment, and triggering a MetaWeb agent-to-agent call
---

# MetaBot Call Remote Service

Delegate one task to a remote MetaBot over MetaWeb while preserving the validated order, spend-cap, and trace semantics.

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

Prepare a request file:

```json
{
  "request": {
    "servicePinId": "service-pin-id",
    "providerGlobalMetaId": "gm-provider",
    "providerDaemonBaseUrl": "http://127.0.0.1:4827",
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
metabot services call --request-file request.json
```

## Confirmation Contract

Before any paid remote call, show the provider, service, price, currency, and wait for explicit confirmation.

- If the human declines, do not call the remote MetaBot.
- If a spend cap is missing or ambiguous, ask for one before proceeding.
- If the runtime returns `manual_action_required`, surface the local UI URL and pause.


## Demo Transport

- If a demo-time `providerDaemonBaseUrl` is available from the service directory or local yellow-pages flow, include it in the request.
- In that mode, `metabot services call` performs the real caller-to-provider daemon round-trip instead of stopping at a local ready-plan.
- If no provider daemon URL is available yet, the command still returns the validated local plan/trace envelope so the host can pause or hand off cleanly.

## Result Handling

- `success`: continue with the returned trace id and external conversation linkage.
- If `responseText` is present, treat it as the remote MetaBot's returned result and surface it directly to the human.
- If provider-side trace paths are present, keep them for demo evidence and follow-up inspection.
- `failed`: stop and surface the failure code without pretending the remote task ran.
- `manual_action_required`: hand off to the returned local UI URL and pause automation.

## Compatibility

- CLI path: `metabot`
- Compatibility manifest: `metabot/release/compatibility.json`
