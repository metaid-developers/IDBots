# MRC-721 Open Market — Passive Offer Protocol (SIGHASH_SINGLE Offer Pin)

Status: **v2 of this design — owner decision 2026-11-08: build the PASSIVE
offer line (M2) directly.** Companion to `docs/nft-sell-protocol-draft.md`
(sell-intent protocol v2, APPROVED — unchanged by this design).

## 1. Goal

An MRC-721 NFT is tradeable for native MVC SPACE **atomically, openly, and
passively**: the seller signs ONE offer object, publishes it on-chain, and
may go offline. Any buyer anywhere completes the sale with no seller
cooperation, no counterparty risk, and no covenant contract. Directed
(private-chat) trading and the existing directed swap stay available.

## 2. Owner's mechanism (2026-11-08, adopted verbatim)

The seller signs the item input with `SIGHASH_SINGLE | FORKID |
ANYONECANPAY` over a transaction whose output0 IS the price output. By
SIGHASH_SINGLE semantics the signature commits exactly `{item outpoint,
output0}` — the price is cryptographically locked, and the seller has
committed to NOTHING else. The raw signed transaction is then wrapped in a
pin and published on-chain, so the indexer indexes it and any buyer can see
it, complete it, and broadcast it.

No covenant is needed anywhere. The earlier "true open taking requires a
covenant contract (v2)" note in `docs/nft-sell-protocol-draft.md` is
retracted (corrections in §8): it assumed passive taking AND the
delivery-output-pinned-to-output0 indexer convention as fixed premises. The
second premise is a convention, not math.

## 3. The offer tx (seller side, offline)

```
inputs[0]  = the item UTXO (current outpoint from mrc721_item_info)
outputs[0] = P2PKH(priceSats → seller address)        ← paired with input 0
```

- Signed with `SIGHASH_SINGLE | FORKID | ANYONECANPAY` (constant
  `MRC721_OPEN_OFFER_SIGHASH`, computed from `mvc.crypto.Signature`
  constants — measured, never guessed; the byte is 195
  (SINGLE=0x03 | FORKID=0x40 | ACP=0x80), pinned in
  tests).
- The offer tx contains EXACTLY one input and one output. Everything else
  (buyer funding, delivery output, change) is appended by the buyer and is
  not covered by — nor able to invalidate — the seller signature.
- Price floor 22000 sats enforced at build time (same floor as the directed
  swap).
- If the seller later spends the item UTXO in any other way, the offer dies
  automatically: the take-time check finds input0 spent and refuses. Safety
  does not depend on a cancel pin; cancel pins exist only so the indexer can
  stop advertising.

## 4. The offer pin (the on-chain order book entry)

