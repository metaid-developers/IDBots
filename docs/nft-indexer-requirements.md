# MRC-721 Indexer Requirements (IDBots → man-p2p / manapi)

Filed 2026-11-04 from the IDBots P0 NFT tool work (branch `feat/nft-p0-tools`).
Everything below describes what the IDBots host and its bots need from the
MRC-721 indexer (`manapi.metaid.io` today, man-p2p locally). Existing
conventions are stated first so new endpoints can match them exactly.

## 0. Existing conventions (keep these)

- Envelope: `{ "code": 1, "message": "ok", "data": … }`; `code !== 1` is a miss.
- Pagination: `cursor` + `size` request params; list payloads are
  `{ list: [...], cursor?: string }` — absent/empty `cursor` = end of list.
- Response rows currently duplicate fields in camelCase and snake_case
  (`collectionName` + `collectionname`); IDBots reads the camelCase shape.
- Collection row fields IDBots consumes: `collectionName`, `name`, `desc`,
  `totalSupply`, `totalnum`, `royaltyRate`, `pinid` (collectionid),
  `createAddress`, `createMetaId`, `createTime`, `cover`, `genesisChainName`.
- Reads go remote-first with an optional local man-p2p override
  (`IDBOTS_MAN_P2P_LOCAL_BASE`), so local parity with these shapes is required.

## R-A — Server-side collection search (P0, highest value)

Today IDBots filters the full `/api/mrc721/collection/pageList` client-side
(`searchMrc721Collections` in `src/main/services/mrc721Service.ts`). At scale
this wastes bandwidth and caps search depth. Add:

- `GET /api/mrc721/collection/search`
  - `keyword` — case-insensitive substring match over `name`, `collectionName`,
    `desc` (and exact match on `pinid`).
  - `issuer` — optional filter: issuer address (`createAddress`) or issuer
    MetaID (`createMetaId`), one param accepting either.
  - `cursor` / `size` — same pagination contract as `pageList`.
  - Response: the same `{ list: CollectionSummary[], cursor? }` shape.
- Keep `/api/mrc721/collection/pageList` unchanged (it stays the square view).

## R-B — Issuer view with supply state (P0→P1, backs the publish skill)

The publish-NFT skill needs "the collections THIS issuer created and which
ones still have slots". `pageList`-scan works today but is O(all collections)
and `totalnum` semantics are not documented. Add (or document):

- `GET /api/mrc721/address/collections-issued?address=<addr>` (or extend
  `/api/mrc721/address/collection` with an `issued=1` flag) — collections where
  `createAddress == <addr>`, same row shape.
- Authoritative per-collection minted count (`mintedCount`) in the collection
  row, and a documented statement of what `totalnum` means today
  (minted count vs supply cap — the IDBots formatter currently assumes minted).

## R-C — Sell-declaration indexing (P2, pending protocol approval)

The "NFT 售" (sell-intent) MetaID protocol is being drafted separately and
requires owner sign-off before it is proposed. Once approved, the indexer will
need to index sell-intent pins so IDBots can answer "what is on sale in this
collection" (requirement S2). Placeholder — do not implement before the
protocol draft is approved.

## R-D — Holding verification fast path (P2, nice-to-have)

`verifyMrc721Holding` currently pages `/api/mrc721/address/item?address=&pinId=`
and filters burned rows client-side. A dedicated
`GET /api/mrc721/address/holding?address=&pinId=` returning
`{ holds: boolean, count: number }` would make badge-gated flows
(`mrc721_verify_holding` tool, host hard gates) one cheap round trip. The
current endpoint is sufficient for correctness; this is purely a latency /
payload optimization.

## Client-side interim behavior (for the backend team's awareness)

Until R-A/R-B land, IDBots scans `pageList` client-side (default 20 pages ×
100 rows, reported honestly as `scanned`/`truncated` in tool output) and
counts items per collection via `/api/mrc721/collection/items/pageList` when
supply state is requested (first 20 matches, 50-page cap per collection).
MetaID → address resolution uses the metafile-indexer user-info route
(`/api/v1/users/info/metaid/{metaid}`, `data.address`), not the MRC-721 API —
no indexer change needed there.
