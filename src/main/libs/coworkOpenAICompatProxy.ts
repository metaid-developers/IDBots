import http from 'http';
import fs from 'fs';
import path from 'path';
import { session, app } from 'electron';
import { broadcastToRenderers } from '../ipc/broadcast';
import {
  anthropicToOpenAI,
  buildOpenAIChatCompletionsURL,
  formatSSEEvent,
  mapStopReason,
  openAIToAnthropic,
  type OpenAIStreamChunk,
} from './coworkFormatTransform';
import { DeepSeekReasoningStore } from './deepseekReasoningStore';
import { DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER } from './coworkAssistantReply';
import { coworkLog } from './coworkLogger';
import { buildOpenCodeGoHeaders } from './opencodeGatewayHeaders';
import { resolveOpenCodeGoApiFormat } from './opencodeGoProtocol';
import { writeFileAtomicSync } from './atomicFile';
import { snipStaleToolResultBlocks } from './coworkToolResultSnip';
import { foldLowValueToolResults } from './coworkToolResultFold';
import {
  compareRequestHead,
  fingerprintRequestHead,
  isMainLoopRequestHead,
  type RequestHeadDrift,
  type RequestHeadFingerprint,
} from './coworkRequestHeadWatch';
import { modelSupportsVision } from './coworkModelLimits';
import { modelAlwaysThinks, responsesEffortForThinkingOff, thinkingWireFamily } from './modelThinking';
import type { ScheduledTaskStore, ScheduledTaskInput, ScheduledTaskSessionMode } from '../scheduledTaskStore';
import { DEFAULT_AGENT_MAX_FIRES, SCHEDULED_TASK_SESSION_MODES } from '../scheduledTaskStore';

/** `sessionMode` is optional everywhere: absent = 'series' on create, keep on update. */
function validateScheduledTaskSessionMode(value: unknown): string | null {
  if (value === undefined) return null;
  return SCHEDULED_TASK_SESSION_MODES.includes(value as ScheduledTaskSessionMode)
    ? null
    : 'sessionMode must be "series" (default: every fire continues one standing conversation) or "fresh" (a new session for every fire), or omitted.';
}
import type { Scheduler } from './scheduler';

export type OpenAICompatUpstreamConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  provider?: string;
  /**
   * User-selected API format from the provider config. 'responses' forces the
   * Responses upstream regardless of the provider name; 'openai' / absent
   * keep the provider-based resolution (openai -> Responses, deepseek flash ->
   * Responses, everything else -> Chat Completions).
   */
  apiFormat?: 'anthropic' | 'openai' | 'responses';
  /**
   * Optional cowork session id. When set, configureCoworkOpenAICompatProxy
   * records this upstream ONLY under the session key and leaves the shared
   * singleton untouched, so concurrent sessions on DIFFERENT openai/responses
   * providers neither clobber each other nor re-point in-flight unscoped
   * callers (memory judge, title generation). The runner passes the cowork
   * sessionId here; handleRequest then resolves the per-session entry first and
   * falls back to the singleton when absent.
   */
  sessionKey?: string;
  /**
   * Whether this provider's model row accepts image input (the Settings
   * 支持图像输入 checkbox, resolved provider-scoped by the caller). When
   * present it overrides the static catalog in the Responses converter's
   * image-degradation decision, so a checked vision model never gets its
   * history images placeholdered (2026-09-28 glm-5.3-flash incident). Absent
   * on legacy callers — the static catalog keeps deciding.
   */
  supportsImage?: boolean;
};

export type OpenAICompatProxyTarget = 'local' | 'sandbox';

export type OpenAICompatProxyStatus = {
  running: boolean;
  baseURL: string | null;
  hasUpstream: boolean;
  upstreamBaseURL: string | null;
  upstreamModel: string | null;
  lastError: string | null;
};

type ToolCallState = {
  id?: string;
  name?: string;
  extraContent?: unknown;
};

type StreamState = {
  messageId: string | null;
  model: string | null;
  contentIndex: number;
  currentBlockType: 'thinking' | 'text' | 'tool_use' | null;
  activeToolIndex: number | null;
  hasMessageStart: boolean;
  hasMessageStop: boolean;
  toolCalls: Record<number, ToolCallState>;
  preserveDeepSeekReasoning: boolean;
  currentDeepSeekReasoningContent: string;
  /**
   * finish_reason seen on the last content chunk. With OpenAI/DeepSeek
   * streaming convention (stream_options.include_usage=true) the REAL usage
   * arrives in a separate FINAL chunk with an empty choices array, AFTER the
   * finish chunk. We hold the stop reason here and emit the message_delta only
   * once the usage chunk lands (or at stream end), so the SDK's result event
   * gets the provider's actual token/cache accounting instead of zeros.
   */
  pendingStopReason: string | null;
  /** Usage carried by the trailing usage-only stream chunk (choices: []). */
  collectedUsage: OpenAIStreamChunk['usage'] | null;
};

type StreamStateOptions = {
  preserveDeepSeekReasoning?: boolean;
};

type UpstreamAPIType = 'chat_completions' | 'responses';

type ResponsesFunctionCallState = {
  outputIndex: number;
  callId: string;
  itemId: string;
  name: string;
  extraContent?: unknown;
  argumentsBuffer: string;
  finalArguments: string;
  emitted: boolean;
  metadataEmitted: boolean;
};

type ResponsesStreamContext = {
  functionCallByOutputIndex: Map<number, ResponsesFunctionCallState>;
  functionCallByCallId: Map<string, ResponsesFunctionCallState>;
  functionCallByItemId: Map<string, ResponsesFunctionCallState>;
  nextToolIndex: number;
  hasAnyDelta: boolean;
  /** True once any reasoning delta was forwarded to the client this stream. */
  hasReasoningDeltas: boolean;
  /**
   * Ids of web_search_call output items already relayed as Anthropic
   * server_tool_use blocks, so output_item.added/done pairs and the completed
   * fallback each emit the marker exactly once per search.
   */
  emittedWebSearchItemIds: Set<string>;
  /** Text deltas relayed to the client this stream (layer-2 assertion gate). */
  accumulatedText: string;
  /**
   * Distinct Responses SSE event types observed this stream. Only populated
   * when DEEPSEEK_REASONING_DIAGNOSTIC is on; empty otherwise. Lets the
   * diagnostic reveal event names the proxy may not be handling.
   */
  observedEventTypes: Set<string>;
};

/**
 * Loopback only. This proxy serves unauthenticated internal APIs (scheduled
 * task CRUD) and relays the user's upstream API key (/v1/messages); binding
 * all interfaces exposed both to the LAN. Sandbox sessions still reach it:
 * QEMU user networking maps the guest's 10.0.2.2 to the HOST LOOPBACK, and
 * the loopback-bound web-search server (127.0.0.1:8923, reached by guests as
 * http://10.0.2.2:8923) already proves that path. (Restores the hardening
 * from upstream 83ab8646 "bind OpenAI compat proxy to 127.0.0.1 to prevent
 * remote unauthenticated RCE", which the genesis import rolled back.)
 */
const PROXY_BIND_HOST = '127.0.0.1';
const LOCAL_HOST = '127.0.0.1';
const SANDBOX_HOST = '10.0.2.2';
const GEMINI_FALLBACK_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';
// DeepSeek's thinking API rejects (400) any assistant tool-call message that
// lacks the reasoning_content key. When the real reasoning is unrecoverable
// (process restart, LRU eviction, or history from turns that never produced
// reasoning), we inject an EMPTY STRING (not a human-readable placeholder) so
// the request contract stays valid AND the cached prefix remains byte-stable.
// A variable placeholder text would change the prefix per lost-reasoning set
// and crater DeepSeek's automatic context-cache hit rate; an empty string is
// constant and accepted by the API. Mirrors Reasonix openai.go which sends a
// pointer to the (possibly empty) ReasoningContent field.
const DEEPSEEK_REASONING_PLACEHOLDER = '';

/**
 * Optional diagnostic for the DeepSeek reasoning_content capture pipeline.
 * Default OFF. Enable by setting `IDBOTS_DEBUG_DEEPSEEK_REASONING=1` before
 * launching the app. When OFF the only cost is a single boolean check per
 * streamed event/response (no string building, no I/O), so leaving it in the
 * codebase is zero-impact. When ON it writes one compact summary line per
 * upstream response to cowork.log: the distinct SSE event types observed,
 * whether reasoning deltas arrived, the captured reasoning length, and the
 * per-tool-call cache hit/miss — enough to tell whether reasoning never
 * arrived from the upstream (e.g. opencode relay omitting it) vs. arrived but
 * was not cached (a code bug).
 */
const DEEPSEEK_REASONING_DIAGNOSTIC =
  process.env.IDBOTS_DEBUG_DEEPSEEK_REASONING === '1'
  || process.env.IDBOTS_DEBUG_DEEPSEEK_REASONING === 'true';

/**
 * Anti-hallucination guard appended to the instructions of DeepSeek Responses
 * requests (which carry the injected server-side web_search tool). The model
 * must not confidently assert post-training real-time facts (news, awards,
 * standings, prices, weather, latest figures) without search evidence — the
 * confident fabrication of non-existent facts is worse than admitting a gap.
 * Constant text keeps the cached prompt prefix byte-stable across turns.
 */
const DEEPSEEK_WEB_SEARCH_INTEGRITY_GUARD =
  '实时信息规范：对于训练截止之后发生或变化的事实（新闻、奖项、赛事、行情、天气、最新数据、人物当选或任命等），'
  + '第一步必须调用 web_search 工具搜索后再作答，禁止凭记忆直接作答。'
  + '若未执行搜索或搜索结果不足以确认答案，只能回答「无法确认」或「未验证」并简述原因，'
  + '禁止给出具体的人名、日期、比分、数字或结论。';

/** Concatenated final answer text of a Responses output (message/output_text). */
function extractResponsesOutputText(responseObj: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (toString(itemObj?.type) !== 'message') {
      continue;
    }
    for (const block of toArray(itemObj?.content)) {
      const blockObj = toOptionalObject(block);
      if (toString(blockObj?.type) !== 'output_text') {
        continue;
      }
      const text = toString(blockObj?.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join('');
}

// DeepSeek's Responses API is stricter than chat/completions: it REJECTS an
// empty reasoning pass-back (`reasoning` input items with empty text) with the
// same 400. When the real reasoning is unrecoverable in the Responses path we
// inject this CONSTANT placeholder instead — byte-stable across turns (any set
// of lost-reasoning turns serializes identically), unlike a variable text.

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;
let upstreamConfig: OpenAICompatUpstreamConfig | null = null;
let lastProxyError: string | null = null;

/**
 * Fired when an upstream answer carries a relay quota-exhaustion machine code
 * (free_quota_exhausted / quota_exhausted). Registered by main.ts to trigger
 * an immediate quota-nudge recompute so the global banner lights up at the
 * moment of failure instead of at the next poll. Never awaited, never throws.
 */
let freeQuotaExhaustedListener: (() => void) | null = null;
export function setFreeQuotaExhaustedListener(listener: (() => void) | null): void {
  freeQuotaExhaustedListener = listener;
}
// Per-session upstream registry. Each cowork session whose provider routes via
// this proxy (openai/responses apiFormat) registers its own upstream here, so
// concurrent sessions on different providers no longer overwrite each other
// through the shared `upstreamConfig` singleton. Resolved first in handleRequest;
// the singleton remains as a fallback for non-session callers (sandbox,
// scheduled tasks, internal API, legacy paths).
const sessionUpstreams = new Map<string, OpenAICompatUpstreamConfig>();
const toolCallExtraContentById = new Map<string, unknown>();
const MAX_TOOL_CALL_EXTRA_CONTENT_CACHE = 1024;
const MAX_DEEPSEEK_REASONING_CACHE = 1024;
// Reasoning_content is persisted (JSONL in the user-data dir) so an app
// restart no longer degrades historical reasoning to '' — that fallback is a
// mid-history byte change that breaks DeepSeek's cached prefix. The store
// stays memory-only when the user-data path is unavailable (e.g. tests).
const deepSeekReasoningStore = new DeepSeekReasoningStore(MAX_DEEPSEEK_REASONING_CACHE);
let deepSeekReasoningStoreLoaded = false;

function ensureDeepSeekReasoningStoreLoaded(): void {
  if (deepSeekReasoningStoreLoaded) {
    return;
  }
  deepSeekReasoningStoreLoaded = true;
  try {
    const filePath = path.join(app.getPath('userData'), 'cowork', 'deepseek-reasoning-cache.jsonl');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    deepSeekReasoningStore.load(filePath);
  } catch {
    // Memory-only fallback (non-Electron test hosts, early app init).
  }
}

// --- Per-session tool-result snip boundaries ---
// Reasonix-style tiered truncation: instead of flattening the whole history
// when the context estimate crosses the soft threshold (a full cold start for
// DeepSeek's cached prefix), the runner raises a per-session HEAD boundary
// and the proxy snips stale tool_result blocks below it (see
// coworkToolResultSnip.ts). The boundary is monotonic per session so a
// previously snipped prefix stays byte-identical, and it is persisted across
// restarts for the same reason as the DeepSeek reasoning cache above. The
// in-memory map is the hot path (lookups happen on every /v1/messages
// request); the JSON file is only rewritten when a boundary actually moves.
const snipHeadTokensBySession = new Map<string, number>();
let snipHeadTokensLoaded = false;
let snipHeadTokensFilePath: string | null = null;

function ensureSnipHeadTokensLoaded(): void {
  if (snipHeadTokensLoaded) {
    return;
  }
  snipHeadTokensLoaded = true;
  try {
    snipHeadTokensFilePath = path.join(app.getPath('userData'), 'cowork', 'tool-result-snip.json');
    const parsed = JSON.parse(fs.readFileSync(snipHeadTokensFilePath, 'utf8')) as { sessions?: unknown };
    const sessions = parsed?.sessions;
    if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
      for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
        if (key && typeof value === 'number' && Number.isFinite(value) && value > 0) {
          snipHeadTokensBySession.set(key, Math.floor(value));
        }
      }
    }
  } catch {
    // Missing/corrupt file or non-Electron host: memory-only, start empty.
  }
}

function persistSnipHeadTokens(): void {
  if (!snipHeadTokensFilePath) {
    return;
  }
  try {
    const sessions: Record<string, number> = {};
    for (const [key, value] of snipHeadTokensBySession) {
      sessions[key] = value;
    }
    fs.mkdirSync(path.dirname(snipHeadTokensFilePath), { recursive: true });
    writeFileAtomicSync(snipHeadTokensFilePath, Buffer.from(JSON.stringify({ sessions })));
  } catch {
    // Best effort; the in-memory map still serves this run.
  }
}

/** Current snip boundary (estimated head tokens) for a session; 0 when unset. */
export function getCoworkSnipHeadTokens(sessionKey: string): number {
  if (!sessionKey) {
    return 0;
  }
  ensureSnipHeadTokensLoaded();
  return snipHeadTokensBySession.get(sessionKey) ?? 0;
}

/**
 * Raise a session's snip boundary. Monotonic: a value at or below the
 * persisted one is ignored — lowering the boundary would un-snip previously
 * snipped blocks and break the cached prefix a second time.
 */
export function setCoworkSnipHeadTokens(sessionKey: string, tokens: number): void {
  if (!sessionKey || !Number.isFinite(tokens) || tokens <= 0) {
    return;
  }
  ensureSnipHeadTokensLoaded();
  const existing = snipHeadTokensBySession.get(sessionKey) ?? 0;
  if (tokens <= existing) {
    return;
  }
  snipHeadTokensBySession.set(sessionKey, Math.floor(tokens));
  persistSnipHeadTokens();
}

/** Forget a session's boundary (session deleted, or history fully compacted into a fresh SDK session). */
export function resetCoworkSnipHeadTokens(sessionKey: string): void {
  if (!sessionKey) {
    return;
  }
  ensureSnipHeadTokensLoaded();
  if (snipHeadTokensBySession.delete(sessionKey)) {
    persistSnipHeadTokens();
  }
}

// --- Per-session request-head baselines ---
// Fingerprint of the (system, tools) wire bytes for each session's main loop,
// persisted so a restart-resume that serializes the head differently is
// detected (first-request cache miss attribution) instead of staying silent.
const requestHeadBaselineBySession = new Map<string, RequestHeadFingerprint>();
let requestHeadBaselinesLoaded = false;
let requestHeadBaselinesFilePath: string | null = null;

function ensureRequestHeadBaselinesLoaded(): void {
  if (requestHeadBaselinesLoaded) {
    return;
  }
  requestHeadBaselinesLoaded = true;
  try {
    requestHeadBaselinesFilePath = path.join(app.getPath('userData'), 'cowork', 'request-head-hashes.json');
    const parsed = JSON.parse(fs.readFileSync(requestHeadBaselinesFilePath, 'utf8')) as { sessions?: unknown };
    const sessions = parsed?.sessions;
    if (sessions && typeof sessions === 'object' && !Array.isArray(sessions)) {
      for (const [key, value] of Object.entries(sessions as Record<string, unknown>)) {
        const entry = value as { systemHash?: unknown; toolsHash?: unknown } | null;
        const systemHash = typeof entry?.systemHash === 'string' ? entry.systemHash : '';
        const toolsHash = typeof entry?.toolsHash === 'string' ? entry.toolsHash : '';
        if (key && systemHash && toolsHash) {
          requestHeadBaselineBySession.set(key, { systemHash, toolsHash });
        }
      }
    }
  } catch {
    // Missing/corrupt file or non-Electron host: memory-only, start empty.
  }
}

function persistRequestHeadBaselines(): void {
  if (!requestHeadBaselinesFilePath) {
    return;
  }
  try {
    const sessions: Record<string, RequestHeadFingerprint> = {};
    for (const [key, value] of requestHeadBaselineBySession) {
      sessions[key] = value;
    }
    fs.mkdirSync(path.dirname(requestHeadBaselinesFilePath), { recursive: true });
    writeFileAtomicSync(requestHeadBaselinesFilePath, Buffer.from(JSON.stringify({ sessions })));
  } catch {
    // Best effort; the in-memory map still serves this run.
  }
}

