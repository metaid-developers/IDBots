import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const initSqlJs = require('sql.js');
const Module = require('node:module');
const { DB_FILENAME } = require('../dist-electron/appConstants.js');

const worktreeRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function resolveRepoRoot() {
  let current = worktreeRoot;
  while (true) {
    const candidateWasm = path.join(current, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (fs.existsSync(candidateWasm)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Failed to resolve repo root for sqliteStore memory migration test');
    }
    current = parent;
  }
}

const repoRoot = resolveRepoRoot();
const sqlWasmPath = path.join(repoRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

function getColumns(db, tableName) {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
}

function getIndexNames(db, tableName) {
  const result = db.exec(`PRAGMA index_list(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
}

test('SqliteStore.create() upgrades legacy user_memories scope columns before creating scoped indexes', async () => {
  const legacyDb = await createSqlDatabase();
  legacyDb.run(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  legacyDb.run(`
    CREATE TABLE metabots (
      id INTEGER PRIMARY KEY,
      name TEXT,
      avatar TEXT,
      metabot_type TEXT
    );
  `);
  legacyDb.run(`
    INSERT INTO metabots (id, name, avatar, metabot_type)
    VALUES (1, 'Twin', NULL, 'twin');
  `);
  legacyDb.run(`
    CREATE TABLE user_memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.75,
      is_explicit INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'created',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);

  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-sqlitestore-memory-scope-'));
  const dbPath = path.join(userDataPath, DB_FILENAME);
  fs.writeFileSync(dbPath, Buffer.from(legacyDb.export()));

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

  try {
    const { SqliteStore } = require('../dist-electron/sqliteStore.js');
    const sqliteStore = await SqliteStore.create(userDataPath);
    const db = sqliteStore.getDatabase();

    const columns = getColumns(db, 'user_memories');
    assert(columns.includes('scope_kind'));
    assert(columns.includes('scope_key'));
    assert(columns.includes('usage_class'));
    assert(columns.includes('visibility'));

    const indexNames = getIndexNames(db, 'user_memories');
    assert(indexNames.includes('idx_user_memories_scope_status_updated'));
    assert(indexNames.includes('idx_user_memories_scope_fingerprint'));
    assert(indexNames.includes('idx_user_memories_usage_visibility'));
  } finally {
    Module._load = originalLoad;
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
