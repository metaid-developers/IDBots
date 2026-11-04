/**
 * Cerebellum (小脑) turn-ack gate — decides whether an interactive turn emits
 * the LLM-written first-sentence bubble immediately or optimistically gives
 * the main reply a short grace window.
 *
 * Owner decision 2026-11-03 (session 3ecd2a2f): every generic turn used to get
 * two bubbles — the ack and the real answer — whether the message was "在吗" or
 * a multi-hour task, and the ack model (no time/memory context) could even
 * contradict the real answer on simple questions. This gate reads the user
 * message at turn entry and judges the work it implies: messages the main reply
 * covers in one short conversational answer (greetings, small talk, simple
 * questions answerable from context) hold the ack briefly so a fast main answer
 * arrives as the single bubble. If that answer misses the grace window, the
 * caller releases the held ack instead of leaving a status-only wait. Messages
 * whose answer needs tools (local-machine search, web2, the on-chain AI
 * internet/MetaWeb, files, shell, browser), recall of past conversations,
 * multi-step work, or a long composed answer keep the immediate ack.
 *
 * The boundary is judged by the cerebellum from intent, never hardcoded text
 * rules (owner requirement: no regex over "需要翻一下"-style wording).
 *
 * Solo turn-entry call (like the effort selector), not part of the per-turn
 * decision bundle: the verdict is needed within the ack window (~1.5s), ahead
 * of the volatile-context build the bundle rides. Fail-open like every other
 * cerebellum decision: a null verdict (disabled, timeout, quota, malformed,
 * blank input) keeps the historical behavior — the ack is emitted immediately,
 * because a redundant bubble on a quick turn beats a silent 30s wait on a heavy
 * one.
 *
 * Pure and Electron-free: the caller injects the fetch implementation, which in
 * the app MUST come from resolveCerebellumCallContext() — bare Node fetch is
 * region-blocked (HTTP 451) and a bare Electron net fetch against a free-relay
 * config 401s.
 *
 * Never throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Same hard abort deadline as every other cerebellum call site: the verdict is
 * awaited before the ack LLM call fires, so an over-budget gate would stack
 * onto first-sentence latency. The 2026-10-16 server baseline (relay P50
 * 217ms / P99 412ms) leaves ~3x headroom, and a timeout simply fails open.
 */
export const CEREBELLUM_TURN_ACK_GATE_TIMEOUT_MS = 1500;

/**
 * Noul probability at or above which the turn keeps its first-sentence bubble.
 * The cookbook 0.5: the criteria text below is written to produce a clean cliff
 * (tool/recall/multi-step work vs immediately answerable chat), so neither
 * direction needs a bias nudge — scripts/cerebellum-ack-gate-eval.mjs measures
 * the placement, same as the sibling gates' evals.
 */
export const CEREBELLUM_TURN_ACK_GATE_THRESHOLD = 0.5;

/** Input cap for the user-message slice sent to the gate. */
export const CEREBELLUM_TURN_ACK_GATE_MESSAGE_MAX_CHARS = 1200;

export const CEREBELLUM_TURN_ACK_GATE_QUESTION_ID = 'turn_ack_needed';

/**
 * English instructions; the state carries the user message in its original
 * language. Keep this byte-synced with scripts/cerebellum-ack-gate-eval.mjs —
 * that script must build the request through buildTurnAckGateRequest.
 */
export const CEREBELLUM_TURN_ACK_GATE_INSTRUCTIONS =
  'The user message at `user_message` just arrived in a chat with an AI assistant that CAN use tools ' +
  '(searching the local machine, web search, the on-chain AI internet/MetaWeb, reading files, running ' +
  'commands, driving the browser) and CAN recall past conversations. A separate fast responder can show ' +
  'a short interim "got it, working on it" bubble while the full reply is prepared. ' +
  'Does THIS message warrant that interim bubble? ' +
  'Count it as needed when the answer will take noticeable time: any tool use (searching the local ' +
  'machine, the web, or the AI internet; reading files; running commands; browser actions), looking up ' +
  'or recalling past conversations or stored information, multi-step work, coding or debugging, or a ' +
  'long composed answer. ' +
  'Do NOT count messages the assistant can answer immediately in one short conversational reply from ' +
  'its own context: greetings, check-ins, small talk, thanks, simple factual or casual questions, ' +
  'opinions, and follow-ups that need no lookup. ' +
  'The text may be in ANY language; judge the work the message implies, never surface keywords, ' +
  'phrasing, or length.';

