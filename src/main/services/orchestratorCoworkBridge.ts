/**
 * Bridge: run one orchestrator "skill turn" via CoworkRunner so the same
 * skill list + Read/Bash logic is used as in local Cowork (no duplicate prompts).
 */

import type { CoworkRunner } from '../libs/coworkRunner';
import type { CoworkStore } from '../coworkStore';
import { isNonAnswerAssistantReply } from '../libs/coworkAssistantReply';
import { generateSessionTitle } from '../libs/coworkUtil';
import { buildOrchestratorSessionTitle } from '../libs/orchestratorSessionTitle';
import { isSqliteWasmBoundsError } from '../sqliteRecovery';
import { isDshShutdownError } from '../libs/dshShutdownError';
import type { PracticeSessionState } from '../libs/practiceInteractionGuard';
import {
  claimManagedOrchestratorSession,
  resolveOrchestratorPermissionReply,
} from './orchestratorPermissionRelay';
import { noteOwnerAskTurnTimeout } from './pendingOwnerAskBridge';
import {
  advanceWrapUpMachine,
  buildExtensionGrantedMessage,
  buildWrapUpMessage,
  EXTENSION_REQUEST_MARKER,
  initialWrapUpMachineState,
  resolveWrapUpRuntimeConfig,
  type WrapUpEffect,
} from '../libs/skillTurnWrapUpState';

const SKILL_TURN_TIMEOUT_MS = 300_000;
/**
 * Default late-completion window for existing-session skill turns (see
 * RunExistingSessionSkillTurnParams.lateCompletionTimeoutMs). 10 min keeps
 * watchdog + window (30 + 10 min at the group-task binding) inside the
 * daemon's 45-min hard in-flight cap, so a late success settles before the
 * guard is force-settled and re-driven.
 */
const SKILL_TURN_LATE_COMPLETION_WINDOW_MS = 10 * 60_000;
/**
 * How long the bridge keeps watching a session after the skill-turn watchdog
 * fires. The watchdog only detaches the caller's promise: the worker session
 * keeps running inside CoworkRunner and may legitimately deliver its result
 * hours later (a real delegation took ~8h). Late results are handed to
 * onLateCompletion so the attempt can be corrected to completed instead of
 * staying permanently failed. If the session neither completes nor terminates
 * within this window, recovery is abandoned via onRecoveryExpired.
 */
const SKILL_TURN_RECOVERY_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Error the skill-turn promise rejects with when the watchdog fires. Carries
 * the sessionId so the caller can keep tracking the still-running session and
 * correct its attempt state when a late result eventually arrives.
 */
export class SkillTurnTimeoutError extends Error {
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`Skill turn timed out after ${timeoutMs / 1000}s`);
    this.name = 'SkillTurnTimeoutError';
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}

