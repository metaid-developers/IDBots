import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import {
  createSqliteStore,
  getColumns,
  getCompiledStores,
  getSqlJs,
} from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getScheduledTaskStoreClass() {
  return require('../dist-electron/scheduledTaskStore.js').ScheduledTaskStore;
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Recurring task',
    description: '',
    schedule: { type: 'cron', expression: '*/5 * * * *' },
    prompt: 'Run this task',
    workingDirectory: process.cwd(),
    systemPrompt: '',
    executionMode: 'local',
    metabotId: 1,
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
    ...overrides,
  };
}

test('ScheduledTaskStore preserves task cowork session until execution MetaBot changes', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getScheduledTaskStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});
    const task = store.createTask(createTaskInput());

    assert.equal(task.coworkSessionId, null);

    store.setTaskSessionId(task.id, 'session-a');
    assert.equal(store.getTaskSessionId(task.id), 'session-a');
    assert.equal(store.getTask(task.id).coworkSessionId, 'session-a');

    const renamed = store.updateTask(task.id, { name: 'Renamed recurring task' });
    assert.equal(renamed.coworkSessionId, 'session-a');

    const sameBot = store.updateTask(task.id, { metabotId: 1 });
    assert.equal(sameBot.coworkSessionId, 'session-a');

    const changedBot = store.updateTask(task.id, { metabotId: 2 });
    assert.equal(changedBot.coworkSessionId, null);
    assert.equal(store.getTaskSessionId(task.id), null);
  } finally {
    cleanup();
  }
});

test('SqliteStore migration adds cowork_session_id to legacy scheduled task tables', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const { SqliteStore } = getCompiledStores();
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-scheduled-task-store-'));
  const dbPath = path.join(userDataPath, 'test.sqlite');

  try {
    db.run(`
      CREATE TABLE scheduled_tasks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        schedule_json TEXT NOT NULL,
        prompt TEXT NOT NULL,
        working_directory TEXT NOT NULL DEFAULT '',
        system_prompt TEXT NOT NULL DEFAULT '',
        execution_mode TEXT NOT NULL DEFAULT 'auto',
        metabot_id INTEGER,
        expires_at TEXT,
        notify_platforms_json TEXT NOT NULL DEFAULT '[]',
        next_run_at_ms INTEGER,
        last_run_at_ms INTEGER,
        last_status TEXT,
        last_error TEXT,
        last_duration_ms INTEGER,
        running_at_ms INTEGER,
        consecutive_errors INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const sqliteStore = new SqliteStore(db, dbPath);
    sqliteStore.initializeTables(userDataPath);

    assert.ok(getColumns(db, 'scheduled_tasks').includes('cowork_session_id'));
  } finally {
    db.close();
    fs.rmSync(userDataPath, { recursive: true, force: true });
  }
});
