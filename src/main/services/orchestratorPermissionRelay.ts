/**
 * Text-relay channel for orchestrator-managed cowork sessions (worker turns,
 * group-task turns, plain private-chat/side-panel turns). These sessions run
 * with confirmationMode 'text' but, unlike IM chats and gig orders, had no
 * relay owner: their permission prompts went nowhere and burned the runner's
 * 60s watchdog into an automatic denial. Mirroring imCoworkHandler, the
 * confirmation question is posted into the session transcript as a chat
 * message and the next incoming user message (允许/拒绝) answers the oldest
 * still-pending prompt. A newer prompt does not deny the older one; each
 * card keeps its own timer. Tool approvals time out as allow, safety
 * confirms time out as deny, and questions with no default wait. Owner-gated
 * SUSPENDED approvals (requestSuspendedApproval) are exempt.
 *
 * Dependency-light by design (type-only runner import): unit tests import
 * this module directly with stub runner/store objects.
 */
import type { CoworkRunner } from '../libs/coworkRunner';
import type { PermissionResult } from '../libs/coworkPermissionTypes';

type RelayPermissionRequest = {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  timeoutDefault?: 'allow' | 'deny' | null;
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
  pendingBySession: Map<string, PendingOrchestratorPermission[]>;
  timeoutMs: number;
  subscribed: boolean;
}

interface PendingOrchestratorPermission {
  sessionId: string;
  request: RelayPermissionRequest;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

interface OrchestratorRelayOptions {
  /** Overrides the 60s confirmation timeout (tests pass a short value). */
  timeoutMs?: number;
}

const relayStates = new WeakMap<CoworkRunner, OrchestratorRelayState>();

const ALLOW_RESPONSE_RE = /^(允许|同意|yes|y)$/i;
const DENY_RESPONSE_RE = /^(拒绝|不同意|no|n)$/i;

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

  const waitsForHuman = request.toolName === 'AskUserQuestion'
    && request.timeoutDefault !== 'allow'
    && request.timeoutDefault !== 'deny';
  const zh = [
    `检测到需要安全确认的操作（工具: ${requestedToolName}）。`,
    detail ? `说明: ${detail}` : '说明: 当前操作需要用户确认。',
    waitsForHuman
      ? '请回复“允许”或“拒绝”。该请求会一直等待，直到你回复。'
      : '请在 60 秒内回复“允许”或“拒绝”。',
  ].join('\n');
  const en = [
    `A safety confirmation is required (tool: ${requestedToolName}).`,
    detail ? `Details: ${detail}` : 'Details: this operation needs user confirmation.',
    waitsForHuman
      ? 'Reply with "yes" or "no". This request waits until you answer.'
      : 'Reply with "yes" or "no" within 60 seconds.',
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
      const list = state!.pendingBySession.get(sid);
      if (!list) return;
      for (const pending of list) {
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
      }
      state!.pendingBySession.delete(sid);
    };
    runner.on('complete', dropPending);
    runner.on('error', dropPending);
    runner.on('stopped', dropPending);
  }
  return state;
}

function relayTimeoutResult(request: RelayPermissionRequest): PermissionResult | null {
  // Questions with no default stay until a person answers. Every tool
  // approval carries timeoutDefault 'deny' (fail-closed since the
  // 2026-11-03 pre-release review — the auto-allow default was reverted).
  if (request.toolName === 'AskUserQuestion' && request.timeoutDefault !== 'allow' && request.timeoutDefault !== 'deny') {
    return null;
  }
  if (request.timeoutDefault === 'allow') {
    const input = request.toolInput && typeof request.toolInput === 'object' ? request.toolInput : {};
    return { behavior: 'allow', updatedInput: input };
  }
  return { behavior: 'deny', message: 'Permission request timed out after 60s' };
}

function dropRelayEntry(
  state: OrchestratorRelayState,
  sessionId: string,
  requestId: string,
): void {
  const list = state.pendingBySession.get(sessionId);
  if (!list) return;
  const index = list.findIndex((entry) => entry.request.requestId === requestId);
  if (index < 0) return;
  const [removed] = list.splice(index, 1);
  if (removed?.timeoutId) clearTimeout(removed.timeoutId);
  if (list.length === 0) state.pendingBySession.delete(sessionId);
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

  // A newer request keeps the older cards. Each one keeps its own countdown
  // and default action; nothing is denied just because another prompt arrived.
  const list = state.pendingBySession.get(sessionId) ?? [];
  const timeoutResult = relayTimeoutResult(request);
  const timeoutId = timeoutResult === null
    ? null
    : setTimeout(() => {
      const current = state.pendingBySession.get(sessionId)?.find((entry) => entry.request.requestId === request.requestId);
      if (!current) return;
      dropRelayEntry(state, sessionId, request.requestId);
      runner.respondToPermission(request.requestId, timeoutResult);
    }, state.timeoutMs);

  if (timeoutId && typeof timeoutId.unref === 'function') timeoutId.unref();

  list.push({ sessionId, request, timeoutId });
  state.pendingBySession.set(sessionId, list);

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

function oldestLiveRelayEntry(
  runner: CoworkRunner,
  state: OrchestratorRelayState | undefined,
  sessionId: string,
): PendingOrchestratorPermission | null {
  if (!state) return null;
  const list = state.pendingBySession.get(sessionId);
  if (!list) return null;
  while (list.length > 0) {
    const head = list[0];
    if (runner.isPermissionPending(head.request.requestId)) return head;
    dropRelayEntry(state, sessionId, head.request.requestId);
  }
  return null;
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
  const pending = oldestLiveRelayEntry(runner, state, sessionId);
  if (!state || !pending) return null;

  const normalizedReply = userMessage.trim().replace(/[。！!,.，\s]+$/g, '');
  const waitsForHuman = pending.request.toolName === 'AskUserQuestion'
    && pending.request.timeoutDefault !== 'allow'
    && pending.request.timeoutDefault !== 'deny';
  const english = state.store.getAppLanguage?.() === 'en';
  const stillPendingText = waitsForHuman
    ? (english
      ? 'A confirmation is pending. Reply with "yes" or "no".'
      : '当前有待确认操作，请回复“允许”或“拒绝”。')
    : (english
      ? 'A confirmation is pending. Reply with "yes" or "no" (within 60 seconds).'
      : '当前有待确认操作，请回复“允许”或“拒绝”（60 秒内）。');
  if (!normalizedReply) {
    return { replyText: stillPendingText, assistantMessageId: null };
  }

  if (DENY_RESPONSE_RE.test(normalizedReply)) {
    dropRelayEntry(state, sessionId, pending.request.requestId);
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
  dropRelayEntry(state, sessionId, pending.request.requestId);
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
