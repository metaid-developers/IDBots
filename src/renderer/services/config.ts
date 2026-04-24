import { AppConfig, CONFIG_KEYS, defaultConfig, normalizeDeepSeekAppConfig } from '../config';
import { localStore } from './store';

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

const normalizeProviderApiFormat = (providerKey: string, apiFormat: unknown): 'anthropic' | 'openai' => {
  const fixed = getFixedProviderApiFormat(providerKey);
  if (fixed) {
    return fixed;
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

const normalizeSingleProviderConfig = (
  providerKey: string,
  providerConfig: NonNullable<AppConfig['providers']>[string],
): NonNullable<AppConfig['providers']>[string] => ({
  ...providerConfig,
  baseUrl: normalizeProviderBaseUrl(providerKey, providerConfig.baseUrl),
  apiFormat: normalizeProviderApiFormat(providerKey, providerConfig.apiFormat),
  models: cloneProviderModels(providerConfig.models),
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

        const normalizedConfig = normalizeDeepSeekAppConfig(mergedConfig);
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

  getApiConfig() {
    return {
      apiKey: this.config.api.key,
      baseUrl: this.config.api.baseUrl,
    };
  }
}

export const configService = new ConfigService(); 
