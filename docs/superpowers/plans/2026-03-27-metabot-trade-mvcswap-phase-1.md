# Metabot Trade Mvcswap Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a production-ready Phase 1 `metabot-trade-mvcswap` skill that can discover `SPACE <-> token` pairs, quote exact-in swaps, preview when confirmation is missing, and execute mvcswap `v1` swaps using the current MetaBot wallet without exposing mnemonic.

**Architecture:** Keep mvcswap business logic in the skill and add only generic local wallet/account primitives in the Electron main process. Reuse existing account, balance, and fee-rate logic where it already exists; add new `noBroadcast` raw-transaction builders through dedicated subprocess workers so MVC and MVC FT transaction assembly stays isolated from the Electron main process.

**Tech Stack:** Electron main process, local HTTP RPC via `metaidRpcServer.ts`, TypeScript services/workers, Node.js 18+ skill scripts, `meta-contract`, mvcswap v1 HTTP API, Node `node:test`, existing `SkillManager` built-in skill discovery.

---

## Inputs

- Spec: `docs/superpowers/specs/2026-03-27-metabot-trade-mvcswap-design.md`
- Existing related code:
  - `src/main/services/metaidRpcServer.ts`
  - `src/main/services/addressBalanceService.ts`
  - `src/main/services/feeRateStore.ts`
  - `src/main/services/metabotWalletService.ts`
  - `src/main/services/transferService.ts`
  - `src/main/libs/transferMvcWorker.ts`
  - `SKILLs/metabot-omni-caster/`
  - `SKILLs/metabot-post-skillservice/`
  - `tests/baoyuImageStudioSkill.test.mjs`
  - `tests/metaAppCoworkPrompt.test.mjs`

## File Map

### New files

- `src/main/services/metabotAccountService.ts`
  - Generic MetaBot account-summary resolver built on the existing store
- `src/main/services/walletRawTxService.ts`
  - Generic `noBroadcast` MVC / MVC FT raw-transaction builder wrappers and transaction summary helpers
- `src/main/libs/buildMvcTransferRawTxWorker.ts`
  - Subprocess worker that builds signed MVC raw transactions without broadcasting
- `src/main/libs/buildMvcFtTransferRawTxWorker.ts`
  - Subprocess worker that builds signed MVC FT transfer raw transactions without broadcasting
- `SKILLs/metabot-trade-mvcswap/SKILL.md`
  - Official skill prompt and operating rules
- `SKILLs/metabot-trade-mvcswap/scripts/index.js`
  - CLI entrypoint used by Cowork / service-square execution
- `SKILLs/metabot-trade-mvcswap/scripts/lib/intent.js`
  - Pure natural-language trade-intent parsing and normalization
- `SKILLs/metabot-trade-mvcswap/scripts/lib/mvcswapApi.js`
  - Thin mvcswap v1 API client helpers
- `SKILLs/metabot-trade-mvcswap/scripts/lib/localRpc.js`
  - Thin local IDBots RPC client helpers
- `SKILLs/metabot-trade-mvcswap/scripts/lib/formatter.js`
  - Stable preview / success / failure message builders
- `SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js`
  - Quote, preview, direct-execute, and request-body assembly flow
- `tests/metabotAccountService.test.mjs`
- `tests/metaidRpcWalletRoutes.test.mjs`
- `tests/walletRawTxService.test.mjs`
- `tests/metabotTradeMvcswapSkill.test.mjs`
- `tests/metabotTradeMvcswapIntent.test.mjs`
- `tests/metabotTradeMvcswapScript.test.mjs`

### Modified files

- `src/main/services/metaidRpcServer.ts`
  - Add generic account-summary, balance, fee-rate-summary, MVC raw-tx, and MVC FT raw-tx HTTP routes
- `src/main/services/addressBalanceService.ts`
  - Only if a small export or response-shape helper is needed for route reuse
- `src/main/libs/transferMvcWorker.ts`
  - Only if extracting common worker utilities is cleaner than duplicating them; otherwise leave untouched

### Verification commands used throughout

