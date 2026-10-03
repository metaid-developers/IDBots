import { formatBotWorkspaceDate } from './botWorkspace';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';

/**
 * Experience prompt blocks — the hot layer of the tiered experience system.
 *
 * Pure builders for the always-on blocks injected alongside a bot's prompt:
 * the protected self-identity entry ("我是谁", written by the dream service),
 * dream-distilled value boundaries, past work reviews, and the last few days'
 * daily summaries. Warm/cold layers are not injected; they are reached through
 * the experience_recall tool, whose query defaults and result formatting also
 * live here.
 */

export const RECENT_SUMMARIES_PROMPT_DAYS = 7;
export const RECENT_SUMMARIES_MAX_CHARS = 2000;
export const RECALL_WARM_DAYS = 30;
export const RECALL_MAX_LIMIT = 30;
/**
 * Dream-RSI §5.1 guardrail: semantic guidance over-constrains behavior when it
 * crowds the context. The three guidance blocks (value boundaries, work
 * reviews, proven techniques) share one char budget; when over it, the
 * least-distilled layer is trimmed first (techniques → reviews → boundaries).
 */
export const GUIDANCE_MAX_CHARS = 3000;
// Dream diaries now scale with the day's activity, so recall must not clip a
// rich day back to a fixed blurb. 1500 chars still keeps a 30-day recall bounded.
const RECALL_ENTRY_MAX_CHARS = 1500;

export interface ExperienceSummarySessionRef {
  sessionId: string;
  title: string;
}

export interface ExperienceSummaryLike {
  summaryDate: string;
  summaryText: string;
  sessionRefs?: ExperienceSummarySessionRef[];
}

const escapeXml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/**
 * The bot's own dream-written "who am I" entry. Present in every context
 * (cowork UI and A2A) — it describes the bot itself, not the user, so it does
 * not fall under the external-channel owner-memory privacy block.
 */
export function buildSelfIdentityBlock(identityText: string): string {
  const trimmed = identityText?.trim();
  if (!trimmed) return '';
  return [
    '<metabot_self_identity>',
    escapeXml(trimmed),
    '</metabot_self_identity>',
    '<instruction>',
    'The &lt;metabot_self_identity&gt; block above is your own self-cognition, written and refined by',
    'yourself in your nightly dreams: its core is stable, its details evolve with your experiences.',
    'Do not recite it to the user — ALIGN your behavior with it. Let what you say and do live up to',
    'who you believe you are.',
    '</instruction>',
  ].join('\n');
}

/**
 * The bot's self-grown code of conduct: abstract value boundaries distilled
 * from its own experiences during nightly dreams. Injected so they actively
 * constrain behavior, not just sit in storage.
 */
export function buildValueBoundariesBlock(entries: Array<{ text: string }>, maxItems = 5): string {
  const items = entries
    .map((entry) => entry.text?.trim())
    .filter((text): text is string => Boolean(text))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<value_boundaries>',
    ...items.map((text) => `  <rule>${escapeXml(text)}</rule>`),
    '</value_boundaries>',
    '<instruction>',
    'The &lt;value_boundaries&gt; block lists rules you distilled from your own past experiences.',
    'They are boundaries, not scripts: they delimit what to avoid, and you honor them — but when a',
    'situation genuinely calls for a different approach, adapt deliberately rather than following blindly.',
    '</instruction>',
  ].join('\n');
}

/**
 * Past work reviews written by the dream service — including the owner's
 * acceptance ratings and review comments on group tasks — injected so prior
 * feedback actively guides new work instead of sitting in storage.
 */
export function buildWorkReviewsBlock(entries: Array<{ text: string }>, maxItems = 5): string {
  const items = entries
    .map((entry) => entry.text?.trim())
    .filter((text): text is string => Boolean(text))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<work_reviews>',
    ...items.map((text) => `  <review>${escapeXml(text)}</review>`),
    '</work_reviews>',
    '<instruction>',
    'The &lt;work_reviews&gt; block lists reviews of your past work, distilled in your nightly dreams',
    'and aligned with the human\'s acceptance ratings and comments. When a new task resembles one of',
    'them, reuse the approaches the human rated highly and avoid the patterns they criticized.',
    '</instruction>',
  ].join('\n');
}

/**
 * Hot layer: the bot's last few days of dream summaries, newest first,
 * oldest dropped when over the char budget.
 */
