import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { LongTermAdvanceService, DEFAULT_SESSION_ROTATION_MESSAGES, MAX_ATTENTION_ESCALATIONS_PER_SUBTASK } = require('../dist-electron/main/services/longTermAdvanceService.js');

/**
 * LongTermAdvanceService (P1): the longterm.advance heartbeat handler. Real
 * store on a temp db; stub session-store/runner with recorded calls.
 */

const HOUR = 3_600_000;

function makeStubCowork() {
  const sessions = new Map();
  const counts = new Map();
  const engagement = new Map();
  const turnOutcomes = new Map();
  const metabots = new Map();
  // Mirrors CoworkStore: NULL until an auto-creating flow stamps it; a
  // human-opened session never gets one.
  const autoOrigins = new Map();
  const calls = { create: [], update: [], message: [], autoOrigin: [] };
  return {
    calls,
    counts,
    engagement,
    turnOutcomes,
    metabots,
    autoOrigins,
    createSession(title, cwd, systemPrompt, mode, skills, metabotId, sessionType) {
      const id = `sess-${sessions.size + 1}`;
      sessions.set(id, { id, title, sessionType, skills: [...(skills ?? [])] });
      metabots.set(id, metabotId ?? null);
      calls.create.push({ title, sessionType, skills: [...(skills ?? [])], metabotId });
      return { id };
    },
    updateSession(id, patch) { calls.update.push({ id, patch }); },
    setSessionAutoOrigin(id, autoOrigin) {
      autoOrigins.set(id, autoOrigin);
      calls.autoOrigin.push({ id, autoOrigin });
    },
    addMessage(id, msg) { counts.set(id, (counts.get(id) ?? 0) + 1); calls.message.push({ id, msg }); },
    getSession(id) { return sessions.get(id) ?? null; },
    countSessionMessages(id) { return counts.get(id) ?? 0; },
    getSessionAutoOrigin(id) { return autoOrigins.get(id) ?? null; },
    getSessionEngagement(id) {
      return engagement.get(id) ?? { lastOwnerMessageAtMs: null, lastAssistantMessageAtMs: null };
    },
    getSessionTurnOutcome(id) {
      return turnOutcomes.get(id) ?? { lastFailedAtMs: null, lastCompletedAtMs: null };
    },
    getSessionMetabotId(id) { return metabots.has(id) ? metabots.get(id) : null; },
    /**
     * Test helper: a session that exists outside createSession. By default a
     * human-opened one (no auto-origin — the owner's venue, a definition
     * session); pass autoOrigin 'longterm' for a previous sub-project's
     * heartbeat session.
     */
    registerSession(id, metabotId, autoOrigin = null) {
      sessions.set(id, { id, title: id, sessionType: autoOrigin === 'longterm' ? 'longterm' : 'standard', skills: [] });
      metabots.set(id, metabotId ?? null);
      if (autoOrigin) autoOrigins.set(id, autoOrigin);
    },
  };
}

function makeRunner() {
  return {
    starts: [],
    active: new Set(),
    async startSession(sessionId, prompt) { this.starts.push({ sessionId, prompt }); },
    isSessionActive(sessionId) { return this.active.has(sessionId); },
  };
}

async function openWorld() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-advance-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
  };
  const advance = new LongTermAdvanceService(deps);
  return { store, cowork, runner, advance, deps };
}

const SPEC = {
  title: 'Game hub',
  goal: 'Ship the on-chain game hub.',
  subtasks: [{ title: 'Blueprint match loop' }, { title: 'Spectate & replay', dependsOnOrdinals: [1] }],
};

async function createActive(store) {
  const created = store.createTask(SPEC, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(store.activateTask(created.value.id, 'owner').ok);
  return created.value.id;
}

test('pending current sub-project → escalates: opens a longterm session, binds it, journals nudged, starts a turn', async () => {
  const { store, cowork, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const report = await advance.run(now);

  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const hit = report.escalated[0];
  assert.equal(hit.taskId, taskId);
  assert.equal(hit.reusedSession, false);
  assert.match(hit.reasons[0], /pending/);

  assert.equal(cowork.calls.create.length, 1);
  assert.match(cowork.calls.create[0].title, /^\[长期\] Game hub/);
  assert.equal(cowork.calls.create[0].sessionType, 'longterm');
  assert.deepEqual(cowork.calls.create[0].skills, ['long-term-task-exec']);
  assert.equal(cowork.calls.create[0].metabotId, 7);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.equal(subtask.sessionId, hit.sessionId, 'sub-project bound to the opened session');
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].sessionId, hit.sessionId);
  assert.match(runner.starts[0].prompt, /longterm_task_get/);

  const events = store.getTask(taskId).events;
  assert.equal(events[0].kind, 'nudged');
  assert.equal(events[0].actor, 'system');
  const nudgeState = store.getNudgeState(taskId);
  assert.equal(nudgeState.lastNudgeAtMs, now);
  assert.equal(nudgeState.lastEventId, events[0].id, 'throttle state stores the post-nudge journal position');
});

test('throttle: a second run within the window and no new events does not re-escalate', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  const second = await advance.run(now + 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.match(second.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /throttled/);
  assert.equal(runner.starts.length, 1);
});

test('timed external wait expired → escalates even inside the throttle window', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'external',
      note: 'notarization',
      waitUntil: new Date(now - HOUR).toISOString(),
    }, 'twin').ok,
  );
  const report = await advance.run(now + 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /timed wait expired/);
  assert.equal(report.escalated[0].reusedSession, true, 'the bound session is reused, never duplicated');
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, runner.starts[1].sessionId);
});

test('owner decision quiet beyond the reminder window → reminder escalation', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  const report = await advance.run(Date.now() + 13 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('owner reminder cadence: silent at 6h, reminding past the relaxed 12h window', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const now = Date.now();
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  // The pending decision is already permanently visible (main-timeline fold
  // lift + sidebar/tab badges), so the heartbeat only re-presents as a daily
  // digest — six hours in is no longer a reminder.
  const advance = new LongTermAdvanceService(deps);
  const early = await advance.run(now + 6 * HOUR);
  assert.equal(early.escalated.length, 0, JSON.stringify(early));

  // The engine cadence itself is untouched — the sweep still runs and the
  // reminder lands just past the 12h window (the comparison is strictly
  // greater-than on the quiet time), quoting the relaxed interval.
  const due = await advance.run(now + 12 * HOUR + 5 * 60_000);
  assert.equal(due.escalated.length, 1, JSON.stringify(due));
  assert.match(due.escalated[0].reasons[0], /owner decision still pending/);
  assert.match(due.escalated[0].reasons[0], /720min/, 'the relaxed window is what the reason states');
});

test('owner wait with a future waitUntil stays silent inside the promised quiet window', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'owner',
      note: 'need a channel decision',
      waitUntil: new Date(Date.now() + 12 * HOUR).toISOString(),
    }, 'twin').ok,
  );

  const report = await advance.run(Date.now() + 5 * HOUR);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.match(report.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /nothing due/);
});

test('owner wait: the first tick after the quiet window passes re-escalates as a window-ended re-presentation', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(subtask.id, {
      kind: 'owner',
      note: 'need a channel decision',
      waitUntil: new Date(now + HOUR).toISOString(),
    }, 'twin').ok,
  );

  const report = await advance.run(now + 13 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /quiet window ended/);
});

test('stale owner wait: twin work after the wait was parked → convergence escalation, not an owner reminder', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'waiting for owner to start first game' }, 'twin').ok);
  // The Twin works past the parked wait (journal note) but never clears it.
  assert.ok(store.addNote(taskId, subtask.id, 'proceeded autonomously: first bot-vs-bot game started', 'twin').ok);

  const report = await advance.run(Date.now());
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  assert.doesNotMatch(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('stale owner wait converges: after the Twin re-records the wait, reminders return to the normal cadence', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'side work while waiting', 'twin').ok);
  // The convergence turn re-records the wait — fresh anchor, nothing after it.
  assert.ok(
    store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision (re-confirmed)' }, 'twin').ok,
  );

  const report = await advance.run(now + 13 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /owner decision still pending/);
});

test('proposing from an external wait leaves reminders un-silenced; the session-bind note is not "work"', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(
    store.waitSubtask(
      subtask.id,
      { kind: 'external', note: 'notarization', waitUntil: new Date(now + 12 * HOUR).toISOString() },
      'twin',
    ).ok,
  );
  assert.ok(store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);

  const advance = new LongTermAdvanceService(deps);
  // The fresh proposal escalates immediately (一提请就叫你) — this first
  // escalation also binds the session, journaling a system note AFTER the
  // proposal anchor.
  const first = await advance.run(now + 60_000);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  // Hours later the pending decision still reminds as a plain reminder —
  // the residual external window is gone and the bind note must not trip
  // stale-wait convergence.
  const later = await advance.run(now + 13 * HOUR);
  assert.equal(later.escalated.length, 1, JSON.stringify(later));
  assert.match(later.escalated[0].reasons[0], /owner decision still pending/);
  assert.doesNotMatch(later.escalated[0].reasons[0], /stale owner wait/);
});

