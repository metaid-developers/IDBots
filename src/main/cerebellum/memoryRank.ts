/**
 * Cerebellum (小脑) memory re-ranker — the first real call site of the
 * optional fast decision model (TypeSafe JEV, POST {baseUrl}/v1/systemone).
 *
 * One request carries one state (the current user message + the candidate
 * memory pool) and one Noul question per candidate: each question asks
 * whether that memory is useful context for replying to the current message,
 * and the returned noul probability (0..1) becomes the entry's relevance
 * score downstream.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: rankMemoriesWithCerebellum NEVER throws and returns null
 * on HTTP errors, network errors, abort/timeout, malformed payloads, and
 * INCOMPLETE answer coverage (below CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE) —
 * a partial score map would rank unscored entries' lexical scores (>= 1)
 * above every scored entry's noul (<= 1), so an incomplete answer set falls
 * back to lexical as a whole instead of mixing scales.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';

/**
 * Minimal structural subset of fetch. Both Electron's session.fetch and
 * Node's global fetch satisfy it; tests inject fakes.
 */
export type CerebellumFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Per-turn prompt assembly must never stall on the cerebellum: one ranking
 * call gets a hard abort deadline, after which the turn proceeds with the
 * lexical ranking.
 */
export const CEREBELLUM_MEMORY_RANK_TIMEOUT_MS = 2500;

/**
 * Candidate cap for one /v1/systemone request — state size and question
 * count both scale linearly with the pool. Candidates beyond the cap keep
 * their lexical score downstream (they are simply absent from the score map).
 * Historically 200; tightened to 30 with the prefilter below after a heavy
 * user burned the weekly JEV pool on ~7.8k-token average calls.
 */
export const CEREBELLUM_MEMORY_MAX_CANDIDATES = 30;

/**
 * Recency window for the cheap prefilter: only the N most recently used pool
 * entries ever compete for the semantic round. The caller's pool arrives
 * last-used-DESC, so "recently used" is simply pool order. Entries outside
 * the window keep their lexical score downstream, exactly like entries past
 * the candidate cap.
 */
export const CEREBELLUM_MEMORY_PREFILTER_WINDOW = 60;

/**
 * Per-memory text cap applied before the state budget is summed: one long
 * memory must not eat the whole payload.
 */
export const CEREBELLUM_MEMORY_TEXT_MAX_CHARS = 800;

/**
 * Total char budget across every selected memory text (~4k tokens). Selection
 * stops at the first entry that would overflow, dropping from the
 * least-relevant end (the tail of the prefilter order).
 */
export const CEREBELLUM_MEMORY_STATE_MAX_CHARS = 12000;

/**
 * Cap for `state.current_message`: a huge pasted message would otherwise ride
 * the ranking payload unbounded. A 4k-char prefix keeps plenty of signal.
 */
export const CEREBELLUM_MEMORY_CURRENT_MESSAGE_MAX_CHARS = 4000;

/**
 * Below this combined pool size the lexical ranker is already adequate and a
 * cerebellum round-trip is not worth its latency — skip the call entirely.
 */
export const CEREBELLUM_MEMORY_MIN_POOL = 12;

/**
 * Minimum share of asked questions that must come back with a usable noul.
 * Below this the whole ranking is discarded (null) rather than mixed with
 * lexical scores, whose scale (>= 1) sits above every noul (<= 1).
 */
export const CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE = 0.8;

export interface CerebellumMemoryCandidate {
  id: string;
  text: string;
}

/**
 * Local UTF-16-unit prefix cut (same semantics as truncateUtf16Units in
 * libs/llmSafeText, inlined so this module stays free of runtime imports —
 * unit tests load it directly with Node type stripping, which requires
 * extension-ful ESM specifiers; type-only imports are erased and safe).
 */
function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Cheap lexical signal for the prefilter: tokens of the current message that
 * also occur in a candidate text. ASCII words (>= 2 chars) plus CJK bigrams,
 * lowercased. This is only a BOOST inside the recency window — it can reorder
 * the window but never reaches beyond it, so semantically relevant memories
 * with zero keyword overlap still ride the window's recency slots instead of
 * being filtered out outright.
 */
function lexicalOverlapScore(memoryText: string, messageTokens: ReadonlySet<string>): number {
  if (messageTokens.size === 0) return 0;
  const haystack = memoryText.toLowerCase();
  let score = 0;
  for (const token of messageTokens) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
}

function extractMessageTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z0-9]{2,}/g)) {
    tokens.add(match[0]);
  }
  for (const run of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const chars = run[0];
    for (let index = 0; index + 1 < chars.length; index += 1) {
      tokens.add(chars.slice(index, index + 2));
    }
    if (chars.length === 1) tokens.add(chars);
  }
  return tokens;
}

/** Payload accounting surfaced to the caller's debug log (counts/chars only). */
export interface CerebellumMemoryPayloadStats {
  /** Raw pool size handed to the ranker. */
  poolSize: number;
  /** Candidates actually sent after prefilter + budget. */
  sent: number;
  /** Sum of the sent memory texts' lengths (chars). */
  memoriesChars: number;
  /** Length of the (capped) current_message actually sent. */
  currentMessageChars: number;
  /** Length of the serialized questions object (chars) — the second linear term. */
  questionsChars: number;
  /** Length of the whole serialized request body (chars). */
  totalChars: number;
}

/**
 * Client-side prefilter that bounds one ranking payload: recency window
 * (pool order is last-used-DESC) -> lexical-overlap boost within the window
 * (stable, recency breaks ties) -> per-entry truncation -> total char budget
 * -> candidate cap. Pure; empty pool yields an empty selection; never throws.
 */
