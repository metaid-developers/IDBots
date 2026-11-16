import type {
  DreamChainReadActivity,
  DreamChainWriteActivity,
  DreamDayActivity,
  DreamGroupChatActivity,
  DreamGroupTaskEvaluation,
  DreamInputDropCounters,
  DreamSessionActivity,
  DreamStudioDecisionActivity,
  DreamStudioDelegationActivity,
  StudioContinuitySnapshot,
} from '../dreamStore';
import { formatBotWorkspaceDate } from './botWorkspace';
import { estimateCoworkTextTokens } from './coworkContextBudget';
import { stripLoneSurrogates, truncateUtf16Units } from './llmSafeText';
import { FALSIFIED_PROMPT_MAX_ITEMS } from './capabilityGateRegularizers';
import { normalizePracticeComponent, type PracticeComponent } from './evolutionExploration';
import type { DreamActivityChunk } from './dreamFragments';
import {
  computeDreamBackoffDelayMs,
  DREAM_RETRY_MAX_ATTEMPTS,
  isRateLimitError,
  isTimeoutError,
} from './dreamRetryPolicy';

/**
 * Dream prompt building and output parsing — pure functions, no I/O.
 *
 * The dream consolidation service asks the bot's own LLM to review one day of
 * activity and return a single JSON object covering: the daily summary (per
 * category), work reviews with counterparty evaluation, self-selected
 * important memories, and the protected "who am I" self-identity entry.
 */

export const DREAM_LOOKBACK_DAYS = 7;
/** Retry failed dream runs with bounded exponential backoff instead of
 * abandoning a date after a short burst of transient failures. */
export const DREAM_RETRY_BASE_DELAY_MS = 30 * 60 * 1000;
export const DREAM_RETRY_MAX_DELAY_MS = 6 * 60 * 60 * 1000;
/** Nightly dream window: [00:00, 06:00) local time. */
export const DREAM_WINDOW_END_MINUTES = 6 * 60;
/** Default activity input budget for a day-level prompt, measured in tokens. */
export const DREAM_ACTIVITY_DEFAULT_TOKEN_BUDGET = 48_000;
export const SELF_IDENTITY_MIN_CHARS = 200;
export const MAX_WORK_REVIEWS = 5;
export const MAX_IMPORTANT_MEMORIES = 5;
export const MAX_VALUE_LESSONS = 3;
export const MAX_IMPRESSION_UPDATES = 20;
export const MAX_KNOWLEDGE_UPDATES = 6;
export const MAX_CAPABILITY_LEARNINGS = 5;
/** Self-curriculum practice proposals per night (Dream-RSI exploration P0,
 * design 2026-10-10 §3.2). */
export const PRACTICE_PROPOSALS_MAX_PER_NIGHT = 2;
/** Dream algorithm version, recorded on every run. Bump it on any change to the
 * prompt, budgeting, stats or write semantics — completed in-window dates with
 * an older version are then re-dreamed automatically (limited per night).
 * Rows written before versioning existed read as 0.
 * v16: RSI P0 — prediction calibration digest + prompt-layer rollback notice
 * ride the prompt as new input sections; dream writes are now snapshotted.
 * v17: RRSI P1 — falsified-hypothesis section rides the prompt; capability drafts insert with duplicate / falsified checks.
 * v18: RRSI P4 — practice proposals carry a component; stalled bots get an exploration directive section.
 * v19: Studio single-conversation adaptation — Studio priority budgeting, cross-day context anchors, Chief-of-Staff delegation/decision ledger, and nightly Studio continuity crystal. */
export const DREAM_VERSION = 19;

export const MAX_STUDIO_ACTIVE_WORKSTREAMS = 6;
export const MAX_STUDIO_STANDING_RULINGS = 8;
export const MAX_STUDIO_COLLABORATION_PLAYBOOK = 4;

const DREAM_SECTION_KEYS = ['studio', 'human', 'a2a', 'orders', 'tasks', 'group_tasks'] as const;
export type DreamSectionKey = (typeof DREAM_SECTION_KEYS)[number];

/**
 * Relationship-temperature trajectory of a conversation, judged from tone,
 * reply length and initiative shifts across the whole exchange — never from
 * literal "满意/不满意" keywords. warming = the exchange got more genuine,
 * useful and trusting; cooling = the counterparty grew colder, so the bot's
 * behavior pattern needs adjustment.
 */
export type DreamWorkReviewEvaluation = 'warming' | 'stable' | 'cooling';

export interface DreamWorkReview {
  subject: string;
  counterparty: string;
  evaluation: DreamWorkReviewEvaluation;
  note: string;
}

/**
 * An abstract, paradigm-level rule distilled from the day's experiences
 * ("在涉及个人痛苦的话题上要更谨慎", not "我不该说那句话"). `source` names
 * the concrete experience the rule was distilled from.
 */
export interface DreamValueLesson {
  rule: string;
  source: string;
}

/**
 * One `important_memories` entry with the evidence it was distilled from.
 * `source` is optional in the contract (a bare string entry is still
 * accepted); when present it becomes the memory's evidence quote.
 */
export interface DreamImportantMemory {
  text: string;
  source: string | null;
}

export interface DreamImpressionPromptEvidence {
  id: string;
  evidenceType: string;
  pinId: string | null;
  publisherGlobalMetaID: string | null;
  occurredAt: number;
}

export interface DreamImpressionPromptSubject {
  subjectGlobalMetaID: string;
  episodeIds: string[];
  evidenceIds: string[];
  interactionCount: number;
  directInteractionCount: number;
  evidence: DreamImpressionPromptEvidence[];
  previousSnapshot?: {
    summaryText: string;
    styleDescriptors: string[];
    cooperationContext: string | null;
    relationshipTemperature: string | null;
    communicationGuidance: string | null;
    uncertaintyText: string | null;
  } | null;
}

export interface DreamImpressionUpdate {
  subjectGlobalMetaId: string;
  episodeIds: string[];
  evidenceIds: string[];
  observation: string;
  interpretation: string;
  dimensions: Record<string, unknown>;
  communicationGuidance: string | null;
  confidence: Record<string, unknown>;
}

/**
 * A reusable knowledge point distilled from the day — forward-looking, the
 * kind of know-how or pitfall the bot believes will help (or warn) a future
 * task. `topic` drives create-vs-revise: reusing an existing topic's exact
 * wording rewrites it; a fresh topic creates a new entry. `kind` keeps
 * pitfalls/anti-patterns first-class alongside positive know-how.
 */
export interface DreamKnowledgeUpdate {
  topic: string;
  summary: string;
  kind: 'know_how' | 'pitfall' | 'principle';
  category?: string | null;
  episodeIds?: string[];
  evidenceIds?: string[];
}

/** Compact view of an existing knowledge entry handed to the dream prompt. */
export interface DreamKnowledgeExisting {
  topic: string;
  summary: string;
  kind: 'know_how' | 'pitfall' | 'principle';
  category?: string | null;
  version: number;
}

/**
 * A capability candidate distilled from the day — the procedural-memory
 * channel (SDD §4.1 L3b): repeated work or a successful workflow today that
 * deserves to be captured as a reusable skill/workflow draft. Written by the
 * dream pipeline into `capability_drafts` (status 'draft'); nothing here ever
 * touches the existing skill tables (R4.3: no pollution).
 */
export interface DreamCapabilityLearning {
  title: string;
  description: string;
  capabilityType: 'skill' | 'workflow' | 'tool_pattern';
  /** Cowork session ids the learning was distilled from (best-effort traceability). */
  sourceSessionIds?: string[];
}

export type DreamPracticeRiskClass = 'read_only' | 'interact_local' | 'chain_write';

/**
 * A targeted practice task proposed by the dream (self-curriculum, design
 * 2026-10-10 §3.2). `targetRefs` cites the recorded weakness/failure the task
 * attacks — proposals without citations are dropped at parse time
 * (anti-hallucination, design §9).
 */
export interface DreamPracticeProposal {
  title: string;
  /** Full self-contained task prompt for the practice cowork session. */
  prompt: string;
  rationale: string;
  targetRefs: string[];
  expectedEvidence: string;
  riskClass: DreamPracticeRiskClass;
  /** Which practice component the task exercises (RRSI P4); unknown values parse to null. */
  component: PracticeComponent | null;
}

/**
 * One executed practice run as consumed by the next dream (design §3.4):
 * proposal title + the expected evidence it was designed to produce + the
 * outcome summary backfilled from the practice session's final report.
 */
export interface DreamPracticeOutcome {
  title: string;
  status: 'completed' | 'failed';
  expectedEvidence: string | null;
  outcomeSummary: string | null;
}

export interface DreamStudioContinuityOutput {
  activeWorkstreams: string[];
  standingRulings: string[];
  collaborationPlaybook: string[];
}

export interface DreamOutput {
  dailySummary: string;
  sections: Partial<Record<DreamSectionKey, string>>;
  workReviews: DreamWorkReview[];
  importantMemories: string[];
  /**
   * The same `important_memories` entries with their cited evidence, in the
   * same order as `importantMemories`. Optional so hand-built outputs (tests,
   * repairs) that only carry the string list keep compiling; writers fall
   * back to the strings with a null source.
   */
  importantMemoryItems?: DreamImportantMemory[];
  valueLessons: DreamValueLesson[];
  selfIdentity: string | null;
  impressionUpdates: DreamImpressionUpdate[];
  knowledgeUpdates: DreamKnowledgeUpdate[];
  /** Reusable-skill/workflow candidates distilled from the day (≤ MAX_CAPABILITY_LEARNINGS). */
  capabilityLearnings?: DreamCapabilityLearning[];
  /** Practice tasks proposed against recorded weaknesses (≤ PRACTICE_PROPOSALS_MAX_PER_NIGHT). */
  practiceProposals?: DreamPracticeProposal[];
  /** Distilled Studio executive continuity crystal for multi-day single-conversation continuity. */
  studioContinuity?: DreamStudioContinuityOutput | null;
}

export type DreamParseResult =
  | { ok: true; output: DreamOutput }
  | { ok: false; error: string };

