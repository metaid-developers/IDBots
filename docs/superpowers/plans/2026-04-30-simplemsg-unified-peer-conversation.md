# Simplemsg Unified Peer Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render all `/protocols/simplemsg` private chat and service-order messages for one peer in one A2A conversation, with order lifecycle represented by tagged events inside that conversation.

**Architecture:** Keep `metaweb_private` as the canonical display session. Keep `metaweb_order` mappings as order indexes that point to that same session. Add shared simplemsg classification, active-order suppression, and a non-destructive migration that hides old standalone order sessions from normal navigation while preserving their rows.

**Tech Stack:** Electron main process TypeScript, sql.js SQLite persistence, React renderer, Node test runner, `tsx` renderer/unit tests, existing service-order protocol helpers.

---

## File Structure

Create:

- `src/main/services/simplemsgPeerConversation.ts`
  Shared helpers for simplemsg classification, canonical peer session ids, order metadata, and active-order suppression predicate.
- `tests/simplemsgPeerConversation.test.ts`
  Fast source-level tests for classifier and active-order predicate.
- `tests/serviceOrderObserverSessionUnified.test.mjs`
  Compiled integration test proving order index mappings point to the canonical peer session.
- `tests/coworkUnifiedSessionMigration.test.mjs`
  Compiled migration/listing tests for legacy order session hiding and de-duplication.
- `tests/serviceOrderStoreActiveOrder.test.mjs`
  Store-level coverage for the active-order suppression query.
- `tests/privateChatActiveOrderSuppression.test.mjs`
  Daemon-level coverage proving ordinary non-protocol private chat is display-only while a peer has active orders, and auto-reply resumes after terminal order state.
- `tests/privateChatUnifiedOrderRouting.test.mjs`
  Integration coverage for incoming order protocol routing into the canonical peer session, including protocol messages bypassing ordinary private-chat gates.
- `tests/coworkOrderFocus.test.tsx`
  Renderer coverage for opening a unified peer session with a focused `orderTxid`.

Modify:

- `src/main/services/privateChatDaemon.ts`
  Route all incoming simplemsg messages through the canonical peer session. Suppress ordinary private-chat auto-reply while active orders exist. Ensure order protocol messages bypass ordinary private-chat gates.
- `src/main/services/serviceOrderObserverSession.ts`
  Stop creating separate displayed order sessions. Ensure or reuse canonical peer session and write `metaweb_order` as an index mapping to it.
- `src/main/services/privateChatOrderCowork.ts`
  Ensure order-run local messages and outgoing status/delivery/rating metadata are compatible with the canonical peer session.
- `src/main/services/serviceOrderLifecycleService.ts`
  Ensure timeout-generated `[ORDER_END]` messages are appended to the canonical peer session if needed.
- `src/main/serviceOrderStore.ts`
  Add query/helper support for active orders by local MetaBot and peer.
- `src/main/coworkStore.ts`
  Add `hidden_from_session_list` migration, list filtering, legacy order-session migration/backfill, and canonical simplemsg backfill adjustments.
- `src/main/sqliteStore.ts`
  Add idempotent schema compatibility for `cowork_sessions.hidden_from_session_list`.
- `src/main/memory/memoryScopeResolver.ts`
  Treat unified direct sessions as contact-scoped and avoid `metaweb_order` group/shared memory scope for display sessions.
- `src/renderer/components/cowork/CoworkSessionDetail.tsx`
  Render all order protocol messages in the unified session and support optional focused `orderTxid`.
- `src/renderer/components/cowork/CoworkSessionList.tsx` / `src/renderer/components/cowork/CoworkSessionItem.tsx`
  Ensure hidden legacy sessions are not shown by default if summaries include the flag.
- Existing tests:
  - `tests/a2aSimplemsgMetadataBackfill.test.mjs`
  - `tests/a2aMessageItem.test.tsx`
  - `tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs`
  - `tests/privateChatOrderCoworkTimeout.test.mjs`
  - `tests/privateChatRatingPrompt.test.ts`

---

## Task 1: Shared Simplemsg Classification and Active-Order Predicate

**Files:**

- Create: `src/main/services/simplemsgPeerConversation.ts`
- Create: `tests/simplemsgPeerConversation.test.ts`
- Modify if needed: `src/main/services/serviceOrderProtocols.js` exports only if an existing parser is not currently exported

