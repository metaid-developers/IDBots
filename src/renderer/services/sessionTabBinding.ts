import type {
  BotBrowserTabCommand,
  BotBrowserTabCommandResult,
  BotBrowserTabInfo,
} from '../features/botBrowser/types';
import type { CoworkSession, CoworkSessionSummary } from '../types/cowork';
import {
  loadPersistedBrowserSessionId,
  savePersistedBrowserSessionId,
} from './viewState';

/**
 * Session ↔ tab binding for the BotHub face (owner request 2026-11-10).
 *
 * The model: every BotHub Co-Work session owns ONE browser tab. The binding
 * shows up in four flows:
 *
 * 1. 「新对话」 click — if the active tab still shows a page, the upcoming
 *    session gets a FRESH blank tab; a blank active tab is reused as-is, so
 *    consecutive new-conversation clicks never pile up empty tabs.
 * 2. Session start — the new session binds to the pending draft tab (or, when
 *    the composer was used straight from the welcome page, to a tab chosen by
 *    the same blank-tab policy).
 * 3. Session select (records) — the browser reveals that session's tab.
 * 4. App launch — the last open session is restored into the conversation
 *    window and its tab is restored into the freshly booted browser (the
 *    initial blank tab is navigated instead of stacking a second tab).
 *
 * Persistence: ABC tabs are in-memory and their ids die with the renderer, so
 * the durable binding is the session's `browserUri` (stamped per turn
 * main-side) plus the last-open-session pointer in viewState. Live tab ids
 * live only in this module's map and are re-resolved by URI after a restart.
 *
 * All tab traffic runs through the injected `controlTabs`, which App wires to
 * the shell's SILENT control path — restoring a tab must never yank the user
 * off the surface they are reading. Everything is best-effort: a failed or
 * timed-out tab command degrades to "no tab switch", never to an error the
 * user sees.
 */

export interface SessionTabHost {
  controlTabs(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
  /** The panel's currently open session (browserCowork pointer), if any. */
  getOpenSession(): CoworkSession | null;
  /** Load a session into the panel pointer; resolves the session or null. */
  openSession(sessionId: string): Promise<CoworkSession | null>;
  /** The full (non-archived) browser-session list, freshest first. */
  listBrowserSessions(): Promise<CoworkSessionSummary[]>;
}

export interface SessionTabBinding {
  attach(host: SessionTabHost): void;
  /** Write the last-open-session pointer (null clears it). */
  rememberOpenSession(sessionId: string | null): void;
  /** 「新对话」 click: reuse a blank active tab, else open a fresh one. */
  prepareDraftTab(): Promise<number | null>;
  /** Bind a just-started session to its tab (pending draft tab when alive). */
  bindNewSession(sessionId: string): Promise<void>;
  /** Reveal the session's tab in the browser (switch / re-open by URI). */
  revealSessionTab(sessionId: string): Promise<void>;
  /** One-shot launch restore: last session into the panel + its tab. */
  restoreLastSession(): Promise<void>;
}

const MAX_BOUND_TABS = 200;

const uriOf = (tab: BotBrowserTabInfo | null | undefined): string =>
  String(tab?.uri ?? '').trim();

const isActiveTabBlank = (active: BotBrowserTabInfo | null | undefined): boolean =>
  !active || !uriOf(active);

export function createSessionTabBinding(): SessionTabBinding {
  let host: SessionTabHost | null = null;
  /** Tab chosen by the latest 「新对话」 click, consumed by the next start. */
  let pendingDraftTabId: number | null = null;
  /** Live sessionId → tabId hints; re-resolved by URI after every restart. */
  const sessionTabs = new Map<string, number>();
  let restoreStarted = false;

  const rememberTab = (sessionId: string, tabId: number): void => {
    // Re-insert to refresh recency, then cap so long histories cannot grow
    // the map unboundedly.
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
      // Bridge down / surface never became ready: tab juggling is best-effort.
      return null;
    }
  };

  const listTabs = async (): Promise<BotBrowserTabInfo[]> => {
    const result = await controlTabs({ action: 'get-tabs' });
    return result?.tabs ?? [];
  };

  const isTabAlive = async (tabId: number): Promise<boolean> => {
    if (tabId <= 0) return false;
    return (await listTabs()).some((tab) => tab.id === tabId);
  };

