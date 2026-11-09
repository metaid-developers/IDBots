import { collectMetaTaskEvents, rosterPinsFromEvents, type CollectMetaTaskEventsOptions } from './collector';
import { nextTimeDeadlineMs } from './deadlines';
import { replayMetaTask, taskDirtyKey, taskEventSet, type MetaTaskTaskEventSet } from './engine';
import type { MetaTaskBoard, MetaTaskTaskProjection } from './types';
import type { MetaTaskProjectionStore } from './projectionStore';
import type { PollBackoffController } from '../pollBackoffController';

export interface MetaTaskRefreshResult {
  ok: boolean;
  board: MetaTaskBoard | null;
  error: string | null;
}

export interface MetaTaskRefreshOptions {
  /**
   * Start even when the minimum-interval window has not elapsed. The heartbeat
   * uses this: its own cadence already spaces it out, and it must never be
   * deferred by a burst of tool-triggered requests.
   */
  bypassMinInterval?: boolean;
  /**
   * Skip the protocol-pin walk memo for this sweep (write-following refreshes
   * must observe the just-pinned rows; the incremental head-stop still walks
   * the pool head, so cost stays at one page for a quiet pool).
   */
  bypassCache?: boolean;
}

export interface MetaTaskRefresherOptions {
  store: () => MetaTaskProjectionStore;
  rosterMetaIds?: () => string[];
  collectOptions?: CollectMetaTaskEventsOptions;
  /**
   * Minimum spacing between sweeps STARTED by ordinary callers (tools, IPC).
   * Requests inside the window do not run immediately: exactly one trailing
   * sweep is scheduled for when the window elapses. 0 disables coalescing.
   */
  minIntervalMs?: number;
  /** Clock seam (default Date.now). */
  now?: () => number;
  /** Push hook: called with the bumped seq after every successful refresh. */
  onUpdated?: (payload: { seq: number; reason: string }) => void;
  /**
   * Issue #24 retry hygiene for the periodic heartbeat sweep: ok:false sweeps
   * record failures (escalating ladder + circuit breaker) and the heartbeat
   * consults refreshBackoffReady() before each sweep. Absent = no gating.
   */
  backoff?: PollBackoffController;
}

/**
 * Chain → projection pipeline for the MetaTask tab (P1 read path):
 * collect the ten pools → cache events → replay the DIRTY task roots → persist
 * projections → board. The chain is the source of truth; everything in the
 * store is a rebuildable projection. A failed network sweep keeps the last
 * good projections and records the error for the freshness line.
 *
 * P2 scale hardening:
 *  - a root whose replay-relevant event set is unchanged (and whose persisted
 *    projection has no pending time-driven deadline) is not replayed and its
 *    row is not rewritten;
 *  - ordinary callers are coalesced to at most one sweep per minIntervalMs
 *    (heartbeat callers bypass it).
 */
export class MetaTaskRefresher {
  private readonly options: MetaTaskRefresherOptions;
  private readonly minIntervalMs: number;
  private readonly now: () => number;
  private inFlight: Promise<MetaTaskRefreshResult> | null = null;
  /** Start instant of the last sweep that actually began (ms). */
  private lastStartedAtMs: number | null = null;
  private trailing: { timer: ReturnType<typeof setTimeout> | null; promise: Promise<MetaTaskRefreshResult> } | null = null;

  constructor(options: MetaTaskRefresherOptions) {
    this.options = options;
    this.minIntervalMs = Math.max(0, Math.trunc(options.minIntervalMs ?? 60_000));
    this.now = options.now ?? Date.now;
  }

  board(): MetaTaskBoard {
    return this.options.store().board(this.roster());
  }

  detail(rootPinId: string): MetaTaskTaskProjection | null {
    return this.options.store().getProjection(rootPinId);
  }

  /** All cached chain events — engine input for guards and replays. */
  loadEvents(): import('./types').MetaTaskChainEvent[] {
    return this.options.store().loadEvents();
  }

  private roster(): string[] {
    return this.options.rosterMetaIds ? this.options.rosterMetaIds() : [];
  }

  /**
   * Sweep the chain. Concurrent callers share the in-flight sweep; callers
   * inside the minimum-interval window share exactly one trailing sweep.
   */
  refreshOnce(reason: string, options: MetaTaskRefreshOptions = {}): Promise<MetaTaskRefreshResult> {
    if (this.inFlight) return this.inFlight;
    const nowMs = this.now();
    if (
      !options.bypassMinInterval &&
      this.minIntervalMs > 0 &&
      this.lastStartedAtMs !== null &&
      nowMs - this.lastStartedAtMs < this.minIntervalMs
    ) {
      return this.scheduleTrailing(reason, options);
    }
    return this.start(reason, options);
  }

  /** Cancel a pending coalesced sweep (app shutdown). */
  dispose(): void {
    if (this.trailing?.timer) clearTimeout(this.trailing.timer);
    this.trailing = null;
  }

  /**
   * Issue #24: backoff gate for the periodic heartbeat sweep — false while
   * the shared controller has the ladder delay pending or the circuit open
   * (asking past the cooldown flips the circuit to half-open: one probe).
   * Absent controller = always ready (no gating).
   */
  refreshBackoffReady(): boolean {
    return this.options.backoff ? this.options.backoff.ready() : true;
  }

