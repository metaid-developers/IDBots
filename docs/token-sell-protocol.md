# MVC FT TokenSell — protocol notes for the host capability

Status: construction + query capability only (this PR). The signing layers are
ported 1:1 from the live-fire-validated workspace of 2026-10-30; nothing in
this PR broadcasts, and no live-fire was performed through the host path.

## What it is

FT (fungible token / MetaContract FT) on-chain trading via the **TokenSell**
contract, mirroring the NFT capability (`mvcNftService` / NftManager) so bots
can list and take FT orders the same way they already trade NFTs:

| tool | action | shape |
|---|---|---|
| `wallet_token_balance` | read | FT holdings per address (open-api-mvc `contract/ft`) |
| `wallet_token_sell` | LIST | op=1 TRANSFER into a TokenSell seed lock |
| `wallet_token_sell_orders` | read | verify a listing tuple against the chain |
| `wallet_token_take` | TAKE | op=2 UNLOCK_FROM_CONTRACT |
| `wallet_token_cancel_sell` | CANCEL | self-take (seller==taker; price circles back, fees spent) |

All signing runs in the subprocess worker
(`src/main/libs/buildMvcTokenSellRawTxWorker.ts`, `ELECTRON_RUN_AS_NODE`, same
posture as `buildMvcNftTradeRawTxWorker`). The worker never broadcasts; the
service broadcasts the ordered tx set (checker mint → seed → final) with the
NFT-trade retry posture. Session-bot-own-wallet enforcement and the
chain-write budget gate live in the tools layer, identical to wallet_nft_*.

## Live-fire anchors (do not re-derive; all block-confirmed)

Forward loop (seller leg, 2026-10-30):

- seed deploy **TxA** `3663e0f341d08772983c6d195697662af7740ed0914854d16ab52aec90ea634c`
  — out0 = 2032 sats, 850B TokenSell lock, ctor = (seller, 5e8 sats)
- token LIST **TxB** `e281d9a2d0475da86c59e0973ebda42ac3a8fa96b25adad084f59f519e5d267b`
  — in0 = `f518099d…:0` (op=1); out0 = token → hash160(sha256(seedLock))
- take `cda834c57e7c9c94c90ad311259d4e0d1e372b1741fff8e698f2474f7008a279`
  — confirmed @196361; out0 = 5e8 sats → seller

Reverse loop: `6be46ade…` / `d385c3b3…` / `3c675b1d…` (taker-side wiring).

Token utxo lineage: merge tx `f518099daaa0e0d3548b5bc47c71d6d697ac7ff37e401c74271ec4fb748b0953`
(in0 = `1f3baf0e…:0`, in1 = `d25da839…:10`, conservation 915725043517 verbatim).

Evidence workspace: `/Users/wufeng/idbots/project/bots/2/2026-10-30/`
(`amtcheck/skill-package/sell-list.mjs` = parameterized LIST closing;
`amtcheck/taker/taker.mjs` = take CLI; `amtcheck/stage2b-result.json` carries
the live TxA/TxB raw hex; `handoff-stage2b-final.md` = root-cause record).
On-chain ledgers: seller pin://65a7bcfe72cbe02559ef8e25bc4497e7018b12284bbcfaf37b15883a8adbdb7ei0,
buyer pin://e1512a46f3b58fa6577fc1f00c3a6b8b879545637464be498d20763e44ffa2d2i0.

## v10 txid (112B header)

`txid = reverse(hash256(header))` where
`header = u32LE(version) ‖ u32LE(locktime) ‖ i32LE(nIn) ‖ i32LE(nOut) ‖ inRoot ‖ scriptRoot ‖ outRoot`

- inRoot contribution per input: **wire-order prevTxId bytes verbatim** ‖
  u32LE(vout) ‖ u32LE(sequence); scriptRoot: sha256(scriptSig) per input;
  outRoot: u64LE(sats) ‖ sha256(scriptPubKey) per output.
- The consensus txid **commits to scriptSigs** (scriptRoot): mvc-lib
  `Transaction.id` IS the consensus/broadcast txid. Never strip scriptSigs
  for a listing reference (the stage2b-era "bare txid" was disproven and is
  forbidden).
- Implemented independently in `mvcTokenSellCore.extractV10Header/v10TxId`
  and cross-checked against mvc-lib on the live seed / LIST / merge txs.

## Checker kill-switch

A deployed **TokenTransferCheck** (op=1 family) lock is exactly:

```
desc template bytes (3423B, tokenTransferCheck_desc.json) ‖ 84B dataPart tail
  6a 4c <len> ‖ dataPart (tokenCodeHash, tokenID, amounts, receivers)
```

