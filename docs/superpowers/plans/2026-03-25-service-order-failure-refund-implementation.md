# Service Order Failure Refund Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a durable service-order ledger, timeout-based failure handling, automatic buyer refund requests, manual seller refund processing, and service-square refund risk signaling without breaking existing user data.

**Architecture:** The implementation keeps runtime truth in a new local `service_orders` ledger, treats chain protocols as verifiable refund evidence, and continues to use existing A2A cowork sessions as the display surface. The plan deliberately separates persistence/state logic, timeout/refund services, and renderer presentation helpers so the workflow can be tested in focused layers instead of depending on one fragile end-to-end path.

**Tech Stack:** Electron main process, React renderer, TypeScript services/stores, sql.js-backed SQLite, Node `node:test` tests, existing `createPin`/MetaID protocol flow, existing cowork IPC/render stream plumbing.

---

## File Map

### New files

- `src/main/serviceOrderStore.ts`
  - Persistent CRUD/query layer for `service_orders`
- `src/main/services/serviceOrderState.ts`
  - Pure timeout/state transition helpers and risk-age helpers
- `src/main/services/serviceOrderProtocols.js`
  - Pure builders/parsers for `[DELIVERY]`, `service-refund-request`, `service-refund-finalize`
- `src/main/services/serviceOrderLifecycleService.ts`
  - Buyer/seller order creation, timeout scans, auto refund request retries
- `src/main/services/serviceRefundSyncService.ts`
  - Chain scanning, refund finalize reconciliation, provider risk aggregation
- `src/main/services/txTransferVerification.ts`
  - Shared raw-tx recipient/amount verification for payments and refunds
- `src/renderer/components/cowork/coworkServiceOrderPresentation.js`
  - Pure renderer helpers for orange title state, refund badges, bottom-card copy
- `src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js`
  - Pure renderer helpers for red-card/hidden-card provider risk behavior
- `tests/serviceOrderState.test.mjs`
- `tests/serviceOrderStore.test.mjs`
- `tests/serviceOrderProtocols.test.mjs`
- `tests/serviceOrderLifecycleService.test.mjs`
- `tests/serviceRefundSyncService.test.mjs`
- `tests/txTransferVerification.test.mjs`
- `tests/coworkServiceOrderPresentation.test.mjs`
- `tests/gigSquareRefundRiskPresentation.test.mjs`

### Modified files

- `src/main/sqliteStore.ts`
  - Add `service_orders` schema and indexes with idempotent migration
- `src/main/main.ts`
  - Instantiate the new store/services, wire startup scanning, enrich IPC handlers
- `src/main/services/privateChatDaemon.ts`
  - Create seller orders, route first-response events, emit structured delivery, attach refund system messages
- `src/main/services/orderPayment.ts`
  - Reuse shared transfer verification helper instead of duplicating tx parsing logic
- `src/main/coworkStore.ts`
  - Add minimal helpers for session-linked service-order lookups if main-process session enrichment needs them
- `src/renderer/types/cowork.ts`
  - Extend session/session-summary shape with optional `serviceOrderSummary`
- `src/renderer/types/electron.d.ts`
  - Add IPC return shape updates and any new `gigSquare`/`cowork` calls
- `src/renderer/types/gigSquare.ts`
  - Extend service-card type with refund-risk fields
- `src/renderer/services/cowork.ts`
  - Refresh session summaries when tagged order-state system messages arrive
- `src/renderer/store/slices/coworkSlice.ts`
  - Preserve/update `serviceOrderSummary` on session and summary updates
- `src/renderer/components/cowork/CoworkSessionItem.tsx`
  - Orange title and refund-needed badge behavior
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
  - Buyer/seller refund cards and success/failure system banners
- `src/renderer/components/cowork/coworkSessionPresentation.js`
  - Thread title classes/badge helpers
- `src/renderer/components/gigSquare/GigSquareView.tsx`
  - Provider refund-risk card styling and hidden-card filtering
- `src/renderer/components/gigSquare/GigSquareOrderModal.tsx`
  - Duplicate-order block messaging if main IPC rejects a second open order
- `src/renderer/services/i18n.ts`
  - New strings for refund cards, timeout system messages, provider risk badge

### Verification commands used throughout

