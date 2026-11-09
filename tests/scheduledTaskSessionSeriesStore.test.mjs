import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function getScheduledTaskStoreClass() {
  return require('../dist-electron/main/scheduledTaskStore.js').ScheduledTaskStore;
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Daily digest',
    description: '',
    schedule: { type: 'cron', expression: '0 9 * * *' },
    prompt: 'Write the digest',
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

async function createStore() {
  const ScheduledTaskStore = getScheduledTaskStoreClass();
  const { db, cleanup } = await createSqliteStore();
  const store = new ScheduledTaskStore(db, () => {});
  return { store, db, cleanup };
}

test('ScheduledTaskStore adds the session series columns and defaults sessionMode to series', async () => {
  const { store, db, cleanup } = await createStore();
  try {
    const columns = db
      .exec('PRAGMA table_info(scheduled_tasks);')[0].values
      .map((row) => String(row[1]));
    assert.ok(columns.includes('session_mode'), 'missing session_mode column');
    assert.ok(columns.includes('series_session_id'), 'missing series_session_id column');

    const task = store.createTask(createTaskInput());
    assert.equal(task.sessionMode, 'series', 'absent mode stores as series');
    assert.equal(task.seriesSessionId, null);
  } finally {
    cleanup();
  }
});

test('sessionMode "fresh" persists and round-trips', async () => {
  const { store, cleanup } = await createStore();
  try {
    const task = store.createTask(createTaskInput({ sessionMode: 'fresh' }));
    assert.equal(task.sessionMode, 'fresh');

    const updated = store.updateTask(task.id, { sessionMode: 'series' });
    assert.equal(updated.sessionMode, 'series');
    // An unknown value is rejected at the seams; a direct store-level absent
    // value keeps the stored one.
    const kept = store.updateTask(task.id, { description: 'x' });
    assert.equal(kept.sessionMode, 'series');
  } finally {
    cleanup();
  }
});

test('switching the session mode keeps the standing-conversation pointer', async () => {
  const { store, cleanup } = await createStore();
  try {
    const task = store.createTask(createTaskInput());
    store.setSeriesSessionId(task.id, 'session-1');
    const toFresh = store.updateTask(task.id, { sessionMode: 'fresh' });
    assert.equal(toFresh.seriesSessionId, 'session-1', 'mode switch keeps the pointer');
    const back = store.updateTask(task.id, { sessionMode: 'series' });
    assert.equal(back.seriesSessionId, 'session-1');
  } finally {
    cleanup();
  }
});

test('a metabot change resets every session binding, the standing conversation included', async () => {
  const { store, cleanup } = await createStore();
  try {
    const task = store.createTask(createTaskInput({ targetSessionId: 'bound-1' }));
    store.setSeriesSessionId(task.id, 'session-1');

    const moved = store.updateTask(task.id, { metabotId: 2 });
    assert.equal(moved.targetSessionId, null);
    assert.equal(moved.coworkSessionId, null);
    assert.equal(moved.seriesSessionId, null);
    // The mode itself is a task property, not a bot binding.
    assert.equal(moved.sessionMode, 'series');
  } finally {
    cleanup();
  }
});

test('setSeriesSessionId persists and getLatestRunSessionId returns the newest session-bearing run', async () => {
  const { store, cleanup } = await createStore();
  try {
    const task = store.createTask(createTaskInput());

    assert.equal(store.getLatestRunSessionId(task.id), null);

    const runA = store.createRun(task.id, 'scheduled');
    store.completeRun(runA.id, 'success', 'session-a', 10, null);
    const runB = store.createRun(task.id, 'scheduled');
    store.completeRun(runB.id, 'success', 'session-b', 10, null);
    // An in-flight run has no session yet and must not shadow the latest one.
    store.createRun(task.id, 'scheduled');

    assert.equal(store.getLatestRunSessionId(task.id), 'session-b');

    store.setSeriesSessionId(task.id, 'session-b');
    assert.equal(store.getTask(task.id).seriesSessionId, 'session-b');
    store.setSeriesSessionId(task.id, '  ');
    assert.equal(store.getTask(task.id).seriesSessionId, null, 'blank clears the pointer');
  } finally {
    cleanup();
  }
});
