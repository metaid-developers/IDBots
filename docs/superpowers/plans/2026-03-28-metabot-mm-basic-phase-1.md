# Metabot MM Basic Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `metabot-mm-basic` as an official built-in skill that can quote and simulate exact-in `BTC <-> SPACE` and `DOGE <-> SPACE` market-making flows with inventory-based pricing, strict payment verification, deterministic refund rules, and a structured `--payload` execution contract.

**Architecture:** Keep market-making business logic inside `SKILLs/metabot-mm-basic/` and expose only minimal generic transfer/account primitives from Electron core. Use a dedicated runtime JSON config under user-data, a deterministic pricing + payment-verification execution core, and targeted Node tests plus RPC route tests. Defer Gig Square/service-order integration; Phase 1 ships as an ordinary skill simulation with explicit payout/refund address seams.

**Tech Stack:** Electron main process, local HTTP RPC via `metaidRpcServer.ts`, Node.js 18+ skill scripts, existing `transferService.ts`, external CEX price API at `https://www.metalet.space/wallet-api/v3/coin/price?net=mainnet`, Node `node:test`, existing `SkillManager` built-in skill discovery.

---

## File Map

### New skill files

- Create: `SKILLs/metabot-mm-basic/SKILL.md`
  - Natural-language contract, examples, and strict routing behavior for quote vs execute.
- Create: `SKILLs/metabot-mm-basic/scripts/index.js`
  - `--payload` JSON entrypoint; optional natural-language fallback only if useful for local testing.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/payload.js`
  - Parse and validate structured payloads, derive authoritative pair/direction/input asset semantics.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/config.js`
  - Resolve runtime config path and load/validate JSON config.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/marketData.js`
  - Fetch `btc/doge/space` USDT spot values, compute cross rates, handle fallback policy.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/pricing.js`
  - Inventory skew, `mid`, `bid`, `ask`, rounding, and slippage calculations.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/paymentProof.js`
  - Strict payment-proof validation contract for `BTC`, `DOGE`, and `SPACE`.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/state.js`
  - Idempotency key helpers and terminal-outcome contract for duplicate/retry handling.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/localRpc.js`
  - Thin wrappers around local RPC endpoints for account, balance, fee, and transfer execution.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/execution.js`
  - Orchestrate quote/execute/refund/void flow.
- Create: `SKILLs/metabot-mm-basic/scripts/lib/formatter.js`
  - Stable user-facing responses for quote, preview, execute, refund, and void cases.

### Core/main-process files

- Modify: `src/main/libs/coworkUtil.ts`
  - Inject `IDBOTS_APP_DATA_PATH` and `IDBOTS_USER_DATA_PATH` into skill env so the skill can default to a writable config location.
- Modify: `src/main/services/metaidRpcServer.ts`
  - Add a generic transfer execution route for skill scripts.
- Possibly modify: `src/main/services/transferService.ts`
  - Only if the new RPC route needs small validation or return-shape adjustments; avoid unrelated refactors.
- Modify: `SKILLs/skills.config.json`
  - Register `metabot-mm-basic` order/version/enabled defaults.

### Test files

- Create: `tests/metabotMmBasicSkill.test.mjs`
  - Built-in skill discovery, prompt content, and `--payload` runner contract.
- Create: `tests/metabotMmBasicConfig.test.mjs`
  - Config path resolution, config validation, trade-limit/max-usable schema, fallback gating, and config reload behavior.
- Create: `tests/metabotMmBasicPricing.test.mjs`
  - Fair value, spread units, inventory skew direction, clamp behavior, and slippage rule.
- Create: `tests/metabotMmBasicExecution.test.mjs`
  - Structured quote/execute/refund/idempotency flows using mocked RPC + mocked market data.
- Modify: `tests/metaidRpcWalletRoutes.test.mjs`
  - Cover the new generic transfer RPC route.

## Task 1: Scaffold The Built-In Skill Shell

**Files:**
- Create: `SKILLs/metabot-mm-basic/SKILL.md`
- Create: `SKILLs/metabot-mm-basic/scripts/index.js`
- Modify: `SKILLs/skills.config.json`
- Test: `tests/metabotMmBasicSkill.test.mjs`

- [ ] **Step 1: Write the failing built-in skill discovery test**

```js
test('listSkills exposes metabot-mm-basic as an enabled built-in skill', () => {
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-mm-basic');
  assert.ok(skill);
  assert.equal(skill.enabled, true);
  assert.equal(skill.isBuiltIn, true);
  assert.equal(skill.isOfficial, true);
});
```

