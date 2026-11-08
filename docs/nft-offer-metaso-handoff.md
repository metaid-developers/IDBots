# Handoff Brief — MRC-721 Offer Index (R-E) for the MetaSo Backend

From: IDBots host team (feat/nft-open-market). Date: 2026-11-08.
Authority docs: `docs/nft-offer-protocol.md` (frozen protocol, owner-approved),
`docs/nft-offer-indexer-requirements.md` (R-E full requirements),
`docs/nft-open-market-psbt-settlement.md` (design + security analysis).

## TL;DR

IDBots froze a new pin protocol, `/protocols/mrc721offer` — the PASSIVE open
listing for MRC-721 NFTs: the seller signs ONE transaction (item input signed
`SIGHASH_SINGLE|FORKID|ANYONECANPAY`, output0 = the price payment — the
seller's only commitment) and wraps the signed raw tx in this pin. Any buyer
completes and broadcasts it with no seller cooperation. MetaSo needs three
things, and the existing `/protocols/mrc721sell` ingest is the template for
all of them:

1. **Ingest** the offer pins (create-only, latest-pin-wins per `itemPinId`,
   payload stored verbatim).
2. **Two read endpoints** mirroring the sell-intent endpoints' envelope.
3. **One layout rule (R-E-3)** for whoever serves item ownership — likely a
   manapi-side change, see "Scope boundary".

Everything else on the client side is DONE and tested (tx primitives, offer
service, agent tools). The core loop (publish → chat-shared payload → take)
works WITHOUT the endpoints; the endpoints unlock market browsing.

## Background in three bullets

- The offer tx commits exactly `{item outpoint, output0 price}` via
  SIGHASH_SINGLE|FORKID|ACP (byte 195). The buyer appends the delivery output
  (at index 1 — see R-E-3) plus funding and broadcasts. No covenant, no
  custodian, no seller online.
- The pin payload is `{ active, itemPinId, priceSats, offerTx, createdAt }`.
  `offerTx` = base64(TxComposer JSON envelope). `priceSats` is a MIRROR for
  filtering convenience — the authority is output0 inside the signed tx. Do
  not parse, validate, or normalize `offerTx`; store it verbatim.
- Cancellation = a new pin with `active:false`. An offer whose item UTXO moved
  is dead regardless of any pin — the index is an advertisement, chain state
  is the truth. Clients re-verify the holder view and outpoint before taking.

## Work item 1 — ingest `/protocols/mrc721offer`

Mirror the sell-intent hook exactly (aggregator block-pin path hook,
`/protocols/mrc721sell` is the reference implementation):

- CREATE ops only; other ops on the path are ignored (same as sell intents).
- Keyed by payload `itemPinId` (`<64hex>i<vout>`), **latest pin wins** per
  item — a new offer superseding an old one is the normal re-price flow, not
  a conflict.
- `active:false` rows are cancellations — keep them queryable, do not delete.
- Unknown/extra payload fields: ignore, never reject (same tolerance as the
  sell-intent ingest; "required fields are checked for existence only, not
  format" applies).
- Mempool: same decision as sell intents — do NOT ingest from mempool;
  block-loop ingestion is the authority (chain-order-wins is unsafe
  mempool-side).
- Feature flag following the house convention, e.g.
  `METASO_P2P_MRC721_OFFER_ENABLED=true` (your naming call).
- Historical backfill: the protocol is brand new, so there should be zero
  historical pins — a backfill command is optional (mirror
  cmd/metaso-p2p-mrc721-backfill only if trivial).

## Work item 2 — read endpoints (envelope identical to the sell-intent family)

1. `GET /api/mrc721/offers` — active offers, newest chain-order first.
   - Filters: `itemPinId`, `sellerMetaId` (the pin creator), `collectionPinId`
     (join through the item → collection relation where available), plus
     standard `cursor`/`size`.
   - Response envelope: `{ list: [...], total, cursor }` (same shape as
     `/api/mrc721/sell/intents`; camelCase rows; keep the camelCase/lowercase
     duplicate convention if the sell-intent rows ship one).
   - Row fields: `itemPinId`, `offerPinId`, `active`, `priceSats`,
     `offerTx` (verbatim), `createdAt` (epoch SECONDS), `height`, `txId`,
     `chainName` — as available.
2. `GET /api/mrc721/offer/info?itemPinId=<itemPinId>` — the latest offer for
   one item, full payload including `offerTx`. Miss = `40400` (same envelope
   as sell intent info). NOTE: the lookup key is **itemPinId** (the client
   keys offers per item and takes the latest) — not the offer pinId.
3. Public read, no authentication — identical to the sell-intent endpoints.

## Work item 3 — R-E-3, the delivery-output layout rule

This is the ONE consensus-facing change, and it is a convention change, not a
contract. In the offer settlement tx the layout MIRRORS the directed swap:

```
inputs[0]  = the item UTXO (seller-signed, SINGLE|FORKID|ACP)
outputs[0] = P2PKH(priceSats → seller)     ← the signed price, NOT the delivery
outputs[1] = P2PKH(itemValue → buyer)      ← the DELIVERY output
outputs[2+]= buyer change (optional)
```

Required rule: when a tx spends an MRC-721 item UTXO at input0 and output0 is
NOT a valid delivery output for that item (its value differs from input0's
value — it is the price payment), read the new owner from **output1**. The
client guarantees output1 carries exactly input0's satoshis and pays a
standard P2PKH address. Suggested detection:
`output0.satoshis !== inputs[0].satoshis → delivery = outputs[1]` (optionally
also require `outputs[1].satoshis === inputs[0].satoshis`).

**Scope boundary (please route accordingly):** R-E-3 belongs on whichever
surface serves item OWNERSHIP. Today the item index is the manapi-compatible
surface; if MetaSo only proxies item reads to it, R-E-3 is a manapi change
request (the IDBots team can take it there) — MetaSo itself only needs items
1 and 2 unless/until it owns the item read model.

## Non-goals

- No order matching, no escrow, no custody of anything.
- No changes to `/protocols/mrc721sell` ingest or endpoints (v2 continues
  unchanged alongside the offer protocol).
- No man-p2p changes at all: the offer pin is an ordinary pin there.

## Acceptance checklist

1. Ingest unit tests: create-only (a modify op on the path is ignored),
   latest-wins per itemPinId, cancellation row kept, unknown-field tolerance.
2. Endpoint tests: filters, pagination envelope, `40400` miss on info.
3. A stored `offerTx` round-trips byte-identical (the client's signature
   verification depends on it).
4. Live end-to-end (with IDBots dev build): bot A publishes an offer → the
   offer appears in `/api/mrc721/offers` → bot B takes it → the settlement tx
   confirms → the item's owner resolves to the buyer through the R-E-3 rule.
5. `curl` verification snippets land in the deploy SOP (same section style as
   the sell-intent endpoints, SOP §13).

## Rollout notes (house conventions)

- Ship behind the offer flag; default off until acceptance passes.
- Restart caveat: after a deploy, the pebble WAL replay delays the API port
  (~2 min of 502 behind Caddy) — poll, do not roll back.
- The offer protocol is new, so ingest starts empty; no backfill is required
  for correctness.

Effort expectation: a close mirror of the sell-intent slice (ingest hook + two
read endpoints + tests) — the design decisions are already frozen in
`docs/nft-offer-protocol.md`, so the work is integration, not design. The only
open coordination point is R-E-3's placement (manapi vs MetaSo item reads).
