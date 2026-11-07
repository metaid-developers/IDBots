/**
 * One-shot chat completion for Cognitive Orchestrator (Task 12.2).
 * Task 12.4: Native tools (function calling) support; returns content and/or tool_calls.
 * When llmId is provided (MetaBot's configured LLM), resolves that model's provider and config;
 * otherwise uses app default. Supports both OpenAI-compat (/v1/chat/completions) and
 * Anthropic (/v1/messages) APIs so that e.g. DeepSeek (anthropic format) works correctly.
 */

import { resolveApiConfigForModel, resolveSystemRescueBrain } from '../libs/claudeSettings';
import { clearCoworkSessionUpstream } from '../libs/coworkOpenAICompatProxy';
import { buildOpenCodeGoHeaders } from '../libs/opencodeGatewayHeaders';
import { effortForAnthropicWire, effortForOpenAiWire, type LlmEffortLevel } from '../libs/llmEffort';
import { budgetAssumesThinking, modelAlwaysThinks, thinkingWireFamily } from '../libs/modelThinking';
import { resolveOpenAiCompatContent } from '../libs/openAiCompatContent';
import { runWithSystemRescue, type BrainRescueInfo } from './llmFallback';
import { fetchLlmPost } from './llmFetch';

let oneShotPinCounter = 0;

/**
 * Throwaway upstream-pin key for one cognitive attempt. One-shot calls have no
 * cowork session, so without a pin they share the proxy's singleton upstream —
 * which ANY concurrent proxy-routed caller (dreams, memory hygiene, content
 * summaries in the same nightly window, another bot's consolidation) republishes
 * on its own configure step, forwarding this attempt to the WRONG provider
 * mid-flight (the 2026-09-03 deep-consolidation 400: a bot's request carrying
 * its glm-* brain model landed on a deepseek-only gateway). Each attempt pins
 * its upstream under this key and clears the pin when done.
 */
function nextOneShotPinKey(): string {
  oneShotPinCounter = (oneShotPinCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `oneshot-${Date.now().toString(36)}-${oneShotPinCounter}`;
}

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
  /** Provider response metadata used to explain empty completions without logging prompt/output data. */
  responseMetadata?: ChatCompletionResponseMetadata;
}