/** Extract the Anthropic request's system field as plain text (string or text blocks). */
function extractAnthropicSystemText(systemField: unknown): string {
  if (typeof systemField === 'string') {
    return systemField;
  }
  const parts: string[] = [];
  for (const block of toArray(systemField)) {
    const blockObj = toOptionalObject(block);
    if (toString(blockObj?.type) === 'text') {
      parts.push(toString(blockObj?.text));
    }
  }
  return parts.join('\n');
}

/**
 * Watch the (system, tools) request head of a session's main-loop requests.
 * Subagent/side-job calls (agent-definition systems without the IDBots safety
 * signature) are skipped so their alternating prompts cannot pollute the
 * baseline. Drift — including a KNOWN reset that propagated to the wire bytes
 * — is logged with both fingerprints for correlation with the runner's
 * cache-miss attribution labels.
 */
function trackRequestHeadStability(
  sessionKey: string,
  anthropicRequestBody: Record<string, unknown>
): RequestHeadDrift | null {
  const systemText = extractAnthropicSystemText(anthropicRequestBody.system);
  if (!isMainLoopRequestHead(systemText)) {
    return null;
  }
  const next = fingerprintRequestHead(systemText, anthropicRequestBody.tools);
  ensureRequestHeadBaselinesLoaded();
  const baseline = requestHeadBaselineBySession.get(sessionKey);
  if (!baseline) {
    requestHeadBaselineBySession.set(sessionKey, next);
    persistRequestHeadBaselines();
    return null;
  }
  const drift = compareRequestHead(baseline, next);
  if (!drift) {
    return null;
  }
  requestHeadBaselineBySession.set(sessionKey, next);
  persistRequestHeadBaselines();
  console.warn('[cowork-openai-compat-proxy] Request head drift detected (cached prefix break)', {
    sessionKey,
    kind: drift.kind,
    previousSystemHash: drift.previous.systemHash,
    nextSystemHash: drift.next.systemHash,
    previousToolsHash: drift.previous.toolsHash,
    nextToolsHash: drift.next.toolsHash,
    note: 'Known resets (system_prompt_changed/compaction/... ) also show here; cross-check the runner cache-miss attribution.',
  });
  return drift;
}

// --- Scheduled task API dependencies ---
interface ScheduledTaskDeps {
  getScheduledTaskStore: () => ScheduledTaskStore;
  getScheduler: () => Scheduler;
  /**
   * Advisory `sessionId` probe for the HTTP create/update path. The proxy has
   * no cowork-store handle of its own, so main.ts injects this predicate (same
   * validity rules the scheduler applies at fire time: exists, not archived,
   * not A2A, not sandbox). It only drives the non-fatal `sessionWarning` in the
   * response — an unusable target is never a hard error, the task simply runs
   * in a fresh session. Absent → warnings are skipped.
   */
  isSessionUsableAsTaskTarget?: (sessionId: string) => boolean;
  /**
   * Host-side provenance stamping for API creates: derives the creation
   * context of a session ('a2a' / 'group-task:<id>' / 'chat' / …). Absent →
   * the caller-declared originContext (if any) is used, else null.
   */
  resolveSessionOriginContext?: (sessionId: string) => string | null;
}
let scheduledTaskDeps: ScheduledTaskDeps | null = null;

export function setScheduledTaskDeps(deps: ScheduledTaskDeps): void {
  scheduledTaskDeps = deps;
}

function toOptionalObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Claude-native model names that must never reach an OpenAI-compatible
 * upstream verbatim. The Claude Agent SDK 0.3.221 CLI ignores the parent
 * session model for subagents: regardless of options.model / AgentDefinition
 * model / AgentInput.model, subagent requests are sent with the CLI's own
 * fallback default (e.g. claude-opus-5). DeepSeek and other OpenAI-compatible
 * providers reject those names with a 400, which surfaced as
 * "you passed claude-opus-5" errors in metabot/cowork sessions. The proxy only
 * fronts OpenAI-compatible upstreams (Anthropic-native providers bypass it), so
 * any claude-* or bare alias model here is the CLI's fallback, never a model a
 * user configured for this upstream — map it to the configured session model.
 */
function isClaudeNativeFallbackModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith('claude-')) return true;
  return normalized === 'opus' || normalized === 'sonnet' || normalized === 'haiku' || normalized === 'fable';
}

/**
 * Resolve the effective upstream model for an incoming request. Empty model
 * (request omitted it) and Claude-native fallback names (the CLI's subagent
 * defaults) both resolve to the configured session model; any other name
 * (e.g. deepseek-v4-flash, gpt-5.6-sol) passes through untouched.
 */
export function resolveEffectiveUpstreamModel(
  requestedModel: string,
  configuredModel: string
): string {
  if (isClaudeNativeFallbackModel(requestedModel)) {
    return configuredModel;
  }
  return requestedModel.trim() ? requestedModel : configuredModel;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value ?? '');
  } catch {
    return '';
  }
}

function normalizeFunctionArguments(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value === undefined) {
    return '';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function normalizeScheduledTaskWorkingDirectory(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
  // Sandbox guest workspace roots are not valid host directories.
  if (/^(?:[A-Za-z]:)?\/workspace(?:\/project)?$/i.test(normalized)) {
    return '';
  }
  return raw;
}

function normalizeScheduledTaskMetabotId(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeToolCallExtraContent(toolCallObj: Record<string, unknown>): unknown {
  if (toolCallObj.extra_content !== undefined) {
    return toolCallObj.extra_content;
  }

  const functionObj = toOptionalObject(toolCallObj.function);
  if (functionObj?.extra_content !== undefined) {
    return functionObj.extra_content;
  }

  const thoughtSignature = toString(functionObj?.thought_signature);
  if (!thoughtSignature) {
    return undefined;
  }

  return {
    google: {
      thought_signature: thoughtSignature,
    },
  };
}

function extractDeepSeekReasoningFromExtraContent(extraContent: unknown): string {
  const extraObj = toOptionalObject(extraContent);
  if (!extraObj) {
    return '';
  }

  const direct = toString(extraObj.reasoning_content) || toString(extraObj.reasoning);
  if (direct) {
    return direct;
  }

  const deepSeekObj = toOptionalObject(extraObj.deepseek);
  if (!deepSeekObj) {
    return '';
  }

  return toString(deepSeekObj.reasoning_content) || toString(deepSeekObj.reasoning);
}

function attachDeepSeekReasoningToExtraContent(extraContent: unknown, reasoningContent: string): unknown {
  if (!reasoningContent.trim()) {
    return extraContent;
  }

  const extraObj = toOptionalObject(extraContent);
  const output: Record<string, unknown> = extraObj ? { ...extraObj } : {};
  const existingDeepSeek = toOptionalObject(output.deepseek);
  const nextDeepSeek: Record<string, unknown> = existingDeepSeek ? { ...existingDeepSeek } : {};
  nextDeepSeek.reasoning_content = reasoningContent;
  output.deepseek = nextDeepSeek;
  return output;
}

function cacheToolCallExtraContent(toolCallId: string, extraContent: unknown): void {
  if (!toolCallId || extraContent === undefined) {
    return;
  }

  toolCallExtraContentById.set(toolCallId, extraContent);

  if (toolCallExtraContentById.size > MAX_TOOL_CALL_EXTRA_CONTENT_CACHE) {
    const oldestKey = toolCallExtraContentById.keys().next().value;
    if (typeof oldestKey === 'string') {
      toolCallExtraContentById.delete(oldestKey);
    }
  }
}

function cacheDeepSeekReasoningForToolCall(toolCallId: string, reasoningContent: string): void {
  if (!toolCallId || !reasoningContent.trim()) {
    return;
  }

  ensureDeepSeekReasoningStoreLoaded();
  deepSeekReasoningStore.set(toolCallId, reasoningContent);
}

function cacheDeepSeekReasoningFromToolCalls(toolCalls: unknown, reasoningContent: string): void {
  if (!reasoningContent.trim()) {
    return;
  }

  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }
    cacheDeepSeekReasoningForToolCall(toString(toolCallObj.id), reasoningContent);
  }
}

function cacheDeepSeekReasoningForStreamToolCalls(state: StreamState): void {
  if (!state.preserveDeepSeekReasoning || !state.currentDeepSeekReasoningContent.trim()) {
    return;
  }

  for (const toolCall of Object.values(state.toolCalls)) {
    if (!toolCall.id) {
      continue;
    }

    toolCall.extraContent = attachDeepSeekReasoningToExtraContent(
      toolCall.extraContent,
      state.currentDeepSeekReasoningContent
    );
    cacheToolCallExtraContent(toolCall.id, toolCall.extraContent);
    cacheDeepSeekReasoningForToolCall(toolCall.id, state.currentDeepSeekReasoningContent);
  }
}

function cacheToolCallExtraContentFromOpenAIToolCalls(toolCalls: unknown): void {
  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }

    const toolCallId = toString(toolCallObj.id);
    const extraContent = normalizeToolCallExtraContent(toolCallObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
}

/**
 * Whether a model id is a DeepSeek thinking-capable model. Used to apply the
 * DeepSeek reasoning round-trip machinery to gateway providers (e.g. the
 * opencode "Console Go" upstream serving `deepseek-v4-flash`), whose provider
 * name/base URL carry no "deepseek" marker.
 */
function isDeepSeekModel(model?: string): boolean {
  const normalized = (model ?? '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('deepseek')
    || normalized.includes('v4-flash')
    || normalized.includes('v4-pro')
    || normalized.includes('reasoner')
    || normalized === 'r1'
    || normalized.startsWith('r1-');
}

function isDeepSeekProvider(provider?: string, baseURL?: string, model?: string): boolean {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === 'deepseek') {
    return true;
  }
  if (isDeepSeekModel(model)) {
    return true;
  }
  return Boolean(baseURL?.toLowerCase().includes('deepseek'));
}

/**
 * Billing identity of a CoWork session's upstream. Unlike isDeepSeekProvider
 * (which also matches deepseek MODELS served through gateways like opencode —
 * needed for reasoning round-trips), this is the strict "who do we pay"
 * signal: only a deepseek provider key or a deepseek host means the DeepSeek
 * account balance and CNY rate estimate apply. Everything else ('other':
 * opencode plans, openrouter, custom gateways, ollama, ...) is billed by its
 * own plan/counter and must not show DeepSeek balances or cost estimates.
 */
export function resolveCoworkBillingSource(
  provider?: string,
  baseURL?: string
): 'deepseek' | 'anthropic' | 'other' {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === 'deepseek') {
    return 'deepseek';
  }
  if (normalizedProvider === 'anthropic') {
    return 'anthropic';
  }
  if (baseURL?.toLowerCase().includes('deepseek')) {
    return 'deepseek';
  }
  return 'other';
}

function isDeepSeekThinkingRequest(
  body: Record<string, unknown>,
  provider?: string,
  baseURL?: string,
  model?: string
): boolean {
  if (!isDeepSeekProvider(provider, baseURL, model ?? toString(body.model))) {
    return false;
  }

  const thinking = toOptionalObject(body.thinking);
  if (toString(thinking?.type).toLowerCase() === 'enabled') {
    return true;
  }

  if (body.reasoning_effort !== undefined || body.output_config !== undefined) {
    return true;
  }

  const resolvedModel = toString(body.model).toLowerCase();
  // Any DeepSeek thinking-capable model (flash defaults to thinking ON, like
  // pro/reasoner/r1) needs reasoning pass-back; plain `deepseek-chat` does not.
  // The renamed V4.1 ids — `deepseek-flash` and the free relay's 2026-10-16
  // `deepseek-4.1-flash` — are matched literally so other vendors' `flash`
  // models (gemini-3-flash, …) stay out.
  return /\b(?:deepseek-)?(?:v4-flash|v4-pro|reasoner|r1)\b/.test(resolvedModel)
    || /\bdeepseek-(?:flash|4\.1-flash)\b/.test(resolvedModel);
}

type DeepSeekReasoningHydrateResult = {
  ok: true;
  hydratedCount: number;
  /** Number of messages that could not be restored from cache/history and fell back to the placeholder. */
  placeholderCount: number;
};

function resolveDeepSeekReasoningForToolCalls(toolCalls: unknown): string {
  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }

    const toolCallId = toString(toolCallObj.id);
    ensureDeepSeekReasoningStoreLoaded();
    const cachedReasoning = toolCallId ? deepSeekReasoningStore.get(toolCallId) : undefined;
    if (cachedReasoning) {
      return cachedReasoning;
    }

    const inlineReasoning = extractDeepSeekReasoningFromExtraContent(
      normalizeToolCallExtraContent(toolCallObj)
    );
    if (inlineReasoning) {
      return inlineReasoning;
    }
  }

  return '';
}

function attachDeepSeekReasoningToToolCalls(toolCalls: unknown, reasoningContent: string): void {
  if (!reasoningContent.trim()) {
    return;
  }

  for (const toolCall of toArray(toolCalls)) {
    const toolCallObj = toOptionalObject(toolCall);
    if (!toolCallObj) {
      continue;
    }

    toolCallObj.extra_content = attachDeepSeekReasoningToExtraContent(
      normalizeToolCallExtraContent(toolCallObj),
      reasoningContent
    );
    cacheToolCallExtraContent(toString(toolCallObj.id), toolCallObj.extra_content);
    cacheDeepSeekReasoningForToolCall(toString(toolCallObj.id), reasoningContent);
  }
}

function hydrateDeepSeekReasoningForRequest(
  body: Record<string, unknown>,
  provider?: string,
  baseURL?: string
): DeepSeekReasoningHydrateResult {
  if (!isDeepSeekThinkingRequest(body, provider, baseURL)) {
    return { ok: true, hydratedCount: 0, placeholderCount: 0 };
  }

  let hydratedCount = 0;
  let placeholderCount = 0;

  for (const message of toArray(body.messages)) {
    const messageObj = toOptionalObject(message);
    if (!messageObj || toString(messageObj.role) !== 'assistant') {
      continue;
    }

    const toolCalls = toArray(messageObj.tool_calls);
    if (toolCalls.length === 0) {
      continue;
    }

    const existingReasoning = toString(messageObj.reasoning_content) || toString(messageObj.reasoning);
    if (existingReasoning) {
      messageObj.reasoning_content = existingReasoning;
      attachDeepSeekReasoningToToolCalls(toolCalls, existingReasoning);
      continue;
    }

    const restoredReasoning = resolveDeepSeekReasoningForToolCalls(toolCalls);
    if (restoredReasoning) {
      messageObj.reasoning_content = restoredReasoning;
      attachDeepSeekReasoningToToolCalls(toolCalls, restoredReasoning);
      hydratedCount += 1;
      continue;
    }

    // The real reasoning_content is unrecoverable (process restart, LRU
    // eviction, or this turn predates thinking mode). Injecting an EMPTY STRING
    // satisfies DeepSeek's structural requirement (the key must be present on
    // assistant tool-call messages) while keeping the cached prefix byte-stable,
    // avoiding the session wipe that a 400 would trigger downstream. We do NOT
    // stash the empty value into tool-call extra_content — there is nothing to
    // cache, and the message-level key is what the API validates.
    messageObj.reasoning_content = DEEPSEEK_REASONING_PLACEHOLDER;
    placeholderCount += 1;
  }

  return { ok: true, hydratedCount, placeholderCount };
}

function cacheToolCallExtraContentFromOpenAIResponse(body: unknown): void {
  const responseObj = toOptionalObject(body);
  if (!responseObj) {
    return;
  }

  const firstChoice = toOptionalObject(toArray(responseObj.choices)[0]);
  if (!firstChoice) {
    return;
  }

  const message = toOptionalObject(firstChoice.message);
  if (!message) {
    return;
  }

  cacheToolCallExtraContentFromOpenAIToolCalls(message.tool_calls);
}

function attachDeepSeekReasoningToOpenAIResponseToolCalls(
  body: unknown,
  provider?: string,
  baseURL?: string,
  model?: string
): void {
  const responseObj = toOptionalObject(body);
  if (!responseObj) {
    return;
  }
  if (!isDeepSeekProvider(provider, baseURL, model ?? toString(responseObj.model))) {
    return;
  }

  const firstChoice = toOptionalObject(toArray(responseObj.choices)[0]);
  const message = toOptionalObject(firstChoice?.message);
  if (!message) {
    return;
  }

  const reasoningContent = toString(message.reasoning_content) || toString(message.reasoning);
  if (!reasoningContent) {
    return;
  }

  attachDeepSeekReasoningToToolCalls(message.tool_calls, reasoningContent);
  cacheDeepSeekReasoningFromToolCalls(message.tool_calls, reasoningContent);
}

function hydrateOpenAIRequestToolCalls(
  body: Record<string, unknown>,
  provider?: string,
  baseURL?: string
): void {
  const isGemini =
    provider === 'gemini' || Boolean(baseURL?.includes('generativelanguage.googleapis.com'));
  const messages = toArray(body.messages);
  for (const message of messages) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    for (const toolCall of toArray(messageObj.tool_calls)) {
      const toolCallObj = toOptionalObject(toolCall);
      if (!toolCallObj) {
        continue;
      }

      const existingExtraContent = normalizeToolCallExtraContent(toolCallObj);
      if (existingExtraContent !== undefined) {
        continue;
      }

      const toolCallId = toString(toolCallObj.id);
      if (toolCallId) {
        const cachedExtraContent = toolCallExtraContentById.get(toolCallId);
        if (cachedExtraContent !== undefined) {
          toolCallObj.extra_content = cachedExtraContent;
          continue;
        }
      }

      if (isGemini) {
        // Gemini requires thought signatures for tool calls; use a documented fallback when missing.
        toolCallObj.extra_content = {
          google: {
            thought_signature: GEMINI_FALLBACK_THOUGHT_SIGNATURE,
          },
        };
      }
    }
  }
}

function createAnthropicErrorBody(message: string, type = 'api_error'): Record<string, unknown> {
  return {
    type: 'error',
    error: {
      type,
      message,
    },
  };
}

function extractErrorMessage(raw: string): string {
  if (!raw) {
    return 'Upstream API request failed';
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errorObj = parsed.error;
    if (errorObj && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
      const message = (errorObj as Record<string, unknown>).message;
      if (typeof message === 'string' && message) {
        return message;
      }
    }
    if (typeof parsed.message === 'string' && parsed.message) {
      return parsed.message;
    }
  } catch {
    // noop
  }

  return raw;
}

