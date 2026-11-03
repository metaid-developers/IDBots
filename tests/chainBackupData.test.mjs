import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { MetaIDKnowledgeStore } = require('../dist-electron/main/metaidKnowledgeStore.js');
const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { deriveBackupKey, encryptJson, decryptJson, decryptBytes, objectId } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects, importBackupObjects, selectLatestBackupObjects } = require('../dist-electron/main/services/chainBackupData.js');
const { recordChainBackupTombstones, listChainBackupTombstones } = require('../dist-electron/main/libs/chainBackupTombstones.js');

/**
 * Chain-backup data round-trip: extract from a source DB, encrypt/decrypt like
 * the on-chain segment does, import into a fresh DB with a remapped metabot id.
 * Run `pnpm run compile:electron` first.
 */

const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  // Knowledge/dream tables are created by their stores, not SqliteStore.
  new MetaIDKnowledgeStore(db, save);
  new DreamStore(db, save);
  const metabotStore = new MetabotStore(db, save);
  return { sqliteStore, db, metabotStore };
}

const MNEMONIC_B = 'letter advice cage absurd amount doctor acoustic avoid letter advice cage above';

function createBot(metabotStore, name, gid, mnemonic = TEST_MNEMONIC) {
  const wallet = metabotStore.insertMetabotWallet({ mnemonic, path: "m/44'/10001'/0'/0/0" });
  return metabotStore.createMetabot({
    wallet_id: wallet.id,
    mvc_address: `mvc-${name}`,
    btc_address: `btc-${name}`,
    doge_address: `doge-${name}`,
    public_key: `pub-${name}`,
    chat_public_key: `chat-${name}`,
    name,
    enabled: true,
    metaid: `metaid-${name}`,
    globalmetaid: gid,
    metabot_type: 'worker',
    created_by: '0000',
    role: 'tester',
    soul: 'test soul',
  });
}

