# CR-WSE-004 — Device registration and push delivery

- **Status:** Approved by the owner through the CM2 implementation request on 2026-11-20
- **Contract:** additive C3 device/preference routes and a tenant-authenticated notification ingest; no frozen contract document is edited
- **Affected parties:** WS-A, WS-B, WS-E, native shell, acceptance
- **Compatibility:** backward-compatible additions; no existing login, gateway, notification-inbox, or task behavior is removed

## Change

Add `POST /api/v1/devices/register`, `POST /api/v1/devices/unregister`, and `GET/PUT /api/v1/notification-preferences`, all protected by the existing session cookie and Origin policy. Registration identifies an installation without treating its random identifier as a credential. The provider token is encrypted at rest and never returned by these routes.

Add `POST /internal/v1/tenants/:tenantId/notifications`. The tenant authenticates with its existing gateway bearer secret and `X-Tenant-Id`; the route resolves the user from that tenant, never from caller-provided identity. The event carries only a stable event ID, category/type, safe display text, and priority. A push opens the authoritative notification ID and cannot approve an action.

Persist one `(eventId, deviceId)` delivery row per selected device. Delivery is at-least-once, with durable attempts, retry time, claim recovery, provider message ID, and sanitized error class. Provider-disabled is a distinct outcome, not a successful send. FCM is the reference provider; fake is for automated tests only. Chinese OEM, APNs, production-provider, and physical-device acceptance remain separate launch gates.

## Tenant semantics

The tenant stores the inbox event before external delivery. Only server mode runs the outbox worker. Read/resolved events are not claimed; transient control-plane failures retry with persisted exponential backoff. Provider outcomes never affect Agent execution or notification persistence. Logout revokes only the current installation.
