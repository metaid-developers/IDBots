# Indexer Requirement R-F — MRC-721 Zero-Confirmation Indexing (for the MetaSo backend)

Status: requirement for the MetaSo-P2P team, 2026-11-08. Follows the
client-contract conventions of `docs/nft-indexer-requirements.md`
(envelope, camelCase, pagination) and extends R-C (sell intents), R-D, and
R-E (passive offers).

Priority, in delivery order:

1. **R-F-10 and R-F-11 (P0, ship first)** — two confirmed-path defects
   found while verifying this requirement. Mint-before-register albums get
   numbers in pinId order, and an `item_desc` with object `metadata` is
   dropped whole. Both are live in production today, independent of
   zero-conf.
2. **R-F-1 to R-F-8 (P0)** — zero-confirmation indexing for issuance and
   trading.

Audience: maintainers of `internal/aggregator/mrc721nft`,
`internal/aggregator/mrc721`, and `internal/indexer/engine.go` in
metaso-p2p (the service behind `https://so.metaid.io/api/mrc721/*`).

This document also covers the field report the MetaBot AI_Sunny wrote
after the 2026-11-08 test issue (its "R1 aggregation includes unconfirmed
pins + explicit state field" and "R3 holdings consistency" map to R-F-2,
R-F-5 and R-F-3 below; its "R2 skill wording" is IDBots-side work tracked
separately).

## 0. Owner directive

**Every MRC-721 read surface goes zero-confirmation, trading included.**

- MVC has no replace-by-fee. A transaction with a sufficient fee that is in
  the mempool confirms with near certainty, so waiting for a block adds
  nothing but latency, and most of all to atomic-swap settlements.
- Ship issuance AND trading as zero-confirmation now. The owner may later
  move trading back to confirmed-only, so trading sits behind its own
  configuration gate (R-F-6) and can be switched back without a redeploy.

## 1. Field evidence (2026-11-08, test album `pixel-sun-test`)

The full guided issuance, done by the MetaBot through IDBots on MVC:

| Time (UTC+8) | Event |
|---|---|
| 21:34–21:36 | 5 image uploads, then 5 item mints (`/nft/mrc721/pixel-sun-test/frame-1..5`) |
| 21:37 | 1 batch `item_desc` pin (display info for all 5 items) |
| 21:38 | `collection_desc` broadcast — collectionid `4687fb9b…a1cei0` |
| 21:38–22:03 | `/api/mrc721/collection/info?pinId=…` → code 100 ("not indexed"); `collection/search` (issuer) → old album only; `item/info` → miss for all 5 items |
| 21:41–22:05 | the raw pin read (man-p2p `pin` endpoint) returns the full `collection_desc` with `genesisHeight:-1`; the wallet shows the change as unconfirmed spendable |

The album and its items were **invisible on every MRC-721 endpoint for 25+
minutes** while the data sat in the mempool, fully readable at the raw pin
layer. The agent spent the wait polling and the owner aborted the session.
The same gap applies after every transfer or trade: the new owner cannot
see, re-list, or resell the NFT until a block arrives.

Reference vectors (Appendix A) let you replay the scenario.

## 2. Current behavior (code references)

1. `engine.pollMempoolOnce` (`internal/indexer/engine.go`, every
   `mempoolPollInterval`, default `10s`) already parses mempool pins and
   routes them via `Registry.RouteMempoolPin`.
2. **Both MRC-721 aggregators drop them**:
   - `mrc721nft.Aggregator.HandleMempoolPin` is a deliberate no-op
     ("mirroring man-p2p: only confirmed pins fold into the aggregate").
   - `mrc721.Aggregator.HandleMempoolPin` is a deliberate no-op. The reason
     given: latest-wins sell/offer logs must not let a mempool re-declare
     overwrite a confirmed cancellation "with no recovery path".
3. Spends: `engine.mempoolTransferLoop` (every 30s, full mempool) feeds
   `HandleMempoolSpends`. The only effect is the additive `pending` key on
   `item/info` and the `pending` array on `item/transfers`. **Ownership,
   `output`, and the holder views stay on the confirmed state.**
4. Why a naive fold-in would break: `mintCommit` mutates persistent Pebble
   state (`TotalNum++`, `SaveItem`, `AppendCollectionItem`, holder index)
   and is idempotent by `itemPinId`. If a mempool fold wrote there:
   - a dropped transaction could never be rolled back;
   - when the confirmed copy arrives, the idempotency guard would skip it,
     freezing `genesisHeight:-1` and any provisional number for good.

## 3. Design principles (normative)

