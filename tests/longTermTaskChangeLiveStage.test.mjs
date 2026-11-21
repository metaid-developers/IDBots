import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distRoot = process.env.IDBOTS_ELECTRON_DIST
  ? path.resolve(process.env.IDBOTS_ELECTRON_DIST)
  : path.resolve(new URL('../dist-electron', import.meta.url).pathname);
const { SqliteStore } = require(path.join(distRoot, 'main/sqliteStore.js'));
const { LongTermTaskStore } = require(path.join(distRoot, 'main/longTermTaskStore.js'));
const { buildStudioLiveTaskHud } = require(path.join(distRoot, 'main/services/studioLiveStageModel.js'));
const { createStudioLiveStageService } = require(path.join(distRoot, 'main/services/studioLiveStageService.js'));

const mainSource = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');

/**
 * Task-ledger change outlet → Live Stage reading.
 *
 * The reported bug (owner, 2026-11-21): Live Stage task progress lagged the
 * real ledger. Worker/B twin agent tools (task_subtask_submit / _progress /
 * _accept, stage moves) write straight to LongTermTaskStore and never touch a
 * chat store, so the only existing refresh triggers — chat persistence and
 * group-message ingest — stayed silent until the NEXT chat message. This suite
 * pins the seam that fixes it:
 *
 *   1. the store emits a ledger change for every visible mutation class,
 *      including writes that leave the subtask status alone;
 *   2. that event feeds the SAME debounced Live Stage read (1500ms) and the
 *      reading moves within 2s with no chat row inserted;
 *   3. the snapshot the HUD is built from carries the new submission /
 *      progress-note text.
 *
 * Runs against compiled output: pnpm run compile:electron (or a temp outDir
 * passed as IDBOTS_ELECTRON_DIST).
 */

async function openStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-longterm-livestage-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  return { store, dir };
}

const SPEC = {
  title: 'Live Stage sync',
  goal: 'Keep the stage reading on the ledger, not on chat.',
  subtasks: [
    { title: 'First', acceptanceCriteria: ['done'] },
    { title: 'Second', acceptanceCriteria: ['done'] },
  ],
};

async function createActive(store) {
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const activated = store.activateTask(created.value.id, 'owner');
  assert.ok(activated.ok, JSON.stringify(activated));
  const taskId = created.value.id;
  const [first, second] = store.getTask(taskId).subtasks;
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  return { taskId, firstId: first.id, secondId: second.id };
}

/** The exact read main.ts hands to the stage HUD (getLiveTaskHud). */
function liveStageSnapshot(store) {
  const board = store.listBoard();
  return buildStudioLiveTaskHud({
    cards: board.cards,
    sessionOwnedTaskIds: new Set(),
    studioBusy: false,
    rawQueuedDecisions: 0,
  });
}

function hudEntry(store, taskId) {
  const snapshot = liveStageSnapshot(store);
  assert.ok(snapshot, 'the HUD snapshot exists while the task is open');
  const entry = snapshot.tasks.find((task) => task.id === taskId);
  assert.ok(entry, `HUD entry for ${taskId}`);
  return entry;
}

function record(store) {
  const changes = [];
  const unsubscribe = store.onTaskChanged((change) => changes.push(change));
  return { changes, unsubscribe };
}

test('task create / update / stage moves emit task-row ledger changes', async () => {
  const { store } = await openStore();
  const seen = [];
  store.onTaskChanged((change) => seen.push(change));

  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_created' }]);

  seen.length = 0;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_activated' }]);

  seen.length = 0;
  assert.ok(store.updateTask({ taskId, title: 'Renamed by the Twin' }, 'twin').ok);
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_updated' }]);

  seen.length = 0;
  assert.ok(store.pauseTask(taskId, 'twin', 'hold').ok);
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_paused' }]);

  seen.length = 0;
  assert.ok(store.activateTask(taskId, 'twin').ok);
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_activated' }]);

  seen.length = 0;
  assert.ok(store.cancelTask(taskId, 'owner', 'stop').ok);
  assert.deepEqual(seen, [{ taskId, subtaskId: null, entity: 'task', reason: 'task_cancelled' }]);
});

