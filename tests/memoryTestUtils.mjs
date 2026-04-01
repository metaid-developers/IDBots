import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import initSqlJs from 'sql.js';

const require = Module.createRequire(import.meta.url);

let sqlPromise = null;
let mockedUserDataPath = process.cwd();
let compiledModules = null;

function findNearestNodeModules(startDir = process.cwd()) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const candidate = path.join(currentDir, 'node_modules');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Unable to locate node_modules from ${startDir}`);
    }
    currentDir = parentDir;
  }
}

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => mockedUserDataPath,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

export async function getSqlJs() {
  if (!sqlPromise) {
    const nodeModulesDir = findNearestNodeModules();
    sqlPromise = initSqlJs({
      locateFile: (file) => path.join(nodeModulesDir, 'sql.js/dist', file),
    });
  }
  return sqlPromise;
}

export function getCompiledStores() {
  if (!compiledModules) {
    compiledModules = {
      ...loadCompiledModule('../dist-electron/coworkStore.js'),
      ...loadCompiledModule('../dist-electron/sqliteStore.js'),
    };
  }
  return compiledModules;
}

export async function createLegacyMemoryDb() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();

  db.run(`
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE metabots (
      id INTEGER PRIMARY KEY,
      name TEXT,
      avatar TEXT,
      metabot_type TEXT
    );
  `);
  db.run(`
    INSERT INTO metabots (id, name, avatar, metabot_type)
    VALUES (1, 'Twin', NULL, 'twin');
  `);

  db.run(`
    CREATE TABLE cowork_sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      pinned INTEGER NOT NULL DEFAULT 0,
      cwd TEXT NOT NULL,
      system_prompt TEXT NOT NULL DEFAULT '',
      execution_mode TEXT,
      active_skill_ids TEXT,
      metabot_id INTEGER,
      session_type TEXT NOT NULL DEFAULT 'standard',
      peer_global_metaid TEXT,
      peer_name TEXT,
      peer_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE user_memories (
      id TEXT PRIMARY KEY,
      metabot_id INTEGER,
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

  db.run(`
    CREATE TABLE user_memory_sources (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      metabot_id INTEGER,
      session_id TEXT,
      source_channel TEXT,
      source_type TEXT,
      external_conversation_id TEXT,
      source_id TEXT,
      message_id TEXT,
      role TEXT NOT NULL DEFAULT 'system',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE cowork_conversation_mappings (
      channel TEXT NOT NULL,
      external_conversation_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL DEFAULT 0,
      cowork_session_id TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL,
      last_active_at INTEGER NOT NULL,
      PRIMARY KEY (channel, external_conversation_id, metabot_id)
    );
  `);

  return db;
}

export function createCoworkStore(db) {
  const { CoworkStore } = getCompiledStores();
  return new CoworkStore(db, () => {});
}

export async function createSqliteStore() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { SqliteStore } = getCompiledStores();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-memory-store-'));
  mockedUserDataPath = userDataPath;
  const dbPath = path.join(userDataPath, 'test.sqlite');
  const store = new SqliteStore(db, dbPath);
  store.initializeTables(userDataPath);
  return {
    db,
    store,
    userDataPath,
    cleanup: () => fs.rmSync(userDataPath, { recursive: true, force: true }),
  };
}

export function getColumns(db, tableName) {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
}

export function getRow(db, sql, params = []) {
  const result = db.exec(sql, params);
  if (!result[0]?.values?.[0]) {
    return null;
  }
  const columns = result[0].columns;
  const values = result[0].values[0];
  return Object.fromEntries(columns.map((column, index) => [column, values[index]]));
}

export function getIndexNames(db, tableName) {
  const result = db.exec(`PRAGMA index_list(${tableName})`);
  return (result[0]?.values || []).map((row) => String(row[1]));
}
