/**
 * Routes every Studio projection through the renderer's session-tab binding.
 * The main process supplies the session id and its Stage tab as hints; the
 * binding owns live tab identity, background activation, and last-URI recovery.
 */

import type { BotBrowserTabBridge } from './botBrowserTabBridge';
import { previewMetaappUriForPath } from '../libs/localPreviewUri';

export type BotBrowserProjectionInput = {
  sessionId: string;
  /** Absolute path of the report file (a file, or a directory with index.html). */
  localPath: string;
  /** Short display label for the projection tab (used when the tab opens). */
  title?: string;
  /** Leave this projection active after navigation (final owner-facing report). */
  reveal?: boolean;
  /** The current turn's confirmed Stage tab, used as a binding hint. */
  tabId?: number;
  /**
   * Fixed session-tab role this projection lands in. Live Stage and Genesis
   * Stage pass 'stage'; owner-facing reports pass 'showcase' (the default
   * when omitted — commands without a role bind the showcase tab).
   */
  role?: 'stage' | 'showcase';
  /**
   * First stage projection of a brand-new session: the renderer may adopt
   * the prewarmed draft tab unconditionally (unowned, blank or on the entry).
   */
  draftClaim?: boolean;
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
  /** Kept for the stage services' archive/delete lifecycle. */
  forget(sessionId: string): void;
};

/** Recorded for showcase projections only — stage chrome never owns browserUri. */
export type BotBrowserProjectionRecord = {
  sessionId: string;
  uri: string;
  title: string | null;
  role?: 'stage' | 'showcase';
};

const projectionUriForPath = (localPath: string): string => previewMetaappUriForPath(localPath);

export function createBotBrowserProjectionService(deps: {
  getTabBridge: () => BotBrowserTabBridge;
  recordProjection?: (input: BotBrowserProjectionRecord) => void;
}): BotBrowserProjectionService {
  const project = async (input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome> => {
    const uri = projectionUriForPath(input.localPath);
    const label = input.title?.trim() || undefined;
    const reveal = input.reveal === true;
    const result = await deps.getTabBridge().execute({
      action: 'open-tab',
      uri,
      label,
      sessionId: input.sessionId,
      tabId: input.tabId,
      role: input.role,
      ...(input.draftClaim === true ? { draftClaim: true } : {}),
      activate: reveal,
      // Every projection stays off the app surface (stage and reports alike):
      // a report reveals its tab inside Bot Browser, never switches the app view.
      background: true,
    }, { focusWindow: false });
    const tabId = result.openedTabId ?? result.sessionTab?.id
      ?? (reveal ? result.activeTab?.id ?? null : null);
    if (tabId == null || (reveal && result.activeTab?.id !== tabId)) {
      throw new Error('The projector tab could not be opened and confirmed.');
    }
    const outcome = {
      uri,
      tabId,
      announced: reveal || result.activeTab?.id === tabId,
    };
    try {
      deps.recordProjection?.({
        sessionId: input.sessionId,
        uri,
        title: label ?? null,
        role: input.role,
      });
    } catch {
      // The projection succeeded; a durable recovery hint is best-effort.
    }
    return outcome;
  };

  return {
    project,
    forget: () => {},
  };
}

let singleton: BotBrowserProjectionService | null = null;

export function initBotBrowserProjectionService(deps: {
  getTabBridge: () => BotBrowserTabBridge;
  recordProjection?: (input: BotBrowserProjectionRecord) => void;
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
