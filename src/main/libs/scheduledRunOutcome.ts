/**
 * Scheduled-run outcome tiering (T-A, RSI/WTL second batch).
 *
 * The run ledger previously recorded only `success` | `error`, both keyed on
 * ONE fact: whether `startCoworkSession` threw. That collapses two different
 * worlds into one label — "the executor exited normally" and "the executor
 * did actual work" — so a fire whose DSH runtime was broken (turn settled
 * failed, zero work) still entered the history as `success`, and the daily
 * report aggregated the day into an "all succeeded" narrative that masked a
 * systemic failure (2026-11-17 pool-skeleton fire).
 *
 * Four terminal tiers now distinguish those worlds:
 *   - `completed`        executor exited normally AND produced actual work;
 *   - `completed_empty`  executor exited normally but produced zero work;
 *   - `crashed`          executor exited abnormally (submission threw, or the
 *                        turn's newest settlement marker in the run window is
 *                        a failure — provider error, stall abort, truncation);
 *   - `timeout`          the wall-clock watchdog killed the run (the executor
 *                        never got a normal exit).
 *
 * Zero-work criterion (defined on fields that already exist):
 *   A run's work evidence is the count of `assistant` / `tool_use` messages
 *   persisted in the session at `created_at >= runStartMs`. The scheduler
 *   awaits the full turn (`runner.startSession` resolves only after the DSH
 *   turn pipeline has settled: turn-outcome markers are recorded BEFORE the
 *   active session is removed, so the markers and the final messages are both
 *   durable when classification runs). Zero work = that count is exactly 0.
 *   A count of `null` means the evidence could not be read at all (store
 *   without the paging API, legacy embedder) — unknown evidence can never
 *   prove "empty", so it classifies as `completed` (the old label).
 *
 * Task-level bookkeeping is deliberately UNCHANGED: scheduling, auto-disable,
 * practice writeback, notifications and origin-session reports all key on
 * "did the executor exit normally" (`completed` | `completed_empty` → true;
 * `crashed` | `timeout` → false), which is byte-for-byte the old no-throw /
 * threw split. Only the run receipt and the daily-report aggregation gain
 * resolution.
 *
 * Pure and Electron-free: unit tests load it directly with Node type
 * stripping.
 */

/** Terminal run outcome tiers (legacy rows keep 'success' | 'error'). */
export type ScheduledRunOutcome = 'completed' | 'completed_empty' | 'crashed' | 'timeout';

/**
 * Stable discriminator of the wall-clock watchdog's kill. The watchdog arms
 * in `Scheduler.runScheduledTurn` for practice runs, stops the session with
 * `finalStatus: 'error'`, and the awaiting fire then throws
 * `Practice run exceeded its N-minute wall-clock budget`. That throw is the
 * only wall-clock timeout the scheduler produces today — the `timeout` tier
 * is its receipt label. Both construction sites share this exact template,
 * so a prefix match is the honest discriminator (never guess from free text:
 * this constant and the throw sites move together).
 */
export const WALL_CLOCK_BUDGET_EXCEEDED_MARKER = 'Practice run exceeded its';

export const isWallClockBudgetError = (errorMessage: string | null): boolean =>
  typeof errorMessage === 'string' && errorMessage.startsWith(WALL_CLOCK_BUDGET_EXCEEDED_MARKER);

/** Diagnostic recorded on a crashed run whose executor never threw (the turn
 *  pipeline settled the failure itself). Keeps the `error` column non-null so
 *  the history shows a reason instead of a bare tier. */
export const TURN_SETTLED_ABNORMALLY_ERROR =
  'executor turn settled without answering (failed / stall-aborted / truncated)';

export interface ClassifyScheduledRunOutcomeInput {
  /** `runner.startSession` resolved — the executor had a normal lifecycle. */
  submitted: boolean;
  /** The throw message when `submitted` is false, else null. */
  errorMessage: string | null;
  /**
   * The turn's newest settlement marker inside the run window is a failure
   * (recordSessionTurnFailure newer than recordSessionTurnCompletion, or the
   * only marker). Computed by the scheduler from
   * `coworkStore.getSessionTurnOutcome` so the window stays the scheduler's
   * knowledge; the classifier stays pure.
   */
  turnSettledAbnormally: boolean;
  /**
   * Work evidence for the run window (see module doc). `null` = unknown —
   * treated as has-work so missing evidence cannot downgrade a run.
   */
  workMessageCount: number | null;
}

export function classifyScheduledRunOutcome(
  input: ClassifyScheduledRunOutcomeInput,
): ScheduledRunOutcome {
  if (!input.submitted) {
    return isWallClockBudgetError(input.errorMessage) ? 'timeout' : 'crashed';
  }
  if (input.turnSettledAbnormally) {
    return 'crashed';
  }
  return input.workMessageCount === 0 ? 'completed_empty' : 'completed';
}

/** Message types that count as actual work in a run window. */
const WORK_MESSAGE_TYPES = new Set(['assistant', 'tool_use']);

/** Minimal message shape the counter needs (CoworkMessage-compatible). */
export interface RunWindowMessageLike {
  type: string;
  timestamp: number;
}

/**
 * Count the work messages a run produced: `assistant` / `tool_use` messages
 * persisted at `timestamp >= runStartMs`. The scheduler awaits the whole
 * turn, so at classification time the window [runStartMs, now] holds exactly
 * this fire's output even in a standing 'series' conversation (concurrent
 * fires are excluded by the idle-check gate, not by the timestamp).
 * Returns the count; the caller passes it straight to the classifier.
 */
export function countRunWorkMessages(
  messages: ReadonlyArray<RunWindowMessageLike>,
  runStartMs: number,
): number {
  let count = 0;
  for (const message of messages) {
    if (WORK_MESSAGE_TYPES.has(message.type) && message.timestamp >= runStartMs) {
      count += 1;
    }
  }
  return count;
}