- `npm install`
- `npm run compile:electron`
- `node --test tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs`
- `node --test tests/walletRawTxService.test.mjs`
- `node --test tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs`
- `node --test tests/metabotTradeMvcswapScript.test.mjs`
- `npm run lint`
- `npm run electron:dev`

Note:

- `tests/skillFrontmatter.test.mjs` is a known unrelated baseline failure per `localdocs/gotchas.md`.
- Keep verification focused on this feature plus `npm run lint`.

---

### Task 1: Create the Dedicated Worktree and Verify the Baseline

**Files:**
- Existing: `.worktrees/`
- Reference: `docs/superpowers/specs/2026-03-27-metabot-trade-mvcswap-design.md`

- [ ] **Step 1: Create the worktree**

Run:

```bash
git worktree add .worktrees/metabot-trade-mvcswap -b codex/metabot-trade-mvcswap
```

Expected:

- new branch `codex/metabot-trade-mvcswap`
- new directory `.worktrees/metabot-trade-mvcswap`

- [ ] **Step 2: Install dependencies in the worktree**

Run:

```bash
cd .worktrees/metabot-trade-mvcswap
npm install
```

Expected:

- dependencies install cleanly without unexpected lockfile drift

- [ ] **Step 3: Verify the focused baseline**

Run:

```bash
npm run compile:electron
node --test tests/metabotWalletService.test.mjs tests/metaidRpcEndpoint.test.mjs tests/baoyuImageStudioSkill.test.mjs
```

Expected:

- compile passes
- the focused baseline tests pass before feature code is added

- [ ] **Step 4: Record the known baseline caveat**

Note in task notes:

- `tests/skillFrontmatter.test.mjs` is unrelated and currently known-bad
- do not use that failure to block this feature

---

### Task 2: Expose Generic Account, Balance, and Fee-Rate HTTP Primitives

**Files:**
- Create: `src/main/services/metabotAccountService.ts`
- Modify: `src/main/services/metaidRpcServer.ts`
- Modify: `src/main/services/addressBalanceService.ts` (only if a helper export is required)
- Test: `tests/metabotAccountService.test.mjs`
- Test: `tests/metaidRpcWalletRoutes.test.mjs`

- [ ] **Step 1: Write the failing account-summary and route tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { getMetabotAccountSummary } = require('../dist-electron/services/metabotAccountService.js');

test('getMetabotAccountSummary returns store-backed address fields without mnemonic', () => {
  const store = createMetabotStoreForTest({
    metabot: { id: 1, name: 'Trader', mvc_address: 'mvc-addr', btc_address: 'btc-addr', doge_address: 'doge-addr', public_key: 'pub' },
  });

  const summary = getMetabotAccountSummary(store, 1);

  assert.equal(summary.metabot_id, 1);
  assert.equal(summary.mvc_address, 'mvc-addr');
  assert.equal('mnemonic' in summary, false);
});

