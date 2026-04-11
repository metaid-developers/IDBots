# MVC Payment Pipeline Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unify all MVC on-chain/payment actions behind one shared spend pipeline with consistent UTXO selection, retry behavior, and per-MetaBot serialization.

**Architecture:** Keep business-specific entrypoints such as heartbeats, pings, transfers, Gig Square payments, and file uploads, but move MVC spend policy into a shared core plus a per-MetaBot coordinator. Entry adapters describe what transaction they need; the shared core handles UTXO ordering, retryable stale-input failures, broadcast, logging, and local queueing.

**Tech Stack:** Electron main process, TypeScript, Node test runner, existing `meta-contract` transaction builders, existing worker subprocess model.

---

### Task 1: Build Shared MVC Spend Core Contracts

**Files:**
- Modify: `src/main/libs/mvcSpend.ts`
- Create: `tests/mvcSpend.test.mjs`
- Reference: `src/main/libs/createPinWorker.ts`
- Reference: `src/main/libs/transferMvcWorker.ts`

- [ ] **Step 1: Write the failing shared-core tests**

Add `tests/mvcSpend.test.mjs` to cover:
- provider-order selection is preserved
- excluded outpoints are skipped
- retryable error classification includes stale-input variants
- already-known responses resolve to raw txid
- normalized error classification distinguishes stale-input vs insufficient-balance vs network/fetch

- [ ] **Step 2: Run the new test to verify it fails**

Run: `npm run compile:electron && node --test tests/mvcSpend.test.mjs`

Expected: FAIL because `mvcSpend.ts` does not yet expose the normalized request/result helpers and classification API required by the test.

- [ ] **Step 3: Implement the minimal shared-core contracts**

Extend `src/main/libs/mvcSpend.ts` with:
- normalized MVC spend error categories
- provider-order input selection helpers
- outpoint key helpers
- broadcast result normalization
- retryable stale-input classification helpers
- types that both pin and transfer workers can share without each worker re-inventing interfaces

Keep this module focused on reusable MVC spend primitives, not business workflows.

- [ ] **Step 4: Run the shared-core tests to verify they pass**

Run: `npm run compile:electron && node --test tests/mvcSpend.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/libs/mvcSpend.ts tests/mvcSpend.test.mjs
git add -f tests/mvcSpend.test.mjs
git commit -m "feat: expand shared mvc spend core"
```

### Task 2: Add Per-MetaBot MVC Spend Coordinator

**Files:**
- Create: `src/main/services/mvcSpendCoordinator.ts`
- Create: `tests/mvcSpendCoordinator.test.mjs`
- Modify: `src/main/services/metaidCore.ts`
- Modify: `src/main/services/transferService.ts`

- [ ] **Step 1: Write failing coordinator tests**

Add tests that assert:
- two MVC spend jobs for the same `metabotId` execute serially
- jobs for different `metabotId` values can proceed independently
- a failed job does not deadlock the queue
- logs or result metadata preserve the action name for later diagnosis

- [ ] **Step 2: Run the coordinator tests to verify they fail**

Run: `npm run compile:electron && node --test tests/mvcSpendCoordinator.test.mjs`

Expected: FAIL because the coordinator service does not exist yet.

- [ ] **Step 3: Implement the minimal coordinator**

Create `src/main/services/mvcSpendCoordinator.ts` with:
- one queue per `metabotId`
- `runMvcSpendJob({ metabotId, action, execute })`
- normalized result/error propagation
- queue cleanup when the last job finishes

Hook `metaidCore` and `transferService` only enough to prove the coordinator can wrap worker execution without changing business semantics yet.

- [ ] **Step 4: Run the coordinator tests to verify they pass**

Run: `npm run compile:electron && node --test tests/mvcSpendCoordinator.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/services/mvcSpendCoordinator.ts tests/mvcSpendCoordinator.test.mjs src/main/services/metaidCore.ts src/main/services/transferService.ts
git add -f tests/mvcSpendCoordinator.test.mjs
git commit -m "feat: add mvc spend coordinator"
```

### Task 3: Route MVC Pin-Send Paths Through Shared Governance

