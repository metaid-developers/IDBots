# OpenClaw MetaBot Skills Pack

This skills pack is only a bridge to the shared MetaBot CLI/runtime.

It does not own payment, request, delivery, or transport semantics. Those stay in the extracted IDBots runtime and `scripts/metabot-cli.mjs`.

## Boundaries

- Preserve local-first, then remote fallback. The host decides when a local miss has happened.
- Recommendation presentation is a host responsibility. The bridge only exposes remote candidates.
- Requester confirmation must happen before `request-service` is called.
- The provider-side daemon returns `provider_delivery`; this pack does not fabricate delivery payloads.
- Requester reinjection must key on both `request_id` and `requester_session_id`.
- The pending request registry lives at `integrations/openclaw/skills-pack/state/pending-requests.json` unless `OPENCLAW_PENDING_REQUESTS_FILE` overrides it.

## Bridge Commands

- `bin/publish-service.mjs`: thin wrapper over `metabot-cli publish-service`.
- `bin/request-remote-service.mjs --discover`: calls `metabot-cli list-services`, returns remote candidates, then stops for host confirmation.
- `bin/request-remote-service.mjs --submit`: calls `metabot-cli request-service`, persists the pending request metadata, and emits `{ request_write, provider_wakeup }`.

Run `npm run compile:electron` before using the bridge scripts so they can load the compiled runtime adapter.

## Mental Model

The CLI is the capability layer. This pack is just the OpenClaw-facing bridge and operator manual. Keep business logic in the runtime, not in the skill prompts.
