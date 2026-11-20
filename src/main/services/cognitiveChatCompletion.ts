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
   * What attemptTimeoutMs bounds for the streaming transport:
   *  - 'total' (default): wall-clock budget for the whole attempt — exactly
   *    the pre-streaming semantics. Callers that use attemptTimeoutMs as a
   *    wall-budget clamp (dream: min(ladder, remaining run budget) with no
   *    caller signal) keep this so an attempt can never outlive the value.
   *  - 'idle': no-progress budget — the attempt aborts when the SSE stream
   *    carries no bytes for this long, and the total budget grows to
   *    min(idle×8, 600s) (never below the idle value) so a steadily flowing
   *    long generation finishes instead of being cut (the 2026-11-20 ABS
   *    relay handoff: glm non-stream avg 45.6s against 45-60s total caps).
   */
  attemptTimeoutKind?: 'total' | 'idle';
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
    {
      ...options,
      // The per-attempt deadline (caller signal + total cap + streaming idle
      // watchdog) is built inside chatCompletionSingleAttempt from
      // attemptTimeoutMs; llmFallback must not double-wrap the caller signal
      // with AbortSignal.timeout, which would re-impose the old total-only
      // semantics on the streaming transport.
      streamingTransport: true,
    },
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

    // Per-attempt deadline: caller cancellation + total cap + (streaming
    // branch only) the idle watchdog. Built here — not by
    // llmFallback.withPerAttemptSignal, which skips when streamingTransport
    // is set — so all three wire styles share one deadline and the idle
    // semantics never leak into the non-streaming ones.
    const attemptDeadline = buildOneShotAttemptDeadline(
      resolveOneShotStreamDeadline(options),
      options.signal
    );
    try {
      let result: ChatCompletionResult;
      if (useDeepSeekResponses && config.upstreamBaseURL) {
        result = await callDeepSeekResponsesStyle(
          config.upstreamBaseURL,
          model,
          config.apiKey ?? '',
          messages,
          options.tools,
          attemptDeadline.signal,
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
          attemptDeadline.signal,
          options.maxTokens,
          options.temperature,
          thinking,
          effort,
          { streaming: ONE_SHOT_STREAMING_ENABLED, deadline: attemptDeadline }
        );
      } else {
        result = await callOpenAIStyleWithTools(
          baseURL,
          model,
          config.apiKey ?? '',
          messages,
          options.tools,
          attemptDeadline.signal,
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
    } finally {
      attemptDeadline.cleanup();
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
    /** See ChatCompletionOptions.attemptTimeoutKind — what attemptTimeoutMs bounds. */
    attemptTimeoutKind?: 'total' | 'idle';
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
    attemptTimeoutKind: options.attemptTimeoutKind,
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

// ── Streaming transport (2026-11-20 ABS relay handoff) ─────────────────────
// One-shot calls historically sent no `stream` field, so the upstream relay
// generated the ENTIRE reply before the first byte reached us (glm-5.3-flash
// non-stream avg 45.6s, max 952s) and per-caller total caps (45-60s) cut the
// long tail — the relay logged those cuts as client_gone (96.7% of its
// apparent failures). The transport now requests `stream: true` on the
// Anthropic wire — which covers BOTH real Anthropic upstreams and every
// openai-format provider via the local OpenAI-compat proxy, whose SSE
// passthrough is the same path kernel sessions already stream on — and
// re-arms an idle watchdog on every arriving chunk. Bytes flowing = progress,
// so a long generation survives as long as the upstream keeps answering; the
// relay's 15s SSE heartbeat (`: ping` comment frames, ignored per the SSE
// spec) keeps healthy streams alive so they are never cut mid-generation.

/** Kill switch: IDBOTS_ONESHOT_NONSTREAM=1 restores the pre-streaming transport. */
const ONE_SHOT_STREAMING_ENABLED = process.env.IDBOTS_ONESHOT_NONSTREAM !== '1';

/** Idle budget when a caller passes no attemptTimeoutMs: such callers
 *  previously waited unbounded on a hung request; a silent stream now aborts
 *  into the fallback attempt (relay heartbeats keep healthy streams alive). */
const DEFAULT_ONE_SHOT_STREAM_IDLE_MS = 120_000;

/** Total-budget ceiling for attemptTimeoutKind:'idle' attempts — bounds the
 *  pathological "heartbeats keep flowing, no data" case without shrinking any
 *  caller's existing window (a value at or above the ceiling keeps itself). */
const ONE_SHOT_STREAM_TOTAL_CEILING_MS = 600_000;

interface OneShotStreamDeadline {
  /** Abort when the SSE stream is silent for this long (re-armed per chunk). */
  idleMs: number;
  /** Wall-clock cap for the whole attempt; null = unbounded (caller signal governs). */
  totalMs: number | null;
}

function resolveOneShotStreamDeadline(options: ChatCompletionOptions): OneShotStreamDeadline {
  const idleMs = options.attemptTimeoutMs && options.attemptTimeoutMs > 0
    ? options.attemptTimeoutMs
    : DEFAULT_ONE_SHOT_STREAM_IDLE_MS;
  if ((options.attemptTimeoutKind ?? 'total') === 'total') {
    return {
      idleMs,
      totalMs: options.attemptTimeoutMs && options.attemptTimeoutMs > 0 ? options.attemptTimeoutMs : null,
    };
  }
  return {
    idleMs,
    totalMs: Math.max(idleMs, Math.min(idleMs * 8, ONE_SHOT_STREAM_TOTAL_CEILING_MS)),
  };
}

/** Timeout-flavored abort reason so downstream classification sees the same
 *  TimeoutError name AbortSignal.timeout produced before this transport. */
function streamDeadlineError(kind: 'idle' | 'total', ms: number): DOMException {
  const label = kind === 'idle' ? 'LLM stream idle timeout' : 'LLM stream deadline exceeded';
  return new DOMException(`${label} after ${Math.round(ms / 1000)}s`, 'TimeoutError');
}

/** Per-attempt deadline shared by all three wire styles. The total timer
 *  mirrors the old AbortSignal.timeout semantics; the idle watchdog arms
 *  only in the streaming SSE reader (re-armed per arriving chunk), so the
 *  non-streaming styles keep exactly their pre-streaming behavior. */
interface OneShotAttemptDeadline {
  signal: AbortSignal;
  /** Arm the idle watchdog once before the fetch (covers time-to-first-byte). */
  enableIdle(): void;
  /** Re-arm the idle watchdog; no-op until enableIdle. */
  armIdle(): void;
  cleanup(): void;
}

function buildOneShotAttemptDeadline(
  deadline: OneShotStreamDeadline,
  callerSignal: AbortSignal | undefined
): OneShotAttemptDeadline {
  const controller = new AbortController();
  let idleEnabled = false;
  let idleTimer: NodeJS.Timeout | null = null;
  const armIdle = () => {
    if (!idleEnabled) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(
      () => controller.abort(streamDeadlineError('idle', deadline.idleMs)),
      deadline.idleMs
    );
    idleTimer.unref?.();
  };
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
  }
  const totalTimer = deadline.totalMs != null
    ? setTimeout(() => controller.abort(streamDeadlineError('total', deadline.totalMs as number)), deadline.totalMs)
    : null;
  totalTimer?.unref?.();
  return {
    signal: controller.signal,
    enableIdle: () => {
      idleEnabled = true;
      armIdle();
    },
    armIdle,
    cleanup: () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (totalTimer) clearTimeout(totalTimer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    },
  };
}

/** Shape shared by the non-streaming JSON body and the folded SSE stream, so
 *  one assembly path serves both transports. */
interface AnthropicWireShaped {
  content?: Array<{ type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown }>;
  stop_reason?: string | null;
  usage?: { input_tokens?: number; output_tokens?: number };
}

/**
 * Anthropic-style API with optional tools. Returns content and tool_use blocks as tool_calls.
 */
/** Fold an Anthropic-wire SSE stream (real Anthropic upstream, or the local
 *  OpenAI-compat proxy's stream conversion of an OpenAI-format upstream) into
 *  the same shape the non-streaming JSON body has. Comment frames — the
 *  relay's 15s `: ping` keep-alive heartbeat — are ignored per the SSE spec,
 *  and every arriving byte re-arms the idle watchdog. */
async function readAnthropicSseCompletion(
  response: Response,
  transport: { deadline: OneShotAttemptDeadline }
): Promise<AnthropicWireShaped> {
  const deadline = transport.deadline;
  if (!response.body) {
    throw new Error('LLM stream returned an empty body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const textByIndex = new Map<number, string>();
  const thinkingByIndex = new Map<number, string>();
  const toolByIndex = new Map<number, { id: string; name: string; json: string }>();
  let stopReason: string | null = null;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawEvent = false;
  let sawTerminal = false;
  let buffer = '';

  type SsePayload = Record<string, unknown>;
  const applyEvent = (rawEvent: string): void => {
    let eventName = '';
    const dataLines: string[] = [];
    for (const line of rawEvent.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue; // comment/heartbeat frame
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).trimStart());
    }
    if (dataLines.length === 0) return;
    sawEvent = true;
    const dataText = dataLines.join('\n');
    if (dataText === '[DONE]') return; // OpenAI-style sentinel; not on the Anthropic wire
    let payload: SsePayload;
    try {
      payload = JSON.parse(dataText) as SsePayload;
    } catch {
      return; // malformed frame — later frames carry the stream state
    }
    const type = typeof payload.type === 'string' && payload.type ? payload.type : eventName;
    if (type === 'message_start') {
      const usage = (payload.message as { usage?: { input_tokens?: number } } | undefined)?.usage;
      if (typeof usage?.input_tokens === 'number') inputTokens = usage.input_tokens;
    } else if (type === 'content_block_start') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const block = payload.content_block as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === 'tool_use') {
        toolByIndex.set(index, { id: block.id ?? '', name: block.name ?? '', json: '' });
      }
    } else if (type === 'content_block_delta') {
      const index = typeof payload.index === 'number' ? payload.index : 0;
      const delta = payload.delta as { type?: string; text?: string; thinking?: string; partial_json?: string } | undefined;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        textByIndex.set(index, (textByIndex.get(index) ?? '') + delta.text);
      } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
        thinkingByIndex.set(index, (thinkingByIndex.get(index) ?? '') + delta.thinking);
      } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        const tool = toolByIndex.get(index);
        if (tool) tool.json += delta.partial_json;
      }
    } else if (type === 'message_delta') {
      const delta = payload.delta as { stop_reason?: string | null } | undefined;
      if (delta?.stop_reason !== undefined) stopReason = delta.stop_reason;
      const usage = payload.usage as { output_tokens?: number } | undefined;
      if (typeof usage?.output_tokens === 'number') outputTokens = usage.output_tokens;
    } else if (type === 'message_stop') {
      sawTerminal = true;
    } else if (type === 'error') {
      const err = payload.error as { message?: string } | undefined;
      throw new Error(`LLM stream error: ${err?.message ?? dataText.slice(0, 300)}`);
    }
  };

  deadline.enableIdle(); // covers time-to-first-byte, re-armed per chunk
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (deadline.signal.aborted) {
        throw deadline.signal.reason ?? new DOMException('LLM stream aborted', 'AbortError');
      }
      if (done) break;
      deadline.armIdle();
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.search(/\r?\n\r?\n/);
      while (boundary !== -1 && !sawTerminal) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, '');
        applyEvent(rawEvent);
        boundary = buffer.search(/\r?\n\r?\n/);
      }
      if (sawTerminal) break;
    }
  } finally {
    try { await reader.cancel(); } catch { /* best-effort release of the upstream connection */ }
  }

  if (!sawEvent) {
    throw new Error('LLM stream returned no events');
  }
  if (!sawTerminal) {
    throw new Error('LLM stream ended without message_stop');
  }

  const content: NonNullable<AnthropicWireShaped['content']> = [];
  const indices = [...new Set([...textByIndex.keys(), ...thinkingByIndex.keys(), ...toolByIndex.keys()])]
    .sort((a, b) => a - b);
  for (const index of indices) {
    const text = textByIndex.get(index);
    if (text) content.push({ type: 'text', text });
    const thinking = thinkingByIndex.get(index);
    if (thinking) content.push({ type: 'thinking', thinking });
    const tool = toolByIndex.get(index);
    if (tool) content.push({ type: 'tool_use', id: tool.id, name: tool.name, input: tool.json });
  }
  return {
    content,
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens ?? undefined, output_tokens: outputTokens ?? undefined },
  };
}

