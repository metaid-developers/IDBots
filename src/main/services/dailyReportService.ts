/**
 * Daily Report (每日汇报) service — the system-level scheduler that fires the
 * Twin's daily briefing (a local Twin chat + a self-contained HTML report).
 *
 * Dream-service shape: a self-rescheduling setTimeout tick (≤60s) that
 * RECOMPUTES the next fire from LIVE Twin settings every tick, so an
 * hour/toggle edit applies without an app restart. Trigger rules (owner
 * alignment 2026-10-22):
 *
 * - Normal: fire at the configured local hour (default 08:00) while the app
 *   runs; `trigger_kind='scheduled'`.
 * - Catch-up: when the app starts past the START day's configured hour (+2
 *   min grace) with no run row for that day, fire 15 minutes after start;
 *   `trigger_kind='catchup'`. The report is claimed for the MISSED start day
 *   even when the 15-minute delay fires after midnight (start 23:45, hour 8
 *   → fires 00:00 next day with report_date = the start day).
 * - Crash recovery: at service start and on every tick, 'running' rows
 *   created before this service instance started (orphaned by a killed
 *   process) are flipped to 'failed', so their days re-enter the bounded
 *   retry/backoff path instead of blocking the day forever.
 * - Fresh installs: no fire while `backgroundDeferral()` returns a reason
 *   (the first ~24h window shared by dream/surf/study).
 * - Manual: `runNow()` fires the full pipeline on the owner's demand
 *   (`trigger_kind='manual'`); it re-opens a day that already has a run row
 *   and always delivers a NEW session. `force:true` bypasses ONLY the
 *   fresh-install deferral and the empty-window skip — every other gate
 *   (experimental switch, twin exists, per-Twin enabled) always applies.
 * - Skip: a window with literally zero activity (collector's
 *   `hasAnyActivity === false`) records a `skipped` row and sends nothing.
 * - Retry: a failure after the claim records `failed`; the tick re-arms the
 *   row with dream-style bounded backoff (classifyDreamError terminal class
 *   never retries; DREAM_RETRY_MAX_ATTEMPTS caps the attempts) and reuses
 *   the recorded session_id, so a retry never creates a duplicate session —
 *   unless the user deleted or archived that session inside the backoff
 *   window; delivery then re-checks existence first and falls back to a
 *   fresh report session, repointing the run row via setRunSessionId.
 *
 * Fire-time gates: the global experimental-automation master switch AND a
 * Twin exists AND `dailyReport.enabled === '1'` AND the fresh-install
 * deferral is clear. Double-fire guard: the UNIQUE(report_date) claim happens
 * before any generation work.
 */

import {
  computeDailyReportWindow,
  formatDailyReportLocalDate,
  type DailyReportFacts,
} from './dailyReportCollector';
import {
  generateDailyReport,
  resolveDailyReportStrings,
  type DailyReportBrainOptions,
  type DailyReportGenerationResult,
  type DailyReportPerformChat,
} from './dailyReportGenerator';
import { isDailyReportEnabled, resolveDailyReportHour } from './dailyReportSettings';
import type { DailyReportRun, DailyReportStore, DailyReportTriggerKind } from '../dailyReportStore';
import {
  selectDailyReportNarration,
  DAILY_REPORT_MAX_NARRATED_SESSIONS,
} from '../cerebellum/dailyReportTriage';
import {
  classifyDreamError,
  computeDreamBackoffDelayMs,
  DREAM_RETRY_MAX_ATTEMPTS,
  isRateLimitError,
} from '../libs/dreamRetryPolicy';

/** Tick cadence: recomputing the fire from live settings every 30s. */
export const DAILY_REPORT_TICK_INTERVAL_MS = 30_000;
/** Catch-up fires 15 minutes after app start (owner alignment). */
export const DAILY_REPORT_CATCHUP_DELAY_MS = 15 * 60_000;
/** Grace past the configured hour before "app was off at fire time". */
export const DAILY_REPORT_FIRE_GRACE_MS = 2 * 60_000;
/** Deterministic session title (owner alignment — always Chinese). */
export const DAILY_REPORT_SESSION_TITLE_PREFIX = '每日汇报';

