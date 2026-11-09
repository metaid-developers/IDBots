import { randomUUID } from 'node:crypto';
import { broadcastToRenderers } from '../ipc/broadcast';
import {
  ScheduledTaskStore,
  ScheduledTask,
  ScheduledTaskRun,
  Schedule,
  NotifyPlatform,
  ScheduledTaskMemoryAccess,
  SCHEDULED_TASK_MEMORY_ACCESS_LEVELS,
} from '../scheduledTaskStore';
import type { CoworkMessage, CoworkSession, CoworkStore, DreamPracticeProposalRecord } from '../coworkStore';
import type { CoworkRunner } from './coworkRunner';
import { resolveSessionWorkingDirectory } from './botWorkspace';
import { resolveCoworkExecutionMode } from './coworkExecutionMode';
import { buildScheduledRunReportMessage, tailDispatchReportExcerpt } from './coworkCrossSessionReport';
import { createPracticeSessionState, PRACTICE_RUN_WATCHDOG_MS } from './practiceInteractionGuard';
import type { IMGatewayManager } from '../im/imGatewayManager';
import type { CoworkSubmitInput, CoworkSubmitInputResult } from '../services/coworkTurnSubmission';

type SubmitToSessionFailure = Extract<CoworkSubmitInputResult, { success: false }>;

/**
 * Structural view of CoworkSubmitInputResult the scheduler consumes. `success`
 * is a plain boolean on purpose: electron-tsconfig runs with strictNullChecks
 * off, where a boolean-literal discriminant does not narrow.
 */
type SubmitToSessionResult = { success: boolean; error?: SubmitToSessionFailure['error'] };

/**
 * Memory-surface runner options for an ordinary scheduled task, derived from
 * its per-task opt-in (SCHEDULED_TASK_MEMORY_ACCESS_LEVELS). `none` keeps the
 * legacy blackout (disableMemoryUpdates blocks memory reads AND writes —
 * the pre-opt-in behavior of every scheduled task); `read-only` mounts the
 * recall tools without the mutating ones; `read-write` leaves both flags off.
 * Unknown values fall back to 'none' so a hand-edited row cannot silently
 * widen the surface.
 */
function resolveMemoryAccessRunnerOptions(memoryAccess: ScheduledTaskMemoryAccess | string | null | undefined): {
  disableMemoryUpdates?: boolean;
  memoryReadOnly?: boolean;
} {
  const normalized = SCHEDULED_TASK_MEMORY_ACCESS_LEVELS.includes(memoryAccess as ScheduledTaskMemoryAccess)
    ? (memoryAccess as ScheduledTaskMemoryAccess)
    : 'none';
  if (normalized === 'read-only') return { memoryReadOnly: true };
  if (normalized === 'read-write') return {};
  return { disableMemoryUpdates: true };
}

interface SchedulerDeps {
  scheduledTaskStore: ScheduledTaskStore;
  coworkStore: CoworkStore;
  getCoworkRunner: () => CoworkRunner;
  getIMGatewayManager?: () => IMGatewayManager | null;
  getSkillsPrompt?: () => Promise<string | null>;
  isRecoverableSqliteError?: (error: unknown) => boolean;
  recoverSqlite?: (error: unknown, operationName: string) => void | Promise<void>;
  /** Wall-clock budget for a practice run; tests shrink it. Defaults to PRACTICE_RUN_WATCHDOG_MS. */
  practiceRunWatchdogMs?: number;
  /**
   * Injects a prompt into an existing cowork session (the same seam the
   * renderer's submit-input IPC uses). Enables scheduled tasks bound to a
   * session via `targetSessionId` to post their prompt there instead of
   * spawning a fresh session.
   */
  submitToSession?: (input: CoworkSubmitInput) => Promise<SubmitToSessionResult>;
  /**
   * Forwards a message the scheduler persisted itself (a fire's prompt, the
   * rotation pointer) to open renderers — the runner only emits what it
   * writes, so without this a standing conversation the owner has open would
   * not show the new fire's prompt until reloaded.
   */
  emitSessionMessage?: (sessionId: string, message: CoworkMessage) => void;
  /** Owner's UI language ('zh' | 'en') for the copy the scheduler writes into sessions. */
  getAppLanguage?: () => string;
  /** How long a fire waits for its busy standing conversation; tests shrink it. */
  seriesSessionBusyWaitMs?: number;
  /** How often the wait polls for idle; tests shrink it alongside the wait. */
  seriesSessionBusyPollMs?: number;
}

/**
 * Standing-conversation budget for a 'series' task (2026-11-09). Checked
 * BEFORE each fire; crossing either limit rotates the task into a successor
 * conversation titled `[定时] <name>（N）`.
 * - Context: the provider-reported share of the context window the
 *   conversation filled on its last turn (`usage_stats.lastRealContextUsage`,
 *   persisted for every DSH turn). 0.6 leaves headroom for the fire itself and
 *   usually rotates before the runtime has to compact a fat transcript.
 * - Messages: a row backstop for sessions with no real usage reading and for
 *   transcripts that compaction keeps under the ratio but that otherwise grow
 *   without bound. Rows include tool traffic; recurring tasks average 9–95
 *   rows per fire (one outlier ~270), so 1200 rows still hold a week or more
 *   of a typical daily task.
 */
export const SERIES_SESSION_CONTEXT_RATIO_LIMIT = 0.6;
export const SERIES_SESSION_MESSAGE_LIMIT = 1200;

const SCHEDULED_SESSION_TITLE_PREFIX = '[定时] ';

/**
 * Title of a scheduled task's conversation: `[定时] <name>`, plus a `（N）`
 * generation suffix from the second standing conversation on. A stored
 * title, not UI chrome (like the `[长期]` long-term titles): the sidebar fold
 * and the legacy message-origin labels key off the prefix. The task name is
 * written by the creating bot (or typed by the owner), so the title is the
 * human-readable label of the task's whole conversation.
 *
 * Exported for tests.
 */
export function buildScheduledSessionTitle(taskName: string, generation: number = 1): string {
  const base = `${SCHEDULED_SESSION_TITLE_PREFIX}${taskName}`;
  return generation > 1 ? `${base}（${generation}）` : base;
}

/**
 * Generation of a standing conversation, read back from its title: the base
 * title is 1, `…（N）` is N. A title that no longer matches the task name
 * (either was renamed) reads as 1, so its successor is simply `（2）` — the
 * title is only a label; the binding is the stored session id.
 *
 * Exported for tests.
 */
