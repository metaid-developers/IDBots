// Twin step acceptance (append-only writeback).
//
// WHY: a delegated step used to sit at step.status 'completed' / task 'review'
// with acceptedResult.verified permanently false and no acceptance primitive at
// all — the record kept claiming "awaiting verification" after the work was
// verified and shipped. This suite pins the shape of the fix:
//   * one APPEND-ONLY row { who, when, evidence[], note } per accept;
//   * the step row (the Worker's claim) is never written by an accept;
//   * evidence is mandatory and validated BEFORE any write;
//   * unknown step / task mismatch / non-Twin caller refuse with a readable
//     code and write nothing;
//   * twin_task_status shows the Worker claim and the acceptances side by side.
//
// Requires: pnpm --config.verify-deps-before-run=false run compile:electron

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');

const BOTS = [
  { id: 1, name: 'Twin', enabled: true, metabot_type: 'twin', boss_global_metaid: 'owner-global', skills: [] },
  { id: 2, name: 'Builder', enabled: true, metabot_type: 'worker', boss_global_metaid: 'owner-global', skills: [] },
];

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-twin-step-accept-'));

async function openStore() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { sqliteStore, orchestration };
}

// The real shape the delegation produced: step completed, task in review, and
// acceptedResult.verified stuck at false.
function seedDelegatedStep(orchestration, { ordinal = 1 } = {}) {
  const task = orchestration.createTask({
    ownerIntent: 'Ship the acceptance writeback',
    twinMetabotId: 1,
    ownerGlobalMetaId: 'owner-global',
    sourceSessionId: 'twin-session',
  });
  orchestration.updateTaskStatus(task.id, 'running');
  const step = orchestration.createStep({
    taskId: task.id,
    ordinal,
    title: `Step ${ordinal}`,
    objective: 'Do the bounded thing and hand off evidence',
    acceptanceCriteria: ['handoff names the files'],
    assigneeMetabotId: 2,
    status: 'ready',
  });
  orchestration.updateStepStatus(step.id, 'queued');
  orchestration.updateStepStatus(step.id, 'running');
  orchestration.updateStepStatus(step.id, 'completed', {
    acceptedResult: { summary: 'worker handoff', verified: false },
  });
  orchestration.updateTaskStatus(task.id, 'review');
  return { task, step };
}

function rawStepRow(db, stepId) {
  const result = db.exec('SELECT * FROM orchestration_steps WHERE id = ?', [stepId]);
  return { columns: result[0].columns, values: result[0].values };
}

function acceptanceCount(db) {
  return Number(db.exec('SELECT COUNT(*) FROM orchestration_step_acceptances')[0]?.values?.[0]?.[0] ?? 0);
}

function refusalCode(error) {
  return error && typeof error === 'object' ? error.code : undefined;
}

test('accept appends one event and leaves the step row byte-identical', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { step } = seedDelegatedStep(orchestration);
    const db = sqliteStore.getDatabase();
    const before = rawStepRow(db, step.id);

    const acceptance = orchestration.recordStepAcceptance({
      stepId: step.id,
      acceptedByMetabotId: 1,
      evidence: [
        { kind: 'dir', uri: '/tmp/idbots-worker-2/out' },
        { kind: 'pin', uri: 'pin://0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefi0', note: 'handoff note' },
      ],
      note: 'Verified the handoff against the acceptance criteria.',
    });

    // The step row is untouched: same columns, same values, same status, same
    // acceptedResult (verified stays false — acceptance is a separate record).
    assert.deepEqual(rawStepRow(db, step.id), before);
    const reread = orchestration.getStep(step.id);
    assert.equal(reread.status, 'completed');
    assert.deepEqual(reread.acceptedResult, { summary: 'worker handoff', verified: false });

    // Exactly one new row, and it carries { who, when, evidence[], note }.
    assert.equal(acceptanceCount(db), 1);
    assert.equal(acceptance.stepId, step.id);
    assert.equal(acceptance.taskId, step.taskId);
    assert.equal(acceptance.acceptedByMetabotId, 1);
    assert.match(acceptance.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(acceptance.evidence.length, 2);
    assert.deepEqual(acceptance.evidence[0], { kind: 'dir', uri: '/tmp/idbots-worker-2/out' });
    assert.equal(acceptance.evidence[1].note, 'handoff note');
    assert.equal(acceptance.note, 'Verified the handoff against the acceptance criteria.');
    assert.deepEqual(orchestration.listStepAcceptances(step.id), [acceptance]);
  } finally {
    sqliteStore.close();
  }
});

