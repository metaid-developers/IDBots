/**
 * Cerebellum (小脑) memory write gate — roadmap #1 of the cerebellum system.
 *
 * One cheap JEV Noul in front of the turn-level brain memory-extraction call
 * (coworkMemoryJudge.judgeTurnMemoryExtraction): "is this turn worth a memory
 * extraction pass at all?" Most turns are chatter, and the extraction pass is
 * a full brain-LLM round trip per substantive turn — the gate skips it when
 * the cerebellum says nothing in the turn is memory-worthy. The brain still
 * does the actual extraction when the gate passes (JEV never generates text).
 * Mirrors TypeSafe's basic-memory cookbook: gate at P >= 0.5.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: gateMemoryWriteWithCerebellum NEVER throws and returns
 * null (no verdict) on HTTP errors, network errors, abort/timeout, malformed
 * payloads, and blank user text. null and true BOTH mean "proceed to the
 * brain extraction" — the gate is fail-open, so a broken cerebellum can only
 * cost money, never memories.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

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

/**
 * The memory-update phase runs after the user's reply is already delivered,
 * but the gate still gets the same hard abort deadline as every cerebellum
 * call: one shot, then the brain extraction proceeds ungated.
 */
export const CEREBELLUM_MEMORY_WRITE_GATE_TIMEOUT_MS = 2500;

/**
 * Noul probability at or above which the turn is worth a brain extraction
 * pass (cookbook default P >= 0.5). Below it the extraction is skipped for
 * this turn. Tuned against scripts/cerebellum-write-gate-eval.mjs on real
 * Chinese turns.
 */
export const CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD = 0.5;

/** Same excerpt caps as the brain extraction pass (runTurnMemoryExtractionDefault). */
export const CEREBELLUM_MEMORY_WRITE_GATE_MAX_USER_CHARS = 1200;
export const CEREBELLUM_MEMORY_WRITE_GATE_MAX_ASSISTANT_CHARS = 400;

export const CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID = 'worth_remembering';

/**
 * Noul instruction templates (ONE tunable place per mode). Instructions are
 * in English per TypeSafe's English-primary guidance and reference state
 * fields by backticked path; the state itself carries the user's original
 * (often Chinese) text. `{{EXPLICIT_ONLY}}` swaps the memory-worthy
 * definition for explicit-only sessions (implicit memories disabled).
 */
export const CEREBELLUM_MEMORY_WRITE_GATE_INSTRUCTIONS =
  'Does the conversation turn at `user_message` (with `assistant_message` as context) contain ' +
  'anything worth storing as a long-term memory about the user — a stable personal fact, a ' +
  'stable preference or habit, or an explicit remember/forget instruction given by the user? ' +
  'The user may write in ANY language. ' +
  '{{EXPLICIT_ONLY}}' +
  'Ignore questions, transient small talk, one-off tasks, current-session debugging context, ' +
  'and procedural/command output; a turn about only the task at hand is not memory-worthy.';

const EXPLICIT_ONLY_CLAUSE =
  'In this explicit-only mode ONLY an explicit remember/forget instruction from the user counts — ' +
  'personal facts and preferences do NOT. ';

const IMPLICIT_CLAUSE = '';

export const CEREBELLUM_MEMORY_WRITE_GATE_CRITERIA_EXPLICIT_ONLY = {
  true: 'The user gives an explicit remember/forget instruction in this turn.',
  false: 'The user gives no explicit remember/forget instruction; nothing here counts in explicit-only mode.',
} as const;

export const CEREBELLUM_MEMORY_WRITE_GATE_CRITERIA_IMPLICIT = {
  true: 'The turn contains at least one durable user fact, stable preference, or explicit remember/forget instruction.',
  false: 'The turn is transient — small talk, a question, a one-off task, or command output — with nothing durable about the user.',
} as const;

export interface CerebellumMemoryWriteGateQuestion {
  type: 'noul';
  instructions: string;
  criteria: { true: string; false: string };
}

export interface CerebellumMemoryWriteGateRequest {
  state: {
    user_message: string;
    assistant_message: string;
  };
  model: string;
  questions: Record<string, CerebellumMemoryWriteGateQuestion>;
}

export function buildMemoryWriteGateQuestion(input: {
  explicitOnly: boolean;
}): CerebellumMemoryWriteGateQuestion {
  const clause = input.explicitOnly ? EXPLICIT_ONLY_CLAUSE : IMPLICIT_CLAUSE;
  return {
    type: 'noul',
    instructions: CEREBELLUM_MEMORY_WRITE_GATE_INSTRUCTIONS.replaceAll('{{EXPLICIT_ONLY}}', clause),
    criteria: input.explicitOnly
      ? { ...CEREBELLUM_MEMORY_WRITE_GATE_CRITERIA_EXPLICIT_ONLY }
      : { ...CEREBELLUM_MEMORY_WRITE_GATE_CRITERIA_IMPLICIT },
  };
}

export function buildMemoryWriteGateRequest(input: {
  userText: string;
  assistantText: string;
  model: string;
  explicitOnly: boolean;
}): CerebellumMemoryWriteGateRequest {
  return {
    state: {
      user_message: truncateUtf16Prefix(
        String(input.userText ?? '').replace(/\s+/g, ' ').trim(),
        CEREBELLUM_MEMORY_WRITE_GATE_MAX_USER_CHARS,
      ),
      assistant_message: truncateUtf16Prefix(
        String(input.assistantText ?? '').replace(/\s+/g, ' ').trim(),
        CEREBELLUM_MEMORY_WRITE_GATE_MAX_ASSISTANT_CHARS,
      ),
    },
    model: input.model,
    questions: {
      [CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID]: buildMemoryWriteGateQuestion({
        explicitOnly: input.explicitOnly,
      }),
    },
  };
}

/**
 * Extract the gate noul (0..1) from a /v1/systemone payload. Returns null on
 * any unusable shape (no answers object, missing question, non-numeric noul).
 */
export function parseMemoryWriteGateAnswer(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answer = (payload as { answers?: unknown }).answers as Record<string, unknown> | undefined;
  if (!answer || typeof answer !== 'object') {
    return null;
  }
  const gate = answer[CEREBELLUM_MEMORY_WRITE_GATE_QUESTION_ID];
  if (!gate || typeof gate !== 'object') {
    return null;
  }
  const noul = (gate as { noul?: unknown }).noul;
  if (typeof noul !== 'number' || !Number.isFinite(noul)) {
    return null;
  }
  return Math.max(0, Math.min(1, noul));
}

/**
 * Ask the cerebellum whether the turn is worth a brain memory-extraction
 * pass. Returns true (worth it, noul >= threshold), false (skip, noul <
 * threshold), or null (no verdict — blank user text, HTTP/network error,
 * abort/timeout, malformed payload). Never throws.
 */
export async function gateMemoryWriteWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  userText: string;
  assistantText: string;
  explicitOnly: boolean;
  timeoutMs?: number;
}): Promise<boolean | null> {
  const { config, fetchImpl } = input;
  if (!String(input.userText ?? '').trim()) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, input.timeoutMs ?? CEREBELLUM_MEMORY_WRITE_GATE_TIMEOUT_MS),
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildMemoryWriteGateRequest({
        userText: input.userText,
        assistantText: input.assistantText,
        model: config.model,
        explicitOnly: input.explicitOnly,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const noul = parseMemoryWriteGateAnswer(await response.json());
    if (noul === null) {
      return null;
    }
    return noul >= CEREBELLUM_MEMORY_WRITE_GATE_THRESHOLD;
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller proceeds to the brain extraction as if no gate existed.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
