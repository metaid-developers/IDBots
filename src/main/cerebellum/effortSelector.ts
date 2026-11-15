/**
 * Cerebellum (小脑) reasoning-effort auto selection — roadmap #11 of the
 * cerebellum system.
 *
 * One JEV Choice question rates how much deliberation the user's message
 * intrinsically needs ({off, low, high, max}), and the "auto" effort rung
 * resolves per turn from that verdict:
 *
 *   - Assistant mode escalates ONLY when P(high)+P(max) crosses the threshold
 *     (default 0.5) — casual chat stays `off`, preserving the mode's
 *     fast-first-sentence promise; correctness-risk work (coding, debugging,
 *     multi-step analysis) gets the thinking it deserves.
 *   - Professional mode takes the argmax rung (conservative tie-break: the
 *     LOWER rung wins ties).
 *   - Any failure (disabled cerebellum, network, timeout, malformed payload,
 *     blank text) is null — the caller then falls back to the existing
 *     default chain and behavior is byte-identical to before.
 *
 * Phase-0 live validation (jev-1.13.0, 30 labeled Chinese cases,
 * scripts/cerebellum-effort-eval.mjs): exact-match 28/30 (both misses are
 * off→low on trivial drafting — harmless under the two-level policy), the
 * escalation sweep is 30/30 at EVERY threshold 0.3–0.8 (casual ≤0.02 vs
 * correctness-risk ≥0.81 — a clean cliff), ~600 input tokens per call
 * (≈$0.000025/turn), 200–665 ms latency. The request builder below is kept
 * byte-identical to the eval harness — tune them together.
 *
 * Pure and Electron-free so it is unit-testable in plain Node; the caller
 * injects the fetch implementation. In the app this MUST be
 * session.defaultSession.fetch: the Electron net stack follows the system
 * proxy, while bare Node fetch is region-blocked (HTTP 451) for some users.
 *
 * Failure contract: selectEffortWithCerebellum NEVER throws.
 */

import type { ResolvedCerebellumConfig } from '../libs/cerebellumConfig';
import type { CerebellumFetchLike } from './memoryRank';

/**
 * Solo-call budget. The other cerebellum call sites share a 1.5 s window; the
 * effort selector usually overlaps them (the runner kicks it before the
 * volatile-context build and awaits it at the effort resolution). The
 * Phase-0 eval measured 200–665 ms, but production JEV relay latency runs
 * hotter: cowork.log 2026-11-04..09 shows successful verdicts at a 701 ms
 * median with the tail pressed right against the budget, and 1 s aborted 72%
 * of all selector calls (93/130, every no-verdict settle ≥1000 ms) —
 * assistant mode then silently rode the fallback effort for most turns.
 * 2.5 s covers the observed production tail; the runner's race budget
 * (CEREBELLUM_EFFORT_RACE_BUDGET_MS) still bounds how long the turn START
 * waits, so this only caps the HTTP call, not the turn.
 */
export const CEREBELLUM_EFFORT_TIMEOUT_MS = 2500;

/**
 * Assistant-mode escalation threshold on P(high)+P(max). 0.5 sits in the
 * middle of the wide clean gap the Phase-0 eval measured (casual ≤0.02,
 * correctness-risk ≥0.81); anything in 0.3–0.8 scored identically.
 */
export const CEREBELLUM_EFFORT_ESCALATION_THRESHOLD = 0.5;

export type CerebellumEffortRung = 'off' | 'low' | 'high' | 'max';

export const CEREBELLUM_EFFORT_RUNGS: readonly CerebellumEffortRung[] = ['off', 'low', 'high', 'max'];

/** Probability per rung, all four keys always present after parsing. */
export type CerebellumEffortDistribution = Record<CerebellumEffortRung, number>;

/**
 * Choice instructions (ONE tunable place — keep in sync with
 * scripts/cerebellum-effort-eval.mjs). English per TypeSafe's
 * English-primary guidance; the user's original (often Chinese) message stays
 * in `state.user_message`.
 */
export const CEREBELLUM_EFFORT_INSTRUCTIONS =
  'How much reasoning effort does answering the user\'s message at `user_message` need? '
  + 'Judge the DEPTH of work the task intrinsically requires, not its topic or length. '
  + '`off`: casual chat, greetings, thanks, bare follow-ups, simple lookups, short single-shot '
  + 'factual or creative snippets, commands that just invoke a tool. '
  + '`low`: light drafting — summarizing, translating a passage, rephrasing, short structured '
  + 'writing with a clear shape to follow. '
  + '`high`: work with correctness risk — writing or debugging code, refactoring, multi-step '
  + 'analysis, tradeoff decisions, planning with failure modes. '
  + '`max`: formal proofs, rigorous derivations, intricate algorithm or protocol design. '
  + 'When unsure between two levels, pick the lower one — depth of thinking is expensive and is '
  + 'only worth it when the task genuinely needs it. The user may write in any language.';