export interface DailyReportTwinLike {
  id: number;
  name?: string;
}

export interface DailyReportServiceDeps {
  coworkStore: {
    getConfig(): { workingDirectory: string };
    createSession(
      title: string,
      cwd: string,
      systemPrompt?: string,
      executionMode?: string,
      activeSkillIds?: string[],
      metabotId?: number | null,
    ): { id: string };
    addMessage(
      sessionId: string,
      message: { type: string; content: string; metadata?: Record<string, unknown> },
    ): unknown;
    /** Lightweight existence probe (no messages loaded); null = row deleted. */
    getSessionWithoutMessages(id: string): { id: string } | null;
    /** Archived sessions stay out of the sidebar — invalid retry targets. */
    isSessionArchived(id: string): boolean;
  };
  metabotStore: {
    listMetabots(): ReadonlyArray<{ id: number; metabot_type?: string }>;
    getMetabotSetting(metabotId: number, key: string): string | null;
  };
  dailyReportStore: DailyReportStore;
  /** App kv store backing isExperimentalAutomationAllowed. */
  experimentalAutomationStore: { get(key: string): unknown } | null;
  /** Fresh-install deferral (resolveBackgroundAutomationDeferral). */
  backgroundDeferral: () => string | null;
  isExperimentalAutomationAllowed: (store: { get(key: string): unknown } | null) => boolean;
  /** Collector, wired to the shared db (or off-thread read worker) by the caller. */
  collectFacts: (args: { windowStartMs: number; windowEndMs: number; twinId: number }) => DailyReportFacts | Promise<DailyReportFacts>;
  /** Cerebellum triage gate; null verdicts degrade to recency order. */
  triageCandidates: (args: {
    candidates: ReadonlyArray<{
      sessionId: string;
      sessionTitle: string;
      lastAssistantText: string;
      lastUserText: string;
    }>;
  }) => Promise<ReadonlyMap<string, number> | null>;
  /** System brain (Twin's primary+fallback pair), resolved lazily per fire. */
  resolveBrain: () => DailyReportBrainOptions | null;
  performChat: DailyReportPerformChat;
  emitCoworkStreamMessage: (sessionId: string, message: unknown) => void;
  /** UI locale resolver ('zh' | 'en' | OS locale string). */
  getLocale: () => string;
  /** <userData>/daily-reports. */
  reportDir: string;
  /** resolveSessionWorkingDirectory(base, metabotId) — twin workspace cwd. */
  resolveSessionCwd: (baseWorkingDirectory: string, metabotId: number | null) => string;
  now?: () => Date;
  /** Service-start anchor for the catch-up rule (defaults to real start). */
  serviceStartedAtMs?: number;
  tickIntervalMs?: number;
  log?: (message: string) => void;
}

const localTodayAtHourMs = (nowMs: number, hour: number): number => {
  const d = new Date(nowMs);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};

export type DailyReportFireTrigger = DailyReportTriggerKind;

export interface DailyReportFireDecision {
  trigger: DailyReportFireTrigger;
  /** The re-armed run row when this is a bounded retry of a failed day. */
  retryRun: DailyReportRun | null;
  /** The local date the claim/report belongs to — the missed start day for a
   *  cross-midnight catch-up, today for a scheduled fire, the failed day's
   *  date for a retry. */
  reportDate: string;
}

/**
 * Structured outcome of one report attempt — returned by the manual "run now"
 * entry point and produced internally by every fire path, so the IPC layer
 * can surface exactly what happened without parsing logs. Never throws.
 */
export type DailyReportRunNowResult =
  | { status: 'completed'; sessionId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; error: string }
  | { status: 'unavailable'; reason: string };

