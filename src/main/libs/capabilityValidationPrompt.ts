/**
 * Capability draft validation — the Dream-RSI "replay gate" (P0).
 *
 * Every nightly dream writes capability_learnings as status='draft' rows, but
 * a draft only becomes injectable hot-layer guidance after it survives a
 * validation pass against the bot's OWN recorded history: recent dream
 * diaries, acceptance ratings, and human feedback. A draft that is grounded
 * in what actually happened and corroborated by recorded outcomes is promoted
 * to 'validated'; one contradicted by recorded outcomes is demoted to
 * 'rejected'. This mirrors Dream-RSI's selection guarantee — a lesson only
 * ships when it is consistent with what actually happened.
 *
 * Pure prompt builders + a tolerant output parser; the DreamService owns the
 * LLM call and the store writes.
 */

export const CAPABILITY_VALIDATION_MAX_DRAFTS = 10;
export const CAPABILITY_VALIDATION_PROMOTE_MIN_SCORE = 0.6;
/** Recent dream diaries handed to the validator as the replayable history. */
export const CAPABILITY_VALIDATION_SUMMARY_DAYS = 14;
/**
 * Nightly promotion pass (Dream-RSI P2): only top-scored validated drafts
 * harden into procedure memory — and only after they survived at least one
 * night of calendar distance (see coworkStore.listPromotableCapabilityDrafts).
 */
export const CAPABILITY_PROMOTION_MIN_SCORE = 0.85;
/** Per-bot per-night promotion cap (flood guard). */
export const CAPABILITY_PROMOTION_MAX_PER_NIGHT = 3;
const SUMMARY_EVIDENCE_MAX_CHARS = 400;

export interface CapabilityValidationDraftInput {
  id: number;
  dreamDate: string;
  title: string;
  description: string;
  capabilityType: string;
}

export type CapabilityValidationVerdict = 'validated' | 'rejected' | 'keep_draft';

export interface CapabilityValidationVerdictEntry {
  id: number;
  verdict: CapabilityValidationVerdict;
  /** 0..1 — validated verdicts below PROMOTE_MIN_SCORE stay drafts. */
  score: number;
  rationale: string;
}

export type CapabilityValidationParseResult =
  | { ok: true; verdicts: CapabilityValidationVerdictEntry[] }
  | { ok: false; error: string };

const truncate = (text: string, maxChars: number): string =>
  text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;

export function buildCapabilityValidationPrompt(input: {
  botName: string;
  date: string;
  drafts: CapabilityValidationDraftInput[];
  /** Recent daily summaries (newest first) — the replayable history pool. */
  recentSummaries: Array<{ summaryDate: string; summaryText: string }>;
  /** One-line digest of today's activity stats (session/order/task counts). */
  todayDigest?: string;
}): { system: string; user: string } {
  const system = [
    `你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`,
    '现在是你的夜间整理时间(做梦)的「能力验证」环节。你在过去的梦里提炼过一些能力草案(自以为学会的技巧/流程)。',
    '这些草案不一定靠谱:可能是事后合理化的错觉,可能只在特定情境成立,也可能确实被后续实践反复验证。',
    '请以置身事外的观察者视角,拿草案逐条对照你真实 recorded 的历史(下方梦境日记),实事求是地裁决:',
    '- validated:草案有明确的真实事件支撑,且与记录的结果(人类评价、验收评分、后续实践)一致或因此变好。',
    '- rejected:草案与记录的事实矛盾,或照着做曾导致差评/失败/返工。',
    '- keep_draft:证据不足,无法判定——既不晋升也不否决,留待以后的梦继续观察。',
    '不要为草案辩护,不要因为"听起来有用"就判 validated。宁可 keep_draft,不可错判。',
  ].join('\n');

  const draftLines = input.drafts.map((draft) => [
    `### 草案 #${draft.id}(${draft.dreamDate} 梦中提炼,类型:${draft.capabilityType})`,
    `标题:${draft.title}`,
    `描述:${draft.description}`,
  ].join('\n'));

  const summaryLines = input.recentSummaries.map((summary) =>
    `- [${summary.summaryDate}] ${truncate(summary.summaryText.replace(/\s+/g, ' ').trim(), SUMMARY_EVIDENCE_MAX_CHARS)}`,
  );

  const user = [
    `今天是 ${input.date}。请验证以下 ${input.drafts.length} 条能力草案。`,
    '',
    '## 待验证的能力草案',
    draftLines.join('\n\n'),
    '',
    '## 可重放的历史(近期梦境日记,新→旧)',
    summaryLines.length > 0 ? summaryLines.join('\n') : '(暂无历史日记)',
    ...(input.todayDigest ? ['', '## 当日活动概况', input.todayDigest] : []),
    '',
    '## 输出契约(严格只输出一个 JSON 对象,不要输出任何其他文字)',
    '{',
    '  "verdicts": [',
    '    {',
    '      "id": 草案数字id,',
    '      "verdict": "validated" | "rejected" | "keep_draft",',
    '      "score": 0到1的小数,表示证据强度(1=铁证如山,0=毫无根据),',
    '      "rationale": "一句话裁决依据,引用具体的日记日期或事件"',
    '    }',
    '  ]',
    '}',
    '每条草案都必须有且仅有一条 verdict;id 必须来自上方草案列表。',
  ].join('\n');

  return { system, user };
}

/**
 * Tolerant parser mirroring parseDreamOutput: strips code fences, takes the
 * outermost braces, accepts snake_case aliases, clamps scores into [0, 1],
 * drops verdicts with unknown ids or unknown verdict words.
 */
export function parseCapabilityValidationOutput(
  raw: string,
  validIds: ReadonlySet<number>,
): CapabilityValidationParseResult {
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
  const list = Array.isArray(root?.verdicts) ? root.verdicts : null;
  if (!list) return { ok: false, error: 'missing verdicts array' };

  const verdicts: CapabilityValidationVerdictEntry[] = [];
  const seen = new Set<number>();
  for (const item of list) {
    const entry = item as Record<string, unknown>;
    const id = Number(entry?.id);
    if (!Number.isInteger(id) || !validIds.has(id) || seen.has(id)) continue;
    const rawVerdict = String(entry?.verdict ?? '').trim().toLowerCase();
    const verdict: CapabilityValidationVerdict | null =
      rawVerdict === 'validated' || rawVerdict === 'validate' ? 'validated'
        : rawVerdict === 'rejected' || rawVerdict === 'reject' ? 'rejected'
          : rawVerdict === 'keep_draft' || rawVerdict === 'keep' ? 'keep_draft'
            : null;
    if (!verdict) continue;
    const rawScore = Number(entry?.score);
    const score = Number.isFinite(rawScore) ? Math.max(0, Math.min(1, rawScore)) : 0;
    const rationale = String(entry?.rationale ?? entry?.reason ?? '').trim();
    seen.add(id);
    verdicts.push({ id, verdict, score, rationale });
  }
  if (verdicts.length === 0) return { ok: false, error: 'no usable verdicts' };
  return { ok: true, verdicts };
}
