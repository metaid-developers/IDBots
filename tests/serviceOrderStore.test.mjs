import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const Module = require('node:module');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');
const { DB_FILENAME } = require('../dist-electron/appConstants.js');

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

function createCoworkTables(db) {
  db.run(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      cwd TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE cowork_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

async function createServiceOrderStoreForTest() {
  const db = await createSqlDatabase();
  createCoworkTables(db);
  const now = Date.now();
  db.run(
    'INSERT INTO cowork_sessions (id, title, cwd, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['session-1', 'Original Session', '/tmp', now, now]
  );
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ['msg-1', 'session-1', 'user', 'hello cowork', now]
  );
  const store = new ServiceOrderStore(db, () => {});
  return { db, store };
}

test('store creates and reloads buyer orders without mutating existing cowork data', async () => {
  const { db, store } = await createServiceOrderStoreForTest();
  const beforeSessionCount = db.exec('SELECT COUNT(*) AS count FROM cowork_sessions')[0].values[0][0];
  const beforeMessageRow = db.exec('SELECT content FROM cowork_messages WHERE id = ?', ['msg-1'])[0].values[0][0];

  const order = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: 'a'.repeat(64),
    paymentAmount: '1.23',
  });

  assert.equal(store.getOrderById(order.id)?.paymentTxid, 'a'.repeat(64));

  const reloadedStore = new ServiceOrderStore(db, () => {});
  const reloaded = reloadedStore.getOrderById(order.id);
  assert.equal(reloaded?.id, order.id);
  assert.equal(reloaded?.paymentTxid, order.paymentTxid);
  assert.equal(reloaded?.role, 'buyer');

  const afterSessionCount = db.exec('SELECT COUNT(*) AS count FROM cowork_sessions')[0].values[0][0];
  const afterMessageRow = db.exec('SELECT content FROM cowork_messages WHERE id = ?', ['msg-1'])[0].values[0][0];
  assert.equal(afterSessionCount, beforeSessionCount);
  assert.equal(afterMessageRow, beforeMessageRow);
});

test('store createOrder defaults to SLA deadlines based on current time', async () => {
  const { store } = await createServiceOrderStoreForTest();
  const now = Date.now();
  const order = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: 'b'.repeat(64),
    paymentAmount: '9.99',
    now,
  });

  assert.equal(order.firstResponseDeadlineAt, now + 5 * 60_000);
  assert.equal(order.deliveryDeadlineAt, now + 15 * 60_000);
});

test('store createOrder is idempotent for localMetabotId + role + paymentTxid', async () => {
  const { db, store } = await createServiceOrderStoreForTest();
  const baseInput = {
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: 'c'.repeat(64),
    paymentAmount: '2.34',
  };

  const first = store.createOrder(baseInput);
  const second = store.createOrder(baseInput);

  assert.equal(second.id, first.id);
  const rowCount = db.exec(
    'SELECT COUNT(*) FROM service_orders WHERE local_metabot_id = ? AND role = ? AND payment_txid = ?',
    [1, 'buyer', 'c'.repeat(64)]
  )[0].values[0][0];
  assert.equal(rowCount, 1);
});

