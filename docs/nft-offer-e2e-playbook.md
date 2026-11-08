# MRC-721 Open-Offer E2E Playbook (bot-executable)

Audience: IDBots MetaBots. Read this document fully, then execute ONLY the role
the owner assigned to you (SELLER or BUYER). Protocol background:
`docs/nft-offer-protocol.md`. Written 2026-11-08.

## What this test proves

The passive open offer works end to end on mainnet with no seller
cooperation: the SELLER signs one price-locked offer and goes offline; the
BUYER discovers it through the public market index, takes it alone, and the
item's owner resolves to the buyer. Free negative tests prove that tampered,
self-taken, and already-sold offers are refused before anything is signed. An
optional phase proves that cancelling really revokes the offer.

## Kickoff parameters (the owner gives these)

- `SELLER_BOT` — local MetaBot name of the seller.
- `BUYER_BOT` — local MetaBot name of the buyer.

The test collection is fixed: `idbots-offer-e2e`. The price is fixed:
`22000` sats.

## Rules for the executing bot (read before acting)

1. Use ONLY the tools named in your role. Do NOT use the `metabot-publish-nft`
   issue wizard — its confirmation gates are designed for humans.
2. Money-moving steps run ONCE each: collection create, mint, `mrc721_offer`,
   `mrc721_take_offer` (the real take), `mrc721_offer_cancel`. If one returns
   an error, do NOT retry blindly — a broadcast may have landed anyway. First
   re-read state (`mrc721_item_info`, `mrc721_offers`, `wallet_balance`), and
   retry only when the state proves nothing landed.
3. A negative test that broadcasts anything is an immediate FAIL: stop and
   report. Negative tests must end in a refusal with "Nothing was signed" or
   an equivalent refusal reason.
4. Never touch anything outside the test: never offer, take, transfer, or
   cancel an item that is not in collection `idbots-offer-e2e`, and never take
   an offer whose seller is not `SELLER_BOT`.
5. Confirmations take a block. Polling read-only tools about every 2 minutes
   is normal (use a shell `sleep 120` between polls if you have one). Each
   step lists its time limit; exceeding it = BLOCKED, report and stop.
6. Copy every pin id (`<64hex>i<n>`) and txid (64 hex) verbatim into your
   report. Never paraphrase ids.

## Phase 0 — Preflight (both roles, zero cost)

| Step | Call | Pass when |
|---|---|---|
| P0.1 | `mrc721_offers_market` with `size=5` | It returns a list or "No open offers match". FAIL if it says the index is not reachable. |
| P0.2 | `wallet_balance` for yourself | SELLER ≥ 15,000 sats spendable; BUYER ≥ 30,000 sats. Otherwise BLOCKED: report "FUNDING NEEDED" with your address. |

## SELLER role

| Step | Call | Pass when | Limit |
|---|---|---|---|
| S1 | `mrc721_search_collections` with `keyword=idbots-offer-e2e`, `issuer=<SELLER_BOT>` | If a collection is found, record `COLLECTION_PINID` and skip to S2. | — |
| S1b | (only if none) `mrc721_collection_create` with `collection_name=idbots-offer-e2e`, `name="IDBots Offer E2E"`, `total_supply=-1`, `desc="Test fixtures for the IDBots open-offer E2E playbook. No value."`, `wait_ms=120000` | A collection pinId is returned (record `COLLECTION_PINID`). Then poll S1 until it is found. | 30 min |
| S2 | `mrc721_mint` with `collection_name=idbots-offer-e2e`, `name="Offer E2E <UTC yyyy-mm-dd hh:mm>"`, `desc="E2E fixture"`, `wait_ms=120000` | An item pinId is returned → record `ITEM_1`. | — |
| S2b | poll `mrc721_item_info` with `pin_id=ITEM_1` | The owner is your own address. Record `ITEM_1_OUTPUT` (its current output). | 30 min |
| S3 | `mrc721_offer` with `item_pin_id=ITEM_1`, `price_sats=22000` | The receipt has an `nft-card` (listed), an offer pin, and an "Offer payload" JSON line. Record `OFFER_PIN_1` and `PAYLOAD_1` (the JSON line, verbatim). | — |
| S4 | NEGATIVE, self-take: `mrc721_take_offer` with `offer_payload=<PAYLOAD_1 verbatim>` | REFUSED (taking your own offer). FAIL and stop if it broadcasts. | — |
| S5 | `mrc721_offers` | The `ITEM_1` row is ACTIVE. | — |
| S6 | Emit `SELLER_REPORT` (template below) and STOP. You are now "offline": take no further action unless the owner explicitly starts Phase C. | — | — |

## BUYER role

You may start right after the seller, or at the same time; S1–S3 take a few
blocks, so B1 polls.

