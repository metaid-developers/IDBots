# IDBots NFT CA Protocol (v1 — APPROVED by owner 2026-11-05)

The trust root behind IDBots-certified MRC-721 collection badges (NFT
avatars). IDBots publishes ONE official registry pin on-chain; clients read
it to decide which collections carry the official certification mark.

## 1. Pin shape

- Path: `/protocols/idbots-nft-ca` — the unofficial `/protocols/` namespace
  (same decision as the MRC-721 sell-intent protocol: never `/nft/*`).
- Single registry pin: the registry is ONE canonical pin, updated over time
  via `modify` pins on the same path (full-content rewrite each time — a
  reader never needs to merge history).
- Read rule: **the latest pin on the path wins** (the standard MetaID
  read convention). History keeps every create/modify pin, but only the
  latest is ever authoritative — no ambiguity.
- Creator: the pin's on-chain creator MUST be the IDBots official identity
  (see §3). A same-path pin from any other creator is not the registry.

## 2. Content schema (the pin payload)

Per the house no-duplication principle, the payload carries NO
`protocol`/`version` fields — the pin 7-tuple's path and `version` field
already carry the protocol identity and version.

```json
{
  "collections": [
    {
      "collectionPinId": "<collection_desc pinid, 64hex>i<n>",
      "collectionName": "optional display name",
      "note": "optional free text (why it is certified)",
      "certifiedAt": 1793868000
    }
  ]
}
```

- `collectionPinId` is required and validated (`<64hex>i<n>`); entries
  without a usable value are dropped by clients.
- Everything else is advisory. `certifiedAt` is epoch SECONDS.
- Extension rule: future optional keys may be added; clients must ignore
  unknown keys. Breaking changes require a new pin path, not a payload flag.

## 3. Trust root (owner designation)

- Official identity: the MetaBot **"Bob"** — globalMetaId
  `idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47`, metaID
  `2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212`,
  MVC address `1BNesCuvJeW2DAF42xkyCU1ifZVuNZ61mv`.
- Official registry pin (issued 2026-11-05 by Bob, initially EMPTY — honest
  baseline until collections are certified):
  `77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0`.
- Client verification: resolve the latest pin's creator from the chain
  record and require an exact match with the official metaID. Badges render
  only when creator matches AND the collection is listed in the payload.

## 4. Client rules

- Never throw on registry problems: missing pin, network error, non-JSON
  body, bad schema, creator mismatch → empty or `verified:false` registry.
- Certification marks REQUIRE verified registry + listed collection. An
  uncertified NFT avatar may still be set; it just never gets the official
  mark.
- Process-lifetime caching with a short TTL (IDBots: 10 min) and an explicit
  refresh path is recommended; the registry changes rarely.
