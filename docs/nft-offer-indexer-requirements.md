# Indexer Requirement R-E — MRC-721 Passive Offer Index (for the MetaSo backend)

Status: requirement handed to the MetaSo backend team, 2026-11-08. Companion
to `docs/nft-open-market-psbt-settlement.md` (the passive-offer design this
serves). Follows the client-contract conventions already established in
`docs/nft-indexer-requirements.md` (envelope, camelCase, pagination).

## R-E-1: Ingest `/protocols/mrc721offer` pins

- Treat CREATE pins on the fixed path `/protocols/mrc721offer` like the v2
  sell-intent ingest: create-only, latest-pin-wins keyed by `itemPinId`,
  no chain re-org surprises beyond the existing block-ingest rules.
- Payload fields: `itemPinId` (`<64hex>i<vout>`), `priceSats` (integer),
  `offerTx` (base64 of the TxComposer JSON envelope — store verbatim, do
  not parse or validate the tx), `active` (boolean; `false` = cancellation
  declaration).
- Unknown/extra fields: ignore, never reject (same tolerance as the sell
  intent ingest).
- An offer whose item UTXO is spent elsewhere may remain indexed — clients
  verify chain state at take time; the index is an advertisement, not a
  source of truth.

## R-E-2: Query endpoints (mirror the sell-intent shape)

- `GET /api/mrc721/offers` — active offers, newest first. Filters:
  `itemPinId`, `sellerMetaId` (the pin creator), `collectionPinId`
  (join through the item → collection relation where available), plus
  standard `page`/`size`. Returns the payload fields + the offer pinId and
  block height.
- `GET /api/mrc721/offer/info?itemPinId=` — one offer (the client keys offers
  per item, latest-wins), full payload (including `offerTx`). Miss = 40400,
  same envelope as sell intent info.
- Authentication: none (public read), identical to the sell-intent
  endpoints.

## R-E-3: Delivery-output layout rule for offer settlements (the one consensus-facing change)

Today the indexer reads the new owner of a transferred item from **output0**
(the directed swap puts the delivery output at index 0 and the price at
index 1). The passive-offer settlement tx MIRRORS the layout:

```
inputs[0]  = the item UTXO (signed SIGHASH_SINGLE|FORKID|ACP by the seller)
outputs[0] = P2PKH(priceSats → seller)     ← inside the seller's signature
outputs[1] = P2PKH(itemValue → buyer)      ← the DELIVERY output
outputs[2+]= buyer change (optional)
```

Required rule:

> When a transaction spends an MRC-721 item UTXO at input0 and output0 is
> NOT a valid delivery output for that item (its value differs from
> input0's value, i.e. it is the price payment), the indexer MUST read the
> new owner from output1. The client guarantees output1 carries exactly
> input0's satoshis and pays a standard P2PKH address.

Client-side enforcement backs this rule: the take flow builds the delivery
output at index 1 deterministically and refuses to broadcast anything else.
Suggested backend detection: `input0` is an indexed item UTXO AND
`outputs[0].satoshis !== inputs[0].satoshis` → delivery = `outputs[1]`.
Fallback for zero ambiguity (if the team prefers): also require
`outputs[1].satoshis === inputs[0].satoshis`.

## R-E-4: Non-goals

- No order-matching, no escrow, no custodial anything: the index only
  advertises offers and reads settlements.
- No change to `/protocols/mrc721sell` ingest or endpoints (v2 continues
  unchanged alongside).
- No man-p2p changes at all: the offer pin is an ordinary pin there.
