# MRC-721 Open-Offer Protocol ("NFT 硬挂单", v1)

Status: **APPROVED by the owner (2026-11-08).** The shape below is the frozen
protocol: fixed unofficial path `/protocols/mrc721offer`, minimal duplicate-free
payload, append-only offer log with per-itemPinId latest-pin-wins. The
mechanism is the owner's: the seller signs the item input with
`SIGHASH_SINGLE|FORKID|ANYONECANPAY` over a tx whose output0 IS the price
output, and wraps the signed raw tx in this pin so the indexer indexes it and
any buyer can take it offline.

Related: `docs/nft-open-market-psbt-settlement.md` (design + security
analysis), `docs/nft-offer-indexer-requirements.md` (R-E, backend),
`docs/nft-sell-protocol-draft.md` (the soft sell-intent v2 this sits beside),
`src/main/libs/mrc721OpenOfferTx.ts` (tx primitives).

## 1. Positioning

A **hard listing**. The v2 sell intent (`/protocols/mrc721sell`) declares
willingness and still needs seller cooperation to settle; this protocol
publishes the SETTLEMENT ITSELF — a signed, price-locked, first-taker-wins
offer. The seller signs once and may go offline. Directed (private-chat)
trading and the escrow rail stay untouched.

## 2. Pin path

```
/protocols/mrc721offer
```

Every owner decision from the v2 sell intent carries over unchanged:

- **`/protocols/`, not `/nft/`** — unofficial namespace; keeps offer pins away
  from the `/nft/mrc721/` item-mint rule (zero phantom-item risk).
- **Fixed path, no per-item suffix** — `itemPinId` lives only in the content.
- **No `protocol`/`version` payload fields** — the pin seven-tuple carries
  protocol identity and version.
- **Append-only offer log (buzz pattern)** — every publish / re-price / re-list
  is a CREATE pin; per `itemPinId` the LATEST pin (by chain order) wins; no
  delete operation. Cancellation = a new pin with `"active": false`.
- An offer also dies **naturally** the moment the item UTXO is spent in any
  other way (transfer, directed sale, burn): the take-time gate finds input0
  spent and refuses. Chain state, not a cancel pin, is the real kill switch.

## 3. Content schema (the pin payload)

```json
{
  "active": true,
  "itemPinId": "<64hex>i<n>",
  "priceSats": 30000,
  "offerTx": "<base64( TxComposer.serialize() JSON envelope )>",
  "createdAt": 1794000000
}
```

| Field | Required | Constraint | Nature |
|---|---|---|---|
| `active` | yes | boolean; cancellation = new pin `active:false` | protocol |
| `itemPinId` | yes | `<64hex>i<n>`, lowercase; **the latest-wins key** | protocol |
| `priceSats` | yes | positive integer, ≥ 22000 (enforced at build time) | **mirror** — the authority is output0 inside `offerTx` |
| `offerTx` | yes | base64 of the TxComposer JSON envelope (signed, prevouts hydrated) | protocol (the core) |
| `createdAt` | yes | epoch **SECONDS** (same convention as v2) | advisory |

**`offerTx` decoded is the deed itself** (every part verifiable offline):

```
inputs[0]  = the item UTXO, signed by the seller with SINGLE|FORKID|ACP (byte 195)
outputs[0] = P2PKH(priceSats → seller address)   ← the ONLY commitment, inside the signature
```

Deliberate deviations from the v2 intent payload (owner-reviewed 2026-11-08):
no `sellerAddress`/`sellerMetaId` (the address is signature-locked inside
output0; the seller identity is the pin creator), no `itemOutpoint` (it is
input0 of the signed tx), no `acceptedCurrencies`/`settlement` (the offer is
native-SPACE atomic by construction), no `expiresAt` (the offer dies by chain
state, not by a TTL), no `note`/collection fields (keep the payload minimal;
collection joins are the indexer's job). Local KV bookkeeping may carry
`kind`/`version` bookkeeping fields — local only, never on-chain.

## 4. Lifecycle

```
publish   CREATE pin (schema above) → nft-card(action=listed) emission
re-price  another CREATE pin (latest-wins supersedes automatically)
cancel    another CREATE pin, active:false
take      a buyer completes + broadcasts offline → the item UTXO moves;
          the offer pin remains on-chain but is dead (input0 spent)
```

A take produces NO new pin — one ordinary transaction.

## 5. What the indexer does (R-E)

- Index CREATE pins whose path is exactly `/protocols/mrc721offer`, keyed by
  payload `itemPinId`, latest pin wins. Store `offerTx` verbatim — the
  indexer never parses or validates it.
- Query endpoints mirroring the sell-intent shape: `GET /api/mrc721/offers`,
  `GET /api/mrc721/offer/info?pinId=` (public read).
- Layout rule R-E-3: in a settlement tx spending the item UTXO at input0
  where output0 is not the delivery output, read the new owner from output1.
- The index is an advertisement, not a source of truth; clients re-verify
  chain state before taking.

## 6. Security notes

1. The offer pin authorizes nothing by itself: no wallet touch, no transfer.
   Money moves only when a buyer signs and broadcasts their own tx.
2. Pin ≠ ownership: before taking, re-verify the item is still held by the
   seller and the outpoint is unspent (`mrc721_item_info` + unspent check).
3. The price cannot be cheated: output0 is inside the SINGLE digest — any
   tampered advertisement fails the seller-signature verification and moves
   nothing.
4. `/protocols/mrc721offer` is outside `/nft/*`: offer pins can never be
   treated as items by indexers.
5. A cancellation pin does NOT revoke the signature. The signed `offerTx` of
   the original pin stays public on-chain, so while the item sits at the
   offered outpoint anyone holding that payload can still complete it at the
   signed price. A real cancel must MOVE the item (a self-transfer to a fresh
   outpoint); the `active:false` pin only stops advertising. Hosts must
   implement cancel as revoke-then-declare (§7).

## 7. Host implementation (this branch)

- Tx primitives: `src/main/libs/mrc721OpenOfferTx.ts` (build / decode / shape
  assert / payload / complete — offline-tested round-trips). Buyer funding is
  ordinary coin selection (several inputs, change at output2): the seller's
  SINGLE signature commits only output0, so nothing else is frozen.
- Service: `mrc721OpenOfferService.ts` — publish (holding check → build →
  createPin → local ledger `mrc721_offers:<metabotId>`), list my offers,
  HARD cancel (self-transfer revoke when the offer is still takeable → then
  the `active:false` declaration; idempotent on retry), take (five gates →
  complete → broadcast → ledger), market discovery over the R-E endpoints
  with a structured "R-E not served here" fallback.
- Agent tools: `mrc721_offer` / `mrc721_offer_cancel` / `mrc721_offers` /
  `mrc721_take_offer` / `mrc721_offers_market`, mounted alongside the existing
  `mrc721_*` family. The take refuses an index row that is a cancellation.
- Cards: publishes emit the standard `nft-card` with action **`listed`** (the
  existing badge — no renderer contract change).
