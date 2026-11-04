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

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Harness mirroring tests/schedulerSqliteRecovery.test.mjs: a mocked store,
 * cowork store and runner, plus the optional submitToSession dep. Records
 * every createSession / startSession / submitToSession / completeRun call.
 */
function createHarness({
  task,
  sessions = {},
  archived = [],
  submitToSession,
  startSessionGate,
  runningTasks = () => [],
} = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = {
    createdSessions: [],
    runnerCalls: [],
    submitCalls: [],
    completedRuns: [],
    skippedRuns: [],
    releasedTaskIds: [],
  };
  const runs = new Map();
  let runIndex = 0;
  const archivedIds = new Set(archived);

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
      markTaskRunning: () => {},
      tryMarkTaskRunning: () => true,
      touchTaskRunning: () => {},
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
      releaseStuckRunningTask: (taskId) => {
        recording.releasedTaskIds.push(taskId);
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
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => {
        const session = { id: `session-${recording.createdSessions.length + 1}` };
        recording.createdSessions.push({ title, cwd, executionMode, metabotId, session });
        return session;
      },
      getSessionWithoutMessages: (sessionId) => sessions[sessionId] ?? null,
      isSessionArchived: (sessionId) => archivedIds.has(sessionId),
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId, prompt, options) => {
        recording.runnerCalls.push({ sessionId, prompt, options });
        if (startSessionGate) await startSessionGate;
      },
      stopSession: () => {},
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
    ...(submitToSession
      ? {
          submitToSession: async (input) => {
            recording.submitCalls.push(input);
            return submitToSession(input);
          },
        }
      : {}),
  });

  return { scheduler, recording };
}

function standardSession(id, overrides = {}) {
  return {
    id,
    sessionType: 'standard',
    executionMode: 'local',
    ...overrides,
  };
}

test('Scheduler submits a bound task into its existing session instead of creating a fresh one', async () => {
  const task = createTask({ id: 'bound-task', targetSessionId: 'bound-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'bound-session': standardSession('bound-session') },
    submitToSession: () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.submitCalls.length, 1);
  const submission = recording.submitCalls[0];
  assert.equal(submission.sessionId, 'bound-session');
  // Recurring tasks carry the lifecycle preamble in front of the prompt.
  assert.ok(submission.text.startsWith('[Scheduled task lifecycle]'));
  assert.ok(submission.text.endsWith('Run the check'));
  assert.equal(submission.origin, 'schedule');
  assert.equal(submission.originLabel, 'Daily check');
  assert.match(submission.submissionId, UUID_V4_RE);

  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.runnerCalls, []);
  assert.equal(recording.completedRuns.length, 1);
  assert.equal(recording.completedRuns[0].status, 'success');
  assert.equal(recording.completedRuns[0].sessionId, 'bound-session');
});

