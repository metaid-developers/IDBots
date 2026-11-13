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

// ---------------------------------------------------------------------------
// Fixed stage/showcase roles (owner ruling 2026-11-12)
// ---------------------------------------------------------------------------

const STAGE_ENTRY_URI = 'preview-metaapp://localhost/app-data/live-stage/studio-live-stage-official-0123456789ab/stage.html';
const LEGACY_STAGE_URI = 'preview-metaapp://localhost/app-data/reports/live-stage-turn-1.html';

function installStageEntry(uri = STAGE_ENTRY_URI, initial?: Record<string, string>) {
  const storage = installLocalStorage(initial);
  const win = (globalThis as { window?: { electron?: unknown } }).window;
  if (win) {
    win.electron = {
      studioLiveStage: { getStageEntry: async () => ({ uri }) },
    };
  }
  return storage;
}

const flushAdoption = () => new Promise((resolve) => setTimeout(resolve, 10));

test('stage and showcase roles bind separate tabs and only the showcase page persists', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    fakeHost.sessions.set('session-a', sessionOf('session-a'));
    fakeHost.sessions.set('session-b', sessionOf('session-b'));
    fakeHost.setOpen('session-a');

    const stageOpen = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-a', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    assert.equal(stageOpen.sessionTab?.uri, STAGE_ENTRY_URI);
    const stageTabId = stageOpen.sessionTab!.id;

    const showcaseOpen = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-a', role: 'showcase', uri: 'metaapp://report', activate: true,
    });
    const showcaseTabId = showcaseOpen.sessionTab!.id;
    assert.notEqual(showcaseTabId, stageTabId, 'the two roles never share a tab');

    const stageTabs = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a', role: 'stage' });
    assert.equal(stageTabs.sessionTab?.id, stageTabId);
    const showcaseTabs = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a', role: 'showcase' });
    assert.equal(showcaseTabs.sessionTab?.id, showcaseTabId);
    // A role-less get-tabs keeps meaning the showcase tab.
    const plainTabs = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a' });
    assert.equal(plainTabs.sessionTab?.id, showcaseTabId);

    // The shared entry URI never dedupes two sessions onto one stage tab.
    fakeHost.setOpen('session-b');
    const stageOpenB = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-b', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    assert.notEqual(stageOpenB.sessionTab?.id, stageTabId, 'session-b gets its own stage tab');
    assert.equal(stageOpenB.sessionTab?.uri, STAGE_ENTRY_URI);
    const stageOpenCommand = bridge.commands.find((command) => command.action === 'open-tab' && command.uri === STAGE_ENTRY_URI);
    assert.equal(stageOpenCommand?.dedupe, false, 'the stage open always bypasses URI dedupe');

    const persisted = JSON.parse(storage.store.get('idbots.botBrowser.viewState') ?? '{}') as {
      sessionPages?: Record<string, { uri: string }>;
    };
    assert.equal(persisted.sessionPages?.['session-a']?.uri, 'metaapp://report', 'only the showcase page persists');
    assert.equal(persisted.sessionPages?.['session-b'], undefined, 'the stage role never persists a page');
  } finally {
    storage.restore();
  }
});

test('a committed active tab never moves an existing session binding', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    fakeHost.sessions.set('session-a', sessionOf('session-a'));
    fakeHost.sessions.set('session-b', sessionOf('session-b'));
    fakeHost.setOpen('session-a');

    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-a', role: 'showcase', uri: 'metaapp://report', activate: true,
    });
    const boundShowcaseId = bridge.activeTabId;

    // A brand-new unowned tab becomes active and commits a navigation: the
    // session already owns a showcase tab, so nothing may be adopted.
    await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://other' });
    const strayTabId = bridge.activeTabId;
    assert.notEqual(strayTabId, boundShowcaseId);
    binding.handleBrowserEvent(navigationCommitted(strayTabId, 'metaapp://other', 'Other'));
    await flushAdoption();

    const tabsA = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a' });
    assert.equal(tabsA.sessionTab?.id, boundShowcaseId, 'the showcase binding did not move');

    // A session holding only the stage tab is equally protected.
    fakeHost.setOpen('session-b');
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-b', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    const stageTabId = bridge.activeTabId;
    await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://other-b' });
    const strayTabIdB = bridge.activeTabId;
    binding.handleBrowserEvent(navigationCommitted(strayTabIdB, 'metaapp://other-b', 'Other B'));
    await flushAdoption();

    const tabsB = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-b' });
    assert.equal(tabsB.sessionTab, null, 'no showcase binding was adopted over the stage role');
    const stageTabsB = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-b', role: 'stage' });
    assert.equal(stageTabsB.sessionTab?.id, stageTabId, 'the stage binding is untouched');
  } finally {
    storage.restore();
  }
});