- [ ] **Step 2: Add a failing prompt-content assertion**

```js
test('metabot-mm-basic prompt advertises market making, exact-in, and BTC/SPACE + DOGE/SPACE coverage', () => {
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-mm-basic');
  assert.match(skill.prompt, /BTC|DOGE|SPACE/i);
  assert.match(skill.prompt, /做市|market/i);
  assert.match(skill.prompt, /exact-in|按市价|询价|退款/i);
});
```

- [ ] **Step 3: Run the skill test to verify failure**

Run:

```bash
npm run compile:electron
node --test tests/metabotMmBasicSkill.test.mjs
```

Expected: FAIL because the skill directory and config entry do not exist yet.

- [ ] **Step 4: Create the minimal skill shell**

```yaml
---
name: metabot-mm-basic
description: MetaBot 的基础做市技能。用于 BTC/SPACE 与 DOGE/SPACE 的交易对查询、报价、按市价兑换、退款说明与结构化执行；当用户提到做市、兑换、买入、卖出、询价、按市价购买、流动性、退款时都应考虑使用。
official: true
---
```

Task 1 is still only the built-in shell. If routing metadata would otherwise overstate implemented behavior, it is acceptable for the frontmatter description to preserve these routing keywords while explicitly noting that this is the Phase 1 scaffold / stub and that full execution behavior arrives in later tasks.

```js
#!/usr/bin/env node
'use strict';
const { parseArgs } = require('util');
const { values } = parseArgs({ options: { payload: { type: 'string' } } });
if (!values.payload) {
  process.stderr.write('Error: --payload is required.\n');
  process.exit(1);
}
process.stdout.write(`${JSON.stringify({ mode: 'stub', ok: true })}\n`);
```

- [ ] **Step 5: Add the built-in default entry**

```json
"metabot-mm-basic": {
  "order": 22,
  "version": "1.0.0",
  "creator-metaid": "",
  "installedAt": 1774656000000,
  "enabled": true
}
```

- [ ] **Step 6: Re-run the targeted skill test**

Run:

```bash
npm run compile:electron
node --test tests/metabotMmBasicSkill.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add SKILLs/metabot-mm-basic SKILLs/skills.config.json tests/metabotMmBasicSkill.test.mjs
git commit -m "feat: scaffold metabot mm basic skill"
```

## Task 2: Add The Runtime Config Path And Payload Contract

**Files:**
- Modify: `src/main/libs/coworkUtil.ts`
- Create: `SKILLs/metabot-mm-basic/scripts/lib/payload.js`
- Create: `SKILLs/metabot-mm-basic/scripts/lib/config.js`
- Modify: `SKILLs/metabot-mm-basic/scripts/index.js`
- Test: `tests/metabotMmBasicConfig.test.mjs`
- Test: `tests/metabotMmBasicExecution.test.mjs`

- [ ] **Step 1: Write a failing config-path test**

```js
test('resolveConfigPath defaults to userData/metabot-mm-basic/config.json', () => {
  const result = resolveConfigPath({
    env: { IDBOTS_USER_DATA_PATH: '/tmp/idbots-user' },
  });
  assert.equal(result, '/tmp/idbots-user/metabot-mm-basic/config.json');
});
```

- [ ] **Step 2: Write a failing payload-authority test**

```js
test('pair + direction are authoritative and reject conflicting asset_in', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1', asset_in: 'DOGE' },
  }), /asset_in/i);
});
```

- [ ] **Step 3: Add failing payload-schema tests for settlement and quote-context fields**

```js
test('execute payload requires pay_txid, payer_globalmetaid, payout_address, and refund_address', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: { amount_in: '0.1' },
  }), /pay_txid|payer_globalmetaid|payout_address|refund_address/i);
});

test('quote-confirm payload validates quote_context when has_prior_quote is true', () => {
  assert.throws(() => normalizePayload({
    mode: 'execute',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    order: {
      amount_in: '0.1',
      pay_txid: 'a'.repeat(64),
      payer_globalmetaid: 'gmid',
      payout_address: 'dest',
      refund_address: 'refund',
    },
    quote_context: { has_prior_quote: true, slippage_bps: 100 },
  }), /quoted_output|quoted_at/i);
});
```

- [ ] **Step 3.5: Add a failing discovery-payload test for supported-pair listing**

