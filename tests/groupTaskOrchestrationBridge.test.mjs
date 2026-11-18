import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-orchestration-'));

async function makeHarness() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const db = sqliteStore.getDatabase();
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [1, 'abandon ability able about above absent absorb abstract absurd abuse access accident bridge', "m/44'/10001'/0'/0/0", 1],
  );
  const insertBot = ({ id, name, type, globalmetaid, bossGlobalMetaId }) => {
    db.run(
      `INSERT INTO metabots (
        id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
        name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
        boss_global_metaid, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, '0000', ?, ?, ?, 1, 1)`,
      [
        id, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
        name, `metaid-${id}`, globalmetaid, type, `${name} role`, `${name} soul`, bossGlobalMetaId,
      ],
    );
  };
  insertBot({ id: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGlobalMetaId: 'gmid-owner' });
  insertBot({ id: 2, name: 'Builder Bot', type: 'worker', globalmetaid: 'gmid-worker', bossGlobalMetaId: 'gmid-owner' });

  const metabotStore = new MetabotStore(db, sqliteStore.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, sqliteStore.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, sqliteStore.getSaveFunction());
  const bridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });
  const groupTask = groupTaskStore.createTask({
    groupId: 'group-bridge',
    title: 'Build MetaApp',
    goal: 'Build and verify a MetaID knowledge MetaApp',
    acceptanceCriteria: 'A verifiable MetaApp PinID is delivered',
    chairMetabotId: 1,
    createdBy: 'user',
  });
  groupTaskStore.addMember({
    taskId: groupTask.id,
    metabotId: 1,
    globalmetaid: 'gmid-twin',
    role: 'chair',
  });
  groupTaskStore.addMember({
    taskId: groupTask.id,
    metabotId: 2,
    globalmetaid: 'gmid-worker',
    role: 'worker',
  });
  return { sqliteStore, groupTaskStore, orchestrationStore, bridge, groupTask };
}

test('Group Task canonical linking is lazy, durable, and idempotent', async () => {
  const h = await makeHarness();
  try {
    const canonical = h.bridge.ensureCanonicalTask(h.groupTask.id);
    assert.equal(canonical.status, 'planning');
    assert.equal(canonical.ownerGlobalMetaId, 'gmid-owner');
    assert.equal(canonical.twinMetabotId, 1);
    assert.equal(canonical.sourceSessionId, `group-task:${h.groupTask.id}`);
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).orchestrationTaskId, canonical.id);
    assert.equal(h.bridge.ensureCanonicalTask(h.groupTask.id).id, canonical.id);
    assert.equal(h.orchestrationStore.listActiveTasks().length, 1);
  } finally {
    h.sqliteStore.close();
  }
});

test('Worker handoff, deliverable evidence, review, and owner acceptance close both models', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp and return its PinID',
      sourceMessageKey: 'assignment-pin-i0',
    });
    assert.equal(started.task.status, 'running');
    assert.equal(started.step.status, 'queued');
    assert.equal(started.attempt.status, 'queued');
    assert.equal(h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'duplicate message must not create another attempt',
      sourceMessageKey: 'assignment-pin-i0',
    }).attempt.id, started.attempt.id);

    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    h.bridge.completeWorkerAttempt({
      attemptId: started.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://abc',
      groupMessagePinId: 'deliverable-message-i0',
    });
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'completed');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'waiting_input');

    const deliverable = h.groupTaskStore.addDeliverable({
      taskId: h.groupTask.id,
      msgPinId: 'deliverable-message-i0',
      authorGlobalmetaid: 'gmid-worker',
      kind: 'metaapp',
      uri: 'metaapp://abc',
    });
    h.bridge.recordDeliverable({
      groupTaskId: h.groupTask.id,
      deliverable,
      verificationNotes: ['Host verification: MetaApp PinID found on-chain.'],
    });
    const result = h.orchestrationStore.getAttempt(started.attempt.id).result;
    assert.equal(result.deliverables.length, 1);
    assert.equal(result.deliverables[0].groupTaskDeliverableId, deliverable.id);

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    assert.equal(h.bridge.syncStatus(h.groupTask.id).status, 'review');

    // P0-b (task #149): explicit owner actor — this test is the owner
    // acceptance lifecycle; a no-actor accept now flips deliverables to
    // 'delivered' instead of 'accepted'.
    const accepted = h.bridge.acceptGroupTask(h.groupTask.id, { kind: 'owner' });
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'completed');
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).result.ownerAccepted, true);
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).result.verified, false);
    assert.equal(h.groupTaskStore.listDeliverables(h.groupTask.id)[0].status, 'accepted');
  } finally {
    h.sqliteStore.close();
  }
});