- [ ] **Step 1: Write failing classifier and active-order tests**

Create `tests/simplemsgPeerConversation.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCanonicalPrivateConversationExternalConversationId,
  classifySimplemsgContent,
  isServiceOrderActiveForPrivateChatSuppression,
} from '../src/main/services/simplemsgPeerConversation';

test('classifySimplemsgContent recognizes scoped order protocol tags', () => {
  const orderTxid = 'a'.repeat(64);
  assert.deepEqual(classifySimplemsgContent('[ORDER] do work').kind, 'order_protocol');
  assert.equal(classifySimplemsgContent(`[ORDER_STATUS:${orderTxid}] processing`).orderTxid, orderTxid);
  assert.equal(classifySimplemsgContent(`[DELIVERY:${orderTxid}] {"result":"done"}`).tag, 'DELIVERY');
  assert.equal(classifySimplemsgContent(`[NeedsRating:${orderTxid}] please rate`).tag, 'NeedsRating');
  assert.equal(classifySimplemsgContent(`[ORDER_END:${orderTxid} rated] thanks`).reason, 'rated');
});

test('classifySimplemsgContent leaves ordinary private chat untagged', () => {
  assert.deepEqual(classifySimplemsgContent('hello there'), { kind: 'private_chat' });
});

test('buildCanonicalPrivateConversationExternalConversationId uses peer global metaid', () => {
  assert.equal(
    buildCanonicalPrivateConversationExternalConversationId(' idq-peer '),
    'metaweb-private:idq-peer'
  );
});

test('isServiceOrderActiveForPrivateChatSuppression matches current order statuses', () => {
  const base = {
    role: 'buyer',
    status: 'awaiting_first_response',
    refundRequestPinId: null,
    refundTxid: null,
    refundCompletedAt: null,
  };
  for (const status of ['awaiting_first_response', 'in_progress', 'rating_pending', 'refund_pending']) {
    assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status }), true);
  }
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'completed' }), false);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'refunded' }), false);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({ ...base, status: 'failed' }), true);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({
    ...base,
    status: 'failed',
    refundRequestPinId: 'pin',
  }), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npx tsx --test tests/simplemsgPeerConversation.test.ts
```

Expected: FAIL because `simplemsgPeerConversation.ts` does not exist.

- [ ] **Step 3: Implement minimal helper**

Create `src/main/services/simplemsgPeerConversation.ts`:

```ts
import {
  parseDeliveryMessage,
  parseNeedsRatingMessage,
  parseOrderEndMessage,
  parseOrderStatusMessage,
  isOrderMessage,
} from './serviceOrderProtocols.js';

export type SimplemsgProtocolTag = 'ORDER' | 'ORDER_STATUS' | 'DELIVERY' | 'NeedsRating' | 'ORDER_END';

export type SimplemsgClassification =
  | { kind: 'private_chat' }
  | {
      kind: 'order_protocol';
      tag: SimplemsgProtocolTag;
      orderTxid?: string | null;
      reason?: string | null;
    };

export function buildCanonicalPrivateConversationExternalConversationId(peerGlobalMetaId: string): string {
  return `metaweb-private:${String(peerGlobalMetaId || '').trim() || 'unknown-peer'}`;
}

export function classifySimplemsgContent(content: string): SimplemsgClassification {
  const text = String(content || '').trim();
  if (!text) return { kind: 'private_chat' };
  if (isOrderMessage(text)) return { kind: 'order_protocol', tag: 'ORDER' };
  const status = parseOrderStatusMessage(text);
  if (status) return { kind: 'order_protocol', tag: 'ORDER_STATUS', orderTxid: status.orderTxid };
  const delivery = parseDeliveryMessage(text);
  if (delivery) return { kind: 'order_protocol', tag: 'DELIVERY', orderTxid: delivery.orderTxid ?? null };
  const needsRating = parseNeedsRatingMessage(text);
  if (needsRating) return { kind: 'order_protocol', tag: 'NeedsRating', orderTxid: needsRating.orderTxid ?? null };
  const orderEnd = parseOrderEndMessage(text);
  if (orderEnd) return {
    kind: 'order_protocol',
    tag: 'ORDER_END',
    orderTxid: orderEnd.orderTxid ?? null,
    reason: orderEnd.reason ?? null,
  };
  return { kind: 'private_chat' };
}

export function isServiceOrderActiveForPrivateChatSuppression(order: {
  role?: string | null;
  status?: string | null;
  refundRequestPinId?: string | null;
  refundTxid?: string | null;
  refundCompletedAt?: number | null;
}): boolean {
  const status = String(order.status || '').trim();
  if (status === 'awaiting_first_response' || status === 'in_progress' || status === 'rating_pending' || status === 'refund_pending') {
    return true;
  }
  if (status !== 'failed') return false;
  return String(order.role || '').trim() === 'buyer'
    && !order.refundRequestPinId
    && !order.refundTxid
    && !order.refundCompletedAt;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npx tsx --test tests/simplemsgPeerConversation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Compile**

Run:

```bash
npm run compile:electron
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/simplemsgPeerConversation.ts tests/simplemsgPeerConversation.test.ts
git commit -m "feat: add simplemsg peer conversation helpers"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 2: Canonical Peer Session Resolver and Order Index Mapping