```js
test('quote payload may omit pair and direction only for supported-pair discovery', () => {
  const result = normalizePayload({
    mode: 'quote',
    query: { kind: 'supported_pairs' },
  });
  assert.equal(result.query.kind, 'supported_pairs');
});
```

- [ ] **Step 4: Add a failing config-schema test for trade limits, max-usable caps, and fallback gating**

```js
test('config requires positive target inventory, trade limits, and explicit quote/execute fallback flags', () => {
  assert.throws(() => validateConfig({
    market_data: { provider: 'cex' },
    pairs: { 'BTC/SPACE': { target_inventory: { BTC: '0', SPACE: '100' } } },
  }), /target|trade_limits|quote_fallback_enabled|execute_fallback_enabled/i);
});
```

- [ ] **Step 5: Add a failing config reload test**

```js
test('loadConfig rereads the JSON file on each quote/execute call instead of caching stale operator edits', () => {
  writeConfig({ pairs: { 'BTC/SPACE': { spread_bps: 200 } } });
  const first = loadConfig({ env });
  writeConfig({ pairs: { 'BTC/SPACE': { spread_bps: 300 } } });
  const second = loadConfig({ env });
  assert.equal(first.pairs['BTC/SPACE'].spread_bps, 200);
  assert.equal(second.pairs['BTC/SPACE'].spread_bps, 300);
});
```

- [ ] **Step 6: Run the config/payload tests to verify failure**

Run:

```bash
node --test tests/metabotMmBasicConfig.test.mjs tests/metabotMmBasicExecution.test.mjs
```

Expected: FAIL because the helpers do not exist.

- [ ] **Step 7: Inject writable runtime data env vars into skill environments**

```ts
env.IDBOTS_APP_DATA_PATH = app.getPath('appData');
env.IDBOTS_USER_DATA_PATH = app.getPath('userData');
```

- [ ] **Step 8: Implement config path + JSON loader**

```js
function resolveConfigPath({ env }) {
  const base = String(env.IDBOTS_USER_DATA_PATH || '').trim();
  if (!base) throw new Error('IDBOTS_USER_DATA_PATH is required.');
  return path.join(base, 'metabot-mm-basic', 'config.json');
}
```

- [ ] **Step 9: Implement the authoritative payload normalizer and required execute fields**

```js
if (order.asset_in && order.asset_in !== derivedAssetIn) {
  throw new Error('asset_in does not match pair + direction');
}
```

Allow `mode: 'quote'` discovery payloads with `query.kind === 'supported_pairs'` to bypass pair-specific validation, but keep pair + direction mandatory for executable settlement and pair-specific quoting.

- [ ] **Step 10: Reject input amounts that exceed supported asset precision**

```js
if (fractionalDigits > maxAssetDecimals) {
  throw new Error('amount_in exceeds supported precision');
}
```

- [ ] **Step 11: Make `scripts/index.js` parse `--payload` JSON into the new helpers**

```js
const payload = JSON.parse(values.payload);
const normalized = normalizePayload(payload);
```

- [ ] **Step 12: Re-run the config/payload tests**

Run:

```bash
node --test tests/metabotMmBasicConfig.test.mjs tests/metabotMmBasicExecution.test.mjs
```

Expected: PASS for the new config-path and payload normalization cases.

- [ ] **Step 13: Commit**

```bash
git add src/main/libs/coworkUtil.ts SKILLs/metabot-mm-basic/scripts/index.js SKILLs/metabot-mm-basic/scripts/lib/payload.js SKILLs/metabot-mm-basic/scripts/lib/config.js tests/metabotMmBasicConfig.test.mjs tests/metabotMmBasicExecution.test.mjs
git commit -m "feat: add mm basic config and payload helpers"
```

## Task 3: Implement Market Data And Pricing

**Files:**
- Create: `SKILLs/metabot-mm-basic/scripts/lib/marketData.js`
- Create: `SKILLs/metabot-mm-basic/scripts/lib/pricing.js`
- Test: `tests/metabotMmBasicPricing.test.mjs`

- [ ] **Step 1: Write the failing fair-value cross-rate test**

```js
test('buildFairValue computes BTC/SPACE from btc and space USDT quotes', async () => {
  const quotes = { btc: 66960.15, space: 0.0502, doge: 0.0925 };
  assert.equal(computeCrossRate(quotes, 'BTC/SPACE'), '1333867.53');
});
```

- [ ] **Step 2: Write the failing spread-bps test**

