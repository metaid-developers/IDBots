export type ModelOptions = {
  reasoningEffort?: 'low' | 'medium' | 'high' | 'max';
  thinking?: {
    type: 'enabled' | 'disabled';
  };
};

type ConfiguredModel = {
  id: string;
  name: string;
  supportsImage?: boolean;
  options?: ModelOptions;
};

// 配置类型定义
export interface AppConfig {
  // API 配置
  api: {
    key: string;
    baseUrl: string;
  };
  // 模型配置
  model: {
    availableModels: ConfiguredModel[];
    defaultModel: string;
  };
  // 多模型提供商配置
  providers?: {
    openai: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      // API 协议格式：anthropic 为 Anthropic 兼容，openai 为 OpenAI 兼容
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    deepseek: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    moonshot: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    zhipu: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    minimax: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    qwen: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    openrouter: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    gemini: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    anthropic: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    xiaomi: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    ollama: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
    [key: string]: {
      enabled: boolean;
      apiKey: string;
      baseUrl: string;
      apiFormat?: 'anthropic' | 'openai';
      models?: ConfiguredModel[];
    };
  };
  // 主题配置
  theme: 'light' | 'dark' | 'system';
  // 语言配置
  language: 'zh' | 'en';
  // 语言初始化标记 (用于判断是否是首次启动)
  language_initialized?: boolean;
  // 应用配置
  app: {
    port: number;
    isDevelopment: boolean;
  };
  // 快捷键配置
  shortcuts?: {
    newChat: string;
    search: string;
    settings: string;
    [key: string]: string | undefined;
  };
  // 费率配置 (用户选定的各网络费率)
  feeRates?: {
    btc?: number;
    mvc?: number;
    doge?: number;
  };
}

type ModelDefinition = AppConfig['model']['availableModels'][number];
type ProviderDefinition = NonNullable<AppConfig['providers']>[string];
type ProviderModelDefinition = NonNullable<ProviderDefinition['models']>[number];
type ModelLike = {
  id: string;
  name: string;
  supportsImage?: boolean;
  options?: ModelOptions;
};

export const DEEPSEEK_DEFAULT_MODEL_ID = 'deepseek-v4-pro';

const DEEPSEEK_DEFAULT_MODELS: ReadonlyArray<ModelLike> = Object.freeze([
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', supportsImage: false },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro',
    supportsImage: false,
    options: {
      reasoningEffort: 'max',
      thinking: { type: 'enabled' },
    },
  },
]);

const DEEPSEEK_DEFAULT_MODEL_ORDER = DEEPSEEK_DEFAULT_MODELS.map((model) => model.id);

const DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP: Readonly<Record<string, ModelLike>> = Object.freeze({
  'deepseek-chat': DEEPSEEK_DEFAULT_MODELS[0],
  'deepseek-reasoner': DEEPSEEK_DEFAULT_MODELS[1],
});

export function getDefaultDeepSeekModels(): ModelDefinition[] {
  return DEEPSEEK_DEFAULT_MODELS.map((model) => ({
    ...model,
    options: model.options
      ? {
          ...model.options,
          thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
        }
      : undefined,
  }));
}

function normalizeDeepSeekModel(model: ModelLike): ModelLike {
  const migrated = DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP[model.id];
  const canonical = DEEPSEEK_DEFAULT_MODELS.find((entry) => entry.id === (migrated?.id ?? model.id));
  if (!migrated) {
    if (!canonical) {
      return { ...model };
    }
    return {
      ...model,
      supportsImage: canonical.supportsImage ?? model.supportsImage,
      options: model.options ?? canonical.options,
    };
  }
  return {
    ...model,
    id: migrated.id,
    name: migrated.name,
    supportsImage: migrated.supportsImage,
    options: migrated.options,
  };
}

function dedupeModels<T extends ModelLike>(models: T[]): T[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) {
      return false;
    }
    seen.add(model.id);
    return true;
  });
}

function maybeCanonicalizeDeepSeekDefaults<T extends ModelLike>(models: T[]): T[] {
  if (
    models.length !== DEEPSEEK_DEFAULT_MODEL_ORDER.length
    || models.some((model) => !DEEPSEEK_DEFAULT_MODEL_ORDER.includes(model.id))
  ) {
    return models;
  }
  return [...models].sort(
    (left, right) => DEEPSEEK_DEFAULT_MODEL_ORDER.indexOf(left.id) - DEEPSEEK_DEFAULT_MODEL_ORDER.indexOf(right.id),
  );
}

function normalizeDeepSeekModelList<T extends ModelLike>(models?: T[] | null): T[] | undefined {
  if (!models) {
    return undefined;
  }
  return maybeCanonicalizeDeepSeekDefaults(dedupeModels(models.map((model) => normalizeDeepSeekModel(model) as T)));
}

