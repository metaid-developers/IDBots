# CR-WSA-002 — Register the me:* IPC family in `02` (retroactive)

- **Status:** Approved by the owner (2026-11-08); retroactive registration of channels that landed with the S9 ME slices
- **Date:** 2026-11-08
- **Contracts:** `02-ipc-allowlist-v1.md` invoke channels `me:getPlans` … `me:pickVoucher`; allowlist version 1.0.0 → 1.0.1 (minor bump shared with CR-WSA-001)
- **Affected parties:** WS-A (gateway/allowlist), WS-E (mobile client), acceptance
- **Compatibility:** Backward-compatible (registration only for the P1 family; `me:pickVoucher` moves from the implicit default-deny to an explicit N — same gateway decision, exact coverage reporting)

## Current Text

No `me:*` rows exist in `02`. The ME points family landed with the S9 ME slices: `src/main/gateway/allowlist.ts` carries the family at P1, but the contract document was never updated. The generated contract (`src/mobile/generated/ipc-contract.json`) contains `me:getSubscriptionOrders` and `me:pickVoucher`, which therefore resolve to the implicit default deny — and the tier-coverage gate (`02` Tests Required #2 / REQ-A-23) fails.

## Problem

`02` is the contract of record. Channels present in the preload contract without a `02` row are exactly the drift the tier-coverage test exists to catch; the me family slipped past it because the committed contract JSON predated the last preload additions and the full test chain was not re-run before the merge.

## Proposed Change

1. Register the ME points family at P1, exactly as `allowlist.ts` already tiers it: `me:getPlans`, `me:getRates`, `me:getTopupPackages`, `me:getBalance`, `me:getSubscription`, `me:getHistory`, `me:submitTopupOrder`, `me:subscriptionOrder`, `me:getTopupOrders`, `me:getPaymentInfo`, plus `me:getSubscriptionOrders` (added to `allowlist.ts` at P1 by this CR — a read-only orders list that missed registration entirely).
2. `me:pickVoucher` → explicit tier **N**: the mobile voucher path is a photo upload + remark; the native picker dialog is desktop-only. Explicit N keeps the coverage report exact (same deny decision as today).
3. Allowlist version **1.0.0 → 1.0.1** (shared minor bump with CR-WSA-001).

## Migration and Acceptance

No behavior change for the P1 family (already allowed in `allowlist.ts` since the S9 slices). `me:pickVoucher` over the gateway keeps returning `CHANNEL_NOT_ALLOWED` (now explicitly). Acceptance: the tier-coverage test passes; the regenerated contract carries `allowlistVersion` 1.0.1; `02` rows and `allowlist.ts` agree row-for-row.