```js
test('quoteFromMid uses spread_bps as total spread', () => {
  const quote = buildBidAsk({ mid: 100, spreadBps: 200 });
  assert.equal(quote.ask, '101');
  assert.equal(quote.bid, '99');
});
```

- [ ] **Step 3: Write the failing inventory-skew + clamp test**

```js
test('inventory skew raises mid when SPACE is abundant and BTC is scarce', () => {
  const result = computeSkewBps({
    targetBase: '1',
    currentBase: '0.8',
    targetQuote: '100000',
    currentQuote: '120000',
    sensitivityBps: 500,
    maxSkewBps: 300,
  });
  assert.equal(result, 200);
});
```

- [ ] **Step 4: Write the failing slippage-rule test**

```js
test('slippage rejects execute when latest output is worse than quoted output beyond slippage_bps', () => {
  assert.equal(isWithinSlippage({
    quotedOutput: '1000',
    latestOutput: '989',
    slippageBps: 100,
  }), false);
});
```

- [ ] **Step 5: Add a failing fallback-gating test**

```js
test('fallback fair value is allowed for quote but blocked for execute when execute fallback is disabled', async () => {
  const cfg = { market_data: { quote_fallback_enabled: true, execute_fallback_enabled: false } };
  await assert.doesNotReject(() => resolveFairValue({ mode: 'quote', config: cfg, fetchImpl: failingFetch }));
  await assert.rejects(() => resolveFairValue({ mode: 'execute', config: cfg, fetchImpl: failingFetch }), /fallback/i);
});
```

- [ ] **Step 6: Add a failing cache-behavior test**

```js
test('market data client reuses a short-lived cached quote within cache_ttl_ms', async () => {
  const fetchImpl = mockFetchOnce({ btc: 1, doge: 2, space: 3 });
  await readSpotQuotes({ now: () => 1000, cacheTtlMs: 5000, fetchImpl });
  await readSpotQuotes({ now: () => 1500, cacheTtlMs: 5000, fetchImpl });
  assert.equal(fetchImpl.callCount, 1);
});
```

- [ ] **Step 7: Add a failing usable-inventory clip test**

```js
test('usable inventory clips live balance by max_usable_inventory before skew and settlement checks', () => {
  const usable = resolveUsableInventory({ liveBalance: '1000', maxUsable: '600' });
  assert.equal(usable, '600');
});
```

- [ ] **Step 8: Add a failing dust/min-transfer output guard test**

```js
test('rounded output below minimum transferable amount returns refund_required instead of execute', () => {
  const result = classifyOutputAmount({
    assetOut: 'BTC',
    roundedOutputBaseUnits: '545',
  });
  assert.equal(result, 'refund_required');
});
```

- [ ] **Step 9: Add a failing round-down precision test for settlement output**

```js
test('roundExecutableOutput floors output to supported asset precision before transfer and dust checks', () => {
  const result = roundExecutableOutput({
    assetOut: 'BTC',
    rawOutput: '0.123456789',
  });
  assert.equal(result, '0.12345678');
});
```

- [ ] **Step 10: Run the pricing tests to verify failure**

Run:

```bash
node --test tests/metabotMmBasicPricing.test.mjs
```

Expected: FAIL because the pricing helpers do not exist.

- [ ] **Step 11: Implement market-data fetch, validation, fallback gating, and cache**

```js
if (!Number.isFinite(json.btc) || json.btc <= 0) {
  throw new Error('Invalid btc quote');
}
```

- [ ] **Step 12: Implement pricing, spread, skew, usable-inventory clipping, round-down settlement, slippage helpers, and dust guards**

```js
const ask = mid.mul(new Decimal(1).plus(new Decimal(spreadBps).div(20000)));
const bid = mid.mul(new Decimal(1).minus(new Decimal(spreadBps).div(20000)));
```

- [ ] **Step 13: Re-run the pricing tests**

Run:

```bash
node --test tests/metabotMmBasicPricing.test.mjs
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add SKILLs/metabot-mm-basic/scripts/lib/marketData.js SKILLs/metabot-mm-basic/scripts/lib/pricing.js tests/metabotMmBasicPricing.test.mjs
git commit -m "feat: add mm basic market data and pricing"
```

## Task 4: Implement Payment Verification And Terminal-Outcome Rules

**Files:**
- Create: `SKILLs/metabot-mm-basic/scripts/lib/paymentProof.js`
- Create: `SKILLs/metabot-mm-basic/scripts/lib/state.js`
- Test: `tests/metabotMmBasicExecution.test.mjs`

