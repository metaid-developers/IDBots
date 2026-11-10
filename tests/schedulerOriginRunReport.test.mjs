import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

function loadSchedulerWithElectronStub() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { BrowserWindow: { getAllWindows: () => [] } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const schedulerPath = require.resolve('../dist-electron/main/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    name: 'Delegated errand',
    description: '',
    enabled: true,
    schedule: { type: 'at', datetime: new Date().toISOString() },
    prompt: 'Do the errand and report',
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    metabotId: null,
    coworkSessionId: null,
    targetSessionId: null,
    originSessionId: 'origin-session',
    expiresAt: null,
    notifyPlatforms: [],
    fireCount: 0,
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

/**
 * Slim harness: fresh-session path only (no submitToSession unless provided),
 * with the cross-session seam mocked to record run-report deliveries.
 */
function createHarness({ task, startSessionError, latestReply } = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = { deliveries: [], createdSessions: [], runnerCalls: [] };
  let runIndex = 0;
  let sessionIndex = 0;
  const runs = new Map();

  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
      getTask: () => task,
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
        const completed = { ...runs.get(runId), status, sessionId, durationMs, error };
        runs.set(runId, completed);
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
      getConfig: () => ({ workingDirectory: '/tmp', systemPrompt: '', executionMode: 'local' }),
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => {
        const session = { id: `worker-session-${++sessionIndex}` };
        recording.createdSessions.push({ title, session });
        return session;
      },
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
      getSessionLatestVisibleMessage: (sessionId) => {
        if (!latestReply) return null;
        return { id: `${sessionId}-latest`, type: 'assistant', content: latestReply };
      },
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId, prompt, options) => {
        recording.runnerCalls.push({ sessionId, prompt, options });
        if (startSessionError) throw new Error(startSessionError);
      },
      stopSession: () => {},
      insertCrossSessionMessageAndQueue: (input) => {
        recording.deliveries.push(input);
        return { insert: { ok: true, ...input, message: { id: input.deliveryId } }, runQueued: true, queueDepth: 0 };
      },
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
  });

  return { scheduler, recording };
}

test('a one-shot delegated task reports its run back into the origin session', async () => {
  const { scheduler, recording } = createHarness({
    task: createTask({ id: 'errand-1', originSessionId: 'origin-session' }),
    latestReply: 'ERRAND_REPORT: done, everything green.',
  });
  await scheduler.executeTask(createTask({ id: 'errand-1', originSessionId: 'origin-session' }), 'manual');

  assert.equal(recording.deliveries.length, 1);
  const delivery = recording.deliveries[0];
  assert.match(delivery.deliveryId, /^schedule_report:errand-1:run-1$/);
  assert.match(delivery.sourceSessionId, /^worker-session-\d+$/);
  assert.equal(delivery.targetSessionId, 'origin-session');
  assert.match(delivery.message, /\[SCHEDULED-RUN-REPORT\] 定时任务 "Delegated errand"（id errand-1）的一次运行已结束：outcome=success/);
  assert.match(delivery.message, /<worker_report trust="untrusted">ERRAND_REPORT: done, everything green\.<\/worker_report>/);
});

test('a recurring task stays silent on success but reports failures', async () => {
  const recurring = createTask({ id: 'poll-1', schedule: { type: 'interval', intervalMs: 60_000 } });

  const successWorld = createHarness({ task: recurring });
  await successWorld.scheduler.executeTask(recurring, 'manual');
  assert.equal(successWorld.recording.deliveries.length, 0, 'per-fire success pings would flood the origin chat');

  const failureWorld = createHarness({
    task: recurring,
    startSessionError: 'provider outage',
  });
  await failureWorld.scheduler.executeTask(recurring, 'manual');
  assert.equal(failureWorld.recording.deliveries.length, 1);
  const delivery = failureWorld.recording.deliveries[0];
  assert.equal(delivery.sourceSessionId, 'scheduled-task:poll-1', 'no worker session opened — synthetic pseudo-source');
  assert.equal(delivery.targetSessionId, 'origin-session');
  assert.match(delivery.message, /outcome=failed/);
  assert.match(delivery.message, /失败原因：provider outage/);
});

test('a flapping recurring task reports once per cooldown window; a one-shot task reports every failure', async () => {
  // Three consecutive failures of the same recurring task within the window:
  // each failed fire would otherwise queue a full owner LLM turn into the
  // origin chat, so only the first one reports.
  const recurring = createTask({ id: 'flap-1', schedule: { type: 'interval', intervalMs: 60_000 } });
  const flapWorld = createHarness({ task: recurring, startSessionError: 'provider outage' });
  await flapWorld.scheduler.executeTask(recurring, 'manual');
  await flapWorld.scheduler.executeTask(recurring, 'manual');
  await flapWorld.scheduler.executeTask(recurring, 'manual');
  assert.equal(flapWorld.recording.deliveries.length, 1, 'one failure report per cooldown window, not one per failed fire');

  // A manual one-shot run reports EVERY failure immediately — the owner must
  // learn about it. The per-run delivery ids stay distinct.
  const oneshot = createTask({ id: 'manual-1' });
  const oneshotWorld = createHarness({ task: oneshot, startSessionError: 'provider outage' });
  await oneshotWorld.scheduler.executeTask(oneshot, 'manual');
  await oneshotWorld.scheduler.executeTask(oneshot, 'manual');
  assert.equal(oneshotWorld.recording.deliveries.length, 2, 'non-recurring failures bypass the cooldown');
  assert.deepEqual(
    oneshotWorld.recording.deliveries.map((d) => d.deliveryId),
    ['schedule_report:manual-1:run-1', 'schedule_report:manual-1:run-2'],
  );
});

test('a run that executed inside the origin chat itself is not reported back into it', async () => {
  const bound = createTask({
    id: 'self-bound',
    targetSessionId: 'origin-session',
    originSessionId: 'origin-session',
  });
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = { deliveries: [] };
  let runIndex = 0;
  const runs = new Map();
  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
      getTask: () => bound,
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
        const completed = { ...runs.get(runId), status, sessionId, durationMs, error };
        runs.set(runId, completed);
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
      getConfig: () => ({ workingDirectory: '/tmp', systemPrompt: '', executionMode: 'local' }),
      createSession: () => ({ id: 'never-created' }),
      getSessionWithoutMessages: (sessionId) => (sessionId === 'origin-session'
        ? { id: 'origin-session', sessionType: 'standard', executionMode: 'local' }
        : null),
      isSessionArchived: () => false,
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
    },
    getCoworkRunner: () => ({
      startSession: async () => {},
      stopSession: () => {},
      insertCrossSessionMessageAndQueue: (input) => {
        recording.deliveries.push(input);
        return { insert: { ok: true }, runQueued: true };
      },
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
    submitToSession: async () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(bound, 'manual');
  assert.equal(recording.deliveries.length, 0, 'the origin chat just watched the turn happen — no self-ping');
});

test('a one-shot task without an origin session records nothing', async () => {
  const world = createHarness({ task: createTask({ originSessionId: null }) });
  await world.scheduler.executeTask(createTask({ originSessionId: null }), 'manual');
  assert.equal(world.recording.deliveries.length, 0);
});
