/**
 * Open cross-session delegations for one Studio session, derived from the
 * orchestration store. Pure module: every store/session lookup arrives through
 * `deps` so main.ts and tests can inject the real implementations.
 *
 * "Open" means the attempt is still queued or running — including the real
 * case where the attempt watchdog timed out but the worker session itself is
 * still running (the worker keeps working after its attempt row went stale).
 */
export type StudioOpenDelegationAttempt = {
  id: string;
  stepId: string;
  workerMetabotId: number;
  workerSessionId: string | null;
  status: string;
  queuedAt: string;
  startedAt: string | null;
};

export type StudioOpenDelegationStep = {
  id: string;
  title: string;
};

export type StudioOpenDelegationTask = {
  status: string;
  ownerIntent: string;
};

export type StudioOpenDelegationSession = {
  status?: string;
};

export type StudioOpenDelegationMetabot = {
  name?: string | null;
  avatar?: string | null;
};

export type StudioOpenDelegationsDeps = {
  listAttemptsForSourceSessions(sessionIds: string[]): StudioOpenDelegationAttempt[];
  getStep(stepId: string): StudioOpenDelegationStep | null;
  getTaskForStep(stepId: string): StudioOpenDelegationTask | null;
  getSession(sessionId: string): StudioOpenDelegationSession | null;
  getMetabotById(metabotId: number): StudioOpenDelegationMetabot | null;
};

export type StudioOpenDelegation = {
  attemptId: string;
  workerMetabotId: number;
  workerName?: string;
  workerAvatar?: string;
  workerSessionId?: string;
  title: string;
  /** Epoch ms; `startedAt` when known, otherwise `queuedAt`. */
  startedAt: number;
};

const OPEN_ATTEMPT_STATUSES = new Set(['queued', 'running']);
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const MAX_ATTEMPT_AGE_MS = 24 * 60 * 60 * 1000;
const SAFE_AVATAR_PATTERN = /^(?:data:image\/|https?:\/\/)/i;

const firstLine = (value: string | null | undefined, max: number): string => {
  const line = String(value ?? '').split('\n', 1)[0].replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, Math.max(0, max - 1))}…` : line;
};

const clipTitle = (value: string | null | undefined): string => firstLine(value, 40);

export type StudioOpenDelegationsOptions = {
  /**
   * Projection-gate mode (2026-11-12 owner ruling): count ONLY attempts whose
   * own status is queued/running. The timed_out-with-running-worker-session
   * heuristic stays OFF here — twinOrchestrationService marks the attempt
   * completed before it notifies the Twin, and a timed-out attempt can still
   * recover, so neither should hold a projection hostage. Live Stage and the
   * panel keep the default (heuristic included).
   */
  activeAttemptsOnly?: boolean;
};

export function listStudioOpenDelegations(
  deps: StudioOpenDelegationsDeps,
  sessionId: string,
  now: number = Date.now(),
  options?: StudioOpenDelegationsOptions,
): StudioOpenDelegation[] {
  const activeAttemptsOnly = options?.activeAttemptsOnly === true;
  const attempts = deps.listAttemptsForSourceSessions([sessionId]) ?? [];
  const entries: StudioOpenDelegation[] = [];
  for (const attempt of attempts) {
    const queuedMs = Date.parse(attempt.queuedAt);
    if (!Number.isFinite(queuedMs) || queuedMs > now + 60_000 || now - queuedMs > MAX_ATTEMPT_AGE_MS) continue;
    const status = String(attempt.status ?? '');
    let open = OPEN_ATTEMPT_STATUSES.has(status);
    if (!open && !activeAttemptsOnly && status === 'timed_out') {
      const workerSession = attempt.workerSessionId ? deps.getSession(attempt.workerSessionId) : null;
      open = workerSession?.status === 'running';
    }
    if (!open) continue;
    const task = deps.getTaskForStep(attempt.stepId);
    if (task && TERMINAL_TASK_STATUSES.has(String(task.status ?? ''))) continue;
    const step = deps.getStep(attempt.stepId);
    const metabot = deps.getMetabotById(attempt.workerMetabotId);
    const name = typeof metabot?.name === 'string' ? metabot.name.trim().slice(0, 80) : '';
    const avatar = typeof metabot?.avatar === 'string' && SAFE_AVATAR_PATTERN.test(metabot.avatar) ? metabot.avatar : undefined;
    const startedMs = Date.parse(attempt.startedAt ?? '') || queuedMs;
    entries.push({
      attemptId: attempt.id,
      workerMetabotId: attempt.workerMetabotId,
      ...(name ? { workerName: name } : {}),
      ...(avatar ? { workerAvatar: avatar } : {}),
      ...(attempt.workerSessionId ? { workerSessionId: attempt.workerSessionId } : {}),
      title: clipTitle(task?.ownerIntent) || clipTitle(step?.title),
      startedAt: startedMs,
    });
  }
  entries.sort((a, b) => a.startedAt - b.startedAt);
  const seen = new Set<string>();
  const deduped: StudioOpenDelegation[] = [];
  for (const entry of entries) {
    const key = entry.workerSessionId ?? entry.attemptId;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(entry);
  }
  return deduped;
}
