import { LLM_FREE_PROVIDER_KEY, LLM_FREE_PROVIDER_LEGACY_KEY } from '../../services/llmFreeQuotaGate.js';

/**
 * Default provider for onboarding step 1. When the built-in free-quota
 * provider is already provisioned (e.g. bootstrap succeeded but the welcome
 * bot creation failed, so onboarding still shows), preselect it so the user
 * can continue with zero input.
 */
export function getDefaultOnboardingProvider(language, providers) {
  const free = providers
    ? (providers[LLM_FREE_PROVIDER_KEY] ?? providers[LLM_FREE_PROVIDER_LEGACY_KEY])
    : undefined;
  if (free && free.enabled && free.apiKey && free.baseUrl) {
    return LLM_FREE_PROVIDER_KEY;
  }
  return language === 'zh' ? 'deepseek' : 'openai';
}