test('extract → encrypt → decrypt → import round-trip with metabot_id remap', async () => {
  const source = await openStore('idbots-backup-src-');
  const bot = createBot(source.metabotStore, 'src-bot', TEST_GID);
  const db = source.db;

  const now = Date.now();
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-1', ?, 'user likes tea', 'fp-tea', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-si', ?, 'I am a careful tester bot', 'fp-self', 1.0, 0, 'created', 'owner', 'owner:self', 'self_identity', 'local_only', 'dream', 1.0, ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO user_memory_sources (id, memory_id, metabot_id, source_type, dream_date, created_at)
     VALUES ('src-1', 'mem-si', ?, 'dream', '2026-10-09', ?)`,
    [bot.id, now],
  );
  db.run(
    `INSERT INTO metabot_daily_summaries (id, metabot_id, summary_date, summary_text, created_at, updated_at)
     VALUES ('day-1', ?, '2026-10-09', 'Today I dreamed of tea.', ?, ?)`,
    [bot.id, now, now],
  );
  db.run(
    `INSERT INTO metaid_knowledge_entries (id, metabot_id, topic, topic_fingerprint, summary, kind, confidence, status, origin, version, created_at, updated_at)
     VALUES ('kn-1', ?, 'tea brewing', 'tfp-tea', 'steep 3 minutes', 'know_how', 0.8, 'active', 'dream', 1, ?, ?)`,
    [bot.id, now, now],
  );
  // deleted memories must not be extracted
  db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-del', ?, 'forgotten', 'fp-del', 0.5, 0, 'deleted', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.5, ?, ?)`,
    [bot.id, now, now],
  );

  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  const objects = extractBackupObjects(db, bot.id, wallet);

  const kinds = objects.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ['bot_profile', 'dream_daily', 'key_envelope', 'knowledge', 'memory', 'memory', 'memory_tombstone']);
  // The deleted row never ships as a live object — only as a minimal tombstone.
  assert.ok(!objects.some((o) => o.data.text === 'forgotten'));
  const tombstone = objects.find((o) => o.kind === 'memory_tombstone');
  assert.equal(tombstone.data.ref, 'mem-del');
  const envelope = objects.find((o) => o.kind === 'key_envelope');
  assert.equal(envelope.data.mnemonic, TEST_MNEMONIC);

  // Simulate the on-chain segment: encrypt the whole container, then decrypt.
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const segmentPlaintext = {
    version: 1,
    bot: TEST_GID,
    createdAt: Math.floor(now / 1000),
    objects: objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
  };
  const onChainPayload = encryptJson(key, segmentPlaintext).toString('base64');
  const decrypted = decryptJson(deriveBackupKey(TEST_MNEMONIC, TEST_GID), Buffer.from(onChainPayload, 'base64'));
  assert.equal(objectId(decrypted), objectId(segmentPlaintext));

  // Import into a fresh device DB; an unrelated pre-existing bot forces the
  // restored bot onto a different local id, proving the metabot_id remap.
  const target = await openStore('idbots-backup-dst-');
  createBot(target.metabotStore, 'unrelated-bot', 'idqunrelated000000000000000000000000000', MNEMONIC_B);
  const restoredBot = createBot(target.metabotStore, 'src-bot-re', TEST_GID);
  assert.notEqual(restoredBot.id, bot.id);

  const importedObjects = selectLatestBackupObjects(
    decrypted.objects.map((o) => ({ id: o.id, kind: o.kind, data: o.data })),
  );
  const first = importBackupObjects(target.db, restoredBot.id, importedObjects);
  assert.equal(first.imported, 5); // 2 memories + 1 source + 1 daily + 1 knowledge
  assert.equal(first.skipped, 2); // key_envelope + bot_profile are never imported as rows

  const memories = target.db.exec(`SELECT * FROM user_memories WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(memories[0].values.length, 2);
  const selfIdentity = target.db.exec(
    `SELECT text FROM user_memories WHERE metabot_id = ? AND usage_class = 'self_identity'`,
    [restoredBot.id],
  );
  assert.equal(selfIdentity[0].values[0][0], 'I am a careful tester bot');
  const daily = target.db.exec(`SELECT summary_text FROM metabot_daily_summaries WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(daily[0].values[0][0], 'Today I dreamed of tea.');
  const knowledge = target.db.exec(`SELECT summary FROM metaid_knowledge_entries WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(knowledge[0].values[0][0], 'steep 3 minutes');
  const sources = target.db.exec(`SELECT dream_date FROM user_memory_sources WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(sources[0].values[0][0], '2026-10-09');

  // Re-running the same import is a no-op (idempotent).
  const second = importBackupObjects(target.db, restoredBot.id, importedObjects);
  assert.equal(second.imported, 0);
  const memoriesAfter = target.db.exec(`SELECT COUNT(*) FROM user_memories WHERE metabot_id = ?`, [restoredBot.id]);
  assert.equal(memoriesAfter[0].values[0][0], 2);
});

test('journal rebuild from manifest: post-restore backup diffs to zero', async () => {
  const { readChainBackupState, rebuildChainBackupStateFromManifest } =
    require('../dist-electron/main/services/chainBackupData.js');

  const source = await openStore('idbots-journal-src-');
  const bot = createBot(source.metabotStore, 'journal-bot', TEST_GID);
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-j1', ?, 'journal memory', 'fp-journal', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, 1, 1)`,
    [bot.id],
  );
  const wallet = source.metabotStore.getMetabotWalletByMetabotId(bot.id);
  const objects = extractBackupObjects(source.db, bot.id, wallet);

  // Pretend these were published on-chain in one segment.
  const manifest = {
    pinId: 'fakepinid' + '0'.repeat(56) + 'i0',
    segments: [{
      pinId: 'segpin' + '0'.repeat(58) + 'i0',
      segment: 'seg-hash',
      bytes: 1234,
      kinds: ['memory', 'key_envelope'],
      objectIds: objects.map((o) => o.id),
    }],
    updatedAt: 1760000000,
  };

  // Fresh device: restore imports the rows, then rebuilds the journal.
  const target = await openStore('idbots-journal-dst-');
  const restoredBot = createBot(target.metabotStore, 'journal-bot', TEST_GID);
  importBackupObjects(target.db, restoredBot.id, objects);
  rebuildChainBackupStateFromManifest(target.db, {
    botGlobalMetaId: TEST_GID,
    manifestPinId: manifest.pinId,
    segments: manifest.segments,
    manifestUpdatedAt: manifest.updatedAt,
  });

  const state = readChainBackupState(target.db, TEST_GID);
  assert.ok(state);
  assert.equal(state.manifest_pinid, manifest.pinId);
  assert.equal(state.last_backup_at, 1760000000 * 1000);
  const uploaded = new Set(JSON.parse(state.uploaded_object_ids_json));
  assert.equal(uploaded.size, objects.length);

  // The next backup's diff: re-extract on this device, drop already-uploaded
  // ids — nothing should remain (the restored rows hash to the same ids).
  const reExtracted = extractBackupObjects(target.db, restoredBot.id, null);
  const pending = reExtracted.filter((o) => !uploaded.has(o.id));
  assert.deepEqual(pending, []);
});

