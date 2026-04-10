import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');
const {
  DEFAULT_REFUND_REQUEST_RETRY_DELAY_MS,
  SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON,
  SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE,
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
    resolveLocalMetabotGlobalMetaId: options.resolveLocalMetabotGlobalMetaId,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
}

test('createBuyerOrder allows multiple unresolved orders for the same buyer/seller pair when payment txids differ', async () => {
  const { service } = await createLifecycleServiceForTest();

  const first = service.createBuyerOrder(baseOrderInput());
  const second = service.createBuyerOrder(baseOrderInput({ paymentTxid: 'b'.repeat(64) }));

  assert.equal(first.paymentTxid, 'a'.repeat(64));
  assert.equal(second.paymentTxid, 'b'.repeat(64));
});

test('getBuyerOrderAvailability stays allowed when the pair already has an unresolved order', async () => {
  const { service } = await createLifecycleServiceForTest();

  service.createBuyerOrder(baseOrderInput());

  assert.deepEqual(
    service.getBuyerOrderAvailability(7, 'seller-global-metaid'),
    { allowed: true }
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

test('getBuyerOrderAvailability rejects self-directed orders for the same MetaBot global identity', async () => {
  const { service } = await createLifecycleServiceForTest({
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 7 ? 'seller-global-metaid' : null
    ),
  });

  assert.deepEqual(
    service.getBuyerOrderAvailability(7, 'seller-global-metaid'),
    {
      allowed: false,
      errorCode: SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE,
      error: 'A MetaBot cannot order its own service.',
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

test('createBuyerOrder persists structured MRC20 settlement metadata', async () => {
  const { service } = await createLifecycleServiceForTest();

  const order = service.createBuyerOrder(baseOrderInput({
    paymentTxid: 'f'.repeat(64),
    paymentCommitTxid: 'e'.repeat(64),
    paymentChain: 'btc',
    paymentAmount: '1.11',
    paymentCurrency: 'TRAC-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'trac',
    mrc20Id: 'mrc20-token-id-003',
  }));

  assert.equal(order.paymentTxid, 'f'.repeat(64));
  assert.equal(order.paymentCommitTxid, 'e'.repeat(64));
  assert.equal(order.paymentChain, 'btc');
  assert.equal(order.paymentCurrency, 'TRAC-MRC20');
  assert.equal(order.settlementKind, 'mrc20');
  assert.equal(order.mrc20Ticker, 'TRAC');
  assert.equal(order.mrc20Id, 'mrc20-token-id-003');
});

test('reserveBuyerOrderCreation refuses concurrent in-flight creation for the same payment txid only', async () => {
  const { service } = await createLifecycleServiceForTest();

  const release = service.reserveBuyerOrderCreation(7, 'seller-global-metaid', 'a'.repeat(64));

  assert.throws(
    () => service.reserveBuyerOrderCreation(7, 'seller-global-metaid', 'a'.repeat(64)),
    /open order already exists/i
  );

  const otherRelease = service.reserveBuyerOrderCreation(7, 'seller-global-metaid', 'b'.repeat(64));
  otherRelease();

  release();

  const nextRelease = service.reserveBuyerOrderCreation(7, 'seller-global-metaid', 'a'.repeat(64));
  nextRelease();
});

test('repairSelfDirectedOrders locally resolves broken self-order rows so they no longer block new orders', async () => {
  const now = 1_770_000_333_000;
  const { service, store } = await createLifecycleServiceForTest({
    now: () => now,
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 7 ? 'self-global-metaid' : null
    ),
  });

  const buyerOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 7,
    counterpartyGlobalMetaid: 'self-global-metaid',
    servicePinId: 'service-pin-id',
    serviceName: 'Weather Pro',
    paymentTxid: 'c'.repeat(64),
    paymentChain: 'mvc',
    paymentAmount: '12.34',
    paymentCurrency: 'SPACE',
    coworkSessionId: 'buyer-session-id',
    status: 'refund_pending',
    now,
  });
  const sellerOrder = store.createOrder({
    role: 'seller',
    localMetabotId: 7,
    counterpartyGlobalMetaid: 'self-global-metaid',
    servicePinId: 'service-pin-id',
    serviceName: 'Weather Pro',
    paymentTxid: 'c'.repeat(64),
    paymentChain: 'mvc',
    paymentAmount: '12.34',
    paymentCurrency: 'SPACE',
    coworkSessionId: 'seller-session-id',
    status: 'refund_pending',
    now,
  });

  const repaired = service.repairSelfDirectedOrders();

  assert.equal(repaired.length, 2);
  assert.equal(store.getOrderById(buyerOrder.id)?.status, 'refunded');
  assert.equal(store.getOrderById(sellerOrder.id)?.status, 'refunded');
  assert.equal(store.getOrderById(buyerOrder.id)?.failureReason, SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE);
  assert.deepEqual(
    service.getBuyerOrderAvailability(7, 'self-global-metaid'),
    {
      allowed: false,
      errorCode: SERVICE_ORDER_SELF_ORDER_NOT_ALLOWED_ERROR_CODE,
      error: 'A MetaBot cannot order its own service.',
    }
  );
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

test('markSellerOrderFirstResponseSent moves awaiting seller orders into in_progress', async () => {
  const now = 1_770_000_111_500;
  const { service } = await createLifecycleServiceForTest({
    now: () => now,
  });
  const order = service.createSellerOrder(baseOrderInput());

  const updated = service.markSellerOrderFirstResponseSent({
    localMetabotId: order.localMetabotId,
    counterpartyGlobalMetaId: order.counterpartyGlobalMetaid,
    paymentTxid: order.paymentTxid,
    sentAt: now,
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

test('scanTimedOutOrders includes structured MRC20 settlement fields in the refund request payload', async () => {
  let currentNow = 1_770_000_000_000;
  let refundRequestInput = null;
  const { service } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async (input) => {
      refundRequestInput = input;
      return { pinId: 'refund-request-mrc20-pin-id' };
    },
  });

  service.createBuyerOrder(baseOrderInput({
    paymentTxid: '1'.repeat(64),
    paymentCommitTxid: '2'.repeat(64),
    paymentChain: 'btc',
    paymentAmount: '3.5',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'metaid',
    mrc20Id: 'mrc20-token-id-101',
  }));

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  assert.equal(refundRequestInput?.payload.paymentTxid, '1'.repeat(64));
  assert.equal(refundRequestInput?.payload.paymentChain, 'btc');
  assert.equal(refundRequestInput?.payload.refundAmount, '3.5');
  assert.equal(refundRequestInput?.payload.refundCurrency, 'METAID-MRC20');
  assert.equal(refundRequestInput?.payload.settlementKind, 'mrc20');
  assert.equal(refundRequestInput?.payload.mrc20Ticker, 'METAID');
  assert.equal(refundRequestInput?.payload.mrc20Id, 'mrc20-token-id-101');
  assert.equal(refundRequestInput?.payload.paymentCommitTxid, '2'.repeat(64));
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

test('scanTimedOutOrders auto-resolves free timed-out orders without creating refund requests', async () => {
  let currentNow = 1_770_000_000_000;
  let refundRequestCalls = 0;
  const seenEvents = [];
  const { service, store } = await createLifecycleServiceForTest({
    now: () => currentNow,
    createRefundRequestPin: async () => {
      refundRequestCalls += 1;
      return { pinId: 'refund-request-pin-id' };
    },
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}`);
    },
  });

  const buyerOrder = service.createBuyerOrder(baseOrderInput({
    paymentTxid: '0'.repeat(64),
    paymentAmount: '0',
    coworkSessionId: 'buyer-session-id',
  }));
  const sellerOrder = service.createSellerOrder(baseOrderInput({
    paymentTxid: '0'.repeat(64),
    paymentAmount: '0',
    coworkSessionId: 'seller-session-id',
  }));

  currentNow += 5 * 60_000 + 1;
  await service.scanTimedOutOrders();

  assert.equal(refundRequestCalls, 0);
  assert.equal(store.getOrderById(buyerOrder.id)?.status, 'refunded');
  assert.equal(store.getOrderById(sellerOrder.id)?.status, 'refunded');
  assert.equal(store.getOrderById(buyerOrder.id)?.refundRequestPinId, null);
  assert.equal(store.getOrderById(sellerOrder.id)?.refundRequestPinId, null);
  assert.equal(
    store.getOrderById(buyerOrder.id)?.failureReason,
    'first_response_timeout'
  );
  assert.equal(
    store.getOrderById(sellerOrder.id)?.failureReason,
    SERVICE_ORDER_FREE_REFUND_SKIPPED_REASON
  );
  assert.deepEqual(
    seenEvents.map((event) => event).sort(),
    ['refunded:buyer', 'refunded:seller']
  );
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
