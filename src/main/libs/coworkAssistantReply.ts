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

/** True when a DSH turn outcome is an error whose failure code is transient
 *  (environmental) and therefore worth an automatic turn-level resume. */
export function isTransientDshTurnError(outcome: { kind?: string; error?: { code?: string } }): boolean {
  if (outcome?.kind !== 'error') return false;
  const code = outcome.error?.code;
  return typeof code === 'string' && TRANSIENT_TURN_ERROR_CODES.has(code);
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