1. **Overlay, never mutation.** Confirmed state stays exactly as today in the
   Pebble aggregates. Mempool state lives in a separate overlay that is
   **recomputed** from the current mempool, never merged destructively.
   Reads return base + overlay.
2. **Confirmed wins.** When a pin or spend confirms, the block path ingests
   it as today and the overlay entry for that txid is dropped in the same
   critical section.
3. **Eviction.** A full-mempool round that no longer contains a transaction
   removes its overlay effects. This is the reconcile rule the transfer
   pending channel already uses.
4. **Deterministic provisional order.** Inside the overlay, order is
   topological (a parent transaction before its child), then `firstSeenAt`,
   then txid.
5. **Additive wire contract.** No field is renamed or removed. New fields
   are optional. The `pending` key on item/info and the `pending` array on
   item/transfers stay as they are today.
6. **Strict opt-out.** Any client can still request today's confirmed-only
   view (R-F-6).

## R-F-1: Overlay store and lifecycle

- **Where**: `mrc721nft` and `mrc721` aggregators; engine mempool loops.
- **Required**:
  - Implement `HandleMempoolPin` in both aggregators to record **overlay
    entries**:
    - one entry per mempool pin under `/nft/mrc721/*`, `/protocols/mrc721sell`
      and `/protocols/mrc721offer`;
    - fields: txid, firstSeenAt, raw pin facts, and the parsed effect.
  - Feed mempool spend notices of tracked outputs into the same overlay,
    the way `HandleMempoolSpends` feeds pending transfers today.
  - Keep the overlay in memory, or in a separate namespace that is wiped at
    startup. It is never part of backfill or replay.
  - After a restart the overlay rebuilds from the node mempool within one
    poll plus one full scan.
  - Reconcile on every full-mempool round: drop entries whose txid is gone
    and that did not confirm.
  - When a block confirms a txid: ingest it on the base path first, then
    drop its overlay entries, under the same lock.

## R-F-2: Issuance becomes zero-confirmation

The overlay applies the same protocol rules the base path uses:

1. **`collection_desc` create.**
   - An overlay album registers for (collectionName, issuer) when the base
     has none.
   - It is served with `confirmed:false`, and its collectionid is the
     mempool pinId.
   - First-registration rules hold: a confirmed album for the pair always
     wins over an overlay one.
2. **`collection_desc` modify** (issuer-only version chain).
   - Overlay modifies stack on the confirmed version in provisional order.
   - The collection DTO shows the merged content with
     `contentConfirmed:false` while any overlay modify applies.
3. **Mints.**
   - An overlay mint under a registered album gets
     `provisionalNumber = confirmed totalNum + rank`, where rank is the
     mint's position in the album's overlay mint order.
   - Supply gate: overlay mints past the remaining supply get
     `overSupply:true` and stay out of item lists and counts. That matches
     the outcome once chain order is final.
   - **Mint-before-register** (IDBots issues items first and registers the
     album last):
     - confirmed staged mints (`PutPending`) and overlay mints must both
       surface under an overlay album;
     - numbering must follow exactly the order `drainPending` will apply
       when the album confirms (confirmed staged mints first, by chain
       order, then overlay mints).
4. **`item_desc`.**
   - Per-field first-write-wins and the issuer gate as today.
   - Confirmed descs apply first, then overlay descs in provisional order.
   - A field filled only by an overlay desc is reported with
     `descConfirmed:false`.

**Acceptance (issuance)**: replaying Appendix A on staging — mints first,
batch `item_desc`, then `collection_desc` — every check below passes
**within 20s of the last broadcast** and before any block:

- `collection/info?pinId=<collectionid>` returns the album with
  `confirmed:false`, `totalSupply:5`, `mintedCount:5`;
- `collection/items/pageList` lists 5 items numbered 1..5 in mint order,
  each with `confirmed:false` and `numberFinal:true` (the mints are a
  parent→child chain, see R-F-5);
- every `item/info?pinId=` returns the item with name, desc and cover;
- `collection/search` (keyword or issuer) and
  `address/collections-issued` include the album;
- `address/item` and `address/collection` for the issuer include it.

After the block, the same calls return identical numbers and fields with
`confirmed:true`.

## R-F-3: Trading becomes zero-confirmation (transfers, atomic swaps, offers)

1. **Ownership follows the overlay.**
   - A detected mempool spend of a tracked item output moves the item to its
     new owner in the overlay, using the same input-0 → output-0 rule as
     today and the R-E-3 output-1 delivery rule for passive-offer
     settlements.
   - Meltdown or burn semantics apply as today.
   - `item/info` reports the new owner in `address` / `ownerAddress`, and
     the new spend target in `output` / `outputValue`.
   - New fields: `ownershipConfirmed:false` and `confirmedOwnerAddress`
     (the last confirmed owner).
   - The existing `pending` object remains.
