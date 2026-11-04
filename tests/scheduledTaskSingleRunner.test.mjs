/**
 * Single-runner guarantee for scheduled tasks.
 *
 * Two independent defects used to let one due task execute twice:
 *  A. the fire path claimed with an unconditional UPDATE, so any second writer
 *     (another host process sharing the SQLite file) overwrote the marker and
 *     ran the same task;
 *  B. the orphan sweep treated this process's `activeTasks` map as the only
 *     liveness truth, so a marker owned by a LIVE foreign process was judged
 *     orphaned, released, and the task fired again.
 *
 * The fix is an atomic conditional claim in the store, a per-run heartbeat that
 * keeps `running_at_ms` fresh while a run is alive, and a lease rule in the
 * sweep. These tests cover each leg plus the timer lifecycle.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

// Mirrors the lease constant in src/main/libs/scheduler.ts. Kept as a literal
// on purpose: a test that imported the constant would keep passing after
// somebody shrank the lease to something that releases live runs.
const RUN_LIVENESS_LEASE_MS = 10 * 60_000;
// Mirrors Scheduler.RUN_HEARTBEAT_INTERVAL_MS.
const RUN_HEARTBEAT_INTERVAL_MS = 2 * 60_000;

function getStoreModule() {
  return require('../dist-electron/main/scheduledTaskStore.js');
}

function loadSchedulerWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        BrowserWindow: {
          getAllWindows: () => [],
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    // memoryTestUtils loads the stores with a narrower electron stub ({app}
    // only), and ipc/broadcast.js captures `electron` at module scope. Evict it
    // alongside the scheduler so it resolves against THIS stub on reload.
    delete require.cache[require.resolve('../dist-electron/main/ipc/broadcast.js')];
    const schedulerPath = require.resolve('../dist-electron/main/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createTaskInput(overrides = {}) {
  return {
    name: 'Single runner task',
    description: '',
    schedule: { type: 'interval', intervalMs: 60_000 },
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

function createTaskObject(overrides = {}) {
  return {
    id: 'task-1',
    name: 'Daily check',
    description: '',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 60_000 },
    prompt: 'Run the check',
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    metabotId: null,
    coworkSessionId: null,
    targetSessionId: null,
    expiresAt: null,
    notifyPlatforms: [],
    state: {
      nextRunAtMs: Date.now(),
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function withStore(fn) {
  const { db, store: sqliteStore, cleanup } = await createSqliteStore();
  const { ScheduledTaskStore } = getStoreModule();
  try {
    return await fn(new ScheduledTaskStore(db, sqliteStore.getSaveFunction()), db);
  } finally {
    cleanup();
  }
}

/**
 * Scheduler harness mirroring tests/schedulerTargetSession.test.mjs, plus the
 * claim/liveness seams this fix introduces. Every store write is recorded so a
 * test can assert not just the outcome but which path produced it.
 */
function createHarness({
  task = createTaskObject(),
  claimResults = [true],
  runningTasks = () => [],
  startSession,
} = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = {
    claims: [],
    touched: [],
    releasedTaskIds: [],
    skippedRuns: [],
    createdSessions: [],
    runnerCalls: [],
    completedRuns: [],
  };
  const runs = new Map();
  let runIndex = 0;
  let claimIndex = 0;

  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => runningTasks(),
      getTask: () => task,
      createRun: (taskId, trigger) => {
        const run = {
          id: `run-${++runIndex}`,
          taskId,
          sessionId: null,
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          error: null,
          trigger,
        };
        runs.set(run.id, run);
        return run;
      },
      tryMarkTaskRunning: (taskId, runningAtMs) => {
        recording.claims.push({ taskId, runningAtMs });
        const result = claimResults[Math.min(claimIndex, claimResults.length - 1)];
        claimIndex += 1;
        return result;
      },
      touchTaskRunning: (taskId, runningAtMs) => {
        recording.touched.push({ taskId, runningAtMs });
      },
      markTaskRunning: () => {},
      releaseStuckRunningTask: (taskId) => {
        recording.releasedTaskIds.push(taskId);
      },
      recordSkippedRun: (taskId, reason, trigger) => {
        const now = new Date().toISOString();
        const run = {
          id: `skip-${recording.skippedRuns.length + 1}`,
          taskId,
          sessionId: null,
          status: 'skipped',
          startedAt: now,
          finishedAt: now,
          durationMs: 0,
          error: null,
          trigger,
          skipReason: reason,
        };
        recording.skippedRuns.push(run);
        return run;
      },
      completeRun: (runId, status, sessionId, durationMs, error) => {
        const completed = { ...runs.get(runId), status, sessionId, durationMs, error };
        runs.set(runId, completed);
        recording.completedRuns.push(completed);
        return completed;
      },
      markTaskCompleted: () => {},
      toggleTask: () => {},
      pruneRuns: () => {},
      getRun: (runId) => runs.get(runId) ?? null,
      getTaskSessionId: () => null,
      setTaskSessionId: () => {},
    },
    coworkStore: {
      getConfig: () => ({
        workingDirectory: '/tmp',
        systemPrompt: '',
        executionMode: 'local',
      }),
      createSession: (title) => {
        recording.createdSessions.push(title);
        return { id: `session-${recording.createdSessions.length}` };
      },
      getSession: () => null,
      getSessionWithoutMessages: () => null,
      isSessionArchived: () => false,
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId) => {
        recording.runnerCalls.push(sessionId);
        if (startSession) return startSession(sessionId);
        return undefined;
      },
      stopSession: () => {},
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
  });

  return { scheduler, recording, task };
}