function normalizeDeepSeekDefaultModel(defaultModel: string, availableModels: ModelLike[]): string {
  const migratedDefault = DEEPSEEK_LEGACY_MODEL_MIGRATION_MAP[defaultModel]?.id ?? defaultModel;
  if (availableModels.some((model) => model.id === migratedDefault)) {
    return migratedDefault;
  }
  if (availableModels.some((model) => model.id === DEEPSEEK_DEFAULT_MODEL_ID)) {
    return DEEPSEEK_DEFAULT_MODEL_ID;
  }
  return availableModels[0]?.id ?? DEEPSEEK_DEFAULT_MODEL_ID;
}

function hasConfiguredProviderApiKey(providers?: AppConfig['providers']): boolean {
  if (!providers) {
    return false;
  }
  return Object.values(providers).some(
    (provider) => provider?.enabled && typeof provider.apiKey === 'string' && provider.apiKey.trim() !== '',
  );
}

function detectLegacyProviderFromApiBaseUrl(baseUrl: string): keyof NonNullable<AppConfig['providers']> | null {
  const normalizedBaseUrl = baseUrl.trim().toLowerCase();
  if (!normalizedBaseUrl) {
    return null;
  }
  if (normalizedBaseUrl.includes('openai')) return 'openai';
  if (normalizedBaseUrl.includes('deepseek')) return 'deepseek';
  if (normalizedBaseUrl.includes('moonshot.ai') || normalizedBaseUrl.includes('moonshot.cn')) return 'moonshot';
  if (normalizedBaseUrl.includes('bigmodel.cn')) return 'zhipu';
  if (normalizedBaseUrl.includes('minimax')) return 'minimax';
  if (normalizedBaseUrl.includes('dashscope')) return 'qwen';
  if (normalizedBaseUrl.includes('openrouter.ai')) return 'openrouter';
  if (normalizedBaseUrl.includes('googleapis')) return 'gemini';
  if (normalizedBaseUrl.includes('anthropic')) return 'anthropic';
  if (normalizedBaseUrl.includes('ollama') || normalizedBaseUrl.includes('11434')) return 'ollama';
  return null;
}

function inferLegacyApiFormat(
  providerKey: keyof NonNullable<AppConfig['providers']>,
  baseUrl: string,
): 'anthropic' | 'openai' {
  if (providerKey === 'openai' || providerKey === 'gemini') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return baseUrl.toLowerCase().includes('/anthropic') ? 'anthropic' : 'openai';
}

function normalizeLegacyApiBackfill(providers: AppConfig['providers'], api: AppConfig['api']): AppConfig['providers'] {
  const legacyApiKey = typeof api.key === 'string' ? api.key.trim() : '';
  const legacyBaseUrl = typeof api.baseUrl === 'string' ? api.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!legacyApiKey || !legacyBaseUrl || hasConfiguredProviderApiKey(providers)) {
    return providers;
  }

  const providerKey = detectLegacyProviderFromApiBaseUrl(legacyBaseUrl);
  if (!providerKey) {
    return providers;
  }

  const nextProviders = { ...((providers ?? defaultConfig.providers) as NonNullable<AppConfig['providers']>) };
  const existingProvider = nextProviders[providerKey];
  nextProviders[providerKey] = {
    ...existingProvider,
    enabled: true,
    apiKey: legacyApiKey,
    baseUrl: legacyBaseUrl,
    apiFormat: inferLegacyApiFormat(providerKey, legacyBaseUrl),
    models: existingProvider?.models,
  };
  return nextProviders;
}

export function normalizeDeepSeekAppConfig(config: AppConfig): AppConfig {
  const normalizedAvailableModels = normalizeDeepSeekModelList(config.model.availableModels)
    ?? getDefaultDeepSeekModels();
  const normalizedProviders = config.providers
    ? Object.fromEntries(
        Object.entries(config.providers).map(([providerKey, providerConfig]) => [
          providerKey,
          providerKey === 'deepseek'
            ? {
                ...providerConfig,
                models: normalizeDeepSeekModelList(providerConfig.models as ProviderModelDefinition[] | undefined)
                  ?? getDefaultDeepSeekModels(),
              }
            : providerConfig,
        ]),
      ) as AppConfig['providers']
    : config.providers;
  const normalizedProvidersWithLegacyApi = normalizeLegacyApiBackfill(normalizedProviders, config.api);

  return {
    ...config,
    model: {
      ...config.model,
      availableModels: normalizedAvailableModels,
      defaultModel: normalizeDeepSeekDefaultModel(config.model.defaultModel, normalizedAvailableModels),
    },
    providers: normalizedProvidersWithLegacyApi,
  };
}

