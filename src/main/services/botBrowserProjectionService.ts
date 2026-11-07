/**
 * Bot Internet projector (owner ruling 2026-11-07, spec
 * docs/design/bot-internet-projector-mode.md): per-session projection-tab
 * bookkeeping for bot-authored HTML reports.
 *
 * Each projector session owns ONE projection tab in the Bot Browser. The first
 * projection ANNOUNCES (openUri broadcast switches the internet pane to the
 * browser and focuses the window, so the owner sees the projector light up);
 * every further projection navigates that same tab in place via the tab
 * bridge's navigate-tab action with focusWindow: false — the page is written
 * silently, never stealing the tab or the OS focus. ABC's per-tab history
 * stack makes previous turns' pages reachable with the back button for free.
 *
 * The sessionId → tabId map is a hint, not truth: ABC tabs are in-memory, so
 * every projection re-validates the entry against the live tab list and falls
 * back to opening (announcing) again when the tab is gone.
 */

import { sendBotBrowserOpenUri } from './botBrowserOpenUriService';
import type { BotBrowserTabBridge } from './botBrowserTabBridge';

export type BotBrowserProjectionInput = {
  sessionId: string;
  /** Absolute path of the report file (a file, or a directory with index.html). */
  localPath: string;
  /** Short display label for the projection tab (used when the tab opens). */
  title?: string;
};

export type BotBrowserProjectionOutcome = {
  uri: string;
  /** The projection tab id, when it could be confirmed. */
  tabId: number | null;
  /** true when this projection opened the session's tab (first projection). */
  announced: boolean;
};

export type BotBrowserProjectionService = {
  project(input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome>;
  /** Drop the session's projection-tab hint (session archived/deleted). */
  forget(sessionId: string): void;
};

const projectionUriForPath = (localPath: string): string => `preview-metaapp://localhost${localPath}`;

export function createBotBrowserProjectionService(deps: {
  getTabBridge: () => BotBrowserTabBridge;
}): BotBrowserProjectionService {
  const projectionTabs = new Map<string, number>();

  const findTabByUriPrefix = async (uriPrefix: string): Promise<number | null> => {
    const result = await deps.getTabBridge().execute({ action: 'get-tabs' }, { focusWindow: false });
    const match = (result.tabs ?? []).find((tab) => typeof tab.uri === 'string' && tab.uri.startsWith(uriPrefix));
    return match ? match.id : null;
  };

  const project = async (input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome> => {
    const uri = projectionUriForPath(input.localPath);
    const label = input.title?.trim() || undefined;

    // 1) Cached tab: verify it is still alive, then navigate it in place,
    //    silently (no window focus, no tab switch visible to the user).
    const cachedTabId = projectionTabs.get(input.sessionId);
    if (cachedTabId != null) {
      try {
        const info = await deps.getTabBridge().execute(
          { action: 'get-tab-info', tabId: cachedTabId },
          { focusWindow: false },
        );
        if (info.info) {
          await deps.getTabBridge().execute(
            { action: 'navigate-tab', tabId: cachedTabId, uri },
            { focusWindow: false },
          );
          return { uri, tabId: cachedTabId, announced: false };
        }
      } catch {
        // Tab gone (user closed it, renderer rebuilt) — fall through.
      }
      projectionTabs.delete(input.sessionId);
    }

    // 2) Orphan recovery: another tab already shows this report directory
    //    (e.g. the user re-opened it via the chat chip after a restart of the
    //    map only). Re-adopt it instead of stacking a second projector tab.
    const reportsDirPrefix = `${uri.slice(0, uri.lastIndexOf('/') + 1)}`;
    try {
      const orphanTabId = await findTabByUriPrefix(reportsDirPrefix);
      if (orphanTabId != null) {
        projectionTabs.set(input.sessionId, orphanTabId);
        await deps.getTabBridge().execute(
          { action: 'navigate-tab', tabId: orphanTabId, uri },
          { focusWindow: false },
        );
        return { uri, tabId: orphanTabId, announced: false };
      }
    } catch {
      // No window / bridge unavailable — the open path below reports honestly.
    }

    // 3) First projection for this session: open the tab AND announce it
    //    (pane reveal + window focus) so the owner sees the projector light up.
    sendBotBrowserOpenUri({ uri, newTab: true, label });
    let tabId: number | null = null;
    try {
      tabId = await findTabByUriPrefix(uri);
    } catch {
      // Tab confirmation is best-effort; the projection itself went out.
    }
    if (tabId != null) projectionTabs.set(input.sessionId, tabId);
    return { uri, tabId, announced: true };
  };

  return {
    project,
    forget: (sessionId: string) => {
      projectionTabs.delete(sessionId);
    },
  };
}

let singleton: BotBrowserProjectionService | null = null;

export function initBotBrowserProjectionService(deps: {
  getTabBridge: () => BotBrowserTabBridge;
}): BotBrowserProjectionService {
  if (!singleton) {
    singleton = createBotBrowserProjectionService(deps);
  }
  return singleton;
}

export function getBotBrowserProjectionService(): BotBrowserProjectionService {
  if (!singleton) {
    throw new Error('Bot Browser projection service is not initialized.');
  }
  return singleton;
}
