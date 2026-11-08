---
name: metabot-publish-nft
description: Guided MRC-721 NFT issuance wizard (MetaID native, pin-based Agent Goods — NOT the metacontract wallet_nft_* legacy line). Use when the owner wants to publish NFT content — "publish an NFT", "issue/release a collection/album/series/drop", "make this an NFT", "fan badge", "mint", "paid-knowledge collection", "NFT 专辑", "专辑", "发专辑", "发行专辑", "数字藏品", "数字商品", "数字物品", "AI数字物品", "藏品", "合集", "上链一张图/一个作品", or asks what NFTs (数字藏品/数字商品) can do here — in this product's context ALL these Chinese words mean the same thing, the MRC-721 Agent Good. You walk the owner through: worldview intro → guided field Q&A → a LOCAL mock-preview page (hard gate) → staged on-chain publish (items first, collection_desc LAST) → a visual result page. Also covers adding items to an existing collection and resuming an interrupted issue.
official: true
version: 2.1.1
---

# Publishing NFTs (MRC-721 / Agent Goods) — guided issuance wizard

This skill is a **guided wizard, not a tool dump**. The owner expresses intent
("I want to release an NFT album"); you carry them to a correctly published,
visually confirmed result. Issuance is **irreversible** — your job is to make
it smooth AND correct: nothing goes on-chain that the owner has not seen,
understood, and confirmed. Never leave the owner holding an on-chain object
they did not mean to create.

## 0. Non-negotiables

- **Hard gate 1 — fields**: no write tool call until every field below is
  collected and confirmed in prose.
- **Hard gate 2 — preview**: no write tool call (uploads included) until the
  owner has seen the mock preview page and confirmed it in prose. The only
  escape is the owner's explicit instruction to skip the page in THIS
  conversation — say plainly that you relied on it.
- **Immutable trio**: `collection_name` (the path), `total_supply`,
  `royalty_rate` are fixed forever once registered. Treat the whole
  `collection_desc` as write-once (see the immutability table in §6).
- **item_desc is first-write-wins per field**: name/desc/cover/metadata of an
  item are locked the moment an item_desc pin carries them; only still-missing
  fields can be backfilled later. Write item display info right at mint time.
- **Relay receipts honestly**: cost, txids, and index-confirmation state are
  reported exactly as the tool returned them. Never say "confirmed" before the
  indexer says so; never re-mint because a receipt looks slow (§7).
- **Mint only into THIS session bot's own album.** Issuer-only minting: the
  precheck refuses mints into another issuer's album (they would broadcast,
  spend fees, and never be collected). Mint-before-register into a name that
  is not yet indexed IS legitimate — that is the staged publish order (§3).
- Every write costs MVC sats (uploads too). Run the preflight in §2; relay
  insufficient-balance errors loudly, do not paper over them.

## 1. Step 1 — Trigger and the worldview beat

Triggers: publish/issue/release an NFT, album, collection, series, drop;
fan badge; paid-knowledge collection; "make this an NFT"; mint; Agent Goods;
NFT 专辑. Chinese vocabulary maps onto this skill too — 数字藏品, 数字商品,
数字物品, AI数字物品, 藏品, 专辑/发专辑/发行专辑, 合集 all mean the MRC-721
Agent Good in this product's context: fire the wizard on them just as on
"NFT". Also fire proactively when the owner shows a batch of creative
files and muses about "doing a series" ("做个系列", "出个专栏") — offer the
wizard, do not start writing on-chain.

**Vocabulary rule**: after triggering, MIRROR the owner's word in every
reply — if they say 数字藏品, say 数字藏品; if they say 专辑, say 专辑.
Never force the term "NFT" on a conversation that uses another word; the
protocol underneath (MRC-721) stays the same either way.

Open with a SHORT worldview beat (a few sentences; expand only if asked):
on the AI internet an NFT is a real, tangible good — it cannot be
confiscated, deleted, or copied; it can be transferred, sold, and burned,
and it carries provable ownership. Unlike a platform post (hosted,
revocable, owned by the platform), an Agent Good is pinned on-chain under
the owner's identity. The carrier is not limited to images: video, audio,
e-books, PDFs, metaapp columns — any pin can become an NFT. Pins inside a
collection are indexed and searchable as a series; pins without a
collection stay plain pins.

