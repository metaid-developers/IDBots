/**
 * Shared helpers for MetaBot fallback LLM (secondary brain) support.
 * Kept dependency-light so the retry policy can be unit-tested from compiled
 * output without touching real provider configs or the network.
 */

import type { Metabot } from '../types/metabot';
import { toLlmEffortLevel, type LlmEffortLevel } from '../libs/llmEffort';
import { classifyOneShotLlmTerminalError, type OneShotLlmTerminalKind } from '../libs/llmTerminalError';

/** Normalize a raw llm id (model id or legacy provider key) for use in LLM calls; null when unusable. */
export function normalizeMetabotLlmId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

/**
 * Resolve the effective fallback llm id: the trimmed fallback when it is
 * non-empty and names a different brain than the primary; otherwise null (no
 * retry). "Different brain" compares the (model id, provider) pair, not the
 * model id alone: a bot whose primary and fallback share a model id on
 * different providers (e.g. glm-5.3-flash @ zhipu primary, glm-5.3-flash @
 * volcengine fallback) HAS a meaningful backup — the same id on another
 * gateway resolves to a different baseURL/apiKey. Id-only comparison silently
 * discarded that backup, so a single-provider outage failed the run with no
 * safety net (the 2026-09-20 dream 502s). When either provider is unknown the
 * legacy id-only rule applies (same id, no fallback).
 */
export function resolveFallbackLlmId(
  primaryLlmId: unknown,
  fallbackLlmId: unknown,
  primaryLlmProvider?: unknown,
  fallbackLlmProvider?: unknown
): string | null {
  const fallback = normalizeMetabotLlmId(fallbackLlmId);
  if (!fallback) return null;
  const primary = normalizeMetabotLlmId(primaryLlmId);
  if (!primary || fallback !== primary) return fallback;
  const primaryProvider = normalizeMetabotLlmId(primaryLlmProvider);
  const fallbackProvider = normalizeMetabotLlmId(fallbackLlmProvider);
  if (!fallbackProvider) return null;
  return fallbackProvider !== primaryProvider ? fallback : null;
}

/** The metabot brain pair as used by automation LLM calls (A2A chat, group tasks, dreams, impressions). */
export interface MetabotBrainOptions {
  /** Primary brain: model id (new) or legacy provider key. */
  llmId: string | null;
  /** Provider key the primary brain model was picked from. */
  llmProvider: string | null;
  /** Primary brain reasoning effort (off/low/high/max); null = model default. */
  effort: LlmEffortLevel | null;
  fallbackLlmId: string | null;
  fallbackLlmProvider: string | null;
  fallbackEffort: LlmEffortLevel | null;
}

/**
 * Extract a metabot's brain pair: model ids (or legacy provider keys),
 * provider hints, and per-brain reasoning efforts. This is the single seam
 * automation call sites use so the "bot brain = model + effort" rule stays
 * consistent across A2A private chat, group tasks, dreams, impressions, and
 * the guest/order daemons.
 */
export function metabotBrainOptions(metabot: Partial<Pick<Metabot,
  'llm_id' | 'llm_provider' | 'llm_effort' | 'fallback_llm_id' | 'fallback_llm_provider' | 'fallback_llm_effort'
>> | null | undefined): MetabotBrainOptions {
  return {
    llmId: normalizeMetabotLlmId(metabot?.llm_id),
    llmProvider: normalizeMetabotLlmId(metabot?.llm_provider),
    effort: toLlmEffortLevel(metabot?.llm_effort),
    fallbackLlmId: normalizeMetabotLlmId(metabot?.fallback_llm_id),
    fallbackLlmProvider: normalizeMetabotLlmId(metabot?.fallback_llm_provider),
    fallbackEffort: toLlmEffortLevel(metabot?.fallback_llm_effort),
  };
}

/**
 * The fleet-level "system brain": the Twin Bot's brain pair (primary +
 * fallback + efforts). Fleet/system automations that do NOT act for one
 * specific bot (culture distillation, staffing intent classification, memory
 * judging, session titling, agent-game moves) must ride this pair instead of
 * the bare app default model — the default may be the metaid-free onboarding
 * model, whose exhausted free quota must never zero system features. When no
 * twin exists or it has no brain configured, every field is null and callers
 * keep the app-default behavior (new-user onboarding).
 */
export function resolveSystemBrainOptions(
  metabots: Array<Partial<Pick<Metabot,
    'metabot_type' | 'llm_id' | 'llm_provider' | 'llm_effort'
    | 'fallback_llm_id' | 'fallback_llm_provider' | 'fallback_llm_effort'
  >>> | null | undefined,
): MetabotBrainOptions {
  const twin = (metabots ?? []).find((bot) => bot?.metabot_type === 'twin') ?? null;
  return metabotBrainOptions(twin);
}

