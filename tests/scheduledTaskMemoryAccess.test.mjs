import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Module from 'node:module';
import { createRequire } from 'node:module';
import { createSqliteStore, getColumns, getSqlJs } from './memoryTestUtils.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Part 1: scheduler -> runner option mapping (loaded from dist-electron, so
// run `pnpm run compile:electron` first). Harness mirrors
// tests/schedulerTargetSession.test.mjs.
// ---------------------------------------------------------------------------

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
    memoryAccess: 'none',
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

function createHarness({ task, practiceProposal = null } = {}) {
  const { Scheduler } = loadSchedulerWithElectronStub();
  const recording = {
    runnerCalls: [],
  };
  let runIndex = 0;

  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getNextDueTimeMs: () => null,
      getDueTasks: () => [],
      getRunningTasks: () => [],
      getTask: () => task,
      createRun: (taskId, trigger) => ({
        id: `run-${++runIndex}`,
        taskId,
        sessionId: null,
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        durationMs: null,
        error: null,
        trigger,
      }),
      markTaskRunning: () => {},
      // The fire path claims atomically and refreshes its liveness marker.
      tryMarkTaskRunning: () => true,
      touchTaskRunning: () => {},
      recordSkippedRun: () => ({}),
      releaseStuckRunningTask: () => {},
      completeRun: (runId, status, sessionId, durationMs, error) => ({
        id: runId,
        taskId: task.id,
        sessionId,
        status,
        durationMs,
        error,
      }),
      markTaskCompleted: () => {},
      toggleTask: () => {},
      pruneRuns: () => {},
      getRun: () => null,
      getTaskSessionId: () => null,
      setTaskSessionId: () => {},
    },
    coworkStore: {
      getConfig: () => ({
        workingDirectory: '/tmp',
        systemPrompt: '',
        executionMode: 'local',
      }),
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId) => ({
        id: `session-${recording.runnerCalls.length + 1}`,
      }),
      getSessionWithoutMessages: () => null,
      isSessionArchived: () => false,
      setSessionAutoOrigin: () => {},
      updateSession: () => {},
      addMessage: () => {},
      ...(practiceProposal
        ? { getDreamPracticeProposalByScheduledTaskId: () => practiceProposal }
        : {}),
    },
    getCoworkRunner: () => ({
      startSession: async (sessionId, prompt, options) => {
        recording.runnerCalls.push({ sessionId, prompt, options });
      },
      stopSession: () => {},
    }),
    getIMGatewayManager: () => null,
    getSkillsPrompt: async () => null,
  });

  return { scheduler, recording };
}

test('A task without memoryAccess keeps the legacy memory blackout', async () => {
  const task = createTask({ memoryAccess: undefined });
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');

  assert.equal(recording.runnerCalls.length, 1);
  const options = recording.runnerCalls[0].options;
  assert.equal(options.disableMemoryUpdates, true);
  assert.ok(!options.memoryReadOnly);
  assert.ok(!options.autoApprove);
  assert.equal(options.practiceSession, undefined);
});

test('A read-only task mounts the recall tools without the mutating ones', async () => {
  const task = createTask({ memoryAccess: 'read-only' });
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');

  const options = recording.runnerCalls[0].options;
  assert.equal(options.memoryReadOnly, true);
  assert.ok(!options.disableMemoryUpdates);
});

test('A read-write task leaves both memory flags off', async () => {
  const task = createTask({ memoryAccess: 'read-write' });
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');

  const options = recording.runnerCalls[0].options;
  assert.ok(!options.disableMemoryUpdates);
  assert.ok(!options.memoryReadOnly);
});

test('An invalid memoryAccess value falls back to the legacy blackout', async () => {
  const task = createTask({ memoryAccess: 'banana' });
  const { scheduler, recording } = createHarness({ task });

  await scheduler.executeTask(task, 'manual');

  const options = recording.runnerCalls[0].options;
  assert.equal(options.disableMemoryUpdates, true);
  assert.ok(!options.memoryReadOnly);
});

