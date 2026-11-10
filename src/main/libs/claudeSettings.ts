import type { SqliteStore } from '../sqliteStore';
import type { CoworkPermissionMode } from '../coworkStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, buildOpenAIChatCompletionsURL, type AnthropicApiFormat } from './coworkFormatTransform';
import { buildOpenAIResponsesURL } from './coworkOpenAICompatProxy';
import { resolveCoworkModelLimits, type CoworkModelLimits } from './coworkModelLimits';
import { toLlmEffortLevel } from './llmEffort';

type ProviderModel = {
  id: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  /**
   * The Settings "支持图像输入" checkbox value for this provider's row.
   * Present in the app_config blob; declared here so provider-scoped model
   * limit resolution (resolveCoworkModelLimits) can honor it as the user's
   * per-provider vision override.
   */
  supportsImage?: boolean;
  /**
   * Per-model options mirroring the renderer's ModelOptions. Present in the
   * app_config blob but previously stripped by this typed reader, so the cowork
   * SDK path never saw effort/thinking settings.
   */
  options?: {
    reasoningEffort?: string;
    thinking?: { type: string };
  };
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'responses' | 'native';
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
    /**
     * Explicit default-provider key ('deepseek', 'opencode', ...) recorded
     * when the user picks a model in the UI. Used to disambiguate identical
     * model ids offered by multiple enabled providers (e.g. deepseek and
     * opencode both serve deepseek-v4-flash): without it, the config-order
     * scan below would always pick whichever provider appears first.
     * Absent on legacy configs — behavior stays the config-order scan.
     */
    defaultProvider?: string;
    /** Optional SDK fallback model id for automatic model refusal fallback. */
    fallbackModel?: string;
    availableModels?: ProviderModel[];
  };
  providers?: Record<string, ProviderConfig>;  /**
   * Phase 1 M5 rollout flag: cowork sessions on OpenAI-compatible provider
   * routes may run on the DSH kernel (dsh-runtime subprocess). Default off.
   */
  dshKernelEnabled?: boolean;

};

export type ApiConfigResolution = {
  config: CoworkApiConfig | null;
  error?: string;
};

// Store getter function injected from main.ts
let storeGetter: (() => SqliteStore | null) | null = null;

export function setStoreGetter(getter: () => SqliteStore | null): void {
  storeGetter = getter;
}

const getStore = (): SqliteStore | null => {
  if (!storeGetter) {
    return null;
  }
  return storeGetter();
};

/**
 * Read the raw DeepSeek provider config (apiKey + baseUrl) from app_config,
 * without routing through the cowork proxy. Used by services that need to call
 * DeepSeek endpoints other than chat completions (e.g. /user/balance).
 * Returns null when the store is unavailable or DeepSeek is not configured.
 */
export function getDeepSeekProviderConfig(): { apiKey: string; baseUrl: string } | null {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return null;
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  const deepseek = appConfig?.providers?.deepseek;
  if (!deepseek) {
    return null;
  }
  const apiKey = (deepseek.apiKey ?? '').trim();
  const baseUrl = (deepseek.baseUrl ?? '').trim();
  if (!apiKey || !baseUrl) {
    return null;
  }
  return { apiKey, baseUrl };
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
};

/** Optional caller context so the default-route fallback warning can name the offending bot. */
export interface LlmResolutionContext {
  botId?: number | string | null;
  botName?: string | null;
  /** DSH callers must not silently pick among colliding provider model ids. */
  requireProviderDisambiguation?: boolean;
}

export class ModelProviderSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderSelectionError';
  }
}

function getEffectiveProviderApiFormat(providerName: string, apiFormat: unknown): AnthropicApiFormat {
  if (providerName === 'openai' || providerName === 'gemini') {
    return 'openai';
  }
  if (providerName === 'anthropic') {
    return 'anthropic';
  }
  return normalizeProviderApiFormat(apiFormat);
}

