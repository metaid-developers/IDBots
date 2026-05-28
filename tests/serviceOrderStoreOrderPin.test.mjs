import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

const sqlWasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

async function createServiceOrderStoreForTest() {
  const db = await createSqlDatabase();
  const store = new ServiceOrderStore(db, () => {});
  return { db, store };
}

const baseOrderInput = (overrides = {}) => ({
  role: 'buyer',
  localMetabotId: 11,
  counterpartyGlobalMetaid: 'counterparty-global-metaid',
  serviceName: 'service-name',
  paymentAmount: '0',
  paymentCurrency: 'SPACE',
  ...overrides,
});

test('free orders dedupe by order pin id while preserving empty payment txids', async () => {
  const { db, store } = await createServiceOrderStoreForTest();

  const first = store.createOrder(baseOrderInput({
    paymentTxid: '',
    orderPinId: 'order-pin-i0',
  }));
  const duplicate = store.createOrder(baseOrderInput({
    paymentTxid: '',
    orderPinId: 'order-pin-i0',
    serviceName: 'updated-service-name',
  }));
  const secondFree = store.createOrder(baseOrderInput({
    paymentTxid: '',
    orderPinId: 'order-pin-i1',
    serviceName: 'second-free-service',
  }));

  assert.equal(first.paymentTxid, '');
  assert.equal(first.orderPinId, 'order-pin-i0');
  assert.equal(duplicate.id, first.id);
  assert.notEqual(secondFree.id, first.id);
  assert.equal(secondFree.paymentTxid, '');
  assert.equal(secondFree.orderPinId, 'order-pin-i1');

  const rows = db.exec(
    `SELECT id, payment_txid, order_pin_id
     FROM service_orders
     WHERE local_metabot_id = ? AND role = ?
     ORDER BY created_at ASC, id ASC`,
    [11, 'buyer']
  )[0].values;
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row[1]), ['', '']);
  assert.deepEqual(store.listOrdersByPaymentTxid(''), []);
});

test('legacy paid rows still dedupe and lookup by non-empty payment txid', async () => {
  const { store } = await createServiceOrderStoreForTest();
  const paymentTxid = 'a'.repeat(64);
  const first = store.createOrder(baseOrderInput({
    paymentAmount: '1.25',
    paymentTxid,
  }));
  const duplicate = store.createOrder(baseOrderInput({
    paymentAmount: '1.25',
    paymentTxid,
    serviceName: 'duplicate-paid-service',
  }));

  assert.equal(duplicate.id, first.id);
  assert.equal(store.findOrderByPayment({
    role: 'buyer',
    localMetabotId: 11,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    paymentTxid,
  })?.id, first.id);
  assert.equal(store.findOrderByPayment({
    role: 'buyer',
    localMetabotId: 11,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    paymentTxid: '',
  }), null);
  assert.deepEqual(store.listOrdersByPaymentTxid(paymentTxid).map((order) => order.id), [first.id]);
});

test('find and list orders by order pin id', async () => {
  const { store } = await createServiceOrderStoreForTest();
  const buyer = store.createOrder(baseOrderInput({
    role: 'buyer',
    localMetabotId: 12,
    paymentTxid: '',
    orderPinId: 'order-pin-shared',
  }));
  const seller = store.createOrder(baseOrderInput({
    role: 'seller',
    localMetabotId: 13,
    counterpartyGlobalMetaid: 'buyer-global-metaid',
    paymentTxid: '',
    orderPinId: 'order-pin-shared',
  }));

  assert.equal(store.findOrderByOrderPinId({
    role: 'buyer',
    localMetabotId: 12,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    orderPinId: 'order-pin-shared',
  })?.id, buyer.id);
  assert.equal(store.findOrderByOrderPinId({
    role: 'buyer',
    localMetabotId: 12,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    orderPinId: '',
  }), null);
  assert.deepEqual(
    store.listOrdersByOrderPinId('order-pin-shared').map((order) => order.id).sort(),
    [buyer.id, seller.id].sort()
  );
});

test('duplicate remediation does not collapse legacy free rows with empty payment txids', async () => {
  const db = await createSqlDatabase();
  db.run(`
    CREATE TABLE service_orders (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      local_metabot_id INTEGER NOT NULL,
      counterparty_global_metaid TEXT NOT NULL,
      service_pin_id TEXT,
      service_name TEXT NOT NULL,
      payment_txid TEXT NOT NULL,
      payment_chain TEXT NOT NULL,
      payment_amount TEXT NOT NULL,
      payment_currency TEXT NOT NULL,
      order_message_pin_id TEXT,
      cowork_session_id TEXT,
      status TEXT NOT NULL,
      first_response_deadline_at INTEGER NOT NULL,
      delivery_deadline_at INTEGER NOT NULL,
      first_response_at INTEGER,
      delivery_message_pin_id TEXT,
      delivered_at INTEGER,
      failed_at INTEGER,
      failure_reason TEXT,
      refund_request_pin_id TEXT,
      refund_finalize_pin_id TEXT,
      refund_txid TEXT,
      refund_requested_at INTEGER,
      refund_completed_at INTEGER,
      refund_apply_retry_count INTEGER NOT NULL DEFAULT 0,
      next_retry_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const insertLegacyFree = (id, orderPinId, createdAt) => {
    db.run(
      `INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        'buyer',
        21,
        'counterparty-global-metaid',
        orderPinId,
        '',
        'mvc',
        '0',
        'SPACE',
        'awaiting_first_response',
        1000,
        2000,
        createdAt,
        createdAt,
      ]
    );
  };
  insertLegacyFree('legacy-free-1', 'order-pin-legacy-1', 100);
  insertLegacyFree('legacy-free-2', 'order-pin-legacy-2', 200);

  const store = new ServiceOrderStore(db, () => {});
  void store;

  const rows = db.exec(
    `SELECT id, payment_txid, order_pin_id
     FROM service_orders
     WHERE local_metabot_id = ? AND role = ?
     ORDER BY id ASC`,
    [21, 'buyer']
  )[0].values;
  assert.deepEqual(rows, [
    ['legacy-free-1', '', null],
    ['legacy-free-2', '', null],
  ]);
});
