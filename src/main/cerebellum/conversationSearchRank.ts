/**
 * Cerebellum (小脑) conversation-search re-rank — roadmap #15.
 *
 * conversation_search returns keyword hits ordered by session updated_at.
 * One Noul per hit asks whether that chat answers the search query. The
 * noul replaces recency as the rank key. Null keeps the keyword order.
 *
 * Pure and Electron-free. Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

export const CEREBELLUM_CONVERSATION_RANK_TIMEOUT_MS = 2500;
/** The tool itself never returns more than 10 chats. */
export const CEREBELLUM_CONVERSATION_RANK_MAX_CANDIDATES = 10;
/** One hit has nothing to reorder. */
export const CEREBELLUM_CONVERSATION_RANK_MIN_POOL = 2;
export const CEREBELLUM_CONVERSATION_RANK_MIN_ANSWER_COVERAGE = 0.8;
export const CEREBELLUM_CONVERSATION_TEXT_MAX_CHARS = 700;

export const CEREBELLUM_CONVERSATION_RANK_INSTRUCTIONS =
  'Would the prior chat at `chats[{{INDEX}}].text` help answer the search need at `search_query`? ' +
  'Helpful means the chat contains the decision, fact, or earlier work the query is looking for — ' +
  'not merely shared keywords or a more recent unrelated chat.';

export const CEREBELLUM_CONVERSATION_RANK_CRITERIA = {
  true: 'This chat is what the search is looking for; showing it first would make the answer better.',
  false: 'This chat only shares surface words, or it is about something else.',
} as const;

export interface CerebellumConversationCandidate {
  id: string;
  text: string;
}

export interface CerebellumConversationRankRequest {
  state: {
    search_query: string;
    chats: CerebellumConversationCandidate[];
  };
  model: string;
  questions: Record<string, {
    type: 'noul';
    instructions: string;
    criteria: { true: string; false: string };
  }>;
}

export function cerebellumConversationQuestionId(index: number): string {
  return `chat_${index}`;
}

function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapse(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function formatConversationCandidateText(input: {
  title?: string;
  human?: string;
  assistant?: string;
}): string {
  const title = collapse(input.title) || 'Untitled';
  const human = collapse(input.human);
  const assistant = collapse(input.assistant);
  return truncateUtf16Prefix(
    `Title: ${title}\nHuman: ${human || '(empty)'}\nAssistant: ${assistant || '(empty)'}`,
    CEREBELLUM_CONVERSATION_TEXT_MAX_CHARS,
  );
}

export function buildConversationRankQuestions(count: number): CerebellumConversationRankRequest['questions'] {
  const questions: CerebellumConversationRankRequest['questions'] = {};
  for (let index = 0; index < count; index += 1) {
    questions[cerebellumConversationQuestionId(index)] = {
      type: 'noul',
      instructions: CEREBELLUM_CONVERSATION_RANK_INSTRUCTIONS.replaceAll('{{INDEX}}', String(index)),
      criteria: { ...CEREBELLUM_CONVERSATION_RANK_CRITERIA },
    };
  }
  return questions;
}

export function selectConversationRankCandidates(
  chats: readonly CerebellumConversationCandidate[],
): CerebellumConversationCandidate[] {
  const selected: CerebellumConversationCandidate[] = [];
  for (const chat of chats) {
    if (selected.length >= CEREBELLUM_CONVERSATION_RANK_MAX_CANDIDATES) break;
    const id = collapse(chat?.id);
    const text = collapse(chat?.text);
    if (!id || !text) continue;
    selected.push({ id, text: truncateUtf16Prefix(text, CEREBELLUM_CONVERSATION_TEXT_MAX_CHARS) });
  }
  return selected;
}

export function buildConversationRankRequest(input: {
  searchQuery: string;
  chats: readonly CerebellumConversationCandidate[];
  model: string;
}): CerebellumConversationRankRequest {
  const chats = selectConversationRankCandidates(input.chats);
  return {
    state: {
      search_query: collapse(input.searchQuery),
      chats,
    },
    model: input.model,
    questions: buildConversationRankQuestions(chats.length),
  };
}

export function parseConversationRankAnswers(
  payload: unknown,
  chats: readonly CerebellumConversationCandidate[],
): Map<string, number> | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const scores = new Map<string, number>();
  for (let index = 0; index < chats.length; index += 1) {
    const answer = (answers as Record<string, unknown>)[cerebellumConversationQuestionId(index)];
    if (!answer || typeof answer !== 'object') continue;
    const noul = (answer as { noul?: unknown }).noul;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) continue;
    scores.set(chats[index].id, noul);
  }
  return scores;
}

/** Recency order unless a score map is present. Missing ids sink below scored ones. */
export function orderConversationHits<T extends { id: string }>(
  records: readonly T[],
  scores: ReadonlyMap<string, number> | null | undefined,
): T[] {
  if (!scores || scores.size === 0) return records.slice();
  return records
    .map((record, index) => ({ record, index, score: scores.get(record.id) }))
    .sort((left, right) => {
      const leftScore = typeof left.score === 'number' && Number.isFinite(left.score)
        ? left.score
        : Number.NEGATIVE_INFINITY;
      const rightScore = typeof right.score === 'number' && Number.isFinite(right.score)
        ? right.score
        : Number.NEGATIVE_INFINITY;
      if (leftScore !== rightScore) return rightScore - leftScore;
      return left.index - right.index;
    })
    .map((row) => row.record);
}

export async function rankConversationsWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  searchQuery: string;
  chats: readonly CerebellumConversationCandidate[];
  timeoutMs?: number;
}): Promise<Map<string, number> | null> {
  const chats = selectConversationRankCandidates(input.chats);
  if (!collapse(input.searchQuery) || chats.length === 0) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_CONVERSATION_RANK_TIMEOUT_MS),
  );
  try {
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildConversationRankRequest({
        searchQuery: input.searchQuery,
        chats,
        model: input.config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const scores = parseConversationRankAnswers(await response.json(), chats);
    if (scores === null) return null;
    if (scores.size < chats.length * CEREBELLUM_CONVERSATION_RANK_MIN_ANSWER_COVERAGE) return null;
    return scores;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