function providerRequiresApiKey(providerName: string): boolean {
  return providerName !== 'ollama';
}

const DEEPSEEK_PROVIDER_KEY = 'deepseek';
const DEEPSEEK_AUTOMATION_MODEL_ID = 'deepseek-flash';
/** Built-in free-quota relay. Must not silently substitute for a paid bot brain. */
export const LLM_FREE_PROVIDER_KEY = 'metaid-free';

export function isFreeQuotaProvider(name?: string | null): boolean {
  return (name ?? '').trim().toLowerCase() === LLM_FREE_PROVIDER_KEY;
}

/**
 * Defense-in-depth for pre-migration metabots.llm_id values, which held
 * PROVIDER ids: 'deepseek' maps to the automation-preferred flash model.
 * Any OTHER provider key is handled generically by Fallback 1 in
 * resolveMatchedProvider (provider's first/default model), and the startup
 * migration (services/llmBrainMigration) rewrites legacy values to model ids.
 */
export function resolveAutomationModelOverride(modelId?: string | null): string | null {
  const normalized = modelId?.trim();
  if (!normalized) return null;
  if (normalized.toLowerCase() === DEEPSEEK_PROVIDER_KEY) {
    return DEEPSEEK_AUTOMATION_MODEL_ID;
  }
  return normalized;
}

/**
 * Resolve which provider and model to use. When overrideModelId is provided (e.g. MetaBot's llm_id),
 * find the enabled provider that offers that model; otherwise use app default or first available.
 * An optional providerHint (the provider key the model was picked from, stored alongside model-level
 * brains) is preferred when the same model id is offered by multiple enabled providers.
 */
