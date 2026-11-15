import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore, deriveManagedState } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { LongTermAdvanceService } = require('../dist-electron/main/services/longTermAdvanceService.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try {
    sqliteStore?.close?.();
  } catch {
    // Ignore close errors.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Tolerant Windows CI cleanup.
  }
}

async function createSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-studio-cos-p2-'));
  const sqliteStore = await SqliteStore.create(dir);
  return { dir, sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() };
}

test('deriveManagedState maps every non-terminal task strictly into the 3 canonical states (in_progress | waiting_external | waiting_owner)', () => {
  assert.equal(deriveManagedState('defining', 'pending'), 'waiting_owner');
  assert.equal(deriveManagedState('paused', 'in_progress'), 'waiting_owner');
  assert.equal(deriveManagedState('active', 'pending'), 'in_progress');
  assert.equal(deriveManagedState('active', 'in_progress'), 'in_progress');
  assert.equal(deriveManagedState('active', 'waiting_external'), 'waiting_external');
  assert.equal(deriveManagedState('active', 'waiting_owner'), 'waiting_owner');
  assert.equal(deriveManagedState('done', 'accepted'), null);
  assert.equal(deriveManagedState('cancelled', 'skipped'), null);
});

test('createQuickTask coexists in the unified Managed Task Tree alongside multi-step project trees', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const store = new LongTermTaskStore(db, saveDb);

    const quick = store.createQuickTask(
      {
        title: 'Write v1.1.0 release buzz draft',
        goal: 'Draft and verify a release buzz in Markdown',
        acceptanceCriteria: ['Zero factual errors', 'Under 300 chars'],
        definitionSessionId: 'studio-stream-1',
      },
      'twin',
    );
    assert.equal(quick.ok, true);
    assert.equal(quick.value.taskKind, 'quick');
    assert.equal(quick.value.stage, 'active');
    assert.equal(quick.value.managedState, 'in_progress');
    assert.equal(quick.value.subtasks.length, 1);
    assert.equal(quick.value.subtasks[0].status, 'in_progress');

    const project = store.createTask(
      {
        title: '8-part AI Internet tutorial series',
        goal: 'Publish 8 verified tutorials + index',
        definitionSessionId: 'studio-stream-1',
        subtasks: [
          { title: 'Draft 00-01', acceptanceCriteria: ['Approved tone'] },
          { title: 'Delegate 02-07', dependsOnOrdinals: [1], acceptanceCriteria: ['Source checked'] },
        ],
      },
      'twin',
    );
    assert.equal(project.ok, true);
    assert.equal(project.value.taskKind, 'project');
    assert.equal(project.value.managedState, 'waiting_owner', 'defining draft awaits owner sign-off');

    const board = store.listBoard();
    assert.equal(board.cards.length, 2);
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Studio delegations auto-ledger a quick task card when unlinked and isolate participant chips per task on a shared Studio session', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const metabots = [
      { id: 1, name: 'Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 2, name: 'Lucy', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 3, name: 'Aming', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];
    const ltStore = new LongTermTaskStore(db, saveDb, {
      resolveParticipants: (ids) => ids.map((id) => ({ id, name: metabots.find((b) => b.id === id)?.name ?? `#${id}`, avatar: null })),
    });
    const orchStore = new OrchestrationStore(db, saveDb);

    const sessions = new Map([
      ['studio-main', { id: 'studio-main', sessionType: 'browser', assistantMode: true, metabotId: 1 }],
    ]);

    const orchService = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore: { getSession: (id) => sessions.get(id) ?? null },
      coworkRunner: { insertCrossSessionMessageAndQueue: () => ({ insert: { ok: true, message: {} }, runQueued: true }) },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: (sid) => sid === 'studio-main',
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: (id) => sessions.get(id) ?? null,
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        await params.onSessionCreated(`ws-${params.metabotId}`);
        return 'Done.\n<worker_handoff>{"state":"ready","summary":"ok","deliverables":[],"verificationEvidence":[],"blockers":[],"humanAction":null}</worker_handoff>';
      },
    });

    // Two independent delegations from the SAME persistent Studio session without passing longtermTaskId:
    const d1 = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 2,
      taskIntent: 'Task Alpha for Lucy',
      objective: 'Write Alpha',
      idempotencyKey: 'auto-ledger-1',
    });
    const d2 = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 3,
      taskIntent: 'Task Beta for Aming',
      objective: 'Write Beta',
      idempotencyKey: 'auto-ledger-2',
    });

    for (let i = 0; i < 40; i += 1) {
      if (orchStore.getTask(d1.task.id)?.status === 'review' && orchStore.getTask(d2.task.id)?.status === 'review') {
        break;
      }
      await new Promise((r) => setTimeout(r, 15));
    }

    assert.ok(d1.task.longtermTaskId, 'first Studio delegation auto-linked to Managed Task Tree');
    assert.ok(d2.task.longtermTaskId, 'second Studio delegation auto-linked to Managed Task Tree');
    assert.notEqual(d1.task.longtermTaskId, d2.task.longtermTaskId, 'each independent ask gets its own quick card');

    const card1 = ltStore.getTask(d1.task.longtermTaskId);
    const card2 = ltStore.getTask(d2.task.longtermTaskId);
    assert.equal(card1.taskKind, 'quick');
    assert.deepEqual(card1.participants.map((p) => p.name), ['Lucy'], 'Task Alpha only lists Lucy, not Aming');
    assert.deepEqual(card2.participants.map((p) => p.name), ['Aming'], 'Task Beta only lists Aming, not Lucy');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('LongTermAdvanceService auto-escalates overdue waiting_external subtasks to waiting_owner', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const ltStore = new LongTermTaskStore(db, saveDb);
    const quick = ltStore.createQuickTask(
      { title: 'Wait for external API key', definitionSessionId: 'studio-main' },
      'twin',
    );
    const taskId = quick.value.id;
    const subtaskId = quick.value.subtasks[0].id;
    ltStore.waitSubtask(subtaskId, { kind: 'external', note: 'Waiting on third-party DNS propagation' }, 'twin');

    const escalatedTurns = [];
    const advance = new LongTermAdvanceService({
      store: () => ltStore,
      coworkStore: () => ({
        getSession: () => ({ id: 'studio-main', metabotId: 1 }),
        getSessionEngagement: () => ({ lastOwnerMessageAtMs: null, lastAssistantMessageAtMs: null }),
        getSessionTurnOutcome: () => null,
        getSessionMetabotId: () => 1,
        getSessionAutoOrigin: () => null,
        countSessionMessages: () => 2,
        createSession: () => { throw new Error('should reuse studio-main'); },
        setSessionAutoOrigin: () => {},
        updateSession: () => {},
        addMessage: () => ({ id: 'm1', type: 'user', content: '', timestamp: 1 }),
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async (sid, prompt) => { escalatedTurns.push({ sid, prompt }); },
      }),
      resolveTwinMetabotId: () => 1,
      resolveWorkingDirectory: () => dir,
      getBaseSystemPrompt: () => '',
      externalReminderMs: 3_600_000,
      externalEscalateToOwnerMs: 4 * 3_600_000,
    });

    // Advance clock 5 hours past the external wait: must escalate subtask status to waiting_owner!
    const fiveHoursLater = Date.now() + 5 * 3_600_000;
    await advance.run(fiveHoursLater);

    const updated = ltStore.getTask(taskId);
    assert.equal(updated.subtasks[0].status, 'waiting_owner');
    assert.equal(updated.managedState, 'waiting_owner');
    assert.match(updated.subtasks[0].waitNote, /需要你拍板的事项/);
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