/**
 * Pure decision core, split out for tests: given the service-start anchor,
 * the live hour and a per-date run-row lookup, decide whether THIS tick
 * should fire, and for WHICH local date. Gates (twin/enabled/experimental/
 * deferral) are checked by the caller BEFORE this — a blocked gate must not
 * consume the catch-up arm.
 *
 * Two candidate dates, in priority order:
 *  1. The missed start day: when the service began AFTER that day's configured
 *     fire time (+ grace), the report is owed to THAT day. The 15-minute
 *     catch-up delay can push the actual fire past midnight (start 23:45,
 *     hour 8 → fire 00:00 next day) — the claim still carries the start day.
 *     While the start-day row is missing, the catch-up arm owns the decision
 *     and today's scheduled arm must not sneak in. Once the start-day row
 *     settles (or fails terminally / exhausts its budget), a DIFFERENT today
 *     falls through to the normal scheduled/retry arm.
 *  2. Today: the normal scheduled arm once the configured hour passes, plus
 *     the bounded-retry arm for today's failed row.
 */
export const decideDailyReportFire = (input: {
  nowMs: number;
  serviceStartedAtMs: number;
  hour: number;
  /** Run-row lookup by local date label ('YYYY-MM-DD'). */
  getRun: (reportDate: string) => DailyReportRun | null;
  maxAttempts?: number;
}): DailyReportFireDecision | null => {
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? DREAM_RETRY_MAX_ATTEMPTS));

  // Bounded retry of a failed row: dream-style backoff from the failure time;
  // terminal error classes and exhausted budgets never retry.
  const retryDecisionFor = (run: DailyReportRun): DailyReportFireDecision | null => {
    if (run.attemptCount >= maxAttempts) return null;
    if (classifyDreamError(run.error) === 'terminal') return null;
    const failedAtMs = run.completedAt ?? run.createdAt;
    const backoffMs = computeDreamBackoffDelayMs({
      attemptCount: run.attemptCount,
      rateLimited: isRateLimitError(run.error),
    });
    if (input.nowMs < failedAtMs + backoffMs) return null;
    return { trigger: 'retry', retryRun: run, reportDate: run.reportDate };
  };

  const todayAtHourMs = localTodayAtHourMs(input.nowMs, input.hour);
  const startDayAtHourMs = localTodayAtHourMs(input.serviceStartedAtMs, input.hour);
  const startDateLabel = formatDailyReportLocalDate(input.serviceStartedAtMs);
  const todayLabel = formatDailyReportLocalDate(input.nowMs);
  // The app was off (or started) past the START day's fire time: that day is
  // owed a report 15 minutes after start.
  const missedStartDay = input.serviceStartedAtMs > startDayAtHourMs + DAILY_REPORT_FIRE_GRACE_MS;

  if (missedStartDay) {
    const startDayRun = input.getRun(startDateLabel);
    if (!startDayRun) {
      return input.nowMs >= input.serviceStartedAtMs + DAILY_REPORT_CATCHUP_DELAY_MS
        ? { trigger: 'catchup', retryRun: null, reportDate: startDateLabel }
        : null;
    }
    if (startDayRun.status === 'failed') {
      const retry = retryDecisionFor(startDayRun);
      if (retry) return retry;
      // Failed but cooling down / terminal / budget exhausted: only a
      // DIFFERENT today may still fire; the start day itself is done.
    }
    if (todayLabel === startDateLabel) return null; // settled or un-retryable row owns the day
    // else fall through — today is a new date with its own scheduled/retry arm
  }

  const todayRun = input.getRun(todayLabel);
  if (todayRun) {
    if (todayRun.status !== 'failed') return null; // running/completed/skipped own the day
    return retryDecisionFor(todayRun);
  }
  if (input.nowMs < todayAtHourMs) return null; // before the configured hour
  return { trigger: 'scheduled', retryRun: null, reportDate: todayLabel };
};

/** Handle returned by startDailyReportService (also what main.ts caches for IPC). */
export interface DailyReportServiceHandle {
  /** Test hook: run the decision+fire pipeline immediately. */
  tickNow: () => Promise<void>;
  /** Manual "run now" — see the method doc on the implementation. */
  runNow: (opts?: { force?: boolean }) => Promise<DailyReportRunNowResult>;
  stop: () => void;
}

let activeService: DailyReportServiceHandle | null = null;

