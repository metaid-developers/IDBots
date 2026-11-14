---
name: metabot-publish-nft
description: >-
  Guided MRC-721 NFT issuance wizard (MetaID native, pin-based Agent Goods — NOT the metacontract wallet_nft_* legacy line). Use when the owner wants to publish NFT content — "publish an NFT", "issue/release a collection/album/series/drop", "make this an NFT", "fan badge", "mint", "paid-knowledge collection", "NFT 专辑", "专辑", "发专辑", "发行专辑", "数字藏品", "数字商品", "数字物品", "AI数字物品", "藏品", "合集", "上链一张图/一个作品", or asks what NFTs (数字藏品/数字商品) can do here — in this product's context ALL these Chinese words mean the same thing, the MRC-721 Agent Good. You walk the owner through: worldview intro → guided field Q&A → a LOCAL mock-preview page (hard gate) → staged on-chain publish (items first, collection_desc LAST) → a visual result page. Also covers adding items to an existing collection and resuming an interrupted issue.
official: true
version: 2.2.0
---

# Publishing NFTs (MRC-721 / Agent Goods) — guided issuance wizard

This skill is a **guided wizard, not a tool dump**. The owner expresses intent
("I want to release an NFT album"); you carry them to a correctly published,
visually confirmed result. Issuance is **irreversible** — your job is to make
it smooth AND correct: nothing goes on-chain that the owner has not seen,
understood, and confirmed. Never leave the owner holding an on-chain object
they did not mean to create.

## 0. Non-negotiables

- **Visibility rule (assistant mode)**: the owner sees ONLY two things —
  `owner_update` bubbles and the FINAL reply of each turn. Text you write
  mid-turn (before or between tool calls) folds into hidden thinking: a link
  or question placed there is NEVER seen. Anything the owner must look at or
  decide on — above all the preview page — goes into the reply that ENDS the
  turn.
- **Hard gate 1 — fields**: no write tool call until every field below is
  collected and confirmed in prose.
- **Hard gate 2 — preview**: no write tool call (uploads included) until the
  owner has seen the mock preview page and confirmed it **in a typed reply**.
  - Deliver the page as the ending reply of the turn (link + short summary +
    "reply 确认 or name the field to change") and STOP. The owner's next
    message is the verdict.
  - Never put this gate in `ask_user_question` or any choice card — a card
    answers in one click and invites confirming a page the owner never
    opened (the 2026-11-08 test confirmed an unseen preview in 25 seconds).
    Never offer a pre-selected or "(Recommended)" approval for an
    irreversible write.
  - The only escape is the owner's explicit instruction to skip the page in
    THIS conversation — say plainly that you relied on it.
- **Immutable trio**: `collection_name` (the path), `total_supply`,
  `royalty_rate` are fixed forever once registered. Treat the whole
  `collection_desc` as write-once (see the immutability table in §6).
- **item_desc is first-write-wins per field**: name/desc/cover/metadata of an
  item are locked the moment an item_desc pin carries them; only still-missing
  fields can be backfilled later. Write item display info right at mint time.
- **Zero-confirmation delivery**: a broadcast IS the result. Never wait,
  poll, or `sleep` for block confirmation — MVC blocks can take 10-30
  minutes and nothing about the issue depends on them. Deliver as
  "on-chain, pending block" and move on.
- **Relay receipts honestly**: cost, txids, and index state are reported
  exactly as the tool returned them ("pending block" is a state, not a
  failure). Never re-mint or re-issue because the index looks slow (§7).
- **Mint only into THIS session bot's own album.** Issuer-only minting: the
  precheck refuses mints into another issuer's album (they would broadcast,
  spend fees, and never be collected). Mint-before-register into a name that
  is not yet indexed IS legitimate — that is the staged publish order (§3).
- Every write costs MVC sats (uploads cost the most). Run the preflight in
  §2; relay insufficient-balance errors loudly, do not paper over them.

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
  `mrc721_item_info` — the two info tools report "ON-CHAIN, PENDING BLOCK"
  for a just-broadcast pin instead of "not found"
- Planning: `mrc721_issue_estimate` — dry-run plan + upper-bound fee
  estimate for the whole issue, uploads included when you pass
  `upload_files`; validates every planned field with the write tools' own
  builders, so invalid fields fail HERE, before any fee is spent. Run it
  before building the preview page.
- Writes: `mrc721_collection_create` (registers collection_desc — the
  go-public step), `mrc721_mint` (item pin + optional item_desc backfill
  pin), `mrc721_item_desc_batch` (ONE item_desc pin carrying display info
  for up to 100 already-minted items — the fee-efficient path),
  `mrc721_collection_update` (emergency display-field repair only, §6)
