import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

function loadSchedulerModule() {
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

const {
  Scheduler,
  buildScheduledSessionTitle,
  readScheduledSessionGeneration,
  readSessionContextUsageRatio,
  buildScheduledSessionContinuityNote,
  SERIES_SESSION_CONTEXT_RATIO_LIMIT,
  SERIES_SESSION_MESSAGE_LIMIT,
} = loadSchedulerModule();

function createTask(overrides = {}) {
  return {
    id: 'task-1',
    name: 'Daily check',
    description: '',
    enabled: true,
    schedule: { type: 'cron', expression: '0 9 * * *' },
    prompt: 'Run the check',
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'local',
    metabotId: null,
    coworkSessionId: null,
    targetSessionId: null,
    sessionMode: 'series',
    seriesSessionId: null,
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

/**
 * Harness with a session map that remembers created sessions, per-session
 * usage stats and message counts — everything the series resolution reads.
 */
function createHarness({
  task,
  sessions = {},
  archived = [],
  activeSessionIds = [],
  submitToSession,
  busyWaitMs = 0,
  busyPollMs = 5,
} = {}) {
  const recording = {
    createdSessions: [],
    runnerCalls: [],
    seatedSeries: [],
    addMessages: [],
  };
  const runs = new Map();
  let runIndex = 0;
  const archivedIds = new Set(archived);
  const activeIds = new Set(activeSessionIds);
  const usageStats = new Map(Object.entries(sessions).map(([id, session]) => [id, session.usageStats ?? null]));
  const messageCounts = new Map(
    Object.entries(sessions).map(([id, session]) => [id, session.messageCount ?? 0])
  );
  // Sessions created by the harness itself are immediately visible to lookups.
  const allSessions = { ...sessions };

  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
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
      getLatestRunSessionId: (taskId) => task.id === taskId ? (task.latestRunSessionId ?? null) : null,
      setSeriesSessionId: (taskId, sessionId) => {
        if (task.id === taskId) recording.seatedSeries.push(sessionId);
      },
    },
    coworkStore: {
      getConfig: () => ({ workingDirectory: '/tmp', systemPrompt: '', executionMode: 'local' }),
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => {
        const session = {
          id: `session-${recording.createdSessions.length + 1}`,
          title,
        };
        recording.createdSessions.push({
          title,
          cwd,
          systemPrompt,
          executionMode,
          metabotId,
          session,
        });
        allSessions[session.id] = {
          id: session.id,
          title,
          sessionType: 'standard',
          executionMode: 'local',
          metabotId,
          autoOrigin: 'schedule',
          status: 'idle',
        };
        usageStats.set(session.id, null);
        messageCounts.set(session.id, 0);
        return session;
      },
      getSessionWithoutMessages: (sessionId) => {
        const session = allSessions[sessionId];
        return session ? { ...session } : null;
      },
      getSession: (sessionId) => allSessions[sessionId] ?? null,
      isSessionArchived: (sessionId) => archivedIds.has(sessionId),
      getSessionAutoOrigin: (sessionId) => allSessions[sessionId]?.autoOrigin ?? null,
      getSessionUsageStats: (sessionId) => usageStats.get(sessionId) ?? null,
      countSessionMessages: (sessionId) => messageCounts.get(sessionId) ?? 0,
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: (sessionId, message) => {
        recording.addMessages.push({ sessionId, ...message });
        messageCounts.set(sessionId, (messageCounts.get(sessionId) ?? 0) + 1);
        return { id: `msg-${recording.addMessages.length}`, ...message };
      },
      getSessionLatestVisibleMessage: (sessionId) => {
        const session = allSessions[sessionId];
        if (session?.lastAssistantContent) {
          return { type: 'assistant', content: session.lastAssistantContent };
        }
        return null;
      },
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId, prompt, options) => {
        recording.runnerCalls.push({ sessionId, prompt, options });
        activeIds.delete(sessionId);
      },
      stopSession: () => {},
      isSessionActive: (sessionId) => activeIds.has(sessionId),
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
    ...(submitToSession
      ? {
          submitToSession: async (input) => {
            recording.submitCalls = recording.submitCalls ?? [];
            recording.submitCalls.push(input);
            return submitToSession(input);
          },
        }
      : {}),
    seriesSessionBusyWaitMs: busyWaitMs,
    seriesSessionBusyPollMs: busyPollMs,
  });

  return { scheduler, recording, allSessions, usageStats, messageCounts };
}

function seriesSession(id, overrides = {}) {
  return {
    id,
    title: '[定时] Daily check',
    sessionType: 'standard',
    executionMode: 'local',
    metabotId: null,
    autoOrigin: 'schedule',
    usageStats: null,
    messageCount: 0,
    ...overrides,
  };
}

// --- Title and generation helpers ---

test('buildScheduledSessionTitle appends the generation suffix from the second conversation on', () => {
  assert.equal(buildScheduledSessionTitle('热点选题官'), '[定时] 热点选题官');
  assert.equal(buildScheduledSessionTitle('热点选题官', 2), '[定时] 热点选题官（2）');
  assert.equal(buildScheduledSessionTitle('热点选题官', 12), '[定时] 热点选题官（12）');
});