test('cancelling a Group Task cancels its canonical attempts and steps', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Long-running work',
      sourceMessageKey: 'cancel-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    const cancelled = h.bridge.cancelGroupTask(h.groupTask.id);
    assert.equal(cancelled.groupTask.status, 'cancelled');
    assert.equal(cancelled.canonicalTask.status, 'cancelled');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'cancelled');
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'cancelled');
  } finally {
    h.sqliteStore.close();
  }
});

test('P0-1: failed noise steps do NOT block owner acceptance', async () => {
  const h = await makeHarness();
  try {
    // A real worker step that completed (waiting_input after completion)
    const real = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'real-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(real.attempt.id, 'session-real');
    h.bridge.completeWorkerAttempt({
      attemptId: real.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://realpin',
      groupMessagePinId: 'real-deliverable-i0',
    });

    // A noise step that failed (mistaken mention whose skill routing failed)
    const noise = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'noise message',
      sourceMessageKey: 'noise-message-i0',
    });
    h.bridge.failWorkerAttempt(noise.attempt.id, 'SKILL_ROUTING_FAILED');

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    // Acceptance must NOT throw despite the failed step
    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

test('P0-1b: ignoreFailedSteps demotes noise steps to completed with an ignored marker', async () => {
  const h = await makeHarness();
  try {
    const noise = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'noise',
      sourceMessageKey: 'noise-i0',
    });
    h.bridge.failWorkerAttempt(noise.attempt.id, 'SKILL_ROUTING_FAILED');
    assert.equal(h.orchestrationStore.getStep(noise.step.id).status, 'failed');

    const ignored = h.bridge.ignoreFailedSteps(h.groupTask.id);
    assert.equal(ignored, 1);
    const step = h.orchestrationStore.getStep(noise.step.id);
    assert.equal(step.status, 'completed');
    assert.equal(step.acceptedResult.ignored, true);

    // Real steps are untouched
    const real = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'real',
      sourceMessageKey: 'real-i0',
    });
    assert.equal(h.orchestrationStore.getStep(real.step.id).status, 'queued');
    assert.equal(h.bridge.ignoreFailedSteps(h.groupTask.id), 0, 'no more failed steps to ignore');
  } finally {
    h.sqliteStore.close();
  }
});

// ---------------------------------------------------------------------------
// F6 (GT#11): close path — no-step close succeeds; unfinished steps produce a
// detailed, actionable error instead of the bare "unfinished canonical steps"
// ---------------------------------------------------------------------------

