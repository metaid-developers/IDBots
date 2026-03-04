/**
 * One-shot chat completion for Cognitive Orchestrator (Task 12.2).
 * When llmId is provided (MetaBot's configured LLM), resolves that model's provider and config;
 * otherwise uses app default. Supports both OpenAI-compat (/v1/chat/completions) and
 * Anthropic (/v1/messages) APIs so that e.g. DeepSeek (anthropic format) works correctly.
 */

import { resolveApiConfigForModel } from '../libs/claudeSettings';

/** Mask baseURL for logs (keep scheme + host, hide path/auth). */
function maskBaseURL(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid URL)';
  }
}

export async function performChatCompletionForOrchestrator(
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null
): Promise<string> {
  const { config, error } = resolveApiConfigForModel(llmId ?? undefined);
  if (error || !config) {
    throw new Error(error ?? 'LLM config not available');
  }

  const baseURL = config.baseURL?.trim();
  if (!baseURL) {
    throw new Error('LLM base URL not available');
  }

  const model = config.model || 'gpt-4o';
  const apiType = config.apiType ?? 'openai';
  console.log(
    `[Orchestrator] LLM call: apiType=${apiType} baseURL=${maskBaseURL(baseURL)} model=${model}`
  );

  if (apiType === 'anthropic') {
    return callAnthropicStyle(baseURL, model, config.apiKey ?? '', systemPrompt, userMessage);
  }

  return callOpenAIStyle(baseURL, model, config.apiKey ?? '', systemPrompt, userMessage);
}

/**
 * Anthropic-style API: POST /v1/messages, body has model, max_tokens, messages, system.
 * Used by DeepSeek and other Anthropic-compat providers.
 */
async function callAnthropicStyle(
  baseURL: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`;
  const body = {
    model,
    max_tokens: 2048,
    messages: [{ role: 'user' as const, content: userMessage }],
    system: systemPrompt,
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim();
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM Anthropic error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  let data: { content?: Array<{ type?: string; text?: string }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM Anthropic invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const content = data.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((block) => block.type === 'text' && block.text)
      .map((block) => (block as { text: string }).text);
    return parts.join('').trim();
  }
  const single = (content as unknown as { text?: string })?.text;
  return (single ?? '').trim();
}

/**
 * OpenAI-style API: POST /v1/chat/completions, body has model, messages, max_tokens.
 */
async function callOpenAIStyle(
  baseURL: string,
  model: string,
  apiKey: string,
  systemPrompt: string,
  userMessage: string
): Promise<string> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/chat/completions`;
  const body = {
    model,
    messages: [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: userMessage },
    ],
    max_tokens: 2048,
  };

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }

  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });

  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM OpenAI-compat error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM OpenAI-compat invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const content = data.choices?.[0]?.message?.content ?? '';
  return content.trim();
}