test('a proposal produced by the heartbeat turn itself still pages the owner next run (anchor fixed before the turn)', async () => {
  // Regression (2026-10-22): the journal anchor used to be stored AFTER
  // `await escalate()` returned — and the turn runs to completion inside
  // escalate(), so a 'proposed' event created by the turn was swallowed by
  // the anchor (proposed.id > lastEventId never held) and the owner was never
  // paged about the acceptance proposal.
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  // The turn works inside startSession: begin + propose acceptance.
  runner.startSession = async (sessionId, prompt) => {
    runner.starts.push({ sessionId, prompt });
    const subtask = store.getTask(taskId).subtasks[0];
    if (subtask.status === 'pending') {
      assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
      assert.ok(
        store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/done' }], summary: 'criteria met' }, 'twin').ok,
      );
    }
  };
  const advance = new LongTermAdvanceService(deps);
  const first = await advance.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_owner');

  // Next sweep: the fresh proposal is newer than the pre-turn anchor, so the
  // owner-facing page fires immediately (一提请就叫你).
  const second = await advance.run(now + 60_000);
  assert.equal(second.escalated.length, 1, JSON.stringify(second));
  assert.match(second.escalated[0].reasons[0], /acceptance proposal awaiting/);
});

test('stale detection survives the 200-event detail cap (direct queries, not sliced journal)', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'waiting for owner' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait', 'twin').ok);
  // Bury the anchor and the work beyond the 200-event projection with noise.
  for (let i = 0; i < 205; i += 1) store.recordNudge(taskId, subtask.id, `noise ${i}`);
  assert.equal(store.getTask(taskId).events.length, 200, 'the detail journal projection is capped');

  const advance = new LongTermAdvanceService(deps);
  const report = await advance.run(Date.now() + HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
});

test('session rotation: an over-budget bound session is rotated with a continuity preamble', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // opens + binds session 1
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES); // at the budget

  const report = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const hit = report.escalated[0];
  assert.equal(hit.reusedSession, false, 'rotation opens a fresh session');
  assert.notEqual(hit.sessionId, firstSessionId);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, hit.sessionId, 'sub-project rebound to the new session');
  assert.match(runner.starts[1].prompt, /SESSION ROTATION/);
  assert.ok(
    runner.starts[1].prompt.includes(`${DEFAULT_SESSION_ROTATION_MESSAGES} messages`),
    'rotation budget stated in the preamble',
  );
  // The rotation is journaled as a system note (excluded from stale-work detection).
  const events = store.getTask(taskId).events;
  assert.ok(events.some((event) => event.kind === 'note' && event.actor === 'system' && /session rotated/.test(event.detail)));
});

test('the rotation budget counts every message row, so a turn-heavy session rotates once it crosses it', async () => {
  // The budget is compared against CoworkStore.countSessionMessages, which
  // counts ALL cowork_messages rows (user + assistant + tool_use + tool_result
  // + system) — not conversation turns. Production rotation points run 62–2024
  // with a median of 129, which is why the default sits at 180: one tool-heavy
  // turn adds 60–400 rows, so a smaller budget only bought an extra rotation
  // per day without buying a smaller context.
  assert.ok(
    DEFAULT_SESSION_ROTATION_MESSAGES >= 150 && DEFAULT_SESSION_ROTATION_MESSAGES <= 200,
    `expected a 150-200 budget for the all-rows unit, got ${DEFAULT_SESSION_ROTATION_MESSAGES}`,
  );

  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;

  // One row below the budget: reused (the comparison is strict `<`).
  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES - 1);
  const reused = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(reused.escalated[0].reusedSession, true);

  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES);
  const rotated = await new LongTermAdvanceService(deps).run(now + 4 * HOUR);
  assert.equal(rotated.escalated[0].reusedSession, false, 'exactly at the budget rotates');
});

test('session rotation: under-budget bound sessions are reused as before', async () => {
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, 12);

  const report = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].reusedSession, true);
  assert.equal(report.escalated[0].sessionId, firstSessionId);
});

test('the opened session title names the sub-project, and a rotation keeps it', async () => {
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);

  const firstCreate = cowork.calls.create[0];
  assert.match(firstCreate.title, /^\[长期\] /);
  assert.match(firstCreate.title, /#1 /, 'the sub-project ordinal is in the title');
  assert.ok(
    firstCreate.title.includes(store.getTask(taskId).subtasks[0].title),
    `sub-project title missing from "${firstCreate.title}"`,
  );
  assert.notEqual(firstCreate.title, `[长期] ${store.getTask(taskId).title}`, 'not the bare task title');

  // Rotation: same sub-project → same title (continuity lives in the preamble).
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES);
  await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(cowork.calls.create.length, 2, 'a fresh session was created');
  assert.equal(cowork.calls.create[1].title, firstCreate.title, 'rotations keep the identical title');
});

test('convergence churn breaker: repeated stale-wait convergence escalates to the owner instead of looping', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  const advance = new LongTermAdvanceService(deps);
  const now = Date.now();
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  // Three stale cycles inside the churn window: each is an ordinary
  // convergence turn (Twin re-parks the wait, works past it again).
  for (let round = 0; round < 3; round += 1) {
    assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: `decision ${round}` }, 'twin').ok);
    assert.ok(store.addNote(taskId, subtask.id, `worked past wait ${round}`, 'twin').ok);
    const report = await advance.run(now + (round + 1) * 10 * 60_000);
    assert.equal(report.escalated.length, 1, JSON.stringify(report));
    assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  }
  // The fourth stale cycle inside the window trips the churn breaker.
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'decision 3' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past wait 3', 'twin').ok);
  const report = await advance.run(now + 45 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /convergence churn/);
});

test('supervision: a leading streak of failed worker dispatches trips a supervise turn, once per new failure', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const now = Date.now();
  const attempts = [
    { id: 'a1', label: 'ltt_x_step_v1', status: 'completed', startedAtMs: now - 9 * HOUR, finishedAtMs: now - 8 * HOUR },
    { id: 'a2', label: 'ltt_x_step_v2', status: 'failed', startedAtMs: now - 7 * HOUR, finishedAtMs: now - 6 * HOUR },
    { id: 'a3', label: 'ltt_x_step_v3', status: 'timed_out', startedAtMs: now - 5 * HOUR, finishedAtMs: now - 4 * HOUR },
  ];
  deps.listWorkerAttempts = () => attempts;
  const supervisor = new LongTermAdvanceService(deps);

  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);

  // Signature already consumed: later runs fall back to ordinary logic (a
  // quiet push at most) — never a repeated supervision for the same failures.
  const second = await supervisor.run(now + 45 * 60_000);
  assert.ok(second.escalated.every((hit) => !hit.reasons[0].startsWith('supervision:')), JSON.stringify(second));

  // A NEW failure changes the signature: supervision re-fires — and bypasses
  // the 30-min noise throttle (last nudge was 5 min ago).
  const fourth = { id: 'a4', label: 'ltt_x_step_v4', status: 'failed', startedAtMs: now - 3 * HOUR, finishedAtMs: now - 2 * HOUR };
  deps.listWorkerAttempts = () => [...attempts, fourth];
  const third = await supervisor.run(now + 50 * 60_000);
  assert.equal(third.escalated.length, 1, JSON.stringify(third));
  assert.match(third.escalated[0].reasons[0], /supervision: 3 consecutive/);
  assert.equal(runner.starts.length, 3, 'three turns total: supervise, quiet push, re-supervise');
});

test('supervision: duration overrun past the expected budget trips a supervise turn, re-armed once per budget window', async () => {
  const { store, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.updateSubtask({ subtaskId: subtask.id, expectedMinutes: 60 }, 'twin').ok);
  const supervisor = new LongTermAdvanceService(deps);

  const first = await supervisor.run(now + 90 * 60_000); // 1.5x the budget
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: in progress for >\d+h without converging \(budget 60min\)/);

  // Inside the re-arm window since that supervision: no second supervision.
  const second = await supervisor.run(now + 2 * HOUR);
  assert.ok(second.escalated.every((hit) => !hit.reasons[0].startsWith('supervision:')), JSON.stringify(second));

  // A full budget window after the last supervision: it fires again.
  const third = await supervisor.run(now + 4 * HOUR);
  assert.equal(third.escalated.filter((hit) => hit.reasons[0].startsWith('supervision:')).length, 1, JSON.stringify(third));
});

test('P1-A regression: a duration turn does not reset the failure-streak dedup (no paired supervision)', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.updateSubtask({ subtaskId: subtask.id, expectedMinutes: 60 }, 'twin').ok);
  deps.listWorkerAttempts = () => [
    { id: 'a1', label: 'v1', status: 'failed', startedAtMs: now - 3 * HOUR, finishedAtMs: now - 2.5 * HOUR },
    { id: 'a2', label: 'v2', status: 'failed', startedAtMs: now - 2 * HOUR, finishedAtMs: now - 1.5 * HOUR },
  ];
  const supervisor = new LongTermAdvanceService(deps);

  // Failure-streak supervision consumes its signature.
  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /supervision: 2 consecutive/);

  // One budget window later (no new failures): duration supervision fires.
  const second = await supervisor.run(now + 90 * 60_000);
  assert.equal(second.escalated.length, 1, JSON.stringify(second));
  assert.match(second.escalated[0].reasons[0], /supervision: in progress for >\d+h without converging/);

  // Five minutes after that duration turn — still no new failures, and the
  // last nudge is 5 min old (inside the 30-min noise throttle): the OLD
  // failure signature must NOT look fresh again. With the shared-slot bug
  // this spurious turn fired and bypassed the throttle.
  const third = await supervisor.run(now + 95 * 60_000);
  assert.equal(third.escalated.length, 0, JSON.stringify(third));
  assert.equal(runner.starts.length, 2, 'exactly two supervision turns total');
});

