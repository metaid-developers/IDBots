import type { NotificationStore } from '../notificationStore';
import type { ScheduledTask, ScheduledTaskRun } from '../scheduledTaskStore';
import type {
  AgentNotificationInput,
  AgentNotificationCategory,
  AgentNotificationChangedEvent,
  AgentNotificationListOptions,
} from '../../renderer/types/notification';

type Language = 'zh' | 'en';

const COPY = {
  en: {
    workCompleted: 'Task completed',
    workFailed: 'Task failed',
    scheduledCompleted: 'Scheduled task completed',
    scheduledFailed: 'Scheduled task failed',
    permission: 'Approval needed',
    permissionBody: 'Your Bot needs your input before it can continue.',
    openResult: (title: string) => `Open “${title}” to review the result.`,
    scheduledBody: (title: string) => `Open the run for “${title}”.`,
  },
  zh: {
    workCompleted: '任务已完成',
    workFailed: '任务失败',
    scheduledCompleted: '定时任务已完成',
    scheduledFailed: '定时任务失败',
    permission: '需要你处理',
    permissionBody: 'Bot 需要你的确认后才能继续。',
    openResult: (title: string) => `打开“${title}”查看结果。`,
    scheduledBody: (title: string) => `查看“${title}”的运行记录。`,
  },
} as const;

function language(value: string | undefined): Language {
  return value === 'zh' ? 'zh' : 'en';
}

function text(value: string, maxLength: number): string {
  const normalized = value.trim().replace(/\s+/g, ' ');
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

export function buildCoworkNotificationEventId(sessionId: string, outcome: 'completed' | 'failed', terminalMarker: string | number): string {
  return `cowork:${sessionId}:${outcome}:${terminalMarker}`;
}

export class NotificationService {
  constructor(
    private store: NotificationStore,
    private onChanged: (event: AgentNotificationChangedEvent) => void,
  ) {}

  record(input: AgentNotificationInput): boolean {
    const eventId = text(input.eventId, 200);
    const inserted = this.store.record({
      ...input,
      eventId,
      type: text(input.type, 80),
      title: text(input.title, 200),
      body: text(input.body, 500),
    });
    if (inserted) this.onChanged({ eventId });
    return inserted;
  }

  getStore(): NotificationStore {
    return this.store;
  }

  list(options: AgentNotificationListOptions) {
    return this.store.list(options);
  }

  get(eventId: string) {
    return this.store.get(eventId);
  }

  getUnreadCount(category?: AgentNotificationCategory) {
    return this.store.getUnreadCount(category);
  }

  markRead(eventIds: string[]): number {
    const changed = this.store.markRead(eventIds);
    if (changed > 0) {
      for (const eventId of new Set(eventIds)) this.onChanged({ eventId });
    }
    return changed;
  }

  markAllRead(category?: AgentNotificationCategory): number {
    const unread = this.store.list({ category, unreadOnly: true, limit: 100 }).items;
    const changed = this.store.markAllRead(category);
    if (changed > 0) {
      for (const item of unread) this.onChanged({ eventId: item.eventId });
    }
    return changed;
  }

  recordCoworkTerminal(input: {
    sessionId: string;
    terminalMarker: string | number;
    outcome: 'completed' | 'failed';
    title: string;
    metabotId: number | null;
    language?: string;
  }): boolean {
    const copy = COPY[language(input.language)];
    return this.record({
      eventId: buildCoworkNotificationEventId(input.sessionId, input.outcome, input.terminalMarker),
      type: `work.${input.outcome}`,
      category: 'work',
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      taskId: null,
      runId: null,
      title: input.outcome === 'completed' ? copy.workCompleted : copy.workFailed,
      body: copy.openResult(text(input.title, 160)),
      priority: input.outcome === 'completed' ? 'normal' : 'high',
      target: { kind: 'session', sessionId: input.sessionId },
    });
  }

  recordScheduledRun(input: { task: ScheduledTask; run: ScheduledTaskRun; language?: string }): boolean {
    const succeeded = input.run.status === 'completed' || input.run.status === 'completed_empty' || input.run.status === 'success';
    const failed = input.run.status === 'crashed' || input.run.status === 'timeout' || input.run.status === 'error';
    if (!succeeded && !failed) return false;
    const copy = COPY[language(input.language)];
    return this.record({
      eventId: `scheduled:${input.run.id}`,
      type: succeeded ? 'scheduled.completed' : 'scheduled.failed',
      category: 'work',
      metabotId: input.task.metabotId,
      sessionId: input.run.sessionId,
      taskId: input.task.id,
      runId: input.run.id,
      title: succeeded ? copy.scheduledCompleted : copy.scheduledFailed,
      body: copy.scheduledBody(text(input.task.name, 160)),
      priority: succeeded ? 'normal' : 'high',
      target: { kind: 'scheduled_run', taskId: input.task.id, runId: input.run.id, sessionId: input.run.sessionId },
    });
  }

  recordPermissionRequired(input: { sessionId: string; requestId: string; metabotId: number | null; language?: string }): boolean {
    if (!input.requestId.trim()) return false;
    const copy = COPY[language(input.language)];
    return this.record({
      eventId: `permission:${input.requestId}`,
      type: 'permission.required',
      category: 'action',
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      taskId: null,
      runId: null,
      title: copy.permission,
      body: copy.permissionBody,
      priority: 'high',
      target: { kind: 'session', sessionId: input.sessionId },
    });
  }

  resolvePermission(requestId: string): number {
    const changed = this.store.markRead([`permission:${requestId}`]);
    if (changed > 0) this.onChanged({ eventId: `permission:${requestId}` });
    return changed;
  }
}
