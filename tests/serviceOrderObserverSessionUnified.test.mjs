import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

const {
  ensureServiceOrderObserverSession,
} = await import('../dist-electron/services/serviceOrderObserverSession.js');

test('ensureServiceOrderObserverSession indexes orders to the canonical peer private session', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = createCoworkStore(sqlite.db);
    const orderTxid = 'b'.repeat(64);
    const result = await ensureServiceOrderObserverSession(store, {
      role: 'seller',
      metabotId: 1,
      peerGlobalMetaId: 'peer-global',
      peerName: 'Peer Bot',
      servicePaidTx: 'a'.repeat(64),
      orderTxid,
      orderMessageTxid: orderTxid,
      orderPayload: '[ORDER] hello',
    });

    const privateMapping = store.getConversationMapping('metaweb_private', 'metaweb-private:peer-global', 1);
    const orderMapping = store.getConversationMapping('metaweb_order', result.externalConversationId, 1);

    assert.ok(privateMapping);
    assert.ok(orderMapping);
    assert.equal(orderMapping.coworkSessionId, privateMapping.coworkSessionId);
    assert.equal(result.coworkSessionId, privateMapping.coworkSessionId);

    const session = store.getSession(result.coworkSessionId);
    assert.equal(session?.peerGlobalMetaId, 'peer-global');
    assert.equal(session?.messages?.length, 1);
    assert.equal(session?.messages?.[0]?.metadata?.sourceChannel, 'metaweb_private');
    assert.equal(session?.messages?.[0]?.metadata?.orderProtocolTag, 'ORDER');
    assert.equal(session?.messages?.[0]?.metadata?.orderTxid, orderTxid);
    assert.equal(session?.messages?.[0]?.metadata?.orderMappingExternalConversationId, result.externalConversationId);
  } finally {
    sqlite.cleanup();
  }
});

test('ensureServiceOrderObserverSession reuses canonical peer session for concurrent order indexes', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = createCoworkStore(sqlite.db);
    const firstOrderTxid = '1'.repeat(64);
    const secondOrderTxid = '2'.repeat(64);

    const first = await ensureServiceOrderObserverSession(store, {
      role: 'buyer',
      metabotId: 2,
      peerGlobalMetaId: 'seller-global',
      servicePaidTx: 'a'.repeat(64),
      orderTxid: firstOrderTxid,
      orderMessageTxid: firstOrderTxid,
      orderPayload: '[ORDER] first',
    });
    const second = await ensureServiceOrderObserverSession(store, {
      role: 'buyer',
      metabotId: 2,
      peerGlobalMetaId: 'seller-global',
      servicePaidTx: 'a'.repeat(64),
      orderTxid: secondOrderTxid,
      orderMessageTxid: secondOrderTxid,
      orderPayload: '[ORDER] second',
    });

    assert.equal(first.coworkSessionId, second.coworkSessionId);
    assert.notEqual(first.externalConversationId, second.externalConversationId);

    const session = store.getSession(first.coworkSessionId);
    assert.equal(session?.messages?.length, 2);
    assert.deepEqual(
      session?.messages?.map((message) => message.metadata?.orderTxid),
      [firstOrderTxid, secondOrderTxid],
    );
  } finally {
    sqlite.cleanup();
  }
});