test('runChainBackup: publishes encrypted segments + manifest, incremental second run', async () => {
  const { runChainBackup, CHAIN_BACKUP_OBJECT_PATH, CHAIN_BACKUP_MANIFEST_PATH } =
    require('../dist-electron/main/services/chainBackupService.js');
  const { readChainBackupState } = require('../dist-electron/main/services/chainBackupData.js');

  const source = await openStore('idbots-svc-src-');
  const bot = createBot(source.metabotStore, 'svc-bot', TEST_GID);
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-svc1', ?, 'service memory', 'fp-svc', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, 1, 1)`,
    [bot.id],
  );

  const userStore = { get: () => ({ mnemonic: TEST_MNEMONIC, globalmetaid: TEST_GID }) };
  const published = []; // {metaidData, pinId}
  let pinCounter = 0;
  const createPinImpl = async (_store, _botId, metaidData) => {
    pinCounter += 1;
    const pinId = `pin${String(pinCounter).padStart(4, '0')}` + '0'.repeat(55) + 'i0';
    published.push({ metaidData, pinId });
    return { txids: ['tx' + pinCounter], pinId, totalCost: 100 };
  };
  let manifestSyncs = 0;
  const syncBotsManifestImpl = async () => {
    manifestSyncs += 1;
    return { success: true, botCount: 1, boundCount: 1, newlyBound: 0, skippedUnbound: [], txids: [] };
  };

  const deps = {
    db: source.db,
    metabotStore: source.metabotStore,
    userStore,
    createPinImpl,
    syncBotsManifestImpl,
    sleep: async () => {},
  };

  const first = await runChainBackup(deps);
  assert.equal(first.success, true);
  assert.equal(first.botsManifestSynced, true);
  assert.equal(manifestSyncs, 1);
  assert.equal(first.bots.length, 1);
  assert.equal(first.bots[0].uploadedObjects, 3); // memory + key_envelope + bot_profile
  assert.equal(first.bots[0].segments, 1);

  // One object pin (create) + one manifest pin (create).
  const objectPins = published.filter((p) => p.metaidData.path === CHAIN_BACKUP_OBJECT_PATH);
  const manifestPins = published.filter((p) => p.metaidData.path === CHAIN_BACKUP_MANIFEST_PATH);
  assert.equal(objectPins.length, 1);
  assert.equal(manifestPins.length, 1);
  assert.equal(manifestPins[0].metaidData.operation, 'create');

  // The object pin decrypts with the mnemonic-derived key and hashes correctly.
  const envelope = JSON.parse(objectPins[0].metaidData.payload);
  assert.equal(envelope.cipher, 'aes-256-gcm');
  assert.equal(envelope.encoding, 'gzip');
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const segment = JSON.parse(
    zlib.gunzipSync(decryptBytes(key, Buffer.from(envelope.payload, 'base64'))).toString('utf8'),
  );
  assert.equal(objectId(segment), envelope.segment);
  assert.equal(segment.objects.length, 3);

  // State journal written.
  const state = readChainBackupState(source.db, TEST_GID);
  assert.ok(state);
  assert.equal(state.manifest_pinid, manifestPins[0].pinId);

  // Second run: nothing new → no object pin; manifest refreshed via modify.
  const second = await runChainBackup(deps);
  assert.equal(second.success, true);
  assert.equal(second.bots[0].uploadedObjects, 0);
  assert.equal(second.bots[0].skippedObjects, 3);
  assert.equal(manifestSyncs, 2);
  const secondObjectPins = published.slice(objectPins.length).filter((p) => p.metaidData.path === CHAIN_BACKUP_OBJECT_PATH);
  assert.equal(secondObjectPins.length, 0);
  const modifyPins = published.filter((p) => p.metaidData.operation === 'modify');
  assert.equal(modifyPins.length, 1);
  assert.equal(modifyPins[0].metaidData.path, `@${manifestPins[0].pinId}`);

  // Third run: the modify target ADVANCES to the previous modify pin (chain
  // head) instead of re-modifying the original create pin — the gig-square /
  // MetaApp convention.
  const third = await runChainBackup(deps);
  assert.equal(third.success, true);
  const modifyPinsAfterThird = published.filter((p) => p.metaidData.operation === 'modify');
  assert.equal(modifyPinsAfterThird.length, 2);
  assert.equal(modifyPinsAfterThird[1].metaidData.path, `@${modifyPinsAfterThird[0].pinId}`);
});

