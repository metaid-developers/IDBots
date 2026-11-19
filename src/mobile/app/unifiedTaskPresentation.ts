import type {
  LongTermColumn,
  LongTermSubtask,
  LongTermTaskDetail,
  LongTermTaskSummary,
} from '@/types/longTermTask';
import { filterTaskBoardCards, sortColumnCards } from '@/utils/taskBoardOrganization';
import { resolveLongTermResultSession } from './activity';
import '../taskCenterI18n';
import { t } from '../i18n';

export type UnifiedTaskFilter = 'all' | LongTermColumn;

export const UNIFIED_TASK_COLUMNS: LongTermColumn[] = [
  'waiting_owner',
  'in_progress',
  'waiting_external',
  'defining',
  'paused',
  'done',
];

export function filterUnifiedTaskCards(
  cards: readonly LongTermTaskSummary[],
  status: UnifiedTaskFilter,
  query: string,
): LongTermTaskSummary[] {
  const searched = filterTaskBoardCards(cards, { query });
  const filtered = status === 'all' ? searched : searched.filter((card) => card.column === status);
  return sortColumnCards(status === 'all' ? 'in_progress' : status, filtered);
}

export function liveTaskCounts(cards: readonly LongTermTaskSummary[]): Record<'waiting_owner' | 'in_progress' | 'waiting_external', number> {
  const counts = { waiting_owner: 0, in_progress: 0, waiting_external: 0 };
  for (const card of cards) {
    if (card.stage === 'done' || card.stage === 'cancelled') continue;
    if (card.column === 'waiting_owner' || card.column === 'in_progress' || card.column === 'waiting_external') {
      counts[card.column] += 1;
    }
  }
  return counts;
}

function expectedDuration(minutes: number): string {
  if (minutes < 60) return t('mobile.taskCenter.duration.minutes', { count: minutes });
  const hours = minutes / 60;
  return t('mobile.taskCenter.duration.hours', { count: Number.isInteger(hours) ? hours : hours.toFixed(1) });
}

export function unifiedTaskNextAction(card: LongTermTaskSummary): string {
  if (card.column === 'defining') return t('mobile.taskCenter.next.defining');
  if (card.column === 'paused') return t('mobile.taskCenter.next.paused');
  if (card.column === 'done') return t('mobile.taskCenter.next.done');
  const note = card.currentWaitNote ?? '';
  if (card.currentSubtaskStatus === 'waiting_owner') {
    return t('mobile.taskCenter.next.waitingOwner', { note });
  }
  if (card.currentSubtaskStatus === 'waiting_external') {
    return t('mobile.taskCenter.next.waitingExternal', { note });
  }
  if (card.currentSubtaskStatus === 'in_progress') {
    const base = t('mobile.taskCenter.next.inProgress');
    return card.currentExpectedMinutes !== null
      ? `${base} · ${t('mobile.taskCenter.next.budget', { duration: expectedDuration(card.currentExpectedMinutes) })}`
      : base;
  }
  return t('mobile.taskCenter.next.inProgress');
}

export function formatUnifiedTaskTime(iso: string, nowMs: number = Date.now()): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  const diff = Math.max(0, nowMs - ms);
  if (diff < 60_000) return t('mobile.taskCenter.time.justNow');
  if (diff < 3_600_000) return t('mobile.taskCenter.time.minutes', { count: Math.floor(diff / 60_000) });
  if (diff < 86_400_000) return t('mobile.taskCenter.time.hours', { count: Math.floor(diff / 3_600_000) });
  if (diff < 7 * 86_400_000) return t('mobile.taskCenter.time.days', { count: Math.floor(diff / 86_400_000) });
  return new Date(ms).toLocaleDateString();
}

export function resolveSubtaskSession(detail: LongTermTaskDetail, subtask: LongTermSubtask): string | null {
  if (subtask.sessionId) return subtask.sessionId;
  if (subtask.sessionHistory.length > 0) return subtask.sessionHistory[subtask.sessionHistory.length - 1];
  return resolveLongTermResultSession(detail);
}

export function linkedSubtaskIds(detail: LongTermTaskDetail): Set<string> {
  const linked = new Set<string>();
  for (const subtask of detail.subtasks) {
    if (subtask.dependsOn.length > 0) linked.add(subtask.id);
    for (const dependency of subtask.dependsOn) linked.add(dependency);
  }
  return linked;
}

export function canReorderSubtask(detail: LongTermTaskDetail, subtask: LongTermSubtask): boolean {
  return !linkedSubtaskIds(detail).has(subtask.id)
    && subtask.status !== 'accepted'
    && subtask.status !== 'skipped'
    && (detail.stage === 'active' || detail.stage === 'defining');
}