test('readScheduledSessionGeneration reads the generation back from the title', () => {
  assert.equal(readScheduledSessionGeneration('[定时] Daily check', 'Daily check'), 1);
  assert.equal(readScheduledSessionGeneration('[定时] Daily check（2）', 'Daily check'), 2);
  assert.equal(readScheduledSessionGeneration('[定时] Daily check（11）', 'Daily check'), 11);
  // Renamed task or session: unknown generation reads as 1.
  assert.equal(readScheduledSessionGeneration('[定时] Renamed', 'Daily check'), 1);
  assert.equal(readScheduledSessionGeneration('[定时] Daily check（x）', 'Daily check'), 1);
});

test('readSessionContextUsageRatio only trusts real usage readings', () => {
  assert.equal(readSessionContextUsageRatio(null), null);
  assert.equal(readSessionContextUsageRatio({}), null);
  assert.equal(
    readSessionContextUsageRatio({ lastRealContextUsage: { usageRatio: 0.25, isRealUsage: false } }),
    null
  );
  assert.equal(
    readSessionContextUsageRatio({ lastRealContextUsage: { usageRatio: 0.25, isRealUsage: true } }),
    0.25
  );
  assert.equal(
    readSessionContextUsageRatio({ lastRealContextUsage: { usedTokens: 300, contextWindow: 1000, isRealUsage: true } }),
    0.3
  );
});

test('buildScheduledSessionContinuityNote reuses without a note and explains rotations', () => {
  assert.equal(
    buildScheduledSessionContinuityNote({ kind: 'reuse' }).includes('[Standing conversation]'),
    true
  );
  const rotated = buildScheduledSessionContinuityNote({
    kind: 'rotate',
    cause: 'budget',
    generation: 2,
    previousTitle: '[定时] Daily check',
    previousSessionId: 'session-1',
    previousResult: { excerpt: 'Tail of the last report.', truncated: true },
  });
  assert.ok(rotated.includes('conversation #2'));
  assert.ok(rotated.includes('[定时] Daily check'));
  assert.ok(rotated.includes('session session-1'));
  assert.ok(rotated.includes('Tail of the last report.'));
  assert.ok(rotated.includes('tail excerpt'));
});

// --- Series fire behavior ---

test('first fire of a series task opens "[定时] <name>" and seats it as the standing conversation', async () => {
  const task = createTask();
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.createdSessions[0].title, '[定时] Daily check');
  assert.deepEqual(recording.seatedSeries, ['session-1']);
  assert.equal(recording.runnerCalls[0].sessionId, 'session-1');
  // A first standing conversation carries no continuity note.
  assert.equal(recording.runnerCalls[0].prompt.includes('[Standing conversation]'), false);
});

test('later fires continue the standing conversation with the continuity note instead of opening new sessions', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'standing-1': seriesSession('standing-1') },
  });

  await scheduler.executeTask(task, 'manual');
  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.seatedSeries, []);
  assert.deepEqual(recording.runnerCalls.map((call) => call.sessionId), ['standing-1', 'standing-1']);
  for (const call of recording.runnerCalls) {
    assert.ok(call.prompt.includes('[Standing conversation] Earlier fires of this task ran in this same conversation'));
    assert.ok(call.prompt.endsWith('Run the check'));
  }
});

test('a legacy task adopts the session of its latest run instead of opening yet another session', async () => {
  const task = createTask({ latestRunSessionId: 'prev-fire' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'prev-fire': seriesSession('prev-fire') },
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.seatedSeries, ['prev-fire']);
  assert.equal(recording.runnerCalls[0].sessionId, 'prev-fire');
  assert.ok(recording.runnerCalls[0].prompt.includes('[Standing conversation]'));
});

test('adoption skips a latest-run session that belongs to another bot or is not a scheduled conversation', async () => {
  for (const { name, sessionOverrides, harnessOverrides } of [
    { name: 'other-bot', sessionOverrides: { metabotId: 42 }, harnessOverrides: {} },
    { name: 'not-schedule', sessionOverrides: { autoOrigin: null }, harnessOverrides: {} },
    { name: 'archived', sessionOverrides: {}, harnessOverrides: { archived: ['prev-fire'] } },
    { name: 'a2a', sessionOverrides: { sessionType: 'a2a' }, harnessOverrides: {} },
    { name: 'hidden', sessionOverrides: { hiddenFromSessionList: true }, harnessOverrides: {} },
  ]) {
    const task = createTask({ latestRunSessionId: 'prev-fire' });
    const { scheduler, recording } = createHarness({
      task,
      sessions: { 'prev-fire': seriesSession('prev-fire', sessionOverrides) },
      ...harnessOverrides,
    });

    await scheduler.executeTask(task, 'manual');

    assert.equal(recording.createdSessions.length, 1, `${name}: opened a new conversation`);
    assert.deepEqual(recording.seatedSeries, ['session-1'], `${name}: seated the new conversation`);
    assert.equal(recording.createdSessions[0].title, '[定时] Daily check', `${name}: base title`);
  }
});

