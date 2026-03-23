import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const initSqlJs = require('sql.js');
const { ScheduledTaskStore } = require('../dist-electron/scheduledTaskStore.js');
const { Scheduler } = require('../dist-electron/libs/scheduler.js');

const sqlWasmPath = path.join(projectRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
const scheduledTaskScriptPath = path.join(projectRoot, 'SKILLs', 'scheduled-task', 'scripts', 'create-task.sh');

async function createSqlDatabase() {
  const SQL = await initSqlJs({
    locateFile: () => sqlWasmPath,
  });
  return new SQL.Database();
}

function createScheduledTaskTables(db) {
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
}

test('ScheduledTaskStore persists metabotId with the task', async () => {
  const db = await createSqlDatabase();
  createScheduledTaskTables(db);
  const store = new ScheduledTaskStore(db, () => {});

  const created = store.createTask({
    name: 'Post buzz every 10 minutes',
    description: '',
    schedule: {
      type: 'interval',
      intervalMs: 10 * 60 * 1000,
      unit: 'minutes',
      value: 10,
    },
    prompt: 'post a buzz',
    workingDirectory: '/tmp',
    systemPrompt: '',
    executionMode: 'auto',
    metabotId: 42,
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
  });

  assert.equal(created?.metabotId, 42);
  assert.equal(store.getTask(created.id)?.metabotId, 42);
});

test('Scheduler.startCoworkSession binds the scheduled task metabotId to the new session', async () => {
  const createSessionCalls = [];
  const runnerCalls = [];
  const scheduler = new Scheduler({
    scheduledTaskStore: {
      getTask: () => null,
    },
    coworkStore: {
      getConfig: () => ({
        workingDirectory: '/workspace/default',
        systemPrompt: 'global-system',
        executionMode: 'auto',
      }),
      createSession: (...args) => {
        createSessionCalls.push(args);
        return { id: 'session-1' };
      },
      updateSession: () => {},
      addMessage: () => {},
    },
    getCoworkRunner: () => ({
      startSession: async (...args) => {
        runnerCalls.push(args);
      },
    }),
  });

  const sessionId = await scheduler.startCoworkSession({
    id: 'task-1',
    name: 'Buzz',
    description: '',
    enabled: true,
    schedule: { type: 'interval', intervalMs: 600000, unit: 'minutes', value: 10 },
    prompt: 'send one buzz',
    workingDirectory: '/workspace/task',
    systemPrompt: '',
    executionMode: 'auto',
    metabotId: 42,
    expiresAt: null,
    notifyPlatforms: [],
    state: {
      nextRunAtMs: null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  assert.equal(sessionId, 'session-1');
  assert.equal(createSessionCalls.length, 1);
  assert.equal(createSessionCalls[0][5], 42, 'metabotId should be forwarded to coworkStore.createSession');
  assert.equal(runnerCalls.length, 1);
});

test('scheduled-task create script forwards IDBOTS_METABOT_ID when payload omits metabotId', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        body,
      });
      res.writeHead(201, {
        'content-type': 'application/json',
        connection: 'close',
      });
      res.end(JSON.stringify({ success: true, task: { id: 'task-1' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : null;
  assert.ok(port, 'server should expose a port');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-scheduled-task-'));
  const payloadPath = path.join(tempDir, 'task.json');
  fs.writeFileSync(payloadPath, JSON.stringify({
    name: 'Buzz',
    prompt: 'send one buzz',
    schedule: {
      type: 'interval',
      intervalMs: 600000,
      unit: 'minutes',
      value: 10,
    },
  }), 'utf8');

  try {
    await execFileAsync('bash', [scheduledTaskScriptPath, `@${payloadPath}`], {
      cwd: projectRoot,
      env: {
        ...process.env,
        IDBOTS_API_BASE_URL: `http://127.0.0.1:${port}`,
        IDBOTS_METABOT_ID: '42',
      },
    });
  } finally {
    server.closeAllConnections?.();
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }

  assert.equal(requests.length, 1);
  const requestJson = JSON.parse(requests[0].body);
  assert.equal(requestJson.metabotId, 42);
});
