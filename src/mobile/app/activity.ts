import type { LongTermBoard, LongTermTaskDetail, LongTermTaskStage } from '@/types/longTermTask';
import type { MockMetabot, ScheduledTask, ScheduledTaskRun } from '../bridge/types';

export type ActivityKind = 'scheduled' | 'longterm';
export type ActivityStatus = 'running' | 'success' | 'error' | 'skipped' | 'waiting' | 'paused' | 'done';

/**
 * Run receipt tiering (desktop 2026-11-18) widened ScheduledTaskRun.status
 * with terminal tiers. The phone's activity list keeps the coarse tri-state,
 * mapped exactly like the desktop's task-level bookkeeping contract: a
 * normal executor exit (completed / completed_empty) reads as success, an
 * abnormal exit (crashed / timeout) reads as error, legacy labels and the
 * in-flight states pass through untouched.
 */
const runStatusToActivityStatus = (
  runStatus: ScheduledTaskRun['status'],
): ActivityStatus =>
  runStatus === 'completed' || runStatus === 'completed_empty'
    ? 'success'
    : runStatus === 'crashed' || runStatus === 'timeout'
      ? 'error'
      : runStatus;

export interface WorkActivity {
  id: string;
  kind: ActivityKind;
  taskId: string;
  runId: string | null;
  title: string;
  participants: string[];
  status: ActivityStatus;
  waitingReason: string | null;
  updatedAt: number;
  sessionId: string | null;
  stage: LongTermTaskStage | null;
  currentSubtaskTitle: string | null;
  progress: { accepted: number; total: number; percent: number } | null;
}

export function buildWorkActivity(input: {
  tasks: ScheduledTask[];
  runs: Array<ScheduledTaskRun & { taskName?: string }>;
  board: LongTermBoard | null;
  bots: MockMetabot[];
}): WorkActivity[] {
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));
  const botById = new Map(input.bots.map((bot) => [bot.id, bot.name]));
  const scheduled = input.runs.map((run): WorkActivity => {
    const task = taskById.get(run.taskId);
    return {
      id: `scheduled:${run.id}`,
      kind: 'scheduled',
      taskId: run.taskId,
      runId: run.id,
      title: task?.name ?? run.taskName ?? run.taskId,
      participants: task?.metabotId == null ? [] : [botById.get(task.metabotId) ?? `Bot ${task.metabotId}`],
      status: runStatusToActivityStatus(run.status),
      waitingReason: run.error ?? run.skipReason,
      updatedAt: Date.parse(run.startedAt) || 0,
      sessionId: run.sessionId,
      stage: null,
      currentSubtaskTitle: null,
      progress: null,
    };
  });
  const longTerm = (input.board?.cards ?? []).map((card): WorkActivity => {
    const status: ActivityStatus = card.stage === 'done'
      ? 'done'
      : card.stage === 'cancelled'
        ? 'skipped'
        : card.stage === 'paused'
          ? 'paused'
          : card.column === 'waiting_owner' || card.column === 'waiting_external'
            ? 'waiting'
            : 'running';
    return {
      id: `longterm:${card.id}`,
      kind: 'longterm',
      taskId: card.id,
      runId: null,
      title: card.title,
      participants: card.participants.map((participant) => participant.name),
      status,
      waitingReason: card.currentWaitNote,
      updatedAt: Date.parse(card.updatedAt) || 0,
      sessionId: card.decisionSessionIds[0] ?? null,
      stage: card.stage,
      currentSubtaskTitle: card.currentSubtaskTitle,
      progress: card.progress,
    };
  });
  return [...longTerm, ...scheduled].sort((a, b) => (
    b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  ));
}

export function resolveLongTermResultSession(detail: LongTermTaskDetail): string | null {
  const current = detail.subtasks.find((subtask) => subtask.id === detail.currentSubtaskId);
  if (current?.sessionId) return current.sessionId;
  if (current?.sessionHistory.length) return current.sessionHistory[current.sessionHistory.length - 1];
  return detail.definitionSessionId;
}

export function resolveTwinMetabotId(bots: MockMetabot[]): number | null {
  return bots.find((bot) => bot.metabot_type === 'twin')?.id ?? null;
}
