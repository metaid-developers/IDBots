# CR-WSA-003 — Mobile ME capability reads and settings

- **Status:** Proposed; not approved and not active
- **Requested by:** Mobile commercial iteration
- **Contract:** `02-ipc-allowlist-v1.md` 1.0.1
- **Compatibility:** Backward-compatible additions and tier changes only; no payload or transport change. The allowlist minor version should be incremented when approved.

## Current text

The following channels are `N` in the gateway allowlist:

- `me:getPointsSettings`
- `me:setPointsSettings`
- `traffic:getMeBillingStatus`

Mobile therefore cannot render the same auto-deduct preference or authoritative ME-traffic capability state as desktop.

## Proposed text

- Make `me:getPointsSettings` and `me:setPointsSettings` `P1`, with the same identity-signature and single-boolean input restrictions used by desktop.
- Make `traffic:getMeBillingStatus` `P1`, read-only. It returns capability state only and must not enable ME billing or change sponsor behavior.

No `botBrowser:*` or trusted Browser write channel is requested in this CR. The mobile Browser remains read-only for URI resolution and MetaApp rendering; private chat, chain writes, NFT purchases, and other trusted actions stay disabled.

## Reason

The mobile account page needs to explain and, where supported, edit the user's ME deduction preference using the same source of truth as desktop. Mobile also needs to distinguish actual ME-billed traffic from legacy byte-billed traffic instead of claiming unification from a static label.

## Affected parties

- **WS-A:** Register the proposed tiers and add positive/negative gateway tests, including payload redaction and the settings write schema.
- **WS-E:** Render server-confirmed state only; never optimistically enable ME traffic billing.
- **WS-D:** Confirm that the production sponsor and ABS support the same state and setting semantics.

## Migration and rollout

1. Approve this CR and increment the allowlist minor version.
2. Ship the gateway changes with contract fixtures before the mobile UI enables the entries.
3. Keep legacy byte-billed tenants unchanged. Capability discovery must remain read-only and must not opt a tenant into ME billing.
4. Verify a mixed account matrix: unsupported, supported but disabled, and enabled ME traffic billing.
