import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

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
    const schedulerPath = require.resolve('../dist-electron/libs/scheduler.js');
    delete require.cache[schedulerPath];
    return require(schedulerPath);
  } finally {
    Module._load = originalLoad;
  }
}

function waitFor(assertion, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        assertion();
        resolve();
      } catch (error) {
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(check, 5);
      }
    };
    check();
  });
}

function createTask(overrides = {}) {
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

function createScheduler({
  scheduledTaskStore,
  recoverSqlite = async () => {},
  coworkRunner,
} = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  return new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => Date.now(),
      getDueTasks: () => [],
      getTask: () => null,
      createRun: () => ({ id: 'run-1' }),
      markTaskRunning: () => {},
      completeRun: () => null,
      markTaskCompleted: () => {},
      toggleTask: () => {},
      pruneRuns: () => {},
      getRun: () => null,
      getTaskSessionId: () => null,
      setTaskSessionId: () => {},
      ...scheduledTaskStore,
    },
    coworkStore: {
      getConfig: () => ({
        workingDirectory: '/tmp',
        systemPrompt: '',
        executionMode: 'local',
      }),
      createSession: () => ({ id: 'session-1' }),
      getSession: () => null,
      updateSession: () => {},
      addMessage: () => {},
    },
    getCoworkRunner: () => coworkRunner ?? {
      startSession: async () => {},
      stopSession: () => {},
    },
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
    isRecoverableSqliteError: (error) => /memory access out of bounds/i.test(error?.message ?? String(error)),
    recoverSqlite,
  });
}

test('Scheduler routes sqlite WASM failures from scheduling into recovery', async () => {
  const recoveries = [];
  const wasmError = new WebAssembly.RuntimeError('memory access out of bounds');
  const scheduler = createScheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => {
        throw wasmError;
      },
    },
    recoverSqlite: async (error, operationName) => {
      recoveries.push({ error, operationName });
    },
  });

  scheduler.start();

  await waitFor(() => {
    assert.equal(recoveries.length, 1);
  });
  scheduler.stop();

  assert.equal(recoveries[0].error, wasmError);
  assert.equal(recoveries[0].operationName, 'scheduledTask:scheduleNext');
});

test('Scheduler routes sqlite WASM failures from due-task polling into recovery', async () => {
  const recoveries = [];
  const wasmError = new WebAssembly.RuntimeError('memory access out of bounds');
  const scheduler = createScheduler({
    scheduledTaskStore: {
      getDueTasks: () => {
        throw wasmError;
      },
    },
    recoverSqlite: async (error, operationName) => {
      recoveries.push({ error, operationName });
    },
  });

  scheduler.start();

  await waitFor(() => {
    assert.equal(recoveries.length, 1);
  });
  scheduler.stop();

  assert.equal(recoveries[0].error, wasmError);
  assert.equal(recoveries[0].operationName, 'scheduledTask:tick');
});

test('Scheduler starts sqlite recovery without waiting for unrelated long scheduled executions', async () => {
  const recoveries = [];
  const wasmError = new WebAssembly.RuntimeError('memory access out of bounds');
  const longTask = createTask({ id: 'long-task' });
  const failingTask = createTask({ id: 'failing-task' });
  let releaseLongSession;
  const scheduler = createScheduler({
    scheduledTaskStore: {
      getDueTasks: () => [longTask, failingTask],
      createRun: (taskId) => {
        if (taskId === failingTask.id) {
          throw wasmError;
        }
        return {
          id: `run-${taskId}`,
          taskId,
          sessionId: null,
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          durationMs: null,
          error: null,
          trigger: 'scheduled',
        };
      },
      getTask: () => longTask,
    },
    coworkRunner: {
      startSession: () => new Promise((resolve) => {
        releaseLongSession = () => resolve();
      }),
      stopSession: () => {},
    },
    recoverSqlite: async (error, operationName) => {
      recoveries.push({ error, operationName });
    },
  });

  scheduler.start();

  try {
    await waitFor(() => {
      assert.equal(recoveries.length, 1);
    }, 100);
  } finally {
    scheduler.stop();
    releaseLongSession?.();
  }

  assert.equal(recoveries[0].error, wasmError);
  assert.equal(recoveries[0].operationName, 'scheduledTask:tick');
});

