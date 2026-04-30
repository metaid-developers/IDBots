import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getColumns,
  getRow,
} from './memoryTestUtils.mjs';

const { ServiceOrderStore } = await import('../dist-electron/serviceOrderStore.js');

const makeTxid = (char) => char.repeat(64);

test('schema and listSessions hide sessions marked hidden_from_session_list', async () => {
  const sqlite = await createSqliteStore();
  try {
    assert.equal(getColumns(sqlite.db, 'cowork_sessions').includes('hidden_from_session_list'), true);
    const store = createCoworkStore(sqlite.db);
    const visible = store.createSession('Visible peer', process.cwd(), '', 'local', [], 1, 'a2a', 'peer', 'Peer', null);
    const hidden = store.createSession('Hidden order', process.cwd(), '', 'local', [], 1, 'a2a', 'peer', 'Peer', null);

    store.setSessionHiddenFromList(hidden.id, true);

    assert.equal(store.getSession(hidden.id)?.title, 'Hidden order');
    assert.deepEqual(
      store.listSessions().map((session) => session.id),
      [visible.id],
    );
  } finally {
    sqlite.cleanup();
  }
});

test('migration repoints legacy order mapping to canonical peer session and hides old order session', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 1;
    const peerGlobalMetaId = 'peer-migration';
    const orderTxid = makeTxid('a');
    const paymentTxid = makeTxid('b');
    const pinTxid = makeTxid('c');
    const directTxid = makeTxid('d');
    const overlapTxid = makeTxid('e');
    const copiedTxid = makeTxid('f');
    const privateExternalConversationId = `metaweb-private:${peerGlobalMetaId}`;
    const orderExternalConversationId = `metaweb_order:seller:${metabotId}:${peerGlobalMetaId}:${orderTxid.slice(0, 16)}`;

    const privateSession = store.createSession(
      'Peer',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      'Peer',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: privateExternalConversationId,
      metabotId,
      coworkSessionId: privateSession.id,
    });

    store.addMessage(privateSession.id, {
      type: 'user',
      content: 'already has pin',
      metadata: { pinId: `${pinTxid}i0`, sourceChannel: 'metaweb_private' },
    });
    store.addMessage(privateSession.id, {
      type: 'assistant',
      content: 'already has txid',
      metadata: { txid: directTxid, sourceChannel: 'metaweb_private' },
    });
    store.addMessage(privateSession.id, {
      type: 'assistant',
      content: 'already has txids intersection',
      metadata: { txids: [overlapTxid], sourceChannel: 'metaweb_private' },
    });

    const orderSession = store.createSession(
      'Legacy order',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      'Peer',
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: orderExternalConversationId,
      metabotId,
      coworkSessionId: orderSession.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId,
        orderTxid,
        servicePaidTx: paymentTxid,
      }),
    });

    store.addMessage(orderSession.id, {
      type: 'user',
      content: '[ORDER] duplicate by pin',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'incoming',
        pinId: `${pinTxid}i0`,
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: '[ORDER_STATUS] duplicate by txid',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
        txid: directTxid,
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: '[ORDER_STATUS] duplicate by txids intersection',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
        txids: [overlapTxid, makeTxid('1')],
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: '[DELIVERY] copied by new txid',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
        txid: copiedTxid,
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: 'legacy no-chain final answer',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: '重复状态：仍在处理。',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
      },
    });
    store.addMessage(orderSession.id, {
      type: 'assistant',
      content: '重复状态：仍在处理。',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        direction: 'outgoing',
      },
    });

    const serviceOrderStore = new ServiceOrderStore(sqlite.db, () => {});
    const serviceOrder = serviceOrderStore.createOrder({
      role: 'seller',
      localMetabotId: metabotId,
      counterpartyGlobalMetaid: peerGlobalMetaId,
      serviceName: 'Migration service',
      paymentTxid,
      paymentAmount: '1',
      paymentCurrency: 'SPACE',
      orderMessageTxid: orderTxid,
      coworkSessionId: orderSession.id,
      status: 'in_progress',
    });

    const changed = store.migrateMetawebOrderSessionsToPeerConversations();
    assert.equal(changed > 0, true);
    assert.equal(store.migrateMetawebOrderSessionsToPeerConversations(), 0);

    const mapping = store.getConversationMapping('metaweb_order', orderExternalConversationId, metabotId);
    assert.equal(mapping?.coworkSessionId, privateSession.id);
    assert.equal(store.getSession(orderSession.id)?.title, 'Legacy order');
    assert.equal(store.listSessions().some((session) => session.id === orderSession.id), false);
    assert.equal(store.listSessions().some((session) => session.id === privateSession.id), true);

    const migratedOrder = serviceOrderStore.getOrderById(serviceOrder.id);
    assert.equal(migratedOrder?.coworkSessionId, privateSession.id);

    const privateMessages = store.getSession(privateSession.id)?.messages ?? [];
    assert.equal(privateMessages.some((message) => message.content === '[ORDER] duplicate by pin'), false);
    assert.equal(privateMessages.some((message) => message.content === '[ORDER_STATUS] duplicate by txid'), false);
    assert.equal(privateMessages.some((message) => message.content === '[ORDER_STATUS] duplicate by txids intersection'), false);

    const copiedDelivery = privateMessages.find((message) => message.content === '[DELIVERY] copied by new txid');
    assert.ok(copiedDelivery);
    assert.equal(copiedDelivery.metadata?.sourceChannel, 'metaweb_private');
    assert.equal(copiedDelivery.metadata?.externalConversationId, privateExternalConversationId);
    assert.equal(copiedDelivery.metadata?.orderMappingExternalConversationId, orderExternalConversationId);
    assert.equal(copiedDelivery.metadata?.txid, copiedTxid);

    const copiedNoChain = privateMessages.find((message) => message.content === 'legacy no-chain final answer');
    assert.ok(copiedNoChain);
    assert.equal(copiedNoChain.metadata?.sourceChannel, 'metaweb_private');
    assert.equal(copiedNoChain.metadata?.externalConversationId, privateExternalConversationId);
    assert.equal(copiedNoChain.metadata?.orderMappingExternalConversationId, orderExternalConversationId);
    assert.equal(
      privateMessages.filter((message) => message.content === '重复状态：仍在处理。').length,
      2,
    );

    const legacyRow = getRow(sqlite.db, 'SELECT hidden_from_session_list FROM cowork_sessions WHERE id = ?', [orderSession.id]);
    assert.equal(legacyRow?.hidden_from_session_list, 1);
  } finally {
    sqlite.cleanup();
  }
});

