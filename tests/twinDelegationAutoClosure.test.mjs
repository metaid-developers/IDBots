// Twin delegation auto-closure + ORCH-NOTIFY oversized-text trim retry.
//
// WHY: the v1.5 owner ruling (「谁发起，谁验收」) made twin_delegate cards
// twin-closable and excluded them from the owner's pending closure queue —
// but nothing ever performed the close. Every delegation accumulated as a
// permanent 'review' row (543 review vs 124 completed in the 2026-11-09
// store audit), and the attention loop kept re-flagging delivered work as
// "awaits Twin verification". This suite pins:
//   * the last accepted step of a twin_delegate card auto-completes it
//     (review → completed + self-processed closure) and reports
//     taskAutoCompleted in the accept result;
//   * a mid-way acceptance leaves the card open;
//   * owner-origin cards keep their own closure ceremony;
//   * an ORCH-NOTIFY failure notification exceeding the 12k insert cap is
//     trimmed and retried instead of being dropped forever.
//
// Requires: pnpm run compile:electron

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { CoworkCrossSessionService } = require('../dist-electron/main/services/coworkCrossSession.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-auto-close-'));

function makeBots() {
  return [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: ['metaapp-builder'] },
  ];
}

function makeCrossSessionHarness() {
  const sessions = new Map([
    ['twin-session', { id: 'twin-session', sessionType: 'standard' }],
    ['worker-session-2', { id: 'worker-session-2', sessionType: 'standard' }],
  ]);
  const inserted = [];
  const store = {
    getSession: (id) => sessions.get(id) ?? null,
    getSessionMetadata: (id) => sessions.get(id) ?? null,
    getSessionLatestMessage: () => null,
    getSessionLatestVisibleMessage: () => null,
    addMessage: (sessionId, message) => {
      const full = { id: 'm-' + (inserted.length + 1), timestamp: 1700000000000, ...message };
      inserted.push({ targetSessionId: sessionId, message: full });
      return full;
    },
  };
  const service = new CoworkCrossSessionService(store);
  return { service, inserted };
}

function makeKv() {
  const map = new Map();
  return {
    get: (key) => map.get(key),
    set: (key, value) => { map.set(key, value); },
    delete: (key) => { map.delete(key); },
    map,
  };
}

async function makeService(runWorkerTurn, overrides = {}) {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const orchestrationStore = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const bots = makeBots();
  const directory = {
    getSession: (id) => id === 'twin-session' ? { id, metabotId: 1 } : id === 'worker-session' ? { id, metabotId: 2 } : null,
    listMetabots: () => bots,
    getOwnerGlobalMetaId: () => 'owner-global',
  };
  const runner = {
    insertCrossSessionMessageAndQueue(input) {
      return {
        insert: {
          ok: true,
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          message: { id: 'm', type: 'user', content: input.message, timestamp: 1700000000000, metadata: null },
        },
        runQueued: true,
        queueDepth: 0,
      };
    },
  };
  const service = new TwinOrchestrationService({
    orchestrationStore,
    coworkStore: {},
    coworkRunner: runner,
    directory,
    getMetabotById: (id) => bots.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: (id) => `/tmp/idbots-worker-${id}`,
    runWorkerTurn,
    ...(overrides.insertCrossSessionUserMessage ? { insertCrossSessionUserMessage: overrides.insertCrossSessionUserMessage } : {}),
    ...(overrides.kv ? { kv: overrides.kv } : {}),
  });
  return { sqliteStore, orchestrationStore, service };
}

async function waitFor(assertion, timeoutMs = 500) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try { assertion(); return; } catch (error) { lastError = error; await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  if (lastError) throw lastError;
  assertion();
}

const EVIDENCE = [{ kind: 'other', uri: 'verified against acceptance criteria' }];

async function delegateCompletingTask(service, idempotencyKey) {
  const result = await service.delegateLocalWorker('twin-session', {
    workerMetabotId: 2,
    objective: 'Build the bounded thing',
    idempotencyKey,
  });
  await waitFor(() => {
    const task = result.task;
    assert.ok(task);
  });
  return result;
}

test('the last accepted step of a twin_delegate card auto-completes it with a self-closure', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    return 'Handoff: built index.html; verification evidence: file exists.';
  });
  try {
    const { task, step } = await delegateCompletingTask(service, 'auto-close-single');
    await waitFor(() => assert.equal(orchestrationStore.getTask(task.id).status, 'review'));

    const accepted = service.acceptStep('twin-session', {
      stepId: step.id,
      taskId: task.id,
      evidence: EVIDENCE,
      note: 'Verified against the acceptance criteria.',
    });
    assert.equal(accepted.taskAutoCompleted, true, 'the accept result reports the auto-completion');
    const closed = orchestrationStore.getTask(task.id);
    assert.equal(closed.status, 'completed');
    assert.ok(closed.completedAt, 'completed_at stamped');

    const mark = orchestrationStore.getClosureMark(task.id);
    assert.ok(mark, 'closure mark written');
    assert.equal(mark.by, 'twin');
    assert.equal(mark.conclusion, null);
    assert.ok(mark.at);

    // v1.5: the self-closure writes its own processed mark in the same
    // statement — it must never leak into the owner's pending queue.
    const processed = sqliteStore.getDatabase().exec(
      'SELECT closure_processed_by FROM orchestration_tasks WHERE id = ?', [task.id],
    );
    assert.equal(processed[0]?.values?.[0]?.[0], 'twin');
  } finally {
    sqliteStore.close();
  }
});

