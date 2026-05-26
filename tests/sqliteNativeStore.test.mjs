import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlite-native-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', bossId = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
      name, avatar, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
      role, soul, goal, background, boss_id, boss_global_metaid, llm_id, tools, skills, allow_chat_skills,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      walletId,
      `mvc-${id}`,
      `btc-${id}`,
      `doge-${id}`,
      `public-${id}`,
      `chat-public-${id}`,
      null,
      name,
      null,
      1,
      `metaid-${id}`,
      `globalmetaid-${id}`,
      null,
      type,
      '0000',
      `${name} role`,
      `${name} soul`,
      null,
      null,
      bossId,
      null,
      'openai',
      '[]',
      '[]',
      '[]',
      1700000000000 + id,
      1700000000000 + id,
    ]
  );
};

test('SqliteStore uses native sqlite by default and persists without sql.js export', async () => {
  const { SqliteStore } = require('../dist-electron/sqliteStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  assert.equal(store.getBackendKind(), 'native');
  store.set('native-store-test', { ok: true });
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  assert.equal(reopened.getBackendKind(), 'native');
  assert.deepEqual(reopened.get('native-store-test'), { ok: true });
  reopened.close();
});

test('native sqlite adapter preserves sql.js exec and row-change behavior', async () => {
  const { SqliteStore } = require('../dist-electron/sqliteStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();

  db.run('CREATE TABLE adapter_test (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)');
  db.run('INSERT INTO adapter_test (name) VALUES (?)', ['alpha']);
  assert.equal(db.getRowsModified(), 1);

  const inserted = db.exec('SELECT last_insert_rowid() AS id');
  assert.equal(inserted[0].columns[0], 'id');
  assert.equal(inserted[0].values[0][0], 1);

  const rows = db.exec('SELECT id, name FROM adapter_test WHERE id = ?', [1]);
  assert.deepEqual(rows, [{
    columns: ['id', 'name'],
    values: [[1, 'alpha']],
  }]);

  store.close();
});

test('SqliteStore.create() clears orphan MetaBot boss ids before native FK updates', async () => {
  const { SqliteStore } = require('../dist-electron/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/metabotStore.js');
  const tempDir = makeTempDir();

  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  db.run('PRAGMA foreign_keys = OFF');
  insertWallet(db, 5);
  insertWallet(db, 7);
  insertMetabot(db, { id: 5, walletId: 5, name: 'AI WuFenG', bossId: 1 });
  insertMetabot(db, { id: 6, walletId: 7, name: 'Twin Bot', bossId: 1 });
  db.run('PRAGMA foreign_keys = ON');
  store.close();

  const reopened = await SqliteStore.create(tempDir);
  const rows = reopened.getDatabase().exec('SELECT id, boss_id FROM metabots ORDER BY id ASC')[0].values;
  assert.deepEqual(rows, [[5, null], [6, null]]);

  const metabotStore = new MetabotStore(reopened.getDatabase(), reopened.getSaveFunction());
  const updated = metabotStore.updateMetabot(6, { name: 'Twin Bot edited', boss_id: 1 });
  assert.equal(updated?.boss_id, null);
  assert.equal(updated?.name, 'Twin Bot edited');
  reopened.close();
});

test('deleting a MetaBot clears child boss ids instead of failing FK constraints', async () => {
  const { SqliteStore } = require('../dist-electron/sqliteStore.js');
  const { MetabotStore } = require('../dist-electron/metabotStore.js');
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  insertWallet(db, 1);
  insertWallet(db, 2);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Boss Bot', type: 'twin' });
  insertMetabot(db, { id: 2, walletId: 2, name: 'Worker Bot', bossId: 1 });

  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  assert.equal(metabotStore.deleteMetabot(1), true);

  const childBossId = db.exec('SELECT boss_id FROM metabots WHERE id = 2')[0].values[0][0];
  assert.equal(childBossId, null);
  store.close();
});