test('F6: owner acceptance closes a task with no canonical steps (nothing unfinished)', async () => {
  const h = await makeHarness();
  try {
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

test('F6: close error names every unfinished step with its status and the remedy', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'f6-running-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'group-worker-session');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'running');

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    assert.throws(
      () => h.bridge.acceptGroupTask(h.groupTask.id),
      (error) => {
        assert.match(error.message, /1 unfinished canonical step/);
        assert.match(error.message, /"Worker assignment: Builder Bot" \[running\] assignee=bot-2/);
        assert.match(error.message, /re-dispatch/);
        assert.match(error.message, /noise steps never block/);
        return true;
      },
    );
    // Nothing closed: the group task stays in review, the step stays running.
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).status, 'review');
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'running');
  } finally {
    h.sqliteStore.close();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-acceptance: restart-recovery fossil steps (status 'ready' with
// a severed active-attempt link) must neither wedge the ledger on re-drive nor
// block owner acceptance forever.
// ---------------------------------------------------------------------------

test('re-driven trigger after restart recovery re-arms the fossil step with a fresh attempt', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'crash-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'session-before-crash');

    // Simulate the app dying mid-turn: recovery settles the attempt to failed
    // and parks the step as ready with no active attempt.
    h.orchestrationStore.recoverAfterRestart();
    const fossil = h.orchestrationStore.getStep(started.step.id);
    assert.equal(fossil.status, 'ready');
    assert.equal(fossil.activeAttemptId, null);
    assert.equal(h.orchestrationStore.getAttempt(started.attempt.id).status, 'failed');

    // The daemon re-drives the SAME unanswered trigger message after restart.
    const redriven = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'crash-assignment-i0',
    });
    assert.equal(redriven.reused, false);
    assert.equal(redriven.step.id, started.step.id, 'same step re-armed, no duplicate step');
    assert.equal(redriven.step.status, 'queued');
    assert.notEqual(redriven.attempt.id, started.attempt.id);
    assert.equal(redriven.attempt.status, 'queued');
    assert.equal(h.orchestrationStore.getStep(started.step.id).activeAttemptId, redriven.attempt.id);

    // The fresh attempt advances the ledger normally through to acceptance.
    h.bridge.markWorkerAttemptRunning(redriven.attempt.id, 'session-after-restart');
    h.bridge.completeWorkerAttempt({
      attemptId: redriven.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://recovered',
      groupMessagePinId: 'recovered-deliverable-i0',
    });
    assert.equal(h.orchestrationStore.getStep(started.step.id).status, 'waiting_input');

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
  } finally {
    h.sqliteStore.close();
  }
});

test('orphan ready steps (restart-recovery fossils) are auto-cancelled and do NOT block owner acceptance', async () => {
  const h = await makeHarness();
  try {
    // Real work that completed and reached waiting_input.
    const real = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'real-assignment-i0',
    });
    h.bridge.markWorkerAttemptRunning(real.attempt.id, 'session-real');
    h.bridge.completeWorkerAttempt({
      attemptId: real.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://realpin',
      groupMessagePinId: 'real-deliverable-i0',
    });

    // Two duplicate assignments (like the double "Worker assignment: eleven"
    // steps) whose attempts were running when the app died — the exact state
    // that trapped group task acceptance before this fix.
    for (const key of ['fossil-assignment-i0', 'fossil-assignment-i1']) {
      const fossil = h.bridge.beginWorkerAttempt({
        groupTaskId: h.groupTask.id,
        workerMetabotId: 2,
        objective: 'duplicate dispatch',
        sourceMessageKey: key,
      });
      h.bridge.markWorkerAttemptRunning(fossil.attempt.id, `session-${key}`);
    }
    h.orchestrationStore.recoverAfterRestart();
    const fossils = h.orchestrationStore.listSteps(real.step.taskId)
      .filter((step) => step.id !== real.step.id);
    assert.equal(fossils.length, 2);
    for (const fossil of fossils) {
      assert.equal(fossil.status, 'ready');
      assert.equal(fossil.activeAttemptId, null);
    }

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    // Acceptance cancels the orphans with an ignored marker and closes.
    const accepted = h.bridge.acceptGroupTask(h.groupTask.id);
    assert.equal(accepted.groupTask.status, 'done');
    assert.equal(accepted.canonicalTask.status, 'completed');
    assert.equal(h.orchestrationStore.getStep(real.step.id).status, 'completed');
    for (const fossil of fossils) {
      const step = h.orchestrationStore.getStep(fossil.id);
      assert.equal(step.status, 'cancelled');
      assert.equal(step.acceptedResult.ignored, true);
    }
  } finally {
    h.sqliteStore.close();
  }
});