test('supervision turn prompt carries the verdict contract, responsibility chain, and dispatch record', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const now = Date.now();
  deps.listWorkerAttempts = () => [
    { id: 'a1', label: 'ltt_x_v1', status: 'completed', startedAtMs: now - 9 * HOUR, finishedAtMs: now - 8 * HOUR },
    { id: 'a2', label: 'ltt_x_v2', status: 'failed', startedAtMs: now - 7 * HOUR, finishedAtMs: now - 6 * HOUR },
    { id: 'a3', label: 'ltt_x_v3', status: 'timed_out', startedAtMs: now - 4 * HOUR, finishedAtMs: now - 3 * HOUR },
  ];
  const supervisor = new LongTermAdvanceService(deps);
  const report = await supervisor.run(now);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const prompt = runner.starts[0].prompt;
  assert.match(prompt, /SUPERVISION check on delegated work/i);
  assert.match(prompt, /three questions/i);
  assert.match(prompt, /Responsibility chain/i);
  assert.match(prompt, /third identical retry is forbidden/i);
  assert.ok(prompt.includes('ltt_x_v3: timed_out (60min)'), 'dispatch record embedded with duration');
  assert.ok(prompt.includes('ltt_x_v2: failed (60min)'), 'failed dispatch visible');
});

test('routine (non-supervision) turns carry no supervision block', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.doesNotMatch(runner.starts[0].prompt, /SUPERVISION check on delegated work/i);
});

test('attention: Twin recovery escalates once per attempt and re-arms only for a new attempt', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  let attemptId = 'restart-a1';
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-restart',
    attention: { waitingOn: 'twin', reason: 'RECOVERED_AFTER_RESTART', stepId: 'step-1', attemptId },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.match(first.escalated[0].reasons[0], /attention: twin/);
  assert.match(runner.starts[0].prompt, /RECOVERED_AFTER_RESTART/);
  assert.match(runner.starts[0].prompt, /SUPERVISION check on delegated work/i);

  const second = await supervisor.run(now + 5 * 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.equal(runner.starts.length, 1, 'the same attention cannot create a duplicate turn');

  attemptId = 'restart-a2';
  const third = await supervisor.run(now + 10 * 60_000);
  assert.equal(third.escalated.length, 1, JSON.stringify(third));
  assert.equal(runner.starts.length, 2, 'a new attempt bypasses the ordinary nudge throttle exactly once');
});

test('attention: a subtask that keeps failing is parked for the owner after the retry cap, not escalated forever', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  let attemptSeq = 0;
  // Every run reports a NEW failed attempt — a fresh attention key each time,
  // exactly the runaway shape the review flagged (twin re-dispatch → new
  // attempt → new key → throttle bypassed).
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-cap',
    attention: { waitingOn: 'twin', reason: 'RECOVERED_AFTER_RESTART', stepId: 'step-1', attemptId: `cap-a${++attemptSeq}` },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  for (let i = 0; i < MAX_ATTENTION_ESCALATIONS_PER_SUBTASK; i += 1) {
    const report = await supervisor.run(now + i * 5 * 60_000);
    assert.equal(report.escalated.length, 1, `run ${i + 1} should escalate: ${JSON.stringify(report)}`);
  }
  assert.equal(runner.starts.length, MAX_ATTENTION_ESCALATIONS_PER_SUBTASK);

  // The next fresh attempt no longer buys a turn: the subtask is parked.
  const capped = await supervisor.run(now + MAX_ATTENTION_ESCALATIONS_PER_SUBTASK * 5 * 60_000);
  assert.equal(capped.escalated.length, 0, JSON.stringify(capped));
  assert.equal(runner.starts.length, MAX_ATTENTION_ESCALATIONS_PER_SUBTASK, 'the cap stops further attention turns');
  assert.match(capped.skipped[0].reason, /attention retry cap reached/);
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_owner');
  assert.match(store.getTask(taskId).subtasks[0].waitNote ?? '', /owner review needed/);
});

test('attention: Owner question is journaled once and delivered with the concrete human action', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-owner',
    attention: { waitingOn: 'owner', reason: 'Worker requested a human decision', humanAction: 'Approve production deploy?', attemptId: 'owner-a1' },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 1, JSON.stringify(first));
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_owner');
  assert.match(runner.starts[0].prompt, /Approve production deploy\?/);
  assert.match(store.getTask(taskId).subtasks[0].waitNote, /Approve production deploy\?/);

  const second = await supervisor.run(now + 5 * 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.equal(runner.starts.length, 1, 'the same owner question is not re-asked');
});

test('attention: External wait is recorded without an LLM turn and without duplicate journal entries', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-external',
    attention: { waitingOn: 'external', reason: 'CI still running', attemptId: 'external-a1' },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  const first = await supervisor.run(now);
  assert.equal(first.escalated.length, 0, JSON.stringify(first));
  assert.equal(runner.starts.length, 0);
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_external');
  assert.match(store.getTask(taskId).subtasks[0].waitNote, /CI still running/);
  const waitingEvents = store.getTask(taskId).events.filter((event) => event.kind === 'waiting' && event.detail.includes('CI still running'));
  assert.equal(waitingEvents.length, 1);

  const second = await supervisor.run(now + 5 * 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.equal(runner.starts.length, 0);
  assert.equal(store.getTask(taskId).events.filter((event) => event.kind === 'waiting' && event.detail.includes('CI still running')).length, 1);
});

test('attention: Worker execution suppresses a duplicate quiet push', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-worker',
    attention: { waitingOn: 'worker', reason: 'Worker attempt is running', attemptId: 'worker-a1' },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const report = await supervisor.run(Date.now());
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.equal(runner.starts.length, 0);
  assert.match(report.skipped[0].reason, /waiting for the Worker/);
});

test('action outcome: an unchanged attention retries with backoff and escalates to Owner after bounded attempts', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  deps.attentionRetryMs = 1_000;
  deps.attentionMaxAttempts = 2;
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-noop',
    attention: { waitingOn: 'twin', reason: 'still unresolved', attemptId: 'a1' },
  }];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  await supervisor.run(now);
  assert.equal(runner.starts.length, 1);
  let state = store.getSuperviseState(taskId);
  assert.equal(state.lastAttentionResolution, 'actioned');
  assert.equal(state.attentionActionCount, 1);
  assert.equal(state.nextAttentionRetryAtMs, now + 1_000);

  await supervisor.run(now + 500);
  assert.equal(runner.starts.length, 1, 'backoff suppresses an immediate duplicate action');

  await supervisor.run(now + 1_000);
  assert.equal(runner.starts.length, 2);
  state = store.getSuperviseState(taskId);
  assert.equal(state.lastAttentionResolution, 'actioned');
  assert.equal(state.attentionActionCount, 2);

  await supervisor.run(now + 2_000);
  assert.equal(runner.starts.length, 3);
  state = store.getSuperviseState(taskId);
  assert.equal(state.lastAttentionResolution, 'escalated');
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_owner');
  assert.match(runner.starts[2].prompt, /could not resolve/);

  await supervisor.run(now + 3_000);
  assert.equal(runner.starts.length, 3, 'Owner escalation does not create another unresolved retry');
});

test('action outcome: a changed attention is resolved and the new state gets its own action', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  let waitingOn = 'twin';
  deps.listOrchestrationAttention = () => [{
    orchestrationTaskId: 'orch-resolved',
    attention: { waitingOn, reason: 'worker state changed', attemptId: 'a1' },
  }];
  runner.startSession = async (sessionId, prompt) => {
    runner.starts.push({ sessionId, prompt });
    waitingOn = 'worker';
  };
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  await supervisor.run(now);
  const state = store.getSuperviseState(taskId);
  assert.equal(state.lastAttentionResolution, 'resolved');
  assert.equal(state.nextAttentionRetryAtMs, 0);
  assert.equal(state.attentionActionCount, 0);

  const second = await supervisor.run(now + 1_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.equal(runner.starts.length, 1, 'resolved attention cannot be replayed');
});

test('action outcome: a legacy action key without resolution gets one result review instead of being swallowed', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const selection = {
    orchestrationTaskId: 'legacy-orch',
    attention: { waitingOn: 'twin', reason: 'legacy failure', attemptId: 'legacy-a1' },
  };
  const { longTermAttentionKey } = await import('../dist-electron/main/services/longTermAttentionAction.js');
  store.setSuperviseState(taskId, {
    lastSuperviseAtMs: 0,
    lastAttentionKey: longTermAttentionKey(selection),
  });
  deps.attentionRetryMs = 1_000;
  deps.attentionMaxAttempts = 2;
  deps.listOrchestrationAttention = () => [selection];
  const supervisor = new LongTermAdvanceService(deps);
  const now = Date.now();

  await supervisor.run(now);
  assert.equal(runner.starts.length, 1, 'legacy actioned state is eligible for result review');
  assert.equal(store.getSuperviseState(taskId).lastAttentionResolution, 'actioned');
  assert.equal(store.getSuperviseState(taskId).attentionActionCount, 2);

  await supervisor.run(now + 1_000);
  assert.equal(store.getSuperviseState(taskId).lastAttentionResolution, 'escalated');
  assert.equal(store.getTask(taskId).subtasks[0].status, 'waiting_owner');
});