test('two accepts on the same step are two distinct events, in order', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { step } = seedDelegatedStep(orchestration);
    const first = orchestration.recordStepAcceptance({
      stepId: step.id,
      acceptedByMetabotId: 1,
      evidence: [{ kind: 'dir', uri: '/tmp/out' }],
      note: 'first pass',
    });
    const second = orchestration.recordStepAcceptance({
      stepId: step.id,
      acceptedByMetabotId: 1,
      evidence: [{ kind: 'url', uri: 'https://example.test/pr/1' }],
      note: 're-verified after the rebase',
    });

    assert.notEqual(second.id, first.id);
    // Strictly later, even when both land in the same millisecond — a second
    // accept must never look like a silent overwrite of the first.
    assert.ok(Date.parse(second.createdAt) > Date.parse(first.createdAt));

    const all = orchestration.listStepAcceptances(step.id);
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((row) => row.id), [first.id, second.id]);
    assert.equal(all[0].note, 'first pass');
    assert.equal(all[1].note, 're-verified after the rebase');
    // The first row is still readable with its original content.
    assert.deepEqual(orchestration.getStepAcceptance(first.id).evidence, [{ kind: 'dir', uri: '/tmp/out' }]);
    assert.equal(acceptanceCount(sqliteStore.getDatabase()), 2);
  } finally {
    sqliteStore.close();
  }
});

test('refusals are explicit and write nothing', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { task, step } = seedDelegatedStep(orchestration);
    const db = sqliteStore.getDatabase();

    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: step.id, evidence: [], note: 'no evidence' }),
      (error) => refusalCode(error) === 'ACCEPTANCE_EVIDENCE_REQUIRED',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: step.id, evidence: undefined }),
      (error) => refusalCode(error) === 'ACCEPTANCE_EVIDENCE_REQUIRED',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: step.id, evidence: [{ kind: 'dir', uri: '   ' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_EVIDENCE_INVALID',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: step.id, evidence: [{ uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_EVIDENCE_INVALID',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: step.id, evidence: [{ kind: 'nope', uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_EVIDENCE_INVALID',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: 'does-not-exist', evidence: [{ kind: 'dir', uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_STEP_NOT_FOUND',
    );
    assert.throws(
      () => orchestration.recordStepAcceptance({
        stepId: step.id,
        taskId: 'another-task',
        evidence: [{ kind: 'dir', uri: '/tmp/out' }],
      }),
      (error) => refusalCode(error) === 'ACCEPTANCE_TASK_MISMATCH',
    );
    // The readable reason is on the message too (what the tool returns).
    assert.throws(
      () => orchestration.recordStepAcceptance({ stepId: 'nope', evidence: [] }),
      /No orchestration step nope|at least one evidence entry/,
    );

    assert.equal(acceptanceCount(db), 0, 'a refused accept writes nothing');
    // The task id is valid and the step untouched by all of the above.
    assert.equal(orchestration.getStep(step.id).status, 'completed');
    assert.ok(orchestration.getTask(task.id));
  } finally {
    sqliteStore.close();
  }
});

