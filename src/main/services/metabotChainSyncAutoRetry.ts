/**
 * Unattended retry for a bot's unpublished on-chain profile steps.
 *
 * Chain writes fail transiently (an unindexed subsidy payout, a provider
 * hiccup, a network drop) and a fresh bot then sat at "identity registered ·
 * profile pending" until the owner found the re-sync button. This scheduler
 * republishes the persisted pending steps on a backoff (per bot) whenever it
 * is kicked — at launch and after every bot mutation — and gives up after the
 * last delay so a truly unfunded wallet is not hammered; the manual re-sync
 * entry stays available either way.
 */
export const CHAIN_SYNC_AUTO_RETRY_DELAYS_MS = [20_000, 90_000, 5 * 60_000, 20 * 60_000] as const;

export interface MetabotChainSyncAutoRetryDeps {
  listCandidates(): number[];
  resync(metabotId: number): Promise<{ attemptedSteps: string[]; success: boolean; remainingSteps: string[]; error?: string }>;
  delaysMs?: readonly number[];
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (message: string, data?: Record<string, unknown>) => void;
  /** Fired after an attempt that published something (e.g. refresh bot lists). */
  onProgress?: (metabotId: number) => void;
}

export interface MetabotChainSyncAutoRetry {
  kick(): void;
  dispose(): void;
}

export function createMetabotChainSyncAutoRetry(deps: MetabotChainSyncAutoRetryDeps): MetabotChainSyncAutoRetry {
  const delays = deps.delaysMs ?? CHAIN_SYNC_AUTO_RETRY_DELAYS_MS;
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => {
    const timer = setTimeout(fn, ms);
    timer.unref?.();
    return { cancel: () => clearTimeout(timer) };
  });
  const state = new Map<number, { attempts: number; dueAt: number }>();
  let timer: { cancel(): void } | null = null;
  let timerAt = Infinity;
  let running = false;
  let disposed = false;

  const arm = () => {
    if (disposed) return;
    let next = Infinity;
    for (const entry of state.values()) {
      if (entry.attempts < delays.length) next = Math.min(next, entry.dueAt);
    }
    if (next === Infinity || (timer && timerAt <= next)) return;
    timer?.cancel();
    timerAt = next;
    timer = setTimer(() => {
      timer = null;
      timerAt = Infinity;
      void pass();
    }, Math.max(0, next - now()));
  };

  const refresh = () => {
    const candidates = new Set(deps.listCandidates());
    for (const id of [...state.keys()]) if (!candidates.has(id)) state.delete(id);
    for (const id of candidates) {
      if (!state.has(id)) state.set(id, { attempts: 0, dueAt: now() + delays[0] });
    }
  };

  const pass = async () => {
    if (running || disposed) return;
    running = true;
    try {
      refresh();
      for (const [id, entry] of state) {
        if (disposed) return;
        if (entry.attempts >= delays.length || entry.dueAt > now()) continue;
        entry.attempts += 1;
        let result: Awaited<ReturnType<MetabotChainSyncAutoRetryDeps['resync']>> | null = null;
        try {
          result = await deps.resync(id);
        } catch (error) {
          deps.log?.('chain-sync auto-retry threw', { metabotId: id, error: error instanceof Error ? error.message : String(error) });
        }
        deps.log?.('chain-sync auto-retry attempt', {
          metabotId: id,
          attempt: entry.attempts,
          attemptedSteps: result?.attemptedSteps ?? [],
          success: result?.success ?? false,
          remainingSteps: result?.remainingSteps ?? [],
          error: result?.error,
        });
        const published = result?.attemptedSteps.some((step) => !result!.remainingSteps.includes(step)) ?? false;
        if (published) deps.onProgress?.(id);
        if (result?.success || (result && result.attemptedSteps.length === 0)) {
          state.delete(id);
        } else if (entry.attempts < delays.length) {
          entry.dueAt = now() + delays[entry.attempts];
        }
      }
    } finally {
      running = false;
      arm();
    }
  };

  return {
    kick: () => {
      if (disposed) return;
      try {
        refresh();
      } catch (error) {
        deps.log?.('chain-sync auto-retry candidate scan failed', { error: error instanceof Error ? error.message : String(error) });
        return;
      }
      arm();
    },
    dispose: () => {
      disposed = true;
      timer?.cancel();
      timer = null;
      state.clear();
    },
  };
}
