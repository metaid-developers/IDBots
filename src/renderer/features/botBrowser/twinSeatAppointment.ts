/**
 * Twin-seat appointment procedure (owner ruling 2026-11-08).
 *
 * The Twin is a replaceable seat, not a fixed identity: appointing a bot must
 * move exactly one system-wide fact — `metabot_type` — the same field the
 * My Bots editor writes. The swap is demote-then-promote (a machine may have
 * at most one acting Twin), and a failed promote rolls the previous Twin back
 * up so the machine is never left seatless through a half-completed swap.
 *
 * Deliberately free of React and `window`: the sequence, the rollback and the
 * toast text are covered by mock-IPC unit tests, never by clicking the real
 * roster (the dev fixture bots are identity-protected).
 */

export type TwinSeatMetabotType = 'twin' | 'worker' | 'welcome';

export interface TwinSeatBot {
  id: number;
  name: string;
  metabot_type: string;
}

export interface TwinSeatUpdatePatch {
  metabot_type: TwinSeatMetabotType;
}

export interface TwinSeatUpdateResult {
  success: boolean;
  error?: string;
}

export interface TwinSeatAppointmentDeps {
  /** Mirrors `window.electron.metabot.update`. */
  update: (id: number, patch: TwinSeatUpdatePatch) => Promise<TwinSeatUpdateResult>;
  /** Re-reads the roster after a successful appointment. */
  reload: () => Promise<void>;
  /** Surfaces the outcome to the user (the panel dispatches app:showToast). */
  notify: (message: string) => void;
  /** Resolves an i18n key (the panel passes i18nService.t). */
  translate: (key: string) => string;
}

export type TwinSeatAppointmentOutcome =
  | {
      status: 'appointed';
      targetId: number;
      previousTwinId: number | null;
      rollbackAttempted: false;
    }
  | { status: 'unchanged'; targetId: number }
  | {
      status: 'failed';
      stage: 'demote' | 'promote';
      error: string;
      rollbackAttempted: boolean;
      rollbackSucceeded: boolean;
    };

/**
 * Appoint `target` as the acting Twin.
 *
 * Order is load-bearing: the previous Twin is demoted to `worker` first, then
 * the target is promoted to `twin`. A demote failure aborts before any promote
 * (the old seat stays intact). A promote failure restores the old Twin.
 */
export async function appointTwinSeat<B extends TwinSeatBot>(
  target: B,
  roster: readonly B[],
  deps: TwinSeatAppointmentDeps,
): Promise<TwinSeatAppointmentOutcome> {
  const currentTwin = roster.find((bot) => bot.metabot_type === 'twin') ?? null;
  if (currentTwin?.id === target.id) {
    return { status: 'unchanged', targetId: target.id };
  }

  if (currentTwin) {
    const demote = await deps.update(currentTwin.id, { metabot_type: 'worker' });
    if (!demote.success) {
      const error = demote.error || 'Failed to release the previous Twin';
      deps.notify(error);
      return {
        status: 'failed',
        stage: 'demote',
        error,
        rollbackAttempted: false,
        rollbackSucceeded: false,
      };
    }
  }

  const promote = await deps.update(target.id, { metabot_type: 'twin' });
  if (!promote.success) {
    const error = promote.error || 'Failed to appoint the acting Twin';
    let rollbackAttempted = false;
    let rollbackSucceeded = false;
    if (currentTwin) {
      rollbackAttempted = true;
      try {
        const rollback = await deps.update(currentTwin.id, { metabot_type: 'twin' });
        rollbackSucceeded = rollback.success;
      } catch {
        rollbackSucceeded = false;
      }
    }
    deps.notify(
      rollbackAttempted && !rollbackSucceeded
        ? `${error} ${deps.translate('botInternetTwinSeatRollbackFailed')}`
        : error,
    );
    return { status: 'failed', stage: 'promote', error, rollbackAttempted, rollbackSucceeded };
  }

  await deps.reload();
  deps.notify(
    deps.translate('botInternetTwinSeatAppointed').replace('{name}', target.name),
  );
  return {
    status: 'appointed',
    targetId: target.id,
    previousTwinId: currentTwin?.id ?? null,
    rollbackAttempted: false,
  };
}
