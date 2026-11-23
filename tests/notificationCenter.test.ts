// 批 B · P0-4 — 通知消费水龙头 (Friday 稿 Fork 5 A).
//
// Before this slice the notification pipeline had writers and five IPC reads
// and ZERO renderer consumers. This suite pins the faucet:
//   1. the pure model — three-class grouping (完成 / 失败 / 待拍板) and the
//      jump mapping onto the app's existing events;
//   2. the component — it reads `notification:list` / `getUnreadCount` /
//      `onChanged` and the LIVE decision queue, and it marks a row read
//      before jumping;
//   3. the mount — the rail's system zone hosts the bell, so both faces
//      share one entry;
//   4. i18n parity for every new key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  classifyNotification,
  groupNotifications,
  resolveNotificationJump,
  sortNotificationsForPanel,
} from '../src/renderer/utils/notificationCenter';
import type { AgentNotification } from '../src/renderer/types/notification';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => fs.readFileSync(path.join(here, '..', rel), 'utf8');

const note = (over: Partial<AgentNotification>): AgentNotification => ({
  eventId: 'e1',
  type: 'work.completed',
  category: 'work',
  createdAt: 1,
  metabotId: 1,
  sessionId: 's1',
  taskId: null,
  runId: null,
  title: '任务已完成',
  body: '打开查看结果。',
  priority: 'normal',
  target: { kind: 'session', sessionId: 's1' },
  readAt: null,
  ...over,
});

// ── 1. three-class grouping ───────────────────────────────────────────────

test('classify: completed / failed / decision / other', () => {
  assert.equal(classifyNotification('work.completed'), 'completed');
  assert.equal(classifyNotification('scheduled.completed'), 'completed');
  assert.equal(classifyNotification('work.failed'), 'failed');
  assert.equal(classifyNotification('scheduled.failed'), 'failed');
  assert.equal(classifyNotification('permission.required'), 'decision');
  assert.equal(classifyNotification('report.ready'), 'other');
  assert.equal(classifyNotification(''), 'other');
});

test('group: the three sections fill independently and other rows are dropped', () => {
  const groups = groupNotifications([
    note({ eventId: 'a', type: 'work.completed' }),
    note({ eventId: 'b', type: 'work.failed' }),
    note({ eventId: 'c', type: 'permission.required', category: 'action' }),
    note({ eventId: 'd', type: 'report.ready', category: 'report' }),
    note({ eventId: 'e', type: 'scheduled.completed' }),
  ]);
  assert.deepEqual(groups.completed.map((item) => item.eventId), ['a', 'e']);
  assert.deepEqual(groups.failed.map((item) => item.eventId), ['b']);
  assert.deepEqual(groups.decisions.map((item) => item.eventId), ['c']);
});

test('group: per-group cap keeps the panel bounded', () => {
  const rows = Array.from({ length: 12 }, (_, index) => note({ eventId: `e${index}`, type: 'work.completed' }));
  const groups = groupNotifications(rows, 3);
  assert.equal(groups.completed.length, 3);
});

test('sort: unread first, then newest', () => {
  const sorted = sortNotificationsForPanel([
    note({ eventId: 'read-new', createdAt: 90, readAt: 5 }),
    note({ eventId: 'unread-old', createdAt: 10, readAt: null }),
    note({ eventId: 'unread-new', createdAt: 50, readAt: null }),
  ]);
  assert.deepEqual(sorted.map((item) => item.eventId), ['unread-new', 'unread-old', 'read-new']);
});

// ── 2. jump mapping ───────────────────────────────────────────────────────

test('jump: every target kind maps onto an existing app event', () => {
  assert.deepEqual(resolveNotificationJump({ kind: 'session', sessionId: ' s1 ' }), { kind: 'session', sessionId: 's1' });
  assert.deepEqual(
    resolveNotificationJump({ kind: 'scheduled_run', taskId: 't1', runId: 'r1', sessionId: 's2' }),
    { kind: 'scheduled', sessionId: 's2' },
  );
  assert.deepEqual(resolveNotificationJump({ kind: 'task', taskId: 'ltt_1' }), { kind: 'task', taskId: 'ltt_1' });
});

