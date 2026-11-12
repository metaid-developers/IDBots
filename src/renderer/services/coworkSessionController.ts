import { v4 as uuidv4 } from 'uuid';
import type {
  CoworkMessage,
  CoworkMessageHistoryState,
  CoworkMessagePage,
  CoworkPermissionRequest,
  CoworkPermissionResult,
  CoworkSession,
  CoworkSessionSummary,
  CoworkStartOptions,
} from '../types/cowork';
import {
  applyCoworkSessionEvent,
  applyCoworkSessionSnapshot,
  createCoworkSessionEventState,
  markCoworkSessionRead,
  type CoworkSessionEvent,
  type CoworkSessionEventState,
} from './coworkSessionState';
import {
  CoworkStreamReassembler,
  type CoworkStreamUpdatePayload,
} from './coworkStreamReassembly';
import {
  composeCoworkSubmitPrompt,
  submitCoworkComposerDraft,
} from '../components/cowork/coworkComposerAttachments';
import {
  CoworkSessionDraftStore,
  type CoworkSessionDraft,
  type MobileChatAttachment,
} from './coworkSessionDrafts';

export const MOBILE_OPEN_SESSION_STORAGE_KEY = 'idbots.mobile.openSessionId.v1';
export const MOBILE_DRAFTS_STORAGE_KEY = 'idbots.mobile.sessionDrafts.v1';

/**
 * F-17b uncertain-outcome reconcile (2026-10-28 阿燃 incident): a gateway
 * invoke timeout ("no result within 120000ms") leaves the submission status
 * "uncertain" even when the tenant main actually completed the work, so the
 * user has no signal that retrying would duplicate side effects. Reconciliation
 * translates those outcomes against the server-side session transcript: any
 * tool result that deterministically proves completion ends "verified".
 *
 * The map is deliberately narrow: each entry is a tool whose result text
 * doubles as a completion certificate. Detection reads only persisted tool_use
 * / tool_result message metadata (the same transcript the user sees).
 */
/** Tool-use entries older than this window relative to the attempt are ignored. */
export const COWORK_RECONCILE_TOOL_USE_LOOKBACK_MS = 120_000;

const SIDE_EFFECT_TOOL_CERTIFICATES: Record<string, { ok: RegExp }> = {
  metabot_create: { ok: /MetaBot created/ },
};

export function detectSideEffectOutcome(
  messages: CoworkMessage[],
  attempt: Pick<CoworkSubmissionAttempt, 'createdAt'>,
): string | null {
  for (const [toolName, certificate] of Object.entries(SIDE_EFFECT_TOOL_CERTIFICATES)) {
    const uses = messages.filter((message) => (
      message.type === 'tool_use'
      && message.metadata?.toolName === toolName
      && typeof message.metadata?.toolUseId === 'string'
      && (typeof message.timestamp !== 'number'
        || typeof attempt.createdAt !== 'number'
        || message.timestamp >= attempt.createdAt - COWORK_RECONCILE_TOOL_USE_LOOKBACK_MS)
    ));
    for (const use of uses) {
      const useId = use.metadata.toolUseId as string;
      const result = messages.find((message) => (
        message.type === 'tool_result'
        && message.metadata?.toolUseId === useId
        && message.metadata?.isError !== true
      ));
      if (!result) continue;
      const text = typeof result.metadata?.toolResult === 'string'
        ? result.metadata.toolResult
        : result.content;
      if (text && certificate.ok.test(text)) {
        return text;
      }
    }
  }
  return null;
}

export interface PendingPermissionEntry {
  sessionId: string;
  request: CoworkPermissionRequest;
  createdAt: number;
}

export interface CoworkResyncGuard {
  generation: number;
  epoch: number;
  messageRevisions: Record<string, number>;
}

export interface CoworkResyncSnapshot {
  session: CoworkSession | null;
  liveContent: { sessionId: string; messageId: string; content: string } | null;
  pendingPermissions: PendingPermissionEntry[];
  guard?: CoworkResyncGuard;
}

export interface CoworkRecoveryStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface CoworkGreetingOptions {
  title: string;
  fallbackGreeting: string;
  cwd?: string;
  systemPrompt?: string;
}

export type CoworkSubmissionStatus = 'sending' | 'failed' | 'uncertain' | 'reconciling' | 'verified';

export interface CoworkSubmissionAttempt {
  submissionId: string;
  kind: 'start' | 'submit';
  sessionId: string | null;
  text: string;
  draftToken: string;
  draftText: string;
  draftAttachments: MobileChatAttachment[];
  status: CoworkSubmissionStatus;
  error: string | null;
  createdAt: number;
  startOptions: Omit<CoworkStartOptions, 'prompt'> | null;
}

export interface CoworkActionResult {
  status: 'accepted' | 'failed' | 'uncertain' | 'verified';
  error: string | null;
  submissionId?: string;
  sessionId?: string | null;
  refreshError?: string | null;
}

export interface CoworkStreamErrorState {
  code: string | null;
  text: string;
}

