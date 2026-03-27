# IDBots `metabot-trade-mvcswap` Phase 1 Design

## Goal

Add a first-phase official skill, `metabot-trade-mvcswap`, that lets a user ask a MetaBot to quote and execute `SPACE <-> token` swaps through mvcswap `v1`, while keeping wallet custody inside IDBots.

The desired user experience is:

- the user can ask natural-language questions such as "10 SPACE can swap to how much MC",
- the user can ask to trade with or without an explicit confirmation phrase,
- the skill can dynamically discover supported pairs from mvcswap instead of using a hardcoded whitelist,
- the skill can execute the swap with the current MetaBot wallet,
- the skill never reads or exposes mnemonic directly,
- the Electron main process stays generic and does not contain mvcswap-specific business logic.

## Constraints

- Phase 1 uses mvcswap `swap v1` only. `swapv2` is explicitly out of scope.
- Phase 1 does not support liquidity add/remove or any LP operation.
- Phase 1 executes `exact-in` only.
- Phase 1 supports only trades where one side is `SPACE`.
- Supported trade pairs come from mvcswap `/swap/allpairs` at runtime. They must not be hardcoded in the app.
- The default slippage must match the current mvcswap web app default. As of March 27, 2026, that is `1%`.
- The skill may override slippage from natural language when the user says so.
- The skill must follow the existing IDBots skill pattern: skill script handles application logic and talks to local core capabilities over local RPC.
- The Electron main process must expose only generic wallet/account primitives. It must not expose mvcswap-specific route names, request state, or business decisions.
- Phase 1 should prefer local HTTP RPC additions in `metaidRpcServer.ts` instead of adding renderer-only dependencies.

## Phase 1 Scope

- Add a new official skill directory: `SKILLs/metabot-trade-mvcswap/`
- Support these user intents:
  - discover supported `SPACE` pairs,
  - quote `SPACE -> token`,
  - quote `token -> SPACE`,
  - execute `SPACE -> token`,
  - execute `token -> SPACE`.
- Add or expose the minimum generic local RPC primitives needed for the skill to:
  - read the current MetaBot account summary,
  - read current balances,
  - read current MVC fee tiers/default rate,
  - build complete signed MVC raw transactions with `noBroadcast`,
  - build complete signed MVC FT transfer raw transactions with `noBroadcast`.
- Keep all mvcswap HTTP calls, pair selection, quote calculations, confirmation semantics, and final swap request assembly inside the skill.

## Non-Goals

- no `swapv2`,
- no liquidity operations,
- no `token -> token` execution,
- no persistent preview state or `preview_id` stored in core,
- no generic "sign any raw tx" RPC,
- no renderer UI work in Phase 1,
- no scheduled-task or private-chat specialization in Phase 1,
- no marketplace/service-square specific packaging beyond making the skill usable there.

## UX Model

### Supported intent classes

Phase 1 handles three classes of requests:

1. Discovery and quote
- "What SPACE pairs are supported?"
- "How much MC for 10 SPACE?"
- "How much SPACE if I sell 500 MC?"

2. Preview then wait for confirmation
- "Help me buy 10 SPACE worth of MC"
- "I want to sell 500 MC"

3. Immediate execution
- "Buy 10 SPACE of MC, confirm trade"
- "Sell 500 MC to SPACE, execute directly"

### Confirmation semantics

The skill decides whether it can execute immediately from user language:

- if the request includes a clear second-confirmation meaning such as `确认交易`, `确定执行`, or `无需询问`, the skill may execute immediately,
- otherwise the skill must return a preview and ask for confirmation.

Phase 1 does not store a preview token in core. When a user confirms after a preview, the skill recomputes the latest quote and requests fresh mvcswap args before execution.

### Response shape

Preview responses should consistently include:

- direction,
- input amount,
- estimated output,
- minimum received after slippage,
- slippage setting,
- a concise confirmation instruction.

Execution success responses should consistently include:

- direction,
- input amount,
- expected output summary,
- mvcswap txid.

Execution failure responses should prefer user-facing business errors over raw SDK or HTTP errors.

## Responsibility Boundary

### Skill responsibilities

`metabot-trade-mvcswap` owns:

- natural-language intent parsing,
- pair discovery from mvcswap,
- `SPACE <-> token` validation,
- exact-in quote logic,
- slippage parsing and defaulting,
- direct-execute vs preview-only decision,
- mvcswap `/reqswapargs` calls,
- final payload assembly for `/token1totoken2` and `/token2totoken1`,
- mapping low-level failures into stable user-facing messages.

### Core responsibilities

IDBots core owns only generic wallet/account capabilities:

- resolve the current MetaBot account summary,
- resolve chain balances for that MetaBot,
- expose current fee tiers/default rate,
- construct MVC raw transfer transactions without broadcasting,
- construct MVC FT transfer transactions without broadcasting.

Core must not:

- know mvcswap pair symbols,
- know mvcswap route names,
- keep mvcswap request indexes,
- decide whether a trade is acceptable,
- store or manage swap previews,
- expose a broad arbitrary signing interface.