test('ready_for_review submission keeps in_progress yet notifies and reaches the HUD text', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);
  const { changes } = record(store);

  const submitted = store.submitSubtaskWork(firstId, {
    outcome: 'ready_for_review',
    workerMetabotId: 4,
    summary: 'Behavior suite is green; tsc 0.',
    artifacts: [{ kind: 'dir', uri: '/tmp/livestage-artifacts' }],
    evidence: [{ kind: 'dir', uri: '/tmp/livestage-evidence' }],
  }, 'worker');
  assert.ok(submitted.ok, JSON.stringify(submitted));

  // The status channel deliberately stays silent for this outcome...
  assert.equal(submitted.value.status, 'in_progress');
  assert.equal(submitted.value.submission.outcome, 'ready_for_review');
  // ...but the ledger outlet must not.
  const submitEvents = changes.filter((change) => change.reason === 'subtask_submitted');
  assert.equal(submitEvents.length, 1, JSON.stringify(changes));
  assert.equal(submitEvents[0].taskId, taskId);
  assert.equal(submitEvents[0].subtaskId, firstId);
  assert.equal(submitEvents[0].entity, 'subtask');

  // The snapshot the Live Stage renders now carries the submitted state text.
  const entry = hudEntry(store, taskId);
  assert.equal(entry.state, 'in_progress');
  assert.match(entry.progressNote, /^submitted for review: Behavior suite is green; tsc 0\.$/);
});

test('a progress checkpoint notifies and its note is in the HUD snapshot', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);
  const { changes } = record(store);

  const progress = store.recordSubtaskProgress(firstId, { note: '2/3: security audit complete' }, 'worker');
  assert.ok(progress.ok, JSON.stringify(progress));

  assert.deepEqual(changes, [{
    taskId,
    subtaskId: firstId,
    entity: 'subtask',
    reason: 'subtask_progress',
  }]);
  assert.equal(hudEntry(store, taskId).progressNote, '2/3: security audit complete');
});

test('re-recording a wait brief on an already-waiting sub-project still emits', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);
  assert.ok(store.waitSubtask(firstId, { kind: 'owner', note: 'first brief' }, 'twin').ok);
  const { changes } = record(store);

  assert.ok(store.waitSubtask(firstId, { kind: 'owner', note: 'revised brief' }, 'twin').ok);
  assert.deepEqual(changes, [{
    taskId,
    subtaskId: firstId,
    entity: 'subtask',
    reason: 'subtask_wait_note',
  }]);
  assert.equal(store.getSubtask(firstId).waitNote, 'revised brief');
});

test('a liveness pulse is silent unless its progress text actually changes', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);
  const { changes } = record(store);

  assert.ok(store.touchSubtaskActivity(firstId));
  assert.deepEqual(changes, [], 'heartbeat liveness alone must not churn the stage');

  assert.ok(store.touchSubtaskActivity(firstId, undefined, 'pulse note'));
  assert.deepEqual(changes, [{
    taskId,
    subtaskId: firstId,
    entity: 'subtask',
    reason: 'subtask_progress',
  }]);

  // Same note again → nothing new to render.
  assert.ok(store.touchSubtaskActivity(firstId, undefined, 'pulse note'));
  assert.equal(changes.length, 1);
});

test('accept emits a ledger change and the HUD counts move with it', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);
  assert.ok(store.submitSubtaskWork(firstId, {
    outcome: 'ready_for_review',
    workerMetabotId: 4,
    summary: 'first is ready',
  }, 'worker').ok);
  const { changes } = record(store);

  const accepted = store.acceptSubtask(firstId, 'owner', 'ok');
  assert.ok(accepted.ok, JSON.stringify(accepted));

  assert.equal(changes.filter((change) => change.reason === 'subtask_accepted').length, 1, JSON.stringify(changes));
  const entry = hudEntry(store, taskId);
  assert.equal(entry.accepted, 1);
  assert.equal(entry.total, 2);
});

