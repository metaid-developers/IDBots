import test from 'node:test';
import assert from 'node:assert/strict';

import reducer, {
  setBrowserSession,
  prependBrowserMessages,
  addBrowserMessage,
  updateBrowserMessageContent,
  appendBrowserMessageContent,
  updateBrowserSessionStatus,
  updateBrowserSessionModel,
  setBrowserStreaming,
  clearBrowserSession,
} from '../src/renderer/store/slices/browserCoworkSlice';
import coworkReducer, {
  deleteSession,
  setCurrentSession as setCoworkCurrentSession,
  appendMessageContent as appendCoworkMessageContent,
} from '../src/renderer/store/slices/coworkSlice';
import type { CoworkSession } from '../src/renderer/types/cowork';

const makeSession = (overrides: Partial<CoworkSession> = {}): CoworkSession => ({
  id: 'session-1',
  title: 'Browser chat',
  claudeSessionId: null,
  status: 'running',
  pinned: false,
  cwd: '/tmp',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: [],
  createdAt: 1000,
  updatedAt: 1000,
  sessionType: 'browser',
  ...overrides,
});

test('setBrowserSession stores the session and derives streaming from status', () => {
  const running = reducer(undefined, setBrowserSession(makeSession()));
  assert.equal(running.currentSession?.id, 'session-1');
  assert.equal(running.isStreaming, true);

  const idle = reducer(undefined, setBrowserSession(makeSession({ status: 'completed' })));
  assert.equal(idle.isStreaming, false);
});

test('prependBrowserMessages prepends deduplicated older pages and setBrowserSession preserves them on refresh', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    status: 'completed',
    messages: [{ id: 'm3', type: 'assistant', content: 'newest', timestamp: 1003 }],
    messageHistory: { hasMoreBefore: true, beforeSequence: null, beforeTranscriptCursor: '1003:0:3', pageSize: 1 },
  })));
  state = reducer(state, prependBrowserMessages({
    sessionId: 'session-1',
    messages: [
      { id: 'm1', type: 'user', content: 'oldest', timestamp: 1001 },
      { id: 'm2', type: 'assistant', content: 'middle', timestamp: 1002 },
    ],
    messageHistory: { hasMoreBefore: false, beforeSequence: null, beforeTranscriptCursor: null, pageSize: 1 },
  }));
  assert.deepEqual(state.currentSession?.messages.map((m) => m.id), ['m1', 'm2', 'm3']);

  state = reducer(state, setBrowserSession(makeSession({
    status: 'completed',
    messages: [
      { id: 'm3', type: 'assistant', content: 'newest updated', timestamp: 1003 },
      { id: 'm4', type: 'user', content: 'follow-up', timestamp: 1004 },
    ],
    messageHistory: { hasMoreBefore: true, beforeSequence: null, beforeTranscriptCursor: '1003:0:3', pageSize: 1 },
  })));
  assert.deepEqual(state.currentSession?.messages.map((m) => m.id), ['m1', 'm2', 'm3', 'm4']);
  assert.equal(state.currentSession?.messages[2].content, 'newest updated');
  assert.equal(state.currentSession?.messageHistory?.hasMoreBefore, false);
});

test('addBrowserMessage appends only for the open session and dedupes by id', () => {
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, addBrowserMessage({
    sessionId: 'other-session',
    message: { id: 'm0', type: 'user', content: 'ignored', timestamp: 1001 },
  }));
  assert.equal(state.currentSession?.messages.length, 0);

  state = reducer(state, addBrowserMessage({
    sessionId: 'session-1',
    message: { id: 'm1', type: 'user', content: 'hello', timestamp: 1002 },
  }));
  state = reducer(state, addBrowserMessage({
    sessionId: 'session-1',
    message: { id: 'm1', type: 'user', content: 'hello', timestamp: 1002 },
  }));
  assert.equal(state.currentSession?.messages.length, 1);
  assert.equal(state.currentSession?.updatedAt, 1002);
});

test('updateBrowserMessageContent patches content and metadata in place', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    messages: [{ id: 'm1', type: 'assistant', content: 'partial', timestamp: 1002 }],
  })));
  state = reducer(state, updateBrowserMessageContent({
    sessionId: 'session-1',
    messageId: 'm1',
    content: 'full answer',
    metadata: { isStreaming: true },
  }));
  assert.equal(state.currentSession?.messages[0].content, 'full answer');
  assert.equal(state.currentSession?.messages[0].metadata?.isStreaming, true);
});

test('updateBrowserMessageContent merges metadata so thinking flags survive finalize', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    messages: [{
      id: 'm1',
      type: 'assistant',
      content: 'hmm',
      timestamp: 1002,
      metadata: { isThinking: true, isStreaming: true },
    }],
  })));
  state = reducer(state, updateBrowserMessageContent({
    sessionId: 'session-1',
    messageId: 'm1',
    content: 'hmm done',
    metadata: { isStreaming: false, isFinal: true },
  }));
  assert.equal(state.currentSession?.messages[0].metadata?.isThinking, true);
  assert.equal(state.currentSession?.messages[0].metadata?.isStreaming, false);
  assert.equal(state.currentSession?.messages[0].metadata?.isFinal, true);
});

