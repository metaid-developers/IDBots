import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { ServiceOrderStore } = require('../dist-electron/main/serviceOrderStore.js');

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows handle tolerance
  }
}

test('ServiceOrderStore.getOrderSessionLookup caches by revision and indexes latest bound orders', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-lookup-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const save = sqliteStore.getSaveFunction();
    const orderStore = new ServiceOrderStore(db, save);

    const emptyLookup = orderStore.getOrderSessionLookup();
    assert.equal(emptyLookup.totalOrders, 0);
    assert.equal(emptyLookup.latestBySessionId.size, 0);
    assert.strictEqual(orderStore.getOrderSessionLookup(), emptyLookup);

    const created = orderStore.createOrder({
      role: 'buyer',
      localMetabotId: 1,
      counterpartyGlobalMetaid: 'idq1peer000000000000000000000000000000000000',
      servicePinId: 'a'.repeat(64) + 'i0',
      orderPinId: 'b'.repeat(64) + 'i0',
      serviceName: 'Code Audit',
      paymentTxid: 'c'.repeat(64),
      paymentChain: 'mvc',
      paymentAmount: '0.01',
      paymentCurrency: 'SPACE',
      coworkSessionId: 'session-a2a-1',
      now: 1_700_000_000_000,
    });

    const nextLookup = orderStore.getOrderSessionLookup();
    assert.notStrictEqual(nextLookup, emptyLookup);
    assert.equal(nextLookup.totalOrders, 1);
    assert.equal(nextLookup.latestBySessionId.get('session-a2a-1')?.id, created.id);
    assert.equal(nextLookup.ordersByLocalMetabotId.get(1)?.length, 1);
    assert.equal(orderStore.findLatestOrderBySessionId('session-a2a-1')?.id, created.id);
    assert.equal(orderStore.getSessionSummary('session-a2a-1')?.serviceName, 'Code Audit');

    orderStore.markDelivered(created.id, {
      deliveryMessagePinId: 'd'.repeat(64) + 'i0',
      deliveredAt: 1_700_000_005_000,
    });
    assert.equal(orderStore.getSessionSummary('session-a2a-1')?.status, 'rating_pending');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('CoworkStore targeted order-message queries return only order headers and linkage rows without scanning unrelated messages', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-order-msgs-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const save = sqliteStore.getSaveFunction();
    const coworkStore = new CoworkStore(db, save);

    const session = coworkStore.createSession(
      'A2A Order Session',
      '/tmp',
      '',
      'local',
      [],
      null,
      'a2a',
      'idq1peer000000000000000000000000000000000000',
      'Peer Bot',
    );

    for (let index = 0; index < 40; index += 1) {
      coworkStore.addMessage(session.id, {
        type: index % 2 === 0 ? 'user' : 'assistant',
        content: `ordinary chat turn #${index} with plenty of prose`,
      });
    }
    const orderTxid = 'e'.repeat(64);
    coworkStore.addMessage(session.id, {
      type: 'user',
      content: `[ORDER]\nservice_name: Translation\noutput_type: markdown\ntxid: ${orderTxid}`,
      metadata: { orderTxid },
    });

    const headerMessages = coworkStore.getSessionOrderHeaderMessages(session.id);
    assert.equal(headerMessages.length, 1);
    assert.match(headerMessages[0].content, /^\[ORDER\]/);

    const linkageMessages = coworkStore.getSessionOrderLinkageMessages(session.id);
    assert.equal(linkageMessages.length, 1);
    assert.equal(linkageMessages[0].metadata?.orderTxid, orderTxid);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('cowork:session:list uses batch enrichment and avoids unconditional getSession loads', () => {
  const mainSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src/main/main.ts'),
    'utf8',
  ).replace(/\r\n/g, '\n');

  assert.match(
    mainSource,
    /enrichCoworkSessionsWithServiceOrderSummaries\(\s*getCoworkStore\(\)\.listSessions\(/,
  );
  const summaryFnStart = mainSource.indexOf('const getServiceOrderSummaryForSession =');
  const summaryFnEnd = mainSource.indexOf('const getScheduler =', summaryFnStart);
  assert.ok(summaryFnStart > 0 && summaryFnEnd > summaryFnStart);
  const summaryFnBody = mainSource.slice(summaryFnStart, summaryFnEnd);
  assert.doesNotMatch(summaryFnBody, /getCoworkStore\(\)\.getSession\(/);
});