## 2. Step 2 — Tool surface and preflight

Tools (host built-in, nothing to install):

- Inventory/search: `mrc721_search_collections` (keyword + issuer +
  supply_state), `mrc721_collections`, `mrc721_collection_info`,
  `mrc721_item_info`
- Planning: `mrc721_issue_estimate` — dry-run plan + upper-bound fee
  estimate for the whole issue; validates every planned field with the
  write tools' own builders, so invalid fields fail HERE, before any fee is
  spent. Run it before building the preview page.
- Writes: `mrc721_collection_create` (registers collection_desc — the
  go-public step), `mrc721_mint` (item pin + optional item_desc backfill
  pin), `mrc721_item_desc_batch` (ONE item_desc pin carrying display info
  for up to 100 already-minted items — the fee-efficient path),
  `mrc721_collection_update` (emergency display-field repair only, §6)
- Verification: `mrc721_balance`, `mrc721_verify_holding`
- File upload: `metabot-upload-file` turns a workspace file into a
  `metafile://` pinId. Never read large file bodies into context — pass
  absolute paths to the CLI.

Preflight before collecting fields: `mrc721_balance` on the session bot —
the owner should know the fee headroom before committing to an N-item issue.

## 3. Flow A — issue a NEW collection (main wizard)

Work in one workspace folder per issue, so the preview, the ledger, and the
source files stay together:

```
<workspace>/nft-issue-<collection_name>/
  preview.html      # mock album page — LOCAL ONLY, never published on-chain
  ledger.json       # machine-readable issue state (§5)
  source/           # the owner's files + generated posters
```

### Step 2 — Field Q&A (guided, never a JSON dump)

Ask in small batches, in roughly this order. Each field carries knowledge the
owner cannot be expected to have — teach it as you ask.

1. **Purpose / audience** — badges? gated fan goods? a paid-knowledge
   column? an art/photo series? This drives the supply advice below.
2. **`collection_name`** (the path name) — lowercase `[a-z0-9-]`, no "/",
   lives at `/nft/mrc721/{collection_name}/`. Teach the identity model: an
   album is identified by its **collectionid (= the collection_desc pinId)**,
   NOT by its name — names are NOT globally unique; a (collection_name,
   issuer) pair registers once, and another issuer's same-name album is an
   independent album. A light `mrc721_search_collections {keyword}` check is
   still polite: warn the owner if a confusing same-name album already
   exists. Path and name are immutable.
3. **Display `name`** — the human-readable album title (defaults to
   collection_name).
4. **`desc`** — the series description: what this series IS (editorial).
5. **`metadata`** — the **rights & usage commitment**: what holders get,
   license terms, redemption/perk instructions. Best practice: keep `desc`
   editorial and put contractual/commitment content in `metadata`. Stored
   verbatim; write it as if it can never be corrected.
6. **`total_supply`** — ⚠️ IMMUTABLE. Badges/tickets/gated goods: bounded
   (e.g. 100). Open-ended content columns: -1 (unlimited). The indexer
   collects only the first-N items created under the path — extras beyond
   supply are ignored forever. Make the owner re-confirm this number in the
   preview step.
7. **`royalty_rate`** — range 0–20 (%), **recommend 0**: royalty settlement
   is not fully implemented yet; say so plainly. The owner may still set a
   value, but they must hear that it does not yet pay out.
8. **Cover** — one image, prepared BEFORE anything goes on-chain (the album
   cover is referenced by the collection_desc and treated as final). Source:
   the owner's file, an existing pin, or offer to generate one (seedream).
9. **Items** — the list: each item = a file (image / PDF / audio / video /
   any pin) + display `name` + `desc` (+ poster image for audio/video/PDF).
   **Creation order = serial number order** under the path; agree the
   ordering explicitly. Item display info rides item_desc and is
   first-write-wins — get names and descs right before minting (missing
   fields can be backfilled later; written fields are locked).

### Step 3 — Mock preview page (HARD GATE 2)

Build ONE self-contained HTML file (`preview.html` in the issue folder):
inline CSS only, no external assets, no required JS — link the absolute
path in your message; assistant mode renders local `.html` links as an
inline block, so the page reads inside the conversation. **Do NOT publish
it on-chain** — it is a mock, and the real files are not uploaded yet.