test('revealSessionTab prefers the stage tab, then opens the stage entry, and asks main to redeliver', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const shown: string[] = [];
  const storage = installStageEntry();
  const win = (globalThis as { window?: { electron?: { studioLiveStage?: Record<string, unknown> } } }).window;
  if (win?.electron?.studioLiveStage) {
    win.electron.studioLiveStage.showSession = async (sessionId: string) => {
      shown.push(sessionId);
      return { success: true };
    };
  }
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    fakeHost.sessions.set('session-a', sessionOf('session-a'));
    fakeHost.sessions.set('session-b', sessionOf('session-b'));
    fakeHost.sessions.set('session-c', sessionOf('session-c'));

    // session-a owns both roles: the STAGE tab is revealed first — the
    // showcase stays reachable through its own tab or the report button.
    fakeHost.setOpen('session-a');
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-a', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-a', role: 'showcase', uri: 'metaapp://report-a', activate: true,
    });
    const stageA = (await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a', role: 'stage' })).sessionTab!.id;
    await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://elsewhere' });
    await binding.revealSessionTab('session-a');
    assert.equal(bridge.activeTabId, stageA, 'the stage tab wins the reveal over showcase');
    assert.deepEqual(shown, ['session-a'], 'main was asked to redeliver the stage state');

    // session-b owns only the stage tab: it is revealed when no showcase exists.
    fakeHost.setOpen('session-b');
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'session-b', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    const stageB = bridge.activeTabId;
    await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://elsewhere-2' });
    await binding.revealSessionTab('session-b');
    assert.equal(bridge.activeTabId, stageB, 'the bound stage tab is revealed');
    assert.deepEqual(shown, ['session-a', 'session-b']);

    // session-c owns nothing: reveal opens the stage entry as the stage role.
    fakeHost.setOpen('session-c');
    await binding.revealSessionTab('session-c');
    const stageC = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-c', role: 'stage' });
    assert.equal(stageC.sessionTab?.uri, STAGE_ENTRY_URI, 'the persistent entry opened as the stage tab');
    assert.equal(bridge.activeTabId, stageC.sessionTab!.id);
    const showcaseC = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-c', role: 'showcase' });
    assert.equal(showcaseC.sessionTab, null, 'reveal never invents a showcase tab');
    assert.deepEqual(shown, ['session-a', 'session-b', 'session-c']);
  } finally {
    storage.restore();
  }
});

test('role switch-tab activates the bound tab only for the open session', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);
  fakeHost.sessions.set('session-a', sessionOf('session-a'));
  fakeHost.sessions.set('session-b', sessionOf('session-b'));
  fakeHost.setOpen('session-a');

  await binding.controlSessionTab({
    action: 'open-tab', sessionId: 'session-a', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
  });
  const stageTabId = bridge.activeTabId;
  await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://elsewhere' });
  assert.notEqual(bridge.activeTabId, stageTabId);

  // A different conversation is on screen: the activation is a no-op and no
  // switch command ever reaches the tab bridge.
  fakeHost.setOpen('session-b');
  const denied = await binding.controlSessionTab({ action: 'switch-tab', sessionId: 'session-a', role: 'stage' });
  assert.equal(denied.sessionTab, null);
  assert.notEqual(bridge.activeTabId, stageTabId, 'the view was not yanked to another session');
  assert.ok(!bridge.commands.some((command) => command.action === 'switch-tab'), 'no switch command reached the bridge');

  // The owning session on screen: the bound stage tab activates.
  fakeHost.setOpen('session-a');
  const activated = await binding.controlSessionTab({ action: 'switch-tab', sessionId: 'session-a', role: 'stage' });
  assert.equal(activated.sessionTab?.id, stageTabId);
  assert.equal(bridge.activeTabId, stageTabId);
});

