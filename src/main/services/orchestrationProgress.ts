import type { OrchestrationAttempt, OrchestrationStep, OrchestrationTask } from '../orchestrationStore';

export type WorkerHandoffState = 'progress' | 'ready' | 'blocked' | 'waiting_external' | 'failed' | 'dropped';

export interface WorkerHandoff {
  state: WorkerHandoffState;
  summary: string;
  deliverables: unknown[];
  verificationEvidence: unknown[];
  blockers: string[];
  humanAction: string | null;
  structured: boolean;
  parseError?: string;
}

export type OrchestrationWaitingOn = 'worker' | 'twin' | 'owner' | 'external' | 'none';

export interface OrchestrationAttention {
  waitingOn: OrchestrationWaitingOn;
  reason: string;
  stepId?: string;
  attemptId?: string;
  humanAction?: string | null;
}

const HANDOFF_STATES = new Set<WorkerHandoffState>(['progress', 'ready', 'blocked', 'waiting_external', 'failed', 'dropped']);
const ACTIVE_ATTEMPTS = new Set(['queued', 'running', 'timed_out']);

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => text(item)).filter(Boolean);
  const single = text(value);
  return single ? [single] : [];
}

function objectList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function legacyHandoff(replyText: string): WorkerHandoff {
  return {
    state: 'ready',
    summary: replyText.trim(),
    deliverables: [],
    verificationEvidence: [],
    blockers: [],
    humanAction: null,
    structured: false,
  };
}

function invalidHandoff(replyText: string, parseError: string): WorkerHandoff {
  return {
    ...legacyHandoff(replyText),
    state: 'failed',
    blockers: [parseError],
    parseError,
  };
}

export function parseWorkerHandoff(replyText: string): WorkerHandoff {
  const matches = [...replyText.matchAll(/<worker_handoff>\s*([\s\S]*?)\s*<\/worker_handoff>/g)];
  if (matches.length === 0) {
    if (replyText.includes('<worker_handoff>') || replyText.includes('</worker_handoff>')) {
      return invalidHandoff(replyText, 'WORKER_HANDOFF_INVALID');
    }
    return legacyHandoff(replyText);
  }
  try {
    const payload = JSON.parse(matches[matches.length - 1][1]) as Record<string, unknown>;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return invalidHandoff(replyText, 'WORKER_HANDOFF_INVALID');
    const state = text(payload.state) as WorkerHandoffState;
    if (!HANDOFF_STATES.has(state)) return invalidHandoff(replyText, 'WORKER_HANDOFF_STATE_INVALID');
    return {
      state,
      summary: text(payload.summary, replyText.trim()),
      deliverables: objectList(payload.deliverables),
      verificationEvidence: objectList(payload.verificationEvidence),
      blockers: stringList(payload.blockers),
      humanAction: text(payload.humanAction) || null,
      structured: true,
    };
  } catch {
    return invalidHandoff(replyText, 'WORKER_HANDOFF_INVALID');
  }
}

export function handoffFromResult(result: unknown): WorkerHandoff | null {
  if (!result || typeof result !== 'object') return null;
  const record = result as { handoff?: unknown; replyText?: unknown };
  if (record.handoff && typeof record.handoff === 'object') {
    const handoff = record.handoff as WorkerHandoff;
    if (HANDOFF_STATES.has(handoff.state)) return handoff;
  }
  return typeof record.replyText === 'string' ? legacyHandoff(record.replyText) : null;
}

function latestAttempt(step: OrchestrationStep & { attempts: OrchestrationAttempt[] }): OrchestrationAttempt | null {
  const active = step.attempts.find((attempt) => attempt.id === step.activeAttemptId);
  if (active) return active;
  return [...step.attempts].sort((left, right) => left.queuedAt.localeCompare(right.queuedAt)).at(-1) ?? null;
}

function handoffAttention(
  task: OrchestrationTask,
  step: OrchestrationStep & { attempts: OrchestrationAttempt[] },
): OrchestrationAttention | null {
  const attempt = latestAttempt(step);
  const handoff = handoffFromResult(attempt?.result);
  if (!handoff) return null;
  const base = { stepId: step.id, attemptId: attempt?.id };
  if (handoff.humanAction) {
    return { ...base, waitingOn: 'owner', reason: 'Worker requested a human decision', humanAction: handoff.humanAction };
  }
  if (handoff.state === 'waiting_external') {
    return { ...base, waitingOn: 'external', reason: handoff.blockers[0] || handoff.summary || 'Waiting for an external condition' };
  }
  if (handoff.state === 'failed' || handoff.state === 'blocked') {
    return { ...base, waitingOn: 'twin', reason: handoff.blockers[0] || handoff.summary || 'Twin must correct, retry, or reassign the step' };
  }
  if (step.status === 'waiting_input' && task.origin !== 'twin_delegate') {
    return { ...base, waitingOn: 'owner', reason: 'Delivered work awaits owner acceptance' };
  }
  return { ...base, waitingOn: 'twin', reason: handoff.state === 'ready' || handoff.state === 'dropped'
    ? 'Delivered work awaits Twin verification'
    : 'Worker reported progress that needs Twin follow-up' };
}

export function deriveOrchestrationAttention(
  task: OrchestrationTask,
  steps: Array<OrchestrationStep & { attempts: OrchestrationAttempt[] }>,
): OrchestrationAttention {
  if (task.status === 'completed' || task.status === 'cancelled') {
    return { waitingOn: 'none', reason: `Task is ${task.status}` };
  }

  for (const step of steps) {
    const attempt = latestAttempt(step);
    const handoff = handoffFromResult(attempt?.result);
    if (handoff?.humanAction) {
      return {
        waitingOn: 'owner',
        reason: 'Worker requested a human decision',
        stepId: step.id,
        attemptId: attempt?.id,
        humanAction: handoff.humanAction,
      };
    }
  }

  for (const step of steps) {
    const attempt = latestAttempt(step);
    if (attempt && ACTIVE_ATTEMPTS.has(attempt.status)) {
      return {
        waitingOn: 'worker',
        reason: `Worker attempt is ${attempt.status}`,
        stepId: step.id,
        attemptId: attempt.id,
      };
    }
  }

  for (const step of steps) {
    const attempt = latestAttempt(step);
    if (step.status === 'failed' || (step.status === 'ready' && attempt?.status === 'failed')) {
      return {
        waitingOn: 'twin',
        reason: attempt?.error || 'Twin must retry or reassign the failed step',
        stepId: step.id,
        attemptId: attempt?.id,
      };
    }
  }

  for (const step of steps) {
    const attention = handoffAttention(task, step);
    if (attention?.waitingOn === 'external') return attention;
  }
  for (const step of steps) {
    const attention = handoffAttention(task, step);
    if (attention) return attention;
  }

  if (task.status === 'failed') return { waitingOn: 'twin', reason: 'Task failed and needs Twin recovery' };
  if (task.status === 'review') {
    return {
      waitingOn: task.origin === 'twin_delegate' ? 'twin' : 'owner',
      reason: task.origin === 'twin_delegate' ? 'Task awaits Twin verification' : 'Task awaits owner acceptance',
    };
  }
  return { waitingOn: 'twin', reason: 'Task needs planning or the next Twin action' };
}