**Files:**
- Modify: `src/main/services/metaidCore.ts`
- Modify: `src/main/libs/createPinWorker.ts`
- Modify: `src/main/services/providerPingService.ts`
- Modify: `src/main/services/heartbeatService.ts`
- Test: `tests/createPinWorker.test.mjs`
- Test: `tests/providerPingService.test.mjs`
- Test: `tests/heartbeatService.test.mjs`

- [ ] **Step 1: Add failing tests for governed pin sends**

Extend tests to cover:
- pin-related workers report normalized stale-input failures
- ping/heartbeat sends go through a coordinator-wrapped path for MVC
- same-metabot concurrent pin sends serialize rather than racing

- [ ] **Step 2: Run the affected tests to verify they fail**

Run:
```bash
npm run compile:electron && node --test tests/createPinWorker.test.mjs tests/providerPingService.test.mjs tests/heartbeatService.test.mjs
```

Expected: FAIL on the new coordinator/serialization assertions.

- [ ] **Step 3: Implement the minimal routing changes**

Make `metaidCore.createPin` use the coordinator for MVC requests while leaving BTC/DOGE behavior unchanged.

Keep `createPinWorker.ts` as an MVC adapter over shared spend primitives:
- no confirmed-first reordering
- no randomization
- stale-input retries remain shared

Update ping and heartbeat paths only as needed so their MVC sends now share the same local serialization rule.

- [ ] **Step 4: Run the pin-send tests to verify they pass**

Run:
```bash
npm run compile:electron && node --test tests/createPinWorker.test.mjs tests/providerPingService.test.mjs tests/heartbeatService.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/services/metaidCore.ts src/main/libs/createPinWorker.ts src/main/services/providerPingService.ts src/main/services/heartbeatService.ts tests/createPinWorker.test.mjs tests/providerPingService.test.mjs tests/heartbeatService.test.mjs
git commit -m "feat: govern mvc pin send paths"
```

### Task 4: Route MVC Transfer and Gig Square Payment Paths Through Shared Governance

**Files:**
- Modify: `src/main/libs/transferMvcWorker.ts`
- Modify: `src/main/services/transferService.ts`
- Modify: `src/main/main.ts`
- Test: `tests/transferMvcWorker.test.mjs`
- Test: `tests/orderPayment.test.mjs`
- Test: `tests/gigSquareOnlineState.test.mjs`

- [ ] **Step 1: Add failing tests for governed MVC payment behavior**

Extend or add tests to cover:
- MVC transfer worker reports normalized stale-input retries
- payment execution uses the coordinator-wrapped transfer path
- Gig Square payment flow does not surface first-attempt stale-input failure when a retryable next outpoint exists

- [ ] **Step 2: Run the transfer/payment tests to verify they fail**

Run:
```bash
npm run compile:electron && node --test tests/transferMvcWorker.test.mjs tests/orderPayment.test.mjs
```

Expected: FAIL on the new payment governance assertions.

- [ ] **Step 3: Implement the minimal transfer/payment routing**

Keep the current `transferMvcWorker.ts` builder, but ensure all MVC transfer execution is invoked through the coordinator path and returns normalized action metadata.

Update `main.ts` Gig Square payment call sites only enough to rely on the governed MVC transfer path, not bespoke retry semantics.

- [ ] **Step 4: Run the transfer/payment tests to verify they pass**

Run:
```bash
npm run compile:electron && node --test tests/transferMvcWorker.test.mjs tests/orderPayment.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/libs/transferMvcWorker.ts src/main/services/transferService.ts src/main/main.ts tests/transferMvcWorker.test.mjs tests/orderPayment.test.mjs
git add -f tests/transferMvcWorker.test.mjs
git commit -m "feat: govern mvc transfer and payment paths"
```

### Task 5: Route File Upload and Merge Transaction Paths Through Shared Governance

**Files:**
- Modify: `src/main/services/metaFileUploadService.ts`
- Modify: `src/main/libs/uploadLargeFileWorker.ts`
- Modify: `src/main/libs/mvcSpend.ts`
- Create: `tests/metaFileUploadMvcSpend.test.mjs`

