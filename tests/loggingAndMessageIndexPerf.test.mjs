import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { formatCoworkLogEntry } = require('../dist-electron/main/libs/coworkLogger.js');

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

test('CoworkStore drops redundant prefix indexes once composite window indexes exist and skips redundant saveDb calls on warm init', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-msg-idx-perf-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const db = sqliteStore.getDatabase();
    let saveCalls = 0;
    const coworkStore = new CoworkStore(db, () => {
      saveCalls += 1;
    });
    assert.ok(saveCalls > 0);

    const indexNames = new Set(
      (db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'cowork_messages'")[0]?.values ?? [])
        .map((row) => String(row[0])),
    );
    assert.ok(indexNames.has('idx_cowork_messages_session_created_sequence'));
    assert.ok(indexNames.has('idx_cowork_messages_session_sequence_created'));
    assert.ok(indexNames.has('idx_cowork_messages_session_sequence'));
    assert.equal(indexNames.has('idx_cowork_messages_session_id'), false, 'redundant single-col prefix index dropped');
    assert.equal(indexNames.has('idx_cowork_messages_session_created_at'), false, 'redundant 2-col prefix index dropped');

    let warmSaveCalls = 0;
    new CoworkStore(db, () => {
      warmSaveCalls += 1;
    }, { deferHeavyStartupMaintenance: true });
    assert.equal(warmSaveCalls, 0, 'warm CoworkStore init with all indexes present must not call saveDb()');
  } finally {
    disposeStore(sqliteStore, dir);
  }
});

test('coworkLogger formats structured entries and StudioLiveStage suppresses per-message dev console.warn spam', () => {
  const formatted = formatCoworkLogEntry('INFO', 'perf:test', 'hello', { latencyMs: 12 });
  assert.match(formatted, /\[INFO\] \[perf:test\] hello/);
  assert.match(formatted, /latencyMs: 12/);

  const stageSource = fs.readFileSync(
    path.resolve(import.meta.dirname, '..', 'src/main/services/studioLiveStageService.ts'),
    'utf8',
  );
  assert.doesNotMatch(stageSource, /process\.env\.NODE_ENV === 'development'[\s\S]{0,120}observe \$\{sessionId\}/);
  assert.match(stageSource, /process\.env\.IDBOTS_DEBUG_LIVE_STAGE === '1'/);
});
