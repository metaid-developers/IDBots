import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');
const { ServiceRefundSyncService } = require('../dist-electron/services/serviceRefundSyncService.js');

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

async function createRefundSyncServiceForTest(options = {}) {
  const db = await createSqlDatabase();
  const store = new ServiceOrderStore(db, () => {});
  const service = new ServiceRefundSyncService(store, {
    now: options.now || (() => 1_770_000_000_000),
    fetchRefundRequestPins: options.fetchRefundRequestPins || (async () => []),
    fetchRefundFinalizePins: options.fetchRefundFinalizePins || (async () => []),
    resolveLocalMetabotGlobalMetaId: options.resolveLocalMetabotGlobalMetaId,
    buildRefundVerificationInput: options.buildRefundVerificationInput,
    verifyTransferToRecipient: options.verifyTransferToRecipient,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
}

function insertSellerOrder(
  db,
  {
    id = 'seller-order',
    localMetabotId = 8,
    counterpartyGlobalMetaId = 'buyer-global-metaid',
    paymentTxid = 'a'.repeat(64),
    servicePinId = 'service-pin-id',
    status = 'awaiting_first_response',
    failureReason = null,
    refundRequestPinId = null,
    refundRequestedAt = null,
    refundCompletedAt = null,
  } = {}
) {
  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      status, first_response_deadline_at, delivery_deadline_at, failed_at, failure_reason,
      refund_request_pin_id, refund_requested_at, refund_completed_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'seller',
      localMetabotId,
      counterpartyGlobalMetaId,
      servicePinId,
      'Weather Pro',
      paymentTxid,
      'mvc',
      '12.34',
      'SPACE',
      'order-pin-id',
      status,
      1_770_000_000_000 + 5 * 60_000,
      1_770_000_000_000 + 15 * 60_000,
      failureReason ? 1_770_000_000_000 : null,
      failureReason,
      refundRequestPinId,
      refundRequestedAt,
      refundCompletedAt,
      1_770_000_000_000,
      1_770_000_000_000,
    ]
  );
}

function insertRefundPendingBuyerOrder(db) {
  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      status, first_response_deadline_at, delivery_deadline_at, failed_at, failure_reason,
      refund_request_pin_id, refund_requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'refund-pending-order',
      'buyer',
      7,
      'seller-global-metaid',
      'service-pin-id',
      'Weather Pro',
      'a'.repeat(64),
      'mvc',
      '12.34',
      'SPACE',
      'order-pin-id',
      'refund_pending',
      1_770_000_000_000 + 5 * 60_000,
      1_770_000_000_000 + 15 * 60_000,
      1_770_000_000_000,
      'first_response_timeout',
      'refund-request-pin-id',
      1_770_000_000_000,
      1_770_000_000_000,
      1_770_000_000_000,
    ]
  );
}

function insertRefundPendingSellerOrder(db) {
  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      status, first_response_deadline_at, delivery_deadline_at, failed_at, failure_reason,
      refund_request_pin_id, refund_requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      'refund-pending-seller-order',
      'seller',
      8,
      'buyer-global-metaid',
      'service-pin-id',
      'Weather Pro',
      'a'.repeat(64),
      'mvc',
      '12.34',
      'SPACE',
      'order-pin-id',
      'refund_pending',
      1_770_000_000_000 + 5 * 60_000,
      1_770_000_000_000 + 15 * 60_000,
      1_770_000_000_000,
      'first_response_timeout',
      'refund-request-pin-id',
      1_770_000_000_000,
      1_770_000_000_000,
      1_770_000_000_000,
    ]
  );
}

function insertProviderRiskBuyerOrder(db, {
  id,
  providerGlobalMetaId,
  refundRequestedAt,
}) {
  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      status, first_response_deadline_at, delivery_deadline_at, failed_at, failure_reason,
      refund_request_pin_id, refund_requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      'buyer',
      7,
      providerGlobalMetaId,
      'service-pin-id',
      'Weather Pro',
      `${id}`.padEnd(64, 'a').slice(0, 64),
      'mvc',
      '12.34',
      'SPACE',
      'order-pin-id',
      'refund_pending',
      refundRequestedAt - 5 * 60_000,
      refundRequestedAt - 1,
      refundRequestedAt - 60_000,
      'delivery_timeout',
      `${id}-refund-pin`,
      refundRequestedAt,
      refundRequestedAt - 60_000,
      refundRequestedAt,
    ]
  );
}

