# wallet_token_transfer fast-follow — evidence report (2026-10-31, Tuesday/Mars)

Task `5959a6ca-df9a-4526-b182-2442b389d828` / step `e9426017-c0a7-4901-a342-0cb6925bfb85`.
Branch `feat/token-transfer-tool` (from local `upstream/main` @ `92d1ddaeb`, which already
contains the PR #109 merge `3785efd08` incl. review fix `1072288a5`). All changes UNCOMMITTED —
commit/push/PR stay with Monday, per the delegation contract.

## What was built

Non-trade op=1 TRANSFER (TokenTransferCheck family, full-utxo semantics, raw receiver
address) — the TokenSell LIST shape trimmed of its trade coupling, mirroring the
`wallet_nft_transfer` tool posture. Follows `pr109-work/TRANSFER-FASTFOLLOW-SPEC.md`
(the live-fire night's design draft).

## Files touched (9, all uncommitted; `git diff HEAD --stat` = 868+/22-)

| File | Change |
|---|---|
| `src/main/libs/mvcTokenSellCore.ts` | +`checkTokenTransferAmountGates` / `assertTokenTransferAmountGates` (full-utxo move only, checker ≥ dust 600 sats; reuses `DUST_SATS`; no price gate — transfers have no price) |
| `src/main/libs/mvcTokenSellAssembly.ts` | +`buildTransferTxB` (+interfaces `TransferTxBStaticInputs/TransferTxBResult`): in0 token utxo (op=1 18-param unlock, verbatim SDK input0 proof, backtrace lineage — identical to LIST), in1 auto-minted TransferCheck checker (receiver = RAW receiver hash160, amount = full utxo amount), in2 funding P2PKH; out0 token locked to receiver via `getNewTokenScript` (taker.mjs out0 shape — receiver gets a standard re-transferable/listable utxo), out1 change. Deterministic fee convergence + dual verify verdicts + stage2b `dryRunOverrides` posture, same as LIST. |
| `src/main/libs/buildMvcTokenSellRawTxWorker.ts` | +action `transfer` (genesis+codehash discovery like sell: unique utxo or explicit token_txid/vout; owner == session wallet check; full-utxo gates; auto-minted checker; ONE funding utxo for fee budget — no seed leg). Worker NEVER broadcasts; returns ordered `fundingTxs:[checkerMint]` + final transfer tx. Both legs must verify PASS before hand-out. |
| `src/main/services/walletRawTxService.ts` | `BuildMvcTokenSellTradeParams.action` +`'transfer'`; param validation branch (genesis 64h / codehash 40h / receiverAddress required). |
| `src/main/services/mvcTokenSellService.ts` | `executeMvcTokenSellTrade` action union +`'transfer'` (same ordered-broadcast orchestration + retryable-rebuild posture; comment updated). |
| `src/main/libs/walletAgentTools.ts` | +`wallet_token_transfer` tool registered beside the `wallet_token_*` block (after `wallet_token_balance`, mirroring the NFT line order) + `WalletToolsControl.transferToken`. Session-own-wallet posture (`resolveMetabotId` gate), `receiver_address` REQUIRED and must be a raw MVC address (per delegation; mirrors the FT line's `wallet_token_buy` receiver posture — local-bot name/id deliberately NOT accepted), genesis/codehash hex-validated + lowercased, irreversible-move confirm wording, verify hint. |
| `src/main/main.ts` | control wiring: `transferToken` under `withChainWriteBudget('wallet_token_transfer', …)` → `executeMvcTokenSellTrade(action:'transfer')`. |
| `docs/token-sell-protocol.md` | + "Non-trade op=1 TRANSFER (wallet_token_transfer)" section (semantics, tx shape, gates, broadcast order, discovery posture). |
| `tests/mvcTokenSell.test.mjs` | +5 tests (12 → 17): transfer gates; TRANSFER assembly dry-run (offline, live fixtures + dry signer/receiver + offline-minted checker); partial-transfer construction rejection; service DI orchestration test (broadcast order mint→transfer, non-retryable funding failure preserves raw txs); tool registration + fail-closed handler behaviors. |

## Verification evidence (final state, rerun)

| Command | Exit |
|---|---|
| `npx -p typescript@5 tsc --project electron-tsconfig.json` | **0** (run again after ALL source edits: `TSC_FINAL=0`) |
| `node scripts/copy-electron-js.cjs` | 0 |
| `node --check` on the 6 touched compiled outputs + `tests/mvcTokenSell.test.mjs` | all 0 |
| `node --test tests/mvcTokenSell.test.mjs` | **0 — 17/17 pass** (independent final rerun `FINAL_TEST_EXIT=0`) |

Zero network in tests (all fetch paths are DI fakes that throw on unexpected calls);
zero key material (dry keys derived in-process, never persisted/echoed); worker has no
broadcast call (grep-verified by construction — it only `console.log`s the built txs).

## Notable findings / deviations (Monday's discretion)

1. **Fabricated-txid length bug (mine, in tests, fixed)**: `appendInput({txId})` writes
   the prevTxId as `Buffer.from(hex)` at whatever length decodes — a 128-hex-char
   literal produces a 64-byte prevTxId and a structurally unparseable wire tx. My first
   test draft used `'aa'.repeat(64)` (=128 chars). Fixed to 64-char txids. Note: mvc-lib
   does NOT validate prevTxId length; the merged code only ever passes real 64-char
   txids, so it is unaffected — flagged for future fixture work.
2. **Spec-draft deviation (declared)**: TRANSFER-FASTFOLLOW-SPEC.md suggested
   "default to the unique/LARGEST utxo of the genesis". I mirrored sell instead:
   unique-or-explicit (`token_txid`+`token_vout` required when several utxos held).
   Silently defaulting to the largest utxo moves funds without disambiguation; the
   merged `wallet_token_sell` posture is unique-or-explicit and consistency wins.
3. **Spec-draft deviation (declared)**: the draft's optional `funding_txid/vout/sats/
   address` override params were NOT implemented — the sell/take line never had them
   (the worker does its own funding discovery + `excludeOutpoints` on retry); adding a
   parallel override channel in this fast-follow would diverge from the merged line.
4. **`token_amount` param not exposed on the tool**: full-utxo semantics make it
   redundant (the utxo moves in full; the worker REJECTS any explicit amount ≠ full —
   construction-path gate). `wallet_token_sell` keeps its amount param because a
   listing cross-checks against the utxo it will lock.
5. Checker sats: worker default 3000 (same as sell/take); not surfaced on the tool
   (consistent with the merged line; `checkerSats` flows through service params if the
   host ever wants to override).
6. Pre-existing environment facts (unchanged): sparse-checkout cone needed `git
   sparse-checkout add tests docs` in this worktree (done); `pnpm run compile:electron`
   remains blocked by the SKILLs-submodule postinstall — the underlying tsc+copy
   commands are used directly (both exit 0).
7. `git fetch upstream` was skipped (offline red line): the LOCAL `upstream/main` ref
   already contained PR #109's merge `3785efd08` (verified `git merge-base --is-ancestor`
   for both `4a95c5e26` and `1072288a5`) — no fetch needed to branch from it.

## Explicit gaps (unchanged posture + transfer-specifics)

- Host path not live-fired (zero-broadcast red line in this delegation): the worker's
  transfer branch's on-line discovery section (fetchFtUtxos/fetchRawTx lineage walk) is
  compile-level + offline-DI covered only; the op=1 token-unlock + checker legs are
  byte-level offline-verified against the live-fixture pair (same proven legs LIST uses).
- `buildCheckerMintTx`/`buildSeedTx` return `tc.getRawHex()` whose unchecked
  serialization is re-parseable in the states exercised by tests — worth a live-fire
  confirmation before the seed/checker mint txs hit a real broadcast (pre-existing
  merged code path, not changed by this step; flagged, not fixed).
- `git add -f` needed for `tests/mvcTokenSell.test.mjs` + `docs/token-sell-protocol.md`
  on commit (repo `.gitignore` `tests/*` rule; Monday already force-added them in PR
  #109, so this only matters for the NEW diff hunks).

## Red lines

Zero broadcast by this session ✅ (no broadcast call anywhere in the diff; tests offline)
Zero chain writes ✅ (nothing was signed/broadcast/submitted to any network)
Zero key echo ✅ (no mnemonic/WIF in code, tests, logs, or this report)
