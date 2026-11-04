/**
 * Text-relay channel for orchestrator-managed cowork sessions (worker turns,
 * group-task turns, plain private-chat/side-panel turns). These sessions run
 * with confirmationMode 'text' but, unlike IM chats and gig orders, had no
 * relay owner: their permission prompts went nowhere and burned the runner's
 * 60s watchdog into an automatic denial. Mirroring imCoworkHandler, the
 * confirmation question is posted into the session transcript as a chat
 * message and the next incoming user message (允许/拒绝) is routed back to
 * respondToPermission. Unanswered prompts still auto-deny after 60s, aligned
 * with the runner watchdog. Owner-gated SUSPENDED approvals
 * (requestSuspendedApproval) are exempt: they have no watchdog, and this
 * relay must not arm one for them (see handlePermissionRequest).
 *
 * Dependency-light by design (type-only runner import): unit tests import
 * this module directly with stub runner/store objects.
 */
import type { CoworkRunner } from '../libs/coworkRunner';

export type RelayPermissionRequest = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
};

type RelayPermissionResult = {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
};

type RelayStore = {
  addMessage: (
    sessionId: string,
    message: { type: string; content: string; metadata?: Record<string, unknown> },
  ) => unknown;
  getAppLanguage?: () => string;
};

export interface OrchestratorRelayReply {
  replyText: string;
  assistantMessageId: null;
}

interface OrchestratorRelayState {
  store: RelayStore;
  managedSessions: Set<string>;
  pendingBySession: Map<string, PendingOrchestratorPermission>;
  timeoutMs: number;
  subscribed: boolean;
}