/**
 * Extracts the machine error code of an OpenAI-style error body (error.code),
 * e.g. "free_quota_exhausted" from the free-quota relay. Returns '' when the
 * body carries no usable code.
 */
function extractUpstreamErrorCode(raw: string): string {
  if (!raw) {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const errorObj = parsed.error;
    if (errorObj && typeof errorObj === 'object' && !Array.isArray(errorObj)) {
      const code = (errorObj as Record<string, unknown>).code;
      if (typeof code === 'string' && code.trim()) {
        return code.trim();
      }
    }
  } catch {
    // noop
  }
  return '';
}

function resolveUpstreamAPIType(provider?: string, model?: string, apiFormat?: string, baseURL?: string): UpstreamAPIType {
  // Per-model protocol correction for the OpenCode Go gateway (see
  // opencodeGoProtocol.ts): the gateway serves GLM over chat completions only
  // and answers /responses with 400 ModelProtocolUnsupported, so this wins
  // over the explicit-format returns below — for THIS gateway the per-model
  // wire is not a preference, it is what the upstream serves. Non-gateway
  // routes are passed through untouched.
  const configured: 'openai' | 'responses' | 'anthropic' =
    apiFormat === 'responses' ? 'responses' : apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const openCodeGoCorrected = resolveOpenCodeGoApiFormat({ baseUrl: baseURL, model, apiFormat: configured });
  if (openCodeGoCorrected !== configured) {
    return openCodeGoCorrected === 'responses' ? 'responses' : 'chat_completions';
  }
  // An explicit user-selected 'responses' format always wins so custom
  // providers pointing at Responses-only endpoints work.
  if (apiFormat === 'responses') {
    return 'responses';
  }
  const normalizedProvider = provider?.toLowerCase();
  // OpenAI always uses the Responses API.
  if (normalizedProvider === 'openai') {
    return 'responses';
  }
  // DeepSeek's Responses API serves the V4 family (flash GA since the
  // endpoint launched, pro GA 2026-08-13 — both verified to execute the
  // built-in web_search tool server-side). Older/other variants fall back
  // to chat/completions.
  if (normalizedProvider === 'deepseek') {
    const normalizedModel = (model ?? '').toLowerCase();
    if (normalizedModel.includes('flash') || normalizedModel.includes('pro')) {
      return 'responses';
    }
  }
  return 'chat_completions';
}

/**
 * Build the Responses endpoint URL.
 *
 * DeepSeek exposes the endpoint at the host root (`/responses`) without a
 * version prefix, matching the official OpenAI-SDK base_url usage documented
 * at https://api-docs.deepseek.com/zh-cn/guides/responses_api. OpenAI and
 * other OpenAI-compatible providers use the conventional `/v1/responses`.
 */
export function buildOpenAIResponsesURL(baseURL: string, provider?: string): string {
  let normalized = baseURL.trim().replace(/\/+$/, '');
  const isDeepSeekHost = normalized.toLowerCase().includes('api.deepseek.com')
    || provider?.toLowerCase() === 'deepseek';

  // DeepSeek's Responses endpoint lives at the host root regardless of which
  // compatibility path the user configured. Strip a trailing /anthropic or /v1
  // so a base URL like https://api.deepseek.com/anthropic resolves correctly.
  if (isDeepSeekHost) {
    normalized = normalized.replace(/\/anthropic$/, '').replace(/\/v1$/, '');
  }

  const responsesPath = isDeepSeekHost ? '/responses' : '/v1/responses';
  if (!normalized) {
    return responsesPath;
  }
  if (normalized.endsWith('/responses') || normalized.endsWith(responsesPath)) {
    return normalized;
  }
  if (!isDeepSeekHost) {
    // Versioned bases (…/v1, …/v4 — e.g. Zhipu's /api/coding/paas/v4) mount
    // /responses directly, mirroring buildOpenAIChatCompletionsURL's
    // versioned-base rule. The old code only recognized …/v1 and blindly
    // appended /v1/responses to everything else, producing doubled paths
    // like …/v4/v1/responses and …/v4/chat/completions/v1/responses for
    // versioned chat bases (route-construction 404s, 2026-10-23). A trailing
    // /chat/completions identifies the chat endpoint, not the base — strip it
    // first, the same way the DeepSeek branch strips /anthropic.
    const versioned = normalized.replace(/\/chat\/completions$/, '');
    if (/\/v\d+$/.test(versioned)) {
      return `${versioned}/responses`;
    }
  }
  return `${normalized}${responsesPath}`;
}

function buildUpstreamTargetUrls(baseURL: string, apiType: UpstreamAPIType, provider?: string): string[] {
  if (apiType === 'responses') {
    return [buildOpenAIResponsesURL(baseURL, provider)];
  }

  const primary = buildOpenAIChatCompletionsURL(baseURL);
  const urls = new Set<string>([primary]);

  if (primary.includes('generativelanguage.googleapis.com')) {
    if (primary.includes('/v1beta/openai/')) {
      urls.add(primary.replace('/v1beta/openai/', '/v1/openai/'));
    } else if (primary.includes('/v1/openai/')) {
      urls.add(primary.replace('/v1/openai/', '/v1beta/openai/'));
    }
  }

  return Array.from(urls);
}

/**
 * Transient Chromium network errors worth an immediate retry on a fresh
 * connection. The proxy's upstream transport is Electron's
 * `session.defaultSession.fetch` (Chromium network stack), and one closed
 * socket — server/LB dropping an idle keep-alive mid-request, a network flap,
 * a relay gateway teardown — surfaces as `net::ERR_CONNECTION_CLOSED`. Until
 * 2026-09-20 any single transport exception was wrapped straight into a 502
 * and killed the whole multi-minute caller attempt (three dream runs died on
 * one zhipu gateway flap), because the proxy had zero transport-level
 * retries. Match by substring: Electron prefixes these codes with `net::`.
 *
 * 2026-09-29: added the TLS/protocol-session codes a relayed connection
 * (system proxy, e.g. ClashX) produces when a node flaps mid-handshake or
 * mid-stream. The 2026-09-28 nightly dream died on `ERR_SSL_PROTOCOL_ERROR` —
 * one sub-second TLS handshake jitter through the proxy was NOT in this list,
 * skipped every retry, and failed a 45-minute run at its last fragment.
 * `ERR_ABORTED` stays out deliberately: that is a programmatic abort (our own
 * caller-disconnect propagation), never a network flap.
 */
const TRANSIENT_UPSTREAM_NETWORK_ERROR_RE = new RegExp(
  [
    'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_RESET',
    'ERR_CONNECTION_ABORTED',
    'ERR_CONNECTION_FAILED',
    'ERR_EMPTY_RESPONSE',
    'ERR_TIMED_OUT',
    'ERR_NETWORK_CHANGED',
    'ERR_NETWORK_IO_SUSPENDED',
    'ERR_NAME_NOT_RESOLVED',
    'ERR_SOCKET_NOT_CONNECTED',
    'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_INTERNET_DISCONNECTED',
    'ERR_PROXY_CONNECTION_FAILED',
    'ERR_ADDRESS_UNREACHABLE',
    'ERR_SSL_PROTOCOL_ERROR',
    'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
    'ERR_QUIC_PROTOCOL_ERROR',
    'ERR_QUIC_HANDSHAKE_FAILED',
    'ERR_HTTP2_PROTOCOL_ERROR',
    'ERR_HTTP2_PING_FAILED',
  ].join('|')
);

/** Whether an upstream fetch failure message looks transient (safe to retry on a fresh connection). */
export function isTransientUpstreamNetworkError(message: string): boolean {
  return TRANSIENT_UPSTREAM_NETWORK_ERROR_RE.test(message);
}

/**
 * Backoff between transient-error retries, in ms. These are sub-second socket
 * deaths and gateway flaps, not quota errors — long backoffs would just burn
 * the caller's own timeout window (dreams budget 180s per attempt).
 */
const TRANSIENT_UPSTREAM_RETRY_DELAYS_MS = [500, 1500];

/**
 * Upstream statuses worth one more fresh-connection try before surfacing to
 * the caller: a gateway's own bad-gateway/unavailable/timeout usually clears
 * immediately. Deliberately excludes 429 (quota/rate — the caller owns that
 * backoff) and 500 (request-specific server errors, e.g. prompt rejections
 * misreported as 500s by some relays).
 */
const RETRYABLE_UPSTREAM_STATUSES = new Set([502, 503, 504]);

/**
 * Send one upstream request, retrying transient failures a bounded number of
 * times. The request body is a plain JSON string rebuilt per attempt, so every
 * retry is a fully replayable POST on a fresh connection. Non-transient
 * exceptions and statuses pass through untouched on the first attempt.
 */
export async function sendUpstreamRequestWithTransientRetry(
  send: (payload: Record<string, unknown>, targetURL: string) => Promise<Response>,
  payload: Record<string, unknown>,
  targetURL: string
): Promise<Response> {
  const maxAttempts = TRANSIENT_UPSTREAM_RETRY_DELAYS_MS.length + 1;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, TRANSIENT_UPSTREAM_RETRY_DELAYS_MS[attempt - 1]));
    }
    let response: Response;
    try {
      response = await send(payload, targetURL);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= maxAttempts - 1 || !isTransientUpstreamNetworkError(message)) {
        throw error;
      }
      coworkLog('WARN', 'upstream-transient-retry', `transient network error on attempt ${attempt + 1}/${maxAttempts}; retrying`, {
        targetURL,
        error: message,
      });
      continue;
    }
    if (RETRYABLE_UPSTREAM_STATUSES.has(response.status) && attempt < maxAttempts - 1) {
      // Drain the error body so the socket is released before retrying.
      await response.text().catch(() => undefined);
      coworkLog('WARN', 'upstream-transient-retry', `upstream returned ${response.status} on attempt ${attempt + 1}/${maxAttempts}; retrying`, {
        targetURL,
      });
      continue;
    }
    return response;
  }
}

function extractTextFromChatContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  const chunks: string[] = [];
  for (const part of toArray(content)) {
    const partObj = toOptionalObject(part);
    if (!partObj) {
      continue;
    }
    const partText = toString(partObj.text);
    if (partText) {
      chunks.push(partText);
    }
  }
  return chunks.join('');
}

/** Text placeholder replacing an image block for non-vision models (GT#12 N1). */
function imageBlockPlaceholderForNonVisionModel(imageURL: string): string {
  if (/^data:image\//i.test(imageURL)) {
    return '[图片块已省略：当前模型不支持视觉输入（base64 图片内容不透明，已不发送）]';
  }
  return `[图片已省略：当前模型不支持视觉输入（来源：${imageURL.slice(0, 120)}）]`;
}

/**
 * N1 scheme-B fallback: degrade image content blocks to short text
 * placeholders when the request's model has no vision capability. Scheme A
 * (canUseTool guard) blocks new reads at the source; this catches image
 * blocks that were persisted before the guard existed, when history is
 * replayed through the proxy — so a non-vision model never receives base64
 * it cannot interpret. Content blocks stay structurally valid (input_text
 * instead of input_image).
 */
function convertUserChatContentToResponsesInput(
  content: unknown,
  supportsVision: boolean = true
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return content
      ? [{ type: 'input_text', text: content }]
      : [];
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const item of toArray(content)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'text') {
      const text = toString(itemObj.text);
      if (text) {
        parts.push({ type: 'input_text', text });
      }
      continue;
    }

    if (itemType === 'image_url') {
      const imageURLObj = toOptionalObject(itemObj.image_url);
      const imageURL = toString(imageURLObj?.url) || toString(itemObj.image_url);
      if (imageURL) {
        if (!supportsVision) {
          parts.push({ type: 'input_text', text: imageBlockPlaceholderForNonVisionModel(imageURL) });
        } else {
          parts.push({ type: 'input_image', image_url: imageURL });
        }
      }
    }
  }

  return parts;
}

/**
 * N1 scheme-B fallback for tool messages: a persisted tool_result whose
 * content embeds image blocks (e.g. `[{"type":"image","source":{base64}}]`)
 * is degraded to a text placeholder for non-vision models. Array content is
 * mapped block-by-block so text blocks survive; string content that looks
 * like an image JSON block is replaced wholesale. Pairing (tool_use_id) is
 * preserved — only content changes.
 */
function sanitizeToolContentForNonVisionModel(content: unknown): unknown {
  if (Array.isArray(content)) {
    const nextBlocks = content.map((block) => {
      const blockObj = toOptionalObject(block);
      if (blockObj && toString(blockObj.type) === 'image') {
        return { type: 'text', text: imageBlockPlaceholderForNonVisionModel('data:image/*') };
      }
      return block;
    });
    return nextBlocks;
  }
  const raw = stringifyUnknown(content);
  if (raw.length > 0 && /"type"\s*:\s*"image"/i.test(raw)) {
    return `[图片块已省略：当前模型不支持视觉输入（原 content 含 image 块，${raw.length} 字符，已不发送）]`;
  }
  return content;
}

function normalizeResponsesToolsFromChat(toolsInput: unknown): Array<Record<string, unknown>> {
  const normalizedTools: Array<Record<string, unknown>> = [];

  for (const tool of toArray(toolsInput)) {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) {
      continue;
    }

    const toolType = toString(toolObj.type);
    if (toolType !== 'function') {
      normalizedTools.push(toolObj);
      continue;
    }

    const functionObj = toOptionalObject(toolObj.function);
    const name = toString(toolObj.name) || toString(functionObj?.name);
    if (!name) {
      continue;
    }

    const normalized: Record<string, unknown> = {
      type: 'function',
      name,
    };

    const description = toString(toolObj.description) || toString(functionObj?.description);
    if (description) {
      normalized.description = description;
    }

    const parameters = toolObj.parameters ?? functionObj?.parameters;
    if (parameters !== undefined) {
      normalized.parameters = parameters;
    }

    const strict = toolObj.strict ?? functionObj?.strict;
    if (typeof strict === 'boolean') {
      normalized.strict = strict;
    }

    normalizedTools.push(normalized);
  }

  return normalizedTools;
}

function normalizeResponsesToolChoiceFromChat(toolChoice: unknown): unknown {
  if (typeof toolChoice === 'string') {
    return toolChoice;
  }

  const toolChoiceObj = toOptionalObject(toolChoice);
  if (!toolChoiceObj) {
    return toolChoice;
  }

  const normalizedType = toString(toolChoiceObj.type).toLowerCase();
  if (normalizedType === 'any') {
    return 'required';
  }
  if (normalizedType === 'auto' || normalizedType === 'none' || normalizedType === 'required') {
    return normalizedType;
  }
  if (normalizedType === 'function' || normalizedType === 'tool') {
    const functionObj = toOptionalObject(toolChoiceObj.function);
    const name = toString(toolChoiceObj.name) || toString(functionObj?.name);
    if (name) {
      return {
        type: 'function',
        name,
      };
    }
  }

  return toolChoice;
}