function resolveMatchedProvider(
  appConfig: AppConfig,
  overrideModelId?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};
  const requestedOverride = overrideModelId?.trim() || null;
  const isDeepSeekAutomationProviderKey = requestedOverride?.toLowerCase() === DEEPSEEK_PROVIDER_KEY;

  const resolveFallbackModel = (): string | undefined => {
    for (const provider of Object.values(providers)) {
      if (!provider?.enabled || !provider.models || provider.models.length === 0) {
        continue;
      }
      return provider.models[0].id;
    }
    return undefined;
  };

  const modelId =
    resolveAutomationModelOverride(requestedOverride) || appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  // Explicit default-provider preference (global/default sessions only):
  // resolve the model against the user-chosen provider FIRST. Multiple
  // enabled providers can offer the same model id (e.g. deepseek and
  // opencode both serve deepseek-v4-flash), and the config-order scan below
  // would otherwise always pick whichever provider appears first. A
  // requestedOverride (metabot llm_id) is an explicit provider choice of its
  // own and must NOT be overridden by the global default provider.
  const defaultProviderKey = requestedOverride
    ? null
    : appConfig.model?.defaultProvider?.trim().toLowerCase() || null;
  let providerEntry: [string, ProviderConfig] | undefined;
  // Model-level brain with an explicit provider hint: prefer that provider's
  // exact model match over the config-order scan below (model ids can collide
  // across providers, e.g. a custom relay mirroring an official catalog).
  const providerHintKey = requestedOverride && providerHint?.trim()
    ? providerHint.trim().toLowerCase()
    : null;
  if (context?.requireProviderDisambiguation && requestedOverride && !providerHintKey && !defaultProviderKey) {
    const matchingProviders = Object.entries(providers).filter(
      ([, provider]) => provider?.enabled && provider.models?.some((model) => model.id === modelId),
    );
    if (matchingProviders.length > 1) {
      const names = matchingProviders.map(([name]) => name).join(', ');
      return {
        matched: null,
        error: `Model '${modelId}' is provided by multiple enabled providers (${names}); provider selection is required.`,
      };
    }
  }
  if (providerHintKey) {
    providerEntry = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === providerHintKey
        && provider?.enabled
        && provider.models?.some((model) => model.id === modelId)
    ) as [string, ProviderConfig] | undefined;
    if (!providerEntry && context?.requireProviderDisambiguation) {
      return {
        matched: null,
        error: `Provider '${providerHint}' does not offer enabled model '${modelId}'; provider selection is required.`,
      };
    }
  }
  if (defaultProviderKey) {
    providerEntry = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === defaultProviderKey
        && provider?.enabled
        && provider.models?.some((model) => model.id === modelId)
    ) as [string, ProviderConfig] | undefined;
  }
  if (!providerEntry) {
    providerEntry = Object.entries(providers).find(
      ([, provider]) => {
        if (!provider?.enabled || !provider.models) return false;
        return provider.models.some((model) => model.id === modelId);
      }
    ) as [string, ProviderConfig] | undefined;
  }

  let resolvedModelId: string = modelId;

  // Fallback: when the configured default provider is enabled but does not
  // offer the default model (provider catalog changed, or the built-in
  // metaid-free relay serving a single model), use that provider's own first
  // model instead of failing. The default provider is the user's explicit
  // choice and must win over a hard error.
  if (!providerEntry && defaultProviderKey) {
    const byDefaultProvider = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === defaultProviderKey && provider?.enabled && provider.models?.length
    ) as [string, ProviderConfig] | undefined;
    if (byDefaultProvider) {
      const [providerName, providerConfig] = byDefaultProvider;
      const providerModels = providerConfig.models as Array<{ id: string }>;
      providerEntry = [providerName, providerConfig];
      resolvedModelId = providerModels.find((model) => model.id === modelId)?.id ?? providerModels[0].id;
    }
  }

  // When overrideModelId is given (e.g. MetaBot llm_id "deepseek"), exact model id may not match.
  // Fallback 1: treat as provider key (e.g. "deepseek" -> provider "deepseek", use its first or default model).
  if (!providerEntry && requestedOverride && !isDeepSeekAutomationProviderKey) {
    const key = requestedOverride.toLowerCase();
    const byProviderKey = Object.entries(providers).find(
      ([name, provider]) =>
        name.toLowerCase() === key && provider?.enabled && provider?.models?.length
    ) as [string, ProviderConfig] | undefined;
    if (byProviderKey) {
      const [providerName, providerConfig] = byProviderKey;
      const defaultInApp = appConfig.model?.defaultModel;
      const useModel =
        providerConfig.models?.some((m) => m.id === defaultInApp)
          ? defaultInApp
          : providerConfig.models?.[0]?.id;
      if (useModel) {
        providerEntry = [providerName, providerConfig];
        resolvedModelId = useModel;
      }
    }
  }

  // Fallback 2: match by model id prefix (e.g. "deepseek" -> "deepseek-chat").
  if (!providerEntry && requestedOverride && !isDeepSeekAutomationProviderKey) {
    const prefix = requestedOverride.toLowerCase();
    for (const [providerName, provider] of Object.entries(providers)) {
      if (!provider?.enabled || !provider.models) continue;
      const firstMatch = provider.models.find((m) => m.id.toLowerCase().startsWith(prefix));
      if (firstMatch) {
        providerEntry = [providerName, provider];
        resolvedModelId = firstMatch.id;
        break;
      }
    }
  }

  if (!providerEntry) {
    // Last-resort safety net: a legacy/unresolvable override (e.g. a stale
    // provider key or a removed model id left in metabots.llm_id) must never
    // dead-end a bot turn. Re-resolve with NO override — the same default
    // route a session without an llm_id gets (default model -> first enabled
    // provider's first model) — and warn. Only the genuine no-enabled-
    // providers case keeps the hard error below.
    if (requestedOverride) {
      const defaultRoute = resolveMatchedProvider(appConfig);
      if (defaultRoute.matched) {
        const botLabel = context?.botId != null
          ? `bot ${context.botId}${context.botName ? ` (${context.botName})` : ''}: `
          : '';
        // A paid/explicit brain (DeepSeek, OpenCode, ...) must never be
        // rewritten onto the free-quota relay just because the chosen
        // provider is disabled or the model id went stale. That silently
        // burns the ID.Bots relay and surfaces as free_quota_exhausted.
        if (
          isFreeQuotaProvider(defaultRoute.matched.providerName)
          && !isFreeQuotaProvider(requestedOverride)
          && !isFreeQuotaProvider(providerHint)
        ) {
          console.warn(
            `[llm-brain] ${botLabel}unresolvable llm_id '${requestedOverride}', refusing to substitute the free-quota relay ` +
            `(default model '${defaultRoute.matched.modelId}', provider '${defaultRoute.matched.providerName}')`
          );
          return { matched: null, error: `No enabled provider found for model: ${modelId}` };
        }
        console.warn(
          `[llm-brain] ${botLabel}unresolvable llm_id '${requestedOverride}', using default route ` +
          `(model '${defaultRoute.matched.modelId}', provider '${defaultRoute.matched.providerName}')`
        );
        return defaultRoute;
      }
    }
    return { matched: null, error: `No enabled provider found for model: ${modelId}` };
  }

  const [providerName, providerConfig] = providerEntry;
  const apiFormat = getEffectiveProviderApiFormat(providerName, providerConfig.apiFormat);
  const baseURL = providerConfig.baseUrl?.trim();

  if (!baseURL) {
    return { matched: null, error: `Provider ${providerName} is missing base URL.` };
  }

  if (apiFormat === 'anthropic' && providerRequiresApiKey(providerName) && !providerConfig.apiKey?.trim()) {
    return { matched: null, error: `Provider ${providerName} requires API key for Anthropic-compatible mode.` };
  }

  return {
    matched: {
      providerName,
      providerConfig,
      modelId: resolvedModelId,
      apiFormat,
    },
  };
}