- [ ] **Step 1: Write the failing strict-amount-match test**

```js
test('payment verification rejects when normalized base units do not match exactly', async () => {
  await assert.rejects(
    () => verifyPaymentProof({ expectedBaseUnits: '10000', paidBaseUnits: '9999' }),
    /amount/i
  );
});
```

- [ ] **Step 2: Write a failing payment-proof discoverability + chain test**

```js
test('payment proof rejects txs that are missing, on the wrong chain, or absent from the tx source', async () => {
  await assert.rejects(() => verifyPaymentProof({
    expectedChain: 'btc',
    txSourceResult: null,
  }), /discoverable|chain/i);
});
```

- [ ] **Step 3: Write a failing recipient-address summing test**

```js
test('payment proof sums outputs to the bot receiving address and rejects mismatched totals', async () => {
  await assert.rejects(() => verifyPaymentProof({
    expectedReceivingAddress: 'bot-btc-address',
    txOutputs: [
      { address: 'bot-btc-address', baseUnits: '5000' },
      { address: 'other', baseUnits: '5000' },
    ],
    expectedBaseUnits: '15000',
  }), /receiving address|amount/i);
});
```

- [ ] **Step 4: Write the failing idempotency test**

```js
test('duplicate execute for the same pay_txid returns the recorded terminal outcome', async () => {
  const state = createInMemoryTerminalState();
  await recordTerminalOutcome(state, 'txid-1', { mode: 'executed' });
  const result = await getTerminalOutcome(state, 'txid-1');
  assert.equal(result.mode, 'executed');
});
```

- [ ] **Step 5: Write the failing lifecycle-state test**

```js
test('execution lifecycle records pending_payment_proof, validated, and executed canonical states in order', async () => {
  const trace = createLifecycleTrace();
  await trace.mark('pending_payment_proof');
  await trace.mark('validated');
  await trace.mark('executed');
  assert.deepEqual(trace.states, ['pending_payment_proof', 'validated', 'executed']);
});
```

- [ ] **Step 6: Write the failing late-payment reconciliation test**

```js
test('late payment after tx lookup void resolves to refund_required rather than delayed execute', async () => {
  const result = classifyLatePayment({ previousOutcome: 'void', txFoundLater: true });
  assert.equal(result, 'refund_required');
});
```

- [ ] **Step 7: Write the failing tx-lookup retry/void test**

```js
test('missing tx lookup retries once after ~5 seconds and then returns void when still unresolved', async () => {
  const result = await verifyWithRetry({ txid: 'a'.repeat(64), retryDelayMs: 5000 }, failingSourceTwice);
  assert.equal(result.mode, 'void');
  assert.equal(result.lookupAttempts, 2);
});
```

- [ ] **Step 8: Run the execution test file to verify failure**

Run:

```bash
node --test tests/metabotMmBasicExecution.test.mjs
```

Expected: FAIL because verification/state helpers do not exist yet.

- [ ] **Step 9: Implement strict base-unit normalization and full payment-proof checks**

```js
if (expectedBaseUnits !== observedBaseUnits) {
  throw new Error('Paid amount does not exactly match requested amount');
}
```

- [ ] **Step 10: Implement tx lookup retry/void behavior and operator-visible reconciliation metadata**

```js
if (attempts >= 2) {
  return { mode: 'void', needsOperatorReconciliation: true };
}
```

- [ ] **Step 11: Implement the terminal-outcome key contract and canonical lifecycle-state helpers**

```js
function buildIdempotencyKey({ serviceOrderPinId, payTxid, pair, direction, payerGlobalmetaid }) {
  return serviceOrderPinId
    ? `${serviceOrderPinId}:${payTxid}`
    : `${payTxid}:${pair}:${direction}:${payerGlobalmetaid}`;
}
```

- [ ] **Step 12: Re-run the execution tests**

Run:

```bash
node --test tests/metabotMmBasicExecution.test.mjs
```

Expected: PASS for strict amount, duplicate-call, and late-payment classification cases.

- [ ] **Step 13: Commit**

```bash
git add SKILLs/metabot-mm-basic/scripts/lib/paymentProof.js SKILLs/metabot-mm-basic/scripts/lib/state.js tests/metabotMmBasicExecution.test.mjs
git commit -m "feat: add mm basic payment verification rules"
```

## Task 5: Expose Generic Transfer Execution Over Local RPC

