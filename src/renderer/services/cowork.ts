import { store } from '../store';
import {
  setSessions,
  setCurrentSession,
  addSession,
  registerBackgroundSession,
  updateSessionStatus,
  deleteSession as deleteSessionAction,
  addMessage,
  prependMessages,
  updateMessageContent,
  appendMessageContent,
  setMessageFeedback as setMessageFeedbackAction,
  clearMessageFeedback as clearMessageFeedbackAction,
  loadSessionFeedback as loadSessionFeedbackAction,
  markSessionFeedbackLoaded,
  setStreaming,
  updateSessionPinned,
  updateSessionFoldOverride,
  updateSessionFollowUp,
  updateSessionTitle,
  updateSessionPermissionMode,
  updateSessionGoal,
  upsertSubagentTask,
  setSubagentTasks,
  enqueuePendingPermission,
  dequeuePendingPermission,
  setConfig,
  clearCurrentSession,
} from '../store/slices/coworkSlice';
import {
  addBrowserMessage,
  updateBrowserMessageContent,
  appendBrowserMessageContent,
  updateBrowserSessionStatus,
} from '../store/slices/browserCoworkSlice';
import type {
  CoworkSession,
  CoworkSessionStatus,
  CoworkConfigUpdate,
  CoworkApiConfig,
  CoworkSandboxStatus,
  CoworkSandboxProgress,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkMemoryPolicy,
  MemoryHygieneConfig,
  MemoryHygieneRunStats,
  TeamCultureEntry,
  TeamCultureActiveCounts,
  TeamCultureDistillationRecord,
  TeamCultureKind,
  TeamCultureStatus,
  TaskCommTrendRow,
  CoworkMemoryScopesOverview,
  CoworkSessionMemoryScope,
  CoworkMetaIDContactSummary,
  CoworkMetaIDContactDetail,
  CoworkKnowledgeEntry,
  CoworkKnowledgeKind,
  CoworkKnowledgeStatus,
  CoworkPermissionResult,
  CoworkA2AGuidanceRequest,
  CoworkA2AGuidanceResult,
  CoworkA2AOwnerMessageRequest,
  CoworkA2AOwnerMessageResult,
  CoworkA2AHistoryCursor,
  CoworkA2AHistoryPage,
  CoworkPermissionMode,
  CoworkSessionFoldOverride,
  CoworkStartOptions,
  CoworkContinueOptions,
  CoworkSubmitInput,
  CoworkSubmitInputResult,
  CoworkMessage,
  MessageFeedbackRating,
  SubagentTaskState,
  SubagentTaskStatus,
} from '../types/cowork';
import {
  shouldMarkSessionRunningFromStreamMessage,
  shouldRegisterStreamSessionFromFetch,
} from './coworkStreamPresentation';
import { i18nService } from './i18n';
import { metabotAvatarCache } from './metabotAvatarCache';
import {
  CoworkStreamReassembler,
  type CoworkStreamUpdatePayload,
} from './coworkStreamReassembly';

/**
 * Trailing window that folds a burst of session-list refresh requests into one
 * read. Event-driven refreshes (a stream message carrying refreshSessionSummary,
 * a peer-profile refresh, a background session appearing) arrive faster than a
 * full list read completes; without the fold every one of them sent its own
 * ~36MB-shaped list read through IPC.
 */
const SESSIONS_RELOAD_DEBOUNCE_MS = 300;

/**
 * Ceiling on how long a buffered stream update may wait for the next animation
 * frame. A hidden or backgrounded window throttles frames; live tokens must
 * still land in the stores.
 */
const STREAM_FLUSH_MAX_DELAY_MS = 100;
/** Bound on the per-message stream baselines kept for the append fast path. */
const STREAM_DISPATCHED_MAX_KEYS = 256;
/** Debounce for the gap-heal reload: one reload per session per window. */
const STREAM_GAP_HEAL_DEBOUNCE_MS = 1200;
/** Bound on per-session live-tail sequence tracking. */
const STREAM_TAIL_SEQ_MAX_KEYS = 512;

type PendingStreamUpdate = {
  sessionId: string;
  messageId: string;
  /** Accumulated stream text, or null for a metadata-only update. */
  text: string | null;
  metadata?: CoworkMessage['metadata'];
  /** What this service last wrote for the message (see rememberStreamDispatched). */
  dispatched: string | null;
};

class CoworkService {
  private streamListenerCleanups: Array<() => void> = [];
  private initialized = false;
  /** Incremental stream reassembly (renderer half of the delta protocol). */
  private readonly streamReassembly = new CoworkStreamReassembler();
  /** Buffered stream updates waiting for the next flush. */
  private readonly streamPending = new Map<string, PendingStreamUpdate>();
  /** Per-message text the stores were last given, for the append fast path. */
  private readonly streamDispatched = new Map<string, string>();
  private streamFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private streamFlushFrame: number | null = null;
  /** The session-list read in progress, if any; reads never overlap. */
  private sessionsLoadInFlight: Promise<void> | null = null;
  private sessionsReloadTimer: ReturnType<typeof setTimeout> | null = null;
  /** Callers waiting for the next read the current burst will produce. */
  private sessionsReloadWaiters: Array<() => void> = [];
  /** Newest live sequence seen per session (stream events + session loads). */
  private readonly streamTailSeq = new Map<string, number>();
  /** Sessions with a gap-heal reload already scheduled (debounce). */
  private readonly streamGapHealTimers = new Map<string, ReturnType<typeof setTimeout>>();

  async init(): Promise<void> {
    if (this.initialized) return;

    // Load initial config
    await this.loadConfig();

    // Load sessions list
    await this.loadSessions();

    // Set up stream listeners
    this.setupStreamListeners();

    this.initialized = true;
  }

  private setupStreamListeners(): void {
    const cowork = window.electron?.cowork;
    if (!cowork) return;

    // Clean up any existing listeners
    this.cleanupListeners();

    // Message listener - also check if session exists (for IM-created sessions)
    const messageCleanup = cowork.onStreamMessage(async ({ sessionId, message }) => {
      // Whole-message loss detection runs before anything awaitable: a dropped
      // base event is exactly the case where the rest of this handler may be
      // the only signal that ever arrives.
      this.noteStreamSequence(sessionId, message);

      // Check if session exists in current list
      let state = store.getState().cowork;
      let sessionExists = state.sessions.some(s => s.id === sessionId);

      if (!sessionExists) {
        // Session was created by IM or another source, refresh the session list
        await this.loadSessions();
        // Re-check after reload
        state = store.getState().cowork;
        sessionExists = state.sessions.some(s => s.id === sessionId);
      }

      // If still not found (e.g. race condition), fetch and register it directly
      if (!sessionExists) {
        try {
          const result = await window.electron?.cowork?.getSession(sessionId);
          if (result?.success && result.session) {
            const s = result.session;
            if (shouldRegisterStreamSessionFromFetch(s)) {
              store.dispatch(registerBackgroundSession({
                id: s.id,
                title: s.title,
                status: s.status,
                pinned: s.pinned ?? false,
                createdAt: s.createdAt,
                updatedAt: s.updatedAt,
                sessionType: s.sessionType,
                peerName: s.peerName ?? null,
                peerAvatar: s.peerAvatar ?? null,
                metabotId: s.metabotId ?? null,
                metabotName: s.metabotName ?? null,
                metabotAvatar: s.metabotAvatar ?? null,
                // Stream-created background sessions (long-term task runs,
                // orchestration runs, scheduled runs) must arrive with their
                // fold marker: without it a machine-started session would pop
                // into the human list until the next full refresh.
                autoOrigin: s.autoOrigin ?? null,
                serviceOrderSummary: s.serviceOrderSummary ?? null,
              }));
            }
          }
        } catch { /* ignore */ }
      }

      // A new user turn means this session is actively running again
      // (especially important for IM-triggered turns that do not call continueSession from renderer).
      if (shouldMarkSessionRunningFromStreamMessage(message)) {
        store.dispatch(updateSessionStatus({ sessionId, status: 'running' }));
        store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'running' }));
      }

      // Do not force status back to "running" on arbitrary messages.
      // Late stream chunks can arrive after an error/complete event.
      store.dispatch(addMessage({ sessionId, message }));
      store.dispatch(addBrowserMessage({ sessionId, message }));