test('telemetry wiring: real OrchestrationStore attempts sourced from the bound session drive the failure streak', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-telemetry-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
    // Mirrors the main.ts adapter: attempts sourced from every session EVER
    // bound to this sub-project (rotation-safe), and only this sub-project's.
    listWorkerAttempts: (taskId, subtaskId) => {
      const subtask = store.getSubtask(subtaskId);
      if (!subtask) return [];
      const sessionIds = subtask.sessionHistory.length > 0
        ? subtask.sessionHistory
        : (subtask.sessionId ? [subtask.sessionId] : []);
      if (sessionIds.length === 0) return [];
      return orchestration.listAttemptsForSourceSessions(sessionIds).map((attempt) => ({
        id: attempt.id,
        label: attempt.idempotencyKey,
        status: attempt.status,
        startedAtMs: attempt.startedAt ? Date.parse(attempt.startedAt) : null,
        finishedAtMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) : null,
      }));
    },
  };
  const advance = new LongTermAdvanceService(deps);
  const taskId = await createActive(store);
  const now = Date.now();
  // First escalation while the sub-project is pending opens + binds the session.
  await advance.run(now);
  const boundSessionId = store.getTask(taskId).subtasks[0].sessionId;
  assert.ok(boundSessionId, 'session bound by the first escalation');

  // Two failed dispatches sourced from an UNRELATED session: must not trip
  // supervision for this sub-project.
  const stranger = orchestration.createTask({
    ownerIntent: 'someone else', sourceSessionId: 'unrelated-session',
    twinMetabotId: 7, ownerGlobalMetaId: 'owner-global', origin: 'twin_delegate',
  });
  const strangerStep = orchestration.createStep({ taskId: stranger.id, ordinal: 1, title: 's', objective: 'o' });
  const s1 = orchestration.createAttempt({ stepId: strangerStep.id, idempotencyKey: 'other_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(s1.id, 'failed', { error: 'boom' });
  const s2 = orchestration.createAttempt({ stepId: strangerStep.id, idempotencyKey: 'other_v2', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(s2.id, 'failed', { error: 'boom' });

  // The Twin begins. With only the unrelated session's failures visible, the
  // next turn is an ordinary quiet push — never supervision.
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const midRun = await advance.run(now + 45 * 60_000);
  assert.ok(midRun.escalated.length === 1 && !midRun.escalated[0].reasons[0].startsWith('supervision:'), JSON.stringify(midRun));

  // Dispatches from THIS session then both fail → supervision fires.
  const orch = orchestration.createTask({
    ownerIntent: 'build the thing',
    sourceSessionId: boundSessionId,
    twinMetabotId: 7,
    ownerGlobalMetaId: 'owner-global',
    origin: 'twin_delegate',
  });
  const step = orchestration.createStep({ taskId: orch.id, ordinal: 1, title: 's', objective: 'o' });
  const first = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'ltt_x_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(first.id, 'failed', { error: 'boom' });
  const second = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'ltt_x_v2', workerMetabotId: 15, prompt: 'go again' });
  orchestration.updateAttempt(second.id, 'failed', { error: 'boom again' });

  const report = await advance.run(now + 50 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);
  // The dispatch record embedded in the supervision prompt comes from the real store.
  assert.ok(runner.starts[2].prompt.includes('ltt_x_v2: failed'), 'real attempt rendered in the prompt');
  // Supervision turns journal as 'supervised' (distinct from routine 'nudged').
  const events = store.getTask(taskId).events;
  assert.equal(events[0].kind, 'supervised');
  assert.equal(events[0].actor, 'system');
});

test('session rotation does not blind the failure streak (history spans all bound sessions)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-rotate-'));
  const sqliteStore = await SqliteStore.create(dir);
  const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const orchestration = new OrchestrationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const cowork = makeStubCowork();
  const runner = makeRunner();
  const deps = {
    store: () => store,
    coworkStore: () => cowork,
    coworkRunner: () => runner,
    resolveTwinMetabotId: () => 7,
    resolveWorkingDirectory: () => '/tmp/lt',
    getBaseSystemPrompt: () => 'base',
    getSkillsPrompt: async () => null,
    listWorkerAttempts: (taskId, subtaskId) => {
      const subtask = store.getSubtask(subtaskId);
      if (!subtask) return [];
      const sessionIds = subtask.sessionHistory.length > 0
        ? subtask.sessionHistory
        : (subtask.sessionId ? [subtask.sessionId] : []);
      if (sessionIds.length === 0) return [];
      return orchestration.listAttemptsForSourceSessions(sessionIds).map((attempt) => ({
        id: attempt.id,
        label: attempt.idempotencyKey,
        status: attempt.status,
        startedAtMs: attempt.startedAt ? Date.parse(attempt.startedAt) : null,
        finishedAtMs: attempt.finishedAt ? Date.parse(attempt.finishedAt) : null,
      }));
    },
  };
  const advance = new LongTermAdvanceService(deps);
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now); // pending escalation → binds session 1
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  assert.ok(firstSessionId);

  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const orch = orchestration.createTask({
    ownerIntent: 'build the thing', sourceSessionId: firstSessionId,
    twinMetabotId: 7, ownerGlobalMetaId: 'owner-global', origin: 'twin_delegate',
  });
  const step = orchestration.createStep({ taskId: orch.id, ordinal: 1, title: 's', objective: 'o' });
  const a1 = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'rot_v1', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(a1.id, 'failed', { error: 'boom' });
  const a2 = orchestration.createAttempt({ stepId: step.id, idempotencyKey: 'rot_v2', workerMetabotId: 15, prompt: 'go' });
  orchestration.updateAttempt(a2.id, 'failed', { error: 'boom' });

  // Push the bound session over the rotation budget: the NEXT escalation must
  // rotate — and the streak from the OLD session must still trip supervision.
  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES);
  const report = await advance.run(now + 10 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /supervision: 2 consecutive failed\/timed-out worker dispatches/);
  assert.equal(report.escalated[0].reusedSession, false, 'the bound session rotated');
  assert.notEqual(report.escalated[0].sessionId, firstSessionId);
  const after = store.getTask(taskId).subtasks[0];
  assert.deepEqual(after.sessionHistory, [firstSessionId, report.escalated[0].sessionId], 'history spans both sessions');
});

test('in_progress without a bound session starts the first work turn immediately', async () => {
  const { store, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok, 'begin did not start a work session');

  const report = await advance.run(Date.now());
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /just began but no work session was started/);
});

test('in_progress with a bound session and fresh work events is NOT re-pushed (quiet rule)', async () => {
  const { store, cowork, advance } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  cowork.registerSession('sess-existing', 7, 'longterm');
  assert.ok(store.bindSession(subtask.id, 'sess-existing', 'twin').ok);
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok, 'a turn just began it');

  const report = await advance.run(Date.now());
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
});

test('never stacks a turn onto an already-running session', async () => {
  const { store, runner, advance } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await advance.run(now);
  const sessionId = store.getTask(taskId).subtasks[0].sessionId;
  runner.active.add(sessionId);

  const report = await advance.run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.match(report.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /already running/);
});

test('run escalation budget: at most maxEscalationsPerRun escalations per run', async () => {
  const { store, advance, deps } = await openWorld();
  deps.maxEscalationsPerRun = 2;
  const capped = new LongTermAdvanceService(deps);
  await createActive(store);
  await createActive(store);
  await createActive(store);

  const report = await capped.run(Date.now());
  assert.equal(report.escalated.length, 2, JSON.stringify(report));
  assert.ok(report.skipped.some((s) => s.reason.includes('budget')));
});

test('paused / defining / done tasks are never escalated', async () => {
  const { store, advance } = await openWorld();
  const activeId = await createActive(store);
  assert.ok(store.pauseTask(activeId, 'owner').ok);
  const draft = store.createTask(SPEC, 'twin');
  assert.ok(draft.ok);
  assert.equal(draft.value.stage, 'defining');

  const report = await advance.run(Date.now());
  assert.equal(report.checkedTasks, 0);
  assert.equal(report.escalated.length, 0);
});

test('a fresh acceptance proposal escalates at the next tick (一提请就叫你), not after the reminder window', async () => {
  const { store, advance, runner } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  // One escalation to establish the session + nudge state.
  await advance.run(now);
  assert.equal(runner.starts.length, 1);

  // Twin begins and proposes acceptance with evidence — 2 minutes ago.
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);
  assert.equal(store.getTask(taskId).column, 'waiting_owner');

  // Next tick, 2 minutes later: fresh proposed event → immediate escalation.
  const report = await advance.run(now + 2 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /acceptance proposal/);
});

