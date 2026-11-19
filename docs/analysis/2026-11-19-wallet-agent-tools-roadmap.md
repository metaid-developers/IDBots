# Wallet Agent Tools — Incident Review and Next-Phase Roadmap

Date: 2026-11-19 · Branch: `feat/wallet-tools` (worktree `.worktrees/wallet-tools`)
Incident session: `IDBots://0c841356-2f9f-4167-8cff-69a92dd731b8` (log:
`~/Library/Application Support/IDBots/dsh-sessions/v0/--Users-tusm-idbots-project-bots-1-2026-11-19--/cw-0c841356-2f9f-4167-8cff-69a92dd731b8/session.v4.jsonl.zstd`)
Bot: AI_Sunny (`metabot_id 1`, MVC address `1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za`), 2026-11-19 09:56–10:03 CST.

All file:line references are against `main` @ `5611f0f81`.

## 1. What happened in the incident session

| Time (turn) | What the user asked | What the bot did | Result |
|---|---|---|---|
| 09:56 (t1) | "转出你钱包里 mvc token 'METAID' 到 12ghVWG…，转 0.1 个" | model call failed with `429 insufficient_me` (quota, unrelated to wallet) | no action |
| (t2, fallback model) | same request carried over | called `wallet_token_balance {metabot_ids:[1]}` | tool returned **all four FT balances = 0** → bot refused: "METAID 余额是 0" |
| 09:58 (t3) | (owner nudge) | 429 again | no action |
| (t4) | same request | `wallet_token_balance` again → still 0; then probed the chain manually via curl to the Metalet v4 endpoint | real balances: **METAID 1.02915788 confirmed + 0.11926471 unconfirmed**, Token 678813, SS 386860783159, MC 113536394 |
| (t4 cont.) | — | tried `wallet_token_transfer {genesis: 28a481…(40-hex), codehash: c9cc…}` | rejected: "requires genesis (64 hex)" |
| (t4 cont.) | — | read the TokenSell-lineage code (`mvcTokenSellCore.ts`, `buildMvcTokenSellRawTxWorker.ts`, `mvcTokenSellAssembly.ts`), found the full-utxo gate, and **wrongly generalized it to the UI path** | concluded "MVC 代币转账只能整笔 UTXO 全额移动，系统里没有拆分代币功能"; proposed option A = "add a split capability first" |

Post-incident note: a full scan of every session log written today (2026-11-19) shows the real balance value
(`1.02915788`) appears **only** in the incident session — produced by the bot's manual curl, never by
`wallet_token_balance`. The "later it could query the balance" impression comes from the bot reusing that
manual reading from conversation context; the agent-side balance tool itself never recovered during the day.

## 2. Root causes (verified in code)

### RC1 — FT balance tool returns hard zeros: parser reads a field the API never sends

- Agent path: `wallet_token_balance` → `listMvcFtTokens` control (`main.ts:8449`) → `getMvcFtTokenBalance`
  (`src/main/services/mvcTokenSellService.ts:126`).
- Endpoint: `${APIMVC_HOST}/contract/ft/address/{address}/balance` where `APIMVC_HOST =
  https://api.microvisionchain.com/open-api-mvc` (`mvcTokenSellService.ts:35`, `:96-99`).
- The response rows carry `confirmed` / `confirmedString` / `unconfirmedString` (verified live against the
  incident address during the session). There is **no `balance` field**.
- The parser does `balance: String(row.balance ?? '0')` (`mvcTokenSellService.ts:139`) → **every token maps
  to balance `'0'`** while symbol/genesis/codehash still come through. That matches the observed output
  exactly (correct token list, all-zero balances).
- This is deterministic, not indexer lag — every user/bot that queries FT balances through the agent tool
  gets zeros. The UI never noticed because it reads a different service (`mvcFtService`, below).

### RC2 — the agent FT transfer tool is bound to the TokenSell market lineage, not the general MVC20 path

`wallet_token_transfer` → `executeMvcTokenSellTrade(action: 'transfer')` (`main.ts:8483-8490`) →
`buildMvcTokenSellRawTx` (`walletRawTxService.ts:1055-1106`) → `buildMvcTokenSellRawTxWorker.ts` →
`buildTransferTxB` (`mvcTokenSellAssembly.ts:677-820`). Two stacked constraints:

1. **64-hex genesis required in three layers** — tool schema regex (`walletAgentTools.ts:997`, `:1016-1017`),
   service validation (`walletRawTxService.ts:1086`), worker validation (`buildMvcTokenSellRawTxWorker.ts:412-414`).
   Standard MVC20 tokens identify genesis as **40 hex** (METAID = `28a481ecdae9499a599a9457ae70b5cf234ef417`).
   The 64-hex rule is an over-generalization of the NFT-genesis convention — the open-api-mvc FT utxo
   endpoint accepts the 40-hex genesis (verified live in the session). So the tool cannot address common
   MVC20 tokens at all, even before amount semantics matter.
2. **Full-utxo-only amount semantics** — `checkTokenTransferAmountGates`
   (`src/main/libs/mvcTokenSellCore.ts:374-393`) rejects any `transferTokenAmount != utxoTokenAmount`
   ("partial transfer rejected … split the token first if you need a smaller amount"), enforced in the
   worker (`buildMvcTokenSellRawTxWorker.ts:476-488`) and again in the assembly
   (`mvcTokenSellAssembly.ts:734-741`). The reason is structural, not arbitrary: the TokenSell checker
   (TransferCheck OCS leg) conservations pair the checker receiver amount with the token output amount,
   which is built from the full utxo dataPart.

### RC3 — two parallel MVC-FT implementations with different data sources (single-source-of-truth violation)

| | UI path (works) | Agent tool path (broken) |
|---|---|---|
| FT balance source | Metalet v4 `wallet-api/v4/mvc/address/contract/ft/balance-list` (`mvcFtService.ts:131-136`) | open-api-mvc `contract/ft/address/{addr}/balance` (`mvcTokenSellService.ts:96-99`) |
| Balance parsing | `confirmedString` / `unconfirmedString` (`mvcFtService.ts:63-68`) | `row.balance ?? '0'` (missing field) → zeros (`mvcTokenSellService.ts:139`) |
| Transfer builder | meta-contract SDK `FtManager.transfer({receivers: [{address, amount}]})` (`buildMvcFtTransferRawTxWorker.ts:289-300`) — **partial amounts supported, token change output returned** | TokenSell op=1 assembly — full-utxo only (`mvcTokenSellCore.ts:374-393`) |
| Genesis accepted | 40-hex as returned by the chain | 64-hex only (regex) |

The incident bot's final claim — "手动转账也转不出 0.1 个，界面执行时会比对填的数量和实际数额" — is **wrong**:
it read the TokenSell lineage's amount gate and attributed it to the UI. The UI path
(`MetaBotTokenTransferModal` → `metabotTokenTransferService.executeTokenTransfer` → `mvcFtService.executeMvcFtTransfer`)
passes an arbitrary `amount` to the meta-contract SDK, which splits the token utxo and returns change. The
owner's successful manual transfer matches the code. What is actually missing is agent access to that path.

### Contributing observations (not root causes)

- Turns 1/3 failed on `429 insufficient_me` quota before any wallet work; the wallet issue is independent.
- During diagnosis the bot read a wallet mnemonic in plaintext out of `idbots.sqlite`
  (`metabot_wallets.mnemonic`, `metabotStore.ts:832`; no encryption layer in the store). See Phase 2
  hardening item.

## 3. Current inventory of wallet/transfer capabilities

### Agent tools mounted on every cowork surface (`coworkRunner.ts:15855`, not gated off Studio owner chat)

15 tools in `src/main/libs/walletAgentTools.ts`:

- Native: `wallet_balance` (MVC/BTC/DOGE utxo-sum snapshots), `wallet_transfer` (**SPACE only**; channel A
  local-roster / channel B external with owner dialog or `external_confirmed`; audit ledger on every attempt;
  dust 600 sats).
- MetaContract NFT: `wallet_nft_balance`, `wallet_nft_transfer`, `wallet_nft_sell_orders`, `wallet_nft_sell`,
  `wallet_nft_cancel_sell`, `wallet_nft_buy`.
- MVC FT (TokenSell lineage): `wallet_token_balance`, `wallet_token_transfer`, `wallet_token_sell_orders`
  (tuple verification), `wallet_token_sell`, `wallet_token_buy` (+ `wallet_token_take` alias),
  `wallet_token_cancel_sell`.
- Adjacent families: `btc_multisig_*` (P2WSH PSBT sign/broadcast only), `mrc721_*` (pin-based MetaID NFTs),
  `escrow_*`, `payment_card_*`.

### UI-only services that already exist and work (not exposed to the agent)

- `transferService.ts` — full transfer path for `chain: 'mvc' | 'doge' | 'btc'` (fee summary, preview,
  UTXO selection, broadcast); BTC guarded by the inscription-carrier floor (`btcSpendPolicy.ts`). The UI
  `MetaBotTransferModal` exposes all three chains; the agent has none of BTC/DOGE.