test('rpc gateway exposes account-summary, balance, and fee-rate-summary as local JSON endpoints', async () => {
  const { server, baseUrl } = await startMetaidRpcServerForTest();

  const accountRes = await fetch(`${baseUrl}/api/idbots/metabot/account-summary`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: 1 }),
  });
  const balanceRes = await fetch(`${baseUrl}/api/idbots/address/balance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ metabot_id: 1 }),
  });
  const feeRes = await fetch(`${baseUrl}/api/idbots/fee-rate-summary?chain=mvc`);

  const accountJson = await accountRes.json();
  const balanceJson = await balanceRes.json();
  const feeJson = await feeRes.json();

  assert.equal(accountJson.success, true);
  assert.equal(balanceJson.success, true);
  assert.equal(feeJson.success, true);
  server.close();
});
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- FAIL because `metabotAccountService` and the new HTTP routes do not exist yet

- [ ] **Step 3: Implement the generic account, balance, and fee-rate route layer**

```ts
// src/main/services/metabotAccountService.ts
export function getMetabotAccountSummary(store: MetabotStore, metabotId: number) {
  const metabot = store.getMetabotById(metabotId);
  if (!metabot) throw new Error(`MetaBot ${metabotId} not found`);
  return {
    metabot_id: metabot.id,
    name: metabot.name,
    mvc_address: metabot.mvc_address,
    btc_address: metabot.btc_address,
    doge_address: metabot.doge_address,
    public_key: metabot.public_key,
  };
}
```

```ts
// src/main/services/metaidRpcServer.ts
if (req.method === 'POST' && pathname === '/api/idbots/metabot/account-summary') {
  const { metabot_id } = JSON.parse(body);
  const summary = getMetabotAccountSummary(getMetabotStore(), metabot_id);
  res.writeHead(200);
  res.end(JSON.stringify({ success: true, ...summary }));
  return;
}

if (req.method === 'POST' && pathname === '/api/idbots/address/balance') {
  const { metabot_id, addresses } = JSON.parse(body);
  const balance = await resolveAddressBalance({ metabotId: metabot_id, addresses, metabotStore: getMetabotStore() });
  res.writeHead(200);
  res.end(JSON.stringify({ success: true, balance }));
  return;
}

if (req.method === 'GET' && pathname === '/api/idbots/fee-rate-summary') {
  const chain = new URLSearchParams(search || '').get('chain') || 'mvc';
  const feeRate = getGlobalFeeRate(chain as 'mvc' | 'btc' | 'doge');
  const tiers = getGlobalFeeTiers()[chain as 'mvc' | 'btc' | 'doge'] || [];
  res.writeHead(200);
  res.end(JSON.stringify({ success: true, list: tiers, defaultFeeRate: feeRate }));
  return;
}
```

- [ ] **Step 4: Re-run the focused tests and make them pass**

Run:

```bash
npm run compile:electron && node --test tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- PASS for both new test files

- [ ] **Step 5: Lint and commit the generic account/balance/fee routes**

Run:

```bash
npm run lint
git add src/main/services/metabotAccountService.ts src/main/services/metaidRpcServer.ts src/main/services/addressBalanceService.ts tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
git commit -m "feat: add generic wallet rpc account routes"
```

Expected:

- lint passes
- commit succeeds

---

### Task 3: Add the Generic MVC `noBroadcast` Raw-Tx Builder

**Files:**
- Create: `src/main/services/walletRawTxService.ts`
- Create: `src/main/libs/buildMvcTransferRawTxWorker.ts`
- Modify: `src/main/services/metaidRpcServer.ts`
- Test: `tests/walletRawTxService.test.mjs`
- Test: `tests/metaidRpcWalletRoutes.test.mjs`

- [ ] **Step 1: Write the failing MVC raw-tx tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  summarizeMvcTransferTx,
  buildMvcTransferRawTx,
} = require('../dist-electron/services/walletRawTxService.js');

test('summarizeMvcTransferTx returns txid, recipient output index, and spent outpoints', () => {
  const summary = summarizeMvcTransferTx({
    txHex: SAMPLE_MVC_TX_HEX,
    toAddress: 'mqrecipient',
    amountSats: 1000,
  });

  assert.equal(summary.outputIndex, 0);
  assert.equal(typeof summary.txid, 'string');
  assert.ok(summary.spentOutpoints.length > 0);
});

test('buildMvcTransferRawTx rejects invalid amount_sats before spawning the worker', async () => {
  await assert.rejects(
    () => buildMvcTransferRawTx(createMetabotStoreForTest(), { metabotId: 1, toAddress: 'mqrecipient', amountSats: 0, feeRate: 1 }),
    /amount_sats/i,
  );
});
```

- [ ] **Step 2: Run the MVC raw-tx tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- FAIL because the generic MVC raw-tx service and route are missing

- [ ] **Step 3: Implement the new worker and service**

```ts
// src/main/libs/buildMvcTransferRawTxWorker.ts
const result = await wallet.sendArray([{ address: toAddress, amount: amountSats }], undefined, { noBroadcast: true });
console.log(JSON.stringify({ success: true, txHex: result.txHex }));
```

```ts
// src/main/services/walletRawTxService.ts
export async function buildMvcTransferRawTx(store: MetabotStore, params: BuildMvcTransferRawTxParams) {
  const txHex = await runMvcTransferWorker(params);
  const summary = summarizeMvcTransferTx({ txHex, toAddress: params.toAddress, amountSats: params.amountSats });
  return {
    raw_tx: txHex,
    txid: summary.txid,
    output_index: summary.outputIndex,
    spent_outpoints: summary.spentOutpoints,
    change_outpoint: summary.changeOutpoint,
  };
}
```

- [ ] **Step 4: Wire the HTTP route**

Add `POST /api/idbots/wallet/mvc/build-transfer-rawtx` in `metaidRpcServer.ts` with input validation and `success: false` JSON on malformed requests.

- [ ] **Step 5: Re-run the MVC raw-tx tests**

Run:

```bash
npm run compile:electron && node --test tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- PASS for MVC raw-tx service and route coverage