## Existing Code Reuse

Phase 1 should reuse current code paths wherever possible.

### Reuse directly

- `metabotStore.getMetabotById()` and existing metabot wallet lookups for account summary data.
- `addressBalanceService.ts` for chain balance fetching.
- existing global fee-rate store and `idbots:getTransferFeeSummary` behavior for MVC fee defaults.
- `transferMvcWorker.ts` as the proven pattern for `meta-contract` `Wallet.sendArray(..., { noBroadcast: true })` in a subprocess.

### Extend rather than duplicate

- `metaidRpcServer.ts` should gain new generic HTTP routes instead of reimplementing logic in skill scripts.
- the existing MVC transfer worker should be generalized or wrapped so it can return the metadata the skill needs, not only `txHex`.
- a new FT worker should follow the same subprocess pattern as the existing MVC worker and use `meta-contract` `FtManager.transfer(..., { noBroadcast: true })`.

### Do not reuse as-is

- `executeTransfer()` in `transferService.ts` broadcasts immediately, so it is not suitable for mvcswap raw transaction assembly.

## Generic Local RPC Endpoints

These endpoints should live under the existing local RPC server and remain generic.

### 1. `POST /api/idbots/metabot/account-summary`

Request:

```json
{
  "metabot_id": 1
}
```

Response:

```json
{
  "success": true,
  "metabot_id": 1,
  "name": "MetaBot Name",
  "mvc_address": "1...",
  "btc_address": "1...",
  "doge_address": "D...",
  "public_key": "..."
}
```

Purpose:

- give the skill the current MetaBot address material without exposing mnemonic,
- reuse current store-backed metabot data.

### 2. `POST /api/idbots/address/balance`

Request:

```json
{
  "metabot_id": 1
}
```

or

```json
{
  "addresses": {
    "mvc": "1..."
  }
}
```

Response should match the existing balance shape already used by the app, for example:

```json
{
  "success": true,
  "balance": {
    "mvc": {
      "value": 12.34,
      "unit": "SPACE"
    }
  }
}
```

Purpose:

- let the skill preflight `SPACE` balance without new chain-specific code.

### 3. `GET /api/idbots/fee-rate-summary?chain=mvc`

Response:

```json
{
  "success": true,
  "list": [
    { "title": "Slow", "desc": "...", "feeRate": 1 }
  ],
  "defaultFeeRate": 1
}
```

Purpose:

- keep skill transaction building aligned with the same default fee tiers used elsewhere in IDBots.

### 4. `POST /api/idbots/wallet/mvc/build-transfer-rawtx`

Request:

```json
{
  "metabot_id": 1,
  "to_address": "1...",
  "amount_sats": 1000000,
  "fee_rate": 1,
  "exclude_outpoints": ["txid:vout"]
}
```

Response:

```json
{
  "success": true,
  "raw_tx": "...",
  "txid": "...",
  "output_index": 0,
  "spent_outpoints": ["txid:vout"],
  "change_outpoint": "txid:vout"
}
```

Purpose:

- construct a complete MVC payment transaction with `noBroadcast`,
- optionally avoid specific UTXOs to reduce unbroadcast double-spend risk when the skill builds multiple transactions in one swap flow.

### 5. `POST /api/idbots/wallet/mvc-ft/build-transfer-rawtx`

Request:

```json
{
  "metabot_id": 1,
  "token": {
    "symbol": "MC",
    "tokenID": "...",
    "genesisHash": "...",
    "codeHash": "...",
    "decimal": 8
  },
  "to_address": "1...",
  "amount": "500000000",
  "fee_rate": 1,
  "exclude_outpoints": ["txid:vout"]
}
```

Response:

```json
{
  "success": true,
  "raw_tx": "...",
  "output_index": 0,
  "amount_check_raw_tx": "...",
  "spent_outpoints": ["txid:vout"],
  "change_outpoint": "txid:vout"
}
```

Purpose:

- construct a complete MVC FT transfer transaction and the associated amount-check transaction with `noBroadcast`,
- return the output index needed by mvcswap,
- remain generic to any MVC FT transfer, not just swaps.

## Skill Workflow

### 1. Parse the user request

The skill should normalize:

- trade direction,
- token symbol,
- exact-in amount,
- whether the amount is in `SPACE` or in the token,
- optional slippage override,
- whether the request includes immediate execution intent.

If the request is not clearly one of:

- quote,
- previewable exact-in trade,
- directly executable exact-in trade,

the skill should ask a concise follow-up question instead of guessing.

### 2. Discover and validate the pair

The skill calls mvcswap `/swap/allpairs` and filters to pairs where one side is `SPACE`.

Validation rules:

- the requested token must exist in the live pair list,
- one side must be `SPACE`,
- the request must map cleanly to either `SPACE -> token` or `token -> SPACE`.

### 3. Quote

The skill calls mvcswap `/router/route` for exact-in estimation.

The skill then derives:

- estimated output,
- minimum received using slippage,
- stable display labels for direction and units.

If the user only asked for a quote, the flow ends here.