function convertChatCompletionsRequestToResponsesRequest(
  chatRequest: Record<string, unknown>,
  provider?: string,
  supportsImageHint?: boolean
): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  const unresolvedFunctionCalls = new Map<string, { name: string; hasOutput: boolean }>();

  const isDeepSeek = provider?.toLowerCase() === 'deepseek'
    || isDeepSeekModel(toString(chatRequest.model));
  // N1 scheme-B: whether the effective model can consume image blocks. The
  // provider-scoped checkbox hint (this provider's 支持图像输入 row for this
  // model) wins when present; otherwise the static catalog decides, where
  // unknown models default to true (safe default) and only known non-vision
  // models (DeepSeek V4 family) degrade images to placeholders.
  const supportsVision = typeof supportsImageHint === 'boolean'
    ? supportsImageHint
    : modelSupportsVision(toString(chatRequest.model));

  if (chatRequest.model !== undefined) {
    request.model = chatRequest.model;
  }
  if (chatRequest.stream !== undefined) {
    request.stream = chatRequest.stream;
  }
  if (chatRequest.temperature !== undefined) {
    request.temperature = chatRequest.temperature;
  }
  if (chatRequest.top_p !== undefined) {
    request.top_p = chatRequest.top_p;
  }

  // DeepSeek Responses API: inject the built-in web_search tool (server-side
  // executed) so the agent can search the web. It must stay FIRST and stable
  // across turns to keep the cacheable tools prefix byte-identical (mirrors
  // Reasonix responses.go web-search handling). The remaining tools are sorted
  // deterministically by name so the prefix never depends on the caller's
  // array order (defense-in-depth: the chat-format converter already sorts,
  // but the invariant must hold locally for every Responses request).
  const normalizedTools = [...normalizeResponsesToolsFromChat(chatRequest.tools)]
    .sort((a, b) => {
      const nameA = toString(a?.name);
      const nameB = toString(b?.name);
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      const serializedA = JSON.stringify(a ?? null);
      const serializedB = JSON.stringify(b ?? null);
      if (serializedA !== serializedB) return serializedA < serializedB ? -1 : 1;
      return 0;
    });
  const responseTools = isDeepSeek
    ? [{ type: 'web_search' }, ...normalizedTools]
    : normalizedTools;
  if (responseTools.length > 0) {
    request.tools = responseTools;
  }
  const explicitToolChoice = chatRequest.tool_choice;
  if (explicitToolChoice !== undefined) {
    request.tool_choice = normalizeResponsesToolChoiceFromChat(explicitToolChoice);
  } else if (isDeepSeek && responseTools.length > 0) {
    // Default to auto so the model decides when to invoke web_search.
    request.tool_choice = 'auto';
  }

  // DeepSeek Responses API controls reasoning depth via `reasoning.effort`,
  // distinct from chat/completions' top-level reasoning_effort / thinking. Map
  // the chat-style controls into the Responses reasoning object so effort set
  // on the model preset (or by the caller) still applies. The API defaults to
  // thinking ON (effort 'high') when `reasoning` is omitted, so disabling
  // thinking requires an explicit { effort: 'none' } — omitting the field
  // silently turns thinking back on.
  if (isDeepSeek) {
    const thinking = toOptionalObject(chatRequest.thinking);
    const thinkingEnabled = toString(thinking?.type).toLowerCase() !== 'disabled';
    const rawEffort = toString(chatRequest.reasoning_effort)
      || toString(toOptionalObject(chatRequest.output_config)?.effort);
    // 'off'/'none' effort requests disable thinking just like thinking.disabled;
    // empty effort keeps the 'high' default (matches Reasonix default).
    const effort = thinkingEnabled
      ? (normalizeDeepSeekResponsesEffort(rawEffort) ?? (rawEffort ? 'none' : 'high'))
      : 'none';
    request.reasoning = { effort };
  } else if (thinkingWireFamily(toString(chatRequest.model)) === 'glm') {
    // GLM family on a Responses endpoint (zhipu open.bigmodel.cn, z.ai, and
    // any relay serving glm-* ids). The 2026-09-20 dream-fragment outage: this
    // branch did not exist, so a caller's thinking:{type:'disabled'} was
    // silently dropped, GLM-5.x kept thinking at its default effort, and the
    // hidden reasoning consumed the whole max_output_tokens budget
    // (stop_reason=max_tokens, blocks=none). Map the toggle explicitly —
    // GLM-5.x cannot disable (effort 'none' is a 400, code 1210), so "off"
    // becomes the lowest tier; GLM-4.x honors 'none'. An enabled toggle with
    // a small budget_tokens maps to 'low' so a caller's low-effort intent
    // survives the wire translation.
    const glmModel = toString(chatRequest.model);
    const thinking = toOptionalObject(chatRequest.thinking);
    const thinkingType = toString(thinking?.type).toLowerCase();
    const thinkingBudget = toNumber((thinking as { budget_tokens?: unknown } | null)?.budget_tokens);
    if (thinkingType === 'disabled') {
      const effort = responsesEffortForThinkingOff(glmModel);
      if (effort) request.reasoning = { effort };
    } else if (thinkingType === 'enabled' && thinkingBudget != null && thinkingBudget > 0) {
      request.reasoning = { effort: thinkingBudget <= 4_000 ? 'low' : 'high' };
    }
  }

  const maxOutputTokens = toNumber(chatRequest.max_output_tokens)
    ?? toNumber(chatRequest.max_completion_tokens)
    ?? toNumber(chatRequest.max_tokens);
  if (maxOutputTokens !== null) {
    request.max_output_tokens = maxOutputTokens;
  }

  for (const message of toArray(chatRequest.messages)) {
    const messageObj = toOptionalObject(message);
    if (!messageObj) {
      continue;
    }

    const role = toString(messageObj.role);
    if (role === 'system') {
      const text = extractTextFromChatContent(messageObj.content);
      if (text) {
        instructions.push(text);
      }
      continue;
    }

    if (role === 'tool') {
      const toolCallId = toString(messageObj.tool_call_id);
      // N1 scheme-B: degrade image blocks persisted in old tool_results before
      // they are forwarded to a non-vision model.
      const toolContent = supportsVision
        ? messageObj.content
        : sanitizeToolContentForNonVisionModel(messageObj.content);
      const output = stringifyUnknown(toolContent);
      if (toolCallId && output) {
        input.push({
          type: 'function_call_output',
          call_id: toolCallId,
          output,
        });
      }
      continue;
    }

    if (role === 'assistant') {
      const text = extractTextFromChatContent(messageObj.content);
      const toolCalls = toArray(messageObj.tool_calls);
      const hasToolCalls = toolCalls.length > 0;

      // DeepSeek's Responses API requires the assistant's chain-of-thought to
      // be passed back as a `reasoning` input item whenever the turn made tool
      // calls (thinking mode; empty reasoning text is rejected with a 400).
      // `reasoning_content` was hydrated onto the message by
      // hydrateDeepSeekReasoningForRequest (or replayed as thinking blocks);
      // unrecoverable reasoning falls back to a constant placeholder so the
      // request stays valid and the cached prefix stays byte-stable. For
      // non-DeepSeek Responses providers (OpenAI etc.) plain-text reasoning
      // items are not part of their contract, so we only emit them for
      // DeepSeek models.
      if (isDeepSeek) {
        const reasoningContent = toString(messageObj.reasoning_content) || toString(messageObj.reasoning);
        const effectiveReasoning = reasoningContent
          || (hasToolCalls ? DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER : '');
        if (effectiveReasoning) {
          input.push({
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: effectiveReasoning }],
          });
        }
      }

      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }

      for (const toolCall of toolCalls) {
        const toolCallObj = toOptionalObject(toolCall);
        const functionObj = toOptionalObject(toolCallObj?.function);
        if (!toolCallObj || !functionObj) {
          continue;
        }
        const callId = toString(toolCallObj.call_id) || toString(toolCallObj.id);
        const name = toString(functionObj.name);
        const argumentsText = normalizeFunctionArguments(functionObj.arguments) || '{}';
        if (!callId || !name) {
          continue;
        }

        const functionCallItem: Record<string, unknown> = {
          type: 'function_call',
          call_id: callId,
          name,
          arguments: argumentsText,
        };
        const extraContent = normalizeToolCallExtraContent(toolCallObj);
        if (extraContent !== undefined) {
          functionCallItem.extra_content = extraContent;
        }
        input.push(functionCallItem);
        unresolvedFunctionCalls.set(callId, {
          name,
          hasOutput: false,
        });
      }
      continue;
    }

    const userParts = convertUserChatContentToResponsesInput(messageObj.content, supportsVision);
    if (userParts.length > 0) {
      input.push({
        role: role || 'user',
        content: userParts,
      });
    }
  }

  if (instructions.length > 0 || isDeepSeek) {
    const instructionParts = [...instructions];
    if (isDeepSeek) {
      // DeepSeek Responses requests always carry the injected web_search tool;
      // the guard makes the model search instead of confidently fabricating
      // real-time facts, and mark results it cannot verify as unverified.
      instructionParts.push(DEEPSEEK_WEB_SEARCH_INTEGRITY_GUARD);
    }
    request.instructions = instructionParts.join('\n\n');
  }

  for (const messageItem of input) {
    if (toString(messageItem.type) !== 'function_call_output') {
      continue;
    }
    const callId = toString(messageItem.call_id);
    if (!callId) {
      continue;
    }
    const existing = unresolvedFunctionCalls.get(callId);
    if (existing) {
      existing.hasOutput = true;
      unresolvedFunctionCalls.set(callId, existing);
    }
  }

  for (const [callId, callInfo] of unresolvedFunctionCalls.entries()) {
    if (callInfo.hasOutput) {
      continue;
    }
    // OpenAI Responses requires each historical function_call to have a matching output.
    // When upstream tool execution fails before producing a tool_result, auto-close it here.
    input.push({
      type: 'function_call_output',
      call_id: callId,
      output: JSON.stringify({
        error: `Missing tool output for function call "${callId}" (${callInfo.name || 'unknown'}). Auto-closed by compatibility proxy.`,
      }),
    });
  }

  request.input = input;

  return request;
}

function normalizeToolName(value: unknown): string {
  return toString(value).trim().toLowerCase();
}

/**
 * Normalize a reasoning-effort string for the DeepSeek Responses API.
 * DeepSeek Responses accepts: low (flash only), high, max. "off"/empty → undefined
 * (caller decides default). Unknown values map to the closest valid bucket.
 */
function normalizeDeepSeekResponsesEffort(effort: string): 'low' | 'high' | 'max' | undefined {
  const normalized = effort.trim().toLowerCase();
  if (!normalized || normalized === 'off' || normalized === 'none') {
    return undefined;
  }
  if (normalized === 'max' || normalized === 'high' || normalized === 'low') {
    return normalized;
  }
  if (normalized === 'medium') {
    return 'high';
  }
  return 'high';
}

function filterOpenAIToolsForProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }

  const tools = toArray(openAIRequest.tools);
  if (tools.length === 0) {
    return;
  }

  const filteredTools = tools.filter((tool) => {
    const toolObj = toOptionalObject(tool);
    if (!toolObj) return true;
    const functionObj = toOptionalObject(toolObj.function);
    const toolName = normalizeToolName(toolObj.name) || normalizeToolName(functionObj?.name);
    if (!toolName) return true;
    // OpenAI path should use skills by reading SKILL.md via normal tools, not Skill tool.
    return toolName !== 'skill';
  });

  if (filteredTools.length !== tools.length) {
    openAIRequest.tools = filteredTools;
    const toolChoiceObj = toOptionalObject(openAIRequest.tool_choice);
    if (toolChoiceObj) {
      const forcedName = normalizeToolName(toolChoiceObj.name)
        || normalizeToolName(toOptionalObject(toolChoiceObj.function)?.name);
      if (forcedName === 'skill') {
        openAIRequest.tool_choice = 'auto';
      }
    }
  }
}

function extractMaxTokensRange(errorMessage: string): { min: number; max: number } | null {
  if (!errorMessage) {
    return null;
  }

  const normalized = errorMessage.toLowerCase();
  if (!normalized.includes('max_tokens')) {
    return null;
  }

  const bracketMatch = /max_tokens[^\[]*\[\s*(\d+)\s*,\s*(\d+)\s*\]/i.exec(errorMessage);
  if (bracketMatch) {
    return {
      min: Number(bracketMatch[1]),
      max: Number(bracketMatch[2]),
    };
  }

  const betweenMatch = /max_tokens.*between\s+(\d+)\s*(?:and|-)\s*(\d+)/i.exec(errorMessage);
  if (betweenMatch) {
    return {
      min: Number(betweenMatch[1]),
      max: Number(betweenMatch[2]),
    };
  }

  return null;
}

function clampMaxTokensFromError(
  openAIRequest: Record<string, unknown>,
  errorMessage: string
): { changed: boolean; clampedTo?: number } {
  const currentMaxTokens = openAIRequest.max_tokens;
  if (typeof currentMaxTokens !== 'number' || !Number.isFinite(currentMaxTokens)) {
    return { changed: false };
  }

  const range = extractMaxTokensRange(errorMessage);
  if (!range) {
    return { changed: false };
  }

  const normalizedMin = Math.max(1, Math.floor(range.min));
  const normalizedMax = Math.max(normalizedMin, Math.floor(range.max));
  const nextValue = Math.min(Math.max(Math.floor(currentMaxTokens), normalizedMin), normalizedMax);

  if (nextValue === currentMaxTokens) {
    return { changed: false };
  }

  openAIRequest.max_tokens = nextValue;
  return { changed: true, clampedTo: nextValue };
}

function shouldUseMaxCompletionTokensForModel(model: unknown): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const normalizedModel = model.toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return resolvedModel.startsWith('gpt-5')
    || resolvedModel.startsWith('o1')
    || resolvedModel.startsWith('o3')
    || resolvedModel.startsWith('o4');
}

function normalizeMaxTokensFieldForOpenAIProvider(
  openAIRequest: Record<string, unknown>,
  provider?: string
): void {
  if (provider !== 'openai') {
    return;
  }
  if (!shouldUseMaxCompletionTokensForModel(openAIRequest.model)) {
    return;
  }
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return;
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
}

function isMaxTokensUnsupportedError(errorMessage: string): boolean {
  const normalized = errorMessage.toLowerCase();
  return normalized.includes('max_tokens')
    && normalized.includes('max_completion_tokens')
    && normalized.includes('not supported');
}

function convertMaxTokensToMaxCompletionTokens(
  openAIRequest: Record<string, unknown>
): { changed: boolean; convertedTo?: number } {
  const maxTokens = openAIRequest.max_tokens;
  if (typeof maxTokens !== 'number' || !Number.isFinite(maxTokens)) {
    return { changed: false };
  }
  openAIRequest.max_completion_tokens = maxTokens;
  delete openAIRequest.max_tokens;
  return { changed: true, convertedTo: maxTokens };
}

function writeJSON(
  res: http.ServerResponse,
  statusCode: number,
  body: Record<string, unknown>
): void {
  const payload = JSON.stringify(body);
  try {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch {
    // The caller disconnected mid-request (socket destroyed); there is nobody
    // left to read this response, and a write-after-destroy must not crash the
    // proxy's error path itself.
  }
}

/**
 * Wrap an upstream transport exception into the 502 the caller sees. Always
 * coworkLogs it: exceptions that exhausted the transient-retry budget were
 * already logged per attempt, but a NON-transient transport code previously
 * only set lastProxyError and left zero trace in cowork.log — the 2026-09-28
 * dream failure (net::ERR_SSL_PROTOCOL_ERROR) was invisible in the logs for
 * exactly that reason.
 */
function writeUpstreamTransportError(res: http.ServerResponse, message: string): void {
  lastProxyError = message;
  coworkLog('WARN', 'upstream-transport-error', 'upstream request failed at the transport layer; returning 502 to the caller', {
    error: message,
  });
  writeJSON(res, 502, createAnthropicErrorBody(message));
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const decodeBody = (raw: Buffer): string => {
      if (raw.length === 0) {
        return '';
      }

      const collectStringValues = (input: unknown, out: string[]): void => {
        if (typeof input === 'string') {
          out.push(input);
          return;
        }
        if (Array.isArray(input)) {
          for (const item of input) collectStringValues(item, out);
          return;
        }
        if (input && typeof input === 'object') {
          for (const value of Object.values(input as Record<string, unknown>)) {
            collectStringValues(value, out);
          }
        }
      };

      const scoreDecodedJsonText = (text: string): number => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          return -10000;
        }

        const values: string[] = [];
        collectStringValues(parsed, values);
        const joined = values.join('\n');
        if (!joined) return 0;

        const cjkCount = (joined.match(/[\u3400-\u9FFF]/g) || []).length;
        const replacementCount = (joined.match(/\uFFFD/g) || []).length;
        const mojibakeCount = (joined.match(/[ÃÂÐÑØÙÞæçèéêëìíîïðñòóôõöøùúûüýþÿ]/g) || []).length;
        const nonAsciiCount = (joined.match(/[^\x00-\x7F]/g) || []).length;

        return cjkCount * 4 + nonAsciiCount - replacementCount * 8 - mojibakeCount * 3;
      };

      // BOM-aware decoding first.
      if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) {
        return new TextDecoder('utf-8', { fatal: false }).decode(raw.subarray(3));
      }
      if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe) {
        return new TextDecoder('utf-16le', { fatal: false }).decode(raw.subarray(2));
      }
      if (raw.length >= 2 && raw[0] === 0xfe && raw[1] === 0xff) {
        return new TextDecoder('utf-16be', { fatal: false }).decode(raw.subarray(2));
      }

      // Try strict UTF-8 first.
      let utf8Decoded: string | null = null;
      try {
        utf8Decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw);
      } catch {
        utf8Decoded = null;
      }

      // On Windows local shells (especially Git Bash/curl paths), requests
      // may be emitted in system codepage instead of UTF-8.
      if (process.platform === 'win32') {
        let gbDecoded: string | null = null;
        try {
          gbDecoded = new TextDecoder('gb18030', { fatal: true }).decode(raw);
        } catch {
          gbDecoded = null;
        }

        if (utf8Decoded && gbDecoded) {
          const utf8Score = scoreDecodedJsonText(utf8Decoded);
          const gbScore = scoreDecodedJsonText(gbDecoded);
          if (gbScore > utf8Score) {
            console.warn(`[CoworkProxy] Decoded request body using gb18030 (score ${gbScore} > utf8 ${utf8Score})`);
            return gbDecoded;
          }
          return utf8Decoded;
        }

        if (gbDecoded && !utf8Decoded) {
          console.warn('[CoworkProxy] Decoded request body using gb18030 fallback');
          return gbDecoded;
        }
      }

      if (utf8Decoded) {
        return utf8Decoded;
      }

      return new TextDecoder('utf-8', { fatal: false }).decode(raw);
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > 20 * 1024 * 1024) {
        fail(new Error('Request body too large'));
        // Do NOT destroy the socket here: the caller still needs to answer
        // (413). The settled guard above makes every further chunk a no-op,
        // so the oversized body drains to the floor while the error response
        // reaches the client (destroying first would EPIPE the caller).
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      if (settled) return;
      settled = true;
      const body = decodeBody(Buffer.concat(chunks));
      resolve(body);
    });

    req.on('error', (error) => {
      fail(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

function createStreamState(options: StreamStateOptions = {}): StreamState {
  return {
    messageId: null,
    model: null,
    contentIndex: 0,
    currentBlockType: null,
    activeToolIndex: null,
    hasMessageStart: false,
    hasMessageStop: false,
    toolCalls: {},
    preserveDeepSeekReasoning: Boolean(options.preserveDeepSeekReasoning),
    currentDeepSeekReasoningContent: '',
    pendingStopReason: null,
    collectedUsage: null,
  };
}

function createResponsesStreamContext(): ResponsesStreamContext {
  return {
    functionCallByOutputIndex: new Map<number, ResponsesFunctionCallState>(),
    functionCallByCallId: new Map<string, ResponsesFunctionCallState>(),
    functionCallByItemId: new Map<string, ResponsesFunctionCallState>(),
    nextToolIndex: 0,
    hasAnyDelta: false,
    hasReasoningDeltas: false,
    emittedWebSearchItemIds: new Set<string>(),
    accumulatedText: '',
    observedEventTypes: new Set<string>(),
  };
}

function resolveResponsesObject(body: unknown): Record<string, unknown> {
  const source = toOptionalObject(body);
  if (!source) {
    return {};
  }
  const nested = toOptionalObject(source.response);
  if (nested) {
    return nested;
  }
  return source;
}

function extractResponsesReasoningText(itemObj: Record<string, unknown>): string {
  const summaryTexts: string[] = [];
  for (const summaryItem of toArray(itemObj.summary)) {
    const summaryObj = toOptionalObject(summaryItem);
    if (!summaryObj) {
      continue;
    }
    const summaryText = toString(summaryObj.text);
    if (summaryText) {
      summaryTexts.push(summaryText);
    }
  }
  if (summaryTexts.length > 0) {
    return summaryTexts.join('');
  }

  const directText = toString(itemObj.text);
  if (directText) {
    return directText;
  }
  return '';
}

function detectResponsesFinishReason(responseObj: Record<string, unknown>): string {
  const output = toArray(responseObj.output);
  const hasFunctionCall = output.some((item) => toString(toOptionalObject(item)?.type) === 'function_call');
  if (hasFunctionCall) {
    return 'tool_calls';
  }

  const status = toString(responseObj.status);
  const incompleteReason = toString(toOptionalObject(responseObj.incomplete_details)?.reason);
  if (
    status === 'incomplete'
    && (incompleteReason === 'max_output_tokens' || incompleteReason === 'max_tokens')
  ) {
    return 'length';
  }
  return 'stop';
}

function convertResponsesToOpenAIResponse(body: unknown): Record<string, unknown> {
  const responseObj = resolveResponsesObject(body);
  const output = toArray(responseObj.output);

  const textParts: Array<{ type: 'text'; text: string }> = [];
  const reasoningParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    const itemObj = toOptionalObject(item);
    if (!itemObj) {
      continue;
    }

    const itemType = toString(itemObj.type);
    if (itemType === 'message') {
      for (const contentItem of toArray(itemObj.content)) {
        const contentObj = toOptionalObject(contentItem);
        if (!contentObj) {
          continue;
        }
        const contentType = toString(contentObj.type);
        if (contentType === 'output_text' || contentType === 'text' || contentType === 'input_text') {
          const text = toString(contentObj.text);
          if (text) {
            textParts.push({ type: 'text', text });
          }
        }
      }
      continue;
    }

    if (itemType === 'reasoning') {
      const reasoningText = extractResponsesReasoningText(itemObj);
      if (reasoningText) {
        reasoningParts.push(reasoningText);
      }
      continue;
    }

    if (itemType === 'function_call') {
      const callId = toString(itemObj.call_id) || toString(itemObj.id);
      const name = toString(itemObj.name);
      if (!callId || !name) {
        continue;
      }
      const toolCall: Record<string, unknown> = {
        id: callId,
        type: 'function',
        function: {
          name,
          arguments: normalizeFunctionArguments(itemObj.arguments) || '{}',
        },
      };
      const extraContent = normalizeToolCallExtraContent(itemObj);
      if (extraContent !== undefined) {
        toolCall.extra_content = extraContent;
      }
      toolCalls.push(toolCall);
    }
  }

  const message: Record<string, unknown> = {
    role: 'assistant',
  };
  if (textParts.length === 1 && textParts[0].type === 'text') {
    message.content = textParts[0].text;
  } else if (textParts.length > 1) {
    message.content = textParts;
  } else {
    message.content = null;
  }
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }
  if (reasoningParts.length > 0) {
    message.reasoning_content = reasoningParts.join('');
  }

  const usage = toOptionalObject(responseObj.usage);
  // DeepSeek Responses API reports cache hits under nested details objects
  // (input_tokens_details.cached_tokens / output_tokens_details.reasoning_tokens),
  // unlike chat/completions which uses top-level prompt_cache_hit_tokens. Map
  // both into the unified OpenAI-style usage so downstream token accounting is
  // consistent across the two API shapes.
  const inputTokensDetails = toOptionalObject(usage?.input_tokens_details);
  const outputTokensDetails = toOptionalObject(usage?.output_tokens_details);
  const promptTokens = toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0;
  const cacheHitTokens = toNumber(inputTokensDetails?.cached_tokens)
    ?? toNumber(usage?.prompt_cache_hit_tokens) ?? 0;
  // DeepSeek Responses reports input_tokens as the TOTAL input (cached + uncached).
  // Derive the miss so cache-read accounting stays truthful. If a relay already
  // provides an explicit miss value, prefer it.
  const explicitMiss = toNumber(usage?.prompt_cache_miss_tokens);
  const cacheMissTokens = explicitMiss ?? Math.max(promptTokens - cacheHitTokens, 0);
  return {
    id: toString(responseObj.id),
    model: toString(responseObj.model),
    choices: [
      {
        message,
        finish_reason: detectResponsesFinishReason(responseObj),
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
      prompt_cache_hit_tokens: cacheHitTokens,
      prompt_cache_miss_tokens: cacheMissTokens,
      // Surface reasoning token cost separately for diagnostics.
      reasoning_tokens: toNumber(outputTokensDetails?.reasoning_tokens) ?? 0,
    },
  };
}

function cacheToolCallExtraContentFromResponsesResponse(body: unknown): void {
  const responseObj = resolveResponsesObject(body);
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }
    const toolCallId = toString(itemObj.call_id) || toString(itemObj.id);
    const extraContent = normalizeToolCallExtraContent(itemObj);
    cacheToolCallExtraContent(toolCallId, extraContent);
  }
}