      // Subagent activity events ride on system messages via
      // metadata.subagentEvent; drive the live subagent panel, not the message list.
      const subagentEvent = message.metadata?.subagentEvent as
        | (Record<string, unknown> & { event?: string; taskId?: string })
        | undefined;
      if (subagentEvent?.event) {
        const eventName = subagentEvent.event;

        // background_tasks_changed is a level signal for the whole set (no
        // taskId); REPLACE the task map. Preserve existing task detail — the
        // payload is ids-only — and keep real terminal status.
        if (eventName === 'background_tasks_changed') {
          const backgroundTasks = Array.isArray(subagentEvent.backgroundTasks)
            ? subagentEvent.backgroundTasks as Array<{ taskId: string; taskType: string; description: string }>
            : [];
          store.dispatch(setSubagentTasks({
            sessionId,
            tasks: backgroundTasks,
          }));
          return;
        }

        if (!subagentEvent.taskId) return;
        const taskId = String(subagentEvent.taskId);
        const task: SubagentTaskState = {
          taskId,
          sessionId,
          toolUseId: typeof subagentEvent.toolUseId === 'string' ? subagentEvent.toolUseId : undefined,
          subagentType: typeof subagentEvent.subagentType === 'string' ? subagentEvent.subagentType : undefined,
          taskType: typeof subagentEvent.taskType === 'string' ? subagentEvent.taskType : undefined,
          workflowName: typeof subagentEvent.workflowName === 'string' ? subagentEvent.workflowName : undefined,
          description: typeof subagentEvent.description === 'string' ? subagentEvent.description : undefined,
          prompt: typeof subagentEvent.prompt === 'string' ? subagentEvent.prompt : undefined,
          status: (subagentEvent.status as SubagentTaskStatus) ?? 'running',
          isBackgrounded: typeof subagentEvent.isBackgrounded === 'boolean'
            ? subagentEvent.isBackgrounded
            : undefined,
          endTime: typeof subagentEvent.endTime === 'number' ? subagentEvent.endTime : undefined,
          summary: typeof subagentEvent.summary === 'string' ? subagentEvent.summary : undefined,
          lastToolName: typeof subagentEvent.lastToolName === 'string' ? subagentEvent.lastToolName : undefined,
          outputFile: typeof subagentEvent.outputFile === 'string' ? subagentEvent.outputFile : undefined,
          error: typeof subagentEvent.error === 'string' ? subagentEvent.error : undefined,
          usage: subagentEvent.usage as SubagentTaskState['usage'],
          startedAt: typeof subagentEvent.startedAt === 'number' ? subagentEvent.startedAt : undefined,
          updatedAt: typeof subagentEvent.updatedAt === 'number' ? subagentEvent.updatedAt : undefined,
        };
        store.dispatch(upsertSubagentTask(task));
      }

