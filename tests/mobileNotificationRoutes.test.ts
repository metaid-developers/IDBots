import test from 'node:test';
import assert from 'node:assert/strict';
import {
  notificationCenterPath,
  notificationTargetPath,
  parseMobileAppRoute,
  sanitizeMobileReturnPath,
} from '../src/mobile/app/notifications/notificationRoutes';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge';

test('notification routes round-trip session, task, scheduled run, and notification center targets', () => {
  assert.equal(notificationCenterPath('cowork:session-1:completed:123'), '/app/notifications/cowork%3Asession-1%3Acompleted%3A123');
  assert.deepEqual(parseMobileAppRoute('/app/notifications/cowork%3Asession-1%3Acompleted%3A123'), {
    kind: 'notification', eventId: 'cowork:session-1:completed:123',
  });
  assert.deepEqual(parseMobileAppRoute('/app/sessions/session-1'), { kind: 'session', sessionId: 'session-1' });
  assert.deepEqual(parseMobileAppRoute('/app/tasks/task-1'), { kind: 'task', taskId: 'task-1' });
  assert.deepEqual(parseMobileAppRoute('/app/scheduled/task-1/runs/run-1'), {
    kind: 'scheduled_run', taskId: 'task-1', runId: 'run-1',
  });
  assert.equal(notificationTargetPath({ kind: 'scheduled_run', taskId: 'task-1', runId: 'run-1', sessionId: null }), '/app/scheduled/task-1/runs/run-1');
  assert.deepEqual(parseMobileAppRoute('/app/notifications'), { kind: 'notifications' });
  assert.deepEqual(parseMobileAppRoute('/app/'), { kind: 'root' });
});

test('automation notification routes preserve the Bot, section, and run', () => {
  const target = { kind: 'bot_automation', metabotId: 7, section: 'surf', runId: 'surf-run-1' } as const;
  assert.equal(notificationTargetPath(target), '/app/bots/7/automation?section=surf&runId=surf-run-1');
  assert.deepEqual(parseMobileAppRoute('/app/bots/7/automation', 'section=surf&runId=surf-run-1'), target);
  assert.deepEqual(parseMobileAppRoute('/app/bots/7/automation', 'section=daily_report'), {
    kind: 'bot_automation', metabotId: 7, section: 'daily_report',
  });
});

test('login return paths stay local to the mobile app', () => {
  assert.equal(sanitizeMobileReturnPath('/app/notifications/event-1?from=push'), '/app/notifications/event-1?from=push');
  assert.equal(sanitizeMobileReturnPath('https://evil.example/'), '/app/');
  assert.equal(sanitizeMobileReturnPath('//evil.example/'), '/app/');
  assert.equal(sanitizeMobileReturnPath('/app/\\evil'), '/app/');
  assert.equal(sanitizeMobileReturnPath(undefined), '/app/');
});

test('mock notification APIs list, filter, and reconcile read state', async (t) => {
  const bridge = createMobileMockBridge();
  t.after(() => bridge.destroy());
  const api = bridge.electron.notification;

  const unread = await api.list({ unreadOnly: true });
  assert.equal(unread.success, true);
  assert.deepEqual(unread.items?.map((item) => item.eventId), ['mock-work-complete']);
  assert.equal((await api.getUnreadCount()).count, 1);

  const target = await api.get('mock-work-complete');
  assert.equal(target.success, true);
  assert.deepEqual(target.item?.target, { kind: 'session', sessionId: 'mock-session-1' });

  assert.deepEqual((await api.markRead(['mock-work-complete'])).count, 1);
  assert.equal((await api.getUnreadCount()).count, 0);
  assert.equal((await api.get('mock-work-complete')).item?.readAt !== null, true);

  const all = await api.list({ category: 'action' });
  assert.deepEqual(all.items?.map((item) => item.eventId), ['mock-permission-resolved']);
  assert.equal((await api.markAllRead()).count, 0);
});
