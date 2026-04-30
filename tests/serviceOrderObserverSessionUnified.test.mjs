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

test('ensureServiceOrderObserverSession relinks legacy order mapping to canonical peer private session', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = createCoworkStore(sqlite.db);
    const orderTxid = 'c'.repeat(64);
    const legacySession = store.createSession(
      'Legacy order',
      process.cwd(),
      '',
      'local',
      [],
      3,
      'a2a',
      'peer-legacy',
      'Peer Legacy',
      null,
    );
    const externalConversationId = `metaweb_order:seller:3:peer-legacy:${orderTxid.slice(0, 16)}`;
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId,
      metabotId: 3,
      coworkSessionId: legacySession.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId: 'peer-legacy',
        orderTxid,
      }),
    });

    const result = await ensureServiceOrderObserverSession(store, {
      role: 'seller',
      metabotId: 3,
      peerGlobalMetaId: 'peer-legacy',
      peerName: 'Peer Legacy',
      servicePaidTx: 'd'.repeat(64),
      orderTxid,
      orderMessageTxid: orderTxid,
      orderPayload: '[ORDER] legacy relink',
    });

    assert.notEqual(result.coworkSessionId, legacySession.id);
    const privateMapping = store.getConversationMapping('metaweb_private', 'metaweb-private:peer-legacy', 3);
    assert.ok(privateMapping);
    assert.equal(result.coworkSessionId, privateMapping.coworkSessionId);
    assert.equal(
      store.getConversationMapping('metaweb_order', externalConversationId, 3)?.coworkSessionId,
      privateMapping.coworkSessionId,
    );
  } finally {
    sqlite.cleanup();
  }
});

test('canonical peer session source context prefers metaweb_private over order indexes', async () => {
  const sqlite = await createSqliteStore();

  try {
    const store = createCoworkStore(sqlite.db);
    const orderTxid = 'e'.repeat(64);
    const result = await ensureServiceOrderObserverSession(store, {
      role: 'buyer',
      metabotId: 4,
      peerGlobalMetaId: 'seller-source-context',
      servicePaidTx: 'f'.repeat(64),
      orderTxid,
      orderMessageTxid: orderTxid,
      orderPayload: '[ORDER] source context',
    });

    const sourceContext = store.getConversationSourceContextBySession(result.coworkSessionId);
    assert.equal(sourceContext.sourceChannel, 'metaweb_private');
    assert.equal(sourceContext.externalConversationId, 'metaweb-private:seller-source-context');
  } finally {
    sqlite.cleanup();
  }
});
