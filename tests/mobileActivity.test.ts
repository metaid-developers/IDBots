import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkActivity, resolveLongTermResultSession, resolveTwinMetabotId } from '../src/mobile/app/activity.ts';
import { mergeActivitySnapshot, reduceLongTermUpdate } from '../src/mobile/app/hooks/useWorkActivity.ts';
import { createLongTermFixture, longTermBoard } from '../src/mobile/bridge/backgroundFixtures.ts';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import type { MockMetabot, ScheduledTaskRun } from '../src/mobile/bridge/types.ts';

function run(id: string, startedAt: string): ScheduledTaskRun {
  return {
    id,
    taskId: 'task-1',
    sessionId: `session-${id}`,
    status: 'success',
    startedAt,
    finishedAt: startedAt,
    durationMs: 100,
    error: null,
    trigger: 'scheduled',
    skipReason: null,
  };
}

test('activity consumes board projections and sorts all work by recency', async (t) => {
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const bots = (await bridge.electron.metabot.list()).list as MockMetabot[];
  const tasks = (await bridge.electron.scheduledTasks.list()).tasks;
  tasks[0].id = 'task-1';
  tasks[0].name = 'Digest';
  const detail = createLongTermFixture('longterm-session');
  detail.updatedAt = '2026-10-27T03:00:00.000Z';
  const activities = buildWorkActivity({
    tasks,
    runs: [run('run-1', '2026-10-27T01:00:00.000Z'), run('run-2', '2026-10-27T02:00:00.000Z')],
    board: longTermBoard(detail),
    bots,
  });

  assert.deepEqual(activities.map((activity) => activity.id), ['longterm:lt-document', 'scheduled:run-2', 'scheduled:run-1']);
  assert.equal(activities[0].waitingReason, 'Owner review required');
  assert.equal(activities[0].currentSubtaskTitle, 'Produce a document');
  assert.deepEqual(activities[0].progress, { accepted: 1, total: 3, percent: 33 });
  assert.deepEqual(activities[0].participants, ['Twin Bot']);
  assert.equal(activities[1].title, 'Digest');
  assert.deepEqual(activities[1].participants, ['Twin Bot']);

  const unbound = buildWorkActivity({
    tasks: [{ ...tasks[0], id: 'deleted-task', metabotId: null }],
    runs: [{ ...run('legacy-run', '2026-10-27T04:00:00.000Z'), taskName: 'Legacy job' }],
    board: null,
    bots,
  });
  assert.equal(unbound[0].title, 'Legacy job');
  assert.deepEqual(unbound[0].participants, []);
});

test('long-term result resolution uses current, latest historical, then definition session', () => {
  const detail = createLongTermFixture('current-session');
  detail.definitionSessionId = 'definition-session';
  assert.equal(resolveLongTermResultSession(detail), 'current-session');
  const current = detail.subtasks.find((subtask) => subtask.id === detail.currentSubtaskId)!;
  current.sessionId = null;
  current.sessionHistory = ['older-session', 'latest-session'];
  assert.equal(resolveLongTermResultSession(detail), 'latest-session');
  current.sessionHistory = [];
  assert.equal(resolveLongTermResultSession(detail), 'definition-session');
  detail.currentSubtaskId = 'missing-subtask';
  assert.equal(resolveLongTermResultSession(detail), 'definition-session');
  detail.definitionSessionId = null;
  assert.equal(resolveLongTermResultSession(detail), null);
});

test('Twin selection never falls back to an arbitrary worker', async (t) => {
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const bots = (await bridge.electron.metabot.list()).list as MockMetabot[];
  const reordered = [bots.find((bot) => bot.metabot_type === 'worker')!, bots.find((bot) => bot.metabot_type === 'twin')!];
  assert.equal(resolveTwinMetabotId(reordered), 1);
  assert.equal(resolveTwinMetabotId(reordered.filter((bot) => bot.metabot_type !== 'twin')), null);
});

test('failed refresh fields preserve the last good activity snapshot', () => {
  const bots = [{ id: 1, name: 'Twin Bot', metabot_type: 'twin' } as MockMetabot];
  const board = longTermBoard(createLongTermFixture('session'));
  const previous = { tasks: [], runs: [run('run-1', '2026-10-27T01:00:00.000Z')], bots, board };
  const merged = mergeActivitySnapshot(previous, {
    tasks: undefined,
    runs: [run('run-2', '2026-10-27T02:00:00.000Z')],
    bots: undefined,
    board: null,
  });
  assert.equal(merged.tasks, previous.tasks);
  assert.equal(merged.bots, previous.bots);
  assert.deepEqual(merged.runs.map((entry) => entry.id), ['run-2']);
  assert.equal(merged.board, null);
});

test('long-term event sequence drops duplicates and advances across heartbeats', () => {
  assert.deepEqual(reduceLongTermUpdate(0, { seq: 1, reason: 'stage_pause' }), { seq: 1, reload: true });
  assert.deepEqual(reduceLongTermUpdate(1, { seq: 1, reason: 'stage_pause' }), { seq: 1, reload: false });
  assert.deepEqual(reduceLongTermUpdate(1, { seq: 0, reason: 'updated' }), { seq: 1, reload: false });
  assert.deepEqual(reduceLongTermUpdate(1, { seq: 2, reason: 'heartbeat' }), { seq: 2, reload: false });
  assert.deepEqual(reduceLongTermUpdate(2, { seq: 3, reason: 'updated' }), { seq: 3, reload: true });
});

test('tiered run receipts map onto the activity tri-state like the desktop contract', async (t) => {
  // 840d45ff6 shipped the mapping with zero test coverage; the desktop's
  // receipt tiers (completed / completed_empty / crashed / timeout) and the
  // legacy labels must land in the phone's coarse success/error/pass-through
  // buckets exactly (2026-11-19 review P2).
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const bots = (await bridge.electron.metabot.list()).list as MockMetabot[];
  const tasks = (await bridge.electron.scheduledTasks.list()).tasks;
  tasks[0].id = 'task-1';
  const statuses = [
    ['completed', 'success'],
    ['completed_empty', 'success'],
    ['crashed', 'error'],
    ['timeout', 'error'],
    ['success', 'success'],
    ['error', 'error'],
    ['running', 'running'],
    ['skipped', 'skipped'],
  ] as const;
  const runs = statuses.map(([status], index) => ({
    ...run(`run-${index}`, `2026-10-27T0${index}:00:00.000Z`),
    status,
  }));
  const activities = buildWorkActivity({ tasks, runs, board: null, bots });
  const byRunId = new Map(activities.map((activity) => [activity.runId, activity.status]));
  for (const [status, expected] of statuses) {
    const index = statuses.findIndex(([candidate]) => candidate === status);
    assert.equal(byRunId.get(`run-${index}`), expected, `status ${status} must read as ${expected}`);
  }
});