- `mrc20Service.ts` — MRC20 balance listing (`listMrc20Assets`, `:734`) and transfer
  (`executeMrc20Transfer`, `:744`, commit/reveal two-tx). The UI `MetaBotTokenTransferModal` transfers
  MRC20 with amount; **no agent tool touches MRC20 today**.
- `metabotTokenTransferService.ts` — unified `executeTokenTransfer({kind: 'mrc20' | 'mvc-ft', amount, …})`;
  the single entry the UI uses for token transfers.
- Tx-lookup fragments: `fetchRawTx` for MVC (`mvcTokenSellService.ts:102`, metalet v4 `tx/raw`),
  `fetchBtcTxHex` (`libs/btcApi.ts:277`, metalet + mempool.space fallback), `fetchDogeTxHex`
  (`transferService.ts:114`), and `verifyMrc20Payment` (`mrc20PaymentVerification.ts:228`, polls a
  recipient address until a given txid appears). **No generic tx-status/confirmation helper exists for any
  chain, and no agent tool verifies a txid.**

### Gap matrix

| Capability | UI | Agent tool |
|---|---|---|
| Native balance (MVC/BTC/DOGE) | yes | yes (`wallet_balance`) |
| Native transfer SPACE | yes | yes (`wallet_transfer`) |
| Native transfer BTC | yes | **no** (multisig PSBT only) |
| Native transfer DOGE | yes | **no** |
| MVC20/FT balance | yes (correct source) | yes but **hard-zero bug (RC1)** |
| MVC20/FT partial transfer | yes (arbitrary amount) | **no** (full-utxo + 64-hex genesis, RC2) |
| MRC20 balance / transfer | yes | **no** |
| Split an FT utxo | (implicit via partial transfer) | **no** |
| Tx status by txid | partial (`verifyMrc20Payment`) | **no** |
| Payment-proof verification (txid → receiver/amount) | no | **no** |

## 4. Roadmap

### Phase 0 — hotfix the two defects behind the incident (small, this branch)

- **F1 — fix the FT balance read.** Make the agent's FT balance share the UI's source: point the
  `listMvcFtTokens` control at `listMvcFtAssets` (`mvcFtService.ts:189`, Metalet v4 balance-list) instead of
  `getMvcFtTokenBalance`, and keep the response shape backward-compatible (`balance` display string plus
  `confirmed`/`unconfirmed`). Update `formatFtBalance` in `walletAgentTools.ts:912` to show the
  confirmed/unconfirmed split. If the open-api-mvc source must stay for any reason, the minimal fix is
  parsing `confirmedString`/`unconfirmedString` at `mvcTokenSellService.ts:139` — but one source of truth
  (option b) is the preferred end state.
- **F2 — regression test with the live fixture.** Unit test `listMvcFtTokens` formatting against the exact
  response captured in the incident (METAID confirmed 102915788 / unconfirmed 11926471, decimal 8) so the
  all-zero regression can never ship silently.

### Phase 1 — the three tool families the owner asked for

- **T1 — `wallet_token_send`: general MVC20/FT transfer with an amount.** Reuse
  `metabotTokenTransferService.executeTokenTransfer` (kind `mvc-ft`) — the exact service the UI uses. Args:
  token identified by genesis + codehash (accept 40- or 64-hex) with `wallet_token_balance` as the lookup
  aid; `to` = raw MVC address or local metabot id/name (resolve to address first, mirroring
  `wallet_transfer`); `amount` in token display units, converted to base units with the token's decimal.
  Keep gate parity with `wallet_transfer`: chain-write budget, audit-ledger record, channel-A/B owner
  confirmation for external receivers. Output: transfer txid + amount-check txid + change outpoint, plus a
  pointer to `wallet_tx_status` for confirmation. `wallet_token_transfer` stays TokenSell-scoped (full-utxo
  listing semantics); its description should say so explicitly.
- **T2 — `wallet_tx_status`: transaction status by txid.** One service function per chain behind a single
  tool. MVC: reuse `fetchRawTx` (`mvcTokenSellService.ts:102`) for existence/parse plus a confirmation
  source (survey: metalet wallet-api tx endpoints vs api.microvisionchain.com mvcSCAN REST — pick one,
  wrap it so it is swappable). BTC: `fetchBtcTxHex` (`btcApi.ts:277`) + mempool.space `/tx/<id>` for
  confirmations/height. DOGE: `fetchDogeTxHex` (`transferService.ts:114`) + equivalent status source.
  Output: `found | pending | confirmed | failed`, block height, confirmation count, fee, size. Read-only.