export function readScheduledSessionGeneration(title: string, taskName: string): number {
  const base = buildScheduledSessionTitle(taskName);
  if (title.startsWith(base)) {
    const match = /^（(\d+)）$/.exec(title.slice(base.length));
    if (match) return Math.max(1, Number(match[1]));
  }
  return 1;
}

/**
 * Provider-reported context-window share of a session's last turn, read from
 * its persisted usage stats; null when the session has no real reading yet.
 *
 * Exported for tests.
 */
export function readSessionContextUsageRatio(usageStats: Record<string, unknown> | null | undefined): number | null {
  const usage = usageStats?.lastRealContextUsage;
  if (!usage || typeof usage !== 'object') return null;
  const { usageRatio, usedTokens, contextWindow, isRealUsage } = usage as Record<string, unknown>;
  if (isRealUsage === false) return null;
  if (typeof usageRatio === 'number' && Number.isFinite(usageRatio)) return usageRatio;
  if (typeof usedTokens === 'number' && typeof contextWindow === 'number' && contextWindow > 0) {
    return usedTokens / contextWindow;
  }
  return null;
}

/**
 * Where a 'series' fire runs, decided before the turn starts:
 * - `reuse`: continue the standing conversation;
 * - `new`: open the task's first standing conversation;
 * - `rotate`: open the successor of a standing conversation that outgrew its
 *   budget (`budget`) or can no longer host fires — archived by the owner,
 *   moved to another bot (`retired`);
 * - `fresh`: the task opted out — a one-off session, nothing is seated.
 */
type ScheduledSessionSeat =
  | { kind: 'fresh' }
  | { kind: 'new' }
  | { kind: 'reuse'; sessionId: string }
  | {
      kind: 'rotate';
      cause: 'budget' | 'retired';
      detail: string;
      previousSessionId: string;
      previousTitle: string;
      generation: number;
    };

/**
 * The factual frame of a 'series' fire, prepended after the lifecycle
 * preamble: whether the bot continues the task's standing conversation (its
 * earlier fires are in context) or starts a rotation successor (they are not
 * — the previous conversation's last result rides along as the only anchor).
 * A first standing conversation and every 'fresh' fire get no note.
 *
 * Exported for tests.
 */
export function buildScheduledSessionContinuityNote(
  input:
    | { kind: 'reuse' }
    | {
        kind: 'rotate';
        cause: 'budget' | 'retired';
        generation: number;
        previousTitle: string;
        previousSessionId: string;
        previousResult?: { excerpt: string; truncated: boolean } | null;
      },
): string {
  if (input.kind === 'reuse') {
    return [
      '[Standing conversation] Earlier fires of this task ran in this same conversation — their results are above; build on them instead of starting over.',
      'An owner request from an earlier fire that is still unanswered stays open: carry it in this run\'s follow-up tag.',
    ].join('\n');
  }
  const why = input.cause === 'budget'
    ? 'reached its size budget'
    : 'can no longer host this task (archived or reassigned)';
  const lines = [
    `[Standing conversation rotated] This is conversation #${input.generation} for this task: the previous one ("${input.previousTitle}", session ${input.previousSessionId}) ${why} and stays readable as an archive. None of its history is in this conversation; later fires of this task continue here.`,
  ];
  if (input.previousResult?.excerpt) {
    lines.push(
      `Last result in the previous conversation${input.previousResult.truncated ? ' (tail excerpt)' : ''}, for continuity:`,
      input.previousResult.excerpt,
    );
  }
  return lines.join('\n');
}

class SchedulerStoppedError extends Error {
  constructor() {
    super('Scheduler was stopped');
    this.name = 'SchedulerStoppedError';
  }
}

/**
 * End-of-run follow-up contract, prepended to EVERY scheduled run's prompt
 * (one-shot and recurring alike). The firing bot ends its final message with
 * an explicit follow-up declaration tag; the Follow-Up Tasks gate consumes it
 * deterministically (see parseFollowUpDeclaration in
 * cerebellum/sessionFollowUpGate.ts) instead of leaving the decision to the
 * classifier's prose reading alone. The host defines the contract; the bot owns
 * the verdict (protocol-standard over host heuristics).
 *
 * Exported for tests.
 */
export function buildScheduledTaskFollowUpContract(): string {
  return [
    '[End-of-run follow-up contract] End this run\'s final message with exactly ONE tag on its own line:',
    '- `[FOLLOW_UP: none]` — nothing in this run needs the owner\'s decision, approval, funds, or reply: the work is complete, the next step is yours, or the wait is on another bot, person, or group (their follow-up, not the owner\'s).',
    '- `[FOLLOW_UP: owner — <one short phrase naming what the owner must decide, approve, or provide>]` — ONLY when the owner personally must act before this work can proceed.',
    'Never omit the tag. Never tag `owner` for risks owned by other bots or third parties, conditional offers ("I can also … if you want"), or purely informational notes — tag `none` and keep handling those yourself. The tag routes this session between the owner\'s Follow-Up list and the autonomous fold; a missing or wrong tag costs the owner attention they did not owe.',
  ].join('\n');
}

/**
 * Lifecycle preamble prepended to a recurring task's prompt at fire time.
 * The host only states FACTS (fire number, budget, declared exit condition,
 * origin pointer); deciding whether the condition is met stays with the bot
 * (protocol-standard over host heuristics). One-shot 'at' tasks get no
 * lifecycle preamble — the host already disables them after execution (they
 * still get the follow-up contract via buildScheduledTaskFollowUpContract).
 *
 * Exported for tests.
 */
export function buildScheduledTaskLifecyclePreamble(task: ScheduledTask): string {
  if (task.schedule.type === 'at') return '';

  const fireNumber = (task.fireCount ?? 0) + 1;
  const maxFires = task.maxFires ?? null;
  const remaining = maxFires != null ? maxFires - fireNumber : null;
  const lines: string[] = [`[Scheduled task lifecycle] Task "${task.name}" (id ${task.id}), fire #${fireNumber}.`];

  if (maxFires != null) {
    lines.push(
      remaining > 0
        ? `Fire budget: ${maxFires} total, ${remaining} remaining after this one.`
        : `Fire budget: ${maxFires} total — this is the FINAL fire; the task will be disabled automatically after this run. Finish or hand off anything it is responsible for.`
    );
  }

  lines.push(
    task.exitCondition?.trim()
      ? `Exit condition (declared at creation): "${task.exitCondition.trim()}"`
      : 'No exit condition was declared for this task — scrutinize whether it still has a reason to run.'
  );

  lines.push(
    `After this run's work, decide whether this task still deserves to exist. If the exit condition is met, or the reason this task exists is gone (the upstream order/thread/group task it serves is finished or moot), retire it now: bash "$SKILLS_ROOT/scheduled-task/scripts/toggle-task.sh" ${task.id} false — then state in your final message that you retired the task and why. Keeping a task whose purpose has ended is a defect, not caution.`
  );

  if (task.originSessionId) {
    lines.push(`Created from session ${task.originSessionId}${task.originContext ? ` (${task.originContext})` : ''} — consult it if the task's purpose is unclear.`);
  }

  return lines.join('\n');
}

