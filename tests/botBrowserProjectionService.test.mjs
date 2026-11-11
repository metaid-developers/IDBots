import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { createBotBrowserProjectionService } = require('../dist-electron/main/services/botBrowserProjectionService.js');
const { createBotBrowserTabBridge } = require('../dist-electron/main/services/botBrowserTabBridge.js');

function fixture() {
  let activeTabId = 99;
  let nextTabId = 1;
  const tabs = [{ id: 99, uri: 'preview-metaapp://localhost/shared/reports/other-session.html' }];
  const commands = [];

  const info = (tab) => ({ ...tab, title: null, isActive: tab.id === activeTabId });
  const result = (action, openedTabId) => ({
    action,
    ...(openedTabId == null ? {} : { openedTabId }),
    tabs: tabs.map(info),
    activeTab: tabs.find((tab) => tab.id === activeTabId) ? info(tabs.find((tab) => tab.id === activeTabId)) : null,
  });
  const execute = async (command) => {
    commands.push(command);
    if (command.action === 'open-tab') {
      let tab = tabs.find((entry) => entry.uri === command.uri);
      if (!tab) {
        tab = { id: nextTabId++, uri: command.uri };
        tabs.push(tab);
      }
      activeTabId = tab.id;
      return result(command.action, tab.id);
    }
    if (command.action === 'get-tab-info') {
      const tab = tabs.find((entry) => entry.id === command.tabId) ?? null;
      return { ...result(command.action), info: tab ? { ...info(tab), current: { uri: tab.uri } } : null };
    }
    if (command.action === 'get-tabs') {
      return result(command.action);
    }
    if (command.action === 'navigate-tab') {
      const tab = tabs.find((entry) => entry.id === command.tabId);
      if (!tab) throw new Error('missing tab');
      tab.uri = command.uri;
      if (command.activate === true) activeTabId = tab.id;
      return result(command.action);
    }
    throw new Error(`Unexpected command: ${command.action}`);
  };

  return {
    commands,
    tabs,
    execute,
    get activeTabId() { return activeTabId; },
    set activeTabId(value) { activeTabId = value; },
  };
}

test('a final report reveals only its own session tab, never a same-directory sibling', async () => {
  const bridge = fixture();
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: bridge.execute }) });

  const stage = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/live-stage-a.html' });
  assert.equal(stage.announced, true);
  assert.notEqual(stage.tabId, 99);
  assert.equal(bridge.activeTabId, stage.tabId);

  bridge.activeTabId = 99;
  const report = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/final-a.html', reveal: true });
  assert.equal(report.tabId, stage.tabId);
  assert.equal(report.announced, true);
  assert.equal(bridge.activeTabId, stage.tabId);
  assert.equal(bridge.tabs.find((tab) => tab.id === 99).uri, 'preview-metaapp://localhost/shared/reports/other-session.html');
  assert.equal(bridge.commands.at(-1).activate, true);
});

test('Live Stage updates stay background and a missing cached tab opens a confirmed replacement', async () => {
  const bridge = fixture();
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: bridge.execute }) });
  const first = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/stage-1.html' });

  bridge.activeTabId = 99;
  const background = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/stage-2.html' });
  assert.equal(background.announced, false);
  assert.equal(bridge.activeTabId, 99);
  assert.equal(bridge.commands.at(-1).activate, false);

  bridge.tabs.splice(bridge.tabs.findIndex((tab) => tab.id === first.tabId), 1);
  const replacement = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/final.html', reveal: true });
  assert.notEqual(replacement.tabId, first.tabId);
  assert.notEqual(replacement.tabId, 99);
  assert.equal(replacement.announced, true);
  assert.equal(bridge.activeTabId, replacement.tabId);
});

