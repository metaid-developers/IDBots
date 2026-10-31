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
import type { CoworkStore, DreamPracticeProposalRecord } from '../coworkStore';
import type { CoworkRunner } from './coworkRunner';
import { resolveSessionWorkingDirectory } from './botWorkspace';
import { resolveCoworkExecutionMode } from './coworkExecutionMode';
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
  private readonly practiceRunWatchdogMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeTasks: Map<string, AbortController> = new Map();
  // Track cowork session IDs for running tasks so we can stop them
  private taskSessionIds: Map<string, string> = new Map();
  private stopGeneration = 0;

  private static readonly MAX_TIMER_INTERVAL_MS = 60_000;
  private static readonly MAX_CONSECUTIVE_ERRORS = 5;

  constructor(deps: SchedulerDeps) {
    this.store = deps.scheduledTaskStore;
    this.coworkStore = deps.coworkStore;
    this.getCoworkRunner = deps.getCoworkRunner;
    this.getIMGatewayManager = deps.getIMGatewayManager ?? null;
    this.getSkillsPrompt = deps.getSkillsPrompt ?? null;
    this.isRecoverableSqliteError = deps.isRecoverableSqliteError ?? null;
    this.recoverSqlite = deps.recoverSqlite ?? null;
    this.submitToSession = deps.submitToSession ?? null;
    this.practiceRunWatchdogMs = deps.practiceRunWatchdogMs ?? PRACTICE_RUN_WATCHDOG_MS;
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
   * the task out of the due set — nothing in the store can tell a slow-but-live
   * run from an abandoned one (there is no heartbeat), so `activeTasks` is the
   * authoritative liveness signal and an orphan is detected as soon as it
   * exists, not after a fixed timeout. Recording the skip puts the dropped
   * execution in the ledger; releasing the marker lets the task fire again.
   * Errors propagate so the tick's recovery path still sees them.
   */
  private ledgerStuckRunningTasks(): void {
    for (const task of this.store.getRunningTasks()) {
      if (this.activeTasks.has(task.id)) continue;

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
    const run = this.store.createRun(task.id, trigger);

    this.store.markTaskRunning(task.id, startTime);
    this.emitTaskStatusUpdate(task.id);
    this.emitRunUpdate(run);

    const abortController = new AbortController();
    this.activeTasks.set(task.id, abortController);

    let sessionId: string | null = null;
    let success = false;
    let error: string | null = null;

    try {
      sessionId = await this.startCoworkSession(task, executionGeneration);
      success = true;
    } catch (err: unknown) {
      if (!(err instanceof SchedulerStoppedError)) {
        error = err instanceof Error ? err.message : String(err);
        console.error(`[Scheduler] Task ${task.id} failed:`, error);
      }
    } finally {
      const durationMs = Date.now() - startTime;
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

  private async startCoworkSession(task: ScheduledTask, executionGeneration: number): Promise<string> {
    this.assertExecutionCurrent(executionGeneration);

    // The lifecycle preamble (fire number, budget, exit clause) and the
    // end-of-run follow-up contract ride in front of the prompt on EVERY
    // delivery path so the firing bot can judge — and execute — the task's
    // retirement in the same run, and declare whether the owner is owed
    // follow-up. The lifecycle half is recurring-only; the contract is not.
    const preamble = buildScheduledTaskLifecyclePreamble(task);
    const contract = buildScheduledTaskFollowUpContract();
    const frontMatter = [preamble, contract].filter(Boolean).join('\n\n');
    const fullPrompt = frontMatter ? `${frontMatter}\n\n${task.prompt}` : task.prompt;

    // A task bound to an existing session posts its prompt there instead of
    // opening a fresh one. An invalid binding (deleted/archived/A2A/sandbox
    // session) falls through to the fresh-session path below.
    if (task.targetSessionId) {
      const boundSessionId = await this.submitToBoundSession(task, task.targetSessionId, fullPrompt, executionGeneration);
      if (boundSessionId) return boundSessionId;
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

    const session = this.coworkStore.createSession(
      `[定时] ${task.name}`,
      cwd,
      systemPrompt,
      executionMode,
      [],
      task.metabotId ?? null
    );
    const sessionId = session.id;
    this.coworkStore.setSessionAutoOrigin(sessionId, 'schedule');

    // Update session to running
    this.coworkStore.updateSession(sessionId, { status: 'running' });

    // Add initial user message
    this.coworkStore.addMessage(sessionId, {
      type: 'user',
      content: fullPrompt,
      metadata: { origin: 'schedule', originLabel: task.name },
    });

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