export class Scheduler {
  private store: ScheduledTaskStore;
  private coworkStore: CoworkStore;
  private getCoworkRunner: () => CoworkRunner;
  private getIMGatewayManager: (() => IMGatewayManager | null) | null;
  private getSkillsPrompt: (() => Promise<string | null>) | null;
  private isRecoverableSqliteError: ((error: unknown) => boolean) | null;
  private recoverSqlite: ((error: unknown, operationName: string) => void | Promise<void>) | null;
  private submitToSession: ((input: CoworkSubmitInput) => Promise<SubmitToSessionResult>) | null;
  private emitSessionMessage: ((sessionId: string, message: CoworkMessage) => void) | null;
  private getAppLanguage: (() => string) | null;
  private readonly practiceRunWatchdogMs: number;
  private readonly seriesSessionBusyWaitMs: number;
  private readonly seriesSessionBusyPollMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeTasks: Map<string, AbortController> = new Map();
  // Per-run liveness timers, keyed like activeTasks. A live run keeps its own
  // `running_at_ms` marker fresh so other schedulers can tell it from an orphan.
  private runHeartbeats: Map<string, ReturnType<typeof setInterval>> = new Map();
  // Track cowork session IDs for running tasks so we can stop them
  private taskSessionIds: Map<string, string> = new Map();
  private stopGeneration = 0;

  private static readonly MAX_TIMER_INTERVAL_MS = 60_000;
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;
  /**
   * How often a live run refreshes its `running_at_ms` marker. Deliberately a
   * per-run timer and not part of the tick loop: tick() awaits
   * Promise.all(executions), so a long run blocks later ticks and a
   * tick-driven heartbeat would go silent exactly when the run needs it most.
   */
  private static readonly RUN_HEARTBEAT_INTERVAL_MS = 2 * 60_000;
  /**
   * How stale a `running_at_ms` marker must be before this scheduler may treat
   * it as abandoned. 5× the heartbeat interval, so a live run survives four
   * consecutive missed heartbeats before its marker becomes eligible for
   * release — a foreign marker younger than this is presumed live and left
   * alone.
   */
  private static readonly RUN_LIVENESS_LEASE_MS = 10 * 60_000;
  /**
   * How long a fire waits for its standing conversation to go idle (the owner
   * chatting in it, a relayed turn) before it runs in a one-off session
   * instead. tick() awaits every execution, so the wait stays short.
   */
  private static readonly SERIES_SESSION_BUSY_WAIT_MS = 2 * 60_000;
  private static readonly SERIES_SESSION_BUSY_POLL_MS = 2_000;

  constructor(deps: SchedulerDeps) {
    this.store = deps.scheduledTaskStore;
    this.coworkStore = deps.coworkStore;
    this.getCoworkRunner = deps.getCoworkRunner;
    this.getIMGatewayManager = deps.getIMGatewayManager ?? null;
    this.getSkillsPrompt = deps.getSkillsPrompt ?? null;
    this.isRecoverableSqliteError = deps.isRecoverableSqliteError ?? null;
    this.recoverSqlite = deps.recoverSqlite ?? null;
    this.submitToSession = deps.submitToSession ?? null;
    this.emitSessionMessage = deps.emitSessionMessage ?? null;
    this.getAppLanguage = deps.getAppLanguage ?? null;
    this.practiceRunWatchdogMs = deps.practiceRunWatchdogMs ?? PRACTICE_RUN_WATCHDOG_MS;
    this.seriesSessionBusyWaitMs = Math.max(0, deps.seriesSessionBusyWaitMs ?? Scheduler.SERIES_SESSION_BUSY_WAIT_MS);
    this.seriesSessionBusyPollMs = Math.max(1, deps.seriesSessionBusyPollMs ?? Scheduler.SERIES_SESSION_BUSY_POLL_MS);
  }

  // --- Lifecycle ---

  start(): void {
    if (this.running) return;
    this.running = true;
    console.log('[Scheduler] Started');
    this.scheduleNext();
  }