export function selectMemoryRankCandidates(
  memories: readonly CerebellumMemoryCandidate[],
  currentUserText: string,
): CerebellumMemoryCandidate[] {
  if (memories.length === 0) return [];
  const window = memories.slice(0, CEREBELLUM_MEMORY_PREFILTER_WINDOW);
  const messageTokens = extractMessageTokens(currentUserText);
  const ordered = window
    .map((memory, index) => ({ memory, index, score: lexicalOverlapScore(memory.text, messageTokens) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const selected: CerebellumMemoryCandidate[] = [];
  let totalChars = 0;
  for (const entry of ordered) {
    if (selected.length >= CEREBELLUM_MEMORY_MAX_CANDIDATES) break;
    const text = truncateUtf16Prefix(entry.memory.text, CEREBELLUM_MEMORY_TEXT_MAX_CHARS);
    if (totalChars + text.length > CEREBELLUM_MEMORY_STATE_MAX_CHARS) break;
    totalChars += text.length;
    selected.push({ id: entry.memory.id, text });
  }
  return selected;
}

/**
 * Noul instruction template for the per-memory relevance question. ONE
 * template so the wording stays tunable in a single place; `{{INDEX}}` is
 * replaced with the candidate's position in `state.memories`. Instructions
 * are in English per TypeSafe's English-primary guidance and reference state
 * fields by backticked dot-index path; the state itself carries the user's
 * original (often Chinese) text.
 */
export const CEREBELLUM_MEMORY_RANK_INSTRUCTIONS =
  'Would the memory at `memories[{{INDEX}}].text` be useful context for the assistant ' +
  "when replying to the user's current message at `current_message`? " +
  'Useful means the memory contains a durable fact, preference, commitment, or prior ' +
  'instruction about the user that is relevant to this specific message — not merely ' +
  'shared keywords.';

export const CEREBELLUM_MEMORY_RANK_CRITERIA = {
  true: 'Replying to the current message would be noticeably better with this memory in context.',
  false: 'This memory is unrelated to the current message, or only shares surface words.',
} as const;

export interface CerebellumNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface CerebellumMemoryRankRequest {
  state: {
    current_message: string;
    memories: CerebellumMemoryCandidate[];
  };
  model: string;
  questions: Record<string, CerebellumNoulQuestion>;
}

export function cerebellumMemoryQuestionId(index: number): string {
  return `mem_${index}`;
}

/** One Noul question per candidate memory, all evaluated against the same state. */
export function buildMemoryRankQuestions(count: number): Record<string, CerebellumNoulQuestion> {
  const questions: Record<string, CerebellumNoulQuestion> = {};
  for (let index = 0; index < count; index += 1) {
    questions[cerebellumMemoryQuestionId(index)] = {
      type: 'noul',
      instructions: CEREBELLUM_MEMORY_RANK_INSTRUCTIONS.replaceAll('{{INDEX}}', String(index)),
      criteria: { ...CEREBELLUM_MEMORY_RANK_CRITERIA },
    };
  }
  return questions;
}

export function buildMemoryRankRequest(input: {
  currentUserText: string;
  memories: CerebellumMemoryCandidate[];
  model: string;
}): CerebellumMemoryRankRequest {
  const memories = input.memories.map((memory) => ({ id: memory.id, text: memory.text }));
  return {
    state: {
      current_message: truncateUtf16Prefix(input.currentUserText, CEREBELLUM_MEMORY_CURRENT_MESSAGE_MAX_CHARS),
      memories,
    },
    model: input.model,
    questions: buildMemoryRankQuestions(memories.length),
  };
}

/**
 * Map answers back to memory ids: `answers[mem_<i>]` belongs to
 * `memories[i]`. Missing, non-object, or non-numeric-noul answers are
 * skipped — those ids simply keep their lexical score downstream. Returns
 * null only when the payload shape itself is unusable (no `answers` object).
 */
export function parseMemoryRankAnswers(
  payload: unknown,
  memories: readonly CerebellumMemoryCandidate[],
): Map<string, number> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') {
    return null;
  }
  const scores = new Map<string, number>();
  for (let index = 0; index < memories.length; index += 1) {
    const answer = (answers as Record<string, unknown>)[cerebellumMemoryQuestionId(index)];
    if (!answer || typeof answer !== 'object') {
      continue;
    }
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      continue;
    }
    scores.set(memories[index].id, noul);
  }
  return scores;
}

export async function rankMemoriesWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  memories: CerebellumMemoryCandidate[];
  timeoutMs?: number;
  /** Debug hook: payload accounting (counts/chars only, never memory text). */
  onPayload?: (stats: CerebellumMemoryPayloadStats) => void;
}): Promise<Map<string, number> | null> {
  const { config, fetchImpl, currentUserText } = input;
  const memories = selectMemoryRankCandidates(input.memories, currentUserText);
  if (!currentUserText.trim() || memories.length === 0) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_MEMORY_RANK_TIMEOUT_MS),
  );
  try {
    const request = buildMemoryRankRequest({
      currentUserText,
      memories,
      model: config.model,
    });
    const body = JSON.stringify(request);
    input.onPayload?.({
      poolSize: input.memories.length,
      sent: memories.length,
      memoriesChars: memories.reduce((sum, memory) => sum + memory.text.length, 0),
      currentMessageChars: request.state.current_message.length,
      questionsChars: JSON.stringify(request.questions).length,
      totalChars: body.length,
    });
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const scores = parseMemoryRankAnswers(await response.json(), memories);
    if (scores === null) {
      return null;
    }
    // Incomplete coverage must not reach the merger: unscored entries would
    // keep lexical scores (>= 1) and outrank every noul (<= 1).
    if (scores.size < memories.length * CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE) {
      return null;
    }
    return scores;
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller falls back to lexical ranking silently.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
