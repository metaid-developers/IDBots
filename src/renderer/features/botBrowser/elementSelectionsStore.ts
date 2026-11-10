import type {
  BrowserElementSelectionsSnapshot,
} from '@openagentinternet/agent-browser-host-contract';
import { buildMarkedElementsBlock } from './markedElementsPrompt';

/**
 * Renderer-side cache of the ABC element picker snapshots (v0.10.0).
 *
 * ABC keeps markers per tab, session-only: navigation / reload / back-forward
 * clears them and the locators die with the page. The integration guide says
 * hosts should "read early": this store records every snapshot pushed by the
 * changed-event path (browserElementSelectionsBridge) so a turn sent right
 * after an accidental navigation still carries the marks captured before it.
 *
 * Nothing here is persisted — marks are volatile context, exactly like the
 * browser's own marker store.
 */

/** Cached snapshots older than this are ignored at capture time. */
const CACHED_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000;

export type MarkedElementsTurnCapture = {
  snapshot: BrowserElementSelectionsSnapshot;
  /**
   * True when the snapshot comes from the pre-navigation cache instead of a
   * live read (the page the user is looking at no longer carries the marks).
   */
  stale: boolean;
};

type ElementSelectionsFetcher = (
  tabId?: number | string,
) => Promise<BrowserElementSelectionsSnapshot | null>;

export class ElementSelectionsStore {
  private latestByTab = new Map<string, BrowserElementSelectionsSnapshot>();
  private lastNonEmptyByTab = new Map<string, { snapshot: BrowserElementSelectionsSnapshot; capturedAt: number }>();
  private lastNonEmptyTabKey: string | null = null;
  private fetcher: ElementSelectionsFetcher | null = null;

  registerFetcher(fetcher: ElementSelectionsFetcher): () => void {
    this.fetcher = fetcher;
    return () => {
      if (this.fetcher === fetcher) this.fetcher = null;
    };
  }

  /** Records a snapshot delivered by the bridge (changed-event follow-up). */
  recordSnapshot(snapshot: BrowserElementSelectionsSnapshot, now: number = Date.now()): void {
    if (!snapshot || typeof snapshot !== 'object') return;
    const tabKey = String(snapshot.tabId);
    this.latestByTab.set(tabKey, snapshot);
    if (Array.isArray(snapshot.selections) && snapshot.selections.length > 0) {
      this.lastNonEmptyByTab.set(tabKey, { snapshot, capturedAt: now });
      this.lastNonEmptyTabKey = tabKey;
    }
  }

  /** Latest non-empty snapshot for one tab (cache only, no live read). */
  getCachedForTab(tabId: number | string, now: number = Date.now()): MarkedElementsTurnCapture | null {
    const cached = this.lastNonEmptyByTab.get(String(tabId));
    if (!cached) return null;
    if (now - cached.capturedAt > CACHED_SNAPSHOT_MAX_AGE_MS) return null;
    return { snapshot: cached.snapshot, stale: true };
  }

  /**
   * Capture for the message being sent: live read of the active tab first,
   * falling back to the freshest cached non-empty snapshot for that tab (or
   * for whichever tab was updated last when the live read fails outright).
   * Returns null when there is nothing worth injecting.
   */
  async captureForTurn(now: number = Date.now()): Promise<MarkedElementsTurnCapture | null> {
    let fresh: BrowserElementSelectionsSnapshot | null = null;
    if (this.fetcher) {
      try {
        fresh = await this.fetcher();
      } catch {
        fresh = null;
      }
    }
    if (fresh && Array.isArray(fresh.selections) && fresh.selections.length > 0) {
      return { snapshot: fresh, stale: false };
    }
    const tabKey = fresh
      ? String(fresh.tabId)
      : this.lastNonEmptyTabKey;
    if (!tabKey) return null;
    const cached = this.lastNonEmptyByTab.get(tabKey);
    if (!cached || now - cached.capturedAt > CACHED_SNAPSHOT_MAX_AGE_MS) return null;
    return { snapshot: cached.snapshot, stale: true };
  }

  /** Convenience for the composer: '' when there is nothing to inject. */
  async capturePromptBlock(now: number = Date.now()): Promise<string> {
    const capture = await this.captureForTurn(now);
    return capture ? buildMarkedElementsBlock(capture) : '';
  }
}

export const elementSelectionsStore = new ElementSelectionsStore();
