import type { AppConfig } from '../../../renderer/config';
import { canonicalFreeProviderKey, LLM_FREE_PROVIDER_KEY } from '../../../renderer/services/llmFreeQuotaGate.js';
import { PROVIDER_TEMPLATES, type ProviderTemplate, type ProviderTemplateModel } from '../../../renderer/services/providerTemplates';
import { getMobileElectron } from '../appBridge';

export type MobileProviderConfig = NonNullable<AppConfig['providers']>[string];
export type MobileApiFormat = NonNullable<MobileProviderConfig['apiFormat']>;

export interface MobileModelConfig {
  providers?: AppConfig['providers'];
  model?: Partial<AppConfig['model']>;
}

export interface MobileModelSelection {
  providerKey: string;
  providerName: string;
  apiKey: string;
  baseUrl: string;
  apiFormat: MobileApiFormat;
  modelId: string;
  models: ProviderTemplateModel[];
  apiKeyManagementUrl?: string;
  logoKey?: string;
}

export type MobileModelValidationReason =
  | 'officialUnavailable'
  | 'nameRequired'
  | 'apiKeyRequired'
  | 'baseUrlRequired'
  | 'baseUrlInvalid'
  | 'modelRequired';

export class MobileModelValidationError extends Error {
  constructor(readonly reason: MobileModelValidationReason) {
    super(reason);
    this.name = 'MobileModelValidationError';
  }
}

const PRESET_PROVIDER_KEYS: Readonly<Record<string, string>> = {
  deepseek: 'deepseek',
  'moonshot-kimi': 'moonshot',
  openai: 'openai',
  anthropic: 'anthropic',
  'qwen-alibaba-model-studio-cn': 'qwen',
  minimax: 'minimax',
  openrouter: 'openrouter',
};

const PRESET_TEMPLATE_IDS = Object.keys(PRESET_PROVIDER_KEYS);

export const MOBILE_PROVIDER_PRESETS: readonly ProviderTemplate[] = PRESET_TEMPLATE_IDS
  .map((templateId) => PROVIDER_TEMPLATES.find((template) => template.templateId === templateId))
  .filter((template): template is ProviderTemplate => template !== undefined);

export function isOfficialProvider(providerKey: string | null | undefined): boolean {
  return canonicalFreeProviderKey(providerKey) === LLM_FREE_PROVIDER_KEY;
}

export function officialProviderKey(config: MobileModelConfig): string | null {
  return Object.keys(config.providers ?? {}).find((key) => isOfficialProvider(key)) ?? null;
}

export function providerKeyForPreset(templateId: string): string {
  return PRESET_PROVIDER_KEYS[templateId] ?? `custom-${templateId}`;
}

export function customProviderKey(name: string, config: MobileModelConfig): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  const base = `custom-${slug || 'provider'}`;
  let key = base;
  let suffix = 2;
  while (config.providers?.[key]) {
    key = `${base}-${suffix}`;
    suffix += 1;
  }
  return key;
}

export function hasSavedProviderKey(provider: MobileProviderConfig | undefined): boolean {
  return Boolean(provider?.apiKey?.trim());
}

export function configuredProviderKeys(config: MobileModelConfig): string[] {
  const defaultProvider = config.model?.defaultProvider ?? '';
  return Object.entries(config.providers ?? {})
    .filter(([key, provider]) => (
      !isOfficialProvider(key)
      && (provider.enabled || hasSavedProviderKey(provider) || key.startsWith('custom-') || key === defaultProvider)
    ))
    .map(([key]) => key);
}

export function defaultModelSummary(config: MobileModelConfig, language: 'zh' | 'en'): {
  providerName: string;
  modelName: string;
  providerKey: string;
} | null {
  const providerKey = config.model?.defaultProvider ?? officialProviderKey(config);
  if (!providerKey) return null;
  const provider = config.providers?.[providerKey];
  if (!provider) return null;
  const preset = MOBILE_PROVIDER_PRESETS.find((template) => providerKeyForPreset(template.templateId) === providerKey);
  const providerName = isOfficialProvider(providerKey)
    ? 'ID.Bots'
    : provider.name?.trim() || (preset ? (language === 'zh' ? preset.nameZh : preset.nameEn) : providerKey);
  const modelId = config.model?.defaultModel ?? provider.models?.[0]?.id ?? '';
  const modelName = provider.models?.find((model) => model.id === modelId)?.name || modelId;
  return { providerName, modelName, providerKey };
}

