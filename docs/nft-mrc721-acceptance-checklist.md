# MRC-721 Acceptance Checklist (device verification)

Owner-facing checklist for verifying the MRC-721 (Agent Goods) line on a real
device. First written 2026-11-05 (feat/nft-p0-tools closeout), extended
2026-11-08 (feat/nft-mrc721-enhance: escrow arbitration entry, invariant
audits, read-only mobile channels).

**Preconditions**

- Verify in **dev mode** (`pnpm run electron:dev`) — the installed release
  (v1.0.10) predates this line and must not be used for acceptance.
- Prepare 2–3 local bots: seller, buyer, and a third bot as the escrow
  guarantor.
- All flows write the real chain; budget ≈ <0.05 SPACE (collection creation is
  the largest single cost).
- Tool calls happen in the bots' CoWork sessions via natural language; cards
  and receipts render in the session messages.

## 1. Search & holdings (read-only, zero cost — verify the MetaSo route first)

- [ ] Collection search by keyword returns the production-indexed test collection with no "not configured" notice.
- [ ] Issuer-scoped search and remaining-supply read (`mintedCount` fast path).
- [ ] Balance/holdings query for an arbitrary MetaID.
- [ ] `mrc721_verify_holding` returns HOLDS / NOT_HOLDING; an unindexed collection reports lookup-failed (never a false NOT_HOLDING).

## 2. Publish skill (`metabot-publish-nft`)

- [ ] Flow A: publish a new collection (issuer-only naming prechecks; a foreign same-name collection is allowed with a shared-name note).
- [ ] Flow B: publish content as an NFT — the skill inventories remaining supply first, mints, emits an `nft-card` with the MINTED badge, and verifies via `mrc721_item_info`.
- [ ] Red line: asking it to mint into someone else's collection must ask for consent first; minting into a collection this bot does not issue is refused with the fee-protection reason.

## 3. NFT avatar

- [ ] Bot settings → avatar offers "Set NFT Avatar"; the picker lists the bot's own MRC-721 items.
- [ ] Selected avatar renders with the rainbow ring in the bot list, edit page, and session header.
- [ ] The blue certified badge appears only when the CA registry lists the item's collection (registry currently empty → no badge is the expected result).

## 4. Sell intent (open declaration rail)

- [ ] Declare: SELLING badge card + pin link; the declaration pin lands on `/protocols/mrc721sell`.
- [ ] List own intents (ACTIVE / cancelled / stale states).
- [ ] Cancel produces a NEW pin with `active:false` (append-only, no modification).
- [ ] Cross-bot discovery: another bot's `mrc721_market_intents` finds the declaration through the MetaSo production index.

## 5. Wallet (desktop NPC wallet, MRC721 tab)

- [ ] Sell flow: price floor enforced at 22000 sats, buyer lock warning shown, listing JSON copyable.
- [ ] Buy flow: pasted listing passes the five-check gate; a corrupted JSON turns red; executing produces a txid.
- [ ] My listings: per-order status valid / invalid / expired with reasons.

## 6. Escrow (three bots)

- [ ] Create order → escrow-card; the seller performs a real `mrc721_transfer` to the guarantor address and records the txid as `escrow_goods` proof.
- [ ] Payment evidence → seller confirm (amount exact to the cent, memo embeds the order id) → guarantor release with double-check → RELEASED.
- [ ] Wrong-role actions are refused by the machine with its own reason.
- [ ] The session list shows the shield trade badge; `escrow_tick` reports timers T1–T4.

## 7. Escrow arbitration (new in feat/nft-mrc721-enhance)

- [ ] The card's 申诉/复核 entry expands on non-terminal cards: appeal rules (≤2 per party, second needs new evidence) + a copyable `escrow_order_act … dispute_open` template embedding the order id.
- [ ] Executing the template from a party session moves the order to DISPUTED with the written reason on the timeline; the card banner switches to 仲裁中.
- [ ] Second appeal inside DISPUTED flags OWNER REVIEW.
- [ ] `escrow_order_info` and `escrow_tick` surface the OWNER REVIEW flag and the owner-level ruling instruction (`owner:` basis prefix).
- [ ] Owner-level re-ruling re-runs `ruling_release`/`ruling_rollback` with basis `owner: …` and is recorded as an owner-level negative record.
- [ ] Invariant audit: if any of the five invariants trip on a live order, the escrow tools surface an audit line (they never block persistence).

## 8. Cards & badges misc

- [ ] `nft-card` action badges render for every emitted action; adjacent NFT cards merge into the horizontal carousel.
- [ ] Detail modal copies the pinId.
- [ ] A SELLING card earns the session the P2P trade badge.

## 9. Mobile (gateway tier)

- [ ] Already P1: `getMetabotNfts`, `resolveAvatarSource`, `getNftCaRegistry`, `healNftCard`.
- [ ] New P1 (CR-WSA-001): `verifyMrc721Listing` and `listMrc721SellOrders` answer over the gateway (a mobile client may call them; a native UI surface is a later round).
- [ ] Money channels still denied: `sellMrc721Listing`, `buyMrc721Listing`, `transferMetabotMrc721`, `transferMetabotMvcNft` return `CHANNEL_NOT_ALLOWED`.

## 10. Expected emptiness (not bugs)

- No certified badge anywhere (CA registry pin starts empty until the first collections are registered).
- Market sell-intent list may be empty (the protocol is newly live).
- `escrow_tick` reports no expiries inside timer windows.
