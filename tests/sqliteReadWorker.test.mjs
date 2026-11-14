import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { collectDailyReportFacts, createDailyReportDbAccessor } = require('../dist-electron/main/services/dailyReportCollector.js');

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

test('SqliteReadWorker executes archived session search and daily report collection off-main-thread with clean teardown', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-read-worker-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    const coworkStore = new CoworkStore(db, sqliteStore.getSaveFunction());

    const active = coworkStore.createSession('Active Work', '/tmp', '', 'local', [], null);
    coworkStore.addMessage(active.id, { type: 'user', content: 'implement worker offload' });
    coworkStore.addMessage(active.id, { type: 'assistant', content: 'done on worker thread' });

    const archived = coworkStore.createSession('Archived Secret Note', '/tmp', '', 'local', [], null);
    coworkStore.addMessage(archived.id, { type: 'user', content: 'unique-needle-4299 in body' });
    coworkStore.archiveSession(archived.id);

    const readWorker = sqliteStore.getReadWorker();
    assert.ok(readWorker, 'native file-backed SqliteStore must expose a SqliteReadWorker');

    const page = await coworkStore.listArchivedSessionsPageAsync(
      { query: 'unique-needle-4299', searchContent: true, limit: 20, offset: 0 },
      readWorker,
    );
    assert.equal(page.total, 1);
    assert.equal(page.sessions.length, 1);
    assert.equal(page.sessions[0].id, archived.id);

    const nowMs = Date.now() + 1000;
    const windowStartMs = nowMs - 86_400_000;
    const workerFacts = await readWorker.collectDailyReportFacts({
      windowStartMs,
      windowEndMs: nowMs,
      twinId: 1,
    });
    const directFacts = collectDailyReportFacts({
      db: createDailyReportDbAccessor(db),
      windowStartMs,
      windowEndMs: nowMs,
      twinId: 1,
    });
    assert.ok(workerFacts);
    assert.equal(workerFacts.hasAnyActivity, directFacts.hasAnyActivity);
    assert.equal(workerFacts.newSessionCount, directFacts.newSessionCount);
    assert.deepEqual(workerFacts.humanSessions, directFacts.humanSessions);

    await assert.rejects(
      () => readWorker.queryAll("INSERT INTO kv (key, value, updated_at) VALUES ('forbidden', '1', 1)"),
      /readonly|read-only/i,
    );
  } finally {
    disposeStore(sqliteStore, dir);
  }
});