**Files:**
- Modify: `src/main/services/metaidRpcServer.ts`
- Possibly modify: `src/main/services/transferService.ts`
- Modify: `tests/metaidRpcWalletRoutes.test.mjs`

- [ ] **Step 1: Write the failing RPC-route test for generic transfer execution**

```js
test('rpc transfer route forwards btc, doge, and space transfer requests through the same generic contract', async () => {
  // Assert route path, JSON parsing, and success payload shape for chain = btc | doge | space.
});
```

- [ ] **Step 2: Write the failing validation test for malformed transfer requests**

```js
test('rpc transfer route rejects unsupported chain or missing fields with 400', async () => {
  // Assert 400 for invalid chain / missing to_address / invalid amount.
});
```

- [ ] **Step 3: Run the RPC route tests to verify failure**

Run:

```bash
npm run compile:electron
node --test tests/metaidRpcWalletRoutes.test.mjs
```

Expected: FAIL because the route does not exist yet.

- [ ] **Step 4: Add a generic route such as `/api/idbots/wallet/transfer`**

```ts
const EXECUTE_TRANSFER_PATH = '/api/idbots/wallet/transfer';
```

```ts
const result = await executeTransfer(store, {
  metabotId,
  chain,
  toAddress,
  amount,
  feeRate,
});
```

- [ ] **Step 5: Keep the route generic**

```ts
// Accept only generic wallet transfer fields such as metabot_id, chain, to_address, amount,
// and optional generic fee controls. Do not add market-maker-specific semantics here.
```

- [ ] **Step 6: Re-run compile + RPC tests**

Run:

```bash
npm run compile:electron
node --test tests/metaidRpcWalletRoutes.test.mjs
```

Expected: PASS for the new generic transfer route without regressing the existing raw-tx route coverage.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/metaidRpcServer.ts src/main/services/transferService.ts tests/metaidRpcWalletRoutes.test.mjs
git commit -m "feat: add generic transfer rpc for mm skills"
```

## Task 6: Finish The End-To-End Execution Core

**Files:**
- Create: `SKILLs/metabot-mm-basic/scripts/lib/localRpc.js`
- Create: `SKILLs/metabot-mm-basic/scripts/lib/formatter.js`
- Modify: `SKILLs/metabot-mm-basic/scripts/lib/execution.js`
- Modify: `SKILLs/metabot-mm-basic/scripts/index.js`
- Test: `tests/metabotMmBasicExecution.test.mjs`

- [ ] **Step 1: Write the failing quote-flow test**

```js
test('quote flow can list supported pairs with latest bid/ask snapshots', async () => {
  const result = await handleMmRequest({
    mode: 'quote',
    query: { kind: 'supported_pairs' },
  }, deps);
  assert.equal(result.mode, 'quoted');
  assert.ok(result.supportedPairs.find((entry) => entry.pair === 'BTC/SPACE'));
  assert.ok(result.supportedPairs.find((entry) => entry.pair === 'DOGE/SPACE'));
});
```

- [ ] **Step 2: Write the failing quote-flow side-mapping test**

```js
test('quote flow uses bid for BTC -> SPACE and ask for SPACE -> BTC, with latest-price settlement warning', async () => {
  const btcToSpace = await handleMmRequest({
    mode: 'quote',
    service: { pair: 'BTC/SPACE', direction: 'btc_to_space' },
    ...payload,
  }, deps);
  const spaceToBtc = await handleMmRequest({
    mode: 'quote',
    service: { pair: 'BTC/SPACE', direction: 'space_to_btc' },
    ...payload,
  }, deps);
  assert.equal(btcToSpace.quote.side, 'bid');
  assert.equal(spaceToBtc.quote.side, 'ask');
  assert.match(btcToSpace.message, /latest price/i);
});
```

- [ ] **Step 3: Write the failing execute-success test**

```js
test('execute flow uses bid for BTC -> SPACE settlement and ask for SPACE -> BTC settlement', async () => {
  const sellBase = await handleMmRequest({ mode: 'execute', service: { pair: 'BTC/SPACE', direction: 'btc_to_space' }, ...payload }, deps);
  const buyBase = await handleMmRequest({ mode: 'execute', service: { pair: 'BTC/SPACE', direction: 'space_to_btc' }, ...payload }, deps);
  assert.equal(sellBase.mode, 'executed');
  assert.equal(buyBase.mode, 'executed');
  assert.deepEqual(sellBase.lifecycle, ['pending_payment_proof', 'validated', 'executed']);
  assert.equal(fakeTransferCalls[0].pricingSide, 'bid');
  assert.equal(fakeTransferCalls[1].pricingSide, 'ask');
});
```

- [ ] **Step 4: Write the failing refund-on-insufficient-inventory test**

```js
test('insufficient inventory triggers refund transfer instead of partial fill', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, deps);
  assert.equal(result.mode, 'refunded');
  assert.deepEqual(result.lifecycle, ['pending_payment_proof', 'validated', 'refund_required', 'refunded']);
  assert.equal(fakeRefundCalls.length, 1);
});
```

- [ ] **Step 5: Add a failing trade-limit test**

```js
test('execute flow refunds when amount_in is outside configured min/max trade limits', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, deps);
  assert.equal(result.mode, 'refunded');
  assert.match(result.message, /minimum|maximum/i);
});
```

- [ ] **Step 6: Add a failing direct-market-vs-quote-confirm slippage test**

```js
test('direct market ignores quote snapshot while quote-confirm enforces slippage_bps', async () => {
  const market = await handleMmRequest({ mode: 'execute', quote_context: { has_prior_quote: false }, ...payload }, deps);
  const quoted = await handleMmRequest({ mode: 'execute', quote_context: { has_prior_quote: true, slippage_bps: 100, quoted_output: '1000', quoted_at: '2026-03-28T12:00:00Z' }, ...payload }, deps);
  assert.equal(market.mode, 'executed');
  assert.equal(quoted.mode, 'refunded');
});
```

- [ ] **Step 7: Add failing refund-fee-responsibility messaging tests**

```js
test('amount mismatch refund message says payer bore the refund fee', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, mismatchDeps);
  assert.match(result.message, /payer|Bot A|refund fee/i);
});

