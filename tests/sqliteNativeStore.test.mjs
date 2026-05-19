import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlite-native-'));

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
