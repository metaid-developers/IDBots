import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { createSessionTabBinding } from '../src/renderer/services/sessionTabBinding';
import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
} from '../src/renderer/features/botBrowser/types';
import type {
  CoworkSession,
  CoworkSessionSummary,
} from '../src/renderer/types/cowork';

type FakeTab = { id: number; uri: string | null; title: string | null };

function createFakeTabBridge() {
  const tabs: FakeTab[] = [{ id: 1, uri: null, title: null }];
  let activeTabId = 1;
  let nextTabId = 2;
  const commands: BotBrowserTabCommand[] = [];

  const snapshot = (action: BotBrowserTabCommand['action'], openedTabId?: number): BotBrowserTabCommandResult => ({
    action,
    ...(openedTabId == null ? {} : { openedTabId }),
    tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
    activeTab: tabs.find((tab) => tab.id === activeTabId)
      ? { ...tabs.find((tab) => tab.id === activeTabId)!, isActive: true }
      : null,
  });

  const respond = (command: BotBrowserTabCommand): BotBrowserTabCommandResult => {
    const action = command.action;
    if (action === 'get-tabs' || action === 'get-active-tab') return snapshot(action);
    if (action === 'open-tab') {
      if (command.uri && command.dedupe !== false) {
        const existing = tabs.find((tab) => tab.uri === command.uri);
        if (existing) {
          activeTabId = existing.id;
          return snapshot(action, existing.id);
        }
      }
      const tab: FakeTab = { id: nextTabId++, uri: command.uri ?? null, title: command.label ?? null };
      tabs.push(tab);
      activeTabId = tab.id;
      return snapshot(action, tab.id);
    }
    if (action === 'switch-tab') {
      const target = Number(command.tabId);
      if (!tabs.some((tab) => tab.id === target)) throw new Error(`tab ${target} does not exist`);
      activeTabId = target;
      return snapshot(action);
    }
    if (action === 'navigate-tab') {
      const target = tabs.find((tab) => tab.id === Number(command.tabId));
      if (!target) throw new Error('tab does not exist');
      target.uri = command.uri ?? null;
      if (command.activate === true) activeTabId = target.id;
      return snapshot(action);
    }
    if (action === 'close-tab') {
      const index = tabs.findIndex((tab) => tab.id === Number(command.tabId));
      if (index !== -1) tabs.splice(index, 1);
      if (!tabs.length) tabs.push({ id: nextTabId++, uri: null, title: null });
      if (activeTabId === Number(command.tabId)) activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? tabs[0].id;
      return snapshot(action);
    }
    throw new Error(`unsupported action: ${action}`);
  };

  return {
    commands,
    tabs,
    get activeTabId() {
      return activeTabId;
    },
    controlTabs: async (command: BotBrowserTabCommand) => {
      commands.push(command);
      return respond(command);
    },
  };
}

function sessionOf(id: string, browserUri?: string | null): CoworkSession {
  return {
    id,
    title: `Session ${id}`,
    messages: [],
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    sessionType: 'browser',
    browserUri: browserUri ?? null,
    browserTitle: null,
  } as unknown as CoworkSession;
}

function summaryOf(id: string, updatedAt: number): CoworkSessionSummary {
  return {
    id,
    title: `Session ${id}`,
    updatedAt,
    sessionType: 'browser',
  } as unknown as CoworkSessionSummary;
}

function createFakeHost(bridge: ReturnType<typeof createFakeTabBridge>) {
  const sessions = new Map<string, CoworkSession>();
  const summaries: CoworkSessionSummary[] = [];
  const loadedSessionIds: string[] = [];
  let openId: string | null = null;
  return {
    sessions,
    summaries,
    loadedSessionIds,
    setOpen(id: string | null) {
      openId = id;
    },
    host: {
      controlTabs: bridge.controlTabs,
      getOpenSession: () => (openId ? sessions.get(openId) ?? null : null),
      openSession: async (sessionId: string) => {
        loadedSessionIds.push(sessionId);
        const session = sessions.get(sessionId) ?? null;
        openId = session ? sessionId : null;
        return session;
      },
      listBrowserSessions: async () => summaries,
    },
  };
}

function installLocalStorage(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  return {
    store,
    restore() {
      delete (globalThis as { window?: unknown }).window;
    },
  };
}

function navigationCommitted(tabId: number, uri: string, title = 'Page') {
  return {
    type: 'agent-browser:event',
    version: 1,
    event: 'navigation-committed',
    payload: { tabId, uri, title },
  } as const;
}

test('prepareDraftTab reuses the blank active tab without opening one', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);

  const tabId = await binding.prepareDraftTab();

  assert.equal(tabId, 1);
  assert.equal(bridge.tabs.length, 1);
  assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'));
});