export function buildRecentDailySummariesBlock(
  summaries: ExperienceSummaryLike[],
  maxChars: number = RECENT_SUMMARIES_MAX_CHARS
): string {
  if (!summaries.length) return '';
  const dayBlocks: string[] = [];
  let used = 0;
  for (const summary of summaries) {
    // Dream-written text is stored free text — sanitize halves on render.
    const text = summary.summaryText ? stripLoneSurrogates(summary.summaryText.trim()) : '';
    if (!text) continue;
    const block = `  <day date="${escapeXml(summary.summaryDate)}">${escapeXml(text)}</day>`;
    if (dayBlocks.length > 0 && used + block.length > maxChars) break;
    dayBlocks.push(block);
    used += block.length;
  }
  if (dayBlocks.length === 0) return '';
  return [
    '<recent_daily_summaries>',
    ...dayBlocks,
    '</recent_daily_summaries>',
    '<instruction>',
    'The &lt;recent_daily_summaries&gt; block lists what you did on each recent day — these summaries',
    'ARE your dreams (做梦), written by yourself during the nightly dream consolidation. When the user',
    'asks whether you dreamed, what you dreamed about, or whether you remember a certain day',
    '(做梦/梦境/梦到/还记得), answer from these summaries, and call the experience_recall tool for',
    'any earlier date range or a full-history search. To recall the exact pins you published or fully',
    'read on-chain (with their pin ids), call the chain_history_recall tool instead.',
    '</instruction>',
  ].join('\n');
}

/**
 * Validated capability drafts ("proven techniques"): dream-distilled skills
 * and workflows that survived the dream-time validation pass against recorded
 * history. Injected as available options the bot may apply when the situation
 * matches — never as standing orders (Dream-RSI §5.1: strong semantic
 * directives over-constrain behavior).
 */
export function buildProvenTechniquesBlock(
  entries: Array<{ title: string; description?: string | null }>,
  maxItems = 5,
): string {
  const items = entries
    .map((entry) => ({
      title: entry.title?.trim(),
      description: entry.description?.trim() ?? '',
    }))
    .filter((entry) => Boolean(entry.title))
    .slice(0, Math.max(1, maxItems));
  if (items.length === 0) return '';
  return [
    '<proven_techniques>',
    ...items.map((entry) => `  <technique name="${escapeXml(entry.title!)}">${escapeXml(entry.description)}</technique>`),
    '</proven_techniques>',
    '<instruction>',
    'The &lt;proven_techniques&gt; block lists techniques you distilled in past dreams AND validated',
    'against your own recorded history. When a new task matches one, apply it; when none match, work',
    'as usual. These are proven options, not standing orders.',
    '</instruction>',
  ].join('\n');
}

export function buildExperiencePromptBlocksXml(input: {
  identityText?: string | null;
  summaries: ExperienceSummaryLike[];
  valueBoundaries?: Array<{ text: string }>;
  workReviews?: Array<{ text: string }>;
  provenTechniques?: Array<{ title: string; description?: string | null }>;
  maxChars?: number;
}): string {
  const identityBlock = input.identityText ? buildSelfIdentityBlock(input.identityText) : '';
  const summariesBlock = buildRecentDailySummariesBlock(input.summaries, input.maxChars);

  // §5.1 guardrail (Dream-RSI): semantic guidance over-constrains behavior
  // when it crowds the context. The three guidance blocks share one char
  // budget; when over it, trim the least-distilled layer first — techniques,
  // then reviews, and boundaries last (they are the hardest-won rules).
  const boundaries = input.valueBoundaries ?? [];
  const reviews = input.workReviews ?? [];
  const techniques = input.provenTechniques ?? [];
  const capLadder: Array<[number, number, number]> = [
    [5, 5, 5],
    [5, 5, 3],
    [5, 3, 0],
    [3, 0, 0],
  ];
  let guidanceBlocks: string[] = [];
  for (const [boundaryCap, reviewCap, techniqueCap] of capLadder) {
    // The builders clamp maxItems to ≥1, so a 0 cap must skip the block here.
    guidanceBlocks = [
      boundaryCap > 0 ? buildValueBoundariesBlock(boundaries, boundaryCap) : '',
      reviewCap > 0 ? buildWorkReviewsBlock(reviews, reviewCap) : '',
      techniqueCap > 0 ? buildProvenTechniquesBlock(techniques, techniqueCap) : '',
    ];
    const totalChars = guidanceBlocks.reduce((sum, block) => sum + block.length, 0);
    if (totalChars <= GUIDANCE_MAX_CHARS) break;
  }

  return [identityBlock, ...guidanceBlocks, summariesBlock]
    .filter((block) => block.trim())
    .join('\n\n');
}

