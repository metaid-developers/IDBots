/**
 * Model thinking-capability profile — the single source of truth for how a
 * model id maps onto thinking/reasoning wire controls and output budgets.
 *
 * Why this module exists (the 2026-09-20 dream-fragment outage): the
 * one-shot LLM chain reasoned about "thinking" via the CALLER'S toggle, not
 * the model's actual capability. A dream fragment asked for
 * `thinking: 'disabled'` with a 4096-token output ceiling; the zhipu
 * (responses-format) conversion dropped the toggle for every non-DeepSeek
 * provider; GLM-5.x always thinks — so hidden reasoning consumed the whole
 * 4096-token budget and the reply died as `stop_reason=max_tokens,
 * blocks=none`. Every layer that needs to know "will this model think, and
 * how do I express off/low on its wire" must ask here instead of pattern
 * matching on its own.
 *
 * Capability facts (official docs, 2026-09):
 *  - DeepSeek Responses API: `reasoning.effort` none|low|high|max; omitting
 *    the field leaves thinking ON at 'high'. 'none' fully disables.
 *  - GLM-5.x (zhipu open.bigmodel.cn / z.ai, any gateway serving them):
 *    ALWAYS thinks. `thinking: {type:'disabled'}` and `reasoning: {effort:
 *    'none'}` are rejected with HTTP 400 code 1210 (「该模型始终思考，不支
 *    持关闭思考」). The best "off" is the lowest tier ('low').
 *  - GLM-4.5–4.7: thinking is switchable; 'none'/disabled is honored.
 *  - Unknown families: no dialect is known, so "off" cannot be expressed —
 *    the field is omitted and the model's default (possibly thinking ON)
 *    applies. Budgets must assume thinking for these.
 *
 * Detection is by MODEL ID (last path segment, so gateway-prefixed ids like
 * `z-ai/glm-5.3-flash` or `deepseek/deepseek-flash` resolve), NOT by provider
 * key: a new custom provider serving a known model family gets the correct
 * wire mapping automatically — the class of "every new provider breaks the
 * automation calls" incidents this module exists to end.
 */

/** Wire dialect family for thinking/reasoning controls, keyed off the model id. */
export type ThinkingWireFamily = 'deepseek' | 'glm' | 'unknown';

function lastPathSegment(modelId: string | null | undefined): string {
  const normalized = (modelId ?? '').trim().toLowerCase();
  return (normalized.split('/').pop() ?? normalized).trim();
}

/** Resolve the thinking wire family for a model id (gateway prefixes tolerated). */
export function thinkingWireFamily(modelId: string | null | undefined): ThinkingWireFamily {
  const segment = lastPathSegment(modelId);
  if (!segment) return 'unknown';
  if (segment.includes('deepseek')) return 'deepseek';
  if (/(?:^|[-_/])glm(?:[-_/]|$)/.test(segment)) return 'glm';
  return 'unknown';
}

/** Major version of a GLM id (`glm-5.3-flash` → 5); null when not a versioned GLM id. */
function glmMajorVersion(segment: string): number | null {
  const match = /(?:^|[-_/])glm-(\d+)/.exec(segment);
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Whether the model thinks no matter what the caller requests. GLM-5+ always
 * thinks (rejects every off control — see module docs). DeepSeek and GLM-4.x
 * can genuinely disable; unknown families are reported as false here (use
 * {@link budgetAssumesThinking} for the conservative budget view).
 */
export function modelAlwaysThinks(modelId: string | null | undefined): boolean {
  const segment = lastPathSegment(modelId);
  if (thinkingWireFamily(segment) !== 'glm') return false;
  const major = glmMajorVersion(segment);
  return major != null && major >= 5;
}

/**
 * Whether this route can express "thinking off" at all in a form the DSH
 * dispatch will accept. Two disjoint cases fail:
 *  - ALWAYS-THINKS families (glm-5+): every off control is rejected upstream
 *    (HTTP 400 code 1210), so the honest floor is the lowest tier.
 *  - UNKNOWN families: no dialect is declared for them, pi-ai materializes
 *    `reasoning: false`, and the dsh-llm capability gate throws
 *    UNSUPPORTED_REASONING_EFFORT on any requested 'off' before provider
 *    I/O (2026-11-26 incident: `gemini-4-hydrogen` on a custom opencode-zen
 *    responses route — the "Auto" effort rung resolved to 'off' and the turn
 *    died before dispatch). Unknown means we cannot vouch for 'off', so the
 *    auto chain must floor to 'low' instead of guessing.
 *
 * DeepSeek (either dialect) and GLM-4.x genuinely honor disabling and stay
 * false here.
 */
export function modelCannotExpressOff(modelId: string | null | undefined): boolean {
  const segment = lastPathSegment(modelId);
  return thinkingWireFamily(segment) === 'unknown' || modelAlwaysThinks(segment);
}

/**
 * Responses-wire `reasoning.effort` value that best expresses "the caller
 * asked thinking OFF" for this model:
 *  - deepseek / glm-4.x → 'none' (fully disables thinking)
 *  - glm-5+ → 'low' (cannot disable; lowest tier keeps reasoning bounded)
 *  - unknown family → null (omit the field — no known dialect; sending a
 *    guess could 400 on a relay that rejects unknown values)
 */
export function responsesEffortForThinkingOff(modelId: string | null | undefined): 'none' | 'low' | null {
  const segment = lastPathSegment(modelId);
  const family = thinkingWireFamily(segment);
  if (family === 'deepseek') return 'none';
  if (family === 'glm') return modelAlwaysThinks(segment) ? 'low' : 'none';
  return null;
}

/**
 * Whether an output-token budget for this call must leave headroom for
 * reasoning tokens. Reasoning shares the providers' output budget, so a
 * "thinking-off-sized" 4K ceiling truncates the reply to nothing whenever the
 * model thinks anyway (the 2026-09-20 `stop_reason=max_tokens; blocks=none`
 * dream-fragment failure).
 *
 * Conservative by design: only a caller-requested 'disabled' on a family that
 * is KNOWN to honor disabling (deepseek, glm-4.x) counts as thinking-off.
 * Everything else — enabled, model default (undefined), always-thinking
 * models, unknown families — budgets for reasoning. Ceilings are free
 * (billing is by actual tokens), a truncation is not.
 */
export function budgetAssumesThinking(
  modelId: string | null | undefined,
  thinking: 'enabled' | 'disabled' | undefined
): boolean {
  if (thinking === 'enabled') return true;
  const segment = lastPathSegment(modelId);
  if (thinking !== 'disabled') return true; // model default: assume it thinks
  if (modelAlwaysThinks(segment)) return true; // glm-5+: cannot turn off
  return thinkingWireFamily(segment) === 'unknown'; // can't express "off" → may think
}