export interface CoworkSessionControllerSnapshot {
  states: ReadonlyMap<string, CoworkSessionEventState>;
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  attempts: CoworkSubmissionAttempt[];
  drafts: Readonly<Record<string, CoworkSessionDraft>>;
  actionErrors: Readonly<Record<string, string>>;
  streamErrors: Readonly<Record<string, CoworkStreamErrorState>>;
  respondingPermissionIds: ReadonlySet<string>;
  dismissedPermissionIds: ReadonlySet<string>;
  stoppingSessionIds: ReadonlySet<string>;
  uncertainSessionIds: ReadonlySet<string>;
  restoring: boolean;
  generation: number;
  epoch: number;
}

interface CoworkSessionControllerOptions {
  electron: Pick<Window['electron'], 'cowork' | 'mobile'>;
  storage?: CoworkRecoveryStorage | null;
  now?: () => number;
  createSubmissionId?: () => string;
}

const errorText = (error: unknown, fallback: string): string => (
  error instanceof Error && error.message ? error.message : fallback
);

export class CoworkSessionController {
  private readonly electron: CoworkSessionControllerOptions['electron'];
  private readonly storage: CoworkRecoveryStorage | null;
  private readonly now: () => number;
  private readonly createSubmissionId: () => string;
  private readonly reassembler = new CoworkStreamReassembler();
  private readonly listeners = new Set<() => void>();
  private readonly cleanups: Array<() => void> = [];
  private readonly sessionRequests = new Map<string, number>();
  private readonly historyRequests = new Map<string, number>();
  private readonly healTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private states = new Map<string, CoworkSessionEventState>();
  private sessions: CoworkSessionSummary[] = [];
  private currentSessionId: string | null = null;
  private attempts: CoworkSubmissionAttempt[] = [];
  private readonly draftStore: CoworkSessionDraftStore;
  private actionErrors: Record<string, string> = {};
  private streamErrors: Record<string, CoworkStreamErrorState> = {};
  private respondingPermissionIds = new Set<string>();
  private dismissedPermissionIds = new Set<string>();
  private stoppingSessionIds = new Set<string>();
  private uncertainSessionIds = new Set<string>();
  // F-17b: one automatic server reconcile per uncertain submission; the pin
  // blocks stacked timers while the reconcile runs, and any deliberate state
  // change (retry, discard, finish, an accepted round) releases it.
  private readonly reconcilingSubmissionIds = new Set<string>();
  private readonly reconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private restoring = false;
  private restorePromise: Promise<void> | null = null;
  private generation = 0;
  private epoch = 0;
  private listRequest = 0;
  private destroyed = false;
  private snapshot: CoworkSessionControllerSnapshot;

  constructor(options: CoworkSessionControllerOptions) {
    this.electron = options.electron;
    this.storage = options.storage ?? null;
    this.now = options.now ?? Date.now;
    this.createSubmissionId = options.createSubmissionId ?? uuidv4;
    this.draftStore = new CoworkSessionDraftStore(
      this.storage,
      MOBILE_DRAFTS_STORAGE_KEY,
      () => this.publish(),
    );
    this.snapshot = this.makeSnapshot();
    this.attach();
  }

  getSnapshot = (): CoworkSessionControllerSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getOpenSessionId = (): string | null => this.currentSessionId;

  getDraft = (): string => this.draftStore.getText(this.currentSessionId);

  getDraftToken = (): string => this.draftStore.tokenForSession(this.currentSessionId);

  getAttachments = (): MobileChatAttachment[] => this.draftStore.getAttachments(this.currentSessionId);

  addAttachments(token: string, attachments: MobileChatAttachment[]): void {
    this.draftStore.addAttachments(token, attachments);
  }

  removeAttachment(token: string, path: string): void {
    this.draftStore.removeAttachment(token, path);
  }

