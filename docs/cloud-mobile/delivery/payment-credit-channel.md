# Delivery Note — Payment Credit Channel (feat/payment-credit-channel)

**Status:** implemented and unit-tested on this branch; real Alipay payment NOT RUN here (the ¥99.90 incident is what motivated this channel — operator-recorded credit closes the "收款到账但额度未核销" gap at the bookkeeping level while upstream order confirmation is being fixed separately).

**Single commit on `feat/payment-credit-channel`** (base `4e419f76`); not merged to main. Run `git log --oneline feat/payment-credit-channel -1` for the exact hash.

## Scope and Architecture

The credit channel closes the operator loop without touching the frozen C2/C3 contracts and without inventing any new credential or channel:

```
user pays (C4 bundle order / page recharge)
  └─ upstream Metaso webhook credits the traffic account + LLM quota   ← upstream, has the truth
  └─ client records a local order voucher at create time and stamps the
     first paid/credited observation exactly once                       ← this branch (client)
  └─ operator/automation records one ledger row per paid order with
     reference_key = the upstream orderId                               ← this branch (control plane)
  └─ byte-level application to the tenant traffic account goes through the
     tenant image's admin grant channel                                  ← tenant image (separate repo, existing)
```

Deliberate non-choice: **the client never calls the control-plane admin surface.** The bearer token (`CP_ADMIN_API_TOKEN`) is an operator secret; shipping it to clients would turn the credit surface into a user-gated surface. The trigger therefore runs where the token lives.

## Control Plane

### Interface paths

- `POST /api/v1/admin/credit`
- `GET  /api/v1/admin/credit?userId={id}&limit={n}` (n positive integer, capped at 200; default 50)
- CLI: `credit grant --user <id> --bytes <int> --reason <text> [--reference <key>] --as <name>` / `credit list [--user <id>]`
- Third-party function surface: `services/bundleOrderCredit.ts → recordBundleOrderCredit(app, {userId, order}, operator)` — the payment-success trigger seam that maps a paid C4 order to one ledger row.

### Request/response shape

`POST /api/v1/admin/credit` body: `{ userId: string, bytes: int > 0, reason: string, source?: 'manual' | 'bundle-order', operator?: string, referenceKey?: string }`.

Response 201 (fresh grant) / 200 (same `referenceKey` resubmitted = duplicate):

```json
{ "creditId": 1, "userId": "…", "bytes": 104857600, "source": "bundle-order",
  "reason": "bundle order bo_x paid 19.90 CNY (plan bundle_basic_cny, 104857600 bytes)",
  "actor": "admin:http", "referenceKey": "bo_x", "createdAt": 1761…, "duplicate": false }
```

Error shapes: 400 `INVALID_BODY` / `INVALID_BYTES` / `MISSING_REASON` / `INVALID_QUERY`, 403 `FORBIDDEN_ACTOR` (credit grants are operator actions; actor must not be a user session), 404 `USER_NOT_FOUND` and route-level 404, 409 `USER_DISABLED`. CREATE returns 201; a duplicate resubmission returns 200 with the existing `creditId`.

### Authentication

`Bearer` token against `CP_ADMIN_API_TOKEN`, checked in the handler (`requireAdminToken`), NOT through the session middleware — the routes are declared `auth: false` on purpose so a user session can never reach them. Token unset/empty → every route answers 404 (surface indistinguishable from nonexistent; the CLI remains the operator path). Token set + missing/wrong bearer → 401 `ADMIN_UNAUTHORIZED`. Never write the token into git; it is deployment env only.

### Audit fields

One `credit_ledger` row (migration 3) per grant: `user_id`, `bytes_total` (INTEGER, CHECK > 0 — bytes, never floats), `source` (`manual` | `bundle-order`), `reason`, `actor`, `reference_key` (UNIQUE — the idempotency key; carries the upstream C4 orderId for bundle orders), `created_at` (unix ms). Plus one paired `audit_log` row (`action='credit.grant'`, `actor='admin:<operator>'`, `target=<userId>`, detail JSON with creditId/bytes/source/reason/referenceKey) — same convention the CLI (`--as` enforced at the operator gate) and other mutating surfaces use.

### Exactly-once trigger (`recordBundleOrderCredit`)

Maps one paid order → `grantCredit(source='bundle-order', reason="bundle order <orderId> paid <amount> <currency> (plan <planId>, <bytes> bytes)", referenceKey=<orderId>)`. A paid order without its upstream orderId is refused with 400 `MISSING_ORDER_ID` (no idempotency key means a replayed notification could double-credit — refuse rather than guess). The trigger is replay-safe by construction: creditService checks `reference_key` before insert and resolves the UNIQUE race inside the transaction. Tests: `cloud/control-plane/test/bundle-order-credit.test.ts` (paid observation → exactly one row + one audit row; replay → `duplicate:true`, ledger unchanged; different orderId → second row; missing orderId → 400, nothing written).

### Client voucher (local order record, REQ-B/A-24 adjacent)

`src/main/services/bundleService.ts`: every successful `createBundleOrder` (stub and real path) persists a `BundleOrderVoucher` under the local SqliteStore KV key `bundle.orderVouchers` — `{ orderId (verbatim upstream id), planId, payAmount, payCurrency, trafficBytes, llmQuota, gateway, createdAt }`. The first status poll that observes PAID/CREDITED stamps `paidAt`/`creditedAt` exactly once (`markVoucherPaid`); later observations are no-ops. Read surface: `getBundleOrderVoucher(orderId)`. Voucher absence never fails a live payment (store-configured instance with no voucher = order created before this build).

## Rollback

Everything here is additive; there is no schema rewrite of C2/C3 tables.

- **Code rollback:** `git revert` the branch commit on a server branch — all routes, CLI verbs, voucher logic, and the trigger seam disappear.
- **Schema:** migrations are forward-only (`runMigrations` skips applied versions; no downgrade runner). Rolling back the code on a DB that already applied migration 3 leaves `credit_ledger` in place — harmless and inert (no code writes it). Full removal, if ever needed:
  1. `DROP TABLE credit_ledger;`
  2. `DELETE FROM schema_migrations WHERE version = 3;`
  then the old build starts clean. Do this only inside a maintenance window with a DB backup first.
- **Ledger correction:** rows are append-only audit records. A wrong grant is corrected with a compensating negative… never — `bytes_total` CHECK requires > 0; a mis-grant is fixed by a counter-grant row with `reason` explaining the correction, preserving the audit trail.

## Verification

- `cloud/control-plane`: full suite + lint + build — see the run output pasted in the work journal (AC-1/AC-2 tests by the sibling instance; `bundle-order-credit.test.ts` from this slice).
- Client: `npm run compile:electron && node --test tests/bundleService.test.mjs` — voucher tests added (create persists voucher; first-poll credit stamps once; repeated polls stay stamped-once; real-mode create persists the upstream orderId; uncertain create writes nothing).

## NOT RUN / Not Accepted Here

- A real Alipay wallet payment end-to-end (AC of 硬门二 belongs to #7, not this slice); what IS verified is the exactly-once bookkeeping behind it.
- The tenant-image grant channel call (`POST /v1/admin/traffic/accounts/{accountId}/grants`) — separate repo; the ledger row carries the operator's cross-reference in `reason`/`reference_key`.
- The `CP_ADMIN_API_TOKEN` itself is not provided, rotated, or deployed in this slice (deployment env, owner action).
