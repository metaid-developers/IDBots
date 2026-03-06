/**
 * One-shot chat completion for Cognitive Orchestrator (Task 12.2).
 * Task 12.4: Native tools (function calling) support; returns content and/or tool_calls.
 * When llmId is provided (MetaBot's configured LLM), resolves that model's provider and config;
 * otherwise uses app default. Supports both OpenAI-compat (/v1/chat/completions) and
 * Anthropic (/v1/messages) APIs so that e.g. DeepSeek (anthropic format) works correctly.
 */

import { resolveApiConfigForModel } from '../libs/claudeSettings';

/** OpenAI-style tool definition for function calling. */
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

/** Single tool call from LLM response. */
export interface ToolCallResult {
  id: string;
  name: string;
  arguments: string;
}

/** Chat completion result: content and/or tool_calls. */
export interface ChatCompletionResult {
  content?: string;
  tool_calls?: ToolCallResult[];
}

/** Message for chat completion (OpenAI-style). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

/** Mask baseURL for logs (keep scheme + host, hide path/auth). */
function maskBaseURL(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '(invalid URL)';
  }
}

/**
 * Chat completion with optional tools. Returns content and/or tool_calls.
 * Used by Cognitive Orchestrator for multi-turn tool loop (Task 12.4).
 */
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  options: { llmId?: string | null; tools?: OpenAITool[] } = {}
): Promise<ChatCompletionResult> {
  const { config, error } = resolveApiConfigForModel(options.llmId ?? undefined);
  if (error || !config) {
    throw new Error(error ?? 'LLM config not available');
  }

  const baseURL = config.baseURL?.trim();
  if (!baseURL) {
    throw new Error('LLM base URL not available');
  }

  const model = config.model || 'gpt-4o';
  const apiType = config.apiType ?? 'openai';
  const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
  if (process.env.NODE_ENV === 'development' || hasTools) {
    console.log(
      `[Orchestrator] LLM call: apiType=${apiType} baseURL=${maskBaseURL(baseURL)} model=${model} tools=${hasTools ? options.tools!.length : 0}`
    );
  }

  try {
    if (apiType === 'anthropic') {
      return await callAnthropicStyleWithTools(
        baseURL,
        model,
        config.apiKey ?? '',
        messages,
        options.tools
      );
    }
    return await callOpenAIStyleWithTools(
      baseURL,
      model,
      config.apiKey ?? '',
      messages,
      options.tools
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[Orchestrator] chatCompletionWithTools failed:', msg);
    throw err;
  }
}

/**
 * One-shot completion for backward compatibility. When tools are not used,
 * returns only the reply text. For tool loop use chatCompletionWithTools.
 */
export async function performChatCompletionForOrchestrator(
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const result = await chatCompletionWithTools(messages, { llmId });
  const content = result.content?.trim() ?? '';
  if (result.tool_calls?.length) {
    console.warn('[Orchestrator] performChatCompletionForOrchestrator: LLM returned tool_calls but no tools were requested; ignoring tool_calls');
  }
  return content;
}

/**
 * Build OpenAI request body messages from ChatMessage[] (strip tool_call_id/name for initial send).
 */
function toOpenAIMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    const msg: Record<string, unknown> = { role: m.role };
    if (m.role === 'tool') {
      msg.content = m.content ?? '';
      msg.tool_call_id = m.tool_call_id ?? '';
    } else if (m.content !== undefined) {
      msg.content = m.content;
    }
    if (m.tool_calls?.length) {
      msg.tool_calls = m.tool_calls;
    }
    return msg;
  });
}

/**
 * Anthropic-style API with optional tools. Returns content and tool_use blocks as tool_calls.
 */
async function callAnthropicStyleWithTools(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[]
): Promise<ChatCompletionResult> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/messages`;
  const systemParts: string[] = [];
  const anthropicMessages: Array<{ role: string; content: unknown }> = [];

  for (const m of messages) {
    if (m.role === 'system' && m.content) {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === 'user') {
      anthropicMessages.push({ role: 'user', content: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      const content: unknown[] = m.content ? [{ type: 'text', text: m.content }] : [];
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments || '{}') : tc.function.arguments,
          });
        }
      }
      if (content.length) anthropicMessages.push({ role: 'assistant', content });
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      anthropicMessages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }],
      });
    }
  }

  const body: Record<string, unknown> = {
    model,
    max_tokens: 2048,
    messages: anthropicMessages,
    system: systemParts.join('\n\n'),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description ?? '',
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

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

  let data: { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: string }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM Anthropic invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const out: ChatCompletionResult = {};
  const contentBlocks = data.content ?? [];
  const toolCalls: ToolCallResult[] = [];
  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text) {
      out.content = (out.content ?? '') + block.text;
    }
    if (block.type === 'tool_use' && block.id && block.name) {
      const args =
        typeof (block as { input?: unknown }).input === 'string'
          ? (block as { input: string }).input
          : JSON.stringify((block as { input?: unknown }).input ?? {});
      toolCalls.push({ id: block.id, name: block.name, arguments: args });
    }
  }
  if (out.content) out.content = out.content.trim();
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

/**
 * OpenAI-style API with tools. Returns content and/or tool_calls from response.
 */
async function callOpenAIStyleWithTools(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[]
): Promise<ChatCompletionResult> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(messages),
    max_tokens: 2048,
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }

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

  type ChoiceMessage = {
    content?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  let data: { choices?: Array<{ message?: ChoiceMessage }> };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM OpenAI-compat invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const msg = data.choices?.[0]?.message;
  const out: ChatCompletionResult = {};
  if (msg?.content) {
    out.content = String(msg.content).trim();
  }
  if (msg?.tool_calls?.length) {
    out.tool_calls = msg.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function?.name ?? '',
      arguments: typeof tc.function?.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function?.arguments ?? {}),
    }));
  }
  return out;
}
