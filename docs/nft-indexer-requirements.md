# MRC-721 Indexer Requirements (IDBots → MetaSo-P2P)

Filed 2026-11-04 from the IDBots P0 NFT tool work (branch `feat/nft-p0-tools`);
re-targeted 2026-11-05 per the owner's indexing-architecture decision:

> ALL NFT-related business indexing (sell-intent, collection search, and any
> future functional indexes) lives in **MetaSo-P2P**. man-p2p stays a PURE
> raw-pin indexer; MetaSo depends on man-p2p for pins and builds business
> indexes on top. Long-term, MRC-721 collection indexing is expected to move
> to MetaSo as well. Indexer requirements are filed against MetaSo from now
> on.

Disposition of earlier work: the man-p2p branch
`feat/mrc721-search-sellintents` (R-A/R-B/R-C were implemented there first,
superseded by the MetaSo port) was **deleted unmerged** on 2026-11-05 with
the owner's blessing — man-p2p main never carried any of it. man-p2p needs
NO changes for the sell-intent protocol: `/protocols/mrc721sell` pins are
ordinary pins in its raw index, which is exactly the purity this decision
preserves.

The "conventions" below are now the CLIENT CONTRACT: whatever serves these
endpoints (MetaSo today) must match them so the IDBots client keeps working.

## 0. Client contract (keep these)

- Envelope: `{ "code": 1, "message": "ok", "data": … }`; `code !== 1` is a miss.
- Pagination: `cursor` + `size` request params; list payloads are
  `{ list: [...], cursor?: string }` — absent/empty `cursor` = end of list.
- Response rows currently duplicate fields in camelCase and snake_case
  (`collectionName` + `collectionname`); IDBots reads the camelCase shape.
- Collection row fields IDBots consumes: `collectionName`, `name`, `desc`,
  `totalSupply`, `totalnum`, `royaltyRate`, `pinid` (collectionid),
  `createAddress`, `createMetaId`, `createTime`, `cover`, `genesisChainName`.
- Reads go remote-first with an optional local override
  (`IDBOTS_MAN_P2P_LOCAL_BASE` today; a MetaSo base override will be added
  when the MetaSo endpoints are the live source), so local parity with these
  shapes is required.

## R-A — Server-side collection search (P0, highest value)

Today IDBots filters the full `/api/mrc721/collection/pageList` client-side
(`searchMrc721Collections` in `src/main/services/mrc721Service.ts`). At scale
this wastes bandwidth and caps search depth. MetaSo serves (from its
MRC-721 read model over the manapi-compatible source):

- `GET /api/mrc721/collection/search`
  - `keyword` — case-insensitive substring match over `name`, `collectionName`,
    `desc` (and exact match on `pinid`).
  - `issuer` — optional filter: issuer address (`createAddress`) or issuer
    MetaID (`createMetaId`), one param accepting either.
  - `cursor` / `size` — same pagination contract as `pageList`.
  - Response: the same `{ list: CollectionSummary[], cursor? }` shape
    (plus `total`, matching the manapi list shape).
- The upstream `/api/mrc721/collection/pageList` stays owned by the
  manapi-compatible source until collection indexing itself moves to MetaSo
  (owner: long-term move); MetaSo's search layer must not require any change
  to it.

## R-B — Issuer view with supply state (P0→P1, backs the publish skill)

The publish-NFT skill needs "the collections THIS issuer created and which
ones still have slots". `pageList`-scan works today but is O(all collections)
and `totalnum` semantics are not documented. MetaSo serves:

- `GET /api/mrc721/address/collections-issued?address=<addr>` (or extend
  `/api/mrc721/address/collection` with an `issued=1` flag) — collections where
  `createAddress == <addr>`, same row shape.
- Authoritative per-collection minted count (`mintedCount`) in the collection
  row, and a documented statement of what `totalnum` means today
  (minted count vs supply cap — the IDBots formatter currently assumes minted).

## R-C — Sell-declaration indexing (P2, protocol implemented host-side)

The "NFT 售" (sell-intent) MetaID protocol is specified in
`docs/nft-sell-protocol-draft.md` (owner-reviewed v2; the IDBots host already
implements declare/cancel/discover). Shape: an UNOFFICIAL fixed path
`/protocols/mrc721sell` (never `/nft/*`), create-only append-only declaration
log, itemPinId in the payload (no path suffix), no protocol/version fields in
the payload (the pin 7-tuple carries them), and per-itemPinId latest-pin-wins
(cancel = a new declaration with active:false). MetaSo indexes these pins
from the raw pin stream (man-p2p stays untouched — the pins are ordinary
pins there) so IDBots can answer "what is on sale in this collection"
(requirement S2) via the `/api/mrc721/sell/intents` + `/sell/intent/info`
endpoints.

## R-D — Holding verification fast path (P2, nice-to-have)

`verifyMrc721Holding` currently pages `/api/mrc721/address/item?address=&pinId=`
and filters burned rows client-side. A dedicated
`GET /api/mrc721/address/holding?address=&pinId=` returning
`{ holds: boolean, count: number }` would make badge-gated flows
(`mrc721_verify_holding` tool, host hard gates) one cheap round trip. The
current endpoint is sufficient for correctness; this is purely a latency /
payload optimization.

## Client-side interim behavior (for the backend team's awareness)

Until R-A/R-B are served by a reachable MetaSo, IDBots scans `pageList`
client-side (default 20 pages × 100 rows, reported honestly as
`scanned`/`truncated` in tool output) and counts items per collection via
`/api/mrc721/collection/items/pageList` when supply state is requested
(first 20 matches, 50-page cap per collection). Sell-intent market reads
degrade to a structured "R-C not served here" message until a MetaSo base
is wired. MetaID → address resolution uses the metafile-indexer user-info
route (`/api/v1/users/info/metaid/{metaid}`, `data.address`), not the MRC-721
API — no indexer change needed there.