function emitSSE(res: http.ServerResponse, event: string, data: Record<string, unknown>): void {
  res.write(formatSSEEvent(event, data));
}

function closeCurrentBlockIfNeeded(res: http.ServerResponse, state: StreamState): void {
  if (!state.currentBlockType) {
    return;
  }

  emitSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index: state.contentIndex,
  });

  state.contentIndex += 1;
  state.currentBlockType = null;
  state.activeToolIndex = null;
}

function ensureMessageStart(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  if (state.hasMessageStart) {
    return;
  }

  state.messageId = chunk.id ?? state.messageId ?? `chatcmpl-${Date.now()}`;
  state.model = chunk.model ?? state.model ?? 'unknown';

  emitSSE(res, 'message_start', {
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.model,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
      },
    },
  });

  state.hasMessageStart = true;
}

function ensureThinkingBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'thinking') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'thinking',
      thinking: '',
    },
  });

  state.currentBlockType = 'thinking';
}

function ensureTextBlock(res: http.ServerResponse, state: StreamState): void {
  if (state.currentBlockType === 'text') {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: {
      type: 'text',
      text: '',
    },
  });

  state.currentBlockType = 'text';
}

function ensureToolUseBlock(
  res: http.ServerResponse,
  state: StreamState,
  index: number,
  toolCall: ToolCallState
): void {
  const resolvedId = toolCall.id || `tool_call_${index}`;
  const resolvedName = toolCall.name || 'tool';

  if (state.currentBlockType === 'tool_use' && state.activeToolIndex === index) {
    return;
  }

  closeCurrentBlockIfNeeded(res, state);

  const contentBlock: Record<string, unknown> = {
    type: 'tool_use',
    id: resolvedId,
    name: resolvedName,
  };

  if (toolCall.extraContent !== undefined) {
    contentBlock.extra_content = toolCall.extraContent;
  }

  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index: state.contentIndex,
    content_block: contentBlock,
  });

  state.currentBlockType = 'tool_use';
  state.activeToolIndex = index;
}

function emitMessageDelta(
  res: http.ServerResponse,
  state: StreamState,
  finishReason: string | null | undefined,
  chunk?: OpenAIStreamChunk
): void {
  closeCurrentBlockIfNeeded(res, state);

  // Prefer the chunk's own usage; fall back to the trailing usage-only chunk
  // collected on the stream state (stream_end emit path).
  const usage = chunk?.usage ?? state.collectedUsage;
  emitSSE(res, 'message_delta', {
    type: 'message_delta',
    delta: {
      stop_reason: mapStopReason(finishReason),
      stop_sequence: null,
    },
    usage: {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      // DeepSeek reports cache hits/misses at the top level of usage; map
      // them to Anthropic's cache fields so the SDK's result event carries
      // real per-turn token accounting for the cost display.
      cache_read_input_tokens: usage?.prompt_cache_hit_tokens ?? 0,
      cache_creation_input_tokens: usage?.prompt_cache_miss_tokens ?? 0,
    },
  });
}

function processOpenAIChunk(
  res: http.ServerResponse,
  state: StreamState,
  chunk: OpenAIStreamChunk
): void {
  ensureMessageStart(res, state, chunk);

  // A usage-only chunk (choices: []) is the OpenAI/DeepSeek convention for the
  // FINAL stream chunk when stream_options.include_usage=true. It carries the
  // per-request token/cache accounting that the SDK's result event consumes;
  // dropping it (the old behavior) left every proxy-streamed session with
  // zeroed usage and a broken cache-hit-rate panel. Emit the pending
  // message_delta here so the real numbers land on the SDK.
  if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
    state.collectedUsage = chunk.usage;
    if (state.pendingStopReason) {
      emitMessageDelta(res, state, state.pendingStopReason, chunk);
      state.pendingStopReason = null;
    }
    return;
  }

  const choice = chunk.choices?.[0];
  if (!choice) {
    return;
  }

  const delta = choice.delta;
  const deltaReasoning = delta?.reasoning_content ?? delta?.reasoning;

  if (deltaReasoning) {
    if (state.preserveDeepSeekReasoning) {
      state.currentDeepSeekReasoningContent += deltaReasoning;
      cacheDeepSeekReasoningForStreamToolCalls(state);
    }
    ensureThinkingBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'thinking_delta',
        thinking: deltaReasoning,
      },
    });
  }

  if (delta?.content) {
    ensureTextBlock(res, state);
    emitSSE(res, 'content_block_delta', {
      type: 'content_block_delta',
      index: state.contentIndex,
      delta: {
        type: 'text_delta',
        text: delta.content,
      },
    });
  }

  if (Array.isArray(delta?.tool_calls)) {
    for (const item of delta.tool_calls) {
      const toolIndex = item.index ?? 0;
      const existing = state.toolCalls[toolIndex] ?? {};
      const normalizedExtraContent = normalizeToolCallExtraContent(
        item as unknown as Record<string, unknown>
      );
      if (normalizedExtraContent !== undefined) {
        existing.extraContent = normalizedExtraContent;
      }
      if (state.preserveDeepSeekReasoning && state.currentDeepSeekReasoningContent) {
        existing.extraContent = attachDeepSeekReasoningToExtraContent(
          existing.extraContent,
          state.currentDeepSeekReasoningContent
        );
      }

      if (item.id) {
        existing.id = item.id;
      }
      if (item.function?.name) {
        existing.name = item.function.name;
      }
      state.toolCalls[toolIndex] = existing;
      if (existing.id && existing.extraContent !== undefined) {
        cacheToolCallExtraContent(existing.id, existing.extraContent);
      }
      if (existing.id && state.preserveDeepSeekReasoning && state.currentDeepSeekReasoningContent) {
        cacheDeepSeekReasoningForToolCall(existing.id, state.currentDeepSeekReasoningContent);
      }

      if (item.function?.name) {
        ensureToolUseBlock(res, state, toolIndex, existing);
      }

      if (item.function?.arguments) {
        ensureToolUseBlock(res, state, toolIndex, existing);
        emitSSE(res, 'content_block_delta', {
          type: 'content_block_delta',
          index: state.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: item.function.arguments,
          },
        });
      }
    }
  }

  if (choice.finish_reason) {
    if (chunk.usage) {
      // Provider attaches usage directly to the finish chunk (Responses path):
      // emit immediately with the real numbers.
      emitMessageDelta(res, state, choice.finish_reason, chunk);
    } else {
      // OpenAI/DeepSeek convention: usage arrives in a SEPARATE trailing chunk
      // with an empty choices array. Hold the stop reason and emit the
      // message_delta when that chunk lands (or at stream end) so the SDK's
      // result usage carries the provider's real accounting instead of zeros.
      state.pendingStopReason = choice.finish_reason;
    }
  }
}

function parseSSEPacket(packet: string): { event: string; payload: string } {
  const lines = packet.split(/\r?\n/);
  const dataLines: string[] = [];
  let event = '';

  for (const line of lines) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trimStart();
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  return {
    event,
    payload: dataLines.join('\n'),
  };
}

function findSSEPacketBoundary(
  buffer: string
): { index: number; separatorLength: number } | null {
  const match = /\r?\n\r?\n/.exec(buffer);
  if (!match || typeof match.index !== 'number') {
    return null;
  }

  return {
    index: match.index,
    separatorLength: match[0].length,
  };
}

function extractResponsesFunctionCallMetadata(
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): {
  outputIndex: number | null;
  callId: string;
  itemId: string;
  name: string;
  extraContent: unknown;
} {
  const outputIndex = toNumber(payloadObj.output_index) ?? toNumber(itemObj?.output_index);
  const callId = toString(payloadObj.call_id) || toString(itemObj?.call_id);
  const itemId = toString(payloadObj.item_id) || toString(itemObj?.id);
  const name = toString(payloadObj.name) || toString(itemObj?.name);
  const extraContent = itemObj ? normalizeToolCallExtraContent(itemObj) : undefined;
  return {
    outputIndex,
    callId,
    itemId,
    name,
    extraContent,
  };
}

function registerResponsesFunctionCallState(
  context: ResponsesStreamContext,
  payloadObj: Record<string, unknown>,
  itemObj: Record<string, unknown> | null
): ResponsesFunctionCallState {
  const metadata = extractResponsesFunctionCallMetadata(payloadObj, itemObj);

  let callState = metadata.callId
    ? context.functionCallByCallId.get(metadata.callId)
    : undefined;
  if (!callState && metadata.itemId) {
    callState = context.functionCallByItemId.get(metadata.itemId);
  }
  if (!callState && metadata.outputIndex !== null) {
    callState = context.functionCallByOutputIndex.get(metadata.outputIndex);
  }

  if (!callState) {
    const outputIndex = metadata.outputIndex !== null
      ? metadata.outputIndex
      : context.nextToolIndex;
    callState = {
      outputIndex,
      callId: '',
      itemId: '',
      name: '',
      extraContent: undefined,
      argumentsBuffer: '',
      finalArguments: '',
      emitted: false,
      metadataEmitted: false,
    };
    context.functionCallByOutputIndex.set(outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, outputIndex + 1);
  } else if (metadata.outputIndex !== null && callState.outputIndex !== metadata.outputIndex) {
    context.functionCallByOutputIndex.delete(callState.outputIndex);
    callState.outputIndex = metadata.outputIndex;
    context.functionCallByOutputIndex.set(callState.outputIndex, callState);
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  } else {
    context.nextToolIndex = Math.max(context.nextToolIndex, callState.outputIndex + 1);
  }

  if (metadata.callId) {
    callState.callId = metadata.callId;
    context.functionCallByCallId.set(metadata.callId, callState);
  }
  if (metadata.itemId) {
    callState.itemId = metadata.itemId;
    context.functionCallByItemId.set(metadata.itemId, callState);
  }
  if (metadata.name) {
    callState.name = metadata.name;
  }
  if (metadata.extraContent !== undefined) {
    callState.extraContent = metadata.extraContent;
  }

  context.functionCallByOutputIndex.set(callState.outputIndex, callState);
  return callState;
}

function syncToolCallStateWithResponsesFunctionCall(
  state: StreamState,
  callState: ResponsesFunctionCallState
): ToolCallState {
  const toolCall = state.toolCalls[callState.outputIndex] ?? {};
  if (callState.callId) {
    toolCall.id = callState.callId;
  } else if (callState.itemId) {
    toolCall.id = callState.itemId;
  } else if (!toolCall.id) {
    toolCall.id = `tool_call_${callState.outputIndex}`;
  }
  if (callState.name) {
    toolCall.name = callState.name;
  }
  if (callState.extraContent !== undefined) {
    toolCall.extraContent = callState.extraContent;
  }
  state.toolCalls[callState.outputIndex] = toolCall;
  if (toolCall.id && toolCall.extraContent !== undefined) {
    cacheToolCallExtraContent(toolCall.id, toolCall.extraContent);
  }
  return toolCall;
}

function emitResponsesFunctionCallChunk(
  res: http.ServerResponse,
  state: StreamState,
  callState: ResponsesFunctionCallState,
  options: {
    includeName: boolean;
    argumentsText?: string;
    responseId?: string;
    model?: string;
  }
): void {
  const toolCall = syncToolCallStateWithResponsesFunctionCall(state, callState);

  const functionObj: Record<string, unknown> = {};
  if (options.includeName && toolCall.name) {
    functionObj.name = toolCall.name;
  }

  const argumentsText = options.argumentsText ?? '';
  if (argumentsText) {
    functionObj.arguments = argumentsText;
  }

  if (Object.keys(functionObj).length === 0) {
    return;
  }

  processOpenAIChunk(res, state, {
    id: options.responseId || undefined,
    model: options.model || undefined,
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: callState.outputIndex,
              id: toolCall.id,
              type: 'function',
              function: functionObj,
            },
          ],
        },
      },
    ],
  });
}

function emitResponsesFunctionCallMetadataOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  responseId?: string,
  model?: string
): void {
  if (callState.metadataEmitted) {
    return;
  }
  if (!callState.name) {
    return;
  }

  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    responseId,
    model,
  });
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

function emitResponsesFunctionCallArgumentsOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  callState: ResponsesFunctionCallState,
  argumentsText: string,
  responseId?: string,
  model?: string
): void {
  if (callState.emitted) {
    return;
  }

  const resolvedArguments = argumentsText
    || callState.finalArguments
    || callState.argumentsBuffer
    || '{}';
  if (!resolvedArguments) {
    return;
  }

  callState.finalArguments = resolvedArguments;
  emitResponsesFunctionCallChunk(res, state, callState, {
    includeName: true,
    argumentsText: resolvedArguments,
    responseId,
    model,
  });
  callState.emitted = true;
  callState.metadataEmitted = true;
  context.hasAnyDelta = true;
}

/**
 * Relay a server-side `web_search_call` output item as an Anthropic
 * `server_tool_use` content block, so the SDK context records that a web
 * search actually ran (mirrors cognitiveChatCompletion marking response
 * metadata with 'web_search'). Upstreams (opencode gateway, api.deepseek.com)
 * do NOT embed search_results in the item, so the block carries an empty
 * input — its purpose is the search marker, not the result text. Emitted
 * exactly once per item id (output_item.added/done pairs + completed fallback
 * all funnel here).
 */
function emitResponsesWebSearchBlockOnce(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  itemObj: Record<string, unknown>
): void {
  const itemId = toString(itemObj.id);
  if (!itemId || context.emittedWebSearchItemIds.has(itemId)) {
    return;
  }
  context.emittedWebSearchItemIds.add(itemId);
  context.hasAnyDelta = true;

  // The block is real stream content: make sure message_start exists even if
  // this was the first event of the stream.
  ensureMessageStart(res, state, {});
  closeCurrentBlockIfNeeded(res, state);

  const index = state.contentIndex;
  emitSSE(res, 'content_block_start', {
    type: 'content_block_start',
    index,
    content_block: {
      type: 'server_tool_use',
      id: itemId,
      name: 'web_search',
      input: {},
    },
  });
  emitSSE(res, 'content_block_stop', {
    type: 'content_block_stop',
    index,
  });

  state.contentIndex = index + 1;
  state.currentBlockType = null;
  state.activeToolIndex = null;
}

