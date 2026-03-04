import { join } from 'path';
import { app } from 'electron';
import type { SqliteStore } from '../sqliteStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import {
  configureCoworkOpenAICompatProxy,
  type OpenAICompatProxyTarget,
  getCoworkOpenAICompatProxyBaseURL,
  getCoworkOpenAICompatProxyStatus,
} from './coworkOpenAICompatProxy';
import { normalizeProviderApiFormat, type AnthropicApiFormat } from './coworkFormatTransform';

type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled: boolean;
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  models?: ProviderModel[];
};

type AppConfig = {
  model?: {
    defaultModel?: string;
  };
  providers?: Record<string, ProviderConfig>;
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

export function getClaudeCodePath(): string {
  if (app.isPackaged) {
    return join(
      process.resourcesPath,
      'app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk/cli.js'
    );
  }

  // In development, try to find the SDK in the project root node_modules
  // app.getAppPath() might point to dist-electron or other build output directories
  // We need to look in the project root
  const appPath = app.getAppPath();
  // If appPath ends with dist-electron, go up one level
  const rootDir = appPath.endsWith('dist-electron') 
    ? join(appPath, '..') 
    : appPath;

  return join(rootDir, 'node_modules/@anthropic-ai/claude-agent-sdk/cli.js');
}

type MatchedProvider = {
  providerName: string;
  providerConfig: ProviderConfig;
  modelId: string;
  apiFormat: AnthropicApiFormat;
};

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

/**
 * Resolve which provider and model to use. When overrideModelId is provided (e.g. MetaBot's llm_id),
 * find the enabled provider that offers that model; otherwise use app default or first available.
 */
function resolveMatchedProvider(
  appConfig: AppConfig,
  overrideModelId?: string | null
): { matched: MatchedProvider | null; error?: string } {
  const providers = appConfig.providers ?? {};

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
    (overrideModelId?.trim() || null) || appConfig.model?.defaultModel || resolveFallbackModel();
  if (!modelId) {
    return { matched: null, error: 'No available model configured in enabled providers.' };
  }

  let providerEntry: [string, ProviderConfig] | undefined = Object.entries(providers).find(
    ([, provider]) => {
      if (!provider?.enabled || !provider.models) return false;
      return provider.models.some((model) => model.id === modelId);
    }
  ) as [string, ProviderConfig] | undefined;

  let resolvedModelId: string = modelId;

  // When overrideModelId is given (e.g. MetaBot llm_id "deepseek"), exact model id may not match.
  // Fallback 1: treat as provider key (e.g. "deepseek" -> provider "deepseek", use its first or default model).
  if (!providerEntry && overrideModelId?.trim()) {
    const key = overrideModelId.trim().toLowerCase();
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
  if (!providerEntry && overrideModelId?.trim()) {
    const prefix = overrideModelId.trim().toLowerCase();
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
 * Resolve API config for a given model id (e.g. MetaBot's llm_id). When modelId is provided and
 * non-empty, finds the enabled provider that offers that model; otherwise uses app default.
 * Use this for per-MetaBot LLM (orchestrator chat completion).
 */
export function resolveApiConfigForModel(
  modelId?: string | null,
  target: OpenAICompatProxyTarget = 'local'
): ApiConfigResolution {
  const sqliteStore = getStore();
  if (!sqliteStore) {
    return { config: null, error: 'Store is not initialized.' };
  }
  const appConfig = sqliteStore.get<AppConfig>('app_config');
  if (!appConfig) {
    return { config: null, error: 'Application config not found.' };
  }
  const { matched, error } = resolveMatchedProvider(appConfig, modelId ?? undefined);
  if (!matched) {
    return { config: null, error };
  }
  return buildApiConfigFromMatched(matched, target);
}

function buildApiConfigFromMatched(
  matched: MatchedProvider,
  target: OpenAICompatProxyTarget
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
  });

  const proxyBaseURL = getCoworkOpenAICompatProxyBaseURL(target);
  if (!proxyBaseURL) {
    return { config: null, error: 'OpenAI compatibility proxy base URL is unavailable.' };
  }

  return {
    config: {
      apiKey: resolvedApiKey || 'idbots-openai-compat',
      baseURL: proxyBaseURL,
      model: matched.modelId,
      apiType: 'openai',
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

  return buildApiConfigFromMatched(matched, target);
}

export function getCurrentApiConfig(target: OpenAICompatProxyTarget = 'local'): CoworkApiConfig | null {
  return resolveCurrentApiConfig(target).config;
}

export function buildEnvForConfig(config: CoworkApiConfig): Record<string, string> {
  const baseEnv = { ...process.env } as Record<string, string>;

  baseEnv.ANTHROPIC_AUTH_TOKEN = config.apiKey;
  baseEnv.ANTHROPIC_API_KEY = config.apiKey;
  baseEnv.ANTHROPIC_BASE_URL = config.baseURL;
  baseEnv.ANTHROPIC_MODEL = config.model;

  return baseEnv;
}