test('session messages render chronologically after migration even when sequences were appended later', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession('Peer chronology', process.cwd(), '', 'local', [], 1, 'a2a', 'peer-chronology', 'Peer', null);

    const newer = store.addMessage(session.id, {
      type: 'assistant',
      content: 'newer existing message',
      metadata: { sourceChannel: 'metaweb_private' },
    });
    const older = store.addMessage(session.id, {
      type: 'user',
      content: 'older migrated message',
      metadata: { sourceChannel: 'metaweb_private' },
    });

    sqlite.db.run('UPDATE cowork_messages SET created_at = ?, sequence = ? WHERE id = ?', [2_000, 1, newer.id]);
    sqlite.db.run('UPDATE cowork_messages SET created_at = ?, sequence = ? WHERE id = ?', [1_000, 2, older.id]);

    assert.deepEqual(
      store.getSession(session.id)?.messages.map((message) => message.content),
      ['older migrated message', 'newer existing message'],
    );
  } finally {
    sqlite.cleanup();
  }
});

test('migration-created canonical peer sessions keep historical activity timestamps', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 1;
    const peerGlobalMetaId = 'peer-historical';
    const orderTxid = makeTxid('6');
    const privateExternalConversationId = `metaweb-private:${peerGlobalMetaId}`;
    const orderExternalConversationId = `metaweb_order:seller:${metabotId}:${peerGlobalMetaId}:${orderTxid.slice(0, 16)}`;
    const historicalCreatedAt = 1_700_000_000_000;
    const historicalUpdatedAt = 1_700_000_060_000;

    const orderSession = store.createSession(
      'Old order',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      'Historical Peer',
      null,
    );
    const orderMessage = store.addMessage(orderSession.id, {
      type: 'user',
      content: '[ORDER] old request',
      metadata: {
        sourceChannel: 'metaweb_order',
        externalConversationId: orderExternalConversationId,
        txid: orderTxid,
      },
    });
    sqlite.db.run('UPDATE cowork_messages SET created_at = ? WHERE id = ?', [historicalUpdatedAt, orderMessage.id]);
    sqlite.db.run(
      'UPDATE cowork_sessions SET created_at = ?, updated_at = ? WHERE id = ?',
      [historicalCreatedAt, historicalUpdatedAt, orderSession.id],
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: orderExternalConversationId,
      metabotId,
      coworkSessionId: orderSession.id,
      metadataJson: JSON.stringify({
        role: 'seller',
        peerGlobalMetaId,
        orderTxid,
      }),
    });

    store.migrateMetawebOrderSessionsToPeerConversations();

    const privateMapping = store.getConversationMapping('metaweb_private', privateExternalConversationId, metabotId);
    assert.ok(privateMapping);
    const canonical = store.getSession(privateMapping.coworkSessionId);
    assert.equal(canonical?.sessionType, 'a2a');
    assert.equal(canonical?.peerGlobalMetaId, peerGlobalMetaId);
    assert.equal(canonical?.createdAt, historicalCreatedAt);
    assert.equal(canonical?.updatedAt, historicalUpdatedAt);
    assert.deepEqual(
      store.listSessions().map((session) => session.id),
      [canonical?.id],
    );
  } finally {
    sqlite.cleanup();
  }
});