/**
 * Resolves the fallback model id from app config. The SDK's `fallbackModel`
 * option is only meaningful when the fallback model is served by the same
 * provider as the primary (same base URL / API key), because the SDK retries
 * in-process without re-resolving provider env. So we validate that the
 * configured fallbackModel exists in an enabled provider's model list.
 * Returns undefined when no usable fallback is configured.
 */
function resolveFallbackModelId(
  appConfig: AppConfig,
  primaryProviderName: string | null
): string | undefined {
  const fallbackId = appConfig.model?.fallbackModel?.trim();
  if (!fallbackId) return undefined;

  const providers = appConfig.providers ?? {};
  for (const [providerName, provider] of Object.entries(providers)) {
    if (!provider?.enabled || !provider.models) continue;
    if (provider.models.some((m) => m.id === fallbackId)) {
      // Only use fallback from the same provider — the SDK retries with the
      // same base URL/key, so a cross-provider fallback would hit the wrong API.
      if (primaryProviderName && providerName !== primaryProviderName) continue;
      return fallbackId;
    }
  }
  return undefined;
}

/**
 * Resolve API config for a given model id (e.g. MetaBot's llm_id). When modelId is provided and
 * non-empty, finds the enabled provider that offers that model; otherwise uses app default.
 * Use this for per-MetaBot LLM (orchestrator chat completion).
 */
export function resolveApiConfigForModel(
  modelId?: string | null,
  target: OpenAICompatProxyTarget = 'local',
  sessionKey?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig, modelId ?? undefined, providerHint ?? undefined, context);
  if (!matched) {
    return { config: null, error };
  }
  const resolution = buildApiConfigFromMatched(matched, target, sessionKey);
  if (resolution.config) {
    const fallbackModel = resolveFallbackModelId(appConfig, matched.providerName);
    if (fallbackModel) {
      resolution.config.fallbackModel = fallbackModel;
    }
  }
  return resolution;
}

