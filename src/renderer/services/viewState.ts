/**
 * Persisted cowork view state: which main view was open and which conversation
 * it showed.
 *
 * Everything about the open conversation lives in memory (the Redux cowork
 * slice starts empty and App's mainView starts at 'cowork'), so any renderer
 * reload — dev HMR, the main process's load-timeout / crash / did-fail-load
 * recovery (`scheduleReload` in main.ts), or an auto-update relaunch — used to
 * reset the window to the New Task home. Right after onboarding that silently
 * threw the freshly created Twin Bot chat away, and it read as the view
 * "forcing itself" back to the bot picker.
 *
 * Restoring the last view + session makes the UI survive those reloads: the
 * user stays in the conversation they were in, wherever they were.
 *
 * Storage is best-effort localStorage (the same mechanism the sidebar width
 * uses): a missing or unparsable value simply restores nothing.
 */

export type PersistedMainView = 'cowork' | 'scheduledTasks' | 'groupTasks' | 'metabots';

export interface PersistedViewState {
  mainView: PersistedMainView;
  sessionId: string | null;
}

const STORAGE_KEY = 'idbots.viewState';
const ONBOARDING_ENTER_KEY = 'idbots.onboardingEnterPending';

const MAIN_VIEWS: PersistedMainView[] = ['cowork', 'scheduledTasks', 'groupTasks', 'metabots'];

const isPersistedMainView = (value: unknown): value is PersistedMainView =>
  typeof value === 'string' && (MAIN_VIEWS as string[]).includes(value);

/** The stored view state, or null when nothing usable was stored. */
export function loadPersistedViewState(): PersistedViewState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { mainView?: unknown; sessionId?: unknown };
    const sessionId = typeof parsed?.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : null;
    return {
      mainView: isPersistedMainView(parsed?.mainView) ? parsed.mainView : 'cowork',
      sessionId,
    };
  } catch {
    return null;
  }
}

export function savePersistedViewState(state: PersistedViewState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // A full or blocked localStorage must never break navigation.
  }
}

/**
 * Forget the conversation, keep the view. Called when the stored session no
 * longer loads (deleted, archived, or a stale `temp-…` id), so a later reload
 * does not keep retrying it.
 */
export function clearPersistedSession(): void {
  const current = loadPersistedViewState();
  savePersistedViewState({ mainView: current?.mainView ?? 'cowork', sessionId: null });
}

/**
 * The welcome flow's "Enter IDBots" click, in flight.
 *
 * Set when the click starts and cleared once the greeting chat exists. A reload
 * between the two (dev HMR, crash, auto-update) would otherwise leave the user
 * with a freshly created Twin Bot and no chat, on the New Task home, with the
 * welcome flow suppressed — so the next launch re-offers the flow instead, and
 * its Enter is idempotent (it adopts the Twin that already exists).
 */
export function markOnboardingEnterPending(): void {
  try {
    window.localStorage.setItem(ONBOARDING_ENTER_KEY, '1');
  } catch {
    // Best effort, same as the view state above.
  }
}

export function clearOnboardingEnterPending(): void {
  try {
    window.localStorage.removeItem(ONBOARDING_ENTER_KEY);
  } catch {
    // Best effort.
  }
}

export function isOnboardingEnterPending(): boolean {
  try {
    return window.localStorage.getItem(ONBOARDING_ENTER_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * The Studio face's open Co-Work session, persisted separately from the home
 * surface's `sessionId` above (the two panels deliberately keep independent
 * pointers). Restoring it on launch is what makes the Studio conversation
 * window survive a restart instead of falling back to the Twin welcome page.
 */
const BROWSER_VIEW_STATE_KEY = 'idbots.botBrowser.viewState';

export function loadPersistedBrowserSessionId(): string | null {
  try {
    const raw = window.localStorage.getItem(BROWSER_VIEW_STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { sessionId?: unknown };
    return typeof parsed?.sessionId === 'string' && parsed.sessionId.trim()
      ? parsed.sessionId.trim()
      : null;
  } catch {
    return null;
  }
}

export function savePersistedBrowserSessionId(sessionId: string | null): void {
  try {
    window.localStorage.setItem(BROWSER_VIEW_STATE_KEY, JSON.stringify({ sessionId }));
  } catch {
    // Best effort, same as the view state above.
  }
}
