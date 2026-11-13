import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createBrowserElementSelectionsBridge,
  BrowserElementSelectionsRequestError,
} from '../src/renderer/features/botBrowser/browserElementSelectionsBridge';
import type { BrowserElementSelectionsSnapshot } from '@openagentinternet/agent-browser-host-contract';

const snapshotOf = (overrides: Partial<BrowserElementSelectionsSnapshot> = {}): BrowserElementSelectionsSnapshot => ({
  tabId: 3,
  uri: 'metaapp://abc',
  title: 'Chess App',
  selections: [],
  ...overrides,
});

type FrameVerdict = { ok: boolean; result?: unknown; error?: { code: string; message: string } } | null;

/**
 * Tiny fake frame: records envelopes and, when a responder is installed,
 * answers them through the bridge's own handleMessage (async, real timers).
 * The responder closes over the per-test bridge via this module-level
 * binding — each test assigns it right after creating its bridge.
 */
let bridge: ReturnType<typeof createBrowserElementSelectionsBridge>;

function fakeFrame() {
  const sent: Record<string, unknown>[] = [];
  let respond: ((envelope: Record<string, unknown>) => FrameVerdict) | null = null;
  return {
    sent,
    onRequestResponder(responder: (envelope: Record<string, unknown>) => FrameVerdict) {
      respond = responder;
    },
    postToFrame: (payload: Record<string, unknown>) => {
      sent.push(payload);
      const verdict = respond?.(payload);
      if (!verdict) return true;
      const responseType = `${payload.type}:response`;
      setTimeout(() => {
        bridge.handleMessage({
          type: responseType,
          version: 1,
          requestId: payload.requestId,
          ok: verdict.ok,
          ...(verdict.ok ? { result: verdict.result } : { error: verdict.error }),
        });
      }, 0);
      return true;
    },
  };
}

/**
 * Poll until the expected bridge activity shows up. The debounced fetch and
 * the fake frame's response are real setTimeout(0) chains; Windows runner
 * timer granularity (~15ms per hop) can push them past a fixed sleep window,
 * so the assertions poll instead of racing a fixed drain.
 */
const waitFor = async (predicate: () => boolean, what: string, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test('changed event triggers a debounced snapshot fetch and records it', async () => {
  const recorded: BrowserElementSelectionsSnapshot[] = [];
  const frame = fakeFrame();
  bridge = createBrowserElementSelectionsBridge({
    postToFrame: frame.postToFrame,
    onSnapshot: (snapshot) => recorded.push(snapshot),
    refetchDebounceMs: 0,
  });
  frame.onRequestResponder((envelope) => ({
    ok: true,
    result: snapshotOf({ tabId: Number(envelope.tabId ?? 3), selections: [{ markerId: 'marker-1' }] as never }),
  }));

  const consumed = bridge.handleMessage({
    type: 'agent-browser:event',
    version: 1,
    event: 'element-selections-changed',
    payload: { reason: 'marker-added', tabId: 7, count: 1 },
  });

  assert.equal(consumed, true);
  await waitFor(() => recorded.length > 0 && frame.sent.length > 0, 'the debounced snapshot fetch to record');
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].tabId, 7);
  assert.equal(frame.sent.length, 1);
  assert.equal(frame.sent[0].type, 'agent-browser:get-element-selections');
  assert.equal(frame.sent[0].tabId, 7);
});

test('changed events debounce: a burst fetches once with the latest tabId', async () => {
  const recorded: BrowserElementSelectionsSnapshot[] = [];
  const frame = fakeFrame();
  const handled: number[] = [];
  bridge = createBrowserElementSelectionsBridge({
    postToFrame: frame.postToFrame,
    onSnapshot: (snapshot) => recorded.push(snapshot),
    refetchDebounceMs: 0,
  });
  frame.onRequestResponder((envelope) => {
    handled.push(Number(envelope.tabId));
    return { ok: true, result: snapshotOf({ tabId: Number(envelope.tabId ?? 3) }) };
  });

  bridge.handleMessage({ type: 'agent-browser:event', version: 1, event: 'element-selections-changed', payload: { tabId: 1, count: 1 } });
  bridge.handleMessage({ type: 'agent-browser:event', version: 1, event: 'element-selections-changed', payload: { tabId: 2, count: 1 } });
  bridge.handleMessage({ type: 'agent-browser:event', version: 1, event: 'element-selections-changed', payload: { tabId: 3, count: 2 } });
  await waitFor(() => recorded.length > 0 && frame.sent.length > 0, 'the debounced burst fetch to record');

  assert.equal(frame.sent.length, 1, 'burst should collapse into one fetch');
  assert.deepEqual(handled, [3], 'the fetch targets the latest event tab');
  assert.equal(recorded.length, 1);
});

