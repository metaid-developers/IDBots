/**
 * Owner-question delivery for unattended bridge turns (A2A private chat,
 * OpenTeam guest turns, group-task worker turns, Twin delegations).
 *
 * Why this exists: those turns run with confirmationMode 'text' and
 * autoApprove, so the orchestrator permission relay used to answer every
 * AskUserQuestion with a transcript prompt and a 60s auto-deny. For a
 * STRUCTURED ask (the model asking the owner a question, no safety context)
 * that is a fabricated "the user declined" — the real answer seat is the
 * existing AskUserQuestion modal / CoworkPermissionOverlay, and nobody was
 * pushing it to an owner who had switched away from the app.
 *
 * This module adds exactly the missing pieces and nothing else:
 *   1. delivery: one desktop notification per pending owner question for a
 *      managed bridge session (the notification is a NUDGE — the question is
 *      still rendered by the SAME CoworkPermissionOverlay; no second dialog
 *      system exists);
 *   2. honest timeout: when the skill-turn watchdog settles a bridge turn
 *      while the question is still unanswered, or when the kernel cancels an
 *      unanswered ask, the owner gets an explicit notice (transcript system
 *      message + notification) instead of the question vanishing silently.
 *
 * Timeout semantics (chosen path, per the task's either/or): we do NOT park
 * the bridge promise forever. `runSkillTurnInExistingSession` /
 * `runOrchestratorSkillTurn` still settle with SkillTurnTimeoutError, but the
 * pending ask is left pending (never force-denied) and the owner is told
 * explicitly that the turn stopped waiting — a late answer is recorded in the
 * conversation but does not replay the turn. The runner's stall watchdog keeps
 * re-arming while the ask is pending, so the question stays answerable.
 *
 * Dependency-light by design (type-only runner import) so unit tests can drive
 * it with EventEmitter stubs, exactly like orchestratorPermissionRelay.
 */
import type { CoworkRunner } from '../libs/coworkRunner';
import {
  isManagedOrchestratorSession,
  isStructuredOwnerQuestion,
  type RelayPermissionRequest,
} from './orchestratorPermissionRelay';

export interface OwnerAskNotification {
  kind: 'ask' | 'timeout';
  sessionId: string;
  requestId: string;
  title: string;
  body: string;
}

export type OwnerAskNotify = (notification: OwnerAskNotification) => void;

type OwnerAskStore = {
  addMessage: (
    sessionId: string,
    message: { type: string; content: string; metadata?: Record<string, unknown> },
  ) => unknown;
  getAppLanguage?: () => string;
};

export interface OwnerAskBridgeOptions {
  notify: OwnerAskNotify;
  getAppLanguage?: () => string;
}

interface PendingOwnerAsk {
  sessionId: string;
  requestId: string;
  question: string;
  questionCount: number;
  raisedAt: number;
}

interface OwnerAskBridgeState {
  notify: OwnerAskNotify;
  getAppLanguage: () => string;
  pendingBySession: Map<string, PendingOwnerAsk>;
  timeoutNotified: Set<string>;
  subscribed: boolean;
}

const bridgeStates = new WeakMap<CoworkRunner, OwnerAskBridgeState>();

const MAX_QUESTION_CHARS = 160;

