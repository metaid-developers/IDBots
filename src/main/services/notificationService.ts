import type { NotificationStore } from '../notificationStore';
import type { ProcessNeedsHumanReason } from './processNeedsHuman';
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
    dailyReady: 'Daily report ready',
    dailyFailed: 'Daily report failed',
    surfCompleted: 'Surf completed',
    surfFailed: 'Surf failed',
    dailyBody: 'Open your Twin daily briefing.',
    dailyFailedBody: 'Open Automation to review the report failure.',
    surfBody: (name: string) => `Open the Surf report for “${name}”.`,
    longTermWaiting: 'Decision needed',
    longTermFailed: 'Task needs attention',
    longTermBody: (title: string) => `Open “${title}” to review the work.`,
    decisionEnqueued: 'Decision needed',
    decisionBody: (title: string) => `“${title}” is queued and ready for your ruling.`,
    attemptCompleted: 'Delivery completed',
    attemptFailed: 'Delivery failed',
    attemptCompletedBody: (worker: string) => `${worker} delivered; review when ready.`,
    attemptFailedBody: (worker: string, detail: string) =>
      detail ? `${worker} failed: ${detail}` : `${worker} failed.`,
    // N1: 推进完毕 · 需要人类下一步动作 — the ONLY completion-class notification
    // that survives the N8 gate.
    needsHuman: 'Needs your next step',
    needsHumanBody: (title: string) => `“${title}” finished its push and left a digest for you.`,
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
    dailyReady: '每日汇报已生成',
    dailyFailed: '每日汇报失败',
    surfCompleted: '冲浪已完成',
    surfFailed: '冲浪失败',
    dailyBody: '打开 Twin 的每日汇报查看。',
    dailyFailedBody: '打开自动化页面查看汇报失败原因。',
    surfBody: (name: string) => `打开“${name}”的冲浪报告。`,
    longTermWaiting: '需要你处理',
    longTermFailed: '任务需要关注',
    longTermBody: (title: string) => `打开“${title}”查看结果。`,
    decisionEnqueued: '需要你拍板',
    decisionBody: (title: string) => `“${title}”已进入决策队列，等待你拍板。`,
    attemptCompleted: '交付已完成',
    attemptFailed: '交付失败',
    attemptCompletedBody: (worker: string) => `${worker} 已完成交付，可以验收了。`,
    attemptFailedBody: (worker: string, detail: string) =>
      detail ? `${worker} 交付失败：${detail}` : `${worker} 交付失败。`,
    needsHuman: '需要你的下一步',
    needsHumanBody: (title: string) => `“${title}”已推进完毕，给你留了一份摘要件。`,
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

/**
 * Pure copy builders for the completion-state push (zh/en in one place, so the
 * notification-center row and the desktop popup always say the same thing).
 * main.ts calls these right after the matching record* method returns true,
 * without re-deriving the copy.
 */
export function buildLongTermTaskCopy(
  outcome: 'waiting_owner' | 'completed' | 'failed',
  title: string,
  lang?: string,
): { title: string; body: string } {
  const copy = COPY[language(lang)];
  const waiting = outcome === 'waiting_owner';
  const completed = outcome === 'completed';
  return {
    title: waiting ? copy.longTermWaiting : completed ? copy.workCompleted : copy.longTermFailed,
    body: copy.longTermBody(text(title, 200)),
  };
}

export function buildDecisionEnqueuedCopy(
  title: string,
  lang?: string,
): { title: string; body: string } {
  const copy = COPY[language(lang)];
  return { title: copy.decisionEnqueued, body: copy.decisionBody(text(title, 200)) };
}

export function buildOrchestrationAttemptCopy(
  input: { workerName: string; outcome: 'completed' | 'failed'; detail?: string | null },
  lang?: string,
): { title: string; body: string } {
  const copy = COPY[language(lang)];
  const worker = text(input.workerName || 'Worker', 60);
  return input.outcome === 'completed'
    ? { title: copy.attemptCompleted, body: copy.attemptCompletedBody(worker) }
    : { title: copy.attemptFailed, body: copy.attemptFailedBody(worker, text(input.detail ?? '', 140)) };
}

