/**
 * Cerebellum (小脑) volatile block gate — roadmap #3 of the cerebellum system.
 *
 * One JEV request per turn carrying one Noul question per gateable volatile
 * context block ("does this turn need block X?"), all evaluated in parallel
 * against one shared state (the current user message). Blocks whose noul
 * falls below their threshold are omitted from the per-turn user-message
 * tail for THIS turn; everything else injects exactly as before.
 *
 * What this buys: the volatile tail re-sends every CHANGED block on every
 * turn (content-hash dedup only covers byte-stable blocks, and every tail
 * byte is a guaranteed cache miss), and blocks that are irrelevant to the
 * current request dilute the model's attention ("context rot"). Gating
 * trims both per-turn tokens and noise for the occasionally-relevant
 * background blocks. The cacheable system-prompt head is never touched —
 * these blocks live in the tail by design.
 *
 * Gateable blocks (single source for the runner's push sites):
 * - experience:      dream-layer self-identity + daily summaries
 * - twin-impression: distilled impressions of local Worker bots
 * - knowledge-bases: per-bot knowledge base listings
 * - remote-services: on-chain remote service directory
 *
 * Deliberately NOT gated: memory (alwaysInject by design), browser and goal
 * (small, live, user-explicit), skills-catalog (the skill shortlist owns
 * that surface).
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: gateVolatileBlocksWithCerebellum NEVER throws and
 * returns null on HTTP errors, network errors, abort/timeout, malformed
 * payloads, and blank user text — the caller then injects every block
 * exactly as before. Within a usable payload, a missing/unusable per-block
 * answer resolves to true (inject): fail-open per block, never per turn.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/** Same hard abort deadline as every other cerebellum call site. */
export const CEREBELLUM_VOLATILE_GATE_TIMEOUT_MS = 2500;

/**
 * Cap for `state.user_message`: a single chat message is normally small, but
 * a huge pasted blob would otherwise ride the gate payload unbounded. Same
 * defensive spirit as the memoryRank budgets.
 */
export const CEREBELLUM_VOLATILE_GATE_MAX_MESSAGE_CHARS = 4000;

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

/** Section keys the runner consults gate verdicts for (single source). */
export const CEREBELLUM_VOLATILE_GATE_SECTION_KEYS = [
  'experience',
  'twin-impression',
  'knowledge-bases',
  'remote-services',
  // Dream review P1: team culture block in the cowork volatile tail.
  'team-culture',
] as const;

export type CerebellumVolatileGateSectionKey = (typeof CEREBELLUM_VOLATILE_GATE_SECTION_KEYS)[number];

/**
 * Inject thresholds per block: inject when noul >= threshold. Deliberately
 * BELOW 0.5 — skipping a block the turn actually needed (lost context) is
 * worse than carrying a few extra tokens, so the gate only skips when the
 * cerebellum is fairly confident the block is irrelevant. Tuned against
 * scripts/cerebellum-volatile-gate-eval.mjs on real Chinese turns.
 */
export const CEREBELLUM_VOLATILE_GATE_THRESHOLDS: Record<CerebellumVolatileGateSectionKey, number> = {
  experience: 0.35,
  'twin-impression': 0.35,
  'knowledge-bases': 0.35,
  'remote-services': 0.35,
  // Same bias as the other guidance blocks: only skip when fairly confident
  // the turn does not involve shared team conventions/terms/lessons.
  'team-culture': 0.35,
};

/**
 * Noul instruction per gateable block (ONE tunable place). English per
 * TypeSafe's English-primary guidance; the user's original (often Chinese)
 * message stays in `state.current_message` (the shared turn-bundle state
 * field). Each question describes its block CATEGORY so the model can judge
 * relevance without the block's content — the content is exactly what a
 * skip avoids sending.
 */