test('migration repairs legacy metaweb_private mappings that point at local standard sessions', async () => {
  const sqlite = await createSqliteStore();
  try {
    const store = createCoworkStore(sqlite.db);
    const metabotId = 2;
    const peerGlobalMetaId = 'peer-standard-legacy';
    const orderTxid = makeTxid('7');
    const privateExternalConversationId = `metaweb-private:${peerGlobalMetaId}`;
    const orderExternalConversationId = `metaweb_order:buyer:${metabotId}:${peerGlobalMetaId}:${orderTxid.slice(0, 16)}`;

    const legacyPrivateSession = store.createSession(
      `Private-${peerGlobalMetaId.slice(0, 12)}`,
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'standard',
      null,
      null,
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: privateExternalConversationId,
      metabotId,
      coworkSessionId: legacyPrivateSession.id,
      metadataJson: JSON.stringify({ peerGlobalMetaId }),
    });

    const orderSession = store.createSession(
      'Legacy order index',
      process.cwd(),
      '',
      'local',
      [],
      metabotId,
      'a2a',
      peerGlobalMetaId,
      null,
      null,
    );
    store.upsertConversationMapping({
      channel: 'metaweb_order',
      externalConversationId: orderExternalConversationId,
      metabotId,
      coworkSessionId: orderSession.id,
      metadataJson: JSON.stringify({
        role: 'buyer',
        peerGlobalMetaId,
        orderTxid,
      }),
    });

    store.migrateMetawebOrderSessionsToPeerConversations();

    const repaired = store.getSession(legacyPrivateSession.id);
    assert.equal(repaired?.sessionType, 'a2a');
    assert.equal(repaired?.peerGlobalMetaId, peerGlobalMetaId);
    assert.equal(
      store.getConversationMapping('metaweb_order', orderExternalConversationId, metabotId)?.coworkSessionId,
      legacyPrivateSession.id,
    );
    assert.equal(store.listSessions().some((session) => session.id === orderSession.id), false);
  } finally {
    sqlite.cleanup();
  }
});