test('nudge prompt follows the owner locale (zh owners get the Chinese hand-off)', async () => {
  const { store, runner, deps } = await openWorld();
  deps.getAppLanguage = () => 'zh';
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.equal(runner.starts.length, 1);
  assert.match(runner.starts[0].prompt, /心跳自动开启/);
  assert.match(runner.starts[0].prompt, /用主人的语言回复/);
  assert.match(runner.starts[0].prompt, /本地时区/);
});

test('nudge prompt anchors the turn to the goal + acceptance criteria (anti-drift)', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  const prompt = runner.starts[0].prompt;
  // The task goal (done-ness definition) rides every heartbeat turn.
  assert.ok(prompt.includes('Ship the on-chain game hub.'), 'goal text missing from the nudge prompt');
  // The turn must restate understanding before acting, and escalate new infra as a question.
  assert.match(prompt, /复述.*理解|restate your understanding/i);
  assert.match(prompt, /自行拍板|never your call alone/i);
  assert.match(prompt, /local timezone/i);
});

test('nudge prompt embeds acceptance criteria lines', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  const withCriteria = store.createTask(
    { title: 't1', goal: 'g', subtasks: [{ title: 's1', acceptanceCriteria: ['criterion one', 'criterion two'] }] },
    'owner',
  );
  assert.ok(withCriteria.ok);
  assert.ok(store.activateTask(withCriteria.value.id, 'owner').ok);
  await advance.run(Date.now());
  assert.ok(runner.starts[0].prompt.includes('criterion one'), 'criteria lines missing');
});

test('waiting-owner nudge prompt carries the full-restatement contract and the wait note', async () => {
  const { store, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick channel A or B' }, 'twin').ok);

  const advance = new LongTermAdvanceService(deps);
  const report = await advance.run(Date.now() + 13 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const prompt = runner.starts[0].prompt;
  assert.match(prompt, /waiting on the owner/i);
  assert.match(prompt, /full re-presentation/i);
  assert.match(prompt, /no change/);
  assert.ok(prompt.includes('pick channel A or B'), 'wait note embedded in the prompt');
});

test('non-waiting nudge prompts carry no restatement contract', async () => {
  const { store, runner, deps } = await openWorld();
  const advance = new LongTermAdvanceService(deps);
  await createActive(store);
  await advance.run(Date.now());
  assert.doesNotMatch(runner.starts[0].prompt, /SPECIAL REQUIREMENT/);
});

// ── P2 owner engagement: related-session awareness, suppression, venue convergence ──

test('owner actively engaged in a related session: the acceptance-proposal call is suppressed, then fires into the venue after disengagement', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  // Run #1: pending → escalation opens + binds the session.
  await new LongTermAdvanceService(deps).run(now);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);

  // The conversation drifts to a history session; run #2 rebinds silently
  // (owner engaged there) without firing a turn.
  cowork.registerSession('venue', 7);
  assert.ok(store.bindSession(subtask.id, 'venue', 'system').ok);
  assert.ok(store.bindSession(subtask.id, boundId, 'system').ok);
  cowork.engagement.set('venue', { lastOwnerMessageAtMs: now + 4 * 60_000, lastAssistantMessageAtMs: null });
  const second = await new LongTermAdvanceService(deps).run(now + 5 * 60_000);
  assert.equal(second.escalated.length, 0, JSON.stringify(second));
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'venue', 'the binding silently followed the owner');

  // The twin proposes acceptance; the owner is STILL online in the venue. The
  // proposal fast-path (一提请就叫你) is owner-facing — an engaged owner must
  // not get a second, parallel call.
  assert.ok(store.proposeSubtask(subtask.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);
  cowork.engagement.set('venue', { lastOwnerMessageAtMs: now + 7 * 60_000, lastAssistantMessageAtMs: null });
  const third = await new LongTermAdvanceService(deps).run(now + 8 * 60_000);
  assert.equal(third.escalated.length, 0, JSON.stringify(third));
  assert.match(third.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /actively engaged/);
  assert.equal(runner.starts.length, 1, 'no parallel turn fired while the owner is mid-conversation');
  assert.equal(store.getNudgeState(taskId).lastOwnerActivityAtMs, now + 7 * 60_000, 'owner-activity anchor persisted');

  // Once the owner has been quiet past the engagement window, the proposal
  // call fires — into the venue where the owner last spoke.
  const fourth = await new LongTermAdvanceService(deps).run(now + 8 * 60_000 + 2 * HOUR + 5 * 60_000);
  assert.equal(fourth.escalated.length, 1, JSON.stringify(fourth));
  assert.match(fourth.escalated[0].reasons[0], /acceptance proposal awaiting/);
  assert.equal(fourth.escalated[0].sessionId, 'venue');
  assert.equal(fourth.escalated[0].reusedSession, true);
});

test('after the owner disengages, the reminder measures quiet from their last message and lands in the venue without rotating', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick A or B' }, 'twin').ok);
  const first = await new LongTermAdvanceService(deps).run(now + 13 * HOUR);
  const boundId = first.escalated[0].sessionId;
  cowork.registerSession('venue', 7);
  assert.ok(store.bindSession(subtask.id, 'venue', 'system').ok);
  assert.ok(store.bindSession(subtask.id, boundId, 'system').ok);
  // Engaged sweep: rebind + suppress + anchor.
  const tEngaged = now + 14 * HOUR;
  cowork.engagement.set('venue', { lastOwnerMessageAtMs: tEngaged - 5 * 60_000, lastAssistantMessageAtMs: null });
  await new LongTermAdvanceService(deps).run(tEngaged);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'venue', 'binding followed the owner');

  // The owner kept talking until tTalk (6h past the rebind), then went quiet.
  // At mid the journal has been silent for 12.5h — past the 12h reminder
  // window — but the OWNER has been quiet for only 6.5h: WITHOUT the owner
  // anchor a reminder would fire here, with it the reminder waits for the
  // owner's own quiet clock.
  const tTalk = tEngaged + 6 * HOUR;
  cowork.engagement.set('venue', { lastOwnerMessageAtMs: tTalk, lastAssistantMessageAtMs: null });
  const mid = await new LongTermAdvanceService(deps).run(tEngaged + 12 * HOUR + 30 * 60_000);
  assert.equal(mid.escalated.length, 0, `quiet measured from the owner's last word: ${JSON.stringify(mid)}`);

  // Past the owner-anchored 12h the reminder fires — into the venue, even over
  // the rotation budget: owner-facing turns never rotate away from the owner.
  cowork.counts.set('venue', 10_000);
  const due = await new LongTermAdvanceService(deps).run(tTalk + 12 * HOUR + 5 * 60_000);
  assert.equal(due.escalated.length, 1, JSON.stringify(due));
  assert.match(due.escalated[0].reasons[0], /owner decision still pending/);
  assert.equal(due.escalated[0].sessionId, 'venue');
  assert.equal(due.escalated[0].reusedSession, true, 'venue reused, not rotated');
  const lastPrompt = runner.starts[runner.starts.length - 1].prompt;
  assert.match(lastPrompt, /full re-presentation/, 'cold delivery keeps the self-contained brief');
});

test('hot delivery: a due work push lands in the owner\'s live session with the conversational prompt', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  deps.getAppLanguage = () => 'zh';
  const taskId = await createActive(store);
  const now = Date.now();
  const first = await new LongTermAdvanceService(deps).run(now);
  const boundId = first.escalated[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  cowork.registerSession('venue', 7);
  assert.ok(store.bindSession(subtask.id, 'venue', 'system').ok);
  assert.ok(store.bindSession(subtask.id, boundId, 'system').ok);
  // 45 minutes of journal quiet (> the 30-min push window), owner active 10
  // minutes ago in the drifted venue, twin idle for 2h.
  const t2 = now + 45 * 60_000;
  cowork.engagement.set('venue', { lastOwnerMessageAtMs: t2 - 10 * 60_000, lastAssistantMessageAtMs: t2 - 2 * HOUR });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  const hit = report.escalated[0];
  assert.match(hit.reasons[0], /gone quiet/);
  assert.equal(hit.sessionId, 'venue', 'the turn was delivered into the owner\'s live session');
  const prompt = runner.starts[runner.starts.length - 1].prompt;
  assert.match(prompt, /主人此刻就在本会话中/, 'hot intro');
  assert.doesNotMatch(prompt, /复述你对该子项目的理解/, 'hot mode drops the cold-template restatement');
  assert.match(store.getTask(taskId).events[0].detail, /owner's live session/, 'journal marks the hot delivery');
});

test('hot delivery for a waiting-owner turn forbids the six-section brief', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick A or B' }, 'twin').ok);
  const first = await new LongTermAdvanceService(deps).run(now + 13 * HOUR);
  const boundId = first.escalated[0].sessionId;
  // The owner is engaged in the BOUND session itself; a stale-wait convergence
  // (work family) is due, so a turn fires while the owner is online.
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait', 'twin').ok);
  const t2 = now + 14 * HOUR;
  cowork.engagement.set(boundId, { lastOwnerMessageAtMs: t2 - 3 * 60_000, lastAssistantMessageAtMs: t2 - 2 * HOUR });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  const prompt = runner.starts[runner.starts.length - 1].prompt;
  assert.match(prompt, /RIGHT HERE in this session/);
  assert.match(prompt, /six-section re-presentation is FORBIDDEN/);
});