- [ ] **Step 6: Lint and commit the MVC raw-tx primitive**

Run:

```bash
npm run lint
git add src/main/services/walletRawTxService.ts src/main/libs/buildMvcTransferRawTxWorker.ts src/main/services/metaidRpcServer.ts tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
git commit -m "feat: add mvc raw tx wallet rpc"
```

Expected:

- lint passes
- commit succeeds

---

### Task 4: Add the Generic MVC FT `noBroadcast` Raw-Tx Builder

**Files:**
- Modify: `src/main/services/walletRawTxService.ts`
- Create: `src/main/libs/buildMvcFtTransferRawTxWorker.ts`
- Modify: `src/main/services/metaidRpcServer.ts`
- Test: `tests/walletRawTxService.test.mjs`
- Test: `tests/metaidRpcWalletRoutes.test.mjs`

- [ ] **Step 1: Write the failing FT raw-tx tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { buildMvcFtTransferRawTx } = require('../dist-electron/services/walletRawTxService.js');

test('buildMvcFtTransferRawTx returns raw_tx, amount_check_raw_tx, and output_index 0 for the first receiver', async () => {
  const result = await buildMvcFtTransferRawTx(createMetabotStoreForTest(), {
    metabotId: 1,
    token: { symbol: 'MC', genesisHash: 'genesis', codeHash: 'code', decimal: 8 },
    toAddress: 'mqrecipient',
    amount: '500000000',
    feeRate: 1,
  });

  assert.equal(result.output_index, 0);
  assert.equal(typeof result.raw_tx, 'string');
  assert.equal(typeof result.amount_check_raw_tx, 'string');
});
```

- [ ] **Step 2: Run the FT raw-tx tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- FAIL because the FT worker and FT route do not exist yet

- [ ] **Step 3: Implement the FT worker and service path**

```ts
// src/main/libs/buildMvcFtTransferRawTxWorker.ts
const result = await ftManager.transfer({
  codehash: token.codeHash,
  genesis: token.genesisHash,
  receivers: [{ address: toAddress, amount }],
  senderWif,
  noBroadcast: true,
});
console.log(JSON.stringify({
  success: true,
  txHex: result.txHex,
  amountCheckRawTx: result.routeCheckTxHex,
  outputIndex: 0,
}));
```

```ts
// src/main/services/walletRawTxService.ts
export async function buildMvcFtTransferRawTx(store: MetabotStore, params: BuildMvcFtTransferRawTxParams) {
  const result = await runMvcFtTransferWorker(params);
  return {
    raw_tx: result.txHex,
    output_index: result.outputIndex,
    amount_check_raw_tx: result.amountCheckRawTx,
    spent_outpoints: result.spentOutpoints,
    change_outpoint: result.changeOutpoint,
  };
}
```

- [ ] **Step 4: Wire the FT HTTP route**

Add `POST /api/idbots/wallet/mvc-ft/build-transfer-rawtx` in `metaidRpcServer.ts` with explicit token-field validation.

- [ ] **Step 5: Re-run the FT raw-tx tests**

Run:

```bash
npm run compile:electron && node --test tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
```

Expected:

- PASS for FT raw-tx service and route coverage

- [ ] **Step 6: Lint and commit the FT raw-tx primitive**

Run:

```bash
npm run lint
git add src/main/services/walletRawTxService.ts src/main/libs/buildMvcFtTransferRawTxWorker.ts src/main/services/metaidRpcServer.ts tests/walletRawTxService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
git commit -m "feat: add mvc ft raw tx wallet rpc"
```

Expected:

- lint passes
- commit succeeds

---

### Task 5: Scaffold the Skill and Lock Down Intent Parsing

**Files:**
- Create: `SKILLs/metabot-trade-mvcswap/SKILL.md`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/index.js`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/lib/intent.js`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/lib/mvcswapApi.js`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/lib/localRpc.js`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/lib/formatter.js`
- Create: `SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js`
- Test: `tests/metabotTradeMvcswapSkill.test.mjs`
- Test: `tests/metabotTradeMvcswapIntent.test.mjs`