**Files:**

- Modify: `src/main/services/serviceOrderObserverSession.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Test: `tests/serviceOrderObserverSessionUnified.test.mjs`

- [ ] **Step 1: Write failing canonical mapping test**

Create `tests/serviceOrderObserverSessionUnified.test.mjs` using `createSqliteStore()` and `createCoworkStore()` from `tests/memoryTestUtils.mjs`.

Test behavior:

```js
test('ensureServiceOrderObserverSession indexes orders to the canonical peer private session', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const result = await ensureServiceOrderObserverSession(store, {
      role: 'seller',
      metabotId: 1,
      peerGlobalMetaId: 'peer-global',
      servicePaidTx: 'a'.repeat(64),
      orderTxid: 'b'.repeat(64),
      orderMessageTxid: 'b'.repeat(64),
      orderPayload: '[ORDER] hello',
    });
    const privateMapping = store.getConversationMapping('metaweb_private', 'metaweb-private:peer-global', 1);
    const orderMapping = store.getConversationMapping('metaweb_order', result.externalConversationId, 1);
    assert.ok(privateMapping);
    assert.ok(orderMapping);
    assert.equal(orderMapping.coworkSessionId, privateMapping.coworkSessionId);
    assert.equal(result.coworkSessionId, privateMapping.coworkSessionId);
  } finally {
    sqlite.cleanup();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run compile:electron
node --test tests/serviceOrderObserverSessionUnified.test.mjs
```

Expected: FAIL because current `ensureServiceOrderObserverSession()` creates a separate `metaweb_order` session.

- [ ] **Step 3: Implement canonical resolver**

In `serviceOrderObserverSession.ts`:

- add an internal `ensureCanonicalPeerSession(coworkStore, input)` that gets/creates `metaweb_private:<peerGlobalMetaId>`,
- keep `buildServiceOrderObserverConversationId()` unchanged for order index identity,
- upsert `metaweb_order` mapping with `coworkSessionId` equal to canonical peer session id,
- add initial `[ORDER]` message to the canonical session only if no message with the same pin/tx already exists.

In `privateChatDaemon.ts`:

- replace private local-only `buildPrivateConversationExternalConversationId()` logic with the shared helper where possible,
- keep ordinary private-chat resolver behavior compatible.

- [ ] **Step 4: Run focused tests**

Run:

```bash
npm run compile:electron
node --test tests/serviceOrderObserverSessionUnified.test.mjs
node --test tests/a2aSimplemsgMetadataBackfill.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/serviceOrderObserverSession.ts src/main/services/privateChatDaemon.ts tests/serviceOrderObserverSessionUnified.test.mjs
git commit -m "feat: index service orders to peer sessions"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 3: Active Order Suppression for Ordinary Private Chat

**Files:**

- Modify: `src/main/serviceOrderStore.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Test: `tests/simplemsgPeerConversation.test.ts`
- Test: `tests/serviceOrderStoreActiveOrder.test.mjs`
- Test: `tests/privateChatActiveOrderSuppression.test.mjs`

- [ ] **Step 1: Add failing service-order active query tests**

Extend `tests/simplemsgPeerConversation.test.ts` for the predicate if Task 1 did not already cover all cases:

```ts
test('buyer failed refund retry remains active until refund request is created or resolved', () => {
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({
    role: 'buyer',
    status: 'failed',
    refundRequestPinId: null,
    refundTxid: null,
    refundCompletedAt: null,
  }), true);
  assert.equal(isServiceOrderActiveForPrivateChatSuppression({
    role: 'buyer',
    status: 'failed',
    refundRequestPinId: 'pin',
    refundTxid: null,
    refundCompletedAt: null,
  }), false);
});
```

Add a store-level test proving `hasActiveOrderForPrivateChatSuppression(localMetabotId, peerGlobalMetaId)` returns true for active statuses and false for terminal statuses.

Create `tests/privateChatActiveOrderSuppression.test.mjs` with daemon-level behavior coverage. Seed or simulate an incoming ordinary non-protocol simplemsg from a peer that has an active order and assert:

- the message is appended to the canonical `metaweb_private` peer session,
- the raw private-chat row is marked processed,
- ordinary private-chat LLM/cowork/send-reply code is not invoked,
- no `service_orders` state is mutated by the ordinary text.

Add a second case where all orders for that peer are terminal (`completed`, `refunded`, or non-retry `failed`) and assert the existing ordinary auto-reply path is eligible again.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
npx tsx --test tests/simplemsgPeerConversation.test.ts
node --test tests/serviceOrderStoreActiveOrder.test.mjs
node --test tests/privateChatActiveOrderSuppression.test.mjs
```