test('non-picker agent-browser events and unknown messages are not consumed', () => {
  bridge = createBrowserElementSelectionsBridge({ postToFrame: () => true, onSnapshot: () => {} });
  assert.equal(bridge.handleMessage({ type: 'agent-browser:event', version: 1, event: 'tab-activated' }), false);
  assert.equal(bridge.handleMessage({ type: 'agent-browser:event', version: 1, event: 'element-selections-changed' }), false);
  assert.equal(bridge.handleMessage({ type: 'agent-browser:event', event: 'element-selections-changed', payload: {} }), false);
  assert.equal(bridge.handleMessage({ type: 'agent-browser:get-tab-info:response', requestId: 'x', ok: true }), false);
  assert.equal(bridge.handleMessage(null), false);
  assert.equal(bridge.handleMessage({}), false);
});

test('getElementSelections correlates responses by requestId', async () => {
  const frame = fakeFrame();
  bridge = createBrowserElementSelectionsBridge({ postToFrame: frame.postToFrame, onSnapshot: () => {} });
  frame.onRequestResponder((envelope) => ({
    ok: true,
    result: snapshotOf({ tabId: envelope.requestId === 'element-selections-1' ? 1 : 2 }),
  }));

  const [first, second] = await Promise.all([
    bridge.getElementSelections(),
    bridge.getElementSelections(9),
  ]);
  assert.equal(first?.tabId, 1);
  assert.equal(second?.tabId, 2);
  assert.equal(frame.sent.length, 2);
});

test('tab_not_found resolves to null (getTabInfo semantics)', async () => {
  const frame = fakeFrame();
  bridge = createBrowserElementSelectionsBridge({ postToFrame: frame.postToFrame, onSnapshot: () => {} });
  frame.onRequestResponder(() => ({ ok: false, error: { code: 'tab_not_found', message: 'No browser tab matches the requested tabId.' } }));
  const snapshot = await bridge.getElementSelections(42);
  assert.equal(snapshot, null);
  const cleared = await bridge.clearElementSelections(42);
  assert.equal(cleared, null);
});

test('other error codes reject with the ABC code attached', async () => {
  const frame = fakeFrame();
  bridge = createBrowserElementSelectionsBridge({ postToFrame: frame.postToFrame, onSnapshot: () => {} });
  frame.onRequestResponder(() => ({ ok: false, error: { code: 'invalid_request', message: 'Invalid host request.' } }));
  await assert.rejects(bridge.getElementSelections(), (error: BrowserElementSelectionsRequestError) => {
    assert.equal(error.code, 'invalid_request');
    return true;
  });
});

test('clearElementSelections resolves the cleared envelope', async () => {
  const frame = fakeFrame();
  bridge = createBrowserElementSelectionsBridge({ postToFrame: frame.postToFrame, onSnapshot: () => {} });
  frame.onRequestResponder((envelope) => ({ ok: true, result: { tabId: Number(envelope.tabId ?? 3), cleared: true } }));
  const result = await bridge.clearElementSelections(3);
  assert.deepEqual(result, { tabId: 3, cleared: true });
  assert.equal(frame.sent[frame.sent.length - 1].type, 'agent-browser:clear-element-selections');
});

test('requests time out when the frame never answers', async () => {
  const timers: (() => void)[] = [];
  bridge = createBrowserElementSelectionsBridge({
    postToFrame: () => true,
    onSnapshot: () => {},
    timeoutMs: 25,
    setTimeoutImpl: (handler) => {
      timers.push(handler);
      return timers.length;
    },
    clearTimeoutImpl: () => {},
  });
  const pending = bridge.getElementSelections();
  assert.equal(timers.length, 1);
  // Fire the injected timeout so the pending request settles.
  timers[0]();
  await assert.rejects(pending, (error: BrowserElementSelectionsRequestError) => {
    assert.equal(error.code, 'timeout');
    return true;
  });
});

test('a missing frame rejects with frame_unavailable', async () => {
  bridge = createBrowserElementSelectionsBridge({ postToFrame: () => false, onSnapshot: () => {} });
  await assert.rejects(bridge.getElementSelections(), (error: BrowserElementSelectionsRequestError) => {
    assert.equal(error.code, 'frame_unavailable');
    return true;
  });
});

test('dispose rejects in-flight requests and stops answering', async () => {
  bridge = createBrowserElementSelectionsBridge({ postToFrame: () => true, onSnapshot: () => {} });
  const pending = bridge.getElementSelections();
  bridge.dispose();
  await assert.rejects(pending, /closed/);
  await assert.rejects(bridge.getElementSelections(), /closed/);
});

test('responses without a matching pending request are consumed silently', () => {
  bridge = createBrowserElementSelectionsBridge({ postToFrame: () => true, onSnapshot: () => {} });
  assert.equal(bridge.handleMessage({
    type: 'agent-browser:get-element-selections:response',
    version: 1,
    requestId: 'stale',
    ok: true,
    result: snapshotOf(),
  }), true);
});
