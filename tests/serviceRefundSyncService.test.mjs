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
    buildRefundVerificationInput: options.buildRefundVerificationInput,
    verifyTransferToRecipient: options.verifyTransferToRecipient,
    resolveRefundMrc20RecipientAddress: options.resolveRefundMrc20RecipientAddress,
    verifyMrc20Transfer: options.verifyMrc20Transfer,
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

test('syncRequestPins falls back to an existing seller order by payment txid when strict globalMetaId matching fails', async () => {
  const paymentTxid = 'f'.repeat(64);
  const seenEvents = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundRequestPins: async () => [{
      pinId: 'refund-request-existing-seller-fallback',
      timestampMs: 1_770_000_730_000,
      content: JSON.stringify({
        paymentTxid,
        servicePinId: 'service-forecast',
        serviceName: 'Forecast Service',
        refundAmount: '0.1',
        refundCurrency: 'SPACE',
        refundToAddress: 'buyer-refund-address',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid-legacy',
        orderMessagePinId: 'order-pin-id',
        failureReason: 'delivery_timeout',
        failureDetectedAt: 1_770_000_725,
      }),
    }],
    resolveLocalMetabotGlobalMetaId: (localMetabotId) => (
      localMetabotId === 31 ? 'seller-global-metaid-current' : null
    ),
    resolveLocalMetabotIdByGlobalMetaId: () => null,
    resolveLocalMetabotIdByServicePinId: () => null,
    onOrderEvent: (event) => {
      seenEvents.push(`${event.type}:${event.order.role}:${event.order.id}`);
    },
  });

  const sellerOrder = store.createOrder({
    role: 'seller',
    localMetabotId: 31,
    counterpartyGlobalMetaid: 'buyer-global-metaid',
    servicePinId: 'service-forecast',
    serviceName: 'Forecast Service',
    paymentTxid,
    paymentChain: 'mvc',
    paymentAmount: '0.1',
    paymentCurrency: 'SPACE',
    status: 'failed',
    now: 1_770_000_720_000,
  });
  store.markFailed(sellerOrder.id, 'llm_error', 1_770_000_721_000);

  await service.syncRequestPins();

  const updatedOrder = store.getOrderById(sellerOrder.id);
  assert.equal(updatedOrder.status, 'refund_pending');
  assert.equal(updatedOrder.refundRequestPinId, 'refund-request-existing-seller-fallback');
  assert.equal(updatedOrder.failureReason, 'llm_error');
  assert.equal(updatedOrder.refundRequestedAt, 1_770_000_730_000);
  assert.equal(seenEvents.length, 1);
  assert.equal(seenEvents[0], `refund_requested:seller:${sellerOrder.id}`);
});