- [ ] **Step 1: Write the failing skill and intent tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { parseTradeIntent } = await import('../SKILLs/metabot-trade-mvcswap/scripts/lib/intent.js');

test('parseTradeIntent marks confirm_trade language as executeNow', () => {
  const intent = parseTradeIntent('帮我买 10 SPACE 的 MC，确定交易');
  assert.equal(intent.executeNow, true);
  assert.equal(intent.direction, 'space_to_token');
  assert.equal(intent.amountUnit, 'SPACE');
});

test('parseTradeIntent rejects exact-out phrasing in phase 1', () => {
  const intent = parseTradeIntent('我要买到 2000 MC');
  assert.equal(intent.kind, 'unsupported');
  assert.match(intent.reason, /exact-in/i);
});
```

```js
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { SkillManager } = require('../dist-electron/skillManager.js');

test('SkillManager lists metabot-trade-mvcswap as an enabled built-in skill', () => {
  const manager = createSkillManagerForTest();
  const skill = manager.listSkills().find((entry) => entry.id === 'metabot-trade-mvcswap');
  assert.ok(skill);
  assert.equal(skill.enabled, true);
});
```

- [ ] **Step 2: Run the skill and intent tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs
```

Expected:

- FAIL because the skill directory and parser do not exist yet

- [ ] **Step 3: Implement the skill scaffold and parser**

```js
// SKILLs/metabot-trade-mvcswap/scripts/lib/intent.js
export function parseTradeIntent(input) {
  const text = String(input || '').trim();
  if (/买到|得到.*多少/.test(text)) {
    return { kind: 'unsupported', reason: 'Phase 1 only supports exact-in trades.' };
  }
  return {
    kind: 'trade',
    direction: /卖出/.test(text) ? 'token_to_space' : 'space_to_token',
    amount: extractAmount(text),
    tokenSymbol: extractTokenSymbol(text),
    slippagePercent: extractSlippage(text) ?? 1,
    executeNow: /确认交易|确定执行|无需询问/.test(text),
  };
}
```

```md
---
name: metabot-trade-mvcswap
description: MetaBot 的 mvcswap 交易技能。用于 SPACE 与 mvcswap 当前支持 token 的报价、预览和交易；当用户提到买入、卖出、兑换、swap、报价、滑点、确认交易时都应考虑使用。
official: true
---
```

- [ ] **Step 4: Re-run the skill and intent tests**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs
```

Expected:

- PASS for skill registration and phase-1 parsing rules

- [ ] **Step 5: Lint and commit the skill scaffold**

Run:

```bash
npm run lint
git add SKILLs/metabot-trade-mvcswap tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs
git commit -m "feat: scaffold mvcswap trade skill"
```

Expected:

- lint passes
- commit succeeds

---

### Task 6: Implement Quote and Preview-Only Flow in the Skill

**Files:**
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/index.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/mvcswapApi.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/localRpc.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/formatter.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js`
- Test: `tests/metabotTradeMvcswapScript.test.mjs`

- [ ] **Step 1: Write the failing quote and preview tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const { handleTradeRequest } = await import('../SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js');

test('quote-only request returns an estimated output without calling execute endpoints', async () => {
  const result = await handleTradeRequest({
    input: '10 SPACE 能换多少 MC',
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForQuote(),
  });

  assert.equal(result.mode, 'quote');
  assert.match(result.message, /预计收到/);
});

test('preview request returns a confirmation instruction when executeNow is false', async () => {
  const result = await handleTradeRequest({
    input: '帮我买 10 SPACE 的 MC',
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForQuote(),
  });

  assert.equal(result.mode, 'preview');
  assert.match(result.message, /确认交易/);
});
```

- [ ] **Step 2: Run the quote/preview tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapScript.test.mjs
```

