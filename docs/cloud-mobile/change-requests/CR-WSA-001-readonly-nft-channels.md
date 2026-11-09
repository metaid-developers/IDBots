# CR-WSA-001 — Read-only MRC-721 channels move from N to P1

- **Status:** Approved by the owner (2026-11-08); implemented in the same change per the `00` process
- **Date:** 2026-11-08
- **Contracts:** `02-ipc-allowlist-v1.md` invoke channels `idbots:verifyMrc721Listing` and `idbots:listMrc721SellOrders`; allowlist version 1.0.0 → 1.0.1
- **Affected parties:** WS-A (gateway/allowlist), WS-E (mobile client), acceptance
- **Compatibility:** Backward-compatible (tier relaxation N → P1 on two read-only channels; no channel added or removed; no argument or result shape change)

## Current Text

`idbots:verifyMrc721Listing` — tier N, "Read-only pre-buy MRC-721 listing check (indexer/node reads, no funds); tiered with the trade channels."
`idbots:listMrc721SellOrders` — tier N, "MRC-721 sell-order records of the desktop MetaBot NFT wallet (read + per-order re-verify); tiered with the trade channels."

## Problem

Both channels shipped inside the MRC-721 wallet trade slice and were tiered **N** alongside the money-moving channels (`sellMrc721Listing`, `buyMrc721Listing`, the two transfer channels) pending the SMS re-verification design for custodial fund outflow. But both are strictly read-only:

- `verifyMrc721Listing` runs the five-check pre-buy verification (listing shape, sighash, unspent outpoint, price floor, buyer match) over indexer/node reads. No wallet is touched, nothing is broadcast.
- `listMrc721SellOrders` reads locally recorded listings and re-verifies each against chain state (outpoint unspent check). No wallet is touched.

Tiering them with the trade channels means a mobile client cannot even *preview* a purchase — the exact verification step a cautious buyer needs before deciding to pay through any rail. The blanket custodial-outflow rule was never about these reads.

## Proposed Change

1. `idbots:verifyMrc721Listing` → tier **P1** (read-only pre-buy check, no funds).
2. `idbots:listMrc721SellOrders` → tier **P1** (local sell-order records + per-order re-verify, no funds).
3. Allowlist version bumps **1.0.0 → 1.0.1** (minor: tier relaxation only; the default-deny surface is unchanged).
4. The money-moving MRC-721 / MetaContract channels remain **N** until the SMS re-verification design for custodial fund outflow lands (a separate CR with its own design work).

## Migration and Acceptance

No client change is required: the two channels previously answered `CHANNEL_NOT_ALLOWED` over the gateway and now answer normally. Acceptance:

1. Gateway tests confirm both channels are allowed at tier P1 and the four money channels still return `CHANNEL_NOT_ALLOWED` at P1.
2. `02` rows and `src/main/gateway/allowlist.ts` agree row-for-row.
3. The regenerated mobile IPC contract (`src/mobile/generated/ipc-contract.json`) carries `allowlistVersion` 1.0.1 with the two channels at P1.