  private start(reason: string, options: MetaTaskRefreshOptions = {}): Promise<MetaTaskRefreshResult> {
    this.lastStartedAtMs = this.now();
    this.inFlight = this.runRefresh(reason, this.lastStartedAtMs, options).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private scheduleTrailing(reason: string, options: MetaTaskRefreshOptions = {}): Promise<MetaTaskRefreshResult> {
    if (this.trailing) return this.trailing.promise;
    const waitMs = Math.max(0, (this.lastStartedAtMs ?? this.now()) + this.minIntervalMs - this.now());
    const entry: { timer: ReturnType<typeof setTimeout> | null; promise: Promise<MetaTaskRefreshResult> } = {
      timer: null,
      promise: null as unknown as Promise<MetaTaskRefreshResult>,
    };
    entry.promise = new Promise<MetaTaskRefreshResult>((resolve) => {
      entry.timer = setTimeout(() => {
        this.trailing = null;
        // runRefresh never rejects (it records the failure and reports ok:false),
        // so a failing trailing sweep cannot wedge the scheduler.
        resolve(this.start(`${reason}+coalesced`, options));
      }, waitMs);
      // Never hold the process open for a pending coalesced sweep.
      entry.timer.unref?.();
    });
    this.trailing = entry;
    return entry.promise;
  }

  /**
   * A skipped replay is only safe while no time-driven clock has crossed since
   * the last one (claim TTL / review window / challenge TTL — see deadlines.ts).
   * Challenge candidates come from the scoped event set, because the projection
   * exposes only the `disputed` flag, not challenge timestamps.
   */
  private deadlinePending(
    projection: MetaTaskTaskProjection,
    taskSet: MetaTaskTaskEventSet,
    nowMs: number
  ): boolean {
    const deadline = nextTimeDeadlineMs(projection, {
      challengeTimestampsMs: taskSet.scoped
        .filter((pin) => pin.path === 'challenge')
        .map((pin) => pin.timestampMs),
    });
    if (deadline === null) return false;
    // The engine transitions on `now > deadline`, so a deadline below the last
    // replay instant already fired then; only [evaluatedAtMs, now) can still trip.
    const evaluatedAtMs = projection.freshness?.evaluatedAtMs ?? 0;
    return deadline >= evaluatedAtMs && deadline < nowMs;
  }

  private async runRefresh(
    reason: string,
    nowMs: number,
    options: MetaTaskRefreshOptions = {}
  ): Promise<MetaTaskRefreshResult> {
    const store = this.options.store();
    store.setRefreshing(true);
    try {
      const collected = await collectMetaTaskEvents({
        ...this.options.collectOptions,
        ...(options.bypassCache ? { bypassCache: true } : {}),
      });
      // Issue #24: the collector deliberately swallows pool-walk failures into
      // per-path `error` fields (a failed path must not fail the whole sweep),
      // so a total network outage still lands here with ok semantics. A sweep
      // where EVERY pool failed to walk is the outage shape — feed the backoff
      // ladder; any healthy pool counts as success.
      const walkedPools = collected.perPath.length;
      const failedPools = collected.perPath.filter((entry) => Boolean(entry.error)).length;
      const totalWalkFailure = walkedPools > 0 && failedPools === walkedPools;
      store.upsertEvents(collected.events);
      const allEvents = store.loadEvents();
      // Same-side roster pins travel with the event set: the engine filters a
      // post-H_ACT2 vote whose voter shares a roster group with the submitter
      // or the root author (pre-H_ACT2 votes stay untouched, so the pilots'
      // projections are unchanged).
      const rosterPins = rosterPinsFromEvents(allEvents);
      const roots = allEvents.filter((event) => event.path === 'task');
      const persisted = new Map(store.projectionSweepState().map((row) => [row.rootPinId, row]));
      const projections: MetaTaskTaskProjection[] = [];
      const liveRootIds: string[] = [];
      const dirtyKeys: Record<string, string> = {};
      for (const root of roots) {
        // Live roots are declared even when their replay fails, so a malformed
        // task keeps its last good row instead of being pruned.
        liveRootIds.push(root.pinId);
        let taskSet: MetaTaskTaskEventSet;
        try {
          taskSet = taskEventSet(allEvents, { rootPinId: root.pinId });
        } catch {
          continue;
        }
        const dirtyKey = taskDirtyKey(taskSet, { rosterPins });
        dirtyKeys[root.pinId] = dirtyKey;
        const previous = persisted.get(root.pinId);
        if (
          previous &&
          previous.dirtyKey === dirtyKey &&
          !this.deadlinePending(previous.projection, taskSet, nowMs)
        ) {
          // Unchanged event set, no pending clock: the persisted row already
          // says exactly what a replay would — leave it untouched.
          continue;
        }
        try {
          projections.push(
            replayMetaTask(allEvents, {
              rootPinId: root.pinId,
              now: nowMs,
              evaluatedAtMs: nowMs,
              rosterPins,
            })
          );
        } catch {
          // one malformed task must not fail the sweep; next refresh retries it
        }
      }
      // Identity enrichment runs only for the replayed roots: a skipped row
      // already carries its persisted identities.
      await store.enrichIdentities(projections);
      store.saveProjections(projections, { liveRootIds, dirtyKeys });
      const boundaryBlock = projections.reduce(
        (max, projection) => Math.max(max, projection.freshness.boundaryBlock),
        -1
      );
      store.markRefreshDone(true, null, boundaryBlock);
      const seq = store.bumpSeq();
      this.options.onUpdated?.({ seq, reason });
      if (totalWalkFailure) {
        this.options.backoff?.recordFailure();
      } else {
        this.options.backoff?.recordSuccess();
      }
      return { ok: true, board: store.board(this.roster()), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      store.markRefreshDone(false, message, -1);
      this.options.backoff?.recordFailure();
      return { ok: false, board: store.board(this.roster()), error: message };
    }
  }
}