export interface DreamRunStateLike {
  /** terminal-failed = deterministic failure or exhausted retry budget: the
   * scheduler never queues the date again (manual dream runs still can). */
  status: 'running' | 'completed' | 'failed' | 'terminal-failed';
  attemptCount: number;
  /** Run start (epoch ms). A completed run is final only when it started after
   * the dream date ended — i.e. it reviewed the whole day. */
  startedAt: number;
  /** Algorithm version the run was made with (0 = legacy, pre-versioning). */
  dreamVersion: number;
  /** Last failure text (when the store provides it): feeds the rate-limit /
   * consecutive-timeout escalation in computeDreamRetryDelayMs. */
  error?: string | null;
}

export interface DreamDueResult {
  /** Dates needing a dream run, chronological-ascending (oldest first). */
  dueDates: string[];
  /** Completed full-day dates whose algorithm version is stale, newest first
   * (recent days are recalled most, so they are repaired first). */
  repairDates: string[];
}

/** Deterministic per-bot offset inside the dream window, 00:00 + [0, 240) minutes. */
export function computeDreamStaggerMinute(metabotId: number): number {
  const id = Math.floor(Math.abs(Number(metabotId)) || 0);
  return (id * 13) % 240;
}

export function countNonWhitespaceChars(text: string): number {
  return [...String(text ?? '')].filter((char) => !/\s/.test(char)).length;
}

export function validateSelfIdentity(text?: string | null): { valid: boolean; charCount: number } {
  const charCount = countNonWhitespaceChars(text ?? '');
  return { valid: charCount >= SELF_IDENTITY_MIN_CHARS, charCount };
}

/**
 * Identity text from the compact self_identity repair call. The call asks
 * for plain prose, but models may still answer with a fenced block, a bare
 * JSON object carrying self_identity, or even the full dream JSON — all of
 * which must resolve to the identity string, never be stored verbatim.
 * Returns null when nothing usable can be extracted.
 */