/* ------------------------------------------------------------------------- *
 * v1.4: acceptance IS closure (owner ruling C) + board-sweep self-heal (D).
 *   - acceptGroupTask writes the neutral owner closure record when the
 *     canonical carries none, and never overwrites an existing one;
 *   - healAcceptedGroupTaskCards catches the detached pre-v1.4 pairs
 *     (canonical closed by a human, group task still in review), skipping
 *     any pair it cannot heal instead of throwing.
 * ------------------------------------------------------------------------- */

test('v1.4: acceptance records the neutral owner closure when the canonical has none', async (t) => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'closure-auto-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'session-closure-auto');
    h.bridge.completeWorkerAttempt({
      attemptId: started.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://closure-auto',
      groupMessagePinId: 'closure-auto-deliverable-i0',
    });
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    assert.equal(h.orchestrationStore.hasClosureRecord(started.task.id), false, 'precondition: not closed yet');
    h.bridge.acceptGroupTask(h.groupTask.id);

    assert.equal(h.orchestrationStore.hasClosureRecord(started.task.id), true, 'acceptance records closure');
    const mark = h.orchestrationStore.getClosureMark(started.task.id);
    assert.equal(mark.conclusion, null, 'the acceptance record invents no conclusion');
    assert.equal(mark.by, 'owner');
    assert.ok(mark.at, 'closure_at is stamped');
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: an existing closure record survives acceptance untouched (idempotent)', async () => {
  const h = await makeHarness();
  try {
    const canonical = h.bridge.ensureCanonicalTask(h.groupTask.id);
    // The board closed this card earlier with a real instruction.
    h.orchestrationStore.recordClosure(canonical.id, {
      conclusion: 'board wrote this first',
      by: 'owner',
      pinId: null,
    });
    const markBefore = h.orchestrationStore.getClosureMark(canonical.id);

    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'done', { actor: { kind: 'owner' } });
    h.bridge.acceptGroupTask(h.groupTask.id);

    const markAfter = h.orchestrationStore.getClosureMark(canonical.id);
    assert.equal(markAfter.conclusion, 'board wrote this first', 'the earlier conclusion is not overwritten');
    assert.equal(markAfter.at, markBefore.at, 'even the timestamp is untouched');
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: healAcceptedGroupTaskCards catches a detached review pair up to done', async () => {
  const h = await makeHarness();
  try {
    const started = h.bridge.beginWorkerAttempt({
      groupTaskId: h.groupTask.id,
      workerMetabotId: 2,
      objective: 'Build the MetaApp',
      sourceMessageKey: 'heal-ok-i0',
    });
    h.bridge.markWorkerAttemptRunning(started.attempt.id, 'session-heal-ok');
    h.bridge.completeWorkerAttempt({
      attemptId: started.attempt.id,
      replyText: '[DELIVERABLE] metaapp: metaapp://heal-ok',
      groupMessagePinId: 'heal-ok-deliverable-i0',
    });
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    // The owner closed the canonical through the board; the group task
    // lagged behind in review (the pre-v1.4 detached state).
    h.orchestrationStore.recordClosure(started.task.id, { conclusion: null, by: 'owner' });

    const report = h.bridge.healAcceptedGroupTaskCards();
    assert.deepEqual(report.healed, [{ groupTaskId: h.groupTask.id, canonicalTaskId: started.task.id }]);
    assert.equal(report.skipped.length, 0);
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).status, 'done', 'the group task caught up');
    assert.equal(h.orchestrationStore.getTask(started.task.id).status, 'completed');
    // Healing is idempotent: a second pass has nothing left to do.
    const second = h.bridge.healAcceptedGroupTaskCards();
    assert.equal(second.healed.length, 0);
    assert.equal(second.skipped.length, 0);
  } finally {
    h.sqliteStore.close();
  }
});

