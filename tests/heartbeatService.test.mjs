import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const { DB_FILENAME } = require('../dist-electron/appConstants.js');

const worktreeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// Worktree is at <repoRoot>/.claude/worktrees/<name>/ — go up 3 levels to reach the repo root
const repoRoot = path.resolve(worktreeRoot, '..', '..', '..');

function patchElectron(userDataPath) {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => repoRoot,
          getPath: () => userDataPath,
        },
      };
    }
    return originalLoad(request, parent, isMain);
  };
  return originalLoad;
}

function getColumns(db, tableName) {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
}

test('SqliteStore adds heartbeat_enabled column to metabots table on initialization', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-heartbeat-migration-'));
  const originalLoad = patchElectron(userDataPath);
  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();

    const columns = getColumns(db, 'metabots');
    assert(
      columns.includes('heartbeat_enabled'),
      `Expected metabots table to have heartbeat_enabled column, got: ${columns.join(', ')}`
    );
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('heartbeat_enabled column defaults to 0 in metabots table', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-heartbeat-default-'));
  const originalLoad = patchElectron(userDataPath);
  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();

    // Inspect the column default via PRAGMA table_info
    const result = db.exec('PRAGMA table_info(metabots)');
    const rows = result[0]?.values || [];
    // Each row: [cid, name, type, notnull, dflt_value, pk]
    const hbRow = rows.find((row) => String(row[1]) === 'heartbeat_enabled');
    assert(hbRow != null, 'heartbeat_enabled column not found in metabots table');

    const dfltValue = hbRow[4]; // dflt_value field
    assert.equal(
      String(dfltValue),
      '0',
      `Expected heartbeat_enabled default to be 0, got: ${dfltValue}`
    );
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});

test('heartbeat_enabled migration is idempotent — second SqliteStore.create does not throw', async () => {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-heartbeat-idempotent-'));
  const originalLoad = patchElectron(userDataPath);
  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');

    // First init
    const store1 = await SqliteStore.create(userDataPath);
    store1.getDatabase(); // ensure it's usable

    // Second init against the same DB — should not throw
    await assert.doesNotReject(
      () => SqliteStore.create(userDataPath),
      'Second SqliteStore.create should not throw when heartbeat_enabled already exists'
    );
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
