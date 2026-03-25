import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

let ServiceRefundSettlementService;
try {
  ({ ServiceRefundSettlementService } = require('../dist-electron/services/serviceRefundSettlementService.js'));
} catch {
  ServiceRefundSettlementService = undefined;
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

async function createRefundSettlementServiceForTest(options = {}) {
  assert.equal(typeof ServiceRefundSettlementService, 'function');
  const db = await createSqlDatabase();
  const store = new ServiceOrderStore(db, () => {});
  const service = new ServiceRefundSettlementService(store, {
    now: options.now || (() => 1_770_000_789_000),
    fetchRefundRequestPin: options.fetchRefundRequestPin,
    executeRefundTransfer: options.executeRefundTransfer,
    createRefundFinalizePin: options.createRefundFinalizePin,
    resolveLocalMetabotGlobalMetaId: options.resolveLocalMetabotGlobalMetaId,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
}

function insertRefundPendingOrder(
  db,
  {
    id,
    role,
    localMetabotId,
    counterpartyGlobalMetaId,
    coworkSessionId,
    paymentTxid = 'a'.repeat(64),
    paymentChain = 'mvc',
    paymentCurrency = 'SPACE',
    paymentAmount = '12.34',
    refundRequestPinId = 'refund-request-pin-id',
    refundTxid = null,
  }
) {
  db.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_pin_id, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, order_message_pin_id,
      cowork_session_id, status, first_response_deadline_at, delivery_deadline_at, failed_at,
      failure_reason, refund_request_pin_id, refund_txid, refund_requested_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      role,
      localMetabotId,
      counterpartyGlobalMetaId,
      'service-pin-id',
      'Weather Pro',
      paymentTxid,
      paymentChain,
      paymentAmount,
      paymentCurrency,
      'order-pin-id',
      coworkSessionId,
      'refund_pending',
      1_770_000_000_000 + 5 * 60_000,
      1_770_000_000_000 + 15 * 60_000,
      1_770_000_000_000,
      'first_response_timeout',
      refundRequestPinId,
      refundTxid,
      1_770_000_000_000,
      1_770_000_000_000,
      1_770_000_000_000,
    ]
  );
}

test('processSellerRefundForSession executes the refund, writes finalize proof, and marks mirrored local rows refunded', async () => {
  const seenEvents = [];
  const transferInputs = [];
  const finalizeInputs = [];
  const { db, store, service } = await createRefundSettlementServiceForTest({
    fetchRefundRequestPin: async () => ({
      pinId: 'refund-request-pin-id',
      content: JSON.stringify({
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        serviceName: 'Weather Pro',
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        refundToAddress: '1refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }),
    executeRefundTransfer: async (input) => {
      transferInputs.push(input);
      return { txId: 'b'.repeat(64) };
    },
    createRefundFinalizePin: async (input) => {
      finalizeInputs.push(input);
      return { pinId: 'refund-finalize-pin-id' };
    },
    resolveLocalMetabotGlobalMetaId: (metabotId) => (
      metabotId === 8 ? 'seller-global-metaid' : null
    ),
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}`);
    },
  });
  insertRefundPendingOrder(db, {
    id: 'buyer-order',
    role: 'buyer',
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'seller-global-metaid',
    coworkSessionId: 'buyer-session-id',
  });
  insertRefundPendingOrder(db, {
    id: 'seller-order',
    role: 'seller',
    localMetabotId: 8,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    coworkSessionId: 'seller-session-id',
  });

  assert.equal(typeof service.processSellerRefundForSession, 'function');
  const result = await service.processSellerRefundForSession('seller-session-id');

  assert.equal(result.refundTxid, 'b'.repeat(64));
  assert.equal(result.refundFinalizePinId, 'refund-finalize-pin-id');
  assert.equal(transferInputs.length, 1);
  assert.equal(transferInputs[0].refundToAddress, '1refund-address');
  assert.equal(transferInputs[0].refundAmount, '12.34');
  assert.equal(finalizeInputs.length, 1);
  assert.equal(finalizeInputs[0].payload.refundRequestPinId, 'refund-request-pin-id');
  assert.equal(finalizeInputs[0].payload.refundTxid, 'b'.repeat(64));
  assert.equal(store.getOrderById('buyer-order')?.status, 'refunded');
  assert.equal(store.getOrderById('seller-order')?.status, 'refunded');
  assert.equal(store.getOrderById('seller-order')?.refundTxid, 'b'.repeat(64));
  assert.deepEqual(seenEvents.sort(), ['refunded:buyer', 'refunded:seller']);
});

test('processSellerRefundForSession reuses a previously recorded refund txid instead of transferring twice when finalize proof must be retried', async () => {
  const transferInputs = [];
  const finalizeInputs = [];
  const { db, store, service } = await createRefundSettlementServiceForTest({
    fetchRefundRequestPin: async () => ({
      pinId: 'refund-request-pin-id',
      content: JSON.stringify({
        paymentTxid: 'a'.repeat(64),
        servicePinId: 'service-pin-id',
        serviceName: 'Weather Pro',
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        refundToAddress: '1refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }),
    executeRefundTransfer: async (input) => {
      transferInputs.push(input);
      return { txId: 'b'.repeat(64) };
    },
    createRefundFinalizePin: async (input) => {
      finalizeInputs.push(input);
      return { pinId: 'refund-finalize-pin-id' };
    },
    resolveLocalMetabotGlobalMetaId: (metabotId) => (
      metabotId === 8 ? 'seller-global-metaid' : null
    ),
  });
  insertRefundPendingOrder(db, {
    id: 'seller-order',
    role: 'seller',
    localMetabotId: 8,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    coworkSessionId: 'seller-session-id',
    refundTxid: 'c'.repeat(64),
  });

  const result = await service.processSellerRefundForSession('seller-session-id');

  assert.equal(result.refundTxid, 'c'.repeat(64));
  assert.equal(transferInputs.length, 0);
  assert.equal(finalizeInputs.length, 1);
  assert.equal(finalizeInputs[0].payload.refundTxid, 'c'.repeat(64));
  assert.equal(store.getOrderById('seller-order')?.status, 'refunded');
});

test('processSellerRefundForSession preserves BTC refund chain and currency semantics', async () => {
  const transferInputs = [];
  const { db, service } = await createRefundSettlementServiceForTest({
    fetchRefundRequestPin: async () => ({
      pinId: 'refund-request-pin-id',
      content: JSON.stringify({
        paymentTxid: 'f'.repeat(64),
        servicePinId: 'service-pin-id',
        serviceName: 'Weather Pro',
        refundAmount: '0.00120000',
        refundCurrency: 'BTC',
        refundToAddress: '1MFi1WM2NXnV3kjdLKaUw7Ad23LSvSD9fY',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }),
    executeRefundTransfer: async (input) => {
      transferInputs.push(input);
      return { txId: '1'.repeat(64) };
    },
    createRefundFinalizePin: async () => ({ pinId: 'refund-finalize-pin-id' }),
    resolveLocalMetabotGlobalMetaId: (metabotId) => (
      metabotId === 8 ? 'seller-global-metaid' : null
    ),
  });
  insertRefundPendingOrder(db, {
    id: 'seller-btc-order',
    role: 'seller',
    localMetabotId: 8,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    coworkSessionId: 'seller-session-id',
    paymentTxid: 'f'.repeat(64),
    paymentChain: 'btc',
    paymentCurrency: 'BTC',
    paymentAmount: '0.00120000',
  });

  await service.processSellerRefundForSession('seller-session-id');

  assert.equal(transferInputs.length, 1);
  assert.equal(transferInputs[0].order.paymentChain, 'btc');
  assert.equal(transferInputs[0].order.paymentCurrency, 'BTC');
  assert.equal(transferInputs[0].refundCurrency, 'BTC');
  assert.equal(transferInputs[0].refundAmount, '0.00120000');
});

test('processSellerRefundForSession preserves DOGE refund chain and currency semantics', async () => {
  const transferInputs = [];
  const { db, service } = await createRefundSettlementServiceForTest({
    fetchRefundRequestPin: async () => ({
      pinId: 'refund-request-pin-id',
      content: JSON.stringify({
        paymentTxid: 'e'.repeat(64),
        servicePinId: 'service-pin-id',
        serviceName: 'Weather Pro',
        refundAmount: '25.50000000',
        refundCurrency: 'DOGE',
        refundToAddress: 'DRPoYmHffwgmakvE4ua3UsLDuB4kEBYukq',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }),
    executeRefundTransfer: async (input) => {
      transferInputs.push(input);
      return { txId: '2'.repeat(64) };
    },
    createRefundFinalizePin: async () => ({ pinId: 'refund-finalize-pin-id' }),
    resolveLocalMetabotGlobalMetaId: (metabotId) => (
      metabotId === 8 ? 'seller-global-metaid' : null
    ),
  });
  insertRefundPendingOrder(db, {
    id: 'seller-doge-order',
    role: 'seller',
    localMetabotId: 8,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    coworkSessionId: 'seller-session-id',
    paymentTxid: 'e'.repeat(64),
    paymentChain: 'doge',
    paymentCurrency: 'DOGE',
    paymentAmount: '25.50000000',
  });

  await service.processSellerRefundForSession('seller-session-id');

  assert.equal(transferInputs.length, 1);
  assert.equal(transferInputs[0].order.paymentChain, 'doge');
  assert.equal(transferInputs[0].order.paymentCurrency, 'DOGE');
  assert.equal(transferInputs[0].refundCurrency, 'DOGE');
  assert.equal(transferInputs[0].refundAmount, '25.50000000');
});