export interface RunOrchestratorSkillTurnParams {
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  /** MetaBot id for this group task; session will use its wallet env for skill scripts. */
  metabotId?: number;
  groupId?: string | null;
  triggerReason?: string;
  supervisorGlobalmetaid?: string | null;
  latestMessageSenderGlobalmetaid?: string | null;
  activeSkillIds?: string[];
  disableRemoteServicesPrompt?: boolean;
  sourceChannel?: 'metaweb_group' | 'metaweb_private' | 'orchestrator';
  /** Optional lifecycle hook used by durable orchestration before execution starts. */
  onSessionCreated?: (sessionId: string) => Promise<void> | void;
  /** Background delegation may opt into a bounded permission mode. */
  autoApprove?: boolean;
  disableMemoryUpdates?: boolean;
  /**
   * M4 nightly study session: restricts the inline tool surface to the
   * learning allowlist and hard-caps metaweb-source KB adds at pinBudget.
   */
  metawebStudySession?: { pinBudget: number; kind?: 'topic' | 'qa-surf'; kbAddsUsed?: number };
  /**
   * MetaWeb surf session: restricts the inline tool surface to the surf
   * allowlist and hard-caps chain writes at interactionBudget (KB adds at
   * kbBudget) through the guards in coworkRunner. Counters live on this
   * object so a per-turn tool-surface rebuild cannot reset them (P2.1).
   */
  metawebSurfSession?: import('../libs/surfInteractionGuard').SurfSessionWriteState;
  /**
   * Static session title. When set, the title-summarization LLM call is
   * skipped entirely and the localized orchestrator prefix is composed with
   * this body instead. For unattended sessions that are hidden from the
   * session list (surf/study/exam) the generated title is never displayed,
   * so the per-session title LLM call is pure token waste.
   */
  sessionTitle?: string;
  permissionMode?: 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions';
  /** Overrides the skill-turn watchdog timeout (ms). Defaults to 300s. */
  skillTurnTimeoutMs?: number;
  /**
   * ACTIVE wrap-up mechanism for Twin→Worker delegations — OPT-IN, nothing
   * changes for callers that leave it undefined (group-task, A2A, study,
   * surf, private-chat routing keep the legacy passive watchdog exactly).
   *
   * When set, the budget watchdog no longer passively parks the turn: the
   * bridge injects ONE wrap-up cross-session message ("budget exhausted;
   * stop exploring; write your handoff NOW; ask for ONE extension by
   * starting your reply with `EXTENSION_REQUEST: <reason>`, else start with
   * `WRAP_UP:`") and runs the grace/extension timers through the pure state
   * machine in libs/skillTurnWrapUpState.ts. A reply that is anything other
   * than a first-time extension request resolves the turn normally with that
   * reply as the handoff. The whole sequence (budget + grace, or budget +
   * capped extension + final grace) is hard-capped at the 45-min daemon
   * watchdog documented there.
   */
  wrapUpSignal?: {
    /** Grace window (ms) after the wrap-up signal. Defaults to 5 min. */
    graceMs?: number;
    /** Requested extension as a ratio of the original budget. Defaults to 0.5. */
    extensionRatio?: number;
    /**
     * Injection seam for the wrap-up / extension messages. The bridge has no
     * session identity of its own to insert a cross-session message with, so
     * the delegating service provides the injector (the Twin service injects
     * as the Twin session, the same seam as its ORCH-NOTIFY path). When
     * omitted the machine still runs — bounded windows, completions resolve —
     * but no signal is delivered and a warning is logged.
     */
    injectMessage?: (message: string) => void | Promise<void>;
  };
  /**
   * How long (ms) the bridge keeps watching the session after the watchdog
   * fires so a still-running worker session can deliver a late result.
   * Defaults to 12h. Only matters when the session outlives the watchdog.
   */
  lateCompletionTimeoutMs?: number;
  /** Called when the session completes after the watchdog fired (late result). */
  onLateCompletion?: (late: { sessionId: string; replyText: string }) => void | Promise<void>;
  /** Called when the session errors or is stopped after the watchdog fired. */
  onLateTermination?: (late: { sessionId: string; reason: 'error' | 'stopped'; message?: string }) => void | Promise<void>;
  /** Called when the recovery window expires without any terminal session event. */
  onRecoveryExpired?: (late: { sessionId: string }) => void | Promise<void>;
  /**
   * Dream review P2-1: practice-session marker for read_only isolated runs
   * (frozen exams) — forwarded to runner.startSession so the practice
   * interaction guard constrains every tool call. Absent → unrestricted
   * (every existing caller).
   */
  practiceSession?: PracticeSessionState;
}

export interface RunExistingSessionSkillTurnParams {
  sessionId: string;
  systemPrompt: string;
  userMessage: string;
  cwd: string;
  activeSkillIds?: string[];
  disableRemoteServicesPrompt?: boolean;
  /**
   * Group-task skill turns: start the session in READ-ONLY memory mode
   * (volatile memory read injection + read-only recall tools stay on, every
   * write stays off) INSTEAD of the legacy disableMemoryUpdates blackout,
   * which suppressed reads too and left worker turns with no memory context
   * at all. Only the group-task binding in main.ts sets this; other callers
   * keep the blackout default.
   */
  memoryReadOnly?: boolean;
  onSkillExecutionStart?: () => Promise<void> | void;
  /**
   * Overrides the skill-turn watchdog timeout (ms). Defaults to 300s.
   * Group-task turns run real pipelines (video/audio generation, batch file
   * work) that routinely exceed 5 min, so the group-task daemon passes a much
   * larger budget — the 300s delegation default systematically timed out
   * mid-work and the daemon's message retries then re-ran the same turn five
   * times before dropping the trigger message unanswered (task #41).
   */
  skillTurnTimeoutMs?: number;
  /**
   * Late-completion window (ms) AFTER the watchdog fires. The watchdog only
   * detaches the caller's promise in the OLD contract; here the promise stays
   * pending while the turn keeps running inside the runner. A session that
   * completes within this window resolves the turn NORMALLY (the reply flows
   * through the caller's standard posting path — task #64: eleven's 31-min
   * turn finished its full deliverable report 90s after the 30-min watchdog
   * fired, and the detached-listener contract silently discarded it, forcing
   * the group to re-live the 32-min-old welcome trigger instead). Only when
   * the session errors, stops, or stays silent past this window does the
   * promise reject with SkillTurnTimeoutError (the legacy behavior).
   * Defaults to 10 min. Keep watchdog + window below the group-task daemon's
   * 45-min hard in-flight cap so a late success settles inside the guard.
   */
  lateCompletionTimeoutMs?: number;
}

