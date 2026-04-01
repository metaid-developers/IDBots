import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const require = createRequire(import.meta.url);
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

let buildServiceOrderObserverConversationId;
let recoverMissingRefundPendingOrderSessions;

try {
  ({ buildServiceOrderObserverConversationId } = await import('../dist-electron/services/serviceOrderObserverSession.js'));
  ({ recoverMissingRefundPendingOrderSessions } = await import('../dist-electron/services/serviceOrderSessionRecovery.js'));
} catch {
  buildServiceOrderObserverConversationId = undefined;
  recoverMissingRefundPendingOrderSessions = undefined;
}

function createRefundPendingOrder(store, overrides = {}) {
  const now = 1_770_000_000_000;
  const order = store.createOrder({
    role: overrides.role ?? 'seller',
    localMetabotId: overrides.localMetabotId ?? 8,
    counterpartyGlobalMetaid: overrides.counterpartyGlobalMetaid ?? 'buyer-global-metaid',
    servicePinId: overrides.servicePinId ?? 'service-pin-id',
    serviceName: overrides.serviceName ?? 'Weather Pro',
    paymentTxid: overrides.paymentTxid ?? 'a'.repeat(64),
    paymentChain: overrides.paymentChain ?? 'mvc',
    paymentAmount: overrides.paymentAmount ?? '12.34',
    paymentCurrency: overrides.paymentCurrency ?? 'SPACE',
    orderMessagePinId: overrides.orderMessagePinId ?? 'order-pin-id',
    coworkSessionId: overrides.coworkSessionId ?? null,
    status: overrides.status ?? 'awaiting_first_response',
    now,
  });

  store.markFailed(order.id, overrides.failureReason ?? 'delivery_timeout', now + 1);
  return store.markRefundPending(
    order.id,
    overrides.refundRequestPinId ?? 'refund-request-pin-id',
    overrides.refundRequestedAt ?? (now + 2)
  );
}

test('buildServiceOrderObserverConversationId scopes sessions by role, peer, and txid prefix', () => {
  assert.equal(typeof buildServiceOrderObserverConversationId, 'function');

  const buyerConversationId = buildServiceOrderObserverConversationId({
    role: 'buyer',
    metabotId: 12,
    peerGlobalMetaId: 'seller-global-metaid',
    paymentTxid: 'a'.repeat(64),
  });
  const sellerConversationId = buildServiceOrderObserverConversationId({
    role: 'seller',
    metabotId: 12,
    peerGlobalMetaId: 'buyer-global-metaid',
    paymentTxid: 'a'.repeat(64),
  });

  assert.equal(
    buyerConversationId,
    `metaweb_order:buyer:12:seller-global-metaid:${'a'.repeat(16)}`
  );
  assert.equal(
    sellerConversationId,
    `metaweb_order:seller:12:buyer-global-metaid:${'a'.repeat(16)}`
  );
});

test('recoverMissingRefundPendingOrderSessions recreates deleted seller refund sessions with restored order text', async () => {
  assert.equal(typeof recoverMissingRefundPendingOrderSessions, 'function');
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const orderStore = new ServiceOrderStore(sqlite.db, () => {});
    const order = createRefundPendingOrder(orderStore, {
      role: 'seller',
      localMetabotId: 8,
      counterpartyGlobalMetaid: 'buyer-global-metaid',
      paymentTxid: 'b'.repeat(64),
    });

    const firstPass = await recoverMissingRefundPendingOrderSessions({
      coworkStore,
      orderStore,
      resolvePeerInfo: () => ({ peerName: 'Buyer Bot', peerAvatar: null }),
      resolveOrderText: () => (
        `[ORDER] 请处理天气查询\n支付金额 12.34 SPACE\ntxid: ${'b'.repeat(64)}`
      ),
    });

    assert.equal(firstPass.length, 1);

    const firstRecoveredOrder = orderStore.getOrderById(order.id);
    const firstSessionId = firstRecoveredOrder?.coworkSessionId;
    assert.ok(firstSessionId);
    const firstSession = coworkStore.getSession(firstSessionId);
    assert.ok(firstSession);
    assert.equal(firstSession?.sessionType, 'a2a');
    assert.equal(firstSession?.peerGlobalMetaId, 'buyer-global-metaid');
    assert.equal(firstSession?.messages?.[0]?.metadata?.direction, 'incoming');
    assert.match(firstSession?.messages?.[0]?.content || '', /^\[ORDER\]/);
    assert.match(firstSession?.messages?.[0]?.content || '', /txid:\s*[0-9a-f]{64}/i);
    assert.match(firstSession?.messages?.[1]?.content || '', /自动恢复/i);

    coworkStore.deleteSession(firstSessionId);

    const secondPass = await recoverMissingRefundPendingOrderSessions({
      coworkStore,
      orderStore,
      resolvePeerInfo: () => ({ peerName: 'Buyer Bot', peerAvatar: null }),
      resolveOrderText: () => (
        `[ORDER] 请处理天气查询\n支付金额 12.34 SPACE\ntxid: ${'b'.repeat(64)}`
      ),
    });

    assert.equal(secondPass.length, 1);
    const secondRecoveredOrder = orderStore.getOrderById(order.id);
    assert.ok(secondRecoveredOrder?.coworkSessionId);
    assert.notEqual(secondRecoveredOrder?.coworkSessionId, firstSessionId);
    assert.ok(coworkStore.getSession(secondRecoveredOrder?.coworkSessionId || ''));
  } finally {
    sqlite.cleanup();
  }
});

