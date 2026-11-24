/**
 * Floatwin single-seat registry (M1=B, owner approval 2026-11-24 17:23).
 *
 * The app has exactly one floatwin seat: Settings and 进程中心 are both
 * 900×80vh overlays at z-50, so two of them must never be on screen together —
 * the later one wins and the earlier one yields ("打开另一浮窗时让位", not a
 * stack). This module is the ONE announcement channel for that rule: an opener
 * announces its id, every mounted floatwin that is not the announced id closes
 * itself. It holds no state and no React import, so it can be imported by any
 * component without a dependency edge.
 */

export type FloatwinId = 'process-center' | 'settings';

const listeners = new Set<(opener: FloatwinId) => void>();

/** Announce that `opener` is opening. Idempotent; subscribers decide. */
export const announceFloatwinOpen = (opener: FloatwinId): void => {
  for (const listener of [...listeners]) {
    try {
      listener(opener);
    } catch {
      // A listener must never break the opener's own open path.
    }
  }
};

/**
 * Subscribe to announcements. Returns the unsubscribe function.
 * The subscriber closes only when a DIFFERENT floatwin opens.
 */
export const subscribeFloatwinYield = (
  me: FloatwinId,
  onYield: () => void,
): (() => void) => {
  const listener = (opener: FloatwinId): void => {
    if (opener !== me) onYield();
  };
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/** Test hook: drop every subscriber (never called by app code). */
export const __resetFloatwinRegistryForTests = (): void => {
  listeners.clear();
};