export interface LlmFallbackCallOptions {
  llmId?: string | null;
  /** Provider key the primary brain model was picked from. */
  llmProvider?: string | null;
  fallbackLlmId?: string | null;
  /** Provider key the fallback brain model was picked from. */
  fallbackLlmProvider?: string | null;
  /** Effort riding the primary brain (off/low/high/max); null = model default. */
  effort?: LlmEffortLevel | null;
  /** Effort riding the fallback brain; null = model default. */
  fallbackEffort?: LlmEffortLevel | null;
  /**
   * Per-attempt timeout in ms. When set, EACH attempt (primary and fallback)
   * gets its own fresh AbortSignal.timeout, still linked to the caller's
   * signal for real cancellation — a primary that burns its whole window no
   * longer leaves the fallback retry a dead shared signal (the 2026-09-03
   * dream/dream-diary failures: GLM primary timed out and the fallback never
   * actually ran).
   */
  attemptTimeoutMs?: number;
  /**
   * Set when the attempt transport builds its own per-attempt deadline
   * (cognitiveChatCompletion.buildOneShotAttemptDeadline: caller signal +
   * total cap + streaming idle watchdog, with the total/idle semantics chosen
   * by attemptTimeoutKind). withPerAttemptSignal must not wrap the caller
   * signal in AbortSignal.timeout on top — that would re-impose the old
   * total-only semantics and cut steadily-flowing long generations, exactly
   * what the streaming transport exists to stop (the 2026-11-20 ABS relay
   * handoff: glm non-stream avg 45.6s against 45-60s total caps).
   */
  streamingTransport?: boolean;
}

/**
 * Derive the options for one attempt: when attemptTimeoutMs is set, swap the
 * caller's signal for a fresh per-attempt timeout linked to it, so each
 * attempt gets the full window while caller cancellation still propagates.
 * Skipped when the transport owns the deadline (streamingTransport).
 */
function withPerAttemptSignal<TOptions extends LlmFallbackCallOptions>(options: TOptions): TOptions {
  const timeoutMs = options.attemptTimeoutMs;
  if (!timeoutMs || timeoutMs <= 0 || options.streamingTransport) return options;
  const callerSignal = (options as { signal?: AbortSignal }).signal;
  const attemptSignal = callerSignal
    ? AbortSignal.any([callerSignal, AbortSignal.timeout(timeoutMs)])
    : AbortSignal.timeout(timeoutMs);
  return { ...options, signal: attemptSignal };
}

/**
 * Run `attempt` with the primary llm id; when it throws (config resolution
 * failure or API call failure), retry exactly once with the fallback llm id
 * when one is configured and names a different brain than the primary (model
 * id, or same id on a different provider — see resolveFallbackLlmId). The
 * retry swaps BOTH the model and the effort to the fallback brain's pair.
 * Rethrows the primary error when no fallback is available; when the fallback
 * attempt also fails, throws a combined error naming both failures so callers
 * (dream diary, memory-hygiene stats) can tell the fallback DID run and why
 * it failed.
 */
export async function runWithLlmFallback<TResult, TOptions extends LlmFallbackCallOptions>(
  options: TOptions,
  attempt: (options: TOptions) => Promise<TResult>,
  log: (message: string) => void = console.log
): Promise<TResult> {
  try {
    return await attempt(withPerAttemptSignal(options));
  } catch (primaryError) {
    const fallbackId = resolveFallbackLlmId(
      options.llmId,
      options.fallbackLlmId,
      options.llmProvider,
      options.fallbackLlmProvider
    );
    if (!fallbackId) {
      throw primaryError;
    }
    // Callers may pass ONE shared abort signal (e.g. AbortSignal.timeout)
    // through options; when the primary attempt consumed it, the fallback
    // attempt would fail instantly with the same abort/timeout — skip the
    // dead retry and surface the primary error directly. (Per-attempt
    // timeouts via attemptTimeoutMs keep the caller's signal live, so a
    // primary timeout no longer trips this guard.)
    const sharedSignal = (options as { signal?: AbortSignal }).signal;
    if (sharedSignal?.aborted) {
      throw primaryError;
    }
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const primaryLabel = normalizeMetabotLlmId(options.llmId) ?? 'default';
    const fallbackProvider = normalizeMetabotLlmId(options.fallbackLlmProvider);
    const fallbackLabel = fallbackProvider ? `${fallbackId}@${fallbackProvider}` : fallbackId;
    log(`[LLM Fallback] Primary LLM '${primaryLabel}' failed (${primaryMessage}); retrying once with fallback '${fallbackLabel}'.`);
    try {
      return await attempt(withPerAttemptSignal({
        ...options,
        llmId: fallbackId,
        llmProvider: options.fallbackLlmProvider ?? null,
        fallbackLlmId: null,
        fallbackLlmProvider: null,
        effort: options.fallbackEffort ?? null,
      }));
    } catch (fallbackError) {
      const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      console.error(`[LLM Fallback] Fallback LLM '${fallbackLabel}' also failed: ${fallbackMessage}`);
      const combined = new Error(`${primaryMessage} (fallback '${fallbackLabel}' also failed: ${fallbackMessage})`);
      if (primaryError instanceof Error && primaryError.name && primaryError.name !== 'Error') {
        combined.name = primaryError.name;
      }
      throw combined;
    }
  }
}