test('store bootstrap remediates legacy duplicate payment rows before creating unique dedupe index', async () => {
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

  const txid = '9'.repeat(64);
  const base = [
    7,
    'buyer',
    'counterparty-global-metaid',
    'service-name',
    txid,
    'mvc',
    '1.00',
    'SPACE',
    'awaiting_first_response',
    1000,
    2000,
  ];

  db.run(
    `INSERT INTO service_orders (
      id, local_metabot_id, role, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['dup-old', ...base, 100, 100]
  );
  db.run(
    `INSERT INTO service_orders (
      id, local_metabot_id, role, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['dup-keep', ...base, 200, 300]
  );

  const store = new ServiceOrderStore(db, () => {});
  void store;

  const rows = db.exec(
    'SELECT id FROM service_orders WHERE local_metabot_id = ? AND role = ? AND payment_txid = ? ORDER BY id ASC',
    [7, 'buyer', txid]
  )[0].values;
  assert.deepEqual(rows, [['dup-keep']]);

  const uniqueIndexRows = db.exec(
    "SELECT name FROM pragma_index_list('service_orders') WHERE name = 'idx_service_orders_dedupe_payment' AND \"unique\" = 1"
  );
  assert.equal(uniqueIndexRows[0]?.values?.length ?? 0, 1);
});

test('SqliteStore.create() remediates legacy duplicate payment rows and enforces unique dedupe index on startup', async () => {
  const legacyDb = await createSqlDatabase();
  legacyDb.run(`
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

  const txid = '8'.repeat(64);
  legacyDb.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-old', 'buyer', 9, 'counterparty-global-metaid', 'service-name', txid, 'mvc', '1.00', 'SPACE', 'awaiting_first_response', 1000, 2000, 100, 100]
  );
  legacyDb.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-keep', 'buyer', 9, 'counterparty-global-metaid', 'service-name', txid, 'mvc', '1.00', 'SPACE', 'awaiting_first_response', 1000, 2000, 200, 300]
  );

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlitestore-service-orders-'));
  const dbPath = path.join(userDataPath, DB_FILENAME);
  fs.writeFileSync(dbPath, Buffer.from(legacyDb.export()));

  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => projectRoot,
          getPath: (name) => {
            if (name === 'userData') return userDataPath;
            return userDataPath;
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();
    const rows = db.exec(
      'SELECT id FROM service_orders WHERE local_metabot_id = ? AND role = ? AND payment_txid = ? ORDER BY id ASC',
      [9, 'buyer', txid]
    )[0].values;
    assert.deepEqual(rows, [['legacy-keep']]);

    const uniqueIndexRows = db.exec(
      "SELECT name FROM pragma_index_list('service_orders') WHERE name = 'idx_service_orders_dedupe_payment' AND \"unique\" = 1"
    );
    assert.equal(uniqueIndexRows[0]?.values?.length ?? 0, 1);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('SqliteStore.create() remediates legacy MVC currency alias to SPACE for mvc chain', async () => {
  const legacyDb = await createSqlDatabase();
  legacyDb.run(`
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

  legacyDb.run(
    `INSERT INTO service_orders (
      id, role, local_metabot_id, counterparty_global_metaid, service_name,
      payment_txid, payment_chain, payment_amount, payment_currency, status,
      first_response_deadline_at, delivery_deadline_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['legacy-mvc-currency', 'buyer', 10, 'counterparty-global-metaid', 'service-name', '7'.repeat(64), 'mvc', '1.00', 'MVC', 'awaiting_first_response', 1000, 2000, 100, 100]
  );

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlitestore-service-orders-'));
  const dbPath = path.join(userDataPath, DB_FILENAME);
  fs.writeFileSync(dbPath, Buffer.from(legacyDb.export()));

  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => projectRoot,
          getPath: (name) => {
            if (name === 'userData') return userDataPath;
            return userDataPath;
          },
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };

  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();
    const rows = db.exec(
      'SELECT payment_chain, payment_currency FROM service_orders WHERE id = ?',
      ['legacy-mvc-currency']
    )[0].values;
    assert.deepEqual(rows, [['mvc', 'SPACE']]);
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('service_orders schema rejects invalid role values', async () => {
  const { db, store } = await createServiceOrderStoreForTest();
  const now = Date.now();
  const deadlines = {
    first: now + 5 * 60_000,
    second: now + 15 * 60_000,
  };

  assert.throws(() => {
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'invalid-role-order',
      'provider',
      1,
      'counterparty-global-metaid',
      'service-name',
      'd'.repeat(64),
      'mvc',
      '1.00',
      'MVC',
      'awaiting_first_response',
      deadlines.first,
      deadlines.second,
      now,
      now,
    ]);
  });

  void store;
});

test('service_orders schema rejects invalid status values', async () => {
  const { db } = await createServiceOrderStoreForTest();
  const now = Date.now();
  const deadlines = {
    first: now + 5 * 60_000,
    second: now + 15 * 60_000,
  };

  assert.throws(() => {
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'invalid-status-order',
      'buyer',
      1,
      'counterparty-global-metaid',
      'service-name',
      'e'.repeat(64),
      'mvc',
      '1.00',
      'MVC',
      'delivered',
      deadlines.first,
      deadlines.second,
      now,
      now,
    ]);
  });
});

test('service_orders schema rejects invalid payment_chain values', async () => {
  const { db } = await createServiceOrderStoreForTest();
  const now = Date.now();
  const deadlines = {
    first: now + 5 * 60_000,
    second: now + 15 * 60_000,
  };

  assert.throws(() => {
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'invalid-chain-order',
      'buyer',
      1,
      'counterparty-global-metaid',
      'service-name',
      '3'.repeat(64),
      'eth',
      '1.00',
      'SPACE',
      'awaiting_first_response',
      deadlines.first,
      deadlines.second,
      now,
      now,
    ]);
  });
});

test('service_orders schema rejects invalid payment_currency values', async () => {
  const { db } = await createServiceOrderStoreForTest();
  const now = Date.now();
  const deadlines = {
    first: now + 5 * 60_000,
    second: now + 15 * 60_000,
  };

  assert.throws(() => {
    db.run(`
      INSERT INTO service_orders (
        id, role, local_metabot_id, counterparty_global_metaid, service_name,
        payment_txid, payment_chain, payment_amount, payment_currency, status,
        first_response_deadline_at, delivery_deadline_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      'invalid-currency-order',
      'buyer',
      1,
      'counterparty-global-metaid',
      'service-name',
      '4'.repeat(64),
      'mvc',
      '1.00',
      'USD',
      'awaiting_first_response',
      deadlines.first,
      deadlines.second,
      now,
      now,
    ]);
  });
});