test('twin recently active in a related session: the quiet work push is suppressed', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const t2 = now + 3 * HOUR;
  // The twin turned 10 minutes ago (no journal write) — a journal-quiet push
  // would double the work line.
  cowork.engagement.set(boundId, { lastOwnerMessageAtMs: null, lastAssistantMessageAtMs: t2 - 10 * 60_000 });
  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.match(report.skipped.find((s) => s.taskId === taskId)?.reason ?? '', /twin recently active/);
  assert.equal(runner.starts.length, 1);
});

test('a delegated worker\'s session activity neither suppresses nor blocks the twin\'s escalations', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  // A worker session (metabot 15 ≠ twin 7) in the task's history, mid-turn.
  cowork.registerSession('worker-sess', 15);
  assert.ok(store.bindSession(subtask.id, 'worker-sess', 'system').ok);
  assert.ok(store.bindSession(subtask.id, boundId, 'system').ok);
  const t2 = now + 3 * HOUR;
  cowork.engagement.set('worker-sess', { lastOwnerMessageAtMs: null, lastAssistantMessageAtMs: t2 - 5 * 60_000 });
  runner.active.add('worker-sess');
  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report), 'worker activity must not silence the heartbeat that supervises it');
  assert.match(report.escalated[0].reasons[0], /gone quiet/);
});

test('session rotation leaves a visible pointer message in the old session', async () => {
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const firstSessionId = store.getTask(taskId).subtasks[0].sessionId;
  cowork.counts.set(firstSessionId, DEFAULT_SESSION_ROTATION_MESSAGES);
  const report = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.notEqual(report.escalated[0].sessionId, firstSessionId);
  const pointer = cowork.calls.message.find((call) => call.id === firstSessionId && call.msg.type === 'system');
  assert.ok(pointer, 'a system pointer message was posted to the old session');
  // Owner-facing wording: routine rotation, not a failure — no budget numbers.
  assert.match(pointer.msg.content, /Routine rotation/);
  assert.doesNotMatch(pointer.msg.content, /budget/i);
});

test('an over-budget bound session that is the owner\'s live venue is reused, not rotated', async () => {
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const t2 = now + 3 * HOUR;
  cowork.counts.set(boundId, 10_000); // way over the rotation budget
  cowork.engagement.set(boundId, { lastOwnerMessageAtMs: t2 - 5 * 60_000, lastAssistantMessageAtMs: t2 - 2 * HOUR });
  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, boundId, 'the owner\'s live session is kept');
  assert.equal(report.escalated[0].reusedSession, true);
  assert.equal(cowork.calls.create.length, 1, 'no fresh session was opened');
});

test('an owner-opened conversation is never rotated: a due work turn after the owner steps away reuses it over budget, with no pointer or fresh session', async () => {
  // Production incident: the owner defined a long-term task inside a normal
  // conversation; the venue rebind bound sub-project #1 to it; 3.5h after the
  // owner's last message a work push found 353 rows (> budget) and rotated —
  // a "budget reached" pointer landed in the owner's own conversation and the
  // task moved to a fresh session, only for the owner's next message to
  // rebind it and queue the same rotation again.
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // opens + binds heartbeat session 1
  const heartbeatSessionId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);

  // A conversation the OWNER opened (no auto-origin): related to the task,
  // and the engaged sweep rebinds to it — the venue-follow behaviour.
  cowork.registerSession('owner-chat', 7);
  assert.equal(cowork.getSessionAutoOrigin('owner-chat'), null, 'human-opened sessions carry no auto-origin');
  assert.ok(store.bindSession(subtask.id, 'owner-chat', 'system').ok);
  assert.ok(store.bindSession(subtask.id, heartbeatSessionId, 'system').ok);
  const tEngaged = now + 1 * HOUR;
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: tEngaged - 5 * 60_000, lastAssistantMessageAtMs: null });
  await new LongTermAdvanceService(deps).run(tEngaged);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'owner-chat', 'binding followed the owner into their conversation');

  // The owner steps away past the engagement window; their conversation is
  // far over the rotation budget (tool traffic counts every row) and a work
  // push is due (still inside the supervision budget, so a plain push). It
  // must simply run there — the owner's conversation is governed by the
  // runner's compaction and the owner, never by this budget.
  cowork.counts.set('owner-chat', 353);
  const createdBefore = cowork.calls.create.length;
  const report = await new LongTermAdvanceService(deps).run(tEngaged + 90 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /gone quiet/);
  assert.equal(report.escalated[0].sessionId, 'owner-chat', 'the owner\'s conversation is kept');
  assert.equal(report.escalated[0].reusedSession, true, 'reused, not rotated');
  assert.equal(cowork.calls.create.length, createdBefore, 'no fresh session was opened');
  assert.ok(
    !cowork.calls.message.some((call) => call.id === 'owner-chat' && call.msg.type === 'system'),
    'no rotation pointer was posted into the owner\'s conversation',
  );
  assert.ok(
    !store.getTask(taskId).events.some((event) => /session rotated/.test(event.detail)),
    'nothing was journaled as a rotation',
  );
});

test('a heartbeat-owned session still rotates on budget once the owner is gone, even if they once typed in it', async () => {
  // Ownership is by origin, not by presence: the heartbeat's own sessions stay
  // subject to the budget (unattended growth is what rotation exists for);
  // only the live-venue / owner's-latest-word cases hold them back.
  const { store, cowork, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  assert.equal(cowork.getSessionAutoOrigin(boundId), 'longterm', 'heartbeat sessions carry the longterm auto-origin');
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  const t2 = now + 3 * HOUR;
  cowork.counts.set(boundId, DEFAULT_SESSION_ROTATION_MESSAGES);
  // The owner dropped a line here two hours ago — past the engagement window,
  // so this is neither their live venue nor an owner-facing turn's target.
  cowork.engagement.set(boundId, { lastOwnerMessageAtMs: t2 - 2 * HOUR, lastAssistantMessageAtMs: t2 - 2 * HOUR });
  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].reusedSession, false, 'heartbeat-owned session rotated on budget');
  assert.notEqual(report.escalated[0].sessionId, boundId);
});

// ── P3 venue rules: owner-facing turns never fork the human conversation ──

test('2026-11-02 incident: a waiting-owner turn never rotates — the fat heartbeat session holding the owner\'s latest word is kept', async () => {
  // Production incident: the acceptance ticket sat on a 401-message
  // heartbeat-owned session; the owner's last word (2h before dawn) was in
  // that same session. A stale-wait convergence turn fired while the owner
  // slept, the reason classified as a WORK turn, so the venue guards did not
  // apply and the session rotated into a fresh one — the re-pushed ticket
  // surfaced the new session as the decision venue, and the owner's morning
  // ruling landed in a forked conversation. A turn whose prompt carries the
  // owner-wait block (ANY turn on a waiting_owner sub-project) is
  // owner-facing in effect: it stays where the owner last spoke, budget or
  // not.
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // opens + binds session 1
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'acceptance proposed' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait (v1.0.2 shipped)', 'twin').ok);
  cowork.counts.set(boundId, DEFAULT_SESSION_ROTATION_MESSAGES);
  // The owner's newest message is IN the bound session, two hours ago — past
  // the engagement window (asleep), but still their latest word.
  const t2 = now + 3 * HOUR;
  cowork.engagement.set(boundId, { lastOwnerMessageAtMs: t2 - 2 * HOUR, lastAssistantMessageAtMs: t2 - 2 * HOUR });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /stale owner wait/);
  assert.equal(report.escalated[0].sessionId, boundId, 'the turn stays in the session holding the owner\'s latest word');
  assert.equal(report.escalated[0].reusedSession, true, 'no rotation');
  assert.equal(cowork.calls.create.length, 1, 'no fresh session was opened');
  const prompt = runner.starts[runner.starts.length - 1].prompt;
  assert.match(prompt, /full re-presentation/, 'the decision re-push still happens — in the right session');
  assert.doesNotMatch(prompt, /SESSION ROTATION/);
});

test('an owner-facing turn targets the owner\'s latest conversation even when the bound work session is over budget', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // opens + binds the work session
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick A or B' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait', 'twin').ok);
  cowork.counts.set(boundId, DEFAULT_SESSION_ROTATION_MESSAGES);
  // The owner's newest word is in a DIFFERENT related conversation (their own
  // chat), two hours ago — not live, so no engaged-rebind happens; only the
  // venue rules move the decision line there.
  cowork.registerSession('owner-chat', 7);
  assert.ok(store.bindSession(subtask.id, 'owner-chat', 'system').ok); // make it related
  assert.ok(store.bindSession(subtask.id, boundId, 'system').ok);
  const t2 = now + 3 * HOUR;
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: t2 - 2 * HOUR, lastAssistantMessageAtMs: null });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'owner-chat', 'the decision re-push lands in the owner\'s conversation');
  assert.equal(report.escalated[0].reusedSession, true, 'no fresh session');
  assert.equal(cowork.calls.create.length, 1, 'the over-budget work session was not rotated either');
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'owner-chat', 'the binding converged');
  assert.doesNotMatch(runner.starts[runner.starts.length - 1].prompt, /SESSION ROTATION/);
});

