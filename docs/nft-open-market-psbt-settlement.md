# MRC-721 Open Market — PSBT Two-Phase Settlement Design

Status: **draft for owner approval** (2026-11-08). Companion to
`docs/nft-sell-protocol-draft.md` (sell-intent protocol v2, APPROVED) — this
doc does NOT change the pin protocol; it defines the settlement flow that
turns the open sell-intent declaration into an atomic, trustless purchase.

## 1. Goal

Owner directive (2026-11-08): an MRC-721 NFT must be tradeable for native
MVC SPACE **atomically and openly** — any buyer, not a pre-named one — as the
foundation of an open NFT marketplace. Directed (private-chat) trading stays
available alongside it.

## 2. Feasibility conclusion (and the covenant correction)

PSBT (partially signed transactions) alone is sufficient for open atomic
trading. The earlier note in `nft-sell-protocol-draft.md` ("true open taking
requires a covenant contract (v2)") is **over-narrow**: it holds only when
BOTH of these are treated as fixed:

1. taking is *passive* (the seller publishes one fully signed offer object and
   may go offline), and
2. the MRC-721 indexer pins the item delivery output to index 0.

Neither premise is actually fixed:

- **Interactive two-phase settlement** (§3) needs no covenant at all and
  changes no protocol.
- **Passive walk-away offers** (§5, M2) need no covenant either — they only
  need the indexer convention relaxed from "delivery output MUST be output0"
  to "the delivery output is identified by its item-envelope structure at any
  index", after which `SIGHASH_SINGLE|FORKID|ANYONECANPAY` on the item input
  yields a self-contained open offer (output0 = the price output, signed and
  protected; the buyer appends the delivery output and their funding).

Sighash flag values follow the existing code rule ("the value is measured,
never guessed"): the tx builder reuses the constants already pinned in
`mrc721AtomicSwapTx.ts` (ALL|FORKID|ANYONECANPAY = 193) and its siblings.

## 3. M1 — interactive two-phase settlement (builds the open market)

Roles are bots on both sides; the marketplace experience is: a buyer bot sees
a sell intent through `mrc721_market_intents`, takes it, and the whole
settlement completes without either owner touching their wallet.

### 3.1 Transaction shape (built by the BUYER)

```
inputs[0]   = the item UTXO (outpoint via mrc721_item_info)   — left UNSIGNED
inputs[1..] = the buyer's SPACE UTXOs (each ≥ 600 sats floor)  — signed ALL|FORKID
outputs[0]  = item delivery output to the buyer address, exact MRC-721 envelope
              shape (same builder the current directed sell flow uses)
outputs[1]  = the listed price (or more) in sats → the seller's MVC address
outputs[2]  = buyer change (buyer-controlled)
fee         = paid by the buyer, bounded by the existing 3x fee-multiplier rule
```

The buyer signs only their own inputs while inputs[0] sits in the tx with an
empty unlocking script (standard PSBT order; the digests commit to the
outpoints of ALL inputs, so the item outpoint must be present — and it is,
taken from the listing). The partially signed tx is the *countersign
request*.

Why this is atomic and safe for both sides:

- The seller's countersignature covers everything (ALL|FORKID on the item
  input). The seller never signs a tx that pays them less than the listed
  price, delivers the item anywhere but output0, or drags in another of the
  seller's UTXOs.
- The buyer cannot pay less: output0's envelope and outputs[1]'s amount are
  what the seller verifies before signing; a buyer-built tx that fails
  verification is simply refused and nothing broadcasts.
- First-come-first-served = countersign-order + double-spend race. Two
  concurrent takes of the same listing: the winner confirms, the loser's tx
  is invalid on broadcast and the loser's SPACE UTXOs were never spent.
  Nobody loses money on a lost race.
- Stale listings: if the item UTXO was already spent (sold elsewhere, or
  transferred), the countersign gate refuses and the buyer's funds stay
  untouched.

### 3.2 Seller-side verification gates (countersign "five checks")

Adapted from the existing directed-flow verification (`verifyMrc721Listing`):

1. The request binds to an **ACTIVE local sell intent** of this bot with the
   same itemPinId (latest-wins per the v2 intent ledger), or to a directed
   private-chat deal with this bot as seller.
2. The item UTXO is still owned by this bot and unspent at sign time.
3. `outputs[0]` is a valid MRC-721 delivery envelope (shape-checked against
   the mrc721Service builder); the delivery address is NOT constrained
   (open market) but the envelope must be well-formed.
4. The payment output(s) to the seller's address total ≥ the declared price
   (floor 22000 sats enforced; paying MORE is allowed — a market take above
   ask is a feature, not an attack).
5. Fee and input hygiene: fee rate within the multiplier rule; the tx contains
   NO input other than inputs[0] that belongs to this bot's wallets; the
   buyer's partial signatures validate (TxComposer verify) before the seller
   adds theirs.

Refusals return the gate reason verbatim and are recorded (see §6).

### 3.3 Transport

The countersign request/reply rides the existing bot-to-bot A2A private-chat
route (chatpubkey rotation already live; envelopes are end-to-end encrypted).
Payload: `{ kind: 'mrc721-countersign-request', itemPinId, intentPinId,
partialTx, buyerAddress }`; the reply carries the fully signed tx hex or a
structured refusal reason.

### 3.4 Deterministic host-level auto-responder (no LLM in the money path)

The seller's auto-countersign decision is deterministic gate evaluation, so
it runs as a host-level listener in the seller bot's main process — the LLM
is never in the signing path (same principle as the browser-buy payment
gate). The LLM is only notified of the outcome; the `mrc721_countersign`
agent tool remains available for the manual/LLM-driven path.

Policy setting per bot: **auto-countersign ON by default** (the marketplace
only works if takes settle without human latency), with an owner-visible
switch to require per-take confirmation. Every attempt — accepted or refused,
with the gate reason — is appended to a local audit ledger.

### 3.5 New surface

- Buyer agent tool: `mrc721_buy_open` (resolve intent → build tx → sign →
  send request → await countersign → broadcast → emit `nft-card` bought).
- Seller tools/listener: `mrc721_countersign` + the deterministic
  auto-responder behind the policy switch.
- UI: the market-intents card and the wallet's buy flow gain the open-take
  action; a new per-bot setting row for auto-countersign.
- No new IPC contract rows unless the setting needs a renderer channel (it
  does — one P1 read/write settings channel, registered via the standard
  gate).

### 3.6 What does NOT change

- Sell-intent pin protocol v2 (`/protocols/mrc721sell`): unchanged, still the
  open order book.
- The directed `mrc721_sell` / `mrc721_buy` flow: unchanged, still used for
  private-chat directed deals.
- Indexer conventions: unchanged (delivery output stays at output0).
- MetaSo endpoints: unchanged.

## 4. Directed trading stays

Private-chat scenarios keep the existing seller-built directed listing
(`mrc721_sell` with a named buyer, `mrc721_buy` completing it). The open flow
is additive; both share the same tx primitives and verification code.

## 5. M2 — passive walk-away offers (optional second phase)

Requires ONE indexer convention change, requested at MetaSo: identify the
item delivery output by its envelope structure at any output index (not
hard-coded to output0). Once granted:

- The seller signs the item input with `SIGHASH_SINGLE|FORKID|ANYONECANPAY`
  over a tx whose output0 = the price output (paired, signed, protected).
- The offer object is fully signed and may live anywhere (including inside a
  sell-intent pin payload). Any buyer completes it by appending the delivery
  output + funding, with no seller online. True walk-away first-come-first-
  served.
- Buyer-side guarantee is the signature math, not seller cooperation; the
  price output cannot be altered without breaking the seller's signature.

If MetaSo declines the convention change, M2 stays parked; M1 already
delivers the marketplace.

## 6. Corrections to land in `docs/nft-sell-protocol-draft.md` upon approval

1. §covenant note: replace "true open taking requires a covenant contract
   (v2)" with the two-mode statement — interactive two-phase settlement needs
   no covenant (this doc §3); passive offers need only the indexer
   index-flexibility convention (§5).
2. Settlement rails line: "locked atomic swap / guarantor" becomes "directed
   atomic swap (seller-built, private chat) / open two-phase swap
   (buyer-built + bot countersign) / guarantor (any currency)".

## 7. Open questions for the owner

1. M1 scope approved as above? (M2 stays parked until MetaSo answers.)
2. Auto-countersign default ON acceptable, with the per-take-confirm switch
   exposed in bot settings?
3. Buying ABOVE the ask allowed (recommended: yes — it is the natural market
   behavior and costs the seller nothing)?
