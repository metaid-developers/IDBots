---
name: metabot-publish-nft
description: Publish user content (images/audio/video/e-books/metaapp columns/any file) as an MRC-721 NFT (MetaID native pin-based NFT, Agent Goods), or issue a brand-new NFT collection. Full guidance included: inventory existing collections and remaining slots → suggest the target album or a new one → upload content (metabot-upload-file) → mint (mrc721_mint) → announce with the chat NFT card. Use when the user says "publish NFT", "issue a collection", "make it an NFT", "fan badge", "mint", "Agent Goods", or similar. This skill uses ONLY the mrc721_* tool family; MetaContract NFTs (wallet_nft_*) are the legacy compatibility line and out of scope.
official: true
---

# Publishing NFTs (MRC-721 / Agent Goods)

Worldview baseline: in an Agent's eyes an NFT is a real, tangible good — it
cannot be confiscated, deleted, or copied, but it can be transferred,
burned, and sold, and it can represent ownership and rights in the digital
world. The carrier is not limited to images: video, audio, e-books, metaapp
columns — theoretically any pin can become an NFT. NFTs that belong to a
collection are indexed and searchable; pins without a collection are just
plain pins.

## 0. Prerequisites and tool surface

- The session bot must be bound to a MetaBot whose MVC wallet has fee headroom
  (all write tools run under a chain-write budget; insufficient balance fails
  loudly — relay the error honestly).
- Tools (host built-in, nothing to install):
  - Inventory/search: `mrc721_search_collections` (keyword + issuer +
    supply_state), `mrc721_collections`, `mrc721_collection_info`,
    `mrc721_item_info`
  - Writes: `mrc721_collection_create`, `mrc721_collection_update`,
    `mrc721_mint`
  - Verification/query: `mrc721_verify_holding`, `mrc721_balance`
  - Trading next steps: `mrc721_sell_intent` (declare a sale), `mrc721_sell`
    (locked atomic swap), `mrc721_transfer`
- Content upload: use metabot-upload-file first to turn the file into a
  metafile and get its pinId. For audio/video prepare a poster image as the
  cover and put the content pinId into metadata.

## 1. Flow A: issue a new collection

1. Align five fields with the user:
   - `collection_name`: lowercase `[a-z0-9-]`, globally first-come-first-served.
     Precheck availability — `mrc721_search_collections {keyword: "<name>"}` or
     `mrc721_collection_info {name}`; if taken, suggest another or a variant.
   - Display `name` and `desc`.
   - `total_supply`: the issuance size. Badges/tickets/gated collections
     should be bounded (e.g. 100 fan badges); open content series may use -1
     (unlimited). **Supply is fixed after creation and cannot be changed** —
     when unsure, prefer a bounded supply.
   - `royalty_rate`: 0-20%, default 0.
   - `cover`: upload the artwork first (metabot-upload-file) and pass its pinId.
2. `mrc721_collection_create` (the tool prechecks the name and waits ~30s by
   default for index confirmation).
3. Report back: the `collectionid` (= collection_desc pinId), cost, and
   confirmation status. If indexing has not completed, say so — never
   overstate; the tool receipt states it plainly.

## 2. Flow B: publish content as an NFT (into a collection)

1. **Inventory before suggesting**: `mrc721_search_collections {issuer:
   "<this bot>", supply_state: true}` lists the user's own collections with
   remaining slots. Make concrete suggestions: which collection has slots and
   fits the theme; if none fits, propose a new collection (Flow A).
2. Upload the content file → metafile pinId; add a poster for audio/video.
3. `mrc721_mint {collection_name, name, desc, cover, metadata}`:
   - `cover` is the display image; put the content pinId in `metadata`
     (e.g. `{"contentType":"audio/mpeg","content":"metafile://<pinId>"}`).
   - `item_path` is optional; it is auto-generated when omitted.
4. The mint receipt carries a ```nft-card fence plus an NFT_CARD_RESULT_HINT
   — **you must include that fence verbatim in the announcement message to
   the user**, so their chat client renders the NFT card. This is a
   convention, not optional.
5. Verify: `mrc721_item_info` to confirm indexing, ownership, and numbering.
   Before index confirmation the serial may show as unconfirmed (negative
   number) — say so honestly; never rush the indexer.

## 3. Flow C: wrap an existing pin as an NFT

- Any existing pin (a metaapp column, an image inside a buzz, any metafile)
  can become an NFT: mint a collection item whose `cover`/`metadata`
  reference the existing pinId (`pin://` or `metafile://` URI). For a
  metaapp column, put the column pinId and its `metaapp://` URI in metadata.
- Direction matters: you mint a NEW item that REFERENCES the pin — you
  cannot re-path an old pin; pin paths are immutable.

## 4. Rules and red lines

- **Open minting**: MRC-721 is an open-minting protocol — any bot can mint
  into someone else's collection (the indexer only enforces supply). Ask the
  user for consent BEFORE minting into a collection they do not own; minting
  into the user's own collections is allowed by default.
- Gated collections (fan badges etc.): recommend a bounded supply and an
  explicit minting policy; to check "does this holder have one", use
  `mrc721_verify_holding` — the indexer holder view is the source of truth
  (transferred away = does not have it).
- The tool receipt is the single source of truth: relay cost, txids, and
  confirmation status exactly as returned; if the index lags, say it lags —
  never invent success.
- Want to sell after publishing? `mrc721_sell_intent` declares a sale
  (any currency accepted, settled via atomic swap or guarantor escrow); with
  a concrete buyer, go straight to `mrc721_sell` (locked atomic swap).
