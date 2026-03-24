import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');
const { ServiceOrderLifecycleService } = require('../dist-electron/services/serviceOrderLifecycleService.js');

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