test('listStepAcceptances returns only that step events', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { task, step } = seedDelegatedStep(orchestration, { ordinal: 1 });
    const otherStep = orchestration.createStep({
      taskId: task.id,
      ordinal: 2,
      title: 'Step 2',
      objective: 'Second slice',
      status: 'ready',
    });
    orchestration.updateStepStatus(otherStep.id, 'queued');
    orchestration.updateStepStatus(otherStep.id, 'running');
    orchestration.updateStepStatus(otherStep.id, 'completed');

    orchestration.recordStepAcceptance({ stepId: step.id, evidence: [{ kind: 'dir', uri: '/tmp/a' }] });
    orchestration.recordStepAcceptance({ stepId: otherStep.id, evidence: [{ kind: 'dir', uri: '/tmp/b' }] });

    assert.deepEqual(orchestration.listStepAcceptances(step.id).map((row) => row.evidence[0].uri), ['/tmp/a']);
    assert.deepEqual(orchestration.listStepAcceptances(otherStep.id).map((row) => row.evidence[0].uri), ['/tmp/b']);
    assert.deepEqual(orchestration.listStepAcceptances('no-such-step'), []);
  } finally {
    sqliteStore.close();
  }
});

test('acceptance rows are append-only at the database level', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { step } = seedDelegatedStep(orchestration);
    const acceptance = orchestration.recordStepAcceptance({
      stepId: step.id,
      evidence: [{ kind: 'dir', uri: '/tmp/out' }],
      note: 'original',
    });
    const db = sqliteStore.getDatabase();
    assert.throws(
      () => db.run('UPDATE orchestration_step_acceptances SET note = ? WHERE id = ?', ['tampered', acceptance.id]),
      /append-only/i,
    );
    assert.equal(orchestration.getStepAcceptance(acceptance.id).note, 'original');
  } finally {
    sqliteStore.close();
  }
});

// ---------------------------------------------------------------------------
// Service + tool layer (no Electron window required: the host tool dispatcher
// is reachable through handleHostToolExecution, the same seam the existing
// twinWorkerSessionStop suite uses).
// ---------------------------------------------------------------------------

function makeService(orchestration) {
  return new TwinOrchestrationService({
    orchestrationStore: orchestration,
    coworkStore: {},
    coworkRunner: {},
    directory: {
      getSession: (id) => (id === 'twin-session'
        ? { id, metabotId: 1 }
        : id === 'worker-session'
          ? { id, metabotId: 2 }
          : null),
      listMetabots: () => BOTS,
      getOwnerGlobalMetaId: () => 'owner-global',
    },
    getMetabotById: (id) => BOTS.find((bot) => bot.id === id) ?? null,
    getWorkerWorkspace: (id) => `/tmp/idbots-worker-${id}`,
  });
}

function loadRunner() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => `/tmp/idbots-twin-accept-${name}`,
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

function makeToolHarness(orchestration) {
  const service = makeService(orchestration);
  const { CoworkRunner } = loadRunner();
  const sessions = new Map([
    ['twin-session', { id: 'twin-session', metabotId: 1, status: 'idle' }],
    ['worker-session', { id: 'worker-session', metabotId: 2, status: 'running' }],
  ]);
  const store = {
    getSession: (id) => sessions.get(id) ?? null,
    getConfig: () => ({}),
    updateSession: (id, updates) => {
      sessions.set(id, { ...(sessions.get(id) ?? { id }), ...updates });
    },
  };
  const runner = new CoworkRunner(store, {
    getMetabotById: (id) => BOTS.find((bot) => bot.id === id) ?? null,
    twinTaskStatus: (sessionId, taskId) => service.getTaskStatus(sessionId, taskId),
    twinTaskAccept: (sessionId, input) => service.acceptStep(sessionId, input),
  });
  const call = (toolName, toolInput, asSession = 'twin-session') =>
    runner.handleHostToolExecution({ toolName, toolInput }, asSession);
  return { call, sessions };
}

