/**
 * Cerebellum (小脑) per-turn decision bundle — ONE /v1/systemone request per
 * cowork turn covering the five turn-scoped decisions that used to fire five
 * parallel requests: memory re-rank, skill shortlist, remote-service
 * shortlist, volatile block gate, and the knowledge hot-layer rank.
 *
 * The JEV protocol natively multiplexes questions: `questions` is an id-keyed
 * map and `answers` comes back keyed the same way, and the five decisions'
 * question ids are already pairwise disjoint (`mem_<i>`, `best_skill`,
 * `best_service`, the gate's section keys, `kn_<i>`). The bundle therefore
 * reuses each decision module's own question builders and answer parsers
 * verbatim — only the transport is merged. One shared state carries the
 * current user message plus the memory and knowledge pools ONCE, instead of
 * five requests each serializing their own copy (the memory ranker's state
 * alone was ~20KB): five round-trips and five quota bills collapse into one.
 *
 * Per-decision failure semantics are preserved from the split-call era: each
 * answer section degrades independently inside one response (a missing
 * `best_skill` answer costs only the shortlist), the memory and knowledge
 * coverage floors still discard partial score maps as a whole, and any
 * transport failure (HTTP error, network error, abort/timeout, malformed
 * payload) returns null so the turn proceeds with lexical ranking, no
 * shortlists, and every volatile block injected.
 *
 * Deliberately NOT bundled: the reasoning-effort selector keeps its own
 * 1s-budget call (different semantics and consumer), and the brain-invoked
 * intuition tool is not turn-scoped at all.
 *
 * Unlike the sibling decision modules this one carries runtime imports, so
 * it is loaded from dist-electron (compile:electron first); plain-Node tests
 * and eval scripts import the compiled module, mirroring the
 * knowledgePromptBlocks precedent.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike, CerebellumMemoryCandidate } from './memoryRank';
import {
  CEREBELLUM_MEMORY_CURRENT_MESSAGE_MAX_CHARS,
  CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE,
  CEREBELLUM_MEMORY_MIN_POOL,
  CEREBELLUM_MEMORY_RANK_CRITERIA,
  CEREBELLUM_MEMORY_RANK_INSTRUCTIONS,
  buildMemoryRankQuestions,
  cerebellumMemoryQuestionId,
  parseMemoryRankAnswers,
  selectMemoryRankCandidates,
} from './memoryRank';
import {
  CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE,
  CEREBELLUM_KNOWLEDGE_MIN_POOL,
  CEREBELLUM_KNOWLEDGE_RANK_CRITERIA,
  CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS,
  buildKnowledgeRankQuestions,
  cerebellumKnowledgeQuestionId,
  parseKnowledgeRankAnswers,
  selectKnowledgeRankCandidates,
} from './knowledgeHotRank';
import type { CerebellumKnowledgeCandidate } from './knowledgeHotRank';
import {
  CEREBELLUM_SKILL_MAX_OPTIONS,
  CEREBELLUM_SKILL_SHORTLIST_MIN_POOL,
  buildSkillChoiceQuestions,
  parseSkillShortlistAnswers,
} from './skillShortlist';
import type { CerebellumSkillCandidate, CerebellumSkillChoiceQuestion, CerebellumSkillRankEntry } from './skillShortlist';
import {
  CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS,
  CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL,
  buildRemoteServiceChoiceQuestions,
  parseRemoteServiceShortlistAnswers,
} from './remoteServiceShortlist';
import type {
  CerebellumRemoteServiceCandidate,
  CerebellumRemoteServiceChoiceQuestion,
  CerebellumRemoteServiceRankEntry,
} from './remoteServiceShortlist';
import {
  buildVolatileGateQuestions,
  CEREBELLUM_VOLATILE_GATE_SECTION_KEYS,
  parseVolatileGateAnswers,
} from './volatileBlockGate';
import {
  buildBundledEffortQuestion,
  parseEffortSelectorAnswers,
  type CerebellumEffortChoiceQuestion,
  type CerebellumEffortDistribution,
} from './effortSelector';

export const CEREBELLUM_TURN_DECISION_TIMEOUT_MS = 1500;
export const CEREBELLUM_BUNDLE_MAX_MEMORIES = 15;
export const CEREBELLUM_BUNDLE_MEMORY_TEXT_MAX_CHARS = 220;
export const CEREBELLUM_BUNDLE_MAX_KNOWLEDGE = 12;
export const CEREBELLUM_BUNDLE_KNOWLEDGE_TEXT_MAX_CHARS = 200;
export const CEREBELLUM_BUNDLE_MAX_SKILLS = 18;
export const CEREBELLUM_BUNDLE_SKILL_DESC_MAX_CHARS = 140;
export const CEREBELLUM_BUNDLE_MAX_SERVICES = 16;
export const CEREBELLUM_BUNDLE_SERVICE_DESC_MAX_CHARS = 140;
export const CEREBELLUM_BUNDLE_CURRENT_MESSAGE_MAX_CHARS = 1200;

/** The five turn-scoped decisions, gathered by the caller before the call. */
export interface CerebellumTurnDecisionSet {
  currentUserText: string;
  /** Raw memory pool (last-used-DESC); the module prefilter bounds the payload. */
  memories: readonly CerebellumMemoryCandidate[];
  /** Raw knowledge pool (newest-first); blank entries drop at selection. */
  knowledge: readonly CerebellumKnowledgeCandidate[];
  /** Visible skill catalog; pools below the min size make no question. */
  skills: readonly CerebellumSkillCandidate[];
  /** Discovered remote-service directory; pools below the min make no question. */
  services: readonly CerebellumRemoteServiceCandidate[];
  /** Whether the volatile block gate questions ride (blank text skips all). */
  includeGate: boolean;
  /** Whether to coalesce the auto reasoning-effort Choice question into this bundle. */
  includeEffort?: boolean;
}

