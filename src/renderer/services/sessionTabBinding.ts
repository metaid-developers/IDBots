import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
  BotBrowserTabInfo,
} from '../features/botBrowser/types';
import type { CoworkSession, CoworkSessionSummary } from '../types/cowork';
import {
  loadPersistedBrowserSessionId,
  loadPersistedBrowserSessionPages,
  savePersistedBrowserSessionId,
  savePersistedBrowserSessionPage,
  type PersistedBrowserSessionPage,
} from './viewState';

/**
 * One live Bot Browser tab per Studio session. Tab ids are runtime-only; the
 * last committed URI is persisted per session and `browserUri` remains the
 * fallback for sessions saved by older builds.
 */
export interface SessionTabHost {
  controlTabs(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
  getOpenSession(): CoworkSession | null;
  openSession(sessionId: string): Promise<CoworkSession | null>;
  listBrowserSessions(): Promise<CoworkSessionSummary[]>;
}

export type SessionBrowserEvent = {
  type?: 'agent-browser:event';
  version?: 1;
  event?: unknown;
  payload?: {
    tabId?: unknown;
    uri?: unknown;
    title?: unknown;
  } | null;
};

export interface SessionTabBinding {
  attach(host: SessionTabHost): void;
  rememberOpenSession(sessionId: string | null): void;
  prepareDraftTab(): Promise<number | null>;
  bindNewSession(sessionId: string): Promise<void>;
  revealSessionTab(sessionId: string): Promise<void>;
  restoreLastSession(): Promise<void>;
  controlSessionTab(
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult>;
  handleBrowserEvent(message: SessionBrowserEvent): void;
}

const MAX_BOUND_TABS = 200;

const uriOf = (tab: BotBrowserTabInfo | null | undefined): string =>
  String(tab?.uri ?? '').trim();

const titleOf = (tab: BotBrowserTabInfo | null | undefined): string | null => {
  const title = String(tab?.title ?? '').trim();
  return title || null;
};

const isBlank = (tab: BotBrowserTabInfo | null | undefined): boolean => !uriOf(tab);

export function createSessionTabBinding(): SessionTabBinding {
  let host: SessionTabHost | null = null;
  let pendingDraftTabId: number | null = null;
  const sessionTabs = new Map<string, number>();
  const sessionPages = new Map<string, PersistedBrowserSessionPage>();
  let pagesLoaded = false;
  let restoreStarted = false;
  let queue: Promise<void> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  const ensurePagesLoaded = (): void => {
    if (pagesLoaded) return;
    pagesLoaded = true;
    for (const [sessionId, page] of Object.entries(loadPersistedBrowserSessionPages())) {
      sessionPages.set(sessionId, page);
    }
  };

  const pageFor = (sessionId: string): PersistedBrowserSessionPage | null => {
    ensurePagesLoaded();
    const persisted = sessionPages.get(sessionId);
    if (persisted) return persisted;
    const open = host?.getOpenSession();
    if (open?.id !== sessionId) return null;
    const uri = String(open.browserUri ?? '').trim();
    if (!uri) return null;
    return { uri, title: String(open.browserTitle ?? '').trim() || null };
  };

  const rememberPage = (sessionId: string, uri: string, title?: string | null): void => {
    ensurePagesLoaded();
    const normalizedUri = uri.trim();
    if (!normalizedUri) return;
    const normalizedTitle = title?.trim() || null;
    const previous = sessionPages.get(sessionId);
    if (previous?.uri === normalizedUri && previous.title === normalizedTitle) return;
    sessionPages.delete(sessionId);
    const page = { uri: normalizedUri, title: normalizedTitle };
    sessionPages.set(sessionId, page);
    while (sessionPages.size > MAX_BOUND_TABS) {
      const oldest = sessionPages.keys().next();
      if (oldest.done) break;
      sessionPages.delete(oldest.value);
    }
    savePersistedBrowserSessionPage(sessionId, page);
  };

  const ownerOfTab = (tabId: number): string | null => {
    for (const [sessionId, boundTabId] of sessionTabs) {
      if (boundTabId === tabId) return sessionId;
    }
    return null;
  };

  const rememberTab = (sessionId: string, tabId: number): void => {
    const previousOwner = ownerOfTab(tabId);
    if (previousOwner && previousOwner !== sessionId) sessionTabs.delete(previousOwner);
    sessionTabs.delete(sessionId);
    sessionTabs.set(sessionId, tabId);
    while (sessionTabs.size > MAX_BOUND_TABS) {
      const oldest = sessionTabs.keys().next();
      if (oldest.done) break;
      sessionTabs.delete(oldest.value);
    }
  };

  const controlTabs = async (
    command: BotBrowserTabCommand,
  ): Promise<BotBrowserTabCommandResult | null> => {
    if (!host) return null;
    try {
      return await host.controlTabs(command);
    } catch {
      return null;
    }
  };

  const listTabs = async (): Promise<BotBrowserTabCommandResult | null> =>
    controlTabs({ action: 'get-tabs' });

  const liveBoundTab = (
    sessionId: string,
    tabs: BotBrowserTabInfo[],
  ): BotBrowserTabInfo | null => {
    const tabId = sessionTabs.get(sessionId);
    if (tabId == null) return null;
    const tab = tabs.find((entry) => entry.id === tabId) ?? null;
    if (!tab) sessionTabs.delete(sessionId);
    return tab;
  };

  const canAdopt = (
    sessionId: string,
    tab: BotBrowserTabInfo,
    uri: string,
  ): boolean => {
    const owner = ownerOfTab(tab.id);
    if (owner && owner !== sessionId) return false;
    if (isBlank(tab) || uriOf(tab) === uri) return true;
    const lastPage = pageFor(sessionId);
    return lastPage?.uri === uriOf(tab);
  };

  const finish = async (
    action: BotBrowserTabCommand['action'],
    tabId: number,
    fallback: BotBrowserTabCommandResult,
  ): Promise<BotBrowserTabCommandResult> => {
    const snapshot = await listTabs();
    const result = snapshot ?? fallback;
    const sessionTab = result.tabs.find((tab) => tab.id === tabId)
      ?? (result.activeTab?.id === tabId ? result.activeTab : null);
    return {
      ...result,
      action,
      openedTabId: tabId,
      sessionTab,
    };
  };

  const ensureSessionTab = async (input: {
    sessionId: string;
    action: 'open-tab' | 'navigate-tab';
    uri?: string;
    label?: string;
    hintTabId?: number;
    activate: boolean;
    matchByUri: boolean;
  }): Promise<BotBrowserTabCommandResult> => {
    const snapshot = await listTabs();
    if (!snapshot) throw new Error('Bot Browser tabs are not available.');
    const tabs = snapshot.tabs;
    const activeBefore = snapshot.activeTab ?? tabs.find((tab) => tab.isActive) ?? null;
    const uri = input.uri?.trim() ?? '';
    let target = liveBoundTab(input.sessionId, tabs);

    if (!target && input.hintTabId != null) {
      const hinted = tabs.find((tab) => tab.id === input.hintTabId) ?? null;
      if (hinted && canAdopt(input.sessionId, hinted, uri)) target = hinted;
    }

    if (!target && uri && input.matchByUri) {
      target = tabs.find((tab) => (
        uriOf(tab).toLowerCase() === uri.toLowerCase()
        && canAdopt(input.sessionId, tab, uri)
      )) ?? null;
    }

    const canUsePendingDraft = !pageFor(input.sessionId)
      || host?.getOpenSession()?.id === input.sessionId;
    if (!target && pendingDraftTabId != null) {
      const pending = tabs.find((tab) => tab.id === pendingDraftTabId) ?? null;
      if (pending) {
        const owner = ownerOfTab(pending.id);
        if (canUsePendingDraft && (!owner || owner === input.sessionId)) target = pending;
      } else {
        pendingDraftTabId = null;
      }
    }

    if (!target) {
      const activeBlank = activeBefore && isBlank(activeBefore) ? activeBefore : null;
      const canUseBlank = (tab: BotBrowserTabInfo): boolean => (
        (tab.id !== pendingDraftTabId || canUsePendingDraft)
        && canAdopt(input.sessionId, tab, uri)
      );
      if (activeBlank && canUseBlank(activeBlank)) {
        target = activeBlank;
      } else if (tabs.length === 1 && isBlank(tabs[0]) && canUseBlank(tabs[0])) {
        target = tabs[0];
      }
    }

    let fallback = snapshot;
    if (target) {
      rememberTab(input.sessionId, target.id);
      if (pendingDraftTabId === target.id) pendingDraftTabId = null;
      if (uri && uriOf(target) !== uri) {
        const navigated = await controlTabs({
          action: 'navigate-tab',
          tabId: target.id,
          uri,
          activate: input.activate,
        });
        if (!navigated) throw new Error(`Bot Browser tab ${target.id} could not be navigated.`);
        fallback = navigated;
      } else if (input.activate && !target.isActive) {
        const switched = await controlTabs({ action: 'switch-tab', tabId: target.id });
        if (!switched) throw new Error(`Bot Browser tab ${target.id} could not be activated.`);
        fallback = switched;
      }
    } else {
      const uriOwnedByAnotherSession = uri && tabs.some((tab) => {
        const owner = ownerOfTab(tab.id);
        return uriOf(tab).toLowerCase() === uri.toLowerCase()
          && owner != null
          && owner !== input.sessionId;
      });
      const opened = await controlTabs({
        action: 'open-tab',
        ...(uri ? { uri } : {}),
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        ...(uriOwnedByAnotherSession ? { dedupe: false } : {}),
      });
      const tabId = opened?.openedTabId ?? opened?.activeTab?.id ?? null;
      if (!opened || tabId == null) throw new Error('The session tab could not be opened.');
      rememberTab(input.sessionId, tabId);
      if (pendingDraftTabId === tabId) pendingDraftTabId = null;
      fallback = opened;
      target = opened.tabs.find((tab) => tab.id === tabId)
        ?? (opened.activeTab?.id === tabId ? opened.activeTab : null);
      if (!input.activate && activeBefore && activeBefore.id !== tabId) {
        const restored = await controlTabs({ action: 'switch-tab', tabId: activeBefore.id });
        if (restored) fallback = restored;
      }
    }

    if (!target) throw new Error('The session tab could not be confirmed.');
    const committedUri = uri || uriOf(target);
    if (committedUri) rememberPage(input.sessionId, committedUri, titleOf(target));
    return finish(input.action, target.id, fallback);
  };

  const prepareDraftTab = (): Promise<number | null> => enqueue(async () => {
    try {
      const snapshot = await listTabs();
      const active = snapshot?.activeTab ?? null;
      const reusableBlank = active && isBlank(active) && (
        pendingDraftTabId === active.id || ownerOfTab(active.id) == null
      );
      if (reusableBlank) {
        pendingDraftTabId = active.id;
        return active.id;
      }
      const opened = await controlTabs({ action: 'open-tab' });
      pendingDraftTabId = opened?.openedTabId ?? opened?.activeTab?.id ?? null;
      return pendingDraftTabId;
    } catch {
      pendingDraftTabId = null;
      return null;
    }
  });

  const bindNewSession = (sessionId: string): Promise<void> => enqueue(async () => {
    try {
      await ensureSessionTab({
        sessionId,
        action: 'open-tab',
        uri: pageFor(sessionId)?.uri,
        activate: true,
        matchByUri: true,
      });
    } catch {
      // The next projection or selection retries the binding.
    }
  });

  const reveal = async (sessionId: string): Promise<void> => {
    await ensureSessionTab({
      sessionId,
      action: 'open-tab',
      uri: pageFor(sessionId)?.uri,
      activate: true,
      matchByUri: true,
    });
  };

  const revealSessionTab = (sessionId: string): Promise<void> => enqueue(async () => {
    try {
      await reveal(sessionId);
    } catch {
      // Session selection remains usable when the Browser bridge is unavailable.
    }
  });

  const restoreLastSession = (): Promise<void> => {
    if (restoreStarted) return Promise.resolve();
    restoreStarted = true;
    return enqueue(async () => {
      try {
        if (!host) return;
        let sessionId = loadPersistedBrowserSessionId();
        let session = sessionId ? await host.openSession(sessionId) : null;
        if (!session) {
          const candidates = (await host.listBrowserSessions())
            .filter((entry) => entry.sessionType === 'browser')
            .sort((a, b) => Number(b.updatedAt ?? 0) - Number(a.updatedAt ?? 0));
          sessionId = candidates[0]?.id ?? null;
          session = sessionId ? await host.openSession(sessionId) : null;
        }
        if (!session) return;
        await reveal(session.id);
      } catch {
        // Boot never fails because a convenience restore could not load a tab.
      }
    });
  };

  const sessionSnapshot = async (
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult> => {
    const snapshot = await listTabs();
    if (!snapshot) throw new Error('Bot Browser tabs are not available.');
    let sessionTab = liveBoundTab(command.sessionId, snapshot.tabs);
    if (!sessionTab) {
      const lastPage = pageFor(command.sessionId);
      if (lastPage) {
        sessionTab = snapshot.tabs.find((tab) => (
          uriOf(tab) === lastPage.uri && canAdopt(command.sessionId, tab, lastPage.uri)
        )) ?? null;
        if (sessionTab) rememberTab(command.sessionId, sessionTab.id);
      }
    }
    return {
      ...snapshot,
      action: command.action,
      sessionTab,
    };
  };

  const controlSessionTab = (
    command: BotBrowserTabCommand & { sessionId: string },
  ): Promise<BotBrowserTabCommandResult> => enqueue(async () => {
    if (command.action === 'get-tabs' || command.action === 'get-active-tab') {
      return sessionSnapshot(command);
    }
    if (command.action === 'open-tab' || command.action === 'navigate-tab') {
      return ensureSessionTab({
        sessionId: command.sessionId,
        action: command.action,
        uri: command.uri,
        label: command.label,
        hintTabId: command.tabId,
        activate: command.action === 'open-tab' ? command.activate !== false : command.activate === true,
        matchByUri: command.action === 'open-tab',
      });
    }
    const result = await controlTabs(command);
    if (!result) throw new Error(`Bot Browser command ${command.action} failed.`);
    return result;
  });

  const adoptCommittedActiveTab = (tabId: number, uri: string, title: string | null): void => {
    globalThis.setTimeout(() => {
      void (async () => {
        if (ownerOfTab(tabId) || pendingDraftTabId === tabId) return;
        const open = host?.getOpenSession();
        if (open?.sessionType !== 'browser' || open.id.startsWith('optimistic-browser-')) return;
        const snapshot = await listTabs();
        const tab = snapshot?.tabs.find((entry) => entry.id === tabId);
        if (!tab?.isActive || ownerOfTab(tabId) || pendingDraftTabId === tabId) return;
        rememberTab(open.id, tabId);
        rememberPage(open.id, uri, title);
      })().catch(() => {});
    }, 0);
  };

  const handleBrowserEvent = (message: SessionBrowserEvent): void => {
    if (message?.type !== 'agent-browser:event' || message.version !== 1) return;
    const tabId = Number(message.payload?.tabId);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
    if (message.event === 'tab-closed') {
      const owner = ownerOfTab(tabId);
      if (owner) sessionTabs.delete(owner);
      if (pendingDraftTabId === tabId) pendingDraftTabId = null;
      return;
    }
    const sessionId = ownerOfTab(tabId);
    if (message.event === 'navigation-committed') {
      const uri = String(message.payload?.uri ?? '').trim();
      if (!uri) return;
      const title = String(message.payload?.title ?? '').trim() || null;
      if (sessionId) rememberPage(sessionId, uri, title);
      else adoptCommittedActiveTab(tabId, uri, title);
      return;
    }
    if (!sessionId) return;
    if (message.event === 'title-updated') {
      const page = pageFor(sessionId);
      if (page) rememberPage(sessionId, page.uri, String(message.payload?.title ?? '').trim() || null);
    }
  };

  return {
    attach: (next) => {
      host = next;
    },
    rememberOpenSession: (sessionId) => {
      savePersistedBrowserSessionId(sessionId);
    },
    prepareDraftTab,
    bindNewSession,
    revealSessionTab,
    restoreLastSession,
    controlSessionTab,
    handleBrowserEvent,
  };
}

export const sessionTabBinding = createSessionTabBinding();
