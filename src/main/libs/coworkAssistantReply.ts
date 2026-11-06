import { DSH_RUNTIME_BOOT_ERROR_CODE } from './dshRuntimeBootError';

/**
 * Shared helpers for deciding whether an assistant message is a *usable*
 * final reply/handoff.
 *
 * The DeepSeek Responses path in coworkOpenAICompatProxy injects
 * `DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER` into request history when
 * reasoning is unrecoverable. On some upstreams that placeholder also
 * round-trips back as thinking content and gets persisted as an assistant
 * message. Any consumer that extracts a "final reply" (skill-turn bridge,
 * worker delegation, group daemon) must treat that text as empty instead of
 * handing a fake "completed" result to the caller.
 */
export const DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER = '[reasoning unavailable]';

/**
 * Cue fed back to the model when an empty terminal turn is auto-continued
 * (DeepSeek emitted only a reasoning block, then `end_turn`, with no text and
 * no tool_use). Mirrors the manual "继续" workaround: resume the session (full
 * history preserved) with a minimal instruction so the model performs the step
 * it clearly intended. This is real answer text — NOT the DeepSeek
 * `[reasoning unavailable]` placeholder — so `isNonAnswerAssistantReply` must
 * treat it as a genuine message and it can never itself look like another
 * empty terminal turn.
 */
export const EMPTY_TERMINAL_TURN_CONTINUE_PROMPT =
  'The previous turn ended without producing any output or tool action. Continue the task from where you left off and perform the next step.';

export const FINALIZATION_TURN_CONTINUE_PROMPT = [
  'The execution phase has stopped. Produce the owner-facing final response now, with no tool calls.',
  'Answer the user\'s original question directly in the first sentence, then give the verified outcome, any remaining limits, the next checkpoint, and any action or decision needed from the user.',
  'Integrate earlier assistant drafts with the final tool evidence instead of publishing only the latest addendum or a process note. Do not retell the execution log.',
  'For worker delivery notices, distinguish delivered-for-review from accepted or verified. Never claim verification that the tool evidence does not support.',
  'Use the conversation language and keep the response useful even if the larger task continues after this checkpoint.',
].join('\n');

/**
 * Cue fed back to the model when a turn was cut by the output-token ceiling
 * (turn/end reason `max-tokens`) and is auto-continued. Covers both shapes of
 * the truncation: a mid-reply cut (partial answer text) and a reasoning-only
 * burnout where thinking consumed the whole budget before any text or tool
 * call (the cw-86812c4f stall). Keep the reasoning short and deliver the
 * answer — otherwise a ceiling that thinking alone can exhaust truncates the
 * continuation too.
 */
export const TRUNCATED_TURN_CONTINUE_PROMPT =
  'Your previous response was cut off by the output token limit. Continue from where you left off with minimal further reasoning and deliver the complete answer.';

/**
 * Effort used for empty-terminal and max-tokens auto-continue turns.
 * Re-running the original effort (often `max`, thinking on) burns the output
 * ceiling on reasoning again — the 2026-09-14 silent stall after one
 * continuation (sessions e6af1710, 572751a8, 10b02949). `off` forces the
 * recovery turn to emit tools or visible text.
 */
export const CONTINUE_TURN_REASONING_EFFORT = 'off' as const;

/**
 * Provider failure codes that mean "the request never got answered for
 * environmental reasons" — network unreachable (TRANSPORT), request timed out
 * (TIMEOUT), provider 429/5xx (RATE_LIMIT/SERVER), or a stream that closed
 * without any content (EMPTY_RESPONSE). These carry no information about the
 * model's own behavior: the same prompt is perfectly answerable once the
 * environment recovers, so the turn is worth resuming instead of failing the
 * task behind it.
 */
export const TRANSIENT_TURN_ERROR_CODES: ReadonlySet<string> = new Set([
  'TRANSPORT',
  'TIMEOUT',
  'RATE_LIMIT',
  'SERVER',
  'EMPTY_RESPONSE',
]);

/**
 * Cue fed back to the model when a DSH turn died on a transient error (see
 * TRANSIENT_TURN_ERROR_CODES) and the runner auto-resumes it. Full session
 * history — including every tool result of the interrupted turn — is
 * preserved, so the model picks up exactly where the environment cut it off;
 * no tool side effects are replayed.
 */