Expected: helper tests pass if already implemented; store test fails because query method does not exist; daemon test fails because active-order suppression is not yet applied.

- [ ] **Step 3: Implement store query**

In `src/main/serviceOrderStore.ts`, add:

```ts
hasActiveOrderForPrivateChatSuppression(localMetabotId: number, counterpartyGlobalMetaid: string): boolean {
  const rows = this.getAll<ServiceOrderRow>(`
    SELECT *
    FROM service_orders
    WHERE local_metabot_id = ?
      AND counterparty_global_metaid = ?
      AND (
        status IN ('awaiting_first_response', 'in_progress', 'rating_pending', 'refund_pending')
        OR (
          role = 'buyer'
          AND status = 'failed'
          AND refund_request_pin_id IS NULL
          AND refund_txid IS NULL
          AND refund_completed_at IS NULL
        )
      )
    LIMIT 1
  `, [localMetabotId, counterpartyGlobalMetaid]);
  return rows.length > 0;
}
```

If the store maps rows before predicate use, call `isServiceOrderActiveForPrivateChatSuppression()` instead of duplicating logic.

- [ ] **Step 4: Apply suppression in `privateChatDaemon.ts`**

After appending incoming ordinary private-chat message to canonical session, before `evaluatePrivateChatAutoReplyPolicy()`, add:

```ts
if (serviceOrderStore.hasActiveOrderForPrivateChatSuppression(metabot.id, fromGlobalMetaId)) {
  emitLog(`[PrivateChat] Active service order with ${fromGlobalMetaId.slice(0, 12)}…, display-only ordinary private chat.`);
  markProcessed(db, row.id, saveDb);
  return;
}
```

Use the actual service-order store/lifecycle access pattern available in this module.

- [ ] **Step 5: Verify**

Run:

```bash
npm run compile:electron
npx tsx --test tests/simplemsgPeerConversation.test.ts
node --test tests/serviceOrderStoreActiveOrder.test.mjs
node --test tests/privateChatActiveOrderSuppression.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/serviceOrderStore.ts src/main/services/privateChatDaemon.ts tests/simplemsgPeerConversation.test.ts tests/serviceOrderStoreActiveOrder.test.mjs tests/privateChatActiveOrderSuppression.test.mjs
git commit -m "feat: suppress private replies during active orders"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 4: Route Incoming Order Protocol Messages Into the Unified Peer Session

**Files:**

- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/privateChatOrderCowork.ts`
- Modify: `src/main/services/serviceOrderLifecycleService.ts`
- Test: `tests/privateChatUnifiedOrderRouting.test.mjs`
- Test: existing order tests

