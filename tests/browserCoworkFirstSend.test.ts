import test from 'node:test';
import assert from 'node:assert/strict';

import { store } from '../src/renderer/store';
import { setBrowserSession } from '../src/renderer/store/slices/browserCoworkSlice';
import { setBrowserOpenSessionId } from '../src/renderer/store/slices/coworkSlice';
import { browserCoworkService } from '../src/renderer/services/browserCowork';
import { coworkService } from '../src/renderer/services/cowork';
import type { CoworkSession } from '../src/renderer/types/cowork';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const realSession = (): CoworkSession => ({
  id: 'session-real',
  title: 'Generated title',
  claudeSessionId: null,
  status: 'running',
  pinned: false,
  cwd: '/tmp/project',
  systemPrompt: '',
  executionMode: 'local',
  activeSkillIds: [],
  messages: [{ id: 'persisted-first-message', type: 'user', content: 'first question', timestamp: 2000 }],
  createdAt: 1000,
  updatedAt: 2000,
  sessionType: 'browser',
  assistantMode: true,
  metabotId: 1,
});

function resetPanel() {
  store.dispatch(setBrowserSession(null));
  store.dispatch(setBrowserOpenSessionId(null));
}

function fixture(t: Parameters<typeof test>[1], startSession: (options: unknown) => Promise<unknown>, generateTitle?: Promise<string | null>) {
  resetPanel();
  const previousWindow = globalThis.window;
  const previousLoadSessions = coworkService.loadSessions;
  const calls = { start: 0, submit: 0, stop: 0 };
  const values = new Map<string, string>();
  globalThis.window = {
    electron: {
      generateSessionTitle: () => generateTitle ?? Promise.resolve(null),
      cowork: {
        startSession: async (options: unknown) => {
          calls.start += 1;
          return startSession(options);
        },
        submitInput: async () => {
          calls.submit += 1;
          return { success: true };
        },
        stopSession: async () => {
          calls.stop += 1;
          return { success: true };
        },
      },
    },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    },
  } as unknown as Window & typeof globalThis;
  coworkService.loadSessions = async () => undefined;
  t.after(() => {
    globalThis.window = previousWindow;
    coworkService.loadSessions = previousLoadSessions;
    resetPanel();
  });
  return calls;
}

test('first send paints an optimistic bubble before title generation and the real session resolve', async (t) => {
  const title = deferred<string | null>();
  const started = deferred<{ success: boolean; session: CoworkSession }>();
  const calls = fixture(t, () => started.promise, title.promise);

  const pending = browserCoworkService.start('first question', 1, '/tmp/project');
  const optimistic = store.getState().browserCowork.currentSession;
  assert.ok(optimistic, 'the draft session exists synchronously');
  assert.match(optimistic.id, /^optimistic-browser-/);
  assert.equal(optimistic.status, 'running');
  assert.equal(optimistic.messages.length, 1);
  assert.equal(optimistic.messages[0].type, 'user');
  assert.equal(optimistic.messages[0].content, 'first question');
  assert.equal(store.getState().browserCowork.isStreaming, true, 'activity renders below that bubble');
  assert.equal(store.getState().cowork.browserOpenSessionId, null, 'the optimistic id is never persisted as the open session');
  assert.equal(calls.start, 0, 'title generation is still pending');

  assert.equal(await browserCoworkService.send('too early'), false, 'steering cannot target the optimistic id');
  await browserCoworkService.stop();
  assert.equal(calls.submit, 0);
  assert.equal(calls.stop, 0);

  title.resolve(null);
  for (let index = 0; index < 20 && calls.start === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(calls.start, 1);
  const actual = realSession();
  started.resolve({ success: true, session: actual });
  assert.equal(await pending, actual);

  const settled = store.getState().browserCowork.currentSession;
  assert.equal(settled?.id, actual.id);
  assert.deepEqual(settled?.messages, actual.messages, 'the real first message replaces rather than duplicates the optimistic one');
  assert.equal(store.getState().cowork.browserOpenSessionId, actual.id);
  assert.equal(store.getState().browserCowork.isStreaming, true);
});

test('prompt enrichment also runs after the optimistic bubble is already visible', async (t) => {
  const preparation = deferred<string>();
  const started = deferred<{ success: boolean; session: CoworkSession }>();
  let outgoingPrompt = '';
  const calls = fixture(t, async (options) => {
    outgoingPrompt = (options as { prompt: string }).prompt;
    return started.promise;
  });
  const pending = browserCoworkService.start(
    'first question',
    1,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => preparation.promise,
  );
  assert.equal(store.getState().browserCowork.currentSession?.messages[0].content, 'first question');
  assert.equal(store.getState().browserCowork.isStreaming, true);
  assert.equal(calls.start, 0, 'the backend is still waiting for prompt enrichment');

  preparation.resolve('enriched first question');
  for (let index = 0; index < 20 && calls.start === 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(calls.start, 1);
  const actual = realSession();
  started.resolve({ success: true, session: actual });
  assert.equal(await pending, actual);
  assert.equal(outgoingPrompt, 'enriched first question');
});

test('a rejected start removes the optimistic session and restores the draft state', async (t) => {
  fixture(t, async () => ({ success: false, error: 'backend unavailable' }));
  const pending = browserCoworkService.start('first question', 1);
  assert.ok(store.getState().browserCowork.currentSession);

  assert.equal(await pending, null);
  assert.equal(store.getState().browserCowork.currentSession, null);
  assert.equal(store.getState().browserCowork.isStreaming, false);
  assert.equal(store.getState().cowork.browserOpenSessionId, null);
});

test('a thrown start also clears the optimistic session instead of leaving a stuck activity bar', async (t) => {
  fixture(t, async () => { throw new Error('connection lost'); });
  const pending = browserCoworkService.start('first question', 1);
  assert.ok(store.getState().browserCowork.currentSession);

  await assert.rejects(pending, /connection lost/);
  assert.equal(store.getState().browserCowork.currentSession, null);
  assert.equal(store.getState().browserCowork.isStreaming, false);
  assert.equal(store.getState().cowork.browserOpenSessionId, null);
});