/** Dedup key for attempt-terminal owner pushes — mirrors UNIQUE(attempt_id, outcome). */
export function buildOrchestrationAttemptEventId(taskId: string, attemptId: string, outcome: 'completed' | 'failed'): string {
  return `orchestration:${taskId}:${attemptId}:${outcome}`;
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

  /**
   * N1 — `process.needs_human`: the one completion-state notification that
   * survives the N8 gate (owner definition 2026-11-24 00:47). Written ONLY when
   * the authoring bot declared a human next step, or an OBJECTIVE wait state
   * exists (M7=A fallback). A normal completion must never reach this method.
   *
   * `target` prefers the digest (artifact) because 态3's click has to land on
   * the file; without a digest the row still jumps to the session.
   */
  recordProcessNeedsHuman(input: {
    sessionId: string;
    taskId?: string | null;
    /** Dedup key: the same session + reason + marker writes one row. */
    marker: string | number;
    reason: ProcessNeedsHumanReason;
    title: string;
    body?: string | null;
    artifactUri?: string | null;
    metabotId?: number | null;
    language?: string;
  }): boolean {
    const copy = COPY[language(input.language)];
    const artifactUri = String(input.artifactUri ?? '').trim();
    const body = String(input.body ?? '').trim() || copy.needsHumanBody(text(input.title, 160));
    return this.record({
      eventId: `process_needs_human:${input.sessionId}:${input.reason}:${input.marker}`,
      type: 'process.needs_human',
      category: 'action',
      metabotId: input.metabotId ?? null,
      sessionId: input.sessionId,
      taskId: input.taskId ?? null,
      runId: null,
      title: copy.needsHuman,
      body: text(body, 360),
      priority: 'high',
      target: artifactUri
        ? {
            kind: 'artifact',
            artifactUri,
            sessionId: input.sessionId,
            ...(input.taskId ? { taskId: input.taskId } : {}),
          }
        : input.sessionId
          ? { kind: 'session', sessionId: input.sessionId }
          : { kind: 'task', taskId: input.taskId ?? '' },
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

  recordDailyReport(input: { runId: string; metabotId: number; sessionId: string | null; outcome: 'completed' | 'failed'; language?: string }): boolean {
    const copy = COPY[language(input.language)];
    const completed = input.outcome === 'completed';
    return this.record({
      eventId: `daily_report:${input.runId}`,
      type: completed ? 'daily_report.completed' : 'daily_report.failed',
      category: 'report',
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      taskId: null,
      runId: input.runId,
      title: completed ? copy.dailyReady : copy.dailyFailed,
      body: completed ? copy.dailyBody : copy.dailyFailedBody,
      priority: completed ? 'normal' : 'high',
      target: completed && input.sessionId
        ? { kind: 'session', sessionId: input.sessionId }
        : { kind: 'bot_automation', metabotId: input.metabotId, section: 'daily_report', runId: input.runId },
    });
  }

  recordSurfRun(input: { runId: string; metabotId: number; botName: string; outcome: 'done' | 'failed'; language?: string }): boolean {
    const copy = COPY[language(input.language)];
    const completed = input.outcome === 'done';
    return this.record({
      eventId: `surf:${input.runId}`,
      type: completed ? 'surf.completed' : 'surf.failed',
      category: 'report',
      metabotId: input.metabotId,
      sessionId: null,
      taskId: null,
      runId: input.runId,
      title: completed ? copy.surfCompleted : copy.surfFailed,
      body: copy.surfBody(text(input.botName, 160)),
      priority: completed ? 'normal' : 'high',
      target: { kind: 'bot_automation', metabotId: input.metabotId, section: 'surf', runId: input.runId },
    });
  }

  recordLongTermTask(input: {
    taskId: string;
    subtaskId: string;
    reason: string;
    title: string;
    metabotId: number | null;
    sessionId: string | null;
    outcome: 'waiting_owner' | 'completed' | 'failed';
    language?: string;
  }): boolean {
    const copy = buildLongTermTaskCopy(input.outcome, input.title, language(input.language));
    const waiting = input.outcome === 'waiting_owner';
    const completed = input.outcome === 'completed';
    return this.record({
      eventId: `longterm:${input.taskId}:${input.subtaskId}:${input.reason}`,
      type: waiting ? 'longterm.waiting_owner' : completed ? 'longterm.completed' : 'longterm.failed',
      category: waiting ? 'action' : 'work',
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.subtaskId,
      title: copy.title,
      body: copy.body,
      priority: completed ? 'normal' : 'high',
      target: { kind: 'task', taskId: input.taskId },
    });
  }

  /**
   * A decision card entered the Studio queue (enqueue emits 'enqueued' only
   * for a genuinely NEW row — dedupeKey updates reuse the row and emit
   * 'updated', which never reaches this method). Callers that push a desktop
   * notification from this row must skip longterm-linked cards: those are
   * already covered by recordLongTermTask on the waiting_owner transition, and
   * a second push for the same fact would be exactly the double popup this
   * fix refuses to introduce.
   */
  recordDecisionEnqueued(input: {
    itemId: string;
    taskTitle: string;
    kind: string;
    twinMetabotId: number;
    originStudioSessionId?: string | null;
    longtermTaskId?: string | null;
    longtermSubtaskId?: string | null;
    metabotId?: number | null;
    language?: string;
  }): boolean {
    const copy = buildDecisionEnqueuedCopy(input.taskTitle, language(input.language));
    return this.record({
      eventId: `decision:${input.itemId}`,
      type: 'decision.enqueued',
      category: 'action',
      metabotId: input.metabotId ?? input.twinMetabotId,
      sessionId: input.originStudioSessionId ?? null,
      taskId: input.longtermTaskId ?? null,
      runId: input.longtermSubtaskId ?? null,
      title: copy.title,
      body: copy.body,
      priority: 'high',
      target: input.longtermTaskId
        ? { kind: 'task', taskId: input.longtermTaskId }
        : { kind: 'session', sessionId: input.originStudioSessionId ?? '' },
    });
  }

  /**
   * A worker attempt reached a terminal state. Call this ONLY after
   * orchestrationStore.claimNotification returned true for
   * (attemptId, outcome) — the claim row is the durable at-most-once arbiter
   * and this notification's eventId mirrors its uniqueness, so a duplicate
   * transition can neither re-insert the row nor re-push the desktop notice.
   */
  recordOrchestrationAttempt(input: {
    taskId: string;
    attemptId: string;
    outcome: 'completed' | 'failed';
    workerName: string;
    detail?: string | null;
    metabotId?: number | null;
    sessionId?: string | null;
    language?: string;
  }): boolean {
    const copy = buildOrchestrationAttemptCopy(input, language(input.language));
    return this.record({
      eventId: buildOrchestrationAttemptEventId(input.taskId, input.attemptId, input.outcome),
      type: input.outcome === 'completed' ? 'orchestration.attempt.completed' : 'orchestration.attempt.failed',
      category: 'work',
      metabotId: input.metabotId ?? null,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId,
      runId: input.attemptId,
      title: copy.title,
      body: copy.body,
      priority: input.outcome === 'completed' ? 'normal' : 'high',
      target: input.sessionId
        ? { kind: 'session', sessionId: input.sessionId }
        : { kind: 'task', taskId: input.taskId },
    });
  }

  recordProactiveFollowUp(input: {
    followUpId: string;
    tier: 'inform' | 'light_decision' | 'task_proposal';
    informOutcome?: 'handled' | 'declined' | 'observed' | null;
    title: string;
    body: string;
    metabotId: number | null;
    sessionId: string;
    language?: string;
  }): boolean {
    const isZh = language(input.language) === 'zh';
    const needsDecision = input.tier !== 'inform';
    const header = needsDecision
      ? (isZh ? '分身有事找你确认' : 'Your Twin needs a quick call')
      : input.informOutcome === 'declined'
        ? (isZh ? '分身已代为回绝一项请求' : 'Your Twin declined a request')
        : (isZh ? '分身同步了一项进展' : 'Update from your Twin');
    return this.record({
      eventId: `followup:${input.followUpId}`,
      type: `followup.${input.tier}`,
      category: needsDecision ? 'action' : 'work',
      metabotId: input.metabotId,
      sessionId: input.sessionId,
      taskId: null,
      runId: null,
      title: text(input.title || header, 180),
      body: text(input.body || header, 360),
      priority: needsDecision ? 'high' : 'normal',
      target: { kind: 'session', sessionId: input.sessionId },
    });
  }

  resolvePermission(requestId: string): number {
    const changed = this.store.markRead([`permission:${requestId}`]);
    if (changed > 0) this.onChanged({ eventId: `permission:${requestId}` });
    return changed;
  }
}