- [ ] **Step 1: Write failing incoming routing test**

Create a test that simulates:

- a canonical `metaweb_private` session for peer,
- an incoming `[ORDER]` message,
- seller order row creation,
- `metaweb_order` mapping points to canonical session,
- no extra order session is created.

If direct daemon integration is too heavy, extract a focused routing function from `privateChatDaemon.ts` and test that function. The test must still assert persisted outcomes: canonical session message, `metaweb_order` mapping target, and absence of a new visible order session.

The same test file must include explicit gate-bypass cases for all protocol tags:

- `[ORDER]`
- `[DELIVERY:<orderTxid>]`
- `[NeedsRating:<orderTxid>]`
- `[ORDER_END:<orderTxid> rated]`

For each case, configure the ordinary private-chat path so it would normally skip or block the message (`respondToStrangerPrivateChats = false`, stale/latest-message-only false path, no-op text skip where applicable, and `byeSent = true`). Assert the protocol message is still appended to the canonical peer session, relevant order state is updated, the private-chat row is marked processed, and the ordinary private-chat LLM/send-reply path is not called.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run compile:electron
node --test tests/privateChatUnifiedOrderRouting.test.mjs
```

Expected: FAIL under current separate-order-session behavior.

- [ ] **Step 3: Refactor daemon order path**

In `privateChatDaemon.ts`:

- classify plaintext before ordinary private-chat gates,
- ensure canonical peer session before order handling,
- append `[ORDER]` to canonical session with:

```ts
{
  sourceChannel: 'metaweb_private',
  simplemsgKind: 'order_protocol',
  orderProtocolTag: 'ORDER',
  orderTxid: orderMessageTxid,
  orderRole: 'seller',
  direction: 'incoming',
  txid: row.tx_id,
  pinId: row.pin_id
}
```

- create/update seller `service_orders` as today,
- create/update `metaweb_order` index mapping pointing to canonical session,
- do not append the same `[ORDER]` twice when `ensureServiceOrderObserverSession()` is also called.
- keep protocol handling above `respondToStrangerPrivateChats`, latest-message-only, no-op text skip, and `byeSent` checks.

- [ ] **Step 4: Route buyer-side order protocol replies**

For `[ORDER_STATUS]`, `[DELIVERY]`, `[NeedsRating]`, `[ORDER_END]` from seller to buyer:

- find order index by scoped `orderTxid`,
- fallback to legacy matching only when unique,
- append the incoming message to the canonical peer session,
- update `service_orders`,
- trigger rating flow for `[NeedsRating]`,
- never run ordinary private-chat auto-reply for these messages.

- [ ] **Step 5: Verify focused tests**

Run:

```bash
npm run compile:electron
node --test tests/privateChatUnifiedOrderRouting.test.mjs
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
node --test tests/privateChatOrderCoworkTimeout.test.mjs
npx tsx --test tests/privateChatRatingPrompt.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderCowork.ts src/main/services/serviceOrderLifecycleService.ts tests/privateChatUnifiedOrderRouting.test.mjs
git commit -m "feat: route order protocol messages to peer sessions"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 5: Outgoing Order Events Use Canonical Session Metadata

**Files:**

- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/privateChatOrderCowork.ts`
- Modify: `src/main/services/serviceOrderLifecycleService.ts`
- Modify after audit if needed: refund/failure/rating-timeout/manual-resend order event writers discovered by `rg`
- Test: `tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs`
- Test: `tests/a2aMessageItem.test.tsx`

- [ ] **Step 1: Add failing metadata expectations**

Extend existing order delivery artifact tests to assert outgoing local messages have:

```ts
metadata.sourceChannel === 'metaweb_private'
metadata.simplemsgKind === 'order_protocol'
metadata.orderProtocolTag === 'DELIVERY'
metadata.orderTxid === orderTxid
metadata.orderMappingExternalConversationId starts with 'metaweb_order:'
```

Do the same for status, needs-rating, and order-end messages where covered.

Before implementation, audit all current order display-message writers:

```bash
rg -n "sourceChannel\\s*[:=]\\s*['\\\"]metaweb_order['\\\"]|metaweb_order" src/main src/renderer tests
```

Classify each result as one of:

- order index or legacy compatibility path: allowed to remain,
- display message metadata: must move to `sourceChannel: 'metaweb_private'`,
- renderer route/session lookup: must open the canonical peer session and pass `orderTxid`.

The audit must explicitly include refund events, manual resend paths, failure notices, rating timeout, delivery retry/fallback, and rating request/end writes, not just `privateChatDaemon.ts`, `privateChatOrderCowork.ts`, and `serviceOrderLifecycleService.ts`.

- [ ] **Step 2: Run tests to verify failure**

Run:

```bash
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
```

Expected: FAIL because metadata still says `sourceChannel: 'metaweb_order'` in order bubbles.

- [ ] **Step 3: Update outgoing metadata**

Change outgoing order event appends so display metadata uses `metaweb_private`, with explicit order fields for routing.

Do not remove order mapping metadata. It remains the lookup index.

Update every display-message writer discovered in Step 1, including refund/failure/manual-resend/rating-timeout paths. New order display bubbles should carry:

```ts
{
  sourceChannel: 'metaweb_private',
  simplemsgKind: 'order_protocol',
  orderProtocolTag: '<tag>',
  orderTxid,
  orderMappingExternalConversationId
}
```

- [ ] **Step 4: Verify UI rendering still handles tags**

Run:

```bash
npm run compile:electron
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
npx tsx --test tests/a2aMessageItem.test.tsx
rg -n "sourceChannel\\s*[:=]\\s*['\\\"]metaweb_order['\\\"]" src/main
```

Expected: tests PASS. The grep output is either empty or limited to documented order-index/legacy compatibility code; no remaining display-message metadata writes use `sourceChannel: 'metaweb_order'`.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderCowork.ts src/main/services/serviceOrderLifecycleService.ts tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs tests/a2aMessageItem.test.tsx
git commit -m "feat: mark order events inside peer conversations"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 6: Legacy Migration, Backfill, and Hidden Order Sessions

**Files:**

- Modify: `src/main/sqliteStore.ts`
- Modify: `src/main/coworkStore.ts`
- Test: `tests/coworkUnifiedSessionMigration.test.mjs`
- Test: `tests/a2aSimplemsgMetadataBackfill.test.mjs`

- [ ] **Step 1: Write failing migration tests**

Create `tests/coworkUnifiedSessionMigration.test.mjs`:

```js
test('migration repoints legacy order mapping to canonical peer session and hides old order session', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const privateSession = store.createSession('Peer', process.cwd(), '', 'local', [], 1, 'a2a', 'peer', 'Peer', null);
    store.upsertConversationMapping({ channel: 'metaweb_private', externalConversationId: 'metaweb-private:peer', metabotId: 1, coworkSessionId: privateSession.id });
    const orderSession = store.createSession('Order', process.cwd(), '', 'local', [], 1, 'a2a', 'peer', 'Peer', null);
    store.upsertConversationMapping({ channel: 'metaweb_order', externalConversationId: 'metaweb_order:seller:1:peer:aaaaaaaaaaaaaaaa', metabotId: 1, coworkSessionId: orderSession.id, metadataJson: JSON.stringify({ role: 'seller', peerGlobalMetaId: 'peer', orderTxid: 'a'.repeat(64) }) });

    const changed = store.migrateMetawebOrderSessionsToPeerConversations();
    assert.equal(changed > 0, true);
    const mapping = store.getConversationMapping('metaweb_order', 'metaweb_order:seller:1:peer:aaaaaaaaaaaaaaaa', 1);
    assert.equal(mapping.coworkSessionId, privateSession.id);
    assert.equal(store.listSessions().some((session) => session.id === orderSession.id), false);
  } finally {
    sqlite.cleanup();
  }
});
```

Extend the migration test file with required cases:

- seed legacy order-session messages with overlapping `metadata.pinId`, `metadata.txid`, and `metadata.txids`; assert only missing chain messages are copied into the canonical peer session,
- run `migrateMetawebOrderSessionsToPeerConversations()` twice and assert the second run does not create duplicate canonical messages,
- seed a matching `service_orders` row whose `cowork_session_id` points to the legacy order session and assert it is repointed to the canonical peer session,
- assert hidden legacy order sessions are filtered by `CoworkStore.listSessions()` at the backend/store layer, not only hidden in React,
- assert the old legacy session row still exists and is not deleted.

- [ ] **Step 2: Run test to verify failure**

Run:

```bash
npm run compile:electron
node --test tests/coworkUnifiedSessionMigration.test.mjs
```

Expected: FAIL because migration and hidden column do not exist.

- [ ] **Step 3: Add hidden session schema**

In `src/main/sqliteStore.ts` and `CoworkStore.ensureSchemaCompatibility()` add idempotent migration:

```sql
ALTER TABLE cowork_sessions ADD COLUMN hidden_from_session_list INTEGER NOT NULL DEFAULT 0;
```

Update `CoworkSessionSummary` if necessary.

- [ ] **Step 4: Filter hidden sessions in backend list**

In `CoworkStore.listSessions()`:

```sql
WHERE COALESCE(hidden_from_session_list, 0) = 0
```

Do this in backend list/query layer, not only renderer.

- [ ] **Step 5: Implement legacy migration**

Add `migrateMetawebOrderSessionsToPeerConversations()` and call it from `ensureSchemaCompatibility()` after conversation mapping compatibility:

- find `metaweb_order` mappings,
- resolve peer from mapping metadata or session peer,
- ensure `metaweb_private` canonical session,
- copy missing messages from old order session to canonical session using pin/tx de-duplication,
- update `cowork_conversation_mappings.cowork_session_id`,
- update matching `service_orders.cowork_session_id`,
- set old order session `hidden_from_session_list = 1`,
- never delete old rows.

De-duplication order:

1. same `metadata.pinId`,
2. same `metadata.txid`,
3. intersection of `metadata.txids`,
4. content-only fallback only when no chain identifiers exist.

- [ ] **Step 6: Verify**

Run:

```bash
npm run compile:electron
node --test tests/coworkUnifiedSessionMigration.test.mjs
node --test tests/a2aSimplemsgMetadataBackfill.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/sqliteStore.ts src/main/coworkStore.ts tests/coworkUnifiedSessionMigration.test.mjs tests/a2aSimplemsgMetadataBackfill.test.mjs
git commit -m "feat: migrate order sessions into peer conversations"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 7: Renderer Navigation and Order Focus

