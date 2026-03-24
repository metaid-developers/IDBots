type ProviderModel = {
  id: string;
};

type ProviderConfig = {
  enabled?: boolean;
  apiKey?: string;
  baseUrl?: string;
  models?: ProviderModel[];
};

type AppConfig = {
  providers?: Record<string, ProviderConfig>;
};

type ImageProviderId =
  | 'openai'
  | 'google'
  | 'openrouter'
  | 'dashscope'
  | 'replicate'
  | 'jimeng'
  | 'seedream';

type ProviderSpec = {
  imageProvider: ImageProviderId;
  appProviderKey?: string;
  credentialEnvNames: string[];
  modelEnvName: string;
  defaultModel: string;
  baseUrlEnvName?: string;
  requiresAllCredentials?: boolean;
};

const BAOYU_IMAGE_SKILL_ID = 'baoyu-image-studio';

const PROVIDER_SPECS: Record<ImageProviderId, ProviderSpec> = {
  openai: {
    imageProvider: 'openai',
    appProviderKey: 'openai',
    credentialEnvNames: ['OPENAI_API_KEY'],
    modelEnvName: 'OPENAI_IMAGE_MODEL',
    defaultModel: 'gpt-image-1.5',
    baseUrlEnvName: 'OPENAI_BASE_URL',
  },
  google: {
    imageProvider: 'google',
    appProviderKey: 'gemini',
    credentialEnvNames: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    modelEnvName: 'GOOGLE_IMAGE_MODEL',
    defaultModel: 'gemini-3-pro-image-preview',
    baseUrlEnvName: 'GOOGLE_BASE_URL',
  },
  openrouter: {
    imageProvider: 'openrouter',
    appProviderKey: 'openrouter',
    credentialEnvNames: ['OPENROUTER_API_KEY'],
    modelEnvName: 'OPENROUTER_IMAGE_MODEL',
    defaultModel: 'google/gemini-3.1-flash-image-preview',
    baseUrlEnvName: 'OPENROUTER_BASE_URL',
  },
  dashscope: {
    imageProvider: 'dashscope',
    appProviderKey: 'qwen',
    credentialEnvNames: ['DASHSCOPE_API_KEY'],
    modelEnvName: 'DASHSCOPE_IMAGE_MODEL',
    defaultModel: 'qwen-image-2.0-pro',
    baseUrlEnvName: 'DASHSCOPE_BASE_URL',
  },
  replicate: {
    imageProvider: 'replicate',
    credentialEnvNames: ['REPLICATE_API_TOKEN'],
    modelEnvName: 'REPLICATE_IMAGE_MODEL',
    defaultModel: 'google/nano-banana-pro',
    baseUrlEnvName: 'REPLICATE_BASE_URL',
  },
  jimeng: {
    imageProvider: 'jimeng',
    credentialEnvNames: ['JIMENG_ACCESS_KEY_ID', 'JIMENG_SECRET_ACCESS_KEY'],
    modelEnvName: 'JIMENG_IMAGE_MODEL',
    defaultModel: 'jimeng_t2i_v40',
    baseUrlEnvName: 'JIMENG_BASE_URL',
    requiresAllCredentials: true,
  },
  seedream: {
    imageProvider: 'seedream',
    credentialEnvNames: ['ARK_API_KEY'],
    modelEnvName: 'SEEDREAM_IMAGE_MODEL',
    defaultModel: 'doubao-seedream-5-0-260128',
    baseUrlEnvName: 'SEEDREAM_BASE_URL',
  },
};

const BRIDGE_PROVIDER_ORDER: ImageProviderId[] = ['openai', 'google', 'openrouter', 'dashscope'];
const ENV_ONLY_PROVIDER_ORDER: ImageProviderId[] = ['replicate', 'jimeng', 'seedream'];
const METABOT_PROVIDER_MAPPING: Record<string, ImageProviderId> = {
  openai: 'openai',
  gemini: 'google',
  openrouter: 'openrouter',
  qwen: 'dashscope',
};

const normalizeString = (value: unknown): string => {
  return typeof value === 'string' ? value.trim() : '';
};

const normalizeSkillIds = (skillIds?: string[]): Set<string> => {
  return new Set(
    (skillIds ?? [])
      .map((id) => normalizeString(id).toLowerCase())
      .filter(Boolean)
      .flatMap((id) => [id, id.replace(/_/g, '-'), id.replace(/-/g, '_')])
  );
};