export const TRANSIENT_TURN_RESUME_PROMPT =
  'The previous turn was interrupted by a transient network or provider failure. Continue the task from where you left off.';

/** Cue fed back to the model when a DSH turn died on a context-overflow error
 *  and the runner auto-resumed it on the fallback (larger-context) route. The
 *  history is fully preserved; the ask is to continue without re-reading
 *  everything, so the resumed request stays well inside the new window. */
export const OVERFLOW_TURN_RESUME_PROMPT =
  'The previous turn failed because it exceeded the previous model\'s context window; this turn continues on a fallback model with the full preserved history. Continue the task from where you left off, working from what is already in the conversation without re-reading files or repeating large tool calls.';

/**
 * Cue fed back to the model when a DSH turn died because the provider streamed
 * a tool call whose accumulated arguments never parsed as JSON (kernel code
 * MALFORMED_RESPONSE, "DeepSeek Messages stream: tool input is invalid JSON";
 * 2026-10-13 session 38c18094 on the native DeepSeek route). The kernel
 * discards the malformed step BEFORE any assistant message enters the session
 * history (only an assistant/attempt telemetry record is appended) and no tool
 * call from it ever dispatched, so the preserved history is consistent and the
 * model can simply re-issue the step — no side effects replay.
 */
export const MALFORMED_TOOL_CALL_TURN_CONTINUE_PROMPT =
  'The previous response was interrupted: a tool call was emitted with corrupted arguments that could not be parsed. Continue the task from where you left off and re-issue that step.';

/**
 * Cue fed back to the model when a DSH turn died on a CONFIG-class hard error
 * (credential rejected / model id not served) and the runner switched to the
 * fallback route for its single attempt. Naming the real cause matters: the
 * generic transient-resume cue tells the model a network blip happened, which
 * invites it to "wait and retry" behavior instead of just continuing the task
 * on the healthy route (2026-10-18 session 3144cb1a: 44 alternating
 * auth-failed/tool_removal pairs all read "transient network failure").
 */
export const CONFIG_HARD_FALLBACK_RESUME_PROMPT =
  'The previous turn failed because the primary model route rejected its configuration (credential rejected, or the model id is not served there). This turn continues on a fallback model route with the full preserved history. Continue the task from where you left off.';

/** True when a DSH turn outcome failed because the provider streamed tool-call
 *  arguments that never parsed as JSON — a stochastic model-side emission
 *  glitch on the DeepSeek Messages route, worth ONE automatic continue.
 *  Deliberately scoped to this exact fingerprint: other MALFORMED_RESPONSE
 *  details (SSE frame corruption, schema mismatches) can be persistent
 *  provider/adapter defects and never enter the auto-continue path. */
export function isMalformedToolCallDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  if (String(outcome.error?.code ?? '').toUpperCase() !== 'MALFORMED_RESPONSE') return false;
  return /tool input is invalid JSON/i.test(String(outcome.error?.message ?? ''));
}

/**
 * Zhipu (Z.ai / bigmodel.cn) gateway transient-outage fingerprint, mirrored
 * verbatim from the upstream response body the gateway returns when it loses
 * its backend mid-request: `server_error: 网络错误，错误id <server-id> ，请稍
 * 后重试。[<server-id>]`. This is a fixed upstream error-body template (the
 * id is a server-side timestamp), not natural-language intent matching — same
 * category as the quota/auth fingerprints below. pi-ai's English-only failure
 * classifier cannot fingerprint the Chinese template and lands it on the
 * generic `PI_AI_ERROR` code, which used to bypass both turn-resume ladders
 * entirely (2026-11-01 session b07c64e9: two hard turn deaths at 21:13/21:40
 * while the same route served fine turns minutes either side; a full-corpus
 * journal scan 9/25–11/01 found 13 such deaths, all on zhipu routes, zero on
 * deepseek routes).
 */
const ZHIPU_GATEWAY_NETERR_MESSAGE_FINGERPRINT = /server_error: 网络错误，错误id [0-9a-zA-Z]+ ，请稍后重试/;

