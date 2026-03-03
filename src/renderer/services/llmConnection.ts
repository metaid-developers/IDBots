/**
 * Shared LLM connection test logic. Reused by Settings and Onboarding so both use
 * the same validation and URL building as the system LLM config (config.providers).
 */

const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

function getFixedApiFormatForProvider(provider: string): 'anthropic' | 'openai' | null {
  if (provider === 'openai' || provider === 'gemini') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  return null;
}

function normalizeApiFormat(value: unknown): 'anthropic' | 'openai' {
  return value === 'openai' ? 'openai' : 'anthropic';
}

export function getEffectiveApiFormat(provider: string, value: unknown): 'anthropic' | 'openai' {
  return getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value);
}

/** True when provider supports both Anthropic and OpenAI compatible APIs (user can choose). */
export function shouldShowApiFormatSelector(provider: string): boolean {
  return getFixedApiFormatForProvider(provider) === null;
}

const PROVIDER_DEFAULT_BASE_URLS: Record<string, { anthropic: string; openai: string }> = {
  deepseek: { anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com' },
  moonshot: { anthropic: 'https://api.moonshot.cn/anthropic', openai: 'https://api.moonshot.cn/v1' },
  zhipu: { anthropic: 'https://open.bigmodel.cn/api/anthropic', openai: 'https://open.bigmodel.cn/api/paas/v4/chat/completions' },
  minimax: { anthropic: 'https://api.minimaxi.com/anthropic', openai: 'https://api.minimaxi.com/v1' },
  qwen: { anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic', openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  xiaomi: { anthropic: 'https://api.xiaomimimo.com/anthropic', openai: 'https://api.xiaomimimo.com/v1/chat/completions' },
  openrouter: { anthropic: 'https://openrouter.ai/api', openai: 'https://openrouter.ai/api/v1' },
  ollama: { anthropic: 'http://localhost:11434', openai: 'http://localhost:11434/v1' },
};

/** Default base URL for a provider and API format (same as Settings). */
export function getProviderDefaultBaseUrl(provider: string, apiFormat: 'anthropic' | 'openai'): string | null {
  return PROVIDER_DEFAULT_BASE_URLS[provider]?.[apiFormat] ?? null;
}

export function providerRequiresApiKey(provider: string): boolean {
  return provider !== 'ollama';
}

function buildOpenAICompatibleChatCompletionsUrl(baseUrl: string, provider: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/chat/completions';
  if (normalized.endsWith('/chat/completions')) return normalized;
  const isGeminiLike = provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1') ? `${normalized.slice(0, -3)}v1beta` : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

function buildOpenAIResponsesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/responses';
  if (normalized.endsWith('/responses')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
}

function shouldUseOpenAIResponsesForProvider(provider: string): boolean {
  return provider === 'openai';
}

function shouldUseMaxCompletionTokensForOpenAI(provider: string, modelId?: string): boolean {
  if (provider !== 'openai') return false;
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return (
    resolvedModel.startsWith('gpt-5') ||
    resolvedModel.startsWith('o1') ||
    resolvedModel.startsWith('o3') ||
    resolvedModel.startsWith('o4')
  );
}

export interface ProviderConfigForTest {
  apiKey: string;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  models?: Array<{ id: string }>;
}

/**
 * Test connection for a given provider using the same logic as Settings > LLM.
 * Uses system config structure (config.providers[providerKey]).
 */
export async function testProviderConnection(
  providerKey: string,
  providerConfig: ProviderConfigForTest,
  i18n: { t: (key: string) => string }
): Promise<{ success: boolean; message: string }> {
  if (providerRequiresApiKey(providerKey) && !(providerConfig.apiKey ?? '').trim()) {
    return { success: false, message: i18n.t('apiKeyRequired') };
  }
  const firstModel = providerConfig.models?.[0];
  if (!firstModel) {
    return { success: false, message: i18n.t('noModelsConfigured') };
  }
  const normalizedBaseUrl = (providerConfig.baseUrl ?? '').trim().replace(/\/+$/, '');
  const useAnthropicFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat) === 'anthropic';

  try {
    let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
    if (useAnthropicFormat) {
      const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
        ? `${normalizedBaseUrl}/messages`
        : `${normalizedBaseUrl}/v1/messages`;
      response = await window.electron.api.fetch({
        url: anthropicUrl,
        method: 'POST',
        headers: {
          'x-api-key': providerConfig.apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: firstModel.id,
          max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
    } else {
      const useResponsesApi = shouldUseOpenAIResponsesForProvider(providerKey);
      const openaiUrl = useResponsesApi
        ? buildOpenAIResponsesUrl(normalizedBaseUrl)
        : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, providerKey);
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (providerConfig.apiKey) {
        headers.Authorization = `Bearer ${providerConfig.apiKey}`;
      }
      const openAIRequestBody: Record<string, unknown> = useResponsesApi
        ? {
            model: firstModel.id,
            input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }],
            max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
          }
        : {
            model: firstModel.id,
            messages: [{ role: 'user', content: 'Hi' }],
          };
      if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(providerKey, firstModel.id)) {
        openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
      } else if (!useResponsesApi) {
        openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
      }
      response = await window.electron.api.fetch({
        url: openaiUrl,
        method: 'POST',
        headers,
        body: JSON.stringify(openAIRequestBody),
      });
    }

    if (response.ok) {
      return { success: true, message: i18n.t('connectionSuccess') };
    }
    const data = (response as { data?: { error?: { message?: string }; message?: string } }).data ?? {};
    const errorMessage =
      data.error?.message || data.message || `${i18n.t('connectionFailed')}: ${(response as { status?: number }).status}`;
    if (
      typeof errorMessage === 'string' &&
      errorMessage.toLowerCase().includes('model output limit was reached')
    ) {
      return { success: true, message: i18n.t('connectionSuccess') };
    }
    return { success: false, message: errorMessage };
  } catch (err) {
    return {
      success: false,
      message: err instanceof Error ? err.message : i18n.t('connectionFailed'),
    };
  }
}