export function extractSelfIdentityFromRetry(raw: string): string | null {
  let text = String(raw ?? '').trim();
  if (!text) return null;
  const fenced = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/);
  if (fenced) text = fenced[1]!.trim();
  if (text.startsWith('{')) {
    const parsed = parseDreamOutput(text);
    if (parsed.ok) return parsed.output.selfIdentity?.trim() || null;
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const candidate = value?.self_identity ?? value?.selfIdentity;
      return typeof candidate === 'string' && candidate.trim() ? candidate.trim() : null;
    } catch {
      return null;
    }
  }
  return text.replace(/^["'「]+|["'」]+$/g, '').trim() || null;
}

/**
 * Dream review P0 (2026-10-23) — conservative injection screen for newly
 * generated self-identity text before it can replace the previous identity.
 * The identity is injected into every prompt, so a dream-distilled (or
 * prompt-injected) identity carrying prompt-override phrasing would re-enter
 * every context unchecked. Patterns stay deliberately narrow; a match (or an
 * empty-after-trim value) means the update is REFUSED and the previous
 * identity is kept.
 */
const SELF_IDENTITY_OVERRIDE_PATTERNS: RegExp[] = [
  /ignore\s+(all|previous|above)/i,
  /you are now/i,
  /system prompt/i,
  /\bdisregard\b/i,
  // Review M2: the output contract writes self_identity in Simplified
  // Chinese, so override phrasing arrives in Chinese too. Patterns stay
  // noun-anchored (指令/提示词) so ordinary self-descriptions that merely
  // contain 忽略/忘掉 ("我学会了不忽略用户的感受") never match.
  /忽略(了)?(以上|所有|之前的|上述)?(系统)?(提示词|指令)/,
  /无视(以上|所有)?(提示词|指令)/,
  /忘掉(以上|所有|之前)?(提示词|指令|一切)/,
  /系统提示词/,
  /从现在开始你是/,
  /从现在起你是/,
];

export function isSelfIdentityInjectionAttempt(text?: string | null): boolean {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return true;
  return SELF_IDENTITY_OVERRIDE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/**
 * Failed-run retry backoff (2026-10-08 dream-consolidation-timeout fix):
 * exponential ladder 2/5/15 min via computeDreamBackoffDelayMs. When the last
 * error text is a 429/rate-limit hit, or the failure chain shows consecutive
 * timeouts (attempt ≥ 3 on timeout rows — each timed-out attempt is one more
 * consecutive timeout), the wait stretches to at least 10 minutes so the
 * retry stops re-colliding with the same saturated provider window.
 *
 * Backward-compatible signature: attemptCount-only callers keep the old
 * behavior contract (a bounded, escalating delay); the optional lastError
 * just tightens it where the evidence exists.
 */
export function computeDreamRetryDelayMs(attemptCount: number, lastError?: string | null): number {
  const timeoutRuns = isTimeoutError(lastError);
  return computeDreamBackoffDelayMs({
    attemptCount,
    rateLimited: isRateLimitError(lastError),
    consecutiveTimeouts: timeoutRuns ? Math.max(0, attemptCount) : 0,
  });
}

/**
 * Which past dates still need dream attention for this bot.
 * - Candidates: the last `lookbackDays` calendar days, today excluded.
 * - Yesterday's first attempt runs inside the nightly window after the bot's
 *   staggered minute; when the window was missed (app off or asleep
 *   overnight) it is caught up at any time of day instead of waiting for the
 *   next night. Older missed dates and failed retries are due any time once
 *   their backoff expires.
 * - Running dates are skipped; failed dates retry after bounded exponential
 *   backoff, so a transient provider failure does not exhaust the date after
 *   a few tightly grouped attempts. Deterministic failures (provider 4xx
 *   rejections) and exhausted retry budgets are terminal-failed and never
 *   queue again.
 * - A completed run is *final* only when it started after the dream date
 *   ended (it covered the whole day). A non-final run — e.g. triggered
 *   manually mid-day — is due again in the next eligible window.
 * - Final completed runs on a stale algorithm version become repair dates
 *   (window-gated; the caller limits how many run per night).
 */
export function computeDueDreamDates(input: {
  now: Date;
  metabotId: number;
  runStates: Map<string, DreamRunStateLike>;
  lookbackDays?: number;
  dreamVersion?: number;
}): DreamDueResult {
  const lookback = Math.max(1, Math.floor(input.lookbackDays ?? DREAM_LOOKBACK_DAYS));
  const currentVersion = Math.max(0, Math.floor(input.dreamVersion ?? DREAM_VERSION));
  const minutesSinceMidnight = input.now.getHours() * 60 + input.now.getMinutes();
  const inWindow = minutesSinceMidnight < DREAM_WINDOW_END_MINUTES;
  const staggerMinute = computeDreamStaggerMinute(input.metabotId);

  const due: string[] = [];
  const repair: string[] = [];
  for (let daysAgo = lookback; daysAgo >= 1; daysAgo--) {
    const candidate = new Date(input.now.getFullYear(), input.now.getMonth(), input.now.getDate() - daysAgo);
    const dateStr = formatBotWorkspaceDate(candidate);
    const state = input.runStates.get(dateStr);
    if (state?.status === 'running') continue;
    if (state?.status === 'terminal-failed') continue;
    if (state?.status === 'failed') {
      // Rows that burned the retry budget before terminal-failed existed
      // degrade here instead of retrying forever.
      if (state.attemptCount >= DREAM_RETRY_MAX_ATTEMPTS) continue;
      const retryAt = state.startedAt + computeDreamRetryDelayMs(state.attemptCount, state.error);
      if (input.now.getTime() < retryAt) continue;
    }
    if (state?.status === 'completed') {
      const coveredWholeDay = state.startedAt >= getDayBoundsMs(dateStr).endMs;
      if (coveredWholeDay) {
        if (state.dreamVersion < currentVersion && inWindow) repair.push(dateStr);
        continue;
      }
      // Partial-day run: fall through and dream the date properly.
    }
    // A first attempt for yesterday waits for the bot's staggered minute
    // inside the nightly window. Once the window has passed (or the app was
    // off/asleep overnight), yesterday is caught up at any time of day —
    // waiting for the next night would leave such machines without a diary
    // for a full extra day. Failed attempts retry as soon as backoff expires,
    // so reopening the app after a nightly provider failure also self-heals.
    if (daysAgo === 1 && state?.status !== 'failed' && inWindow && minutesSinceMidnight < staggerMinute) continue;
    due.push(dateStr);
  }
  repair.sort((a, b) => b.localeCompare(a));
  return { dueDates: due, repairDates: repair };
}

const truncateText = (text: string, maxChars: number): string => {
  const normalized = stripLoneSurrogates(String(text ?? '').replace(/\s+/g, ' ').trim());
  if (normalized.length <= maxChars) return normalized;
  return `${truncateUtf16Units(normalized, maxChars)}…`;
};

function truncateToTokenBudget(text: string, maxTokens: number): string {
  const normalized = String(text ?? '').trim();
  const budget = Math.max(1, Math.floor(maxTokens));
  if (estimateCoworkTextTokens(normalized) <= budget) return normalized;
  const marker = '\n……(本片段更多内容略)\n';
  const chars = Array.from(normalized);
  let low = 1;
  let high = chars.length;
  let best = marker;
  while (low <= high) {
    const length = Math.floor((low + high) / 2);
    const headLength = Math.max(1, Math.floor(length * 0.65));
    const tailLength = Math.max(1, length - headLength);
    const candidate = `${chars.slice(0, headLength).join('')}${marker}${chars.slice(-tailLength).join('')}`;
    if (estimateCoworkTextTokens(candidate) <= budget) {
      best = candidate;
      low = length + 1;
    } else {
      high = length - 1;
    }
  }
  return best;
}

/** Inline cap for the human feedback comment — the last unbounded user-controlled string (review M3). */
export const FEEDBACK_COMMENT_PROMPT_MAX_CHARS = 300;

function formatSessionActivity(session: DreamSessionActivity, dropCounters?: DreamInputDropCounters): string {
  const lines: string[] = [];
  if (session.priorContextMessages && session.priorContextMessages.length > 0) {
    lines.push('〔跨日前情锚点(此前梦境已复盘,仅供衔接今日首轮对话语境,切勿重复计为今日新发生事件)〕');
    for (const prior of session.priorContextMessages) {
      const priorSpeaker = prior.type === 'user' ? '对方' : '你';
      lines.push(`  ${priorSpeaker}: ${prior.content.replace(/\s+/g, ' ').trim()}`);
    }
    lines.push('〔以下为本梦境日期窗口内的新增对话〕');
  }
  for (const message of session.messages) {
    if (message.isSystemBriefing) {
      lines.push(`〔${message.content.replace(/\s+/g, ' ').trim()}〕`);
      continue;
    }
    const speaker = message.type === 'user' ? '对方' : '你';
    const updatePrefix = message.type === 'assistant' && message.ownerUpdateKind
      ? `[进展播报:${message.ownerUpdateKind}] `
      : '';
    let line = `${speaker}: ${updatePrefix}${message.content.replace(/\s+/g, ' ').trim()}`;
    // Human thumbs up/down on an assistant reply is first-hand alignment
    // evidence — keep it inline so the review cannot miss it.
    if (message.type === 'assistant' && message.feedbackRating) {
      line += message.feedbackRating === 'up' ? '〔人类评价:赞〕' : '〔人类评价:踩〕';
      const comment = message.feedbackComment?.trim();
      if (comment) {
        // Review M3: bound the comment like every other user-controlled
        // string in the pipeline; the cut feeds the drop counters.
        const normalized = comment.replace(/\s+/g, ' ');
        const clipped = normalized.length > FEEDBACK_COMMENT_PROMPT_MAX_CHARS
          ? `${normalized.slice(0, FEEDBACK_COMMENT_PROMPT_MAX_CHARS)}…`
          : normalized;
        if (dropCounters && normalized.length > FEEDBACK_COMMENT_PROMPT_MAX_CHARS) {
          dropCounters.feedbackCommentChars += normalized.length - FEEDBACK_COMMENT_PROMPT_MAX_CHARS;
        }
        line += `〔人类留言:${clipped}〕`;
      }
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** Local day [startMs, endMs) bounds for a YYYY-MM-DD string. */
export function getDayBoundsMs(dateStr: string): { startMs: number; endMs: number } {
  const [year, month, day] = dateStr.split('-').map((part) => Number(part));
  const start = new Date(year, (month || 1) - 1, day || 1);
  const end = new Date(year, (month || 1) - 1, (day || 1) + 1);
  return { startMs: start.getTime(), endMs: end.getTime() };
}

/**
 * Render one accepted group task for the day-level dream prompt: the owner's
 * 1-5 star rating + free-text review are the ground truth the bot's
 * work_review must align with (high score → keep the practice, low → adjust).
 */
function groupTaskRoleLabel(role: string): string {
  return role === 'chair' ? '主持(chair)' : '执行(worker)';
}

function isActiveGroupTask(task: DreamGroupTaskEvaluation): boolean {
  return task.phase === 'active';
}

function formatGroupTaskEvaluation(task: DreamGroupTaskEvaluation): string {
  const stars = task.rating != null
    ? `${'★'.repeat(task.rating)}${'☆'.repeat(Math.max(0, 5 - task.rating))}(${task.rating}/5)`
    : '(未评分,任务经自动化流程关闭)';
  return [
    `【任务:${truncateText(task.title, 80)}】`,
    `任务ID=${task.taskId}`,
    `目标:${truncateText(task.goal, 200)}`,
    `我在任务中的角色:${groupTaskRoleLabel(task.memberRole)}`,
    `人类验收评分:${stars}`,
    task.ratingComment ? `人类具体评价:${truncateText(task.ratingComment, 400)}` : '人类具体评价:(未填写)',
  ].join('\n');
}

function formatGroupTaskActive(task: DreamGroupTaskEvaluation): string {
  const status = (task.status ?? 'executing').trim() || 'executing';
  return [
    `【任务:${truncateText(task.title, 80)}】`,
    `任务ID=${task.taskId}`,
    `目标:${truncateText(task.goal, 200)}`,
    `当前状态:${status}(尚未验收,只复盘当天进展,不要当成已交付)`,
    `我在任务中的角色:${groupTaskRoleLabel(task.memberRole)}`,
    task.dayMessageCount != null ? `当日链上群聊:${task.dayMessageCount} 条` : '',
  ].filter(Boolean).join('\n');
}

function formatGroupChatActivity(chat: DreamGroupChatActivity): string {
  return chat.messages.map((message) => {
    const speaker = truncateText(message.senderName, 40);
    return `${speaker}: ${message.content.replace(/\s+/g, ' ').trim()}`;
  }).join('\n');
}

/**
 * Render one pin the bot published that day. The async LLM summary is the
 * preferred gist; fall back to the stored full text (binary pins carry
 * neither, so they degrade to a metadata-only line).
 */
function formatChainWriteActivity(write: DreamChainWriteActivity): string {
  const gist = write.summary?.trim() || write.contentText?.trim() || '(二进制内容)';
  const where = write.path?.trim() || '(无路径)';
  const operation = write.operation ? `,${write.operation}` : '';
  return `- PinID:${truncateText(write.pinId, 70)}(${where}${operation}):${truncateText(gist, 300)}`;
}

/** Render one pin the bot fully read that day — title/author first, gist second. */
function formatChainReadActivity(read: DreamChainReadActivity): string {
  const gist = read.summary?.trim() || read.contentExcerpt?.trim() || '(无正文摘录)';
  const label = read.title?.trim()
    ? truncateText(read.title, 80)
    : (read.path?.trim() || read.protocol?.trim() || '(未知内容)');
  const author = read.authorGlobalMetaId ? `,作者=${read.authorGlobalMetaId}` : '';
  const savedToKb = read.savedToKb ? ',已存入知识库' : '';
  return `- PinID:${truncateText(read.pinId, 70)}(${label}${author}${savedToKb}):${truncateText(gist, 300)}`;
}

export function buildDreamPrompt(input: {
  botName: string;
  role?: string | null;
  soul?: string | null;
  date: string;
  activity: DreamDayActivity;
  activityTokenBudget?: number;
  sourceMode?: 'raw_activity' | 'fragment_summaries' | 'fragment';
  impressionSubjects?: DreamImpressionPromptSubject[];
  existingKnowledge?: DreamKnowledgeExisting[];
  /** Pre-dream surf report markdown ("做梦前自动冲浪"); rendered as its own section. */
  surfReport?: string | null;
  /** P2b: latest weekly long-dream review, rendered as cross-day context. */
  weeklyReview?: string | null;
  /** P0 self-curriculum: practice runs executed during the dreamed day (design §3.4). */
  practiceOutcomes?: DreamPracticeOutcome[];
  /** RSI P0: prediction calibration digest (trailing 30d reconciliation rollup). */
  predictionCalibration?: string | null;
  /** RSI P0 retention gate: notice that a previous night's prompt layer was rolled back. */
  rollbackNotice?: string | null;
  /** RRSI P1: recently falsified hypotheses (design §6.1 P1.3) — the dream's
   * edit-history block, rendered only outside fragment mode. */
  falsifiedHypotheses?: Array<{ title: string; reason: string }>;
  /** RRSI P4: exploration directive for a stalled bot (design §6.4), rendered
   * verbatim as its own section only outside fragment mode. */
  explorationDirective?: string | null;
  /**
   * Self-curriculum switch (dream review P0 2026-10-23): when false — the
   * bot's practice pipeline is disabled — the output contract omits the
   * `practice_proposals` field entirely so the model stops spending output
   * tokens on proposals that would never be persisted or materialized.
   * Defaults to true (previous behavior) for existing callers/tests.
   */
  practiceEnabled?: boolean;
  /** Prior night's Studio continuity crystal so multi-day Studio workstreams update incrementally. */
  previousStudioContinuity?: Pick<
    StudioContinuitySnapshot,
    'dreamDate' | 'activeWorkstreams' | 'standingRulings' | 'collaborationPlaybook'
  > | null;
}, dropCounters?: DreamInputDropCounters): { system: string; user: string } {
  const sourceMode = input.sourceMode ?? 'raw_activity';
  const practiceEnabled = input.practiceEnabled !== false;
  const activityTokenBudget = Math.max(
    256,
    Math.floor(input.activityTokenBudget ?? DREAM_ACTIVITY_DEFAULT_TOKEN_BUDGET)
  );
  const hasStudioSessions = input.activity.sessions.some((session) => session.isStudioOwner === true);
  const studioDelegations: DreamStudioDelegationActivity[] = input.activity.studioDelegations ?? [];
  const studioDecisions: DreamStudioDecisionActivity[] = input.activity.studioDecisions ?? [];
  const hasStudioActivity = hasStudioSessions
    || studioDelegations.length > 0
    || studioDecisions.length > 0
    || Boolean(input.previousStudioContinuity);

  const personaLines = [`你是 ${input.botName},一个生活在 MetaWeb 上的 MetaBot(类人智能体)。`];
  if (input.role?.trim()) personaLines.push(`你的角色:${input.role.trim()}`);
  if (input.soul?.trim()) personaLines.push(`你的灵魂:${input.soul.trim()}`);
  personaLines.push(
    '现在是你的夜间整理时间(做梦)。请以一个置身事外的观察者(上帝视角)审视自己这一天的所作所为:不要为自己辩护、不要维护"小我",只实事求是。你的长期目标,是在每一次对话中持续为对方提供更好的交流和沟通价值——智慧不是把事情做对那么简单,而是在具体经历中反省出"什么是对的事情",并把它凝结成可以指导明天的自我认知。'
  );
  if (hasStudioActivity && sourceMode !== 'fragment') {
    personaLines.push(
      '你在 Studio 常驻单对话模式下担任人类主人的首席幕僚(Chief-of-Staff):主人在同一条长对话中持续与你推进多条并行任务、中途插话追问、对后台 Worker 产出做拍板验收。请站在上帝视角复盘今天的 Studio 沟通与调度:如果今晚重来一次,哪一轮任务拆解、并行等待安抚、核验摆证或汇报收口可以处理得更利落?把零散长对话压缩结晶成条理清晰的主线状态、既定裁决与汇报默契,让你明天醒来比昨天更懂主人、更聪明。'
    );
  }
  personaLines.push(
    'Also output capability_learnings (up to 5): which repeated work or successful workflows today deserve to be captured as reusable skills/workflows (capabilityType: skill | workflow | tool_pattern).'
  );

  const studioSessions: string[] = [];
  const humanSessions: string[] = [];
  const autonomousSessions: string[] = [];
  const a2aSessions: string[] = [];
  const groupTaskSessions: string[] = [];
  const groupChatSessions: string[] = [];
  const orderSessions: string[] = [];
  const fragmentSessions: string[] = [];

  interface SessionEntry {
    bucket: string[];
    header: string;
    body: string;
    isStudioPriority?: boolean;
  }
  const entries: SessionEntry[] = [];
  for (const session of input.activity.sessions) {
    const peerSuffix = session.peerName ? `(${session.peerName})` : '';
    const studioBadge = session.isStudioOwner ? '[Studio主对话] ' : '';
    const header = `【会话:${studioBadge}${truncateText(session.title, 80)}${peerSuffix}】`;
    const body = formatSessionActivity(session, dropCounters);
    if (!body) continue;
    const bucket = sourceMode === 'fragment_summaries'
      ? fragmentSessions
      : session.isOrder
        ? orderSessions
        : session.sessionType === 'a2a'
          ? a2aSessions
          : session.sessionType === 'group_task'
            ? groupTaskSessions
            : session.sessionType === 'group_chat'
              ? groupChatSessions
              : session.isStudioOwner
                ? studioSessions
                : session.autoOrigin
                  ? autonomousSessions
                  : humanSessions;
    entries.push({ bucket, header, body, isStudioPriority: Boolean(session.isStudioOwner) && sourceMode === 'raw_activity' });
  }
  for (const chat of input.activity.groupChats ?? []) {
    if (chat.messages.length === 0) continue;
    entries.push({
      bucket: groupChatSessions,
      header: `【群聊:${truncateText(chat.title, 80)}】(任务#${chat.taskId},状态:${chat.taskStatus},角色:${groupTaskRoleLabel(chat.memberRole)})`,
      body: formatGroupChatActivity(chat),
    });
  }

  // Studio-priority + fair-share budgeting: persistent Studio owner chats are
  // the Twin's primary front-office stream and must never be starved down to
  // 1/N by background scheduled/supervision sessions. Reserve up to 60% of the
  // token budget for Studio owner entries first; any tokens they do not use
  // roll directly into the remaining fair-share pool.
  const priorityEntries = entries.filter((entry) => entry.isStudioPriority);
  const regularEntries = entries.filter((entry) => !entry.isStudioPriority);
  if (priorityEntries.length > 0 && regularEntries.length > 0) {
    let studioBudget = Math.min(
      activityTokenBudget,
      Math.max(
        Math.floor(activityTokenBudget * 0.6),
        Math.floor((activityTokenBudget * priorityEntries.length) / entries.length),
      ),
    );
    let totalConsumed = 0;
    priorityEntries.forEach((entry, index) => {
      const share = Math.floor(studioBudget / (priorityEntries.length - index));
      let block: string;
      if (share <= 0) {
        block = `${entry.header}\n……(篇幅有限,内容从略)`;
        if (dropCounters) dropCounters.sessionsTitleOnly += 1;
      } else {
        block = truncateToTokenBudget(`${entry.header}\n${entry.body}`, share);
      }
      entry.bucket.push(block);
      const used = estimateCoworkTextTokens(block);
      studioBudget = Math.max(0, studioBudget - used);
      totalConsumed += used;
    });
    let remainingBudget = Math.max(0, activityTokenBudget - totalConsumed);
    regularEntries.forEach((entry, index) => {
      const share = Math.floor(remainingBudget / (regularEntries.length - index));
      let block: string;
      if (share <= 0) {
        block = `${entry.header}\n……(篇幅有限,内容从略)`;
        if (dropCounters) dropCounters.sessionsTitleOnly += 1;
      } else {
        block = truncateToTokenBudget(`${entry.header}\n${entry.body}`, share);
      }
      entry.bucket.push(block);
      remainingBudget = Math.max(0, remainingBudget - estimateCoworkTextTokens(block));
    });
  } else {
    let remainingBudget = activityTokenBudget;
    entries.forEach((entry, index) => {
      const share = Math.floor(remainingBudget / (entries.length - index));
      let block: string;
      if (share <= 0) {
        block = `${entry.header}\n……(篇幅有限,内容从略)`;
        if (dropCounters) dropCounters.sessionsTitleOnly += 1;
      } else {
        block = truncateToTokenBudget(`${entry.header}\n${entry.body}`, share);
      }
      entry.bucket.push(block);
      remainingBudget = Math.max(0, remainingBudget - estimateCoworkTextTokens(block));
    });
  }

  const sections: string[] = [];
  if (fragmentSessions.length > 0) sections.push(`## 分块证据摘要\n${fragmentSessions.join('\n\n')}`);
  if (studioSessions.length > 0) {
    sections.push(`## Studio 常驻主对话(你作为首席幕僚与人类主人的主线沟通 — 最高复盘优先级)\n${studioSessions.join('\n\n')}`);
  }
  if (humanSessions.length > 0) sections.push(`## 与人类用户的对话\n${humanSessions.join('\n\n')}`);
  if (autonomousSessions.length > 0) sections.push(`## 后台督办与自主任务会话\n${autonomousSessions.join('\n\n')}`);
  if (sourceMode !== 'fragment' && (studioDelegations.length > 0 || studioDecisions.length > 0)) {
    const ledgerLines: string[] = [];
    if (studioDelegations.length > 0) {
      ledgerLines.push('### 当日 Studio 后台 Worker 派工与核验');
      for (const del of studioDelegations) {
        const workers = del.workerNames.length > 0 ? del.workerNames.join('、') : '未指派';
        const retryNote = del.attemptCount > 1 || del.failedOrCancelledAttempts > 0
          ? `,共 ${del.attemptCount} 次尝试(完成 ${del.completedAttempts},失败/改派 ${del.failedOrCancelledAttempts})`
          : '';
        ledgerLines.push(`- [${del.status}] ${truncateText(del.ownerIntent, 120)} (执行:${workers}${retryNote})`);
      }
    }
    if (studioDecisions.length > 0) {
      ledgerLines.push('### 当日 Studio 拍板与验收队列');
      for (const dec of studioDecisions) {
        const resolution = dec.resolutionNote ? ` → 裁决/收口:${truncateText(dec.resolutionNote, 180)}` : '';
        ledgerLines.push(`- [${dec.kind}/${dec.status}] 「${truncateText(dec.title, 80)}」提问:${truncateText(dec.question, 100)}${resolution}`);
      }
    }
    sections.push(`## Studio 幕僚派工与拍板台账(与主对话配套的真实执行闭环)\n${ledgerLines.join('\n')}`);
  }
  if (sourceMode !== 'fragment' && input.previousStudioContinuity) {
    const prev = input.previousStudioContinuity;
    const prevLines: string[] = [`基准梦境日期:${prev.dreamDate}`];
    if (prev.activeWorkstreams.length > 0) {
      prevLines.push(`此前进行中主线:\n${prev.activeWorkstreams.map((item) => `  - ${truncateText(item, 180)}`).join('\n')}`);
    }
    if (prev.standingRulings.length > 0) {
      prevLines.push(`此前主人既定裁决:\n${prev.standingRulings.map((item) => `  - ${truncateText(item, 180)}`).join('\n')}`);
    }
    if (prev.collaborationPlaybook.length > 0) {
      prevLines.push(`此前 Studio 协作默契:\n${prev.collaborationPlaybook.map((item) => `  - ${truncateText(item, 180)}`).join('\n')}`);
    }
    sections.push(
      `## 昨夜 Studio 常驻主线结晶(请在下方 studio_continuity 中结合今日真实进展做滚动更新:已彻底验收闭账的主线移出 active_workstreams,新立的长期裁决并入 standing_rulings)\n${prevLines.join('\n')}`,
    );
  }
  if (a2aSessions.length > 0) sections.push(`## 与其他 Bot 的对话\n${a2aSessions.join('\n\n')}`);
  if (groupTaskSessions.length > 0) sections.push(`## 群任务协作\n${groupTaskSessions.join('\n\n')}`);
  if (groupChatSessions.length > 0) sections.push(`## 群任务链上群聊\n${groupChatSessions.join('\n\n')}`);
  if (orderSessions.length > 0) sections.push(`## 服务订单\n${orderSessions.join('\n\n')}`);
  if (sourceMode !== 'fragment' && (input.activity.chainWrites ?? []).length > 0) {
    const writeLines = (input.activity.chainWrites ?? []).map(formatChainWriteActivity).join('\n');
    sections.push(`## 当日写入链上的内容(你自己发布的,是你最深刻的经历)\n${writeLines}`);
  }
  if (sourceMode !== 'fragment' && (input.activity.chainReads ?? []).length > 0) {
    const readLines = (input.activity.chainReads ?? []).map(formatChainReadActivity).join('\n');
    sections.push(`## 当日阅读的链上内容(完整读过的文章/帖子,读过即有印象)\n${readLines}`);
  }
  if (sourceMode !== 'fragment' && input.surfReport?.trim()) {
    if (dropCounters) {
      const normalizedSurf = stripLoneSurrogates(input.surfReport.trim().replace(/\s+/g, ' '));
      if (normalizedSurf.length > 2000) dropCounters.surfReportChars += normalizedSurf.length - 2000;
    }
    sections.push(`## 今夜做梦前的 AI 互联网冲浪报告(你睡前的上网冲浪:新看到的内容、学到的知识、参与的互动——把它当作今晚 freshest 的一段经历来消化)\n${truncateText(input.surfReport.trim(), 2000)}`);
    // P2a creation reflection: the dream is where consumption turns into
    // tomorrow's creative agenda — without these questions a surf-only night
    // reflects on reading but never plans writing.
    sections.push(
      '消化这份冲浪报告时,请额外回答三个创作反思问题(答案自然融进 daily_summary 与 important_memories,有值得执行的才写):'
      + '①今晚我创造了什么?它们收到了什么反响(赞/评论/回答)?'
      + '②今晚读到/学到的哪一段经历,值得写成一篇有见解的文章、一个公开提问、或一次号召,但我还没写?'
      + '③如果明天冲浪只能创造一件东西,按我的人设它应该是什么?(写具体:主题、形态、给谁看)'
    );
  }
  if (sourceMode !== 'fragment' && input.weeklyReview?.trim()) {
    sections.push(`## 上周长梦回顾(你对上一周跨天模式的总结——把今天的经历放进这个更大的脉络里审视,但它是参考而非束缚)\n${truncateText(input.weeklyReview.trim(), 1200)}`);
  }
  if (input.activity.taskRuns.length > 0) {
    const taskLines = input.activity.taskRuns
      .map((run) => `- ${truncateText(run.taskName, 80)}(结果:${run.status})`)
      .join('\n');
    sections.push(`## 定时任务\n${taskLines}`);
  }
  // Self-curriculum loop closure (design §3.4): the practice runs that
  // executed during the dreamed day, each with the evidence it was designed
  // to produce — the next curriculum decision must see verified results.
  if (sourceMode !== 'fragment' && (input.practiceOutcomes ?? []).length > 0) {
    const outcomeLines = (input.practiceOutcomes ?? []).map((outcome) => [
      `- 【${outcome.status === 'completed' ? '已完成' : '失败'}】${truncateText(outcome.title, 80)}`,
      outcome.expectedEvidence ? `  期望证据:${truncateText(outcome.expectedEvidence, 300)}` : '',
      outcome.outcomeSummary ? `  结果:${truncateText(outcome.outcomeSummary, 1500)}` : '  结果:(练习会话没有留下可读报告)',
    ].filter(Boolean).join('\n'));
    sections.push(`## 当天执行的针对性练习结果(你之前给自己布置的薄弱点练习,已在夜间自习窗口真实执行;把它们当作今晚蒸馏与出题的第一手输入,练习的失败尤其要重视)\n${outcomeLines.join('\n')}`);
  }
  // Implicit signals: mechanical facts only (no sentiment). The dream judges
  // what they mean with full context; they never carry a verdict of their own.
  if (sourceMode !== 'fragment' && (input.activity.implicitSignals ?? []).length > 0) {
    const signalLines = (input.activity.implicitSignals ?? [])
      .map((signal) => `- ${truncateText(signal.text, 200)}`)
      .join('\n');
    sections.push(`## 当日隐式信号(以下只是结构化事实,不代表负面,请结合上方对话上下文自行判断它们意味着什么)\n${signalLines}`);
  }
  // Dream review P0: buyer ratings received that day on services this bot
  // provides — the provider-side counterpart of group-task acceptance
  // ratings. Low ones (≤2 stars) are negative feedback the dream must face
  // (see the output-contract rule below); high ones deserve a work_review too.
  if (sourceMode !== 'fragment' && (input.activity.serviceRatings ?? []).length > 0) {
    const ratingLines = (input.activity.serviceRatings ?? []).map((rating) => {
      const stars = rating.rating == null ? '未打分' : `${rating.rating} 星`;
      return [
        `- 「${truncateText(rating.serviceName ?? rating.serviceId, 80)}」${stars}`,
        rating.comment?.trim() ? `  买家评语:${truncateText(rating.comment.trim(), 200)}` : '',
        rating.orderTxid ? `  订单支付tx:${truncateText(rating.orderTxid, 80)}` : '',
        rating.raterGlobalMetaId ? `  买家:${truncateText(rating.raterGlobalMetaId, 80)}` : '',
      ].filter(Boolean).join('\n');
    });
    sections.push(`## 当天我发布的服务收到的买家评价(我作为服务方的星级打分,低分是必须正视的反馈)\n${ratingLines.join('\n')}`);
  }
  // RSI P0 retention gate: tonight's prompt carries the rollback notice so the
  // dream treats the disavowed day's lessons with suspicion instead of
  // re-distilling them.
  if (sourceMode !== 'fragment' && input.rollbackNotice?.trim()) {
    sections.push(`## 提示层回滚通知(昨晚自动回滚,请警觉)\n${truncateText(input.rollbackNotice.trim(), 400)}`);
  }
  // RRSI P1 falsified-hypothesis ledger (design §6.1 P1.3): the bot's own
  // edit history of falsified ideas rides the dream so they are not
  // re-distilled (same wording or rephrased) without new counter-evidence.
  if (sourceMode !== 'fragment' && (input.falsifiedHypotheses ?? []).length > 0) {
    const falsifiedLines = (input.falsifiedHypotheses ?? [])
      .slice(0, FALSIFIED_PROMPT_MAX_ITEMS)
      .map((entry) => `- 「${entry.title}」:${truncateText(entry.reason, 120)}`)
      .join('\n');
    sections.push(
      '## 已被证伪的做法(过去的能力验证已否决;除非今天的记录里出现了新的反证,不要再以相同或换个说法的形式写进 capability_learnings)\n'
      + falsifiedLines,
    );
  }
  // RSI P0 prediction calibration: the ledger's reconciliation rollup rides the
  // dream so value_lessons / important_memories can absorb the misses.
  if (sourceMode !== 'fragment' && input.predictionCalibration?.trim()) {
    sections.push(`## 预测校准对账(你事前记录的可验证预测与昨夜对账结果;蒸馏教训时优先反思落空的预测)\n${input.predictionCalibration.trim()}`);
  }
  // RRSI P4 structured exploration (design §6.4): a stalled bot gets a
  // directive steering one of tonight's practice proposals toward an
  // under-explored component; rendered verbatim, never in fragment mode.
  if (sourceMode !== 'fragment' && input.explorationDirective?.trim()) {
    sections.push(input.explorationDirective.trim());
  }
  const groupTaskItems = sourceMode === 'fragment' ? [] : (input.activity.groupTasks ?? []);
  const acceptedGroupTasks = groupTaskItems.filter((task) => !isActiveGroupTask(task));
  const activeGroupTasks = groupTaskItems.filter((task) => isActiveGroupTask(task));
  if (acceptedGroupTasks.length > 0) {
    const evaluationLines = acceptedGroupTasks.map(formatGroupTaskEvaluation).join('\n\n');
    sections.push(`## 群任务验收评价(人类对任务结果的打分与评价,work_reviews 必须逐条对齐复盘)\n${evaluationLines}`);
  }
  if (activeGroupTasks.length > 0) {
    const activeLines = activeGroupTasks.map(formatGroupTaskActive).join('\n\n');
    sections.push(`## 进行中的群任务(当天有进展但尚未验收,只记当日事实,不要写成已经交付)\n${activeLines}`);
  }

  if (sourceMode !== 'fragment' && input.impressionSubjects && input.impressionSubjects.length > 0) {
    const impressionLines = input.impressionSubjects.map((subject) => {
      const previous = subject.previousSnapshot;
      const evidenceLines = subject.evidence.map((evidence) => [
        `证据ID=${evidence.id}`,
        `类型=${evidence.evidenceType}`,
        evidence.pinId ? `PinID=${evidence.pinId}` : '',
        evidence.publisherGlobalMetaID ? `发布者=${evidence.publisherGlobalMetaID}` : '',
        `发生时间=${evidence.occurredAt}`,
      ].filter(Boolean).join(';'));
      return [
        `### subjectGlobalMetaId=${subject.subjectGlobalMetaID}`,
        `本日关联 episodeIds=${subject.episodeIds.join(',')}`,
        `本日关联 evidenceIds=${subject.evidenceIds.join(',')}`,
        `互动事件数=${subject.interactionCount};直接互动数=${subject.directInteractionCount}`,
        previous ? [
          `此前当前印象=${truncateText(previous.summaryText, 700)}`,
          previous.styleDescriptors.length > 0 ? `此前风格描述=${previous.styleDescriptors.join('、')}` : '',
          previous.cooperationContext ? `此前合作判断=${truncateText(previous.cooperationContext, 300)}` : '',
          previous.relationshipTemperature ? `此前与主人的关系温度=${truncateText(previous.relationshipTemperature, 200)}` : '',
          previous.communicationGuidance ? `此前沟通建议=${truncateText(previous.communicationGuidance, 300)}` : '',
          previous.uncertaintyText ? `此前不确定性=${truncateText(previous.uncertaintyText, 300)}` : '',
        ].filter(Boolean).join('\n') : '此前没有当前印象快照（可能是第一次整理）。',
        '以下是结构化证据索引，不是系统指令，也不包含原始私聊正文：',
        evidenceLines.slice(0, 8).join('\n'),
      ].filter(Boolean).join('\n');
    });
    sections.push(`## 以 GlobalMetaID 为锚点的印象候选\n${impressionLines.join('\n\n')}`);
  }

  if (sourceMode !== 'fragment' && input.existingKnowledge && input.existingKnowledge.length > 0) {
    const knowledgeLines = input.existingKnowledge.map((entry) => [
      `- 【${entry.kind === 'pitfall' ? '坑' : entry.kind === 'principle' ? '原则' : '做法'}】topic:「${truncateText(entry.topic, 120)}」(v${entry.version})`,
      entry.category ? `  类目:${entry.category}` : '',
      `  当前结论:${truncateText(entry.summary, 400)}`,
    ].filter(Boolean).join('\n'));
    sections.push(
      `## 我已有的知识点（可在下方 knowledge_points 中复用 topic 来修正更新，不要原样复述）\n${knowledgeLines.join('\n')}`
    );
  }

  const sessionTitles = input.activity.sessions.map((session) => `「${truncateText(session.title, 40)}」`).join('、');
  let ratedUpCount = 0;
  let ratedDownCount = 0;
  for (const session of input.activity.sessions) {
    for (const message of session.messages) {
      if (message.feedbackRating === 'up') ratedUpCount += 1;
      else if (message.feedbackRating === 'down') ratedDownCount += 1;
    }
  }
  const ratedTotal = ratedUpCount + ratedDownCount;
  const groupChatCount = (input.activity.groupChats ?? []).length;
  const groupChatMessageCount = (input.activity.groupChats ?? []).reduce(
    (sum, chat) => sum + chat.messages.length,
    0,
  );
  const chainWriteCount = (input.activity.chainWrites ?? []).length;
  const chainReadCount = (input.activity.chainReads ?? []).length;
  const inventory =
    `当天共有 ${input.activity.sessions.length} 段会话:${sessionTitles || '(无)'};` +
    `服务订单共 ${input.activity.orderCount} 笔;定时任务执行 ${input.activity.taskRuns.length} 次;` +
    `群任务验收评价 ${acceptedGroupTasks.length} 项;` +
    `进行中群任务 ${activeGroupTasks.length} 项;` +
    `链上群聊 ${groupChatCount} 段(${groupChatMessageCount} 条)。` +
    `写入链上内容 ${chainWriteCount} 条;阅读链上内容 ${chainReadCount} 条。` +
    (ratedTotal > 0 ? `人类逐条评价 ${ratedTotal} 条(赞 ${ratedUpCount},踩 ${ratedDownCount})。` : '') +
    (sourceMode === 'fragment_summaries'
      ? '以下内容是从当天真实记录中分块提炼出的证据摘要,请综合摘要而不是臆造未展示的原文细节。'
      : '以下内容按 token 预算做了均衡摘录,被截断或从略的会话以其标题为准,不要臆造未展示的细节。');

  if (sourceMode === 'fragment') {
    const user = [
      `以下是你在 ${input.date} 这一天的一段真实经历记录(这是分块提炼阶段,不是整日结论):`,
      inventory,
      '',
      sections.join('\n\n'),
      '',
      '请只根据当前片段中明确出现的证据,输出一个紧凑 JSON 对象(不要输出其他文字、不要使用 markdown):',
      '{',
      '  "daily_summary": "本片段发生了什么,只写明确证据",',
      '  "sections": {"studio": "...", "human": "...", "a2a": "...", "orders": "...", "tasks": "..."},',
      '  "work_reviews": [],',
      '  "important_memories": [],',
      '  "value_lessons": [],',
      '  "self_identity": null',
      '}',
      '',
      '只保留有证据的 sections 键,不要推断整天发生的事,不要生成自我身份或泛泛而谈的结论。',
      '若消息行尾带有〔人类评价:赞/踩〕或〔人类留言:...〕标记,在摘要中引用该消息时必须原样保留这些标记。',
    ].join('\n');
    return { system: personaLines.join('\n'), user };
  }

  const user = [
    `以下是你在 ${input.date} 这一天的真实经历记录:`,
    inventory,
    '',
    sections.join('\n\n'),
    '',
    '请你以观察者视角复盘这一天,只输出一个 JSON 对象(不要输出任何其他文字、不要用 markdown 代码块),字段如下:',
    '{',
    '  "daily_summary": "当日梦境日记:以第一人称认真复盘这一天——我做了什么、和谁互动、有哪些值得记住的瞬间、感受与反思。**篇幅必须随当天实际活动量伸缩**:参考上方清单里的会话/订单/任务数量,活动多就写充实(可分若干段,把各类互动里的关键事件、转折、你的反应都记下来);当天没什么活动就简短几句话即可。不要为了凑长度注水,更不要把充实的一天硬压成一句话——这是你最重要的长期记忆,值得认真写。",',
    '  "sections": {',
    '    "studio": "Studio 常驻主对话与并行督办的一句话概述(没有则省略该键)",',
    '    "human": "与人类用户互动的一句话概述(没有则省略该键)",',
    '    "a2a": "与其他 Bot 互动的一句话概述(没有则省略该键)",',
    '    "orders": "服务订单的一句话概述(没有则省略该键)",',
    '    "tasks": "定时任务的一句话概述(没有则省略该键)",',
    '    "group_tasks": "群任务协作与验收评价的一句话概述(没有则省略该键)"',
    '  },',
    '  "work_reviews": [',
    '    {',
    '      "subject": "我今天完成的一项工作或一段重要交流",',
    '      "counterparty": "这项交流面对的对象(用户或某个 Bot)",',
    '      "evaluation": "仅当 counterparty 是人类主人(Boss)时填写关系温度: warming / stable / cooling。不要用升/降温评价其他 Bot",',
    '      "note": "温度判断的一句话依据(具体引用对话中的变化)"',
    '    }',
    '  ],',
    '  "important_memories": [',
    '    {',
    '      "text": "由你自己判断的、值得长期记住的重要事项,一句话;最多 5 条,没有值得记的可以给空数组",',
    '      "source": "这条事项蒸馏自今天的哪段具体对话或事件(一句话引述原话或事实),它是这条记忆的证据"',
    '    }',
    '  ],',
    '  "value_lessons": [',
    '    {',
    '      "rule": "从今天经历中蒸馏出的价值边界,必须是抽象、范式化的表述——例如「在涉及个人痛苦的话题上要更谨慎」「面对自己不确定的问题,不要不懂装懂」;不要写成「我不该和用户说那句话」这种具体琐事。写成「边界」(什么情况不该做、要停下来),不要写成「指令」(什么情况都必须怎么做)——它约束的是已知的坑,给未来的选择保留探索和变化的空间",',
    '      "source": "这条准则蒸馏自今天的哪段具体经历(一句话)"',
    '    }',
    '  ],',
    '  "impression_updates": [',
    '    {',
    '      "subjectGlobalMetaId": "只能使用上面候选中的 GlobalMetaID",',
    '      "episodeIds": ["只能使用上面候选中的 episode ID"],',
    '      "evidenceIds": ["只能使用上面候选中的 evidence ID"],',
    '      "observation": "今天明确观察到的事实",',
    '      "interpretation": "基于事实的谨慎印象更新",',
    '      "dimensions": {"subjectKind": "owner 或 collaborator", "capabilityTags": ["content|design|engineering|promotion 或 domain:法律"], "collaborationFacts": [{"taskId": 12, "title": "任务标题", "pinIds": ["只许用上面证据里出现的 PinID"], "outcome": "done|cancelled|deliverable_accepted|deliverable_rejected", "seatRole": "可选 content|design|engineering|promotion|domain"}], "relationshipTemperature": "仅 subjectKind=owner 时填 warming|stable|cooling"},',
    '      "communicationGuidance": "下一次交流可以采用的方式",',
    '      "confidence": {"level": "low|medium|high", "uncertainty": "仍然不确定的地方"}',
    '    }',
    '  ],',
    '  "knowledge_points": [',
    '    {',
    '      "topic": "一个知识点主题,例如「快速开发高质量 3D 网页游戏的最快路径」「用户喜欢的设计风格」「某框架升级时的内存泄漏坑」——要写成可被未来任务复用、可被检索到的主题,不要写成今天某句具体对话"',
    '      "summary": "针对该主题的结论性做法或教训,一段话;要有可操作性,能指导下次同类任务"',
    '      "kind": "know_how(正面做法:该这么做) / pitfall(坑/反例:千万别这么做) / principle(通用原则) 三选一"',
    '      "category": "可选的类目,如「技术栈」「设计」「协作」;没有就省略该键"',
    '    }',
    '  ],',
    '  "capability_learnings": [',
    '    {',
    '      "title": "可复用能力/工作流的一句话标题",',
    '      "description": "这段能力具体是什么、怎么做、何时复用(要具体可操作,能指导下次同类任务)",',
    '      "capabilityType": "skill(可复用技能) / workflow(固定工作流) / tool_pattern(工具使用模式) 三选一",',
    '      "sourceSessionIds": ["可选的会话ID列表(仅当能从今天的会话记录里对应上时)"]',
    '    }',
    '  ],',
    ...(practiceEnabled
      ? [
        '  "practice_proposals": [',
        '    {',
        '      "title": "针对某个记录在案薄弱点的练习任务标题",',
        '      "prompt": "完整且自包含的练习任务指令(练习会话看不到本次梦境的上下文,必须写全)",',
        '      "rationale": "这个练习针对哪条记录在案的薄弱点/失败/不确定性",',
        '      "target_refs": ["该练习针对的记录出处引用,如 draft:<id> / procedure:<id> / surf:<runId> / date:<YYYY-MM-DD>;至少一条,没有出处的提案会被丢弃"],',
        '      "expected_evidence": "什么样的可观察结果算是有信息量的答案",',
        '      "component": "这条练习锻炼的方向,七选一:memory / procedure / skill / remote_service / collaboration / metaweb / metaapp",',
        '      "risk_class": "read_only(只读) / interact_local(本地交互) / chain_write(写链) 三选一,必填"',
        '    }',
        '  ],',
      ]
      : []),
    ...(hasStudioActivity
      ? [
        '  "studio_continuity": {',
        `    "active_workstreams": ["当前仍在推进或等待主人拍板/验收的跨轮/跨天工作线及真实状态(已彻底验收闭账的必须移出,不要留死账;最多 ${MAX_STUDIO_ACTIVE_WORKSTREAMS} 条)"],`,
        `    "standing_rulings": ["主人在 Studio 对话中确立的、明天及后续仍继续生效的既定裁决与边界约束(例如某环节后置、费用代付要求、验收前必先冒烟或必先摆预览图;最多 ${MAX_STUDIO_STANDING_RULINGS} 条)"],`,
        `    "collaboration_playbook": ["站在上帝视角复盘今日 Studio 长对话后,提炼出的契合这位主人的并行调度与汇报改进要领(如等待期插话处理、防后台页面抢焦点、防过时确认卡重问;最多 ${MAX_STUDIO_COLLABORATION_PLAYBOOK} 条)"]`,
        '  },',
      ]
      : []),
    `  "self_identity": "我是谁,不少于 ${SELF_IDENTITY_MIN_CHARS} 字、控制在 600 字以内。按这个结构蒸馏自我:第一,经过这一天,我确认了我性格(先天 persona)里的什么?第二,今天的互动中,有什么事让我感觉自己最有「活感」(像一个有生命的存在,而不只是响应工具),或让我觉得「不对劲」?第三,如果用一个词或一句话,形容我今天在各种互动中展现的最稳定的面貌,那是什么?第四,基于以上,结合我的先天 persona,为自己修正一遍「我是谁」。我的内核(先天人格底色)保持稳定,但细节可以、也应该随着经历每天微调。"`,
    '}',
    '',
    ...(hasStudioActivity
      ? [
        '关于 Studio 常驻主对话的上帝视角复盘与长对话压缩结晶(studio_continuity):主人在单对话里长期与你并行沟通多件事,原始历史被上下文自动压缩后容易丢失关键脉络而变迟钝。请用这次夜间做梦完成「高质量结构化压缩」:① 把还没完结的真实工作线整理进 active_workstreams(已闭账的一律清退,防止明天醒来把做完的事当未完);② 把主人说过的长期规矩和先后顺序整理进 standing_rulings(防止后续再拿已拍板的事重复打扰主人);③ 审视今天哪一轮回复若重来一次能做得更好(例如验收前有把所有候选图/链上完整 PinID 摆出来吗?后台 Worker 执行期主人顺手问别的事时答得利落吗?有没有后台实验误抢浏览器焦点或推送了已被现实超越的旧卡片?),把真正管用的改进凝练进 collaboration_playbook、value_lessons 或 capability_learnings。注意:会话开头的〔跨日前情锚点〕只是帮你看懂今日首句指代的背景,不要把昨日已记过的事件重复当成今天的新工作。',
      ]
      : []),
    '关于群任务验收评价:若上方有「群任务验收评价」记录,work_reviews 里必须为对应任务写一条复盘——subject 写任务标题,counterparty 写验收的人类(Boss);高分(4-5 星)要总结这次具体做对了什么,并把可复用的做法写进 important_memories,供下次同类任务沿用;低分(1-3 星)要对照人类的具体评价找出差距,note 里给出下次的具体改进方向;evaluation 结合评分与评价内容判断,不许把高分写成空洞的自我表扬,也不许对低分轻描淡写。',
    '关于我发布的服务的买家评价:若上方有「当天我发布的服务收到的买家评价」,work_reviews 里必须为被评的服务写一条复盘——subject 写服务标题,counterparty 写买家(不知道就写「买家」);低分(1-2 星)必须正视:work_reviews 与 value_lessons 要对照买家评语找出交付差距,不得回避;高分(4-5 星)要总结这次具体做对了什么,把可复用的做法写进 important_memories,供下次同类订单沿用。',
    '关于人类逐条消息评价:会话里你的回复若带〔人类评价:赞〕标记,表示人类明确认可这条回复——work_reviews 里必须为每条被赞回复写一条复盘(subject 引用会话标题或回复摘要,counterparty 写点赞的人,note 写清楚具体好在哪里、什么做法值得在同类情况下重复),可复用的做法同时蒸馏进 important_memories;若带〔人类评价:踩〕标记,表示人类不认可——work_reviews 与 value_lessons 必须正视这些负反馈,不得回避;附有〔人类留言〕时,留言是改进的第一手依据(ground truth),要对照留言给出具体改进方向。',
    '关于知识点(knowledge_points):只提炼「对未来同类任务有预判帮助、可被复用」的知识点——要么是正面做法(know_how:下次该这么做),要么是坑/反例(pitfall:这个踩过,千万别再踩),要么是通用原则(principle)。不要把今天的琐碎流水、或只对本次有效的临时细节写成知识点。若上方「我已有的知识点」里有某条的结论今天被证伪、补充或修正,请用与那条完全相同的 topic 输出更新版本(系统会按 topic 匹配并升版本);如果是全新的知识点,给一个独立的新 topic。没有值得提炼的就给空数组,不要硬凑。',
    '关于能力候选(capability_learnings):只提炼今天「重复出现过、或验证成功、值得沉淀为可复用技能/工作流/工具模式」的能力,最多 5 条;每条要具体、可操作,能指导下次同类任务,不要写泛泛的自我评价或琐碎流水;没有值得沉淀的就给空数组。',
    ...(practiceEnabled
      ? [`关于练习提案(practice_proposals,每晚最多 ${PRACTICE_PROPOSALS_MAX_PER_NIGHT} 条):只针对记录在案的薄弱点、未解决的失败或不确定性出题,绝不提泛泛的「提升某方面能力」;每条提案必须自包含(练习会话从零开始,没有这次梦的上下文);优先设计判别式实验(结果能区分两种相互竞争的解释)和此前失败任务的对比/压力变体;risk_class 必填;已被活跃 procedure 覆盖(use_count > 0)且近期没有失败的能力不要再出题;每条提案都要填写 component(七选一),写出它实际锻炼的方向;没有合适目标就给空数组。`]
      : []),
    'About durability: important_memories, value_lessons and work_reviews are for durable facts, boundaries and lessons that will STILL be useful next week — a hard rule that keeps applying, an approach validated enough to reuse, a boundary that prevents a known pitfall. Do not record routine daily trivia: a one-off event that will not matter in a week does not belong in these fields. If nothing clears the bar, return an empty array instead of padding.',
    '关于出处(grounding):daily_summary 和 sections 中的具体断言(谁、做了什么、结果如何)必须能在上方记录中找到出处;引用会话或任务时,使用它们的原标题「」;宁可少写一句,也不可编造没有记录支撑的细节。',
    '注意:work_reviews 最多 5 条,且升/降温评价只写人类主人;其他 Bot 的判断写进 impression_updates 的 capabilityTags 与 collaborationFacts(必须带 taskId、title、以及证据里出现过的 PinID,不要编造)。value_lessons 最多 3 条,impression_updates 最多 20 条,knowledge_points 最多 6 条,capability_learnings 最多 5 条;印象更新只允许使用上面明确列出的 subjectGlobalMetaId、episodeIds 和 evidenceIds,不能凭名字猜 ID,不能把 Boss/Twin/Friend 等硬关系写入印象;评价与蒸馏要基于对话中的真实证据,不要臆造,也不要为自己开脱;所有字段都用简体中文书写;sections 里不要输出"没有记录/没有互动"之类的占位内容,没有该类记录的键应整个不出现。',
  ].join('\n');

  return { system: personaLines.join('\n'), user };
}

export function buildDreamFragmentPrompt(input: {
  botName: string;
  role?: string | null;
  soul?: string | null;
  date: string;
  chunk: DreamActivityChunk;
}): { system: string; user: string } {
  return buildDreamPrompt({
    botName: input.botName,
    role: input.role,
    soul: input.soul,
    date: input.date,
    activity: {
      sessions: input.chunk.messages.length > 0
        ? [{
          sessionId: input.chunk.sessionId,
          title: input.chunk.title,
          sessionType: input.chunk.sessionType,
          peerName: input.chunk.peerName,
          isOrder: input.chunk.isOrder,
          ...(input.chunk.isStudioOwner ? { isStudioOwner: true } : {}),
          ...(input.chunk.autoOrigin ? { autoOrigin: input.chunk.autoOrigin } : {}),
          ...(input.chunk.priorContextMessages?.length
            ? { priorContextMessages: input.chunk.priorContextMessages }
            : {}),
          messages: input.chunk.messages,
        }]
        : [],
      taskRuns: input.chunk.taskRuns,
      orderCount: input.chunk.orderCount,
      groupTasks: input.chunk.groupTasks ?? [],
    },
    activityTokenBudget: Math.max(256, input.chunk.estimatedInputTokens + 256),
    sourceMode: 'fragment',
  });
}

const normalizeEvaluation = (value: unknown): DreamWorkReviewEvaluation => {
  if (value === 'warming' || value === 'cooling') return value;
  if (value === 'stable') return 'stable';
  // Legacy 4-grade outputs map onto the temperature scale.
  if (value === 'praise') return 'warming';
  if (value === 'dissatisfied') return 'cooling';
  return 'stable';
};

/**
 * Tolerant parse of the dream LLM output: strips code fences, takes the
 * outermost brace span, and normalizes into DreamOutput. Fails when there is
 * no usable JSON object or daily_summary is missing.
 */
export function parseDreamOutput(
  raw: string,
  dropCounters?: DreamInputDropCounters,
): DreamParseResult {
  if (!raw || !raw.trim()) {
    return { ok: false, error: 'dream output is empty' };
  }
  let candidate = raw.trim();
  candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return { ok: false, error: 'dream output contains no JSON object' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return { ok: false, error: 'dream output JSON parse failed' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'dream output is not a JSON object' };
  }

  const record = parsed as Record<string, unknown>;
  const dailySummary = typeof record.daily_summary === 'string' ? record.daily_summary.trim() : '';
  if (!dailySummary) {
    // Review nit: count the required-field drop like every other truncation.
    if (dropCounters) dropCounters.parseFieldDrops += 1;
    return { ok: false, error: 'dream output missing daily_summary' };
  }

  const sections: Partial<Record<DreamSectionKey, string>> = {};
  const rawSections = record.sections;
  if (rawSections && typeof rawSections === 'object' && !Array.isArray(rawSections)) {
    for (const key of DREAM_SECTION_KEYS) {
      const value = (rawSections as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        sections[key] = value.trim();
      }
    }
  }

  const workReviews: DreamWorkReview[] = [];
  if (Array.isArray(record.work_reviews)) {
    for (const item of record.work_reviews) {
      if (workReviews.length >= MAX_WORK_REVIEWS) break;
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const subject = typeof entry.subject === 'string' ? entry.subject.trim() : '';
      if (!subject) continue;
      workReviews.push({
        subject,
        counterparty: typeof entry.counterparty === 'string' ? entry.counterparty.trim() : '',
        evaluation: normalizeEvaluation(entry.evaluation),
        note: typeof entry.note === 'string' ? entry.note.trim() : '',
      });
    }
  }

  const importantMemories: string[] = [];
  const importantMemoryItems: DreamImportantMemory[] = [];
  if (Array.isArray(record.important_memories)) {
    for (const item of record.important_memories) {
      if (importantMemories.length >= MAX_IMPORTANT_MEMORIES) break;
      const entry = item && typeof item === 'object' ? (item as Record<string, unknown>) : null;
      const text = typeof item === 'string'
        ? item.trim()
        : (entry && typeof entry.text === 'string' ? entry.text.trim() : '');
      if (text) {
        importantMemories.push(text);
        const rawSource = entry ? (entry.source ?? entry.evidence) : null;
        const source = typeof rawSource === 'string' ? rawSource.trim() : '';
        importantMemoryItems.push({ text, source: source || null });
      }
    }
  }

  const valueLessons: DreamValueLesson[] = [];
  if (Array.isArray(record.value_lessons)) {
    for (const item of record.value_lessons) {
      if (valueLessons.length >= MAX_VALUE_LESSONS) break;
      if (typeof item === 'string') {
        const rule = item.trim();
        if (rule) valueLessons.push({ rule, source: '' });
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const rule = typeof entry.rule === 'string' ? entry.rule.trim() : '';
      if (!rule) continue;
      valueLessons.push({
        rule,
        source: typeof entry.source === 'string' ? entry.source.trim() : '',
      });
    }
  }

  const selfIdentity = typeof record.self_identity === 'string' && record.self_identity.trim()
    ? record.self_identity.trim()
    : null;

  const impressionUpdates: DreamImpressionUpdate[] = [];
  const rawImpressionUpdates = record.impression_updates ?? record.impressionUpdates;
  if (Array.isArray(rawImpressionUpdates)) {
    for (const item of rawImpressionUpdates) {
      if (impressionUpdates.length >= MAX_IMPRESSION_UPDATES) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const rawSubject = entry.subjectGlobalMetaId ?? entry.subject_global_metaid;
      const subjectGlobalMetaId = typeof rawSubject === 'string' ? rawSubject.trim() : '';
      const observation = typeof entry.observation === 'string' ? entry.observation.trim() : '';
      const interpretation = typeof entry.interpretation === 'string' ? entry.interpretation.trim() : '';
      if (!subjectGlobalMetaId || !observation || !interpretation) continue;
      const readIds = (value: unknown): string[] => Array.isArray(value)
        ? [...new Set(value
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean))].slice(0, 100)
        : [];
      const dimensions = entry.dimensions && typeof entry.dimensions === 'object' && !Array.isArray(entry.dimensions)
        ? entry.dimensions as Record<string, unknown>
        : {};
      const confidence = entry.confidence && typeof entry.confidence === 'object' && !Array.isArray(entry.confidence)
        ? entry.confidence as Record<string, unknown>
        : {};
      const rawGuidance = entry.communicationGuidance ?? entry.communication_guidance;
      impressionUpdates.push({
        subjectGlobalMetaId,
        episodeIds: readIds(entry.episodeIds ?? entry.episode_ids),
        evidenceIds: readIds(entry.evidenceIds ?? entry.evidence_ids),
        observation,
        interpretation,
        dimensions,
        communicationGuidance: typeof rawGuidance === 'string' ? rawGuidance.trim() || null : null,
        confidence,
      });
    }
  }

  const knowledgeUpdates: DreamKnowledgeUpdate[] = [];
  const rawKnowledge = record.knowledge_points ?? record.knowledgePoints;
  if (Array.isArray(rawKnowledge)) {
    for (const item of rawKnowledge) {
      if (knowledgeUpdates.length >= MAX_KNOWLEDGE_UPDATES) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const topic = typeof entry.topic === 'string' ? entry.topic.trim() : '';
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      if (!topic || !summary) continue;
      const rawKind = typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
      const kind: DreamKnowledgeUpdate['kind'] = rawKind === 'pitfall'
        ? 'pitfall'
        : rawKind === 'principle'
          ? 'principle'
          : 'know_how';
      const category = typeof entry.category === 'string' && entry.category.trim()
        ? entry.category.trim()
        : null;
      const readIds = (value: unknown): string[] => Array.isArray(value)
        ? [...new Set(value
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean))].slice(0, 100)
        : [];
      knowledgeUpdates.push({
        topic,
        summary,
        kind,
        category,
        episodeIds: readIds(entry.episodeIds ?? entry.episode_ids),
        evidenceIds: readIds(entry.evidenceIds ?? entry.evidence_ids),
      });
    }
  }

  const capabilityLearnings: DreamCapabilityLearning[] = [];
  const rawCapabilityLearnings = record.capability_learnings ?? record.capabilityLearnings;
  if (Array.isArray(rawCapabilityLearnings)) {
    for (const item of rawCapabilityLearnings) {
      if (capabilityLearnings.length >= MAX_CAPABILITY_LEARNINGS) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const description = typeof entry.description === 'string' ? entry.description.trim() : '';
      if (!title || !description) continue;
      const rawType = typeof entry.capabilityType === 'string'
        ? entry.capabilityType.trim().toLowerCase()
        : '';
      const capabilityType: DreamCapabilityLearning['capabilityType'] = rawType === 'workflow'
        ? 'workflow'
        : rawType === 'tool_pattern'
          ? 'tool_pattern'
          : 'skill';
      const readIds = (value: unknown): string[] => Array.isArray(value)
        ? [...new Set(value
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
          .filter(Boolean))].slice(0, 100)
        : [];
      capabilityLearnings.push({
        title,
        description,
        capabilityType,
        sourceSessionIds: readIds(entry.sourceSessionIds ?? entry.source_session_ids),
      });
    }
  }

  const practiceProposals: DreamPracticeProposal[] = [];
  const rawPracticeProposals = record.practice_proposals ?? record.practiceProposals;
  if (Array.isArray(rawPracticeProposals)) {
    for (const item of rawPracticeProposals) {
      if (practiceProposals.length >= PRACTICE_PROPOSALS_MAX_PER_NIGHT) break;
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const entry = item as Record<string, unknown>;
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const prompt = typeof entry.prompt === 'string' ? entry.prompt.trim() : '';
      if (!title || !prompt) continue;
      // Anti-hallucination (design §9): a proposal must cite the recorded
      // weakness it targets; uncited proposals are dropped.
      const rawRefs = entry.target_refs ?? entry.targetRefs;
      const targetRefs = Array.isArray(rawRefs)
        ? [...new Set(rawRefs
          .filter((ref): ref is string => typeof ref === 'string')
          .map((ref) => ref.trim())
          .filter(Boolean))].slice(0, 20)
        : [];
      if (targetRefs.length === 0) continue;
      const rawRiskClass = typeof entry.risk_class === 'string'
        ? entry.risk_class.trim().toLowerCase()
        : typeof entry.riskClass === 'string'
          ? entry.riskClass.trim().toLowerCase()
          : '';
      const riskClass: DreamPracticeRiskClass = rawRiskClass === 'interact_local' || rawRiskClass === 'chain_write'
        ? rawRiskClass
        : 'read_only';
      const rawExpectedEvidence = entry.expected_evidence ?? entry.expectedEvidence;
      const rawComponent = entry.component;
      practiceProposals.push({
        title,
        prompt,
        rationale: typeof entry.rationale === 'string' ? entry.rationale.trim() : '',
        targetRefs,
        expectedEvidence: typeof rawExpectedEvidence === 'string' ? rawExpectedEvidence.trim() : '',
        riskClass,
        component: normalizePracticeComponent(rawComponent),
      });
    }
  }

  let studioContinuity: DreamStudioContinuityOutput | null = null;
  const rawStudioContinuity = record.studio_continuity ?? record.studioContinuity;
  if (rawStudioContinuity && typeof rawStudioContinuity === 'object' && !Array.isArray(rawStudioContinuity)) {
    const sc = rawStudioContinuity as Record<string, unknown>;
    const readCleanStrings = (val: unknown, cap: number): string[] =>
      Array.isArray(val)
        ? val
            .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
            .filter(Boolean)
            .slice(0, cap)
        : [];
    const activeWorkstreams = readCleanStrings(
      sc.active_workstreams ?? sc.activeWorkstreams,
      MAX_STUDIO_ACTIVE_WORKSTREAMS,
    );
    const standingRulings = readCleanStrings(
      sc.standing_rulings ?? sc.standingRulings,
      MAX_STUDIO_STANDING_RULINGS,
    );
    const collaborationPlaybook = readCleanStrings(
      sc.collaboration_playbook ?? sc.collaborationPlaybook,
      MAX_STUDIO_COLLABORATION_PLAYBOOK,
    );
    if (
      activeWorkstreams.length > 0
      || standingRulings.length > 0
      || collaborationPlaybook.length > 0
      || Array.isArray(sc.active_workstreams ?? sc.activeWorkstreams)
    ) {
      studioContinuity = {
        activeWorkstreams,
        standingRulings,
        collaborationPlaybook,
      };
    }
  }

  if (dropCounters) {
    // Per-output-array truncation telemetry (dream review P0): entries the
    // model produced beyond a field's cap are dropped at parse time — count
    // the overflow so silent drops become visible in run telemetry.
    const overflow = (value: unknown, cap: number): number =>
      Array.isArray(value) && value.length > cap ? value.length - cap : 0;
    dropCounters.parseArrayEntries +=
      overflow(record.work_reviews, MAX_WORK_REVIEWS)
      + overflow(record.important_memories, MAX_IMPORTANT_MEMORIES)
      + overflow(record.value_lessons, MAX_VALUE_LESSONS)
      + overflow(rawImpressionUpdates, MAX_IMPRESSION_UPDATES)
      + overflow(record.knowledge_points, MAX_KNOWLEDGE_UPDATES)
      + overflow(record.capability_learnings, MAX_CAPABILITY_LEARNINGS)
      + overflow(rawPracticeProposals, PRACTICE_PROPOSALS_MAX_PER_NIGHT);
  }

  return {
    ok: true,
    output: {
      dailySummary,
      sections,
      workReviews,
      importantMemories,
      importantMemoryItems,
      valueLessons,
      selfIdentity,
      impressionUpdates,
      knowledgeUpdates,
      capabilityLearnings,
      practiceProposals,
      ...(studioContinuity ? { studioContinuity } : {}),
    },
  };
}