2. **Chained unconfirmed spends.**
   - `TrackedOutputs()` must also include outputs that exist only in the
     overlay (a freshly minted item, a freshly delivered item).
   - Otherwise a resale or re-transfer before the first confirmation is
     invisible.
   - Any depth must work: mint → list → buy → resell, all unconfirmed.
3. **Holder views.**
   - `address/item` and `address/collection` add items whose overlay owner
     is the address.
   - They hide items whose overlay owner moved away, unless the request
     sets `confirmedOnly=1`.
4. **Provenance.**
   - `item/transfers` lists overlay transfers at the head of `list` with
     `confirmed:false`.
   - The `pending` array stays as today for backward compatibility.
   - `total` includes overlay transfers.

**Acceptance (trading)**, all on staging and within 20s of each broadcast,
before any block:

- seller A mints item X;
- A declares a sale (`/protocols/mrc721sell`);
- buyer B completes the atomic swap;
- `item/info?pinId=X` shows owner B with `ownershipConfirmed:false`;
- B's `address/item` contains X and A's does not;
- B immediately re-transfers X to C, and the item shows owner C;
- after confirmation every field is unchanged, with `confirmed:true`.

## R-F-4: Declarations (sell intents, passive offers) go zero-confirmation

- **Where**: `mrc721` aggregator (`/protocols/mrc721sell`,
  `/protocols/mrc721offer`).
- **Required**:
  - Overlay declarations take effect on top of the confirmed latest-wins
    record. Their order is: confirmed chain order first, then overlay
    provisional order.
  - Because the overlay is recomputed, a dropped re-declaration
    automatically restores the confirmed record. This removes the "no
    recovery path" concern in `module.go`.
  - `sell/intents`, `sell/intent/info`, `offers`, and `offer/info` serve
    the merged view. Each row carries `confirmed:false` when an overlay
    pin produced it.
- **Acceptance**:
  - A mempool cancellation hides the intent immediately.
  - Evicting that cancellation restores the intent on the next full
    round.

## R-F-5: Wire contract (additive fields, frozen by this document)

| DTO | New field | Meaning |
|---|---|---|
| collection, item, sell intent, offer, transfer row | `confirmed` (bool) | `false` when any overlay pin or spend produced or changed the row |
| same | `firstSeenAt` (unix s) | Set on overlay rows only |
| collection, item | `genesisHeight` | `-1` for overlay registrations and mints (MAN convention) |
| item | `numberFinal` (bool) | `false` when the provisional number could still change. It is `true` when every overlay mint ranked ahead of it in its album is a confirmed pin or an ancestor transaction (a parent→child chain, so no miner can reorder them) |
| item | `ownershipConfirmed` (bool), `confirmedOwnerAddress` | See R-F-3 |
| item | `descConfirmed` (bool) | See R-F-2.4 |
| item | `overSupply` (bool) | Overlay mint past the remaining supply. Only served with `includeOverSupply=1`; hidden by default |
| collection | `mintedCount` | Counts overlay items too. Mint prechecks need this |
| collection | `confirmedMintedCount` | The confirmed-only count |
| collection | `contentConfirmed` (bool) | See R-F-2.2 |

Rules:

- Unknown or extra fields must never be rejected by clients (IDBots
  already tolerates them).
- `item/verify` reports overlay facts with `confirmed:false`. For an
  overlay item, `collected:true` means provisionally collected.

## R-F-6: Gates and strict opt-out

- **Config** (`config.toml`, `[mrc721]`):
  - `zeroConfIssuance = true`
  - `zeroConfTrade = true`
  - Owner directive: both on now. Turning `zeroConfTrade` off restores
    today's trading behavior exactly (R-F-3/R-F-4 overlay ignored) with no
    redeploy, ideally with a hot reload.
- **Query parameter**: every MRC-721 endpoint accepts `confirmedOnly=1` and
  then returns today's confirmed-only view, byte-identical to the current
  responses. Audits, accounting, and strict clients use it.

## R-F-7: Latency targets

- **Issuance and declaration pins**: visible within one
  `mempoolPollInterval` of the transaction entering the node mempool
  (default 10s); p95 ≤ 20s.
- **Spends** (trades and transfers):
  - Run tracked-output spend detection on every incremental mempool poll,
    not only on the 30s full scan.
  - Keep the full scan for eviction reconcile only, and make it
    configurable (30–60s).
  - Target p95 ≤ 20s for an ownership change to show.