/** True when a DSH turn outcome is an error whose failure code is transient
 *  (environmental) and therefore worth an automatic turn-level resume — a
 *  kernel-normalized transient code, or the Zhipu gateway network-error
 *  fingerprint riding the generic `PI_AI_ERROR` code (see the fingerprint
 *  comment above for why it cannot be kernel-classified). */
export function isTransientDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = outcome.error?.code;
  if (typeof code === 'string' && TRANSIENT_TURN_ERROR_CODES.has(code)) return true;
  return ZHIPU_GATEWAY_NETERR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''));
}

/**
 * Upstream "account has no spendable credit left" fingerprints mirrored from
 * provider error bodies (OpenAI-compat relays, DeepSeek, aggregator gateways).
 * ASCII upstream error fingerprints only — never natural-language intent.
 */
const QUOTA_ERROR_MESSAGE_FINGERPRINT = /insufficient[ _-]?(credits?|quota|balance|funds)|quota[ _-]?exceeded|billing[ _-]?limit/i;

/** True when a DSH turn outcome failed because the provider account ran out
 *  of spendable credit/balance — the kernel-normalized `QUOTA` code, or an
 *  upstream insufficient-credit fingerprint in the raw message. Retrying on
 *  the same route cannot succeed; the transcript error should name the
 *  provider/model so the operator knows what to top up or switch. */
export function isQuotaDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = outcome.error?.code;
  if (typeof code === 'string' && code.toUpperCase() === 'QUOTA') return true;
  return QUOTA_ERROR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''));
}

/**
 * REQ-A-25: the relay answers an exhausted identity quota with HTTP 429 and
 * one of two machine codes — free_quota_exhausted (identity never had
 * purchased quota) and the new C4 quota_exhausted (purchased pool used up).
 * Returns the matched code in lowercase, or null when the text carries
 * neither. (quota_exhausted is a substring of free_quota_exhausted, so the
 * alternation order pins the more specific code first.)
 */
export function extractRelayQuotaExhaustedCode(message: unknown): string | null {
  const match = /(free_quota_exhausted|quota_exhausted)/i.exec(String(message ?? ''));
  return match ? match[1].toLowerCase() : null;
}

/** Stable machine code stamped on the cowork stream error for a quota death. */
export const LLM_QUOTA_EXHAUSTED_ERROR_CODE = 'LLM_QUOTA_EXHAUSTED';

/**
 * Metadata for the `cowork:stream:error` payload when the turn died on either
 * relay quota code — undefined for every other failure so the stream error
 * shape stays unchanged outside the quota case.
 */
export function relayQuotaErrorMetadata(message: unknown): { errorCode: string } | undefined {
  return extractRelayQuotaExhaustedCode(message) ? { errorCode: LLM_QUOTA_EXHAUSTED_ERROR_CODE } : undefined;
}

/**
 * Transcript notice for a free-relay quota death (REQ-A-25).
 *
 * Desktop points at Settings > Models (the user's own provider key is the
 * actionable fix there). Server mode (phone) has no Settings > Models page,
 * so the notice points at recharge instead. The upstream quota code is
 * interpolated verbatim in both modes: the renderer's quota banner keys off
 * it, and tests rely on it staying machine-readable.
 */
export function buildFreeRelayQuotaNotice(
  relayQuotaCode: string | null,
  serverMode: boolean,
  t: (zh: string, en: string) => string,
): string {
  const code = relayQuotaCode ?? 'free_quota_exhausted';
  return serverMode
    ? t(
      `（这不是配置错误：IDBots-Free 免费体验额度已用完。可在「我的」页面充值继续对话。错误代码：${code}。）`,
      ` (This is not a configuration error: the IDBots-Free starter allowance is used up. Recharge on the Me page to keep chatting. Error code: ${code}.)`,
    )
    : t(
      `（这不是配置错误：IDBots-Free 免费体验额度已用完。请到 设置 > 模型 添加一个自己的模型服务商 API Key 即可继续对话。错误代码：${code}。）`,
      ` (This is not a configuration error: the IDBots-Free starter allowance is used up. Add your own model provider API key in Settings > Models to keep chatting. Error code: ${code}.)`,
    );
}

