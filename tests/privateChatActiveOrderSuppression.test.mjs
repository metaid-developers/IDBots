import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
  getRow,
} from './memoryTestUtils.mjs';

const {
  handleActiveOrderOrdinaryPrivateChatSuppression,
} = await import('../dist-electron/services/privateChatDaemon.js');

function buildPrivateChatRow(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    pin_id: overrides.pinId ?? 'incoming-pin-1',
    tx_id: overrides.txId ?? 'a'.repeat(64),
    from_metaid: overrides.fromMetaId ?? 'peer-metaid',
    from_global_metaid: overrides.fromGlobalMetaId ?? 'peer-global',
    from_name: overrides.fromName ?? 'Peer Bot',
    from_avatar: overrides.fromAvatar ?? null,
    from_chat_pubkey: overrides.fromChatPubkey ?? 'pubkey',
    to_metaid: overrides.toMetaId ?? 'local-metaid',
    to_global_metaid: overrides.toGlobalMetaId ?? 'local-global',
    content: overrides.content ?? 'hello during active order',
    encryption: overrides.encryption ?? '0',
    reply_pin: overrides.replyPin ?? null,
    raw_data: overrides.rawData ?? null,
  };
}

function insertPrivateChatRow(db, row) {
  db.run(`
    INSERT INTO private_chat_messages (
      id, pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar,
      from_chat_pubkey, to_metaid, to_global_metaid, protocol, content, content_type,
      encryption, reply_pin, raw_data, is_processed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '/protocols/simplemsg', ?, 'text/plain', ?, ?, ?, 0)
  `, [
    row.id,
    row.pin_id,
    row.tx_id,
    row.from_metaid,
    row.from_global_metaid,
    row.from_name,
    row.from_avatar,
    row.from_chat_pubkey,
    row.to_metaid,
    row.to_global_metaid,
    row.content,
    row.encryption,
    row.reply_pin,
    row.raw_data,
  ]);
}

test('active order ordinary private chat is appended to canonical peer session and marked processed', async () => {
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const row = buildPrivateChatRow();
    insertPrivateChatRow(sqlite.db, row);
    let saveCount = 0;
    let activeCheckCount = 0;

    const result = await handleActiveOrderOrdinaryPrivateChatSuppression({
      db: sqlite.db,
      saveDb: () => { saveCount += 1; },
      coworkStore,
      metabotId: 1,
      row,
      plaintext: row.content,
      fromGlobalMetaId: row.from_global_metaid,
      hasActiveOrderForPrivateChatSuppression: () => {
        activeCheckCount += 1;
        return true;
      },
      emitLog: () => {},
    });

    assert.equal(result.suppressed, true);
    assert.equal(activeCheckCount, 1);
    assert.equal(saveCount > 0, true);

    const rawRow = getRow(sqlite.db, 'SELECT is_processed FROM private_chat_messages WHERE id = ?', [row.id]);
    assert.equal(rawRow?.is_processed, 1);

    const mapping = coworkStore.getConversationMapping('metaweb_private', 'metaweb-private:peer-global', 1);
    assert.ok(mapping);
    const session = coworkStore.getSession(mapping.coworkSessionId);
    assert.equal(session?.messages?.length, 1);
    assert.equal(session?.messages?.[0]?.content, row.content);
    assert.equal(session?.messages?.[0]?.metadata?.sourceChannel, 'metaweb_private');
    assert.equal(session?.messages?.[0]?.metadata?.simplemsgKind, 'private_chat');
    assert.equal(session?.messages?.[0]?.metadata?.txid, row.tx_id);
    assert.equal(session?.messages?.[0]?.metadata?.pinId, row.pin_id);
  } finally {
    sqlite.cleanup();
  }
});

test('ordinary private chat continues to normal auto-reply path when peer has no active orders', async () => {
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const row = buildPrivateChatRow();
    insertPrivateChatRow(sqlite.db, row);

    const result = await handleActiveOrderOrdinaryPrivateChatSuppression({
      db: sqlite.db,
      saveDb: () => {},
      coworkStore,
      metabotId: 1,
      row,
      plaintext: row.content,
      fromGlobalMetaId: row.from_global_metaid,
      hasActiveOrderForPrivateChatSuppression: () => false,
      emitLog: () => {},
    });

    assert.equal(result.suppressed, false);
    assert.equal(
      coworkStore.getConversationMapping('metaweb_private', 'metaweb-private:peer-global', 1),
      null,
    );
    const rawRow = getRow(sqlite.db, 'SELECT is_processed FROM private_chat_messages WHERE id = ?', [row.id]);
    assert.equal(rawRow?.is_processed, 0);
  } finally {
    sqlite.cleanup();
  }
});

test('order protocol messages are not consumed by active-order ordinary chat suppression', async () => {
  const sqlite = await createSqliteStore();

  try {
    const coworkStore = createCoworkStore(sqlite.db);
    const orderTxid = 'b'.repeat(64);
    const row = buildPrivateChatRow({
      content: `[DELIVERY:${orderTxid}] {"result":"done"}`,
    });
    insertPrivateChatRow(sqlite.db, row);

    const result = await handleActiveOrderOrdinaryPrivateChatSuppression({
      db: sqlite.db,
      saveDb: () => {},
      coworkStore,
      metabotId: 1,
      row,
      plaintext: row.content,
      fromGlobalMetaId: row.from_global_metaid,
      hasActiveOrderForPrivateChatSuppression: () => true,
      emitLog: () => {},
    });

    assert.equal(result.suppressed, false);
    assert.equal(
      coworkStore.getConversationMapping('metaweb_private', 'metaweb-private:peer-global', 1),
      null,
    );
  } finally {
    sqlite.cleanup();
  }
});
