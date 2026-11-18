/**
 * Cerebellum (小脑) knowledge hot-layer re-ranker — roadmap #4.
 *
 * The hot layer injects at most 8 knowledge points. Without this ranker the
 * runner asks the store for the newest 8 (`updated_at DESC`) and older
 * points that actually apply to the current message never surface. One
 * /v1/systemone request scores a wider newest-N pool with one Noul per
 * point; the returned probabilities replace recency as the rank key.
 * A null result leaves the newest-8 path untouched.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. Executors in the app obtain that fetch
 * from resolveCerebellumCallContext (Electron net stack, or the free-relay
 * key-retry wrapper).
 *
 * Failure contract: rankKnowledgeWithCerebellum NEVER throws and returns
 * null on HTTP errors, network errors, abort/timeout, malformed payloads,
 * and INCOMPLETE answer coverage (below CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE).
 * A partial score map would sink every unscored point below every noul, so
 * an incomplete answer set falls back to recency as a whole.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/** Same hard abort deadline as the other per-turn cerebellum calls. */
export const CEREBELLUM_KNOWLEDGE_RANK_TIMEOUT_MS = 2500;

/**
 * How many newest active points are sent in one request. The hot layer only
 * renders 8; this pool is the window the ranker can promote from. Points
 * older than the newest 40 stay on recency until the cap is raised.
 * Each point's text is capped (see CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS) so
 * the 4_000-char store summary limit cannot blow the request.
 */
export const CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES = 40;

/**
 * Below this pool size the newest-8 slice already IS the whole active set
 * (the hot layer renders 8), so a round-trip would only reshuffle items
 * that all fit. Skip the call.
 */
export const CEREBELLUM_KNOWLEDGE_MIN_POOL = 9;

/**
 * Minimum share of asked questions that must come back with a usable noul.
 * Below this the whole ranking is discarded (null) rather than sinking
 * unscored points below every scored one.
 */
export const CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE = 0.8;

/** Per-point text cap inside `state.knowledge[].text`. */
export const CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS = 500;

export interface CerebellumKnowledgeCandidate {
  id: string;
  topic: string;
  summary: string;
  kind?: string;
}

/**
 * Noul instruction template. ONE template so the wording stays tunable in a
 * single place; `{{INDEX}}` is replaced with the candidate's position in
 * `state.knowledge`. English instructions, original-language text in state.
 * Keep this byte-synced with scripts/cerebellum-knowledge-hot-rank-eval.mjs
 * — that script builds the request through buildKnowledgeRankRequest.
 */
export const CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS =
  'Would the knowledge point at `knowledge[{{INDEX}}].text` help the assistant handle ' +
  "the user's current message at `current_message`? " +
  'Helpful means the point is reusable know-how, a pitfall to avoid, or a principle that ' +
  'applies to this specific message — not merely shared keywords or generally useful background.';

export const CEREBELLUM_KNOWLEDGE_RANK_CRITERIA = {
  true: 'Applying or avoiding this knowledge point would noticeably change how the assistant handles this message.',
  false: 'This knowledge point does not apply to this message, or only shares surface words.',
} as const;

export interface CerebellumNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface CerebellumKnowledgeRankRequest {
  state: {
    current_message: string;
    knowledge: Array<{ id: string; text: string }>;
  };
  model: string;
  questions: Record<string, CerebellumNoulQuestion>;
}

export function cerebellumKnowledgeQuestionId(index: number): string {
  return `kn_${index}`;
}

function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

/** `[kind] topic: summary`, whitespace-collapsed and capped. Empty when both halves are blank. */
export function formatKnowledgeCandidateText(entry: {
  topic?: string;
  summary?: string;
  kind?: string;
}): string {
  const kind = entry.kind === 'pitfall' || entry.kind === 'principle' || entry.kind === 'know_how'
    ? entry.kind
    : 'know_how';
  const topic = collapseWhitespace(entry.topic);
  const summary = collapseWhitespace(entry.summary);
  const body = topic && summary ? `${topic}: ${summary}` : topic || summary;
  if (!body) return '';
  return truncateUtf16Prefix(`[${kind}] ${body}`, CEREBELLUM_KNOWLEDGE_TEXT_MAX_CHARS);
}

/**
 * Drop blank ids and blank texts, then cap the pool. The returned array is
 * what `state.knowledge` and the question index both refer to.
 */
export function selectKnowledgeRankCandidates(
  entries: readonly CerebellumKnowledgeCandidate[],
): Array<{ id: string; text: string }> {
  const selected: Array<{ id: string; text: string }> = [];
  for (const entry of entries) {
    if (selected.length >= CEREBELLUM_KNOWLEDGE_MAX_CANDIDATES) break;
    const id = collapseWhitespace(entry?.id);
    if (!id) continue;
    const text = formatKnowledgeCandidateText(entry);
    if (!text) continue;
    selected.push({ id, text });
  }
  return selected;
}

export function buildKnowledgeRankQuestions(count: number): Record<string, CerebellumNoulQuestion> {
  const questions: Record<string, CerebellumNoulQuestion> = {};
  for (let index = 0; index < count; index += 1) {
    questions[cerebellumKnowledgeQuestionId(index)] = {
      type: 'noul',
      instructions: CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS.replaceAll('{{INDEX}}', String(index)),
      criteria: { ...CEREBELLUM_KNOWLEDGE_RANK_CRITERIA },
    };
  }
  return questions;
}

export function buildKnowledgeRankRequest(input: {
  currentUserText: string;
  entries: readonly CerebellumKnowledgeCandidate[];
  model: string;
}): CerebellumKnowledgeRankRequest {
  const knowledge = selectKnowledgeRankCandidates(input.entries);
  return {
    state: {
      current_message: input.currentUserText,
      knowledge,
    },
    model: input.model,
    questions: buildKnowledgeRankQuestions(knowledge.length),
  };
}

/**
 * Map `answers[kn_<i>]` back onto `knowledge[i].id`. Missing or non-numeric
 * nouls are skipped. Returns null only when the payload has no answers object.
 */
export function parseKnowledgeRankAnswers(
  payload: unknown,
  knowledge: readonly { id: string }[],
): Map<string, number> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') {
    return null;
  }
  const scores = new Map<string, number>();
  for (let index = 0; index < knowledge.length; index += 1) {
    const answer = (answers as Record<string, unknown>)[cerebellumKnowledgeQuestionId(index)];
    if (!answer || typeof answer !== 'object') {
      continue;
    }
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      continue;
    }
    scores.set(knowledge[index].id, noul);
  }
  return scores;
}

export async function rankKnowledgeWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  entries: readonly CerebellumKnowledgeCandidate[];
  timeoutMs?: number;
}): Promise<Map<string, number> | null> {
  const { config, fetchImpl, currentUserText } = input;
  const knowledge = selectKnowledgeRankCandidates(input.entries);
  if (!currentUserText.trim() || knowledge.length === 0) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_KNOWLEDGE_RANK_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state: {
          current_message: currentUserText,
          knowledge,
        },
        model: config.model,
        questions: buildKnowledgeRankQuestions(knowledge.length),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const scores = parseKnowledgeRankAnswers(await response.json(), knowledge);
    if (scores === null) {
      return null;
    }
    if (scores.size < knowledge.length * CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE) {
      return null;
    }
    return scores;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