- Holdings: `mrc721_balance` (NFTs held), `mrc721_verify_holding`
- Funds: `wallet_balance`
- File upload: `metabot-upload-file` turns a workspace file into a
  `metafile://` pinId. Never read large file bodies into context — pass
  absolute paths to the CLI.

Preflight before collecting fields: `wallet_balance` on the session bot —
the owner should know the fee headroom before committing to an N-item issue.
(`mrc721_balance` lists NFT holdings, not funds.) `mrc721_issue_estimate`
later prices the whole plan against this balance.

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
   Mint in the agreed order and keep it in the ledger. Do NOT promise
   "mint order = serial number" yet: the MetaSo indexer currently numbers
   mint-before-register items by pinId order (requirement R-F-10, fix
   pending). Say the numbers are assigned by the index after registration.
   Item display info rides item_desc and is first-write-wins — get names
   and descs right before minting (missing fields can be backfilled later;
   written fields are locked).

### Step 3 — Mock preview page (HARD GATE 2)

Build ONE self-contained HTML file (`preview.html` in the issue folder):
inline CSS only, no external assets, no required JS. **Do NOT publish it
on-chain** — it is a mock, and the real files are not uploaded yet.

**Images**: write plain RELATIVE `<img src>` paths to the local sources
(`source/frame_1.jpg`). The host inlines local images that sit inside the
issue folder when it renders the page in the chat, so they show up. Do NOT
use `metafile://` (no browser can load it) or absolute `file://` paths. Keep
item files that are not images as type chips (IMG/PDF/AUDIO/VIDEO/PIN).
Never upload files just for the preview.

The page must read at a glance:

1. Status banner: "PREVIEW — nothing has been written on-chain yet".
2. Album card: cover thumbnail, display name, `desc`, `metadata` summary,
   chips for collection_name path / total_supply (⚠ immutable) /
   royalty_rate (recommend 0) / network mvc.
3. Item wall: each item in agreed mint order — thumbnail or type chip,
   display name, desc.
4. Cost line: run `mrc721_issue_estimate` FIRST, with `upload_files` set to
   EVERY file you will upload (cover, item files, posters) — it re-validates
   every field with the write tools' own builders and prices the uploads,
   which usually dominate. Put its REAL numbers on the page: protocol
   writes, file uploads, the upper-bound TOTAL, and the wallet line. If the
   wallet line says INSUFFICIENT, stop and tell the owner before the gate.
5. Immutability warnings: the trio + item display info first-write-wins.

