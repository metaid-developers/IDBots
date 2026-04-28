export const DEFAULT_COWORK_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COWORK_MAX_OUTPUT_TOKENS = 8_192;
export const DEEPSEEK_V4_PRO_CONTEXT_WINDOW = 1_000_000;
export const DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS = 16_000;

export type CoworkModelLimitSource = 'provider-model' | 'available-model' | 'known-model' | 'fallback';

export interface CoworkModelLimits {
  modelId: string;
  contextWindow: number;
  maxOutputTokens: number;
  source: CoworkModelLimitSource;
}

type ModelLike = {
  id?: unknown;
  contextWindow?: unknown;
  maxOutputTokens?: unknown;
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

const KNOWN_MODEL_LIMITS: Record<string, Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>> = {
  'deepseek-v4-pro': {
    contextWindow: DEEPSEEK_V4_PRO_CONTEXT_WINDOW,
    maxOutputTokens: DEEPSEEK_V4_PRO_MAX_OUTPUT_TOKENS,
  },
};

function normalizeModelId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function getModelLimits(model: ModelLike): Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>> {
  return {
    contextWindow: toPositiveInteger(model.contextWindow),
    maxOutputTokens: toPositiveInteger(model.maxOutputTokens),
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
  explicit?: Partial<Pick<CoworkModelLimits, 'contextWindow' | 'maxOutputTokens'>>,
): CoworkModelLimits {
  const known = KNOWN_MODEL_LIMITS[modelId];
  return {
    modelId,
    contextWindow: explicit?.contextWindow ?? known?.contextWindow ?? DEFAULT_COWORK_CONTEXT_WINDOW,
    maxOutputTokens: explicit?.maxOutputTokens ?? known?.maxOutputTokens ?? DEFAULT_COWORK_MAX_OUTPUT_TOKENS,
    source,
  };
}

export function resolveCoworkModelLimits(
  appConfig: AppConfigLike,
  overrideModelId?: string | null,
): CoworkModelLimits {
  const modelId = resolveTargetModelId(appConfig, overrideModelId);

  for (const provider of Object.values(appConfig.providers ?? {})) {
    if (!provider?.enabled) {
      continue;
    }
    const model = findModelById(provider.models, modelId);
    if (!model) {
      continue;
    }
    const explicit = getModelLimits(model);
    if (explicit.contextWindow || explicit.maxOutputTokens) {
      return buildLimits(modelId, 'provider-model', explicit);
    }
  }

  const availableModel = findModelById(appConfig.model?.availableModels, modelId);
  if (availableModel) {
    const explicit = getModelLimits(availableModel);
    if (explicit.contextWindow || explicit.maxOutputTokens) {
      return buildLimits(modelId, 'available-model', explicit);
    }
  }

  if (KNOWN_MODEL_LIMITS[modelId]) {
    return buildLimits(modelId, 'known-model');
  }

  return buildLimits(modelId, 'fallback');
}
