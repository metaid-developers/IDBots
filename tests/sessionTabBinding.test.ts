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

// ---------------------------------------------------------------------------
// Fake tab bridge: a minimal ABC tab model (open/close/switch/navigate/list).
// ---------------------------------------------------------------------------

type FakeTab = { id: number; uri: string | null; title: string | null };

function createFakeTabBridge() {
  const tabs: FakeTab[] = [{ id: 1, uri: null, title: null }];
  let activeTabId = 1;
  let nextTabId = 2;
  const commands: BotBrowserTabCommand[] = [];

  const respond = (command: BotBrowserTabCommand): BotBrowserTabCommandResult => {
    const action = command.action;
    if (action === 'get-tabs') {
      return {
        action,
        tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
        activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      };
    }
    if (action === 'get-active-tab') {
      const active = tabs.find((tab) => tab.id === activeTabId) ?? null;
      return {
        action,
        tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
        activeTab: active ? { ...active, isActive: true } : null,
      };
    }
    if (action === 'open-tab') {
      const tab: FakeTab = { id: nextTabId, uri: command.uri ?? null, title: null };
      nextTabId += 1;
      tabs.push(tab);
      activeTabId = tab.id;
      return {
        action,
        openedTabId: tab.id,
        tabs: tabs.map((entry) => ({ ...entry, isActive: entry.id === activeTabId })),
        activeTab: { ...tab, isActive: true },
      };
    }
    if (action === 'switch-tab') {
      const target = Number(command.tabId);
      if (!tabs.some((tab) => tab.id === target)) {
        throw new Error(`tab ${target} does not exist`);
      }
      activeTabId = target;
      return {
        action,
        tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
        activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      };
    }
    if (action === 'navigate-tab') {
      const target = tabs.find((tab) => tab.id === Number(command.tabId));
      if (!target) throw new Error('tab does not exist');
      target.uri = command.uri ?? null;
      return {
        action,
        tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
        activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      };
    }
    if (action === 'close-tab') {
      const index = tabs.findIndex((tab) => tab.id === Number(command.tabId));
      if (index !== -1) tabs.splice(index, 1);
      if (activeTabId === Number(command.tabId)) activeTabId = tabs[0]?.id ?? 0;
      return {
        action,
        tabs: tabs.map((tab) => ({ ...tab, isActive: tab.id === activeTabId })),
        activeTab: tabs.find((tab) => tab.id === activeTabId) ?? null,
      };
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

// ---------------------------------------------------------------------------
// Fake session host: panel pointer + session list, like App's injected deps.
// ---------------------------------------------------------------------------

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
        openId = sessionId;
        return session;
      },
      listBrowserSessions: async () => summaries,
    },
  };
}

