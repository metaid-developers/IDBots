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
    fetchRefundFinalizePins: options.fetchRefundFinalizePins || (async () => []),
    buildRefundVerificationInput: options.buildRefundVerificationInput,
    verifyTransferToRecipient: options.verifyTransferToRecipient,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
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