export const CEREBELLUM_VOLATILE_GATE_INSTRUCTIONS: Record<CerebellumVolatileGateSectionKey, string> = {
  experience:
    'Does replying to the user\'s message at `current_message` need the assistant\'s own ' +
    'self-identity, nightly dream reflections, or lessons learned from past interactions? ' +
    'Needed only when the message is about who the assistant is, what it has learned or ' +
    'reflects on, or explicitly references its past behavior; ordinary task requests do not need it.',
  'twin-impression':
    'Does replying to the user\'s message at `current_message` need the assistant\'s stored ' +
    'impressions of its local worker bots (their strengths, habits, reliability)? Needed ' +
    'only when the message involves those worker bots, delegating work to them, or team ' +
    'composition questions.',
  'knowledge-bases':
    'Does replying to the user\'s message at `current_message` need the listing of the ' +
    'assistant\'s knowledge bases (their names and document counts)? Needed only when the ' +
    'message asks to search, store into, or consult a knowledge base or its documents.',
  'remote-services':
    'Does replying to the user\'s message at `current_message` need the directory of remote ' +
    'on-chain services offered by other bots? Needed only when the message seeks a ' +
    'capability the assistant itself lacks and might delegate or purchase externally; ' +
    'ordinary self-served requests do not need it.',
  'team-culture':
    'Does replying to the user\'s message at `current_message` need the shared team ' +
    'culture block (fleet-wide glossary terms, working conventions, distilled team ' +
    'lessons)? Needed only when the message involves fleet coordination, team members, ' +
    'shared terminology, or ways of working; ordinary task requests do not need it.',
};

export const CEREBELLUM_VOLATILE_GATE_CRITERIA = {
  true: 'The message clearly falls into what this block provides.',
  false: 'The message is unrelated to what this block provides.',
} as const;

export interface CerebellumVolatileGateNoulQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface CerebellumVolatileGateRequest {
  state: {
    current_message: string;
  };
  model: string;
  questions: Record<string, CerebellumVolatileGateNoulQuestion>;
}

export function buildVolatileGateQuestions(): Record<
  CerebellumVolatileGateSectionKey,
  CerebellumVolatileGateNoulQuestion
> {
  const questions = {} as Record<CerebellumVolatileGateSectionKey, CerebellumVolatileGateNoulQuestion>;
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    questions[key] = {
      type: 'noul',
      instructions: CEREBELLUM_VOLATILE_GATE_INSTRUCTIONS[key],
      criteria: { ...CEREBELLUM_VOLATILE_GATE_CRITERIA },
    };
  }
  return questions;
}

export function buildVolatileGateRequest(input: {
  currentUserText: string;
  model: string;
}): CerebellumVolatileGateRequest {
  const message = String(input.currentUserText ?? '').replace(/\s+/g, ' ').trim();
  return {
    state: {
      current_message: truncateUtf16Prefix(message, CEREBELLUM_VOLATILE_GATE_MAX_MESSAGE_CHARS),
    },
    model: input.model,
    questions: buildVolatileGateQuestions(),
  };
}

/**
 * Map answers to per-block verdicts: true = inject this turn, false = skip.
 * A missing or non-numeric answer for a block resolves to true (fail-open
 * per block). Returns null only when the payload shape itself is unusable
 * (no answers object) — the caller then injects everything as before.
 */
export function parseVolatileGateAnswers(payload: unknown): Record<string, boolean> | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') {
    return null;
  }
  const record = answers as Record<string, unknown>;
  const verdicts: Record<string, boolean> = {};
  for (const key of CEREBELLUM_VOLATILE_GATE_SECTION_KEYS) {
    const answer = record[key];
    const noul = answer && typeof answer === 'object'
      ? (answer as { noul?: unknown }).noul
      : undefined;
    if (typeof noul !== 'number' || !Number.isFinite(noul)) {
      verdicts[key] = true;
      continue;
    }
    const clamped = Math.max(0, Math.min(1, noul));
    verdicts[key] = clamped >= CEREBELLUM_VOLATILE_GATE_THRESHOLDS[key];
  }
  return verdicts;
}

/**
 * Ask the cerebellum which gateable blocks this turn needs. Returns the
 * verdict map (true = inject, false = skip) or null (no verdict — blank
 * user text, HTTP/network error, abort/timeout, malformed payload), in
 * which case the caller injects every block as before. Never throws.
 */
export async function gateVolatileBlocksWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  timeoutMs?: number;
}): Promise<Record<string, boolean> | null> {
  const { config, fetchImpl } = input;
  if (!String(input.currentUserText ?? '').trim()) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_VOLATILE_GATE_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildVolatileGateRequest({
        currentUserText: input.currentUserText,
        model: config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseVolatileGateAnswers(await response.json());
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller injects every volatile block as if no gate existed.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