**Files:**

- Modify: `src/renderer/components/cowork/CoworkSessionDetail.tsx`
- Modify: `src/renderer/components/gigSquare/GigSquareRefundsModal.tsx`
- Modify: `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- Modify: `src/renderer/App.tsx`
- Test: `tests/a2aMessageItem.test.tsx`
- Optional new test: `tests/coworkOrderFocus.test.tsx`

- [ ] **Step 1: Add failing UI test for mixed timeline rendering**

Extend `tests/a2aMessageItem.test.tsx` and add `tests/coworkOrderFocus.test.tsx`:

- ordinary private-chat message renders as normal chain bubble,
- `[ORDER_STATUS:<orderTxid>]` hides routing tag,
- `[DELIVERY:<orderTxid>]` renders delivery result,
- `[ORDER_END:<orderTxid> rated]` hides routing tag and displays visible text.
- opening an order entry point dispatches/selects `{ sessionId: canonicalPeerSessionId, focusedOrderTxid: orderTxid }`,
- `CoworkSessionDetail` scrolls/highlights the first message with matching `metadata.orderTxid` or scoped content tag.

- [ ] **Step 2: Run test to verify baseline**

Run:

```bash
npx tsx --test tests/a2aMessageItem.test.tsx
npx tsx --test tests/coworkOrderFocus.test.tsx
```

Expected: message-item tests may already pass; focus test fails until navigation/detail state is implemented.

- [ ] **Step 3: Update navigation**

Order entry points should open canonical `service_orders.cowork_session_id` after migration. If an `orderTxid` is available, pass focus state to session detail:

```ts
{ sessionId: canonicalPeerSessionId, focusedOrderTxid: orderTxid }
```

Do not open old standalone `metaweb_order` session ids from default UI.

- [ ] **Step 4: Add required focus behavior**

In `CoworkSessionDetail.tsx`:

- locate first message with matching `metadata.orderTxid` or content tag,
- scroll into view,
- show a restrained "focused order" chip or equivalent state affordance when the route has `focusedOrderTxid`,
- keep the default timeline unfiltered unless the user explicitly chooses an order filter.

This focus behavior is required because multiple active orders with the same peer are supported. Filtering remains optional; focus/scroll is not optional when `orderTxid` is known.

- [ ] **Step 5: Verify renderer tests**

Run:

```bash
npx tsx --test tests/a2aMessageItem.test.tsx
npx tsx --test tests/coworkOrderFocus.test.tsx
npm run compile:electron
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/cowork/CoworkSessionDetail.tsx src/renderer/components/gigSquare/GigSquareRefundsModal.tsx src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/App.tsx tests/a2aMessageItem.test.tsx tests/coworkOrderFocus.test.tsx
git commit -m "feat: open orders in peer conversation view"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

