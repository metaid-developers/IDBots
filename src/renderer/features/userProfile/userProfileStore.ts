/**
 * Shared state for the user profile page.
 *
 * Two independent pieces, both external stores so any component can read them
 * without a provider (the entry button is mounted by Sidebar.tsx AND
 * HomeSidebar.tsx — one face at a time — while the page overlay is mounted by
 * the same face; App.tsx stays untouched, which is what keeps the Bot Browser
 * pane mounted across the open/close).
 *
 *  1. `identity` — one shared read of `window.electron.userIdentity.get()`.
 *     The entry button and the page header must never disagree, and the read
 *     must not fire twice per mount. There is exactly ONE service call here
 *     (`userIdentity.get`) — the same one `components/user/UserSettings.tsx`
 *     already issues on mount; this module adds no new IPC channel.
 *  2. `open` — whether the page overlay is showing.
 *  3. `plansPage` — the level-2 page INSIDE the same card (页面嵌套定版
 *     2026-11-09): `null` is the level-1 「我的」 body, `'subscribe'` /
 *     `'topup'` is the plans flow mounted in the very same container. The
 *     level-2 page never outlives the card: closing the card resets it, so
 *     the next open always lands on level 1.
 */

/** The subset of the main-process PublicUserIdentity the page renders. */
export interface UserProfileIdentity {
  id: number;
  name: string;
  avatar: string | null;
  metaid: string;
  globalmetaid: string | null;
  mvc_address: string;
}

export interface UserProfileIdentitySnapshot {
  loading: boolean;
  identity: UserProfileIdentity | null;
  /** Raw IPC error string; the page renders localized copy instead. */
  error: string | null;
  /** False until the first read resolved, so the entry can stay quiet. */
  loaded: boolean;
}

const INITIAL_IDENTITY: UserProfileIdentitySnapshot = {
  loading: true,
  identity: null,
  error: null,
  loaded: false,
};

let identitySnapshot: UserProfileIdentitySnapshot = INITIAL_IDENTITY;
const identityListeners = new Set<() => void>();
let identityInFlight: Promise<void> | null = null;

const emitIdentity = () => {
  identityListeners.forEach((listener) => listener());
};

export const getUserProfileIdentity = (): UserProfileIdentitySnapshot => identitySnapshot;

export const subscribeUserProfileIdentity = (listener: () => void): (() => void) => {
  identityListeners.add(listener);
  return () => {
    identityListeners.delete(listener);
  };
};

const pickIdentity = (identity: Record<string, unknown>): UserProfileIdentity => ({
  id: typeof identity.id === 'number' ? identity.id : 0,
  name: typeof identity.name === 'string' ? identity.name : '',
  avatar: typeof identity.avatar === 'string' ? identity.avatar : null,
  metaid: typeof identity.metaid === 'string' ? identity.metaid : '',
  globalmetaid: typeof identity.globalmetaid === 'string' ? identity.globalmetaid : null,
  mvc_address: typeof identity.mvc_address === 'string' ? identity.mvc_address : '',
});

/**
 * Reads the local identity once and shares the result. Concurrent callers share
 * one in-flight request; a later call re-reads (the account block can create,
 * import, rename or log out, so the avatar/name can legitimately change).
 */
export const refreshUserProfileIdentity = (): Promise<void> => {
  if (identityInFlight) return identityInFlight;
  identityInFlight = (async () => {
    try {
      const result = await window.electron.userIdentity.get();
      identitySnapshot = result.success
        ? {
            loading: false,
            identity: result.identity ? pickIdentity(result.identity as unknown as Record<string, unknown>) : null,
            error: null,
            loaded: true,
          }
        : {
            loading: false,
            identity: identitySnapshot.identity,
            error: result.error || 'USER_IDENTITY_READ_FAILED',
            loaded: true,
          };
    } catch (error) {
      identitySnapshot = {
        loading: false,
        identity: identitySnapshot.identity,
        error: error instanceof Error ? error.message : 'USER_IDENTITY_READ_FAILED',
        loaded: true,
      };
    } finally {
      identityInFlight = null;
      emitIdentity();
    }
  })();
  return identityInFlight;
};

let profileOpen = false;
const openListeners = new Set<() => void>();

const emitOpen = () => {
  openListeners.forEach((listener) => listener());
};

export const getUserProfileOpen = (): boolean => profileOpen;

export const subscribeUserProfileOpen = (listener: () => void): (() => void) => {
  openListeners.add(listener);
  return () => {
    openListeners.delete(listener);
  };
};

// --- Level-2 plans page (页面嵌套定版 2026-11-09) ---------------------------
//
// The plans flow is a SECOND LEVEL of the same profile card, not a separate
// floating modal: level 1 is 「我的」, clicking 「开通/升级套餐」 (or 「充值」)
// swaps the card body to the plans flow, and the card's back bar returns to
// level 1. The section doubles as the tab state inside the flow, so the
// header title follows subscribe ⇄ topup switches.

export type UserProfilePlansPage = 'subscribe' | 'topup';

let plansPage: UserProfilePlansPage | null = null;
const plansListeners = new Set<() => void>();

const emitPlans = () => {
  plansListeners.forEach((listener) => listener());
};

export const getUserProfilePlansPage = (): UserProfilePlansPage | null => plansPage;

export const subscribeUserProfilePlansPage = (listener: () => void): (() => void) => {
  plansListeners.add(listener);
  return () => {
    plansListeners.delete(listener);
  };
};

/** Enter (or re-target) the level-2 plans page. A no-op while the card is closed. */
export const openUserProfilePlansPage = (section: UserProfilePlansPage): void => {
  if (!profileOpen) return;
  if (plansPage === section) return;
  plansPage = section;
  emitPlans();
};

/** Leave the level-2 page and land back on the level-1 「我的」 body. */
export const closeUserProfilePlansPage = (): void => {
  if (plansPage === null) return;
  plansPage = null;
  emitPlans();
};

export const openUserProfile = (): void => {
  if (profileOpen) return;
  profileOpen = true;
  // Always land on level 1, even if a previous card session died mid-flow.
  // Notify only on a REAL change — opening fresh must not churn the level
  // subscribers (they re-render on identity, not on redundant nulls).
  if (plansPage !== null) {
    plansPage = null;
    emitPlans();
  }
  // Opening the page is also the cheapest moment to re-read the identity: it
  // may have been created or renamed since the last mount.
  void refreshUserProfileIdentity();
  emitOpen();
};

export const closeUserProfile = (): void => {
  if (!profileOpen) return;
  profileOpen = false;
  // The level-2 page never outlives the card (reopening starts at 「我的」).
  if (plansPage !== null) {
    plansPage = null;
    emitPlans();
  }
  emitOpen();
};

/** Test seam: reset both stores without touching the IPC surface. */
export const resetUserProfileStoresForTests = (): void => {
  identitySnapshot = INITIAL_IDENTITY;
  identityInFlight = null;
  profileOpen = false;
  plansPage = null;
  emitIdentity();
  emitOpen();
  emitPlans();
};
