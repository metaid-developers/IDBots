import type { BotBrowserSurfaceMode } from './types';

export const SURFACE_MODE_KV_KEY = 'botBrowser.surfaceMode';

export function normalizeStoredSurfaceMode(value: unknown): BotBrowserSurfaceMode | null {
  return value === 'home' || value === 'browser' ? value : null;
}

export interface ResolveInitialSurfaceModeInput {
  localStorageValue: unknown;
  kvStoreValue: unknown;
  currentVersion: string | null;
  firstInstallVersion: string | null;
  hasExistingBots: boolean;
  hasPersistedSessionId: boolean;
  onboardingEnterPending: boolean;
  needsWelcomeFlow: boolean;
}

export interface ResolvedInitialSurfaceMode {
  mode: BotBrowserSurfaceMode;
  isUpgradingExistingUser: boolean;
  persistToLocalStorage: boolean;
  persistToKvStore: boolean;
}

/**
 * Resolves the initial landing surface ('browser' = Studio, 'home' = BotWorks)
 * at startup:
 *   1. An explicit stored value (localStorage first, then SQLite kv mirror)
 *      always wins — users returning from BotWorks stay on BotWorks and users
 *      returning from Studio stay on Studio.
 *   2. When neither store has a saved surface yet, existing/upgrading users
 *      (whose legacy releases did not persist the active tab) land on BotWorks
 *      ('home'), while genuinely new installs land on Studio ('browser').
 */
export function resolveInitialSurfaceMode(
  input: ResolveInitialSurfaceModeInput,
): ResolvedInitialSurfaceMode {
  const fromLocal = normalizeStoredSurfaceMode(input.localStorageValue);
  const fromKv = normalizeStoredSurfaceMode(input.kvStoreValue);

  const isVersionUpgrade = Boolean(
    input.currentVersion
    && input.firstInstallVersion
    && input.firstInstallVersion !== input.currentVersion,
  );
  const isUpgradingExistingUser = !input.onboardingEnterPending && (
    isVersionUpgrade
    || input.hasExistingBots
    || input.hasPersistedSessionId
  );

  if (fromLocal !== null) {
    return {
      mode: fromLocal,
      isUpgradingExistingUser,
      persistToLocalStorage: false,
      persistToKvStore: fromKv !== fromLocal,
    };
  }

  if (fromKv !== null) {
    return {
      mode: fromKv,
      isUpgradingExistingUser,
      persistToLocalStorage: true,
      persistToKvStore: false,
    };
  }

  if (input.needsWelcomeFlow) {
    return {
      mode: isUpgradingExistingUser ? 'home' : 'browser',
      isUpgradingExistingUser,
      persistToLocalStorage: false,
      persistToKvStore: false,
    };
  }

  const mode: BotBrowserSurfaceMode = isUpgradingExistingUser ? 'home' : 'browser';
  return {
    mode,
    isUpgradingExistingUser,
    persistToLocalStorage: true,
    persistToKvStore: true,
  };
}