test('syncFinalizePins routes explicit MRC20 refund finalize payloads to the dedicated MRC20 verifier and does not call the native verifier', async () => {
  const paymentTxid = 'a'.repeat(64);
  const refundRequestPinId = 'refund-request-pin-id-finalize';
  const refundFinalizePinId = 'refund-finalize-pin-id-mrc20';

  const mrc20VerifierCalls = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundFinalizePins: async () => [{
      pinId: refundFinalizePinId,
      content: JSON.stringify({
        refundRequestPinId,
        paymentTxid,
        servicePinId: 'service-mrc20',
        refundTxid: 'f'.repeat(64),
        refundAmount: '12.50000000',
        refundCurrency: 'METAID-MRC20',
        settlementKind: 'mrc20',
        mrc20Ticker: 'METAID',
        mrc20Id: 'payload-mrc20-id',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    resolveRefundMrc20RecipientAddress: () => '1buyer-btc-address',
    verifyTransferToRecipient: async () => {
      throw new Error('native verifier should not be called for MRC20 finalize');
    },
    verifyMrc20Transfer: async (input) => {
      mrc20VerifierCalls.push(input);
      return { valid: true, reason: 'ok' };
    },
  });

  const buyerOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'seller-global-metaid',
    servicePinId: 'service-mrc20',
    serviceName: 'Indexer Credits',
    paymentTxid,
    paymentChain: 'btc',
    paymentAmount: '12.50000000',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'ORDER',
    mrc20Id: 'order-mrc20-id',
    paymentCommitTxid: '7'.repeat(64),
    status: 'failed',
    now: 1_770_000_700_000,
  });
  store.markRefundPending(buyerOrder.id, refundRequestPinId, 1_770_000_710_000);

  const sellerOrder = store.createOrder({
    role: 'seller',
    localMetabotId: 2,
    counterpartyGlobalMetaid: 'buyer-global-metaid',
    servicePinId: 'service-mrc20',
    serviceName: 'Indexer Credits',
    paymentTxid,
    paymentChain: 'btc',
    paymentAmount: '12.50000000',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'ORDER',
    mrc20Id: 'order-mrc20-id',
    paymentCommitTxid: '7'.repeat(64),
    status: 'failed',
    now: 1_770_000_700_000,
  });
  store.markRefundPending(sellerOrder.id, refundRequestPinId, 1_770_000_710_000);

  await service.syncFinalizePins();

  assert.equal(mrc20VerifierCalls.length, 1);
  assert.deepEqual(mrc20VerifierCalls[0], {
    txid: 'f'.repeat(64),
    recipientAddress: '1buyer-btc-address',
    expectedAmountDisplay: '12.50000000',
    mrc20Id: 'payload-mrc20-id',
    mrc20Ticker: 'METAID',
  });

  const updatedBuyer = store.getOrderById(buyerOrder.id);
  const updatedSeller = store.getOrderById(sellerOrder.id);
  assert.equal(updatedBuyer.status, 'refunded');
  assert.equal(updatedSeller.status, 'refunded');
  assert.equal(updatedBuyer.refundFinalizePinId, refundFinalizePinId);
  assert.equal(updatedSeller.refundFinalizePinId, refundFinalizePinId);
});

test('syncFinalizePins falls back to local mrc20 settlement metadata when finalize payload is missing settlement fields', async () => {
  const paymentTxid = 'b'.repeat(64);
  const refundRequestPinId = 'refund-request-pin-id-fallback';
  const refundFinalizePinId = 'refund-finalize-pin-id-fallback';

  const mrc20VerifierCalls = [];
  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundFinalizePins: async () => [{
      pinId: refundFinalizePinId,
      content: JSON.stringify({
        refundRequestPinId,
        paymentTxid,
        servicePinId: 'service-mrc20',
        refundTxid: 'e'.repeat(64),
        refundAmount: '3.00000000',
        refundCurrency: 'SPACE',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    resolveRefundMrc20RecipientAddress: () => 'bc1qbuyer-btc-address',
    verifyTransferToRecipient: async () => {
      throw new Error('native verifier should not be called when local order is mrc20');
    },
    verifyMrc20Transfer: async (input) => {
      mrc20VerifierCalls.push(input);
      return { valid: true, reason: 'ok' };
    },
  });

  const buyerOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'seller-global-metaid',
    servicePinId: 'service-mrc20',
    serviceName: 'Indexer Credits',
    paymentTxid,
    paymentChain: 'btc',
    paymentAmount: '3.00000000',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'METAID',
    mrc20Id: 'order-mrc20-id-fallback',
    paymentCommitTxid: '8'.repeat(64),
    status: 'failed',
    now: 1_770_000_700_000,
  });
  store.markRefundPending(buyerOrder.id, refundRequestPinId, 1_770_000_710_000);

  await service.syncFinalizePins();

  assert.equal(mrc20VerifierCalls.length, 1);
  assert.deepEqual(mrc20VerifierCalls[0], {
    txid: 'e'.repeat(64),
    recipientAddress: 'bc1qbuyer-btc-address',
    expectedAmountDisplay: '3.00000000',
    mrc20Id: 'order-mrc20-id-fallback',
    mrc20Ticker: 'METAID',
  });

  const updatedBuyer = store.getOrderById(buyerOrder.id);
  assert.equal(updatedBuyer.status, 'refunded');
  assert.equal(updatedBuyer.refundFinalizePinId, refundFinalizePinId);
});