test('v1.4: heal skips unclosed canonicals and refused pairs, and never throws', async () => {
  const h = await makeHarness();
  try {
    // Pair 1: review, canonical NOT closed -> skipped (nothing to catch up).
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'executing');
    h.bridge.syncStatus(h.groupTask.id);
    h.groupTaskStore.updateTaskStatus(h.groupTask.id, 'review');
    h.bridge.syncStatus(h.groupTask.id);

    // Pair 2: review, canonical closed, but a live queued step refuses
    // acceptance -> the failure is a skip entry, not a throw.
    const second = h.groupTaskStore.createTask({
      groupId: 'group-heal-refused',
      title: 'Refused pair',
      goal: 'Goal',
      chairMetabotId: 1,
      createdBy: 'user',
    });
    const secondCanonical = h.bridge.ensureCanonicalTask(second.id);
    const attempt = h.bridge.beginWorkerAttempt({
      groupTaskId: second.id,
      workerMetabotId: 2,
      objective: 'still working',
      sourceMessageKey: 'heal-refused-i0',
    });
    assert.equal(attempt.attempt.status, 'queued');
    h.groupTaskStore.updateTaskStatus(second.id, 'executing');
    h.bridge.syncStatus(second.id);
    h.groupTaskStore.updateTaskStatus(second.id, 'review');
    h.bridge.syncStatus(second.id);
    h.orchestrationStore.recordClosure(secondCanonical.id, { conclusion: null, by: 'owner' });

    const report = h.bridge.healAcceptedGroupTaskCards();
    assert.equal(report.healed.length, 0);
    assert.equal(report.skipped.length, 2, 'both pairs are reported as skips');
    const skip1 = report.skipped.find((entry) => entry.groupTaskId === h.groupTask.id);
    const skip2 = report.skipped.find((entry) => entry.groupTaskId === second.id);
    assert.match(skip1.reason, /not closed out yet/);
    assert.match(skip2.reason, /unfinished canonical step/i);
    // Nothing moved: both group tasks are still in review, no closure wrote.
    assert.equal(h.groupTaskStore.getTaskById(h.groupTask.id).status, 'review');
    assert.equal(h.groupTaskStore.getTaskById(second.id).status, 'review');
    assert.equal(h.orchestrationStore.hasClosureRecord(
      h.bridge.ensureCanonicalTask(h.groupTask.id).id,
    ), false);
    assert.equal(h.orchestrationStore.getTask(secondCanonical.id).status, 'review');
  } finally {
    h.sqliteStore.close();
  }
});

// v1.5 (owner ruling 「谁发起，谁验收」): canonical cards of group tasks stay
// origin='owner' — the group's creator (created_by) decides who closes, via
// the board's read-time closerRole derivation. The origin column is the
// FALLBACK for plain cards only; the bridge must not encode closers in it.
test('v1.5: canonical cards keep origin=owner for both creator variants', async () => {
  const h = await makeHarness();
  try {
    const canonical = h.bridge.ensureCanonicalTask(h.groupTask.id);
    assert.equal(canonical.origin, 'owner', 'user-created group canonical stays origin=owner');

    // A twin-created group task gets the same treatment: no origin encoding.
    const twinGroup = h.groupTaskStore.createTask({
      groupId: 'group-bridge-twin',
      title: 'Twin-initiated build',
      goal: 'Build something the Twin will verify itself',
      chairMetabotId: 1,
      createdBy: 'twin',
    });
    const twinCanonical = h.bridge.ensureCanonicalTask(twinGroup.id);
    assert.equal(twinCanonical.origin, 'owner', 'twin-created group canonical ALSO stays origin=owner');
  } finally {
    h.sqliteStore.close();
  }
});