test('syncFinalizePins marks refund-pending orders refunded when finalize protocol and tx verification match', async () => {
  const now = 1_770_000_123_000;
  const { db, store, service } = await createRefundSyncServiceForTest({
    now: () => now,
    fetchRefundFinalizePins: async () => [{
      pinId: 'refund-finalize-pin-id',
      content: JSON.stringify({
        refundRequestPinId: 'refund-request-pin-id',
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        refundTxid: 'b'.repeat(64),
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    buildRefundVerificationInput: (_order, payload) => ({
      chain: 'mvc',
      txid: payload.refundTxid,
      recipientAddress: '1111111111111111111111111111111111',
      expectedAmountSats: 1234000000,
    }),
    verifyTransferToRecipient: async () => ({
      valid: true,
      reason: 'ok',
    }),
  });
  insertRefundPendingBuyerOrder(db);

  await service.syncFinalizePins();

  const updated = store.getOrderById('refund-pending-order');
  assert.equal(updated?.status, 'refunded');
  assert.equal(updated?.refundFinalizePinId, 'refund-finalize-pin-id');
  assert.equal(updated?.refundTxid, 'b'.repeat(64));
  assert.equal(updated?.refundCompletedAt, now);
});

test('syncFinalizePins leaves refund-pending orders unchanged when tx verification fails', async () => {
  const { db, store, service } = await createRefundSyncServiceForTest({
    fetchRefundFinalizePins: async () => [{
      pinId: 'refund-finalize-pin-id',
      content: JSON.stringify({
        refundRequestPinId: 'refund-request-pin-id',
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        refundTxid: 'b'.repeat(64),
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    buildRefundVerificationInput: (_order, payload) => ({
      chain: 'mvc',
      txid: payload.refundTxid,
      recipientAddress: '1111111111111111111111111111111111',
      expectedAmountSats: 1234000000,
    }),
    verifyTransferToRecipient: async () => ({
      valid: false,
      reason: 'recipient_amount_mismatch',
    }),
  });
  insertRefundPendingBuyerOrder(db);

  await service.syncFinalizePins();

  const updated = store.getOrderById('refund-pending-order');
  assert.equal(updated?.status, 'refund_pending');
  assert.equal(updated?.refundFinalizePinId, null);
  assert.equal(updated?.refundCompletedAt, null);
});

test('syncFinalizePins mirrors refunded state onto the seller ledger row for the same order', async () => {
  const now = 1_770_000_123_000;
  const { db, store, service } = await createRefundSyncServiceForTest({
    now: () => now,
    fetchRefundFinalizePins: async () => [{
      pinId: 'refund-finalize-pin-id',
      content: JSON.stringify({
        refundRequestPinId: 'refund-request-pin-id',
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        refundTxid: 'b'.repeat(64),
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    buildRefundVerificationInput: (_order, payload) => ({
      chain: 'mvc',
      txid: payload.refundTxid,
      recipientAddress: '1111111111111111111111111111111111',
      expectedAmountSats: 1234000000,
    }),
    verifyTransferToRecipient: async () => ({
      valid: true,
      reason: 'ok',
    }),
  });
  insertRefundPendingBuyerOrder(db);
  insertRefundPendingSellerOrder(db);

  await service.syncFinalizePins();

  assert.equal(store.getOrderById('refund-pending-order')?.status, 'refunded');
  assert.equal(store.getOrderById('refund-pending-seller-order')?.status, 'refunded');
  assert.equal(store.getOrderById('refund-pending-seller-order')?.refundTxid, 'b'.repeat(64));
});

test('syncFinalizePins emits refunded events for every mirrored session order', async () => {
  const now = 1_770_000_123_000;
  const seenEvents = [];
  const { db, service } = await createRefundSyncServiceForTest({
    now: () => now,
    fetchRefundFinalizePins: async () => [{
      pinId: 'refund-finalize-pin-id',
      content: JSON.stringify({
        refundRequestPinId: 'refund-request-pin-id',
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        refundTxid: 'b'.repeat(64),
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    buildRefundVerificationInput: (_order, payload) => ({
      chain: 'mvc',
      txid: payload.refundTxid,
      recipientAddress: '1111111111111111111111111111111111',
      expectedAmountSats: 1234000000,
    }),
    verifyTransferToRecipient: async () => ({
      valid: true,
      reason: 'ok',
    }),
    onOrderEvent: (event) => {
      seenEvents.push({ type: event.type, role: event.order.role });
    },
  });
  insertRefundPendingBuyerOrder(db);
  insertRefundPendingSellerOrder(db);

  await service.syncFinalizePins();

  assert.deepEqual(
    seenEvents.map((event) => `${event.type}:${event.role}`).sort(),
    ['refunded:buyer', 'refunded:seller']
  );
});

test('syncRequestPins marks matching seller orders refund_pending and emits a seller refund-requested event once', async () => {
  const now = 1_770_000_456_000;
  const seenEvents = [];
  const { db, store, service } = await createRefundSyncServiceForTest({
    now: () => now,
    fetchRefundRequestPins: async () => [{
      pinId: 'refund-request-pin-id',
      content: JSON.stringify({
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        serviceName: 'Weather Pro',
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        refundToAddress: 'seller-refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
        failureReason: 'first_response_timeout',
        failureDetectedAt: Math.floor(now / 1000),
      }),
    }],
    resolveLocalMetabotGlobalMetaId: (metabotId) => (
      metabotId === 8 ? 'seller-global-metaid' : null
    ),
    onOrderEvent: (event) => {
      seenEvents.push({ type: event.type, role: event.order.role });
    },
  });
  insertSellerOrder(db);

  assert.equal(typeof service.syncRequestPins, 'function');
  await service.syncRequestPins();

  const updated = store.getOrderById('seller-order');
  assert.equal(updated?.status, 'refund_pending');
  assert.equal(updated?.failureReason, 'first_response_timeout');
  assert.equal(updated?.refundRequestPinId, 'refund-request-pin-id');
  assert.equal(updated?.refundRequestedAt, now);
  assert.deepEqual(seenEvents, [{ type: 'refund_requested', role: 'seller' }]);

  seenEvents.length = 0;
  await service.syncRequestPins();
  assert.deepEqual(seenEvents, []);
});

test('listProviderRefundRiskSummaries reports red-vs-hidden refund risk by provider age', async () => {
  const now = 1_770_300_000_000;
  const { db, service } = await createRefundSyncServiceForTest({
    now: () => now,
    resolveLocalMetabotGlobalMetaId: (metabotId) => {
      if (metabotId === 8) return 'seller-local';
      return null;
    },
  });

  insertProviderRiskBuyerOrder(db, {
    id: 'provider-risk-visible',
    providerGlobalMetaId: 'seller-visible',
    refundRequestedAt: now - 24 * 60 * 60_000,
  });
  insertProviderRiskBuyerOrder(db, {
    id: 'provider-risk-hidden',
    providerGlobalMetaId: 'seller-hidden',
    refundRequestedAt: now - 73 * 60 * 60_000,
  });
  insertSellerOrder(db, {
    id: 'provider-risk-seller-local',
    localMetabotId: 8,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'seller-local-refund-pin',
    refundRequestedAt: now - 12 * 60 * 60_000,
  });

  const summaries = service.listProviderRefundRiskSummaries();

  assert.deepEqual(
    summaries.map((summary) => ({
      providerGlobalMetaId: summary.providerGlobalMetaId,
      hasUnresolvedRefund: summary.hasUnresolvedRefund,
      unresolvedRefundAgeHours: summary.unresolvedRefundAgeHours,
      hidden: summary.hidden,
    })).sort((a, b) => a.providerGlobalMetaId.localeCompare(b.providerGlobalMetaId)),
    [
      {
        providerGlobalMetaId: 'seller-hidden',
        hasUnresolvedRefund: true,
        unresolvedRefundAgeHours: 73,
        hidden: true,
      },
      {
        providerGlobalMetaId: 'seller-local',
        hasUnresolvedRefund: true,
        unresolvedRefundAgeHours: 12,
        hidden: false,
      },
      {
        providerGlobalMetaId: 'seller-visible',
        hasUnresolvedRefund: true,
        unresolvedRefundAgeHours: 24,
        hidden: false,
      },
    ]
  );
});