export const CEREBELLUM_TURN_ACK_GATE_CRITERIA = {
  true: 'Answering will take noticeable time — tool use (local-machine, web, or AI-internet search; files; shell; browser), recall of past conversations, multi-step work, coding/debugging, or a long composed answer — so the user benefits from an interim acknowledgment.',
  false: 'The assistant can answer immediately in one short conversational reply from context — greetings, small talk, thanks, simple questions needing no lookup or tools — so a separate interim bubble would be redundant.',
} as const;

export interface CerebellumTurnAckGateRequest {
  state: {
    user_message: string;
  };
  model: string;
  questions: {
    turn_ack_needed: {
      type: 'noul';
      instructions: string;
      criteria: { true: string; false: string };
    };
  };
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
  // High surrogate whose pair was cut off would produce a lone surrogate.
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function collapseWhitespace(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export function buildTurnAckGateRequest(input: {
  currentUserText: string;
  model: string;
}): CerebellumTurnAckGateRequest {
  return {
    state: {
      user_message: truncateUtf16Prefix(
        collapseWhitespace(input.currentUserText),
        CEREBELLUM_TURN_ACK_GATE_MESSAGE_MAX_CHARS,
      ),
    },
    model: input.model,
    questions: {
      [CEREBELLUM_TURN_ACK_GATE_QUESTION_ID]: {
        type: 'noul',
        instructions: CEREBELLUM_TURN_ACK_GATE_INSTRUCTIONS,
        criteria: { ...CEREBELLUM_TURN_ACK_GATE_CRITERIA },
      },
    },
  };
}

/**
 * Extract the ack-gate noul (0..1) from a /v1/systemone payload. Returns null
 * on any unusable shape (no answers object, missing question, non-numeric
 * noul); out-of-range values clamp into 0..1.
 */
export function parseTurnAckGateAnswer(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') return null;
  const answers = (payload as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const answer = (answers as Record<string, unknown>)[CEREBELLUM_TURN_ACK_GATE_QUESTION_ID];
  if (!answer || typeof answer !== 'object') return null;
  const noul = (answer as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) return null;
  return Math.max(0, Math.min(1, noul));
}

/** true when the noul says the turn emits its first-sentence bubble immediately. */
export function turnAckNeededFromNoul(
  noul: number,
  threshold: number = CEREBELLUM_TURN_ACK_GATE_THRESHOLD,
): boolean {
  return noul >= threshold;
}

/**
 * Ask the cerebellum whether this turn needs its LLM first-sentence bubble
 * immediately. Returns true (emit now), false (hold briefly for the main reply,
 * then release if no visible text landed), or null (no verdict — blank text,
 * HTTP/network error, abort/timeout, malformed payload); the caller treats null
 * as true (fail-open). Never throws.
 */
export async function classifyTurnAckNeedWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  timeoutMs?: number;
  threshold?: number;
}): Promise<boolean | null> {
  if (!collapseWhitespace(input.currentUserText)) return null;

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_TURN_ACK_GATE_TIMEOUT_MS),
  );
  try {
    const response = await input.fetchImpl(`${input.config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildTurnAckGateRequest({
        currentUserText: input.currentUserText,
        model: input.config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const noul = parseTurnAckGateAnswer(await response.json());
    if (noul === null) return null;
    return turnAckNeededFromNoul(noul, input.threshold ?? CEREBELLUM_TURN_ACK_GATE_THRESHOLD);
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller falls back to emitting the ack, exactly as before the gate.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
