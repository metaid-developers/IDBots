import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const { ServiceOrderStore } = require('../dist-electron/serviceOrderStore.js');

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