test('prepareDraftTab opens a fresh tab when the active tab carries a page', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaapp://abc';
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);

  const tabId = await binding.prepareDraftTab();

  assert.equal(tabId, 2);
  assert.equal(bridge.tabs.length, 2);
  assert.equal(bridge.tabs[1].uri, null);
  assert.equal(bridge.activeTabId, 2);
});

test('prepareDraftTab does not steal another session blank tab', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);
  await binding.bindNewSession('session-a');

  const tabId = await binding.prepareDraftTab();

  assert.equal(tabId, 2);
  assert.equal(bridge.activeTabId, 2);
});

test('bindNewSession consumes the pending draft tab', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  const draftTabId = await binding.prepareDraftTab();
  assert.equal(draftTabId, 1);
  await binding.bindNewSession('session-a');
  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 1);
  assert.equal(bridge.activeTabId, 1);
  assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'));
  const result = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a' });
  assert.equal(result.sessionTab?.id, 1);
});

test('bindNewSession re-chooses when the pending draft tab was closed', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaid://browse';
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);

  await binding.prepareDraftTab();
  await bridge.controlTabs({ action: 'close-tab', tabId: 2 });
  await binding.bindNewSession('session-a');
  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 2);
  assert.equal(bridge.activeTabId, 3);
});

test('bindNewSession without a pending draft reuses a blank active tab', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);

  await binding.bindNewSession('session-a');
  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 1);
  assert.equal(bridge.activeTabId, 1);
});

test('bindNewSession without a pending draft opens a tab when the active one has content', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaapp://xyz';
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);

  await binding.bindNewSession('session-a');
  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 2);
  assert.equal(bridge.tabs[1].uri, null);
});

test('revealSessionTab re-finds an unowned tab by the durable URI after a renderer reset', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  fakeHost.setOpen('session-a');
  await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://report' });
  bridge.commands.length = 0;

  await binding.revealSessionTab('session-a');

  assert.equal(bridge.activeTabId, 2);
  assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'));
});

test('revealSessionTab opens the last URI when no live tab shows it', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaid://browse';
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  fakeHost.setOpen('session-a');

  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 2);
  assert.equal(bridge.tabs[1].uri, 'metaapp://report');
  assert.equal(bridge.activeTabId, 2);
});

test('revealSessionTab still binds a blank tab for a legacy session without a URI', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaid://other-session';
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  fakeHost.sessions.set('session-a', sessionOf('session-a', null));
  fakeHost.setOpen('session-a');

  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 2);
  assert.equal(bridge.tabs[1].uri, null);
  assert.equal(bridge.activeTabId, 2);
});

test('projection reuses each session tab and background updates do not steal activation', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a'));
  fakeHost.sessions.set('session-b', sessionOf('session-b'));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  fakeHost.setOpen('session-a');
  await binding.bindNewSession('session-a');
  const stageA = await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-a',
    uri: 'preview-metaapp://localhost/reports/stage-a.html',
    activate: false,
  });
  assert.equal(stageA.sessionTab?.id, 1);
  assert.equal(bridge.tabs.length, 1);

  await binding.prepareDraftTab();
  fakeHost.setOpen('session-b');
  await binding.bindNewSession('session-b');
  await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-b',
    uri: 'preview-metaapp://localhost/reports/stage-b.html',
    activate: false,
  });
  assert.equal(bridge.activeTabId, 2);

  const backgroundA = await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-a',
    tabId: 1,
    uri: 'preview-metaapp://localhost/reports/report-a.html',
    activate: false,
  });
  assert.equal(backgroundA.sessionTab?.id, 1);
  assert.equal(backgroundA.activeTab?.id, 2);
  assert.equal(bridge.activeTabId, 2);
  assert.equal(bridge.tabs.length, 2);

  await binding.revealSessionTab('session-a');
  assert.equal(bridge.activeTabId, 1);
  assert.equal(bridge.tabs[0].uri, 'preview-metaapp://localhost/reports/report-a.html');
  await binding.revealSessionTab('session-b');
  assert.equal(bridge.activeTabId, 2);
  assert.equal(bridge.tabs[1].uri, 'preview-metaapp://localhost/reports/stage-b.html');
});

test('a closed session tab is recreated with its last projection URI', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);
  await binding.bindNewSession('session-a');
  await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-a',
    uri: 'preview-metaapp://localhost/reports/final-a.html',
    activate: true,
  });
  await bridge.controlTabs({ action: 'close-tab', tabId: 1 });

  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs.length, 1);
  assert.equal(bridge.tabs[0].uri, 'preview-metaapp://localhost/reports/final-a.html');
  assert.equal(bridge.activeTabId, bridge.tabs[0].id);
});

