import type { DreamDayActivity } from '../dreamStore';

/**
 * Counterfactual replay — the Dream-RSI "dreaming in the replay simulator"
 * pass (P1).
 *
 * The nightly dream re-narrates the day once; this pass instead replays the
 * day's NEGATIVE-OUTCOME decision points (thumbs-down replies, poorly rated
 * group-task work) and asks the bot to generate alternative actions and score
 * them against what actually happened. A lesson is only distilled when an
 * alternative clearly beats the recorded action — so the resulting
 * value_boundary rule is simulation-validated, not post-hoc rationalization.
 *
 * Pure extraction + prompt builder + tolerant parser; the DreamService owns
 * the LLM call and the memory writes. Self-identity and impression pipelines
 * are intentionally untouched (owner decision 2026-09-17).
 */

export const COUNTERFACTUAL_MAX_POINTS = 3;
export const COUNTERFACTUAL_MAX_ALTERNATIVES = 2;
/** Minimum (best alternative − original) score gap for a lesson to ship. */
export const COUNTERFACTUAL_LESSON_MIN_MARGIN = 0.2;
/** Minimum absolute score the best alternative must reach. */
export const COUNTERFACTUAL_LESSON_MIN_BEST_SCORE = 0.6;

const CONTEXT_MESSAGE_MAX_CHARS = 300;
const ACTION_MAX_CHARS = 800;
const CONTEXT_WINDOW_MESSAGES = 6;
/** Group-task acceptance ratings at or below this count as negative. */
const LOW_RATING_THRESHOLD = 2;

export interface CounterfactualDecisionPoint {
  /** Stable id echoed back by the LLM (`msg:...` / `task:...` / `implicit:...`). */
  id: string;
  kind: 'thumbs_down' | 'low_rating' | 'implicit';
  /** What led up to the decision point. */
  situation: string;
  /** What the bot actually did. */
  botAction: string;
  /** The recorded negative outcome. */
  outcome: string;
}

export interface CounterfactualAlternative {
  action: string;
  score: number;
}

export interface CounterfactualPointResult {
  id: string;
  originalScore: number;
  alternatives: CounterfactualAlternative[];
  lesson: string;
}