function buildApiConfigFromMatched(
  matched: MatchedProvider,
  target: OpenAICompatProxyTarget,
  sessionKey?: string | null
): ApiConfigResolution {
  const resolvedBaseURL = matched.providerConfig.baseUrl.trim();
  const resolvedApiKey = matched.providerConfig.apiKey?.trim() || '';
  const effectiveApiKey =
    matched.providerName === 'ollama' && matched.apiFormat === 'anthropic' && !resolvedApiKey
      ? 'sk-ollama-local'
      : resolvedApiKey;

  if (matched.apiFormat === 'anthropic') {
    return {
      config: {
        apiKey: effectiveApiKey,
        baseURL: resolvedBaseURL,
        model: matched.modelId,
        apiType: 'anthropic',
        provider: matched.providerName,
        upstreamBaseURL: resolvedBaseURL,
      },
    };
  }

  const proxyStatus = getCoworkOpenAICompatProxyStatus();
  if (!proxyStatus.running) {
    return { config: null, error: 'OpenAI compatibility proxy is not running.' };
  }

  configureCoworkOpenAICompatProxy({
    baseURL: resolvedBaseURL,
    apiKey: resolvedApiKey || undefined,
    model: matched.modelId,
    provider: matched.providerName,
    apiFormat: matched.apiFormat,
    // Pin this upstream to the cowork session so the proxy's per-session
    // registry isolates it from concurrent sessions on other providers.
    sessionKey: sessionKey ?? undefined,
    // Provider-scoped vision capability for this exact model row, so the
    // proxy's Responses converter honors the Settings 支持图像输入 checkbox
    // instead of only the static catalog (2026-09-28 glm-5.3-flash incident).
    supportsImage: resolveCurrentModelLimits(matched.modelId, matched.providerName).supportsVision,
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return { config: null, error: 'OpenAI compatibility proxy base URL is unavailable.' };
  }

  // A pinned session gets the session-scoped route (/s/<key>/v1/messages) so
  // handleRequest resolves the per-session upstream registered above instead of
  // the shared singleton. configureCoworkOpenAICompatProxy now pins the
  // per-session entry WITHOUT republishing the singleton, so an unscoped
  // one-shot caller (dreams, memory hygiene, summaries running in the same
  // window) no longer gets re-pointed to a different provider mid-flight.
  const pinKey = sessionKey?.trim();
  const scopedProxyBaseURL = pinKey
    ? `${proxyBaseURL}/s/${encodeURIComponent(pinKey)}`
    : proxyBaseURL;

  return {
    config: {
      apiKey: resolvedApiKey || 'idbots-openai-compat',
      baseURL: scopedProxyBaseURL,
      model: matched.modelId,
      apiType: 'anthropic', // proxy speaks Anthropic /v1/messages format
      provider: matched.providerName,
      upstreamBaseURL: resolvedBaseURL,
    },
  };
}

export function resolveCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return {
      config: null,
      error: 'Store is not initialized.',
    };
  }

  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return {
      config: null,
      error: 'Application config not found.',
    };
  }

  const { matched, error } = resolveMatchedProvider(appConfig);
  if (!matched) {
    return {
      config: null,
      error,
    };
  }

  const resolution = buildApiConfigFromMatched(matched, target);
  if (resolution.config) {
    const fallbackModel = resolveFallbackModelId(appConfig, matched.providerName);
    if (fallbackModel) {
      resolution.config.fallbackModel = fallbackModel;
    }
  }
  return resolution;
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

/**
 * Raw provider catalog entries (key → enabled/baseUrl/apiKey), for callers
 * that must scan the catalog itself rather than resolve one route (e.g. the
 * DSH hub seeding its web-search credential at construction). Empty object
 * when the store is not initialized.
 */
export function getAppConfigProviders(): Record<
  string,
  { enabled?: boolean; apiKey?: string | null; baseUrl?: string | null } | undefined
> {
  const appConfig = getStore()?.get<AppConfig>('app_config');
  return appConfig?.providers ?? {};
}