## R-F-8: Correctness invariants (test matrix)

1. **Confirmation handoff**:
   - no duplicate rows;
   - no gap between "overlay dropped" and "base visible" (same lock);
   - numbers and fields identical except `confirmed`, `genesisHeight`,
     `numberFinal`, and `firstSeenAt`.
2. **Eviction**: a transaction missing from a fully observed mempool round
   removes all of its overlay effects. A failed mempool fetch never
   reconciles, which is the existing rule.
3. **Restart**: the overlay is empty at boot and rebuilt within one poll
   plus one full scan. Nothing from the overlay is ever persisted into
   Pebble aggregates or replayed by backfill.
4. **Parallel-funded mints**: two independently funded overlay mints in
   one album get `numberFinal:false`. If the block orders them differently,
   the confirmed numbers win and the overlay disappears.
5. **Supply race**: total overlay plus confirmed mints never exceed
   `totalSupply` in served counts.
6. **Reorg**: out of scope. The base behavior is unchanged and the overlay
   recomputes from the new mempool.

## R-F-9: Non-goals

- No change to the confirmed protocol rules: issuer-only minting, the
  `item_desc` issuer gate, first-registration identity, and the transfer
  detection rules. Exception: the two confirmed-path defects in R-F-10 and
  R-F-11, which violate the published protocol today.
- No mempool persistence and no historical "was pending" log.
- No fee policing. MVC has no RBF; the owner accepts fee-sufficient
  zero-conf.
  - Optional (P2): expose the pending transaction's `feeRate` (sat/B), so
    clients can flag below-relay-floor transactions.

## Confirmed-path defects found while verifying this requirement (P0, independent of zero-conf)

The test album is now confirmed (height 197805). Production
`so.metaid.io` serves it wrongly in two ways. Both reproduce with the
Appendix A vectors. Both are pure indexer derivations, so a fix plus a
replay repairs existing albums without any on-chain write.

### R-F-10: Staged mints must drain in chain order, not pinId order

- **Where**: `mrc721nft.drainPending` (`aggregate.go`) and
  `nftStore.PopPending` (`store.go`).
- **Today**:
  - Mints that arrive before their album is registered are staged under
    the key `pending:<collection>&<issuer>&<pinId>`.
  - `PopPending` returns them in Pebble key order, which is **lexicographic
    pinId order**.
  - `drainPending` commits them in that order. Only `colmod` entries are
    sorted.
  - Result for `pixel-sun-test` (mint order frame-1..5): production numbers
    are frame-3 → #1, frame-1 → #2, frame-5 → #3, frame-2 → #4,
    frame-4 → #5, which is exactly the sorted pinIds.
- **Why it is wrong**: the protocol makes creation order authoritative
  ("only the earliest-created N pins under the path are valid"). Today the
  supply cut AND the numbering of every mint-before-register album follow
  the txids' hash order.
  - Mint-before-register is IDBots' default issuance order (items first,
    `collection_desc` last), so every IDBots multi-item album is affected.
- **Required**:
  - Carry the chain position into `PendingMint`: genesis height plus the
    transaction index within the block.
  - `drainPending` sorts staged mints by (height, txIndex, output index)
    before committing. The supply cut then follows that order.
  - Ship a one-off migration that re-derives numbers, and the supply cut,
    for every album whose registration drained two or more staged mints.
    Please publish the list of affected collectionids.
- **Acceptance**: after migration, `pixel-sun-test` numbers frame-1..5 as
  #1..#5. The R-F-2 overlay uses the same ordering (R-F-2.3).

### R-F-11: `item_desc` must tolerate any JSON `metadata`, ref by ref

- **Where**: `ItemDescRef.Metadata` (`store.go`, typed `string`) and
  `parseItemDescRefs` (`aggregate.go`).
- **Today**:
  - `json.Unmarshal` into `[]ItemDescRef` fails as soon as one ref carries
    a non-string `metadata` (an object, as in IDBots' batch and mint
    writes).
  - `parseItemDescRefs` then returns `false`, so **the entire `item_desc`
    pin is dropped** with one warning log line.
  - The test album's batch desc (`5eef07fc…i0`, 5 refs with object
    metadata) was discarded. All 5 items serve empty name, desc, cover
    and metadata.
  - Collection metadata does not have this problem: `collection_desc` reads
    it through the tolerant `stringField`, which is why the album card is
    fine.
- **Why it is wrong**:
  - The protocol defines `metadata` as arbitrary data ("任意数据").
  - Collection and item metadata are parsed inconsistently.
  - One bad field silently erases the display info of up to 100 items.