test('jump: a target without its id maps to null instead of guessing', () => {
  assert.equal(resolveNotificationJump(null), null);
  assert.equal(resolveNotificationJump({ kind: 'session', sessionId: '  ' }), null);
  assert.equal(resolveNotificationJump({ kind: 'scheduled_run', taskId: 't1', runId: 'r1', sessionId: null }), null);
  assert.equal(resolveNotificationJump({ kind: 'task', taskId: '' }), null);
});

// ── 3. the component consumes the pipeline ────────────────────────────────

test('component reads the existing notification IPC and the live decision queue', () => {
  const source = read('src/renderer/components/notifications/NotificationCenter.tsx');
  assert.match(source, /api\.list\(\{ limit: MAX_ITEMS \}\)/);
  assert.match(source, /api\.getUnreadCount\?\.\(\)/);
  assert.match(source, /notification\?\.onChanged\?\.\(/);
  assert.match(source, /lt\.studioStatus\(\{\}\)/);
  assert.match(source, /openDecisions/);
  // mark-read precedes the jump (a read row must not stay bold).
  assert.match(source, /markRead\(\[item\.eventId\]\)/);
});

test('component renders exactly three groups with the agreed data keys', () => {
  const source = read('src/renderer/components/notifications/NotificationCenter.tsx');
  for (const group of ['decision', 'completed', 'failed']) {
    assert.match(source, new RegExp(`data-group="${group}"`), `missing group ${group}`);
  }
  assert.match(source, /data-testid="notification-decision-row"/);
  // Since the 通知中心/进程中心 alignment (2026-11-24 00:38) the BUTTON is not
  // drawn here any more: the panel hands its trigger slot to the rail, which
  // renders the shared RailButton. A locally drawn bell would be a second copy
  // of the rail's entry — the exact drift this test now forbids.
  assert.doesNotMatch(source, /data-slot="rail-item"/);
  assert.doesNotMatch(source, /<button[\s\S]{0,120}data-testid="notification-bell"/);
  assert.match(source, /renderTrigger\(\{ open, unreadCount, decisionCount, label, toggle \}\)/);
});

test('component jumps decisions to the Live Stage first, Process Hub as fallback', () => {
  const source = read('src/renderer/components/notifications/NotificationCenter.tsx');
  assert.match(source, /sessionTabBinding\.revealSessionTab\(sessionId\)/);
  assert.match(source, /onOpenProcesses\(\)/);
  assert.match(source, /cowork:viewSession/);
});

test('mount: the rail system zone hosts the bell on both faces', () => {
  const rail = read('src/renderer/components/layout/WorkspaceRail.tsx');
  assert.match(rail, /import NotificationCenter from '\.\.\/notifications\/NotificationCenter';/);
  assert.match(rail, /<NotificationCenter/);
  assert.match(rail, /onOpenProcesses=\{\(\) => \{/);
  assert.match(rail, /onSelectInternetPane\('processes' as BotInternetPane\)/);
  assert.match(rail, /handleHomeItem\('processes'\)/);
  // The bell's identity attributes ride the rail's entry, because that is where
  // the button is rendered now (same DOM contract as before the alignment).
  assert.match(rail, /testId="notification-bell"/);
  assert.match(rail, /'data-unread-count': unreadCount/);
  assert.match(rail, /'data-decision-count': decisionCount/);
  assert.match(rail, /badgeTestId="notification-bell-badge"/);
});

test('i18n: every notification-center key exists in BOTH languages', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  const keys = [
    'notificationsTitle',
    'notificationsBellLabel',
    'notificationsEmpty',
    'notificationsGroupCompleted',
    'notificationsGroupFailed',
    'notificationsGroupDecision',
    'notificationsGroupDecisionEmpty',
    'notificationsGroupEmpty',
    'notificationsMarkAllRead',
    'notificationsUnreadBadge',
    'notificationsOpenDecision',
  ];
  for (const key of keys) {
    const hits = i18n.match(new RegExp(`^\\s+${key}:`, 'gm')) ?? [];
    assert.equal(hits.length, 2, `${key} must be defined once per language`);
  }
});
