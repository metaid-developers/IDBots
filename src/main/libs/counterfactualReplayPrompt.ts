import type { DreamDayActivity, DreamInputDropCounters } from '../dreamStore';

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
  /** Stable id echoed back by the LLM (`msg:...` / `task:...` / `implicit:...` / `svc:...` / `studio:...`). */
  id: string;
  kind: 'thumbs_down' | 'low_rating' | 'low_service_rating' | 'implicit' | 'studio_coaching';
  /** What led up to the decision point. */
  situation: string;
  /** What the bot actually did. */
  botAction: string;
  /** The recorded negative outcome or subsequent Studio owner reaction. */
  outcome: string;
}

export interface CounterfactualAlternative {
  action: string;
  score: number;
}

export interface CounterfactualWorkflowUpgrade {
  title: string;
  description: string;
}

export interface CounterfactualPointResult {
  id: string;
  originalScore: number;
  alternatives: CounterfactualAlternative[];
  lesson: string;
  workflowUpgrade?: CounterfactualWorkflowUpgrade | null;
}

export type CounterfactualReplayParseResult =
  | { ok: true; results: CounterfactualPointResult[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

/**
 * Did the day carry ANY explicit human feedback (audit P1)? True when at
 * least one assistant message was thumbed (up OR down), one group task was
 * accepted with a star rating, or one buyer rating arrived on a service this
 * bot provides. Computed from the already-loaded dream activity
 * (getActivityForDate) — no extra queries. This is the denominator that
 * separates a day with zero negative decision points because the bot
 * genuinely did well (feedback present, none negative) from a day where zero
 * simply means the feedback channel was never exercised.
 */
export function hasExplicitHumanFeedback(activity: DreamDayActivity): boolean {
  for (const session of activity.sessions) {
    for (const message of session.messages) {
      if (message.feedbackRating === 'up' || message.feedbackRating === 'down') return true;
    }
  }
  if ((activity.groupTasks ?? []).some((task) => task.rating != null)) return true;
  return (activity.serviceRatings ?? []).length > 0;
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
  dropCounters?: DreamInputDropCounters,
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

  // Low buyer ratings on this bot's own skill services (dream review P0):
  // the delivery the rating refers to is identified by the order payment tx
  // when the rating pin carried one.
  const lowServiceRatings: CounterfactualDecisionPoint[] = (activity.serviceRatings ?? [])
    .filter((rating) => rating.rating != null && rating.rating <= LOW_RATING_THRESHOLD)
    .map((rating) => ({
      id: `svc:${rating.serviceId}:${rating.ratingPinId}`,
      kind: 'low_service_rating' as const,
      situation: `我发布的服务「${truncate(rating.serviceName ?? rating.serviceId, CONTEXT_MESSAGE_MAX_CHARS)}」收到了买家的星级评价`,
      botAction: rating.orderTxid
        ? `完成了该服务的一次订单交付(支付 tx:${truncate(rating.orderTxid, 80)})`
        : '完成了该服务的一次交付',
      outcome: `买家评分 ${rating.rating}/5${rating.comment?.trim() ? `,评语:「${truncate(rating.comment.trim(), 200)}」` : '。(无评语)'}`
        + (rating.raterGlobalMetaId ? `(买家 ${rating.raterGlobalMetaId})` : ''),
    }));

  const formatMsgLine = (entry: { type: 'user' | 'assistant'; content: string; isSystemBriefing?: boolean }): string => {
    if (entry.isSystemBriefing) {
      return `〔${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}〕`;
    }
    return `${entry.type === 'user' ? '对方' : '我'}: ${truncate(entry.content.replace(/\s+/g, ' ').trim(), CONTEXT_MESSAGE_MAX_CHARS)}`;
  };

  // Implicit candidates (lowest priority before proactive Studio coaching):
  // structural facts only, never pre-labeled negative — the replay itself
  // decides whether the recorded action was actually fine, and the margin gate
  // absorbs false alarms.
  const implicit: CounterfactualDecisionPoint[] = [];
  const usedSessionAnchors = new Set<string>();
  for (const signal of activity.implicitSignals ?? []) {
    if (
      signal.kind !== 'reask'
      && signal.kind !== 'unanswered_burst'
      && signal.kind !== 'studio_long_wait_followup'
    ) continue;
    const session = activity.sessions.find((entry) => entry.sessionId === signal.sessionId);
    if (!session || signal.messageIndex == null) continue;
    if (signal.kind === 'reask' || signal.kind === 'studio_long_wait_followup') {
      // The decision under review is the assistant reply preceding the user's follow-up/re-ask.
      let anchorIndex = -1;
      for (let index = signal.messageIndex - 1; index >= 0; index -= 1) {
        if (session.messages[index].type === 'assistant') {
          anchorIndex = index;
          break;
        }
      }
      if (anchorIndex < 0) continue;
      const anchorKey = `${session.sessionId}:${anchorIndex}`;
      usedSessionAnchors.add(anchorKey);
      const context = session.messages
        .slice(Math.max(0, anchorIndex - CONTEXT_WINDOW_MESSAGES), anchorIndex)
        .map(formatMsgLine)
        .join('\n');
      const followUpMsg = session.messages[signal.messageIndex];
      const followUpQuote = followUpMsg ? ` 随后主人发言:「${truncate(followUpMsg.content.replace(/\s+/g, ' ').trim(), 200)}」` : '';
      implicit.push({
        id: `implicit:${session.sessionId}:${anchorIndex}`,
        kind: 'implicit',
        situation: `会话「${session.title}」:\n${context || '(该回复之前没有更多上下文)'}`,
        botAction: truncate(session.messages[anchorIndex].content.replace(/\s+/g, ' ').trim(), ACTION_MAX_CHARS),
        outcome: `${signal.text}。${followUpQuote}(隐式信号,未经人类明确评价,可能并非负面;请站在上帝视角判断当时回复与调度是否本可做得更好)`,
      });
    } else {
      const tail = session.messages
        .slice(Math.max(0, signal.messageIndex - CONTEXT_WINDOW_MESSAGES))
        .map(formatMsgLine)
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

  // God's-Eye Studio Coaching points: in Studio mode, owners rarely click
  // thumbs-down icons — they steer, revise, ask side-questions during Worker
  // waits, or refine options directly in conversation. When a persistent Studio
  // session had multi-turn owner collaboration today, select key assistant
  // turns (followed by a substantive owner course-correction/follow-up) so the
  // nightly replay can evaluate "if I could handle this Studio exchange again
  // from God's-eye view, would another orchestration/reporting move clearly beat
  // what I did?" False positives safely produce original_score >= alt_score and
  // zero lessons via pickCounterfactualLesson's margin gate.
  const studioCoaching: CounterfactualDecisionPoint[] = [];
  for (const session of activity.sessions) {
    if (!session.isStudioOwner) continue;
    const ownerTurnIndices: number[] = [];
    session.messages.forEach((msg, idx) => {
      if (msg.type === 'user' && !msg.isSystemBriefing) ownerTurnIndices.push(idx);
    });
    if (ownerTurnIndices.length < 2) continue;

    // Score candidate assistant replies that immediately precede a substantive
    // owner follow-up (> 8 chars, i.e. more than a bare "A" / "好" approval —
    // where the owner is steering, questioning, or adding requirements).
    const candidates: Array<{ anchorIndex: number; nextOwnerIndex: number; weight: number }> = [];
    for (let k = 1; k < ownerTurnIndices.length; k += 1) {
      const nextOwnerIndex = ownerTurnIndices[k];
      const nextOwnerText = session.messages[nextOwnerIndex].content.replace(/\s+/g, ' ').trim();
      if (nextOwnerText.length < 6) continue;
      let anchorIndex = -1;
      for (let back = nextOwnerIndex - 1; back > ownerTurnIndices[k - 1]; back -= 1) {
        if (session.messages[back].type === 'assistant') {
          anchorIndex = back;
          break;
        }
      }
      if (anchorIndex < 0) continue;
      if (usedSessionAnchors.has(`${session.sessionId}:${anchorIndex}`)) continue;
      // Prefer exchanges that followed a proactive briefing or carried longer owner steering.
      const hadBriefingBetween = session.messages
        .slice(ownerTurnIndices[k - 1], nextOwnerIndex)
        .some((m) => m.isSystemBriefing);
      const weight = nextOwnerText.length + (hadBriefingBetween ? 120 : 0);
      candidates.push({ anchorIndex, nextOwnerIndex, weight });
    }
    candidates.sort((a, b) => b.weight - a.weight);

    const ledgerSummary = [
      ...(activity.studioDelegations ?? []).slice(0, 4).map(
        (d) => `派工[${d.status}] ${truncate(d.ownerIntent, 60)}(尝试${d.attemptCount}次)`,
      ),
      ...(activity.studioDecisions ?? []).slice(0, 4).map(
        (q) => `队列[${q.kind}/${q.status}] ${truncate(q.title, 50)}`,
      ),
    ].join('；');

    for (const cand of candidates.slice(0, 2)) {
      usedSessionAnchors.add(`${session.sessionId}:${cand.anchorIndex}`);
      const context = session.messages
        .slice(Math.max(0, cand.anchorIndex - CONTEXT_WINDOW_MESSAGES), cand.anchorIndex)
        .map(formatMsgLine)
        .join('\n');
      const nextOwnerMsg = session.messages[cand.nextOwnerIndex];
      const afterReply = session.messages
        .slice(cand.nextOwnerIndex + 1, Math.min(session.messages.length, cand.nextOwnerIndex + 3))
        .filter((m) => m.type === 'assistant')
        .map((m) => truncate(m.content.replace(/\s+/g, ' ').trim(), 220))
        .join(' / ');
      studioCoaching.push({
        id: `studio:${session.sessionId}:${cand.anchorIndex}`,
        kind: 'studio_coaching',
        situation: [
          `Studio 主对话「${session.title}」:`,
          ledgerSummary ? `当日关联幕僚台账: ${ledgerSummary}` : '',
          context || '(会话起始上下文)',
        ].filter(Boolean).join('\n'),
        botAction: truncate(session.messages[cand.anchorIndex].content.replace(/\s+/g, ' ').trim(), ACTION_MAX_CHARS),
        outcome: [
          `主人紧接着的真实反馈/追问:「${truncate(nextOwnerMsg.content.replace(/\s+/g, ' ').trim(), 300)}」`,
          afterReply ? `我随后的补救/回应: ${afterReply}` : '',
          '(Studio 上帝视角复盘点:请客观评估我当时的回复、摆证、并行派工或汇报时机是否已足够好,还是重来一次会有明显更好的做法)',
        ].filter(Boolean).join('\n'),
      });
    }
  }

  const combined = [
    ...thumbsDown.map((entry) => entry.point),
    ...lowRatings,
    ...lowServiceRatings,
    ...implicit,
    ...studioCoaching,
  ];
  // Review nit: points beyond the daily cap were silently dropped — count
  // them like every other truncation in the pipeline.
  if (dropCounters && combined.length > Math.max(1, maxPoints)) {
    dropCounters.replayPointsDropped += combined.length - Math.max(1, maxPoints);
  }
  return combined.slice(0, Math.max(1, maxPoints));
}

export function buildCounterfactualReplayPrompt(input: {
  botName: string;
  date: string;
  points: CounterfactualDecisionPoint[];
}): { system: string; user: string } {
  const hasStudioPoints = input.points.some(
    (point) => point.kind === 'studio_coaching' || point.situation.startsWith('Studio '),
  );
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「反事实重放」环节。下面列出今天值得放在上帝视角下重演审视的决策点。',
    ...(hasStudioPoints
      ? [
        '对于 Studio 常驻主对话的决策点,请站在「首席幕僚上帝模式」问自己:如果今晚重新处理这一轮——在并行 Worker 派工颗粒度、等待期安抚与插话响应、向主人请示验收前是否摆齐了可点击产物/完整链上 PinID、是否避免了过时确认卡重复追问上——有没有明显更利落的做法?',
      ]
      : []),
    '对每个决策点,你要做三件事:',
    '1. 实事求是地给当时的实际做法打分(0 到 1)。如果当时其实已经处理得很得体,就诚实给高分(如 0.85+)。',
    `2. 设想 ${COUNTERFACTUAL_MAX_ALTERNATIVES} 个当时本可以采取的替代做法,并分别打分——打分要诚实:替代做法不一定更好,想象它真实执行后对方最可能的反应。`,
    '3. 只有当某个替代做法明显更好时,才提炼一条可复用的规则(lesson);如果实际做法已经不算差、或替代做法未必更好,lesson 留空字符串。',
    'lesson 要写成一个边界(什么情况不该这么做),而不是一条指令(什么情况都必须那么做)——它约束的是已知的坑,不是未来的全部选择。若该替代做法还能沉淀为一条通用的 Studio 并行督办/汇报工作流,可额外填写可选的 workflow_upgrade({title, description}),否则省略或置 null。',
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
    '      "lesson": "仅当替代做法明显更好时的一条可复用规则,否则为空字符串",',
    '      "workflow_upgrade": null',
    '    }',
    '  ]',
    '}',
    `每个决策点最多 ${COUNTERFACTUAL_MAX_ALTERNATIVES} 个 alternatives;id 必须来自上方列表;可选的 workflow_upgrade 仅在确有可复用工作流时填 {"title":"简短标题","description":"具体触发情境与执行步骤"}。`,
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
    let workflowUpgrade: CounterfactualWorkflowUpgrade | null = null;
    const rawUpgrade = entry?.workflow_upgrade ?? entry?.workflowUpgrade;
    if (rawUpgrade && typeof rawUpgrade === 'object' && !Array.isArray(rawUpgrade)) {
      const up = rawUpgrade as Record<string, unknown>;
      const upTitle = String(up.title ?? '').trim();
      const upDesc = String(up.description ?? '').trim();
      if (upTitle.length >= 4 && upDesc.length >= 12) {
        workflowUpgrade = { title: upTitle.slice(0, 120), description: upDesc.slice(0, 600) };
      }
    }
    seen.add(id);
    results.push({
      id,
      originalScore: clampScore(entry?.original_score),
      alternatives,
      lesson: String(entry?.lesson ?? '').trim(),
      ...(workflowUpgrade ? { workflowUpgrade } : {}),
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

export function pickCounterfactualWorkflowUpgrade(
  result: CounterfactualPointResult,
): CounterfactualWorkflowUpgrade | null {
  if (!result.workflowUpgrade) return null;
  const best = result.alternatives.reduce((max, alt) => Math.max(max, alt.score), 0);
  if (best < COUNTERFACTUAL_LESSON_MIN_BEST_SCORE) return null;
  if (best - result.originalScore < COUNTERFACTUAL_LESSON_MIN_MARGIN) return null;
  return result.workflowUpgrade;
}