test('prepareDraftTab reuses the blank active tab without opening one', async () => {
  const bridge = createFakeTabBridge(); // initial state: one blank active tab
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

test('bindNewSession consumes the pending draft tab', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  const draftTabId = await binding.prepareDraftTab();
  assert.equal(draftTabId, 1);

  await binding.bindNewSession('session-a');
  // Reveal switches straight to the bound tab (no open needed).
  await binding.revealSessionTab('session-a');
  const switchCommands = bridge.commands.filter((command) => command.action === 'switch-tab');
  assert.equal(switchCommands.length, 1);
  assert.equal(switchCommands[0].tabId, 1);
});

test('bindNewSession re-chooses when the pending draft tab was closed', async () => {
  const bridge = createFakeTabBridge();
  bridge.tabs[0].uri = 'metaid://browse'; // the user's page tab
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  await binding.prepareDraftTab(); // opens blank tab 2, pending = 2
  await bridge.controlTabs({ action: 'close-tab', tabId: 2 }); // pending tab dies

  await binding.bindNewSession('session-a');
  await binding.revealSessionTab('session-a');
  // Fallback policy: the active tab has content, so the session got a fresh
  // tab of its own and reveal switched to it.
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
  const switchCommands = bridge.commands.filter((command) => command.action === 'switch-tab');
  assert.equal(switchCommands.length, 1);
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

test('revealSessionTab re-finds the tab by URI after the binding hint dies', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  fakeHost.setOpen('session-a');

  // A live tab already shows the session's URI (e.g. re-opened by hand).
  await bridge.controlTabs({ action: 'open-tab', uri: 'metaapp://report' });
  bridge.commands.length = 0; // only judge what the reveal itself issues

  await binding.revealSessionTab('session-a');
  assert.equal(bridge.activeTabId, 2);
  assert.ok(!bridge.commands.some((command) => command.action === 'open-tab'));
});

test('revealSessionTab opens the URI when no live tab shows it', async () => {
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

test('revealSessionTab is a no-op for a session without a browser URI', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  fakeHost.sessions.set('session-a', sessionOf('session-a', null));
  fakeHost.setOpen('session-a');

  await binding.revealSessionTab('session-a');
  assert.equal(bridge.commands.length, 0);
});

test('restoreLastSession navigates the sole blank boot tab instead of stacking', async () => {
  const bridge = createFakeTabBridge(); // fresh boot: one blank tab
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-a', sessionOf('session-a', 'metaapp://report'));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  // Pointer persistence: seed the browser-session pointer the way the panel
  // writes it. The coordinator reads it through viewState -> localStorage.
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  try {
    binding.rememberOpenSession('session-a');
    await binding.restoreLastSession();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-a']);
  const navigate = bridge.commands.find((command) => command.action === 'navigate-tab');
  assert.ok(navigate, 'expected the boot tab to be navigated');
  assert.equal(navigate.uri, 'metaapp://report');
  assert.equal(navigate.tabId, 1);
  assert.equal(bridge.tabs.length, 1);
  assert.equal(bridge.tabs[0].uri, 'metaapp://report');
});

test('restoreLastSession falls back to the freshest browser session on a stale pointer', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  fakeHost.sessions.set('session-old', sessionOf('session-old', 'metaapp://gone'));
  fakeHost.sessions.set('session-new', sessionOf('session-new', 'metaapp://latest'));
  fakeHost.summaries.push(summaryOf('session-old', 100), summaryOf('session-new', 200));
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  try {
    binding.rememberOpenSession('session-archived'); // no longer loadable
    await binding.restoreLastSession();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-archived', 'session-new']);
  const navigate = bridge.commands.find((command) => command.action === 'navigate-tab');
  assert.ok(navigate);
  assert.equal(navigate.uri, 'metaapp://latest');
});

test('restoreLastSession does nothing when no browser session exists', async () => {
  const bridge = createFakeTabBridge();
  const fakeHost = createFakeHost(bridge);
  const binding = createSessionTabBinding();
  binding.attach(fakeHost.host);

  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  try {
    await binding.restoreLastSession();
  } finally {
    delete (globalThis as { window?: unknown }).window;
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

  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  try {
    binding.rememberOpenSession('session-a');
    await binding.restoreLastSession();
    await binding.restoreLastSession();
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }

  assert.deepEqual(fakeHost.loadedSessionIds, ['session-a']);
});

test('rememberOpenSession persists the pointer and clears on null', () => {
  const store = new Map<string, string>();
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
  try {
    const binding = createSessionTabBinding();
    binding.rememberOpenSession('session-a');
    assert.deepEqual(JSON.parse(store.get('idbots.botBrowser.viewState') ?? '{}'), { sessionId: 'session-a' });
    binding.rememberOpenSession(null);
    assert.deepEqual(JSON.parse(store.get('idbots.botBrowser.viewState') ?? '{}'), { sessionId: null });
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});

// ---------------------------------------------------------------------------
// Static wiring: the four flows must stay connected to their UI entry points.
// ---------------------------------------------------------------------------

function readSource(path: string): string {
  const url = new URL(path, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

test('static wiring: shell exposes the silent tab path, App attaches + restores + reveals', () => {
  const shellSource = readSource('../src/renderer/features/botBrowser/useBotBrowserShell.ts');
  assert.match(shellSource, /const controlTabsSilent = useCallback/);
  assert.match(shellSource, /controlTabsSilent,/);

  const appSource = readSource('../src/renderer/App.tsx');
  assert.match(appSource, /sessionTabBinding\.attach\(/);
  assert.match(appSource, /botBrowserShell\.controlTabsSilent\(command\)/);
  assert.match(appSource, /command\.background === true/);
  assert.match(appSource, /sessionTabBinding\.restoreLastSession\(\)/);
  assert.match(appSource, /sessionTabBinding\.revealSessionTab\(sessionId\)/);

  const sidebarSource = readSource('../src/renderer/components/Sidebar.tsx');
  assert.match(sidebarSource, /sessionTabBinding\.prepareDraftTab\(\)/);

  const serviceSource = readSource('../src/renderer/services/browserCowork.ts');
  assert.match(serviceSource, /sessionTabBinding\.rememberOpenSession\(/);
  assert.match(serviceSource, /sessionTabBinding\.bindNewSession\(result\.session\.id\)/);
});
