import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UnifiedTasksSection } from '../src/mobile/app/components/unifiedTasks/UnifiedTasksSection.tsx';
import { UnifiedTaskCard } from '../src/mobile/app/components/unifiedTasks/UnifiedTaskCard.tsx';
import type { UnifiedTaskScreen } from '../src/mobile/app/hooks/useUnifiedTasks.ts';
import {
  filterUnifiedTaskCards,
  liveTaskCounts,
  resolveSubtaskSession,
  unifiedTaskNextAction,
} from '../src/mobile/app/unifiedTaskPresentation.ts';
import {
  createActiveLongTermFixture,
  createLongTermFixture,
} from '../src/mobile/bridge/backgroundFixtures.ts';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import { mobileI18n } from '../src/mobile/i18n.ts';

function screenFixture(): UnifiedTaskScreen {
  const cards = [createActiveLongTermFixture('active-session'), createLongTermFixture('review-session')];
  return {
    board: null,
    cards,
    detail: null,
    selectedTaskId: null,
    loading: false,
    detailLoading: false,
    pending: false,
    error: null,
    actionError: null,
    reload: async () => true,
    openDetail: () => undefined,
    closeDetail: () => undefined,
    openTaskChat: async () => true,
    updateTask: async () => true,
    setStage: async () => true,
    completeTask: async () => true,
    acceptSubtask: async () => true,
    acceptAll: async () => true,
    rejectSubtask: async () => true,
    skipSubtask: async () => true,
    unblockSubtask: async () => true,
    beginSubtask: async () => true,
    moveSubtask: async () => true,
  } as UnifiedTaskScreen;
}

test('unified task list defaults to active work and keeps the selected B+A presentation', () => {
  mobileI18n.setLanguage('en');
  const html = renderToStaticMarkup(<UnifiedTasksSection screen={screenFixture()} />);
  assert.match(html, /twin-unified-card-featured/);
  assert.ok(html.includes('Launch the mobile task center'));
  assert.ok(html.includes('Current step'));
  assert.ok(!html.includes('Long-term document'));
  assert.ok(!html.includes('Long-Term'));
  assert.ok(!html.includes('Standard'));
});

test('unified task filtering, live counts and next action match the desktop columns', () => {
  mobileI18n.setLanguage('en');
  const active = createActiveLongTermFixture('active-session');
  const waiting = createLongTermFixture('review-session');
  assert.deepEqual(filterUnifiedTaskCards([waiting, active], 'in_progress', '').map((card) => card.id), [active.id]);
  assert.deepEqual(filterUnifiedTaskCards([waiting, active], 'all', 'Native Library').map((card) => card.id), [active.id]);
  assert.deepEqual(liveTaskCounts([active, waiting]), { in_progress: 1, waiting_owner: 1, waiting_external: 0 });
  assert.equal(unifiedTaskNextAction(waiting), 'Waiting for your decision: Owner review required');
  assert.equal(resolveSubtaskSession(waiting, waiting.subtasks[1]), 'review-session');
});

test('unified task card copy switches between Chinese and English', () => {
  const card = createActiveLongTermFixture('active-session');
  mobileI18n.setLanguage('zh');
  const zh = renderToStaticMarkup(
    <UnifiedTaskCard card={card} featured indented={false} busy={false} onOpenDetails={() => undefined} onOpenChat={() => undefined} />,
  );
  assert.ok(zh.includes('当前步骤'));
  assert.ok(zh.includes('打开聊天'));
  mobileI18n.setLanguage('en');
  const en = renderToStaticMarkup(
    <UnifiedTaskCard card={card} featured indented={false} busy={false} onOpenDetails={() => undefined} onOpenChat={() => undefined} />,
  );
  assert.ok(en.includes('Current step'));
  assert.ok(en.includes('Open chat'));
});

test('mock stage, delegation and completion actions update the unified projection', async (t) => {
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const api = bridge.electron;
  const taskId = 'lt-mobile-task-center';
  assert.equal((await api.longtermTask.get({ taskId })).detail.column, 'in_progress');
  await api.longtermTask.setStage({ taskId, action: 'pause' });
  assert.equal((await api.longtermTask.get({ taskId })).detail.column, 'paused');
  await api.longtermTask.setStage({ taskId, action: 'resume' });
  assert.equal((await api.longtermTask.get({ taskId })).detail.column, 'in_progress');
  await api.longtermTask.update({ taskId, acceptanceDelegate: false });
  assert.equal((await api.longtermTask.get({ taskId })).detail.acceptanceDelegate, false);
  await api.longtermTask.complete({ taskId });
  const completed = (await api.longtermTask.get({ taskId })).detail;
  assert.equal(completed.stage, 'done');
  assert.equal(completed.column, 'done');
  assert.equal(completed.progress.percent, 100);
  assert.ok(completed.subtasks.every((subtask) => subtask.status === 'accepted' || subtask.status === 'skipped'));
});

test('mock owner acceptance advances the current subtask and progress', async (t) => {
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const accepted = await bridge.electron.longtermTask.accept({ subtaskId: 'lt-sub-document' });
  assert.equal(accepted.ok, true);
  const detail = (await bridge.electron.longtermTask.get({ taskId: 'lt-document' })).detail;
  assert.equal(detail.subtasks[1].status, 'accepted');
  assert.equal(detail.currentSubtaskId, 'lt-sub-review');
  assert.equal(detail.column, 'in_progress');
  assert.equal(detail.progress.accepted, 2);
  assert.equal(detail.progress.percent, 67);
  assert.equal(detail.events[0].kind, 'accepted');
});

test('mock rejection returns the waiting subtask to active work with feedback', async (t) => {
  const bridge = createMobileMockBridge({ scheduledRunDelayMs: 60_000 });
  t.after(() => bridge.destroy());
  const rejected = await bridge.electron.longtermTask.reject({ subtaskId: 'lt-sub-document', feedback: 'Revise the summary' });
  assert.equal(rejected.ok, true);
  const detail = (await bridge.electron.longtermTask.get({ taskId: 'lt-document' })).detail;
  assert.equal(detail.currentSubtaskStatus, 'in_progress');
  assert.equal(detail.currentWaitNote, 'Revise the summary');
  assert.equal(detail.column, 'in_progress');
  assert.equal(detail.events[0].kind, 'rejected');
});