/**
 * The system rescue brain (2026-10-23 new-user free-quota post-mortem): the
 * first enabled, keyed, non-free provider's default/first model, in config
 * order. This is the last-resort rung for one-shot cognitive calls
 * (services/llmFallback.runWithSystemRescue) and for the DSH current-default
 * rescue when a bot's primary AND fallback brains both die on terminal errors
 * (quota/auth/config) — the classic case being a new user whose ID.Bots
 * allowance ran out but who already configured their own provider key in
 * Settings without wiring it into any brain setting.
 *
 * The free-quota relay is NEVER a rescue candidate: it must not silently
 * absorb paid-brain traffic, and an exhausted free relay is the most common
 * rescue trigger. Providers already tried this call are excluded by the caller
 * (a dead account fails again). Returns null when nothing usable remains.
 */
export interface SystemRescueBrain {
  llmId: string;
  llmProvider: string;
}

export function resolveSystemRescueBrain(options?: {
  /** Provider keys already tried for this call (a dead account fails again). */
  excludeProviders?: ReadonlyArray<string | null | undefined>;
}): SystemRescueBrain | null {
  const appConfig = getStore()?.get<AppConfig>('app_config');
  const providers = appConfig?.providers ?? {};
  const excluded = new Set(
    (options?.excludeProviders ?? [])
      .map((key) => (key ?? '').trim().toLowerCase())
      .filter(Boolean)
  );
  const defaultModel = appConfig?.model?.defaultModel?.trim() || '';
  for (const [key, provider] of Object.entries(providers)) {
    if (!provider?.enabled) continue;
    if (isFreeQuotaProvider(key)) continue;
    if (excluded.has(key.trim().toLowerCase())) continue;
    if (providerRequiresApiKey(key) && !provider.apiKey?.trim()) continue;
    const models = (provider.models ?? []).filter((model) => typeof model?.id === 'string' && model.id);
    if (models.length === 0) continue;
    const modelId = defaultModel && models.some((model) => model.id === defaultModel)
      ? defaultModel
      : (models[0].id as string);
    return { llmId: modelId, llmProvider: key };
  }
  return null;
}

/**
 * Direct-upstream provider route for the DSH kernel (Phase 1 M5): same
 * provider matching as the Claude path, but WITHOUT the OpenAI-compat proxy —
 * the DSH runtime speaks the provider's native protocol directly, so this
 * exposes the raw apiFormat and true upstream baseUrl/key.
 */
export interface DshProviderRouteInfo {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'anthropic' | 'openai' | 'responses' | 'native';
}

export function resolveDshProviderRoute(
  modelId?: string | null,
  providerHint?: string | null,
  context?: LlmResolutionContext
): DshProviderRouteInfo | null {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config');
  if (!appConfig) return null;
  const { matched, error } = resolveMatchedProvider(appConfig, modelId ?? undefined, providerHint ?? undefined, context);
  if (!matched && context?.requireProviderDisambiguation && error?.endsWith('provider selection is required.')) {
    throw new ModelProviderSelectionError(error);
  }
  if (!matched) return null;
  return {
    provider: dshPiAiRouteKey(matched.providerName, matched.apiFormat, matched.providerConfig.baseUrl.trim()),
    baseUrl: dshApiRootOf(matched.providerConfig.baseUrl.trim(), matched.apiFormat, matched.providerName),
    apiKey: matched.providerConfig.apiKey?.trim() || '',
    model: matched.modelId,
    apiFormat: matched.apiFormat,
  };
}