interface PendingOrchestratorPermission {
  sessionId: string;
  request: RelayPermissionRequest;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface OrchestratorRelayOptions {
  /** Overrides the 60s confirmation timeout (tests pass a short value). */
  timeoutMs?: number;
}

const relayStates = new WeakMap<CoworkRunner, OrchestratorRelayState>();

const ALLOW_RESPONSE_RE = /^(允许|同意|yes|y)$/i;
const DENY_RESPONSE_RE = /^(拒绝|不同意|no|n)$/i;

/**
 * True for an owner question raised by ask_user_question itself (a structured
 * question the model wants a human to answer) as opposed to a safety gate that
 * merely rides the same AskUserQuestion tool. Safety gates always carry
 * toolInput.context.requestedToolName (see buildSafetyQuestionInput in
 * coworkRunner) and their fixed allow/deny options are the only thing a
 * "允许/拒绝" text reply can answer. A structured question has no such context,
 * and the text relay must keep its hands off it: the transcript prompt it posts
 * is invisible in the A2A view, its 60s auto-deny fabricates a refusal the
 * owner never gave, and the real answer seat is the AskUserQuestion modal /
 * CoworkPermissionOverlay (plus the desktop notification nudge installed by
 * pendingOwnerAskBridge for unattended bridge turns).
 */
export function isStructuredOwnerQuestion(request: RelayPermissionRequest): boolean {
  if (request.toolName !== 'AskUserQuestion') return false;
  const input = request.toolInput && typeof request.toolInput === 'object' ? request.toolInput : {};
  const context = input.context && typeof input.context === 'object'
    ? input.context as Record<string, unknown>
    : null;
  const requestedToolName = typeof context?.requestedToolName === 'string'
    ? context.requestedToolName.trim()
    : '';
  return requestedToolName.length === 0;
}

/**
 * True when this session's turns run through the orchestrator bridge
 * (A2A private-chat replies, OpenTeam guest turns, group-task worker turns,
 * Twin delegations). These are the unattended text-mode turns whose owner
 * questions have no composer seat of their own — the global overlay plus the
 * pendingOwnerAskBridge push must carry them.
 */
export function isManagedOrchestratorSession(runner: CoworkRunner, sessionId: string): boolean {
  return relayStates.get(runner)?.managedSessions.has(sessionId) ?? false;
}

export function buildOrchestratorPermissionPrompt(
  request: RelayPermissionRequest,
  language: string,
): string {
  const input = request.toolInput && typeof request.toolInput === 'object' ? request.toolInput : {};
  const context = input.context && typeof input.context === 'object'
    ? input.context as Record<string, unknown>
    : null;
  const requestedToolName = typeof context?.requestedToolName === 'string'
    ? context.requestedToolName
    : request.toolName;
  const questions = Array.isArray(input.questions)
    ? input.questions as Array<Record<string, unknown>>
    : [];
  const questionText = typeof questions[0]?.question === 'string' ? questions[0].question : '';
  const reasonText = typeof input.reason === 'string' ? input.reason.trim() : '';
  const detail = questionText || reasonText;

  const zh = [
    `检测到需要安全确认的操作（工具: ${requestedToolName}）。`,
    detail ? `说明: ${detail}` : '说明: 当前操作需要用户确认。',
    '请在 60 秒内回复“允许”或“拒绝”。',
  ].join('\n');
  const en = [
    `A safety confirmation is required (tool: ${requestedToolName}).`,
    detail ? `Details: ${detail}` : 'Details: this operation needs user confirmation.',
    'Reply with "yes" or "no" within 60 seconds.',
  ].join('\n');
  return language === 'en' ? en : zh;
}

function resolveStoreLanguage(store: RelayStore): string {
  try {
    return store.getAppLanguage?.() ?? 'zh';
  } catch {
    return 'zh';
  }
}

/**
 * Mark a session as orchestrator-managed: its permission prompts are relayed
 * into the session transcript until it terminates. Idempotent per runner.
 */
export function claimManagedOrchestratorSession(
  runner: CoworkRunner,
  sessionId: string,
  store: RelayStore,
  options?: OrchestratorRelayOptions,
): void {
  const state = ensureState(runner, store, options);
  state.managedSessions.add(sessionId);
}

function ensureState(
  runner: CoworkRunner,
  store: RelayStore,
  options?: OrchestratorRelayOptions,
): OrchestratorRelayState {
  let state = relayStates.get(runner);
  if (!state) {
    state = {
      store,
      managedSessions: new Set(),
      pendingBySession: new Map(),
      timeoutMs: options?.timeoutMs ?? 60_000,
      subscribed: false,
    };
    relayStates.set(runner, state);
  }
  if (!state.subscribed) {
    state.subscribed = true;
    runner.on('permissionRequest', (sessionId, request) => {
      handlePermissionRequest(runner, state!, sessionId, request);
    });
    const dropPending = (sid: string) => {
      const pending = state!.pendingBySession.get(sid);
      if (!pending) return;
      clearTimeout(pending.timeoutId);
      state!.pendingBySession.delete(sid);
    };
    runner.on('complete', dropPending);
    runner.on('error', dropPending);
    runner.on('stopped', dropPending);
  }
  return state;
}

function handlePermissionRequest(
  runner: CoworkRunner,
  state: OrchestratorRelayState,
  sessionId: string,
  request: RelayPermissionRequest,
): void {
  // Only prompts of sessions this bridge runs are ours to relay.
  if (!state.managedSessions.has(sessionId)) return;
  // IM chats / gig orders own their text flow end to end; never double-handle.
  if (runner.hasTextPermissionRelay(sessionId)) return;
  // Owner-gated SUSPENDED approvals (requestSuspendedApproval — A2A friend
  // invites) have NO watchdog by design: they must wait for the owner's
  // overlay click however long that takes. Relaying them here would post a
  // text confirmation nothing can answer (A2A view hides system messages)
  // and arm exactly the 60s auto-deny the suspension was built to avoid —
  // the 2026-10-30 real-device defect where the invite overlay vanished and
  // the daemon logged "not authorized" with the owner never clicking. The
  // renderer's global CoworkPermissionOverlay is the one and only seat.
  if (runner.isPermissionSuspended?.(request.requestId)) return;
  // A structured owner question is NOT a turn-scoped yes/no confirmation:
  // answering it from this transcript channel is impossible (the A2A view
  // hides system messages), and the 60s auto-deny below would resolve the
  // ask as "the user declined" with the owner never asked (the same defect
  // class as the 2026-10-30 friend-invite auto-deny). Leave it to the modal
  // seat — the main process broadcasts it to CoworkPermissionOverlay and
  // pendingOwnerAskBridge pushes a desktop notification for bridge turns.
  if (isStructuredOwnerQuestion(request)) return;

  const existing = state.pendingBySession.get(sessionId);
  if (existing && existing.request.requestId !== request.requestId) {
    // A suspended approval is never superseded either: replacing it would
    // resolve the owner-gated wait without an owner answer.
    if (!runner.isPermissionSuspended?.(existing.request.requestId)) {
      clearTimeout(existing.timeoutId);
      state.pendingBySession.delete(sessionId);
      runner.respondToPermission(existing.request.requestId, {
        behavior: 'deny',
        message: 'Superseded by a newer permission request.',
      });
    }
  }

  const timeoutId = setTimeout(() => {
    const current = state.pendingBySession.get(sessionId);
    if (!current || current.request.requestId !== request.requestId) return;
    clearTimeout(current.timeoutId);
    state.pendingBySession.delete(sessionId);
    runner.respondToPermission(request.requestId, {
      behavior: 'deny',
      message: 'Permission request timed out after 60s',
    });
  }, state.timeoutMs);

  // unref: the Electron main process always keeps other handles alive, and an
  // unref'd timer must not pin a test process for the full window.
  if (typeof timeoutId.unref === 'function') timeoutId.unref();

  state.pendingBySession.set(sessionId, { sessionId, request, timeoutId });

  try {
    const record = state.store.addMessage(sessionId, {
      type: 'system',
      content: buildOrchestratorPermissionPrompt(request, resolveStoreLanguage(state.store)),
      metadata: {
        orchestratorPermissionRequest: {
          requestId: request.requestId,
          toolName: request.toolName,
        },
      },
    });
    // Surface the question in the live transcript (same path as the initial
    // turn message); listener failures must not break the relay.
    runner.emit('message', sessionId, record);
  } catch (error) {
    console.warn('[Orchestrator] Failed to post permission prompt into transcript:',
      error instanceof Error ? error.message : String(error));
  }
}

/**
 * Entry hook for the next turn arriving at an orchestrator-managed session:
 * when a text confirmation is pending, the user message is matched against
 * 允许/拒绝 and routed to respondToPermission instead of starting a model
 * turn (mirrors imCoworkHandler.handlePendingPermissionReply). Returns null
 * when no pending confirmation needs the message.
 */
export async function resolveOrchestratorPermissionReply(
  runner: CoworkRunner,
  sessionId: string,
  userMessage: string,
): Promise<OrchestratorRelayReply | null> {
  const state = relayStates.get(runner);
  const pending = state?.pendingBySession.get(sessionId);
  if (!state || !pending) return null;

  // The prompt may have been answered elsewhere (renderer overlay, watcher
  // timeout). If the runner no longer holds it, drop our local record and let
  // the message flow into a normal turn.
  if (!runner.isPermissionPending(pending.request.requestId)) {
    clearTimeout(pending.timeoutId);
    state.pendingBySession.delete(sessionId);
    return null;
  }

  const normalizedReply = userMessage.trim().replace(/[。！!,.，\s]+$/g, '');
  const stillPendingText = state.store.getAppLanguage?.() === 'en'
    ? 'A confirmation is pending. Reply with "yes" or "no" (within 60 seconds).'
    : '当前有待确认操作，请回复“允许”或“拒绝”（60 秒内）。';
  if (!normalizedReply) {
    return { replyText: stillPendingText, assistantMessageId: null };
  }

  if (DENY_RESPONSE_RE.test(normalizedReply)) {
    clearTimeout(pending.timeoutId);
    state.pendingBySession.delete(sessionId);
    runner.respondToPermission(pending.request.requestId, {
      behavior: 'deny',
      message: 'Operation denied by user text confirmation.',
    });
    return {
      replyText: state.store.getAppLanguage?.() === 'en'
        ? 'This operation was denied and the task did not continue.'
        : '已拒绝本次操作，任务未继续执行。',
      assistantMessageId: null,
    };
  }

  if (!ALLOW_RESPONSE_RE.test(normalizedReply)) {
    return { replyText: stillPendingText, assistantMessageId: null };
  }

  clearTimeout(pending.timeoutId);
  state.pendingBySession.delete(sessionId);
  const input = pending.request.toolInput && typeof pending.request.toolInput === 'object'
    ? pending.request.toolInput
    : {};
  runner.respondToPermission(pending.request.requestId, {
    behavior: 'allow',
    updatedInput: input,
  });
  return {
    replyText: state.store.getAppLanguage?.() === 'en'
      ? 'Allowed. Continuing the task.'
      : '已允许，任务继续执行。',
    assistantMessageId: null,
  };
}
