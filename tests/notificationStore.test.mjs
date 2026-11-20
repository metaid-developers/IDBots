import test from 'node:test';
import assert from 'node:assert/strict';

const { createNativeSqliteDatabase } = await import('../dist-electron/main/nativeSqliteDatabase.js');
const { NotificationStore } = await import('../dist-electron/main/notificationStore.js');
const { NotificationService, buildCoworkNotificationEventId } = await import('../dist-electron/main/services/notificationService.js');

function setup(t) {
  const db = createNativeSqliteDatabase(':memory:');
  assert.ok(db, 'native sqlite available in test runtime');
  const store = new NotificationStore(db, () => {});
  t.after(() => db.close());
  return { db, store };
}

function input(eventId, overrides = {}) {
  return {
    eventId,
    type: 'work.completed',
    category: 'work',
    createdAt: 1000,
    metabotId: 7,
    sessionId: 'session-1',
    taskId: null,
    runId: null,
    title: 'Task completed',
    body: 'Open the result.',
    priority: 'normal',
    target: { kind: 'session', sessionId: 'session-1' },
    ...overrides,
  };
}

function scheduledRun(overrides = {}) {
  return {
    id: 'run-1',
    taskId: 'task-1',
    sessionId: 'session-run',
    status: 'completed',
    startedAt: '2026-11-20T01:00:00.000Z',
    finishedAt: '2026-11-20T01:01:00.000Z',
    durationMs: 60000,
    error: null,
    trigger: 'scheduled',
    skipReason: null,
    ...overrides,
  };
}

test('schema creation is idempotent and records one event plus one outbox row', (t) => {
  const { db, store } = setup(t);
  new NotificationStore(db, () => {});
  assert.equal(store.record(input('event-1')), true);
  assert.equal(store.record(input('event-1')), false);
  assert.equal(store.get('event-1').target.kind, 'session');
  assert.deepEqual(store.listPendingOutbox(), [{ eventId: 'event-1', attemptCount: 0, nextAttemptAt: 1000 }]);
});

test('list supports category, unread filters, stable pagination, and read state', (t) => {
  const { store } = setup(t);
  store.record(input('event-1'));
  store.record(input('event-2', { createdAt: 2000 }));
  store.record(input('event-3', { createdAt: 3000, category: 'action', type: 'permission.required' }));

  const first = store.list({ limit: 2 });
  assert.deepEqual(first.items.map((item) => item.eventId), ['event-3', 'event-2']);
  assert.deepEqual(first.nextCursor, { createdAt: 2000, eventId: 'event-2' });
  const second = store.list({ before: first.nextCursor });
  assert.deepEqual(second.items.map((item) => item.eventId), ['event-1']);
  assert.equal(second.nextCursor, null);
  assert.equal(store.getUnreadCount(), 3);
  assert.equal(store.getUnreadCount('action'), 1);

  assert.equal(store.markRead(['event-3', 'event-3'], 4000), 1);
  assert.equal(store.get('event-3').readAt, 4000);
  assert.equal(store.getUnreadCount(), 2);
  assert.deepEqual(store.list({ unreadOnly: true }).items.map((item) => item.eventId), ['event-2', 'event-1']);
  assert.equal(store.markAllRead('work', 5000), 2);
  assert.equal(store.getUnreadCount(), 0);
});

test('outbox claims survive retry delays and process restart recovery', (t) => {
  const { store } = setup(t);
  store.record(input('event-1'));
  assert.deepEqual(store.claimPendingOutbox(999), []);
  assert.deepEqual(store.claimPendingOutbox(1000).map((item) => ({ eventId: item.eventId, attemptCount: item.attemptCount })), [{ eventId: 'event-1', attemptCount: 0 }]);
  assert.deepEqual(store.claimPendingOutbox(1001), []);
  store.retryOutbox('event-1', 'network unavailable', 16000);
  assert.deepEqual(store.claimPendingOutbox(15999), []);
  assert.deepEqual(store.claimPendingOutbox(16000).map((item) => item.attemptCount), [1]);
  store.markOutboxDelivered('event-1');
  assert.deepEqual(store.listPendingOutbox(), []);
});

test('an abandoned claim is recovered and read events are never claimed', (t) => {
  const { store } = setup(t);
  store.record(input('event-1'));
  store.record(input('event-2', { createdAt: 2000 }));
  assert.equal(store.claimPendingOutbox(2000).length, 2);
  store.markRead(['event-1'], 3000);
  assert.deepEqual(store.claimPendingOutbox(32_001).map((item) => item.eventId), ['event-2']);
  assert.deepEqual(store.claimPendingOutbox(33_001), []);
});

test('cowork terminal mapping is stable, localized, and deduped by turn marker', (t) => {
  const { store } = setup(t);
  const changed = [];
  const service = new NotificationService(store, (event) => changed.push(event.eventId));
  const input = {
    sessionId: 'session-1', terminalMarker: 123456, outcome: 'completed', title: 'Research report', metabotId: 7, language: 'en',
  };
  assert.equal(buildCoworkNotificationEventId('session-1', 'completed', 123456), 'cowork:session-1:completed:123456');
  assert.equal(service.recordCoworkTerminal(input), true);
  assert.equal(service.recordCoworkTerminal(input), false);
  assert.equal(store.get('cowork:session-1:completed:123456').type, 'work.completed');
  assert.deepEqual(changed, ['cowork:session-1:completed:123456']);
});

test('scheduled terminal mapping ignores running/skipped and preserves run target', (t) => {
  const { store } = setup(t);
  const service = new NotificationService(store, () => {});
  const task = { id: 'task-1', name: 'Daily brief', metabotId: 7 };
  assert.equal(service.recordScheduledRun({ task, run: scheduledRun({ status: 'running' }) }), false);
  assert.equal(service.recordScheduledRun({ task, run: scheduledRun({ status: 'skipped' }) }), false);
  assert.equal(service.recordScheduledRun({ task, run: scheduledRun() }), true);
  assert.deepEqual(store.get('scheduled:run-1').target, {
    kind: 'scheduled_run', taskId: 'task-1', runId: 'run-1', sessionId: 'session-run',
  });
  assert.equal(service.recordScheduledRun({ task, run: scheduledRun({ id: 'run-2', status: 'timeout' }) }), true);
  assert.equal(store.get('scheduled:run-2').priority, 'high');
});

test('permission request resolution marks the unread event read and emits one change', (t) => {
  const { store } = setup(t);
  const changed = [];
  const service = new NotificationService(store, (event) => changed.push(event.eventId));
  assert.equal(service.recordPermissionRequired({ sessionId: 'session-1', requestId: 'request-1', metabotId: 7, language: 'zh' }), true);
  assert.equal(store.getUnreadCount('action'), 1);
  assert.equal(store.get('permission:request-1').title, '需要你处理');
  assert.equal(service.resolvePermission('request-1'), 1);
  assert.equal(service.resolvePermission('request-1'), 0);
  assert.equal(store.get('permission:request-1').readAt !== null, true);
  assert.deepEqual(changed, ['permission:request-1', 'permission:request-1']);
});
