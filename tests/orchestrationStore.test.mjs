import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-orchestration-store-'));

async function openStore() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  return { sqliteStore, orchestration: new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction()) };
}

test('orchestration tables are created idempotently on an existing database', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const db = sqliteStore.getDatabase();
    for (const table of ['orchestration_tasks', 'orchestration_steps', 'orchestration_attempts']) {
      const result = db.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${table}'`);
      assert.equal(result[0]?.values?.[0]?.[0], table);
    }
    new OrchestrationStore(db, sqliteStore.getSaveFunction());
    assert.equal(orchestration.listActiveTasks().length, 0);
  } finally {
    sqliteStore.close();
  }
});

test('task, step, and attempt lifecycle is durable and idempotent', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const task = orchestration.createTask({
      ownerIntent: 'Build the MetaID knowledge-base MetaApp',
      enrichedGoal: 'Produce a publishable HTML MetaApp',
      acceptanceCriteria: [{ id: 'html', check: 'index.html exists' }],
      sourceSessionId: 'twin-session',
      twinMetabotId: 1,
      ownerGlobalMetaId: 'owner-global',
    });
    assert.equal(task.status, 'planning');
    assert.deepEqual(task.acceptanceCriteria, [{ id: 'html', check: 'index.html exists' }]);

    orchestration.updateTaskStatus(task.id, 'running');
    const step = orchestration.createStep({
      taskId: task.id,
      ordinal: 1,
      title: 'Build',
      objective: 'Create the HTML MetaApp',
      acceptanceCriteria: ['index.html exists'],
      assigneeMetabotId: 2,
      status: 'ready',
    });
    assert.equal(orchestration.getActiveWorkload(2), 1);
    const attempt = orchestration.createAttempt({
      stepId: step.id,
      idempotencyKey: `${task.id}:step-1:attempt-1`,
      workerMetabotId: 2,
      prompt: 'Build the requested MetaApp and return structured evidence.',
    });
    assert.equal(orchestration.createAttempt({
      stepId: step.id,
      idempotencyKey: `${task.id}:step-1:attempt-1`,
      workerMetabotId: 2,
      prompt: 'This duplicate must not execute.',
    }).id, attempt.id);

    orchestration.updateStepStatus(step.id, 'queued');
    orchestration.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    orchestration.updateAttempt(attempt.id, 'running', { workerSessionId: 'worker-session-2' });
    orchestration.updateAttempt(attempt.id, 'completed', { result: { deliverables: ['file:///workspace/index.html'] } });
    orchestration.updateStepStatus(step.id, 'completed', { acceptedResult: { verified: true } });
    assert.equal(orchestration.getActiveWorkload(2), 0);
    assert.equal(orchestration.listAttempts(step.id)[0].status, 'completed');
    assert.deepEqual(orchestration.getStep(step.id).acceptedResult, { verified: true });
    assert.throws(() => orchestration.updateAttempt(attempt.id, 'running'), /Illegal orchestration attempt status transition/);
  } finally {
    sqliteStore.close();
  }
});

test('long-term subtask lookup returns every delegation for that exact subtask only', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const first = orchestration.createTask({
      ownerIntent: 'first slice', twinMetabotId: 1, ownerGlobalMetaId: 'owner',
      longtermTaskId: 'ltt-1', longtermSubtaskId: 'lts-1',
    });
    const second = orchestration.createTask({
      ownerIntent: 'retry slice', twinMetabotId: 1, ownerGlobalMetaId: 'owner',
      longtermTaskId: 'ltt-1', longtermSubtaskId: 'lts-1',
    });
    orchestration.createTask({
      ownerIntent: 'other subtask', twinMetabotId: 1, ownerGlobalMetaId: 'owner',
      longtermTaskId: 'ltt-1', longtermSubtaskId: 'lts-2',
    });
    assert.deepEqual(
      orchestration.listTasksForLongTermSubtask('ltt-1', 'lts-1').map((task) => task.id),
      [first.id, second.id],
    );
  } finally {
    sqliteStore.close();
  }
});

test('restart recovery fails in-flight attempts and returns steps to ready without touching completed evidence', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const task = orchestration.createTask({ ownerIntent: 'recover me', twinMetabotId: 1, ownerGlobalMetaId: 'owner' });
    const step = orchestration.createStep({ taskId: task.id, ordinal: 1, title: 'Recover', objective: 'resume', assigneeMetabotId: 2, status: 'ready' });
    const attempt = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'recover-key', workerMetabotId: 2, prompt: 'resume' });
    orchestration.updateStepStatus(step.id, 'queued');
    orchestration.updateStepStatus(step.id, 'running', { activeAttemptId: attempt.id });
    orchestration.updateAttempt(attempt.id, 'running', { workerSessionId: 'stale-worker-session' });
    assert.deepEqual(orchestration.recoverAfterRestart(), { attempts: 1, steps: 1 });
    assert.equal(orchestration.getAttempt(attempt.id).status, 'failed');
    assert.equal(orchestration.getAttempt(attempt.id).error, 'RECOVERED_AFTER_RESTART');
    assert.equal(orchestration.getStep(step.id).status, 'ready');
    assert.equal(orchestration.getStep(step.id).activeAttemptId, null);
  } finally {
    sqliteStore.close();
  }
});