test('subtask field edits emit a ledger change without a status transition', async () => {
  const { store } = await openStore();
  const { taskId, secondId } = await createActive(store);
  const { changes } = record(store);

  assert.ok(store.updateSubtask({ subtaskId: secondId, title: 'Second renamed' }, 'owner').ok);
  assert.deepEqual(changes, [{
    taskId,
    subtaskId: secondId,
    entity: 'subtask',
    reason: 'subtask_updated',
  }]);
});

test('a failed mutation never emits, a throwing listener never breaks the write', async () => {
  const { store } = await openStore();
  const { firstId } = await createActive(store);
  const seen = [];
  store.onTaskChanged((change) => seen.push(change.reason));
  store.onTaskChanged(() => {
    throw new Error('subscriber blew up');
  });

  // Nothing changed → no event.
  const refused = store.updateTask({ taskId: store.getSubtask(firstId).taskId }, 'owner');
  assert.equal(refused.ok, false);
  assert.deepEqual(seen, []);

  // A real write still succeeds with a throwing subscriber attached.
  const progress = store.recordSubtaskProgress(firstId, { note: 'still alive' }, 'worker');
  assert.ok(progress.ok, JSON.stringify(progress));
  assert.deepEqual(seen, ['subtask_progress']);
});

test('unsubscribing stops ledger events', async () => {
  const { store } = await openStore();
  const { firstId } = await createActive(store);
  const seen = [];
  const unsubscribe = store.onTaskChanged((change) => seen.push(change.reason));
  unsubscribe();
  assert.ok(store.recordSubtaskProgress(firstId, { note: 'nobody listens' }, 'worker').ok);
  assert.deepEqual(seen, []);
});

test('ledger write → 1500ms debounced stage read, within 2s and with no chat row', async () => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);

  assert.equal(hudEntry(store, taskId).progressNote, undefined, 'starts with no progress text');

  // Mirrors main.ts: scheduleLiveStageCompanionsRefresh's trailing debounce
  // (LIVE_STAGE_COMPANION_REFRESH_DEBOUNCE_MS = 1500) fed by onTaskChanged.
  const DEBOUNCE_MS = 1500;
  let timer = null;
  let refreshed = null;
  let refreshes = 0;
  const unsubscribe = store.onTaskChanged(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      refreshes += 1;
      refreshed = liveStageSnapshot(store);
    }, DEBOUNCE_MS);
  });

  const startedAt = Date.now();
  const submitted = store.submitSubtaskWork(firstId, {
    outcome: 'ready_for_review',
    workerMetabotId: 4,
    summary: 'no chat message involved',
  }, 'worker');
  assert.ok(submitted.ok, JSON.stringify(submitted));

  while (refreshed === null && Date.now() - startedAt < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const elapsed = Date.now() - startedAt;
  unsubscribe();
  if (timer) clearTimeout(timer);

  assert.ok(refreshed, 'the stage read fired from the ledger event alone');
  assert.equal(refreshes, 1, 'one debounced refresh per burst');
  assert.ok(elapsed >= 1400, `debounce was honoured (${elapsed}ms)`);
  assert.ok(elapsed <= 2000, `stage reading moved within 2s (${elapsed}ms)`);
  const entry = refreshed.tasks.find((task) => task.id === taskId);
  assert.ok(entry, 'refreshed snapshot still resolves the task');
  assert.match(entry.progressNote, /^submitted for review: no chat message involved$/);
});

test('main.ts routes the ledger outlet through the existing 1500ms Live Stage debounce', () => {
  assert.match(
    mainSource,
    /longTermTaskStore\.onTaskChanged\(\(\) => scheduleLiveStageCompanionsRefresh\(\)\);/,
    'the store outlet is wired to the shared refresh scheduler',
  );
  assert.match(
    mainSource,
    /const LIVE_STAGE_COMPANION_REFRESH_DEBOUNCE_MS = 1500;/,
    'the shared 1500ms debounce still exists and is reused',
  );
  // Existing triggers stay untouched (no behavior change for chat / run state).
  assert.match(
    mainSource,
    /getCoworkStore\(\)\.setChatMessagePersistedHook\(\(\) => scheduleLiveStageCompanionsRefresh\(\)\);/,
  );
  assert.match(mainSource, /scheduleLiveStageCompanionsRefresh\(\);/);

  const hookAt = mainSource.indexOf('longTermTaskStore.onTaskChanged');
  assert.ok(hookAt > 0, 'hook present');
  const hookSnippet = mainSource.slice(hookAt, hookAt + 160);
  assert.ok(!hookSnippet.includes('setInterval'), 'the new trigger is an event hook, not a poller');
});

