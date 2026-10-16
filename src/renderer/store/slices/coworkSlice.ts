import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkMessage,
  CoworkMessageHistoryState,
  CoworkMessageMetadata,
  CoworkConfig,
  CoworkPermissionRequest,
  CoworkPermissionMode,
  CoworkQuotedSelection,
  CoworkSessionFoldOverride,
  CoworkSessionGoal,
  CoworkSessionStatus,
  MessageFeedback,
  MessageFeedbackRating,
  SubagentTaskState,
  SubagentTaskStatus,
} from '../../types/cowork';

/**
 * Composer draft of one session. `quotedSelections` is optional and stays
 * absent unless the draft actually carries quoted excerpts, so drafts that
 * never quoted a passage keep their previous shape.
 */
export interface CoworkSessionDraft {
  value: string;
  attachments: Array<{ path: string; name: string }>;
  /** Quoted transcript excerpts attached to the next message. */
  quotedSelections?: CoworkQuotedSelection[];
}

interface CoworkState {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  currentSession: CoworkSession | null;
  /** When set (e.g. after restore from mnemonic), CoworkView should select this MetaBot and clear it. */
  preferredMetabotId: number | null;
  /** MetaBot selected on the New Task home page; persisted globally so the single-instance page keeps its state across navigation. */
  newTaskMetabotId: number | null;
  draftPrompt: string;
  /**
   * Composer drafts keyed by session id (the steer input of each session
   * detail view). Kept in the store so switching sessions restores the text
   * the user typed in every session's input instead of wiping it.
   */
  sessionDrafts: Record<string, CoworkSessionDraft>;
  unreadSessionIds: string[];
  /**
   * Session currently open in the Bot Browser co-work panel (mirror of
   * browserCowork.currentSession.id). The unread bookkeeping treats it like
   * currentSessionId: opening the session there clears its notification dot,
   * and live messages while it stays open never re-mark it unread — the same
   * semantics the home view already gives standard cowork sessions.
   */
  browserOpenSessionId: string | null;
  isCoworkActive: boolean;
  isStreaming: boolean;
  pendingPermissions: CoworkPermissionRequest[];
  config: CoworkConfig;
  /** Live subagent/background-task state keyed by task_id (drives SubagentPanel). */
  subagentTasks: Record<string, SubagentTaskState>;
  /** Whether the subagent panel is open. */
  isSubagentPanelOpen: boolean;
  /** Per-message human feedback (thumbs up/down) keyed by message id. */
  feedbackByMessageId: Record<string, MessageFeedback>;
}

const initialState: CoworkState = {
  sessions: [],
  currentSessionId: null,
  currentSession: null,
  preferredMetabotId: null,
  newTaskMetabotId: null,
  draftPrompt: '',
  sessionDrafts: {},
  unreadSessionIds: [],
  browserOpenSessionId: null,
  isCoworkActive: false,
  isStreaming: false,
  pendingPermissions: [],
  subagentTasks: {},
  isSubagentPanelOpen: false,
  feedbackByMessageId: {},
  config: {
    workingDirectory: '',
    systemPrompt: '',
    executionMode: 'local',
    memoryEnabled: true,
    memoryImplicitUpdateEnabled: true,
    memoryLlmJudgeEnabled: true,
    memoryGuardLevel: 'strict',
    memoryUserMemoriesMaxItems: 20,
    memoryPromptMaxChars: 12000,
    lastWorkspaceSelection: null,
  },
};

const markSessionRead = (state: CoworkState, sessionId: string | null) => {
  if (!sessionId) return;
  state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
};

const markSessionUnread = (state: CoworkState, sessionId: string) => {
  if (state.currentSessionId === sessionId) return;
  if (state.browserOpenSessionId === sessionId) return;
  if (state.unreadSessionIds.includes(sessionId)) return;
  state.unreadSessionIds.push(sessionId);
};

/**
 * Heartbeat-driven long-term-task turns (the [长期] escalation the heartbeat
 * opens on its own) are machine traffic, not something the human should be
 * paged about: they must not raise the session's unread marker. Everything else
 * keeps the historic behavior — scheduled-task prompts, orchestration turns and
 * plain user input still mark unread.
 */
const isHeartbeatOrigin = (metadata?: CoworkMessageMetadata | null): boolean =>
  metadata?.origin === 'heartbeat';