test('navigation-committed replaces the durable page and a closed tab restores it', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);
  await binding.bindNewSession('session-a');
  binding.handleBrowserEvent(navigationCommitted(1, 'metaapp://latest', 'Latest'));
  await bridge.controlTabs({ action: 'close-tab', tabId: 1 });

  await binding.revealSessionTab('session-a');

  assert.equal(bridge.tabs[0].uri, 'metaapp://latest');
  assert.equal(bridge.activeTabId, bridge.tabs[0].id);
});

test('two sessions can own different tabs with the same URI', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);
  await binding.bindNewSession('session-a');
  await binding.controlSessionTab({ action: 'open-tab', sessionId: 'session-a', uri: 'metaapp://shared', activate: true });
  await binding.prepareDraftTab();
  await binding.bindNewSession('session-b');
  await binding.controlSessionTab({ action: 'open-tab', sessionId: 'session-b', uri: 'metaapp://shared', activate: true });
  await bridge.controlTabs({ action: 'close-tab', tabId: 2 });
  assert.equal(bridge.activeTabId, 1);

  await binding.revealSessionTab('session-b');

  assert.equal(bridge.tabs.length, 2);
  assert.notEqual(bridge.activeTabId, 1);
  assert.equal(bridge.tabs[0].uri, 'metaapp://shared');
  assert.equal(bridge.tabs[1].uri, 'metaapp://shared');
  assert.ok(bridge.commands.some((command) => command.action === 'open-tab' && command.dedupe === false));
});

test('get-tabs returns the session tab rather than mistaking the active tab for it', async () => {
  const bridge = createFakeTabBridge();
  const binding = createSessionTabBinding();
  binding.attach(createFakeHost(bridge).host);
  await binding.bindNewSession('session-a');
  await binding.prepareDraftTab();
  await binding.bindNewSession('session-b');
  assert.equal(bridge.activeTabId, 2);

  const result = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a' });

  assert.equal(result.activeTab?.id, 2);
  assert.equal(result.sessionTab?.id, 1);
});

test('background projection cannot consume a pending new-conversation draft tab', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a'));
  fakeHost.sessions.set('session-b', sessionOf('session-b'));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  fakeHost.setOpen('session-a');
  await binding.bindNewSession('session-a');
  await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-a',
    uri: 'preview-metaapp://localhost/reports/stage-a.html',
    activate: true,
  });
  await bridge.controlTabs({ action: 'close-tab', tabId: 1 });
  fakeHost.setOpen(null);
  const draftTabId = await binding.prepareDraftTab();

  const projected = await binding.controlSessionTab({
    action: 'open-tab',
    sessionId: 'session-a',
    uri: 'preview-metaapp://localhost/reports/report-a.html',
    activate: false,
  });

  assert.notEqual(projected.sessionTab?.id, draftTabId);
  assert.equal(bridge.activeTabId, draftTabId);
  assert.equal(bridge.tabs.find((tab) => tab.id === draftTabId)?.uri, null);
  fakeHost.setOpen('session-b');
  await binding.bindNewSession('session-b');
  const draft = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-b' });
  assert.equal(draft.sessionTab?.id, draftTabId);
});

test('a user-opened active MetaApp becomes the open session tab after navigation commits', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a'));
  fakeHost.setOpen('session-a');
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://from-chat' });
  binding.handleBrowserEvent(navigationCommitted(2, 'metaapp://from-chat', 'From chat'));
  await new Promise((resolve) => setTimeout(resolve, 10));

  const result = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a' });
  assert.equal(result.sessionTab?.id, 2);
  await bridge.controlTabs({ action: 'close-tab', tabId: 2 });
  await binding.revealSessionTab('session-a');
  assert.equal(bridge.tabs.find((tab) => tab.id === bridge.activeTabId)?.uri, 'metaapp://from-chat');
});

test('restoreLastSession navigates the sole blank boot tab instead of stacking', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  const storage = installLocalStorage();
  try {
    binding.rememberOpenSession('session-a');
    await binding.restoreLastSession();
  } finally {
    storage.restore();
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-a']);
  const navigate = bridge.commands.find((command) => command.action === 'navigate-tab');
  assert.ok(navigate);
  assert.equal(navigate.uri, 'metaapp://report');
  assert.equal(navigate.tabId, 1);
  assert.equal(bridge.tabs.length, 1);
  assert.equal(bridge.tabs[0].uri, 'metaapp://report');
});

