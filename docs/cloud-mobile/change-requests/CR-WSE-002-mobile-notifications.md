# CR-WSE-002 — Mobile notification foundation

- **Status:** Approved by the owner through the CM0/CM1 implementation request on 2026-11-20
- **Date:** 2026-11-20
- **Contract:** additive notification IPC and event; allowlist version 1.0.4 → 1.1.0
- **Affected parties:** WS-A (tenant storage, producers, gateway), WS-E (notification center and deep links), acceptance
- **Compatibility:** Backward-compatible additions. Existing cowork, scheduler, permission, and C2 behavior is unchanged. The frozen `01` and `02` documents are not edited by this implementation.

## Current text before this CR

The mobile gateway forwards live cowork, scheduled-task, and permission events only while a socket is connected. It has no persistent notification inbox, unread state, or notification-specific change event. System push and control-plane device delivery are separate CM2 scope.

## Approved change

Add these P1 invoke channels:

- `notification:list`
- `notification:get`
- `notification:getUnreadCount`
- `notification:markRead`
- `notification:markAllRead`

Add the P1 event channel `notification:changed`.

The tenant persists notification rows and a pending delivery outbox with stable event IDs. Initial producers are explicit cowork terminal outcomes, scheduled-run terminal outcomes, and permission requests/resolutions. The outbox carries no external delivery claim in CM1; control-plane device registration and provider adapters remain CM2.

## Reason

A user who assigns work and leaves the phone needs a durable, authoritative place to discover completions, failures, and required decisions. This inbox is the source of truth for later native push and for every notification deep link.

## Migration and acceptance

- Idempotent `CREATE TABLE IF NOT EXISTS` migrations preserve existing user data.
- Duplicate event IDs never create a second inbox row or outbox row.
- Permission resolution marks the corresponding unread notification read without inventing an approval outcome.
- List/get/unread/read APIs and `notification:changed` pass gateway allowlist and contract coverage tests.
- Notification taps resolve through authenticated notification data; no push payload or URL can directly approve an action.
