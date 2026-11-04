/**
 * Twin terminal notifications: at-most-once, arbitrated by the DATABASE.
 *
 * Root cause covered here: the old guard was a kv marker written AFTER
 * insertCrossSession. A process death between the insert and the kv write
 * re-notified the same terminal state, and two completion paths (normal
 * completion + late/recovered completion) could both call the notifier for one
 * attempt. Now `orchestrationStore.claimNotification` INSERTs a row keyed by
 * UNIQUE(attempt_id, outcome) BEFORE the cross-session insert; the row is the
 * decision and the kv marker is a secondary mirror.
 */
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

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-notify-once-'));

function makeBots() {
  return [
    { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
    { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: ['metaapp-builder'] },
  ];
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

/**
 * Service + real SqliteStore/OrchestrationStore, with a recording
 * insertCrossSession spy. console.log is captured so the skip-path assertion
 * can read the operator-visible line.
 */
async function makeHarness() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const store = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const db = sqliteStore.getDatabase();
  const bots = makeBots();
  const kv = makeKv();
  const inserts = [];
  // How many claim rows were visible at the exact moment the insert ran — the
  // "row is written BEFORE the cross-session insert" invariant.
  const rowsSeenAtInsert = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => { logs.push(args.map(String).join(' ')); };

  const service = new TwinOrchestrationService({
    orchestrationStore: store,
    coworkStore: {},
    coworkRunner: {},
    directory: {
      getSession: (id) => (id === 'twin-session' ? { id, metabotId: 1 } : null),
      listMetabots: () => bots,
      getOwnerGlobalMetaId: () => 'owner-global',
    },
    getMetabotById: (id) => bots.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: () => '/tmp/idbots-worker-2',
    runWorkerTurn: async () => 'unused by these tests',
    insertCrossSessionUserMessage: (input) => {
      const count = db.exec('SELECT COUNT(*) FROM orchestration_notifications')[0]?.values?.[0]?.[0] ?? 0;
      rowsSeenAtInsert.push(Number(count));
      inserts.push(input);
      return {
        ok: true,
        sourceSessionId: input.sourceSessionId,
        targetSessionId: input.targetSessionId,
        message: {
          id: 'm-' + inserts.length,
          type: 'user',
          content: input.message,
          timestamp: 1700000000000,
          metadata: null,
        },
      };
    },
    kv,
  });

  return {
    sqliteStore,
    store,
    db,
    kv,
    inserts,
    rowsSeenAtInsert,
    logs,
    service,
    restore: () => { console.log = originalLog; },
    close: () => { console.log = originalLog; sqliteStore.close(); },
  };
}

/** Seed one task/step/attempt without running a worker turn. */
function seedLedger(store, idempotencyKey) {
  const task = store.createTask({
    ownerIntent: 'notify once',
    enrichedGoal: 'notify once',
    acceptanceCriteria: [],
    sourceSessionId: 'twin-session',
    twinMetabotId: 1,
    ownerGlobalMetaId: 'owner-global',
    origin: 'twin_delegate',
  });
  const step = store.createStep({
    taskId: task.id,
    ordinal: 1,
    title: 'Build',
    objective: 'build something',
    acceptanceCriteria: [],
    assigneeMetabotId: 2,
    status: 'ready',
  });
  const attempt = store.createAttempt({
    stepId: step.id,
    idempotencyKey,
    workerMetabotId: 2,
    workerSessionId: 'worker-session-2',
    prompt: 'build something',
  });
  return { task, step, attempt };
}

const claim = (store, { task, step, attempt }, outcome) => store.claimNotification({
  taskId: task.id,
  stepId: step.id,
  attemptId: attempt.id,
  outcome,
});

// ---------------------------------------------------------------------------
// 1. The claim itself: first caller wins, later callers lose, exactly one row.
// ---------------------------------------------------------------------------
test('claimNotification: first claim true, second false, exactly one row', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-basic');
    assert.equal(claim(h.store, ledger, 'completed'), true);
    assert.equal(claim(h.store, ledger, 'completed'), false);

    const rows = h.store.listNotifications(ledger.task.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].attemptId, ledger.attempt.id);
    assert.equal(rows[0].outcome, 'completed');
    assert.equal(rows[0].stepId, ledger.step.id);

    const raw = h.db.exec('SELECT attempt_id, outcome FROM orchestration_notifications');
    assert.equal(raw[0].values.length, 1, 'UNIQUE(attempt_id, outcome) did not duplicate');
    assert.deepEqual(raw[0].values[0], [ledger.attempt.id, 'completed']);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 1b. Backends without change accounting: the read-back identity still decides.
// ---------------------------------------------------------------------------
test('claimNotification falls back to id read-back when getRowsModified is absent', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-no-rows-modified');
    let saves = 0;
    // Same database, but the store's view hides getRowsModified (a backend
    // that does not expose change accounting).
    const fallback = new OrchestrationStore({
      exec: (sql, params) => h.db.exec(sql, params),
      run: (sql, params) => h.db.run(sql, params),
      close: () => {},
    }, () => { saves += 1; });

    const input = {
      taskId: ledger.task.id,
      stepId: ledger.step.id,
      attemptId: ledger.attempt.id,
      outcome: 'completed',
    };
    assert.equal(fallback.claimNotification(input), true, 'the inserting caller wins by row id');
    assert.equal(fallback.claimNotification(input), false, 'a later caller sees a foreign row id');
    assert.equal(h.store.listNotifications(ledger.task.id).length, 1);
    assert.equal(saves, 2, 'table bootstrap + the successful claim each persist once');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 2a. Ordering: the claim row is committed BEFORE insertCrossSession runs.
// ---------------------------------------------------------------------------
test('the claim row exists at the moment the cross-session insert runs', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-ordering');
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');

    assert.equal(h.inserts.length, 1);
    assert.deepEqual(h.rowsSeenAtInsert, [1], 'claim row must already exist when the insert executes');
    assert.equal(h.store.listNotifications(ledger.task.id).length, 1);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 2b. Crash simulation: row landed, kv write lost -> no second notification.
// ---------------------------------------------------------------------------
test('crash after the claim but before the kv write cannot notify twice', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-crash');
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');
    assert.equal(h.inserts.length, 1);
    const guardKey = `orch_notify:${ledger.task.id}:${ledger.attempt.id}:completed`;
    assert.equal(h.kv.get(guardKey), '1', 'kv mirror set on success');

    // Simulate the process dying between the cross-session insert and the kv
    // write: the row is durable, the kv marker never landed.
    h.kv.delete(guardKey);
    assert.equal(h.kv.get(guardKey), undefined);

    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');
    assert.equal(h.inserts.length, 1, 'DB claim must suppress the second insert even with kv empty');
    assert.equal(h.store.listNotifications(ledger.task.id).length, 1);
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 3. The two completion paths for ONE attempt: exactly one notification.
//    In this tree the recovery completion lives in applyLateAttemptResult
//    (the branch's equivalent of the brief's settleRecoveredCompletion).
// ---------------------------------------------------------------------------
test('normal completion + recovered completion on one attempt -> one notification', async () => {
  const h = await makeHarness();
  try {
    const seeded = seedLedger(h.store, 'claim-two-paths');
    // Reach the state the recovery path expects: task running, step running,
    // attempt parked as timed_out by the watchdog.
    h.store.updateTaskStatus(seeded.task.id, 'running');
    h.store.updateStepStatus(seeded.step.id, 'queued');
    h.store.updateStepStatus(seeded.step.id, 'running');
    h.store.updateAttempt(seeded.attempt.id, 'timed_out', { error: 'SkillTurnTimeout' });

    // Recovery completion path (the settleRecoveredCompletion equivalent).
    await h.service.applyLateAttemptResult(
      h.store.getTask(seeded.task.id),
      h.store.getStep(seeded.step.id),
      seeded.attempt.id,
      'Handoff: done; verification evidence: tests pass.',
    );
    assert.equal(h.inserts.length, 1, 'recovery path notified once');
    assert.equal(h.store.getAttempt(seeded.attempt.id).status, 'completed');

    // Drop the kv mirror to prove the DATABASE is the arbiter, then let the
    // normal-completion site (executeAttempt line ~481) race in for the same
    // attempt and outcome.
    h.kv.delete(`orch_notify:${seeded.task.id}:${seeded.attempt.id}:completed`);
    h.service.notifyTwinTerminalState(
      h.store.getTask(seeded.task.id),
      h.store.getAttempt(seeded.attempt.id),
      'Builder',
      'completed',
    );
    assert.equal(h.inserts.length, 1, 'two completion paths must not produce two notifications');
    assert.equal(h.store.listNotifications(seeded.task.id).length, 1, 'and not two claim rows');
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 4. Separate outcomes for one attempt are separate rows (per-attempt kv
//    semantics preserved: completed then failed both notify).
// ---------------------------------------------------------------------------
test('completed and failed are distinct claims for the same attempt', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-two-outcomes');
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'failed', 'boom');

    assert.equal(h.inserts.length, 2, 'a different terminal state is a different notification');
    const rows = h.store.listNotifications(ledger.task.id);
    assert.deepEqual(rows.map((row) => row.outcome).sort(), ['completed', 'failed']);
    assert.equal(
      h.kv.map.get(`orch_notify:${ledger.task.id}:${ledger.attempt.id}:completed`),
      '1',
    );
    assert.equal(
      h.kv.map.get(`orch_notify:${ledger.task.id}:${ledger.attempt.id}:failed`),
      '1',
    );
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 5. The claim is per attempt: a second attempt of the SAME task still notifies.
// ---------------------------------------------------------------------------
test('a claim for one attempt does not block another attempt of the same task', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-attempt-1');
    const step2 = h.store.createStep({
      taskId: ledger.task.id,
      ordinal: 2,
      title: 'Build again',
      objective: 'second step',
      assigneeMetabotId: 2,
      status: 'ready',
    });
    const attempt2 = h.store.createAttempt({
      stepId: step2.id,
      idempotencyKey: 'claim-attempt-2',
      workerMetabotId: 2,
      workerSessionId: 'worker-session-3',
      prompt: 'second step',
    });

    assert.equal(claim(h.store, ledger, 'failed'), true);
    assert.equal(
      h.store.claimNotification({
        taskId: ledger.task.id,
        stepId: step2.id,
        attemptId: attempt2.id,
        outcome: 'failed',
      }),
      true,
      'a different attempt of the same task must still be claimable',
    );
    assert.equal(
      h.store.claimNotification({
        taskId: ledger.task.id,
        stepId: step2.id,
        attemptId: attempt2.id,
        outcome: 'failed',
      }),
      false,
    );
    const rows = h.store.listNotifications(ledger.task.id);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((row) => row.attemptId).sort(),
      [ledger.attempt.id, attempt2.id].sort(),
    );
  } finally {
    h.close();
  }
});

// ---------------------------------------------------------------------------
// 6. The new guard's skip is not silent: one operator-visible log line.
// ---------------------------------------------------------------------------
test('the DB-claim skip leaves a log line naming task, attempt and outcome', async () => {
  const h = await makeHarness();
  try {
    const ledger = seedLedger(h.store, 'claim-log');
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');
    h.kv.delete(`orch_notify:${ledger.task.id}:${ledger.attempt.id}:completed`);
    h.service.notifyTwinTerminalState(ledger.task, ledger.attempt, 'Builder', 'completed');

    assert.equal(h.inserts.length, 1);
    const skipLine = h.logs.find((line) => line.includes('notify skipped (already notified)'));
    assert.ok(skipLine, 'skip must be logged, not silent');
    assert.match(skipLine, /\[TwinOrchestration\] notify skipped \(already notified\)/);
    assert.ok(skipLine.includes(ledger.task.id), 'log names the task');
    assert.ok(skipLine.includes(ledger.attempt.id), 'log names the attempt');
    assert.match(skipLine, /outcome completed/);
  } finally {
    h.close();
  }
});