test('with no owner message anywhere, an owner-facing turn falls back to the task\'s definition session', async () => {
  const { store, cowork, deps } = await openWorld();
  const created = store.createTask({ ...SPEC, definitionSessionId: 'def-sess' }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(store.activateTask(created.value.id, 'owner').ok);
  const taskId = created.value.id;
  cowork.registerSession('def-sess', 7);
  const now = Date.now();
  await new LongTermAdvanceService(deps).run(now); // pending → opens + binds the work session
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'pick A or B' }, 'twin').ok);
  assert.ok(store.addNote(taskId, subtask.id, 'worked past the wait', 'twin').ok);
  cowork.counts.set(boundId, DEFAULT_SESSION_ROTATION_MESSAGES);

  const report = await new LongTermAdvanceService(deps).run(now + 3 * HOUR);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'def-sess', 'fell back to the definition session');
  assert.equal(report.escalated[0].reusedSession, true);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'def-sess');
});

test('per-sweep convergence: every waiting-owner decision line follows the owner\'s venue across sub-projects', async () => {
  // The 2026-11-02 fork shape: sub-project #2's ticket lived in a day-old
  // rotation session while #6 ran in the owner's chat — two live lines for
  // one task. The sweep converges ALL waiting_owner bindings onto the
  // owner's venue (so the decision surface points at the conversation the
  // owner reads) without firing any turn.
  const { store, cowork, runner, deps } = await openWorld();
  const created = store.createTask(
    { title: 'Fork shape', goal: 'Two live lines, one task.', subtasks: [{ title: 'Runs in the owner chat' }, { title: 'Ticket parked in a work session' }] },
    'owner',
  );
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(store.activateTask(created.value.id, 'owner').ok);
  const taskId = created.value.id;
  const detail = store.getTask(taskId);
  const [first, second] = detail.subtasks;
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  assert.ok(store.beginSubtask(second.id, 'twin').ok);
  assert.ok(store.waitSubtask(second.id, { kind: 'owner', note: 'ticket parked from a work session' }, 'twin').ok);
  cowork.registerSession('work-sess', 7, 'longterm');
  assert.ok(store.bindSession(second.id, 'work-sess', 'system').ok);
  cowork.registerSession('owner-chat', 7);
  assert.ok(store.bindSession(first.id, 'owner-chat', 'system').ok); // makes the owner's chat a related session
  // The owner is live in their chat, and #1 just began (no quiet push due).
  const t2 = Date.now();
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: t2 - 5 * 60_000, lastAssistantMessageAtMs: null });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.equal(runner.starts.length, 0, 'convergence is silent — no turn fired');
  assert.equal(store.getTask(taskId).subtasks.find((s) => s.id === second.id).sessionId, 'owner-chat');
  const events = store.getTask(taskId).events;
  assert.ok(events.some((event) => event.kind === 'note' && event.actor === 'system' && /session bound: owner-chat/.test(event.detail)));
  // Idempotent: a second sweep binds nothing new.
  const noteCount = events.filter((event) => /session bound/.test(event.detail)).length;
  await new LongTermAdvanceService(deps).run(t2 + 60_000);
  const after = store.getTask(taskId).events.filter((event) => /session bound/.test(event.detail)).length;
  assert.equal(after, noteCount, 'no repeated convergence notes');
});

test('a cold work turn in a heartbeat-owned session parks owner decisions instead of asking in-session', async () => {
  // Rule 4: the owner is not in a bot work session — a question asked there
  // becomes a second conversation line the owner must discover. Decisions
  // discovered mid-work are journaled (longterm_subtask_wait) and delivered
  // to the owner's conversation by the next owner-facing turn.
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  await new LongTermAdvanceService(deps).run(Date.now()); // pending → cold work turn in a fresh longterm session
  const prompt = runner.starts[0].prompt;
  assert.match(prompt, /Record the decision request with longterm_subtask_wait/);
  assert.doesNotMatch(prompt, /exactly ONE question, multiple choice/);
});

test('a cold work turn in the owner\'s own conversation still asks directly', async () => {
  const { store, cowork, runner, deps } = await openWorld();
  const taskId = await createActive(store);
  const now = Date.now();
  // First run binds #1 to a heartbeat session, then the owner drives the
  // task from their own chat (engaged rebind), goes away, and a work push
  // is due — cold, but in the owner's conversation.
  await new LongTermAdvanceService(deps).run(now);
  const heartbeatSessionId = store.getTask(taskId).subtasks[0].sessionId;
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  cowork.registerSession('owner-chat', 7);
  assert.ok(store.bindSession(subtask.id, 'owner-chat', 'system').ok);
  assert.ok(store.bindSession(subtask.id, heartbeatSessionId, 'system').ok);
  const tEngaged = now + 1 * HOUR;
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: tEngaged - 5 * 60_000, lastAssistantMessageAtMs: null });
  await new LongTermAdvanceService(deps).run(tEngaged);
  const boundId = store.getTask(taskId).subtasks[0].sessionId;
  assert.equal(boundId, 'owner-chat', 'binding followed the owner');
  cowork.counts.set('owner-chat', 12);
  const report = await new LongTermAdvanceService(deps).run(tEngaged + 90 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'owner-chat');
  const prompt = runner.starts[runner.starts.length - 1].prompt;
  assert.match(prompt, /exactly ONE question, multiple choice/);
  assert.doesNotMatch(prompt, /Record the decision request with longterm_subtask_wait/);
});

test('getSessionEngagement: heartbeat prompts and cross-session bot relays are not the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-engage-'));
  const sqliteStore = await SqliteStore.create(dir);
  const cowork = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const session = cowork.createSession('t', '/tmp', '', 'local', [], 7, 'longterm');
  assert.deepEqual(cowork.getSessionEngagement(session.id), {
    lastOwnerMessageAtMs: null,
    lastAssistantMessageAtMs: null,
  });

  cowork.addMessage(session.id, { type: 'user', content: 'real owner words', metadata: { submissionId: 's1' } });
  const ownerAt = cowork.getSessionEngagement(session.id).lastOwnerMessageAtMs;
  assert.ok(ownerAt !== null, 'a typed owner message registers');

  // Later infrastructure messages must not move the owner stamp.
  cowork.addMessage(session.id, { type: 'user', content: 'heartbeat prompt', metadata: { origin: 'heartbeat' } });
  cowork.addMessage(session.id, {
    type: 'user',
    content: '来自某 session 的信息：<cross_session_message>',
    metadata: { sourceChannel: 'idbots_cross_session', sourceSessionId: 'z' },
  });
  assert.equal(cowork.getSessionEngagement(session.id).lastOwnerMessageAtMs, ownerAt);

  cowork.addMessage(session.id, { type: 'assistant', content: 'twin reply' });
  const after = cowork.getSessionEngagement(session.id);
  assert.equal(after.lastOwnerMessageAtMs, ownerAt);
  assert.ok(after.lastAssistantMessageAtMs !== null && after.lastAssistantMessageAtMs >= ownerAt);
  assert.equal(cowork.getSessionMetabotId(session.id), 7);
});

// ---------------------------------------------------------------------------
// Unanswered-owner-reply self-heal (2026-11-03 session 68650d7b): the owner's
// reply died with STREAM_CLOSED mid-turn; the plain quiet clock read the dead
// message as engagement and the waiting_owner task sat silent for the full
// 12h re-present window. The runner now records per-session turn-outcome
// markers; a sweep that finds the newest owner message answered by a FAILED
// turn (no completing turn after it) re-drives the conversation after a short
// grace window, exempt from the engagement-window suppression.

function makeUnansweredWorld(cowork, now) {
  return {
    ownerAtMs: now + 60_000,
    failedAtMs: now + 180_000,
    arm() {
      cowork.engagement.set('def-sess', {
        lastOwnerMessageAtMs: this.ownerAtMs,
        lastAssistantMessageAtMs: this.failedAtMs,
      });
      cowork.turnOutcomes.set('def-sess', {
        lastFailedAtMs: this.failedAtMs,
        lastCompletedAtMs: null,
      });
    },
  };
}

