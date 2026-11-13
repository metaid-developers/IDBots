import test from 'node:test';
import assert from 'node:assert/strict';

import { createBotBrowserTabBridge } from '../src/main/services/botBrowserTabBridge.ts';

function createWindow() {
  const sent = [];
  let focusCalls = 0;
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload }),
  };
  const window = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: () => {},
    show: () => {},
    focus: () => { focusCalls += 1; },
  };
  return { window, webContents, sent, focusCalls: () => focusCalls };
}

test('background tab activation preserves the current app surface and OS focus', async () => {
  const harness = createWindow();
  const bridge = createBotBrowserTabBridge({
    getWindows: () => [harness.window],
    timeoutMs: 1_000,
  });

  const pending = bridge.execute({
    action: 'navigate-tab',
    sessionId: 'studio-session',
    tabId: 7,
    uri: 'preview-metaapp://localhost/report.html',
    activate: true,
  }, { focusWindow: false });

  assert.equal(harness.sent.length, 1);
  const { channel, payload } = harness.sent[0];
  assert.equal(channel, 'botBrowser:tab-command');
  assert.equal(payload.command.background, true);
  assert.equal(payload.command.activate, true);
  assert.equal(harness.focusCalls(), 0);

  bridge.handleResponse(harness.webContents, {
    requestId: payload.requestId,
    success: true,
    result: { action: 'navigate-tab', tabs: [], activeTab: null },
  });
  await pending;
  bridge.dispose();
});


test('tab bridge relays a command and resolves only the target renderer response', async () => {
  const target = createWindow();
  const other = createWindow();
  const bridge = createBotBrowserTabBridge({ getWindows: () => [target.window], timeoutMs: 100 });
  const promise = bridge.execute({ action: 'get-active-tab' });
  const request = target.sent[0];

  assert.equal(request.channel, 'botBrowser:tab-command');
  assert.deepEqual(request.payload.command, { action: 'get-active-tab', background: false });

  bridge.handleResponse(other.webContents, {
    requestId: request.payload.requestId,
    success: true,
    result: { action: 'get-active-tab', tabs: [], activeTab: null },
  });
  bridge.handleResponse(target.webContents, {
    requestId: request.payload.requestId,
    success: true,
    result: {
      action: 'get-active-tab',
      tabs: [{ id: 3, uri: 'metaid://idq1alice', title: 'Alice', isActive: true }],
      activeTab: { id: 3, uri: 'metaid://idq1alice', title: 'Alice', isActive: true },
    },
  });

  const result = await promise;
  assert.equal(result.activeTab?.uri, 'metaid://idq1alice');
  bridge.dispose();
});

test('tab bridge rejects commands when no renderer window is available', async () => {
  const bridge = createBotBrowserTabBridge({ getWindows: () => [] });
  await assert.rejects(
    bridge.execute({ action: 'get-tabs' }),
    /No IDBots window is available/,
  );
  bridge.dispose();
});

test('tab bridge logs slow responses and timeouts with command fields', async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const target = createWindow();
    const bridge = createBotBrowserTabBridge({ getWindows: () => [target.window], timeoutMs: 30, slowCommandMs: 5 });

    // Slow success: respond after ~15ms (>5ms threshold, <30ms timeout).
    const slow = bridge.execute({ action: 'get-tabs', sessionId: 's1', role: 'stage' });
    const slowRequest = target.sent[0];
    await new Promise((resolve) => setTimeout(resolve, 15));
    bridge.handleResponse(target.webContents, {
      requestId: slowRequest.payload.requestId,
      success: true,
      result: { action: 'get-tabs', tabs: [], activeTab: null },
    });
    await slow;

    // Timeout: never answered → the same fields are logged on timeout.
    const timedOut = bridge.execute({ action: 'open-tab', sessionId: 's2', role: 'showcase' });
    const timeoutRequest = target.sent[1];
    await assert.rejects(timedOut, /timed out/);
    assert.equal(timeoutRequest.payload.command.sessionId, 's2');

    const slowLog = warnings.find((line) => line.includes('slow tab command'));
    assert.ok(slowLog, 'a slow command was logged');
    assert.match(slowLog, /action=get-tabs sessionId=s1 role=stage ms=\d+/);
    const timeoutLog = warnings.find((line) => line.includes('timed out'));
    assert.ok(timeoutLog, 'the timeout was logged');
    assert.match(timeoutLog, /action=open-tab sessionId=s2 role=showcase ms=\d+/);
    bridge.dispose();
  } finally {
    console.warn = originalWarn;
  }
});