- `npm run compile:electron`
- `node --test tests/serviceOrderState.test.mjs tests/serviceOrderStore.test.mjs`
- `node --test tests/serviceOrderProtocols.test.mjs tests/serviceOrderLifecycleService.test.mjs`
- `node --test tests/txTransferVerification.test.mjs tests/serviceRefundSyncService.test.mjs`
- `node --test tests/coworkServiceOrderPresentation.test.mjs tests/gigSquareRefundRiskPresentation.test.mjs`
- `npm run electron:dev`

Note: the current repository baseline is not “fresh worktree + full suite = green”. Focus execution on new targeted tests plus compile/electron dev checks for this feature.

---

### Task 1: Add the Service Order Persistence Foundation

**Files:**
- Create: `src/main/serviceOrderStore.ts`
- Create: `src/main/services/serviceOrderState.ts`
- Modify: `src/main/sqliteStore.ts`
- Test: `tests/serviceOrderState.test.mjs`
- Test: `tests/serviceOrderStore.test.mjs`

- [ ] **Step 1: Write the failing persistence/state tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeOrderDeadlines,
  getTimedOutOrderTransition,
  shouldHideProviderForUnresolvedRefund,
} from '../dist-electron/services/serviceOrderState.js';

import { ServiceOrderStore } from '../dist-electron/serviceOrderStore.js';

test('computeOrderDeadlines returns fixed 5m/15m SLA windows', () => {
  const now = 1_770_000_000_000;
  const deadlines = computeOrderDeadlines(now);
  assert.equal(deadlines.firstResponseDeadlineAt, now + 5 * 60_000);
  assert.equal(deadlines.deliveryDeadlineAt, now + 15 * 60_000);
});

