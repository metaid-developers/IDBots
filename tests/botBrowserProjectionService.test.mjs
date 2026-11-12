import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { createBotBrowserProjectionService } = require('../dist-electron/main/services/botBrowserProjectionService.js');
const { createBotBrowserTabBridge } = require('../dist-electron/main/services/botBrowserTabBridge.js');

function projectionFixture() {
  const commands = [];
  const records = [];
  let activeTabId = 99;
  let openedTabId = 7;
  let includeOpenedTabId = true;
  const tabs = [
    { id: 99, uri: 'metaapp://other', title: 'Other', isActive: true },
    { id: 7, uri: null, title: null, isActive: false },
  ];
  const result = (action) => ({
    action,
    ...(includeOpenedTabId ? { openedTabId } : {}),
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
    activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
    sessionTab: tabs.find((tab) => tab.id === openedTabId) ?? null,
  });
  const execute = async (command) => {
    commands.push(command);
    if (command.activate === true) activeTabId = openedTabId;
    return result(command.action);
  };
  const recordProjection = (input) => records.push(input);
  return {
    commands,
    records,
    execute,
    recordProjection,
    result,
    set activeTabId(value) { activeTabId = value; },
    set openedTabId(value) { openedTabId = value; },
    set includeOpenedTabId(value) { includeOpenedTabId = value; },
  };
}

test('projection routes stage and report through the same session binding', async () => {
  const fixture = projectionFixture();
  const service = createBotBrowserProjectionService({
    getTabBridge: () => ({ execute: fixture.execute }),
    recordProjection: fixture.recordProjection,
  });

  const stage = await service.project({ sessionId: 'session-a', localPath: '/reports/live-stage-a.html' });
  assert.equal(stage.tabId, 7);
  assert.equal(stage.announced, false);
  assert.deepEqual(fixture.commands[0], {
    action: 'open-tab',
    uri: 'preview-metaapp://localhost/reports/live-stage-a.html',
    label: undefined,
    sessionId: 'session-a',
    tabId: undefined,
    activate: false,
  });

  const report = await service.project({
    sessionId: 'session-a',
    localPath: '/reports/final-a.html',
    title: 'Final report',
    reveal: true,
    tabId: stage.tabId,
  });
  assert.equal(report.tabId, 7);
  assert.equal(report.announced, true);
  assert.equal(fixture.commands[1].sessionId, 'session-a');
  assert.equal(fixture.commands[1].tabId, 7);
  assert.equal(fixture.commands[1].activate, true);
  assert.deepEqual(fixture.records, [
    { sessionId: 'session-a', uri: stage.uri, title: null },
    { sessionId: 'session-a', uri: report.uri, title: 'Final report' },
  ]);
});

test('a background projection can use the sessionTab result when openedTabId is absent', async () => {
  const fixture = projectionFixture();
  fixture.includeOpenedTabId = false;
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: fixture.execute }) });

  const outcome = await service.project({ sessionId: 'session-a', localPath: '/reports/stage.html' });

  assert.equal(outcome.tabId, 7);
  assert.equal(outcome.announced, false);
});

test('a new active projection is announced even when reveal was not requested', async () => {
  const fixture = projectionFixture();
  fixture.activeTabId = 7;
  const service = createBotBrowserProjectionService({ getTabBridge: () => ({ execute: fixture.execute }) });

  const outcome = await service.project({ sessionId: 'session-a', localPath: '/reports/stage.html' });

  assert.equal(outcome.announced, true);
});

test('a missing tab confirmation fails the projection', async () => {
  const fixture = projectionFixture();
  fixture.includeOpenedTabId = false;
  const service = createBotBrowserProjectionService({
    getTabBridge: () => ({
      execute: async (command) => ({ ...fixture.result(command), sessionTab: null }),
    }),
  });

  await assert.rejects(
    service.project({ sessionId: 'session-a', localPath: '/reports/stage.html' }),
    /could not be opened and confirmed/,
  );
});

test('a reveal that does not activate the bound tab is reported as a failure', async () => {
  const fixture = projectionFixture();
  const service = createBotBrowserProjectionService({
    getTabBridge: () => ({
      execute: async (command) => ({
        ...fixture.result(command),
        activeTab: { id: 99, uri: 'metaapp://other', title: 'Other', isActive: true },
      }),
    }),
  });

  await assert.rejects(
    service.project({ sessionId: 'session-a', localPath: '/reports/final.html', reveal: true }),
    /could not be opened and confirmed/,
  );
});

test('a durable-record failure does not undo a successful projection', async () => {
  const fixture = projectionFixture();
  const service = createBotBrowserProjectionService({
    getTabBridge: () => ({ execute: fixture.execute }),
    recordProjection: () => { throw new Error('database unavailable'); },
  });

  const outcome = await service.project({ sessionId: 'session-a', localPath: '/reports/stage.html' });
  assert.equal(outcome.tabId, 7);
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
