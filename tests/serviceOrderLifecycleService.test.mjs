import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');
const {
  DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS,
  ServiceOrderLifecycleService,
} = require('../dist-electron/services/serviceOrderLifecycleService.js');

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

function baseOrderInput(overrides = {}) {
  return {
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'seller-global-metaid',
    servicePinId: 'service-pin-id',
    serviceName: 'Weather Pro',
    paymentTxid: 'a'.repeat(64),
    paymentChain: 'mvc',
    paymentAmount: '12.34',
    paymentCurrency: 'SPACE',
    coworkSessionId: 'cowork-session-id',
    orderMessagePinId: 'order-pin-id',
    ...overrides,
  };
}

async function createLifecycleServiceForTest(options = {}) {
  const db = await createSqlDatabase();
  const store = new ServiceOrderStore(db, () => {});
  const service = new ServiceOrderLifecycleService(store, {
    now: options.now || (() => 1_770_000_000_000),
    createRefundRequestPin: options.createRefundRequestPin,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
}

test('createBuyerOrder refuses a second unresolved order for the same buyer/seller pair', async () => {
  const { service } = await createLifecycleServiceForTest();

  service.createBuyerOrder(baseOrderInput());

  assert.throws(
    () => service.createBuyerOrder(baseOrderInput({ paymentTxid: 'b'.repeat(64) })),
    /open order already exists/i
  );
});

test('getBuyerOrderAvailability reports blocked before payment when the pair already has an unresolved order', async () => {
  const { service } = await createLifecycleServiceForTest();

  service.createBuyerOrder(baseOrderInput());

  assert.deepEqual(
    service.getBuyerOrderAvailability(7, 'seller-global-metaid'),
    {
      allowed: false,
      errorCode: 'open_order_exists',
      error: 'Open order already exists for this buyer and provider.',
    }
  );
});

test('getBuyerOrderAvailability reports allowed when the pair has no unresolved order', async () => {
  const { service } = await createLifecycleServiceForTest();

  assert.deepEqual(
    service.getBuyerOrderAvailability(7, 'seller-global-metaid'),
    {
      allowed: true,
    }
  );
});

test('createBuyerOrder persists SLA deadlines and links the cowork session', async () => {
  const now = 1_770_000_000_000;
  const { service } = await createLifecycleServiceForTest({
    now: () => now,
  });

  const order = service.createBuyerOrder(baseOrderInput());

  assert.equal(order.status, 'awaiting_first_response');
  assert.equal(order.coworkSessionId, 'cowork-session-id');
  assert.equal(order.orderMessagePinId, 'order-pin-id');
  assert.equal(order.firstResponseDeadlineAt, now + 5 * 60_000);
  assert.equal(order.deliveryDeadlineAt, now + 15 * 60_000);
});

test('reserveBuyerOrderCreation refuses concurrent in-flight creation for the same buyer/seller pair', async () => {
  const { service } = await createLifecycleServiceForTest();

  const release = service.reserveBuyerOrderCreation(7, 'seller-global-metaid');

  assert.throws(
    () => service.reserveBuyerOrderCreation(7, 'seller-global-metaid'),
    /open order already exists/i
  );

  release();

  const nextRelease = service.reserveBuyerOrderCreation(7, 'seller-global-metaid');
  nextRelease();
});

test('createSellerOrder persists a seller-side ledger row keyed by payment txid', async () => {
  const { service } = await createLifecycleServiceForTest();

  const order = service.createSellerOrder(baseOrderInput());

  assert.equal(order.role, 'seller');
  assert.equal(order.status, 'awaiting_first_response');
  assert.equal(order.paymentTxid, 'a'.repeat(64));
});

test('markBuyerOrderFirstResponseReceived moves awaiting orders into in_progress', async () => {
  const now = 1_770_000_111_000;
  const { service } = await createLifecycleServiceForTest({
    now: () => now,
  });
  const order = service.createBuyerOrder(baseOrderInput());

  const updated = service.markBuyerOrderFirstResponseReceived({
    localMetabotId: order.localMetabotId,
    counterpartyGlobalMetaId: order.counterpartyGlobalMetaid,
    paymentTxid: order.paymentTxid,
    receivedAt: now,
  });

  assert.equal(updated?.status, 'in_progress');
  assert.equal(updated?.firstResponseAt, now);
});

test('markBuyerOrderDelivered completes the buyer order and stores the delivery message pin', async () => {
  const now = 1_770_000_222_000;
  const { service } = await createLifecycleServiceForTest({
    now: () => now,
  });
  const order = service.createBuyerOrder(baseOrderInput());

  const updated = service.markBuyerOrderDelivered({
    localMetabotId: order.localMetabotId,
    counterpartyGlobalMetaId: order.counterpartyGlobalMetaid,
    paymentTxid: order.paymentTxid,
    deliveryMessagePinId: 'delivery-pin-id',
    deliveredAt: now,
  });

  assert.equal(updated?.status, 'completed');
  assert.equal(updated?.deliveryMessagePinId, 'delivery-pin-id');
  assert.equal(updated?.deliveredAt, now);
  assert.equal(updated?.firstResponseAt, now);
});

test('scanTimedOutOrders marks first-response timeout orders failed and moves them into refund_pending on successful refund request broadcast', async () => {
  let currentNow = 1_770_000_000_000;
  let refundRequestInput = null;
  const { service, store } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async (input) => {
      refundRequestInput = input;
      return { pinId: 'refund-request-pin-id' };
    },
  });
  const order = service.createBuyerOrder(baseOrderInput());

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  const updated = store.getOrderById(order.id);
  assert.equal(updated?.status, 'refund_pending');
  assert.equal(updated?.failureReason, 'first_response_timeout');
  assert.equal(updated?.refundRequestPinId, 'refund-request-pin-id');
  assert.equal(updated?.refundRequestedAt, currentNow);
  assert.equal(refundRequestInput?.payload.paymentTxid, order.paymentTxid);
});

