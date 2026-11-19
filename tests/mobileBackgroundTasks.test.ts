import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import { buildScheduledTaskCreateInput } from '../src/mobile/app/hooks/useScheduledTasks.ts';
import type { ScheduledTaskInput } from '../src/mobile/bridge/types.ts';

function makeBridge() {
  return createMobileMockBridge({
    scheduledRunDelayMs: 60_000,
    manualRunDelayMs: 60,
    streamTokenIntervalMs: 1,
  });
}

function taskInput(): ScheduledTaskInput {
  return {
    name: 'Twin background job',
    description: 'Keep this description',
    prompt: 'Produce a report',
    schedule: { type: 'interval', intervalMs: 3_600_000, unit: 'hours', value: 1 },
    workingDirectory: '/srv/twin-workspace',
    systemPrompt: 'Keep this context',
    executionMode: 'sandbox',
    metabotId: 1,
    targetSessionId: 'existing-result',
    memoryAccess: 'read-write',
    expiresAt: null,
    notifyPlatforms: [],
    enabled: true,
  };
}

test('mobile task creation binds the Twin and tenant workspace, never an arbitrary bot', () => {
  const draft = {
    name: 'Owner task',
    prompt: 'Do the work',
    schedule: { type: 'interval' as const, intervalMs: 60_000, unit: 'minutes' as const, value: 1 },
  };
  const input = buildScheduledTaskCreateInput(draft, 7, '/tenant/workspace');
  assert.equal(input?.metabotId, 7);
  assert.equal(input?.workingDirectory, '/tenant/workspace');
  assert.equal(input?.targetSessionId, undefined);
  assert.equal(buildScheduledTaskCreateInput(draft, null, '/tenant/workspace'), null);
  assert.equal(buildScheduledTaskCreateInput(draft, 7, '')?.workingDirectory, '');
});

test('partial scheduled updates preserve bindings, workspace and memory access', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const created = await api.scheduledTasks.create(taskInput());
  assert.equal(created.success, true);
  const id = created.task.id;

  const updated = await api.scheduledTasks.update(id, {
    name: 'Edited background job',
    prompt: 'Produce an edited report',
    schedule: { type: 'cron', expression: '15 8 * * *' },
  });
  assert.equal(updated.success, true);
  assert.equal(updated.task.name, 'Edited background job');
  assert.deepEqual(updated.task.schedule, { type: 'cron', expression: '15 8 * * *' });
  assert.equal(updated.task.metabotId, 1);
  assert.equal(updated.task.targetSessionId, 'existing-result');
  assert.equal(updated.task.workingDirectory, '/srv/twin-workspace');
  assert.equal(updated.task.systemPrompt, 'Keep this context');
  assert.equal(updated.task.memoryAccess, 'read-write');
  assert.equal(updated.task.executionMode, 'sandbox');
  assert.equal(updated.task.description, 'Keep this description');

  const rebound = await api.scheduledTasks.update(id, { metabotId: 2 });
  assert.equal(rebound.task.metabotId, 2);
  assert.equal(rebound.task.targetSessionId, null);
  assert.equal(rebound.task.coworkSessionId, null);
});

test('stop reports an active run once and a late completion cannot overwrite it', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const started = await api.scheduledTasks.runManually('mock-task-2');
  assert.equal(started.success, true);
  assert.equal(started.run.status, 'running');

  const stopped = await api.scheduledTasks.stop('mock-task-2');
  assert.deepEqual(stopped, { success: true, result: true });
  const duplicate = await api.scheduledTasks.stop('mock-task-2');
  assert.deepEqual(duplicate, { success: true, result: false });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const history = await api.scheduledTasks.listRuns('mock-task-2');
  const run = history.runs.find((candidate) => candidate.id === started.run.id);
  assert.equal(run.status, 'error');
  assert.equal(run.error, 'Stopped by user');
  assert.ok(run.durationMs >= 0);
  assert.equal(history.runs.filter((candidate) => candidate.id === started.run.id).length, 1);
  const task = await api.scheduledTasks.get('mock-task-2');
  assert.equal(task.task.state.runningAtMs, null);
  assert.equal(task.task.state.lastStatus, 'error');
  const session = await api.cowork.getSession(started.run.sessionId);
  assert.equal(session.session.status, 'idle');
});

test('delete removes the task and its runs without deleting the result session', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const started = await api.scheduledTasks.runManually('mock-task-2');
  const removed = await api.scheduledTasks.delete('mock-task-2');
  assert.deepEqual(removed, { success: true, result: true });

  const listed = await api.scheduledTasks.list();
  assert.equal(listed.tasks.some((task) => task.id === 'mock-task-2'), false);
  assert.deepEqual((await api.scheduledTasks.listRuns('mock-task-2')).runs, []);
  assert.equal((await api.scheduledTasks.get('mock-task-2')).success, false);
  assert.equal((await api.cowork.getSession(started.run.sessionId)).success, true);
  assert.deepEqual(await api.scheduledTasks.delete('missing-task'), { success: true, result: false });
});

test('long-term owner actions use result envelopes and emit monotonic updates', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const updates: Array<{ seq: number; reason: string }> = [];
  const off = api.longtermTask.onUpdate((update) => updates.push(update));
  t.after(off);

  const initial = await api.longtermTask.board();
  assert.equal(initial.success, true);
  assert.equal(initial.board.cards[0].id, 'lt-document');
  assert.equal(initial.board.cards[0].progress.percent, 33);
  assert.equal(initial.board.cards[0].currentWaitNote, 'Owner review required');
  assert.deepEqual(initial.board.cards[0].participants.map((participant) => participant.name), ['Twin Bot']);

  const paused = await api.longtermTask.setStage({ taskId: 'lt-document', action: 'pause' });
  assert.equal(paused.ok, true);
  assert.equal(paused.value.stage, 'paused');
  assert.equal((await api.longtermTask.board()).board.cards[0].column, 'paused');
  const resumed = await api.longtermTask.setStage({ taskId: 'lt-document', action: 'resume' });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.value.stage, 'active');
  assert.equal(resumed.value.currentWaitNote, 'Owner review required');
  const cancelled = await api.longtermTask.setStage({ taskId: 'lt-document', action: 'cancel' });
  assert.deepEqual(cancelled, { ok: true, value: null });
  assert.equal((await api.longtermTask.board()).board.cards.some((card) => card.id === 'lt-document'), false);
  const cancelledDetail = (await api.longtermTask.get({ taskId: 'lt-document' })).detail;
  assert.equal(cancelledDetail.stage, 'cancelled');
  assert.equal(cancelledDetail.column, 'done');
  assert.equal(cancelledDetail.currentSubtaskStatus, 'waiting_owner');
  assert.equal(cancelledDetail.progress.percent, 33);
  assert.deepEqual(updates.map((update) => update.seq), [1, 2, 3]);
  assert.deepEqual(updates.map((update) => update.reason), ['stage_pause', 'stage_resume', 'stage_cancel']);
});

test('long-term results use an explicitly typed session with real artifact content', async (t) => {
  const bridge = makeBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const detail = (await api.longtermTask.get({ taskId: 'lt-document' })).detail;
  const sessionId = detail.subtasks.find((subtask) => subtask.id === detail.currentSubtaskId).sessionId;
  const session = await api.cowork.getSession(sessionId);
  assert.equal(session.success, true);
  assert.equal(session.session.sessionType, 'longterm');
  assert.equal(session.session.autoOrigin, null);
  assert.equal(session.session.status, 'completed');
  assert.ok(session.session.messages.some((message) => message.type === 'assistant' && message.content.includes('Mock artifacts ready.')));
});