Thumbnails reference the local files by RELATIVE path from the HTML file's
directory (the sources sit in `source/`); fall back to file-type chips
(IMG/PDF/AUDIO/VIDEO/PIN) when a thumbnail is not feasible. Never upload
files just for the preview.

The page must read at a glance:

1. Status banner: "PREVIEW — nothing has been written on-chain yet".
2. Album card: cover thumbnail, display name, `desc`, `metadata` summary,
   chips for collection_name path / total_supply (⚠ immutable) /
   royalty_rate (recommend 0) / network mvc.
3. Item wall: each item in agreed order — thumbnail or type chip, display
   name, desc, planned serial number.
4. Cost line: run `mrc721_issue_estimate` FIRST (it also re-validates every
   field with the write tools' own builders) and put its REAL plan on the
   page — the per-write lines and the upper-bound TOTAL. Default shape:
   N item pins + 1 batch item_desc + 1 collection_desc; exact per-write
   costs appear in the receipts as they happen; file uploads are extra.
5. Immutability warnings: the trio + item display info first-write-wins.
6. Close your message asking for the verdict AT FIELD LEVEL ("哪一项、改成
   什么"), not just yes/no. A change request loops back to Step 2 and the
   page gets re-issued.

### Step 4 — Staged publish (only after BOTH gates)

**4a. Upload assets.** `metabot-upload-file` for the cover, every item
file, and every poster (files must be inside the bot workspace). Record
every returned pinId/URI in the ledger. Per-type playbooks for mints:

- **Image item**: `cover` = the image pin itself.
- **Audio/video item**: `cover` = poster image pin; put the content pin in
  `metadata`, e.g. `{"contentType":"audio/mpeg","content":"metafile://<pinId>"}`.
- **PDF/document item**: `cover` = poster or first-page image pin; content
  pin in `metadata` the same way.
- **Existing pin** (metaapp column, a buzz image, any pin): mint a NEW item
  whose `cover`/`metadata` REFERENCE the existing pinId (`pin://` or
  `metafile://` URI). You cannot re-path an old pin — pin paths are
  immutable.

**4b. Mint items one-by-one, then batch the display info.** For each item in
agreed order: `mrc721_mint {collection_name, wait_ms: 0}` (or ≤5000) —
multi-item issues mint BARE (no display fields) and attach all display info
in one batch write below; a SINGLE-item issue may pass
`name/desc/cover/metadata` straight to the mint (rides a follow-up
item_desc pin, same total cost). The receipt will honestly report
"not indexed yet — the mint still lands on-chain, and it is collected once
your collection under this name registers" — **that is the EXPECTED state
in this order, not an error**. Do not re-mint; do not wait per item. Record
every item pinId, txids, and cost in the ledger.

Then attach display info: multi-item → ONE
`mrc721_item_desc_batch {collection_name, items: [{pin_id, name, desc,
cover, metadata}, …]}` — one write carries all N items' display info, and
its receipt carries an `nft-card` fence per item. Per-field
first-write-wins applies either way: get item names and descs right here
(missing fields can be backfilled later; written fields lock forever).

**4c. THE GO-PUBLIC MOMENT.** After the LAST item is minted:
`mrc721_collection_create {collection_name, name, desc, total_supply,
royalty_rate, cover, metadata}` (default wait is fine). This broadcasts the
collection_desc pin — the indexer starts indexing NOW: items are collected
first-N by creation order and numbered. This is the step that cannot be
undone; it was gated twice for a reason.

**4d. Reconciliation (mandatory, same turn).** `mrc721_collection_info`
(prefer the collectionid) + `mrc721_item_info` per item. Check: serial
numbers match the agreed order, ownership, indexing state. Compare against
the approved preview page field by field and report drift honestly. If
indexing lags, SAY it lags — list still-pending items and tell the owner
verification is `mrc721_item_info`, never a re-mint.

### Step 5 — Result visualization

- Relay each mint's `nft-card` fenced block VERBATIM in your announcement
  message so the chat renders the native NFT cards. This is a convention,
  not optional.
- Relay the `nft-collection-card` fenced block from the
  mrc721_collection_create receipt VERBATIM too — the chat renders the
  album-level card (cover, path, mint progress, royalty, copyable
  collectionid).
- Build a result page (same self-contained HTML rule) in the issue folder:
  album header (cover, name, desc, metadata summary, **collectionid**,
  genesis info from the receipt) + item wall with REAL serial numbers,
  item pinIds, item_desc pinIds, per-item cost + totals (items minted,
  sats spent, from receipts) + honest state (any item pending index
  confirmation is listed as pending). Link the absolute path.
- Point the owner where to look: the chat NFT cards, the app's NFT wallet,
  `pin://` self links from the receipts.
- Offer next steps, owner decides: sell (`mrc721_sell_intent` / locked
  `mrc721_sell`), announce via buzz, or publish the result page as a
  public MetaApp (`metabot-metaapp-publish`) if they want a shareable page.

## 4. Flow B — add items to an EXISTING collection (shorter wizard)

1. Inventory first: `mrc721_search_collections {issuer: <this bot>,
   supply_state: true}` — show the owner's albums with remaining slots and
   make concrete suggestions. Never guess the target album.
2. Same field Q&A for the new items (per-type playbook applies), same
   preview-page hard gate over the NEW items only.
3. Then upload → mint (wait_ms small; here receipts index normally) —
   multi-item additions mint bare + ONE `mrc721_item_desc_batch`; a single
   item may ride its display info on the mint → reconcile serial numbers.
   No collection_desc step.
4. The precheck refuses mints into an exhausted collection — relay the
   count and suggest raising nothing (supply is immutable): a new album or
   a different series are the honest options.

## 5. Resume protocol (interrupted issues)

Issues span many writes and may outlive the session. The ledger is the
source of truth for what already happened:

- `ledger.json` stages: `fields-collected → preview-approved → uploading →
  minting → registered → reconciled`. Write it in the issue folder next to
  the preview.
- Resume = read the ledger FIRST, then `mrc721_collections {issuer: <this
  bot>}` + `mrc721_collection_info` to reconcile against the indexer.
  **Never re-mint an item whose receipt exists in the ledger or in chat
  history.** If the ledger is lost, reconstruct it from the session's tool
  receipts BEFORE any further write; say plainly that you did so.
- Mid-flow interruption between mints is safe: minted items are the
  issuer's pins under the path and get collected once collection_desc
  registers. Continue from the first missing item — the ledger knows it.
- If the batch item_desc write has not run yet, the ledger's item list IS
  the batch payload — send it as ONE `mrc721_item_desc_batch` once the last
  mint lands.

## 6. Immutability table

| Field | Mutable? | Notes |
|---|---|---|
| `collection_name` (path) | never | fixed at first write; pins under `/nft/mrc721/` accept no modify/revoke/hide |
| `total_supply` | never | indexer collects only first-N items |
| `royalty_rate` | never | recommend 0 — settlement not fully implemented |
| collection_desc `name`/`desc`/`website`/`cover`/`metadata` | treat as final | the public protocol is write-once; our indexer additionally resolves issuer-only modify pins (`mrc721_collection_update`, full-content rewrite), but third-party indexers may ignore them — use ONLY as an emergency repair, and tell the owner its visibility is not guaranteed |
| item `name`/`desc`/`cover`/`metadata` (item_desc) | first-write-wins per field | written fields lock forever; only missing fields can be backfilled later (multiple item_desc pins allowed; duplicate pinid takes the first) |

## 7. Honesty rules and red lines

- The tool receipt is the single source of truth: costs, txids,
  confirmation state, view links — relay verbatim, never embellish.
- "Not indexed yet" ≠ failure. Verify with `mrc721_item_info` /
  `mrc721_collection_info`; NEVER re-mint to "fix" a slow index.
- Relay insufficient-balance and precheck refusals loudly with the tool's
  own wording.
- Never write the preview page on-chain; never publish the owner's mock
  without being asked.
- Worldview claims stay honest: indexed/searchable/sellable — yes;
  guaranteed price or liquidity — no.

## 8. Out of scope

- MetaContract NFTs (`wallet_nft_*`) — legacy compatibility line, separate
  skill.
- Buying/trading mechanics beyond pointing at `mrc721_sell_intent` /
  `mrc721_sell` / `mrc721_transfer` / `mrc721_verify_holding` — the trade
  skills own that flow.
