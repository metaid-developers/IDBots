# MRC-721 Sell-Intent Protocol Draft ("NFT 售", v1 DRAFT)

Status: **DRAFT — written autonomously per owner authorization ("全部按照你建议去推进");
needs owner review before it is treated as a frozen protocol.** The host-side
implementation in this branch is buildable and reversible; the pin path and
content schema below are the parts that need sign-off, because the indexer
will key on them.

Related: `docs/nft-indexer-requirements.md` (R-C), `docs/nft-trade-protocol-draft.md`
(scenario A/B/C), `src/main/libs/mrc721AtomicSwapTx.ts` (atomic swap v1).

## 1. Problem

- The MRC-721 atomic swap is a **locked listing**: the seller's partial tx
  names the buyer, so a listing cannot be discovered and taken by "whoever
  comes first" without off-chain coordination.
- Why not an open take with plain sighash: the indexer reads the new owner
  from **output 0** of the spending tx, and SIGHASH_SINGLE pairs input 0 with
  output 0 — the seller's signature would protect only the NFT output, leaving
  the price output (output 1) editable by the taker. SIGHASH_ALL|ACP protects
  both outputs but therefore freezes the buyer address. **There is no plain
  sighash scheme that commits the price while leaving output 0 open**; the
  MetaContract NftManager solves this with a covenant contract, which pin-based
  MRC-721 does not have. This is why `assertPartialTxShape` refuses
  SIGHASH_SINGLE listings today.
- PSBT as a *format* is fully supported — the limitation is sighash
  semantics, not PSBT. If the owner wants true first-taker-wins listings for
  MRC-721, the path is a covenant/contract UTXO (a v2 protocol), not a
  different PSBT flag.

## 2. Design: a sell-intent pin

A sell-intent is an **on-chain declaration pin** that says "the holder of item
X wants to sell it, on these terms" — discoverable, indexable, and
currency-agnostic. It moves no funds and transfers nothing; settlement happens
over one of two rails:

1. **atomic-swap** (native SPACE, trustless): after a buyer agrees, the seller
   runs the existing locked `mrc721_sell` for that buyer's address, the buyer
   completes with `mrc721_buy`. One extra step, zero added trust.
2. **escrow** (any currency — fiat, points, other chains): the parties route
   through a guarantor per the scenario-B convention; the MRC-721 custody leg
   is a plain `mrc721_transfer` to the guarantor and then to the buyer
   (`escrowOrderStateMachine.ts`, kind `mrc721`).

### 2.1 Pin path

```
/nft/mrc721sell/{itemPinId}
```

- **Deliberately OUTSIDE `/nft/mrc721/`**: any create pin under
  `/nft/mrc721/{collection}/{item}` mints an item, so sell pins must not live
  under that root or every declaration would mint a phantom item.
- One sell pin per item (the item pinId is the path key). Re-declaring =
  `modify` on the same path (keeps the chain history tidy and gives the
  indexer a single current record per item).
- Cancellation = `modify` with `"active": false`. No delete operation.

### 2.2 Content schema (the create/modify pin payload)

```json
{
  "protocol": "mrc721-sell-intent",
  "version": 1,
  "active": true,
  "itemPinId": "<64hex>i<n>",
  "collectionName": "pixel-cats",
  "collectionPinId": "<collection_desc pinid>",
  "itemOutpoint": { "txid": "<64hex>", "vout": 0, "satoshis": 1 },
  "sellerAddress": "1MVC…",
  "sellerMetaId": "<64hex>",
  "priceHintSats": 30000,
  "acceptedCurrencies": ["space", "btc", "fiat:CNY", "points:metaapp-x"],
  "settlement": ["atomic-swap", "escrow"],
  "contact": { "metaId": "<seller 64hex>", "metabotId": 3 },
  "note": "free text for buyers",
  "createdAt": 1793868000,
  "expiresAt": 1794472800
}
```

- `priceHintSats` is a **reference price in native sats**, optional — it is
  NOT an on-chain ask. Real asks live in the locked listing (rail 1) or in the
  negotiated escrow deal (rail 2).
- `acceptedCurrencies` is an open vocabulary: `space`, `btc`, `doge`, `opcat`,
  `fiat:<code>`, `points:<scope>`, or any settlement token tag. The indexer
  indexes it verbatim; clients interpret the tags they know.
- `expiresAt` is display-only (same stance as the atomic swap listing TTL).
- All fields except `protocol`/`version`/`itemPinId`/`active` are advisory.

### 2.3 What the indexer does with it (R-C)

- Index sell pins under `/nft/mrc721sell/` keyed by `itemPinId`.
- Expose: sell-intents by collection (`collectionPinId`), by seller address,
  and by item — this is what makes "查看专辑在售情况" (S2) a real query.
- Optional: join with the holder view so stale intents (item no longer owned)
  can be filtered server-side.

## 3. Announcement card

Declaring a sell-intent emits the standard chat NFT card with action
**`selling`** (added to the renderer's action badges and the p2p trade-badge
classification). The card carries item identity + `priceHintSats` when
present. The sell pin itself is linked as `pin://<sellPinId>`.

## 4. Security notes

- The intent pin authorizes nothing by itself: no wallet touch, no transfer.
  Anyone can read it; only the holder can settle via the rails above.
- The `mrc721sell` path is a NEW namespace: the item-mint rule under
  `/nft/mrc721/` does not apply to it, and man-p2p must not treat sell pins as
  items (indexer change is exactly R-C).
- Intent ≠ ownership: the holder view remains the only source of truth for
  "does the seller still have it". Clients should re-check
  `mrc721_verify_holding` / `item_info` before engaging on an intent.

## 5. Host implementation in this branch

- `mrc721_sell_intent` / `mrc721_sell_intent_cancel` / `mrc721_sell_intents`
  agent tools + host-callable service functions (KV-backed local intent book
  `mrc721_sell_intents:<metabotId>`). Own intents read from the local book;
  market-wide discovery (`mrc721_market_intents` over `/api/mrc721/sell/intents`)
  degrades to a structured "R-C not served here" error until an indexer with
  the endpoint is reachable.
- `mrc721_sell_orders` gains a collection filter.
- The MetaBot NFT wallet gains list/buy flows over the locked-listing rail.
