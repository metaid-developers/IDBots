/**
 * PaymentCard launch watchdog — the 2s degrade timer (S3 fiat slice).
 *
 * After the card assigns `location.href = alipays://…` the page either hides
 * (the app took over: visibilitychange → hidden, pagehide, or blur) or the
 * environment cannot open the scheme at all (desktop Electron without a
 * handler, blocked webviews) and nothing happens. The watchdog waits
 * LAUNCH_DEGRADE_MS for a hide signal; with none it fires onDegraded exactly
 * once so the UI swaps to the embedded QR fallback card (design doc 01 §4).
 *
 * Timer functions are injected so the logic is unit-testable without a DOM.
 * This module is DOM-free.
 */

export const LAUNCH_DEGRADE_MS = 2000;

export interface LaunchWatchdogDeps {
  /** Degrade window; default 2000ms per design doc 01 §4. */
  delayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

export interface LaunchWatchdog {
  /** A hide signal arrived (visibilitychange/pagehide/blur) — the launch worked; never degrades. */
  succeed(): void;
  /** Stop watching without degrading (component unmount / manual path switch). */
  cancel(): void;
  /** True once the degrade callback has fired. */
  degraded(): boolean;
}

const defaultSetTimeout = (fn: () => void, ms: number) => setTimeout(fn, ms);
const defaultClearTimeout = (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>);

export function startLaunchWatchdog(onDegraded: () => void, deps: LaunchWatchdogDeps = {}): LaunchWatchdog {
  const delayMs = deps.delayMs ?? LAUNCH_DEGRADE_MS;
  const setTimeoutFn = deps.setTimeoutFn ?? defaultSetTimeout;
  const clearTimeoutFn = deps.clearTimeoutFn ?? defaultClearTimeout;

  let timerHandle: unknown = null;
  let settled = false;
  let didDegrade = false;

  const stopTimer = () => {
    if (timerHandle !== null) {
      clearTimeoutFn(timerHandle);
      timerHandle = null;
    }
  };

  timerHandle = setTimeoutFn(() => {
    timerHandle = null;
    if (settled) return;
    settled = true;
    didDegrade = true;
    onDegraded();
  }, delayMs);

  return {
    succeed() {
      if (settled) return;
      settled = true;
      stopTimer();
    },
    cancel() {
      settled = true;
      stopTimer();
    },
    degraded() {
      return didDegrade;
    },
  };
}