test('Scheduler does not write task completion state through a stale store after global stop', async () => {
  const task = createTask();
  let releaseSession;
  let stopped = false;
  let staleStoreReads = 0;
  const scheduler = createScheduler({
    scheduledTaskStore: {
      getTask: () => {
        if (stopped) {
          staleStoreReads += 1;
        }
        return task;
      },
      createRun: () => ({
        id: 'run-1',
        taskId: task.id,
        sessionId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        error: null,
        trigger: 'scheduled',
      }),
    },
    coworkRunner: {
      startSession: () => new Promise((resolve) => {
        releaseSession = () => resolve();
      }),
      stopSession: () => {},
    },
  });

  const execution = scheduler.executeTask(task, 'manual');
  await waitFor(() => {
    assert.equal(typeof releaseSession, 'function');
  });

  stopped = true;
  scheduler.stop();
  releaseSession();
  await execution;

  assert.equal(staleStoreReads, 0);
});

test('Scheduler creates a fresh cowork session for repeated runs of the same scheduled task', async () => {
  const task = createTask({ id: 'recurring-task', metabotId: 7 });
  const runs = new Map();
  const completedRuns = [];
  let runIndex = 0;
  const createdSessions = [];
  const runnerCalls = [];
  let persistedTaskSessionWrites = 0;
  const legacyPersistedSessionId = 'legacy-session';
  const scheduler = createScheduler({
    scheduledTaskStore: {
      getTask: () => task,
      getTaskSessionId: () => legacyPersistedSessionId,
      setTaskSessionId: () => {
        persistedTaskSessionWrites += 1;
      },
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
      completeRun: (runId, status, sessionId, durationMs, error) => {
        const run = runs.get(runId);
        const completed = { ...run, status, sessionId, durationMs, error };
        runs.set(runId, completed);
        completedRuns.push(completed);
        return completed;
      },
      getRun: (runId) => runs.get(runId) ?? null,
    },
    coworkRunner: {
      startSession: async (sessionId, prompt, options) => {
        runnerCalls.push({ sessionId, prompt, options });
      },
      stopSession: () => {},
    },
  });
  scheduler.coworkStore.createSession = (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => {
    const session = { id: `session-${createdSessions.length + 1}` };
    createdSessions.push({ title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId, session });
    return session;
  };
  scheduler.coworkStore.getSession = (sessionId) => {
    if (sessionId === legacyPersistedSessionId) {
      return {
        id: legacyPersistedSessionId,
        title: '[定时] Legacy session',
        claudeSessionId: 'legacy-claude-session',
        status: 'idle',
        pinned: false,
        cwd: '/tmp',
        systemPrompt: '',
        executionMode: 'local',
        activeSkillIds: [],
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metabotId: 7,
      };
    }
    const record = createdSessions.find((item) => item.session.id === sessionId);
    if (!record) return null;
    return {
      ...record.session,
      title: record.title,
      claudeSessionId: null,
      status: 'idle',
      pinned: false,
      cwd: record.cwd,
      systemPrompt: record.systemPrompt,
      executionMode: record.executionMode,
      activeSkillIds: record.activeSkillIds,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      metabotId: record.metabotId,
    };
  };

  await scheduler.executeTask(task, 'manual');
  await scheduler.executeTask(task, 'manual');

  assert.equal(createdSessions.length, 2);
  assert.equal(createdSessions[0].metabotId, 7);
  assert.equal(createdSessions[1].metabotId, 7);
  assert.equal(persistedTaskSessionWrites, 0);
  assert.deepEqual(runnerCalls.map((call) => call.sessionId), ['session-1', 'session-2']);
  assert.deepEqual(completedRuns.map((run) => run.sessionId), ['session-1', 'session-2']);
});
