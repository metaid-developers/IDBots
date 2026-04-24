import type { ModelOptions } from '../config';

export function buildOpenAICompatibleModelRequestOptions(
  provider: string,
  options?: ModelOptions,
): Record<string, unknown> {
  if (provider !== 'deepseek' || !options) {
    return {};
  }

  const requestOptions: Record<string, unknown> = {};
  if (options.reasoningEffort) {
    requestOptions.reasoning_effort = options.reasoningEffort;
  }
  if (options.thinking) {
    requestOptions.thinking = { ...options.thinking };
  }
  return requestOptions;
}

export function buildAnthropicModelRequestOptions(
  provider: string,
  options?: ModelOptions,
): Record<string, unknown> {
  if (provider !== 'deepseek' || !options?.reasoningEffort) {
    return {};
  }

  return {
    output_config: {
      effort: options.reasoningEffort,
    },
  };
}