| Step | Call | Pass when | Limit |
|---|---|---|---|
| B1 | poll `mrc721_offers_market` with `seller=<SELLER_BOT>` | A `[LIVE]` row at `ask 22000 sats` appears. If several are LIVE, take the newest (highest height) whose item is in collection `idbots-offer-e2e` (check with `mrc721_item_info`). Record `ITEM_1` and the row's `pays <address>` as `SELLER_ADDRESS`. | 60 min |
| B2 | `mrc721_item_info` with `pin_id=ITEM_1` | The owner equals `SELLER_ADDRESS` and the collection is `idbots-offer-e2e`. | — |
| B3 | NEGATIVE, lying advertisement: `mrc721_offers_market` with `item_pin_id=ITEM_1`, `include_payload=true` → copy the payload JSON → change ONLY `"priceSats"` to `30000` → `mrc721_take_offer` with `offer_payload=<modified JSON>` | REFUSED (the signed output 0 does not match the advertised price). FAIL and stop if it broadcasts. | — |
| B4 | THE TAKE: `mrc721_take_offer` with `item_pin_id=ITEM_1` | A take txid and an `nft-card` (bought) come back. Record `TAKE_TX`. | — |
| B5 | poll `mrc721_item_info` with `pin_id=ITEM_1` | The owner flips to YOUR address (proves the indexer reads the delivery output, R-E-3). Then `mrc721_balance` for yourself lists `ITEM_1`. | 45 min |
| B6 | `mrc721_offers_market` with `item_pin_id=ITEM_1` | The row is `[DEAD]` ("left the offered outpoint"). | 10 min |
| B7 | NEGATIVE, re-take a sold offer: `mrc721_take_offer` with `item_pin_id=ITEM_1` | REFUSED (dead offer). FAIL and stop if it broadcasts. | — |
| B8 | Emit `BUYER_REPORT` and stop. | — | — |

## Phase C — Hard-cancel test (optional; the owner starts it after B8)

| Step | Role | Call | Pass when | Limit |
|---|---|---|---|---|
| C1 | SELLER | Mint `ITEM_2` exactly like S2, then poll as in S2b | Owner is the seller. Record `ITEM_2_OUTPUT_BEFORE` (current output). | 30 min |
| C2 | SELLER | `mrc721_offer` with `item_pin_id=ITEM_2`, `price_sats=22000` | Record `PAYLOAD_2` (verbatim JSON line). | — |
| C3 | SELLER | `mrc721_offer_cancel` with `item_pin_id=ITEM_2` | The receipt says "on-chain revocation: self-transfer <txid>" plus a closing declaration pin. Record `REVOKE_TX`. | — |
| C4 | SELLER | poll `mrc721_item_info` with `pin_id=ITEM_2` | The current output differs from `ITEM_2_OUTPUT_BEFORE` and the owner is still the seller. Emit `SELLER_REPORT_C` including `PAYLOAD_2`. | 45 min |
| C5 | BUYER (the owner pastes `PAYLOAD_2`) | NEGATIVE: `mrc721_take_offer` with `offer_payload=<PAYLOAD_2 verbatim>` | REFUSED — the ORIGINAL signed offer no longer completes. This is the proof that cancel revokes. FAIL if it broadcasts. | — |
| C6 | BUYER | `mrc721_offers_market` with `item_pin_id=ITEM_2` | No `[LIVE]` row. | 10 min |

## Expected cost

| Item | Approx. sats |
|---|---|
| Collection create (first run only) | 1,000–3,000 |
| Mint (each item, incl. display info) | 1,000–2,500 |
| Offer pin (carries the signed tx) | 1,000–2,500 |
| Take tx fee | 300–800 (+22,000 moved to the seller — it stays between your own bots) |
| Phase C: revoke tx + cancel pin | 1,000–3,000 |

Core run, net: about 5,000–10,000 sats. Including Phase C: about 10,000–16,000.

## Report templates

Copy, fill, and send as your final message. One `key: value` per line.

```
E2E_ROLE: SELLER
E2E_RESULT: PASS | FAIL | BLOCKED
SELLER_BOT: <name>
COLLECTION_PINID: <pinId>
ITEM_1: <pinId>
ITEM_1_OUTPUT: <txid:vout>
OFFER_PIN_1: <pinId>
S4_SELF_TAKE: REFUSED | BROADCAST (FAIL)
S5_OFFERS_ROW: ACTIVE | <other>
PAYLOAD_1: <verbatim JSON>
NOTES: <failures, refusal reasons, timings>
```

```
E2E_ROLE: BUYER
E2E_RESULT: PASS | FAIL | BLOCKED
BUYER_BOT: <name>
ITEM_1: <pinId>
SELLER_ADDRESS: <address>
DISCOVERY_WAIT_MIN: <minutes until the LIVE row appeared>
B3_LYING_AD: REFUSED (<reason>) | BROADCAST (FAIL)
TAKE_TX: <txid>
B5_OWNER_FLIPPED: YES after <minutes> | NO (BLOCKED)
B6_MARKET_ROW: DEAD | <other>
B7_RETAKE: REFUSED (<reason>) | BROADCAST (FAIL)
NOTES: <...>
```

```
E2E_ROLE: SELLER (Phase C)
ITEM_2: <pinId>
ITEM_2_OUTPUT_BEFORE: <txid:vout>
REVOKE_TX: <txid>
ITEM_2_OUTPUT_AFTER: <txid:vout>
PAYLOAD_2: <verbatim JSON>
```

```
E2E_ROLE: BUYER (Phase C)
C5_REVOKED_PAYLOAD: REFUSED (<reason>) | BROADCAST (FAIL)
C6_MARKET_LIVE_ROW: NONE | PRESENT (FAIL)
```

## Verdict

The open-offer line PASSES when: S3, B1, B4, B5, B6 pass; every NEGATIVE step
(S4, B3, B7, and C5 when run) is REFUSED; and C3–C4 show a real self-transfer
revoke. Any NEGATIVE that broadcasts is a release blocker — report it
immediately.