export const CEREBELLUM_EFFORT_RUNG_CRITERIA: Record<CerebellumEffortRung, string> = {
  off: 'off — no deliberation needed: chat, greetings, simple facts, tool commands, follow-ups',
  low: 'low — light drafting: summarize, translate, rephrase, short structured writing',
  high: 'high — correctness-risk work: coding, debugging, refactoring, multi-step analysis, tradeoffs',
  max: 'max — formal or intricate reasoning: proofs, derivations, protocol/algorithm design',
};

export const CEREBELLUM_EFFORT_QUESTION_ID = 'effort_level';

export const CEREBELLUM_BUNDLED_EFFORT_INSTRUCTIONS =
  CEREBELLUM_EFFORT_INSTRUCTIONS.replace('`user_message`', '`current_message`');

export function buildBundledEffortQuestion(): Record<string, CerebellumEffortChoiceQuestion> {
  return {
    [CEREBELLUM_EFFORT_QUESTION_ID]: {
      type: 'choice',
      instructions: CEREBELLUM_BUNDLED_EFFORT_INSTRUCTIONS,
      criteria: CEREBELLUM_EFFORT_RUNG_CRITERIA,
    },
  };
}

export interface CerebellumEffortChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface CerebellumEffortSelectorRequest {
  state: {
    user_message: string;
  };
  model: string;
  questions: Record<string, CerebellumEffortChoiceQuestion>;
}

export function buildEffortSelectorRequest(input: {
  currentUserText: string;
  model: string;
}): CerebellumEffortSelectorRequest {
  return {
    state: {
      user_message: String(input.currentUserText ?? '').replace(/\s+/g, ' ').trim(),
    },
    model: input.model,
    questions: {
      [CEREBELLUM_EFFORT_QUESTION_ID]: {
        type: 'choice',
        instructions: CEREBELLUM_EFFORT_INSTRUCTIONS,
        criteria: CEREBELLUM_EFFORT_RUNG_CRITERIA,
      },
    },
  };
}

/**
 * Extract the effort distribution from a /v1/systemone payload. Unknown rung
 * keys are skipped, values clamped to [0,1]; a usable probabilities map must
 * carry at least one known rung, and missing rungs read as 0. A bare
 * top-level `choice` naming a known rung becomes that rung at probability 1.
 * Returns null on any other unusable shape.
 */
export function parseEffortSelectorAnswers(payload: unknown): CerebellumEffortDistribution | null {
  if (!payload || typeof payload !== 'object') {
    return null;
  }
  const answer = (payload as { answers?: unknown }).answers as Record<string, unknown> | undefined;
  if (!answer || typeof answer !== 'object') {
    return null;
  }
  const record = answer[CEREBELLUM_EFFORT_QUESTION_ID];
  if (!record || typeof record !== 'object') {
    return null;
  }

  const distribution: CerebellumEffortDistribution = { off: 0, low: 0, high: 0, max: 0 };
  const probabilities = (record as Record<string, unknown>).probabilities;
  if (probabilities && typeof probabilities === 'object') {
    let known = 0;
    for (const [key, value] of Object.entries(probabilities as Record<string, unknown>)) {
      if (!(CEREBELLUM_EFFORT_RUNGS as readonly string[]).includes(key)
        || typeof value !== 'number'
        || !Number.isFinite(value)) {
        continue;
      }
      distribution[key as CerebellumEffortRung] = Math.max(0, Math.min(1, value));
      known += 1;
    }
    if (known > 0) {
      return distribution;
    }
  }

  const choice = (record as Record<string, unknown>).choice;
  if (typeof choice === 'string' && (CEREBELLUM_EFFORT_RUNGS as readonly string[]).includes(choice)) {
    distribution[choice as CerebellumEffortRung] = 1;
    return distribution;
  }
  return null;
}

/**
 * Policy resolution from a distribution.
 *
 * Assistant mode: a two-level policy — escalate to thinking only when
 * P(high)+P(max) crosses CEREBELLUM_EFFORT_ESCALATION_THRESHOLD, then take
 * the heavier of the two; otherwise `off`. The Phase-0 eval measured a clean
 * cliff between casual (≤0.02) and correctness-risk (≥0.81) messages, so the
 * threshold placement is forgiving, and the mode's fast-first-sentence
 * promise survives casual chat untouched.
 *
 * Professional mode: argmax across all four rungs with a conservative
 * tie-break (the LOWER rung wins — thinking is the expensive side).
 */
export function resolveAutoEffortRung(
  distribution: CerebellumEffortDistribution,
  options: { assistantMode: boolean },
): CerebellumEffortRung {
  if (options.assistantMode) {
    const escalated = distribution.high + distribution.max >= CEREBELLUM_EFFORT_ESCALATION_THRESHOLD;
    if (!escalated) return 'off';
    return distribution.max > distribution.high ? 'max' : 'high';
  }
  let best: CerebellumEffortRung = 'off';
  for (const rung of CEREBELLUM_EFFORT_RUNGS) {
    // Strict `>` keeps the earlier (lower) rung on ties.
    if (distribution[rung] > distribution[best]) {
      best = rung;
    }
  }
  return best;
}