- **Required**:
  - Decode `metadata` as `json.RawMessage`. Store strings verbatim; store
    any other JSON value as its compact JSON text, which is the same rule
    `stringField` applies to collection metadata.
  - Parse refs individually: skip only a malformed ref (log it) and keep
    the others.
  - Replay every `item_desc` pin previously dropped by this path.
    First-write-wins stays correct, because those pins never wrote any
    field.
- **Acceptance**: after the fix plus replay, all 5 `pixel-sun-test` items
  serve the names, descriptions and covers from `5eef07fc…i0`. Their
  `metadata` comes back as JSON text
  `{"contentType":"image/jpeg","generator":"Seedream 4.5"}`.

IDBots will additionally write `item_desc` and `collection_desc` metadata
as JSON **strings** from its next release, matching the protocol example.
Other indexers that copied the strict `string` field (for example man-p2p,
if it shares the struct) then keep working. The fix above is still required
for pins already on-chain.

## 4. IDBots-side plan (consumer of this contract)

- **Immediately** (independent of MetaSo):
  - IDBots writes `item_desc` and `collection_desc` metadata as JSON
    strings, so R-F-11 cannot drop new pins on any indexer.
  - The issuance guide stops promising "creation order = number order"
    until R-F-10 ships.
- **Interim, before R-F ships**: when `collection/info` or `item/info`
  misses, IDBots falls back to the raw pin read (man-p2p `pin` endpoint,
  which already serves mempool pins). It reports "on-chain, pending block"
  for display only, never for trade preconditions.
- **On R-F**:
  - IDBots reads `confirmed`, `numberFinal` and `ownershipConfirmed`.
  - NFT and collection cards show a "pending" badge when
    `confirmed:false`.
  - The mint supply precheck uses `mintedCount` (overlay included).
  - Transfer, sell, and buy accept overlay outputs as spend targets
    (chained unconfirmed spends).
- **Rollout**:
  1. Ship to staging first.
  2. IDBots dev points `IDBOTS_METASO_API_BASE` at staging and runs
     Appendix A plus the R-F-3 trading script.
  3. Promote to production (`so.metaid.io`) after both pass.

## 5. Open questions for the MetaSo team

1. Provisional numbers under parallel funding (R-F-8.4). Is a per-album
   `numberFinal:false` acceptable, or do you prefer to withhold
   `number`/`itemPinNumber` (serve `-1`) until final?
2. Overlay memory bound: suggest a cap per chain (for example 50k entries)
   with oldest-first eviction plus a log line. Please confirm a figure.
3. Should the incremental spend detection (R-F-7) reuse
   `CatchMempoolPins`' transaction parse to avoid a second decode?

## Appendix A — Test vectors (MVC mainnet, issuer `1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za`)

- collectionid: `4687fb9b4a349fe9832927a6676776c96d1c1cf7dd3a8b0607e4ffdb3400a1cei0`
  (path `/nft/mrc721/pixel-sun-test/collection_desc`, totalSupply 5,
  royaltyRate 0). Confirmed at height 197805 (verified 2026-11-08 on
  `so.metaid.io`).
- Items in mint order. The expected numbers are 1..5; production currently
  serves the numbers in brackets (R-F-10):
  1. `a205961de87f1a3b33133b75f0c54bbf3700f91da33cb3d7dc7474712ac0da68i0` (frame-1, served #2)
  2. `c1da5fc50d088452b9c144461d3a783938bfa40ce25e24799e01795ca12fb621i0` (frame-2, served #4)
  3. `41b4bf71ac5b16f223b1c793533f41466847af3af125b904d692725b74300a25i0` (frame-3, served #1)
  4. `c37eb8a911c904872bf1c6aa0fa5a07b46eae0e68a9f20125e4c38e51fde4101i0` (frame-4, served #5)
  5. `a762925ac00fa317a00face925f9f489702a0499c307d858a3a161aa5ccb8cd2i0` (frame-5, served #3)
- Batch `item_desc`: `5eef07fc2218afb188fa078e4ccaccd383c2875295b7ba8127a286be8ca29001i0`.
  Dropped by R-F-11, so all 5 items currently serve empty display fields.
- Order on chain: mints (parent→child chain) → `item_desc` →
  `collection_desc`, all in block 197805. This exercises the
  mint-before-register path of R-F-10 and R-F-2.3.
- Use these vectors for the confirmed-path checks (R-F-10/R-F-11
  acceptance). Repeat the same flow with a fresh album name on staging for
  the zero-conf checks.
