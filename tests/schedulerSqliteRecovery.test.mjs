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
      ...scheduledTaskStore,
    },
    coworkStore: {
      getConfig: () => ({
        workingDirectory: '/tmp',
        systemPrompt: '',
        executionMode: 'local',
      }),
      createSession: () => ({ id: 'session-1' }),
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