// 默认配置
export const defaultConfig: AppConfig = {
  api: {
    key: '',
    baseUrl: 'https://api.deepseek.com/anthropic',
  },
  model: {
    availableModels: getDefaultDeepSeekModels(),
    defaultModel: DEEPSEEK_DEFAULT_MODEL_ID,
  },
  providers: {
    openai: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.openai.com',
      apiFormat: 'openai',
      models: [
        { id: 'gpt-5.2-2025-12-11', name: 'GPT-5.2', supportsImage: true },
        { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', supportsImage: true }
      ]
    },
    gemini: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      apiFormat: 'openai',
      models: [
        { id: 'gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
        { id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true },
        { id: 'gemini-3-flash-preview', name: 'Gemini 3 Flash', supportsImage: true }
      ]
    },
    anthropic: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      apiFormat: 'anthropic',
      models: [
        { id: 'claude-sonnet-4-5-20250929', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', supportsImage: true },
        { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', supportsImage: true }
      ]
    },
    deepseek: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      apiFormat: 'openai',
      models: getDefaultDeepSeekModels()
    },
    moonshot: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.moonshot.cn/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'kimi-k2.5', name: 'Kimi K2.5', supportsImage: true }
      ]
    },
    zhipu: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'glm-5', name: 'GLM 5', supportsImage: false },
        { id: 'glm-4.7', name: 'GLM 4.7', supportsImage: false }
      ]
    },
    minimax: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'MiniMax-M2.5', name: 'MiniMax M2.5', supportsImage: false },
        { id: 'MiniMax-M2.1', name: 'MiniMax M2.1', supportsImage: false }
      ]
    },
    qwen: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', supportsImage: true },
        { id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus', supportsImage: false }
      ]
    },
    xiaomi: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://api.xiaomimimo.com/anthropic',
      apiFormat: 'anthropic',
      models: [
        { id: 'mimo-v2-flash', name: 'MiMo V2 Flash', supportsImage: false }
      ]
    },
    openrouter: {
      enabled: false,
      apiKey: '',
      baseUrl: 'https://openrouter.ai/api',
      apiFormat: 'anthropic',
      models: [
        { id: 'anthropic/claude-sonnet-4.5', name: 'Claude Sonnet 4.5', supportsImage: true },
        { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', supportsImage: true },
        { id: 'openai/gpt-5.2-codex', name: 'GPT 5.2 Codex', supportsImage: true },
        { id: 'google/gemini-3-pro-preview', name: 'Gemini 3 Pro', supportsImage: true },
      ]
    },
    ollama: {
      enabled: false,
      apiKey: '',
      baseUrl: 'http://localhost:11434',
      apiFormat: 'anthropic',
      models: [
        { id: 'qwen3-coder-next', name: 'Qwen3-Coder-Next', supportsImage: false },
        { id: 'glm-4.7-flash', name: 'GLM 4.7 Flash', supportsImage: false }
      ]
    }
  },
  theme: 'system',
  language: 'zh',
  app: {
    port: 3000,
    isDevelopment: process.env.NODE_ENV === 'development',
  },
  shortcuts: {
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  },
  feeRates: {
    btc: 2,
    mvc: 1,
    doge: 7500000,
  },
};

// 配置存储键
export const CONFIG_KEYS = {
  APP_CONFIG: 'app_config',
  AUTH: 'auth_state',
  CONVERSATIONS: 'conversations',
  PROVIDERS_EXPORT_KEY: 'providers_export_key',
  SKILLS: 'skills',
};

// Model provider classification (kept for compatibility)
export const CHINA_PROVIDERS = ['deepseek', 'moonshot', 'qwen', 'zhipu', 'minimax', 'xiaomi', 'ollama'] as const;
export const GLOBAL_PROVIDERS = ['openai', 'gemini', 'anthropic', 'openrouter'] as const;
export const EN_PRIORITY_PROVIDERS = ['openai', 'anthropic', 'gemini'] as const;

/** All supported LLM provider keys for the Model settings page. No language filtering. */
export const ALL_PROVIDER_KEYS = [
  'openai', 'gemini', 'anthropic', 'deepseek', 'moonshot', 'zhipu', 'minimax', 'qwen', 'xiaomi', 'openrouter', 'ollama',
] as const;

/**
 * Returns all supported LLM provider keys for the Model settings page.
 * No language-based filtering; all providers are shown uniformly.
 */
export const getVisibleProviders = (_language: 'zh' | 'en'): readonly string[] => {
  return ALL_PROVIDER_KEYS;
};