/**
 * Upstream "credential rejected" fingerprints mirrored from provider error
 * bodies (OpenAI-compat relays, DeepSeek, aggregator gateways). ASCII upstream
 * fingerprints only — never natural-language intent. A bare `401` never
 * classifies on its own (ids and counts can carry it); it must be paired with
 * auth wording in the same line.
 */
const AUTH_ERROR_MESSAGE_FINGERPRINT = /authentication[ _-]?fails?|auth[ _-]?failure|invalid[ _-](api[ _-]?)?(key|token)|api[ _-]?key[^\n]{0,24}is[ _-]?invalid|incorrect[ _-]api[ _-]?key|missing[ _-]api[ _-]?key|\bunauthorized\b|401[^\n]{0,40}(invalid|unauthorized|auth)/i;

/** True when a DSH turn outcome failed because the upstream rejected the
 *  credential — a kernel-normalized auth code, or an upstream auth-rejection
 *  fingerprint in the raw message. The transcript error should name the exact
 *  route and the key tail actually sent: with password-masked settings inputs
 *  the operator otherwise cannot tell whether the failing key is the one they
 *  just saved (2026-10-03 Windows report: a replaced DeepSeek key appeared to
 *  keep "reverting" after relaunch). */
export function isAuthDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = String(outcome.error?.code ?? '').toUpperCase();
  if (code === 'AUTH' || code === 'AUTHENTICATION' || code === 'UNAUTHORIZED' || code === 'FORBIDDEN' || code === 'INVALID_API_KEY') return true;
  return AUTH_ERROR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''));
}

/**
 * Upstream "the requested model id does not exist on this provider" fingerprints
 * (OpenAI-compat relays and aggregator gateways: `model not found`,
 * `model does not exist`, `404 ... model`). ASCII upstream fingerprints only.
 * Like an auth rejection, a missing model id is a CONFIGURATION hard error —
 * retrying the same route can never succeed — but unlike an outage it is
 * worth degrading to the next rung (fallback brain / current default), which
 * may point at a model id that actually exists (2026-10-08 Boss ruling,
 * error-type routing corollary: config-class hard errors degrade + log).
 */
const MODEL_MISSING_ERROR_MESSAGE_FINGERPRINT = /\bmodel[ _-]?not[ _-]?found\b|model[ _-]does[ _-]?not[ _-]exist|\b404\b[^\n]{0,48}\bmodel\b/i;

/** True when a DSH turn outcome failed because the provider does not serve
 *  the requested model id — a kernel-normalized model-missing code, or an
 *  upstream model-not-found fingerprint in the raw message. */
export function isConfigModelMissingDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = String(outcome.error?.code ?? '').toUpperCase();
  if (code === 'MODEL_NOT_FOUND' || code === 'MODEL_DOES_NOT_EXIST') return true;
  return MODEL_MISSING_ERROR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''));
}

/** Runtime boot failed before the prompt was submitted. This is eligible for
 *  the fallback route, but the retry must carry the original user prompt. */
export function isRuntimeBootDshTurnError(outcome: { kind?: string; error?: { code?: string } }): boolean {
  return outcome?.kind === 'error' && outcome.error?.code === DSH_RUNTIME_BOOT_ERROR_CODE;
}

/** True when a DSH turn outcome failed in a way that retrying the SAME route
 *  cannot heal: the credential was rejected, the model id is not served, or
 *  the request itself was deterministically refused (INVALID_REQUEST — a 4xx
 *  schema/serde rejection that repeats byte-identical for the same history).
 *  Drives the per-session route circuit breaker in runDshSessionLocal;
 *  transient, quota and overflow deaths keep their own ladders. */
export function isWontHealDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  if (isAuthDshTurnError(outcome) || isConfigModelMissingDshTurnError(outcome)) return true;
  return String(outcome.error?.code ?? '').toUpperCase() === 'INVALID_REQUEST';
}

/**
 * Upstream "request exceeds the model's context window" fingerprints mirrored
 * from provider error bodies (OpenAI-compat relays, DeepSeek, aggregator
 * gateways). ASCII upstream error fingerprints only — never natural-language
 * intent. Deliberately does NOT include the HTTP 413 "request (entity) too
 * large" family — that shape is the transport byte cap (isBodyLimitDshTurnError),
 * not a context-window problem. A bare `400 status code` with no body does NOT
 * classify on its own: too many non-overflow failures share that shape;
 * recovery for that shape is paired with the compaction-failure signal in
 * runDshSessionLocal instead.
 */