/**
 * Non-stream path: inject web_search_call items from the Responses output as
 * `server_tool_use` blocks into the Anthropic-shaped response, placed before
 * the answer text (the search precedes the answer). The streaming path relays
 * the same marker per output_item.done event instead.
 */
function injectResponsesWebSearchBlocks(
  anthropicResponse: Record<string, unknown>,
  upstreamJSON: unknown
): void {
  const responseObj = resolveResponsesObject(upstreamJSON);
  const blocks: Array<Record<string, unknown>> = [];
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (toString(itemObj?.type) !== 'web_search_call') {
      continue;
    }
    const itemId = toString(itemObj?.id);
    if (!itemId) {
      continue;
    }
    blocks.push({
      type: 'server_tool_use',
      id: itemId,
      name: 'web_search',
      input: {},
    });
  }
  if (blocks.length === 0) {
    return;
  }

  const content = Array.isArray(anthropicResponse.content)
    ? anthropicResponse.content
    : [];
  const firstTextIndex = content.findIndex(
    (block) => toString(toOptionalObject(block)?.type) === 'text'
  );
  const insertAt = firstTextIndex === -1 ? content.length : firstTextIndex;
  content.splice(insertAt, 0, ...blocks);
  anthropicResponse.content = content;
}

function emitResponsesCompletedFunctionCalls(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  responseObj: Record<string, unknown>
): void {
  const responseId = toString(responseObj.id);
  const model = toString(responseObj.model);

  for (const [index, item] of toArray(responseObj.output).entries()) {
    const itemObj = toOptionalObject(item);
    if (!itemObj || toString(itemObj.type) !== 'function_call') {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: responseId,
      model,
      call_id: toString(itemObj.call_id),
      item_id: toString(itemObj.id),
      name: toString(itemObj.name),
    };
    const itemOutputIndex = toNumber(itemObj.output_index);
    if (itemOutputIndex !== null) {
      payloadObj.output_index = itemOutputIndex;
    } else {
      payloadObj.output_index = index;
    }

    const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      responseId,
      model
    );

    const finalizedArguments = normalizeFunctionArguments(itemObj.arguments)
      || callState.finalArguments
      || callState.argumentsBuffer
      || '{}';
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      finalizedArguments,
      responseId,
      model
    );
  }
}

function emitResponsesFallbackContent(
  res: http.ServerResponse,
  state: StreamState,
  responseObj: Record<string, unknown>,
  context: ResponsesStreamContext
): void {
  // Server-side web searches recorded in the final output are relayed as
  // server_tool_use blocks even when no deltas streamed (truncated stream that
  // only produced response.completed). Deduped by item id, so the marker is
  // not duplicated when the regular output_item.done path already emitted it.
  for (const item of toArray(responseObj.output)) {
    const itemObj = toOptionalObject(item);
    if (toString(itemObj?.type) === 'web_search_call') {
      emitResponsesWebSearchBlockOnce(res, state, context, itemObj);
    }
  }

  const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(responseObj);
  const firstChoice = toOptionalObject(toArray(syntheticOpenAIResponse.choices)[0]);
  const message = toOptionalObject(firstChoice?.message);
  if (!message) {
    return;
  }

  const reasoning = toString(message.reasoning_content) || toString(message.reasoning);
  if (reasoning) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { reasoning } }],
    });
  }

  const messageContent = message.content;
  if (typeof messageContent === 'string' && messageContent) {
    processOpenAIChunk(res, state, {
      id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      choices: [{ delta: { content: messageContent } }],
    });
  } else if (Array.isArray(messageContent)) {
    for (const part of messageContent) {
      const partObj = toOptionalObject(part);
      const text = toString(partObj?.text);
      if (text) {
        processOpenAIChunk(res, state, {
          id: toString(syntheticOpenAIResponse.id),
          model: toString(syntheticOpenAIResponse.model),
          choices: [{ delta: { content: text } }],
        });
      }
    }
  }

  for (const toolCall of toArray(message.tool_calls)) {
    const toolCallObj = toOptionalObject(toolCall);
    const functionObj = toOptionalObject(toolCallObj?.function);
    if (!toolCallObj || !functionObj) {
      continue;
    }

    const payloadObj: Record<string, unknown> = {
      response_id: toString(syntheticOpenAIResponse.id),
      model: toString(syntheticOpenAIResponse.model),
      call_id: toString(toolCallObj.id),
      name: toString(functionObj.name),
    };
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    emitResponsesFunctionCallMetadataOnce(
      res,
      state,
      context,
      callState,
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      toString(functionObj.arguments) || '{}',
      toString(syntheticOpenAIResponse.id),
      toString(syntheticOpenAIResponse.model)
    );
  }
}

/**
 * Emit a one-line per-response summary of the DeepSeek reasoning_content
 * capture pipeline. Gated by DEEPSEEK_REASONING_DIAGNOSTIC (default OFF) so it
 * is free when disabled — the entire body (Set iteration, store lookups,
 * string/array building, log I/O) only runs with the flag on. Reveals, per
 * upstream response:
 *   - the distinct SSE event types seen (Responses path) — surfaces event
 *     names the proxy may not handle, or confirms reasoning events were absent;
 *   - whether any reasoning delta arrived and how many chars were captured;
 *   - per tool-call id whether its reasoning ended up in the persistent cache.
 */
function emitDeepSeekReasoningDiagnostic(
  tag: string,
  state: StreamState,
  context: ResponsesStreamContext | null,
  details?: { finishReason?: string | null | undefined }
): void {
  if (!DEEPSEEK_REASONING_DIAGNOSTIC) return;
  if (!state.preserveDeepSeekReasoning) return;
  const toolCallIds: string[] = [];
  const cachedIds: string[] = [];
  const missedIds: string[] = [];
  for (const tc of Object.values(state.toolCalls)) {
    if (!tc.id) continue;
    toolCallIds.push(tc.id);
    if (deepSeekReasoningStore.get(tc.id)) cachedIds.push(tc.id);
    else missedIds.push(tc.id);
  }
  coworkLog('DEBUG', 'deepseek-reasoning-diag', 'per-response reasoning capture summary', {
    path: tag,
    observedEventTypes: context ? [...context.observedEventTypes].sort() : null,
    hasReasoningDeltas: context ? context.hasReasoningDeltas : null,
    reasoningContentLen: state.currentDeepSeekReasoningContent.length,
    toolCallCount: toolCallIds.length,
    cachedCount: cachedIds.length,
    missedCount: missedIds.length,
    missedIds,
    finishReason: details?.finishReason ?? null,
  });
}

function processResponsesStreamEvent(
  res: http.ServerResponse,
  state: StreamState,
  context: ResponsesStreamContext,
  event: string,
  payloadObj: Record<string, unknown>
): void {
  const eventType = event || toString(payloadObj.type);
  if (DEEPSEEK_REASONING_DIAGNOSTIC && eventType) {
    context.observedEventTypes.add(eventType);
  }

  const responseObjFromPayload = toOptionalObject(payloadObj.response);
  if (responseObjFromPayload) {
    processOpenAIChunk(res, state, {
      id: toString(responseObjFromPayload.id),
      model: toString(responseObjFromPayload.model),
      choices: [],
    });
  }

  if (eventType === 'response.created') {
    return;
  }

  if (eventType === 'response.output_text.delta' || eventType === 'response.output.delta') {
    const textDelta = toString(payloadObj.delta);
    if (textDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { content: textDelta } }],
      });
      context.hasAnyDelta = true;
      context.accumulatedText += textDelta;
    }
    return;
  }

  if (
    eventType === 'response.reasoning_summary_text.delta'
    || eventType === 'response.reasoning.delta'
    // DeepSeek's Responses API streams chain-of-thought via
    // `response.reasoning_text.delta` (not the OpenAI summary events). Without
    // this handler the reasoning is silently dropped: the CLI never sees
    // thinking blocks, the reasoning store stays empty, and the next request
    // fails with "The `reasoning_text` in the thinking mode must be passed
    // back to the API".
    || eventType === 'response.reasoning_text.delta'
  ) {
    const thinkingDelta = toString(payloadObj.delta);
    if (thinkingDelta) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { reasoning: thinkingDelta } }],
      });
      context.hasAnyDelta = true;
      context.hasReasoningDeltas = true;
    }
    return;
  }

  if (
    eventType === 'response.reasoning_text.done'
    || eventType === 'response.reasoning_summary_text.done'
  ) {
    // Some providers emit the full reasoning only on the `*_done` event. Skip
    // when deltas already streamed it to avoid duplicating the chain-of-thought.
    if (context.hasReasoningDeltas) {
      return;
    }
    const fullReasoning = toString(payloadObj.text) || toString(payloadObj.summary);
    if (fullReasoning) {
      processOpenAIChunk(res, state, {
        id: toString(payloadObj.response_id),
        model: toString(payloadObj.model),
        choices: [{ delta: { reasoning: fullReasoning } }],
      });
      context.hasAnyDelta = true;
    }
    return;
  }

  if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    const itemObj = toOptionalObject(payloadObj.item);
    if (!itemObj) {
      return;
    }

    if (toString(itemObj.type) === 'function_call') {
      const callState = registerResponsesFunctionCallState(context, payloadObj, itemObj);
      const responseId = toString(payloadObj.response_id);
      const model = toString(payloadObj.model);
      emitResponsesFunctionCallMetadataOnce(
        res,
        state,
        context,
        callState,
        responseId,
        model
      );

      if (eventType === 'response.output_item.done' && !callState.emitted) {
        const inlineArguments = normalizeFunctionArguments(itemObj.arguments);
        if (inlineArguments) {
          emitResponsesFunctionCallArgumentsOnce(
            res,
            state,
            context,
            callState,
            inlineArguments,
            responseId,
            model
          );
        }
      }
    } else if (toString(itemObj.type) === 'web_search_call') {
      // Server-side web search (DeepSeek Responses / opencode gateway). Relay
      // it as an Anthropic server_tool_use block once the item completes; the
      // search marker must reach the SDK context so a search-backed answer is
      // distinguishable from a bare training-memory answer.
      if (eventType === 'response.output_item.done') {
        emitResponsesWebSearchBlockOnce(res, state, context, itemObj);
      }
    }
    return;
  }

  if (eventType === 'response.function_call_arguments.delta') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDelta = normalizeFunctionArguments(payloadObj.delta);
    if (!argumentsDelta) {
      return;
    }
    callState.argumentsBuffer += argumentsDelta;
    return;
  }

  if (eventType === 'response.function_call_arguments.done') {
    const callState = registerResponsesFunctionCallState(context, payloadObj, null);
    const argumentsDone = normalizeFunctionArguments(payloadObj.arguments)
      || callState.argumentsBuffer
      || '{}';
    callState.finalArguments = argumentsDone;
    emitResponsesFunctionCallArgumentsOnce(
      res,
      state,
      context,
      callState,
      argumentsDone,
      toString(payloadObj.response_id),
      toString(payloadObj.model)
    );
    return;
  }

  if (eventType === 'response.completed') {
    const responseObj = resolveResponsesObject(payloadObj);
    if (!context.hasAnyDelta) {
      emitResponsesFallbackContent(res, state, responseObj, context);
    }
    emitResponsesCompletedFunctionCalls(res, state, context, responseObj);

    const usage = toOptionalObject(responseObj.usage);
    // Responses API reports cache hits under input_tokens_details.cached_tokens;
    // map into the unified chunk usage so cost/cache accounting works in streams.
    const inputTokensDetails = toOptionalObject(usage?.input_tokens_details);
    const outputTokensDetails = toOptionalObject(usage?.output_tokens_details);
    const promptTokens = toNumber(usage?.input_tokens) ?? toNumber(usage?.prompt_tokens) ?? 0;
    const cacheHitTokens = toNumber(inputTokensDetails?.cached_tokens)
      ?? toNumber(usage?.prompt_cache_hit_tokens) ?? 0;
    const explicitMiss = toNumber(usage?.prompt_cache_miss_tokens);
    const cacheMissTokens = explicitMiss ?? Math.max(promptTokens - cacheHitTokens, 0);
    processOpenAIChunk(res, state, {
      id: toString(responseObj.id),
      model: toString(responseObj.model),
      choices: [{ finish_reason: detectResponsesFinishReason(responseObj) }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: toNumber(usage?.output_tokens) ?? toNumber(usage?.completion_tokens) ?? 0,
        prompt_cache_hit_tokens: cacheHitTokens,
        prompt_cache_miss_tokens: cacheMissTokens,
        reasoning_tokens: toNumber(outputTokensDetails?.reasoning_tokens) ?? 0,
      },
    });
    if (DEEPSEEK_REASONING_DIAGNOSTIC) {
      emitDeepSeekReasoningDiagnostic('responses', state, context, {
        finishReason: detectResponsesFinishReason(responseObj),
      });
    }
  }
}

