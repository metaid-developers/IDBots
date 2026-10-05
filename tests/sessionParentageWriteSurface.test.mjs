import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

import { getSqlJs } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);
let mockedUserDataPath = process.cwd();

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

async function createStore() {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-session-parentage-'));
  const dbPath = path.join(userDataPath, 'test.sqlite');
  const store = new (loadCompiledModule('../dist-electron/main/sqliteStore.js').SqliteStore)(db, dbPath);
  store.initializeTables(userDataPath);
  const { CoworkStore } = loadCompiledModule('../dist-electron/main/coworkStore.js');
  return { coworkStore: new CoworkStore(db, () => {}), cleanup: () => fs.rmSync(userDataPath, { recursive: true, force: true }) };
}

test('createSession persists parentSessionId at creation time', async () => {
  const { coworkStore, cleanup } = await createStore();
  try {
    const parent = coworkStore.createSession('parent', '/tmp', '', 'local');
    const child = coworkStore.createSession('child', '/tmp', '', 'local', [], null, 'standard', null, null, null, 'default', null, null, null, null, null, parent.id);
    assert.equal(child.parentSessionId, parent.id);
    assert.equal(coworkStore.getSession(child.id).parentSessionId, parent.id);
  } finally {
    cleanup();
  }
});

test('default createSession leaves parentSessionId empty (no guessing)', async () => {
  const { coworkStore, cleanup } = await createStore();
  try {
    const s = coworkStore.createSession('manual', '/tmp', '', 'local');
    assert.equal(s.parentSessionId ?? null, null);
    assert.equal(coworkStore.getSession(s.id).parentSessionId ?? null, null);
  } finally {
    cleanup();
  }
});

test('fork inherits the source session as runtime-causal parent', async () => {
  const { coworkStore, cleanup } = await createStore();
  try {
    const source = coworkStore.createSession('source', '/tmp', '', 'local');
    coworkStore.addMessage(source.id, { role: 'human', content: 'hi', type: 'chat', metadata: null, timestamp: Date.now(), sequence: 1 });
    const messages = coworkStore.getSessionMessages(source.id);
    const forked = coworkStore.forkSession(source.id, messages[messages.length - 1].id);
    assert.equal(forked.parentSessionId, source.id);
  } finally {
    cleanup();
  }
});
