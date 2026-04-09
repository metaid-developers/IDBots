import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

let ServiceRefundSyncService;
try {
  ({ ServiceRefundSyncService } = require('../dist-electron/services/serviceRefundSyncService.js'));
} catch {
  ServiceRefundSyncService = undefined;
}

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function findNearestNodeModules(startDir = projectRoot) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, 'node_modules');
    try {
      if (require('node:fs').existsSync(candidate)) {
        return candidate;
      }
    } catch {
      // Ignore and continue walking upward.
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate node_modules from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

const sqlWasmPath = path.join(findNearestNodeModules(projectRoot), 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

async function createRefundSyncServiceForTest(options = {}) {
  assert.equal(typeof ServiceRefundSyncService, 'function');
  const db = await createSqlDatabase();
  const store = new ServiceOrderStore(db, () => {});
  const service = new ServiceRefundSyncService(store, {
    now: options.now || (() => 1_770_000_789_000),
    fetchRefundRequestPins: options.fetchRefundRequestPins,
    fetchRefundFinalizePins: options.fetchRefundFinalizePins,
    resolveLocalMetabotGlobalMetaId: options.resolveLocalMetabotGlobalMetaId,
    resolveLocalMetabotIdByGlobalMetaId: options.resolveLocalMetabotIdByGlobalMetaId,
    resolveLocalMetabotIdByServicePinId: options.resolveLocalMetabotIdByServicePinId,
    onOrderEvent: options.onOrderEvent,
  });
  return { db, store, service };
}

test('syncRequestPins synthesizes a seller refund_pending order when the refund targets a local seller without ledger state', async () => {
  const seenEvents = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundRequestPins: async () => [{
      pinId: 'refund-request-pin-id',
      timestampMs: 1_770_000_700_000,
      content: JSON.stringify({
        paymentTxid: 'd'.repeat(64),
        servicePinId: 'service-weather',
        serviceName: 'Weather Pro',
        refundAmount: '12.34',
        refundCurrency: 'SPACE',
        refundToAddress: 'buyer-refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
        orderMessagePinId: 'order-pin-id',
        failureReason: 'delivery_timeout',
        failureDetectedAt: 1_770_000_650,
      }),
    }],
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 8 ? 'seller-global-metaid' : null
    ),
    resolveLocalMetabotIdByGlobalMetaId: (globalMetaId) => (
      globalMetaId === 'seller-global-metaid' ? 8 : null
    ),
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}`);
    },
  });

  await service.syncRequestPins();

  const sellerOrders = store.listOrdersByRole('seller');
  assert.equal(sellerOrders.length, 1);

  const order = sellerOrders[0];
  assert.equal(order.localMetabotId, 8);
  assert.equal(order.counterpartyGlobalMetaid, 'buyer-global-metaid');
  assert.equal(order.servicePinId, 'service-weather');
  assert.equal(order.serviceName, 'Weather Pro');
  assert.equal(order.paymentTxid, 'd'.repeat(64));
  assert.equal(order.status, 'refund_pending');
  assert.equal(order.orderMessagePinId, 'order-pin-id');
  assert.equal(order.refundRequestPinId, 'refund-request-pin-id');
  assert.equal(order.failureReason, 'delivery_timeout');
  assert.equal(order.failedAt, 1_770_000_650_000);
  assert.equal(order.refundRequestedAt, 1_770_000_700_000);
  assert.deepEqual(seenEvents, ['refund_requested:seller']);

  await service.syncRequestPins();
  assert.equal(store.listOrdersByRole('seller').length, 1);
});

test('syncRequestPins falls back to service pin ownership when seller global meta id cannot be resolved locally', async () => {
  const seenEvents = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundRequestPins: async () => [{
      pinId: 'refund-request-pin-fallback',
      timestampMs: 1_770_000_710_000,
      content: JSON.stringify({
        paymentTxid: 'e'.repeat(64),
        servicePinId: 'service-owned-locally',
        serviceName: 'Daily Headlines',
        refundAmount: '0.00001',
        refundCurrency: 'SPACE',
        refundToAddress: 'buyer-refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid-missing',
        orderMessagePinId: 'order-pin-id',
        failureReason: 'delivery_timeout',
        failureDetectedAt: 1_770_000_701,
      }),
    }],
    resolveLocalMetabotIdByGlobalMetaId: () => null,
    resolveLocalMetabotIdByServicePinId: (servicePinId) => (
      servicePinId === 'service-owned-locally' ? 15 : null
    ),
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 15 ? 'seller-global-metaid-actual' : null
    ),
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}`);
    },
  });

  await service.syncRequestPins();

  const sellerOrders = store.listOrdersByRole('seller');
  assert.equal(sellerOrders.length, 1);
  const order = sellerOrders[0];
  assert.equal(order.localMetabotId, 15);
  assert.equal(order.counterpartyGlobalMetaid, 'buyer-global-metaid');
  assert.equal(order.servicePinId, 'service-owned-locally');
  assert.equal(order.status, 'refund_pending');
  assert.equal(order.refundRequestPinId, 'refund-request-pin-fallback');
  assert.equal(order.failureReason, 'delivery_timeout');
  assert.deepEqual(seenEvents, ['refund_requested:seller']);
});

