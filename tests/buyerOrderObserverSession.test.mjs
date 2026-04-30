import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const {
  buildBuyerOrderObserverConversationId,
  ensureBuyerOrderObserverSession,
} = await import('../dist-electron/services/buyerOrderObserverSession.js');

test('buildBuyerOrderObserverConversationId scopes observer sessions by buyer, seller, and txid', () => {
  const conversationId = buildBuyerOrderObserverConversationId({
    metabotId: 12,
    peerGlobalMetaId: 'seller-global-metaid',
    paymentTxid: 'a'.repeat(64),
  });

  assert.equal(
    conversationId,
    `metaweb_order:buyer:12:seller-global-metaid:${'a'.repeat(16)}`
  );
});

test('buildBuyerOrderObserverConversationId prefers order simplemsg txid over payment txid', () => {
  const orderTxid = 'f'.repeat(64);
  const conversationId = buildBuyerOrderObserverConversationId({
    metabotId: 12,
    peerGlobalMetaId: 'seller-global-metaid',
    paymentTxid: 'a'.repeat(64),
    orderTxid,
  });

  assert.equal(
    conversationId,
    `metaweb_order:buyer:12:seller-global-metaid:${orderTxid.slice(0, 16)}`
  );
});

test('ensureBuyerOrderObserverSession keeps payment txid separate from missing message txid', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);

    const created = await ensureBuyerOrderObserverSession(store, {
      metabotId: 7,
      peerGlobalMetaId: 'seller-global-metaid',
      peerName: 'Seller Bot',
      peerAvatar: 'avatar-data',
      serviceId: 'service-weather',
      servicePrice: '0.0001',
      serviceCurrency: 'SPACE',
      serviceSkill: 'weather',
      serverBotGlobalMetaId: 'seller-global-metaid',
      servicePaidTx: 'b'.repeat(64),
      orderPayload: '[ORDER] 查询北京天气\n支付金额 0.0001 SPACE\ntxid: ' + 'b'.repeat(64),
    });

    assert.equal(created.created, true);
    assert.equal(created.externalConversationId, `metaweb_order:buyer:7:seller-global-metaid:${'b'.repeat(16)}`);

    const mapping = store.getConversationMapping('metaweb_order', created.externalConversationId, 7);
    assert.ok(mapping);
    const metadata = JSON.parse(mapping.metadataJson || '{}');
    assert.equal(metadata.serviceId, 'service-weather');
    assert.equal(metadata.serviceSkill, 'weather');
    assert.equal(metadata.servicePaidTx, 'b'.repeat(64));

    const session = store.getSession(created.coworkSessionId);
    assert.ok(session);
    assert.equal(session?.sessionType, 'a2a');
    assert.equal(session?.peerGlobalMetaId, 'seller-global-metaid');
    assert.equal(session?.peerName, 'Seller Bot');

    const firstMessage = session?.messages?.[0] ?? null;
    assert.ok(firstMessage);
    assert.equal(firstMessage?.type, 'user');
    assert.equal(firstMessage?.metadata?.direction, 'outgoing');
    assert.equal(firstMessage?.metadata?.txid, undefined);
    assert.equal(firstMessage?.metadata?.paymentTxid, 'b'.repeat(64));
    assert.match(firstMessage?.content || '', /^\[ORDER\]/);
  } finally {
    sqlite.cleanup();
  }
});

test('ensureBuyerOrderObserverSession writes order simplemsg metadata when it is already known', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const paymentTxid = 'd'.repeat(64);
    const orderTxid = 'e'.repeat(64);

    const created = await ensureBuyerOrderObserverSession(store, {
      metabotId: 7,
      peerGlobalMetaId: 'seller-global-metaid',
      servicePaidTx: paymentTxid,
      orderPayload: `[ORDER] 查询北京天气\n支付金额 0.0001 SPACE\ntxid: ${paymentTxid}`,
      orderMessagePinId: `${orderTxid}i0`,
      orderMessageTxids: [orderTxid],
    });

    const session = store.getSession(created.coworkSessionId);
    const firstMessage = session?.messages?.[0] ?? null;
    assert.ok(firstMessage);
    assert.equal(firstMessage?.metadata?.txid, orderTxid);
    assert.deepEqual(firstMessage?.metadata?.txids, [orderTxid]);
    assert.equal(firstMessage?.metadata?.pinId, `${orderTxid}i0`);
    assert.equal(firstMessage?.metadata?.paymentTxid, paymentTxid);
  } finally {
    sqlite.cleanup();
  }
});

test('ensureBuyerOrderObserverSession separates concurrent orders by order simplemsg txid', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const paymentTxid = 'd'.repeat(64);
    const firstOrderTxid = '1'.repeat(64);
    const secondOrderTxid = '2'.repeat(64);

    const first = await ensureBuyerOrderObserverSession(store, {
      metabotId: 7,
      peerGlobalMetaId: 'seller-global-metaid',
      servicePaidTx: paymentTxid,
      orderPayload: `[ORDER] first order\ntxid: ${paymentTxid}`,
      orderMessagePinId: `${firstOrderTxid}i0`,
      orderMessageTxid: firstOrderTxid,
    });
    const second = await ensureBuyerOrderObserverSession(store, {
      metabotId: 7,
      peerGlobalMetaId: 'seller-global-metaid',
      servicePaidTx: paymentTxid,
      orderPayload: `[ORDER] second order\ntxid: ${paymentTxid}`,
      orderMessagePinId: `${secondOrderTxid}i0`,
      orderMessageTxid: secondOrderTxid,
    });

    assert.notEqual(first.coworkSessionId, second.coworkSessionId);
    assert.equal(first.externalConversationId.endsWith(firstOrderTxid.slice(0, 16)), true);
    assert.equal(second.externalConversationId.endsWith(secondOrderTxid.slice(0, 16)), true);
  } finally {
    sqlite.cleanup();
  }
});

test('ensureBuyerOrderObserverSession reuses the same observer session for the same txid', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);

    const first = await ensureBuyerOrderObserverSession(store, {
      metabotId: 9,
      peerGlobalMetaId: 'seller-gmid',
      servicePaidTx: 'c'.repeat(64),
      orderPayload: '[ORDER] first order\n支付金额 1 SPACE\ntxid: ' + 'c'.repeat(64),
    });
    const second = await ensureBuyerOrderObserverSession(store, {
      metabotId: 9,
      peerGlobalMetaId: 'seller-gmid',
      servicePaidTx: 'c'.repeat(64),
      orderPayload: '[ORDER] duplicate order\n支付金额 1 SPACE\ntxid: ' + 'c'.repeat(64),
    });

    assert.equal(first.coworkSessionId, second.coworkSessionId);
    assert.equal(second.created, false);
    const session = store.getSession(first.coworkSessionId);
    assert.equal(session?.messages?.length, 1);
  } finally {
    sqlite.cleanup();
  }
});