      if (message.metadata?.refreshSessionSummary) {
        await this.loadSessions();
        const currentSessionId = store.getState().cowork.currentSessionId;
        const previousEpisodeSessionId = typeof message.metadata.previousEpisodeSessionId === 'string'
          ? message.metadata.previousEpisodeSessionId
          : null;
        if (previousEpisodeSessionId && currentSessionId === previousEpisodeSessionId) {
          await this.loadSession(sessionId);
        } else if (currentSessionId === sessionId) {
          try {
            const refreshed = await window.electron?.cowork?.getSession(sessionId);
            if (refreshed?.success && refreshed.session) {
              store.dispatch(setCurrentSession(refreshed.session));
            }
          } catch { /* ignore */ }
        }
      }
    });
    this.streamListenerCleanups.push(messageCleanup);

    // Message update listener (for streaming content updates). Payloads are
    // incremental (see main/libs/coworkStreamUiDelta.ts); the reassembler turns
    // them back into the accumulated text the store has always received.
    const messageUpdateCleanup = cowork.onStreamMessageUpdate((payload) => {
      this.handleStreamMessageUpdate(payload);
    });
    this.streamListenerCleanups.push(messageUpdateCleanup);

    // Permission request listener
    const permissionCleanup = cowork.onStreamPermission(({ sessionId, request }) => {
      store.dispatch(enqueuePendingPermission({
        sessionId,
        toolName: request.toolName,
        toolInput: request.toolInput,
        requestId: request.requestId,
        toolUseId: request.toolUseId ?? null,
        perQuestionTimeoutMs: request.perQuestionTimeoutMs ?? null,
        expiresAt: typeof request.expiresAt === 'number' ? request.expiresAt : null,
        timeoutDefault: request.timeoutDefault === 'allow' || request.timeoutDefault === 'deny'
          ? request.timeoutDefault
          : null,
      }));
    });
    this.streamListenerCleanups.push(permissionCleanup);

    // Permission resolution listener: requests finalized on any path (text
    // relay, watchdog timeout, auto-allow, abort) leave no stale overlay.
    const permissionResolvedCleanup = cowork.onStreamPermissionResolved(({ requestId }) => {
      store.dispatch(dequeuePendingPermission({ requestId }));
    });
    this.streamListenerCleanups.push(permissionResolvedCleanup);

    // Renderer-reload replay (2026-10-23 ab67c828 incident): the permission
    // broadcast is raise-time only, so a window reload while an ask waits
    // (ask_user_question with timeout:-1 never self-unwinds) orphaned its
    // modal — the turn kept waiting with no UI left to answer. Re-enqueue
    // whatever main still tracks; the reducer's requestId dedup keeps this
    // idempotent with entries the live broadcast already delivered.
    void window.electron?.cowork?.listPendingPermissions?.().then((response) => {
      if (!response?.success || !Array.isArray(response.permissions)) return;
      for (const entry of response.permissions) {
        if (typeof entry?.requestId !== 'string' || !entry.requestId) continue;
        store.dispatch(enqueuePendingPermission({
          sessionId: entry.sessionId,
          toolName: entry.toolName,
          toolInput: entry.toolInput,
          requestId: entry.requestId,
          toolUseId: entry.toolUseId ?? null,
          perQuestionTimeoutMs: entry.perQuestionTimeoutMs ?? null,
          expiresAt: typeof entry.expiresAt === 'number' ? entry.expiresAt : null,
          timeoutDefault: entry.timeoutDefault === 'allow' || entry.timeoutDefault === 'deny'
            ? entry.timeoutDefault
            : null,
        } as never));
      }
    }).catch(() => undefined);

    // Complete listener
    const completeCleanup = cowork.onStreamComplete(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'completed' }));
      // Correct the status from the backend if it did NOT actually mark the
      // turn completed. An "empty terminal turn" (DeepSeek thinking-placeholder
      // truncation — the model ended with only reasoning and no final reply)
      // is left `idle` by the backend; without this correction the task list
      // would falsely show "completed" while the final handoff is missing.
      // Also refreshes the current session so usageStats (token/cost chip)
      // reflects the just-finished turn.
      void window.electron?.cowork?.getSession(sessionId).then((refreshed) => {
        if (!refreshed?.success || !refreshed.session) return;
        const backendStatus = refreshed.session.status;
        if (backendStatus && backendStatus !== 'completed') {
          store.dispatch(updateSessionStatus({ sessionId, status: backendStatus }));
          store.dispatch(updateBrowserSessionStatus({ sessionId, status: backendStatus }));
        }
        if (store.getState().cowork.currentSessionId === sessionId) {
          store.dispatch(setCurrentSession(refreshed.session));
          // The turn is over; re-seed the live-tail tracker from the
          // authoritative read so a gap that slipped through mid-turn cannot
          // keep re-firing (or worse, stay silent) on the next turn.
          this.noteSessionSnapshotSeq(refreshed.session);
        }
      }).catch((error) => {
        // This refresh is the last-line healer for dropped stream events — a
        // silent failure here is exactly how a finished turn stays invisible.
        console.warn('[cowork] post-complete session refresh failed:', error);
      });
    });
    this.streamListenerCleanups.push(completeCleanup);

    // Error listener
    const errorCleanup = cowork.onStreamError(({ sessionId }) => {
      store.dispatch(updateSessionStatus({ sessionId, status: 'error' }));
      store.dispatch(updateBrowserSessionStatus({ sessionId, status: 'error' }));
    });
    this.streamListenerCleanups.push(errorCleanup);

    // Kernel-owned session title (dsh-session-title): fallback first, then the
    // first-prompt LLM refinement. The main process already guarded against
    // manual renames and wrote the store row; mirror it into redux.
    const sessionTitleCleanup = cowork.onStreamSessionTitle?.(({ sessionId, title }) => {
      store.dispatch(updateSessionTitle({ sessionId, title }));
    });
    if (typeof sessionTitleCleanup === 'function') {
      this.streamListenerCleanups.push(sessionTitleCleanup);
    }

    // A2A peer profile (name/avatar) was refreshed from latest chain data in
    // the main process; reload so the session list and open detail show it.
    const profileRefreshedCleanup = cowork.onSessionProfileRefreshed?.(async ({ sessionId }) => {
      await this.loadSessions();
      if (store.getState().cowork.currentSessionId === sessionId) {
        try {
          const refreshed = await window.electron?.cowork?.getSession(sessionId);
          if (refreshed?.success && refreshed.session) {
            store.dispatch(setCurrentSession(refreshed.session));
          }
        } catch { /* ignore */ }
      }
    });
    if (typeof profileRefreshedCleanup === 'function') {
      this.streamListenerCleanups.push(profileRefreshedCleanup);
    }
  }

  private cleanupListeners(): void {
    this.streamListenerCleanups.forEach(cleanup => cleanup());
    this.streamListenerCleanups = [];
    this.streamReassembly.reset();
    this.streamPending.clear();
    this.cancelStreamFlush();
    for (const timer of this.streamGapHealTimers.values()) clearTimeout(timer);
    this.streamGapHealTimers.clear();
  }

  /**
   * Reassemble one incremental stream update into the pending buffer.
   *
   * Updates are coalesced rather than dispatched on arrival: several turns can
   * stream at once (parallel sessions, IM/A2A relays, the Bot Browser panel),
   * and each dispatch re-renders every component subscribed to the cowork
   * slice. One flush per animation frame (bounded by a trailing timer for
   * background windows) keeps the transcript at paint cadence while the stores
   * still receive the accumulated text they always received.
   */
  private handleStreamMessageUpdate(payload: CoworkStreamUpdatePayload): void {
    const result = this.streamReassembly.apply(payload);
    switch (result.kind) {
      case 'full':
      case 'append': {
        const metadata = result.kind === 'full' ? result.metadata : undefined;
        this.bufferStreamContent(result.sessionId, result.messageId, result.text, metadata, {
          // Finalize is the authoritative sync point for a message; never make
          // the settled state wait for the next paint.
          immediate: Boolean(metadata?.isFinal),
        });
        break;
      }
      case 'metadata':
        // Metadata-only updates stay immediate: they are rare (finalize
        // bookkeeping, private-chat tags) and carry no content to coalesce.
        this.bufferStreamContent(result.sessionId, result.messageId, undefined, result.metadata, {
          immediate: Boolean(result.metadata?.isFinal),
        });
        break;
      case 'desync':
        // The delta does not fit the text held here (dropped payload, session
        // switched in mid-stream, renderer reloaded). Ask the main process for
        // the text the stream is appending to; the finalize payload is always
        // full, so ignoring a delta can only cost live smoothness.
        void this.resyncStreamMessage(result.sessionId, result.messageId);
        break;
      default:
        break;
    }
  }

  private bufferStreamContent(
    sessionId: string,
    messageId: string,
    text: string | undefined,
    metadata?: CoworkMessage['metadata'],
    options?: { immediate?: boolean },
  ): void {
    const key = `${sessionId}\0${messageId}`;
    const pending = this.streamPending.get(key) ?? {
      sessionId,
      messageId,
      text: null,
      dispatched: this.streamDispatched.get(key) ?? null,
    };
    if (text !== undefined) pending.text = text;
    if (metadata !== undefined) pending.metadata = metadata;
    this.streamPending.set(key, pending);
    if (options?.immediate) {
      this.flushStreamPending();
      return;
    }
    this.scheduleStreamFlush();
  }

  /**
   * Land every buffered stream update in both stores. The delta form is used
   * only when the store's copy still holds exactly what this service last
   * wrote for it; anything else (a slice reloaded mid-stream, a resync, the
   * panel showing a different point in time) gets the whole text.
   */
  private flushStreamPending(): void {
    this.cancelStreamFlush();
    if (this.streamPending.size === 0) return;
    const pending = [...this.streamPending.values()];
    this.streamPending.clear();
    const taskState = store.getState();
    /** Session ids already given their "has traffic" bookkeeping this flush. */
    const trafficMarked = new Set<string>();
    const targets: Array<{
      session: CoworkSession | null | undefined;
      /** The slice that also keeps the unread marker for streamed traffic. */
      tracksTraffic: boolean;
      append: (payload: { sessionId: string; messageId: string; delta: string }) => void;
      update: (payload: { sessionId: string; messageId: string; content?: string; metadata?: CoworkMessage['metadata'] }) => void;
    }> = [
      {
        session: taskState.cowork.currentSession,
        tracksTraffic: true,
        append: (payload) => store.dispatch(appendMessageContent(payload)),
        update: (payload) => store.dispatch(updateMessageContent(payload)),
      },
      {
        session: taskState.browserCowork.currentSession,
        tracksTraffic: false,
        append: (payload) => store.dispatch(appendBrowserMessageContent(payload)),
        update: (payload) => store.dispatch(updateBrowserMessageContent(payload)),
      },
    ];

    for (const entry of pending) {
      const key = `${entry.sessionId}\0${entry.messageId}`;

      for (const target of targets) {
        if (target.session?.id !== entry.sessionId) {
          // The slice is not showing this session, but the reducer still keeps
          // its "this session has traffic" bookkeeping on every stream update —
          // the unread marker a background turn raises. Replay exactly that,
          // once per session and flush, without any content.
          if (target.tracksTraffic && !trafficMarked.has(entry.sessionId)) {
            trafficMarked.add(entry.sessionId);
            target.update({
              sessionId: entry.sessionId,
              messageId: entry.messageId,
              ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
            });
          }
          continue;
        }
        const message = target.session.messages.find((item) => item.id === entry.messageId);
        if (!message) continue;
        if (entry.text === null) {
          if (entry.metadata !== undefined) {
            target.update({ sessionId: entry.sessionId, messageId: entry.messageId, metadata: entry.metadata });
          }
          continue;
        }
        if (message.content === entry.text) {
          // Nothing to append, but a metadata payload (finalize settles the
          // bubble) still has to land.
          if (entry.metadata !== undefined) {
            target.update({ sessionId: entry.sessionId, messageId: entry.messageId, metadata: entry.metadata });
          }
          continue;
        }
        if (entry.dispatched !== null
          && message.content === entry.dispatched
          && entry.text.startsWith(entry.dispatched)) {
          target.append({
            sessionId: entry.sessionId,
            messageId: entry.messageId,
            delta: entry.text.slice(entry.dispatched.length),
          });
          continue;
        }
        target.update({
          sessionId: entry.sessionId,
          messageId: entry.messageId,
          content: entry.text,
          ...(entry.metadata !== undefined ? { metadata: entry.metadata } : {}),
        });
      }

      this.rememberStreamDispatched(key, entry);
    }
  }

  /**
   * Remember what the stores now hold for a message so the next flush can send
   * only the tail — and forget it as soon as the message settles, so a
   * long-lived app does not keep one content string per streamed message.
   * Losing the record only costs one full update.
   */
  private rememberStreamDispatched(key: string, entry: PendingStreamUpdate): void {
    if (entry.text === null) return;
    this.streamDispatched.delete(key);
    if (entry.metadata?.isFinal) return;
    this.streamDispatched.set(key, entry.text);
    while (this.streamDispatched.size > STREAM_DISPATCHED_MAX_KEYS) {
      const oldest = this.streamDispatched.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.streamDispatched.delete(oldest);
    }
  }

  /**
   * One flush per frame, with a trailing timer as the ceiling: a backgrounded
   * window throttles animation frames, and live tokens must still land.
   */
  private scheduleStreamFlush(): void {
    if (this.streamFlushHandle !== null || this.streamFlushFrame !== null) return;
    if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
      this.streamFlushFrame = window.requestAnimationFrame(() => {
        this.streamFlushFrame = null;
        this.flushStreamPending();
      });
    }
    this.streamFlushHandle = setTimeout(() => {
      this.streamFlushHandle = null;
      this.flushStreamPending();
    }, STREAM_FLUSH_MAX_DELAY_MS);
  }

  private cancelStreamFlush(): void {
    if (this.streamFlushFrame !== null && typeof window !== 'undefined') {
      window.cancelAnimationFrame?.(this.streamFlushFrame);
    }
    this.streamFlushFrame = null;
    if (this.streamFlushHandle !== null) clearTimeout(this.streamFlushHandle);
    this.streamFlushHandle = null;
  }

  /**
   * Whole-message loss detector for the live stream. Every store-written
   * message carries a per-session monotonic `sequence`; when the live tail
   * jumps by more than one, a `cowork:stream:message` event never reached this
   * renderer (the 2026-10-22 incident: a heartbeat turn's entire output —
   * 28 messages — never rendered until a manual session reload). The heal is a
   * debounced reload of the session view, guarded to the session actually on
   * screen; background sessions re-read on open anyway.
   */
  private noteStreamSequence(sessionId: string, message: CoworkMessage): void {
    const seq = typeof message.sequence === 'number' && Number.isFinite(message.sequence)
      ? message.sequence
      : null;
    if (seq === null || seq <= 0) return;
    const last = this.streamTailSeq.get(sessionId) ?? null;
    if (last === null || seq > last) {
      this.streamTailSeq.set(sessionId, seq);
    }
    if (this.streamTailSeq.size > STREAM_TAIL_SEQ_MAX_KEYS) {
      const oldest = this.streamTailSeq.keys().next().value;
      if (oldest !== undefined) this.streamTailSeq.delete(oldest);
    }
    if (last === null || seq <= last + 1) return;
    if (this.streamGapHealTimers.has(sessionId)) return;
    console.warn(`[cowork] stream gap on session ${sessionId}: tail ${last} → ${seq}; reloading the session view`);
    const timer = setTimeout(() => {
      this.streamGapHealTimers.delete(sessionId);
      void this.loadSession(sessionId, { onlyIfCurrent: true });
    }, STREAM_GAP_HEAL_DEBOUNCE_MS);
    this.streamGapHealTimers.set(sessionId, timer);
  }

  /**
   * Seed the live tail from a freshly loaded window (its newest message).
   * Overwrites rather than max-merges: a rewind/fork legitimately moves the
   * tail backward, and the load is the authoritative read.
   */
  private noteSessionSnapshotSeq(session: CoworkSession | null | undefined): void {
    if (!session) return;
    let tail = 0;
    for (const message of session.messages) {
      if (typeof message.sequence === 'number' && Number.isFinite(message.sequence) && message.sequence > tail) {
        tail = message.sequence;
      }
    }
    if (tail > 0) this.streamTailSeq.set(session.id, tail);
  }

  private async resyncStreamMessage(sessionId: string, messageId: string): Promise<void> {
    let content: string | null = null;
    try {
      const result = await window.electron?.cowork?.getStreamLiveContent?.({ sessionId, messageId });
      if (result?.success && typeof result.content === 'string') content = result.content;
    } catch {
      content = null;
    }
    const applied = this.streamReassembly.resolveResync(sessionId, messageId, content);
    if (applied.kind === 'full') {
      this.bufferStreamContent(applied.sessionId, applied.messageId, applied.text);
    }
  }

  /**
   * Refresh the session list.
   *
   * One read runs at a time: a request that arrives while a read is in flight
   * (or while a burst is already queued) joins that burst and resolves only once
   * a read that started after it has completed, so callers that reload and then
   * inspect the list still see their own change. An idle request reads at once —
   * the init path is never delayed.
   */
  async loadSessions(): Promise<void> {
    if (this.sessionsLoadInFlight || this.sessionsReloadTimer) {
      await this.queueSessionsReload();
      return;
    }
    await this.readSessions();
  }

  /** Splice the waiters a read covers: it resolves the burst queued before it
   * started, while requests made during the read wait for the next one. */
  private async readSessions(): Promise<void> {
    const waiters = this.sessionsReloadWaiters.splice(0);
    const read = (async () => {
      const result = await window.electron?.cowork?.listSessions();
      if (result?.success && result.sessions) {
        store.dispatch(setSessions(await metabotAvatarCache.attachAvatars(result.sessions)));
      }
    })();
    this.sessionsLoadInFlight = read;
    try {
      await read;
    } finally {
      if (this.sessionsLoadInFlight === read) {
        this.sessionsLoadInFlight = null;
      }
      waiters.forEach((resolve) => resolve());
    }
  }

  /** Queue this request into the trailing burst and wait for its read. The
   * read is best effort for the queued callers: a failed one resolves them
   * without an error, and the list simply stays as it was. */
  private queueSessionsReload(): Promise<void> {
    if (this.sessionsReloadTimer) {
      clearTimeout(this.sessionsReloadTimer);
    }
    const waiter = new Promise<void>((resolve) => {
      this.sessionsReloadWaiters.push(resolve);
    });
    this.sessionsReloadTimer = setTimeout(() => {
      this.sessionsReloadTimer = null;
      void this.flushSessionsReload().catch(() => undefined);
    }, SESSIONS_RELOAD_DEBOUNCE_MS);
    return waiter;
  }

  private async flushSessionsReload(): Promise<void> {
    while (this.sessionsLoadInFlight) {
      // The running read started before the newest request, so it cannot
      // satisfy it; wait it out and then read once for the whole burst.
      await this.sessionsLoadInFlight.catch(() => undefined);
    }
    if (this.sessionsReloadTimer) {
      // A newer request re-armed the window while waiting; its own flush runs.
      return;
    }
    await this.readSessions();
  }

  async loadConfig(): Promise<void> {
    const result = await window.electron?.cowork?.getConfig();
    if (result?.success && result.config) {
      store.dispatch(setConfig(result.config));
    }
  }

  async startSession(options: CoworkStartOptions): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return null;
    }

    store.dispatch(setStreaming(true));

    const result = await cowork.startSession(options);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      return result.session;
    }

    store.dispatch(setStreaming(false));
    console.error('Failed to start session:', result.error);
    return null;
  }

  /**
   * Fire-and-forget runtime-slot prewarm fired on user intent — the home
   * composer's bot/model pick (no session exists yet) or an existing session
   * being opened. The slot boot then overlaps the user's typing instead of
   * stacking inside the first turn (first-sentence latency, 2026-10-16).
   */
  prewarmTurnSlot(input: {
    sessionId?: string;
    metabotId?: number | null;
    model?: string | null;
    modelProvider?: string | null;
    cwd?: string | null;
  }): void {
    const cowork = window.electron?.cowork;
    if (!cowork?.prewarmTurnSlot) return;
    void cowork.prewarmTurnSlot(input).catch(() => undefined);
  }

  async continueSession(options: CoworkContinueOptions): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) {
      console.error('Cowork API not available');
      return false;
    }

    store.dispatch(setStreaming(true));
    store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'running' }));

    const result = await cowork.continueSession({
      sessionId: options.sessionId,
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      activeSkillIds: options.activeSkillIds,
    });
    if (!result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId: options.sessionId, status: 'error' }));
      console.error('Failed to continue session:', result.error);
      return false;
    }

    return true;
  }

  async submitInput(input: CoworkSubmitInput): Promise<CoworkSubmitInputResult> {
    const cowork = window.electron?.cowork;
    if (!cowork?.submitInput) {
      return {
        success: false,
        code: 'delivery_failed',
        error: 'Cowork submit API not available',
      };
    }

    try {
      return await cowork.submitInput(input);
    } catch (error) {
      return {
        success: false,
        code: 'delivery_failed',
        error: error instanceof Error ? error.message : 'Failed to submit Cowork input',
      };
    }
  }

  /**
   * Queues a manual compaction for the next local-mode turn (Phase 3). The
   * runner validates that the session is idle and has history; on success the
   * next submitted message continues from a compacted summary.
   */
  async requestManualCompaction(sessionId: string): Promise<{ success: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.requestManualCompaction) {
      console.error('requestManualCompaction API not available');
      return { success: false, error: 'Manual compaction API not available' };
    }
    const result = await cowork.requestManualCompaction(sessionId);
    if (!result) {
      return { success: false, error: 'Unknown error while requesting manual compaction' };
    }
    return result;
  }

  /**
   * /export command: renders the session transcript as Markdown and saves it
   * through a native save dialog. `cancelled` means the user dismissed the
   * dialog (not an error).
   */
  async exportSessionTranscript(sessionId: string): Promise<{ success: boolean; cancelled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportTranscript) {
      console.error('exportTranscript API not available');
      return { success: false, error: 'Transcript export API not available' };
    }
    return cowork.exportTranscript(sessionId);
  }

  async stopSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.stopSession(sessionId);
    if (result.success) {
      store.dispatch(setStreaming(false));
      store.dispatch(updateSessionStatus({ sessionId, status: 'idle' }));
      return true;
    }

    console.error('Failed to stop session:', result.error);
    return false;
  }

  async setPermissionMode(sessionId: string, mode: CoworkPermissionMode): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setPermissionMode) {
      console.error('setPermissionMode API not available');
      return false;
    }
    const result = await cowork.setPermissionMode(sessionId, mode);
    if (result.success) {
      store.dispatch(updateSessionPermissionMode({ sessionId, permissionMode: mode }));
      return true;
    }
    console.error('Failed to set permission mode:', result.error);
    return false;
  }

  /**
   * /goal command: set, update, or clear a session's goal (null clears).
   * Patches the active session in the store on success.
   */
  async setSessionGoal(
    sessionId: string,
    goal: { text: string; status: 'active' | 'paused' } | null,
  ): Promise<{ success: boolean; goal?: import('../types/cowork').CoworkSessionGoal | null; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionGoal) {
      console.error('setSessionGoal API not available');
      return { success: false, error: 'setSessionGoal API not available' };
    }
    const result = await cowork.setSessionGoal(sessionId, goal);
    if (result.success) {
      store.dispatch(updateSessionGoal({ sessionId, goal: result.goal ?? null }));
    } else {
      console.error('Failed to set session goal:', result.error);
    }
    return result;
  }

  /**
   * Stops a running subagent/background task via the live SDK Query control.
   * Returns true when the stop request was accepted (the SDK emits a
   * task_notification with status 'stopped' afterwards).
   */
  async stopTask(sessionId: string, taskId: string): Promise<{ success: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.stopTask) {
      return { success: false, error: 'stopTask API not available' };
    }
    try {
      return await cowork.stopTask(sessionId, taskId);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Backgrounds a running foreground task via the live SDK Query control.
   * Pass toolUseId to target one task; omit it to background all foreground
   * tasks. Returns true when the request was accepted.
   */
  async backgroundTask(sessionId: string, toolUseId?: string): Promise<{ success: boolean; backgrounded?: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.backgroundTask) {
      return { success: false, error: 'backgroundTask API not available' };
    }
    try {
      return await cowork.backgroundTask(sessionId, toolUseId);
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async setEffort(sessionId: string, effort: string | null): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setEffort) {
      console.error('setEffort API not available');
      return false;
    }
    const result = await cowork.setEffort(sessionId, effort);
    if (!result.success) {
      console.error('Failed to set effort level:', result.error);
      return false;
    }
    return true;
  }

  /**
   * Forks the session from a message into a new session. On success, loads the
   * forked session as the current one.
   */
  async forkSession(sessionId: string, messageId: string, title?: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.forkSession) {
      console.error('forkSession API not available');
      return null;
    }
    const result = await cowork.forkSession(sessionId, messageId, title);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      store.dispatch(setCurrentSession(result.session));
      return result.session;
    }
    console.error('Failed to fork session:', result.error);
    return null;
  }

  /**
   * Rewinds the session to a message (deletes everything after it). On success,
   * reloads the truncated session as the current one.
   */
  async rewindSession(sessionId: string, messageId: string): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.rewindSession) {
      console.error('rewindSession API not available');
      return null;
    }
    const result = await cowork.rewindSession(sessionId, messageId);
    if (result.success && result.session) {
      store.dispatch(addSession(result.session));
      store.dispatch(setCurrentSession(result.session));
      return result.session;
    }
    console.error('Failed to rewind session:', result.error);
    return null;
  }

  /** Lists subagent transcript ids for a session (post-hoc, from disk). */
  async getSubagents(sessionId: string): Promise<string[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubagents) return [];
    const result = await cowork.getSubagents(sessionId);
    return result.success ? result.agents ?? [] : [];
  }

  /** Reads and flattens a subagent's transcript into CoworkMessages. */
  async getSubagentMessages(sessionId: string, agentId: string, limit?: number): Promise<CoworkMessage[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSubagentMessages) return [];
    const result = await cowork.getSubagentMessages(sessionId, agentId, limit);
    return result.success ? result.messages ?? [] : [];
  }

  async getAutoApproveTools(sessionId: string): Promise<string[]> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getAutoApproveTools) return [];
    const result = await cowork.getAutoApproveTools(sessionId);
    return result.success ? result.tools ?? [] : [];
  }

  async addAutoApproveTool(sessionId: string, toolName: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.addAutoApproveTool) return false;
    const result = await cowork.addAutoApproveTool(sessionId, toolName);
    return result.success;
  }

  async removeAutoApproveTool(sessionId: string, toolName: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.removeAutoApproveTool) return false;
    const result = await cowork.removeAutoApproveTool(sessionId, toolName);
    return result.success;
  }

  async endA2APrivateChat(sessionId: string): Promise<{ success: boolean; noticeSent?: boolean; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.endA2APrivateChat) {
      return { success: false, error: 'A2A private chat end API not available' };
    }

    const result = await cowork.endA2APrivateChat(sessionId);
    if (result.success) {
      store.dispatch(updateSessionStatus({ sessionId, status: 'completed' }));
      await this.loadSession(sessionId);
      return {
        success: true,
        noticeSent: result.noticeSent,
      };
    }

    console.error('Failed to end A2A private chat:', result.error);
    return { success: false, error: result.error || 'Failed to end A2A private chat' };
  }

  /**
   * Dismiss the A2A error banner: the main process heals a stale 'error'
   * status to 'completed' (guarded, A2A-only). Local session state follows the
   * backend-reported status so the banner hides immediately.
   */
  async clearSessionError(sessionId: string): Promise<{ success: boolean; status?: CoworkSessionStatus; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.clearSessionError) {
      return { success: false, error: 'Clear session error API not available' };
    }

    const result = await cowork.clearSessionError(sessionId);
    if (!result.success) {
      console.error('Failed to clear session error:', result.error);
      return { success: false, error: result.error || 'Failed to clear session error' };
    }

    const status = result.status ?? 'completed';
    store.dispatch(updateSessionStatus({ sessionId, status }));
    store.dispatch(updateBrowserSessionStatus({ sessionId, status }));
    if (store.getState().cowork.currentSessionId === sessionId) {
      try {
        const refreshed = await window.electron?.cowork?.getSession(sessionId);
        if (refreshed?.success && refreshed.session) {
          store.dispatch(setCurrentSession(refreshed.session));
        }
      } catch { /* ignore */ }
    }
    return { success: true, status };
  }

  async queueA2AGuidance(input: CoworkA2AGuidanceRequest): Promise<CoworkA2AGuidanceResult> {
    const request = {
      sessionId: String(input.sessionId || '').trim(),
      guidance: String(input.guidance || '').trim(),
    };
    const cowork = window.electron?.cowork;
    if (!cowork?.queueA2AGuidance) {
      return { success: false, error: 'A2A guidance API not available' };
    }
    if (!request.sessionId || !request.guidance) {
      return { success: false, error: i18nService.t('a2aGuidanceEmpty') };
    }

    try {
      const result = await cowork.queueA2AGuidance(request);
      if (result?.success) {
        if (result.mode === 'restart_started') {
          if (store.getState().cowork.currentSessionId === request.sessionId) {
            await this.loadSession(request.sessionId, { onlyIfCurrent: true });
          }
          await this.loadSessions();
        }
        return {
          success: true,
          mode: result.mode,
          messageId: result.messageId ?? null,
        };
      }
      return { success: false, error: result?.error || i18nService.t('a2aGuidanceFailed') };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('a2aGuidanceFailed'),
      };
    }
  }

  /**
   * Owner speaks as themselves in an A2A private chat (peer = the configured
   * local user). The main process signs the simplemsg with the user-identity
   * wallet and records it as an incoming peer message; the appended message
   * reaches this renderer through the usual cowork:stream:message event, so
   * no manual session reload is needed here.
   */
  async sendOwnerA2AMessage(input: CoworkA2AOwnerMessageRequest): Promise<CoworkA2AOwnerMessageResult> {
    const request = {
      sessionId: String(input.sessionId || '').trim(),
      content: String(input.content || '').trim(),
    };
    const cowork = window.electron?.cowork;
    if (!cowork?.sendOwnerA2AMessage) {
      return { success: false, error: 'Owner A2A message API not available' };
    }
    if (!request.sessionId || !request.content) {
      return { success: false, error: i18nService.t('a2aOwnerChatFailed') };
    }

    try {
      const result = await cowork.sendOwnerA2AMessage(request);
      if (result?.success) {
        return { success: true, messageId: result.messageId ?? null };
      }
      return { success: false, error: result?.error || i18nService.t('a2aOwnerChatFailed') };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : i18nService.t('a2aOwnerChatFailed'),
      };
    }
  }

  async resendA2ADeliveryArtifact(input: string | { sessionId: string; orderTxid?: string | null }): Promise<{ success: boolean; deliveryPinId?: string | null; error?: string }> {
    const request = typeof input === 'string' ? { sessionId: input } : input;
    const cowork = window.electron?.cowork;
    if (!cowork?.resendA2ADeliveryArtifact) {
      return { success: false, error: 'A2A delivery resend API not available' };
    }

    try {
      const result = await cowork.resendA2ADeliveryArtifact(request);
      if (result?.success) {
        await this.loadSession(request.sessionId);
        await this.loadSessions();
        return {
          success: true,
          deliveryPinId: result.deliveryPinId ?? null,
        };
      }
      return { success: false, error: result?.error || 'Failed to resend digital delivery' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to resend digital delivery',
      };
    }
  }

  /**
   * Archive a session: it leaves the UI list but every record is preserved
   * (dream consolidation and experience retrieval still see it). Hard delete
   * is intentionally not exposed to users — experience data is valuable.
   */
  async archiveSession(sessionId: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.archiveSession(sessionId);
    if (result.success) {
      store.dispatch(deleteSessionAction(sessionId));
      return true;
    }

    console.error('Failed to archive session:', result.error);
    return false;
  }

  async setSessionPinned(sessionId: string, pinned: boolean): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionPinned) return false;

    const result = await cowork.setSessionPinned({ sessionId, pinned });
    if (result.success) {
      store.dispatch(updateSessionPinned({ sessionId, pinned }));
      return true;
    }

    console.error('Failed to update session pin:', result.error);
    return false;
  }

  /**
   * Move a session in or out of the sidebar's "Autonomous Tasks" fold. null
   * clears the manual placement so the auto-origin policy decides again.
   */
  async setSessionFoldOverride(
    sessionId: string,
    override: CoworkSessionFoldOverride | null,
  ): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionFoldOverride) return false;

    const result = await cowork.setSessionFoldOverride({ sessionId, override });
    if (result.success) {
      store.dispatch(updateSessionFoldOverride({ sessionId, override }));
      return true;
    }

    console.error('Failed to update session fold placement:', result.error);
    return false;
  }

  /**
   * Move a session in or out of the sidebar's "Follow-Up Tasks" section.
   * followUp=true persists a 'pending' marker with source 'manual';
   * followUp=false clears ANY pending source main-side, so the row falls back
   * to the auto-origin fold. Mirrors setSessionFoldOverride: on success the
   * local patch lands immediately (optimistic) and the regular list refresh
   * reconciles it with main's stamped timestamp.
   */
  async setSessionFollowUp(sessionId: string, followUp: boolean): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setSessionFollowUp) return false;

    const result = await cowork.setSessionFollowUp({ sessionId, followUp });
    if (result.success) {
      store.dispatch(updateSessionFollowUp({
        sessionId,
        followUp,
        followUpAt: followUp ? new Date().toISOString() : null,
      }));
      return true;
    }

    console.error('Failed to update session follow-up:', result.error);
    return false;
  }

  async renameSession(sessionId: string, title: string): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.renameSession) return false;

    const normalizedTitle = title.trim();
    if (!normalizedTitle) return false;

    const result = await cowork.renameSession({ sessionId, title: normalizedTitle });
    if (result.success) {
      store.dispatch(updateSessionTitle({ sessionId, title: normalizedTitle }));
      return true;
    }

    console.error('Failed to rename session:', result.error);
    return false;
  }

  async processServiceRefund(sessionId: string): Promise<{
    success: boolean;
    refundTxid?: string;
    refundFinalizePinId?: string;
    error?: string;
  }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.processServiceRefund) {
      return { success: false, error: 'Cowork refund API not available' };
    }

    try {
      const result = await cowork.processServiceRefund(sessionId);
      if (result?.success) {
        if (result.session) {
          store.dispatch(setCurrentSession(result.session));
        } else {
          await this.loadSession(sessionId);
        }
        await this.loadSessions();
        return {
          success: true,
          refundTxid: result.refundTxid,
          refundFinalizePinId: result.refundFinalizePinId,
        };
      }
      return { success: false, error: result?.error || 'Failed to process service refund' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process service refund',
      };
    }
  }

  async exportSessionResultImage(options: {
    rect: { x: number; y: number; width: number; height: number };
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.exportResultImage) {
      return { success: false, error: 'Cowork export API not available' };
    }

    try {
      const result = await cowork.exportResultImage(options);
      return result ?? { success: false, error: 'Failed to export session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to export session image',
      };
    }
  }

  async captureSessionImageChunk(options: {
    rect: { x: number; y: number; width: number; height: number };
  }): Promise<{ success: boolean; width?: number; height?: number; pngBase64?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.captureImageChunk) {
      return { success: false, error: 'Cowork capture API not available' };
    }

    try {
      const result = await cowork.captureImageChunk(options);
      return result ?? { success: false, error: 'Failed to capture session image chunk' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to capture session image chunk',
      };
    }
  }

  async saveSessionResultImage(options: {
    pngBase64: string;
    defaultFileName?: string;
  }): Promise<{ success: boolean; canceled?: boolean; path?: string; error?: string }> {
    const cowork = window.electron?.cowork;
    if (!cowork?.saveResultImage) {
      return { success: false, error: 'Cowork save image API not available' };
    }

    try {
      const result = await cowork.saveResultImage(options);
      return result ?? { success: false, error: 'Failed to save session image' };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to save session image',
      };
    }
  }

  async loadSession(sessionId: string, options: { onlyIfCurrent?: boolean } = {}): Promise<CoworkSession | null> {
    const cowork = window.electron?.cowork;
    if (!cowork) return null;

    // Check before the IPC: an onlyIfCurrent caller (the stream-gap heal) has
    // no use for the payload of a session that is not on screen.
    if (options.onlyIfCurrent && store.getState().cowork.currentSessionId !== sessionId) {
      return null;
    }

    const result = await cowork.getSession(sessionId);
    if (result.success && result.session) {
      if (options.onlyIfCurrent && store.getState().cowork.currentSessionId !== sessionId) {
        return result.session;
      }
      store.dispatch(setCurrentSession(result.session));
      store.dispatch(setStreaming(result.session.status === 'running'));
      this.noteSessionSnapshotSeq(result.session);
      return result.session;
    }

    console.error('Failed to load session:', result.error);
    return null;
  }

  async loadEarlierMessages(sessionId: string): Promise<number> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getSessionMessagesPage) return 0;
    const currentSession = store.getState().cowork.currentSession;
    const history = currentSession?.id === sessionId ? currentSession.messageHistory : null;
    if (!history?.hasMoreBefore) return 0;

    // A2A thread aggregation: once the session's own window is exhausted
    // (no in-session cursor left), "load earlier" pages through the previous
    // episodes of the conversation thread instead of stopping.
    const crossEpisode = currentSession?.sessionType === 'a2a'
      && (history.beforeEpisodeIndex != null || history.beforeSequence == null);
    if (crossEpisode && cowork.getA2AConversationHistoryPage) {
      const beforeCursor = history.beforeEpisodeIndex != null
        ? { episodeIndex: history.beforeEpisodeIndex, beforeSequence: history.beforeSequence ?? 0 }
        : { episodeIndex: null, beforeSequence: null };
      const page = await cowork.getA2AConversationHistoryPage({
        sessionId,
        beforeCursor,
        limit: history.pageSize,
      });
      if (!page.success || !page.page) {
        console.error('Failed to load earlier A2A episode messages:', page.error);
        return 0;
      }
      if (store.getState().cowork.currentSessionId !== sessionId) return 0;
      store.dispatch(prependMessages({
        sessionId,
        messages: page.page.messages.map((entry) => ({
          ...entry.message,
          metadata: {
            ...(entry.message.metadata ?? {}),
            a2aEpisodeIndex: entry.episodeIndex,
          },
        })),
        messageHistory: {
          hasMoreBefore: page.page.hasMoreBefore,
          beforeSequence: page.page.beforeCursor?.beforeSequence ?? null,
          beforeEpisodeIndex: page.page.beforeCursor?.episodeIndex ?? null,
          pageSize: history.pageSize,
        },
      }));
      return page.page.messages.length;
    }

    // Non-A2A sessions page in transcript order, addressed by the opaque
    // cursor the window handed over; A2A keeps its sequence cursor.
    const beforeTranscriptCursor = history.beforeTranscriptCursor ?? null;
    if (history.beforeSequence == null && beforeTranscriptCursor == null) return 0;
    const result = await cowork.getSessionMessagesPage({
      sessionId,
      beforeSequence: history.beforeSequence,
      beforeTranscriptCursor,
      limit: history.pageSize,
    });
    if (!result.success || !result.page) {
      console.error('Failed to load earlier session messages:', result.error);
      return 0;
    }
    if (store.getState().cowork.currentSessionId !== sessionId) return 0;
    // The in-session window just ended. For A2A threads with previous
    // episodes, chain one cross-episode page below the current episode so
    // the "load earlier" affordance keeps working instead of dead-ending at
    // the session boundary (the thread's earlier generations are older than
    // this session's page, so they prepend before it).
    if (!result.page.hasMoreBefore && currentSession?.sessionType === 'a2a' && cowork.getA2AConversationHistoryPage) {
      const below = await cowork.getA2AConversationHistoryPage({
        sessionId,
        beforeCursor: { episodeIndex: null, beforeSequence: null },
        limit: history.pageSize,
      });
      if (below.success && below.page && below.page.messages.length > 0) {
        store.dispatch(prependMessages({
          sessionId,
          messages: [
            ...below.page.messages.map((entry) => ({
              ...entry.message,
              metadata: {
                ...(entry.message.metadata ?? {}),
                a2aEpisodeIndex: entry.episodeIndex,
              },
            })),
            ...result.page.messages,
          ],
          messageHistory: {
            hasMoreBefore: below.page.hasMoreBefore,
            beforeSequence: below.page.beforeCursor?.beforeSequence ?? null,
            beforeEpisodeIndex: below.page.beforeCursor?.episodeIndex ?? null,
            pageSize: history.pageSize,
          },
        }));
        return result.page.messages.length + below.page.messages.length;
      }
    }
    store.dispatch(prependMessages({
      sessionId,
      messages: result.page.messages,
      messageHistory: {
        hasMoreBefore: result.page.hasMoreBefore,
        beforeSequence: result.page.beforeSequence,
        beforeTranscriptCursor: result.page.beforeTranscriptCursor ?? null,
        pageSize: history.pageSize,
      },
    }));
    return result.page.messages.length;
  }

  async setMessageFeedback(input: { messageId: string; rating: MessageFeedbackRating | null; comment?: string | null }): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork?.setMessageFeedback) return false;

    const result = await cowork.setMessageFeedback(input);
    if (!result.success) {
      console.error('Failed to set message feedback:', result.error);
      return false;
    }
    if (result.feedback) {
      store.dispatch(setMessageFeedbackAction({
        messageId: result.feedback.messageId,
        rating: result.feedback.rating,
        comment: result.feedback.comment ?? undefined,
      }));
    } else {
      store.dispatch(clearMessageFeedbackAction(input.messageId));
    }
    return true;
  }

  async loadSessionFeedback(sessionId: string): Promise<void> {
    const cowork = window.electron?.cowork;
    if (!cowork?.listSessionFeedback) return;

    const result = await cowork.listSessionFeedback({ sessionId });
    if (!result.success || !result.feedback) {
      console.error('Failed to load session feedback:', result.error);
      return;
    }
    store.dispatch(loadSessionFeedbackAction(result.feedback.map((record) => ({
      messageId: record.messageId,
      rating: record.rating,
      comment: record.comment ?? undefined,
    }))));
    // Review Minor 5: the nudge may now safely consult the hydrated rows.
    store.dispatch(markSessionFeedbackLoaded(sessionId));
  }

  async getA2AConversationHistoryPage(input: {
    sessionId: string;
    beforeCursor?: CoworkA2AHistoryCursor | null;
    limit?: number;
  }): Promise<CoworkA2AHistoryPage | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getA2AConversationHistoryPage) return null;
    const result = await cowork.getA2AConversationHistoryPage(input);
    if (!result.success || !result.page) {
      console.error('Failed to load A2A conversation history:', result.error);
      return null;
    }
    return result.page;
  }

  async getA2AEpisodes(sessionId: string): Promise<Array<{ episodeIndex: number; endedAt: number | null; closeReason: string | null; summary: string | null }> | null> {
    const cowork = window.electron?.cowork;
    if (!cowork?.getA2AEpisodes) return null;
    const result = await cowork.getA2AEpisodes(sessionId);
    if (!result.success || !result.episodes) {
      console.error('Failed to load A2A conversation episodes:', result.error);
      return null;
    }
    return result.episodes;
  }

  async respondToPermission(requestId: string, result: CoworkPermissionResult): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const response = await cowork.respondToPermission({ requestId, result });
    if (response.success) {
      store.dispatch(dequeuePendingPermission({ requestId }));
      return true;
    }

    console.error('Failed to respond to permission:', response.error);
    return false;
  }

  async updateConfig(config: CoworkConfigUpdate): Promise<boolean> {
    const cowork = window.electron?.cowork;
    if (!cowork) return false;

    const result = await cowork.setConfig(config);
    if (result.success) {
      const currentConfig = store.getState().cowork.config;
      store.dispatch(setConfig({ ...currentConfig, ...config }));
      return true;
    }

    console.error('Failed to update config:', result.error);
    return false;
  }

  async getApiConfig(): Promise<CoworkApiConfig | null> {
    if (!window.electron?.getApiConfig) {
      return null;
    }
    return window.electron.getApiConfig();
  }

  async checkApiConfig(): Promise<{ hasConfig: boolean; config: CoworkApiConfig | null; error?: string } | null> {
    if (!window.electron?.checkApiConfig) {
      return null;
    }
    return window.electron.checkApiConfig();
  }

  async saveApiConfig(config: CoworkApiConfig): Promise<{ success: boolean; error?: string } | null> {
    if (!window.electron?.saveApiConfig) {
      return null;
    }
    return window.electron.saveApiConfig(config);
  }

  async getSandboxStatus(): Promise<CoworkSandboxStatus | null> {
    if (!window.electron?.cowork?.getSandboxStatus) {
      return null;
    }
    return window.electron.cowork.getSandboxStatus();
  }

  async installSandbox(): Promise<{ success: boolean; status: CoworkSandboxStatus; error?: string } | null> {
    if (!window.electron?.cowork?.installSandbox) {
      return null;
    }
    return window.electron.cowork.installSandbox();
  }

  async listMemoryEntries(input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'self_identity' | 'work_review' | 'value_boundary';
    query?: string;
    status?: 'created' | 'stale' | 'deleted' | 'all';
    includeDeleted?: boolean;
    includeArchived?: boolean;
    limit?: number;
    offset?: number;
  }): Promise<CoworkUserMemoryEntry[]> {
    const api = window.electron?.cowork?.listMemoryEntries;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !result.entries) return [];
    return result.entries;
  }

  async createMemoryEntry(input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
    visibility?: 'local_only' | 'external_safe';
    text: string;
    confidence?: number;
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.createMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async updateMemoryEntry(input: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
    usageClass?: 'profile_fact' | 'preference' | 'operational_preference' | 'work_review' | 'value_boundary';
    visibility?: 'local_only' | 'external_safe';
    id: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    isExplicit?: boolean;
  }): Promise<CoworkUserMemoryEntry | null> {
    const api = window.electron?.cowork?.updateMemoryEntry;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  async deleteMemoryEntry(input: { sessionId?: string; metabotId?: number; id: string }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryEntry;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  async getMemoryStats(input?: {
    sessionId?: string;
    metabotId?: number;
    scopeKind?: 'owner' | 'contact' | 'conversation';
    scopeKey?: string;
  }): Promise<CoworkMemoryStats | null> {
    const api = window.electron?.cowork?.getMemoryStats;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.stats) return null;
    return result.stats;
  }

  async listMemoryScopes(input: { metabotId?: number }): Promise<CoworkMemoryScopesOverview | null> {
    const api = window.electron?.cowork?.listMemoryScopes;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.overview) return null;
    return result.overview;
  }

  async getSessionMemoryScope(input: { sessionId?: string }): Promise<CoworkSessionMemoryScope | null> {
    const api = window.electron?.cowork?.getSessionMemoryScope;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.sessionScope) return null;
    return result.sessionScope;
  }

  async getMemoryPolicy(input?: { sessionId?: string; metabotId?: number }): Promise<CoworkMemoryPolicy | null> {
    const api = window.electron?.cowork?.getMemoryPolicy;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.policy) return null;
    return result.policy;
  }

  async setMemoryPolicy(input: {
    metabotId: number;
    memoryEnabled?: boolean;
    memoryImplicitUpdateEnabled?: boolean;
    memoryLlmJudgeEnabled?: boolean;
    memoryGuardLevel?: 'strict' | 'standard' | 'relaxed';
    memoryUserMemoriesMaxItems?: number;
    dreamEnabled?: boolean;
    hygieneEnabled?: boolean;
    practiceTasksEnabled?: boolean;
    practiceAutoApproveReadOnly?: boolean;
  }): Promise<CoworkMemoryPolicy | null> {
    const api = window.electron?.cowork?.setMemoryPolicy;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.policy) return null;
    return result.policy;
  }

  async getMemoryHygiene(): Promise<{ config: MemoryHygieneConfig | null; lastRun: MemoryHygieneRunStats | null }> {
    const api = window.electron?.cowork?.getMemoryHygiene;
    if (!api) return { config: null, lastRun: null };
    const result = await api();
    return { config: result?.config ?? null, lastRun: result?.lastRun ?? null };
  }

  async setMemoryHygieneConfig(input: Partial<MemoryHygieneConfig>): Promise<MemoryHygieneConfig | null> {
    const api = window.electron?.cowork?.setMemoryHygieneConfig;
    if (!api) return null;
    const result = await api(input);
    return result?.config ?? null;
  }

  async runMemoryHygieneNow(): Promise<{ stats: MemoryHygieneRunStats | null; error: string | null }> {
    const api = window.electron?.cowork?.runMemoryHygieneNow;
    if (!api) return { stats: null, error: 'Memory hygiene API unavailable' };
    const result = await api();
    return { stats: result?.stats ?? null, error: result?.error ?? null };
  }

  async listTeamCulture(input?: {
    kind?: TeamCultureKind | 'all';
    status?: TeamCultureStatus | 'all';
    query?: string;
  }): Promise<{ entries: TeamCultureEntry[]; activeCounts: TeamCultureActiveCounts | null }> {
    const api = window.electron?.cowork?.listTeamCulture;
    if (!api) return { entries: [], activeCounts: null };
    const result = await api(input);
    return { entries: result?.entries ?? [], activeCounts: result?.activeCounts ?? null };
  }

  async upsertTeamCulture(input: {
    kind?: TeamCultureKind;
    topic: string;
    text: string;
  }): Promise<{ entry: TeamCultureEntry | null; displacedTopic: string | null; capacitySkipped: boolean; error: string | null }> {
    const api = window.electron?.cowork?.upsertTeamCulture;
    if (!api) return { entry: null, displacedTopic: null, capacitySkipped: false, error: 'Team culture API unavailable' };
    const result = await api(input);
    return {
      entry: result?.entry ?? null,
      displacedTopic: result?.displacedTopic ?? null,
      capacitySkipped: Boolean(result?.capacitySkipped),
      error: result?.error ?? null,
    };
  }

  async updateTeamCulture(input: {
    id: string;
    kind?: TeamCultureKind;
    topic?: string;
    text?: string;
  }): Promise<{ entry: TeamCultureEntry | null; error: string | null }> {
    const api = window.electron?.cowork?.updateTeamCulture;
    if (!api) return { entry: null, error: 'Team culture API unavailable' };
    const result = await api(input);
    return { entry: result?.entry ?? null, error: result?.error ?? null };
  }

  async archiveTeamCulture(id: string): Promise<boolean> {
    const api = window.electron?.cowork?.archiveTeamCulture;
    if (!api) return false;
    const result = await api({ id });
    return Boolean(result?.success);
  }

  async listStandingPages(metabotId: number): Promise<Array<{
    id: string; pageKey: string; spec: string; name: string; question: string;
    sections: Array<{ key: string; title: string; body: string }>;
    content: string; builtAt: number | null; status: 'active' | 'archived';
    isDefault: boolean; lastRefreshError: string | null; updatedAt: number; stale?: boolean | null;
  }>> {
    const api = window.electron?.cowork?.listStandingPages;
    if (!api) return [];
    const result = await api({ metabotId });
    return result?.success ? (result.pages ?? []) : [];
  }

  async createStandingPage(metabotId: number, name: string, question: string): Promise<string | null> {
    const api = window.electron?.cowork?.createStandingPage;
    if (!api) return 'unavailable';
    const result = await api({ metabotId, name, question });
    return result?.success ? null : (result?.error ?? 'failed');
  }

  async removeStandingPage(metabotId: number, key: string): Promise<boolean> {
    const api = window.electron?.cowork?.removeStandingPage;
    if (!api) return false;
    const result = await api({ metabotId, key });
    return Boolean(result?.success);
  }

  async restoreStandingPage(metabotId: number, key: string): Promise<boolean> {
    const api = window.electron?.cowork?.restoreStandingPage;
    if (!api) return false;
    const result = await api({ metabotId, key });
    return Boolean(result?.success);
  }

  async restoreTeamCulture(id: string): Promise<boolean> {
    const api = window.electron?.cowork?.restoreTeamCulture;
    if (!api) return false;
    const result = await api({ id });
    return Boolean(result?.success);
  }

  async deleteTeamCulture(id: string): Promise<boolean> {
    const api = window.electron?.cowork?.deleteTeamCulture;
    if (!api) return false;
    const result = await api({ id });
    return Boolean(result?.success);
  }

  async unarchiveMemoryEntry(id: string): Promise<boolean> {
    const api = window.electron?.cowork?.unarchiveMemoryEntry;
    if (!api) return false;
    const result = await api({ id });
    return Boolean(result?.success);
  }

  async listTaskCommTrend(): Promise<TaskCommTrendRow[]> {
    const api = window.electron?.cowork?.listTaskCommTrend;
    if (!api) return [];
    const result = await api();
    return result?.tasks ?? [];
  }

  async listTeamCultureDistillationLog(): Promise<TeamCultureDistillationRecord[]> {
    const api = window.electron?.cowork?.listTeamCultureDistillationLog;
    if (!api) return [];
    const result = await api();
    return Array.isArray(result?.records) ? result.records : [];
  }

  async getTeamCultureConfig(): Promise<{ enabled: boolean }> {
    const api = window.electron?.cowork?.getTeamCultureConfig;
    if (!api) return { enabled: true };
    const result = await api();
    return result?.config ?? { enabled: true };
  }

  async setTeamCultureConfig(enabled: boolean): Promise<{ enabled: boolean }> {
    const api = window.electron?.cowork?.setTeamCultureConfig;
    if (!api) return { enabled: true };
    const result = await api({ enabled });
    return result?.config ?? { enabled: true };
  }

  async approveTeamCulture(id: string): Promise<boolean> {
    const api = window.electron?.cowork?.approveTeamCulture;
    if (!api) return false;
    const result = await api({ id });
    return Boolean(result?.success);
  }

  async listMetaIDContacts(input: { observerGlobalMetaId: string }): Promise<CoworkMetaIDContactSummary[]> {
    const api = window.electron?.p2p?.listContacts;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !Array.isArray(result.contacts)) return [];
    return result.contacts;
  }

  async getMetaIDContactDetail(input: {
    observerGlobalMetaId: string;
    subjectGlobalMetaId: string;
  }): Promise<CoworkMetaIDContactDetail | null> {
    const api = window.electron?.p2p?.getContactDetail;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.detail) return null;
    return result.detail;
  }

  /** List knowledge-point anchored memories for a MetaBot (Settings → Memory → Knowledge). */
  async listKnowledge(input: {
    metabotId: number;
    kind?: CoworkKnowledgeKind;
    status?: CoworkKnowledgeStatus | 'all';
    query?: string;
    limit?: number;
    offset?: number;
  }): Promise<CoworkKnowledgeEntry[]> {
    const api = window.electron?.cowork?.listKnowledge;
    if (!api) return [];
    const result = await api(input);
    if (!result?.success || !Array.isArray(result.entries)) return [];
    return result.entries;
  }

  /** Archive a knowledge point (soft-delete: hidden from active recall). */
  async archiveKnowledge(input: { id: string; metabotId: number }): Promise<boolean> {
    const api = window.electron?.cowork?.archiveKnowledge;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success);
  }

  /** Edit a knowledge point in place (prior text is kept as a revision). */
  async updateKnowledge(input: {
    id: string;
    metabotId: number;
    topic?: string;
    summary?: string;
    kind?: CoworkKnowledgeKind;
  }): Promise<CoworkKnowledgeEntry | null> {
    const api = window.electron?.cowork?.updateKnowledge;
    if (!api) return null;
    const result = await api(input);
    if (!result?.success || !result.entry) return null;
    return result.entry;
  }

  /** Hard-delete a knowledge point and its sources/revisions. */
  async deleteKnowledge(input: { id: string; metabotId: number }): Promise<boolean> {
    const api = window.electron?.cowork?.deleteKnowledge;
    if (!api) return false;
    const result = await api(input);
    return Boolean(result?.success && result.deleted);
  }

  /** Drop a per-MetaBot memory policy override so it follows the global default. */
  async deleteMemoryPolicy(metabotId: number): Promise<boolean> {
    const api = window.electron?.cowork?.deleteMemoryPolicy;
    if (!api) return false;
    const result = await api({ metabotId });
    return Boolean(result?.success);
  }

  onSandboxDownloadProgress(callback: (progress: CoworkSandboxProgress) => void): () => void {
    if (!window.electron?.cowork?.onSandboxDownloadProgress) {
      return () => {};
    }
    return window.electron.cowork.onSandboxDownloadProgress(callback);
  }

  async generateSessionTitle(prompt: string | null): Promise<string | null> {
    if (!window.electron?.generateSessionTitle) {
      return null;
    }
    return window.electron.generateSessionTitle(prompt);
  }

  async getRecentCwds(limit?: number): Promise<string[]> {
    if (!window.electron?.getRecentCwds) {
      return [];
    }
    return window.electron.getRecentCwds(limit);
  }

  clearSession(): void {
    store.dispatch(clearCurrentSession());
  }

  destroy(): void {
    this.cleanupListeners();
    this.initialized = false;
  }
}

export const coworkService = new CoworkService();