  const getActiveTab = async (): Promise<BotBrowserTabInfo | null> => {
    const result = await controlTabs({ action: 'get-active-tab' });
    return result?.activeTab ?? null;
  };

  const switchToTab = async (tabId: number): Promise<void> => {
    await controlTabs({ action: 'switch-tab', tabId });
  };

  /** Reveal `uri` for a session: live URI match wins, else open it. */
  const revealTabByUri = async (sessionId: string, uri: string): Promise<void> => {
    const wanted = uri.toLowerCase();
    const match = (await listTabs())
      .find((tab) => uriOf(tab).toLowerCase() === wanted);
    if (match) {
      rememberTab(sessionId, match.id);
      await switchToTab(match.id);
      return;
    }
    // ABC's open-tab dedupes by URI, so a racing double-open cannot stack tabs.
    const opened = await controlTabs({ action: 'open-tab', uri });
    if (opened?.openedTabId != null) {
      rememberTab(sessionId, opened.openedTabId);
    }
  };

  const prepareDraftTab = async (): Promise<number | null> => {
    try {
      const active = await getActiveTab();
      if (!isActiveTabBlank(active)) {
        // The active tab carries a page the user (or a previous session) was
        // reading: the draft gets its own tab.
        const opened = await controlTabs({ action: 'open-tab' });
        pendingDraftTabId = opened?.openedTabId ?? null;
        return pendingDraftTabId;
      }
      // Blank active tab (fresh boot or a previous new-conversation click
      // never used): keep it, no second tab.
      pendingDraftTabId = active ? active.id : null;
      return pendingDraftTabId;
    } catch {
      pendingDraftTabId = null;
      return null;
    }
  };

  const bindNewSession = async (sessionId: string): Promise<void> => {
    try {
      let tabId = pendingDraftTabId;
      pendingDraftTabId = null;
      if (tabId != null && !(await isTabAlive(tabId))) {
        tabId = null;
      }
      if (tabId == null) {
        // Composer used straight from the welcome page: same policy as the
        // new-conversation click.
        const active = await getActiveTab();
        if (!isActiveTabBlank(active)) {
          const opened = await controlTabs({ action: 'open-tab' });
          tabId = opened?.openedTabId ?? null;
        } else {
          tabId = active ? active.id : null;
        }
      }
      if (tabId != null) {
        rememberTab(sessionId, tabId);
      }
    } catch {
      // Binding is a hint; the turn loop stamps browserUri regardless.
    }
  };

  const revealSessionTab = async (sessionId: string): Promise<void> => {
    try {
      const bound = sessionTabs.get(sessionId);
      if (bound != null && await isTabAlive(bound)) {
        await switchToTab(bound);
        return;
      }
      sessionTabs.delete(sessionId);
      // Durable binding: the session's last stamped tab URI.
      const open = host?.getOpenSession() ?? null;
      const uri = open && open.id === sessionId
        ? String(open.browserUri ?? '').trim()
        : '';
      if (!uri) return;
      await revealTabByUri(sessionId, uri);
    } catch {
      // Never let a tab switch break session selection.
    }
  };

  const restoreLastSession = async (): Promise<void> => {
    if (restoreStarted) return;
    restoreStarted = true;
    try {
      if (!host) return;
      // A stale pointer (session archived/deleted elsewhere) falls through to
      // the freshest browser session, so the conversation window is never
      // empty when the user has past conversations at all.
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

      const uri = String(session.browserUri ?? '').trim();
      if (!uri) return;
      // Fresh boot: exactly one tab, still blank. Navigate it instead of
      // stacking a second tab (the same blank-tab rule as the new-conversation
      // click); any other shape falls back to the ordinary reveal.
      const tabs = await listTabs();
      const active = tabs.find((tab) => tab.isActive) ?? null;
      if (tabs.length <= 1 && isActiveTabBlank(active) && active) {
        const navigated = await controlTabs({
          action: 'navigate-tab',
          tabId: active.id,
          uri,
        });
        if (navigated) {
          rememberTab(session.id, active.id);
          return;
        }
      }
      await revealTabByUri(session.id, uri);
    } catch {
      // Restore is a convenience; boot must never fail because of it.
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
  };
}

export const sessionTabBinding = createSessionTabBinding();
