import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createCoworkStore,
  createSqliteStore,
} from './memoryTestUtils.mjs';

let reconcilePrivateChatDisplayGaps;
let isPrivateChatDisplayCiphertext;
try {
  ({
    reconcilePrivateChatDisplayGaps,
    isPrivateChatDisplayCiphertext,
  } = await import('../dist-electron/main/services/privateChatDisplayReconcile.js'));
} catch {
  ({
    reconcilePrivateChatDisplayGaps,
    isPrivateChatDisplayCiphertext,
  } = await import('../dist-electron/main/services/privateChatDisplayReconcile.js'));
}

const LOCAL = 'idq1local';
const PEER = 'idq1peer';
const PIN = `${'ab'.repeat(32)}i0`;
const KNOWN_PIN = `${'cd'.repeat(32)}i0`;

function insertMetabot(db, id, globalMetaId) {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key,
      chat_public_key, name, metaid, globalmetaid, metabot_type, created_by,
      role, soul, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 'worker', 'test', 'role', 'soul', 1, 1)`,
    [id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `pk-${id}`, `chatpk-${id}`, `bot-${id}`, `metaid-${id}`, globalMetaId],
  );
}

function insertPrivateRow(db, input) {
  db.run(
    `INSERT INTO private_chat_messages (
      pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar, from_chat_pubkey,
      to_metaid, to_global_metaid, protocol, content, content_type, encryption, reply_pin,
      chain_timestamp, chain, raw_data, is_processed
    ) VALUES (?, ?, '', ?, ?, NULL, NULL, '', ?, '/protocols/simplemsg', ?, NULL, 'ecdh', '', ?, 'mvc', '{}', 1)`,
    [
      input.pinId,
      input.txId ?? null,
      input.fromGlobalMetaId,
      input.fromName ?? 'Peer',
      input.toGlobalMetaId,
      input.content,
      input.chainTimestamp,
    ],
  );
}

test('ciphertext detector rejects salted payloads and blank text', () => {
  assert.equal(isPrivateChatDisplayCiphertext(''), true);
  assert.equal(isPrivateChatDisplayCiphertext('U2FsdGVkX1abc'), true);
  assert.equal(isPrivateChatDisplayCiphertext('收到，我先核对一下'), false);
});

test('reconcile inserts a processed inbound bubble in chain order and is idempotent', async () => {
  const sqlite = await createSqliteStore();
  try {
    insertMetabot(sqlite.db, 1, LOCAL);
    const store = createCoworkStore(sqlite.db);
    const session = store.createSession(
      'Peer', '/tmp/a2a', '', 'local', [], 1, 'a2a', PEER, 'Peer',
    );
    store.registerA2AEpisode({
      sessionId: session.id,
      localMetabotId: 1,
      localGlobalMetaId: LOCAL,
      peerGlobalMetaId: PEER,
      episodeIndex: 1,
      startedAt: 1,
    });
    store.upsertConversationMapping({
      channel: 'metaweb_private',
      externalConversationId: `metaweb-private:${PEER}`,
      metabotId: 1,
      coworkSessionId: session.id,
      metadataJson: null,
    });
    store.insertHistoricalCoworkMessage(session.id, {
      type: 'user',
      content: 'earlier',
      timestamp: 1_000_000,
      metadata: { sourceChannel: 'metaweb_private', pinId: KNOWN_PIN, direction: 'incoming' },
    });
    store.insertHistoricalCoworkMessage(session.id, {
      type: 'assistant',
      content: 'later',
      timestamp: 3_000_000,
      metadata: { sourceChannel: 'metaweb_private', direction: 'outgoing' },
    });
    insertPrivateRow(sqlite.db, {
      pinId: KNOWN_PIN,
      fromGlobalMetaId: PEER,
      toGlobalMetaId: LOCAL,
      content: 'earlier',
      chainTimestamp: 1_000,
    });
    insertPrivateRow(sqlite.db, {
      pinId: PIN,
      fromGlobalMetaId: PEER,
      fromName: 'Peer Bot',
      toGlobalMetaId: LOCAL,
      content: 'the missing line',
      chainTimestamp: 2_000,
    });
    insertPrivateRow(sqlite.db, {
      pinId: `${'ef'.repeat(32)}i0`,
      fromGlobalMetaId: PEER,
      toGlobalMetaId: LOCAL,
      content: 'U2FsdGVkX1still-secret',
      chainTimestamp: 2_500,
    });

    const identities = [{ metabotId: 1, globalMetaId: LOCAL }];
    const first = reconcilePrivateChatDisplayGaps({
      db: sqlite.db,
      coworkStore: store,
      identities,
      nowSec: 10_000,
      lookbackSec: 20_000,
    });
    assert.equal(first.inserted, 1);

    const ordered = store.getSession(session.id).messages.map((message) => ({
      content: message.content,
      timestamp: message.timestamp,
      sequence: message.sequence,
      direction: message.metadata?.direction,
      pinId: message.metadata?.pinId,
    }));
    assert.deepEqual(ordered.map((message) => message.content), ['earlier', 'the missing line', 'later']);
    assert.deepEqual(ordered.map((message) => message.sequence), [1, 2, 3]);
    assert.equal(ordered[1].direction, 'incoming');
    assert.equal(ordered[1].pinId, PIN);
    assert.equal(ordered[1].timestamp, 2_000_000);

    const second = reconcilePrivateChatDisplayGaps({
      db: sqlite.db,
      coworkStore: store,
      identities,
      nowSec: 10_000,
      lookbackSec: 20_000,
    });
    assert.equal(second.inserted, 0);
    assert.equal(store.getSession(session.id).messages.length, 3);
  } finally {
    sqlite.store?.close?.();
    sqlite.cleanup();
  }
});