async function handleResponsesStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse,
  provider?: string,
  baseURL?: string,
  model?: string
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState({
    preserveDeepSeekReasoning: isDeepSeekProvider(provider, baseURL, model),
  });
  const context = createResponsesStreamContext();

  let buffer = '';
  let sawDoneMarker = false;

  const flushDone = () => {
    if (!state.hasMessageStart) {
      return;
    }
    if (!state.hasMessageStop) {
      closeCurrentBlockIfNeeded(res, state);
      if (state.pendingStopReason) {
        // The provider never sent a trailing usage-only chunk (or sent it
        // before the finish chunk): emit the held message_delta now with
        // whatever usage was collected (possibly none).
        emitMessageDelta(res, state, state.pendingStopReason);
        state.pendingStopReason = null;
      }
      emitSSE(res, 'message_stop', {
        type: 'message_stop',
      });
      state.hasMessageStop = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const parsedPacket = parseSSEPacket(packet);
      const payload = parsedPacket.payload;
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as Record<string, unknown>;
        processResponsesStreamEvent(res, state, context, parsedPacket.event, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
  }

  flushDone();
  res.end();
}

async function handleChatCompletionsStreamResponse(
  upstreamResponse: Response,
  res: http.ServerResponse,
  provider?: string,
  baseURL?: string,
  model?: string
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  if (!upstreamResponse.body) {
    emitSSE(res, 'error', createAnthropicErrorBody('Upstream returned empty stream', 'stream_error'));
    res.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  const decoder = new TextDecoder();
  const state = createStreamState({
    preserveDeepSeekReasoning: isDeepSeekProvider(provider, baseURL, model),
  });

  let buffer = '';
  let sawDoneMarker = false;

  const flushDone = () => {
    if (!state.hasMessageStart) {
      return;
    }
    if (!state.hasMessageStop) {
      closeCurrentBlockIfNeeded(res, state);
      if (state.pendingStopReason) {
        // The provider never sent a trailing usage-only chunk (or sent it
        // before the finish chunk): emit the held message_delta now with
        // whatever usage was collected (possibly none).
        emitMessageDelta(res, state, state.pendingStopReason);
        state.pendingStopReason = null;
      }
      emitSSE(res, 'message_stop', {
        type: 'message_stop',
      });
      state.hasMessageStop = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    let boundary = findSSEPacketBoundary(buffer);
    while (boundary) {
      const packet = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary.separatorLength);

      const lines = packet.split(/\r?\n/);
      const dataLines: string[] = [];

      for (const line of lines) {
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      const payload = dataLines.join('\n');
      if (!payload) {
        boundary = findSSEPacketBoundary(buffer);
        continue;
      }

      if (payload === '[DONE]') {
        flushDone();
        sawDoneMarker = true;
        break;
      }

      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        processOpenAIChunk(res, state, parsed);
      } catch {
        // Ignore malformed stream chunks.
      }

      boundary = findSSEPacketBoundary(buffer);
    }

    if (sawDoneMarker) {
      break;
    }
  }

  if (sawDoneMarker) {
    try {
      await reader.cancel();
    } catch {
      // noop
    }
  }

  flushDone();
  res.end();
}

/**
 * Resolve the caller-supplied `sessionId` for CREATE into a stored
 * `targetSessionId`. Absent / null / '' mean "no binding" (new session each
 * run). The literal `"current"` must be resolved by the CALLER — the skill
 * script from `IDBOTS_COWORK_SESSION_ID`, the agent tool from its session
 * closure — so an unresolved `"current"` reaching this layer is a caller bug:
 * warn and drop it rather than storing the literal.
 */
function resolveCreateTargetSessionId(raw: unknown): { targetSessionId?: string; warning?: string } {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'string') {
    console.warn(`[CoworkProxy] Ignoring non-string sessionId (${typeof raw}) on scheduled-task create`);
    return { warning: 'sessionId must be a string, null, or omitted; it was ignored and the task will run in a new session.' };
  }
  const trimmed = raw.trim();
  if (!trimmed) return {};
  if (trimmed === 'current') {
    console.warn(
      '[CoworkProxy] sessionId "current" reached the scheduled-task API unresolved; treating it as omitted (the task will run in a new session).'
    );
    return {
      warning: 'sessionId "current" was not resolved by the caller; the task will run in a new session. Resolve it before calling the API.',
    };
  }
  return { targetSessionId: trimmed };
}

/**
 * Advisory warning for a `targetSessionId` that does not resolve to a usable
 * session. Non-fatal on purpose: the scheduler falls back to a fresh session at
 * fire time. Returns null when the binding is fine, absent, or unprobeable
 * (no predicate wired).
 */
function describeUnusableTargetSession(targetSessionId: string): string | null {
  const probe = scheduledTaskDeps?.isSessionUsableAsTaskTarget;
  if (!probe) return null;
  let usable: boolean;
  try {
    usable = probe(targetSessionId);
  } catch (error) {
    console.warn('[CoworkProxy] Session validity probe failed:', error);
    return null;
  }
  if (usable) return null;
  return `sessionId ${targetSessionId} does not resolve to a usable chat session (missing, archived, A2A or sandbox); the task will run in a new session instead.`;
}

async function handleCreateScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid request body' } as any);
    return;
  }

  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid JSON' } as any);
    return;
  }

  // Validate required fields
  if (!input.name?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: name' } as any);
    return;
  }
  if (!input.prompt?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: prompt' } as any);
    return;
  }
  if (!input.schedule?.type) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: schedule.type' } as any);
    return;
  }
  if (!['at', 'interval', 'cron'].includes(input.schedule.type)) {
    writeJSON(res, 400, { success: false, error: 'Invalid schedule type. Must be: at, interval, cron' } as any);
    return;
  }
  if (input.schedule.type === 'cron' && !input.schedule.expression) {
    writeJSON(res, 400, { success: false, error: 'Cron schedule requires expression field' } as any);
    return;
  }
  if (input.schedule.type === 'at' && !input.schedule.datetime) {
    writeJSON(res, 400, { success: false, error: 'At schedule requires datetime field' } as any);
    return;
  }

  // Validate: "at" type must be in the future
  if (input.schedule.type === 'at' && input.schedule.datetime) {
    const targetMs = new Date(input.schedule.datetime).getTime();
    if (targetMs <= Date.now()) {
      writeJSON(res, 400, { success: false, error: 'Execution time must be in the future for one-time (at) tasks' } as any);
      return;
    }
  }

  // Validate: expiresAt must not be in the past
  if (input.expiresAt) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (input.expiresAt <= todayStr) {
      writeJSON(res, 400, { success: false, error: 'Expiration date must be in the future' } as any);
      return;
    }
  }

  // Optional session binding submitted as `sessionId`; stored as targetSessionId.
  const sessionBinding = resolveCreateTargetSessionId(input.sessionId);

  const sessionModeError = validateScheduledTaskSessionMode(input.sessionMode);
  if (sessionModeError) {
    writeJSON(res, 400, { success: false, error: sessionModeError } as any);
    return;
  }

  // Lifecycle discipline (2026-10-24, Seedance-probe incident): every API
  // create comes from a bot session (humans use the settings UI), so the task
  // is stamped agent-origin with this session as its birthplace — a recurring
  // task must never exist without a traceable creator. Recurring tasks
  // additionally REQUIRE a declared exit condition: a cron/interval loop with
  // no death clause is exactly how a probe fired 61 times after the order it
  // served was already delivered.
  const isRecurring = input.schedule.type === 'interval' || input.schedule.type === 'cron';
  const exitCondition = typeof input.exitCondition === 'string' ? input.exitCondition.trim() : '';
  if (isRecurring && !exitCondition) {
    writeJSON(res, 400, {
      success: false,
      error: 'Recurring (interval/cron) tasks require "exitCondition": a natural-language clause stating when this task has done its job and must retire itself. Cover BOTH the watched condition AND the upstream lifecycle, e.g. {"exitCondition":"Retire once the video endpoint is confirmed live AND order-xiaoyi-birthday is delivered; if that order is already closed, retire on the next fire."}. One-shot ("at") tasks do not need it.',
    } as any);
    return;
  }

  const originSessionId =
    typeof input.originSessionId === 'string' && input.originSessionId.trim()
      ? input.originSessionId.trim()
      : null;
  let originContext: string | null = null;
  if (originSessionId && scheduledTaskDeps.resolveSessionOriginContext) {
    try {
      originContext = scheduledTaskDeps.resolveSessionOriginContext(originSessionId);
    } catch (error) {
      console.warn('[CoworkProxy] Origin-context resolution failed:', error);
    }
  }
  if (!originContext && typeof input.originContext === 'string' && input.originContext.trim()) {
    originContext = input.originContext.trim();
  }

  if (input.maxFires !== undefined && input.maxFires !== null) {
    const raw = Number(input.maxFires);
    if (!Number.isInteger(raw) || raw <= 0) {
      writeJSON(res, 400, { success: false, error: 'maxFires must be a positive integer (total fire budget), or null/omitted.' } as any);
      return;
    }
  }
  const maxFires = isRecurring
    ? (input.maxFires === undefined || input.maxFires === null
        ? DEFAULT_AGENT_MAX_FIRES
        : Number(input.maxFires))
    : null;

  // Build ScheduledTaskInput with defaults
  const taskInput: ScheduledTaskInput = {
    name: input.name.trim(),
    description: input.description || '',
    schedule: input.schedule,
    prompt: input.prompt.trim(),
    workingDirectory: normalizeScheduledTaskWorkingDirectory(input.workingDirectory),
    systemPrompt: input.systemPrompt || '',
    executionMode: input.executionMode || 'auto',
    metabotId: normalizeScheduledTaskMetabotId(input.metabotId),
    expiresAt: input.expiresAt || null,
    notifyPlatforms: input.notifyPlatforms || [],
    enabled: input.enabled !== false,
    origin: 'agent',
    originSessionId,
    originContext,
    exitCondition: exitCondition || null,
    maxFires,
    ...(sessionBinding.targetSessionId ? { targetSessionId: sessionBinding.targetSessionId } : {}),
    ...(input.sessionMode !== undefined ? { sessionMode: input.sessionMode as ScheduledTaskSessionMode } : {}),
  };

  const sessionWarning = sessionBinding.warning
    ?? (sessionBinding.targetSessionId
      ? describeUnusableTargetSession(sessionBinding.targetSessionId)
      : null);

  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().createTask(taskInput);
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    broadcastToRenderers('scheduledTask:statusUpdate', {
      taskId: task.id,
      state: task.state,
    });

    console.log(`[CoworkProxy] Scheduled task created via API: ${task.id} "${task.name}"`);
    if (sessionWarning) {
      console.warn(`[CoworkProxy] Scheduled task ${task.id} session binding warning: ${sessionWarning}`);
    }
    writeJSON(res, 201, {
      success: true,
      task,
      ...(sessionWarning ? { sessionWarning } : {}),
    } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to create scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

/** Scheduled-task management helpers backing the skill scripts (list/get/
 * update/delete/toggle). They mirror the IPC handlers in main.ts — same store
 * calls, same reschedule side effects — so HTTP callers and the renderer see
 * identical state without a separate data path. */

function broadcastScheduledTaskState(taskId: string, state: unknown): void {
  try {
    broadcastToRenderers('scheduledTask:statusUpdate', { taskId, state });
  } catch {
    // Best-effort refresh hint; never fail the API response on it.
  }
}

function handleListScheduledTasks(res: http.ServerResponse): void {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  try {
    const tasks = scheduledTaskDeps.getScheduledTaskStore().listTasks();
    writeJSON(res, 200, { success: true, tasks } as any);
  } catch (err: any) {
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

function handleGetScheduledTask(res: http.ServerResponse, id: string): void {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().getTask(id);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    writeJSON(res, 200, { success: true, task } as any);
  } catch (err: any) {
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function readJsonBody(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<Record<string, unknown> | null> {
  let body: string;
  try {
    body = await readRequestBody(req);
  } catch (error) {
    // Distinguish a rejected oversized body (readRequestBody caps at 20MB)
    // from a genuinely malformed stream: 413 vs 400.
    const message = error instanceof Error ? error.message : String(error);
    if (/too large/i.test(message)) {
      writeJSON(res, 413, { success: false, error: message } as any);
    } else {
      writeJSON(res, 400, { success: false, error: `Invalid request body: ${message}` } as any);
    }
    return null;
  }
  try {
    const parsed = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('body must be a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid JSON';
    writeJSON(res, 400, { success: false, error: message } as any);
    return null;
  }
}

function validateScheduledTaskPartialInput(input: Record<string, unknown>): string | null {
  if (input.name !== undefined && !String(input.name).trim()) {
    return 'name must be a non-empty string';
  }
  if (input.prompt !== undefined && !String(input.prompt).trim()) {
    return 'prompt must be a non-empty string';
  }
  const schedule = input.schedule as { type?: unknown; expression?: unknown; datetime?: unknown } | undefined;
  if (schedule !== undefined) {
    if (!schedule || typeof schedule !== 'object' || !schedule.type) {
      return 'schedule requires a type field';
    }
    if (!['at', 'interval', 'cron'].includes(String(schedule.type))) {
      return 'Invalid schedule type. Must be: at, interval, cron';
    }
    if (schedule.type === 'cron' && !schedule.expression) {
      return 'Cron schedule requires expression field';
    }
    if (schedule.type === 'at' && !schedule.datetime) {
      return 'At schedule requires datetime field';
    }
    // Parity with create: a one-time "at" schedule must still be in the
    // future at update time (an update can move a task to a new schedule).
    if (schedule.type === 'at' && schedule.datetime) {
      const targetMs = new Date(String(schedule.datetime)).getTime();
      if (Number.isFinite(targetMs) && targetMs <= Date.now()) {
        return 'Execution time must be in the future for one-time (at) tasks';
      }
    }
  }
  if (input.expiresAt !== undefined && input.expiresAt) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (String(input.expiresAt) <= todayStr) {
      return 'Expiration date must be in the future';
    }
  }
  // `sessionId` mirrors `expiresAt` on the nullable axis: absent = keep, null =
  // clear, string = set. Anything else is a caller bug.
  if (input.sessionId !== undefined && input.sessionId !== null && typeof input.sessionId !== 'string') {
    return 'sessionId must be a string, null, or omitted';
  }
  return validateScheduledTaskSessionMode(input.sessionMode);
}

async function handleUpdateScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  const store = scheduledTaskDeps.getScheduledTaskStore();
  const existing = store.getTask(id);
  if (!existing) {
    writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
    return;
  }
  const input = await readJsonBody(req, res);
  if (!input) return;
  const validationError = validateScheduledTaskPartialInput(input);
  if (validationError) {
    writeJSON(res, 400, { success: false, error: validationError } as any);
    return;
  }
  const normalizedInput: Record<string, unknown> = { ...input };
  // Parity with create: name/prompt are stored trimmed (create builds its
  // taskInput via .trim(); an update must not sneak whitespace back in).
  if (normalizedInput.name !== undefined) {
    normalizedInput.name = String(normalizedInput.name).trim();
  }
  if (normalizedInput.prompt !== undefined) {
    normalizedInput.prompt = String(normalizedInput.prompt).trim();
  }
  if (Object.prototype.hasOwnProperty.call(normalizedInput, 'workingDirectory')) {
    normalizedInput.workingDirectory = normalizeScheduledTaskWorkingDirectory(
      normalizedInput.workingDirectory,
    ) || existing.workingDirectory;
  }
  if (Object.prototype.hasOwnProperty.call(normalizedInput, 'metabotId')) {
    normalizedInput.metabotId = normalizeScheduledTaskMetabotId(normalizedInput.metabotId);
  }
  // `sessionId` is the caller-facing alias of the stored `targetSessionId`
  // (same nullable pattern as expiresAt): key absent = keep the current
  // binding; null / '' = clear it; "current" = caller bug → warn and keep;
  // any other string = bind to that session id.
  let sessionWarning: string | null = null;
  if (Object.prototype.hasOwnProperty.call(normalizedInput, 'sessionId')) {
    const rawSessionId = normalizedInput.sessionId;
    delete normalizedInput.sessionId;
    if (rawSessionId === null || (typeof rawSessionId === 'string' && !rawSessionId.trim())) {
      normalizedInput.targetSessionId = null;
    } else if (typeof rawSessionId === 'string') {
      const requested = rawSessionId.trim();
      if (requested === 'current') {
        console.warn(
          '[CoworkProxy] sessionId "current" reached the scheduled-task API unresolved; keeping the existing binding (callers must resolve it first).'
        );
        sessionWarning = 'sessionId "current" was not resolved by the caller; the existing session binding was kept.';
      } else {
        normalizedInput.targetSessionId = requested;
        sessionWarning = describeUnusableTargetSession(requested);
      }
    } else {
      console.warn(`[CoworkProxy] Ignoring non-string sessionId (${typeof rawSessionId}) on scheduled-task update`);
      sessionWarning = 'sessionId must be a string, null, or omitted; it was ignored and the existing session binding was kept.';
    }
  }
  // Lifecycle fields are updatable (exit clause revision, explicit budget
  // extension = renewal), but provenance is immutable after create — an
  // update must never rewrite who created the task or from where.
  delete normalizedInput.origin;
  delete normalizedInput.originSessionId;
  delete normalizedInput.originContext;
  if (normalizedInput.exitCondition !== undefined) {
    normalizedInput.exitCondition =
      typeof normalizedInput.exitCondition === 'string' ? normalizedInput.exitCondition.trim() || null : null;
  }
  if (normalizedInput.maxFires !== undefined && normalizedInput.maxFires !== null) {
    const rawMaxFires = Number(normalizedInput.maxFires);
    if (!Number.isInteger(rawMaxFires) || rawMaxFires <= 0) {
      writeJSON(res, 400, { success: false, error: 'maxFires must be a positive integer (total fire budget), or null/omitted.' } as any);
      return;
    }
    normalizedInput.maxFires = rawMaxFires;
  }
  try {
    const task = store.updateTask(id, normalizedInput as Partial<ScheduledTaskInput>);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    scheduledTaskDeps.getScheduler().reschedule();
    broadcastScheduledTaskState(task.id, task.state);
    console.log(`[CoworkProxy] Scheduled task updated via API: ${task.id} "${task.name}"`);
    if (sessionWarning) {
      console.warn(`[CoworkProxy] Scheduled task ${task.id} session binding warning: ${sessionWarning}`);
    }
    writeJSON(res, 200, {
      success: true,
      task,
      ...(sessionWarning ? { sessionWarning } : {}),
    } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to update scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleDeleteScheduledTask(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  const store = scheduledTaskDeps.getScheduledTaskStore();
  const existing = store.getTask(id);
  if (!existing) {
    writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
    return;
  }
  try {
    scheduledTaskDeps.getScheduler().stopTask(id);
    const result = store.deleteTask(id);
    scheduledTaskDeps.getScheduler().reschedule();
    console.log(`[CoworkProxy] Scheduled task deleted via API: ${id} "${existing.name}"`);
    writeJSON(res, 200, { success: true, result } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to delete scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleToggleScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  const input = await readJsonBody(req, res);
  if (!input) return;
  if (typeof input.enabled !== 'boolean') {
    writeJSON(res, 400, { success: false, error: 'enabled must be a boolean' } as any);
    return;
  }
  try {
    const { task, warning } = scheduledTaskDeps.getScheduledTaskStore().toggleTask(id, input.enabled);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    scheduledTaskDeps.getScheduler().reschedule();
    broadcastScheduledTaskState(task.id, task.state);
    console.log(`[CoworkProxy] Scheduled task toggled via API: ${task.id} "${task.name}" -> ${input.enabled ? 'enabled' : 'disabled'}`);
    writeJSON(res, 200, { success: true, task, warning } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to toggle scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

const MESSAGES_ROUTE_PATH = '/v1/messages';
const SESSION_MESSAGES_ROUTE_PATTERN = /^\/s\/([^/]+)\/v1\/messages$/;
// Snipping runs on every session-scoped request while a boundary is set; skip
// the walk entirely for conversations too short to have a meaningful head
// region beyond the always-intact tail.
const MIN_MESSAGES_FOR_TOOL_RESULT_SNIP = 6;

/**
 * Match the Anthropic messages route. Returns null for the plain
 * `/v1/messages` form, the decoded session key for the session-scoped
 * `/s/<sessionKey>/v1/messages` form, and undefined for anything else. The
 * runner points the CLI at the session-scoped form by appending
 * `/s/<sessionId>` to ANTHROPIC_BASE_URL (the Anthropic SDK joins
 * baseURL + path via plain string concat).
 */
function parseMessagesRouteSessionKey(pathname: string): string | null | undefined {
  if (pathname === MESSAGES_ROUTE_PATH) {
    return null;
  }
  const match = SESSION_MESSAGES_ROUTE_PATTERN.exec(pathname);
  if (!match) {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]) || undefined;
  } catch {
    return undefined;
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://${LOCAL_HOST}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    writeJSON(res, 200, {
      ok: true,
      running: Boolean(proxyServer),
      hasUpstream: Boolean(upstreamConfig),
      lastError: lastProxyError,
    });
    return;
  }

  // Scheduled task creation API
  if (method === 'POST' && url.pathname === '/api/scheduled-tasks') {
    await handleCreateScheduledTask(req, res);
    return;
  }

  // Scheduled task management API (skill scripts: list/get/update/delete/toggle)
  const scheduledTaskIdMatch = /^\/api\/scheduled-tasks\/([^/]+)$/.exec(url.pathname);
  const scheduledTaskToggleMatch = /^\/api\/scheduled-tasks\/([^/]+)\/toggle$/.exec(url.pathname);
  if (scheduledTaskToggleMatch && method === 'POST') {
    await handleToggleScheduledTask(req, res, decodeURIComponent(scheduledTaskToggleMatch[1]));
    return;
  }
  if (scheduledTaskIdMatch && method === 'GET') {
    handleGetScheduledTask(res, decodeURIComponent(scheduledTaskIdMatch[1]));
    return;
  }
  if (scheduledTaskIdMatch && method === 'PUT') {
    await handleUpdateScheduledTask(req, res, decodeURIComponent(scheduledTaskIdMatch[1]));
    return;
  }
  if (scheduledTaskIdMatch && method === 'DELETE') {
    await handleDeleteScheduledTask(req, res, decodeURIComponent(scheduledTaskIdMatch[1]));
    return;
  }
  if (method === 'GET' && url.pathname === '/api/scheduled-tasks') {
    handleListScheduledTasks(res);
    return;
  }

  const messagesRouteSessionKey = parseMessagesRouteSessionKey(url.pathname);
  if (method !== 'POST' || messagesRouteSessionKey === undefined) {
    writeJSON(res, 404, createAnthropicErrorBody('Not found', 'not_found_error'));
    return;
  }

  // Resolve the effective upstream for THIS request: a per-session entry (set
  // by the runner when it started the session on a proxy-routed provider) wins
  // over the shared singleton, so concurrent sessions on different openai/
  // responses providers no longer clobber each other.
  const upstream = getUpstreamForSession(messagesRouteSessionKey);
  if (!upstream) {
    writeJSON(
      res,
      503,
      createAnthropicErrorBody('OpenAI compatibility proxy is not configured', 'service_unavailable')
    );
    return;
  }

  let requestBodyRaw = '';
  try {
    requestBodyRaw = await readRequestBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    writeJSON(res, 400, createAnthropicErrorBody(message, 'invalid_request_error'));
    return;
  }

  let parsedRequestBody: unknown;
  try {
    parsedRequestBody = JSON.parse(requestBodyRaw);
  } catch {
    writeJSON(res, 400, createAnthropicErrorBody('Request body must be valid JSON', 'invalid_request_error'));
    return;
  }

  let anthropicRequestBody = parsedRequestBody;
  let requestMessages = toOptionalObject(parsedRequestBody)?.messages;
  if (messagesRouteSessionKey) {
    if (Array.isArray(requestMessages)) {
      // GT#12 N5: fold low-value polling tool_result blocks by CONTENT VALUE
      // (complements tier-1 snip, which cuts by token boundary). Storage is
      // untouched — only this replayed request body is affected. Runs before
      // snip so the two savings compose.
      const foldResult = foldLowValueToolResults(requestMessages);
      if (foldResult.stats.folded > 0) {
        anthropicRequestBody = {
          ...(parsedRequestBody as Record<string, unknown>),
          messages: foldResult.messages,
        };
        requestMessages = toOptionalObject(anthropicRequestBody)?.messages;
        console.info('[cowork-openai-compat-proxy] Folded low-value polling tool_result blocks', {
          sessionKey: messagesRouteSessionKey,
          total: foldResult.stats.total,
          folded: foldResult.stats.folded,
          kept: foldResult.stats.kept,
        });
      }
    }
  }
  if (messagesRouteSessionKey) {
    // Tiered compaction tier 1: deterministically snip stale tool_result
    // blocks in the head region of this session's conversation. Same input
    // bytes + same persisted boundary => same output bytes, so DeepSeek's
    // cached prefix only breaks once per boundary raise.
    const snipHeadTokens = getCoworkSnipHeadTokens(messagesRouteSessionKey);
    if (
      snipHeadTokens > 0
      && Array.isArray(requestMessages)
      && requestMessages.length >= MIN_MESSAGES_FOR_TOOL_RESULT_SNIP
    ) {
      const snipResult = snipStaleToolResultBlocks(requestMessages, snipHeadTokens);
      if (snipResult.stats.snippedBlocks > 0) {
        anthropicRequestBody = {
          ...(anthropicRequestBody as Record<string, unknown>),
          messages: snipResult.messages,
        };
        console.info('[cowork-openai-compat-proxy] Snipped stale tool_result blocks in head region', {
          sessionKey: messagesRouteSessionKey,
          snippedBlocks: snipResult.stats.snippedBlocks,
          savedTokens: snipResult.stats.savedTokens,
          snipHeadTokens,
        });
      }
    }
  }

  if (messagesRouteSessionKey) {
    // Watch the (system, tools) request head for silent byte drift. This is a
    // read-only observability path: known resets show up here too, but the
    // fingerprints make every prefix break attributable instead of 'unknown'.
    trackRequestHeadStability(
      messagesRouteSessionKey,
      anthropicRequestBody as Record<string, unknown>
    );
  }

  const openAIRequest = anthropicToOpenAI(anthropicRequestBody);
  openAIRequest.model = resolveEffectiveUpstreamModel(
    toString(openAIRequest.model),
    upstream.model
  );
  // Resolve the upstream API type from the EFFECTIVE model so that a request
  // body overriding the model (e.g. deepseek-v4-pro) still routes correctly.
  const upstreamAPIType = resolveUpstreamAPIType(upstream.provider, toString(openAIRequest.model), upstream.apiFormat, upstream.baseURL);
  filterOpenAIToolsForProvider(openAIRequest, upstream.provider);
  hydrateOpenAIRequestToolCalls(openAIRequest, upstream.provider, upstream.baseURL);
  const deepSeekReasoningHydrateResult = hydrateDeepSeekReasoningForRequest(
    openAIRequest,
    upstream.provider,
    upstream.baseURL
  );
  if (deepSeekReasoningHydrateResult.hydratedCount > 0 || deepSeekReasoningHydrateResult.placeholderCount > 0) {
    console.info('[cowork-openai-compat-proxy] Hydrated DeepSeek reasoning_content for assistant tool-call history', {
      hydratedCount: deepSeekReasoningHydrateResult.hydratedCount,
      placeholderCount: deepSeekReasoningHydrateResult.placeholderCount,
    });
  }
  if (DEEPSEEK_REASONING_DIAGNOSTIC) {
    coworkLog('DEBUG', 'deepseek-reasoning-diag', 'per-request reasoning hydration', {
      path: upstreamAPIType,
      model: toString(openAIRequest.model),
      provider: upstreamConfig.provider ?? null,
      baseURL: upstreamConfig.baseURL ?? null,
      hydratedCount: deepSeekReasoningHydrateResult.hydratedCount,
      placeholderCount: deepSeekReasoningHydrateResult.placeholderCount,
    });
  }

  if (upstreamAPIType === 'chat_completions') {
    normalizeMaxTokensFieldForOpenAIProvider(openAIRequest, upstream.provider);
    // GLM-5.x chat endpoints reject thinking:{type:'disabled'} outright (zhipu
    // 400 code 1210 「该模型始终思考，不支持关闭思考」). Drop the toggle for
    // always-thinking models instead of failing the request; the output budget
    // at the caller is thinking-aware (modelThinking.budgetAssumesThinking),
    // and a disabled toggle on a model that cannot disable was never going to
    // be honored anyway.
    if (modelAlwaysThinks(toString(openAIRequest.model))) {
      const thinking = toOptionalObject(openAIRequest.thinking);
      if (toString(thinking?.type).toLowerCase() === 'disabled') {
        delete openAIRequest.thinking;
        coworkLog('INFO', 'thinking-toggle', 'dropped thinking:disabled for always-thinking model on chat path', {
          model: toString(openAIRequest.model),
        });
      }
    }
  }

  const upstreamRequest = upstreamAPIType === 'responses'
    ? convertChatCompletionsRequestToResponsesRequest(openAIRequest, upstream.provider, upstream.supportsImage)
    : openAIRequest;
  const stream = Boolean(upstreamRequest.stream);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (upstream.apiKey) {
    headers.Authorization = `Bearer ${upstream.apiKey}`;
  }
  // OpenCode Go ("Console Go") refuses requests without a stable session id.
  // Reuse the cowork session key when present so the gateway can prompt-cache
  // across turns; one-shot calls fall back to a fresh uuid inside the helper.
  Object.assign(headers, buildOpenCodeGoHeaders(upstream.baseURL, messagesRouteSessionKey));

  const targetURLs = buildUpstreamTargetUrls(upstream.baseURL, upstreamAPIType, upstream.provider);
  let currentTargetURL = targetURLs[0];

  // Propagate caller disconnects into the upstream request. Callers bound each
  // attempt with their own timeout (dreams: 180s/600s) and abort THEIR fetch to
  // this proxy when it fires; before 2026-09-29 that closed socket went
  // unnoticed here and the upstream request ran to completion anyway, burning
  // provider quota nobody would read — and across ~20 nightly dream bots the
  // orphaned requests could trip upstream rate limits. `res` 'close' also
  // fires after a normal finish, so only abort when the response never
  // completed. The aborted fetch surfaces as ERR_ABORTED/AbortError, which is
  // deliberately NOT in the transient retry list — retries would fight the
  // caller's cancellation.
  const upstreamAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      upstreamAbort.abort();
    }
  });

  const sendUpstreamRequest = async (
    payload: Record<string, unknown>,
    targetURL: string
  ): Promise<Response> => {
    currentTargetURL = targetURL;
    return session.defaultSession.fetch(targetURL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: upstreamAbort.signal,
    });
  };
  // Every upstream send goes through the transient-retry wrapper: a single
  // closed socket (net::ERR_CONNECTION_CLOSED and friends) or a 502/503/504
  // gateway flap gets up to two immediate retries on a fresh connection
  // instead of failing the caller's whole attempt.
  const sendUpstreamRequestWithRetry = (
    payload: Record<string, unknown>,
    targetURL: string
  ): Promise<Response> => sendUpstreamRequestWithTransientRetry(sendUpstreamRequest, payload, targetURL);

  let upstreamResponse: Response;
  try {
    upstreamResponse = await sendUpstreamRequestWithRetry(upstreamRequest, targetURLs[0]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Network error';
    writeUpstreamTransportError(res, message);
    return;
  }

  if (!upstreamResponse.ok) {
    if (upstreamResponse.status === 404 && targetURLs.length > 1) {
      for (let i = 1; i < targetURLs.length; i += 1) {
        const retryURL = targetURLs[i];
        try {
          upstreamResponse = await sendUpstreamRequestWithRetry(upstreamRequest, retryURL);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Network error';
          writeUpstreamTransportError(res, message);
          return;
        }
        if (upstreamResponse.ok || upstreamResponse.status !== 404) {
          break;
        }
      }
    }

    if (!upstreamResponse.ok) {
      const firstErrorText = await upstreamResponse.text();
      let firstErrorMessage = extractErrorMessage(firstErrorText);
      if (firstErrorMessage === 'Upstream API request failed') {
        firstErrorMessage = `Upstream API request failed (${upstreamResponse.status}) ${currentTargetURL}`;
      }
      // Preserve the upstream machine error code (e.g. free_quota_exhausted)
      // in the surfaced message so renderer guidance can key off it.
      const firstErrorCode = extractUpstreamErrorCode(firstErrorText);
      if (firstErrorCode && !firstErrorMessage.includes(firstErrorCode)) {
        firstErrorMessage = `${firstErrorCode}: ${firstErrorMessage}`;
      }
      // A relay quota death is a state change the global quota nudge cares
      // about: force a recompute so the banner lights up now, not at the
      // next poll tick.
      if (firstErrorCode && /^(free_quota_exhausted|quota_exhausted)$/i.test(firstErrorCode)) {
        try {
          freeQuotaExhaustedListener?.();
        } catch { /* the listener must never break the proxy */ }
      }

      if (upstreamAPIType === 'chat_completions' && upstreamResponse.status === 400) {
        if (isMaxTokensUnsupportedError(firstErrorMessage)) {
          const convertResult = convertMaxTokensToMaxCompletionTokens(upstreamRequest);
          if (convertResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequestWithRetry(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  '[cowork-openai-compat-proxy] Retried request with max_completion_tokens '
                    + `converted from max_tokens=${convertResult.convertedTo}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Network error';
              writeUpstreamTransportError(res, message);
              return;
            }
          }
        }

        // Some OpenAI-compatible providers (e.g. DeepSeek) enforce strict max_tokens ranges.
        // Retry once with a clamped value when the upstream response includes the allowed range.
        if (!upstreamResponse.ok) {
          const clampResult = clampMaxTokensFromError(upstreamRequest, firstErrorMessage);
          if (clampResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequestWithRetry(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  `[cowork-openai-compat-proxy] Retried request with clamped max_tokens=${clampResult.clampedTo}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Network error';
              writeUpstreamTransportError(res, message);
              return;
            }
          }
        }
      }

      if (!upstreamResponse.ok) {
        lastProxyError = firstErrorMessage;
        writeJSON(res, upstreamResponse.status, createAnthropicErrorBody(firstErrorMessage));
        return;
      }
    }
  }

  lastProxyError = null;

  if (stream) {
    if (upstreamAPIType === 'responses') {
      await handleResponsesStreamResponse(
        upstreamResponse,
        res,
        upstream.provider,
        upstream.baseURL,
        toString(openAIRequest.model)
      );
    } else {
      await handleChatCompletionsStreamResponse(
        upstreamResponse,
        res,
        upstream.provider,
        upstream.baseURL,
        toString(openAIRequest.model)
      );
    }
    return;
  }

  let upstreamJSON: unknown;
  try {
    upstreamJSON = await upstreamResponse.json();
  } catch {
    lastProxyError = 'Failed to parse upstream JSON response';
    writeJSON(res, 502, createAnthropicErrorBody('Failed to parse upstream JSON response'));
    return;
  }

  if (upstreamAPIType === 'responses') {
    const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(upstreamJSON);
    attachDeepSeekReasoningToOpenAIResponseToolCalls(
      syntheticOpenAIResponse,
      upstream.provider,
      upstream.baseURL,
      toString(syntheticOpenAIResponse.model)
    );
    cacheToolCallExtraContentFromOpenAIResponse(syntheticOpenAIResponse);
    cacheToolCallExtraContentFromResponsesResponse(upstreamJSON);
    const anthropicResponse = openAIToAnthropic(syntheticOpenAIResponse);
    // Non-stream Responses responses may contain web_search_call output items;
    // relay them as server_tool_use blocks so the SDK context still records
    // that a web search ran (streaming path relays per output_item.done).
    injectResponsesWebSearchBlocks(anthropicResponse, upstreamJSON);
    writeJSON(res, 200, anthropicResponse);
    return;
  }

  attachDeepSeekReasoningToOpenAIResponseToolCalls(
    upstreamJSON,
    upstream.provider,
    upstream.baseURL,
    toString(openAIRequest.model)
  );
  cacheToolCallExtraContentFromOpenAIResponse(upstreamJSON);

  const anthropicResponse = openAIToAnthropic(upstreamJSON);
  writeJSON(res, 200, anthropicResponse);
}

export const __openAICompatProxyTestUtils = {
  createStreamState,
  createResponsesStreamContext,
  findSSEPacketBoundary,
  processOpenAIChunk,
  processResponsesStreamEvent,
  convertChatCompletionsRequestToResponsesRequest,
  resolveUpstreamAPIType,
  buildOpenAIResponsesURL,
  filterOpenAIToolsForProvider,
  hydrateDeepSeekReasoningForRequest,
  resolveEffectiveUpstreamModel,
  parseMessagesRouteSessionKey,
  extractAnthropicSystemText,
  trackRequestHeadStability,
  injectResponsesWebSearchBlocks,
  extractResponsesOutputText,
  resetDeepSeekReasoningCache: () => {
    deepSeekReasoningStoreLoaded = false;
    deepSeekReasoningStore.clear();
    toolCallExtraContentById.clear();
  },
};

export async function startCoworkOpenAICompatProxy(): Promise<void> {
  if (proxyServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : 'Internal proxy error';
        lastProxyError = message;
        if (!res.headersSent) {
          writeJSON(res, 500, createAnthropicErrorBody(message));
        } else {
          res.end();
        }
      });
    });

    server.on('error', (error) => {
      lastProxyError = error.message;
      // Pre-listen: surface the bind failure to the starter. Post-listen: a
      // server-level error (accept-loop EMFILE, socket teardown, ...) can
      // leave the listening socket dead while proxyServer/proxyPort still
      // point at it — every resolve then hands out a dead baseURL and ALL
      // calls fail with "fetch failed" until restart (the 2026-09-25 G2
      // outage shape). Reset the state so resolves fail explicitly, then
      // restart once after a short backoff.
      if (proxyServer === server) {
        console.error(`[OpenAICompatProxy] server error after listen: ${error.message}; resetting and restarting`);
        proxyServer = null;
        proxyPort = null;
        const timer = setTimeout(() => {
          void startCoworkOpenAICompatProxy().catch((restartError) => {
            console.error(`[OpenAICompatProxy] restart failed: ${restartError instanceof Error ? restartError.message : restartError}`);
          });
        }, 5_000);
        timer.unref?.();
        return;
      }
      reject(error);
    });

    server.listen(0, PROXY_BIND_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OpenAI compatibility proxy port'));
        return;
      }

      proxyServer = server;
      proxyPort = addr.port;
      lastProxyError = null;
      resolve();
    });
  });
}