test('a final report reuses the supplied Stage tab after the projection cache is lost', async () => {
  const bridge = fixture();
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: bridge.execute }) });
  const stage = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/live-stage-a.html' });
  service.forget('session-a');
  bridge.activeTabId = 99;

  const report = await service.project({
    sessionId: 'session-a',
    localPath: '/shared/reports/final-a.html',
    reveal: true,
    tabId: stage.tabId,
  });

  assert.equal(report.tabId, stage.tabId);
  assert.equal(bridge.activeTabId, stage.tabId);
  assert.equal(bridge.commands.filter((command) => command.action === 'open-tab').length, 1);
  const reopened = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/next-a.html', reveal: true });
  assert.equal(reopened.tabId, stage.tabId, 'the supplied Stage tab also heals the cache');
});

test('a transient tab-info failure falls back to the tab list without opening a duplicate', async () => {
  const bridge = fixture();
  const original = bridge.execute;
  let failTabInfo = true;
  const execute = async (command) => {
    if (failTabInfo && command.action === 'get-tab-info') throw new Error('temporary bridge failure');
    return original(command);
  };
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute }) });
  const stage = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/live-stage-a.html' });
  bridge.activeTabId = 99;

  const report = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/final-a.html', reveal: true });

  assert.equal(report.tabId, stage.tabId);
  assert.equal(bridge.activeTabId, stage.tabId);
  assert.equal(bridge.commands.filter((command) => command.action === 'open-tab').length, 1);
  assert.ok(bridge.commands.some((command) => command.action === 'get-tabs'));

  failTabInfo = false;
});

test('failed tab reads preserve the binding and never open a speculative replacement', async () => {
  const bridge = fixture();
  const original = bridge.execute;
  let unavailable = true;
  const execute = async (command) => {
    if (unavailable && (command.action === 'get-tab-info' || command.action === 'get-tabs')) {
      throw new Error('bridge unavailable');
    }
    return original(command);
  };
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute }) });
  const stage = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/live-stage-a.html' });

  await assert.rejects(
    service.project({ sessionId: 'session-a', localPath: '/shared/reports/final-a.html', reveal: true }),
    /bridge unavailable/,
  );
  assert.equal(bridge.commands.filter((command) => command.action === 'open-tab').length, 1);

  unavailable = false;
  const recovered = await service.project({ sessionId: 'session-a', localPath: '/shared/reports/final-a.html', reveal: true });
  assert.equal(recovered.tabId, stage.tabId);
  assert.equal(bridge.commands.filter((command) => command.action === 'open-tab').length, 1);
});

test('a reveal that does not activate the target is reported as a failure', async () => {
  const bridge = fixture();
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: bridge.execute }) });
  await service.project({ sessionId: 'session-a', localPath: '/shared/reports/stage.html' });
  bridge.activeTabId = 99;
  const original = bridge.execute;
  const brokenExecute = async (command) => {
    if (command.action === 'navigate-tab') {
      return original({ ...command, activate: false });
    }
    return original(command);
  };
  const broken = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: brokenExecute }) });
  await broken.project({ sessionId: 'session-a', localPath: '/shared/reports/stage.html' });
  bridge.activeTabId = 99;
  await assert.rejects(
    broken.project({ sessionId: 'session-a', localPath: '/shared/reports/final.html', reveal: true }),
    /did not become active/,
  );
});

test('background tab commands preserve the app surface except for an activated report reveal', async (t) => {
  const sent = [];
  let bridge;
  const webContents = {
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push(payload);
      queueMicrotask(() => bridge.handleResponse(webContents, {
        requestId: payload.requestId,
        success: true,
        result: { action: payload.command.action, tabs: [], activeTab: null },
      }));
    },
  };
  const window = {
    isDestroyed: () => false,
    isMinimized: () => false,
    isVisible: () => true,
    restore: () => {},
    show: () => {},
    focus: () => {},
    webContents,
  };
  bridge = createBotBrowserTabBridge({ getWindows: () => [window], timeoutMs: 1000 });
  t.after(() => bridge.dispose());

  await bridge.execute({ action: 'get-tabs' }, { focusWindow: false });
  await bridge.execute({ action: 'navigate-tab', tabId: 1, uri: 'preview-metaapp://localhost/report.html', activate: true }, { focusWindow: false });

  assert.equal(sent[0].command.background, true);
  assert.equal(sent[1].command.background, false);
});
