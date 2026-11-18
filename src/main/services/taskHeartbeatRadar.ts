import type { TaskActiveRadarEntry } from '../../renderer/types/longTermTask';

export const DEFAULT_WORKER_LIVENESS_THROTTLE_MS = 5_000;

/**
 * Deterministic fingerprint of all active tasks on this machine. Used by the
 * 5-second Chief-of-Staff heartbeat tick to detect background Worker SQLite
 * writes (progress notes, submissions, status transitions) with zero LLM cost.
 */
export function computeActiveTaskWatermark(entries: readonly TaskActiveRadarEntry[]): string {
  if (entries.length === 0) return 'empty';
  return entries
    .map(
      (e) =>
        `${e.id}:${e.stage}:${e.managedState}:${e.progress.accepted}/${e.progress.total}:` +
        `${e.currentSubtaskId ?? ''}:${e.currentSubtaskStatus ?? ''}:` +
        `${e.assigneeMetabotId ?? ''}:${e.progressNote ?? ''}:${e.updatedAt}`,
    )
    .join('|');
}

/**
 * Render the machine-wide `<active_tasks_radar>` volatile prompt block injected
 * into Twin Bot turns across ALL channels (Studio, BotWorks, Mobile, Telegram/IM).
 * Keeps total size compact (<1.5KB) so Twin has instant awareness of every
 * task regardless of which conversation session the owner speaks from.
 */
export function formatActiveTasksRadarPromptBlock(
  entries: readonly TaskActiveRadarEntry[],
  options?: { currentSessionId?: string | null; maxItems?: number },
): string {
  const maxItems = Math.max(1, Math.min(25, Math.trunc(options?.maxItems ?? 16)));
  const shown = entries.slice(0, maxItems);
  if (shown.length === 0) {
    return [
      '<active_tasks_radar count="0">',
      'No open tasks are currently active or awaiting owner decision on this machine.',
      'Sessions are stateless interaction channels: if the owner initiates a deliverable request, create a tracked Task card via `task_create`; for archived history use `task_search`.',
      '</active_tasks_radar>',
    ].join('\n');
  }

  const curSid = String(options?.currentSessionId ?? '').trim();
  const lines = shown.map((entry) => {
    const badge = entry.isLongTerm ? '[长期]' : '[常规]';
    const originTag = curSid && entry.originSessionId === curSid ? ' (this session)' : '';
    const parentPart = entry.parentTaskId
      ? ` · parent="${entry.parentTaskTitle ?? entry.parentTaskId}" (${entry.parentTaskId})`
      : '';
    const subPart =
      entry.currentSubtaskTitle && entry.currentSubtaskTitle !== entry.title
        ? ` · current="${entry.currentSubtaskTitle}" (${entry.currentSubtaskId ?? 'sub'})`
        : entry.currentSubtaskId
          ? ` (${entry.currentSubtaskId})`
          : '';
    const assigneePart = entry.assigneeName
      ? ` · bot=${entry.assigneeName}`
      : entry.assigneeMetabotId != null
        ? ` · bot=#${entry.assigneeMetabotId}`
        : '';
    const detailPart =
      entry.managedState === 'waiting_owner' && entry.waitNote
        ? ` · waiting="${entry.waitNote.replace(/\s+/g, ' ').slice(0, 90)}"`
        : entry.progressNote
          ? ` · live="${entry.progressNote.replace(/\s+/g, ' ').slice(0, 90)}"`
          : '';
    return `- ${badge} [${entry.managedState}] "${entry.title}" (taskId=${entry.id}, ${entry.progress.accepted}/${entry.progress.total})${originTag}${parentPart}${subPart}${assigneePart}${detailPart}`;
  });

  const omitted = entries.length - shown.length;
  return [
    `<active_tasks_radar count="${entries.length}">`,
    'Machine-wide active tasks shared across ALL sessions and channels (Sessions are interaction channels, Tasks are first-class):',
    ...lines,
    ...(omitted > 0 ? [`- (+${omitted} more open tasks; call task_list_active or task_search)`] : []),
    'Routing rules: If the owner asks what is in flight, answer straight from this radar; if they reference an older/completed topic not listed here, call `task_search`; when spawning a rework, companion asset, or follow-up revision for an existing task above, pass `parentTaskId: "<existing taskId>"` to `task_create` / `local_worker_delegate` so it nests under that parent.',
    '</active_tasks_radar>',
  ].join('\n');
}

export interface WorkerLivenessPulseDeps {
  /** Return active subtask ids currently executed by `sessionId` (empty if not a Worker task session). */
  resolveSubtaskIdsForSession: (sessionId: string) => string[];
  /** Persist `last_activity_at` (and optional fallback tool pulse) onto the subtask row. */
  touchSubtask: (subtaskId: string, activityIso: string, fallbackToolNote?: string) => boolean;
  /** Throttled UI/HUD broadcast callback when liveness updates land. */
  onBroadcast?: (subtaskIds: string[]) => void;
  throttleMs?: number;
  now?: () => number;
}

/**
 * Zero-token runtime liveness tracker: observes streaming chunks and tool calls
 * from active Worker sessions and refreshes `last_activity_at` in SQLite on a
 * bounded throttle so Twin Bot supervision and the Studio HUD know whether a
 * background Worker is actively working vs genuinely wedged.
 */
export class WorkerLivenessPulseTracker {
  private readonly lastPulseBySession = new Map<string, { atMs: number; lastTool: string }>();
  private readonly throttleMs: number;
  private readonly now: () => number;

  constructor(private readonly deps: WorkerLivenessPulseDeps) {
    this.throttleMs = Math.max(500, Math.trunc(deps.throttleMs ?? DEFAULT_WORKER_LIVENESS_THROTTLE_MS));
    this.now = deps.now ?? Date.now;
  }

  observeActivity(sessionId: string, info?: { toolName?: string | null }): boolean {
    const sid = String(sessionId ?? '').trim();
    if (!sid) return false;
    const nowMs = this.now();
    const toolName = String(info?.toolName ?? '').trim();
    const prev = this.lastPulseBySession.get(sid);
    const isNewTool = Boolean(toolName && toolName !== prev?.lastTool);
    if (prev && !isNewTool && nowMs - prev.atMs < this.throttleMs) {
      return false;
    }

    const subtaskIds = this.deps.resolveSubtaskIdsForSession(sid);
    if (subtaskIds.length === 0) {
      return false;
    }

    this.lastPulseBySession.set(sid, { atMs: nowMs, lastTool: toolName || prev?.lastTool || '' });
    if (this.lastPulseBySession.size > 200) {
      const firstKey = this.lastPulseBySession.keys().next();
      if (!firstKey.done) this.lastPulseBySession.delete(firstKey.value);
    }

    const iso = new Date(nowMs).toISOString();
    const touched: string[] = [];
    for (const subId of subtaskIds) {
      if (this.deps.touchSubtask(subId, iso)) {
        touched.push(subId);
      }
    }
    if (touched.length > 0) {
      this.deps.onBroadcast?.(touched);
      return true;
    }
    return false;
  }

  clearSession(sessionId: string): void {
    this.lastPulseBySession.delete(String(sessionId ?? '').trim());
  }
}
