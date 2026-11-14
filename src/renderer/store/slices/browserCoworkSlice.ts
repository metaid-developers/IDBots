import { createSlice, PayloadAction } from '@reduxjs/toolkit';
import type {
  CoworkMessage,
  CoworkMessageHistoryState,
  CoworkMessageMetadata,
  CoworkSession,
  CoworkSessionStatus,
} from '../../types/cowork';
import { deleteSession } from './coworkSlice';

/**
 * State for the Bot Browser side-panel Co-Work surface.
 *
 * Deliberately separate from the main cowork slice: the browser panel and the
 * main CoworkView can each have a different session open at the same time.
 * Stream events are dual-dispatched from services/cowork.ts; every reducer
 * here no-ops when the event's sessionId does not match the panel's open
 * session, mirroring the guard pattern in coworkSlice.
 */
interface BrowserCoworkState {
  currentSession: CoworkSession | null;
  isStreaming: boolean;
}

const initialState: BrowserCoworkState = {
  currentSession: null,
  isStreaming: false,
};

const browserCoworkSlice = createSlice({
  name: 'browserCowork',
  initialState,
  reducers: {
    setBrowserSession(state, action: PayloadAction<CoworkSession | null>) {
      let nextSession = action.payload;
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
      state.isStreaming = nextSession?.status === 'running';
    },

    prependBrowserMessages(
      state,
      action: PayloadAction<{
        sessionId: string;
        messages: CoworkMessage[];
        messageHistory: CoworkMessageHistoryState;
      }>,
    ) {
      const { sessionId, messages, messageHistory } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const existingIds = new Set(state.currentSession.messages.map((item) => item.id));
      const fresh = messages.filter((item) => !existingIds.has(item.id));
      if (fresh.length > 0) {
        state.currentSession.messages = [...fresh, ...state.currentSession.messages];
      }
      state.currentSession.messageHistory = messageHistory;
    },

    addBrowserMessage(state, action: PayloadAction<{ sessionId: string; message: CoworkMessage }>) {
      const { sessionId, message } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const exists = state.currentSession.messages.some((item) => item.id === message.id);
      if (!exists) {
        state.currentSession.messages.push(message);
        state.currentSession.updatedAt = message.timestamp;
      }
    },

    updateBrowserMessageContent(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; content?: string; metadata?: CoworkMessageMetadata }>
    ) {
      const { sessionId, messageId, content, metadata } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      const messageIndex = state.currentSession.messages.findIndex((m) => m.id === messageId);
      if (messageIndex === -1) return;
      if (content !== undefined) {
        state.currentSession.messages[messageIndex].content = content;
      }
      if (metadata !== undefined) {
        state.currentSession.messages[messageIndex].metadata = {
          ...(state.currentSession.messages[messageIndex].metadata ?? {}),
          ...metadata,
        };
      }
    },

    /** Streaming delta for the panel's copy of a live assistant message. */
    appendBrowserMessageContent(
      state,
      action: PayloadAction<{ sessionId: string; messageId: string; delta: string }>
    ) {
      const { sessionId, messageId, delta } = action.payload;
      if (state.currentSession?.id !== sessionId || !delta) return;
      const message = state.currentSession.messages.find((m) => m.id === messageId);
      if (!message) return;
      message.content = `${message.content ?? ''}${delta}`;
    },

    updateBrowserSessionStatus(state, action: PayloadAction<{ sessionId: string; status: CoworkSessionStatus }>) {
      const { sessionId, status } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.status = status;
      state.currentSession.updatedAt = Date.now();
      state.isStreaming = status === 'running';
    },

    updateBrowserSessionModel(
      state,
      action: PayloadAction<{
        sessionId: string;
        model: string | null;
        modelProvider?: string | null;
        effort?: string | null;
      }>,
    ) {
      const { sessionId, model, modelProvider, effort } = action.payload;
      if (state.currentSession?.id !== sessionId) return;
      state.currentSession.model = model;
      if (modelProvider !== undefined) {
        state.currentSession.modelProvider = modelProvider;
      }
      if (effort !== undefined) {
        state.currentSession.effort = effort;
      }
    },

    setBrowserStreaming(state, action: PayloadAction<boolean>) {
      state.isStreaming = action.payload;
    },

    clearBrowserSession(state) {
      state.currentSession = null;
      state.isStreaming = false;
    },
  },
  extraReducers: (builder) => {
    // Archiving a session from any surface (Bot Home list, batch archive, the
    // home cowork view) removes it everywhere; the Bot Browser panel must not
    // keep pointing at a session that no longer exists.
    builder.addCase(deleteSession, (state, action) => {
      if (state.currentSession?.id !== action.payload) return;
      state.currentSession = null;
      state.isStreaming = false;
    });
  },
});

export const {
  setBrowserSession,
  prependBrowserMessages,
  addBrowserMessage,
  updateBrowserMessageContent,
  appendBrowserMessageContent,
  updateBrowserSessionStatus,
  updateBrowserSessionModel,
  setBrowserStreaming,
  clearBrowserSession,
} = browserCoworkSlice.actions;

export default browserCoworkSlice.reducer;
