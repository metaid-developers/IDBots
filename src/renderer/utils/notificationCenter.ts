import type { AgentNotification, AgentNotificationTarget } from '../types/notification';

/**
 * 通知中心 pure model (批 B · P0-4).
 *
 * The renderer consumed ZERO of the notification pipeline before this slice:
 * `notification_events` had writers (cowork terminal, scheduled-run terminal,
 * permission-required) and five IPC reads, but no view. These helpers keep the
 * three-class grouping and the jump mapping out of the component so both are
 * pinned by unit tests instead of by eyeballing a panel.
 *
 * Class mapping (honest to what the host actually writes in THIS tree):
 *   - `*.completed`  → 完成
 *   - `*.failed`     → 失败
 *   - `permission.required` → 待拍板 (the one decision-class write that exists;
 *     the live open decision queue is merged in by the component from
 *     `longtermTask:studioStatus`, because a decision-type notification write
 *     is P2-2 — upstream PR #179, not this tree).
 */

export type NotificationClass = 'completed' | 'failed' | 'decision' | 'other';

export function classifyNotification(type: string): NotificationClass {
  const value = typeof type === 'string' ? type.trim().toLowerCase() : '';
  if (!value) return 'other';
  if (value.endsWith('.completed')) return 'completed';
  if (value.endsWith('.failed')) return 'failed';
  if (value === 'permission.required') return 'decision';
  return 'other';
}

export type NotificationGroups = {
  completed: AgentNotification[];
  failed: AgentNotification[];
  decisions: AgentNotification[];
};

/**
 * Group a notification page into the panel's three sections. `other` rows
 * (report/system categories this tree does not write yet) are intentionally
 * dropped rather than dumped into a catch-all bucket — the panel claims three
 * classes, so it shows three.
 */
export function groupNotifications(items: readonly AgentNotification[], perGroup = 8): NotificationGroups {
  const groups: NotificationGroups = { completed: [], failed: [], decisions: [] };
  for (const item of items) {
    const kind = classifyNotification(item?.type ?? '');
    if (kind === 'completed' && groups.completed.length < perGroup) groups.completed.push(item);
    else if (kind === 'failed' && groups.failed.length < perGroup) groups.failed.push(item);
    else if (kind === 'decision' && groups.decisions.length < perGroup) groups.decisions.push(item);
  }
  return groups;
}

export type NotificationJump =
  | { kind: 'session'; sessionId: string }
  | { kind: 'scheduled'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | null;

/**
 * Map a notification's `target` onto the app's EXISTING jump events:
 *   session        → `cowork:viewSession`
 *   scheduled_run  → `scheduledTask:viewSession` (the run's session)
 *   task           → `longtermTask:viewTask`
 * A target without its required id maps to null — the panel then does
 * nothing rather than guessing a destination.
 */
export function resolveNotificationJump(target: AgentNotificationTarget | null | undefined): NotificationJump {
  if (!target || typeof target !== 'object') return null;
  if (target.kind === 'session') {
    const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
    return sessionId ? { kind: 'session', sessionId } : null;
  }
  if (target.kind === 'scheduled_run') {
    const sessionId = typeof target.sessionId === 'string' ? target.sessionId.trim() : '';
    return sessionId ? { kind: 'scheduled', sessionId } : null;
  }
  if (target.kind === 'task') {
    const taskId = typeof target.taskId === 'string' ? target.taskId.trim() : '';
    return taskId ? { kind: 'task', taskId } : null;
  }
  return null;
}

/** Unread rows first, then newest — the order the panel renders. */
export function sortNotificationsForPanel(items: readonly AgentNotification[]): AgentNotification[] {
  return [...items].sort((a, b) => {
    const aUnread = a.readAt == null ? 1 : 0;
    const bUnread = b.readAt == null ? 1 : 0;
    if (aUnread !== bUnread) return bUnread - aUnread;
    return (b.createdAt ?? 0) - (a.createdAt ?? 0);
  });
}