test('a persisted stage page is never restored as the showcase tab', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installLocalStorage({
    'idbots.botBrowser.viewState': JSON.stringify({
      sessionId: null,
      sessionPages: {
        'session-a': { uri: LEGACY_STAGE_URI, title: 'Live Stage' },
        'session-b': { uri: STAGE_ENTRY_URI, title: 'Live Stage' },
      },
    }),
  });
  const win = (globalThis as { window?: { electron?: unknown } }).window;
  if (win) {
    win.electron = {
      studioLiveStage: { getStageEntry: async () => ({ uri: STAGE_ENTRY_URI }) },
    };
  }
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    fakeHost.sessions.set('session-a', sessionOf('session-a'));
    fakeHost.sessions.set('session-b', sessionOf('session-b'));

    // A legacy per-turn stage file persisted by an old build is ignored: the
    // session opens the persistent entry as its stage tab instead.
    fakeHost.setOpen('session-a');
    await binding.revealSessionTab('session-a');
    const stageA = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a', role: 'stage' });
    assert.equal(stageA.sessionTab?.uri, STAGE_ENTRY_URI);
    assert.ok(!bridge.tabs.some((tab) => tab.uri === LEGACY_STAGE_URI), 'the legacy stage file was never opened');
    const showcaseA = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-a', role: 'showcase' });
    assert.equal(showcaseA.sessionTab, null, 'no showcase tab was bound to the stage page');

    // A persisted persistent-entry URI is ignored the same way.
    fakeHost.setOpen('session-b');
    await binding.revealSessionTab('session-b');
    const stageB = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-b', role: 'stage' });
    assert.equal(stageB.sessionTab?.uri, STAGE_ENTRY_URI);
    const showcaseB = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 'session-b', role: 'showcase' });
    assert.equal(showcaseB.sessionTab, null);

    // A stage-page navigation never becomes the persisted showcase page.
    binding.handleBrowserEvent(navigationCommitted(stageA.sessionTab!.id, STAGE_ENTRY_URI));
    await flushAdoption();
    const persisted = JSON.parse(storage.store.get('idbots.botBrowser.viewState') ?? '{}') as {
      sessionPages?: Record<string, { uri: string }>;
    };
    assert.equal(persisted.sessionPages?.['session-a']?.uri, LEGACY_STAGE_URI, 'the persisted record is untouched by stage navigations');
  } finally {
    storage.restore();
  }
});

test('the stage role adopts the prewarmed draft while the session is still optimistic', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);

    // First-open draft: the pending draft tab is prewarmed onto the entry.
    const draftTabId = await binding.prepareDraftTab();
    assert.equal(draftTabId, 1);
    assert.equal(bridge.tabs[0].uri, STAGE_ENTRY_URI);

    // The owner hits send: the open session is still the optimistic
    // placeholder while main creates the real session and projects the stage.
    fakeHost.sessions.set('optimistic-browser-x', sessionOf('optimistic-browser-x'));
    fakeHost.setOpen('optimistic-browser-x');
    bridge.commands.length = 0;

    const result = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 's1', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    assert.equal(result.sessionTab?.id, draftTabId, 'the prewarmed draft became the stage tab');
    assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'), 'no second stage tab was opened');
    const stageTabs = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 's1', role: 'stage' });
    assert.equal(stageTabs.sessionTab?.id, draftTabId);
  } finally {
    storage.restore();
  }
});

test('the stage role never adopts the draft for an already-bound session', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    fakeHost.sessions.set('optimistic-browser-x', sessionOf('optimistic-browser-x'));
    fakeHost.setOpen('optimistic-browser-x');

    const draftTabId = await binding.prepareDraftTab();
    assert.equal(draftTabId, 1);

    // s2 already owns a showcase tab — it must get its own stage tab even
    // though the open session is still the optimistic placeholder.
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 's2', role: 'showcase', uri: 'metaapp://report', activate: true,
    });
    bridge.commands.length = 0;
    const result = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 's2', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    assert.notEqual(result.sessionTab?.id, draftTabId, 'a bound session never takes the draft');
    assert.equal(result.sessionTab?.uri, STAGE_ENTRY_URI);
    assert.ok(bridge.commands.some((command) => command.action === 'open-tab' && command.dedupe === false), 'a fresh stage tab was opened');
  } finally {
    storage.restore();
  }
});

// ---------------------------------------------------------------------------
// Stage Tabs unit: idempotent draft prewarm, deterministic draftClaim,
// adoption diagnostics, draft identity
// ---------------------------------------------------------------------------

test('prepareDraftTab is idempotent: concurrent and repeat calls never open a second draft', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);

    const [first, second] = await Promise.all([binding.prepareDraftTab(), binding.prepareDraftTab()]);
    assert.equal(first, second, 'concurrent callers share one draft');
    assert.equal(bridge.tabs.length, 1, 'the initial blank tab became the draft — no extra tab');
    assert.equal(bridge.tabs[0].uri, STAGE_ENTRY_URI);

    // A sequential call sees the draft already on the entry and reuses it.
    const opensBefore = bridge.commands.filter((command) => command.action === 'open-tab').length;
    const third = await binding.prepareDraftTab();
    assert.equal(third, first);
    assert.equal(bridge.commands.filter((command) => command.action === 'open-tab').length, opensBefore, 'no second draft tab opened');
  } finally {
    storage.restore();
  }
});