- **T3 — `wallet_tx_verify`: payment-proof verification.** Args: txid + optional expectation tuple
  `{chain, receiver, amount, token (genesis/codehash or mrc20 id)}` → verdict `VERIFIED` or `MISMATCH` with
  the decoded actuals. MVC20: parse the op=1 transfer outputs (reuse the script-decode machinery behind
  `verifyMvcTokenSellListing`, `mvcTokenSellService.ts:151+`); MRC20: decode via the mrc20 activities
  endpoint (`mrc20Service.ts:408`) or fall back to `verifyMrc20Payment` recipient-side polling; native
  SPACE/BTC/DOGE: parse output scripts/amounts. This is the "counterparty shows a txid" scenario in both
  directions: we verify their claim, and our transfer outputs carry a txid they can verify the same way.
- **T4 — `wallet_mrc20_balance` + `wallet_mrc20_transfer`.** Thin agent wrappers over
  `mrc20Service.listMrc20Assets` / `executeMrc20Transfer` (commit/reveal; return both txids; carrier-floor
  and fee errors surfaced verbatim). Same confirmation and audit posture as T1.
- **T5 — `wallet_btc_transfer` + `wallet_doge_transfer`.** Wrappers over `transferService.executeTransfer`
  with `chain: 'btc' | 'doge'`, reusing the UI's fee-summary/preview path so estimates match what the owner
  sees. BTC carrier floor (`btcSpendPolicy.ts`) surfaced as a structured error, not a generic failure.

### Phase 2 — asset-management direction (post Phase 1)

- `wallet_token_split`: explicit self-transfer that carves a smaller FT utxo (sugar over T1 with
  `to = self`), mainly to prepare full-utxo TokenSell listings of a chosen size.
- `wallet_utxo_consolidate`: merge dust native UTXOs per chain (fee-aware).
- `wallet_overview`: one-call cross-chain + cross-asset snapshot (native + FT + MRC20 + NFT counts) for
  planning turns, replacing multi-tool fan-out.
- Payment-request flow: bot↔bot invoicing (amount/token/memo → pay → auto-verify via T3), building on the
  escrow/payment-card patterns already in the codebase.
- Market-data hook (prices/quotes) to support the enhanced-trading direction.
- **Security hardening:** encrypt wallet mnemonics at rest (Electron safeStorage) and narrow the direct
  `store.getMetabotWallet*` read surface (today `metabotStore.ts:832/:913` hand out plaintext seeds, and the
  incident bot demonstrated they are one sqlite query away from any bash-capable session).

### Design principles for every new tool

1. **One implementation per capability** — agent tools call the same services the UI calls
   (`metabotTokenTransferService`, `transferService`, `mrc20Service`); never fork a second tx assembly.
2. **Gate parity** — every write tool gets the chain-write budget, the audit ledger, and the channel-A/B
   owner-confirmation posture that `wallet_transfer` already has; read tools stay strictly read-only.
3. **Keys never enter the tool layer** — signing stays inside services/workers.
4. **Structured, deterministic outputs** — amounts in both display and base units, txids, audit ids,
   explicit error codes with have/need where relevant.
5. **English copy and docs**; update `docs/token-sell-protocol.md` with a scope note for
   `wallet_token_transfer`.

## 5. Acceptance criteria

- Phase 0: on the incident address, `wallet_token_balance` returns METAID 1.02915788 confirmed
  (+0.11926471 unconfirmed); fixture unit tests pass; `pnpm run test:wallet` green with `NO_COLOR=1
  FORCE_COLOR=0`.
- Phase 1: end-to-end on `main` after merge — the bot transfers 0.1 of an FT to an external address after
  owner confirmation; `wallet_tx_verify` confirms receiver + amount from the txid; an MRC20 transfer
  round-trips (both txids reported); BTC/DOGE transfers smoke-tested with small amounts.
- Per the standing delivery loop: branch → merge request → acceptance tests run on `main`, reporting the
  merge commit, exit codes, and test counts.

## 6. Open questions

1. MVC confirmation-status endpoint: metalet wallet-api vs mvcSCAN REST — needs a short survey before T2
   lands; the tool should hide the choice behind one service function.
2. Does `wallet_token_transfer` stay TokenSell-scoped (recommended) or eventually fold into
   `wallet_token_send` with a mode flag?
3. MRC20 balance-tool granularity: full asset list per call vs filtered by mrc20 id.
4. Scheduling for mnemonic at-rest encryption (it touches every signing service).