/**
 * The candidate slices the request and the answer parsers share: question
 * indexes refer to THESE arrays, not the raw inputs. null when nothing is
 * eligible (blank text, or every pool below its floor with the gate off).
 */
export interface CerebellumTurnDecisionSelection {
  currentUserText: string;
  memories: CerebellumMemoryCandidate[];
  knowledge: Array<{ id: string; text: string }>;
  skills: CerebellumSkillCandidate[];
  services: CerebellumRemoteServiceCandidate[];
  includeGate: boolean;
  includeEffort: boolean;
}

export type CerebellumTurnQuestion =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { $tpl: string; index: number }
  | CerebellumSkillChoiceQuestion
  | CerebellumRemoteServiceChoiceQuestion
  | CerebellumEffortChoiceQuestion;

export interface CerebellumTurnDecisionRequest {
  state: {
    current_message: string;
    memories?: CerebellumMemoryCandidate[];
    knowledge?: Array<{ id: string; text: string }>;
  };
  model: string;
  question_templates?: Record<string, { type: 'noul'; instructions: string; criteria: { true: string; false: string } }>;
  questions: Record<string, CerebellumTurnQuestion>;
}

/** Per-decision outcomes; each field degrades to null independently. */
export interface CerebellumTurnDecisionResults {
  memoryScores: ReadonlyMap<string, number> | null;
  knowledgeScores: ReadonlyMap<string, number> | null;
  skillRanking: CerebellumSkillRankEntry[] | null;
  serviceRanking: CerebellumRemoteServiceRankEntry[] | null;
  gateVerdicts: Record<string, boolean> | null;
  effortDistribution?: CerebellumEffortDistribution | null;
}

/**
 * Local UTF-16-unit prefix cut (same semantics as truncateUtf16Units in
 * libs/llmSafeText, inlined to match the sibling decision modules).
 */
function truncateUtf16Prefix(text: string, maxUnits: number): string {
  if (maxUnits <= 0) return '';
  if (text.length <= maxUnits) return text;
  const cut = text.slice(0, maxUnits);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Apply each decision's own floor (the same min-pool rules the split call
 * sites used) and candidate selection. Floors compare the RAW input size —
 * exactly where the old call sites checked — so behavior is unchanged.
 */