export function validateMobileModelSelection(
  config: MobileModelConfig,
  selection: MobileModelSelection,
): MobileModelValidationReason | null {
  const existing = config.providers?.[selection.providerKey];
  if (isOfficialProvider(selection.providerKey)) {
    if (!existing || !selection.modelId.trim()) return 'officialUnavailable';
    return null;
  }
  if (selection.providerKey.startsWith('custom-') && !existing && !selection.providerName.trim()) {
    return 'nameRequired';
  }
  if (selection.providerKey !== 'ollama' && !selection.apiKey.trim() && !hasSavedProviderKey(existing)) {
    return 'apiKeyRequired';
  }
  const baseUrl = selection.baseUrl.trim();
  if (!baseUrl) return 'baseUrlRequired';
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'baseUrlInvalid';
  } catch {
    return 'baseUrlInvalid';
  }
  if (!selection.modelId.trim()) return 'modelRequired';
  return null;
}

export function buildMobileModelPatch(
  config: MobileModelConfig,
  selection: MobileModelSelection,
): Pick<AppConfig, 'providers' | 'model'> {
  const reason = validateMobileModelSelection(config, selection);
  if (reason) throw new MobileModelValidationError(reason);
  const providerKey = selection.providerKey;
  const existing = config.providers?.[providerKey];
  const official = isOfficialProvider(providerKey);
  const modelId = selection.modelId.trim();
  const models = official
    ? existing?.models ?? []
    : selection.models.some((model) => model.id === modelId)
      ? selection.models.map((model) => ({ ...model }))
      : [...selection.models.map((model) => ({ ...model })), { id: modelId, name: modelId }];
  const provider: MobileProviderConfig = official && existing
    ? { ...existing, enabled: true }
    : {
        ...existing,
        enabled: true,
        apiKey: official ? existing?.apiKey ?? '' : selection.apiKey.trim() || existing?.apiKey || '',
        baseUrl: official ? existing?.baseUrl ?? '' : selection.baseUrl.trim(),
        apiFormat: official ? existing?.apiFormat : selection.apiFormat,
        models,
        name: official ? existing?.name : selection.providerName.trim() || existing?.name || providerKey,
        apiKeyManagementUrl: selection.apiKeyManagementUrl ?? existing?.apiKeyManagementUrl,
        logoKey: selection.logoKey ?? existing?.logoKey,
      };
  return {
    providers: {
      ...config.providers,
      [providerKey]: provider,
    } as AppConfig['providers'],
    model: {
      ...config.model,
      defaultProvider: providerKey,
      defaultModel: modelId,
    } as AppConfig['model'],
  };
}

export async function saveMobileModelSelection(
  selection: MobileModelSelection,
): Promise<{ config: MobileModelConfig; providerKey: string; modelId: string }> {
  const electron = getMobileElectron();
  const current = (await electron.store.get('app_config')) as MobileModelConfig | null;
  const config = current ?? {};
  const patch = buildMobileModelPatch(config, selection);
  await electron.store.set('app_config', patch);
  const saved = (await electron.store.get('app_config')) as MobileModelConfig | null;
  const provider = saved?.providers?.[selection.providerKey];
  if (
    saved?.model?.defaultProvider !== selection.providerKey
    || saved.model.defaultModel !== selection.modelId.trim()
    || !provider?.enabled
    || provider.baseUrl !== patch.providers?.[selection.providerKey]?.baseUrl
  ) {
    throw new Error('model_settings_confirmation_failed');
  }
  return { config: saved, providerKey: selection.providerKey, modelId: selection.modelId.trim() };
}