function language(state: OwnerAskBridgeState): string {
  try {
    return state.getAppLanguage() === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

function truncate(value: string, max = MAX_QUESTION_CHARS): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function extractQuestion(request: RelayPermissionRequest): { question: string; questionCount: number } {
  const input = request.toolInput && typeof request.toolInput === 'object' ? request.toolInput : {};
  const questions = Array.isArray(input.questions)
    ? input.questions as Array<Record<string, unknown>>
    : [];
  const first = questions.find((item) => item && typeof item === 'object' && typeof item.question === 'string');
  return {
    question: truncate(typeof first?.question === 'string' ? first.question : ''),
    questionCount: questions.length,
  };
}

export function buildOwnerAskNotification(
  input: { kind: 'ask' | 'timeout'; sessionId: string; requestId: string; question: string; questionCount: number },
  lang: string,
): OwnerAskNotification {
  const extra = input.questionCount > 1
    ? (lang === 'en' ? ` (+${input.questionCount - 1} more question(s))` : `（另有 ${input.questionCount - 1} 个问题）`)
    : '';
  const question = input.question || (lang === 'en' ? 'A question needs your answer' : '有一个问题需要你回答');
  if (input.kind === 'ask') {
    return {
      kind: 'ask',
      sessionId: input.sessionId,
      requestId: input.requestId,
      title: lang === 'en' ? 'Your decision is needed' : '需要你拍板',
      body: lang === 'en'
        ? `${question}${extra} — open IDBots and answer in the permission card.`
        : `${question}${extra} —— 打开 IDBots，在弹出的确认卡片里回答。`,
    };
  }
  return {
    kind: 'timeout',
    sessionId: input.sessionId,
    requestId: input.requestId,
    title: lang === 'en' ? 'Question is still unanswered' : '问题仍未回答',
    body: lang === 'en'
      ? `${question}${extra} — the turn stopped waiting; the question is still open in the permission card.`
      : `${question}${extra} —— 本轮已停止等待，问题仍挂在弹窗里可继续回答。`,
  };
}

/**
 * Install the bridge for one runner (idempotent). main.ts calls this once with
 * a desktop-notification sink; tests call it with a recording sink.
 */
export function installOwnerAskBridge(runner: CoworkRunner, options: OwnerAskBridgeOptions): void {
  const existing = bridgeStates.get(runner);
  if (existing) {
    existing.notify = options.notify;
    if (options.getAppLanguage) existing.getAppLanguage = options.getAppLanguage;
    return;
  }
  const state: OwnerAskBridgeState = {
    notify: options.notify,
    getAppLanguage: options.getAppLanguage ?? (() => 'zh'),
    pendingBySession: new Map(),
    timeoutNotified: new Set(),
    subscribed: false,
  };
  bridgeStates.set(runner, state);

  const drop = (sessionId: string, requestId?: string) => {
    const current = state.pendingBySession.get(sessionId);
    if (!current) return;
    if (requestId && current.requestId !== requestId) return;
    state.pendingBySession.delete(sessionId);
    state.timeoutNotified.delete(current.requestId);
  };

  state.subscribed = true;
  runner.on('permissionRequest', (sessionId: string, request: RelayPermissionRequest) => {
    // Only bridge-managed turns (A2A / OpenTeam / group-task / Twin worker).
    // cowork_ui sessions keep their normal desktop popup and must not get a
    // notification on top of it, and IM/gig sessions own their text relay.
    if (!isManagedOrchestratorSession(runner, sessionId)) return;
    if (runner.hasTextPermissionRelay?.(sessionId)) return;
    if (runner.isPermissionSuspended?.(request.requestId)) return;
    if (!isStructuredOwnerQuestion(request)) return;

    const { question, questionCount } = extractQuestion(request);
    const record: PendingOwnerAsk = {
      sessionId,
      requestId: request.requestId,
      question,
      questionCount,
      raisedAt: Date.now(),
    };
    state.pendingBySession.set(sessionId, record);
    state.timeoutNotified.delete(request.requestId);
    try {
      state.notify(buildOwnerAskNotification({ kind: 'ask', sessionId, requestId: request.requestId, question, questionCount }, language(state)));
    } catch (error) {
      console.warn('[OwnerAsk] desktop push failed:',
        error instanceof Error ? error.message : String(error));
    }
  });

  runner.on('permissionResolved', (sessionId: string, requestId: string) => {
    drop(sessionId, requestId);
  });

  // A completed/stopped turn means nobody is waiting on that question inside
  // the runner anymore (its teardown resolves pending asks) — keep the map
  // from outliving the turn when the resolution event was missed.
  const pruneIfResolved = (sessionId: string) => {
    const record = state.pendingBySession.get(sessionId);
    if (!record) return;
    if (typeof runner.isPermissionPending !== 'function' || !runner.isPermissionPending(record.requestId)) {
      drop(sessionId, record.requestId);
    }
  };
  runner.on('complete', pruneIfResolved);
  runner.on('error', pruneIfResolved);
  runner.on('stopped', (sessionId: string) => {
    const record = state.pendingBySession.get(sessionId);
    if (record) drop(sessionId, record.requestId);
  });
}

/** True while this bridge session still waits on an owner question. */
export function hasPendingOwnerAsk(runner: CoworkRunner, sessionId: string): boolean {
  const state = bridgeStates.get(runner);
  const record = state?.pendingBySession.get(sessionId);
  if (!state || !record) return false;
  return typeof runner.isPermissionPending !== 'function' || runner.isPermissionPending(record.requestId);
}

/**
 * Honest timeout notice for the skill-turn watchdog. Returns true when the
 * settled turn was still waiting on an owner question (the caller may keep the
 * ask pending instead of denying it); false means the legacy timeout path.
 * Idempotent per request id — a turn has two settle stages (budget expiry and
 * late-completion expiry) and the owner must not be told twice.
 */
export function noteOwnerAskTurnTimeout(
  runner: CoworkRunner,
  sessionId: string,
  store: OwnerAskStore,
  timeoutMs: number,
): boolean {
  const state = bridgeStates.get(runner);
  const record = state?.pendingBySession.get(sessionId);
  if (!state || !record) return false;
  if (typeof runner.isPermissionPending === 'function' && !runner.isPermissionPending(record.requestId)) {
    state.pendingBySession.delete(sessionId);
    return false;
  }
  if (state.timeoutNotified.has(record.requestId)) return true;
  state.timeoutNotified.add(record.requestId);
  postOwnerAskNotice(runner, store, {
    sessionId,
    requestId: record.requestId,
    text: language(state) === 'en'
      ? `Timed out waiting for your answer to ask_user_question (${Math.round(timeoutMs / 1000)}s). This turn stopped waiting and returned to its caller; the question is still open in the permission card. A late answer is recorded in the conversation but does not replay this turn.`
      : `等待你回答 ask_user_question 已超时（${Math.round(timeoutMs / 1000)}s）。本轮已停止等待并交还调用方；问题仍挂在权限弹窗里，稍后回答只会记入会话，不会重放本轮。`,
    metadataKey: 'ownerAskTurnTimeout',
    metadata: { requestId: record.requestId, timeoutMs },
  });
  try {
    state.notify(buildOwnerAskNotification({
      kind: 'timeout',
      sessionId,
      requestId: record.requestId,
      question: record.question,
      questionCount: record.questionCount,
    }, language(state)));
  } catch (error) {
    console.warn('[OwnerAsk] timeout push failed:',
      error instanceof Error ? error.message : String(error));
  }
  return true;
}

/**
 * Honest end-of-ask notice for the runner's cancellation path (kernel deadline
 * or turn teardown). An ask cancelled before any owner answer must not look
 * like an explicit refusal: the question is recorded as unanswered, never
 * auto-answered. No-op when the ask was not a tracked owner question or the
 * owner answered it (answer paths resolve through permissionResolved first).
 */
export function noteOwnerAskCancelled(
  runner: CoworkRunner,
  sessionId: string,
  requestId: string,
  store: OwnerAskStore,
): boolean {
  const state = bridgeStates.get(runner);
  const record = state?.pendingBySession.get(sessionId);
  if (!state || !record || record.requestId !== requestId) return false;
  state.pendingBySession.delete(sessionId);
  state.timeoutNotified.delete(requestId);
  postOwnerAskNotice(runner, store, {
    sessionId,
    requestId,
    text: language(state) === 'en'
      ? 'The open ask_user_question ended without an answer (kernel wait window expired or the turn was cancelled). The host did not fabricate an answer. Ask again if the information is still needed.'
      : '待回答的 ask_user_question 在未获回答的情况下结束（内核等待窗口到期或本轮被取消）。宿主没有代答。如果仍需要该信息，请重新提问。',
    metadataKey: 'ownerAskUnanswered',
    metadata: { requestId },
  });
  try {
    state.notify(buildOwnerAskNotification({
      kind: 'timeout',
      sessionId,
      requestId,
      question: record.question,
      questionCount: record.questionCount,
    }, language(state)));
  } catch (error) {
    console.warn('[OwnerAsk] unanswered push failed:',
      error instanceof Error ? error.message : String(error));
  }
  return true;
}

function postOwnerAskNotice(
  runner: CoworkRunner,
  store: OwnerAskStore,
  input: {
    sessionId: string;
    requestId: string;
    text: string;
    metadataKey: string;
    metadata: Record<string, unknown>;
  },
): void {
  try {
    const record = store.addMessage(input.sessionId, {
      type: 'system',
      content: input.text,
      metadata: { [input.metadataKey]: input.metadata },
    });
    // Surface it in the live transcript (same path the permission relay uses).
    runner.emit('message', input.sessionId, record);
  } catch (error) {
    console.warn('[OwnerAsk] failed to post timeout notice into transcript:',
      error instanceof Error ? error.message : String(error));
  }
}