function extractBundleQueryTokens(text: string): Set<string> {
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

function scoreBundleLexicalOverlap(text: string, tokens: ReadonlySet<string>): number {
  if (tokens.size === 0 || !text) return 0;
  const lower = text.toLowerCase();
  let score = 0;
  for (const token of tokens) {
    if (lower.includes(token)) score += 1;
  }
  return score;
}

function rankAndCapBundleOptions<T extends { id: string; name: string; description: string }>(
  items: readonly T[],
  tokens: ReadonlySet<string>,
  maxCount: number,
  maxDescChars: number,
): T[] {
  const ranked = items.length > maxCount
    ? items
        .map((item, index) => ({
          item,
          index,
          score: scoreBundleLexicalOverlap(`${item.name} ${item.description}`, tokens),
        }))
        .sort((a, b) => b.score - a.score || a.index - b.index)
        .slice(0, maxCount)
        .map((entry) => entry.item)
    : items.slice(0, maxCount);

  return ranked.map((item) => ({
    ...item,
    description: truncateUtf16Prefix(String(item.description ?? '').replace(/\s+/g, ' ').trim(), maxDescChars),
  }));
}

export function selectTurnDecisionCandidates(
  decisions: CerebellumTurnDecisionSet,
): CerebellumTurnDecisionSelection | null {
  const currentUserText = String(decisions.currentUserText ?? '');
  if (!currentUserText.trim()) {
    return null;
  }
  const queryTokens = extractBundleQueryTokens(currentUserText);
  const memories = decisions.memories.length >= CEREBELLUM_MEMORY_MIN_POOL
    ? selectMemoryRankCandidates(decisions.memories, currentUserText)
        .slice(0, CEREBELLUM_BUNDLE_MAX_MEMORIES)
        .map((entry) => ({
          id: entry.id,
          text: truncateUtf16Prefix(entry.text, CEREBELLUM_BUNDLE_MEMORY_TEXT_MAX_CHARS),
        }))
    : [];
  const preRankedKnowledge = decisions.knowledge.length >= CEREBELLUM_KNOWLEDGE_MIN_POOL
    ? (decisions.knowledge.length > CEREBELLUM_BUNDLE_MAX_KNOWLEDGE
        ? decisions.knowledge
            .slice(0, 60)
            .map((item, index) => ({
              item,
              index,
              score: scoreBundleLexicalOverlap(`${item.topic} ${item.summary}`, queryTokens),
            }))
            .sort((a, b) => b.score - a.score || a.index - b.index)
            .map((entry) => entry.item)
        : decisions.knowledge)
    : [];
  const knowledge = selectKnowledgeRankCandidates(preRankedKnowledge)
    .slice(0, CEREBELLUM_BUNDLE_MAX_KNOWLEDGE)
    .map((entry) => ({
      id: entry.id,
      text: truncateUtf16Prefix(entry.text, CEREBELLUM_BUNDLE_KNOWLEDGE_TEXT_MAX_CHARS),
    }));
  const skills = decisions.skills.length >= CEREBELLUM_SKILL_SHORTLIST_MIN_POOL
    ? rankAndCapBundleOptions(
        decisions.skills.slice(0, CEREBELLUM_SKILL_MAX_OPTIONS),
        queryTokens,
        CEREBELLUM_BUNDLE_MAX_SKILLS,
        CEREBELLUM_BUNDLE_SKILL_DESC_MAX_CHARS,
      )
    : [];
  const services = decisions.services.length >= CEREBELLUM_REMOTE_SERVICE_SHORTLIST_MIN_POOL
    ? rankAndCapBundleOptions(
        decisions.services.slice(0, CEREBELLUM_REMOTE_SERVICE_MAX_OPTIONS),
        queryTokens,
        CEREBELLUM_BUNDLE_MAX_SERVICES,
        CEREBELLUM_BUNDLE_SERVICE_DESC_MAX_CHARS,
      )
    : [];
  const includeGate = decisions.includeGate;
  const includeEffort = decisions.includeEffort === true;
  if (
    memories.length === 0
    && knowledge.length === 0
    && skills.length === 0
    && services.length === 0
    && !includeGate
    && !includeEffort
  ) {
    return null;
  }
  return { currentUserText, memories, knowledge, skills, services, includeGate, includeEffort };
}

/**
 * Assemble the merged request: one state (message + the two scored pools,
 * each sent once), and every eligible decision's questions under their
 * existing disjoint ids so the per-decision parsers keep working verbatim.
 */
export function buildTurnDecisionRequest(input: {
  selection: CerebellumTurnDecisionSelection;
  model: string;
  useQuestionTemplates?: boolean;
}): CerebellumTurnDecisionRequest {
  const { selection } = input;
  const useTemplates = input.useQuestionTemplates === true
    && (selection.memories.length > 0 || selection.knowledge.length > 0);
  const templates: NonNullable<CerebellumTurnDecisionRequest['question_templates']> = {};
  const memQuestions: Record<string, CerebellumTurnQuestion> = {};
  if (useTemplates && selection.memories.length > 0) {
    templates.mem = {
      type: 'noul',
      instructions: CEREBELLUM_MEMORY_RANK_INSTRUCTIONS,
      criteria: { ...CEREBELLUM_MEMORY_RANK_CRITERIA },
    };
    for (let index = 0; index < selection.memories.length; index += 1) {
      memQuestions[cerebellumMemoryQuestionId(index)] = { $tpl: 'mem', index };
    }
  } else {
    Object.assign(memQuestions, buildMemoryRankQuestions(selection.memories.length));
  }

  const knQuestions: Record<string, CerebellumTurnQuestion> = {};
  if (useTemplates && selection.knowledge.length > 0) {
    templates.kn = {
      type: 'noul',
      instructions: CEREBELLUM_KNOWLEDGE_RANK_INSTRUCTIONS,
      criteria: { ...CEREBELLUM_KNOWLEDGE_RANK_CRITERIA },
    };
    for (let index = 0; index < selection.knowledge.length; index += 1) {
      knQuestions[cerebellumKnowledgeQuestionId(index)] = { $tpl: 'kn', index };
    }
  } else {
    Object.assign(knQuestions, buildKnowledgeRankQuestions(selection.knowledge.length));
  }

  const messageCap = Math.min(CEREBELLUM_MEMORY_CURRENT_MESSAGE_MAX_CHARS, CEREBELLUM_BUNDLE_CURRENT_MESSAGE_MAX_CHARS);
  return {
    state: {
      current_message: truncateUtf16Prefix(selection.currentUserText, messageCap),
      ...(selection.memories.length > 0 ? { memories: selection.memories } : {}),
      ...(selection.knowledge.length > 0 ? { knowledge: selection.knowledge } : {}),
    },
    model: input.model,
    ...(Object.keys(templates).length > 0 ? { question_templates: templates } : {}),
    questions: {
      ...memQuestions,
      ...buildSkillChoiceQuestions(selection.skills),
      ...buildRemoteServiceChoiceQuestions(selection.services),
      ...(selection.includeGate ? buildVolatileGateQuestions() : {}),
      ...(selection.includeEffort ? buildBundledEffortQuestion() : {}),
      ...knQuestions,
    },
  };
}

/**
 * Split one merged answer payload back into the five decisions, reusing each
 * decision module's parser plus its coverage floor. A section that is absent
 * or unusable resolves to null for that decision alone.
 */
export function parseTurnDecisionAnswers(
  payload: unknown,
  selection: CerebellumTurnDecisionSelection,
): CerebellumTurnDecisionResults {
  const memoryScores = parseMemoryRankAnswers(payload, selection.memories);
  const memoryScoresUsable = memoryScores !== null
    && memoryScores.size >= selection.memories.length * CEREBELLUM_MEMORY_MIN_ANSWER_COVERAGE
    ? memoryScores
    : null;
  const knowledgeScores = parseKnowledgeRankAnswers(payload, selection.knowledge);
  const knowledgeScoresUsable = knowledgeScores !== null
    && knowledgeScores.size >= selection.knowledge.length * CEREBELLUM_KNOWLEDGE_MIN_ANSWER_COVERAGE
    ? knowledgeScores
    : null;
  const baseResults: CerebellumTurnDecisionResults = {
    memoryScores: memoryScoresUsable,
    knowledgeScores: knowledgeScoresUsable,
    skillRanking: selection.skills.length > 0 ? parseSkillShortlistAnswers(payload, selection.skills) : null,
    serviceRanking: selection.services.length > 0
      ? parseRemoteServiceShortlistAnswers(payload, selection.services)
      : null,
    gateVerdicts: selection.includeGate ? parseVolatileGateAnswers(payload) : null,
  };
  if (selection.includeEffort) {
    baseResults.effortDistribution = parseEffortSelectorAnswers(payload);
  }
  return baseResults;
}

/** Payload accounting for the JEV cost budget (counts/chars, never text). */
export interface CerebellumTurnDecisionPayloadStats {
  memoriesSent: number;
  knowledgeSent: number;
  skillsSent: number;
  servicesSent: number;
  gateQuestions: number;
  totalQuestions: number;
  currentMessageChars: number;
  totalChars: number;
}

/**
 * Run every eligible turn decision through ONE /v1/systemone request.
 * Returns null on blank/uneligible input, HTTP errors, network errors,
 * abort/timeout, and malformed payloads — the caller then degrades each
 * decision exactly as the split call sites did. Never throws.
 */
export async function runCerebellumTurnDecisions(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  decisions: CerebellumTurnDecisionSet;
  timeoutMs?: number;
  useQuestionTemplates?: boolean;
  /** Debug hook: payload accounting (counts/chars only, never text). */
  onPayload?: (stats: CerebellumTurnDecisionPayloadStats) => void;
}): Promise<CerebellumTurnDecisionResults | null> {
  const { config, fetchImpl } = input;
  const selection = selectTurnDecisionCandidates(input.decisions);
  if (!selection) {
    return null;
  }

  const effectiveTimeoutMs = Math.max(1, input.timeoutMs ?? CEREBELLUM_TURN_DECISION_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    effectiveTimeoutMs,
  );
  try {
    const request = buildTurnDecisionRequest({
      selection,
      model: config.model,
      useQuestionTemplates: input.useQuestionTemplates,
    });
    const body = JSON.stringify(request);
    input.onPayload?.({
      memoriesSent: selection.memories.length,
      knowledgeSent: selection.knowledge.length,
      skillsSent: selection.skills.length,
      servicesSent: selection.services.length,
      gateQuestions: selection.includeGate ? CEREBELLUM_VOLATILE_GATE_SECTION_KEYS.length : 0,
      totalQuestions: Object.keys(request.questions).length,
      currentMessageChars: request.state.current_message.length,
      totalChars: body.length,
    });
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Deadline-Ms': String(effectiveTimeoutMs),
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseTurnDecisionAnswers(await response.json(), selection);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // every decision degrades to its pre-cerebellum behavior silently.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