test('syncRequestPins synthesizes seller MRC20 refund orders with structured settlement metadata', async () => {
  const seenEvents = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundRequestPins: async () => [{
      pinId: 'refund-request-mrc20-pin-id',
      timestampMs: 1_770_000_720_000,
      content: JSON.stringify({
        paymentTxid: 'c'.repeat(64),
        servicePinId: 'service-mrc20',
        serviceName: 'Indexer Credits',
        refundAmount: '12.50000000',
        refundCurrency: 'metaid-mrc20',
        settlementKind: 'mrc20',
        mrc20Ticker: 'metaid',
        mrc20Id: 'mrc20-token-id-009',
        paymentCommitTxid: '7'.repeat(64),
        refundToAddress: '1buyer-refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
        orderMessagePinId: 'mrc20-order-pin-id',
        failureReason: 'delivery_timeout',
        failureDetectedAt: 1_770_000_715,
      }),
    }],
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 21 ? 'seller-global-metaid' : null
    ),
    resolveLocalMetabotIdByGlobalMetaId: (globalMetaId) => (
      globalMetaId === 'seller-global-metaid' ? 21 : null
    ),
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}`);
    },
  });

  await service.syncRequestPins();

  const sellerOrders = store.listOrdersByRole('seller');
  assert.equal(sellerOrders.length, 1);

  const order = sellerOrders[0];
  assert.equal(order.localMetabotId, 21);
  assert.equal(order.counterpartyGlobalMetaid, 'buyer-global-metaid');
  assert.equal(order.paymentTxid, 'c'.repeat(64));
  assert.equal(order.paymentChain, 'btc');
  assert.equal(order.paymentAmount, '12.50000000');
  assert.equal(order.paymentCurrency, 'METAID-MRC20');
  assert.equal(order.settlementKind, 'mrc20');
  assert.equal(order.mrc20Ticker, 'METAID');
  assert.equal(order.mrc20Id, 'mrc20-token-id-009');
  assert.equal(order.paymentCommitTxid, '7'.repeat(64));
  assert.equal(order.status, 'refund_pending');
  assert.equal(order.orderMessagePinId, 'mrc20-order-pin-id');
  assert.equal(order.refundRequestPinId, 'refund-request-mrc20-pin-id');
  assert.equal(order.failureReason, 'delivery_timeout');
  assert.equal(order.failedAt, 1_770_000_715_000);
  assert.equal(order.refundRequestedAt, 1_770_000_720_000);
  assert.deepEqual(seenEvents, ['refund_requested:seller']);
});
