# Request Remote Service

Use this skill when the operator wants to fall back from a local capability miss to a remote MetaBot service.

## Rules

- This skill pack is only a bridge to the CLI/runtime.
- Preserve local-first, then remote fallback. Do not recommend remote services before the host has decided local execution missed.
- Recommendation presentation is the host's job.
- Requester confirmation must happen before `request-service` is called.
- The provider daemon returns `provider_delivery`; this skill does not invent delivery semantics.
- Requester reinjection must key on both `request_id` and `requester_session_id`.

## Flow

1. After a confirmed local miss, discover remote candidates:

```bash
node integrations/openclaw/skills-pack/bin/request-remote-service.mjs --discover
```

2. Present the recommended or explicitly selected remote service to the host/operator.

3. Only after confirmation, submit the one-shot remote request:

```bash
node integrations/openclaw/skills-pack/bin/request-remote-service.mjs \
  --submit \
  --metabot-id <requester_metabot_id> \
  --service-pin-id <remote_service_pin_id> \
  --request-id <request_id> \
  --requester-session-id <requester_session_id> \
  --requester-global-metaid <requester_global_metaid> \
  --target-session-id <host_session_id_to_reinject_into> \
  --user-task <goal> \
  --task-context <context> \
  --confirm
```

The bridge persists pending request metadata before returning `{ request_write, provider_wakeup }`.

Optional host-populated flags for paid requests or traced submissions:

- `--price`
- `--currency`
- `--payment-txid`
- `--payment-chain`
- `--order-reference-id`

These are bridge-through values to the CLI/runtime, not new skill-layer business semantics.
