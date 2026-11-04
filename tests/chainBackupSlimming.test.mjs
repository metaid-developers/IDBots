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
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { deriveBackupKey, decryptBytes, objectId } = require('../dist-electron/main/services/chainBackupCrypto.js');
const { extractBackupObjects, importBackupObjects } = require('../dist-electron/main/services/chainBackupData.js');
const { buildObjectPinContent } = require('../dist-electron/main/services/chainBackupSegments.js');
const { CHAIN_BACKUP_ENCODING_GZIP } = require('../dist-electron/main/services/chainBackupProtocol.js');

/**
 * Chain-backup slimming: conversation rows are trimmed (tool-result metadata
 * duplicate dropped, oversized tool inputs/results capped, inline base64 data
 * URIs stripped) and segment payloads are gzip-compressed before encryption.
 * Run `pnpm run compile:electron` first.
 */

const TEST_MNEMONIC = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
const TEST_GID = 'idqtestglobalmetaid00000000000000000000001';

async function openStore(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sqliteStore = await SqliteStore.create(dir);
  const db = sqliteStore.getDatabase();
  const save = sqliteStore.getSaveFunction();
  new MetaIDKnowledgeStore(db, save);
  new DreamStore(db, save);
  new CoworkStore(db, save, { deferHeavyStartupMaintenance: true });
  const metabotStore = new MetabotStore(db, save);
  return { sqliteStore, db, metabotStore, dir };
}

function createBot(metabotStore, name, gid) {
  const wallet = metabotStore.insertMetabotWallet({ mnemonic: TEST_MNEMONIC, path: "m/44'/10001'/0'/0/0" });
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

function insertSession(db, metabotId, id, now) {
  db.run(
    `INSERT INTO cowork_sessions (id, title, cwd, metabot_id, created_at, updated_at)
     VALUES (?, 'session', '/tmp', ?, ?, ?)`,
    [id, metabotId, now, now],
  );
}

test('conversation extraction drops the toolResult metadata duplicate and caps bulky rows', async () => {
  const source = await openStore('idbots-slim-src-');
  const bot = createBot(source.metabotStore, 'slim-bot', TEST_GID);
  const db = source.db;
  const now = Date.now();
  insertSession(db, bot.id, 'sess-1', now);

  const bigResult = 'r'.repeat(50 * 1024);
  const bigInput = { command: 'run', script: 'x'.repeat(20 * 1024) };
  const bigAssistant = 'a'.repeat(100 * 1024);
  const dataUri = `data:image/png;base64,${'A'.repeat(4096)}`;

  db.run(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES ('m-result', 'sess-1', 'tool_result', ?, ?, ?, 1)`,
    [bigResult, JSON.stringify({ toolResult: bigResult, toolUseId: 'call-1', isError: false }), now],
  );
  db.run(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES ('m-use', 'sess-1', 'tool_use', 'Using tool: bash', ?, ?, 2)`,
    [JSON.stringify({ toolName: 'bash', toolInput: bigInput, toolUseId: 'call-1' }), now],
  );
  db.run(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES ('m-assistant', 'sess-1', 'assistant', ?, NULL, ?, 3)`,
    [bigAssistant, now],
  );
  db.run(
    `INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence)
     VALUES ('m-image', 'sess-1', 'user', ?, NULL, ?, 4)`,
    [`look at this\n![img](${dataUri})`, now],
  );

  const objects = extractBackupObjects(db, bot.id, null, { now });
  const messages = new Map(
    objects.filter((o) => o.kind === 'conversation_message').map((o) => [o.data.id, o.data]),
  );
  assert.equal(messages.size, 4);

  const result = messages.get('m-result');
  assert.ok(Buffer.byteLength(String(result.content), 'utf8') <= 8 * 1024 + 128, 'tool_result content is capped');
  assert.match(String(result.content), /chain-backup: truncated/);
  const resultMeta = JSON.parse(String(result.metadata));
  assert.equal('toolResult' in resultMeta, false, 'metadata.toolResult duplicate is dropped');
  assert.equal(resultMeta.toolUseId, 'call-1', 'other metadata survives');

  const use = messages.get('m-use');
  const useMeta = JSON.parse(String(use.metadata));
  assert.equal(useMeta.toolName, 'bash');
  assert.equal(useMeta.toolInput.backupTrimmed, true, 'oversized toolInput is replaced by a trim marker');
  assert.ok(useMeta.toolInput.originalBytes > 20 * 1024);
  assert.ok(Buffer.byteLength(String(use.metadata), 'utf8') < 4 * 1024);

  const assistant = messages.get('m-assistant');
  assert.ok(Buffer.byteLength(String(assistant.content), 'utf8') <= 64 * 1024 + 128, 'assistant content is capped');
  assert.match(String(assistant.content), /chain-backup: truncated/);

  const image = messages.get('m-image');
  assert.ok(!String(image.content).includes('base64,AAAA'), 'inline base64 payload is stripped');
  assert.match(String(image.content), /binary payload omitted from chain backup/);

  // The slimmed objects import cleanly into a fresh DB.
  const target = await openStore('idbots-slim-dst-');
  const dstBot = createBot(target.metabotStore, 'dst-bot', TEST_GID);
  const { errors } = importBackupObjects(target.db, dstBot.id, objects);
  assert.deepEqual(errors, []);
  const restored = target.db.exec(`SELECT content, metadata FROM cowork_messages WHERE id = 'm-result'`);
  assert.equal(restored.length, 1);
  assert.equal(JSON.parse(restored[0].values[0][1]).toolUseId, 'call-1');
});

test('segment pin payloads are gzip-compressed and round-trip through decrypt+gunzip', () => {
  const key = deriveBackupKey(TEST_MNEMONIC, TEST_GID);
  const plaintext = {
    version: 1,
    bot: TEST_GID,
    createdAt: 1234567890,
    objects: [
      { id: 'obj-1', kind: 'setting', data: { key: 'k', value: 'v'.repeat(4096) } },
    ],
  };
  const content = JSON.parse(buildObjectPinContent(key, TEST_GID, plaintext, 'seg-key'));
  assert.equal(content.encoding, CHAIN_BACKUP_ENCODING_GZIP);
  assert.equal(content.segment, objectId(plaintext));
  assert.equal(content.segmentKey, 'seg-key');

  const decrypted = decryptBytes(key, Buffer.from(content.payload, 'base64'));
  const decoded = JSON.parse(zlib.gunzipSync(decrypted).toString('utf8'));
  assert.deepEqual(decoded, plaintext);
  assert.equal(objectId(decoded), content.segment, 'segment hash still covers the plaintext');

  // Compression actually compresses: a repetitive 4KB object ships far smaller
  // than the plaintext JSON.
  const plaintextBytes = Buffer.byteLength(JSON.stringify(plaintext), 'utf8');
  assert.ok(decrypted.length < plaintextBytes / 2, `compressed ${decrypted.length} vs plaintext ${plaintextBytes}`);
});