/**
 * Mirror of dshPiAiRouteKey in dsh-runtime/lib/generate-runtime-config.mjs.
 * A user provider named after a pi-ai catalog vendor (today: 'anthropic') on
 * the anthropic apiFormat inherits that vendor's catalog compat when its
 * models match by id — including supportsMidConvoToolChanges, which serializes
 * mid-conversation tool changes as tool_addition/tool_removal blocks. Third-
 * party Anthropic-format gateways frequently reject tool_removal, and because
 * the tool-change developer events are durable session history, ONE rejection
 * wedges the conversation permanently (every retry replays the same block —
 * the v1.0.2 "unknown variant `tool removal`" report). pi-ai withholds that
 * compat flag from configuration, so the only lever is the route key: keep the
 * vendor name for the OFFICIAL endpoint, suffix everything else with '-gw' so
 * the route stops inheriting catalog wire behavior and falls back to the
 * universally-compatible shape (developer tool-change messages stripped from
 * requests, full tool declarations per request).
 *
 * The runtime config generator keys its pi-ai providers dict with the same
 * rule, and every DSH turn passes route.provider from here — the two
 * implementations MUST stay in sync (tests/coworkDshRouteKeySync.test.mjs
 * pins the agreement across a matrix of inputs).
 */
export const PI_AI_VENDOR_OFFICIAL_HOSTS: Readonly<Record<string, string>> = {
  anthropic: 'api.anthropic.com',
};

const hostOfUrl = (baseUrl: string): string => {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
};

export function dshPiAiRouteKey(providerKey: string, apiFormat: string, baseUrl: string): string {
  const key = String(providerKey).replace(/[^a-zA-Z0-9_-]/g, '-');
  if (apiFormat !== 'anthropic') return key;
  const officialHost = PI_AI_VENDOR_OFFICIAL_HOSTS[String(providerKey).trim().toLowerCase()];
  if (officialHost === undefined || hostOfUrl(baseUrl) === officialHost) return key;
  return `${key}-gw`;
}

/**
 * pi-ai adapters hand baseURL to the OpenAI SDK, which appends the endpoint
 * path itself — so the DSH route needs the API ROOT, while the stored provider
 * baseUrl may be any compatibility shape. Derive the root with the exact URL
 * knowledge the cowork proxy accumulated (DeepSeek serves /responses at the
 * host root; gateways use /v1/...; chat shape appends /v1/chat/completions).
 */
function dshApiRootOf(baseUrl: string, apiFormat: AnthropicApiFormat, providerName: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (apiFormat === 'responses') {
    const endpoint = buildOpenAIResponsesURL(trimmed, providerName);
    return endpoint.replace(/\/responses$/, '');
  }
  if (apiFormat === 'openai') {
    const endpoint = buildOpenAIChatCompletionsURL(trimmed);
    return endpoint.replace(/\/chat\/completions$/, '');
  }
  return trimmed;
}

/**
 * Local cowork is DSH-only. The Claude Agent SDK kernel and the Settings
 * pill that could switch back to it are retired so dual-kernel fallback
 * cannot hide DSH bugs. Persisted `dshKernelEnabled: false` is ignored.
 */
export function isDshKernelEnabled(): boolean {
  return true;
}

/**
 * Returns the persisted auto-approve tool rules from app_config. These are the
 * defaults new cowork sessions start with; the user's latest changes are saved
 * through the renderer configService (same app_config row).
 */
export function getPersistedAutoApproveTools(): string[] {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ autoApproveTools?: string[] }>('app_config');
  const tools = appConfig?.autoApproveTools;
  if (!Array.isArray(tools)) return [];
  return tools
    .map((name) => (typeof name === 'string' ? name.trim().toLowerCase() : ''))
    .filter(Boolean);
}

/**
 * Global default permission mode for cowork sessions, persisted in app_config.
 * The user's latest selection is inherited by every new session/Bot.
 */
export function getPersistedCoworkPermissionMode(): CoworkPermissionMode {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ coworkPermissionMode?: unknown }>('app_config');
  const mode = appConfig?.coworkPermissionMode;
  return (mode === 'default' || mode === 'plan' || mode === 'acceptEdits' || mode === 'bypassPermissions')
    ? mode
    : 'default';
}