3507 bytes total for the live cast (`sha256(lock) = 128d88f8…8c64`). The
op=2 family (TokenUnlockContractCheck, taker side) shares the OCS preimage
discipline below. `mvcTokenSellCore.checkerKillSwitch` enforces the equality
and the length invariant.

## Signature wiring (what the port preserves)

1. **stage2b final fix**: `tokenTxInputProof` = verbatim SDK input0 proof +
   `prevTokenInputIndex=0` + the original 112B header. Any txHash
   self-anchoring rewrite breaks the deployment-generation consistency
   (15-cell EQVERIFY all-green is the regression proof on the live pair).
2. **OCS short-domain preimage**: TransferCheck-family checkers compute the
   preimage over the script tail AFTER the last OP_CODESEPARATOR; the
   trailing CHECKSIG operands are assembled on-stack from dataPart constants
   — no external signature injection. This is why the checker leg verifies
   fully OFFLINE in the unit tests.
3. **Seed leg (take)**: `TokenSell.unlock(preimage @ SIGHASH_SINGLE|FORKID)`
   binds out1 = price→seller byte-exactly (hashOutputs closure asserted).
4. **Lineage adjacency**: `prevTokenTx` must be the DIRECT parent the LIST
   token input points at (backtrace lock); mismatch fails closed.
5. **Deterministic fee convergence**: 70–73B pushes counted at 73B so
   dry-run and real signatures converge to the same structure/txid.
6. **Consensus txid only** (`mvc-lib Transaction.id`), never a stripped form.

## Amount gates (construction-path hard gates)

Enforced in `mvcTokenSellCore.checkTokenSellAmountGates/assertTokenSellAmountGates`
and re-applied inside the assembly builders (offline-testable):

- **Full-utxo listings only**: listed token amount must EQUAL the token
  utxo's dataPart amount. Partial-quantity listings break the checker's
  conservation invariant (receiverTokenAmountArray must equal the listed
  amount and the token output carries the same amount) and are rejected at
  construction. Split the token first if you need a smaller listing.
- Price in integer **sats** (1 SPACE = 1e8 sats — never mixed units), ≥ dust
  floor; `price_space` conversion at the tool layer only.
- Seed / checker utxo denominations ≥ 600 sats (dust).
- Take side: decoded on-chain seed price must match the claimed listing
  price and seller (misquotes fail closed before any signing).

## Listing discovery model (explicit gap)

TokenSell has **no chain-wide order index** — no wallet-api/open-api endpoint
enumerates sell seeds (they are not address-keyed P2PKH outputs, and listed
tokens leave the seller's FT utxo set). The listing four-tuple
`{sell_txid, sell_output_index, sell_price_sats, seller_address}` travels
off-chain between counterparties by design. `wallet_token_sell_orders`
therefore VERIFIES a tuple against the chain (raw LIST tx, v10 txid
recomputation, seed-lock decode → seller/price cross-check, dataPart amount)
instead of listing orders; misquotes and non-TokenSell outputs fail closed.

## Non-trade op=1 TRANSFER (wallet_token_transfer)

Verb-aligned with `wallet_nft_transfer`. Moves ONE FT token utxo **in full**
from the session wallet to a raw MVC receiver address — no seed lock, no
price output, no listing tuple. Construction = the LIST shape trimmed of its
trade coupling (`mvcTokenSellAssembly.buildTransferTxB`):

- in0 token utxo — op=1 TRANSFER 18-param unlock, verbatim SDK input0 proof
  + backtrace lineage (identical to LIST);
- in1 checker — auto-minted TransferCheck (op=1 family) whose receiver is the
  **raw receiver hash160** and whose amount is the full utxo amount
  (conservation pairs it with the token output);
- in2 funding P2PKH — fees + change;
- out0 token locked to the receiver (`getNewTokenScript` — the taker.mjs
  out0 shape: the receiver gets a standard, re-transferable/listable token
  utxo), out1 change.

Gates: `checkTokenTransferAmountGates/assertTokenTransferAmountGates` in
`mvcTokenSellCore` — full-utxo only (partial moves rejected; splitting needs
the listing/precise-split path), checker denomination ≥ dust. There is no
price in a transfer. The worker action is `transfer` (never broadcasts);
broadcast order is `checker mint → transfer`, staged by the service exactly
like sell/take. Token-utxo discovery mirrors sell: unique utxo of the genesis
or explicit `token_txid`/`token_vout` when several are held.

## Test vectors

`tests/fixtures/tokenSell/` — public chain data only, zero key material:
`f518099d` raw + 112B header, prev-token raw, live checker cast, live seed
TxA, live LIST TxB, and the anchor constants in `meta.json`. The TRANSFER
tests reuse these fixtures with a deterministic dry signer, a dry receiver
and an offline-minted checker cast (no new fixtures).