test('twin_task_status shows the Worker claim and the Twin acceptance side by side', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { task, step } = seedDelegatedStep(orchestration);
    const { call } = makeToolHarness(orchestration);

    const before = JSON.parse((await call('twin_task_status', { taskId: task.id })).text);
    assert.equal(before.ok, true);
    assert.equal(before.steps[0].acceptances.length, 0, 'unaccepted step is visibly unaccepted');
    assert.equal(before.steps[0].status, 'completed');
    assert.deepEqual(before.steps[0].acceptedResult, { summary: 'worker handoff', verified: false });

    const accepted = await call('twin_task_accept', {
      taskId: task.id,
      stepId: step.id,
      evidence: [{ kind: 'dir', uri: '/tmp/idbots-worker-2/out' }],
      note: 'checked the handoff',
    });
    assert.equal(accepted.success, true, accepted.text);
    const acceptedBody = JSON.parse(accepted.text);
    assert.equal(acceptedBody.ok, true);
    assert.equal(acceptedBody.acceptance.acceptedByMetabotId, 1);
    assert.equal(acceptedBody.acceptances.length, 1);

    const after = JSON.parse((await call('twin_task_status', { taskId: task.id })).text);
    const statusStep = after.steps[0];
    // Worker claim intact…
    assert.equal(statusStep.status, 'completed');
    assert.deepEqual(statusStep.acceptedResult, { summary: 'worker handoff', verified: false });
    // …and the Twin acceptance recorded beside it, with who/when/evidence/note.
    assert.equal(statusStep.acceptances.length, 1);
    assert.equal(statusStep.acceptances[0].id, acceptedBody.acceptance.id);
    assert.equal(statusStep.acceptances[0].acceptedByMetabotId, 1);
    assert.equal(statusStep.acceptances[0].note, 'checked the handoff');
    assert.deepEqual(statusStep.acceptances[0].evidence, [{ kind: 'dir', uri: '/tmp/idbots-worker-2/out' }]);
    assert.equal(statusStep.acceptances[0].createdAt, acceptedBody.acceptance.createdAt);
    // Existing status fields survive untouched.
    assert.equal(after.task.id, task.id);
    assert.equal(after.task.status, 'review', 'the task record is not rewritten by an accept');
    assert.ok(Array.isArray(statusStep.attempts));

    // A second accept is a visibly distinct second event, not an overwrite.
    const second = await call('twin_task_accept', {
      stepId: step.id,
      evidence: [{ kind: 'url', uri: 'https://example.test/review' }],
      note: 're-checked after the rebase',
    });
    assert.equal(second.success, true, second.text);
    const twice = JSON.parse((await call('twin_task_status', { taskId: task.id })).text);
    assert.equal(twice.steps[0].acceptances.length, 2);
    assert.deepEqual(
      twice.steps[0].acceptances.map((row) => row.note),
      ['checked the handoff', 're-checked after the rebase'],
    );
    assert.notEqual(twice.steps[0].acceptances[0].id, twice.steps[0].acceptances[1].id);
    assert.ok(Date.parse(twice.steps[0].acceptances[1].createdAt) > Date.parse(twice.steps[0].acceptances[0].createdAt));
    assert.equal(twice.task.status, 'review');
    assert.equal(twice.steps[0].status, 'completed');
  } finally {
    sqliteStore.close();
  }
});