test('store createOrder derives default paymentCurrency from paymentChain semantics', async () => {
  const { store } = await createServiceOrderStoreForTest();

  const mvcOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: 'f'.repeat(64),
    paymentAmount: '1.00',
    paymentChain: 'mvc',
  });
  const btcOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: '1'.repeat(64),
    paymentAmount: '1.00',
    paymentChain: 'btc',
  });
  const dogeOrder = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: '2'.repeat(64),
    paymentAmount: '1.00',
    paymentChain: 'doge',
  });

  assert.equal(mvcOrder.paymentCurrency, 'SPACE');
  assert.equal(btcOrder.paymentCurrency, 'BTC');
  assert.equal(dogeOrder.paymentCurrency, 'DOGE');
});

test('store createOrder does not persist arbitrary invalid chain/currency input', async () => {
  const { store } = await createServiceOrderStoreForTest();
  const order = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: '5'.repeat(64),
    paymentAmount: '1.00',
    paymentChain: 'evm',
    paymentCurrency: 'USDT',
  });

  assert.equal(order.paymentChain, 'mvc');
  assert.equal(order.paymentCurrency, 'SPACE');
});

test('store createOrder normalizes legacy MVC alias to SPACE for mvc chain', async () => {
  const { store } = await createServiceOrderStoreForTest();
  const order = store.createOrder({
    role: 'buyer',
    localMetabotId: 1,
    counterpartyGlobalMetaid: 'counterparty-global-metaid',
    serviceName: 'service-name',
    paymentTxid: '6'.repeat(64),
    paymentAmount: '1.00',
    paymentChain: 'mvc',
    paymentCurrency: 'MVC',
  });

  assert.equal(order.paymentChain, 'mvc');
  assert.equal(order.paymentCurrency, 'SPACE');
});