### 4. Decide preview vs immediate execution

- if the request has no explicit confirmation phrase, return a preview only,
- if the request clearly authorizes execution, continue into the swap flow.

### 5. Build the live execution request

Before execution, the skill must fetch fresh data again:

- latest pair list if needed,
- latest quote,
- latest `/swapinfo` if needed for validation or warnings,
- fresh `/reqswapargs`.

The skill must not reuse an old `requestIndex`.

### 6. `SPACE -> token` execution

1. Fetch current MetaBot MVC address from local account summary RPC.
2. Call mvcswap `/reqswapargs` with:
   - the pair symbol,
   - the sender MVC address,
   - op `3`.
3. Build one MVC raw transaction through the generic local RPC:
   - destination is `mvcToAddress`,
   - amount is `exactIn + txFee`.
4. Submit mvcswap `/token1totoken2` with:
   - `symbol`,
   - `requestIndex`,
   - `mvcRawTx`,
   - `mvcOutputIndex`.

### 7. `token -> SPACE` execution

1. Fetch current MetaBot MVC address from local account summary RPC.
2. Call mvcswap `/reqswapargs` with:
   - the pair symbol,
   - the sender MVC address,
   - op `4`.
3. Build the FT transfer raw transaction through the generic FT RPC:
   - destination is `tokenToAddress`,
   - amount is the exact-in token amount.
4. Build one MVC raw transaction through the generic MVC RPC:
   - destination is `mvcToAddress`,
   - amount is only `txFee`.
5. Submit mvcswap `/token2totoken1` with:
   - `symbol`,
   - `requestIndex`,
   - `token2RawTx`,
   - `token2OutputIndex`,
   - `amountCheckRawTx`,
   - `mvcRawTx`,
   - `mvcOutputIndex`.

### 8. Return a stable result

On success, the skill should return:

- direction,
- input amount,
- estimated output summary,
- mvcswap txid.

On failure, the skill should map the error to a user-facing explanation where possible.

## Confirmation And Safety Rules

- Default slippage is `1%`, matching mvcswap as verified on March 27, 2026.
- Users may override slippage in natural language.
- The skill must reject any execution request that is not `exact-in`.
- The skill must reject any execution request where neither side is `SPACE`.
- The skill should re-quote on final execution rather than trying to preserve a stale preview.
- The skill should warn, but not necessarily block, when price impact appears high or the pool appears shallow.
- The skill should stop and ask for clarification when a token symbol is ambiguous.

## Error Handling

The skill should normalize these common failures:

- unsupported pair,
- ambiguous token name,
- amount missing or invalid,
- non-`SPACE <-> token` request,
- exact-out execution request,
- insufficient `SPACE` balance for required fee/payment,
- slippage limit exceeded,
- expired or invalid mvcswap `requestIndex`,
- temporary mvcswap API failure.

Preferred user-facing messages:

- "Current mvcswap pair does not support `SPACE/XXX`."
- "Phase 1 only supports `SPACE <-> token` trades."
- "Phase 1 only supports exact-in quotes and exact-in execution."
- "Balance is insufficient for this trade."
- "Price moved beyond your slippage limit. Please try again."
- "This swap request expired. Please request the trade again."

## Security Model

- The skill never receives mnemonic directly.
- Core RPC responses must not include mnemonic, WIF, or any reusable signing secret.
- Core exposes constrained transaction-building primitives, not arbitrary raw transaction signing.
- The local HTTP RPC continues to bind to `127.0.0.1` only.
- mvcswap raw transactions built for swap submission must not be broadcast independently.

## Validation Strategy

### Service and skill-level checks

- pair filtering to `SPACE <-> token`,
- exact-in intent parsing,
- slippage default and override parsing,
- confirmation phrase handling,
- preview vs execute branching,
- mvcswap request assembly for both directions.

### Local integration checks

- skill -> local RPC account summary,
- skill -> local RPC balance,
- skill -> local RPC fee summary,
- skill -> MVC raw tx builder worker,
- skill -> FT raw tx builder worker.

### End-to-end checks

Use a test MetaBot and small real amounts to validate:

- quote only for `SPACE -> MC`,
- quote only for `MC -> SPACE`,
- execute `SPACE -> MC`,
- execute `MC -> SPACE`,
- one additional live `SPACE <-> METAID` path.

Failure-path validation should cover:

- unsupported token,
- invalid amount,
- missing confirmation,
- insufficient balance,
- slippage breach,
- expired `requestIndex`.

## Implementation Surface

Phase 1 is expected to touch:

- `SKILLs/metabot-trade-mvcswap/`
- `src/main/services/metaidRpcServer.ts`
- a new generic wallet raw-tx service or worker wrapper under `src/main/services/`
- `src/main/libs/transferMvcWorker.ts` or a generalized successor
- a new FT raw-tx worker under `src/main/libs/`

The renderer should remain untouched unless a shared type surface must be updated for build consistency.

## Open Questions

None for Phase 1. The scope, confirmation model, pair model, and architecture boundary are fixed by this design.