Expected:

- FAIL because the execution flow is still a stub

- [ ] **Step 3: Implement quote and preview flow**

```js
// SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js
export async function handleTradeRequest({ input, env, fetchImpl = fetch }) {
  const intent = parseTradeIntent(input);
  if (intent.kind !== 'trade') return formatUnsupported(intent);

  const pairs = await fetchSpacePairs({ fetchImpl });
  const pair = resolvePairFromIntent(intent, pairs);
  const quote = await quoteExactIn({ pair, intent, fetchImpl, slippagePercent: intent.slippagePercent ?? 1 });

  if (!intent.executeNow) {
    return {
      mode: intent.kind === 'quote' ? 'quote' : 'preview',
      message: formatPreview({ intent, pair, quote }),
    };
  }

  return executeTrade({ intent, pair, quote, env, fetchImpl });
}
```

- [ ] **Step 4: Re-run the quote/preview tests**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapScript.test.mjs
```

Expected:

- PASS for quote and preview-only paths

- [ ] **Step 5: Lint and commit the quote/preview flow**

Run:

```bash
npm run lint
git add SKILLs/metabot-trade-mvcswap/scripts tests/metabotTradeMvcswapScript.test.mjs
git commit -m "feat: add mvcswap quote and preview flow"
```

Expected:

- lint passes
- commit succeeds

---

### Task 7: Implement Direct Execution for Both Swap Directions

**Files:**
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/execution.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/localRpc.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/mvcswapApi.js`
- Modify: `SKILLs/metabot-trade-mvcswap/scripts/lib/formatter.js`
- Test: `tests/metabotTradeMvcswapScript.test.mjs`

- [ ] **Step 1: Write the failing direct-execution tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

test('SPACE -> token execute flow builds mvc raw tx and submits token1totoken2', async () => {
  const calls = [];
  const result = await handleTradeRequest({
    input: '帮我买 10 SPACE 的 MC，确定交易',
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForDirectSpaceTrade(calls),
  });

  assert.equal(result.mode, 'executed');
  assert.ok(calls.some((entry) => entry.url.includes('/swap/token1totoken2')));
});

test('token -> SPACE execute flow builds ft raw tx and mvc fee raw tx before token2totoken1', async () => {
  const calls = [];
  const result = await handleTradeRequest({
    input: '卖出 500 MC，确定执行',
    env: { IDBOTS_METABOT_ID: '1', IDBOTS_RPC_URL: 'http://127.0.0.1:31200' },
    fetchImpl: createFetchStubForDirectTokenTrade(calls),
  });

  assert.equal(result.mode, 'executed');
  assert.ok(calls.some((entry) => entry.url.includes('/swap/token2totoken1')));
});
```

- [ ] **Step 2: Run the execution tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapScript.test.mjs
```

Expected:

- FAIL because direct execution and request assembly are not implemented yet

- [ ] **Step 3: Implement the live execution flow**

```js
// SPACE -> token
const account = await rpc.getAccountSummary({ metabotId, fetchImpl });
const reqArgs = await mvcswap.requestSwapArgs({ pairSymbol, address: account.mvc_address, op: 3, fetchImpl });
const mvcTx = await rpc.buildMvcTransferRawTx({
  metabotId,
  toAddress: reqArgs.mvcToAddress,
  amountSats: exactInSats + reqArgs.txFee,
  feeRate,
  fetchImpl,
});
const swap = await mvcswap.executeToken1ToToken2({
  symbol: pairSymbol,
  requestIndex: reqArgs.requestIndex,
  mvcRawTx: mvcTx.raw_tx,
  mvcOutputIndex: mvcTx.output_index,
  fetchImpl,
});
```

```js
// token -> SPACE
const ftTx = await rpc.buildMvcFtTransferRawTx({
  metabotId,
  token,
  toAddress: reqArgs.tokenToAddress,
  amount: exactInTokenAmount,
  feeRate,
  fetchImpl,
});
const mvcFeeTx = await rpc.buildMvcTransferRawTx({
  metabotId,
  toAddress: reqArgs.mvcToAddress,
  amountSats: reqArgs.txFee,
  feeRate,
  fetchImpl,
});
```