export async function stopCoworkOpenAICompatProxy(): Promise<void> {
  if (!proxyServer) {
    return;
  }

  const server = proxyServer;
  proxyServer = null;
  proxyPort = null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function configureCoworkOpenAICompatProxy(config: OpenAICompatUpstreamConfig): void {
  const normalized: OpenAICompatUpstreamConfig = {
    ...config,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey?.trim(),
  };
  const sessionKey = config.sessionKey?.trim();
  if (sessionKey) {
    // Session-scoped configure: pin ONLY this session's upstream. Do not touch
    // the shared singleton — republishing it here is what let an in-flight
    // unscoped caller (memory judge, title generation, summaries) get re-pointed
    // to a different provider mid-request (400/502). Unscoped resolves set the
    // singleton themselves via the no-sessionKey branch below.
    sessionUpstreams.set(sessionKey, normalized);
  } else {
    // Unscoped configure (legacy / non-session callers): republish the shared
    // singleton so those callers keep resolving the current default provider.
    upstreamConfig = normalized;
  }
  lastProxyError = null;
}

/**
 * Drop the per-session upstream registered for this cowork session. Called by
 * the runner when a session ends to keep the registry from growing unbounded.
 * The singleton is intentionally left untouched (other sessions / fallbacks
 * may still rely on it).
 */
export function clearCoworkSessionUpstream(sessionKey: string | null | undefined): void {
  const key = sessionKey?.trim();
  if (!key) return;
  sessionUpstreams.delete(key);
}

/**
 * Resolve the effective upstream for a session-scoped request: the per-session
 * entry when present, otherwise the shared singleton. Returns null when neither
 * is configured (caller surfaces a 503). Exposed for testability.
 */
export function getUpstreamForSession(sessionKey: string | null | undefined): OpenAICompatUpstreamConfig | null {
  const key = sessionKey?.trim();
  if (key) {
    const perSession = sessionUpstreams.get(key);
    if (perSession) return perSession;
  }
  return upstreamConfig;
}

export function getCoworkOpenAICompatProxyBaseURL(target: OpenAICompatProxyTarget = 'local'): string | null {
  if (!proxyServer || !proxyPort) {
    return null;
  }
  const host = target === 'sandbox' ? SANDBOX_HOST : LOCAL_HOST;
  return `http://${host}:${proxyPort}`;
}

/**
 * Get the proxy base URL for internal API use (scheduled tasks, etc.).
 * Unlike getCoworkOpenAICompatProxyBaseURL which is for the LLM proxy,
 * this always returns the local proxy URL regardless of API format.
 */
export function getInternalApiBaseURL(): string | null {
  return getCoworkOpenAICompatProxyBaseURL('local');
}

export function getCoworkOpenAICompatProxyStatus(): OpenAICompatProxyStatus {
  return {
    running: Boolean(proxyServer),
    baseURL: getCoworkOpenAICompatProxyBaseURL(),
    hasUpstream: Boolean(upstreamConfig),
    upstreamBaseURL: upstreamConfig?.baseURL || null,
    upstreamModel: upstreamConfig?.model || null,
    lastError: lastProxyError,
  };
}