test('A practice proposal keeps precedence over the task memoryAccess', async () => {
  const task = createTask({ memoryAccess: 'read-write' });
  const { scheduler, recording } = createHarness({
    task,
    practiceProposal: { status: 'scheduled', riskClass: 'interact_local' },
  });

  await scheduler.executeTask(task, 'manual');

  const options = recording.runnerCalls[0].options;
  // Practice policy wins: read but never write, whatever the task declared.
  assert.equal(options.memoryReadOnly, true);
  assert.equal(options.autoApprove, true);
  assert.ok(options.practiceSession);
  assert.ok(!options.disableMemoryUpdates);
});

// ---------------------------------------------------------------------------
// Part 2: ScheduledTaskStore persistence (round-trip, legacy normalization,
// idempotent migration). Modeled on tests/scheduledTaskStoreSession.test.mjs.
// ---------------------------------------------------------------------------

function getStoreClass() {
  return require('../dist-electron/main/scheduledTaskStore.js').ScheduledTaskStore;
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

test('ScheduledTaskStore round-trips the memoryAccess opt-in', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});

    // Absent input -> legacy default.
    const defaultTask = store.createTask(createTaskInput());
    assert.equal(defaultTask.memoryAccess, 'none');

    // Explicit values persist.
    const readWrite = store.createTask(createTaskInput({ memoryAccess: 'read-write' }));
    assert.equal(readWrite.memoryAccess, 'read-write');
    assert.equal(store.getTask(readWrite.id).memoryAccess, 'read-write');

    // Updates rewrite when provided...
    const updated = store.updateTask(readWrite.id, { memoryAccess: 'read-only' });
    assert.equal(updated.memoryAccess, 'read-only');

    // ...invalid provided values normalize to 'none'...
    const normalized = store.updateTask(readWrite.id, { memoryAccess: 'garbage' });
    assert.equal(normalized.memoryAccess, 'none');

    // ...and absent values keep the stored one.
    const untouched = store.updateTask(readWrite.id, { name: 'Renamed' });
    assert.equal(untouched.memoryAccess, 'none');
    assert.equal(untouched.name, 'Renamed');
  } finally {
    cleanup();
  }
});

test('Legacy NULL and invalid memory_access rows read as none', async () => {
  const { db, cleanup } = await createSqliteStore();
  const ScheduledTaskStore = getStoreClass();

  try {
    const store = new ScheduledTaskStore(db, () => {});
    const legacy = store.createTask(createTaskInput());
    const corrupt = store.createTask(createTaskInput({ memoryAccess: 'read-only' }));

    // Simulate rows written before the column existed / by a foreign writer.
    db.run('UPDATE scheduled_tasks SET memory_access = NULL WHERE id = ?', [legacy.id]);
    db.run("UPDATE scheduled_tasks SET memory_access = 'read_WRITE' WHERE id = ?", [corrupt.id]);

    assert.equal(store.getTask(legacy.id).memoryAccess, 'none');
    assert.equal(store.getTask(corrupt.id).memoryAccess, 'none');
    assert.deepEqual(
      store.listTasks().map((task) => task.memoryAccess),
      ['none', 'none'],
    );
  } finally {
    cleanup();
  }
});

test('memory_access migration is idempotent across repeated construction', async () => {
  const SQL = await getSqlJs();
  const db = new SQL.Database();
  const ScheduledTaskStore = getStoreClass();

  try {
    // A pre-opt-in table: no memory_access column at all.
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
    // The constructor also touches the runs table; create it so startup
    // stays quiet (mirrors tests/scheduledTaskStoreSession.test.mjs).
    db.run(`
      CREATE TABLE scheduled_task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        duration_ms INTEGER,
        error TEXT,
        trigger_type TEXT NOT NULL DEFAULT 'scheduled'
      );
    `);

    assert.equal(getColumns(db, 'scheduled_tasks').includes('memory_access'), false);

    new ScheduledTaskStore(db, () => {});
    assert.equal(getColumns(db, 'scheduled_tasks').includes('memory_access'), true);

    // Second construction must not ALTER again (a duplicate add throws) and
    // must leave exactly one memory_access column behind.
    new ScheduledTaskStore(db, () => {});
    const occurrences = getColumns(db, 'scheduled_tasks').filter((name) => name === 'memory_access');
    assert.equal(occurrences.length, 1);

    // The migrated (formerly NULL) column resolves to the legacy default.
    const store = new ScheduledTaskStore(db, () => {});
    const task = store.createTask(createTaskInput());
    assert.equal(task.memoryAccess, 'none');
  } finally {
    db.close();
  }
});