---

## Task 8: End-to-End Verification and Final Review

**Files:**

- No new production files unless issues are found.
- Update tests only if a real gap is discovered.

- [ ] **Step 1: Run full focused suite**

Run:

```bash
npm run compile:electron
npx tsx --test tests/simplemsgPeerConversation.test.ts
node --test tests/serviceOrderObserverSessionUnified.test.mjs
node --test tests/privateChatUnifiedOrderRouting.test.mjs
node --test tests/privateChatActiveOrderSuppression.test.mjs
node --test tests/coworkUnifiedSessionMigration.test.mjs
node --test tests/a2aSimplemsgMetadataBackfill.test.mjs
npx tsx --test tests/a2aMessageItem.test.tsx
npx tsx --test tests/coworkOrderFocus.test.tsx
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
node --test tests/privateChatOrderCoworkTimeout.test.mjs
npx tsx --test tests/privateChatRatingPrompt.test.ts
rg -n "sourceChannel\\s*[:=]\\s*['\\\"]metaweb_order['\\\"]" src/main
```

Expected: all tests pass. The grep output is empty or limited to documented order-index/legacy compatibility code, with no display-message metadata writers left on `metaweb_order`.

- [ ] **Step 2: Real-session smoke check**

Use a temporary copy of the user SQLite database and verify without mutating the real DB.

First identify the current app DB path from the existing store path logic or app data directory, then copy it into `/tmp` and run a one-off read/migration probe against the copy. The command must follow this shape, with the real DB path filled in after inspection:

```bash
DB_COPY="/tmp/idbots-unified-simplemsg-smoke.sqlite"
cp "<real-user-db-path>" "$DB_COPY"
IDBOTS_SQLITE_PATH="$DB_COPY" node scripts/smoke-unified-simplemsg-session.mjs 3ef6f6e4-52d4-46f3-b7f0-1be0a9309802
```

If there is no existing smoke script, create a temporary ignored script or use a `node --input-type=module` one-liner that opens the copied DB through the production stores and reports the three assertions below. Do not add a throwaway smoke script to the commit unless it becomes a reusable test.

- session `3ef6f6e4-52d4-46f3-b7f0-1be0a9309802` order messages can be projected into the canonical peer session,
- old order session would be hidden from `listSessions()`,
- `[DELIVERY]` message keeps `pinId` and `txid`.

Do not mutate the real user database for this smoke check. If no real DB exists in the current environment, report that this smoke was skipped and keep the automated migration tests as the verification evidence.

- [ ] **Step 3: SubAgent code review**

Dispatch a review subAgent with:

- spec path,
- plan path,
- base commit before implementation,
- final HEAD,
- focused behavior summary.

Fix Critical/Important findings.

- [ ] **Step 4: SubAgent test acceptance**

Dispatch a separate acceptance subAgent to run the focused suite.

- [ ] **Step 5: Final commit if review fixes were needed**

If review fixes changed files:

Run `git status --short`, stage only the files touched by the review fixes, and commit them with:

```bash
git commit -m "fix: harden unified simplemsg conversation flow"
```

Post a Codex `metabot-post-buzz` development journal after the commit.

- [ ] **Step 6: Final status**

Report:

- branch/worktree,
- commits created,
- tests run,
- subAgent review/acceptance result,
- dev command:

```bash
cd /Users/tusm/Documents/MetaID_Projects/IDBots/IDBots/.worktrees/codex/order-protocol-boundary && npm run electron:dev
```