/** A last-resort route offered by the system rescue rung. */
export interface SystemRescueRoute {
  llmId: string;
  llmProvider: string;
}

/** Details of a successful system rescue, for owner-facing notification. */
export interface BrainRescueInfo {
  fromLlmId: string | null;
  fromProvider: string | null;
  toLlmId: string;
  toProvider: string;
  /** Terminal class of the failure that triggered the rescue. */
  kind: OneShotLlmTerminalKind;
  /** Message of the error that triggered the rescue. */
  triggerError: string;
}

export interface SystemRescueRunOptions {
  /**
   * Resolve the last-resort route given the (model, provider) pairs already
   * tried this call; null when no usable alternative exists. Injected so this
   * module stays store-free and unit-testable — the production resolver is
   * claudeSettings.resolveSystemRescueBrain.
   */
  resolveRescue: (tried: Array<{ llmId: string | null; llmProvider: string | null }>) => SystemRescueRoute | null;
  /** Called after a rescue attempt SUCCEEDS, so callers can surface the switch. */
  onRescue?: (info: BrainRescueInfo) => void;
}

/**
 * The rung BELOW the fallback brain (2026-10-23 new-user free-quota post-mortem):
 * a bot whose primary brain died on a terminal error (quota exhausted, auth
 * rejected, model/config not served) and whose fallback brain is unset or also
 * failed used to die outright — in passive scenarios (private chat, group tasks,
 * dreams) that meant a silently consumed message. When every configured brain
 * fails TERMINALLY, this wrapper makes ONE attempt on a system-resolved route
 * (e.g. the user's own provider key they configured but never wired into the
 * bot's brain settings).
 *
 * Gated strictly on terminal classification: transient failures (timeout, 5xx,
 * connection reset, bare 429 rate limit) rethrow untouched, so a rescue switch
 * never masks a flaky network and never bills another provider for a blip.
 * The rescue attempt drops the caller's effort override (a different model
 * family's default is safer than a mismatched effort) and gets its own fresh
 * per-attempt timeout window like any other attempt. Nothing is anchored — the
 * next call re-resolves from the bot's own brain settings.
 */
export async function runWithSystemRescue<TResult, TOptions extends LlmFallbackCallOptions>(
  options: TOptions,
  attempt: (options: TOptions) => Promise<TResult>,
  rescue: SystemRescueRunOptions,
  log: (message: string) => void = console.log
): Promise<TResult> {
  try {
    return await runWithLlmFallback(options, attempt, log);
  } catch (error) {
    const kind = classifyOneShotLlmTerminalError(error);
    if (!kind) throw error;
    const sharedSignal = (options as { signal?: AbortSignal }).signal;
    if (sharedSignal?.aborted) throw error;

    const tried: Array<{ llmId: string | null; llmProvider: string | null }> = [
      { llmId: normalizeMetabotLlmId(options.llmId), llmProvider: normalizeMetabotLlmId(options.llmProvider) },
    ];
    const fallbackId = resolveFallbackLlmId(
      options.llmId,
      options.fallbackLlmId,
      options.llmProvider,
      options.fallbackLlmProvider
    );
    if (fallbackId) {
      tried.push({ llmId: fallbackId, llmProvider: normalizeMetabotLlmId(options.fallbackLlmProvider) });
    }

    const route = rescue.resolveRescue(tried);
    if (!route) throw error;

    const fromLabel = tried[0]?.llmId ?? 'default';
    const fromProvider = tried[0]?.llmProvider ?? null;
    const rescueLabel = `${route.llmId}@${route.llmProvider}`;
    const triggerMessage = error instanceof Error ? error.message : String(error);
    log(
      `[LLM Rescue] Brain '${fromLabel}' failed terminally (${kind}); ` +
      `making one rescue attempt on '${rescueLabel}'.`
    );
    try {
      const result = await attempt(withPerAttemptSignal({
        ...options,
        llmId: route.llmId,
        llmProvider: route.llmProvider,
        fallbackLlmId: null,
        fallbackLlmProvider: null,
        effort: null,
        fallbackEffort: null,
      }));
      try {
        rescue.onRescue?.({
          fromLlmId: tried[0]?.llmId ?? null,
          fromProvider,
          toLlmId: route.llmId,
          toProvider: route.llmProvider,
          kind,
          triggerError: triggerMessage,
        });
      } catch { /* owner notification is best-effort and must never fail the call */ }
      return result;
    } catch (rescueError) {
      const rescueMessage = rescueError instanceof Error ? rescueError.message : String(rescueError);
      console.error(`[LLM Rescue] Rescue route '${rescueLabel}' also failed: ${rescueMessage}`);
      throw new Error(`${triggerMessage} (system rescue '${rescueLabel}' also failed: ${rescueMessage})`);
    }
  }
}