// ---------------------------------------------------------------------------
// Part 3: static renderer / mobile-bridge coverage (source-level, mirroring
// tests/scheduledTaskSessionFieldUi.test.mjs — the main node suite does not
// compile TS, so behavior here is pinned by source assertions).
// ---------------------------------------------------------------------------

const taskFormPath = path.join(
  projectRoot,
  'src',
  'renderer',
  'components',
  'scheduledTasks',
  'TaskForm.tsx',
);
const i18nPath = path.join(projectRoot, 'src', 'renderer', 'services', 'i18n.ts');
const mockBridgePath = path.join(projectRoot, 'src', 'mobile', 'bridge', 'mockBridge.ts');
const rendererTypePath = path.join(projectRoot, 'src', 'renderer', 'types', 'scheduledTask.ts');

const MEMORY_ACCESS_KEYS = [
  'scheduledTasksFormMemoryAccess',
  'scheduledTasksFormMemoryAccessNone',
  'scheduledTasksFormMemoryAccessReadOnly',
  'scheduledTasksFormMemoryAccessReadWrite',
  'scheduledTasksFormMemoryAccessHint',
];

test('scheduled task form exposes the memory-access select wired into the payload', () => {
  const source = fs.readFileSync(taskFormPath, 'utf8');

  assert.match(source, /ScheduledTaskMemoryAccess/);
  assert.match(source, /const MEMORY_ACCESS_OPTIONS: ScheduledTaskMemoryAccess\[\] = \['none', 'read-only', 'read-write'\]/);
  assert.match(source, /useState<ScheduledTaskMemoryAccess>\(task\?\.memoryAccess \?\? 'none'\)/);
  assert.match(source, /setMemoryAccess\(e\.target\.value as ScheduledTaskMemoryAccess\)/);
  assert.match(source, /scheduledTasksFormMemoryAccessNone/);
  assert.match(source, /scheduledTasksFormMemoryAccessReadOnly/);
  assert.match(source, /scheduledTasksFormMemoryAccessReadWrite/);
  assert.match(source, /scheduledTasksFormMemoryAccessHint/);
  assert.match(source, /memoryAccess,/);
});

test('renderer type declares memoryAccess on the task and its input', () => {
  const source = fs.readFileSync(rendererTypePath, 'utf8');

  assert.match(source, /export type ScheduledTaskMemoryAccess = 'none' \| 'read-only' \| 'read-write'/);
  assert.match(source, /memoryAccess: ScheduledTaskMemoryAccess/);
  assert.match(source, /memoryAccess\?: ScheduledTaskMemoryAccess/);
});

test('i18n defines the memory-access keys in both languages', () => {
  const source = fs.readFileSync(i18nPath, 'utf8');
  const enBlockStart = source.indexOf('\n  en: {');
  assert.ok(enBlockStart > 0, 'expected an en translation block');

  const zhBlock = source.slice(0, enBlockStart);
  const enBlock = source.slice(enBlockStart);

  for (const key of MEMORY_ACCESS_KEYS) {
    assert.match(zhBlock, new RegExp(`\\b${key}:\\s*'`), `missing zh translation for ${key}`);
    assert.match(enBlock, new RegExp(`\\b${key}:\\s*'`), `missing en translation for ${key}`);
  }
});

test('mobile mockBridge validates the memory-access enum and defaults invalid values', () => {
  const source = fs.readFileSync(mockBridgePath, 'utf8');

  assert.match(source, /const SCHEDULED_TASK_MEMORY_ACCESS_OPTIONS: ScheduledTaskMemoryAccess\[\] = \[\s*'none',\s*'read-only',\s*'read-write',\s*\]/);
  assert.match(source, /unknown memory access/);
  assert.match(source, /SCHEDULED_TASK_MEMORY_ACCESS_OPTIONS\.includes\(input\.memoryAccess/);
});
