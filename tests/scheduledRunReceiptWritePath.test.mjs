// Scheduler run-receipt tiering at the write path (T-A).
//
// Contract under test (executeTask → store.completeRun):
//   a. normal exit + work messages in the run window → `completed`;
//   b. normal exit + zero work messages → `completed_empty`;
//   c. normal exit + a turn-failure settlement marker INSIDE the run window
//      → `crashed` with the settled-abnormally diagnostic;
//   d. a turn-failure marker from a PREVIOUS fire (outside the window) never
//      crashes this run (standing-conversation safety);
//   e. a submission throw → `crashed` carrying the throw message;
//   f. the practice watchdog's wall-clock throw → `timeout`;
//   g. task bookkeeping is unchanged: completed_empty still counts as an
//      executor-normal exit for markTaskCompleted (no consecutive-error bump).
//
// The scheduler loads from dist-electron with an electron stub (same harness
// shape as schedulerOriginRunReport.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);

function loadSchedulerWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[require.resolve('../dist-electron/main/ipc/broadcast.js')];
    const schedulerPath = require.resolve('../dist-electron/main/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

const TURN_SETTLED_ABNORMALLY_ERROR = 'executor turn settled without answering (failed / stall-aborted / truncated)';

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    name: 'Receipt probe',
    prompt: 'do the thing',
    schedule: { type: 'interval', intervalMs: 60_000 },
    enabled: true,
    sessionMode: 'fresh',
    targetSessionId: null,
    seriesSessionId: null,
    executionMode: 'auto',
    metabotId: null,
    notifyPlatforms: [],
    originSessionId: null,
    state: { consecutiveErrors: 0, fireCount: 0, runningAtMs: null },
    ...overrides,
  };
}

/**
 * Harness around executeTask. `turnOutcome` / `messages` / `startSessionError`
 * parameterize the evidence the classifier reads; every store call that the
 * receipt path touches is recorded.
 */
async function runFire({ turnOutcome = null, messages = [], startSessionError = null } = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = { completions: [], taskCompletions: [] };
  const runs = new Map();
  let runIndex = 0;
  const runStartBudget = Date.now() + 5_000; // window lower bound handed to the store

  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
      getTask: (id) => (id === 'task-1' ? createTask() : null),
      createRun: (taskId, trigger) => {
        const run = { id: `run-${++runIndex}`, taskId, sessionId: null, status: 'running', trigger };
        runs.set(run.id, run);
        return run;
      },
      tryMarkTaskRunning: () => true,
      markTaskRunning: () => {},
      touchTaskRunning: () => {},
      recordSkippedRun: () => ({}),
      releaseStuckRunningTask: () => {},
      completeRun: (runId, status, sessionId, durationMs, error) => {
        recording.completions.push({ runId, status, sessionId, durationMs, error });
        const completed = { ...runs.get(runId), status, sessionId, durationMs, error };
        runs.set(runId, completed);
        return completed;
      },
      markTaskCompleted: (id, success, durationMs, error) => {
        recording.taskCompletions.push({ id, success, durationMs, error });
      },
      toggleTask: () => {},
      pruneRuns: () => {},
      getRun: (runId) => runs.get(runId) ?? null,
      getTaskSessionId: () => null,
      setTaskSessionId: () => {},
      getLatestRunSessionId: () => null,
      setSeriesSessionId: () => {},
    },
    coworkStore: {
      getConfig: () => ({ workingDirectory: '/tmp', systemPrompt: '', executionMode: 'auto' }),
      createSession: () => ({ id: 'worker-session-1' }),
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => ({ id: 'prompt-1', type: 'user', timestamp: runStartBudget, sequence: 1 }),
      getSessionTurnOutcome: () => turnOutcome,
      getSessionMessagesPage: () => ({
        messages,
        hasMoreBefore: false,
        beforeSequence: null,
      }),
    },
    getCoworkRunner: () => ({
      startSession: async () => {
        if (startSessionError) throw new Error(startSessionError);
      },
      stopSession: () => {},
      isSessionActive: () => false,
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
  });

  const task = createTask();
  await scheduler.executeTask(task, 'manual');
  return recording;
}

// The fire's run window opens at executeTask's internal `startTime` (taken
// AFTER this test captured `now`), so in-window evidence uses timestamps in
// the near future — the classifier compares numbers, not wall clocks.
const inWindow = () => Date.now() + 60_000;
const workMessages = () => ([
  { id: 'm1', type: 'user', timestamp: inWindow(), sequence: 1 },
  { id: 'm2', type: 'assistant', timestamp: inWindow(), sequence: 2 },
  { id: 'm3', type: 'tool_use', timestamp: inWindow(), sequence: 3 },
]);

test('normal exit with work → completed', async () => {
  const now = Date.now();
  const recording = await runFire({
    turnOutcome: { lastFailedAtMs: null, lastCompletedAtMs: inWindow() },
    messages: workMessages(),
  });
  assert.equal(recording.completions.length, 1);
  assert.equal(recording.completions[0].status, 'completed');
  assert.equal(recording.completions[0].error, null);
});

test('normal exit with zero work → completed_empty', async () => {
  const now = Date.now();
  const recording = await runFire({
    turnOutcome: { lastFailedAtMs: null, lastCompletedAtMs: inWindow() },
    messages: [
      { id: 'm1', type: 'user', timestamp: inWindow(), sequence: 1 },
      { id: 'm2', type: 'system', timestamp: inWindow(), sequence: 2 },
    ],
  });
  assert.equal(recording.completions[0].status, 'completed_empty');
  assert.equal(recording.completions[0].error, null);
});

test('turn settled abnormally in-window → crashed with diagnostic', async () => {
  const now = Date.now();
  const recording = await runFire({
    turnOutcome: { lastFailedAtMs: inWindow(), lastCompletedAtMs: null },
    messages: [],
  });
  assert.equal(recording.completions[0].status, 'crashed');
  assert.equal(recording.completions[0].error, TURN_SETTLED_ABNORMALLY_ERROR);
});

test('a failure marker older than the run window never crashes this run', async () => {
  const now = Date.now();
  const recording = await runFire({
    // Previous fire's failure: far in the past relative to the fire we just ran.
    turnOutcome: { lastFailedAtMs: now - 24 * 60 * 60 * 1000, lastCompletedAtMs: inWindow() },
    messages: workMessages(),
  });
  assert.equal(recording.completions[0].status, 'completed');
});

test('submission throw → crashed carrying the throw message', async () => {
  const recording = await runFire({ startSessionError: 'Session not found' });
  assert.equal(recording.completions[0].status, 'crashed');
  assert.equal(recording.completions[0].error, 'Session not found');
});

test('wall-clock watchdog kill → timeout', async () => {
  const recording = await runFire({
    startSessionError: 'Practice run exceeded its 20-minute wall-clock budget',
  });
  assert.equal(recording.completions[0].status, 'timeout');
  assert.match(recording.completions[0].error, /wall-clock budget/);
});

test('task bookkeeping unchanged: completed_empty is still an executor-normal exit', async () => {
  const now = Date.now();
  const recording = await runFire({
    turnOutcome: { lastFailedAtMs: null, lastCompletedAtMs: inWindow() },
    messages: [],
  });
  // markTaskCompleted must keep receiving success=true for completed_empty —
  // the tiering must not change scheduling/auto-disable semantics.
  assert.equal(recording.taskCompletions[0].success, true);
});