- [ ] **Step 1: Write failing tests for file upload merge governance**

Add tests that cover:
- direct `/file` uploads still use governed MVC create-pin path
- chunked upload merge funding no longer reorders UTXOs confirmed-first
- merge transaction funding retries stale-input candidates instead of failing immediately

- [ ] **Step 2: Run the file-upload tests to verify they fail**

Run:
```bash
npm run compile:electron && node --test tests/metaFileUploadMvcSpend.test.mjs
```

Expected: FAIL because `uploadLargeFileWorker.ts` still has its own confirmed-first/random `pickUtxos` and does not use shared governance.

- [ ] **Step 3: Implement the minimal file-upload routing**

Refactor `uploadLargeFileWorker.ts` to reuse shared MVC spend primitives for merge funding.

Do not redesign MetaFS protocol calls in this task. Only govern the local wallet-funding side:
- candidate selection
- stale-input retry
- normalized error mapping

Keep direct uploads on the same governed `createPin` path introduced earlier.

- [ ] **Step 4: Run the file-upload tests to verify they pass**

Run:
```bash
npm run compile:electron && node --test tests/metaFileUploadMvcSpend.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/services/metaFileUploadService.ts src/main/libs/uploadLargeFileWorker.ts src/main/libs/mvcSpend.ts tests/metaFileUploadMvcSpend.test.mjs
git add -f tests/metaFileUploadMvcSpend.test.mjs
git commit -m "feat: govern mvc file upload funding"
```

### Task 6: Add Logging, Manual Smoke Checks, and Release Notes

**Files:**
- Modify: `src/main/services/metaidCore.ts`
- Modify: `src/main/services/transferService.ts`
- Modify: `src/main/libs/uploadLargeFileWorker.ts`
- Modify: `localdocs/` notes if needed for this clone only
- Optional: `README.md` or ops docs only if runtime behavior needs operator explanation

- [ ] **Step 1: Add failing tests or assertions for normalized logging/error categories where practical**

Prefer lightweight unit coverage for:
- normalized stale-input category
- insufficient-balance category
- fetch/network category

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run the smallest relevant set introduced in earlier tasks.

Expected: FAIL where new observability assertions are introduced.

- [ ] **Step 3: Implement structured logging and run real-wallet smoke checks**

Add enough logs to capture:
- action type
- metabot id
- fetched candidate outpoints
- picked outpoints
- blacklist changes
- retry count
- final result

Then manually smoke-check in the app or worker CLI with AI_Sunny:
- heartbeat-style send
- ping/simplemsg send
- MVC transfer
- Gig Square pay-and-request
- file upload / merge path

- [ ] **Step 4: Run full verification**

Run:
```bash
npm run compile:electron
node --test tests/mvcSpend.test.mjs tests/mvcSpendCoordinator.test.mjs tests/createPinWorker.test.mjs tests/transferMvcWorker.test.mjs tests/providerPingService.test.mjs tests/heartbeatService.test.mjs tests/orderPayment.test.mjs tests/metaFileUploadMvcSpend.test.mjs
npm run lint
npm run build
```

Expected: PASS, with any known unrelated failures called out explicitly if they remain outside this scope.

- [ ] **Step 5: Commit**

Run:
```bash
git add src/main/services/metaidCore.ts src/main/services/transferService.ts src/main/libs/uploadLargeFileWorker.ts src/main/libs/mvcSpend.ts tests/mvcSpend.test.mjs tests/mvcSpendCoordinator.test.mjs tests/createPinWorker.test.mjs tests/transferMvcWorker.test.mjs tests/providerPingService.test.mjs tests/heartbeatService.test.mjs tests/orderPayment.test.mjs tests/metaFileUploadMvcSpend.test.mjs
git add -f tests/mvcSpend.test.mjs tests/mvcSpendCoordinator.test.mjs tests/transferMvcWorker.test.mjs tests/metaFileUploadMvcSpend.test.mjs
git commit -m "fix: complete mvc payment pipeline governance"
```
