import { AppConfig, CONFIG_KEYS, defaultConfig, normalizeDeepSeekAppConfig } from '../config';
import { localStore } from './store';
import { getFreeProviderModelCanonical, getFreeProviderModelDisplayName, FREE_PROVIDER_DISPLAY_NAME, LLM_FREE_PROVIDER_KEY } from './llmFreeQuotaGate.js';

const getFixedProviderApiFormat = (providerKey: string): 'anthropic' | 'openai' | null => {
  if (providerKey === 'openai' || providerKey === 'gemini') {
    return 'openai';
  }
  if (providerKey === 'anthropic') {
    return 'anthropic';
  }
  return null;
};

const normalizeProviderBaseUrl = (providerKey: string, baseUrl: unknown): string => {
  if (typeof baseUrl !== 'string') {
    return '';
  }

  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (providerKey !== 'gemini') {
    return normalized;
  }

  if (!normalized || !normalized.includes('generativelanguage.googleapis.com')) {
    return normalized;
  }

  if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
    return normalized;
  }
  if (normalized.endsWith('/v1beta')) {
    return `${normalized}/openai`;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized.slice(0, -3)}v1beta/openai`;
  }

  return 'https://generativelanguage.googleapis.com/v1beta/openai';
};

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' | 'responses' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
  }
  if (apiFormat === 'responses') {
    return 'responses';
  }
  if (apiFormat === 'openai') {
    return 'openai';
  }
  return 'anthropic';
};

const cloneProviderModels = (
  models: NonNullable<NonNullable<AppConfig['providers']>[string]['models']> | undefined,
) => models?.map((model) => ({
  ...model,
  supportsImage: model.supportsImage ?? false,
  options: model.options
    ? {
        ...model.options,
        thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
      }
    : undefined,
}));

const buildProviderSignature = (
  models: NonNullable<NonNullable<AppConfig['providers']>[string]['models']> | undefined,
): string => JSON.stringify(
  (models ?? []).map((model) => ({
    id: model.id,
    name: model.name,
    supportsImage: model.supportsImage ?? false,
    options: model.options
      ? {
          reasoningEffort: model.options.reasoningEffort,
          thinking: model.options.thinking ? { ...model.options.thinking } : undefined,
        }
      : undefined,
  })),
);

// The built-in free-quota provider is managed end to end (relay-provisioned
// credentials, hidden in the UI), so its models always normalize to the
// canonical product config: display names instead of the relay's internal
// wire ids, and — for known ids — the canonical limits/options. The relay
// still reports deepseek-chat with the legacy 64K/4K DeepSeek V3 wire values
// while actually serving the current flash model (deepseek-flash, 1M
// context), so installs provisioned before this normalization get their
// stored entry rewritten on load (ConfigService.init persists the corrected
// config back).
const normalizeFreeProviderModels = (
  models: NonNullable<NonNullable<AppConfig['providers']>[string]['models']> | undefined,
) => models?.map((model) => ({
  ...model,
  ...getFreeProviderModelCanonical(model.id),
  name: getFreeProviderModelDisplayName(model.id),
}));

const normalizeSingleProviderConfig = (
  providerKey: string,
  providerConfig: NonNullable<AppConfig['providers']>[string],
): NonNullable<AppConfig['providers']>[string] => ({
  ...providerConfig,
  // The free provider's stored name predates the IDBots-Free rename on old
  // installs ("MetaID Free"); built-ins expose no rename UI, so the canonical
  // label always wins and name readers see a unified value after migration.
  name: providerKey === LLM_FREE_PROVIDER_KEY
    ? FREE_PROVIDER_DISPLAY_NAME
    : providerConfig.name,
  baseUrl: normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl),
  apiFormat: normalizeProviderApiFormat(providerKey, providerConfig.apiFormat),
  models: providerKey === LLM_FREE_PROVIDER_KEY
    ? normalizeFreeProviderModels(providerConfig.models)
    : cloneProviderModels(providerConfig.models),
});

const getDefaultProvidersConfig = (): NonNullable<AppConfig['providers']> => (
  Object.fromEntries(
    Object.entries(defaultConfig.providers ?? {}).map(([providerKey, providerConfig]) => [
      providerKey,
      normalizeSingleProviderConfig(providerKey, providerConfig),
    ]),
  ) as NonNullable<AppConfig['providers']>
);

const shouldPreserveExistingProviderConfig = (
  providerKey: string,
  currentProvider: NonNullable<AppConfig['providers']>[string] | undefined,
  incomingProvider: NonNullable<AppConfig['providers']>[string] | undefined,
): boolean => {
  if (!currentProvider || !incomingProvider) {
    return false;
  }

  if (!String(currentProvider.apiKey ?? '').trim() || String(incomingProvider.apiKey ?? '').trim()) {
    return false;
  }

  const defaultProvider = getDefaultProvidersConfig()[providerKey];
  if (!defaultProvider) {
    return false;
  }

  return incomingProvider.enabled === defaultProvider.enabled
    && incomingProvider.baseUrl === defaultProvider.baseUrl
    && incomingProvider.apiFormat === defaultProvider.apiFormat
    && buildProviderSignature(incomingProvider.models) === buildProviderSignature(defaultProvider.models);
};

export const mergeProvidersConfig = (
  currentProviders?: AppConfig['providers'],
  incomingProviders?: AppConfig['providers'],
): AppConfig['providers'] => {
  const defaultProviders = getDefaultProvidersConfig();
  const keys = new Set([
    ...Object.keys(defaultProviders),
    ...Object.keys(currentProviders ?? {}),
    ...Object.keys(incomingProviders ?? {}),
  ]);

  return Object.fromEntries(
    Array.from(keys).map((providerKey) => {
      const defaultProvider = defaultProviders[providerKey];
      const currentProvider = currentProviders?.[providerKey]
        ? normalizeSingleProviderConfig(providerKey, currentProviders[providerKey])
        : defaultProvider;
      const incomingProvider = incomingProviders?.[providerKey]
        ? normalizeSingleProviderConfig(providerKey, {
            ...defaultProvider,
            ...incomingProviders[providerKey],
          })
        : undefined;

      if (shouldPreserveExistingProviderConfig(providerKey, currentProvider, incomingProvider)) {
        return [
          providerKey,
          {
            ...currentProvider,
            models: currentProvider?.models ?? incomingProvider?.models,
          },
        ];
      }

      return [
        providerKey,
        incomingProvider
          ? {
              ...currentProvider,
              ...incomingProvider,
              models: incomingProvider.models ?? currentProvider?.models,
            }
          : currentProvider,
      ];
    }),
  ) as AppConfig['providers'];
};

// ---------------------------------------------------------------------------
// 版本化 Provider 预设模型迁移
//
// 背景：stored config 的 providers.models 优先于 defaultConfig，直接改默认值
// 不会让老用户拿到新模型。这里参照 LobsterAI 的做法做版本化迁移：
// - removed：只移除"我们曾作为预设下发、现已淘汰"的模型 ID，用户自定义模型不受影响
// - added：只注入用户列表中尚不存在的新预设模型（置前，保持旗舰模型在首位）
// - defaultModelRemap：用户当前默认模型若被淘汰，则映射到对应的新模型
// 重要：deepseek 不参与迁移，已配置 DeepSeek 的老用户升级后保持完全不变。
// ---------------------------------------------------------------------------

export const PROVIDER_MODEL_MIGRATION_VERSION = 3;

type ProviderModelEntry = NonNullable<NonNullable<AppConfig['providers']>[string]['models']>[number];

/**
 * One capability correction applied to EXISTING model rows across EVERY
 * provider (custom gateways included; deepseek stays untouched like the rest
 * of the migration machinery). `idPattern` is a case-insensitive regex
 * source matched against the id's last path segment, so vendor prefixes
 * (`z-ai/glm-5.3-flash`) and case variants (`GLM-5.3-Flash`) all match.
 */
type ProviderModelVisionFlip = {
  idPattern: string;
  supportsImage: boolean;
};

type ProviderModelMigration = {
  removed: Record<string, string[]>;
  added: Record<string, ProviderModelEntry[]>;
  defaultModelRemap: Record<string, string>;
  visionFlips?: ProviderModelVisionFlip[];
};

const PROVIDER_MODEL_MIGRATIONS: Record<number, ProviderModelMigration> = {
  // v1：向 LobsterAI 最新模型列表对齐（2026-07）
  1: {
    removed: {
      openai: ['gpt-5.2-2025-12-11', 'gpt-5.2-codex'],
      gemini: ['gemini-3-pro-preview'],
      anthropic: ['claude-sonnet-4-5-20250929'],
      minimax: ['MiniMax-M2.1'],
      qwen: ['qwen3-coder-plus'],
      xiaomi: ['mimo-v2-flash'],
      openrouter: [
        'anthropic/claude-sonnet-4.5',
        'anthropic/claude-opus-4.6',
        'openai/gpt-5.2-codex',
        'google/gemini-3-pro-preview',
      ],
    },
    added: {
      openai: [
        { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.5', name: 'GPT-5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'gpt-5.4', name: 'GPT-5.4', supportsImage: true, contextWindow: 1_050_000 },
      ],
      gemini: [
        { id: 'gemini-3.1-flash-lite', name: 'Gemini 3.1 Flash Lite', supportsImage: true, contextWindow: 2_000_000 },
      ],
      anthropic: [
        { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
      ],
      moonshot: [
        { id: 'kimi-k2.6', name: 'Kimi K2.6', supportsImage: true, contextWindow: 262_144 },
      ],
      zhipu: [
        { id: 'glm-5.1', name: 'GLM 5.1', supportsImage: false, contextWindow: 202_800 },
      ],
      minimax: [
        { id: 'MiniMax-M3', name: 'MiniMax M3', supportsImage: true, contextWindow: 1_000_000 },
        { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', supportsImage: false, contextWindow: 204_800 },
      ],
      qwen: [
        { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', supportsImage: true, contextWindow: 1_000_000 },
      ],
      xiaomi: [
        { id: 'mimo-v2.5-pro', name: 'MiMo V2.5 Pro', supportsImage: false, contextWindow: 1_000_000 },
        { id: 'mimo-v2.5', name: 'MiMo V2.5', supportsImage: true, contextWindow: 1_000_000 },
      ],
      openrouter: [
        { id: 'anthropic/claude-sonnet-4.6', name: 'Claude Sonnet 4.6', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'anthropic/claude-opus-4.7', name: 'Claude Opus 4.7', supportsImage: true, contextWindow: 1_048_576 },
        { id: 'openai/gpt-5.5', name: 'GPT 5.5', supportsImage: true, contextWindow: 1_050_000 },
        { id: 'google/gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', supportsImage: true, contextWindow: 2_000_000 },
      ],
    },
    defaultModelRemap: {
      'gpt-5.2-2025-12-11': 'gpt-5.6-sol',
      'gpt-5.2-codex': 'gpt-5.6-sol',
      'gemini-3-pro-preview': 'gemini-3.1-pro-preview',
      'claude-sonnet-4-5-20250929': 'claude-sonnet-4-6',
      'MiniMax-M2.1': 'MiniMax-M2.5',
      'qwen3-coder-plus': 'qwen3.5-plus',
      'mimo-v2-flash': 'mimo-v2.5',
      'anthropic/claude-sonnet-4.5': 'anthropic/claude-sonnet-4.6',
      'anthropic/claude-opus-4.6': 'anthropic/claude-opus-4.7',
      'openai/gpt-5.2-codex': 'openai/gpt-5.5',
      'google/gemini-3-pro-preview': 'google/gemini-3.1-pro-preview',
    },
  },
  // v2：Zhipu 预设对齐 GLM-5.3 家族（2026-09-18）。GLM-5.3/5.3-Flash 全线
  // 1M 上下文（官方 live catalog GET /api/v1/models），Flash 为原生多模态；
  // 5.3 以下的旧预设（glm-5.1/5/4.7）淘汰，自定义添加的模型不受影响。
  2: {
    removed: {
      zhipu: ['glm-5.1', 'glm-5', 'glm-4.7'],
    },
    added: {
      zhipu: [
        { id: 'glm-5.3', name: 'GLM-5.3', supportsImage: false, contextWindow: 1_048_576, maxOutputTokens: 128_000 },
        { id: 'glm-5.3-flash', name: 'GLM-5.3 Flash', supportsImage: true, contextWindow: 1_048_576, maxOutputTokens: 128_000 },
      ],
    },
    defaultModelRemap: {
      'glm-5.1': 'glm-5.3',
      'glm-5': 'glm-5.3',
      'glm-4.7': 'glm-5.3',
    },
  },
  // v3：GLM-5.3-Flash 全供应商开启视觉（2026-09-28）。该 SKU 原生多模态，
  // 所有网关转发的是同一个上游模型；存量行上的 supportsImage:false 并非
  // 用户主动取消勾选，而是行创建时"未验证即文本"的 fail-safe 默认值——
  // 它让 opencode/commandcode 等网关上的 GLM-5.3 Flash 一直无法读图
  // （当天的 glm-5.3-flash 读图事故根因之一）。一次性翻转为 true；
  // 旗舰 glm-5.3 及更早家族确为纯文本，保持不动。
  3: {
    removed: {},
    added: {},
    defaultModelRemap: {},
    visionFlips: [
      { idPattern: '^glm-5\\.3-flash', supportsImage: true },
    ],
  },
};

export const applyProviderModelMigrations = (config: AppConfig): AppConfig => {
  const currentVersion = config.providerModelMigrationVersion ?? 0;
  if (currentVersion >= PROVIDER_MODEL_MIGRATION_VERSION) {
    return config;
  }

  let nextProviders = config.providers;
  let nextDefaultModel = config.model.defaultModel;

  for (let version = currentVersion + 1; version <= PROVIDER_MODEL_MIGRATION_VERSION; version += 1) {
    const migration = PROVIDER_MODEL_MIGRATIONS[version];
    if (!migration) {
      continue;
    }
    const visionFlips = migration.visionFlips ?? [];

    const providers = { ...(nextProviders ?? {}) } as NonNullable<AppConfig['providers']>;
    for (const [providerKey, providerConfig] of Object.entries(providers)) {
      if (providerKey === 'deepseek') {
        continue;
      }
      const removedIds = new Set(migration.removed[providerKey] ?? []);
      const addedModels = migration.added[providerKey] ?? [];
      if (removedIds.size === 0 && addedModels.length === 0 && visionFlips.length === 0) {
        continue;
      }
      const existingModels = providerConfig.models ?? [];
      const keptModels = existingModels.filter((model) => !removedIds.has(model.id));
      const keptIds = new Set(keptModels.map((model) => model.id));
      const modelsToAdd = addedModels.filter((model) => !keptIds.has(model.id));
      let flipped = false;
      const nextModels = [...modelsToAdd, ...keptModels].map((model) => {
        if (visionFlips.length === 0) {
          return model;
        }
        const segment = model.id.split('/').pop() ?? model.id;
        const flip = visionFlips.find((candidate) => new RegExp(candidate.idPattern, 'i').test(segment));
        if (!flip || model.supportsImage === flip.supportsImage) {
          return model;
        }
        flipped = true;
        return { ...model, supportsImage: flip.supportsImage };
      });
      if (!flipped && keptModels.length === existingModels.length && modelsToAdd.length === 0) {
        continue;
      }
      providers[providerKey] = {
        ...providerConfig,
        models: nextModels,
      };
    }
    nextProviders = providers;

    const remappedDefault = migration.defaultModelRemap[nextDefaultModel];
    if (remappedDefault) {
      nextDefaultModel = remappedDefault;
    }
  }

  return {
    ...config,
    model: {
      ...config.model,
      defaultModel: nextDefaultModel,
    },
    providers: nextProviders,
    providerModelMigrationVersion: PROVIDER_MODEL_MIGRATION_VERSION,
  };
};

// ---------------------------------------------------------------------------
// 版本化 Provider API 格式语义迁移
//
// 背景：当出厂默认 apiFormat 的含义/取值发生变化时（例如 opencode 从 chat
// completions 切换到 Responses），stored config 会用旧默认值覆盖 defaultConfig，
// 导致老用户拿不到新默认。这里做幂等的版本化迁移，只纠正仍处于出厂默认状态
// （apiKey 为空）的 provider，已自定义配置（填了 key 或改过格式）的用户保持不动。
// ---------------------------------------------------------------------------

export const PROVIDER_API_FORMAT_MIGRATION_VERSION = 3;

type ProviderApiFormatValue = 'anthropic' | 'openai' | 'responses';

/**
 * v1：opencode 默认 apiFormat 由 'openai'（chat completions）升级为 'responses'。
 *
 * OpenCode Go 网关三个端点共用同一 Base URL，DeepSeek Flash 在 Responses 格式下
 * 可携带 reasoning，故 Responses 成为更合适的默认。对所有仍停留在旧默认 'openai'
 * 的 opencode 用户（含已配置 apiKey 正在使用的）一律升级；用户若手动选过 'responses'
 * 或 'anthropic'，则尊重其选择保持不变。
 */
const migrateOpencodeApiFormatToResponses = (
  providers: NonNullable<AppConfig['providers']>,
): NonNullable<AppConfig['providers']> => {
  const opencode = providers.opencode;
  if (!opencode) {
    return providers;
  }
  // Only migrate providers still on the legacy 'openai' (chat completions) default.
  // A user who explicitly picked 'responses' or 'anthropic' is left untouched.
  if ((opencode.apiFormat as ProviderApiFormatValue | undefined) !== 'openai') {
    return providers;
  }
  return {
    ...providers,
    opencode: { ...opencode, apiFormat: 'responses' },
  };
};

/**
 * v2：DeepSeek 默认 API 形态对齐官方 harness —— 仅 API Key 的开通流程固定走
 * chat completions（apiFormat 'openai'）+ https://api.deepseek.com。设置页已隐藏
 * Base URL / API 格式字段，这里把仍停留在官方 anthropic 端点默认的老配置一次性
 * 迁到 openai 默认；自定义 Base URL（代理等）或已显式选择其他格式的保持不动。
 */
const DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEEPSEEK_OFFICIAL_OPENAI_BASE_URL = 'https://api.deepseek.com';

const migrateDeepseekApiFormatToOpenai = (
  providers: NonNullable<AppConfig['providers']>,
): NonNullable<AppConfig['providers']> => {
  const deepseek = providers.deepseek;
  if (!deepseek) {
    return providers;
  }
  if ((deepseek.apiFormat as ProviderApiFormatValue | undefined) !== 'anthropic') {
    return providers;
  }
  const baseUrl = String(deepseek.baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (baseUrl !== DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL) {
    return providers;
  }
  return {
    ...providers,
    deepseek: { ...deepseek, apiFormat: 'openai', baseUrl: DEEPSEEK_OFFICIAL_OPENAI_BASE_URL },
  };
};

/**
 * v3：Zhipu 默认 API 形态切换到 OpenAI Responses（GLM coding plan 推荐路径，
 * GLM-5.3 家族在 /api/v1 带 reasoning summaries 与 live catalog）。把仍停留在
 * 旧出厂默认（anthropic + https://open.bigmodel.cn/api/anthropic）的老配置一次性
 * 迁到 responses + https://open.bigmodel.cn/api/v1；自定义 Base URL（代理等）或
 * 已显式选择其他格式的保持不动。
 */
const ZHIPU_LEGACY_ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/anthropic';
const ZHIPU_RESPONSES_BASE_URL = 'https://open.bigmodel.cn/api/v1';

const migrateZhipuApiFormatToResponses = (
  providers: NonNullable<AppConfig['providers']>,
): NonNullable<AppConfig['providers']> => {
  const zhipu = providers.zhipu;
  if (!zhipu) {
    return providers;
  }
  if ((zhipu.apiFormat as ProviderApiFormatValue | undefined) !== 'anthropic') {
    return providers;
  }
  const baseUrl = String(zhipu.baseUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
  if (baseUrl !== ZHIPU_LEGACY_ANTHROPIC_BASE_URL) {
    return providers;
  }
  return {
    ...providers,
    zhipu: { ...zhipu, apiFormat: 'responses', baseUrl: ZHIPU_RESPONSES_BASE_URL },
  };
};

export const applyProviderApiFormatMigrations = (config: AppConfig): AppConfig => {
  const currentVersion = config.providerApiFormatMigrationVersion ?? 0;
  if (currentVersion >= PROVIDER_API_FORMAT_MIGRATION_VERSION) {
    return config;
  }

  let nextProviders = config.providers;

  for (let version = currentVersion + 1; version <= PROVIDER_API_FORMAT_MIGRATION_VERSION; version += 1) {
    if (version === 1) {
      nextProviders = nextProviders
        ? migrateOpencodeApiFormatToResponses(nextProviders as NonNullable<AppConfig['providers']>)
        : nextProviders;
    }
    if (version === 2) {
      nextProviders = nextProviders
        ? migrateDeepseekApiFormatToOpenai(nextProviders as NonNullable<AppConfig['providers']>)
        : nextProviders;
    }
    if (version === 3) {
      nextProviders = nextProviders
        ? migrateZhipuApiFormatToResponses(nextProviders as NonNullable<AppConfig['providers']>)
        : nextProviders;
    }
  }

  return {
    ...config,
    providers: nextProviders,
    providerApiFormatMigrationVersion: PROVIDER_API_FORMAT_MIGRATION_VERSION,
  };
};

class ConfigService {
  private config: AppConfig = defaultConfig;

  async init() {
    try {
      const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
      if (storedConfig) {
        const mergedProviders = mergeProvidersConfig(undefined, storedConfig.providers);

        const mergedConfig: AppConfig = {
          ...defaultConfig,
          ...storedConfig,
          api: {
            ...defaultConfig.api,
            ...storedConfig.api,
          },
          model: {
            ...defaultConfig.model,
            ...storedConfig.model,
          },
          app: {
            ...defaultConfig.app,
            ...storedConfig.app,
          },
          shortcuts: {
            ...defaultConfig.shortcuts!,
            ...(storedConfig.shortcuts ?? {}),
          } as AppConfig['shortcuts'],
          providers: mergedProviders as AppConfig['providers'],
        };

        const normalizedConfig = normalizeDeepSeekAppConfig(
          applyProviderModelMigrations(applyProviderApiFormatMigrations(mergedConfig)),
        );
        this.config = normalizedConfig;

        if (JSON.stringify(normalizedConfig) !== JSON.stringify(mergedConfig)) {
          await localStore.setItem(CONFIG_KEYS.APP_CONFIG, normalizedConfig);
        }
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  getConfig(): AppConfig {
    return this.config;
  }

  async updateConfig(newConfig: Partial<AppConfig>) {
    const normalizedProviders = newConfig.providers
      ? mergeProvidersConfig(this.config.providers, newConfig.providers as AppConfig['providers'])
      : undefined;
    this.config = normalizeDeepSeekAppConfig({
      ...this.config,
      ...newConfig,
      ...(normalizedProviders ? { providers: normalizedProviders } : {}),
    });
    await localStore.setItem(CONFIG_KEYS.APP_CONFIG, this.config);
  }

  /**
   * Re-read the persisted config from the store and adopt it as the in-memory
   * config. Called after Settings saves so the form can show what is ACTUALLY
   * stored: if the write silently failed or a migration reshaped a provider,
   * the fields visibly reflect the persisted truth instead of the pre-save
   * editor state (credential issues were otherwise undiagnosable — masked
   * inputs hid which key each provider really holds).
   */
  async reloadFromStore(): Promise<AppConfig> {
    const storedConfig = await localStore.getItem<AppConfig>(CONFIG_KEYS.APP_CONFIG);
    if (storedConfig) {
      this.config = normalizeDeepSeekAppConfig({
        ...defaultConfig,
        ...storedConfig,
        providers: mergeProvidersConfig(undefined, storedConfig.providers) as AppConfig['providers'],
      });
    }
    return this.config;
  }

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
