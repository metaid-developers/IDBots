/**
 * Completion-state owner push (2026-11-23 root fix).
 *
 * Root cause covered here: on 2026-11-22 four re-verified-green deliveries sat
 * silently in the Studio decision queue for hours. Every completion state
 * already wrote a notification-center row, but the desktop app had no active
 * push channel (the Electron desktop notification was wired only to owner-asks)
 * and the queue only presented its head when the conversation went idle.
 *
 * Pinned here:
 *   1. The desktop push is foreground-suppressed and click = raise window only
 *      (inform + jump; it never performs the acceptance itself).
 *   2. notifyOwnerCompletion pushes ONLY on a fresh notification-row insert —
 *      a replayed/duplicated event can never pop a second notification
 *      (重复事件不重复推). The row's eventId PRIMARY KEY is the dedup arbiter,
 *      the same role the orchestration_notifications claim row plays for
 *      attempt terminals.
 *   3. waiting_owner / decision-enqueued / attempt-terminal rows land through
 *      NotificationService with zh/en copy, and duplicate eventIds are refused
 *      by the real NotificationStore.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { NotificationStore } = require('../dist-electron/main/notificationStore.js');
const { NotificationService, buildDecisionEnqueuedCopy, buildLongTermTaskCopy, buildOrchestrationAttemptCopy, buildOrchestrationAttemptEventId } = require('../dist-electron/main/services/notificationService.js');
const { createCompletionNotifier, notifyOwnerCompletion } = require('../dist-electron/main/services/completionNotifier.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-completion-notify-'));

function makeNotifierHarness({ foreground = false, supported = true } = {}) {
  const created = [];
  const shown = [];
  let clickHandler = null;
  const showWindowCalls = [];
  const notify = createCompletionNotifier({
    isSupported: () => supported,
    isWindowForeground: () => foreground,
    createNotification: (input) => {
      created.push(input);
      return {
        on: (event, listener) => {
          if (event === 'click') clickHandler = listener;
        },
        show: () => shown.push(input),
      };
    },
    showWindow: () => { showWindowCalls.push(true); },
    log: (message, error) => console.warn(message, error),
  });
  return {
    notify,
    created,
    shown,
    click: () => { if (clickHandler) clickHandler(); },
    showWindowCalls,
  };
}

// ---------------------------------------------------------------------------
// 1. The desktop push itself: foreground-suppressed, click = raise window.
// ---------------------------------------------------------------------------
test('completion push is suppressed while the app window is foreground', () => {
  const h = makeNotifierHarness({ foreground: true });
  h.notify({ title: '交付已完成', body: 'Builder 已完成交付，可以验收了。' });
  assert.equal(h.created.length, 0, 'no popup on top of an app the owner is already looking at');
  assert.equal(h.shown.length, 0);
});

test('completion push in background shows one notification whose click raises the window', () => {
  const h = makeNotifierHarness({ foreground: false });
  h.notify({ title: '交付已完成', body: 'Builder 已完成交付，可以验收了。' });
  assert.equal(h.created.length, 1);
  assert.equal(h.shown.length, 1);
  assert.equal(h.showWindowCalls.length, 0, 'raising the window is click-gated, not automatic');
  h.click();
  assert.equal(h.showWindowCalls.length, 1, 'click = jump to the app, nothing more');
});

test('hosts without a notifier stay silent', () => {
  const h = makeNotifierHarness({ supported: false });
  h.notify({ title: 'x', body: 'y' });
  assert.equal(h.created.length, 0);
  assert.equal(h.shown.length, 0);
});

// ---------------------------------------------------------------------------
// 2. notifyOwnerCompletion: push rides ONLY a fresh insert.
// ---------------------------------------------------------------------------
test('a fresh notification row triggers exactly one desktop push', () => {
  const pushes = [];
  let recordResult = true;
  const inserted = notifyOwnerCompletion(
    {
      record: () => recordResult,
      notifyDesktop: (input) => pushes.push(input),
    },
    { title: '需要你拍板', body: '“Demo”已进入决策队列，等待你拍板。' },
  );
  assert.equal(inserted, true);
  assert.deepEqual(pushes, [{ title: '需要你拍板', body: '“Demo”已进入决策队列，等待你拍板。' }]);
});

test('a duplicated event (record returns false) never pushes again (重复事件不重复推)', () => {
  const pushes = [];
  let recordResult = true;
  const sink = {
    record: () => {
      const first = recordResult;
      recordResult = false; // simulate the eventId PRIMARY KEY refusing a replay
      return first;
    },
    notifyDesktop: (input) => pushes.push(input),
  };
  notifyOwnerCompletion(sink, { title: 't', body: 'b' });
  notifyOwnerCompletion(sink, { title: 't', body: 'b' });
  notifyOwnerCompletion(sink, { title: 't', body: 'b' });
  assert.equal(pushes.length, 1, 'one row, one popup — replays are silent');
});

// ---------------------------------------------------------------------------
// 3. Real NotificationStore: rows land once, duplicates refused, zh/en copy.
// ---------------------------------------------------------------------------
async function makeServiceHarness() {
  const sqliteStore = await SqliteStore.create(makeTempDir());
  const store = new NotificationStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction());
  const changed = [];
  const service = new NotificationService(store, (event) => changed.push(event));
  return { sqliteStore, store, service, changed, close: () => sqliteStore.close() };
}

test('attempt-terminal row: deterministic eventId mirrors UNIQUE(attempt_id, outcome)', async () => {
  const h = await makeServiceHarness();
  try {
    const eventId = buildOrchestrationAttemptEventId('task-1', 'attempt-1', 'completed');
    assert.equal(eventId, 'orchestration:task-1:attempt-1:completed');

    const first = h.service.recordOrchestrationAttempt({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      outcome: 'completed',
      workerName: 'Builder',
      sessionId: 'twin-session',
      language: 'zh',
    });
    assert.equal(first, true, 'waiting_owner/attempt rows must land on the first event');
    const row = h.store.get(eventId);
    assert.ok(row, 'row readable by the mirrored dedup key');
    assert.equal(row.type, 'orchestration.attempt.completed');
    assert.equal(row.category, 'work');
    assert.equal(row.title, '交付已完成');
    assert.equal(row.taskId, 'task-1');
    assert.equal(row.runId, 'attempt-1');

    const second = h.service.recordOrchestrationAttempt({
      taskId: 'task-1',
      attemptId: 'attempt-1',
      outcome: 'completed',
      workerName: 'Builder',
      language: 'zh',
    });
    assert.equal(second, false, 'duplicate attempt terminal is refused by the store');
    assert.equal(h.store.getUnreadCount('work'), 1);
  } finally {
    h.close();
  }
});

test('failed attempt copy embeds worker and detail, zh and en', async () => {
  const zh = buildOrchestrationAttemptCopy({ workerName: '阿码', outcome: 'failed', detail: 'tests red' }, 'zh');
  assert.equal(zh.title, '交付失败');
  assert.match(zh.body, /阿码 交付失败：tests red/);
  const en = buildOrchestrationAttemptCopy({ workerName: 'Builder', outcome: 'completed', detail: null }, 'en');
  assert.equal(en.title, 'Delivery completed');
  assert.match(en.body, /Builder delivered/);
});

test('decision-enqueued row: one per queue item, zh/en both available', async () => {
  const h = await makeServiceHarness();
  try {
    const en = h.service.recordDecisionEnqueued({
      itemId: 'sdq_1',
      taskTitle: 'Cover image pick',
      kind: 'decision',
      twinMetabotId: 2,
      originStudioSessionId: 'studio-1',
      language: 'en',
    });
    assert.equal(en, true);
    const row = h.store.get('decision:sdq_1');
    assert.ok(row);
    assert.equal(row.type, 'decision.enqueued');
    assert.equal(row.category, 'action');
    assert.equal(row.priority, 'high');

    const replay = h.service.recordDecisionEnqueued({
      itemId: 'sdq_1',
      taskTitle: 'Cover image pick',
      kind: 'decision',
      twinMetabotId: 2,
      originStudioSessionId: 'studio-1',
      language: 'en',
    });
    assert.equal(replay, false, 'the same queue item must not notify twice');

    const zhCopy = buildDecisionEnqueuedCopy('封面挑选', 'zh');
    assert.equal(zhCopy.title, '需要你拍板');
    assert.match(zhCopy.body, /封面挑选/);
    const enCopy = buildDecisionEnqueuedCopy('Cover pick', 'en');
    assert.equal(enCopy.title, 'Decision needed');
  } finally {
    h.close();
  }
});

test('long-term waiting_owner row keeps its legacy eventId and copy (zh/en)', async () => {
  const h = await makeServiceHarness();
  try {
    const inserted = h.service.recordLongTermTask({
      taskId: 'ltt-1',
      subtaskId: 'lts-1',
      reason: 'owner decision requested',
      title: '宿主侧根修',
      metabotId: 4,
      sessionId: 'studio-1',
      outcome: 'waiting_owner',
      language: 'zh',
    });
    assert.equal(inserted, true, 'waiting_owner must produce a notification row');
    const row = h.store.get('longterm:ltt-1:lts-1:owner decision requested');
    assert.ok(row);
    assert.equal(row.type, 'longterm.waiting_owner');
    assert.equal(row.title, '需要你处理');

    const again = h.service.recordLongTermTask({
      taskId: 'ltt-1',
      subtaskId: 'lts-1',
      reason: 'owner decision requested',
      title: '宿主侧根修',
      metabotId: 4,
      sessionId: 'studio-1',
      outcome: 'waiting_owner',
      language: 'zh',
    });
    assert.equal(again, false);

    const copy = buildLongTermTaskCopy('waiting_owner', '宿主侧根修', 'en');
    assert.equal(copy.title, 'Decision needed');
  } finally {
    h.close();
  }
});
