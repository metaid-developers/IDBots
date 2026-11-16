export const DEFAULT_COWORK_CONTEXT_WINDOW = 128_000;
// Uncatalogued-model output ceiling. Current mainstream models cap output far
// above 32K, and thinking-mode reasoning shares the output budget — the old
// 32K default truncated long-thinking steps on uncatalogued SKUs and forced
// the paid truncated-turn auto-continue. Billing is by actual tokens used, so
// a generous DECLARED ceiling costs nothing for short replies — but the
// resolved value is still clamped against the context window at resolution
// time (see clampCoworkMaxOutputTokens) so small-window models keep a viable
// compaction pressure budget.
export const DEFAULT_COWORK_MAX_OUTPUT_TOKENS = 128_000;

/**
 * Effective output-ceiling clamp, applied at resolution time to every source
 * (explicit provider rows included). The DSH kernel's proactive compaction
 * computes its pressure budget as
 * `contextWindow - reservedOutput - headroomTokens` and silently disables
 * itself for a route when that goes non-positive (TargetPressureConfigError:
 * one suppressed warning, then the turn continues with compaction OFF). The
 * 128K default output ceiling does exactly that to every model whose window
 * is ≤192K — the 2026-09-30 space-bunny-free incident: a real-128K model
 * never compacted proactively, overflowed at its true window, and the
 * reactive summarize request (full history, same model) overflowed again.
 *
 * The cap is tiered by window size so the compaction threshold (ratio×window,
 * further capped by window − output − headroom) can sit at 90% for small
 * windows and 80% for large ones (see compactionModelPolicies in
 * dsh-runtime/lib/generate-runtime-config.mjs — keep the tiers in sync):
 *
 * - Small windows (<256K): output ≤ 6% of the window. A small-window model
 *   burns a noticeable share of its context on the very first prompt (~8K
 *   against 128K), so the threshold must sit high (90%) to keep usable
 *   context; that only works if output + headroom stay within the remaining
 *   10%. A 128K model lands at the 8K floor — 6.4% of its window.
 * - Large windows (≥256K): output ≤ 32% of the window. Long-form / thinking
 *   workloads need the generous completion budget, and the threshold cap is
 *   dominated by ratio×window (80%) anyway, so reserving a third of the
 *   window for output costs no usable context.
 *
 * The 8K floor keeps a viable thinking budget on tiny windows either way.
 * The tier boundary is intentionally discontinuous (262143 → ~15.4K cap vs
 * 262144 → ~81.9K): crossing into the ≥256K tier drops the compaction
 * threshold to 80%, which funds the larger output reserve.
 */
export const COWORK_SMALL_WINDOW_TOKENS = 262_144;
export const COWORK_MAX_OUTPUT_SMALL_WINDOW_RATIO = 0.06;
export const COWORK_MAX_OUTPUT_WINDOW_RATIO = 0.32;
export const COWORK_MAX_OUTPUT_FLOOR_TOKENS = 8_192;

export function clampCoworkMaxOutputTokens(maxOutputTokens: number, contextWindow: number): number {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return maxOutputTokens;
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return maxOutputTokens;
  const ratio = contextWindow < COWORK_SMALL_WINDOW_TOKENS
    ? COWORK_MAX_OUTPUT_SMALL_WINDOW_RATIO
    : COWORK_MAX_OUTPUT_WINDOW_RATIO;
  const windowCap = Math.max(
    COWORK_MAX_OUTPUT_FLOOR_TOKENS,
    Math.floor(contextWindow * ratio),
  );
  return Math.min(Math.floor(maxOutputTokens), windowCap);
}
// The whole DeepSeek V4 family shares the same 1M context window. The flash
// variant powers cowork/A2A automation sessions (via resolveAutomationModelOverride),
// so it must carry the same window as v4-pro or the context ring wrongly falls back
// to DEFAULT_COWORK_CONTEXT_WINDOW (128K) for every automation-driven conversation.
export const DEEPSEEK_V4_PRO_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_V4_FLASH_CONTEXT_WINDOW = 1_000_000;
// The DeepSeek API allows up to 384K output tokens for the whole V4 family
// (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). 256K is the app's
// declared ceiling — aligned with upstream deepseek-harness
// (DEFAULT_MAX_TOKENS in packages/llm/llm-deepseek/src/defaults.ts), whose
// flash catalog entries declare no per-model maxTokens so the 256K default
// applies. Thinking-mode reasoning shares the output budget, so the earlier
// 32K ceiling truncated effort-high/effort-max steps mid-thought and forced
// the paid truncated-turn auto-continue (observed as `max-tokens` turn/end
// reasons in IDBots logs, none upstream); 256K restores parity. This is
// independent of the MetaApp bridge's maxOutputTokens validation limit
// (botBrowserBridgeService caps MetaApp-requested completions at 32K — that
// is a separate API contract and stays unchanged). Billing is by actual
// tokens used, so a higher declared ceiling costs nothing for short replies.
// Existing installs' provider rows that pin the old 32_768 default are
// rewritten once at startup (services/deepseekOutputCeilingMigration).
export const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 256_000;
export const DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS = 256_000;
// GLM-5.x actual max output is 128K (z.ai); the declared ceiling now matches
// it. The 2026-09-14 silent-stall incident (glm-5.3-flash sessions e6af1710,
// 572751a8, 10b02949) came from the old 8192 fallback, not from a generous
// ceiling — thinking shares the output budget, so matching the real cap
// removes mid-thought truncation. Billing is by actual tokens used.
export const GLM_MAX_OUTPUT_TOKENS = 128_000;