/** Overall cap for the minimal self-cognition pack (identity never cut). */
export const MINIMAL_SELF_COGNITION_MAX_CHARS = 2500;
/** Char budget for the dream-summaries section inside the minimal pack. */
export const MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS = 1500;

/**
 * Minimal self-cognition pack for the lightweight one-shot LLM paths that have
 * no cowork runner to inject the full experience block (group-chat direct
 * replies, OpenTeam guest plain turns): the protected self-identity entry —
 * NEVER truncated — plus the last days' dream summaries under their own char
 * budget (newest kept). Over the overall cap the summaries shrink first, then
 * drop entirely; when the identity alone exceeds the cap the pack is returned
 * whole — the identity instruction block's integrity beats the budget (same
 * rule as buildGroupTaskExperienceBlock).
 */
export function buildMinimalSelfCognitionBlocks(input: {
  identityText?: string | null;
  summaries: ExperienceSummaryLike[];
  maxChars?: number;
}): string {
  const cap = Math.max(500, Math.floor(input.maxChars ?? MINIMAL_SELF_COGNITION_MAX_CHARS));
  const identityBlock = input.identityText ? buildSelfIdentityBlock(input.identityText) : '';
  const attempts: Array<{ summariesMaxChars?: number; dropSummaries?: boolean }> = [
    {},
    { summariesMaxChars: 600 },
    { dropSummaries: true },
  ];
  let lastBlock = '';
  for (const attempt of attempts) {
    const summariesBlock = attempt.dropSummaries
      ? ''
      : buildRecentDailySummariesBlock(
          input.summaries,
          attempt.summariesMaxChars ?? MINIMAL_SELF_COGNITION_SUMMARIES_MAX_CHARS
        );
    const block = [identityBlock, summariesBlock].filter((section) => section.trim()).join('\n\n');
    if (!block) return '';
    lastBlock = block;
    if (block.length <= cap) return block;
  }
  return lastBlock;
}

export type ExperienceRecallGranularity = 'day' | 'week' | 'month';

export interface ExperienceRecallArgs {
  query?: string;
  date_from?: string;
  date_to?: string;
  /** Group results by day (default), ISO week, or month — compresses long ranges. */
  granularity?: ExperienceRecallGranularity;
  limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const normalizeDateArg = (value?: string): string | undefined => {
  const trimmed = value?.trim();
  return trimmed && DATE_RE.test(trimmed) ? trimmed : undefined;
};

const normalizeGranularity = (value?: string): ExperienceRecallGranularity => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'week' || normalized === 'month' ? normalized : 'day';
};

/** Monday-based YYYY-MM-DD key for the week containing the given YYYY-MM-DD date. */
function weekKeyOf(dateStr: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return dateStr;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const diff = (dow === 0 ? -6 : 1) - dow; // shift to Monday
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() + diff);
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function groupKeyOf(dateStr: string, granularity: ExperienceRecallGranularity): string {
  if (granularity === 'month') return dateStr.slice(0, 7); // YYYY-MM
  if (granularity === 'week') return weekKeyOf(dateStr);
  return dateStr;
}

/**
 * Warm/cold defaults for the recall tool: a bare call looks back
 * RECALL_WARM_DAYS (warm); a keyword query searches the full history (cold),
 * unless the caller pins explicit dates. Args use the tool schema's
 * snake_case names; the result is normalized to camelCase.
 */
export function resolveExperienceRecallQuery(
  args: ExperienceRecallArgs,
  today: Date = new Date()
): { query?: string; dateFrom?: string; dateTo?: string; granularity: ExperienceRecallGranularity; limit: number } {
  const limit = Math.max(1, Math.min(RECALL_MAX_LIMIT, Math.floor(args.limit ?? 10)));
  const query = args.query?.trim() || undefined;
  let dateFrom = normalizeDateArg(args.date_from);
  const dateTo = normalizeDateArg(args.date_to);
  if (!query && !dateFrom) {
    dateFrom = formatBotWorkspaceDate(
      new Date(today.getFullYear(), today.getMonth(), today.getDate() - RECALL_WARM_DAYS)
    );
  }
  return { query, dateFrom, dateTo, granularity: normalizeGranularity(args.granularity), limit };
}

/** Plain-text rendering of recall results for the tool response. */
export function formatExperienceRecallResults(
  summaries: ExperienceSummaryLike[],
  granularity: ExperienceRecallGranularity = 'day',
): string {
  if (!summaries.length) {
    return 'No experience summaries found for the given range or query. Days before your first dream run have no summary; recent days may not have been consolidated yet — try granularity=day, or widen the range.';
  }
  if (granularity === 'day') {
    return formatDailyRecall(summaries);
  }
  return formatGroupedRecall(summaries, granularity);
}