test('syncFinalizePins allows MRC20 refund finalize when verifier reports transient recipient state gap', async () => {
  const paymentTxid = '9'.repeat(64);
  const refundRequestPinId = 'refund-request-pin-id-state-gap';
  const refundFinalizePinId = 'refund-finalize-pin-id-state-gap';

  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundFinalizePins: async () => [{
      pinId: refundFinalizePinId,
      content: JSON.stringify({
        refundRequestPinId,
        paymentTxid,
        servicePinId: 'service-mrc20',
        refundTxid: '8'.repeat(64),
        refundAmount: '4.25000000',
        refundCurrency: 'METAID-MRC20',
        settlementKind: 'mrc20',
        mrc20Ticker: 'METAID',
        mrc20Id: 'order-mrc20-id-state-gap',
        buyerGlobalMetaId: 'buyer-global-metaid',
        sellerGlobalMetaId: 'seller-global-metaid',
      }),
    }],
    resolveRefundMrc20RecipientAddress: () => '1buyer-btc-address',
    verifyMrc20Transfer: async () => ({
      valid: false,
      reason: 'recipient_txid_not_observable',
      currency: 'METAID-MRC20',
      amountDisplay: '4.25000000',
      matchedAmountAtomic: '0',
      expectedAmountAtomic: '425000000',
    }),
  });

  const buyerOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'seller-global-metaid',
    servicePinId: 'service-mrc20',
    serviceName: 'Indexer Credits',
    paymentTxid,
    paymentChain: 'btc',
    paymentAmount: '4.25000000',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'METAID',
    mrc20Id: 'order-mrc20-id-state-gap',
    status: 'failed',
    now: 1_770_000_700_000,
  });
  store.markRefundPending(buyerOrder.id, refundRequestPinId, 1_770_000_710_000);

  await service.syncFinalizePins();

  const updatedBuyer = store.getOrderById(buyerOrder.id);
  assert.equal(updatedBuyer.status, 'refunded');
  assert.equal(updatedBuyer.refundFinalizePinId, refundFinalizePinId);
});

test('syncFinalizePins rejects deterministic MRC20 refund verifier failures', async () => {
  const paymentTxid = '6'.repeat(64);
  const refundRequestPinId = 'refund-request-pin-id-deterministic-failure';

  const { store, service } = await createRefundSyncServiceForTest({
    fetchRefundFinalizePins: async () => [{
      pinId: 'refund-finalize-pin-id-deterministic-failure',
      content: JSON.stringify({
        refundRequestPinId,
        paymentTxid,
        servicePinId: 'service-mrc20',
        refundTxid: '5'.repeat(64),
        refundAmount: '4.25000000',
        refundCurrency: 'METAID-MRC20',
        settlementKind: 'mrc20',
        mrc20Ticker: 'METAID',
        mrc20Id: 'order-mrc20-id-deterministic-failure',
      }),
    }],
    resolveRefundMrc20RecipientAddress: () => '1buyer-btc-address',
    verifyMrc20Transfer: async () => ({
      valid: false,
      reason: 'ticker_mismatch:WRONG:METAID',
    }),
  });

  const buyerOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'seller-global-metaid',
    servicePinId: 'service-mrc20',
    serviceName: 'Indexer Credits',
    paymentTxid,
    paymentChain: 'btc',
    paymentAmount: '4.25000000',
    paymentCurrency: 'METAID-MRC20',
    settlementKind: 'mrc20',
    mrc20Ticker: 'METAID',
    mrc20Id: 'order-mrc20-id-deterministic-failure',
    status: 'failed',
    now: 1_770_000_700_000,
  });
  store.markRefundPending(buyerOrder.id, refundRequestPinId, 1_770_000_710_000);

  await service.syncFinalizePins();

  const updatedBuyer = store.getOrderById(buyerOrder.id);
  assert.equal(updatedBuyer.status, 'refund_pending');
  assert.equal(updatedBuyer.refundFinalizePinId, null);
});