test('the real Live Stage service reads the new task state from the ledger alone (≤2s)', async (t) => {
  const { store } = await openStore();
  const { taskId, firstId } = await createActive(store);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'livestage-stage-cwd-'));
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'livestage-stage-root-'));
  const session = {
    cwd,
    sessionType: 'browser',
    assistantMode: true,
    metabotId: 1,
    metabotName: 'AI_Sunny',
    metabotAvatar: 'data:image/jpeg;base64,AA==',
    messages: [],
  };
  const settings = { enabled: true, directorEnabled: false };
  const taskHudFromLedger = () => buildStudioLiveTaskHud({
    cards: store.listBoard().cards,
    sessionOwnedTaskIds: new Set(),
    studioBusy: false,
    rawQueuedDecisions: 0,
  });
  const service = createStudioLiveStageService({
    getSession: () => session,
    getMetabotById: () => ({ name: 'AI_Sunny', avatar: session.metabotAvatar, llm_id: 'brain', llm_provider: 'test' }),
    getSettings: () => settings,
    getLanguage: () => 'en',
    project: async (input) => ({ uri: `preview-metaapp://localhost${input.localPath}`, tabId: 7, announced: true }),
    getStageTab: async () => ({ id: 7, uri: null }),
    activateStageTab: async () => {},
    applyPatch: async () => {},
    drainInteractions: async () => [],
    respondToPermission: () => {},
    interactionPollMs: 10,
    stageRoot,
    assetRoot: path.resolve('public/live-stage'),
    fallbackAvatarDataUri: 'data:image/png;base64,AA==',
    getLiveTaskHud: taskHudFromLedger,
  });
  t.after(() => {
    service.dispose();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      // temp cleanup is best-effort
    }
  });

  service.observeMessage('stage-session', {
    id: 'u1',
    type: 'user',
    content: 'Please advance the task.',
    timestamp: 1,
    metadata: { origin: 'user', submissionId: 'sub-1' },
  });
  await service.getRunInternals('stage-session').queue;

  const before = service.getState('stage-session').taskHud;
  assert.ok(before, 'the stage carries a task HUD while the task is open');
  assert.equal(before.tasks.find((task) => task.id === taskId).progressNote, undefined);

  // The main.ts wiring, verbatim: ledger event → 1500ms trailing debounce →
  // the SAME refreshChiefOfStaffHud the chat hook calls. No chat is persisted.
  let timer = null;
  const unsubscribe = store.onTaskChanged(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      service.refreshChiefOfStaffHud('stage-session');
    }, 1500);
  });

  const startedAt = Date.now();
  const submitted = store.submitSubtaskWork(firstId, {
    outcome: 'ready_for_review',
    workerMetabotId: 4,
    summary: 'stage service sees this without any chat row',
  }, 'worker');
  assert.ok(submitted.ok, JSON.stringify(submitted));

  let entry = null;
  while (Date.now() - startedAt < 3000) {
    const hud = service.getState('stage-session').taskHud;
    entry = hud?.tasks.find((task) => task.id === taskId) ?? null;
    if (entry?.progressNote) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const elapsed = Date.now() - startedAt;
  unsubscribe();
  if (timer) clearTimeout(timer);

  assert.ok(entry?.progressNote, `stage reading updated (elapsed ${elapsed}ms)`);
  assert.match(entry.progressNote, /^submitted for review: stage service sees this without any chat row$/);
  assert.ok(elapsed <= 2000, `stage reading moved within 2s (${elapsed}ms)`);
});