const OVERFLOW_ERROR_MESSAGE_FINGERPRINT = /maximum[ _-]context[ _-]length|context[ _-]length[ _-]?(exceed|too[ _-]long)|exceeds?[ _-]the[ _-]?(maximum[ _-]?)?(context|model)[ _-]?(length|window)|too[ _-]many[ _-](input[ _-])?tokens|prompt[ _-]is[ _-]too[ _-]long|input[ _-]?(length|tokens?)[ _-]exceed/i;

/**
 * Upstream "request body exceeds the transport byte limit" fingerprints —
 * the HTTP 413 family (nginx "413 Request Entity Too Large", express
 * "request entity too large", the metaid-free relay's
 * `413: request_too_large: ...` detail). ASCII transport fingerprints only.
 * The `\b413\b` guard cannot match inside longer numbers (`4413`, `41312`).
 */
const BODY_LIMIT_ERROR_MESSAGE_FINGERPRINT = /\b413\b|request[ _-](entity[ _-])?too[ _-]large/i;

/** True when a DSH turn outcome failed because the request BODY exceeded the
 *  relay/transport byte cap (HTTP 413 family) — NOT because the conversation
 *  crossed the model's context window (2026-10-04 metaid-free incident: the
 *  relay's body cap answered `413: request_too_large` for long sessions and
 *  for the compaction request alike, and the old classifier mistook it for
 *  overflow, switching sessions onto the paid fallback brain while the real
 *  fix was a client-side contextWindow misconfiguration). A 413 at realistic
 *  context sizes is a history-management anomaly (the serialized history
 *  should be a few hundred KB against a 2MB cap), so callers must surface it
 *  as its own error and must NOT spend the fallback model's quota on it. */
export function isBodyLimitDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = String(outcome.error?.code ?? '').toUpperCase();
  if (code === 'REQUEST_TOO_LARGE' || code === 'PAYLOAD_TOO_LARGE') return true;
  return BODY_LIMIT_ERROR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''));
}

/** 0.2.2 kernel code for a model switch that was aborted because compacting
 *  the history with the PREVIOUS model failed before the smaller-window target
 *  could serve. The kernel preserves the previous route; the session is
 *  healthy on it — the operator just picked a target that cannot hold the
 *  history yet. */
export const MODEL_SWITCH_COMPACTION_FAILED_ERROR_CODE = 'MODEL_SWITCH_COMPACTION_FAILED';

/** True when a DSH turn outcome failed because a mid-session model switch was
 *  aborted by pre-switch compaction (0.2.2 kernel `agent/request` model-switch
 *  pricing). Decisively NOT an overflow of the serving route: the old model is
 *  preserved and works, so the fallback-brain ladder must not engage (the
 *  message embeds the compaction cause, whose text can carry overflow
 *  fingerprints — the code check must win). The fix is operator-side: pick a
 *  larger-window target or compact first. */