test('recoverMissingRefundPendingOrderSessions falls back to a structured order payload when source text is unavailable', async () => {
  assert.equal(typeof recoverMissingRefundPendingOrderSessions, 'function');
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const orderStore = new ServiceOrderStore(sqlite.db, () => {});
    const order = createRefundPendingOrder(orderStore, {
      role: 'buyer',
      localMetabotId: 7,
      counterpartyGlobalMetaid: 'seller-global-metaid',
      paymentTxid: 'c'.repeat(64),
      servicePinId: 'service-weather',
      serviceName: 'Weather Pro',
      paymentAmount: '0.0001',
    });

    const recovered = await recoverMissingRefundPendingOrderSessions({
      coworkStore,
      orderStore,
      resolvePeerInfo: () => ({ peerName: 'Seller Bot', peerAvatar: null }),
      resolveOrderText: () => null,
    });

    assert.equal(recovered.length, 1);
    const recoveredOrder = orderStore.getOrderById(order.id);
    const session = coworkStore.getSession(recoveredOrder?.coworkSessionId || '');
    assert.ok(session);
    assert.equal(session?.messages?.[0]?.metadata?.direction, 'outgoing');
    assert.match(session?.messages?.[0]?.content || '', /^\[ORDER\]/);
    assert.match(session?.messages?.[0]?.content || '', /txid:\s*[0-9a-f]{64}/i);
    assert.match(session?.messages?.[0]?.content || '', /service id:\s*service-weather/i);
  } finally {
    sqlite.cleanup();
  }
});

test('recoverMissingRefundPendingOrderSessions recreates an observer session without overwriting a live source session link', async () => {
  assert.equal(typeof recoverMissingRefundPendingOrderSessions, 'function');
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const orderStore = new ServiceOrderStore(sqlite.db, () => {});
    const sourceSession = coworkStore.createSession(
      'Delegation Source',
      process.cwd(),
      '',
      'local',
      [],
      11,
      'standard',
      'seller-global-metaid',
      'Seller Bot',
      null
    );
    const order = createRefundPendingOrder(orderStore, {
      role: 'buyer',
      localMetabotId: 11,
      counterpartyGlobalMetaid: 'seller-global-metaid',
      paymentTxid: 'd'.repeat(64),
      coworkSessionId: sourceSession.id,
    });

    const recovered = await recoverMissingRefundPendingOrderSessions({
      coworkStore,
      orderStore,
      resolvePeerInfo: () => ({ peerName: 'Seller Bot', peerAvatar: null }),
      resolveOrderText: () => (
        `[ORDER] 自动代理下单\n支付金额 12.34 SPACE\ntxid: ${'d'.repeat(64)}`
      ),
    });

    assert.equal(recovered.length, 1);

    const refreshedOrder = orderStore.getOrderById(order.id);
    assert.equal(refreshedOrder?.coworkSessionId, sourceSession.id);

    const observerConversationId = buildServiceOrderObserverConversationId({
      role: 'buyer',
      metabotId: 11,
      peerGlobalMetaId: 'seller-global-metaid',
      paymentTxid: 'd'.repeat(64),
    });
    const mapping = coworkStore.getConversationMapping('metaweb_order', observerConversationId, 11);
    assert.ok(mapping);
    assert.notEqual(mapping?.coworkSessionId, sourceSession.id);

    const recoveredSession = coworkStore.getSession(mapping?.coworkSessionId || '');
    assert.ok(recoveredSession);
    assert.equal(recoveredSession?.sessionType, 'a2a');
    assert.match(recoveredSession?.messages?.[1]?.content || '', /自动恢复/i);
  } finally {
    sqlite.cleanup();
  }
});