test('Scheduler wired to the real turn-submission controller persists the prompt on the bound session with schedule origin', async () => {
  const { CoworkTurnSubmissionController } =
    require('../dist-electron/main/services/coworkTurnSubmission.js');

  const messages = [];
  const boundSession = {
    id: 'bound-session',
    sessionType: 'standard',
    executionMode: 'local',
    status: 'idle',
    claudeSessionId: null,
    cwd: '/tmp',
    systemPrompt: '',
    activeSkillIds: [],
    metabotId: null,
    messages,
  };
  const continueCalls = [];
  const controller = new CoworkTurnSubmissionController({
    store: {
      getSession: (sessionId) => (sessionId === 'bound-session' ? boundSession : null),
      getMessageById: (_sessionId, messageId) =>
        messages.find((message) => message.id === messageId) ?? null,
      addMessageWithId: (sessionId, messageId, input) => {
        const message = { id: messageId, timestamp: Date.now(), ...input };
        messages.push(message);
        return message;
      },
      updateMessage: () => {},
    },
    runner: {
      getSteerCapability: () => 'inactive',
      trySubmitSteer: () => ({ accepted: false, reason: 'inactive' }),
      waitForActiveTurnSettlement: async () => {},
      interruptKernelTurnForHumanInput: async () => false,
      wasSessionStopped: () => false,
      continueSession: async (sessionId, text, options) => {
        continueCalls.push({ sessionId, text, options });
      },
    },
    emitMessage: () => {},
    emitMessageUpdate: () => {},
  });

  const task = createTask({ id: 'bound-task', targetSessionId: 'bound-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'bound-session': boundSession },
    submitToSession: (input) => controller.submit(input),
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'user');
  // Recurring tasks carry the lifecycle preamble in front of the prompt.
  assert.ok(messages[0].content.startsWith('[Scheduled task lifecycle]'));
  assert.ok(messages[0].content.endsWith('Run the check'));
  assert.equal(messages[0].metadata.origin, 'schedule');
  assert.equal(messages[0].metadata.originLabel, 'Daily check');
  assert.equal(messages[0].metadata.submissionMode, 'continue');
  assert.equal(messages[0].metadata.submissionResult, 'completed');

  assert.equal(continueCalls.length, 1);
  assert.equal(continueCalls[0].sessionId, 'bound-session');
  assert.deepEqual(recording.createdSessions, []);
  assert.equal(recording.completedRuns[0].status, 'success');
  assert.equal(recording.completedRuns[0].sessionId, 'bound-session');
});

test('Scheduler falls back to a fresh session when the bound session no longer exists', async () => {
  const task = createTask({ id: 'bound-task', targetSessionId: 'missing-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: {},
    submitToSession: () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.submitCalls, []);
  assert.equal(recording.createdSessions.length, 1);
  assert.deepEqual(recording.runnerCalls.map((call) => call.sessionId), ['session-1']);
  assert.equal(recording.completedRuns[0].status, 'success');
  assert.equal(recording.completedRuns[0].sessionId, 'session-1');
});

test('Scheduler falls back to a fresh session when the bound session is archived', async () => {
  const task = createTask({ id: 'bound-task', targetSessionId: 'archived-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'archived-session': standardSession('archived-session') },
    archived: ['archived-session'],
    submitToSession: () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.submitCalls, []);
  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.completedRuns[0].sessionId, 'session-1');
});

test('Scheduler falls back to a fresh session for A2A and sandbox bound sessions', async () => {
  for (const [name, session] of [
    ['a2a', standardSession('bound-session', { sessionType: 'a2a' })],
    ['sandbox', standardSession('bound-session', { executionMode: 'sandbox' })],
    // Nightly-token audit 2026-10-25: surf/study/exam sessions are hidden and
    // stopped after their run — a task bound to one (the legacy surf default)
    // must not re-feed that transcript into an invisible work session.
    ['hidden-unattended', standardSession('bound-session', { hiddenFromSessionList: true })],
  ]) {
    const task = createTask({ id: `bound-task-${name}`, targetSessionId: 'bound-session' });
    const { scheduler, recording } = createHarness({
      task,
      sessions: { 'bound-session': session },
      submitToSession: () => ({ success: true, mode: 'continue' }),
    });

    await scheduler.executeTask(task, 'manual');

    assert.deepEqual(recording.submitCalls, [], `${name}: no submission`);
    assert.equal(recording.createdSessions.length, 1, `${name}: fresh session`);
    assert.equal(recording.completedRuns[0].sessionId, 'session-1', `${name}: run bound to fresh session`);
  }
});

test('Scheduler records a failed run when the bound session rejects the submission', async () => {
  const task = createTask({ id: 'bound-task', targetSessionId: 'bound-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'bound-session': standardSession('bound-session') },
    submitToSession: () => ({ success: false, error: 'bound session refused the prompt' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.submitCalls.length, 1);
  // Never double-post: a failed submission must not also open a fresh session.
  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.runnerCalls, []);
  assert.equal(recording.completedRuns.length, 1);
  assert.equal(recording.completedRuns[0].status, 'error');
  assert.equal(recording.completedRuns[0].error, 'bound session refused the prompt');
  assert.equal(recording.completedRuns[0].sessionId, null);
});

test('Scheduler treats a binding as invalid when no submit handler is wired', async () => {
  const task = createTask({ id: 'bound-task', targetSessionId: 'bound-session' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'bound-session': standardSession('bound-session') },
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.submitCalls, []);
  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.completedRuns[0].status, 'success');
  assert.equal(recording.completedRuns[0].sessionId, 'session-1');
});

test('Scheduler still creates a fresh session when the task has no bound session', async () => {
  const task = createTask({ id: 'unbound-task' });
  const { scheduler, recording } = createHarness({
    task,
    submitToSession: () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.submitCalls, []);
  assert.equal(recording.createdSessions.length, 1);
  assert.deepEqual(recording.runnerCalls.map((call) => call.sessionId), ['session-1']);
  assert.equal(recording.completedRuns[0].sessionId, 'session-1');
});

test('Scheduler ledgers an already_running skip when a second fire arrives for a live task', async () => {
  const task = createTask({ id: 'busy-task' });
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  const { scheduler, recording } = createHarness({ task, startSessionGate: gate });

  const live = scheduler.executeTask(task, 'manual');
  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.skippedRuns.map((run) => run.skipReason), ['already_running']);
  assert.equal(recording.skippedRuns[0].status, 'skipped');
  assert.equal(recording.skippedRuns[0].taskId, task.id);
  assert.equal(recording.skippedRuns[0].trigger, 'manual');
  // The skip must not start a second execution nor fake a completion.
  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.completedRuns.length, 0);

  releaseSession();
  await live;

  assert.equal(recording.completedRuns.length, 1);
  assert.equal(recording.completedRuns[0].status, 'success');
});

test('Scheduler ledgers an expired skip for a due task whose expiry day has passed', async () => {
  const task = createTask({ id: 'expired-task', expiresAt: '2000-01-01' });
  const { scheduler, recording } = createHarness({ task });

  scheduler.start();
  try {
    await scheduler.executeTask(task, 'scheduled');
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(recording.skippedRuns.map((run) => run.skipReason), ['expired']);
  assert.equal(recording.skippedRuns[0].status, 'skipped');
  assert.equal(recording.skippedRuns[0].trigger, 'scheduled');
  assert.equal(recording.createdSessions.length, 0);
  assert.equal(recording.runnerCalls.length, 0);
  assert.equal(recording.completedRuns.length, 0);
});

test('Scheduler ledgers an orphaned running marker as stuck_running and releases it', async () => {
  // This orphan carries NO running_at_ms timestamp (createTask's default), which is
  // the strongest form of "no liveness evidence": the sweep releases it at once.
  // A marker that DOES carry a fresh timestamp is deliberately treated as possibly
  // live (another process may be behind it) and is covered by
  // tests/scheduledTaskSingleRunner.test.mjs.
  const orphan = createTask({ id: 'orphan-task' });
  const { scheduler, recording } = createHarness({
    task: orphan,
    runningTasks: () => [orphan],
  });

  scheduler.start();
  try {
    await scheduler.tick(0);
  } finally {
    scheduler.stop();
  }

  assert.deepEqual(
    recording.skippedRuns.map((run) => ({ reason: run.skipReason, trigger: run.trigger })),
    [{ reason: 'stuck_running', trigger: 'scheduled' }],
  );
  assert.deepEqual(recording.releasedTaskIds, ['orphan-task']);
  assert.equal(recording.completedRuns.length, 0);
});

test('Scheduler does not ledger a stuck skip for a task with a live execution', async () => {
  const task = createTask({ id: 'live-task' });
  let releaseSession;
  const gate = new Promise((resolve) => {
    releaseSession = resolve;
  });
  const { scheduler, recording } = createHarness({
    task,
    runningTasks: () => [task],
    startSessionGate: gate,
  });

  scheduler.start();
  try {
    const live = scheduler.executeTask(task, 'manual');
    await scheduler.tick(0);

    assert.deepEqual(recording.skippedRuns, []);
    assert.deepEqual(recording.releasedTaskIds, []);

    releaseSession();
    await live;
  } finally {
    scheduler.stop();
  }

  assert.equal(recording.completedRuns.length, 1);
  assert.equal(recording.completedRuns[0].status, 'success');
});