- Path: `/protocols/mrc721offer` (fixed unofficial path, sibling of the v2
  sell intent; NOT under /nft/* so it can never mint ghost items).
- Payload (JSON, create-only, append-only, latest-pin-wins per itemPinId —
  same semantics as the v2 sell intent):
  ```json
  {
    "itemPinId": "<64hex>i<vout>",
    "priceSats": 22000,
    "offerTx": "<base64(TxComposer.serialize())>",
    "active": true
  }
  ```
- No protocol/version fields (the pin seven-tuple carries them), no contact
  fields (the pin creator is the seller identity).
- `priceSats` is advisory/mirror — the authority is output0 inside offerTx.
  `active:false` pins are cancellation declarations; a stale offer whose
  item UTXO moved is dead regardless.
- Publishing reuses the standard createPin flow (wallet, chain-write budget,
  receipt card).

## 5. The take (buyer side, no seller online)

```
inputs[0]  = the item UTXO, carrying the seller's SINGLE|ACP signature
inputs[1..]= buyer SPACE UTXOs                       — signed ALL|FORKID
outputs[0] = P2PKH(priceSats → seller)               ← verbatim from the offer
outputs[1] = P2PKH(itemValue → buyer address)        ← the DELIVERY output
outputs[2+]= buyer change (optional)
```

Buyer-side verification gates (all offline, before signing anything):

1. Offer pin is the latest active offer for the item and its offerTx
   deserializes (TxComposer).
2. `inputs[0]` spends the item's CURRENT outpoint (cross-checked against
   `mrc721_item_info`) and the input still shows unspent at take time.
3. `outputs[0]` pays exactly the advertised price to exactly the item's
   current owner address; price ≥ 22000 floor.
4. The input0 signature type is `SINGLE|FORKID|ANYONECANPAY` and the seller
   signature verifies under the script interpreter against the declared
   prevout (tamper with output0, the outpoint, or the sig type → verify
   fails).
5. Funding: a single buyer UTXO covers price + normal fee with the same 3x
   fee-multiplier ceiling as the directed swap (no change output in the v1
   take; change outputs are permitted by the math and can be enabled later).

Then the buyer appends outputs[1] (delivery, itemValue to buyer), their
funding input, signs their input, and broadcasts. First-come-first-served:
two concurrent takes double-spend race; the winner confirms, the loser's
funding UTXO was never spent. A stale offer (item moved) refuses at gate 2 —
the buyer loses nothing.

Why the price cannot be cheated: it IS output0, inside the SINGLE digest.
Why the seller cannot be cheated: they signed nothing but the price output
and the item outpoint; whatever the buyer appends cannot touch them. Why the
buyer cannot be cheated: the delivery output is built by the buyer.

## 6. Deliberate layout consequence — indexer requirement

In the directed swap the indexer reads the new owner from output0 (delivery
at index 0, price at index 1). The passive-offer settlement tx mirrors that
layout: **output0 = the signed price payment, output1 = the delivery
output**. This is the ONE indexer-facing change this design needs (backend
requirement: `docs/nft-offer-indexer-requirements.md`, task for the MetaSo
backend):

> When a tx spends an MRC-721 item UTXO at input0 and output0 is NOT a
> valid delivery output for that item, the indexer must read the new owner
> from output1 (the delivery output carries exactly input0's satoshis).

Until the backend ships the offer ingest + endpoints, the core loop still
works: the offer pin is an ordinary pin, so a buyer who holds its pinId can
fetch the payload through the raw pin-read routes and take it (chat-shared
offer cards). The endpoints exist for market browsing/order-book UX.

## 7. Scope

- **M2a (client, no backend dependency for the core loop)**: offer tx
  primitives (`mrc721OpenOfferTx.ts`), offer publish/list/cancel service +
  `mrc721_offer` / `mrc721_offers` / `mrc721_take_offer` tools, take flow
  with the five gates, nft-card `listed` emission, tests (offline TxComposer
  round-trips).
- **M2b (backend, MetaSo team)**: offer-pin ingest + `GET
  /api/mrc721/offers|offer/info` endpoints + the output1 delivery rule
  (requirement doc handed off).
- **M2c (market UX)**: market browsing of offers via the endpoints, wallet
  market tab, buy-with-one-click flows on top of M2a primitives.
- **M1 interactive countersign flow**: DEMOTED to fallback — only relevant
  if the indexer layout change is declined. The design stays in git history
  (this doc's v1).

## 8. Corrections to land in `docs/nft-sell-protocol-draft.md` with this line

1. Retract "SIGHASH_SINGLE leaves the price output unprotected" as a general
   claim: it is layout-specific. With output0 = the price output (this
   design), SINGLE protects exactly the price; with output0 = the delivery
   output (directed layout), it protects exactly the delivery. The directed
   flow's rejection of SINGLE remains correct FOR ITS LAYOUT.
2. Retract "true open taking requires a covenant contract (v2)": passive
   open taking needs only the indexer layout rule (§6); no covenant.
3. Settlement rails line becomes: directed atomic swap (seller-built,
   private chat) / **passive open offer (SINGLE offer pin, this design)** /
   guarantor escrow (any currency).