export type CounterfactualReplayParseResult =
  | { ok: true; results: CounterfactualPointResult[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

/**
 * Did the day carry ANY explicit human feedback (audit P1)? True when at
 * least one assistant message was thumbed (up OR down) or one group task was
 * accepted with a star rating. Computed from the already-loaded dream
 * activity (getActivityForDate) — no extra queries. This is the denominator
 * that separates a day with zero negative decision points because the bot
 * genuinely did well (feedback present, none negative) from a day where zero
 * simply means the feedback channel was never exercised.
 */
export function hasExplicitHumanFeedback(activity: DreamDayActivity): boolean {
  for (const session of activity.sessions) {
    for (const message of session.messages) {
      if (message.feedbackRating === 'up' || message.feedbackRating === 'down') return true;
    }
  }
  return (activity.groupTasks ?? []).some((task) => task.rating != null);
}

/**
 * Pull the day's negative-outcome decision points out of the dream activity:
 * assistant messages the human thumbed down (with conversational context) and
 * group tasks accepted with a low rating. Ordered thumbs-down-with-comment
 * first, then plain thumbs-down, then low ratings; capped at MAX_POINTS.
 */
export function extractNegativeDecisionPoints(
  activity: DreamDayActivity,
  maxPoints: number = COUNTERFACTUAL_MAX_POINTS,
): CounterfactualDecisionPoint[] {
  const thumbsDown: Array<{ point: CounterfactualDecisionPoint; hasComment: boolean }> = [];
  for (const session of activity.sessions) {
    session.messages.forEach((message, index) => {
      if (message.type !== 'assistant' || message.feedbackRating !== 'down') return;
      const context = session.messages
        .slice(Math.max(0, index - CONTEXT_WINDOW_MESSAGES), index)
        .map((entry) => `${entry.type === 'user' ? '对方' : '我'}: ${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`)
        .join('\n');
      const comment = message.feedbackComment?.trim() ?? '';
      thumbsDown.push({
        hasComment: comment.length > 0,
        point: {
          id: `msg:${session.sessionId}:${index}`,
          kind: 'thumbs_down',
          situation: [
            `会话「${session.title}」${session.peerName ? `(与 ${session.peerName})` : ''}:`,
            context || '(该回复之前没有更多上下文)',
          ].join('\n'),
          botAction: truncate(message.content.replace(/\s+/g, ' ').trim(), ACTION_MAX_CHARS),
          outcome: `人类对这条回复点了踩${comment ? `,并留言:「${truncate(comment, 200)}」` : '。(无留言)'}`,
        },
      });
    });
  }
  thumbsDown.sort((a, b) => Number(b.hasComment) - Number(a.hasComment));

  const lowRatings: CounterfactualDecisionPoint[] = (activity.groupTasks ?? [])
    .filter((task) => task.phase === 'accepted' && task.rating != null && task.rating <= LOW_RATING_THRESHOLD)
    .map((task) => ({
      id: `task:${task.taskId}`,
      kind: 'low_rating' as const,
      situation: `群任务「${task.title}」: ${truncate(task.goal.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`,
      botAction: `作为${task.memberRole === 'chair' ? '主席' : '成员'}完成了该任务并交付验收`,
      outcome: `人类验收评分 ${task.rating}/5${task.ratingComment?.trim() ? `,评语:「${truncate(task.ratingComment.trim(), 200)}」` : '。(无评语)'}`,
    }));

  // Implicit candidates (lowest priority): structural facts only, never
  // pre-labeled negative — the replay itself decides whether the recorded
  // action was actually fine, and the margin gate absorbs false alarms.
  const implicit: CounterfactualDecisionPoint[] = [];
  for (const signal of activity.implicitSignals ?? []) {
    if (signal.kind !== 'reask' && signal.kind !== 'unanswered_burst') continue;
    const session = activity.sessions.find((entry) => entry.sessionId === signal.sessionId);
    if (!session || signal.messageIndex == null) continue;
    if (signal.kind === 'reask') {
      // The decision under review is the assistant reply the user restated over.
      let anchorIndex = -1;
      for (let index = signal.messageIndex - 1; index >= 0; index -= 1) {
        if (session.messages[index].type === 'assistant') {
          anchorIndex = index;
          break;
        }
      }
      if (anchorIndex < 0) continue;
      const context = session.messages
        .slice(Math.max(0, anchorIndex - CONTEXT_WINDOW_MESSAGES), anchorIndex)
        .map((entry) => `${entry.type === 'user' ? '对方' : '我'}: ${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`)
        .join('\n');
      implicit.push({
        id: `implicit:${session.sessionId}:${anchorIndex}`,
        kind: 'implicit',
        situation: `会话「${session.title}」:\n${context || '(该回复之前没有更多上下文)'}`,
        botAction: truncate(session.messages[anchorIndex].content.replace(/\s+/g, ' ').trim(), ACTION_MAX_CHARS),
        outcome: `${signal.text}。(隐式信号,未经人类明确评价,可能并非负面)`,
      });
    } else {
      const tail = session.messages
        .slice(Math.max(0, signal.messageIndex - CONTEXT_WINDOW_MESSAGES))
        .map((entry) => `${entry.type === 'user' ? '对方' : '我'}: ${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`)
        .join('\n');
      implicit.push({
        id: `implicit:${session.sessionId}:${signal.messageIndex}:silent`,
        kind: 'implicit',
        situation: `会话「${session.title}」:\n${tail}`,
        botAction: '(没有回复)',
        outcome: `${signal.text}。(隐式信号,未经人类明确评价,可能并非负面)`,
      });
    }
  }

  return [
    ...thumbsDown.map((entry) => entry.point),
    ...lowRatings,
    ...implicit,
  ].slice(0, Math.max(1, maxPoints));
}

export function buildCounterfactualReplayPrompt(input: {
  botName: string;
  date: string;
  points: CounterfactualDecisionPoint[];
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「反事实重放」环节。下面列出今天几个结果不好的决策点。',
    '对每个决策点,你要做三件事:',
    '1. 实事求是地给当时的实际做法打分(0 到 1)。',
    `2. 设想 ${COUNTERFACTUAL_MAX_ALTERNATIVES} 个当时本可以采取的替代做法,并分别打分——打分要诚实:替代做法不一定更好,想象它真实执行后对方最可能的反应。`,
    '3. 只有当某个替代做法明显更好时,才提炼一条可复用的规则(lesson);如果实际做法已经不算差、或替代做法未必更好,lesson 留空字符串。',
    'lesson 要写成一个边界(什么情况不该这么做),而不是一条指令(什么情况都必须那么做)——它约束的是已知的坑,不是未来的全部选择。',
    '以置身事外的观察者视角审视,不要为当时的自己辩护,也不要为了产出而强行提炼。',
  ].join('\n');

  const pointBlocks = input.points.map((point, index) => [
    `### 决策点 ${point.id}(第 ${index + 1} 个)`,
    '情境:',
    point.situation,
    '当时的做法:',
    point.botAction,
    '记录的结果:',
    point.outcome,
  ].join('\n'));

  const user = [
    `今天是 ${input.date}。请对以下 ${input.points.length} 个决策点做反事实重放。`,
    '',
    ...pointBlocks,
    '',
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "results": [',
    '    {',
    '      "id": "决策点id(原样照抄)",',
    '      "original_score": 0到1的小数,',
    '      "alternatives": [{ "action": "替代做法的一句话描述", "score": 0到1的小数 }],',
    '      "lesson": "仅当替代做法明显更好时的一条可复用规则,否则为空字符串"',
    '    }',
    '  ]',
    '}',
    `每个决策点最多 ${COUNTERFACTUAL_MAX_ALTERNATIVES} 个 alternatives;id 必须来自上方列表。`,
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parser mirroring parseDreamOutput: strips code fences, takes the
 * outermost braces, clamps scores into [0, 1], drops results with unknown ids,
 * caps alternatives per point.
 */
export function parseCounterfactualReplayOutput(
  raw: string,
  validIds: ReadonlySet<string>,
): CounterfactualReplayParseResult {
  const text = String(raw ?? '').trim();
  if (!text) return { ok: false, error: 'empty output' };
  const fenced = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  const root = parsed as Record<string, unknown>;
  const list = Array.isArray(root?.results) ? root.results : null;
  if (!list) return { ok: false, error: 'missing results array' };

  const clampScore = (value: unknown): number => {
    const score = Number(value);
    return Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0;
  };

  const results: CounterfactualPointResult[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const id = String(entry?.id ?? '').trim();
    if (!id || !validIds.has(id) || seen.has(id)) continue;
    const alternatives = (Array.isArray(entry?.alternatives) ? entry.alternatives : [])
      .slice(0, COUNTERFACTUAL_MAX_ALTERNATIVES)
      .map((alt) => {
        const record = alt as Record<string, unknown>;
        return {
          action: String(record?.action ?? '').trim(),
          score: clampScore(record?.score),
        };
      })
      .filter((alt) => alt.action.length > 0);
    seen.add(id);
    results.push({
      id,
      originalScore: clampScore(entry?.original_score),
      alternatives,
      lesson: String(entry?.lesson ?? '').trim(),
    });
  }
  if (results.length === 0) return { ok: false, error: 'no usable results' };
  return { ok: true, results };
}

/**
 * The promotion decision, kept pure for tests: a lesson ships only when the
 * best alternative clearly beats the recorded action (margin) and is good in
 * absolute terms. Mirrors the Dream-RSI selection guarantee — the replay must
 * show the alternative would have done better, not merely different.
 */
export function pickCounterfactualLesson(result: CounterfactualPointResult): string | null {
  if (!result.lesson) return null;
  const best = result.alternatives.reduce((max, alt) => Math.max(max, alt.score), 0);
  if (best < COUNTERFACTUAL_LESSON_MIN_BEST_SCORE) return null;
  if (best - result.originalScore < COUNTERFACTUAL_LESSON_MIN_MARGIN) return null;
  return result.lesson;
}
