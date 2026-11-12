# CR-WSA-003 — Mobile ME settings and capability-aware traffic billing

- **Status:** Approved by owner on 2026-11-12; implemented in this branch
- **Requested by:** Mobile commercial iteration and the follow-up unified-ME ruling
- **Contract:** `02-ipc-allowlist-v1.md` 1.0.3
- **Compatibility:** Backward-compatible channel additions and capability-gated billing only; no payload or transport change

## Current text before this CR

The following channels are `N` in the gateway allowlist:

- `me:getPointsSettings`
- `me:setPointsSettings`
- `traffic:getMeBillingStatus`

Mobile therefore cannot read or update the ME persistent-deduction preference or read the authoritative ME-traffic capability. Server-mode sponsors are also hard-coded to byte billing even when the backend advertises `me.trafficBilling`.

## Approved text

- Make `me:getPointsSettings` and `me:setPointsSettings` `P1`, with the same identity signature and single-boolean validation used by desktop.
- Make `traffic:getMeBillingStatus` `P1`, read-only. It returns capability and spendable-balance state only; calling it never enables billing or changes sponsor behavior.
- Allow server-mode sponsor writes to request `billing: "me"` only when credits payment is enabled and the backend's address/info response reports `me.trafficBilling: true`.
- Keep the existing byte-billing and self-pay fallbacks when ME traffic billing is unavailable, disabled, or cannot cover a write.

No `botBrowser:*` or trusted Browser write channel is requested. The mobile Browser remains read-only for URI resolution and MetaApp rendering; private chat, chain writes, NFT purchases, and other trusted actions stay disabled.

## Reason

Official LLM and cerebellum usage already uses the ME ledger. The mobile account page needs the same deduction preference and spendable-ME semantics as desktop. Cloud chain writes must also use ME when the sponsor and ABS advertise that capability instead of being forced to remain on byte billing after the owner has unified the product on ME.

## Affected parties

- **WS-A:** Register the new tiers, keep the sponsor fallback, and add positive/negative gateway tests, including payload redaction and the settings write schema.
- **WS-E:** Render server-confirmed state only; never optimistically enable ME traffic billing or equate total ledger balance with spendable balance.
- **WS-D:** Confirm that production sponsor and ABS support the same state and setting semantics before rollout.

## Migration and rollout

1. Increment the allowlist minor version to 1.0.3.
2. Ship gateway and sponsor changes with contract fixtures before enabling the mobile entries.
3. Preserve byte-billed tenants whenever the capability is absent or disabled; capability discovery must not opt an account into ME billing.
4. Verify a mixed account matrix: unsupported, supported but disabled, enabled with spendable ME, and enabled with insufficient ME.
5. This CR supersedes the earlier server-mode byte-only phase boundary; it does not force unsupported accounts onto ME.