/**
 * Turn-acknowledgment tiers (renderer-side phrase pools live in
 * src/renderer/components/cowork/turnAckPhrases.ts; this mapping is the
 * single difficulty source of truth shared by both halves):
 * off/low → 'fast' ("on it right away"), high → 'moderate' ("needs a
 * moment"), max → 'heavy' ("complex, may take a few minutes"). The same
 * judgment that makes the model think longer tells the user to wait longer,
 * so the promised expectation always matches the actual effort.
 */
export type TurnAckDifficultyTier = 'fast' | 'moderate' | 'heavy';

export function mapCerebellumEffortRungToTurnAckTier(
  rung: CerebellumEffortRung,
): TurnAckDifficultyTier {
  if (rung === 'max') return 'heavy';
  if (rung === 'high') return 'moderate';
  return 'fast';
}

/**
 * How long an escalated rung sticks around a session. Single-message
 * classification misses conversation context: a bare "继续" during a coding
 * session classifies off, yet it IS part of the complex work. Stickiness
 * holds the last escalated rung so follow-ups within the window keep it; the
 * window refreshes only on a FRESH escalation (a sticky-sustained turn does
 * not extend it), so a casual interlude rides high for at most this long
 * even if the conversation never pauses.
 */
export const CEREBELLUM_EFFORT_STICKY_WINDOW_MS = 10 * 60_000;

const EFFORT_RUNG_ORDER: Record<CerebellumEffortRung, number> = { off: 0, low: 1, high: 2, max: 3 };

/** Per-session sticky state held by the caller (the cowork runner). */
export interface CerebellumEffortSticky {
  rung: CerebellumEffortRung;
  at: number;
}

export interface ResolvedStickyAutoEffort {
  rung: CerebellumEffortRung;
  /** True when a fresh sticky entry overrode this turn's base verdict. */
  stickyUsed: boolean;
  /** Next sticky state to store, or null to clear. */
  nextSticky: CerebellumEffortSticky | null;
}

/**
 * Session-sticky wrapper around resolveAutoEffortRung. The effective rung is
 * the heavier of the base verdict and a still-fresh sticky entry; only a
 * fresh ESCALATED base verdict (or a sticky-sustained escalated turn, see
 * below) refreshes the entry:
 *  - escalated base → nextSticky = { rung, at: now } (window restarts);
 *  - sticky-sustained escalated turn → the entry is kept AS IS (at unchanged)
 *    so the window still expires 10 min after the last genuine escalation;
 *  - anything at/below low with no fresh entry → cleared.
 */
export function resolveStickyAutoEffortRung(
  distribution: CerebellumEffortDistribution,
  options: {
    assistantMode: boolean;
    sticky?: CerebellumEffortSticky | null;
    nowMs?: number;
  },
): ResolvedStickyAutoEffort {
  const now = options.nowMs ?? Date.now();
  const base = resolveAutoEffortRung(distribution, { assistantMode: options.assistantMode });
  const stickyFresh = options.sticky != null && now - options.sticky.at <= CEREBELLUM_EFFORT_STICKY_WINDOW_MS;
  const stickyRung = stickyFresh ? options.sticky!.rung : null;
  const rung = stickyRung && EFFORT_RUNG_ORDER[stickyRung] > EFFORT_RUNG_ORDER[base] ? stickyRung : base;
  const stickyUsed = rung !== base;
  const escalated = EFFORT_RUNG_ORDER[rung] >= EFFORT_RUNG_ORDER.high;
  let nextSticky: CerebellumEffortSticky | null = null;
  if (escalated) {
    nextSticky = EFFORT_RUNG_ORDER[base] >= EFFORT_RUNG_ORDER.high
      ? { rung, at: now }
      : (stickyFresh ? options.sticky! : null);
  }
  return { rung, stickyUsed, nextSticky };
}

/**
 * Ask the cerebellum how much reasoning effort the current user message
 * needs. Returns the probability distribution, or null on any failure
 * (blank text, HTTP/network errors, abort/timeout, malformed payloads).
 * Never throws.
 */
export async function selectEffortWithCerebellum(input: {
  config: ResolvedCerebellumConfig;
  fetchImpl: CerebellumFetchLike;
  currentUserText: string;
  timeoutMs?: number;
}): Promise<CerebellumEffortDistribution | null> {
  const { config, fetchImpl } = input;
  if (!String(input.currentUserText ?? '').trim()) {
    return null;
  }

  const effectiveTimeoutMs = Math.max(1, input.timeoutMs ?? CEREBELLUM_EFFORT_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    effectiveTimeoutMs,
  );
  try {
    const response = await fetchImpl(`${config.baseUrl}/v1/systemone`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'Content-Type': 'application/json',
        'X-Deadline-Ms': String(effectiveTimeoutMs),
      },
      body: JSON.stringify(buildEffortSelectorRequest({
        currentUserText: input.currentUserText,
        model: config.model,
      })),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    return parseEffortSelectorAnswers(await response.json());
  } catch {
    // Network errors, aborts/timeouts and JSON parse failures all land here:
    // the caller keeps the existing default effort chain for this turn.
    return null;
  } finally {
    clearTimeout(timer);
  }
}