test('a standing conversation over the context ratio rotates to "（2）" with a pointer and the previous result', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: {
      'standing-1': seriesSession('standing-1', {
        usageStats: { lastRealContextUsage: { usageRatio: SERIES_SESSION_CONTEXT_RATIO_LIMIT + 0.05, isRealUsage: true } },
        lastAssistantContent: 'Assistant replied here.',
      }),
    },
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.createdSessions.length, 1);
  assert.equal(recording.createdSessions[0].title, '[定时] Daily check（2）');
  assert.deepEqual(recording.seatedSeries, ['session-1']);
  const fire = recording.runnerCalls[0];
  assert.ok(fire.prompt.includes('[Standing conversation rotated]'));
  assert.ok(fire.prompt.includes('conversation #2'));
  assert.ok(fire.prompt.includes('Assistant replied here.'));
  // The pointer rides in the OLD conversation, the fire prompt in the new one.
  const pointer = recording.addMessages.find((m) => m.sessionId === 'standing-1' && m.type === 'system');
  assert.ok(pointer, 'rotation pointer posted to the old conversation');
  assert.ok(pointer.content.includes('[定时] Daily check（2）'));
  assert.equal(fire.sessionId, 'session-1');
});

test('rotation generation follows the stored title, so "（2）" rotates to "（3）"', async () => {
  const task = createTask({ seriesSessionId: 'standing-2' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: {
      'standing-2': seriesSession('standing-2', {
        title: '[定时] Daily check（2）',
        messageCount: SERIES_SESSION_MESSAGE_LIMIT,
      }),
    },
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.createdSessions[0].title, '[定时] Daily check（3）');
});

test('the message backstop rotates a conversation with no usage readings', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: {
      'standing-1': seriesSession('standing-1', { messageCount: SERIES_SESSION_MESSAGE_LIMIT }),
    },
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.createdSessions[0].title, '[定时] Daily check（2）');
});

test('a busy standing conversation holds the fire only briefly, then runs it one-off and keeps the seat', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'standing-1': seriesSession('standing-1') },
    activeSessionIds: ['standing-1'],
  });

  await scheduler.executeTask(task, 'manual');

  // The one-off fire is a brand-new session; the standing conversation keeps
  // its seat (only 'new'/'rotate' seats write).
  assert.equal(recording.createdSessions.length, 1);
  assert.deepEqual(recording.seatedSeries, []);
  assert.equal(recording.runnerCalls[0].sessionId, 'session-1');
});

test('an archived standing conversation rotates to a successor without touching the archived one', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'standing-1': seriesSession('standing-1') },
    archived: ['standing-1'],
  });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.createdSessions[0].title, '[定时] Daily check（2）');
  assert.ok(recording.runnerCalls[0].prompt.includes('can no longer host this task'));
  // No pointer into an archived conversation.
  const pointer = recording.addMessages.find((m) => m.sessionId === 'standing-1' && m.type === 'system');
  assert.equal(pointer, undefined);
});

test('sessionMode "fresh" keeps the one-off behavior and never seats a conversation', async () => {
  const task = createTask({ sessionMode: 'fresh' });
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');
  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.createdSessions.map((s) => s.title), [
    '[定时] Daily check',
    '[定时] Daily check',
  ]);
  assert.deepEqual(recording.seatedSeries, []);
  assert.deepEqual(recording.runnerCalls.map((call) => call.sessionId), ['session-1', 'session-2']);
  assert.equal(recording.runnerCalls[1].prompt.includes('[Standing conversation]'), false);
});

test('a bound targetSessionId still wins over the series path', async () => {
  const task = createTask({ targetSessionId: 'bound-session', seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: {
      'bound-session': seriesSession('bound-session'),
      'standing-1': seriesSession('standing-1'),
    },
    submitToSession: () => ({ success: true, mode: 'continue' }),
  });

  await scheduler.executeTask(task, 'manual');

  assert.deepEqual(recording.createdSessions, []);
  assert.equal(recording.runnerCalls.length, 0);
  assert.equal(recording.submitCalls[0].sessionId, 'bound-session');
});

test('a global stop evaporates a fire still waiting for a busy conversation', async () => {
  const task = createTask({ seriesSessionId: 'standing-1' });
  const { scheduler, recording } = createHarness({
    task,
    sessions: { 'standing-1': seriesSession('standing-1') },
    activeSessionIds: ['standing-1'],
    busyWaitMs: 5_000,
    busyPollMs: 5,
  });

  const execution = scheduler.executeTask(task, 'manual');
  scheduler.stop();
  // SchedulerStoppedError resolves the run without completing or starting
  // anything — the same semantics as a stop during a fresh-session fire.
  await execution;
  assert.deepEqual(recording.runnerCalls, []);
  assert.deepEqual(recording.createdSessions, []);
  assert.deepEqual(recording.seatedSeries, []);
});