export const startDailyReportService = (deps: DailyReportServiceDeps): DailyReportServiceHandle => {
  activeService?.stop();
  const tickIntervalMs = Math.max(5_000, Math.floor(deps.tickIntervalMs ?? DAILY_REPORT_TICK_INTERVAL_MS));
  const log = deps.log ?? ((message: string) => console.log(`[DailyReport] ${message}`));
  const serviceStartedAtMs = deps.serviceStartedAtMs ?? Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let firing = false;

  /** One pending tick at a time; a manual tickNow must orphan nothing. */
  const scheduleNextTick = (): void => {
    if (stopped) return;
    if (timer) {
      clearTimeout(timer);
    }
    timer = setTimeout(() => {
      timer = null;
      void tick();
    }, tickIntervalMs);
  };

  const resolveTwin = (): DailyReportTwinLike | null => {
    const twin = deps.metabotStore.listMetabots().find((bot) => bot.metabot_type === 'twin');
    return twin ? { id: twin.id } : null;
  };

  const fireGatesOpen = (twin: DailyReportTwinLike | null): boolean => {
    if (!deps.isExperimentalAutomationAllowed(deps.experimentalAutomationStore)) return false;
    if (!twin) return false;
    if (!isDailyReportEnabled(deps.metabotStore, twin.id)) return false;
    if (deps.backgroundDeferral() !== null) return false;
    return true;
  };

  const deliverReport = (input: {
    run: DailyReportRun;
    twin: DailyReportTwinLike;
    dateLabel: string;
    content: string;
  }): string => {
    let sessionId = input.run.sessionId;
    // A retry may reuse the recorded session only while it is still
    // deliverable: the user may have deleted or archived it inside the
    // backoff window, and writing the report into that orphan would mark
    // the run completed while the owner never sees the message (archived
    // sessions stay out of the sidebar list).
    const recordedSessionDeliverable = sessionId != null
      && deps.coworkStore.getSessionWithoutMessages(sessionId) != null
      && !deps.coworkStore.isSessionArchived(sessionId);
    if (!recordedSessionDeliverable) {
      if (sessionId) {
        log(`${input.dateLabel}: recorded session ${sessionId} was deleted or archived — creating a fresh report session.`);
      }
      const cwd = deps.resolveSessionCwd(deps.coworkStore.getConfig().workingDirectory, input.twin.id);
      const session = deps.coworkStore.createSession(
        `${DAILY_REPORT_SESSION_TITLE_PREFIX} ${input.dateLabel}`,
        cwd,
        '',
        'local',
        [],
        input.twin.id,
      );
      sessionId = session.id;
      deps.dailyReportStore.setRunSessionId(input.run.id, sessionId);
    }
    const message = deps.coworkStore.addMessage(sessionId, {
      type: 'assistant',
      content: input.content,
      metadata: { origin: 'daily_report', originLabel: input.dateLabel },
    });
    deps.emitCoworkStreamMessage(sessionId, message);
    // Sidebar ordering: a fresh session has activity_at NULL, and
    // listSessions falls back to updated_at DESC (bumped by addMessage), so
    // the report tops the main conversation list without extra store writes.
    return sessionId;
  };

  const executeReport = async (
    input: { trigger: DailyReportTriggerKind; force?: boolean; retryRun: DailyReportRun | null; reportDate?: string },
    twin: DailyReportTwinLike,
  ): Promise<DailyReportRunNowResult> => {
    const now = deps.now?.() ?? new Date();
    const nowMs = now.getTime();
    // The decision already pinned the date (the missed start day for a
    // cross-midnight catch-up); manual runs always claim today.
    const dateLabel = input.reportDate ?? formatDailyReportLocalDate(nowMs);
    const lastSuccess = deps.dailyReportStore.getLastSuccessfulRun();
    const { windowStartMs, windowEndMs } = computeDailyReportWindow({
      nowMs,
      lastSuccessfulWindowEndMs: lastSuccess?.windowEndMs ?? null,
    });

    const claim = { reportDate: dateLabel, windowStartMs, windowEndMs };
    let run: DailyReportRun | null = null;
    if (input.trigger === 'retry' && input.retryRun) {
      run = deps.dailyReportStore.reactivateFailedRun(
        { ...claim, triggerKind: 'retry' },
        DREAM_RETRY_MAX_ATTEMPTS,
        nowMs,
      );
    } else if (input.trigger === 'manual') {
      // Manual runs may re-open a day that already has a row: first claim
      // (fresh day), else reset whatever is there for a fresh manual attempt.
      run = deps.dailyReportStore.claimRun({ ...claim, triggerKind: 'manual' }, nowMs)
        ?? deps.dailyReportStore.resetRunForManual({ ...claim, triggerKind: 'manual' }, nowMs);
    } else {
      run = deps.dailyReportStore.claimRun({ ...claim, triggerKind: input.trigger }, nowMs);
    }
    if (!run) {
      return { status: 'unavailable', reason: 'claim_lost' }; // UNIQUE(report_date) — another attempt owns the day
    }

    try {
      const facts = await deps.collectFacts({ windowStartMs, windowEndMs, twinId: twin.id });
      if (!facts.hasAnyActivity && input.force !== true) {
        deps.dailyReportStore.markSkipped(run.id, nowMs);
        log(`${dateLabel}: window empty — recorded 'skipped', no session created.`);
        return { status: 'skipped', reason: 'no_activity' };
      }

      // Cerebellum triage for narration; must-includes bypass it entirely.
      const mustIncludeSessionIds = facts.pendingFollowUps.map((item) => item.sessionId);
      const mustInclude = new Set(mustIncludeSessionIds);
      const candidates = facts.humanSessions.filter((session) => !mustInclude.has(session.sessionId));
      let verdicts: ReadonlyMap<string, number> | null = null;
      try {
        verdicts = await deps.triageCandidates({
          candidates: candidates.map((session) => ({
            sessionId: session.sessionId,
            sessionTitle: session.title,
            lastAssistantText: session.lastAssistantExcerpt ?? '',
            lastUserText: session.lastUserExcerpt ?? '',
          })),
        });
      } catch {
        verdicts = null; // triage never sinks the report
      }
      const narratedSessionIds = selectDailyReportNarration({
        mustIncludeSessionIds,
        candidates,
        verdicts,
        maxNarrated: DAILY_REPORT_MAX_NARRATED_SESSIONS,
      });
      const narrated = new Set(narratedSessionIds);
      // The brain only reads the narrated sessions' excerpts (bounded input);
      // the deterministic briefing below uses the full facts.
      const brainFacts: DailyReportFacts = {
        ...facts,
        humanSessions: facts.humanSessions.filter((session) => narrated.has(session.sessionId)),
      };

      const strings = resolveDailyReportStrings(deps.getLocale());
      const generated = await generateDailyReport({
        facts: brainFacts,
        strings,
        dateLabel,
        reportDir: deps.reportDir,
        brain: deps.resolveBrain(),
        performChat: deps.performChat,
      });

      const content = `${generated.briefingMarkdown}\n\n[${strings.viewFullReport}](<${generated.htmlFileUrl}>)`;
      const sessionId = deliverReport({
        run,
        twin,
        dateLabel,
        content,
      });

      const stats = {
        windowStartMs,
        windowEndMs,
        trigger: input.trigger,
        usedFallback: generated.usedFallback,
        counts: {
          pendingFollowUps: facts.pendingFollowUps.length,
          ownerOrchestrations: facts.ownerOrchestrations.length,
          humanSessions: facts.humanSessions.length,
          narratedSessions: narratedSessionIds.length,
          scheduledRuns: facts.machineActivity.scheduledRuns.length,
          groupTaskTransitions: facts.machineActivity.groupTaskTransitions.length,
          longTermEvents: facts.machineActivity.longTermEvents.length,
          onlineBots: facts.onlineActivity.length,
          botActivity: facts.botActivity.length,
          upcomingFires: facts.upcoming.scheduledFiresTotal,
          newSessions: facts.newSessionCount,
        },
      };
      deps.dailyReportStore.markCompleted(run.id, sessionId, JSON.stringify(stats), nowMs);
      log(`${dateLabel}: report delivered (session ${sessionId}, fallback=${generated.usedFallback}).`);
      return { status: 'completed', sessionId };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.dailyReportStore.markFailed(run.id, message, nowMs);
      const terminal = classifyDreamError(error) === 'terminal';
      log(`${dateLabel}: report failed (${terminal ? 'terminal' : 'retryable'}): ${message}`);
      return { status: 'failed', error: message };
    }
  };

  /**
   * Crash recovery: a 'running' row created BEFORE this service instance
   * started cannot belong to it (this instance only claims at/after its own
   * start), so it is a crash orphan — fail it into the bounded retry path.
   * A row this instance is actively executing carries created_at >=
   * serviceStartedAtMs and is left untouched. Runs before the fire gates on
   * purpose: the ledger heals even while the feature is gated off.
   */
  const recoverInterruptedRuns = (atMs: number): void => {
    const recovered = deps.dailyReportStore.failStaleRunningRuns(serviceStartedAtMs, atMs);
    if (recovered.length > 0) {
      log(`recovered ${recovered.length} stale running run(s) orphaned by a crash (${recovered.map((r) => r.reportDate).join(', ')}) — moved to 'failed' for bounded retry.`);
    }
  };

  const tick = async (): Promise<void> => {
    if (stopped || firing) {
      // Keep the cadence alive when a manual run (or a concurrent manual
      // tick) holds the firing flag — an early return must not kill the loop.
      scheduleNextTick();
      return;
    }
    firing = true;
    try {
      const now = deps.now?.() ?? new Date();
      recoverInterruptedRuns(now.getTime());
      const twin = resolveTwin();
      if (!fireGatesOpen(twin) || !twin) {
        return; // gates checked at fire time; a later tick picks the change up
      }
      const hour = resolveDailyReportHour(deps.metabotStore, twin.id);
      const decision = decideDailyReportFire({
        nowMs: now.getTime(),
        serviceStartedAtMs,
        hour,
        getRun: (date) => deps.dailyReportStore.getRunForDate(date),
      });
      if (decision) {
        await executeReport(
          { trigger: decision.trigger, retryRun: decision.retryRun, reportDate: decision.reportDate },
          twin,
        );
      }
    } catch (error) {
      log(`tick failed soft: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      firing = false;
      scheduleNextTick();
    }
  };

  recoverInterruptedRuns(serviceStartedAtMs);
  scheduleNextTick();
  log(`service started (tick ${tickIntervalMs}ms).`);

  const service = {
    /** Test hook: run the decision+fire pipeline immediately. */
    tickNow: () => tick(),
    /**
     * Manual "run now": the full fire pipeline with trigger_kind='manual',
     * for owners testing the report without waiting for the scheduled hour.
     * Same gates as scheduled fires EXCEPT force:true, which bypasses ONLY
     * the fresh-install deferral and the hasAnyActivity gates. May re-open a
     * day that already has a run row — every manual run delivers a NEW
     * report session. Never throws.
     */
    runNow: async (opts?: { force?: boolean }): Promise<DailyReportRunNowResult> => {
      if (stopped) {
        return { status: 'unavailable', reason: 'service_stopped' };
      }
      if (firing) {
        return { status: 'unavailable', reason: 'already_running' };
      }
      const twin = resolveTwin();
      if (!twin) {
        return { status: 'unavailable', reason: 'no_twin' };
      }
      if (!deps.isExperimentalAutomationAllowed(deps.experimentalAutomationStore)) {
        return { status: 'unavailable', reason: 'experimental_disabled' };
      }
      if (!isDailyReportEnabled(deps.metabotStore, twin.id)) {
        return { status: 'unavailable', reason: 'feature_disabled' };
      }
      const force = opts?.force === true;
      if (!force && deps.backgroundDeferral() !== null) {
        return { status: 'unavailable', reason: 'deferred' };
      }
      firing = true; // hold ticks off for the duration of the manual run
      try {
        const outcome = await executeReport({ trigger: 'manual', force, retryRun: null }, twin);
        log(`manual run (force=${force}): ${outcome.status}${outcome.status === 'failed' ? ` — ${outcome.error}` : ''}`);
        return outcome;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`manual run failed soft: ${message}`);
        return { status: 'failed', error: message };
      } finally {
        firing = false;
      }
    },
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (activeService === service) {
        activeService = null;
      }
    },
  };
  activeService = service;
  return service;
};

export const stopDailyReportService = (): void => {
  activeService?.stop();
  activeService = null;
};