  stop(): void {
    this.stopGeneration += 1;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [, controller] of this.activeTasks) {
      controller.abort();
    }
    this.activeTasks.clear();
    for (const [, heartbeat] of this.runHeartbeats) {
      clearInterval(heartbeat);
    }
    this.runHeartbeats.clear();
    console.log('[Scheduler] Stopped');
  }

  /**
   * Ids of scheduled tasks currently executing (abort controllers live for the
   * whole run). Used by the sleep guard to keep the device awake while a
   * scheduled task is running.
   */
  getActiveTaskIds(): string[] {
    return Array.from(this.activeTasks.keys());
  }

  reschedule(): void {
    if (!this.running) return;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.scheduleNext();
  }

  // --- Core Scheduling ---

  private scheduleNext(): void {
    if (!this.running) return;

    let nextDueMs: number | null;
    try {
      nextDueMs = this.store.getNextDueTimeMs();
    } catch (error) {
      void this.handleSchedulerError(error, 'scheduledTask:scheduleNext').then((handled) => {
        if (!handled) {
          this.scheduleRetryAfterError();
        }
      });
      return;
    }
    const now = Date.now();

    let delayMs: number;
    if (nextDueMs === null) {
      delayMs = Scheduler.MAX_TIMER_INTERVAL_MS;
    } else {
      delayMs = Math.min(
        Math.max(nextDueMs - now, 0),
        Scheduler.MAX_TIMER_INTERVAL_MS
      );
    }

    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick();
    }, delayMs);
  }

  private scheduleRetryAfterError(): void {
    if (!this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.runTick();
    }, Scheduler.MAX_TIMER_INTERVAL_MS);
  }

  private runTick(): void {
    const tickGeneration = this.stopGeneration;
    let shouldScheduleNext = true;

    void this.tick(tickGeneration)
      .catch(async (error) => {
        shouldScheduleNext = !(await this.handleSchedulerError(error, 'scheduledTask:tick'));
      })
      .finally(() => {
        if (shouldScheduleNext && this.running && tickGeneration === this.stopGeneration) {
          this.scheduleNext();
        }
      });
  }

  /**
   * One pass over the due set. A fire can be dropped silently by the store's
   * `running_at_ms IS NULL` / `expires_at` filters or by the guards inside
   * executeTask, so the tick also sweeps orphaned running markers into the
   * ledger. Disabled and expired tasks are deliberately NOT ledgered per tick:
   * a disabled task has no pending fire (disabling nulls `next_run_at_ms`), and
   * an expired one would otherwise write a skip on every tick for as long as it
   * stays expired — pure noise. Their reason codes remain available for the
   * moment a fire does reach the scheduler.
   */
  private async tick(tickGeneration: number): Promise<void> {
    if (!this.running || tickGeneration !== this.stopGeneration) return;

    this.ledgerStuckRunningTasks();
    if (!this.running || tickGeneration !== this.stopGeneration) return;

    const now = Date.now();
    const dueTasks = this.store.getDueTasks(now);
    if (!this.running || tickGeneration !== this.stopGeneration) return;

    const executions = dueTasks.map((task) => this.executeTask(task, 'scheduled', tickGeneration));
    await Promise.all(executions);
  }

  /**
   * Ledger orphaned runs as `stuck_running` skips. `getDueTasks` filters on
   * `running_at_ms IS NULL`, so a marker left behind by a run that no longer
   * has a live execution (scheduler stopped mid-run, lost run) silently wedges
   * the task out of the due set.
   *
   * Liveness has two sources, and a marker must fail BOTH before it is
   * released. `activeTasks` proves liveness for runs owned by this process.
   * For every other marker the only evidence is the marker itself: a live run
   * refreshes `running_at_ms` through its heartbeat, so a marker younger than
   * RUN_LIVENESS_LEASE_MS is presumed to belong to a live run in another
   * process and is left alone — releasing it would hand the task back to the
   * due set and fire it a second time. Only a marker that is both locally
   * inactive and older than the lease is an orphan.
   *
   * Recording the skip puts the dropped execution in the ledger; releasing the
   * marker lets the task fire again. Errors propagate so the tick's recovery
   * path still sees them.
   */
  private ledgerStuckRunningTasks(): void {
    const now = Date.now();
    for (const task of this.store.getRunningTasks()) {
      if (this.activeTasks.has(task.id)) continue;

      // A marker with no usable timestamp carries no liveness evidence at all;
      // only a number can prove a run is recent enough to be alive.
      const runningAtMs = task.state.runningAtMs;
      const markerAgeMs = typeof runningAtMs === 'number' && Number.isFinite(runningAtMs)
        ? now - runningAtMs
        : Number.POSITIVE_INFINITY;
      if (markerAgeMs < Scheduler.RUN_LIVENESS_LEASE_MS) continue;

      const run = this.store.recordSkippedRun(task.id, 'stuck_running', 'scheduled');
      this.store.releaseStuckRunningTask(task.id);
      this.emitRunUpdate(run);
      // Practice loop closure for abandoned runs: the proposal must not stay
      // 'scheduled' forever — record the dropped execution as failed.
      try {
        const practiceProposal = this.resolvePracticeProposal(task);
        if (practiceProposal) {
          this.coworkStore.markDreamPracticeProposalFailed?.({
            id: practiceProposal.id,
            metabotId: practiceProposal.metabotId,
            runId: run.id,
            outcomeSummary: 'practice run abandoned (stuck running marker released)',
          });
        }
      } catch {
        // Best effort — the run ledger entry above is the authoritative record.
      }
      console.warn(
        `[Scheduler] Task ${task.id} had an orphaned running marker; recorded a stuck_running skip`
      );
    }
  }

  /**
   * The dream practice proposal this task was materialized from (linked via
   * dream_practice_proposals.scheduled_task_id), or null for ordinary
   * scheduled tasks. Only a proposal still in 'scheduled' state activates the
   * practice policy — a proposal rejected after approval must not run under
   * it. Optional-call style keeps partial CoworkStore stubs (tests) safe.
   */
  private resolvePracticeProposal(task: ScheduledTask): DreamPracticeProposalRecord | null {
    try {
      const lookup = this.coworkStore.getDreamPracticeProposalByScheduledTaskId;
      if (typeof lookup !== 'function') return null;
      const proposal = lookup.call(this.coworkStore, task.id);
      return proposal && proposal.status === 'scheduled' ? proposal : null;
    } catch {
      return null;
    }
  }

  private isRecoverableSqliteFailure(error: unknown): boolean {
    return Boolean(this.isRecoverableSqliteError?.(error));
  }

  private async handleSchedulerError(error: unknown, operationName: string): Promise<boolean> {
    if (this.isRecoverableSqliteFailure(error) && this.recoverSqlite) {
      try {
        await this.recoverSqlite(error, operationName);
      } catch (recoveryError) {
        console.error(`[Scheduler] SQLite recovery failed for ${operationName}:`, recoveryError);
      }
      return true;
    }

    console.error(`[Scheduler] ${operationName} failed:`, error);
    return false;
  }

  private assertExecutionCurrent(executionGeneration: number): void {
    if (executionGeneration !== this.stopGeneration) {
      throw new SchedulerStoppedError();
    }
  }

  // --- Task Execution ---

  async executeTask(
    task: ScheduledTask,
    trigger: 'scheduled' | 'manual',
    executionGeneration: number = this.stopGeneration,
  ): Promise<void> {
    if (trigger === 'scheduled' && (!this.running || executionGeneration !== this.stopGeneration)) {
      return;
    }
    if (this.activeTasks.has(task.id)) {
      console.log(`[Scheduler] Task ${task.id} already running, skipping`);
      this.emitRunUpdate(this.store.recordSkippedRun(task.id, 'already_running', trigger));
      return;
    }

    // Check if task has expired (skip for manual triggers)
    if (trigger === 'scheduled' && task.expiresAt) {
      const todayStr = new Date().toISOString().slice(0, 10);
      if (task.expiresAt <= todayStr) {
        console.log(`[Scheduler] Task ${task.id} expired (${task.expiresAt}), skipping`);
        this.emitRunUpdate(this.store.recordSkippedRun(task.id, 'expired', trigger));
        return;
      }
    }

    const startTime = Date.now();

    // Claim the task in the store. The activeTasks check above only proves that
    // THIS process is not already running it; the store predicate is what
    // excludes another process that saw the same due entry. Losing the claim
    // means someone else owns this execution, so this fire is a duplicate: it
    // is ledgered and dropped without touching the run/session bookkeeping.
    if (!this.store.tryMarkTaskRunning(task.id, startTime)) {
      console.log(`[Scheduler] Task ${task.id} is claimed by another run, skipping`);
      this.emitRunUpdate(this.store.recordSkippedRun(task.id, 'already_running', trigger));
      return;
    }

    let run: ScheduledTaskRun;
    try {
      run = this.store.createRun(task.id, trigger);
    } catch (err) {
      // Release the claim we just took: leaving the marker set would wedge the
      // task out of the due set until the liveness lease expires.
      this.store.releaseStuckRunningTask(task.id);
      throw err;
    }

    this.emitTaskStatusUpdate(task.id);
    this.emitRunUpdate(run);

    const abortController = new AbortController();
    this.activeTasks.set(task.id, abortController);

    // Keep the claim fresh for as long as the run lives. Started only after the
    // claim landed, so a process that lost the race never advertises liveness
    // for a run it does not own.
    const heartbeat = setInterval(() => {
      try {
        this.store.touchTaskRunning(task.id, Date.now());
      } catch (err) {
        // A failed refresh must not kill the run; the run itself is still
        // recorded through the normal path.
        console.warn(`[Scheduler] Task ${task.id} heartbeat failed:`, err);
      }
    }, Scheduler.RUN_HEARTBEAT_INTERVAL_MS);
    // Never hold the event loop open just for a liveness tick.
    heartbeat.unref?.();
    this.runHeartbeats.set(task.id, heartbeat);

    let sessionId: string | null = null;
    let success = false;
    let error: string | null = null;

    try {
      sessionId = await this.startCoworkSession(task, executionGeneration, abortController.signal);
      success = true;
    } catch (err: unknown) {
      if (!(err instanceof SchedulerStoppedError)) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[Scheduler] Task ${task.id} failed:`, error);
      }
    } finally {
      const durationMs = Date.now() - startTime;
      clearInterval(heartbeat);
      this.runHeartbeats.delete(task.id);
      this.activeTasks.delete(task.id);
      this.taskSessionIds.delete(task.id);

      if (executionGeneration === this.stopGeneration) {
        // Check if task still exists (may have been deleted while running)
        const taskStillExists = this.store.getTask(task.id) !== null;

        if (taskStillExists) {
          // Update run record
          this.store.completeRun(
            run.id,
            success ? 'success' : 'error',
            sessionId,
            durationMs,
            error
          );

          // Practice loop closure (design 2026-10-10 §3.4): the proposal the
          // task was materialized from takes the run's outcome
          // (scheduled → completed | failed); the next dream consumes it.
          try {
            const practiceProposal = this.resolvePracticeProposal(task);
            if (practiceProposal) {
              if (success) {
                this.coworkStore.markDreamPracticeProposalCompleted?.({
                  id: practiceProposal.id,
                  metabotId: practiceProposal.metabotId,
                  runId: run.id,
                });
              } else {
                this.coworkStore.markDreamPracticeProposalFailed?.({
                  id: practiceProposal.id,
                  metabotId: practiceProposal.metabotId,
                  runId: run.id,
                  outcomeSummary: error,
                });
              }
            }
          } catch (practiceError) {
            console.warn('[Scheduler] Practice proposal writeback failed:', practiceError);
          }

          // Update task state
          this.store.markTaskCompleted(
            task.id,
            success,
            durationMs,
            error,
            task.schedule
          );

          // Auto-disable on too many consecutive errors
          const updatedTask = this.store.getTask(task.id);
          if (updatedTask && updatedTask.state.consecutiveErrors >= Scheduler.MAX_CONSECUTIVE_ERRORS) {
            this.store.toggleTask(task.id, false);
            console.warn(
              `[Scheduler] Task ${task.id} auto-disabled after ${Scheduler.MAX_CONSECUTIVE_ERRORS} consecutive errors`
            );
          }

          // Disable one-shot 'at' tasks after execution
          if (task.schedule.type === 'at') {
            this.store.toggleTask(task.id, false);
          }

          // Prune old run history
          this.store.pruneRuns(task.id, 100);

          // Send IM notifications
          if (task.notifyPlatforms && task.notifyPlatforms.length > 0) {
            await this.sendNotifications(task, success, durationMs, error);
          }

          // Scheduled-run report-back: the origin session that created this
          // task never heard about run outcomes (originSessionId was only
          // ever printed into prompt text), so delegated work died silently
          // in the [定时] fold. Best-effort — never fail the run bookkeeping.
          try {
            this.reportRunToOriginSession(task, run.id, sessionId, success, error, durationMs);
          } catch (reportError) {
            console.warn('[Scheduler] Origin-session run report failed:', reportError);
          }

          // Emit final updates
          this.emitTaskStatusUpdate(task.id);
          const updatedRun = this.store.getRun(run.id);
          if (updatedRun) {
            this.emitRunUpdate(updatedRun);
          }
        } else {
          console.log(`[Scheduler] Task ${task.id} was deleted during execution, skipping post-run updates`);
        }

        this.reschedule();
      }
    }
  }

  private async startCoworkSession(
    task: ScheduledTask,
    executionGeneration: number,
    signal?: AbortSignal,
  ): Promise<string> {
    this.assertExecutionCurrent(executionGeneration);

    // The lifecycle preamble (fire number, budget, exit clause) and the
    // end-of-run follow-up contract ride in front of the prompt on EVERY
    // delivery path so the firing bot can judge — and execute — the task's
    // retirement in the same run, and declare whether the owner is owed
    // follow-up. The lifecycle half is recurring-only; the contract is not.
    // A 'series' fire adds its continuity note between the two.
    const preamble = buildScheduledTaskLifecyclePreamble(task);
    const contract = buildScheduledTaskFollowUpContract();
    const composePrompt = (continuityNote: string = ''): string => {
      const frontMatter = [preamble, continuityNote, contract].filter(Boolean).join('\n\n');
      return frontMatter ? `${frontMatter}\n\n${task.prompt}` : task.prompt;
    };

    // A task bound to an existing session posts its prompt there instead of
    // opening a fresh one. An invalid binding (deleted/archived/A2A/sandbox
    // session) falls through to the task's own conversation below.
    if (task.targetSessionId) {
      const boundSessionId = await this.submitToBoundSession(task, task.targetSessionId, composePrompt(), executionGeneration);
      if (boundSessionId) return boundSessionId;
    }

    // Standing conversation (2026-11-09): a 'series' task — the default —
    // runs every fire in one conversation instead of opening a new session
    // per fire. 'fresh' keeps the old one-off behavior.
    const seat: ScheduledSessionSeat = task.sessionMode === 'fresh'
      ? { kind: 'fresh' }
      : this.resolveSeriesSeat(task);

    if (seat.kind === 'reuse') {
      const idle = await this.waitForSeriesSessionIdle(seat.sessionId, executionGeneration, signal);
      // The idle check and the turn start are one synchronous step — no await
      // between here and runner.startSession's activeSessions.set — or an
      // owner turn could start in the gap and have its live session object
      // replaced by this fire's.
      if (idle && !this.getCoworkRunner().isSessionActive?.(seat.sessionId)) {
        // A legacy task's first fire after upgrade adopted its latest run's
        // session: seat it so later fires stop re-deriving it.
        if (task.seriesSessionId !== seat.sessionId) {
          this.store.setSeriesSessionId?.(task.id, seat.sessionId);
        }
        return this.runScheduledTurn(
          task,
          seat.sessionId,
          composePrompt(buildScheduledSessionContinuityNote({ kind: 'reuse' })),
          executionGeneration,
        );
      }
      // Still busy: this fire runs in a one-off session and the standing
      // conversation keeps its seat — the next fire returns to it.
      console.log(
        `[Scheduler] Task ${task.id} standing conversation ${seat.sessionId} stayed busy, running this fire in a one-off session`
      );
    }

    const config = this.coworkStore.getConfig();
    // A per-task folder override always wins; otherwise metabot tasks run
    // inside their per-bot dated workspace.
    const cwd = task.workingDirectory || resolveSessionWorkingDirectory(config.workingDirectory, task.metabotId ?? null);
    const baseSystemPrompt = task.systemPrompt || config.systemPrompt;
    let skillsPrompt: string | null = null;
    if (this.getSkillsPrompt) {
      try {
        skillsPrompt = await this.getSkillsPrompt();
      } catch (error) {
        console.warn('[Scheduler] Failed to build skills prompt for scheduled task:', error);
      }
    }
    this.assertExecutionCurrent(executionGeneration);
    const systemPrompt = [skillsPrompt, baseSystemPrompt]
      .filter((prompt): prompt is string => Boolean(prompt?.trim()))
      .join('\n\n');
    const executionMode = resolveCoworkExecutionMode(task.executionMode || config.executionMode);

    const title = buildScheduledSessionTitle(task.name, seat.kind === 'rotate' ? seat.generation : 1);
    const session = this.coworkStore.createSession(
      title,
      cwd,
      systemPrompt,
      executionMode,
      [],
      task.metabotId ?? null
    );
    const sessionId = session.id;
    this.coworkStore.setSessionAutoOrigin(sessionId, 'schedule');

    let continuityNote = '';
    if (seat.kind === 'new' || seat.kind === 'rotate') {
      this.store.setSeriesSessionId?.(task.id, sessionId);
    }
    if (seat.kind === 'rotate') {
      continuityNote = buildScheduledSessionContinuityNote({
        kind: 'rotate',
        cause: seat.cause,
        generation: seat.generation,
        previousTitle: seat.previousTitle,
        previousSessionId: seat.previousSessionId,
        previousResult: this.readLatestAssistantExcerpt(seat.previousSessionId),
      });
      // Only a conversation that outgrew its budget gets the pointer: it is
      // still live in the sidebar and the owner may return to it. An archived
      // or reassigned one is left untouched.
      if (seat.cause === 'budget') {
        this.postSeriesRotationPointer(task, seat.previousSessionId, title);
      }
      console.log(
        `[Scheduler] Task ${task.id} rotated its standing conversation ${seat.previousSessionId} → ${sessionId} (${seat.detail})`
      );
    }

    return this.runScheduledTurn(task, sessionId, composePrompt(continuityNote), executionGeneration);
  }

  /**
   * Decide where a 'series' fire runs. The stored standing conversation wins;
   * a task without one (new, or legacy before its first fire after upgrade)
   * adopts the session of its latest run, so an existing daily task continues
   * right where its last fire ran instead of starting yet another session.
   * Only conversations the scheduler itself opened for this task's bot are
   * ever continued — a run that went into an owner's own chat (a since-
   * cleared targetSessionId binding) is never adopted.
   */
  private resolveSeriesSeat(task: ScheduledTask): ScheduledSessionSeat {
    const storedId = task.seriesSessionId?.trim() || null;
    const candidateId = storedId ?? this.store.getLatestRunSessionId?.(task.id) ?? null;
    if (!candidateId) return { kind: 'new' };

    const session = this.coworkStore.getSessionWithoutMessages(candidateId);
    if (!session) {
      if (storedId) {
        console.log(`[Scheduler] Task ${task.id} standing conversation ${storedId} no longer exists, opening a new one`);
      }
      return { kind: 'new' };
    }
    const generation = readScheduledSessionGeneration(session.title ?? '', task.name) + 1;

    const unusable = this.describeUnusableSeriesSession(task, candidateId, session);
    if (unusable) {
      // An adoption candidate that cannot host fires is simply not adopted.
      if (!storedId) return { kind: 'new' };
      return {
        kind: 'rotate',
        cause: 'retired',
        detail: unusable,
        previousSessionId: candidateId,
        previousTitle: session.title ?? '',
        generation,
      };
    }

    const overBudget = this.describeSeriesBudgetExceeded(candidateId);
    if (overBudget) {
      return {
        kind: 'rotate',
        cause: 'budget',
        detail: overBudget,
        previousSessionId: candidateId,
        previousTitle: session.title ?? '',
        generation,
      };
    }

    return { kind: 'reuse', sessionId: candidateId };
  }

  private describeUnusableSeriesSession(task: ScheduledTask, sessionId: string, session: CoworkSession): string | null {
    if (this.coworkStore.isSessionArchived(sessionId)) return 'archived';
    if ((session.sessionType ?? 'standard') !== 'standard') return `${session.sessionType} session`;
    if (session.hiddenFromSessionList) return 'hidden from the session list';
    if ((session.metabotId ?? null) !== (task.metabotId ?? null)) return 'belongs to another bot';
    const autoOrigin = session.autoOrigin ?? this.coworkStore.getSessionAutoOrigin?.(sessionId) ?? null;
    if (autoOrigin !== 'schedule') return 'not a scheduled-task conversation';
    return null;
  }

  /** The rotation reason when the standing conversation is over budget, else null. */
  private describeSeriesBudgetExceeded(sessionId: string): string | null {
    const ratio = readSessionContextUsageRatio(this.coworkStore.getSessionUsageStats?.(sessionId));
    if (ratio !== null && ratio >= SERIES_SESSION_CONTEXT_RATIO_LIMIT) {
      return `context at ${Math.round(ratio * 100)}% of the window`;
    }
    const messages = this.coworkStore.countSessionMessages?.(sessionId) ?? 0;
    if (messages >= SERIES_SESSION_MESSAGE_LIMIT) {
      return `${messages} messages`;
    }
    return null;
  }

  /**
   * Wait (bounded) for the standing conversation to go idle. Returns false
   * when it is still busy at the deadline; throws when the scheduler stops or
   * the task is stopped meanwhile.
   */
  private async waitForSeriesSessionIdle(
    sessionId: string,
    executionGeneration: number,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const runner = this.getCoworkRunner();
    const deadline = Date.now() + this.seriesSessionBusyWaitMs;
    while (runner.isSessionActive?.(sessionId)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(this.seriesSessionBusyPollMs, remaining));
      });
      this.assertExecutionCurrent(executionGeneration);
      if (signal?.aborted) {
        throw new Error('Scheduled task was stopped while waiting for its conversation');
      }
    }
    return true;
  }

  /** Tail excerpt of a session's latest visible assistant reply (best-effort). */
  private readLatestAssistantExcerpt(sessionId: string): { excerpt: string; truncated: boolean } | null {
    try {
      const latest = this.coworkStore.getSessionLatestVisibleMessage?.(sessionId) ?? null;
      if (!latest || latest.type !== 'assistant') return null;
      return tailDispatchReportExcerpt(latest.content);
    } catch (error) {
      console.warn('[Scheduler] Previous conversation excerpt failed:', error);
      return null;
    }
  }

  /**
   * Visible pointer in a standing conversation the task rotated away from:
   * an owner returning to it learns where later runs went. Routine
   * maintenance wording — nothing is lost and no action is due.
   */
  private postSeriesRotationPointer(task: ScheduledTask, previousSessionId: string, nextTitle: string): void {
    try {
      const zh = String(this.getAppLanguage?.() ?? '').toLowerCase().startsWith('zh');
      const pointer = this.coworkStore.addMessage(previousSessionId, {
        type: 'system',
        content: zh
          ? `【定时任务】本会话已经较长，「${task.name}」之后的执行已自动转入新会话「${nextTitle}」继续，无需任何操作；本会话保留为可读归档。`
          : `[Scheduled task] This conversation has grown long, so later runs of "${task.name}" now continue in a new conversation, "${nextTitle}" — no action needed. This one stays readable as an archive.`,
        metadata: { origin: 'schedule' },
      });
      if (pointer) this.emitSessionMessage?.(previousSessionId, pointer);
    } catch (error) {
      console.warn('[Scheduler] Rotation pointer failed:', error);
    }
  }

  /**
   * Run one fire's turn in `sessionId` — a new session or the standing
   * conversation. Everything up to runner.startSession is synchronous: the
   * reuse path relies on that to keep its idle check and the turn start atomic.
   */
  private async runScheduledTurn(
    task: ScheduledTask,
    sessionId: string,
    fullPrompt: string,
    executionGeneration: number,
  ): Promise<string> {
    this.assertExecutionCurrent(executionGeneration);

    // Update session to running
    this.coworkStore.updateSession(sessionId, { status: 'running' });

    // Add the fire's prompt as the turn's user message
    const promptMessage = this.coworkStore.addMessage(sessionId, {
      type: 'user',
      content: fullPrompt,
      metadata: { origin: 'schedule', originLabel: task.name },
    });
    if (promptMessage) this.emitSessionMessage?.(sessionId, promptMessage);

    // Start the session with normal permission flow (no auto-approve).
    this.taskSessionIds.set(task.id, sessionId);
    const runner = this.getCoworkRunner();
    this.assertExecutionCurrent(executionGeneration);
    // Dream-RSI practice run (design 2026-10-10 §3.4/§3.5): a task
    // materialized from a dream practice proposal runs unattended on the
    // practice tool policy — restricted inline surface by risk class, counted
    // side effects, a wall-clock watchdog — and reads but never writes memory
    // (learning from the outcome happens in the next dream: single writer).
    const practiceProposal = this.resolvePracticeProposal(task);
    let practiceWatchdog: ReturnType<typeof setTimeout> | null = null;
    let practiceWatchdogFired = false;
    if (practiceProposal) {
      const watchdogMs = this.practiceRunWatchdogMs;
      practiceWatchdog = setTimeout(() => {
        practiceWatchdogFired = true;
        try {
          this.getCoworkRunner().stopSession(sessionId, {
            finalStatus: 'error',
            reason: `Practice run exceeded its ${Math.round(watchdogMs / 60000)}-minute wall-clock budget`,
          });
        } catch {
          // The session already settled between the watchdog and the stop.
        }
      }, watchdogMs);
    }
    try {
      // Memory-surface selection (2026-10-25): the practice policy below keeps
      // precedence — a practice run always reads but never writes memory,
      // whatever the task declared. Ordinary tasks map their per-task opt-in
      // via resolveMemoryAccessRunnerOptions, whose default ('none') is the
      // legacy blackout every scheduled task had before the opt-in existed.
      await runner.startSession(sessionId, fullPrompt, {
        skipInitialUserMessage: true,
        ...(practiceProposal
          ? {
              memoryReadOnly: true,
              autoApprove: true,
              practiceSession: createPracticeSessionState(practiceProposal.riskClass),
            }
          : resolveMemoryAccessRunnerOptions(task.memoryAccess)),
        confirmationMode: 'text',
      });
      if (practiceWatchdogFired) {
        throw new Error(
          `Practice run exceeded its ${Math.round(this.practiceRunWatchdogMs / 60000)}-minute wall-clock budget`,
        );
      }
    } finally {
      if (practiceWatchdog) clearTimeout(practiceWatchdog);
    }
    this.assertExecutionCurrent(executionGeneration);

    return sessionId;
  }

  /**
   * Fire-time resolution of a `targetSessionId` binding. Returns the bound
   * session id once the prompt was accepted there, or null when the target is
   * not usable at fire time (caller then runs the task in a fresh session).
   * A failed submit throws so the run is recorded as failed — never fall back
   * to a fresh session after an attempt, the message may already be persisted.
   */
  private async submitToBoundSession(
    task: ScheduledTask,
    targetSessionId: string,
    fullPrompt: string,
    executionGeneration: number,
  ): Promise<string | null> {
    // Defense in depth: without the submit seam we cannot honour the binding.
    if (!this.submitToSession) {
      console.log(
        `[Scheduler] Task ${task.id} is bound to session ${targetSessionId} but no submit handler is wired, using a fresh session`
      );
      return null;
    }

    const targetSession = this.coworkStore.getSessionWithoutMessages(targetSessionId);
    if (!targetSession) {
      console.log(`[Scheduler] Task ${task.id} bound session ${targetSessionId} no longer exists, using a fresh session`);
      return null;
    }
    if (this.coworkStore.isSessionArchived(targetSessionId)) {
      console.log(`[Scheduler] Task ${task.id} bound session ${targetSessionId} is archived, using a fresh session`);
      return null;
    }
    if (targetSession.sessionType === 'a2a') {
      console.log(`[Scheduler] Task ${task.id} bound session ${targetSessionId} is an A2A session, using a fresh session`);
      return null;
    }
    if (targetSession.executionMode === 'sandbox') {
      console.log(`[Scheduler] Task ${task.id} bound session ${targetSessionId} runs in a sandbox, using a fresh session`);
      return null;
    }
    // Unattended orchestrator sessions (surf/study/exam) are hidden from the
    // session list and stopped once their run ends. Posting a task into one
    // re-feeds its whole transcript as the prefix of an invisible work
    // session — the legacy default of surf-created one-shot tasks (45% of
    // fires in the 2026-10 audit week). The creation seam no longer binds
    // them; this catches the rows already in the store.
    if (targetSession.hiddenFromSessionList) {
      console.log(`[Scheduler] Task ${task.id} bound session ${targetSessionId} is a hidden unattended session, using a fresh session`);
      return null;
    }

    this.taskSessionIds.set(task.id, targetSessionId);
    this.assertExecutionCurrent(executionGeneration);
    const result = await this.submitToSession({
      sessionId: targetSessionId,
      submissionId: randomUUID(),
      text: fullPrompt,
      origin: 'schedule',
      originLabel: task.name,
    });
    this.assertExecutionCurrent(executionGeneration);

    if (!result.success) {
      throw new Error(result.error ?? `Failed to submit task ${task.id} into session ${targetSessionId}`);
    }

    console.log(`[Scheduler] Task ${task.id} submitted into bound session ${targetSessionId}`);
    return targetSessionId;
  }

  /**
   * Report a finished run back into the session that created the task.
   * Delegated one-shot ('at') work reports every run; recurring standing
   * automation reports failures only — a per-fire success ping into the
   * origin chat recreates the poll-flood failure class. A run that executed
   * inside the origin chat itself (bound to it) is skipped: that chat just
   * watched the turn happen. The delivery id is deterministic per run, so
   * retries dedupe; a run that failed before its session opened attributes
   * the report to the synthetic `scheduled-task:<taskId>` pseudo-source.
   */
  private reportRunToOriginSession(
    task: ScheduledTask,
    runId: string,
    sessionId: string | null,
    success: boolean,
    error: string | null,
    durationMs: number,
  ): void {
    const originSessionId = task.originSessionId?.trim();
    if (!originSessionId) return;
    if (task.schedule.type !== 'at' && success) return;
    if (sessionId && sessionId === originSessionId) return;

    let finalReply: string | null = null;
    let finalReplyTruncated = false;
    if (sessionId) {
      try {
        const latest = this.coworkStore.getSessionLatestVisibleMessage?.(sessionId) ?? null;
        if (latest && latest.type === 'assistant') {
          const excerpt = tailDispatchReportExcerpt(latest.content);
          if (excerpt) {
            finalReply = excerpt.excerpt;
            finalReplyTruncated = excerpt.truncated;
          }
        }
      } catch (excerptError) {
        console.warn('[Scheduler] Run report excerpt failed:', excerptError);
      }
    }

    const message = buildScheduledRunReportMessage({
      taskId: task.id,
      taskName: task.name,
      fireNumber: task.schedule.type === 'at' ? null : (task.fireCount ?? 0) + 1,
      outcome: success ? 'success' : 'failed',
      durationMs,
      runSessionId: sessionId,
      failureReason: error,
      finalReply,
      finalReplyTruncated,
    });
    const result = this.getCoworkRunner().insertCrossSessionMessageAndQueue({
      sourceSessionId: sessionId ?? `scheduled-task:${task.id}`,
      targetSessionId: originSessionId,
      message,
      deliveryId: `schedule_report:${task.id}:${runId}`,
    });
    if (!result.insert.ok || !result.runQueued) {
      console.warn('[Scheduler] Origin-session run report did not queue:', {
        taskId: task.id,
        originSessionId,
        deliveryId: `schedule_report:${task.id}:${runId}`,
        insertError: result.insert.ok ? result.error : String(result.insert.message),
      });
    }
  }

  // --- IM Notifications ---

  private async sendNotifications(
    task: ScheduledTask,
    success: boolean,
    durationMs: number,
    error: string | null
  ): Promise<void> {
    const imManager = this.getIMGatewayManager?.();
    if (!imManager) return;

    const status = success ? '✅ 成功' : '❌ 失败';
    const durationStr = durationMs < 1000
      ? `${durationMs}ms`
      : `${(durationMs / 1000).toFixed(1)}s`;

    let message = `📋 定时任务通知\n\n任务: ${task.name}\n状态: ${status}\n耗时: ${durationStr}`;
    if (error) {
      message += `\n错误: ${error}`;
    }

    for (const platform of task.notifyPlatforms) {
      try {
        await imManager.sendNotification(platform, message);
        console.log(`[Scheduler] Notification sent via ${platform} for task ${task.id}`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.warn(`[Scheduler] Failed to send notification via ${platform}: ${errMsg}`);
      }
    }
  }

  // --- Manual Execution ---

  async runManually(taskId: string): Promise<void> {
    try {
      const task = this.store.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      await this.executeTask(task, 'manual');
    } catch (error) {
      const handled = await this.handleSchedulerError(error, 'scheduledTask:manualRun');
      if (!handled) {
        throw error;
      }
    }
  }

  stopTask(taskId: string): boolean {
    const controller = this.activeTasks.get(taskId);
    if (controller) {
      // Also stop the cowork session if one is running
      const sessionId = this.taskSessionIds.get(taskId);
      if (sessionId) {
        try {
          this.getCoworkRunner().stopSession(sessionId, { reason: 'scheduled task stopped' });
        } catch (err) {
          console.warn(`[Scheduler] Failed to stop cowork session for task ${taskId}:`, err);
        }
      }
      controller.abort();
      return true;
    }
    return false;
  }

  // --- Event Emission ---

  private emitTaskStatusUpdate(taskId: string): void {
    const task = this.store.getTask(taskId);
    if (!task) return;

    broadcastToRenderers('scheduledTask:statusUpdate', {
      taskId: task.id,
      state: task.state,
    });
  }

  private emitRunUpdate(run: ScheduledTaskRun): void {
    broadcastToRenderers('scheduledTask:runUpdate', { run });
  }
}