/**
 * Global default effort level for cowork sessions, normalized onto the
 * app-wide off/low/high/max ladder (see llmEffort.ts). Leftover five-step
 * tokens (medium, xhigh) convert at this read boundary; canonical values
 * including `low` pass through. Null means auto / model default. Persisted in
 * app_config like permission mode.
 */
export function getPersistedCoworkEffortLevel(): string | null {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<{ coworkEffortLevel?: unknown }>('app_config');
  const level = appConfig?.coworkEffortLevel;
  return toLlmEffortLevel(level);
}

// getPersistedChatExperienceMode is RETIRED (总裁办公室 surface ruling
// 2026-11-09): the chat experience mode is decided by the active face in the
// renderer (Studio=assistant, BotWorks=professional) and, on the backend, by
// the per-session assistantMode marker alone — see
// coworkRunner.isAssistantModeOwnerChatSession. Nothing reads the legacy
// app_config.chatExperienceMode value any more.

/**
 * Persists a global cowork preference (permission mode / effort level) to
 * app_config. The renderer also writes these via configService.updateConfig,
 * but the main process persists them here on mid-session switches so the
 * choice is global regardless of which UI path changed it.
 *
 * The read is load-bearing: `?? {}` on a MISSING row would be fine, but
 * sqliteStore.get also returns undefined when the stored JSON fails to parse
 * (transient corruption / mid-write read). Writing back a `{preference-only}`
 * object in that state replaces the whole config — every provider credential
 * gone, providers reset to defaults on the next load (the 2026-10-16
 * missing-models incident class). So when the read yields no usable object,
 * the write is skipped outright: the renderer path still persists the
 * preference, and a skipped write can never destroy stored config.
 */
export function setPersistedCoworkPreference(updates: {
  permissionMode?: CoworkPermissionMode;
  effortLevel?: string | null;
}): void {
  const sqliteStore = getStore();
  if (!sqliteStore) return;
  const appConfig = sqliteStore.get<Record<string, unknown>>('app_config');
  if (!appConfig || typeof appConfig !== 'object') {
    console.warn('[claudeSettings] cowork preference not persisted: app_config unreadable (refusing to write a partial config over it)');
    return;
  }
  if (updates.permissionMode !== undefined) {
    appConfig.coworkPermissionMode = updates.permissionMode;
  }
  if (updates.effortLevel !== undefined) {
    appConfig.coworkEffortLevel = updates.effortLevel;
  }
  sqliteStore.set('app_config', appConfig);
}

export function resolveCurrentModelLimits(modelId?: string | null, providerKey?: string | null): CoworkModelLimits {
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config') ?? {};
  return resolveCoworkModelLimits(appConfig, modelId, providerKey);
}

/**
 * Resolves per-model options (effort/thinking) from app_config for the given
 * model id. Returns null when no options are configured. Used by the cowork
 * SDK path to pass effort/thinking into the SDK options — previously these
 * settings only reached the OpenAI-compat proxy for the renderer's direct
 * API calls, never the cowork session.
 */
export function resolveModelOptions(modelId?: string | null): {
  reasoningEffort?: string;
  thinking?: { type: string };
} | null {
  if (!modelId) return null;
  const sqliteStore = getStore();
  const appConfig = sqliteStore?.get<AppConfig>('app_config');
  if (!appConfig?.providers) return null;

  for (const provider of Object.values(appConfig.providers)) {
    if (!provider?.models) continue;
    const model = provider.models.find((m) => m.id === modelId);
    if (model?.options) {
      // Normalize the stored default onto the app-wide off/low/high/max ladder
      // (leftover five-step tokens such as medium/xhigh convert; canonical
      // off/low/high/max pass through).
      return {
        ...model.options,
        ...(model.options.reasoningEffort !== undefined
          ? { reasoningEffort: toLlmEffortLevel(model.options.reasoningEffort) ?? undefined }
          : {}),
      };
    }
  }
  return null;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;
  baseEnv.ANTHROPIC_SMALL_FAST_MODEL = config.model;

  return baseEnv;
}