test('store creates and reloads buyer orders without mutating existing cowork data', () => {
  const store = createServiceOrderStoreForTest();
  const order = store.createOrder({ role: 'buyer', paymentTxid: 'a'.repeat(64) });
  assert.equal(store.getOrderById(order.id)?.paymentTxid, 'a'.repeat(64));
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderState.test.mjs tests/serviceOrderStore.test.mjs
```

Expected:

- FAIL because `serviceOrderStore` / `serviceOrderState` do not exist yet
- or FAIL because `service_orders` schema and helper exports are missing

- [ ] **Step 3: Implement the minimal persistence layer and migration**

```ts
// src/main/services/serviceOrderState.ts
export function computeOrderDeadlines(now: number) {
  return {
    firstResponseDeadlineAt: now + 5 * 60_000,
    deliveryDeadlineAt: now + 15 * 60_000,
  };
}

export function getTimedOutOrderTransition(order: ServiceOrderRecord, now: number) {
  if (order.status === 'awaiting_first_response' && now > order.firstResponseDeadlineAt) {
    return 'first_response_timeout';
  }
  if (order.status === 'in_progress' && now > order.deliveryDeadlineAt) {
    return 'delivery_timeout';
  }
  return null;
}
```

```ts
// src/main/sqliteStore.ts
this.db.run(`
  CREATE TABLE IF NOT EXISTS service_orders (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL,
    local_metabot_id INTEGER NOT NULL,
    counterparty_global_metaid TEXT NOT NULL,
    service_pin_id TEXT,
    service_name TEXT NOT NULL,
    payment_txid TEXT NOT NULL,
    payment_chain TEXT NOT NULL,
    payment_amount TEXT NOT NULL,
    payment_currency TEXT NOT NULL,
    order_message_pin_id TEXT,
    cowork_session_id TEXT,
    status TEXT NOT NULL,
    first_response_deadline_at INTEGER NOT NULL,
    delivery_deadline_at INTEGER NOT NULL,
    first_response_at INTEGER,
    delivery_message_pin_id TEXT,
    delivered_at INTEGER,
    failed_at INTEGER,
    failure_reason TEXT,
    refund_request_pin_id TEXT,
    refund_finalize_pin_id TEXT,
    refund_txid TEXT,
    refund_requested_at INTEGER,
    refund_completed_at INTEGER,
    refund_apply_retry_count INTEGER NOT NULL DEFAULT 0,
    next_retry_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
```

- [ ] **Step 4: Re-run the focused tests and make them pass**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderState.test.mjs tests/serviceOrderStore.test.mjs
```

Expected:

- PASS for both new test files

- [ ] **Step 5: Commit the foundation work**

```bash
git add src/main/sqliteStore.ts src/main/serviceOrderStore.ts src/main/services/serviceOrderState.ts tests/serviceOrderState.test.mjs tests/serviceOrderStore.test.mjs
git commit -m "feat: add service order persistence foundation"
```

---

### Task 2: Create Buyer Orders and Block Duplicate Open Orders

**Files:**
- Create: `src/main/services/serviceOrderLifecycleService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/gigSquare/GigSquareOrderModal.tsx`
- Test: `tests/serviceOrderLifecycleService.test.mjs`

- [ ] **Step 1: Write the failing buyer-order lifecycle tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { ServiceOrderLifecycleService } from '../dist-electron/services/serviceOrderLifecycleService.js';

test('createBuyerOrder refuses a second unresolved order for the same buyer/seller pair', () => {
  const service = createLifecycleServiceForTest();
  service.createBuyerOrder(baseOrderInput());
  assert.throws(() => service.createBuyerOrder(baseOrderInput()), /open order already exists/i);
});

test('createBuyerOrder persists SLA deadlines and links the cowork session', () => {
  const service = createLifecycleServiceForTest();
  const order = service.createBuyerOrder(baseOrderInput());
  assert.equal(order.status, 'awaiting_first_response');
  assert.equal(typeof order.coworkSessionId, 'string');
});
```

- [ ] **Step 2: Run the buyer-order tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderLifecycleService.test.mjs
```

Expected:

- FAIL because `ServiceOrderLifecycleService` does not exist or duplicate guard is not enforced

- [ ] **Step 3: Implement buyer-order creation and wire `gigSquare:sendOrder`**

```ts
// src/main/services/serviceOrderLifecycleService.ts
createBuyerOrder(input: CreateBuyerOrderInput) {
  this.assertNoOpenOrderForPair(input.localMetabotId, input.counterpartyGlobalMetaId);
  const deadlines = computeOrderDeadlines(this.now());
  return this.store.createOrder({
    ...input,
    role: 'buyer',
    status: 'awaiting_first_response',
    ...deadlines,
  });
}
```

```ts
// src/main/main.ts inside gigSquare:sendOrder
const buyerOrder = serviceOrderLifecycle.createBuyerOrder({
  localMetabotId: metabotId,
  counterpartyGlobalMetaId: toGlobalMetaId,
  servicePinId: serviceId,
  serviceName: serviceSkill || serviceId || 'Service Order',
  paymentTxid: servicePaidTx || txidForKey,
  paymentChain: normalizeOrderChain(serviceCurrency),
  paymentAmount: servicePrice || '0',
  paymentCurrency: serviceCurrency || 'SPACE',
  coworkSessionId: session.id,
  orderMessagePinId: result.pinId ?? null,
});
```

- [ ] **Step 4: Re-run the lifecycle tests and the compile step**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderLifecycleService.test.mjs
```

Expected:

- PASS
- Duplicate orders now fail with a stable, renderer-visible error message

- [ ] **Step 5: Commit the buyer-order path**

```bash
git add src/main/services/serviceOrderLifecycleService.ts src/main/main.ts src/renderer/types/electron.d.ts src/renderer/components/gigSquare/GigSquareOrderModal.tsx tests/serviceOrderLifecycleService.test.mjs
git commit -m "feat: create buyer service orders and block duplicates"
```

---

### Task 3: Parse Structured Delivery and Advance Seller/Buyer Order State

**Files:**
- Create: `src/main/services/serviceOrderProtocols.js`
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/privateChatOrderObserverState.js`
- Test: `tests/serviceOrderProtocols.test.mjs`
- Test: `tests/privateChatOrderObserverState.test.mjs`

- [ ] **Step 1: Write the failing delivery protocol tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDeliveryMessage,
  parseDeliveryMessage,
} from '../src/main/services/serviceOrderProtocols.js';

test('buildDeliveryMessage emits a [DELIVERY] envelope with paymentTxid and servicePinId', () => {
  const text = buildDeliveryMessage({
    paymentTxid: 'a'.repeat(64),
    servicePinId: 'pin123',
    serviceName: 'Weather Pro',
    result: 'done',
    deliveredAt: 1770000000,
  });
  assert.match(text, /^\[DELIVERY\]/);
  assert.equal(parseDeliveryMessage(text)?.servicePinId, 'pin123');
});
```

- [ ] **Step 2: Run the protocol tests and verify they fail**

Run:

```bash
node --test tests/serviceOrderProtocols.test.mjs tests/privateChatOrderObserverState.test.mjs
```

Expected:

- FAIL because delivery helpers do not exist and the observer state still only knows `[NeedsRating]`

- [ ] **Step 3: Implement structured delivery helpers and wire `privateChatDaemon`**

```js
export function buildDeliveryMessage(payload) {
  return `[DELIVERY] ${JSON.stringify(payload)}`;
}

export function parseDeliveryMessage(content) {
  if (!String(content || '').trim().startsWith('[DELIVERY]')) return null;
  return JSON.parse(String(content).trim().slice('[DELIVERY]'.length).trim());
}
```

```ts
// src/main/services/privateChatDaemon.ts
const deliveryText = buildDeliveryMessage({
  paymentTxid: txid,
  servicePinId: extractOrderSkillId(plaintext),
  serviceName: extractOrderSkillName(plaintext) || 'Service Order',
  result: trimmedReply,
  deliveredAt: Math.floor(Date.now() / 1000),
});
await sendEncryptedMsg(deliveryText);
serviceOrderLifecycle.markDeliverySent(...);
```

- [ ] **Step 4: Re-run the delivery tests**

Run:

```bash
node --test tests/serviceOrderProtocols.test.mjs tests/privateChatOrderObserverState.test.mjs
```

Expected:

- PASS
- Delivery parsing is deterministic and ready for buyer-side state promotion

- [ ] **Step 5: Commit the delivery protocol work**

```bash
git add src/main/services/serviceOrderProtocols.js src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderObserverState.js tests/serviceOrderProtocols.test.mjs tests/privateChatOrderObserverState.test.mjs
git commit -m "feat: add structured delivery protocol handling"
```

---

### Task 4: Add Timeout Scanning and Automatic Refund Request Creation

**Files:**
- Modify: `src/main/services/serviceOrderLifecycleService.ts`
- Modify: `src/main/services/serviceOrderProtocols.js`
- Modify: `src/main/main.ts`
- Test: `tests/serviceOrderLifecycleService.test.mjs`

- [ ] **Step 1: Write the failing timeout/refund tests**

```js
test('scanTimedOutOrders marks first-response timeout orders failed and enqueues refund request work', async () => {
  const service = createLifecycleServiceForTest({ now: () => DEADLINE_PLUS_1 });
  const order = service.createBuyerOrder(baseOrderInput());
  await service.scanTimedOutOrders();
  const updated = service.store.getOrderById(order.id);
  assert.equal(updated.status, 'refund_pending');
  assert.equal(typeof updated.refundRequestPinId, 'string');
});
```

- [ ] **Step 2: Run the lifecycle tests and verify failure**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderLifecycleService.test.mjs
```

Expected:

- FAIL because timeout scans and refund request builders are missing

- [ ] **Step 3: Implement timeout scanning and refund-request retries**

```ts
async scanTimedOutOrders() {
  for (const order of this.store.listOpenBuyerOrders()) {
    const reason = getTimedOutOrderTransition(order, this.now());
    if (!reason) continue;
    this.store.markFailed(order.id, reason, this.now());
    await this.tryCreateRefundRequest(order.id);
  }
}

async tryCreateRefundRequest(orderId: string) {
  const order = this.store.getOrderById(orderId);
  const payload = buildRefundRequestPayload(order);
  const result = await this.createPin(...payload);
  this.store.markRefundPending(orderId, result.pinId, this.now());
}
```

- [ ] **Step 4: Re-run the timeout/refund tests**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderLifecycleService.test.mjs
```

Expected:

- PASS
- Failed orders now move into `refund_pending` with retry metadata instead of stalling

- [ ] **Step 5: Commit the timeout/refund request path**

```bash
git add src/main/services/serviceOrderLifecycleService.ts src/main/services/serviceOrderProtocols.js src/main/main.ts tests/serviceOrderLifecycleService.test.mjs
git commit -m "feat: add timeout-driven refund requests"
```

---

### Task 5: Reconcile Refund Finalize Events and Verify Refund Transfers

**Files:**
- Create: `src/main/services/txTransferVerification.ts`
- Create: `src/main/services/serviceRefundSyncService.ts`
- Modify: `src/main/services/orderPayment.ts`
- Modify: `src/main/main.ts`
- Test: `tests/txTransferVerification.test.mjs`
- Test: `tests/serviceRefundSyncService.test.mjs`

- [ ] **Step 1: Write the failing transfer verification and refund sync tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import { verifyTransferToRecipient } from '../dist-electron/services/txTransferVerification.js';
import { ServiceRefundSyncService } from '../dist-electron/services/serviceRefundSyncService.js';

test('verifyTransferToRecipient confirms full refund back to the buyer address', async () => {
  const result = await verifyTransferToRecipient({
    chain: 'mvc',
    txid: 'a'.repeat(64),
    recipientAddress: '1BuyerAddress',
    expectedAmountSats: 100000,
    fetchRawTxHex: async () => rawRefundHex,
  });
  assert.equal(result.valid, true);
});
```

- [ ] **Step 2: Run the refund verification tests and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/txTransferVerification.test.mjs tests/serviceRefundSyncService.test.mjs
```

Expected:

- FAIL because the shared tx verification helper and refund sync service do not exist yet

- [ ] **Step 3: Implement shared tx verification and refund reconciliation**

```ts
export async function verifyTransferToRecipient(input: VerifyTransferInput) {
  const rawHex = await input.fetchRawTxHex(input.chain, input.txid);
  const outputs = parseTxOutputs(rawHex);
  return outputs.some((output) => matchesRecipient(output, input.recipientAddress, input.expectedAmountSats));
}
```

```ts
// src/main/services/serviceRefundSyncService.ts
async syncFinalizePins() {
  for (const pin of await this.fetchRefundFinalizePins()) {
    const payload = parseRefundFinalizePayload(pin.content);
    const order = this.store.findByRefundRequestPinId(payload.refundRequestPinId);
    if (!order) continue;
    const valid = await verifyTransferToRecipient({...});
    if (valid) this.store.markRefunded(order.id, payload.refundTxid, pin.pinId, this.now());
  }
}
```

- [ ] **Step 4: Re-run the refund verification tests**

Run:

```bash
npm run compile:electron && node --test tests/txTransferVerification.test.mjs tests/serviceRefundSyncService.test.mjs
```

Expected:

- PASS
- Refund completion now requires both protocol evidence and tx verification

- [ ] **Step 5: Commit the refund sync layer**

```bash
git add src/main/services/txTransferVerification.ts src/main/services/serviceRefundSyncService.ts src/main/services/orderPayment.ts src/main/main.ts tests/txTransferVerification.test.mjs tests/serviceRefundSyncService.test.mjs
git commit -m "feat: reconcile refund finalize events with tx verification"
```

---

### Task 6: Enrich Cowork Sessions with Service Order Summary Data

**Files:**
- Modify: `src/main/serviceOrderStore.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/cowork.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/services/cowork.ts`
- Modify: `src/renderer/store/slices/coworkSlice.ts`
- Test: `tests/coworkServiceOrderPresentation.test.mjs`

- [ ] **Step 1: Write the failing session-summary enrichment tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCoworkServiceOrderTone,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';

test('refund-pending sessions use warning tone and show the refund card', () => {
  assert.equal(getCoworkServiceOrderTone({ status: 'refund_pending' }), 'warning');
  assert.equal(shouldShowRefundStatusCard({ status: 'refund_pending' }), true);
});
```

- [ ] **Step 2: Run the presentation tests and verify failure**

Run:

```bash
node --test tests/coworkServiceOrderPresentation.test.mjs
```

Expected:

- FAIL because the service-order presentation helper does not exist

- [ ] **Step 3: Add session summary enrichment and renderer refresh hooks**

```ts
// src/renderer/types/cowork.ts
export interface CoworkServiceOrderSummary {
  status: 'awaiting_first_response' | 'in_progress' | 'completed' | 'failed' | 'refund_pending' | 'refunded';
  failureReason?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
}
```

```ts
// src/main/main.ts
const serviceOrderSummary = serviceOrderStore.getSessionSummary(session.id);
return { ...session, serviceOrderSummary };
```

```ts
// src/renderer/services/cowork.ts
if (message.metadata?.refreshSessionSummary) {
  await this.loadSessions();
  if (store.getState().cowork.currentSessionId === sessionId) {
    const refreshed = await window.electron.cowork.getSession(sessionId);
    if (refreshed.success && refreshed.session) store.dispatch(setCurrentSession(refreshed.session));
  }
}
```

- [ ] **Step 4: Re-run the renderer summary tests and compile**

Run:

```bash
npm run compile:electron && node --test tests/coworkServiceOrderPresentation.test.mjs
```

Expected:

- PASS
- Renderer types/store now have a stable place to read order status

- [ ] **Step 5: Commit the session-summary plumbing**

```bash
git add src/main/serviceOrderStore.ts src/main/main.ts src/renderer/types/cowork.ts src/renderer/types/electron.d.ts src/renderer/services/cowork.ts src/renderer/store/slices/coworkSlice.ts src/renderer/components/cowork/coworkServiceOrderPresentation.js tests/coworkServiceOrderPresentation.test.mjs
git commit -m "feat: expose service order summaries to cowork sessions"
```

---

### Task 7: Add Buyer/Seller Refund UI in Cowork

**Files:**
- Modify: `src/renderer/components/cowork/CoworkSessionItem.tsx`
- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- Modify: `src/renderer/components/cowork/coworkSessionPresentation.js`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Test: `tests/coworkServiceOrderPresentation.test.mjs`

- [ ] **Step 1: Extend the failing presentation tests for the warning UI rules**

```js
test('warning sessions switch the title class from blue A2A to orange refund warning', () => {
  assert.match(getCoworkServiceOrderTitleClassName({ sessionType: 'a2a', serviceOrderStatus: 'refund_pending' }), /orange|amber/);
});

test('buyer refund card shows waiting copy while seller refund card shows action-required copy', () => {
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refund_pending' }), 'buyer-pending');
  assert.equal(getRefundCardVariant({ role: 'seller', status: 'refund_pending' }), 'seller-action');
});
```

- [ ] **Step 2: Run the UI presentation tests and confirm failure**

Run:

```bash
node --test tests/coworkServiceOrderPresentation.test.mjs
```

Expected:

- FAIL because orange title classes and card variants are not implemented yet

- [ ] **Step 3: Implement the cowork refund UI**

```tsx
// CoworkSessionItem.tsx
<h3 className={getCoworkSessionTitleClassName(session.sessionType, session.serviceOrderSummary?.status)}>
  {displayTitle}
</h3>
```

```tsx
// CoworkSessionDetail.tsx
{currentSession.serviceOrderSummary && shouldShowRefundStatusCard(currentSession.serviceOrderSummary) && (
  <RefundStatusCard summary={currentSession.serviceOrderSummary} />
)}
```

```ts
// privateChatDaemon.ts
const systemMsg = coworkStore.addMessage(sessionId, {
  type: 'system',
  content: '[OrderSystem] Refund request created',
  metadata: { refreshSessionSummary: true, sourceChannel: 'metaweb_order' },
});
```

- [ ] **Step 4: Re-run the UI tests and a compile pass**

Run:

```bash
npm run compile:electron && node --test tests/coworkServiceOrderPresentation.test.mjs
```

Expected:

- PASS
- Buyer/seller refund states are visually distinct and data-driven

- [ ] **Step 5: Commit the cowork UI work**

```bash
git add src/renderer/components/cowork/CoworkSessionItem.tsx src/renderer/components/cowork/CoworkSessionDetail.tsx src/renderer/components/cowork/coworkSessionPresentation.js src/renderer/services/i18n.ts src/main/services/privateChatDaemon.ts src/renderer/components/cowork/coworkServiceOrderPresentation.js tests/coworkServiceOrderPresentation.test.mjs
git commit -m "feat: add cowork refund state UI"
```

---

### Task 8: Surface Provider Refund Risk in Gig Square and Run Focused Regression

**Files:**
- Create: `src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js`
- Modify: `src/main/serviceOrderStore.ts`
- Modify: `src/main/services/serviceRefundSyncService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/gigSquare.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/components/gigSquare/GigSquareView.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `tests/gigSquareRefundRiskPresentation.test.mjs`

- [ ] **Step 1: Write the failing provider-risk tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  shouldHideRiskyGigSquareService,
  getGigSquareRefundRiskBadge,
} from '../src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js';

test('providers with unresolved refunds under 72h stay visible but red', () => {
  assert.equal(shouldHideRiskyGigSquareService({ hasUnresolvedRefund: true, unresolvedRefundAgeHours: 24 }), false);
  assert.equal(getGigSquareRefundRiskBadge({ hasUnresolvedRefund: true }), 'REFUND RISK');
});

test('providers with unresolved refunds over 72h are hidden', () => {
  assert.equal(shouldHideRiskyGigSquareService({ hasUnresolvedRefund: true, unresolvedRefundAgeHours: 73 }), true);
});
```

- [ ] **Step 2: Run the provider-risk tests and confirm failure**

Run:

```bash
node --test tests/gigSquareRefundRiskPresentation.test.mjs
```

Expected:

- FAIL because no provider risk presentation helper or service enrichment exists yet

- [ ] **Step 3: Implement provider risk aggregation and Gig Square filtering**

```ts
// serviceRefundSyncService.ts
listProviderRefundRiskSummaries() {
  return this.store.listProviderRefundRisks().map((risk) => ({
    providerGlobalMetaId: risk.providerGlobalMetaId,
    hasUnresolvedRefund: true,
    unresolvedRefundAgeHours: risk.unresolvedRefundAgeHours,
    hidden: risk.unresolvedRefundAgeHours > 72,
  }));
}
```

```tsx
// GigSquareView.tsx
const filteredServices = services
  .filter((service) => !shouldHideRiskyGigSquareService(service.refundRisk))
  .map((service) => ({ ...service, refundRiskBadge: getGigSquareRefundRiskBadge(service.refundRisk) }));
```

- [ ] **Step 4: Run final focused regression for this feature**

Run:

```bash
npm run compile:electron
node --test tests/serviceOrderState.test.mjs tests/serviceOrderStore.test.mjs tests/serviceOrderProtocols.test.mjs tests/serviceOrderLifecycleService.test.mjs tests/txTransferVerification.test.mjs tests/serviceRefundSyncService.test.mjs tests/coworkServiceOrderPresentation.test.mjs tests/gigSquareRefundRiskPresentation.test.mjs
```

Then run:

```bash
npm run electron:dev
```

Expected:

- Compile succeeds
- All eight targeted test files PASS
- Manual smoke path works:
  - first order creates buyer session + order record
  - timeout produces orange refund UI
  - resolved refund flips the buyer card green
  - risky providers show red before 72h and disappear after the forced-age test fixture

- [ ] **Step 5: Commit the provider-risk UI and regression pass**

```bash
git add src/main/serviceOrderStore.ts src/main/services/serviceRefundSyncService.ts src/main/main.ts src/renderer/types/gigSquare.ts src/renderer/types/electron.d.ts src/renderer/components/gigSquare/GigSquareView.tsx src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js src/renderer/services/i18n.ts tests/gigSquareRefundRiskPresentation.test.mjs
git commit -m "feat: add gig square refund risk handling"
```

---

## Execution Notes

- Keep every migration idempotent. Do not delete or rebuild existing user tables.
- Do not enable auto-refund for ambiguous historical orders. Only newly created orders should be guaranteed to auto-refund.
- Reuse the shared tx verification helper for both `orderPayment` and refund finalize validation to avoid diverging chain parsing rules.
- Keep new renderer logic mostly in pure presentation helpers so the feature remains testable without mounting Electron/React integration in every test.
- Treat unrelated full-suite failures as baseline noise unless one of the new targeted files starts failing.

## Recommended Focused Test Matrix

1. Persistence: `tests/serviceOrderState.test.mjs`, `tests/serviceOrderStore.test.mjs`
2. Protocol/lifecycle: `tests/serviceOrderProtocols.test.mjs`, `tests/serviceOrderLifecycleService.test.mjs`
3. Refund verification: `tests/txTransferVerification.test.mjs`, `tests/serviceRefundSyncService.test.mjs`
4. Renderer: `tests/coworkServiceOrderPresentation.test.mjs`, `tests/gigSquareRefundRiskPresentation.test.mjs`

## Implementation Guardrails

- Do not commit `package-lock.json` changes caused only by local `npm install` unless a dependency actually changed for this feature.
- Do not “fix” unrelated baseline tests as part of this feature branch.
- Keep cowork session enrichment additive: existing session consumers should continue working when `serviceOrderSummary` is absent.
- Use stable chain protocol payload fields from the spec. Avoid inventing optional fields during implementation unless they unlock a proven requirement.