test('selectLatestBackupObjects: newest version wins, tombstones suppress, re-created rows survive', () => {
  const live = (id, text, n) => ({ id: `obj-${id}-${n}`, kind: 'memory', data: { id, text } });
  const tomb = (id, n) => ({ id: `tomb-${id}-${n}`, kind: 'memory_tombstone', data: { ref: id, deleted_at: n } });

  // Edited row: two live versions of mem-1 → the newest (last) one wins.
  const edited = selectLatestBackupObjects([live('mem-1', 'v1', 1), live('mem-1', 'v2', 2)]);
  assert.equal(edited.length, 1);
  assert.equal(edited[0].data.text, 'v2');

  // Deleted row: live snapshot then tombstone → the row is suppressed.
  const deleted = selectLatestBackupObjects([live('mem-2', 'v1', 1), tomb('mem-2', 2)]);
  assert.equal(deleted.length, 0);

  // Re-created after deletion: tombstone then a newer live version → kept.
  const recreated = selectLatestBackupObjects([live('mem-3', 'v1', 1), tomb('mem-3', 2), live('mem-3', 'v2', 3)]);
  assert.equal(recreated.length, 1);
  assert.equal(recreated[0].data.text, 'v2');

  // Knowledge rows dedupe by id and ride knowledge_tombstones.
  const knowledge = selectLatestBackupObjects([
    { id: 'k1', kind: 'knowledge', data: { id: 'kn-1', summary: 'old' } },
    { id: 'k2', kind: 'knowledge', data: { id: 'kn-1', summary: 'new' } },
    { id: 'k4', kind: 'knowledge', data: { id: 'kn-2', summary: 'gone' } },
    { id: 'k3', kind: 'knowledge_tombstone', data: { ref: 'kn-2', deleted_at: 3 } },
    { id: 'k5', kind: 'key_envelope', data: { mnemonic: 'x', path: 'p' } },
  ]);
  assert.deepEqual(
    knowledge.map((o) => `${o.kind}:${o.data.summary ?? ''}`).sort(),
    ['key_envelope:', 'knowledge:new'],
  );

  // Rows without a stable id never collapse into each other.
  const noIds = selectLatestBackupObjects([
    { id: 'a', kind: 'memory', data: { text: 'one' } },
    { id: 'b', kind: 'memory', data: { text: 'two' } },
  ]);
  assert.equal(noIds.length, 2);
});