export interface RunExistingSessionSkillTurnResult {
  replyText: string;
  assistantMessageId: string | null;
}

/**
 * Extract the final usable assistant reply from a session's messages.
 *
 * A message counts as a usable final reply only when ALL of these hold:
 * - it is an assistant text message (not a persisted thinking block);
 * - it is not a known non-answer placeholder (e.g. DeepSeek's
 *   `[reasoning unavailable]` can be persisted as thinking content);
 * - it is not followed by any tool_use/tool_result — text emitted before
 *   more tool activity is an intermediate progress note, not the handoff.
 *
 * This prevents a worker session that ended with a reasoning-only turn (no
 * real text output) from being reported as a successful completion with
 * `[reasoning unavailable]` as its "reply".
 */
export function extractFinalAssistantReply(
  messages: Array<{ id: string; type: string; content: string; metadata?: Record<string, unknown> }>
): { replyText: string; assistantMessageId: string | null } {
  let sawToolAfter = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message) continue;
    if (message.type === 'tool_use' || message.type === 'tool_result') {
      sawToolAfter = true;
      continue;
    }
    if (message.type !== 'assistant') continue;
    if (message.metadata?.privateChatSkillWaitNotice === true) continue;
    if (message.metadata?.isThinking === true) continue;
    // Assistant-mode narration bubbles are interim commentary, not the
    // final answer; consumers here (A2A replies, orchestrator workers,
    // dreams) must skip them exactly like thinking — otherwise a
    // commentary-only turn gets narrated to the peer as the reply.
    if (message.metadata?.narration === true) continue;
    const content = String(message.content ?? '');
    if (isNonAnswerAssistantReply(content)) continue;
    if (sawToolAfter) continue; // intermediate text, more tool activity followed
    return { replyText: content.trim(), assistantMessageId: message.id ?? null };
  }
  return { replyText: '', assistantMessageId: null };
}

/**
 * Resolve the session title for an orchestrator-delegated (non-group) worker
 * session: localized prefix + LLM one-sentence summary of the delegation
 * content, using the same summarization logic as regular Co-Worker session
 * titles (generateSessionTitle — whose prompt already forces the title to be
 * in the same language as the input, so a Chinese delegation yields a Chinese
 * title and an English delegation an English one). On summarization failure
 * the title falls back to a meaningful fragment of the delegation objective
 * instead of an opaque timestamp.
 */
async function resolveOrchestratorSessionTitle(store: CoworkStore, userMessage: string): Promise<string> {
  let summary: string | null = null;
  try {
    summary = await generateSessionTitle(userMessage);
  } catch (error) {
    if (isSqliteWasmBoundsError(error)) throw error;
    console.warn(
      '[Orchestrator] Session title summarization failed, using fallback title:',
      error instanceof Error ? error.message : String(error)
    );
  }
  return buildOrchestratorSessionTitle(store.getAppLanguage(), summary, userMessage);
}

/**
 * Run one skill turn using CoworkRunner: create a new session,
 * startSession with autoApprove, wait for 'complete', extract last assistant
 * content, keep session for UI visibility, return reply text.
 */