const coworkSlice = createSlice({
  name: 'cowork',
  initialState,
  reducers: {
    setCoworkActive(state, action: PayloadAction<boolean>) {
      state.isCoworkActive = action.payload;
    },

    /**
     * Mirror the Bot Browser panel's current-session pointer (dispatched by
     * browserCoworkService alongside its own setBrowserSession /
     * clearBrowserSession). Setting it marks that session read immediately —
     * clicking a browser conversation in the home history must clear its
     * notification dot, exactly like opening a standard cowork session does.
     */
    setBrowserOpenSessionId(state, action: PayloadAction<string | null>) {
      state.browserOpenSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setSessions(state, action: PayloadAction<CoworkSessionSummary[]>) {
      state.sessions = action.payload;
      const validSessionIds = new Set(action.payload.map((session) => session.id));
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => {
        return validSessionIds.has(id) && id !== state.currentSessionId;
      });
      // A session gone from the full list (archived) can no longer be the
      // browser panel's open conversation.
      if (state.browserOpenSessionId && !validSessionIds.has(state.browserOpenSessionId)) {
        state.browserOpenSessionId = null;
      }
    },

    setCurrentSessionId(state, action: PayloadAction<string | null>) {
      state.currentSessionId = action.payload;
      markSessionRead(state, action.payload);
    },

    setCurrentSession(state, action: PayloadAction<CoworkSession | null>) {
      let nextSession = action.payload;
      // Every session kind now arrives as a bounded newest-messages window plus
      // the cursor for the pages below it (coworkStore getSessionView), so a
      // refresh mid-conversation must not drop what the user already loaded:
      // merge into the transcript held here — newer ids appended, ids the window
      // does not carry left as they are, and the local paging cursor kept, since
      // it still describes where this list stops. A payload without
      // messageHistory is a full read (fork, rewind) and replaces the list.
      if (
        nextSession
        && nextSession.messageHistory
        && state.currentSession?.id === nextSession.id
        && state.currentSession.messageHistory
      ) {
        const incomingById = new Map(nextSession.messages.map((message) => [message.id, message]));
        const existingIds = new Set(state.currentSession.messages.map((message) => message.id));
        nextSession = {
          ...nextSession,
          messages: [
            ...state.currentSession.messages.map((message) => incomingById.get(message.id) ?? message),
            ...nextSession.messages.filter((message) => !existingIds.has(message.id)),
          ],
          messageHistory: state.currentSession.messageHistory,
        };
      }
      state.currentSession = nextSession;
      if (nextSession) {
        state.currentSessionId = nextSession.id;
        if (!nextSession.id.startsWith('temp-')) {
          const {
            id,
            title,
            status,
            pinned,
            createdAt,
            updatedAt,
            sessionType,
            peerName,
            autoOrigin,
            foldOverride,
            serviceOrderSummary,
          } = nextSession;
          const summary: CoworkSessionSummary = {
            id,
            title,
            status,
            pinned: pinned ?? false,
            createdAt,
            updatedAt,
            sessionType,
            peerName,
            // Carry the fold marker through the rebuild. Spread-if-present so a
            // payload without the field never erases a marker the list row
            // already learned from listSessions.
            ...(autoOrigin ? { autoOrigin } : {}),
            // Same rule for the manual fold placement ('in' / 'out'), which the
            // session-open payload also carries.
            ...(foldOverride ? { foldOverride } : {}),
            serviceOrderSummary: serviceOrderSummary ?? null,
          };
          const sessionIndex = state.sessions.findIndex((session) => session.id === id);
          if (sessionIndex !== -1) {
            state.sessions[sessionIndex] = {
              ...state.sessions[sessionIndex],
              ...summary,
              // The full-session payload carries the raw last-activity
              // updated_at; merging it would reorder the row on every open or
              // profile refresh, so the list keeps its own sort anchor.
              updatedAt: state.sessions[sessionIndex].updatedAt,
            };
          } else {
            state.sessions.unshift(summary);
          }
        }
        markSessionRead(state, nextSession.id);
      }
    },

    setDraftPrompt(state, action: PayloadAction<string>) {
      state.draftPrompt = action.payload;
    },

    /**
     * Persist one session's composer draft (text + attachments + quoted
     * transcript excerpts). Empty drafts are dropped so idle sessions do not
     * accumulate entries; `quotedSelections` is written only when non-empty so
     * drafts without quotes keep their previous shape.
     */
    setSessionDraft(state, action: PayloadAction<{ sessionId: string; value: string; attachments: Array<{ path: string; name: string }>; quotedSelections?: CoworkQuotedSelection[] }>) {
      const { sessionId, value, attachments, quotedSelections } = action.payload;
      if (!sessionId) return;
      const quotes = quotedSelections ?? [];
      if (!value && attachments.length === 0 && quotes.length === 0) {
        delete state.sessionDrafts[sessionId];
        return;
      }
      state.sessionDrafts[sessionId] = quotes.length > 0
        ? { value, attachments, quotedSelections: quotes }
        : { value, attachments };
    },

    setNewTaskMetabotId(state, action: PayloadAction<number | null>) {
      state.newTaskMetabotId = action.payload;
    },

    addSession(state, action: PayloadAction<CoworkSession>) {
      const summary: CoworkSessionSummary = {
        id: action.payload.id,
        title: action.payload.title,
        status: action.payload.status,
        pinned: action.payload.pinned ?? false,
        createdAt: action.payload.createdAt,
        updatedAt: action.payload.updatedAt,
        sessionType: action.payload.sessionType,
        peerName: action.payload.peerName,
        peerAvatar: action.payload.peerAvatar,
        metabotId: action.payload.metabotId,
        metabotName: action.payload.metabotName,
        metabotAvatar: action.payload.metabotAvatar,
        // A session opened through addSession is one the human just started
        // (auto-created runs arrive via registerBackgroundSession /
        // loadSessions), so the marker is carried only if the payload has one.
        autoOrigin: action.payload.autoOrigin ?? null,
        foldOverride: action.payload.foldOverride ?? null,
        serviceOrderSummary: action.payload.serviceOrderSummary ?? null,
      };
      state.sessions.unshift(summary);
      state.currentSession = action.payload;
      state.currentSessionId = action.payload.id;
      markSessionRead(state, action.payload.id);
    },

    // Register a background session (e.g. IM-created) without switching currentSession
    registerBackgroundSession(state, action: PayloadAction<CoworkSessionSummary>) {
      const exists = state.sessions.some(s => s.id === action.payload.id);
      if (!exists) {
        state.sessions.unshift(action.payload);
      }
    },

    // Status flips (running/waiting/completed) repaint the row's status dot but
    // never reorder the list: the sort anchor is the last user-side input, so
    // parallel streaming sessions stay put while their turns run.
    updateSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;

      // Update in sessions list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].status = status;
      }

      // Update current session if applicable
      if (state.currentSession?.id === sessionId) {
        state.currentSession.status = status;
        // Streaming state is tied to the currently opened session only
        state.isStreaming = status === 'running';
      }
    },

    deleteSession(state, action: PayloadAction<string>) {
      const sessionId = action.payload;
      state.sessions = state.sessions.filter(s => s.id !== sessionId);
      state.unreadSessionIds = state.unreadSessionIds.filter((id) => id !== sessionId);
      if (state.browserOpenSessionId === sessionId) {
        state.browserOpenSessionId = null;
      }
      // A deleted session can never be reopened, so its composer draft is gone too.
      delete state.sessionDrafts[sessionId];

      if (state.currentSessionId === sessionId) {
        state.currentSessionId = null;
        state.currentSession = null;
      }
    },

    addMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;
      // Only user-side input (typed by the user or injected by orchestration —
      // both land as type 'user') moves a session's sort anchor. Assistant /
      // tool / system stream traffic must not reshuffle the sidebar while
      // several sessions run in parallel. Mirrors the SQL in
      // coworkStore.listSessions, which ranks by the last type='user' message.
      const isUserTurn = message.type === 'user';

      if (state.currentSession?.id === sessionId) {
        const exists = state.currentSession.messages.some((item) => item.id === message.id);
        if (!exists) {
          state.currentSession.messages.push(message);
          if (isUserTurn) {
            state.currentSession.updatedAt = message.timestamp;
          }
        }
      }

      // Update session in list
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1 && isUserTurn) {
        state.sessions[sessionIndex].updatedAt = message.timestamp;
      }

      // A heartbeat turn is background progress on a long-term task, not an
      // inbound message the human has to be told about (see isHeartbeatOrigin).
      if (!isHeartbeatOrigin(message.metadata)) {
        markSessionUnread(state, sessionId);
      }
    },

    prependMessages(state, action: PayloadAction<{
      sessionId: string;
      messages: CoworkMessage[];
      messageHistory: CoworkMessageHistoryState;
    }>) {
      const { sessionId, messages, messageHistory } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const existingIds = new Set(state.currentSession.messages.map((message) => message.id));
      const uniqueEarlierMessages = messages.filter((message) => !existingIds.has(message.id));
      state.currentSession.messages = [
        ...uniqueEarlierMessages,
        ...state.currentSession.messages,
      ];
      state.currentSession.messageHistory = messageHistory;
    },

    updateMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; content?: string; metadata?: CoworkMessageMetadata }>) {
      const { sessionId, messageId, content, metadata } = action.payload;

      if (state.currentSession?.id === sessionId) {
        const messageIndex = state.currentSession.messages.findIndex(m => m.id === messageId);
        if (messageIndex !== -1) {
          if (content !== undefined) {
            state.currentSession.messages[messageIndex].content = content;
          }
          if (metadata !== undefined) {
            state.currentSession.messages[messageIndex].metadata = {
              ...(state.currentSession.messages[messageIndex].metadata ?? {}),
              ...metadata,
            };
          }
        }
      }

      // Same rule as addMessage: a heartbeat-driven turn never raises the
      // session's unread marker.
      if (!isHeartbeatOrigin(metadata)) {
        markSessionUnread(state, sessionId);
      }
    },

    /**
     * Append a streamed delta to one message. The streaming service coalesces
     * its buffered deltas and lands them here, so a live answer no longer
     * rebuilds and re-dispatches the whole content string on every update; only
     * the target message object changes, every other message keeps its identity
     * (which is what keeps the transcript's memoized turns from re-rendering).
     */
    appendMessageContent(state, action: PayloadAction<{ sessionId: string; messageId: string; delta: string }>) {
      const { sessionId, messageId, delta } = action.payload;
      if (state.currentSession?.id === sessionId && delta) {
        const message = state.currentSession.messages.find(m => m.id === messageId);
        if (message) {
          message.content = `${message.content ?? ''}${delta}`;
        }
      }
      markSessionUnread(state, sessionId);
    },

    setMessageFeedback(state, action: PayloadAction<{ messageId: string; rating: MessageFeedbackRating; comment?: string }>) {
      const { messageId, rating, comment } = action.payload;
      state.feedbackByMessageId[messageId] = { rating, comment };
    },

    clearMessageFeedback(state, action: PayloadAction<string>) {
      delete state.feedbackByMessageId[action.payload];
    },

    loadSessionFeedback(state, action: PayloadAction<Array<{ messageId: string; rating: MessageFeedbackRating; comment?: string }>>) {
      for (const record of action.payload) {
        state.feedbackByMessageId[record.messageId] = { rating: record.rating, comment: record.comment };
      }
    },

    setStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    updateSessionPinned(state, action: PayloadAction<{ sessionId: string; pinned: boolean }>) {
      const { sessionId, pinned } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].pinned = pinned;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.pinned = pinned;
      }
    },

    /**
     * Manual "Autonomous Tasks" fold placement ('in' | 'out' | null) — mirrors
     * updateSessionPinned: the row moves between the fold and the main list
     * without a re-read, and null hands the row back to the auto-origin policy.
     */
    updateSessionFoldOverride(state, action: PayloadAction<{ sessionId: string; override: CoworkSessionFoldOverride | null }>) {
      const { sessionId, override } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].foldOverride = override;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.foldOverride = override;
      }
    },

    updateSessionTitle(state, action: PayloadAction<{ sessionId: string; title: string }>) {
      const { sessionId, title } = action.payload;
      const sessionIndex = state.sessions.findIndex(s => s.id === sessionId);
      if (sessionIndex !== -1) {
        state.sessions[sessionIndex].title = title;
      }
      if (state.currentSession?.id === sessionId) {
        state.currentSession.title = title;
      }
    },

    updateSessionPermissionMode(state, action: PayloadAction<{ sessionId: string; permissionMode: CoworkPermissionMode }>) {
      const { sessionId, permissionMode } = action.payload;
      // currentSession is the full CoworkSession; the sessions list holds
      // summaries without permissionMode, so only patch the active session.
      if (state.currentSession?.id === sessionId) {
        state.currentSession.permissionMode = permissionMode;
      }
    },

    /** /goal command: patch the active session's goal (null clears). */
    updateSessionGoal(state, action: PayloadAction<{ sessionId: string; goal: CoworkSessionGoal | null }>) {
      const { sessionId, goal } = action.payload;
      if (state.currentSession?.id === sessionId) {
        state.currentSession.goal = goal;
      }
    },

    /**
     * Upsert a subagent task row from a SDK task or tool_progress event.
     * Later events (progress, notification) merge into the existing row.
     */
    upsertSubagentTask(state, action: PayloadAction<SubagentTaskState>) {
      const task = action.payload;
      const existing = state.subagentTasks[task.taskId];
      state.subagentTasks[task.taskId] = existing
        ? { ...existing, ...task }
        : task;
    },

    /**
     * Replace the task set for one session (background_tasks_changed REPLACE
     * semantics). Tasks for other sessions are kept; existing detail for the
     * same task_id is preserved since the payload is ids-only (no status).
     */
    setSubagentTasks(state, action: PayloadAction<{ sessionId: string; tasks: Array<Partial<SubagentTaskState> & { taskId: string }> }>) {
      const { sessionId, tasks } = action.payload;
      const next: Record<string, SubagentTaskState> = {};
      for (const [key, existing] of Object.entries(state.subagentTasks)) {
        if (existing.sessionId !== sessionId) {
          next[key] = existing;
        }
      }
      for (const task of tasks) {
        next[task.taskId] = {
          ...(state.subagentTasks[task.taskId] ?? { status: 'running' as SubagentTaskStatus }),
          ...task,
          sessionId,
        };
      }
      state.subagentTasks = next;
    },

    setSubagentPanelOpen(state, action: PayloadAction<boolean>) {
      state.isSubagentPanelOpen = action.payload;
    },

    enqueuePendingPermission(state, action: PayloadAction<CoworkPermissionRequest>) {
      const alreadyQueued = state.pendingPermissions.some(
        (permission) => permission.requestId === action.payload.requestId
      );
      if (alreadyQueued) return;
      state.pendingPermissions.push(action.payload);
    },

    dequeuePendingPermission(state, action: PayloadAction<{ requestId?: string } | undefined>) {
      const requestId = action.payload?.requestId;
      if (!requestId) {
        state.pendingPermissions.shift();
        return;
      }
      state.pendingPermissions = state.pendingPermissions.filter(
        (permission) => permission.requestId !== requestId
      );
    },

    clearPendingPermissions(state) {
      state.pendingPermissions = [];
    },

    setConfig(state, action: PayloadAction<CoworkConfig>) {
      state.config = action.payload;
    },

    updateConfig(state, action: PayloadAction<Partial<CoworkConfig>>) {
      state.config = { ...state.config, ...action.payload };
    },

    clearCurrentSession(state) {
      state.currentSessionId = null;
      state.currentSession = null;
      state.isStreaming = false;
      // Tasks belong to a session; leaving the session clears its task view
      // (background_tasks_changed REPLACE will repopulate on the next signal).
      state.subagentTasks = {};
      state.isSubagentPanelOpen = false;
    },

    setPreferredMetabotId(state, action: PayloadAction<number | null>) {
      state.preferredMetabotId = action.payload;
    },

    clearPreferredMetabotId(state) {
      state.preferredMetabotId = null;
    },
  },
});

export const {
  setCoworkActive,
  setBrowserOpenSessionId,
  setSessions,
  setCurrentSessionId,
  setCurrentSession,
  setDraftPrompt,
  setSessionDraft,
  setNewTaskMetabotId,
  addSession,
  registerBackgroundSession,
  updateSessionStatus,
  deleteSession,
  addMessage,
  prependMessages,
  updateMessageContent,
  appendMessageContent,
  setMessageFeedback,
  clearMessageFeedback,
  loadSessionFeedback,
  setStreaming,
  updateSessionPinned,
  updateSessionFoldOverride,
  updateSessionTitle,
  updateSessionPermissionMode,
  updateSessionGoal,
  upsertSubagentTask,
  setSubagentTasks,
  setSubagentPanelOpen,
  enqueuePendingPermission,
  dequeuePendingPermission,
  clearPendingPermissions,
  setConfig,
  updateConfig,
  clearCurrentSession,
  setPreferredMetabotId,
  clearPreferredMetabotId,
} = coworkSlice.actions;

export default coworkSlice.reducer;
