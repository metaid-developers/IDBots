/**
 * The app-update polling loop, factored out of App.tsx so the on/off contract
 * is directly testable.
 *
 * Owner order 2026-11-21: when the Settings "check automatically" switch is
 * OFF the loop must register NOTHING — no immediate check, no interval, no
 * visibilitychange listener. `startAppUpdatePolling` therefore returns null
 * before touching any timer or listener when `enabled` is false; the caller's
 * cleanup becomes a no-op and the switch can be flipped repeatedly without
 * leaking a heartbeat.
 *
 * Timing semantics are unchanged from the previous in-component effect:
 *   - one check right away,
 *   - one attempt every UPDATE_HEARTBEAT_INTERVAL_MS (30 min),
 *   - one attempt when the window becomes visible again,
 * with UPDATE_POLL_INTERVAL_MS (30 min) throttling all attempts.
 */

import { UPDATE_HEARTBEAT_INTERVAL_MS, UPDATE_POLL_INTERVAL_MS } from './appUpdate';

export interface AppUpdatePollingHandle {
  /** Clear the heartbeat and the visibility listener. Idempotent. */
  stop: () => void;
}

export interface AppUpdatePollingOptions {
  /** The persisted "check for updates automatically" switch. */
  enabled: boolean;
  /** Performs one update check (the caller decides what a found update means). */
  check: () => void | Promise<void>;
  now?: () => number;
  setIntervalFn?: (callback: () => void, intervalMs: number) => number;
  clearIntervalFn?: (handle: number) => void;
  documentRef?: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
}

export function startAppUpdatePolling(
  options: AppUpdatePollingOptions,
): AppUpdatePollingHandle | null {
  if (!options.enabled) return null;

  const documentRef = options.documentRef
    ?? (typeof document !== 'undefined' ? document : null);
  if (!documentRef) return null;

  const now = options.now ?? (() => Date.now());
  const setIntervalFn = options.setIntervalFn
    ?? ((callback, intervalMs) => window.setInterval(callback, intervalMs));
  const clearIntervalFn = options.clearIntervalFn
    ?? ((handle) => window.clearInterval(handle));

  let stopped = false;
  let lastCheckTime = 0;

  const maybeCheck = async () => {
    if (stopped) return;
    const stamp = now();
    if (lastCheckTime > 0 && stamp - lastCheckTime < UPDATE_POLL_INTERVAL_MS) return;
    lastCheckTime = stamp;
    await options.check();
  };

  void maybeCheck();

  const timer = setIntervalFn(() => {
    void maybeCheck();
  }, UPDATE_HEARTBEAT_INTERVAL_MS);

  const handleVisibilityChange = () => {
    if (documentRef.visibilityState === 'visible') {
      void maybeCheck();
    }
  };
  documentRef.addEventListener('visibilitychange', handleVisibilityChange);

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
      documentRef.removeEventListener('visibilitychange', handleVisibilityChange);
    },
  };
}