export async function runOrchestratorSkillTurn(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunOrchestratorSkillTurnParams
): Promise<string> {
  const {
    systemPrompt,
    userMessage,
    cwd,
    metabotId,
    groupId,
    triggerReason,
    supervisorGlobalmetaid,
    latestMessageSenderGlobalmetaid,
    activeSkillIds = [],
    disableRemoteServicesPrompt = true,
    sourceChannel,
    onSessionCreated,
    autoApprove = true,
    disableMemoryUpdates = true,
    permissionMode = 'default',
    metawebStudySession,
    metawebSurfSession,
    practiceSession,
  } = params;

  const now = Date.now();
  const normalizedGroupId = (groupId ?? '').trim();
  const staticTitleBody = params.sessionTitle?.trim() || '';
  const sessionTitle = normalizedGroupId
    ? `Group-${normalizedGroupId.slice(0, 12)}-${now}`
    : staticTitleBody
      // Unattended hidden sessions: the caller-supplied body replaces the
      // title-summarization LLM call, which nothing would ever display.
      ? buildOrchestratorSessionTitle(store.getAppLanguage(), staticTitleBody, staticTitleBody)
      : await resolveOrchestratorSessionTitle(store, userMessage);
  const externalConversationId = normalizedGroupId
    ? `metaweb-group:${normalizedGroupId}:${now}`
    : `orchestrator:${now}`;

  const session = store.createSession(
    sessionTitle,
    cwd,
    systemPrompt,
    'local',
    activeSkillIds,
    metabotId ?? null
  );
  const sessionId = session.id;
  store.setSessionAutoOrigin(sessionId, 'orchestration');
  claimManagedOrchestratorSession(runner, sessionId, store);

  try {
    onSessionCreated?.(sessionId);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }

  if (normalizedGroupId && sourceChannel !== 'metaweb_private') {
    try {
      store.upsertConversationMapping({
        channel: 'metaweb_group',
        externalConversationId,
        metabotId: metabotId ?? null,
        coworkSessionId: sessionId,
      });
    } catch (error) {
      console.warn('[Orchestrator] Failed to upsert group conversation mapping:', error);
    }
  }

  const userMessageRecord = store.addMessage(sessionId, {
    type: 'user',
    content: userMessage,
    metadata: {
      sourceChannel: sourceChannel ?? (normalizedGroupId ? 'metaweb_group' : 'orchestrator'),
      externalConversationId,
      groupId: normalizedGroupId || undefined,
      skillIds: activeSkillIds,
      triggerReason,
      supervisorGlobalmetaid: supervisorGlobalmetaid ?? undefined,
      latestMessageSenderGlobalmetaid: latestMessageSenderGlobalmetaid ?? undefined,
    },
  });
  runner.emit('message', sessionId, userMessageRecord);

  const skillTurnTimeoutMs = params.skillTurnTimeoutMs ?? SKILL_TURN_TIMEOUT_MS;
  const lateCompletionTimeoutMs = params.lateCompletionTimeoutMs ?? SKILL_TURN_RECOVERY_WINDOW_MS;
  // ACTIVE wrap-up (Twin→Worker delegations only): undefined → every timer
  // below behaves exactly as before (byte-identical legacy passive watchdog).
  const wrapUpConfig = params.wrapUpSignal
    ? resolveWrapUpRuntimeConfig(params.wrapUpSignal, skillTurnTimeoutMs)
    : null;

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let recoveryActive = false;
    let recoveryWindowTimer: ReturnType<typeof setTimeout> | null = null;
    // Wrap-up machine state — only engaged when the caller passed
    // params.wrapUpSignal. `null` for every other caller.
    let wrapUp = wrapUpConfig ? initialWrapUpMachineState() : null;
    let wrapUpTimer: ReturnType<typeof setTimeout> | null = null;
    const turnStartedAt = Date.now();
    const wrapUpElapsedMs = () => Date.now() - turnStartedAt;

    const cleanup = () => {
      runner.off('complete', onComplete);
      runner.off('error', onError);
      runner.off('stopped', onStopped);
      if (timeoutId != null) clearTimeout(timeoutId);
      if (recoveryWindowTimer != null) clearTimeout(recoveryWindowTimer);
      if (wrapUpTimer != null) clearTimeout(wrapUpTimer);
    };

    const finish = (result: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.updateSession(sessionId, { status: 'error' });
      } catch (e) {
        console.warn('[Orchestrator] Failed to mark session error:', e);
      }
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    // Shutdown-abort path: app/host quit closed the DSH runtime mid-turn.
    // That is not a session failure — reject the caller's promise but leave
    // the session status alone (a 'running' remnant is normalized to 'idle'
    // by the next boot's resetRunningSessions).
    const cancelWithoutSessionError = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const extractLastAssistantContent = (): string => {
      const messages = store.getSession(sessionId)?.messages ?? [];
      return extractFinalAssistantReply(messages).replyText;
    };

    const reportLateCompletion = (replyText: string) => {
      cleanup();
      if (!params.onLateCompletion) return;
      const report = () => params.onLateCompletion!({ sessionId, replyText });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Late skill-turn completion callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Late skill-turn completion callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const reportLateTermination = (reason: 'error' | 'stopped', message?: string) => {
      cleanup();
      if (!params.onLateTermination) return;
      const report = () => params.onLateTermination!({ sessionId, reason, message });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Late skill-turn termination callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Late skill-turn termination callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const reportRecoveryExpired = () => {
      cleanup();
      if (!params.onRecoveryExpired) return;
      const report = () => params.onRecoveryExpired!({ sessionId });
      try {
        void Promise.resolve(report()).catch((error) => {
          console.warn('[Orchestrator] Skill-turn recovery expiry callback failed:', error instanceof Error ? error.message : String(error));
        });
      } catch (error) {
        console.warn('[Orchestrator] Skill-turn recovery expiry callback failed:', error instanceof Error ? error.message : String(error));
      }
    };

    const onComplete = (sid: string) => {
      if (sid !== sessionId) return;
      const lastAssistantContent = extractLastAssistantContent();
      if (wrapUp && wrapUpConfig && !settled && wrapUp.phase !== 'running') {
        // Wrap-up engaged: this completion is the worker's answer to the
        // wrap-up protocol — OR the original turn finishing late inside the
        // grace window; the pure machine treats both identically (anything
        // that is not a first-time EXTENSION_REQUEST resolves the turn with
        // the reply as the handoff).
        const result = advanceWrapUpMachine(
          wrapUp,
          { type: 'turn-completed', replyText: lastAssistantContent || '', elapsedMs: wrapUpElapsedMs() },
          wrapUpConfig,
        );
        wrapUp = result.state;
        applyWrapUpEffect(result.effect);
        return;
      }
      if (recoveryActive) {
        // Watchdog already fired: the session finished late. Hand the result to
        // the recovery callback so the attempt can be corrected to completed.
        reportLateCompletion(lastAssistantContent || '');
        return;
      }
      finish(lastAssistantContent || '');
    };

    const onError = (sid: string, errorMessage: string) => {
      if (sid !== sessionId) return;
      if (recoveryActive) {
        reportLateTermination('error', errorMessage);
        return;
      }
      if (isDshShutdownError(errorMessage)) {
        cancelWithoutSessionError(errorMessage);
        return;
      }
      fail(errorMessage);
    };

    // A stopped session settles the caller's promise WITHOUT rewriting the
    // session status (stopSession already recorded the deliberate 'stopped'
    // terminal state; fail() would clobber it with 'error'). Covers both the
    // pre-watchdog phase (Twin cancelled the task / stopped the worker) and
    // the recovery window via recoveryActive. P1-3 (task #39): the runner
    // carries the stop REASON on the event — reject with it so the attempt
    // record and the Twin notification can explain WHY the session died
    // (host storage recovery, app shutdown, Twin request…) instead of a bare
    // WORKER_SESSION_STOPPED.
    const onStopped = (sid: string, reason?: string) => {
      if (sid !== sessionId) return;
      if (recoveryActive) {
        reportLateTermination('stopped', reason);
        return;
      }
      if (settled) return;
      settled = true;
      cleanup();
      const detail = (reason ?? '').trim();
      reject(new Error(detail ? `WORKER_SESSION_STOPPED: ${detail}` : 'WORKER_SESSION_STOPPED'));
    };

    const enterRecovery = () => {
      recoveryActive = true;
      // Keep listening for a late 'complete'/'error' — the worker session is
      // still alive inside CoworkRunner and its eventual result is recoverable.
      recoveryWindowTimer = setTimeout(() => {
        recoveryWindowTimer = null;
        reportRecoveryExpired();
      }, lateCompletionTimeoutMs);
    };

    // Owner-question honesty (A2A / OpenTeam / worker turns): settling the
    // bridge while an ask_user_question is still pending must not let the
    // question disappear with the timeout. The ask is deliberately NOT denied
    // here — it stays answerable in the existing permission card — and the
    // owner receives an explicit transcript notice + desktop push instead (a
    // late answer is recorded but never replays this turn). Semantics chosen
    // for this task: honest timeout, not an unbounded parked promise.
    const notePendingOwnerAskOnTimeout = () => {
      try {
        noteOwnerAskTurnTimeout(runner, sessionId, store, skillTurnTimeoutMs);
      } catch (error) {
        console.warn(
          '[Orchestrator] [Bridge] owner-ask timeout notice failed:',
          error instanceof Error ? error.message : String(error),
        );
      }
    };

    // Legacy watchdog settlement, shared by the passive path and every
    // wrap-up expiry: park in recovery (listeners stay attached so a late
    // completion still flows to onLateCompletion) and reject with
    // SkillTurnTimeoutError so callers can distinguish a watchdog fire.
    const settleAsTimeout = () => {
      if (settled) return;
      notePendingOwnerAskOnTimeout();
      settled = true;
      enterRecovery();
      reject(new SkillTurnTimeoutError(sessionId, skillTurnTimeoutMs));
    };

    const injectWrapUpMessage = (message: string, label: string) => {
      const inject = params.wrapUpSignal?.injectMessage;
      if (!inject) {
        console.warn(
          `[Orchestrator] [Bridge] Wrap-up ${label} skipped: wrapUpSignal carries no injectMessage seam (session ${sessionId})`
        );
        return;
      }
      try {
        const outcome = inject(message);
        if (outcome && typeof (outcome as Promise<void>).then === 'function') {
          void (outcome as Promise<void>).catch((error) => {
            console.warn(
              `[Orchestrator] [Bridge] Wrap-up ${label} injection failed (session ${sessionId}):`,
              error instanceof Error ? error.message : String(error)
            );
          });
        }
        console.log(`[Orchestrator] [Bridge] Wrap-up ${label} injected into session ${sessionId}`);
      } catch (error) {
        console.warn(
          `[Orchestrator] [Bridge] Wrap-up ${label} injection failed (session ${sessionId}):`,
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    // WHY a fresh window per phase: each phase (wrap grace, extension,
    // final grace) gets its own budget from the pure machine, and the whole
    // sequence budget + extension + final grace is proven ≤ the 45-min
    // daemon cap in libs/skillTurnWrapUpState.ts (computeExtensionBudgetMs
    // subtracts the final grace from the watchdog headroom at grant time).
    const startWrapUpWindow = (ms: number) => {
      if (wrapUpTimer != null) {
        clearTimeout(wrapUpTimer);
        wrapUpTimer = null;
      }
      wrapUpTimer = setTimeout(() => {
        wrapUpTimer = null;
        if (settled || !wrapUp || !wrapUpConfig) return;
        const result = advanceWrapUpMachine(
          wrapUp,
          { type: 'window-expired', elapsedMs: wrapUpElapsedMs() },
          wrapUpConfig,
        );
        wrapUp = result.state;
        applyWrapUpEffect(result.effect);
      }, Math.max(0, ms));
    };

    const applyWrapUpEffect = (effect: WrapUpEffect) => {
      if (!wrapUpConfig) return;
      const budgetMinutes = Math.round(skillTurnTimeoutMs / 60_000);
      switch (effect.kind) {
        case 'inject-wrap-up': {
          console.log(
            `[Orchestrator] [Bridge] Wrap-up signal engaged (session ${sessionId}): budget ` +
            `${skillTurnTimeoutMs / 1000}s exhausted at ${wrapUpElapsedMs() / 1000}s; grace ` +
            `${effect.graceMs / 1000}s; one extension available via ${EXTENSION_REQUEST_MARKER}`
          );
          injectWrapUpMessage(
            buildWrapUpMessage({ budgetMinutes, offerExtension: true }),
            'signal',
          );
          startWrapUpWindow(effect.graceMs);
          return;
        }
        case 'grant-extension': {
          console.log(
            `[Orchestrator] [Bridge] Wrap-up extension granted (session ${sessionId}): ` +
            `+${effect.extensionMs / 1000}s (capped by watchdog headroom)`
          );
          injectWrapUpMessage(
            buildExtensionGrantedMessage({ extensionMs: effect.extensionMs }),
            'extension-granted notice',
          );
          startWrapUpWindow(effect.extensionMs);
          return;
        }
        case 'deny-extension': {
          console.warn(
            `[Orchestrator] [Bridge] Wrap-up extension denied (session ${sessionId}): no watchdog ` +
            `headroom left; final grace ${effect.graceMs / 1000}s (extension requests now ignored)`
          );
          injectWrapUpMessage(
            buildWrapUpMessage({ budgetMinutes, offerExtension: false }),
            'final signal (extension denied)',
          );
          startWrapUpWindow(effect.graceMs);
          return;
        }
        case 'inject-final-wrap-up': {
          console.log(
            `[Orchestrator] [Bridge] Wrap-up extension exhausted (session ${sessionId}); final ` +
            `wrap-up signal with grace ${effect.graceMs / 1000}s (extension requests ignored)`
          );
          injectWrapUpMessage(
            buildWrapUpMessage({ budgetMinutes, offerExtension: false }),
            'final signal',
          );
          startWrapUpWindow(effect.graceMs);
          return;
        }
        case 'resolve': {
          console.log(
            `[Orchestrator] [Bridge] Wrap-up resolved (session ${sessionId}) at ${wrapUpElapsedMs() / 1000}s ` +
            `with a ${effect.replyText.length}-char reply`
          );
          finish(effect.replyText || '');
          return;
        }
        case 'timeout': {
          console.warn(
            `[Orchestrator] [Bridge] Wrap-up window expired (session ${sessionId}) at ` +
            `${wrapUpElapsedMs() / 1000}s — settling as SkillTurnTimeoutError, recovery stays attached`
          );
          settleAsTimeout();
          return;
        }
        case 'none':
          return;
      }
    };

    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null;
      if (settled) return;
      if (wrapUpConfig && wrapUp) {
        // ACTIVE wrap-up path (Twin→Worker delegations): at budget exhaustion
        // inject the wrap-up signal instead of passively parking the turn.
        // The promise stays PENDING through the grace/extension phases and
        // settles either with the worker's handoff or the legacy timeout —
        // never later than the 45-min daemon cap (skillTurnWrapUpState.ts).
        const result = advanceWrapUpMachine(
          wrapUp,
          { type: 'budget-exhausted', elapsedMs: wrapUpElapsedMs() },
          wrapUpConfig,
        );
        wrapUp = result.state;
        applyWrapUpEffect(result.effect);
        return;
      }
      // The caller's promise gives up at the watchdog, but the session itself
      // is NOT stopped and keeps running. Park the turn in recovery mode
      // instead of failing the session: a late completion must still be able
      // to correct the attempt state (see onLateCompletion). A pending owner
      // question produces the explicit timeout notice first (same semantics
      // as settleAsTimeout).
      notePendingOwnerAskOnTimeout();
      settled = true;
      enterRecovery();
      reject(new SkillTurnTimeoutError(sessionId, skillTurnTimeoutMs));
    }, skillTurnTimeoutMs);

    runner.on('complete', onComplete);
    runner.on('error', onError);
    runner.on('stopped', onStopped);

    runner
      .startSession(sessionId, userMessage, {
        skipInitialUserMessage: true,
        skillIds: activeSkillIds,
        systemPrompt,
        autoApprove,
        disableMemoryUpdates,
        disableRemoteServicesPrompt,
        permissionMode,
        metawebStudySession,
        metawebSurfSession,
        // Dream review P2-1: read_only practice posture for frozen exams —
        // the interaction guard constrains every tool call to the read
        // surface. Absent for every pre-existing caller.
        ...(practiceSession ? { practiceSession } : {}),
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] startSession rejected:', err instanceof Error ? err.message : String(err));
        if (settled) return;
        if (isDshShutdownError(err)) {
          cancelWithoutSessionError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}

/**
 * Run one skill turn inside an existing session. This is used by ordinary
 * private chat so tool_use/tool_result/assistant output stays in the current
 * A2A window instead of opening a separate "[Orchestrator] skill-turn" session.
 */
export async function runSkillTurnInExistingSession(
  runner: CoworkRunner,
  store: CoworkStore,
  params: RunExistingSessionSkillTurnParams
): Promise<RunExistingSessionSkillTurnResult> {
  const {
    sessionId,
    systemPrompt,
    userMessage,
    cwd,
    activeSkillIds = [],
    disableRemoteServicesPrompt = true,
  } = params;

  const session = store.getSession(sessionId);
  if (!session) {
    return Promise.reject(new Error(`Skill turn session ${sessionId} not found`));
  }

  // A pending text-mode confirmation for this session is answered by the next
  // incoming chat message (允许/拒绝), mirroring the IM handler's reply
  // routing; matched replies resolve without starting a model turn.
  const relayReply = await resolveOrchestratorPermissionReply(runner, sessionId, userMessage);
  if (relayReply) return relayReply;

  // From here on the session's permission prompts are relayed into its own
  // transcript (see orchestratorPermissionRelay) until it terminates.
  claimManagedOrchestratorSession(runner, sessionId, store);

  return new Promise<RunExistingSessionSkillTurnResult>((resolve, reject) => {
    let settled = false;
    let skillExecutionStartPromise: Promise<void> | null = null;
    const cleanup = () => {
      runner.off('complete', onComplete);
      runner.off('error', onError);
      runner.off('message', onMessage);
      runner.off('stopped', onStopped);
      if (timeoutId != null) clearTimeout(timeoutId);
    };

    const finish = (result: RunExistingSessionSkillTurnResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        store.updateSession(sessionId, { status: 'error' });
      } catch (e) {
        console.warn('[Orchestrator] Failed to mark existing skill session error:', e);
      }
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const cancelWithoutSessionError = (err: string | Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(typeof err === 'string' ? new Error(err) : err);
    };

    const triggerSkillExecutionStart = () => {
      if (skillExecutionStartPromise || !params.onSkillExecutionStart) return;
      try {
        skillExecutionStartPromise = Promise.resolve(params.onSkillExecutionStart()).catch((error) => {
          console.warn(
            '[Orchestrator] Private chat skill wait notice callback failed:',
            error instanceof Error ? error.message : String(error)
          );
        });
      } catch (error) {
        skillExecutionStartPromise = Promise.resolve();
        console.warn(
          '[Orchestrator] Private chat skill wait notice callback failed:',
          error instanceof Error ? error.message : String(error)
        );
      }
    };

    const finishAfterSkillStartNotice = (result: RunExistingSessionSkillTurnResult) => {
      const waitForNotice = skillExecutionStartPromise;
      if (!waitForNotice) {
        finish(result);
        return;
      }
      waitForNotice.then(() => finish(result));
    };

    const onMessage = (sid: string, message: { type?: string } | null | undefined) => {
      if (sid !== sessionId || message?.type !== 'tool_use') return;
      triggerSkillExecutionStart();
    };

    const onComplete = (sid: string) => {
      if (sid !== sessionId) return;
      const sessionWithMessages = store.getSession(sessionId);
      const messages = sessionWithMessages?.messages ?? [];
      const { replyText, assistantMessageId } = extractFinalAssistantReply(messages);
      finishAfterSkillStartNotice({
        replyText,
        assistantMessageId,
      });
    };

    const onError = (sid: string, errorMessage: string) => {
      if (sid !== sessionId) return;
      if (isDshShutdownError(errorMessage)) {
        cancelWithoutSessionError(errorMessage);
        return;
      }
      fail(errorMessage);
    };

    const onStopped = (sid: string, reason?: string) => {
      if (sid !== sessionId) return;
      const detail = (reason ?? '').trim();
      cancelWithoutSessionError(
        'Private chat skill turn stopped before assistant output so queued A2A guidance can be applied'
        + (detail ? ` (${detail})` : ''),
      );
    };

    const skillTurnTimeoutMs = Math.max(
      1_000,
      Math.trunc(params.skillTurnTimeoutMs ?? SKILL_TURN_TIMEOUT_MS),
    );
    const lateCompletionTimeoutMs = Math.max(
      0,
      Math.trunc(params.lateCompletionTimeoutMs ?? SKILL_TURN_LATE_COMPLETION_WINDOW_MS),
    );
    let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      timeoutId = null;
      // Watchdog fire: the turn keeps running inside the runner, so the
      // promise stays PENDING and the listeners stay attached for the
      // late-completion window (task #64: a 31-min turn delivered its full
      // report 90s past the watchdog — the old detached-listener contract
      // silently discarded it). A 'complete' inside the window resolves
      // normally through onComplete; only a session error/stop or window
      // expiry settles as the legacy failure below.
      timeoutId = setTimeout(() => {
        timeoutId = null;
        // SkillTurnTimeoutError (not a plain Error) so callers can distinguish
        // a watchdog fire — the session ran past its whole recovery budget —
        // from a real turn failure worth retrying.
        //
        // A2A / OpenTeam honesty: if this turn is still waiting on an owner
        // question, tell the owner explicitly (transcript + desktop push) and
        // leave the ask pending instead of letting the timeout turn it into a
        // fabricated refusal. The turn still settles — a bridge promise must
        // not park forever — but the question stays answerable and a late
        // answer is recorded without replaying this turn.
        try {
          noteOwnerAskTurnTimeout(runner, sessionId, store, skillTurnTimeoutMs);
        } catch (error) {
          console.warn(
            '[Orchestrator] [Bridge] owner-ask timeout notice failed:',
            error instanceof Error ? error.message : String(error),
          );
        }
        fail(new SkillTurnTimeoutError(sessionId, skillTurnTimeoutMs));
      }, lateCompletionTimeoutMs);
    }, skillTurnTimeoutMs);

    runner.on('complete', onComplete);
    runner.on('error', onError);
    runner.on('message', onMessage);
    runner.on('stopped', onStopped);

    runner
      .startSession(sessionId, userMessage, {
        skipInitialUserMessage: true,
        skillIds: activeSkillIds,
        systemPrompt,
        autoApprove: true,
        // Read-only memory mode for group-task skill turns (volatile reads +
        // recall tools stay, every write stays off); the legacy full blackout
        // remains the default for every other caller.
        disableMemoryUpdates: params.memoryReadOnly === true ? false : true,
        memoryReadOnly: params.memoryReadOnly === true,
        disableRemoteServicesPrompt,
        confirmationMode: 'text',
        workspaceRoot: cwd,
      })
      .catch((err) => {
        console.error('[Orchestrator] [Bridge] start existing session rejected:', err instanceof Error ? err.message : String(err));
        if (settled) return;
        if (isDshShutdownError(err)) {
          cancelWithoutSessionError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        fail(err instanceof Error ? err : new Error(String(err)));
      });
  });
}
