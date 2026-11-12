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