/**
 * Replaces the global interval primitives for one test so heartbeat timers are
 * countable and the callback is invocable without waiting two minutes.
 */
function withIntervalSpy() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const clearedHandles = new Set();
  const state = { started: 0, cleared: 0, callbacks: [], handles: [] };

  globalThis.setInterval = (callback, delayMs, ...rest) => {
    state.started += 1;
    state.callbacks.push({ callback, delayMs });
    const handle = { __spy: true, delayMs, callback };
    state.handles.push(handle);
    void rest;
    return handle;
  };
  globalThis.clearInterval = (handle) => {
    if (handle?.__spy) {
      // Count distinct handles: a stop() followed by the run's own finally may
      // legitimately clear the same timer twice, and that is not a leak.
      clearedHandles.add(handle);
      state.cleared = clearedHandles.size;
      return;
    }
    return originalClearInterval(handle);
  };

  return {
    state,
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

// --- Store: atomic claim -------------------------------------------------

test('tryMarkTaskRunning claims once and refuses to overwrite a held marker', async () => {
  await withStore(async (store) => {
    const task = store.createTask(createTaskInput());
    const firstClaimAt = Date.now();

    assert.equal(store.tryMarkTaskRunning(task.id, firstClaimAt), true);

    const secondClaimAt = firstClaimAt + 5_000;
    assert.equal(store.tryMarkTaskRunning(task.id, secondClaimAt), false);

    // The loser wrote nothing: the winner's marker survives verbatim.
    const claimed = store.getTask(task.id);
    assert.equal(claimed.state.runningAtMs, firstClaimAt);
    assert.equal(claimed.state.lastStatus, 'running');
    assert.notEqual(claimed.state.runningAtMs, secondClaimAt);

    // A held marker keeps the task out of the due set, which is what made the
    // duplicate race invisible in the first place.
    assert.deepEqual(store.getDueTasks(Date.now() + 120_000), []);
  });
});

test('tryMarkTaskRunning succeeds again after the marker is released or the run completes', async () => {
  await withStore(async (store) => {
    const task = store.createTask(createTaskInput());
    const dueAfter = () => store.getDueTasks(Date.now() + 120_000).map((due) => due.id);

    assert.equal(store.tryMarkTaskRunning(task.id, Date.now()), true);
    assert.deepEqual(dueAfter(), []);

    // Release path (orphan sweep).
    store.releaseStuckRunningTask(task.id);
    assert.deepEqual(dueAfter(), [task.id]);
    assert.equal(store.tryMarkTaskRunning(task.id, Date.now()), true);

    // Completion path (normal run end).
    store.markTaskCompleted(task.id, true, 1_000, null, task.schedule);
    assert.deepEqual(dueAfter(), [task.id]);
    assert.equal(store.tryMarkTaskRunning(task.id, Date.now()), true);
  });
});

test('touchTaskRunning refreshes a live marker but never resurrects a released one', async () => {
  await withStore(async (store) => {
    const task = store.createTask(createTaskInput());
    const claimedAt = Date.now();
    assert.equal(store.tryMarkTaskRunning(task.id, claimedAt), true);

    const refreshedAt = claimedAt + RUN_HEARTBEAT_INTERVAL_MS;
    store.touchTaskRunning(task.id, refreshedAt);
    assert.equal(store.getTask(task.id).state.runningAtMs, refreshedAt);

    // Once released, a late heartbeat from a dying run must not re-wedge the
    // task by putting the marker back.
    store.releaseStuckRunningTask(task.id);
    store.touchTaskRunning(task.id, refreshedAt + RUN_HEARTBEAT_INTERVAL_MS);
    assert.equal(store.getTask(task.id).state.runningAtMs, null);
    assert.deepEqual(store.getRunningTasks(), []);
  });
});

// --- Store: real cross-connection atomicity ------------------------------

test('two connections to one database file cannot both claim the same task', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    t.skip('node:sqlite is not available in this Node build');
    return;
  }

  // The authoritative table definitions come from the real store schema, so the
  // hand-built database cannot drift into something easier than production.
  const { db: schemaSource, cleanup } = await createSqliteStore();
  const schemaStatements = (schemaSource.exec(
    "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'"
  )[0]?.values ?? []).map((row) => String(row[0]));
  cleanup();

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-single-runner-'));
  const dbPath = path.join(dir, 'shared.sqlite');
  const connectionA = new DatabaseSync(dbPath);
  const connectionB = new DatabaseSync(dbPath);
  const { ScheduledTaskStore } = getStoreModule();

  const adapt = (database) => {
    let lastChanges = 0;
    return {
      exec(sql, params = []) {
        if (/^\s*(select|pragma|with)\b/i.test(sql)) {
          const statement = database.prepare(sql);
          const rows = statement.all(...params);
          const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
          return [{ columns, values: rows.map((row) => columns.map((column) => row[column])) }];
        }
        // DDL arrives without parameters; node:sqlite runs it through exec().
        database.exec(sql);
        return [];
      },
      run(sql, params = []) {
        const result = database.prepare(sql).run(...params);
        lastChanges = Number(result.changes ?? 0);
        return result;
      },
      getRowsModified: () => lastChanges,
      close: () => database.close(),
    };
  };

  try {
    connectionA.exec('PRAGMA journal_mode = WAL;');
    for (const statement of schemaStatements) connectionA.exec(statement);

    // Two stores = two schedulers in two host processes sharing this file.
    const storeA = new ScheduledTaskStore(adapt(connectionA), () => {});
    const storeB = new ScheduledTaskStore(adapt(connectionB), () => {});

    const task = storeA.createTask(createTaskInput({ name: 'Shared file task' }));

    const winnerAt = Date.now();
    const loserAt = winnerAt + 1;

    assert.equal(storeA.tryMarkTaskRunning(task.id, winnerAt), true);
    assert.equal(storeB.tryMarkTaskRunning(task.id, loserAt), false);

    // The winner's marker is intact on the shared row, read through the other
    // connection — the loser could not overwrite it.
    const shared = storeB.getTask(task.id);
    assert.equal(shared.state.runningAtMs, winnerAt);
    assert.notEqual(shared.state.runningAtMs, loserAt);

    // And the task is not due on the loser's side either.
    assert.deepEqual(storeB.getDueTasks(Date.now() + 120_000), []);
  } finally {
    try { connectionA.close(); } catch { /* already closed */ }
    try { connectionB.close(); } catch { /* already closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Scheduler: a lost claim must not execute ----------------------------

test('Scheduler ledgers already_running and executes nothing when the claim is lost', async () => {
  const task = createTaskObject({ id: 'contended-task' });
  const { scheduler, recording } = createHarness({ task, claimResults: [false] });

  scheduler.start();
  try {
    await scheduler.executeTask(task, 'scheduled');
  } finally {
    scheduler.stop();
  }

  // The claim was attempted exactly once, for this task.
  assert.deepEqual(recording.claims.map((claim) => claim.taskId), ['contended-task']);
  // Nothing ran: no session, no runner call, no run completion.
  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.runnerCalls, []);
  assert.deepEqual(recording.completedRuns, []);
  // The dropped duplicate is still visible in the ledger, with the same reason
  // the in-process guard uses.
  assert.deepEqual(
    recording.skippedRuns.map((run) => ({ reason: run.skipReason, trigger: run.trigger, status: run.status })),
    [{ reason: 'already_running', trigger: 'scheduled', status: 'skipped' }],
  );
  // A lost claim must not start a heartbeat for a run this process does not own.
  assert.equal(scheduler.runHeartbeats.size, 0);
});

test('Scheduler still executes when the claim is won', async () => {
  const task = createTaskObject({ id: 'won-task' });
  const { scheduler, recording } = createHarness({ task, claimResults: [true] });

  scheduler.start();
  try {
    await scheduler.executeTask(task, 'scheduled');
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(recording.claims.map((claim) => claim.taskId), ['won-task']);
  assert.deepEqual(recording.skippedRuns, []);
  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.runnerCalls.length, 1);
  assert.equal(recording.completedRuns.length, 1);
});

// --- Scheduler: lease-based orphan release ------------------------------

test('Orphan sweep preserves a fresh foreign marker that may belong to a live run', async () => {
  const task = createTaskObject({
    id: 'fresh-foreign',
    state: {
      ...createTaskObject().state,
      runningAtMs: Date.now() - 60_000,
    },
  });
  const { scheduler, recording } = createHarness({ task, runningTasks: () => [task] });

  scheduler.start();
  try {
    await scheduler.tick(0);
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(recording.releasedTaskIds, []);
  assert.deepEqual(recording.skippedRuns, []);
});

test('Orphan sweep releases a marker older than the lease', async () => {
  const staleAt = Date.now() - (RUN_LIVENESS_LEASE_MS + 60_000);
  const task = createTaskObject({
    id: 'stale-foreign',
    state: { ...createTaskObject().state, runningAtMs: staleAt },
  });
  const { scheduler, recording } = createHarness({ task, runningTasks: () => [task] });

  scheduler.start();
  try {
    await scheduler.tick(0);
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(recording.releasedTaskIds, ['stale-foreign']);
  assert.deepEqual(recording.skippedRuns.map((run) => run.skipReason), ['stuck_running']);
});

test('Orphan sweep preserves a marker just inside the lease and releases one just outside', async () => {
  const inside = createTaskObject({
    id: 'just-inside',
    state: { ...createTaskObject().state, runningAtMs: Date.now() - (RUN_LIVENESS_LEASE_MS - 5_000) },
  });
  const outside = createTaskObject({
    id: 'just-outside',
    state: { ...createTaskObject().state, runningAtMs: Date.now() - (RUN_LIVENESS_LEASE_MS + 5_000) },
  });
  const { scheduler, recording } = createHarness({ runningTasks: () => [inside, outside] });

  scheduler.start();
  try {
    await scheduler.tick(0);
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(recording.releasedTaskIds, ['just-outside']);
});

// --- Scheduler: per-run heartbeat lifecycle ------------------------------

test('Heartbeat starts only after the claim lands and is cleared when the run completes', async () => {
  const task = createTaskObject({ id: 'heartbeat-task' });
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = () => resolve(undefined);
  });
  const intervals = withIntervalSpy();
  const { scheduler, recording } = createHarness({
    task,
    startSession: () => gate,
  });

  scheduler.start();
  try {
    const live = scheduler.executeTask(task, 'manual');
    // Give the run a chance to reach the await.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(intervals.state.started, 1);
    assert.equal(intervals.state.callbacks[0].delayMs, RUN_HEARTBEAT_INTERVAL_MS);
    assert.equal(scheduler.runHeartbeats.has('heartbeat-task'), true);

    releaseSession();
    await live;

    assert.equal(intervals.state.cleared, 1);
    assert.equal(scheduler.runHeartbeats.size, 0);
    assert.equal(scheduler.activeTasks.size, 0);
  } finally {
    intervals.restore();
    scheduler.stop();
  }

  assert.equal(recording.completedRuns.length, 1);
});

test('Heartbeat is cleared on the failure path too', async () => {
  const task = createTaskObject({ id: 'failing-task' });
  const intervals = withIntervalSpy();
  const { scheduler, recording } = createHarness({
    task,
    startSession: () => {
      throw new Error('runner exploded');
    },
  });

  scheduler.start();
  try {
    await scheduler.executeTask(task, 'manual');

    assert.equal(intervals.state.started, 1);
    assert.equal(intervals.state.cleared, 1);
    assert.equal(scheduler.runHeartbeats.size, 0);
  } finally {
    intervals.restore();
    scheduler.stop();
  }

  assert.equal(recording.completedRuns.length, 1);
  assert.equal(recording.completedRuns[0].status, 'error');
});

test('Heartbeat tick refreshes the marker with a newer timestamp', async () => {
  const task = createTaskObject({ id: 'refresh-task' });
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = () => resolve(undefined);
  });
  const intervals = withIntervalSpy();
  const { scheduler, recording } = createHarness({ task, startSession: () => gate });

  scheduler.start();
  try {
    const live = scheduler.executeTask(task, 'manual');
    await new Promise((resolve) => setImmediate(resolve));

    const beforeTick = Date.now();
    intervals.state.callbacks[0].callback();

    assert.equal(recording.touched.length, 1);
    assert.equal(recording.touched[0].taskId, 'refresh-task');
    assert.ok(
      recording.touched[0].runningAtMs >= beforeTick,
      'heartbeat must write a fresh timestamp, not the original claim time',
    );

    releaseSession();
    await live;
  } finally {
    intervals.restore();
    scheduler.stop();
  }
});

test('Scheduler.stop clears an in-flight heartbeat', async () => {
  const task = createTaskObject({ id: 'stopped-task' });
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = () => resolve(undefined);
  });
  const intervals = withIntervalSpy();
  const { scheduler } = createHarness({ task, startSession: () => gate });

  scheduler.start();
  try {
    const live = scheduler.executeTask(task, 'manual');
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(intervals.state.started, 1);
    assert.equal(scheduler.runHeartbeats.size, 1);

    scheduler.stop();

    assert.equal(intervals.state.cleared, 1);
    assert.equal(scheduler.runHeartbeats.size, 0);
    assert.equal(scheduler.activeTasks.size, 0);

    // Let the aborted run settle so the test does not leave a dangling promise.
    releaseSession();
    await live;
    assert.equal(scheduler.runHeartbeats.size, 0);
  } finally {
    intervals.restore();
    scheduler.stop();
  }
});