test('updateBrowserSessionStatus follows the open session only', () => {
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, updateBrowserSessionStatus({ sessionId: 'other', status: 'completed' }));
  assert.equal(state.currentSession?.status, 'running');
  assert.equal(state.isStreaming, true);

  state = reducer(state, updateBrowserSessionStatus({ sessionId: 'session-1', status: 'completed' }));
  assert.equal(state.currentSession?.status, 'completed');
  assert.equal(state.isStreaming, false);
});

test('updateBrowserSessionModel updates model/provider/effort for the open session only', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    status: 'completed',
    messages: [{ id: 'm1', type: 'user', content: 'hi', timestamp: 1001 }],
  })));
  state = reducer(state, updateBrowserSessionModel({
    sessionId: 'other',
    model: 'gpt-5',
    modelProvider: 'openai',
    effort: 'high',
  }));
  assert.equal(state.currentSession?.model, undefined);

  state = reducer(state, updateBrowserSessionModel({
    sessionId: 'session-1',
    model: 'claude-sonnet-4-5',
    modelProvider: 'anthropic',
    effort: 'default',
  }));
  assert.equal(state.currentSession?.model, 'claude-sonnet-4-5');
  assert.equal(state.currentSession?.modelProvider, 'anthropic');
  assert.equal(state.currentSession?.effort, 'default');
  assert.equal(state.currentSession?.messages.length, 1);
});

test('setBrowserStreaming and clearBrowserSession control the stream flag and reset state', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({ status: 'completed' })));
  state = reducer(state, setBrowserStreaming(true));
  assert.equal(state.isStreaming, true);

  state = reducer(state, clearBrowserSession());
  assert.equal(state.currentSession, null);
  assert.equal(state.isStreaming, false);
});

test('deleteSession clears the panel when its open session is archived from any surface', () => {
  // Bot Home list / batch archive / the home cowork view all archive through
  // coworkService, which only dispatches the cowork slice's deleteSession.
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, deleteSession('session-1'));
  assert.equal(state.currentSession, null);
  assert.equal(state.isStreaming, false);
});

test('deleteSession for another session leaves the panel session untouched', () => {
  let state = reducer(undefined, setBrowserSession(makeSession()));
  state = reducer(state, deleteSession('other-session'));
  assert.equal(state.currentSession?.id, 'session-1');
  assert.equal(state.isStreaming, true);
});

test('appendBrowserMessageContent grows one message without touching the others', () => {
  let state = reducer(undefined, setBrowserSession(makeSession({
    messages: [
      { id: 'm1', type: 'user', content: 'question', timestamp: 1002 },
      { id: 'm2', type: 'assistant', content: 'partial', timestamp: 1003, metadata: { isStreaming: true } },
    ],
  })));
  const before = state.currentSession!.messages;

  state = reducer(state, appendBrowserMessageContent({
    sessionId: 'session-1',
    messageId: 'm2',
    delta: ' + more',
  }));

  assert.equal(state.currentSession!.messages[1].content, 'partial + more');
  assert.equal(state.currentSession!.messages[1].metadata?.isStreaming, true, 'marks survive the append');
  assert.notEqual(state.currentSession!.messages[1], before[1], 'the streamed message is a new object');
  assert.equal(state.currentSession!.messages[0], before[0], 'other messages keep their identity');
  assert.notEqual(state.currentSession, before, 'the session object is replaced');
});

test('appendBrowserMessageContent ignores another session and unknown messages', () => {
  const state = reducer(undefined, setBrowserSession(makeSession({
    messages: [{ id: 'm2', type: 'assistant', content: 'partial', timestamp: 1003 }],
  })));
  const afterOtherSession = reducer(state, appendBrowserMessageContent({
    sessionId: 'other-session',
    messageId: 'm2',
    delta: 'nope',
  }));
  assert.equal(afterOtherSession, state, 'no state change at all');

  const afterUnknown = reducer(state, appendBrowserMessageContent({
    sessionId: 'session-1',
    messageId: 'missing',
    delta: 'nope',
  }));
  assert.equal(afterUnknown.currentSession!.messages[0].content, 'partial');
});

test('appendMessageContent streams into the task view the same way', () => {
  const session = makeSession({
    sessionType: 'standard',
    messages: [
      { id: 'm1', type: 'user', content: 'question', timestamp: 1002 },
      { id: 'm2', type: 'assistant', content: 'partial', timestamp: 1003, metadata: { isStreaming: true } },
    ],
  });
  let state = coworkReducer(undefined, setCoworkCurrentSession(session));
  const before = state.currentSession!.messages;

  state = coworkReducer(state, appendCoworkMessageContent({
    sessionId: 'session-1',
    messageId: 'm2',
    delta: ' + more',
  }));

  assert.equal(state.currentSession!.messages[1].content, 'partial + more');
  assert.notEqual(state.currentSession!.messages[1], before[1], 'only the streamed message is rebuilt');
  assert.equal(state.currentSession!.messages[0], before[0], 'every other message keeps its identity');

  // A session the user is not looking at still raises its unread marker.
  state = coworkReducer(state, appendCoworkMessageContent({
    sessionId: 'background-session',
    messageId: 'm2',
    delta: 'behind the scenes',
  }));
  assert.ok(state.unreadSessionIds.includes('background-session'));
  assert.equal(state.currentSession!.messages[1].content, 'partial + more', 'content is untouched');
});