test('prepareDraftTab reuses an unowned active tab already on the stage entry', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    // Simulate a leftover unowned stage-entry tab (e.g. after a renderer reset):
    // no pendingDraftTabId is known, but the ACTIVE tab sits on the entry.
    await bridge.controlTabs({ action: 'navigate-tab', tabId: 1, uri: STAGE_ENTRY_URI });
    const tabId = await binding.prepareDraftTab();
    assert.equal(tabId, 1, 'the entry tab was reused as the draft');
    assert.equal(bridge.tabs.length, 1, 'no second tab was opened');
  } finally {
    storage.restore();
  }
});

test('draftClaim adopts the pending draft with an optimistic, null, or foreign open session', async () => {
  for (const openId of ['optimistic-browser-x', null, 'other-session']) {
    const bridge = createFakeTabBridge();
    const fakeHost = createFakeHost(bridge);
    const storage = installStageEntry();
    try {
      const binding = createSessionTabBinding();
      binding.attach(fakeHost.host);
      if (openId === 'other-session') {
        fakeHost.sessions.set('other-session', sessionOf('other-session'));
        fakeHost.setOpen('other-session');
      } else if (openId) {
        fakeHost.sessions.set(openId, sessionOf(openId));
        fakeHost.setOpen(openId);
      }
      const draftTabId = await binding.prepareDraftTab();
      assert.equal(draftTabId, 1);
      bridge.commands.length = 0;

      const result = await binding.controlSessionTab({
        action: 'open-tab', sessionId: 's1', role: 'stage', uri: STAGE_ENTRY_URI, activate: true, draftClaim: true,
      });
      assert.equal(result.sessionTab?.id, draftTabId, `draft adopted with open=${openId}`);
      assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'), `no second stage tab with open=${openId}`);
    } finally {
      storage.restore();
    }
  }
});

test('an old session background projection never adopts the draft without draftClaim', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    // Another conversation is on screen and 'old' is fully bound already.
    fakeHost.sessions.set('other-session', sessionOf('other-session'));
    fakeHost.setOpen('other-session');
    fakeHost.sessions.set('old', sessionOf('old'));
    await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'old', role: 'showcase', uri: 'metaapp://old-report', activate: true,
    });
    const draftTabId = await binding.prepareDraftTab();
    assert.equal(draftTabId > 0, true);
    bridge.commands.length = 0;

    const result = await binding.controlSessionTab({
      action: 'open-tab', sessionId: 'old', role: 'stage', uri: STAGE_ENTRY_URI, activate: true,
    });
    assert.notEqual(result.sessionTab?.id, draftTabId, 'a bound session keeps its own stage tab');
    assert.ok(bridge.commands.some((command) => command.action === 'open-tab' && command.dedupe === false), 'a fresh stage tab opened');
  } finally {
    storage.restore();
  }
});

test('bindNewSession adopts the pending draft unconditionally for the new session', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const storage = installStageEntry();
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    // A DIFFERENT session is on screen when the draft is claimed — bindNewSession
    // still hands the draft to the brand-new session.
    fakeHost.sessions.set('other-session', sessionOf('other-session'));
    fakeHost.setOpen('other-session');
    const draftTabId = await binding.prepareDraftTab();
    assert.equal(draftTabId, 1);
    bridge.commands.length = 0;

    await binding.bindNewSession('s-new');
    const stage = await binding.controlSessionTab({ action: 'get-tabs', sessionId: 's-new', role: 'stage' });
    assert.equal(stage.sessionTab?.id, draftTabId, 'the draft became the new session stage');
    assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'), 'no second stage tab opened');
  } finally {
    storage.restore();
  }
});

test('prepareDraftIdentity patches the draft frame with the selected bot after prewarm', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const drafts: Array<{ tabId: number; metabotId: number | null }> = [];
  const storage = installStageEntry();
  const win = (globalThis as { window?: { electron?: { studioLiveStage?: Record<string, unknown> } } }).window;
  if (win?.electron?.studioLiveStage) {
    win.electron.studioLiveStage.prepareDraft = async (input: { tabId: number; metabotId?: number | null }) => {
      drafts.push({ tabId: input.tabId, metabotId: input.metabotId ?? null });
      return { success: true };
    };
  }
  try {
    const binding = createSessionTabBinding();
    binding.attach(fakeHost.host);
    await binding.prepareDraftIdentity(7);
    assert.deepEqual(drafts, [{ tabId: 1, metabotId: 7 }], 'the draft identity patch targeted the draft tab');

    // A bot-selection change re-patches the same draft — idempotent, no new tab.
    await binding.prepareDraftIdentity(9);
    assert.deepEqual(drafts.at(-1), { tabId: 1, metabotId: 9 });
    assert.equal(bridge.tabs.length, 1);
  } finally {
    storage.restore();
  }
});