test('a mid-way acceptance leaves the card open until the last step is accepted', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    return 'Handoff: built it; verification evidence: file exists.';
  });
  try {
    const first = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'step one', idempotencyKey: 'auto-close-multi-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(first.task.id).status, 'review'));
    // Second delegation on the SAME task adds step 2 (twin_delegate origin kept).
    const second = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2,
      objective: 'step two',
      taskId: first.task.id,
      idempotencyKey: 'auto-close-multi-2',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(first.task.id).status, 'review'));
    assert.notEqual(first.step.id, second.step.id);

    const firstAccept = service.acceptStep('twin-session', {
      stepId: first.step.id, taskId: first.task.id, evidence: EVIDENCE,
    });
    assert.equal(firstAccept.taskAutoCompleted, undefined, 'one of two steps accepted — card stays open');
    assert.equal(orchestrationStore.getTask(first.task.id).status, 'review');

    const secondAccept = service.acceptStep('twin-session', {
      stepId: second.step.id, taskId: first.task.id, evidence: EVIDENCE,
    });
    assert.equal(secondAccept.taskAutoCompleted, true);
    assert.equal(orchestrationStore.getTask(first.task.id).status, 'completed');
  } finally {
    sqliteStore.close();
  }
});

test('owner-origin cards are never auto-completed by a step acceptance', async () => {
  const { sqliteStore, orchestrationStore, service } = await makeService(async () => 'unused');
  try {
    const task = orchestrationStore.createTask({
      ownerIntent: 'owner-created card',
      twinMetabotId: 1,
      ownerGlobalMetaId: 'owner-global',
      sourceSessionId: 'twin-session',
      origin: 'owner',
    });
    orchestrationStore.updateTaskStatus(task.id, 'running');
    const step = orchestrationStore.createStep({
      taskId: task.id,
      ordinal: 1,
      title: 'Step 1',
      objective: 'do it',
      assigneeMetabotId: 2,
      status: 'ready',
    });
    orchestrationStore.updateStepStatus(step.id, 'queued');
    orchestrationStore.updateStepStatus(step.id, 'running');
    orchestrationStore.updateStepStatus(step.id, 'completed', { acceptedResult: { summary: 'done' } });
    orchestrationStore.updateTaskStatus(task.id, 'review');

    const accepted = service.acceptStep('twin-session', {
      stepId: step.id, taskId: task.id, evidence: EVIDENCE,
    });
    assert.equal(accepted.taskAutoCompleted, undefined, 'owner cards keep their closure ceremony');
    assert.equal(orchestrationStore.getTask(task.id).status, 'review');
  } finally {
    sqliteStore.close();
  }
});

test('an oversized failure notification is trimmed and retried instead of dropped', async () => {
  const cross = makeCrossSessionHarness();
  const kv = makeKv();
  // Enforce the 12k cross-session insert cap the way the real seam does.
  const capEnforcingInsert = (input) => {
    if (input.message.length > 12000) {
      return { ok: false, code: 'MESSAGE_TOO_LONG', message: 'Message must be 12000 characters or fewer.' };
    }
    return cross.service.insertUserMessage(input);
  };
  const hugeError = 'worker crashed: ' + 'x'.repeat(20000);
  const { sqliteStore, orchestrationStore, service } = await makeService(async (params) => {
    await params.onSessionCreated('worker-session-2');
    throw new Error(hugeError);
  }, { insertCrossSessionUserMessage: capEnforcingInsert, kv });
  try {
    const result = await service.delegateLocalWorker('twin-session', {
      workerMetabotId: 2, objective: 'fail loudly', idempotencyKey: 'notify-trim-1',
    });
    await waitFor(() => assert.equal(orchestrationStore.getTask(result.task.id).status, 'failed'));

    assert.equal(cross.inserted.length, 1, 'the trimmed retry delivered the notification');
    const delivered = cross.inserted[0].message.content;
    assert.ok(delivered.length <= 12000 + 500, `delivered within the cap (got ${delivered.length})`);
    assert.match(delivered, /\[ORCH-NOTIFY\] worker Builder 未完成 task/);
    assert.match(delivered, /已截断/);
    assert.equal(kv.get(`orch_notify:${result.task.id}:${result.attempt.id}:failed`), '1', 'guard set on the delivered notice');
  } finally {
    sqliteStore.close();
  }
});
