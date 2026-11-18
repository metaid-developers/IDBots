// App-wide LLM reasoning-effort vocabulary and its per-wire mappings.
//
// The UI exposes a single four-step ladder — off / low / high / max — matching
// the first-party dsh-llm-deepseek adapter's native ladder. Every persistence
// surface (MetaBot brain fields, cowork session effort) stores values from
// this vocabulary; `null` means "follow the model default".
//
// One non-ladder token is legal on the cowork session effort column:
// LLM_EFFORT_DEFAULT_SENTINEL records the composer/session picker's top
// rung ("Auto" today; historically the explicit "Default" pick). See its
// doc below for the current contract and the read-boundary compatibility
// with rows written under the old meaning.
//
// The renderer mirror of the vocabulary lives in
// src/renderer/services/modelCatalog.ts (LlmEffortLevel) — keep the two in
// sync when the ladder changes.
//
// History: the pre-2026-08 effort selector used a five-value ladder
// (null/low/medium/high/max). Unambiguous leftover tokens (medium / minimal /
// xhigh) still convert at read boundaries. Canonical `low` must NOT convert
// to `off`: the current picker uses `low` for light thinking, and rewriting
// it as `off` made the Low choice display and run as Off.

export type LlmEffortLevel = 'off' | 'low' | 'high' | 'max';

export const LLM_EFFORT_LEVELS: readonly LlmEffortLevel[] = ['off', 'low', 'high', 'max'];

/**
 * Marker stored on cowork_sessions.effort (and passed as the session
 * effortOverride) by the composer/session pickers for the top "Auto" rung.
 * It must be a TRUTHY string that is NOT a canonical level, so "picked
 * Auto" stays distinguishable from "never picked" (plain null).
 *
 * Contract history (compat lives at the runner's read boundary — see
 * resolveEffectiveEffort / resolveAutoEffortFallback in coworkRunner):
 * - Pre-auto rows: an explicit "Default" pick whose promise was "model
 *   default, NEVER the bot-brain/global rungs" — the sentinel was created
 *   to stop the old `effortOverride ?? brain ?? global ?? model` chain
 *   before a brain pinned to high.
 * - Effort-auto rows (2026-10+): the "Auto" rung — the cerebellum effort
 *   selector resolves per message; when no verdict lands, the fallback
 *   honors the old promise by degrading to the MODEL DEFAULT, never the
 *   brain/global chain (plain-null sessions keep that chain).
 * toLlmEffortLevel maps the sentinel to null (the model's own default).
 */
export const LLM_EFFORT_DEFAULT_SENTINEL = 'default';

const LEVEL_SET = new Set<string>(LLM_EFFORT_LEVELS);

/** True when `value` is one of the four canonical effort levels. */
export function isLlmEffortLevel(value: unknown): value is LlmEffortLevel {
  return typeof value === 'string' && LEVEL_SET.has(value);
}

/** Ladder rank: off(0) < low(1) < high(2) < max(3); null/unknown ranks -1. */
const LEVEL_RANK: Record<LlmEffortLevel, number> = { off: 0, low: 1, high: 2, max: 3 };

export function effortLevelRank(level: LlmEffortLevel | null | undefined): number {
  return level != null && LEVEL_SET.has(level) ? LEVEL_RANK[level] : -1;
}

/**
 * The higher of two effort levels. `null` means "no say" and loses to any
 * concrete level (two nulls → null). Used to pin an IN-TURN effort floor: a
 * GT-02 fallback attempt may not run the remainder of a turn below the
 * effort the primary attempt already started with — swapping the model AND
 * silently dropping the reasoning tier is a double downgrade (2026-11-18
 * Studio session post-mortem: GLM pinned 'low' → deepseek fallback 'off',
 * 16 turns in one evening).
 */
export function maxLlmEffortLevel(
  a: LlmEffortLevel | null | undefined,
  b: LlmEffortLevel | null | undefined,
): LlmEffortLevel | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return effortLevelRank(a) >= effortLevelRank(b) ? a : b;
}

/**
 * Map a leftover five-step effort token onto the current four-step ladder.
 * Canonical off/low/high/max pass through unchanged — `low` is a current
 * picker rung ("light thinking"), not a synonym for "thinking off".
 *
 *   null → null (auto / model default)
 *   off / low / high / max → themselves
 *   'default' → null (explicit Default pick; the sentinel's explicitness is
 *               carried by the token itself, the result is model default)
 *   minimal / none / disabled → 'off'
 *   medium → 'low'
 *   xhigh → 'max'
 */
export function convertLegacyEffortLevel(value: unknown): LlmEffortLevel | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return null;
  if (isLlmEffortLevel(normalized)) return normalized;
  switch (normalized) {
    case LLM_EFFORT_DEFAULT_SENTINEL:
      return null;
    case 'minimal':
    case 'none':
    case 'disabled':
      return 'off';
    case 'medium':
      return 'low';
    case 'xhigh':
      return 'max';
    default:
      return null;
  }
}

/**
 * Accept either vocabulary at a persistence boundary and normalize onto the
 * four-step ladder. Canonical values (including `low`) pass through.
 */
export function toLlmEffortLevel(value: unknown): LlmEffortLevel | null {
  return convertLegacyEffortLevel(value);
}

/**
 * Effort for the Claude Agent SDK query options. The SDK accepts
 * low/medium/high/xhigh/max and silently downgrades for models without the
 * higher steps, so max maps losslessly. `off` disables thinking instead of
 * picking an effort step.
 */
export function effortForClaudeSdk(
  effort: LlmEffortLevel | null | undefined,
): { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; thinking?: { type: 'enabled' | 'disabled' } } {
  switch (effort ?? null) {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { effort: 'low' };
    case 'high':
      return { effort: 'high' };
    case 'max':
      return { effort: 'max', thinking: { type: 'enabled' } };
    default:
      return {};
  }
}

/**
 * Effort for the Anthropic Messages wire (thinking + budget_tokens). Budgets
 * follow the tiers the direct-call path already used (10k default), with a
 * smaller low tier and a larger max tier. `off` disables thinking.
 */
export function effortForAnthropicWire(
  effort: LlmEffortLevel | null | undefined,
): { thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'disabled' } } {
  switch (effort ?? null) {
    case 'off':
      return { thinking: { type: 'disabled' } };
    case 'low':
      return { thinking: { type: 'enabled', budget_tokens: 4000 } };
    case 'high':
      return { thinking: { type: 'enabled', budget_tokens: 10000 } };
    case 'max':
      return { thinking: { type: 'enabled', budget_tokens: 32000 } };
    default:
      return {};
  }
}

/**
 * Effort for OpenAI-compatible reasoning_effort. The wire only has
 * low/medium/high (plus minimal on some models), so max caps at high and off
 * omits the parameter entirely (providers keep their default behavior).
 */
export function effortForOpenAiWire(
  effort: LlmEffortLevel | null | undefined,
): 'low' | 'medium' | 'high' | undefined {
  switch (effort ?? null) {
    case 'off':
      return undefined;
    case 'low':
      return 'low';
    case 'high':
      return 'high';
    case 'max':
      return 'high';
    default:
      return undefined;
  }
}