test('twin_task_accept: non-Twin callers and bad input refuse with a readable code and write nothing', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const { task, step } = seedDelegatedStep(orchestration);
    const { call } = makeToolHarness(orchestration);
    const db = sqliteStore.getDatabase();

    const asWorker = await call('twin_task_accept', {
      stepId: step.id,
      evidence: [{ kind: 'dir', uri: '/tmp/out' }],
    }, 'worker-session');
    assert.equal(asWorker.success, false);
    assert.equal(JSON.parse(asWorker.text).code, 'TWIN_TOOL_FORBIDDEN');

    const service = makeService(orchestration);
    assert.throws(
      () => service.acceptStep('worker-session', { stepId: step.id, evidence: [{ kind: 'dir', uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'TWIN_TOOL_FORBIDDEN',
    );

    const missingStep = await call('twin_task_accept', {});
    assert.equal(missingStep.success, false);
    assert.equal(JSON.parse(missingStep.text).code, 'STEP_ID_REQUIRED');

    const unknownStep = await call('twin_task_accept', {
      stepId: 'nope',
      evidence: [{ kind: 'dir', uri: '/tmp/out' }],
    });
    assert.equal(unknownStep.success, false);
    assert.equal(JSON.parse(unknownStep.text).code, 'ACCEPTANCE_STEP_NOT_FOUND');
    assert.match(JSON.parse(unknownStep.text).error, /No orchestration step nope/);

    const noEvidence = await call('twin_task_accept', { taskId: task.id, stepId: step.id, evidence: [] });
    assert.equal(noEvidence.success, false);
    assert.equal(JSON.parse(noEvidence.text).code, 'ACCEPTANCE_EVIDENCE_REQUIRED');
    assert.match(JSON.parse(noEvidence.text).error, /at least one evidence entry/);

    const taskMismatch = await call('twin_task_accept', {
      taskId: 'another-task',
      stepId: step.id,
      evidence: [{ kind: 'dir', uri: '/tmp/out' }],
    });
    assert.equal(taskMismatch.success, false);
    assert.equal(JSON.parse(taskMismatch.text).code, 'ACCEPTANCE_TASK_MISMATCH');

    assert.equal(acceptanceCount(db), 0, 'no refusal wrote anything');
    assert.equal(orchestration.getStep(step.id).status, 'completed');
  } finally {
    sqliteStore.close();
  }
});

test('acceptStep refuses a step of a task that belongs to another Twin', async () => {
  const { sqliteStore, orchestration } = await openStore();
  try {
    const service = makeService(orchestration);
    const foreignTask = orchestration.createTask({
      ownerIntent: 'Belongs to a different Twin',
      twinMetabotId: 9,
      ownerGlobalMetaId: 'owner-global',
    });
    const foreignStep = orchestration.createStep({
      taskId: foreignTask.id,
      ordinal: 1,
      title: 'Foreign',
      objective: 'not this Twin\'s task',
      status: 'ready',
    });
    assert.throws(
      () => service.acceptStep('twin-session', { stepId: foreignStep.id, evidence: [{ kind: 'dir', uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_TASK_OWNER_MISMATCH',
    );
    // A step id that does not exist is refused by the service too.
    assert.throws(
      () => service.acceptStep('twin-session', { stepId: 'ghost-step', evidence: [{ kind: 'dir', uri: '/tmp/out' }] }),
      (error) => refusalCode(error) === 'ACCEPTANCE_STEP_NOT_FOUND',
    );
    assert.equal(acceptanceCount(sqliteStore.getDatabase()), 0, 'refusals write nothing');
    assert.equal(orchestration.listStepAcceptances(foreignStep.id).length, 0);
  } finally {
    sqliteStore.close();
  }
});

test('twin_task_accept is registered in the Twin tool surface and wired in the host', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main/libs/coworkRunner.ts'), 'utf8');
  // Registered as an inline tool behind the Twin gate…
  assert.match(source, /'twin_task_accept',\n\s+'Record YOUR acceptance/);
  assert.match(source, /if \(this\.isTwinSession\(sessionId\) && this\.twinTaskAccept\)/);
  // …dispatched to the host seam…
  assert.match(source, /toolName === 'twin_task_accept'/);
  assert.match(source, /this\.twinTaskAccept = options\?\.twinTaskAccept/);
  // …and wired by the app bootstrap.
  const main = fs.readFileSync(path.join(process.cwd(), 'src/main/main.ts'), 'utf8');
  assert.match(main, /twinTaskAccept: \(sessionId, input\) => getTwinOrchestrationService\(\)\.acceptStep\(sessionId, input\)/);
});
