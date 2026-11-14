import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

function disposeStore(sqliteStore, dir) {
  try {
    sqliteStore.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows handle tolerance
  }
}

test('CoworkStore.getSessionSummary matches listSessions fields and returns null for archived or hidden rows', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-summary-delta-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction());

    const s1 = coworkStore.createSession('Delta Session', '/tmp/proj', '', 'local', [], null);
    coworkStore.addMessage(s1.id, { type: 'user', content: 'ping' });

    const single = coworkStore.getSessionSummary(s1.id, { omitInlinePeerDataAvatar: true });
    const fromList = coworkStore.listSessions({ omitInlinePeerDataAvatar: true }).find((s) => s.id === s1.id);
    assert.deepEqual(single, fromList);

    coworkStore.archiveSession(s1.id);
    assert.equal(coworkStore.getSessionSummary(s1.id), null);
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