const shouldInjectForSkillIds = (skillIds?: string[]): boolean => {
  if (!Array.isArray(skillIds) || skillIds.length === 0) {
    return true;
  }

  const normalized = normalizeSkillIds(skillIds);
  return normalized.has(BAOYU_IMAGE_SKILL_ID) || normalized.has(BAOYU_IMAGE_SKILL_ID.replace(/-/g, '_'));
};

const getAppProviderApiKey = (
  appConfig: AppConfig | null | undefined,
  appProviderKey: string | undefined
): string => {
  if (!appProviderKey) {
    return '';
  }

  const provider = appConfig?.providers?.[appProviderKey];
  if (!provider?.enabled) {
    return '';
  }

  return normalizeString(provider.apiKey);
};

const getEnvCredentialValues = (
  spec: ProviderSpec,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> | null => {
  const resolved: Record<string, string> = {};

  if (spec.requiresAllCredentials) {
    for (const envName of spec.credentialEnvNames) {
      const value = normalizeString(processEnv[envName]);
      if (!value) {
        return null;
      }
      resolved[envName] = value;
    }
    return resolved;
  }

  const firstValue = spec.credentialEnvNames
    .map((envName) => normalizeString(processEnv[envName]))
    .find(Boolean);
  if (!firstValue) {
    return null;
  }

  for (const envName of spec.credentialEnvNames) {
    resolved[envName] = firstValue;
  }
  return resolved;
};

const buildProviderEnv = (
  spec: ProviderSpec,
  credentialValues: Record<string, string>,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> => {
  const env: Record<string, string> = {
    BAOYU_IMAGE_PROVIDER: spec.imageProvider,
    [spec.modelEnvName]: normalizeString(processEnv[spec.modelEnvName]) || spec.defaultModel,
  };

  Object.assign(env, credentialValues);

  if (spec.baseUrlEnvName) {
    const baseUrl = normalizeString(processEnv[spec.baseUrlEnvName]);
    if (baseUrl) {
      env[spec.baseUrlEnvName] = baseUrl;
    }
  }

  return env;
};

const resolveProviderFromAppOrEnv = (
  providerId: ImageProviderId,
  appConfig: AppConfig | null | undefined,
  processEnv: NodeJS.ProcessEnv
): Record<string, string> | null => {
  const spec = PROVIDER_SPECS[providerId];
  const appApiKey = getAppProviderApiKey(appConfig, spec.appProviderKey);

  if (appApiKey) {
    const credentialValues = Object.fromEntries(
      spec.credentialEnvNames.map((envName) => [envName, appApiKey])
    );
    return buildProviderEnv(spec, credentialValues, processEnv);
  }

  const envCredentialValues = getEnvCredentialValues(spec, processEnv);
  if (!envCredentialValues) {
    return null;
  }

  return buildProviderEnv(spec, envCredentialValues, processEnv);
};

export function buildImageSkillEnvOverrides(input: {
  activeSkillIds?: string[];
  metabotLlmId?: string | null;
  appConfig?: AppConfig | null;
  processEnv?: NodeJS.ProcessEnv;
}): Record<string, string> {
  if (!shouldInjectForSkillIds(input.activeSkillIds)) {
    return {};
  }

  const processEnv = input.processEnv ?? process.env;
  const appConfig = input.appConfig ?? null;
  const mappedProvider = METABOT_PROVIDER_MAPPING[normalizeString(input.metabotLlmId).toLowerCase()];
  const orderedProviders: ImageProviderId[] = [];

  if (mappedProvider) {
    orderedProviders.push(mappedProvider);
  }

  for (const providerId of BRIDGE_PROVIDER_ORDER) {
    if (!orderedProviders.includes(providerId)) {
      orderedProviders.push(providerId);
    }
  }

  for (const providerId of ENV_ONLY_PROVIDER_ORDER) {
    if (!orderedProviders.includes(providerId)) {
      orderedProviders.push(providerId);
    }
  }

  for (const providerId of orderedProviders) {
    const resolved = resolveProviderFromAppOrEnv(providerId, appConfig, processEnv);
    if (resolved) {
      return resolved;
    }
  }

  return {};
}