/** Shared assembly for both transports: turn the shaped Anthropic-wire
 *  response (JSON body or folded SSE stream) into a ChatCompletionResult.
 *  Behavior is byte-for-byte the pre-streaming JSON assembly. */
function assembleAnthropicResult(shaped: AnthropicWireShaped, model: string): ChatCompletionResult {
  const contentBlocks = shaped.content ?? [];
  const out: ChatCompletionResult = {
    responseMetadata: {
      apiType: 'anthropic',
      stopReason: shaped.stop_reason ?? null,
      contentBlockTypes: contentBlocks.map((block) => block.type ?? 'unknown'),
      inputTokens: shaped.usage?.input_tokens ?? null,
      outputTokens: shaped.usage?.output_tokens ?? null,
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
  effort?: LlmEffortLevel | null,
  transport?: { streaming: boolean; deadline: OneShotAttemptDeadline }
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

  if (transport?.streaming) {
    body.stream = true;
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (apiKey.trim()) {
    headers['x-api-key'] = apiKey.trim();
  }
  Object.assign(headers, buildOpenCodeGoHeaders(url));

  const response = await fetchLlmPost(
    'anthropic',
    url,
    headers,
    JSON.stringify(body),
    transport?.deadline.signal ?? signal
  );
  const contentType = response.headers.get('content-type') ?? '';
  let shaped: AnthropicWireShaped;
  if (transport?.streaming && response.ok && contentType.includes('text/event-stream')) {
    shaped = await readAnthropicSseCompletion(response, transport);
  } else {
    // Non-streaming reply: the pre-streaming transport, the kill switch, or a
    // provider that ignores stream:true and answers with a JSON body.
    const text = await response.text();
    if (!response.ok) {
      console.error('[Orchestrator] LLM Anthropic error:', response.status, text.slice(0, 500));
      throw new Error(`LLM request failed: ${response.status} ${text.slice(0, 300)}`);
    }
    try {
      shaped = JSON.parse(text) as AnthropicWireShaped;
    } catch {
      console.error('[Orchestrator] LLM Anthropic invalid JSON:', text.slice(0, 300));
      throw new Error('LLM response was not valid JSON');
    }
  }
  return assembleAnthropicResult(shaped, model);
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
  readAnthropicSseCompletion,
  assembleAnthropicResult,
  resolveOneShotStreamDeadline,
  buildOneShotAttemptDeadline,
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