  getStreamingMessage = (): { sessionId: string; messageId: string } | null => {
    const state = this.currentSessionId ? this.states.get(this.currentSessionId) : null;
    if (!state) return null;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]!;
      if (message.type === 'assistant' && message.metadata?.isStreaming) {
        return { sessionId: state.id, messageId: message.id };
      }
    }
    if (state.status !== 'running') return null;
    for (let index = state.messages.length - 1; index >= 0; index -= 1) {
      const message = state.messages[index]!;
      if (message.type === 'assistant' && !message.metadata?.isFinal) {
        return { sessionId: state.id, messageId: message.id };
      }
    }
    return null;
  };

  private makeSnapshot(): CoworkSessionControllerSnapshot {
    return {
      states: this.states,
      sessions: this.sessions,
      currentSessionId: this.currentSessionId,
      attempts: this.attempts,
      drafts: this.draftStore.snapshot(),
      actionErrors: this.actionErrors,
      streamErrors: this.streamErrors,
      respondingPermissionIds: this.respondingPermissionIds,
      dismissedPermissionIds: this.dismissedPermissionIds,
      stoppingSessionIds: this.stoppingSessionIds,
      uncertainSessionIds: this.uncertainSessionIds,
      restoring: this.restoring,
      generation: this.generation,
      epoch: this.epoch,
    };
  }

  private publish(): void {
    if (this.destroyed) return;
    this.snapshot = this.makeSnapshot();
    for (const listener of [...this.listeners]) listener();
  }

  private persistOpenSession(): void {
    try {
      this.storage?.setItem(MOBILE_OPEN_SESSION_STORAGE_KEY, this.currentSessionId ?? '');
    } catch {
      return;
    }
  }

  private savedOpenSession(): { id: string | null; explicitNew: boolean } {
    try {
      const raw = this.storage?.getItem(MOBILE_OPEN_SESSION_STORAGE_KEY);
      if (raw === null || raw === undefined) return { id: null, explicitNew: false };
      const id = raw.trim();
      return { id: id || null, explicitNew: id.length === 0 };
    } catch {
      return { id: null, explicitNew: false };
    }
  }

  setDraft(text: string): void {
    this.draftStore.setText(this.currentSessionId, text);
  }

  private stateFor(sessionId: string): CoworkSessionEventState {
    return this.states.get(sessionId) ?? createCoworkSessionEventState(sessionId);
  }

  private setState(state: CoworkSessionEventState): void {
    const next = state.id === this.currentSessionId ? markCoworkSessionRead(state) : state;
    this.states = new Map(this.states).set(state.id, next);
    this.publish();
  }

  private dispatch(event: CoworkSessionEvent): void {
    const isNew = !this.states.has(event.sessionId);
    const result = applyCoworkSessionEvent(this.stateFor(event.sessionId), event);
    this.setState(result.state);
    if (isNew) void this.reloadSessions();
    if (result.sequenceGap && !this.healTimers.has(event.sessionId)) {
      const timer = setTimeout(() => {
        this.healTimers.delete(event.sessionId);
        void this.refreshSession(event.sessionId);
      }, 1200);
      this.healTimers.set(event.sessionId, timer);
    }
    if (result.missingMessage) void this.refreshSession(event.sessionId);
  }

  private attach(): void {
    const { cowork } = this.electron;
    this.cleanups.push(cowork.onStreamMessage(({ sessionId, message }) => {
      this.dispatch({ type: 'message', sessionId, message });
      if (message.metadata?.refreshSessionSummary) void this.reloadSessions();
    }));
    this.cleanups.push(cowork.onStreamMessageUpdate((payload: CoworkStreamUpdatePayload) => {
      const result = this.reassembler.apply(payload);
      if (result.kind === 'full') {
        this.dispatch({
          type: 'content', sessionId: result.sessionId, messageId: result.messageId,
          content: result.text, ...(result.metadata ? { metadata: result.metadata } : {}),
        });
      } else if (result.kind === 'append') {
        this.dispatch({ type: 'content', sessionId: result.sessionId, messageId: result.messageId, content: result.text });
      } else if (result.kind === 'metadata') {
        this.dispatch({
          type: 'content', sessionId: result.sessionId, messageId: result.messageId, metadata: result.metadata,
        });
      } else if (result.kind === 'desync') {
        void this.resyncLiveMessage(result.sessionId, result.messageId);
      }
    }));
    this.cleanups.push(cowork.onStreamPermission(({ sessionId, request }) => {
      this.dispatch({ type: 'permission', sessionId, request });
    }));
    this.cleanups.push(cowork.onStreamPermissionResolved(({ sessionId, requestId }) => {
      this.dispatch({ type: 'permissionResolved', sessionId, requestId });
      this.dismissedPermissionIds = new Set([...this.dismissedPermissionIds].filter((id) => id !== requestId));
      this.publish();
      void this.refreshSession(sessionId);
      void this.refreshPendingPermissions();
    }));
    this.cleanups.push(cowork.onStreamComplete(({ sessionId }) => {
      this.dispatch({ type: 'complete', sessionId });
      void this.refreshSession(sessionId);
      void this.reloadSessions();
    }));
    this.cleanups.push(cowork.onStreamError((payload: { sessionId: string; error: string; metadata?: { errorCode?: string } }) => {
      this.streamErrors = {
        ...this.streamErrors,
        [payload.sessionId]: { code: payload.metadata?.errorCode ?? null, text: payload.error },
      };
      this.dispatch({ type: 'error', sessionId: payload.sessionId });
      void this.refreshSession(payload.sessionId);
    }));
    const offTitle = cowork.onStreamSessionTitle?.(({ sessionId, title }) => {
      this.dispatch({ type: 'title', sessionId, title });
      this.sessions = this.sessions.map((session) => session.id === sessionId ? { ...session, title } : session);
      this.publish();
    });
    if (typeof offTitle === 'function') this.cleanups.push(offTitle);
  }

  private async resyncLiveMessage(sessionId: string, messageId: string): Promise<void> {
    const epoch = this.epoch;
    const revision = this.stateFor(sessionId).messageRevisions[messageId] ?? 0;
    try {
      const live = await this.electron.cowork.getStreamLiveContent({ sessionId, messageId });
      if (this.destroyed || epoch !== this.epoch) return;
      if ((this.stateFor(sessionId).messageRevisions[messageId] ?? 0) !== revision) return;
      const resolved = this.reassembler.resolveResync(
        sessionId,
        messageId,
        live?.success ? (live.content ?? null) : null,
      );
      if (resolved.kind === 'full') {
        this.dispatch({ type: 'content', sessionId, messageId, content: resolved.text });
      }
    } catch {
      return;
    }
  }

  async reloadSessions(): Promise<boolean> {
    const request = ++this.listRequest;
    try {
      const result = await this.electron.cowork.listSessions();
      if (this.destroyed || request !== this.listRequest) return false;
      if (!result?.success || !Array.isArray(result.sessions)) return false;
      this.sessions = result.sessions;
      this.publish();
      return true;
    } catch {
      return false;
    }
  }

  private ingestSessionSnapshot(
    session: CoworkSession,
    baseMessageRevisions: Record<string, number>,
  ): void {
    const current = this.stateFor(session.id);
    const next = applyCoworkSessionSnapshot(current, session, { baseMessageRevisions });
    this.states = new Map(this.states).set(session.id, next);
    this.uncertainSessionIds = new Set([...this.uncertainSessionIds].filter((id) => id !== session.id));
    this.publish();
  }

  private async refreshSessionOutcome(sessionId: string): Promise<'loaded' | 'superseded' | 'failed'> {
    const request = (this.sessionRequests.get(sessionId) ?? 0) + 1;
    this.sessionRequests.set(sessionId, request);
    const epoch = this.epoch;
    const baseMessageRevisions = { ...this.stateFor(sessionId).messageRevisions };
    try {
      const result = await this.electron.cowork.getSession(sessionId, { messageLimit: 200 });
      if (this.destroyed) return 'failed';
      if (epoch !== this.epoch || this.sessionRequests.get(sessionId) !== request) return 'superseded';
      if (!result?.success || !result.session) return 'failed';
      this.ingestSessionSnapshot(result.session, baseMessageRevisions);
      return 'loaded';
    } catch (error) {
      if (!this.destroyed && epoch === this.epoch && this.sessionRequests.get(sessionId) === request) {
        this.uncertainSessionIds = new Set(this.uncertainSessionIds).add(sessionId);
        this.actionErrors = { ...this.actionErrors, [sessionId]: errorText(error, 'Failed to refresh the session') };
        this.publish();
      }
      return 'failed';
    }
  }

  async refreshSession(sessionId: string): Promise<boolean> {
    return (await this.refreshSessionOutcome(sessionId)) === 'loaded';
  }

  async openSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    this.generation += 1;
    this.currentSessionId = sessionId;
    this.setState(this.stateFor(sessionId));
    this.persistOpenSession();
    this.publish();
    const [outcome] = await Promise.all([
      this.refreshSessionOutcome(sessionId),
      this.refreshPendingPermissions(),
    ]);
    return this.currentSessionId === sessionId && outcome !== 'failed';
  }

  newChat(): void {
    this.generation += 1;
    this.draftStore.resetNew();
    this.currentSessionId = null;
    this.persistOpenSession();
    this.publish();
  }

  async restore(metabotId: number | null, greeting?: CoworkGreetingOptions): Promise<void> {
    if (this.restorePromise) return this.restorePromise;
    const generation = this.generation;
    this.restoring = true;
    this.publish();
    this.restorePromise = (async () => {
      await this.reloadSessions();
      if (this.destroyed || generation !== this.generation) return;
      const saved = this.savedOpenSession();
      if (saved.explicitNew) {
        await this.refreshPendingPermissions();
        return;
      }
      let restored = saved.id ? await this.openSession(saved.id) : false;
      if (!restored && saved.id) this.newChat();
      if (!restored) {
        const target = this.sessions
          .filter((session) => (
            session.metabotId === metabotId
            && (!session.sessionType || session.sessionType === 'standard')
            && !session.autoOrigin
          ))
          .sort((a, b) => {
            if ((a.status === 'running') !== (b.status === 'running')) return a.status === 'running' ? -1 : 1;
            return b.updatedAt - a.updatedAt;
          })[0]?.id;
        if (target) restored = await this.openSession(target);
      }
      if (!restored && this.currentSessionId) this.newChat();
      if (!this.currentSessionId) {
        if (greeting && metabotId !== null) await this.createGreeting(metabotId, greeting);
        else await this.refreshPendingPermissions();
      }
    })().finally(() => {
      this.restoring = false;
      this.restorePromise = null;
      this.publish();
    });
    return this.restorePromise;
  }

  private async createGreeting(metabotId: number, options: CoworkGreetingOptions): Promise<boolean> {
    const generation = this.generation;
    try {
      const result = await this.electron.cowork.createGreetingSession({
        title: options.title,
        cwd: options.cwd,
        systemPrompt: options.systemPrompt,
        fallbackGreeting: options.fallbackGreeting,
        metabotId,
      });
      if (this.destroyed) return false;
      if (!result?.success || !result.session) {
        this.actionErrors = {
          ...this.actionErrors,
          new: result?.error ?? 'Failed to create the greeting session',
        };
        this.publish();
        return false;
      }
      const session = result.session;
      this.ingestSessionSnapshot(session, {});
      if (this.currentSessionId === null && generation === this.generation) {
        this.generation += 1;
        this.currentSessionId = session.id;
        this.draftStore.migrateNew(session.id);
        this.persistOpenSession();
      }
      this.publish();
      await this.reloadSessions();
      return true;
    } catch (error) {
      if (!this.destroyed) {
        this.actionErrors = { ...this.actionErrors, new: errorText(error, 'Failed to create the greeting session') };
        this.publish();
      }
      return false;
    }
  }

  beginResync = (): CoworkResyncGuard => {
    this.epoch += 1;
    this.publish();
    return {
      generation: this.generation,
      epoch: this.epoch,
      messageRevisions: this.currentSessionId
        ? { ...this.stateFor(this.currentSessionId).messageRevisions }
        : {},
    };
  };

  applyResync(snapshot: CoworkResyncSnapshot): void {
    const guard = snapshot.guard;
    if (guard && (guard.epoch !== this.epoch || guard.generation !== this.generation)) return;
    if (snapshot.session) {
      if (guard && snapshot.session.id !== this.currentSessionId) return;
      this.ingestSessionSnapshot(snapshot.session, guard?.messageRevisions ?? {});
    }
    if (snapshot.liveContent && snapshot.liveContent.sessionId === this.currentSessionId) {
      const { sessionId, messageId, content } = snapshot.liveContent;
      const resolved = this.reassembler.resolveResync(sessionId, messageId, content);
      if (resolved.kind === 'full') {
        this.dispatch({ type: 'content', sessionId, messageId, content: resolved.text });
      }
    }
    if (guard) {
      const current = this.currentSessionId ? this.stateFor(this.currentSessionId) : null;
      if (current) {
        this.setState({
          ...current,
          pendingPermissions: snapshot.pendingPermissions
            .filter((entry) => entry.sessionId === current.id && entry.request.sessionId === current.id)
            .map((entry) => entry.request),
        });
      }
    }
    void this.reloadSessions();
  }

  async refreshPendingPermissions(): Promise<boolean> {
    const epoch = this.epoch;
    try {
      const response = await this.electron.mobile.listPendingPermissions();
      if (this.destroyed || epoch !== this.epoch || !Array.isArray(response)) return false;
      const entries = response as PendingPermissionEntry[];
      const states = new Map(this.states);
      for (const [sessionId, state] of states) {
        states.set(sessionId, {
          ...state,
          pendingPermissions: entries
            .filter((entry) => entry.sessionId === sessionId && entry.request.sessionId === sessionId)
            .map((entry) => entry.request),
        });
      }
      this.states = states;
      this.publish();
      return true;
    } catch {
      return false;
    }
  }

  async loadEarlierMessages(): Promise<boolean> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return false;
    const state = this.stateFor(sessionId);
    const history = state.messageHistory;
    if (!history?.hasMoreBefore) return false;
    const request = (this.historyRequests.get(sessionId) ?? 0) + 1;
    this.historyRequests.set(sessionId, request);
    const generation = this.generation;
    try {
      const result = await this.electron.cowork.getSessionMessagesPage({
        sessionId,
        beforeSequence: history.beforeSequence,
        beforeTranscriptCursor: history.beforeTranscriptCursor ?? null,
        limit: history.pageSize || 50,
      });
      if (
        this.destroyed || generation !== this.generation
        || this.historyRequests.get(sessionId) !== request
        || !result?.success || !result.page
      ) return false;
      const page: CoworkMessagePage = result.page;
      const latest = this.stateFor(sessionId);
      const existing = new Set(latest.messages.map((message) => message.id));
      const earlier = page.messages.filter((message) => !existing.has(message.id));
      const nextHistory: CoworkMessageHistoryState = {
        hasMoreBefore: page.hasMoreBefore,
        beforeSequence: page.beforeSequence,
        beforeTranscriptCursor: page.beforeTranscriptCursor ?? null,
        pageSize: history.pageSize || 50,
        ...(history.beforeEpisodeIndex !== undefined ? { beforeEpisodeIndex: history.beforeEpisodeIndex } : {}),
      };
      this.setState({
        ...latest,
        messages: [...earlier, ...latest.messages],
        messageHistory: nextHistory,
      });
      return true;
    } catch {
      return false;
    }
  }

  private optimisticUserMessage(attempt: CoworkSubmissionAttempt): CoworkMessage {
    return {
      id: `local-${attempt.submissionId}`,
      type: 'user',
      content: attempt.text,
      timestamp: attempt.createdAt,
      metadata: { submissionId: attempt.submissionId, origin: 'user', optimistic: true },
    };
  }

  private removeOptimisticMessage(attempt: CoworkSubmissionAttempt): void {
    const sessionId = attempt.sessionId ?? 'new';
    const state = this.stateFor(sessionId);
    const id = `local-${attempt.submissionId}`;
    if (!state.messages.some((message) => message.id === id)) return;
    this.setState({ ...state, messages: state.messages.filter((message) => message.id !== id) });
  }

  private updateAttempt(attempt: CoworkSubmissionAttempt): void {
    this.attempts = this.attempts.map((entry) => (
      entry.submissionId === attempt.submissionId ? attempt : entry
    ));
    this.publish();
  }

  private finishAttempt(attempt: CoworkSubmissionAttempt): void {
    if (attempt.kind === 'submit') this.removeOptimisticMessage(attempt);
    this.attempts = this.attempts.filter((entry) => entry.submissionId !== attempt.submissionId);
    this.clearReconcilePin(attempt.submissionId);
    this.draftStore.clearIfUnchanged(attempt.draftToken, attempt.draftText, attempt.draftAttachments);
    this.publish();
  }

  /**
   * F-17b: when a submission ends uncertain (a gateway invoke timeout — the
   * tenant may still have completed the work), run ONE server reconcile
   * automatically instead of leaving the user with a bare "result unknown"
   * card to prod manually. The reconcile turns the transcript into a
   * definite verdict: accepted (submission landed) or verified (a known
   * side-effect tool finished), only falling back to "uncertain" when the
   * server still gives no proof.
   */
  private scheduleAutoReconcile(attempt: CoworkSubmissionAttempt): void {
    const submissionId = attempt.submissionId;
    if (this.reconcilingSubmissionIds.has(submissionId)) return;
    this.reconcilingSubmissionIds.add(submissionId);
    const existing = this.reconcileTimers.get(submissionId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.reconcileTimers.delete(submissionId);
      void this.runReconcile(submissionId).catch(() => undefined);
    }, 30);
    timer.unref?.();
    this.reconcileTimers.set(submissionId, timer);
  }

  private clearReconcilePin(submissionId: string): void {
    const timer = this.reconcileTimers.get(submissionId);
    if (timer) clearTimeout(timer);
    this.reconcileTimers.delete(submissionId);
    this.reconcilingSubmissionIds.delete(submissionId);
  }

  async runReconcile(submissionId: string): Promise<CoworkActionResult> {
    const attempt = this.attempts.find((entry) => entry.submissionId === submissionId);
    // Deliberate user actions (retry / discard / a resolved attempt) always
    // release the auto-reconcile pin so a later timeout of the same attempt
    // can schedule a fresh reconcile.
    if (!attempt) {
      this.clearReconcilePin(submissionId);
      return { status: 'failed', error: 'Submission no longer exists', submissionId };
    }
    const result = await this.reconcileSubmission(submissionId);
    if (result.status !== 'accepted' && result.status !== 'verified') {
      this.clearReconcilePin(submissionId);
    }
    return result;
  }

  private failAttempt(
    attempt: CoworkSubmissionAttempt,
    status: 'failed' | 'uncertain',
    error: string,
  ): CoworkActionResult {
    const errorKey = attempt.sessionId ?? 'new';
    this.actionErrors = { ...this.actionErrors, [errorKey]: this.actionErrors[errorKey] ?? error };
    if (status === 'failed') this.removeOptimisticMessage(attempt);
    this.updateAttempt({ ...attempt, status, error });
    if (status === 'uncertain') this.scheduleAutoReconcile(attempt);
    return { status, error, submissionId: attempt.submissionId, sessionId: attempt.sessionId };
  }

  async send(
    text: string,
    startOptions: Omit<CoworkStartOptions, 'prompt'>,
    attachments: MobileChatAttachment[] = [],
    inputFileLabel = 'Input file',
  ): Promise<CoworkActionResult> {
    const sessionId = this.currentSessionId;
    const draftToken = this.draftStore.tokenForSession(sessionId);
    const draftAttachments = attachments.map((attachment) => ({ ...attachment }));
    const composition = composeCoworkSubmitPrompt({
      submittedValue: text,
      attachments: draftAttachments,
      inputFileLabel,
    });
    if (!composition.finalPrompt) return { status: 'failed', error: 'Message is empty' };
    if (this.attempts.some((attempt) => attempt.sessionId === sessionId && attempt.status === 'sending')) {
      return { status: 'failed', error: 'A message is already being sent', sessionId };
    }
    const attempt: CoworkSubmissionAttempt = {
      submissionId: this.createSubmissionId(),
      kind: sessionId ? 'submit' : 'start',
      sessionId,
      text: composition.finalPrompt,
      draftToken,
      draftText: text,
      draftAttachments,
      status: 'sending',
      error: null,
      createdAt: this.now(),
      startOptions: sessionId ? null : startOptions,
    };
    this.attempts = [...this.attempts, attempt];
    const errorKey = sessionId ?? 'new';
    const remainingErrors = { ...this.actionErrors };
    delete remainingErrors[errorKey];
    this.actionErrors = remainingErrors;
    if (sessionId) {
      const remainingStreamErrors = { ...this.streamErrors };
      delete remainingStreamErrors[sessionId];
      this.streamErrors = remainingStreamErrors;
    }
    this.dispatch({
      type: 'message',
      sessionId: attempt.sessionId ?? 'new',
      message: this.optimisticUserMessage(attempt),
    });
    this.publish();
    let outcome: CoworkActionResult | undefined;
    try {
      await submitCoworkComposerDraft({
        draftField: this.draftStore.field(draftToken, 'text', text),
        attachmentField: this.draftStore.field(draftToken, 'attachments', draftAttachments),
        onSubmit: async () => {
          outcome = sessionId ? await this.submitAttempt(attempt) : await this.startAttempt(attempt);
          return outcome.status === 'accepted';
        },
      });
    } catch (error) {
      return this.failAttempt(attempt, 'uncertain', errorText(error, 'Connection lost while submitting'));
    }
    return outcome ?? this.failAttempt(attempt, 'failed', 'Submission did not complete');
  }

  private async submitAttempt(attempt: CoworkSubmissionAttempt): Promise<CoworkActionResult> {
    const sessionId = attempt.sessionId;
    if (!sessionId) return this.failAttempt(attempt, 'failed', 'Session is missing');
    try {
      const result = await this.electron.cowork.submitInput({
        sessionId,
        submissionId: attempt.submissionId,
        text: attempt.text,
      });
      if (result?.success && result.message) {
        this.removeOptimisticMessage(attempt);
        this.dispatch({ type: 'message', sessionId, message: result.message });
        this.finishAttempt(attempt);
        void this.reloadSessions();
        return { status: 'accepted', error: null, submissionId: attempt.submissionId, sessionId };
      }
      const failure = result && 'error' in result ? result.error : 'Failed to submit the message';
      const uncertain = result && 'code' in result && result.code === 'delivery_failed';
      return this.failAttempt(attempt, uncertain ? 'uncertain' : 'failed', failure);
    } catch (error) {
      return this.failAttempt(attempt, 'uncertain', errorText(error, 'Connection lost while submitting'));
    }
  }

  private async startAttempt(attempt: CoworkSubmissionAttempt): Promise<CoworkActionResult> {
    const generation = this.generation;
    try {
      const result = await this.electron.cowork.startSession({
        ...(attempt.startOptions ?? {}),
        prompt: attempt.text,
        title: attempt.startOptions?.title ?? (
          attempt.draftText.trim().split('\n')[0]!.slice(0, 50)
          || attempt.draftAttachments[0]?.name.slice(0, 50)
          || 'New chat'
        ),
      });
      if (result?.success && result.session) {
        const session = result.session;
        this.removeOptimisticMessage(attempt);
        this.ingestSessionSnapshot(session, {});
        const hasUserMessage = this.stateFor(session.id).messages.some((message) => (
          message.type === 'user'
          && (message.metadata?.submissionId === attempt.submissionId || message.content === attempt.text)
        ));
        if (!hasUserMessage) {
          this.dispatch({
            type: 'message',
            sessionId: session.id,
            message: this.optimisticUserMessage(attempt),
          });
        }
        if (this.currentSessionId === null && this.generation === generation) {
          this.generation += 1;
          this.currentSessionId = session.id;
          this.draftStore.migrateNew(session.id);
          this.persistOpenSession();
        }
        this.finishAttempt(attempt);
        this.publish();
        void this.reloadSessions();
        return { status: 'accepted', error: null, submissionId: attempt.submissionId, sessionId: session.id };
      }
      return this.failAttempt(attempt, 'failed', result?.error ?? 'Failed to start the session');
    } catch (error) {
      return this.failAttempt(attempt, 'uncertain', errorText(error, 'Connection lost while starting the session'));
    }
  }

  async retrySubmission(submissionId: string): Promise<CoworkActionResult> {
    const attempt = this.attempts.find((entry) => entry.submissionId === submissionId);
    if (!attempt) return { status: 'failed', error: 'Submission no longer exists', submissionId };
    if (attempt.kind === 'start' && attempt.status === 'uncertain') {
      return {
        status: 'uncertain',
        error: 'The start outcome is unknown. Reconcile sessions before choosing another send.',
        submissionId,
      };
    }
    const retry = { ...attempt, status: 'sending' as const, error: null };
    this.clearReconcilePin(retry.submissionId);
    this.updateAttempt(retry);
    return retry.kind === 'start' ? this.startAttempt(retry) : this.submitAttempt(retry);
  }

  async reconcileSubmission(submissionId: string): Promise<CoworkActionResult> {
    const attempt = this.attempts.find((entry) => entry.submissionId === submissionId);
    if (!attempt) return { status: 'failed', error: 'Submission no longer exists', submissionId };
    if (attempt.kind === 'start') {
      await this.reloadSessions();
      return this.failAttempt(
        attempt,
        'uncertain',
        'Check the session list and open the restored session, or discard this attempt before sending again.',
      );
    }
    const sessionId = attempt.sessionId!;
    if (attempt.status === 'uncertain') {
      // Visible reconcile round (manual click or the F-17b auto pass).
      this.updateAttempt({ ...attempt, status: 'reconciling', error: null });
    }
    await this.refreshSession(sessionId);
    // The user's retry outranks the reconcile: an in-flight reconcile that
    // finishes after the attempt was resubmitted must never overwrite the
    // live 'sending' status.
    const liveAttempt = this.attempts.find((entry) => entry.submissionId === submissionId);
    if (!liveAttempt || (liveAttempt.status !== 'reconciling' && liveAttempt.status !== 'failed')) {
      return { status: 'uncertain', error: null, submissionId, sessionId };
    }
    const messages = this.stateFor(sessionId).messages;
    const landed = messages.some(
      (message) => message.metadata?.optimistic !== true && message.metadata?.submissionId === submissionId,
    );
    if (landed) {
      this.finishAttempt(attempt);
      return { status: 'accepted', error: null, submissionId, sessionId };
    }
    // F-17b: the delivery of the text is not the only ledger — a side-effect
    // tool that already finished proves the work is done even if the user's
    // message text got lost in transport sizing. E.g. the 2026-10-28 阿燃
    // case: submit timed out at 120000ms, while the tenant transcript showed
    // `metabot_create` → 'MetaBot created: 阿燃 (id=2 …)'.
    const verdict = detectSideEffectOutcome(messages, attempt);
    if (verdict) {
      this.updateAttempt({
        ...attempt,
        status: 'verified',
        error: verdict.length > 200 ? `${verdict.slice(0, 200)}…` : verdict,
      });
      return { status: 'verified', error: null, submissionId, sessionId };
    }
    return this.failAttempt(attempt, 'uncertain', 'The tenant has not confirmed this submission yet');
  }

  discardSubmission(submissionId: string): void {
    const attempt = this.attempts.find((entry) => entry.submissionId === submissionId);
    if (attempt?.status === 'failed') this.removeOptimisticMessage(attempt);
    this.attempts = this.attempts.filter((entry) => entry.submissionId !== submissionId);
    this.clearReconcilePin(submissionId);
    this.publish();
  }

  async stop(): Promise<CoworkActionResult> {
    const sessionId = this.currentSessionId;
    if (!sessionId) return { status: 'failed', error: 'No session is open' };
    this.stoppingSessionIds = new Set(this.stoppingSessionIds).add(sessionId);
    this.publish();
    try {
      const result = await this.electron.cowork.stopSession(sessionId);
      if (!result?.success) {
        const message = result?.error ?? 'Failed to stop the session';
        this.actionErrors = { ...this.actionErrors, [sessionId]: message };
        this.publish();
        return { status: 'failed', error: message, sessionId };
      }
      const refreshed = await this.refreshSession(sessionId);
      if (!refreshed) {
        const refreshError = 'Stop was accepted, but the latest session state could not be loaded';
        this.actionErrors = { ...this.actionErrors, [sessionId]: refreshError };
        this.publish();
        return { status: 'uncertain', error: refreshError, sessionId, refreshError };
      }
      return { status: 'accepted', error: null, sessionId };
    } catch (error) {
      const message = errorText(error, 'Connection lost while stopping');
      this.uncertainSessionIds = new Set(this.uncertainSessionIds).add(sessionId);
      this.actionErrors = { ...this.actionErrors, [sessionId]: message };
      this.publish();
      return { status: 'uncertain', error: message, sessionId };
    } finally {
      this.stoppingSessionIds = new Set([...this.stoppingSessionIds].filter((id) => id !== sessionId));
      this.publish();
    }
  }

  async respondPermission(requestId: string, result: CoworkPermissionResult): Promise<CoworkActionResult> {
    const state = [...this.states.values()].find((entry) => (
      entry.pendingPermissions.some((request) => request.requestId === requestId)
    ));
    if (!state || this.respondingPermissionIds.has(requestId)) {
      return { status: 'failed', error: 'Permission request is no longer pending' };
    }
    this.respondingPermissionIds = new Set(this.respondingPermissionIds).add(requestId);
    this.publish();
    try {
      const response = await this.electron.cowork.respondToPermission({ requestId, result });
      if (!response?.success) {
        const message = response?.error ?? 'Failed to answer the permission request';
        this.actionErrors = { ...this.actionErrors, [state.id]: message };
        this.publish();
        return { status: 'failed', error: message, sessionId: state.id };
      }
      this.dispatch({ type: 'permissionResolved', sessionId: state.id, requestId });
      const [refreshed] = await Promise.all([
        this.refreshSession(state.id),
        this.refreshPendingPermissions(),
      ]);
      if (!refreshed) {
        const message = 'Answer accepted, but the latest session state could not be loaded';
        this.actionErrors = { ...this.actionErrors, [state.id]: message };
        this.publish();
        return {
          status: 'uncertain', error: message,
          sessionId: state.id, refreshError: 'Session refresh failed',
        };
      }
      return { status: 'accepted', error: null, sessionId: state.id };
    } catch (error) {
      const message = errorText(error, 'Connection lost while answering');
      this.actionErrors = { ...this.actionErrors, [state.id]: message };
      this.publish();
      return { status: 'uncertain', error: message, sessionId: state.id };
    } finally {
      this.respondingPermissionIds = new Set([...this.respondingPermissionIds].filter((id) => id !== requestId));
      this.publish();
    }
  }

  dismissPermission(requestId: string): void {
    this.dismissedPermissionIds = new Set(this.dismissedPermissionIds).add(requestId);
    this.publish();
  }

  reopenPermissions(): void {
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    const pending = new Set(
      this.stateFor(sessionId).pendingPermissions.map((request) => request.requestId),
    );
    this.dismissedPermissionIds = new Set(
      [...this.dismissedPermissionIds].filter((requestId) => !pending.has(requestId)),
    );
    this.publish();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const submissionId of [...this.reconcileTimers.keys()]) {
      this.clearReconcilePin(submissionId);
    }
    for (const cleanup of this.cleanups.splice(0)) cleanup();
    for (const timer of this.healTimers.values()) clearTimeout(timer);
    this.healTimers.clear();
    this.reassembler.reset();
    this.listeners.clear();
  }
}