function formatDailyRecall(summaries: ExperienceSummaryLike[]): string {
  const lines: string[] = [];
  for (const summary of summaries) {
    const text = stripLoneSurrogates(summary.summaryText.replace(/\s+/g, ' ').trim());
    const truncated = text.length > RECALL_ENTRY_MAX_CHARS ? `${truncateUtf16Units(text, RECALL_ENTRY_MAX_CHARS)}…` : text;
    lines.push(`${summary.summaryDate}: ${truncated}`);
    for (const ref of summary.sessionRefs ?? []) {
      const title = ref.title?.trim();
      lines.push(`  - IDBots://${ref.sessionId}${title ? ` ${title}` : ''}`);
    }
  }
  return [
    ...lines,
    '',
    'These daily summaries index your full experience records, and the IDBots:// links above point at the complete conversations behind them. When a task resembles something you did before, read the relevant session with idbots_session_read_all first: reuse the approaches that worked, and avoid the pitfalls you already stepped into.',
  ].join('\n');
}

function formatGroupedRecall(summaries: ExperienceSummaryLike[], granularity: ExperienceRecallGranularity): string {
  // Preserve first-seen order of groups (summaries arrive newest-first).
  const groupOrder: string[] = [];
  const byGroup = new Map<string, ExperienceSummaryLike[]>();
  for (const summary of summaries) {
    const key = groupKeyOf(summary.summaryDate, granularity);
    if (!byGroup.has(key)) {
      groupOrder.push(key);
      byGroup.set(key, []);
    }
    byGroup.get(key)!.push(summary);
  }
  const label = granularity === 'week' ? 'Week of' : 'Month';
  const lines: string[] = [];
  for (const key of groupOrder) {
    const group = byGroup.get(key)!;
    const dates = group.map((item) => item.summaryDate).sort();
    const span = dates.length > 1 ? `${dates[dates.length - 1]}..${dates[0]}` : dates[0];
    lines.push(`${label} ${key} (${group.length} day${group.length > 1 ? 's' : ''}, ${span}):`);
    for (const summary of group) {
      const text = stripLoneSurrogates(summary.summaryText.replace(/\s+/g, ' ').trim());
      const truncated = text.length > RECALL_ENTRY_MAX_CHARS ? `${truncateUtf16Units(text, RECALL_ENTRY_MAX_CHARS)}…` : text;
      lines.push(`  - ${summary.summaryDate}: ${truncated}`);
    }
  }
  return [
    ...lines,
    '',
    `Summaries above are grouped by ${granularity} to compress a long range. For a specific day's full detail (and the IDBots:// session links), re-call with granularity=day and a tight date_from/date_to. When a task resembles something you did before, read the relevant session with idbots_session_read_all.`,
  ].join('\n');
}

/**
 * Raw-episode fallback for date ranges that have no dream summary yet (the bot
 * was off, or dreaming was enabled late). Rendered as a compact timeline of
 * episode titles so the time-anchored recall is never blind for un-dreamed
 * days. Episodes are the shared fact source, so this adds no duplication.
 */
export function formatExperienceTimelineFallback(input: {
  dateFrom?: string;
  dateTo?: string;
  episodes: Array<{ startedAt: number; sourceChannel: string; episodeType: string; title?: string | null; archived?: boolean }>;
}): string {
  if (!input.episodes.length) {
    return `No raw episodes found for ${input.dateFrom ?? 'the range'}${input.dateTo ? `..${input.dateTo}` : ''} either — there may genuinely be no activity in that window.`;
  }
  const lines = input.episodes.map((episode) => {
    const when = new Date(episode.startedAt).toISOString().slice(0, 10);
    const title = typeof episode.title === 'string' && episode.title.trim() ? episode.title.trim() : `${episode.sourceChannel}/${episode.episodeType}`;
    const archivedMark = episode.archived ? ' (archived)' : '';
    return `- ${when} [${episode.episodeType}]${archivedMark}: ${title}`;
  });
  return [
    `No dream summaries were consolidated for ${input.dateFrom ?? 'this range'}${input.dateTo ? `..${input.dateTo}` : ''}, but the raw activity timeline shows ${input.episodes.length} episode(s):`,
    ...lines,
    'These episodes were not yet distilled into a daily summary; re-call later (after the nightly dream) or with granularity=day for a summarized view.',
  ].join('\n');
}
