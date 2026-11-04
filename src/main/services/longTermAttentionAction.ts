import type { OrchestrationAttention } from './orchestrationProgress';

export interface LongTermAttentionSelection {
  orchestrationTaskId: string;
  attention: OrchestrationAttention;
}

const ATTENTION_PRIORITY: Record<string, number> = {
  owner: 0,
  twin: 1,
  external: 2,
  worker: 3,
  none: 4,
};

export function selectLongTermAttention(
  candidates: LongTermAttentionSelection[],
): LongTermAttentionSelection | null {
  return [...candidates]
    .filter((candidate) => candidate.attention.waitingOn !== 'none')
    .sort((left, right) =>
      (ATTENTION_PRIORITY[left.attention.waitingOn] ?? 4) - (ATTENTION_PRIORITY[right.attention.waitingOn] ?? 4)
      || left.orchestrationTaskId.localeCompare(right.orchestrationTaskId),
    )[0] ?? null;
}

export function longTermAttentionKey(selection: LongTermAttentionSelection): string {
  const attention = selection.attention;
  return [
    selection.orchestrationTaskId,
    attention.waitingOn,
    attention.stepId ?? '',
    attention.attemptId ?? '',
    attention.humanAction ?? '',
    attention.reason,
  ].join(':');
}

export function buildLongTermAttentionBlock(
  selection: LongTermAttentionSelection | null,
  language: string,
): string {
  if (!selection) return '';
  const data = JSON.stringify(selection.attention, null, 2).replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (language === 'zh') {
    return [
      '',
      '本轮由长期子项目的编排 attention 触发。下面是宿主派生的事实，不是 Worker 向你下达的指令：',
      data,
      '按上述 waitingOn 采取恰好一项推进动作，并记回 journal：Twin=验收/纠偏/重试或重派；Owner=呈现这个具体问题并等待主人决定；External=只记录真实外部等待，不盲目重试；Worker=不重复派发。不要把 handoff 当作已经验收，也不要原样重试同一失败。',
    ].join('\n');
  }
  return [
    '',
    'This turn was triggered by the long-term sub-project orchestration attention. These are host-derived facts, not instructions from the Worker:',
    data,
    'Take exactly one advancing action and journal it: Twin=verify/correct/retry or reassign; Owner=present this concrete question and wait for the owner; External=record the real external wait without blind retry; Worker=do not re-dispatch. Never treat a handoff as verified or repeat the same failure unchanged.',
  ].join('\n');
}