**Delivering the gate** (see the visibility rule in §0): the turn ENDS with
a reply that carries the page link
(`[预览 · <album>](file:///…/preview.html)` — assistant mode renders it
inline), a three-line summary (album / N items / total cost vs balance), and
the ask for a verdict AT FIELD LEVEL ("回复「确认」开始上链，或直接说哪一项、改成
什么"). No choice card. The owner's next typed message is the verdict; a
change request loops back to Step 2 and the page gets re-issued the same
way.

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
agreed order: `mrc721_mint {collection_name, wait_ms: 0}` —
multi-item issues mint BARE (no display fields) and attach all display info
in one batch write below; a SINGLE-item issue may pass
`name/desc/cover/metadata` straight to the mint (rides a follow-up
item_desc pin, same total cost). The receipt reports "not in the NFT index
— EXPECTED": the mint is on-chain (zero-confirmation) and is collected once
your collection registers and its block lands. Do not re-mint; do not wait.
Record every item pinId, txids, and cost in the ledger.

Then attach display info: multi-item → ONE
`mrc721_item_desc_batch {collection_name, items: [{pin_id, name, desc,
cover, metadata}, …]}` — one write carries all N items' display info, and
its receipt carries an `nft-card` fence per item. Per-field
first-write-wins applies either way: get item names and descs right here
(missing fields can be backfilled later; written fields lock forever).
`metadata` may be an object; the tool writes it as a JSON string, the form
indexers parse.

**4c. THE GO-PUBLIC MOMENT.** After the LAST item is minted:
`mrc721_collection_create {collection_name, name, desc, total_supply,
royalty_rate, cover, metadata, wait_ms: 0}`. This broadcasts the
collection_desc pin — the issue is now public and irreversible; it was
gated twice for a reason. The NFT index folds the album and numbers the
items once the block confirms.

**4d. Read-back (ONE pass, no waiting).** Right after 4c, once:
`mrc721_collection_info {pin_id: <collectionid>}`. Two outcomes, both
final for this turn:

- **"ON-CHAIN, PENDING BLOCK"** (the usual case): the tool read the pin
  straight from the chain. Compare its content against the approved preview
  field by field (name, desc, total_supply, royalty_rate, cover, metadata)
  and report drift honestly. Serial numbers and mint counts do not exist
  yet — say they appear after the block.
- **Indexed**: also check every item with `mrc721_item_info` (ownership,
  display fields) and report the numbers the index assigned.

**Never `sleep`, poll, or re-check in a loop.** If the owner wants the
numbers later, they ask, or a later turn reads them. The block wait is not
part of the issue.

### Step 5 — Result visualization (the ending reply of the publish turn)

- Relay each mint's `nft-card` fenced block VERBATIM in your announcement
  message so the chat renders the native NFT cards. This is a convention,
  not optional.
- Relay the `nft-collection-card` fenced block from the
  mrc721_collection_create receipt VERBATIM too — the chat renders the
  album-level card (cover, path, mint progress, royalty, copyable
  collectionid).
- Build a result page (`result.html`, same self-contained HTML rule) in the
  issue folder: album header (cover, name, desc, metadata summary,
  **collectionid**) + item wall with item pinIds, per-item cost + totals
  (items minted, sats spent incl. uploads, from receipts) + honest state
  ("on-chain, pending block — numbers appear after confirmation" until the
  index has them).
  - Images on the result page use the on-chain HTTPS address of each
    uploaded file: `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/<pinId>`
    (bare pinId, no `metafile://`, no extension). Local relative paths also
    work and serve as the fallback.
- **Link ONLY the result page in the final reply.** Never link the preview
  page after the publish: assistant mode renders every linked local page
  inline, and a "PREVIEW — nothing on-chain yet" banner next to the
  delivery reads as a contradiction.
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
   preview-page hard gate over the NEW items only, delivered the same way
   (ending reply, typed verdict).
3. Then upload → mint (`wait_ms: 0`) — multi-item additions mint bare + ONE
   `mrc721_item_desc_batch`; a single item may ride its display info on the
   mint → one read-back pass (Step 4d rules, no waiting). No
   collection_desc step.
4. The precheck refuses mints into an exhausted collection — relay the
   count and suggest raising nothing (supply is immutable): a new album or
   a different series are the honest options.

## 5. Resume protocol (interrupted issues)

Issues span many writes and may outlive the session. The ledger is the
source of truth for what already happened:

- `ledger.json` stages: `fields-collected → preview-approved → uploading →
  minting → registered → reconciled`. Write it in the issue folder next to
  the preview. `registered` already means delivered (zero-confirmation);
  `reconciled` is optional, recorded once the index numbers the items.
- Resume = read the ledger FIRST, then `mrc721_collections {issuer: <this
  bot>}` + `mrc721_collection_info {pin_id}` to check the index (a pending
  block is a valid state, not a gap). **Never re-mint an item whose receipt
  exists in the ledger or in chat history.** If the ledger is lost,
  reconstruct it from the session's tool receipts BEFORE any further write;
  say plainly that you did so.
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

- The tool receipt is the single source of truth: costs, txids, index
  state, view links — relay verbatim, never embellish.
- "Not in the NFT index yet" ≠ failure: on MVC a broadcast pin is final;
  the index folds it after the block. NEVER re-mint or re-issue to "fix" a
  slow index, and never burn the turn waiting for it.
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

## Pin reference format (chain-write preflight)

Every pin reference you put into a chain-write payload — a `pin://`, `metafile://`, or `metaapp://` URI, or a JSON field named like a pin (`pinId`, `coursePinId`, `rootPinId`, …) — must be 64 lowercase hex characters followed by `i` and the output index; pins minted by this host always end in `i0` (e.g. `1e288800fdec1a5911a169e0cb499a3bc63e6083e5f035f5d552f73c601f2cf2i0`), while indexer-read foreign pins may end in `i1`, `i2`, … — copy that suffix verbatim. A 64-hex value WITHOUT the `i` suffix (e.g. `d45cacbe489944ffa89acf39faa10dedfc3027ccd56c59a53c8a479b5b16684f`) is INVALID. Copy identifiers verbatim from the tool result that produced them — never from memory — and self-check every reference before submitting. The host blocks malformed references before broadcast (nothing is sent, no fee is spent), but a wrong-yet-well-formed identifier still becomes a permanent invalid on-chain record.