test('extraction emits tombstones for soft-deleted memories and ledgered hard deletes', async () => {
  const source = await openStore('idbots-tomb-src-');
  const bot = createBot(source.metabotStore, 'tomb-bot', TEST_GID);
  const now = Date.now();
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-live', ?, 'kept', 'fp-live', 0.9, 1, 'created', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.9, ?, ?)`,
    [bot.id, now, now],
  );
  source.db.run(
    `INSERT INTO user_memories (id, metabot_id, text, fingerprint, confidence, is_explicit, status, scope_kind, scope_key, usage_class, visibility, origin, importance, created_at, updated_at)
     VALUES ('mem-soft', ?, 'soft deleted', 'fp-soft', 0.5, 0, 'deleted', 'owner', 'owner:self', 'profile_fact', 'local_only', 'conversation', 0.5, ?, ?)`,
    [bot.id, now - 5000, now - 1000],
  );
  // A hard-deleted row only exists in the ledger now.
  recordChainBackupTombstones(source.db, [
    { kind: 'memory', ref: 'mem-purged', metabotId: bot.id, deletedAt: now - 500 },
    { kind: 'knowledge', ref: 'kn-purged', metabotId: bot.id, deletedAt: now - 400 },
  ]);

  const objects = extractBackupObjects(source.db, bot.id, null);
  const tombstones = objects.filter((o) => o.kind.endsWith('_tombstone'));
  assert.deepEqual(
    tombstones.map((o) => `${o.kind}:${o.data.ref}`).sort(),
    ['knowledge_tombstone:kn-purged', 'memory_tombstone:mem-purged', 'memory_tombstone:mem-soft'],
  );
  const softTomb = tombstones.find((o) => o.data.ref === 'mem-soft');
  assert.equal(softTomb.data.deleted_at, now - 1000);
  // Live rows are unaffected.
  assert.ok(objects.some((o) => o.kind === 'memory' && o.data.id === 'mem-live'));

  // Re-delete ordering: a row restored then deleted again yields a NEW
  // tombstone object id (deleted_at rides the object hash), so the backup
  // journal re-uploads it instead of diffing it away.
  const firstPass = extractBackupObjects(source.db, bot.id, null).filter((o) => o.kind === 'memory_tombstone' && o.data.ref === 'mem-soft');
  source.db.run(`UPDATE user_memories SET updated_at = ? WHERE id = 'mem-soft'`, [now]);
  const secondPass = extractBackupObjects(source.db, bot.id, null).filter((o) => o.kind === 'memory_tombstone' && o.data.ref === 'mem-soft');
  assert.notEqual(secondPass[0].id, firstPass[0].id);

  // The ledger is per-bot: another bot's extraction sees none of these.
  const otherBot = createBot(source.metabotStore, 'tomb-bot-2', 'idqtestglobalmetaid00000000000000000000002', MNEMONIC_B);
  const otherObjects = extractBackupObjects(source.db, otherBot.id, null);
  assert.equal(otherObjects.filter((o) => o.kind.endsWith('_tombstone')).length, 0);
});

test('deleteKnowledge records a chain-backup tombstone that extraction ships', async () => {
  const source = await openStore('idbots-kndel-src-');
  const bot = createBot(source.metabotStore, 'kndel-bot', TEST_GID);
  const knowledgeStore = new MetaIDKnowledgeStore(source.db, source.sqliteStore.getSaveFunction());
  const now = Date.now();
  source.db.run(
    `INSERT INTO metaid_knowledge_entries (id, metabot_id, topic, topic_fingerprint, summary, kind, confidence, status, origin, version, created_at, updated_at)
     VALUES ('kn-del', ?, 'obsolete fact', 'tfp-obs', 'no longer true', 'know_how', 0.6, 'active', 'dream', 1, ?, ?)`,
    [bot.id, now, now],
  );

  assert.equal(knowledgeStore.deleteKnowledge({ id: 'kn-del', metabotId: bot.id }), true);
  const ledger = listChainBackupTombstones(source.db, bot.id);
  assert.deepEqual(ledger.map((row) => `${row.kind}:${row.ref}`), ['knowledge:kn-del']);

  const objects = extractBackupObjects(source.db, bot.id, null);
  const tombstone = objects.find((o) => o.kind === 'knowledge_tombstone');
  assert.ok(tombstone, 'extraction ships the hard-deleted knowledge tombstone');
  assert.equal(tombstone.data.ref, 'kn-del');
  assert.ok(!objects.some((o) => o.kind === 'knowledge'));

  // And on the restore side the tombstone suppresses the stale live snapshot.
  const resolved = selectLatestBackupObjects([
    { id: 'old-kn', kind: 'knowledge', data: { id: 'kn-del', summary: 'no longer true' } },
    tombstone,
  ]);
  assert.equal(resolved.length, 0);
});