export type CoworkModelLimitSource = 'provider-model' | 'available-model' | 'known-model' | 'family-model' | 'fallback';

export interface CoworkModelLimits {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  /**
   * Whether the model can consume image content blocks (vision). Resolution
   * order: the session provider's own model row (the Settings "支持图像输入"
   * checkbox — the user's per-provider override, honored exactly as checked),
   * then the catalog/family knowledge below. Unknown / unlisted models
   * default to `false` (fail-safe): the Read-image guard then denies image
   * reads with an explicit pointer to the relay-backed describe_image
   * instead of silently dropping pixels on a model that cannot read them
   * (the 2026-09-04 glm-5.3-flash regression). Only models KNOWN to support
   * vision are marked true.
   */
  supportsVision: boolean;
  source: CoworkModelLimitSource;
}

type ModelLike = {
  id?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
  supportsVision?: unknown;
  supportsImage?: unknown;
};

type ProviderLike = {
  enabled?: unknown;
  models?: unknown;
};

type AppConfigLike = {
  model?: {
    defaultModel?: unknown;
    availableModels?: unknown;
  };
  providers?: Record<string, ProviderLike> | null;
};

const KNOWN_MODEL_LIMITS: Record<string, Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>>> = {
  // DeepSeek V4.1 Flash (`deepseek-flash`, renamed from deepseek-v4-flash at
  // the 2026-09-10 V4.1 launch) is natively multimodal; V4 Pro stays
  // text-only (2026-08-09 diagnosis: a deepseek-v4-pro session ballooned to
  // 60% context from Read image base64 the model could never interpret).
  // The retired v4-flash / vision-exp aliases keep their entries: upstream
  // still accepts those ids, and stored sessions resolve their limits here.
  // Read/View image guards key off this.
  'deepseek-flash': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: true,
  },
  'deepseek-4.1-flash': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: true,
  },
  'deepseek-v4-pro': {
    contextWindow: DEEPSEEK_V4_PRO_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS,
    supportsVision: false,
  },
  'deepseek-v4-flash': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: false,
  },
  'deepseek-v4-flash-vision-exp': {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: true,
  },
  // 与 src/renderer/config.ts 预设模型保持一致的大上下文模型（2026-07 向 LobsterAI 对齐）
  'gpt-5.6-sol': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.6-terra': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.6-luna': { contextWindow: 1_050_000, supportsVision: true },
  // Older GPT-5.x presets still offered by the renderer; inherit the same family window.
  'gpt-5.5': { contextWindow: 1_050_000, supportsVision: true },
  'gpt-5.4': { contextWindow: 1_050_000, supportsVision: true },
  'claude-opus-4-7': { contextWindow: 1_048_576, supportsVision: true },
  'claude-opus-4-6': { contextWindow: 1_048_576, supportsVision: true },
  'claude-sonnet-4-6': { contextWindow: 1_048_576, supportsVision: true },
  // OpenRouter aliases route to the same upstream models.
  'anthropic/claude-sonnet-4.6': { contextWindow: 1_048_576, supportsVision: true },
  'anthropic/claude-opus-4.7': { contextWindow: 1_048_576, supportsVision: true },
  'openai/gpt-5.5': { contextWindow: 1_050_000, supportsVision: true },
  'google/gemini-3.1-pro-preview': { contextWindow: 2_000_000, supportsVision: true },
  // Gemini 3.x family — 2M context per Google's Gemini 3 spec.
  'gemini-3.1-pro-preview': { contextWindow: 2_000_000, supportsVision: true },
  'gemini-3-flash-preview': { contextWindow: 2_000_000, supportsVision: true },
  'gemini-3.1-flash-lite': { contextWindow: 2_000_000, supportsVision: true },
  'kimi-k2.6': { contextWindow: 262_144, supportsVision: true },
  'kimi-k2.5': { contextWindow: 262_144, supportsVision: true },
  // GLM-5.3 family (Zhipu direct): the whole family shares a 1M context
  // window (1048576 per the live catalog GET /api/v1/models, 2026-09-18).
  // glm-5.3-flash is natively multimodal — image input verified live through
  // the Responses endpoint on 2026-09-18 (matches the official GLM-5.3-Flash
  // docs); the flagship glm-5.3 stays text-only ("目前仅支持处理文本模态信
  // 息"). Older GLM ids keep the historical no-vision/no-1M entries. Gateway
  // ids (commandcode z-ai/glm-5.3-flash, zai-org/GLM-*) serve the SAME
  // upstream multimodal flash SKU, so they declare vision too (2026-09-28
  // owner decision: every provider's GLM-5.3 Flash must read images; the
  // earlier fail-safe false silenced vision for users who proxied the model
  // through a gateway).
  'glm-5.3-flash': { contextWindow: 1_048_576, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: true },
  'glm-5.3-flashx': { contextWindow: 1_048_576, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: true },
  'glm-5.3': { contextWindow: 1_048_576, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-5.2': { contextWindow: 1_000_000, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-5.2-fast': { contextWindow: 1_000_000, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'z-ai/glm-5.3-flash': { contextWindow: 1_048_576, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: true },
  'zai-org/GLM-5.3': { contextWindow: 1_000_000, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'zai-org/GLM-5.2': { contextWindow: 1_000_000, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'zai-org/GLM-5.2-Fast': { contextWindow: 1_000_000, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'zai-org/GLM-5.1': { contextWindow: 202_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'zai-org/GLM-5': { contextWindow: 202_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-5.1': { contextWindow: 202_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-5': { contextWindow: 202_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-4.7': { contextWindow: 204_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'glm-4.7-flash': { contextWindow: 204_800, maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: false },
  'MiniMax-M3': { contextWindow: 1_000_000, supportsVision: true },
  'MiniMax-M2.7': { contextWindow: 204_800, supportsVision: true },
  'MiniMax-M2.5': { contextWindow: 204_800, supportsVision: true },
  'qwen3.6-plus': { contextWindow: 1_000_000, supportsVision: true },
  'qwen3.5-plus': { contextWindow: 1_000_000, supportsVision: true },
  // Qwen3 coder / ollama-local preset; Qwen3 family supports up to 1M.
  'qwen3-coder-next': { contextWindow: 1_000_000, supportsVision: true },
  'mimo-v2.5-pro': { contextWindow: 1_000_000, supportsVision: true },
  'mimo-v2.5': { contextWindow: 1_000_000, supportsVision: true },
};

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * DeepSeek V4 family fallback for ids no exact catalog entry tracks. The
 * vendor ships ephemeral/regional SKUs that append suffixes to the family
 * name (deepseek-v4.1-flash-expires-on-0910) — an exact-match catalog can
 * never keep up, and the uncatalogued id fell to the old
 * DEFAULT_COWORK_MAX_OUTPUT_TOKENS (8192). With reasoning effort 'max' the
 * thinking tokens alone consumed that ceiling and the turn died as a
 * hollow-completed reasoning-only truncation (the 2026-09-09 cw-86812c4f
 * stall). The whole V4 family shares one API contract (1M context, the
 * 32K-declared output ceiling), so any id whose last path segment (gateways
 * prefix vendor ids: 'deepseek/deepseek-v4.1-flash') starts with
 * 'deepseek-v4' inherits the family limits. The renamed V4.1+ line
 * ('deepseek-flash', e.g. gateway ids like 'deepseek/deepseek-flash') gets
 * the same treatment; those SKUs are natively multimodal, while the legacy
 * v4-* line stays fail-safe false unless the SKU name says 'vision'.
 */
function deepseekV4FamilyLimits(modelId: string): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>> | undefined {
  const segment = (modelId.split('/').pop() ?? modelId).toLowerCase();
  if (segment.startsWith('deepseek-flash') || segment.startsWith('deepseek-4.1-flash')) {
    return {
      contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
      maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
      supportsVision: true,
    };
  }
  if (!segment.startsWith('deepseek-v4') && !segment.startsWith('deepseek-4.')) return undefined;
  return {
    contextWindow: DEEPSEEK_V4_FLASH_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_FLASH_MAX_OUTPUT_TOKENS,
    supportsVision: segment.includes('vision'),
  };
}

/**
 * GLM-4.5+ / GLM-5.x family fallback for gateway ids the exact catalog does
 * not track (`z-ai/glm-5.4-flash`, ephemeral SKUs). Thinking shares the
 * output budget, so uncatalogued ids pin the family's 128K ceiling even if
 * a future DEFAULT change regresses. Context window stays on the conservative
 * default unless the exact SKU is catalogued — only the output ceiling is
 * the stall-critical field. Vision is the one modality the family rule
 * declares: every spelling of the GLM-5.3 flash variant (vendor prefixes,
 * case variants like `GLM-5.3-Flash`) serves the same natively multimodal
 * SKU (2026-09-18 live verification), so it resolves vision=true; the
 * flagship and older families stay fail-safe text-only.
 */
function glmFamilyLimits(modelId: string): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>> | undefined {
  const segment = (modelId.split('/').pop() ?? modelId);
  if (!/^glm-(?:4\.[5-9]|[5-9])/i.test(segment)) return undefined;
  if (/^glm-5\.3-flash/i.test(segment)) {
    return { maxOutputTokens: GLM_MAX_OUTPUT_TOKENS, supportsVision: true };
  }
  return { maxOutputTokens: GLM_MAX_OUTPUT_TOKENS };
}

function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return undefined;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

function isModelLike(value: unknown): value is ModelLike {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function getModelLimits(model: ModelLike): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>> {
  const supportsVision = typeof model.supportsVision === 'boolean'
    ? model.supportsVision
    : typeof model.supportsImage === 'boolean'
      ? model.supportsImage
      : undefined;
  return {
    contextWindow: toPositiveInteger(model.contextWindow),
    maxOutputTokens: toPositiveInteger(model.maxOutputTokens),
    supportsVision,
  };
}

function findModelById(models: unknown, modelId: string): ModelLike | null {
  if (!Array.isArray(models) || !modelId) {
    return null;
  }
  for (const model of models) {
    if (!isModelLike(model)) {
      continue;
    }
    if (normalizeModelId(model.id) === modelId) {
      return model;
    }
  }
  return null;
}

function findFirstModelId(models: unknown): string {
  if (!Array.isArray(models)) {
    return '';
  }
  for (const model of models) {
    if (!isModelLike(model)) {
      continue;
    }
    const modelId = normalizeModelId(model.id);
    if (modelId) {
      return modelId;
    }
  }
  return '';
}

function resolveTargetModelId(appConfig: AppConfigLike, overrideModelId?: string | null): string {
  const explicit = normalizeModelId(overrideModelId);
  if (explicit) {
    return explicit;
  }

  const defaultModel = normalizeModelId(appConfig.model?.defaultModel);
  if (defaultModel) {
    return defaultModel;
  }

  for (const provider of Object.values(appConfig.providers ?? {})) {
    if (!provider?.enabled) {
      continue;
    }
    const providerModelId = findFirstModelId(provider.models);
    if (providerModelId) {
      return providerModelId;
    }
  }

  return findFirstModelId(appConfig.model?.availableModels);
}

function buildLimits(
  modelId: string,
  source: CoworkModelLimitSource,
  explicit?: Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens' | 'supportsVision'>>,
): CoworkModelLimits {
  const known = KNOWN_MODEL_LIMITS[modelId] ?? deepseekV4FamilyLimits(modelId) ?? glmFamilyLimits(modelId);
  const contextWindow = explicit?.contextWindow ?? known?.contextWindow ?? DEFAULT_COWORK_CONTEXT_WINDOW;
  const configuredMaxOutputTokens = explicit?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_COWORK_MAX_OUTPUT_TOKENS;
  return {
    modelId,
    contextWindow,
    // The resolved ceiling is EFFECTIVE, not stored: clamped under the window
    // so the kernel's proactive compaction always has a positive pressure
    // budget (see clampCoworkMaxOutputTokens). Stored provider rows keep the
    // user-entered value; only the resolved view is capped.
    maxOutputTokens: clampCoworkMaxOutputTokens(configuredMaxOutputTokens, contextWindow),
    // Fail-safe default: uncatalogued models are treated as text-only. A
    // wrong "true" silently drops image pixels on a model that cannot read
    // them (and, while describe_image was gated by this flag, removed the
    // relay fallback from the catalog too — 2026-09-04 glm-5.3-flash). A
    // wrong "false" is loud: the Read-image guard denies with an explicit
    // pointer to describe_image, which works on every route.
    supportsVision: explicit?.supportsVision ?? known?.supportsVision ?? false,
    source,
  };
}

/**
 * Query whether a model id can consume image content blocks, without needing
 * a full app config. Mirrors buildLimits' fail-safe default (unknown =>
 * false). Used by the OpenAI-compat proxy to degrade image blocks for
 * non-vision models when replaying history.
 */
/** True for model ids of the DeepSeek V4+/flash family (V4.1 renamed to
 *  `deepseek-flash`), including gateway-prefixed and ephemeral-SKU forms.
 *  Shared with the output-ceiling startup migration so both layers agree on
 *  which provider rows count as "DeepSeek family". */
export function isDeepSeekFamilyModelId(modelId: string | null | undefined): boolean {
  return deepseekV4FamilyLimits(normalizeModelId(modelId)) !== undefined;
}

export function modelSupportsVision(modelId: string | null | undefined): boolean {
  const normalized = normalizeModelId(modelId);
  if (!normalized) {
    return false;
  }
  return KNOWN_MODEL_LIMITS[normalized]?.supportsVision
    ?? deepseekV4FamilyLimits(normalized)?.supportsVision
    ?? glmFamilyLimits(normalized)?.supportsVision
    ?? false;
}

export function resolveCoworkModelLimits(
  appConfig: AppConfigLike,
  overrideModelId?: string | null,
  providerKey?: string | null,
): CoworkModelLimits {
  const modelId = resolveTargetModelId(appConfig, overrideModelId);
  const scopedProviderKey = typeof providerKey === 'string' ? providerKey.trim() : '';

  if (scopedProviderKey) {
    // Provider-scoped resolution (2026-09-28 glm-5.3-flash incident): model
    // ids are NOT unique across providers — `glm-5.3-flash` exists on zhipu
    // (supportsImage true), opencode (fail-safe false), and custom gateways
    // alike. The legacy cross-provider scan returned whichever enabled row
    // came first in insertion order, so an unrelated provider's fail-safe
    // flag silently silenced vision for the provider the session actually
    // runs on. When the caller names the session's provider (every DSH route
    // resolution does), ONLY that provider's row may contribute explicit
    // limits; other providers' rows describe different deployments of the
    // same id and must never win. Enabled-ness is deliberately not required
    // here: the route was already resolved, and a mid-session disable must
    // not flip capability answers.
    const scopedProvider = (appConfig.providers ?? {})[scopedProviderKey];
    const scopedModel = scopedProvider ? findModelById(scopedProvider.models, modelId) : null;
    if (scopedModel) {
      const explicit = getModelLimits(scopedModel);
      if (explicit.contextWindow || explicit.maxOutputTokens || explicit.supportsVision !== undefined) {
        return buildLimits(modelId, 'provider-model', explicit);
      }
    }
    // The named provider has no explicit row for the model (or the row is
    // flagless): fall through to the provider-agnostic layers below — never
    // to another provider's row.
  } else {
    for (const provider of Object.values(appConfig.providers ?? {})) {
      if (!provider?.enabled) {
        continue;
      }
      const model = findModelById(provider.models, modelId);
      if (!model) {
        continue;
      }
      const explicit = getModelLimits(model);
      if (explicit.contextWindow || explicit.maxOutputTokens || explicit.supportsVision !== undefined) {
        return buildLimits(modelId, 'provider-model', explicit);
      }
    }
  }

  const availableModel = findModelById(appConfig.model?.availableModels, modelId);
  if (availableModel) {
    const explicit = getModelLimits(availableModel);
    if (explicit.contextWindow || explicit.maxOutputTokens || explicit.supportsVision !== undefined) {
      return buildLimits(modelId, 'available-model', explicit);
    }
  }

  if (KNOWN_MODEL_LIMITS[modelId]) {
    return buildLimits(modelId, 'known-model');
  }

  if (deepseekV4FamilyLimits(modelId) || glmFamilyLimits(modelId)) {
    return buildLimits(modelId, 'family-model');
  }

  return buildLimits(modelId, 'fallback');
}