test('scanTimedOutOrders mirrors refund_pending onto the seller ledger row for the same order', async () => {
  let currentNow = 1_770_000_000_000;
  const { service, store } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async () => ({ pinId: 'refund-request-pin-id' }),
  });

  const buyerOrder = service.createBuyerOrder(baseOrderInput({
    coworkSessionId: 'buyer-session-id',
  }));
  const sellerOrder = service.createSellerOrder(baseOrderInput({
    coworkSessionId: 'seller-session-id',
  }));

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  assert.equal(store.getOrderById(buyerOrder.id)?.status, 'refund_pending');
  assert.equal(store.getOrderById(sellerOrder.id)?.status, 'refund_pending');
  assert.equal(store.getOrderById(sellerOrder.id)?.refundRequestPinId, 'refund-request-pin-id');
});

test('scanTimedOutOrders emits refund_requested events for every mirrored session order', async () => {
  let currentNow = 1_770_000_000_000;
  const seenEvents = [];
  const { service } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async () => ({ pinId: 'refund-request-pin-id' }),
    onOrderEvent: (event) => {
      seenEvents.push({ type: event.type, orderId: event.order.id, role: event.order.role });
    },
  });

  service.createBuyerOrder(baseOrderInput({
    coworkSessionId: 'buyer-session-id',
  }));
  service.createSellerOrder(baseOrderInput({
    coworkSessionId: 'seller-session-id',
  }));

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  assert.deepEqual(
    seenEvents.map((event) => `${event.type}:${event.role}`).sort(),
    ['refund_requested:buyer', 'refund_requested:seller']
  );
});

test('scanTimedOutOrders records retry metadata when refund request broadcast fails', async () => {
  let currentNow = 1_770_000_000_000;
  const { service, store } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async () => {
      throw new Error('offline');
    },
  });
  const order = service.createBuyerOrder(baseOrderInput());

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  const updated = store.getOrderById(order.id);
  assert.equal(updated?.status, 'failed');
  assert.equal(updated?.failureReason, 'first_response_timeout');
  assert.equal(updated?.refundApplyRetryCount, 1);
  assert.equal(updated?.nextRetryAt, currentNow + DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS);
  assert.equal(updated?.refundRequestPinId, null);
});

test('scanTimedOutOrders retries failed refund requests once nextRetryAt is due', async () => {
  let currentNow = 1_770_000_000_000;
  let attempts = 0;
  const { db, service, store } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async () => {
      attempts += 1;
      return { pinId: `refund-pin-${attempts}` };
    },
  });

  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      status, first_response_deadline_at, delivery_deadline_at, failed_at, failure_reason,
      refund_apply_retry_count, next_retry_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'failed-order',
      'buyer',
      7,
      'seller-global-metaid',
      'service-pin-id',
      'Weather Pro',
      'f'.repeat(64),
      'mvc',
      '12.34',
      'SPACE',
      'order-pin-id',
      'failed',
      currentNow + 5 * 60_000,
      currentNow + 15 * 60_000,
      currentNow,
      'first_response_timeout',
      1,
      currentNow - 1,
      currentNow - 60_000,
      currentNow - 60_000,
    ]
  );

  await service.scanTimedOutOrders();

  const updated = store.getOrderById('failed-order');
  assert.equal(updated?.status, 'refund_pending');
  assert.equal(updated?.refundRequestPinId, 'refund-pin-1');
  assert.equal(updated?.refundApplyRetryCount, 1);
});

test('createBuyerOrder allows a new order after the previous one is completed', async () => {
  const { db, service } = await createLifecycleServiceForTest();

  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'completed-order',
      'buyer',
      7,
      'seller-global-metaid',
      'Weather Pro',
      'c'.repeat(64),
      'mvc',
      '12.34',
      'SPACE',
      'completed',
      1_770_000_000_000 + 5 * 60_000,
      1_770_000_000_000 + 15 * 60_000,
      1_770_000_000_000,
      1_770_000_000_000,
    ]
  );

  const order = service.createBuyerOrder(baseOrderInput({ paymentTxid: 'd'.repeat(64) }));

  assert.equal(order.paymentTxid, 'd'.repeat(64));
});