export interface ChatCompletionResponseMetadata {
  apiType: 'openai' | 'anthropic';
  stopReason?: string | null;
  contentBlockTypes?: string[];
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** Cache-read tokens (hit) reported by the provider, if available. */
  cacheReadTokens?: number;
  /** Cache-creation tokens (miss) reported by the provider, if available. */
  cacheCreationTokens?: number;
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

function resolveThinkingForModel(
  model: string,
  thinking: 'enabled' | 'disabled' | undefined,
): 'enabled' | 'disabled' | undefined {
  if (!thinking) return undefined;
  const normalized = model.trim().toLowerCase();
  const isDeepSeekThinkingModel = normalized.includes('deepseek')
    || /(?:^|[-_/])(?:v4-(?:pro|flash)|reasoner|r1)(?:$|[-_/])/.test(normalized);
  // GLM thinking-capable models (4.5+ and the 5.x line, incl. air/flash
  // variants) default to thinking ON when the field is absent. Honor the
  // caller's toggle so 'disabled' actually reaches the z.ai upstream instead
  // of silently burning the output budget — and the call timeout — on hidden
  // reasoning (the 2026-09-04 deep-consolidation timeout root cause).
  const isGlmThinkingModel = /glm-(?:4\.[5-9]|[5-9]\d*|\d{2,})(?:[.\-/]|$)/.test(normalized);
  return isDeepSeekThinkingModel || isGlmThinkingModel ? thinking : undefined;
}

/**
 * Whether the cognitive layer should call the DeepSeek Responses API for this
 * model. The Responses API serves the V4 family (flash and pro — pro GA
 * 2026-08-13); older variants fall back to chat/completions. See
 * https://api-docs.deepseek.com/zh-cn/guides/responses_api
 */
function shouldUseDeepSeekResponses(provider: string | undefined, model: string): boolean {
  if (provider?.toLowerCase() !== 'deepseek') {
    return false;
  }
  const normalized = model.toLowerCase();
  return normalized.includes('flash') || normalized.includes('pro');
}

/** Build the DeepSeek Responses endpoint URL (host root, no /v1 prefix). */
function buildDeepSeekResponsesURL(baseURL: string): string {
  const normalized = baseURL.trim().replace(/\/+$/, '');
  // Strip a trailing /anthropic or /v1 segment — the Responses endpoint lives
  // at the host root regardless of which compatibility path the user configured.
  const stripped = normalized.replace(/\/anthropic$/, '').replace(/\/v1$/, '');
  return `${stripped}/responses`;
}

/** Map an effort string to the DeepSeek Responses reasoning.effort value. */
function normalizeDeepSeekResponsesEffort(effort: string | undefined): 'low' | 'high' | 'max' {
  const normalized = (effort ?? '').trim().toLowerCase();
  if (normalized === 'max' || normalized === 'low') {
    return normalized;
  }
  // 'high' is the safe default; 'medium' maps to 'high'.
  return 'high';
}

/**
 * Reasoning object for the DeepSeek Responses API. The API defaults to
 * thinking ON (effort 'high') when `reasoning` is omitted, so 'disabled' must
 * be sent explicitly as { effort: 'none' } — omitting the field does NOT
 * disable thinking and lets the chain-of-thought consume the whole
 * max_output_tokens budget (status=incomplete with empty output).
 * Enabled/undefined stays at 'max' to match the project's DeepSeek-first
 * thinking-on policy. See https://api-docs.deepseek.com/zh-cn/guides/thinking_mode
 */
function resolveDeepSeekResponsesReasoning(
  thinking: 'enabled' | 'disabled' | undefined,
): { effort: 'none' | 'max' } {
  return thinking === 'disabled' ? { effort: 'none' } : { effort: 'max' };
}

/**
 * Default max output tokens for one-shot cognitive calls that do not pass
 * maxTokens. Thinking-mode reasoning shares the output budget, so a
 * thinking-enabled call needs far more headroom than a disabled one — a 2-4K
 * ceiling lets max-effort reasoning consume the whole budget and return
 * truncated or empty text (the 2026-08-08 dream-diary failure mode, elsewhere).
 * Thinking-on defaults to 32K (the app-wide ceiling); thinking-off stays at
 * 4K for compact JSON callers — but ONLY when the model can actually turn
 * thinking off. GLM-5.x always thinks, and unknown model families may default
 * to thinking with no known dialect to disable them (the 2026-09-20
 * dream-fragment `stop_reason=max_tokens; blocks=none` outage: a 4K
 * "thinking-off" ceiling plus a silently-dropped toggle burned the whole
 * budget on hidden reasoning). Ceilings only: billing is by actual tokens
 * used, so short replies cost the same as before.
 */
function resolveDefaultMaxOutputTokens(
  thinking: 'enabled' | 'disabled' | undefined,
  model?: string | null
): number {
  return budgetAssumesThinking(model, thinking) ? 32_768 : 4_096;
}

/**
 * Translate an Anthropic-wire thinking control for the target model. GLM-5.x
 * endpoints reject {type:'disabled'} outright (zhipu 400 code 1210 「该模型
 * 始终思考，不支持关闭思考」); the closest expressible intent is the low tier —
 * enabled with a small budget_tokens, clamped under the output ceiling
 * (Anthropic requires max_tokens > budget_tokens and budget_tokens >= 1024).
 */
function remapAnthropicThinkingForModel(
  thinking: { type: 'enabled' | 'disabled'; budget_tokens?: number },
  model: string,
  maxOutputTokens: number
): { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' } {
  if (thinking.type !== 'disabled' || !modelAlwaysThinks(model)) {
    return thinking;
  }
  const lowBudget = Math.min(4_000, Math.max(1_024, maxOutputTokens - 256));
  return { type: 'enabled', budget_tokens: lowBudget };
}

function extractAnthropicThinkingText(block: { type?: string; text?: string; thinking?: string }): string {
  if (block.type !== 'thinking' && block.type !== 'redacted_thinking') return '';
  return block.thinking || block.text || '';
}

/**
 * Whether an empty-text Anthropic-wire reply may fall back to its thinking
 * text as the answer content. For the GLM family it may not: GLM reasoning is
 * ALWAYS hidden thinking (GLM-5.x cannot turn thinking off — see
 * ./modelThinking), so a thinking-only reply means the output budget burned
 * inside reasoning before any text was emitted (truncation) and promoting it
 * can only ever leak a mid-thought fragment as the answer. This mirrors the
 * family guard the OpenAI-compat path already has in
 * libs/openAiCompatContent.ts (the 2026-10-23 ack-bubble leak); the Anthropic
 * path kept the unconditional promote-if-empty until the 2026-11-07 daily
 * report exposed the same leak class on this wire. DeepSeek keeps the
 * fallback: its dialect CAN park the final answer in thinking-only replies.
 */
export function allowThinkingFallbackPromotion(model: string | null | undefined): boolean {
  return thinkingWireFamily(model) !== 'glm';
}

/** Options for one chat completion request (with optional fallback LLM retry). */
export interface ChatCompletionOptions {
  llmId?: string | null;
  /** Provider key the primary brain model was picked from (id-collision disambiguation). */
  llmProvider?: string | null;
  /** Optional fallback brain: retried once when the primary resolution or call fails. */
  fallbackLlmId?: string | null;
  fallbackLlmProvider?: string | null;
  /**
   * Reasoning effort for the primary brain (off/low/high/max). Overrides the
   * binary thinking toggle: off disables thinking, any other step enables it
   * with the wire-appropriate strength.
   */
  effort?: LlmEffortLevel | null;
  /** Reasoning effort riding the fallback brain. */
  fallbackEffort?: LlmEffortLevel | null;
  tools?: OpenAITool[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
  /**
   * Built-in DeepSeek web_search injection on the Responses API path.
   * Defaults to enabled — the chat product behavior since the Responses
   * switch — but structured JSON tasks (memory consolidation, distillation,
   * classification) must pass false: a stray search call both delays the
   * reply and derails the model into prose analysis instead of the JSON
   * contract (the 2026-09-02 deep-consolidation "unparseable output" root
   * cause).
   */
  webSearch?: boolean;
  /**
   * Thinking-mode toggle. DeepSeek v4-pro enables thinking by default with
   * effort=high, which makes lightweight llm.complete calls (e.g. chess moves)
   * take minutes and hit timeouts. Client may opt out with 'disabled'.
   */
  thinking?: 'enabled' | 'disabled';
  /**
   * When true, a response with neither text content nor tool_calls throws
   * inside the fallback-wrapped attempt, so a configured fallback LLM gets
   * a chance instead of the empty result passing through as success.
   */
  throwOnEmptyContent?: boolean;
  /**
   * Per-attempt timeout in ms (see LlmFallbackCallOptions.attemptTimeoutMs):
   * the primary and the fallback attempt each get their own fresh window
   * instead of sharing one caller signal.
   */
  attemptTimeoutMs?: number;
  /**
   * Called after the system-rescue rung (llmFallback.runWithSystemRescue)
   * answers a call whose configured brains all failed terminally — passive
   * scenarios (private chat, group tasks) use it to surface the silent
   * provider switch to the owner.
   */
  onBrainRescue?: (info: BrainRescueInfo) => void;
}

/**
 * Chat completion with optional tools. Returns content and/or tool_calls.
 * Used by Cognitive Orchestrator for multi-turn tool loop (Task 12.4).
 * When options.fallbackLlmId is set (and differs from llmId), a failed primary
 * attempt (config resolution or API call) is retried once with the fallback.
 * When every configured brain fails TERMINALLY (quota/auth/config), one last
 * attempt rides the system rescue brain (first enabled, keyed, non-free
 * provider) so passive scenarios keep working for users who configured their
 * own provider but never wired it into the bot's brain settings.
 */
export async function chatCompletionWithTools(
  messages: ChatMessage[],
  options: ChatCompletionOptions = {}
): Promise<ChatCompletionResult> {
  return runWithSystemRescue(
    options,
    (attemptOptions) => chatCompletionSingleAttempt(messages, attemptOptions),
    {
      resolveRescue: (tried) => resolveSystemRescueBrain({
        excludeProviders: tried.map((route) => route.llmProvider),
      }),
      onRescue: (info) => {
        console.warn(
          `[Orchestrator] System rescue: brain '${info.fromLlmId ?? 'default'}'` +
          `${info.fromProvider ? ` (${info.fromProvider})` : ''} failed terminally (${info.kind}); ` +
          `answered via ${info.toLlmId} (${info.toProvider}).`
        );
        try {
          options.onBrainRescue?.(info);
        } catch { /* owner notification is best-effort and must never fail the call */ }
      },
    }
  );
}

/** Single chat completion attempt against the resolved config for options.llmId. */
async function chatCompletionSingleAttempt(
  messages: ChatMessage[],
  options: ChatCompletionOptions
): Promise<ChatCompletionResult> {
  // Pin this attempt's upstream in the proxy's per-session registry; the
  // resolved baseURL then carries the /s/<key> route (see claudeSettings).
  const pinKey = nextOneShotPinKey();
  try {
    const { config, error } = resolveApiConfigForModel(
      options.llmId ?? undefined,
      'local',
      pinKey,
      options.llmProvider ?? undefined,
    );
    if (error || !config) {
      throw new Error(error ?? 'LLM config not available');
    }

    const baseURL = config.baseURL?.trim();
    if (!baseURL) {
      throw new Error('LLM base URL not available');
    }

    const model = config.model || 'gpt-4o';
    const apiType = config.apiType ?? 'openai';
    // An explicit effort overrides the binary thinking toggle: off disables
    // thinking entirely, any other step enables it (the wire mappers below
    // translate the ladder into budget/effort parameters).
    const thinkingToggle: 'enabled' | 'disabled' | undefined = options.effort
      ? (options.effort === 'off' ? 'disabled' : 'enabled')
      : options.thinking;
    const thinking = resolveThinkingForModel(model, thinkingToggle);
    const effort = options.effort ?? null;
    const hasTools = Array.isArray(options.tools) && options.tools.length > 0;
    // DeepSeek flash models support the Responses API (with built-in web_search).
    // Route them there when we have the real upstream base URL; fall back to the
    // chat/completions or Anthropic path otherwise. Pro and non-flash stay on
    // chat/completions until DeepSeek enables Responses for them.
    const useDeepSeekResponses = shouldUseDeepSeekResponses(config.provider, model);
    if (process.env.NODE_ENV === 'development' || hasTools) {
      console.log(
        `[Orchestrator] LLM call: apiType=${apiType} baseURL=${maskBaseURL(baseURL)} model=${model} tools=${hasTools ? options.tools!.length : 0} responses=${useDeepSeekResponses}`
      );
    }

    try {
      let result: ChatCompletionResult;
      if (useDeepSeekResponses && config.upstreamBaseURL) {
        result = await callDeepSeekResponsesStyle(
          config.upstreamBaseURL,
          model,
          config.apiKey ?? '',
          messages,
          options.tools,
          options.signal,
          options.maxTokens,
          options.temperature,
          thinking,
          effort,
          options.webSearch
        );
      } else if (apiType === 'anthropic') {
        result = await callAnthropicStyleWithTools(
          baseURL,
          model,
          config.apiKey ?? '',
          messages,
          options.tools,
          options.signal,
          options.maxTokens,
          options.temperature,
          thinking,
          effort
        );
      } else {
        result = await callOpenAIStyleWithTools(
          baseURL,
          model,
          config.apiKey ?? '',
          messages,
          options.tools,
          options.signal,
          options.maxTokens,
          options.temperature,
          thinking,
          effort
        );
      }
      if (options.throwOnEmptyContent && !result.content?.trim() && !result.tool_calls?.length) {
        const emptyError = new Error(formatEmptyCompletionError(result.responseMetadata));
        // 让上层（botBrowserBridgeService.completeLlm）能把「空回复」从 llm_unavailable 里区分出来。
        emptyError.name = 'EmptyCompletion';
        throw emptyError;
      }
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[Orchestrator] chatCompletionWithTools failed:', msg);
      throw err;
    }
  } finally {
    clearCoworkSessionUpstream(pinKey);
  }
}

/**
 * One-shot completion for backward compatibility. When tools are not used,
 * returns only the reply text. For tool loop use chatCompletionWithTools.
 */
export async function performChatCompletionForOrchestrator(
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options: {
    signal?: AbortSignal;
    maxTokens?: number;
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    effort?: LlmEffortLevel | null;
    fallbackEffort?: LlmEffortLevel | null;
    llmProvider?: string | null;
    throwOnEmptyContent?: boolean;
    thinking?: 'enabled' | 'disabled';
    /** See ChatCompletionOptions.webSearch — pass false for structured JSON tasks. */
    webSearch?: boolean;
    /** Per-attempt timeout in ms; primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
    /** Called after the system-rescue rung answers a terminally-failed call. */
    onBrainRescue?: (info: BrainRescueInfo) => void;
  } = {}
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
  const result = await chatCompletionWithTools(messages, {
    llmId,
    llmProvider: options.llmProvider,
    fallbackLlmId: options.fallbackLlmId,
    fallbackLlmProvider: options.fallbackLlmProvider,
    effort: options.effort,
    fallbackEffort: options.fallbackEffort,
    signal: options.signal,
    maxTokens: options.maxTokens,
    throwOnEmptyContent: options.throwOnEmptyContent,
    thinking: options.thinking,
    webSearch: options.webSearch,
    attemptTimeoutMs: options.attemptTimeoutMs,
    onBrainRescue: options.onBrainRescue,
  });
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
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled',
  effort?: LlmEffortLevel | null
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
    max_tokens: maxTokens ?? resolveDefaultMaxOutputTokens(thinking, model),
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
  if (temperature !== undefined) body.temperature = temperature;
  if (effort) {
    // Model-level brain effort: the ladder maps onto thinking + budget_tokens
    // (off disables; low/high/max enable with tiered budgets).
    const mapped = effortForAnthropicWire(effort);
    if (mapped.thinking) {
      body.thinking = remapAnthropicThinkingForModel(
        mapped.thinking,
        model,
        maxTokens ?? resolveDefaultMaxOutputTokens(thinking, model)
      );
    }
  } else if (thinking !== undefined) {
    // DeepSeek Anthropic 格式支持 thinking toggle（默认 enabled，effort=high）。
    // 轻量 llm.complete 调用（如下棋走子）显式 disabled 可避免长思考与超时。
    body.thinking = remapAnthropicThinkingForModel(
      thinking === 'disabled' ? { type: 'disabled' as const } : { type: 'enabled' as const },
      model,
      maxTokens ?? resolveDefaultMaxOutputTokens(thinking, model)
    );
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim();
  }
  Object.assign(headers, buildOpenCodeGoHeaders(url));

  const response = await fetchLlmPost('anthropic', url, headers, JSON.stringify(body), signal);
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM Anthropic error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  let data: {
    content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM Anthropic invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const contentBlocks = data.content ?? [];
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'anthropic',
      stopReason: data.stop_reason ?? null,
      contentBlockTypes: contentBlocks.map((block) => block.type ?? 'unknown'),
      inputTokens: data.usage?.input_tokens ?? null,
      outputTokens: data.usage?.output_tokens ?? null,
    },
  };
  const toolCalls: ToolCallResult[] = [];
  let thinkingText = '';
  for (const block of contentBlocks) {
    if (block.type === 'text' && block.text) {
      out.content = (out.content ?? '') + block.text;
    } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      // DeepSeek thinking 等模型把推理放 thinking 块、text 可能为空；先收着做回退。
      thinkingText += extractAnthropicThinkingText(block);
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
  if (!out.content && thinkingText.trim() && allowThinkingFallbackPromotion(model)) {
    // 没有 text 块时回退到 thinking 文本，避免上层把「空 content」误判为 llm_unavailable。
    // （browser.llm.complete / 象棋走子：LLM 答案可能只在推理里，解析层能从中提取合法着法。）
    // GLM 家族不回退（allowThinkingFallbackPromotion）：thinking-only 意味着预算耗在
    // 隐藏推理里，提升只会把思维碎片当答案泄露（2026-10-23 ack 气泡 / 2026-11-07 日报）。
    out.content = thinkingText.trim();
    out.responseMetadata.contentBlockTypes = [
      ...(out.responseMetadata.contentBlockTypes ?? []),
      'reasoning-fallback',
    ];
  }
  if (toolCalls.length) out.tool_calls = toolCalls;
  return out;
}

export const __cognitiveChatCompletionTestUtils = {
  resolveThinkingForModel,
  extractAnthropicThinkingText,
  shouldUseDeepSeekResponses,
  buildDeepSeekResponsesURL,
  buildDeepSeekResponsesTools,
  normalizeDeepSeekResponsesEffort,
  resolveDeepSeekResponsesReasoning,
  resolveDefaultMaxOutputTokens,
  remapAnthropicThinkingForModel,
  allowThinkingFallbackPromotion,
};

/**
 * OpenAI-style API with tools. Returns content and/or tool_calls from response.
 */
async function callOpenAIStyleWithTools(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled',
  effort?: LlmEffortLevel | null
): Promise<ChatCompletionResult> {
  const url = `${baseURL.replace(/\/+$/, '')}/v1/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages: toOpenAIMessages(messages),
    max_tokens: maxTokens ?? resolveDefaultMaxOutputTokens(thinking, model),
  };
  if (Array.isArray(tools) && tools.length > 0) {
    body.tools = tools;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (effort) {
    // Model-level brain effort: reasoning_effort on the OpenAI wire (max caps
    // at high) plus the DeepSeek thinking toggle for relays honoring it.
    const reasoningEffort = effortForOpenAiWire(effort);
    if (reasoningEffort) body.reasoning_effort = reasoningEffort;
    // GLM-5.x chat endpoints reject thinking:{type:'disabled'} (400 code
    // 1210) — omit the toggle for always-thinking models and let the
    // thinking-aware output budget carry the headroom instead.
    if (!(effort === 'off' && modelAlwaysThinks(model))) {
      body.thinking = { type: effort === 'off' ? 'disabled' : 'enabled' };
    }
  } else if (thinking !== undefined) {
    // DeepSeek OpenAI 兼容格式同样支持 thinking toggle。
    if (!(thinking === 'disabled' && modelAlwaysThinks(model))) {
      body.thinking = { type: thinking };
    }
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  Object.assign(headers, buildOpenCodeGoHeaders(url));

  const response = await fetchLlmPost('openai-compat', url, headers, JSON.stringify(body), signal);
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] LLM OpenAI-compat error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  type ChoiceMessage = {
    content?: string | null;
    reasoning_content?: string | null;
    reasoning?: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: { name: string; arguments: string };
    }>;
  };
  let data: {
    choices?: Array<{ finish_reason?: string | null; message?: ChoiceMessage }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] LLM OpenAI-compat invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const msg = data.choices?.[0]?.message;
  // Family-aware content resolution (../libs/openAiCompatContent): the
  // DeepSeek dialect can park the final answer in reasoning_content with
  // content empty, so the fallback promotion stays there; GLM
  // reasoning_content is ALWAYS hidden thinking (GLM-5.x cannot turn it
  // off), so promoting it can only leak reasoning as the answer — the
  // 2026-10-23 ack-bubble leak, where a mid-thought English analysis
  // fragment shipped as the ack. Unknown families keep the historical
  // promote-if-empty behavior. 'reasoning' in contentBlockTypes still
  // reports thinking-only replies even when not promoted, so consumers
  // like the turn-ack guard can detect and drop them.
  const resolved = resolveOpenAiCompatContent(model, msg);
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'openai',
      stopReason: data.choices?.[0]?.finish_reason ?? null,
      contentBlockTypes: [
        ...resolved.contentBlockTypes,
        ...(msg?.tool_calls?.length ? ['tool_calls'] : []),
      ],
      inputTokens: data.usage?.prompt_tokens ?? null,
      outputTokens: data.usage?.completion_tokens ?? null,
    },
  };
  if (resolved.content) {
    out.content = resolved.content;
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

/**
 * Tools array for the DeepSeek Responses path: the server-side web_search
 * tool first (stable across turns for cache) unless the caller opted out,
 * then any caller-supplied function tools. Returns an empty array when the
 * caller opted out and passed no tools — in that case the request body
 * should omit `tools` entirely.
 */
export function buildDeepSeekResponsesTools(
  tools?: OpenAITool[],
  webSearch?: boolean
): Array<Record<string, unknown>> {
  const responseTools: Array<Record<string, unknown>> = [];
  if (webSearch !== false) {
    responseTools.push({ type: 'web_search' });
  }
  if (Array.isArray(tools)) {
    for (const t of tools) {
      responseTools.push({ type: 'function', name: t.function.name, parameters: t.function.parameters ?? {} });
    }
  }
  return responseTools;
}

/**
 * DeepSeek Responses API (/responses) call with optional tools.
 *
 * Unlike chat/completions, the Responses API takes `instructions` (system) and
 * `input` (conversation), and supports a server-side `web_search` tool. It is
 * stateless on DeepSeek, so the full history is sent every turn — which also
 * maximizes DeepSeek's automatic context-cache hit rate.
 *
 * Response cache tokens come nested under input_tokens_details.cached_tokens
 * (distinct from chat/completions' top-level prompt_cache_hit_tokens).
 */
async function callDeepSeekResponsesStyle(
  baseURL: string,
  model: string,
  apiKey: string,
  messages: ChatMessage[],
  tools?: OpenAITool[],
  signal?: AbortSignal,
  maxTokens?: number,
  temperature?: number,
  thinking?: 'enabled' | 'disabled',
  effort?: LlmEffortLevel | null,
  webSearch?: boolean
): Promise<ChatCompletionResult> {
  const url = buildDeepSeekResponsesURL(baseURL);
  const instructions: string[] = [];
  const input: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    if (m.role === 'system' && m.content) {
      instructions.push(m.content);
      continue;
    }
    if (m.role === 'user' || m.role === 'assistant') {
      const parts: Array<Record<string, unknown>> = [];
      if (m.content) {
        parts.push({ type: m.role === 'user' ? 'input_text' : 'output_text', text: m.content });
      }
      if (m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments || '{}',
          });
        }
      }
      if (parts.length > 0) {
        input.push({ role: m.role, content: parts });
      }
      continue;
    }
    if (m.role === 'tool' && m.tool_call_id) {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: m.content ?? '',
      });
    }
  }

  // Tools: web_search first (server-side, stable across turns for cache) —
  // injected by default for the chat experience, opt out with webSearch:false —
  // then any caller-supplied function tools.
  const responseTools = buildDeepSeekResponsesTools(tools, webSearch);

  const body: Record<string, unknown> = {
    model,
    input,
  };
  if (responseTools.length > 0) {
    body.tools = responseTools;
    body.tool_choice = 'auto';
  }
  if (instructions.length > 0) {
    body.instructions = instructions.join('\n\n');
  }
  body.max_output_tokens = maxTokens ?? resolveDefaultMaxOutputTokens(thinking, model);
  if (temperature !== undefined) {
    body.temperature = temperature;
  }
  // Reasoning effort: 'disabled' must be explicit ({ effort: 'none' }) — an
  // omitted field means thinking stays ON. See resolveDeepSeekResponsesReasoning.
  // Model-level brain effort rides the Responses reasoning ladder directly
  // (off → none); without an explicit effort the thinking toggle maps as before.
  body.reasoning = effort
    ? { effort: effort === 'off' ? 'none' : effort }
    : resolveDeepSeekResponsesReasoning(thinking);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey.trim()) {
    headers.Authorization = `Bearer ${apiKey.trim()}`;
  }
  Object.assign(headers, buildOpenCodeGoHeaders(url));

  const response = await fetchLlmPost('deepseek-responses', url, headers, JSON.stringify(body), signal);
  const text = await response.text();
  if (!response.ok) {
    console.error('[Orchestrator] DeepSeek Responses error:', response.status, text.slice(0, 500));
    throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
  }

  type ResponsesOutputItem = {
    type?: string;
    content?: Array<{ type?: string; text?: string }>;
    summary?: Array<{ text?: string }>;
    call_id?: string;
    id?: string;
    name?: string;
    arguments?: string;
  };
  let data: {
    id?: string;
    model?: string;
    status?: string;
    output?: ResponsesOutputItem[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  try {
    data = JSON.parse(text) as typeof data;
  } catch {
    console.error('[Orchestrator] DeepSeek Responses invalid JSON:', text.slice(0, 300));
    throw new Error('LLM response was not valid JSON');
  }

  const outputItems = data.output ?? [];
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'openai',
      stopReason: data.status === 'incomplete' ? 'length' : 'stop',
      contentBlockTypes: [],
    },
  };
  const toolCalls: ToolCallResult[] = [];
  let hasWebSearch = false;

  for (const item of outputItems) {
    const itemType = item.type;
    if (itemType === 'message') {
      for (const part of item.content ?? []) {
        if ((part.type === 'output_text' || part.type === 'text') && part.text) {
          out.content = (out.content ?? '') + part.text;
          out.responseMetadata.contentBlockTypes!.push('text');
        }
      }
    } else if (itemType === 'reasoning') {
      const reasoningText = (item.summary ?? []).map((s) => s.text ?? '').join('');
      if (reasoningText && !out.content) {
        // Fallback: if only reasoning is present, surface it (matches chat/completions behavior).
        out.content = reasoningText.trim();
        out.responseMetadata.contentBlockTypes!.push('reasoning');
      }
    } else if (itemType === 'web_search_call') {
      hasWebSearch = true;
    } else if (itemType === 'function_call' && (item.call_id || item.id) && item.name) {
      toolCalls.push({
        id: item.call_id || item.id || '',
        name: item.name,
        arguments: item.arguments || '{}',
      });
    }
  }

  if (hasWebSearch) {
    out.responseMetadata.contentBlockTypes!.push('web_search');
  }
  if (out.content) {
    out.content = out.content.trim();
  }
  if (toolCalls.length) {
    out.tool_calls = toolCalls;
    out.responseMetadata.contentBlockTypes!.push('tool_calls');
  }

  // Cache + token accounting from the nested Responses usage shape.
  const promptTokens = data.usage?.input_tokens ?? null;
  const completionTokens = data.usage?.output_tokens ?? null;
  out.responseMetadata.inputTokens = promptTokens;
  out.responseMetadata.outputTokens = completionTokens;
  if (promptTokens != null) {
    const cached = data.usage?.input_tokens_details?.cached_tokens ?? 0;
    // Stash cache fields on metadata for the usage accumulator; cognitive-layer
    // results don't have a dedicated cache field yet, so we encode it here for
    // future wiring into the usage stats pipeline.
    out.responseMetadata.cacheReadTokens = cached;
    out.responseMetadata.cacheCreationTokens = Math.max(promptTokens - cached, 0);
  }

  return out;
}

function formatEmptyCompletionError(metadata?: ChatCompletionResponseMetadata): string {
  if (!metadata) return 'LLM returned empty content';
  const details = [
    metadata.stopReason ? `stop_reason=${metadata.stopReason}` : null,
    metadata.contentBlockTypes?.length ? `blocks=${metadata.contentBlockTypes.join(',')}` : 'blocks=none',
    metadata.outputTokens != null ? `output_tokens=${metadata.outputTokens}` : null,
  ].filter(Boolean);
  return `LLM returned no text (${details.join('; ')})`;
}