- [ ] **Step 4: Add error normalization and re-quote behavior**

Ensure final execution:

- fetches fresh quote and fresh `requestIndex`,
- maps slippage and unsupported-pair failures into stable user-facing messages,
- never reuses stale request args between preview and later confirmation.

- [ ] **Step 5: Re-run the direct-execution tests**

Run:

```bash
npm run compile:electron && node --test tests/metabotTradeMvcswapScript.test.mjs
```

Expected:

- PASS for quote, preview, `SPACE -> token`, and `token -> SPACE` flows

- [ ] **Step 6: Lint and commit the execution flow**

Run:

```bash
npm run lint
git add SKILLs/metabot-trade-mvcswap/scripts tests/metabotTradeMvcswapScript.test.mjs
git commit -m "feat: add mvcswap direct execution flow"
```

Expected:

- lint passes
- commit succeeds

---

### Task 8: Run Full Focused Verification and Clean-Room QA

**Files:**
- Existing: `tests/metabotAccountService.test.mjs`
- Existing: `tests/metaidRpcWalletRoutes.test.mjs`
- Existing: `tests/walletRawTxService.test.mjs`
- Existing: `tests/metabotTradeMvcswapSkill.test.mjs`
- Existing: `tests/metabotTradeMvcswapIntent.test.mjs`
- Existing: `tests/metabotTradeMvcswapScript.test.mjs`

- [ ] **Step 1: Run the full focused automated suite**

Run:

```bash
npm run compile:electron
node --test tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs
node --test tests/walletRawTxService.test.mjs
node --test tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs tests/metabotTradeMvcswapScript.test.mjs
npm run lint
```

Expected:

- compile passes
- all new focused tests pass
- lint passes

- [ ] **Step 2: Run a local manual smoke in `electron:dev`**

Run:

```bash
npm run electron:dev
```

Verify manually:

- a Cowork session can invoke the skill,
- quote-only request returns a preview,
- request without confirmation does not execute,
- request with `确认交易` executes,
- success and failure copy are readable.

- [ ] **Step 3: Run one small real trade per direction with a test MetaBot**

Use minimal real amounts and document outcomes for:

- `SPACE -> MC`
- `MC -> SPACE`

Capture:

- request phrasing,
- returned preview text,
- final execution result,
- mvcswap txid,
- any unexpected API behavior.

- [ ] **Step 4: Ask a dedicated test subagent to replay the focused suite and audit the changed files**

The dedicated tester should:

- rerun the commands from Step 1 in the worktree,
- inspect the skill script for unhandled branches,
- inspect the wallet RPC routes for accidental mvcswap coupling,
- inspect the error messages for user-facing stability.

Expected:

- no new blocking issues
- any issues found are fixed before the final commit

- [ ] **Step 5: Commit the final verification-ready state**

Run:

```bash
git status --short
git add src/main/services/metaidRpcServer.ts src/main/services/metabotAccountService.ts src/main/services/walletRawTxService.ts src/main/libs/buildMvcTransferRawTxWorker.ts src/main/libs/buildMvcFtTransferRawTxWorker.ts SKILLs/metabot-trade-mvcswap tests/metabotAccountService.test.mjs tests/metaidRpcWalletRoutes.test.mjs tests/walletRawTxService.test.mjs tests/metabotTradeMvcswapSkill.test.mjs tests/metabotTradeMvcswapIntent.test.mjs tests/metabotTradeMvcswapScript.test.mjs
git commit -m "feat: add mvcswap phase 1 trade skill"
```

Expected:

- only understood files are staged
- final commit succeeds on a lint-clean, focused-test-clean worktree

## Execution Notes

- Prefer subagent-driven execution.
- Keep one worker focused on generic wallet/account primitives and one worker focused on the skill flow when write scopes are disjoint.
- Use a separate verification worker after implementation starts stabilizing.
- Do not broaden Phase 1 into `swapv2`, LP flows, or token-to-token execution even if the underlying code makes that look tempting.