export function isModelSwitchCompactionFailedDshTurnError(outcome: { kind?: string; error?: { code?: string; message?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  return String(outcome.error?.code ?? '').toUpperCase() === MODEL_SWITCH_COMPACTION_FAILED_ERROR_CODE;
}

/** Native tools the auto reviewer judges before execution: the mutating
 * members of the runtime policy gate's set (read/read_image stay
 * observation-only and are never reviewed). */
export const AUTO_REVIEW_TOOL_NAMES: ReadonlySet<string> = new Set(['bash', 'write', 'edit', 'delete']);

/** True when a passing policy check should be LLM-reviewed instead of
 * blind-allowed (0.2.2 headless auto review). Only UNATTENDED sessions review:
 * `autoApprove` (A2A, orchestrator/worker, scheduled tasks — nobody answers
 * dialogs, so the session's own model is the only reviewer available).
 * `bypassPermissions` stays a true bypass (the operator explicitly chose zero
 * checks), attended modes keep their guard behavior, and per-tool
 * `autoApproveTools` stays an owner's explicit no-check choice for that tool.
 * The runtime's policy gate runs the session's own model as the reviewer and
 * a denial is final. */
export function shouldAutoReviewDshToolCall(input: {
  toolName: string;
  autoApprove?: boolean | null;
  permissionMode?: string | null;
}): boolean {
  if (!AUTO_REVIEW_TOOL_NAMES.has(String(input.toolName ?? '').toLowerCase())) return false;
  return input.autoApprove === true;
}

/** True when a DSH turn outcome failed because the request exceeded the
 *  model's context window — a kernel-normalized overflow code, or an upstream
 *  overflow fingerprint in the raw message. Retrying on the same route cannot
 *  succeed (history cannot shrink mid-request), but the bot's fallback brain
 *  may resolve to a route with a larger context window, and the terminal
 *  transcript error should tell the operator the session needs compaction or
 *  a fresh session rather than a blind resend. */
export function isOverflowDshTurnError(
  outcome: { kind?: string; error?: { code?: string; message?: string } },
  context: { compactionFailedThisTurn?: boolean } = {},
): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = String(outcome.error?.code ?? '').toUpperCase();
  // A failed model switch (0.2.2 pre-switch compaction) is decisive
  // NON-overflow of the serving route — the previous model is preserved and
  // healthy, and the kernel message embeds the compaction cause whose text
  // can carry overflow fingerprints. Must be checked before the code/finger
  // print families so a switch failure never routes the session onto the
  // fallback brain (the operator picked the target model deliberately).
  if (code === MODEL_SWITCH_COMPACTION_FAILED_ERROR_CODE) return false;
  // CONTEXT_WINDOW_EXCEEDED is the code this incident actually shipped with
  // (2026-09-28 cowork.log: opencode zen deepseek-flash returned
  // `{ message: '400 status code (no body)', code: 'CONTEXT_WINDOW_EXCEEDED' }`
  // three times on the wedged session).
  if (code === 'CONTEXT_LENGTH' || code === 'CONTEXT_OVERFLOW' || code === 'CONTEXT_WINDOW_EXCEEDED') return true;
  // The 413 body-limit family is decisive NON-overflow: it fires on request
  // byte size before the model ever counts tokens, and it must never route a
  // session onto the fallback brain (see isBodyLimitDshTurnError).
  if (isBodyLimitDshTurnError(outcome)) return false;
  if (OVERFLOW_ERROR_MESSAGE_FINGERPRINT.test(String(outcome.error?.message ?? ''))) return true;
  // Bare `400 status code (no body)` never classifies on the message alone —
  // but when the SAME turn also logged a failed auto-compaction (the
  // 2026-09-28 compaction-deadlock incident: history over the context window
  // killed both the compaction request and the turn with identical bodyless
  // 400s), the pairing is decisive evidence of overflow.
  if (context.compactionFailedThisTurn === true && /^\s*400[^\n]*no body/i.test(String(outcome.error?.message ?? ''))) return true;
  return false;
}

const NON_ANSWER_PLACEHOLDERS = new Set<string>([
  DEEPSEEK_RESPONSES_REASONING_PLACEHOLDER,
]);

/** True when a candidate assistant reply is empty or a known non-answer placeholder. */
export function isNonAnswerAssistantReply(text: string): boolean {
  const trimmed = String(text ?? '').trim();
  return trimmed.length === 0 || NON_ANSWER_PLACEHOLDERS.has(trimmed);
}

/**
 * True when an SDK `result` event (already known to be a success — callers
 * gate on `subtype === 'success'`) carries no usable final reply text.
 *
 * `payload.result` is the SDK's authoritative final-answer string for the
 * turn. When it is missing/empty/whitespace, the terminal assistant message
 * had no text — the DeepSeek thinking-placeholder truncation signature (the
 * model emitted only `[reasoning unavailable]` reasoning, then `end_turn`).
 * Intermediate progress notes do NOT count: they precede further tool work,
 * and the SDK still populates `result` with the real final answer when one
 * exists. Used by the empty-terminal-turn guard in CoworkRunner so such turns
 * are not falsely reported as `completed`.
 */
export function isEmptyTerminalSdkResult(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return true;
  const result = (payload as Record<string, unknown>).result;
  return !(typeof result === 'string' && result.trim().length > 0);
}
