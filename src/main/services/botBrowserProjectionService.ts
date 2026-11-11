/**
 * Bot Internet projector (owner ruling 2026-11-07, spec
 * docs/design/bot-internet-projector-mode.md): per-session projection-tab
 * bookkeeping for bot-authored HTML reports.
 *
 * Each projector session owns ONE projection tab in the Bot Browser. Live
 * Stage updates navigate that tab in the background; a finished report sets
 * `reveal` so the same navigation also leaves the projector tab active. ABC's
 * per-tab history stack makes earlier pages reachable with Back.
 *
 * The sessionId → tabId map is a hint, not truth: ABC tabs are in-memory, so
 * every projection re-validates the entry against the live tab list and falls
 * back to opening (announcing) again when the tab is gone.
 */

import type { BotBrowserTabBridge } from './botBrowserTabBridge';

export type BotBrowserProjectionInput = {
  sessionId: string;
  /** Absolute path of the report file (a file, or a directory with index.html). */
  localPath: string;
  /** Short display label for the projection tab (used when the tab opens). */
  title?: string;
  /** Leave this projection active after navigation (final owner-facing report). */
  reveal?: boolean;
};

export type BotBrowserProjectionOutcome = {
  uri: string;
  /** The projection tab id, when it could be confirmed. */
  tabId: number | null;
  /** true when this projection opened or revealed the session's tab. */
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

  const project = async (input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome> => {
    const uri = projectionUriForPath(input.localPath);
    const label = input.title?.trim() || undefined;
    const reveal = input.reveal === true;

    const cachedTabId = projectionTabs.get(input.sessionId);
    if (cachedTabId != null) {
      let alive = false;
      try {
        const info = await deps.getTabBridge().execute(
          { action: 'get-tab-info', tabId: cachedTabId },
          { focusWindow: false },
        );
        alive = info.info != null;
      } catch {
        alive = false;
      }
      if (alive) {
        const result = await deps.getTabBridge().execute(
          { action: 'navigate-tab', tabId: cachedTabId, uri, activate: reveal },
          { focusWindow: false },
        );
        if (reveal && result.activeTab?.id !== cachedTabId) {
          throw new Error('The projector tab did not become active.');
        }
        return { uri, tabId: cachedTabId, announced: reveal };
      }
      projectionTabs.delete(input.sessionId);
    }

    // Never adopt a tab by reports-directory prefix: sibling Studio sessions
    // share that directory, so prefix matching can silently hijack another
    // session's projector. ABC open-tab still dedupes an exact URI match.
    const opened = await deps.getTabBridge().execute({ action: 'open-tab', uri, label });
    const tabId = opened.openedTabId ?? opened.activeTab?.id ?? null;
    if (tabId == null || opened.activeTab?.id !== tabId) {
      throw new Error('The projector tab could not be opened and confirmed.');
    }
    projectionTabs.set(input.sessionId, tabId);
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
