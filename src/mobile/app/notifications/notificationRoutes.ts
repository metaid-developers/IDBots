import type { AgentNotificationTarget } from '@/types/notification';

export type MobileAppRoute =
  | { kind: 'root' }
  | { kind: 'notifications' }
  | { kind: 'notification'; eventId: string }
  | { kind: 'session'; sessionId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'scheduled_run'; taskId: string; runId: string }
  | { kind: 'bot_automation'; metabotId: number; section: 'surf' | 'daily_report'; runId?: string };

function segment(value: string): string {
  return encodeURIComponent(value);
}

function decoded(value: string): string | null {
  try {
    const result = decodeURIComponent(value);
    return result && !result.includes('/') && !result.includes('\u0000') ? result : null;
  } catch {
    return null;
  }
}

export function notificationCenterPath(eventId?: string): string {
  return eventId ? `/app/notifications/${segment(eventId)}` : '/app/notifications';
}

export function notificationTargetPath(target: AgentNotificationTarget): string {
  if (target.kind === 'session') return `/app/sessions/${segment(target.sessionId)}`;
  if (target.kind === 'artifact') {
    // The digest opens in the desktop showcase tab; mobile lands on the
    // conversation that produced it (same fallback as the click route).
    return target.sessionId ? `/app/sessions/${segment(target.sessionId)}` : '/app/notifications';
  }
  if (target.kind === 'task') return `/app/tasks/${segment(target.taskId)}`;
  if (target.kind === 'bot_automation') {
    const params = new URLSearchParams({ section: target.section });
    if (target.runId) params.set('runId', target.runId);
    return `/app/bots/${segment(String(target.metabotId))}/automation?${params.toString()}`;
  }
  return `/app/scheduled/${segment(target.taskId)}/runs/${segment(target.runId)}`;
}

export function parseMobileAppRoute(pathname: string, search = ''): MobileAppRoute {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (parts.length === 1 && parts[0] === 'app') return { kind: 'root' };
  if (parts[0] !== 'app') return { kind: 'root' };
  if (parts.length === 2 && parts[1] === 'notifications') return { kind: 'notifications' };
  if (parts.length === 3 && parts[1] === 'notifications') {
    const eventId = decoded(parts[2]!);
    return eventId ? { kind: 'notification', eventId } : { kind: 'notifications' };
  }
  if (parts.length === 3 && parts[1] === 'sessions') {
    const sessionId = decoded(parts[2]!);
    return sessionId ? { kind: 'session', sessionId } : { kind: 'root' };
  }
  if (parts.length === 3 && parts[1] === 'tasks') {
    const taskId = decoded(parts[2]!);
    return taskId ? { kind: 'task', taskId } : { kind: 'root' };
  }
  if (parts.length === 4 && parts[1] === 'bots' && parts[3] === 'automation') {
    const metabotId = Number(parts[2]);
    if (Number.isInteger(metabotId) && metabotId > 0) {
      const params = new URLSearchParams(search);
      const rawRunId = params.get('runId');
      const runId = rawRunId ? decoded(rawRunId) : null;
      return {
        kind: 'bot_automation',
        metabotId,
        section: params.get('section') === 'daily_report' ? 'daily_report' : 'surf',
        ...(runId ? { runId } : {}),
      };
    }
  }
  if (parts.length === 5 && parts[1] === 'scheduled' && parts[3] === 'runs') {
    const taskId = decoded(parts[2]!);
    const runId = decoded(parts[4]!);
    return taskId && runId ? { kind: 'scheduled_run', taskId, runId } : { kind: 'root' };
  }
  return { kind: 'root' };
}

export function sanitizeMobileReturnPath(value: unknown): string {
  if (typeof value !== 'string') return '/app/';
  if (!value.startsWith('/app/') || value.startsWith('//') || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) return '/app/';
  return value;
}
