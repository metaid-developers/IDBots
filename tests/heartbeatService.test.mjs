import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Module = require('node:module');
const { DB_FILENAME } = require('../dist-electron/appConstants.js');

function resolveRepoRoot() {
  let current = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  while (true) {
    const candidateWasm = path.join(current, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (fs.existsSync(candidateWasm)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Failed to resolve repo root for heartbeatService tests');
    }
    current = parent;
  }
}

const repoRoot = resolveRepoRoot();

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
    // Each row: [cid, name, type, notnull, dflt_value, pk]
    const result = db.exec('PRAGMA table_info(metabots)');
    const rows = result[0]?.values || [];
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

// ── HeartbeatService class unit tests ──

import { describe, it } from 'node:test';

async function loadHeartbeatService() {
  const mod = await import('../dist-electron/services/heartbeatService.js');
  return mod.HeartbeatService;
}

function mockCreatePin() {
  const calls = [];
  const fn = async (store, metabotId, data, options) => {
    calls.push({ store, metabotId, data, options });
    return { txids: ['tx1'], pinId: 'pin1', totalCost: 100 };
  };
  return { fn, calls };
}

describe('HeartbeatService', () => {
  it('startHeartbeat registers an active timer', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(1);
    assert.equal(svc.isActive(1), true);
    assert.equal(svc.activeCount(), 1);
    svc.stopAll();
  });

  it('fires createPin immediately on start', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn, calls } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(42);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(calls.length >= 1);
    assert.equal(calls[0].metabotId, 42);
    svc.stopAll();
  });

  it('passes correct heartbeat pin parameters', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn, calls } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(1);
    await new Promise(r => setTimeout(r, 50));
    const c = calls[0];
    assert.equal(c.data.path, '/protocols/metabot-heartbeat');
    assert.equal(c.data.contentType, 'text/plain');
    assert.equal(c.data.payload, '');
    assert.equal(c.options.network, 'mvc');
    svc.stopAll();
  });

  it('stopHeartbeat clears the timer', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(1);
    svc.stopHeartbeat(1);
    assert.equal(svc.isActive(1), false);
  });

  it('stopAll clears all timers', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(1);
    svc.startHeartbeat(2);
    assert.equal(svc.activeCount(), 2);
    svc.stopAll();
    assert.equal(svc.activeCount(), 0);
  });

  it('replaces existing timer for same metabotId', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn } = mockCreatePin();
    const svc = new HeartbeatService({ createPin: fn });
    svc.startHeartbeat(1);
    svc.startHeartbeat(1);
    assert.equal(svc.activeCount(), 1);
    svc.stopAll();
  });

  it('createPin errors do not crash the service', async () => {
    const HeartbeatService = await loadHeartbeatService();
    let n = 0;
    const svc = new HeartbeatService({ createPin: async () => { n++; throw new Error('fail'); } });
    svc.startHeartbeat(1);
    await new Promise(r => setTimeout(r, 50));
    assert.ok(n >= 1);
    assert.equal(svc.isActive(1), true);
    svc.stopAll();
  });

  it('passes getMetabotStore to createPin', async () => {
    const HeartbeatService = await loadHeartbeatService();
    const { fn, calls } = mockCreatePin();
    const store = { id: 'mock' };
    const svc = new HeartbeatService({ createPin: fn, getMetabotStore: () => store });
    svc.startHeartbeat(1);
    await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(calls[0].store, store);
    svc.stopAll();
  });
});