test('unanswered owner reply self-heal: a failed answering turn re-drives the conversation past the grace window', async () => {
  const { store, cowork, runner, advance } = await openWorld();
  const created = store.createTask({ ...SPEC, definitionSessionId: 'def-sess' }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  cowork.registerSession('def-sess', 7);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  const now = Date.now();
  const world = makeUnansweredWorld(cowork, now);
  world.arm();

  // 12min past the owner message: the 10min grace has passed, the 12h
  // waiting_owner re-present is far away, and the owner-engagement window is
  // still active (11min < 60min) — the self-heal must fire through BOTH.
  const report = await advance.run(now + 12 * 60_000);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.match(report.escalated[0].reasons[0], /owner reply went unanswered/);
  assert.equal(report.escalated[0].sessionId, 'def-sess', 'delivered to the owner venue (definition session)');
  assert.equal(runner.starts.length, 1);
  assert.equal(runner.starts[0].sessionId, 'def-sess');
});

test('unanswered owner reply self-heal: quiet inside the grace window, and when a later turn completed', async () => {
  const { store, cowork, runner, advance } = await openWorld();
  const created = store.createTask({ ...SPEC, definitionSessionId: 'def-sess' }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  cowork.registerSession('def-sess', 7);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  const now = Date.now();
  const world = makeUnansweredWorld(cowork, now);
  world.arm();

  // 8min past the owner message: inside the 10min grace — quiet.
  const early = await advance.run(now + 8 * 60_000);
  assert.equal(early.escalated.length, 0, JSON.stringify(early));
  assert.ok(early.skipped.some((s) => /nothing due|owner is actively engaged/.test(s.reason)), JSON.stringify(early));

  // A completing turn AFTER the owner message clears the condition even
  // though a failure marker exists (a later turn already answered).
  cowork.turnOutcomes.set('def-sess', { lastFailedAtMs: world.failedAtMs, lastCompletedAtMs: now + 5 * 60_000 });
  const healed = await advance.run(now + 20 * 60_000);
  assert.equal(healed.escalated.length, 0, JSON.stringify(healed));

  // And with no markers at all (plain old store), nothing fires either.
  cowork.turnOutcomes.delete('def-sess');
  const plain = await advance.run(now + 30 * 60_000);
  assert.equal(plain.escalated.length, 0, JSON.stringify(plain));
  assert.equal(runner.starts.length, 0);
});

test('unanswered owner reply self-heal: never stacks onto a turn that is already running', async () => {
  const { store, cowork, runner, advance } = await openWorld();
  const created = store.createTask({ ...SPEC, definitionSessionId: 'def-sess' }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  const taskId = created.value.id;
  assert.ok(store.activateTask(taskId, 'owner').ok);
  cowork.registerSession('def-sess', 7);
  const subtask = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(subtask.id, 'twin').ok);
  assert.ok(store.waitSubtask(subtask.id, { kind: 'owner', note: 'need a channel decision' }, 'twin').ok);

  const now = Date.now();
  const world = makeUnansweredWorld(cowork, now);
  world.arm();
  runner.active.add('def-sess');

  const report = await advance.run(now + 12 * 60_000);
  assert.equal(report.escalated.length, 0, JSON.stringify(report));
  assert.ok(report.skipped.some((s) => /a turn is already running/.test(s.reason)), JSON.stringify(report));
  assert.equal(runner.starts.length, 0);
});

test('CoworkStore turn-outcome markers: record/roundtrip (the self-heal signal store)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-lt-turnout-'));
  const sqliteStore = await SqliteStore.create(dir);
  const cowork = new CoworkStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const session = cowork.createSession('t', '/tmp', '', 'local', [], 7, 'longterm');
  assert.deepEqual(cowork.getSessionTurnOutcome(session.id), { lastFailedAtMs: null, lastCompletedAtMs: null });

  cowork.recordSessionTurnCompletion(session.id, 1000);
  cowork.recordSessionTurnFailure(session.id, 2000);
  assert.deepEqual(cowork.getSessionTurnOutcome(session.id), { lastFailedAtMs: 2000, lastCompletedAtMs: 1000 });

  // Markers are independent timestamps: a later completing turn does not
  // erase the failure (the pairing decides), it only moves its own stamp.
  cowork.recordSessionTurnCompletion(session.id, 3000);
  assert.deepEqual(cowork.getSessionTurnOutcome(session.id), { lastFailedAtMs: 2000, lastCompletedAtMs: 3000 });
});

// ── begin-venue rule: a sub-project with no work session starts in the task's conversation ──

async function createActiveIn(store, definitionSessionId) {
  const created = store.createTask({ ...SPEC, definitionSessionId }, 'owner');
  assert.ok(created.ok, JSON.stringify(created));
  assert.ok(store.activateTask(created.value.id, 'owner').ok);
  return created.value.id;
}

test('2026-11-08 incident: an unbound sub-project starts in the definition conversation, not a fresh session', async () => {
  // Production incident: the task was born in the owner's chat; the owner kept
  // talking about it there, yet every sub-project start (pending → ready, or
  // "just began, no session") forked a new [长期] session — four in one
  // afternoon, all folded away from the conversation the owner was reading.
  // The owner last spoke three hours ago: outside the live-engagement window,
  // so neither the live rebind nor hot delivery applies — only the begin-venue
  // rule seats the turn.
  const { store, cowork, runner, deps } = await openWorld();
  cowork.registerSession('owner-chat', 7);
  const taskId = await createActiveIn(store, 'owner-chat');
  const now = Date.now();
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: now - 3 * HOUR, lastAssistantMessageAtMs: now - 3 * HOUR });

  const report = await new LongTermAdvanceService(deps).run(now);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'owner-chat');
  assert.equal(report.escalated[0].reusedSession, true);
  assert.equal(cowork.calls.create.length, 0, 'no fresh session was opened');
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'owner-chat', 'the sub-project is bound to the conversation');
  assert.equal(runner.starts[0].sessionId, 'owner-chat');
  assert.doesNotMatch(runner.starts[0].prompt, /SESSION ROTATION/);
  assert.ok(
    store.getTask(taskId).events.some((event) => event.kind === 'note' && event.actor === 'system' && /continues in the task's conversation/.test(event.detail)),
    'the venue choice is journalled',
  );

  // The next sub-project starts there too: the conversation stays one line.
  const first = store.getTask(taskId).subtasks[0];
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  assert.ok(store.proposeSubtask(first.id, { evidence: [{ kind: 'dir', uri: '/tmp/deliverable' }], summary: 'criteria met' }, 'twin').ok);
  assert.ok(store.acceptSubtask(first.id, 'owner').ok);
  const next = await new LongTermAdvanceService(deps).run(now + 2 * HOUR);
  assert.equal(next.escalated.length, 1, JSON.stringify(next));
  assert.equal(next.escalated[0].sessionId, 'owner-chat');
  assert.equal(cowork.calls.create.length, 0, 'still no fresh session');
});

test('begin venue follows the owner\'s newest word across related sessions', async () => {
  // "Wherever the owner last replied about this task, the task continues
  // there": a related conversation holding a newer owner message than the
  // definition session wins.
  const { store, cowork, deps } = await openWorld();
  cowork.registerSession('birth-chat', 7);
  cowork.registerSession('later-chat', 7);
  const taskId = await createActiveIn(store, 'birth-chat');
  const second = store.getTask(taskId).subtasks[1];
  assert.ok(store.bindSession(second.id, 'later-chat', 'system').ok); // make it related
  const now = Date.now();
  cowork.engagement.set('birth-chat', { lastOwnerMessageAtMs: now - 5 * HOUR, lastAssistantMessageAtMs: null });
  cowork.engagement.set('later-chat', { lastOwnerMessageAtMs: now - 2 * HOUR, lastAssistantMessageAtMs: null });

  const report = await new LongTermAdvanceService(deps).run(now);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'later-chat');
  assert.equal(cowork.calls.create.length, 0);
});

test('a sub-project whose bound session was deleted resumes in the task\'s conversation, not a fresh session', async () => {
  const { store, cowork, deps } = await openWorld();
  cowork.registerSession('owner-chat', 7);
  const taskId = await createActiveIn(store, 'owner-chat');
  const first = store.getTask(taskId).subtasks[0];
  assert.ok(store.bindSession(first.id, 'deleted-session', 'system').ok); // never registered → getSession null

  const report = await new LongTermAdvanceService(deps).run(Date.now());
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].sessionId, 'owner-chat');
  assert.equal(cowork.calls.create.length, 0);
  assert.equal(store.getTask(taskId).subtasks[0].sessionId, 'owner-chat');
});

test('the begin-venue rule does not hijack rotation: an over-budget heartbeat session still rotates', async () => {
  // Boundary: rotation is context hygiene for sessions the heartbeat created
  // itself and keeps its own reviewed behavior (fresh session + pointer). Only
  // the first-session fork is replaced.
  const { store, cowork, runner, deps } = await openWorld();
  cowork.registerSession('owner-chat', 7);
  cowork.registerSession('hb-work', 7, 'longterm');
  const taskId = await createActiveIn(store, 'owner-chat');
  const first = store.getTask(taskId).subtasks[0];
  assert.ok(store.bindSession(first.id, 'hb-work', 'system').ok);
  assert.ok(store.beginSubtask(first.id, 'twin').ok);
  cowork.counts.set('hb-work', DEFAULT_SESSION_ROTATION_MESSAGES);
  const t2 = Date.now() + 3 * HOUR;
  cowork.engagement.set('owner-chat', { lastOwnerMessageAtMs: t2 - 2 * HOUR, lastAssistantMessageAtMs: null });

  const report = await new LongTermAdvanceService(deps).run(t2);
  assert.equal(report.escalated.length, 1, JSON.stringify(report));
  assert.equal(report.escalated[0].reusedSession, false, 'rotation opened a fresh session');
  assert.notEqual(report.escalated[0].sessionId, 'owner-chat');
  assert.notEqual(report.escalated[0].sessionId, 'hb-work');
  assert.equal(cowork.calls.create.length, 1);
  assert.match(runner.starts[0].prompt, /SESSION ROTATION/);
});