test('restart restores the last committed page persisted independently of browserUri', async () => {
  const storage = installLocalStorage();
  try {
    const firstBridge = createFakeTabBridge();
    const firstHost = createFakeHost(firstBridge);
    firstHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://stale'));
    firstHost.setOpen('session-a');
    const firstBinding = createSessionTabBinding();
    firstBinding.attach(firstHost.host);
    await firstBinding.bindNewSession('session-a');
    firstBinding.handleBrowserEvent(navigationCommitted(1, 'preview-metaapp://localhost/reports/final.html', 'Final'));
    firstBinding.rememberOpenSession('session-a');

    const restartedBridge = createFakeTabBridge();
    const restartedHost = createFakeHost(restartedBridge);
    restartedHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://stale'));
    const restartedBinding = createSessionTabBinding();
    restartedBinding.attach(restartedHost.host);
    await restartedBinding.restoreLastSession();

    assert.equal(restartedBridge.tabs.length, 1);
    assert.equal(restartedBridge.tabs[0].uri, 'preview-metaapp://localhost/reports/final.html');
    assert.equal(restartedBridge.activeTabId, 1);
  } finally {
    storage.restore();
  }
});

test('restoreLastSession falls back to the freshest browser session on a stale pointer', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-old', sessionOf('session-old', 'metaapp://gone'));
  fakeHost.sessions.set('session-new', sessionOf('session-new', 'metaapp://latest'));
  fakeHost.summaries.push(summaryOf('session-old', 100), summaryOf('session-new', 200));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  const storage = installLocalStorage();
  try {
    binding.rememberOpenSession('session-archived');
    await binding.restoreLastSession();
  } finally {
    storage.restore();
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-archived', 'session-new']);
  const navigate = bridge.commands.find((command) => command.action === 'navigate-tab');
  assert.equal(navigate?.uri, 'metaapp://latest');
});

test('restoreLastSession does nothing when no browser session exists', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  const storage = installLocalStorage();
  try {
    await binding.restoreLastSession();
  } finally {
    storage.restore();
  }

  assert.deepEqual(fakeHost.loadedSessionIds, []);
  assert.equal(bridge.commands.length, 0);
});

test('restoreLastSession runs exactly once per binding instance', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  const storage = installLocalStorage();
  try {
    binding.rememberOpenSession('session-a');
    await binding.restoreLastSession();
    await binding.restoreLastSession();
  } finally {
    storage.restore();
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-a']);
});

test('session pointer updates preserve durable pages and null only clears the pointer', async () => {
  const storage = installLocalStorage();
  try {
    const bridge = createFakeTabBridge();
    const binding = createSessionTabBinding();
    binding.attach(createFakeHost(bridge).host);
    binding.rememberOpenSession('session-a');
    await binding.bindNewSession('session-a');
    binding.handleBrowserEvent(navigationCommitted(1, 'metaapp://latest', 'Latest'));
    let state = JSON.parse(storage.store.get('idbots.botBrowser.viewState') ?? '{}');
    assert.equal(state.sessionId, 'session-a');
    assert.deepEqual(state.sessionPages['session-a'], { uri: 'metaapp://latest', title: 'Latest' });

    binding.rememberOpenSession(null);
    state = JSON.parse(storage.store.get('idbots.botBrowser.viewState') ?? '{}');
    assert.equal(state.sessionId, null);
    assert.deepEqual(state.sessionPages['session-a'], { uri: 'metaapp://latest', title: 'Latest' });
  } finally {
    storage.restore();
  }
});

function readSource(path: string): string {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

test('static wiring: selection, projection, launch, and browser events share the binding', () => {
  const shellSource = readSource('../src/renderer/features/botBrowser/useBotBrowserShell.ts');
  assert.match(shellSource, /const controlTabsSilent = useCallback/);
  assert.match(shellSource, /controlTabsSilent,/);

  const appSource = readSource('../src/renderer/App.tsx');
  assert.match(appSource, /sessionTabBinding\.attach\(/);
  assert.match(appSource, /botBrowserShell\.controlTabsSilent\(command\)/);
  assert.match(appSource, /command\.background === true/);
  assert.match(appSource, /sessionTabBinding\.restoreLastSession\(\)/);
  assert.match(appSource, /sessionTabBinding\.revealSessionTab\(sessionId\)/);
  assert.match(appSource, /sessionTabBinding\.controlSessionTab\(/);
  assert.match(appSource, /onBrowserEvent=\{sessionTabBinding\.handleBrowserEvent\}/);

  const panelSource = readSource('../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx');
  assert.match(panelSource, /await sessionTabBinding\.revealSessionTab\(sessionId\)/);

  const sidebarSource = readSource('../src/renderer/components/Sidebar.tsx');
  assert.match(sidebarSource, /sessionTabBinding\.prepareDraftTab\(\)/);

  const serviceSource = readSource('../src/renderer/services/browserCowork.ts');
  assert.match(serviceSource, /sessionTabBinding\.rememberOpenSession\(/);
  assert.match(serviceSource, /sessionTabBinding\.bindNewSession\(result\.session\.id\)/);

  const projectionSource = readSource('../src/main/services/botBrowserProjectionService.ts');
  assert.match(projectionSource, /sessionId: input\.sessionId/);
});