test('inventory shortage refund message says maker absorbed the refund fee', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, inventoryDeps);
  assert.match(result.message, /Bot B|maker|refund fee/i);
});
```

- [ ] **Step 8: Add failing refund-amount behavior tests**

```js
test('amount mismatch refund returns principal net of payer-borne refund fee', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, mismatchDeps);
  assert.equal(result.mode, 'refunded');
  assert.equal(fakeRefundCalls[0].feeBearer, 'payer');
  assert.equal(fakeRefundCalls[0].refundAmountMode, 'net_of_fee');
});

test('inventory shortage refund targets full principal with maker-borne refund fee policy', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, inventoryDeps);
  assert.equal(result.mode, 'refunded');
  assert.equal(fakeRefundCalls[0].feeBearer, 'maker');
  assert.equal(fakeRefundCalls[0].refundAmountMode, 'full_principal');
});
```

- [ ] **Step 9: Add failing payout/refund transfer failure tests**

```js
test('payout transfer failure returns payout_failed outcome instead of silent success', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, payoutFailureDeps);
  assert.equal(result.mode, 'payout_failed');
});

test('refund transfer failure returns refund_failed outcome with operator-visible detail', async () => {
  const result = await handleMmRequest({ mode: 'execute', ...payload }, refundFailureDeps);
  assert.equal(result.mode, 'refund_failed');
  assert.match(result.message, /operator|manual/i);
});
```

- [ ] **Step 10: Run the execution tests to verify failure**

Run:

```bash
node --test tests/metabotMmBasicExecution.test.mjs
```

Expected: FAIL because quote/execute/refund orchestration is incomplete.

- [ ] **Step 11: Implement local RPC wrappers**

```js
async function executeTransferViaRpc({ env, fetchImpl, body }) {
  return readJson(await fetchImpl(`${getRpcBase(env)}/api/idbots/wallet/transfer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
```

- [ ] **Step 12: Create `execution.js` and implement discovery, quote, execute, refund, and void orchestration**

```js
if (outcome.kind === 'refund_required') {
  return runRefund(...);
}
return runPayout(...);
```

- [ ] **Step 13: Re-run the execution tests**

Run:

```bash
node --test tests/metabotMmBasicExecution.test.mjs
```

Expected: PASS for quote, execute, refund, idempotency, and void cases.

- [ ] **Step 14: Commit**

```bash
git add SKILLs/metabot-mm-basic/scripts/index.js SKILLs/metabot-mm-basic/scripts/lib/localRpc.js SKILLs/metabot-mm-basic/scripts/lib/formatter.js SKILLs/metabot-mm-basic/scripts/lib/execution.js tests/metabotMmBasicExecution.test.mjs
git commit -m "feat: add mm basic execution flow"
```

## Task 7: Write The Final SKILL.md And Tighten Built-In Verification

**Files:**
- Modify: `SKILLs/metabot-mm-basic/SKILL.md`
- Modify: `tests/metabotMmBasicSkill.test.mjs`
- Reference: `SKILLs/skill-creator/SKILL.md`
- Reference: `SKILLs/metabot-omni-caster/SKILL.md`
- Reference: `SKILLs/metabot-post-buzz/SKILL.md`

- [ ] **Step 1: Write the failing prompt/routing assertions for final skill behavior**

```js
test('metabot-mm-basic prompt explains exact-in, quote-first vs direct-market, and refund cases', () => {
  assert.match(skill.prompt, /exact-in|按市价/i);
  assert.match(skill.prompt, /BTC\/SPACE|DOGE\/SPACE/i);
  assert.match(skill.prompt, /退款|refund/i);
});
```

- [ ] **Step 2: Rewrite `SKILL.md` in the stronger built-in style**

```md
1. 识别请求是查询支持交易对、询价、还是执行兑换。
2. 如需结构化执行，调用 `node "$SKILLS_ROOT/metabot-mm-basic/scripts/index.js" --payload '<JSON>'`。
3. 对直接市价成交，明确说明最终以收款时最新价格为准。
```

- [ ] **Step 2.5: Validate the draft against the repository's skill-writing standard before finalizing**

Check these references while writing:

- `SKILLs/skill-creator/SKILL.md` for the expected frontmatter discipline, triggering-description style, and progressive-disclosure guidance.
- `SKILLs/metabot-omni-caster/SKILL.md` and `SKILLs/metabot-post-buzz/SKILL.md` for stronger built-in natural-language routing patterns.
- Do not model this file after `metabot-trade-mvcswap`.

The final `SKILL.md` should clearly:

- distinguish pair discovery, quote-only, quote-then-confirm, and execute-now requests,
- route structured execution through `--payload` instead of embedding business logic in prose,
- explain exact-in settlement, latest-price execution, and refund outcomes in user-facing terms,
- avoid stuffing future `service-order` details into the skill prompt.

- [ ] **Step 3: Re-run the skill tests**

Run:

```bash
npm run compile:electron
node --test tests/metabotMmBasicSkill.test.mjs
```

Expected: PASS with the final prompt wording.

- [ ] **Step 4: Commit**

```bash
git add SKILLs/metabot-mm-basic/SKILL.md tests/metabotMmBasicSkill.test.mjs
git commit -m "feat: finalize mm basic skill routing"
```

## Task 8: Final Targeted Verification

**Files:**
- Verify only touched files from prior tasks

- [ ] **Step 1: Run the skill-focused unit tests**

Run:

```bash
node --test tests/metabotMmBasicConfig.test.mjs tests/metabotMmBasicPricing.test.mjs tests/metabotMmBasicExecution.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Rebuild Electron output for the built-in skill and RPC tests**

Run:

```bash
npm run compile:electron
```

Expected: successful TypeScript/Electron compile.

- [ ] **Step 3: Run the built-in skill + RPC integration tests**

Run:

```bash
node --test tests/metabotMmBasicSkill.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected: PASS for the new skill discovery and transfer route coverage.

- [ ] **Step 4: Run lint before any keepable implementation commit chain is considered complete**

Run:

```bash
npm run lint
```

Expected: PASS. If unrelated existing lint failures appear, stop and decide whether they are truly pre-existing before proceeding.

- [ ] **Step 5: Document any deliberately deferred work**

```md
- no Gig Square/service-order integration in Phase 1
- no remote globalmetaid multi-chain resolver in Phase 1
- no AMM / BTC<->DOGE / exact-out in Phase 1
```

- [ ] **Step 6: Final commit (only if the previous task commits were intentionally squashed; otherwise skip)**

```bash
git status
```

Expected: clean working tree.

## Suggested Subagent Split

Use subagents where they are independent:

- Worker A: Task 2 + Task 3 (`config`, `marketData`, `pricing`)
- Worker B: Task 4 + Task 6 (`paymentProof`, `state`, `execution`, `formatter`)
- Worker C: Task 5 (`metaidRpcServer` + RPC route tests)

Keep these serial in the main session:

- Task 1, because it establishes the new skill directory and test shell.
- Task 7, because `SKILL.md` should be reviewed after the execution contract settles.
- Task 8, because final verification should happen after integration.
