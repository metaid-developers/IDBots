/**
 * Daily Report (每日汇报) fact collector — deterministic SQLite reads that
 * assemble everything the daily briefing needs for its window
 * [windowStartMs, windowEndMs).
 *
 * Pure shaping + an injectable SQL accessor (the service wires the real
 * database in; unit tests inject canned rows). NEVER throws: every bucket
 * fails soft to empty, so a broken query can shrink a section but can never
 * sink the report. Every bucket is hard-capped (top-N by recency plus char
 * caps) and the assembled facts are capped again at the JSON level so the
 * facts stay ≤ ~80 KB (one idle-time brain call a day, no per-turn context
 * cost; 20 bots is the system-wide bot cap, so a full fleet day must fit).
 *
 * Skip decision (owner-aligned rule E10): a day is skippable only when the
 * window holds literally zero activity — no new cowork sessions of any kind,
 * no private/group chat messages, no orchestration/scheduled/group-task/
 * long-term activity and no pending follow-ups. Nightly dream digests are
 * NOT an activity signal (dreams run autonomously regardless), so they feed
 * the briefing but never the skip bit.
 *
 * Kept free of runtime relative imports (type-only is erased) so plain-Node
 * tests can load it with type stripping.
 */

import type { SqliteDatabase } from '../sqliteTypes';

/** Minimal SQL reader the collector needs; the service adapts the shared db. */
export interface DailyReportDb {
  queryAll<T>(sql: string, params?: ReadonlyArray<string | number | null>): T[];
}

/** Adapt the app's sql.js-backed database to the collector's reader shape. */
export const createDailyReportDbAccessor = (db: SqliteDatabase): DailyReportDb => ({
  queryAll<T>(sql: string, params: ReadonlyArray<string | number | null> = []): T[] {
    const result = db.exec(sql, [...params]);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  },
});

// ── Caps ───────────────────────────────────────────────────────────────────

export const DAILY_REPORT_MAX_LOOKBACK_DAYS = 7;
export const DAILY_REPORT_MAX_PENDING_FOLLOW_UPS = 10;
export const DAILY_REPORT_FOLLOW_UP_TITLE_MAX_CHARS = 120;
export const DAILY_REPORT_FOLLOW_UP_OVERDUE_DAYS = 2;
export const DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS = 10;
export const DAILY_REPORT_ORCHESTRATION_TITLE_MAX_CHARS = 200;
export const DAILY_REPORT_MAX_HUMAN_SESSIONS = 12;
export const DAILY_REPORT_SESSION_TITLE_MAX_CHARS = 120;
export const DAILY_REPORT_SESSION_EXCERPT_MAX_CHARS = 600;
export const DAILY_REPORT_SESSION_USER_EXCERPT_MAX_CHARS = 300;
export const DAILY_REPORT_MAX_SCHEDULED_RUNS = 10;
export const DAILY_REPORT_TASK_NAME_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_GROUP_TASK_TRANSITIONS = 8;
export const DAILY_REPORT_GROUP_TASK_TITLE_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_LONG_TERM_EVENTS = 10;
export const DAILY_REPORT_MAX_LONG_TERM_TASKS = 8;
export const DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS = 100;
export const DAILY_REPORT_MAX_ONLINE_BOTS = 20;
/** 80KB: a full 20-bot day (the system-wide bot cap) with dream digests
 * landed needs ~60-70KB; smaller budgets forced the shrink ladder to drop
 * entire bots, which defeats the one-line-per-active-bot contract. The facts
 * feed ONE idle-time brain call a day — no per-turn context cost. */
export const DAILY_REPORT_MAX_FACTS_JSON_BYTES = 80 * 1024;

// ── v2 owner rework (2026-10-26): per-bot activity + upcoming buckets ──────

/** Active bots kept in facts.botActivity (sorted by activity score). */
export const DAILY_REPORT_MAX_BOT_ACTIVITY = 20;
/** Sessions narrated per bot (by in-window message volume). */
export const DAILY_REPORT_BOT_SESSIONS_MAX = 3;
export const DAILY_REPORT_BOT_SESSION_TITLE_MAX_CHARS = 90;
export const DAILY_REPORT_BOT_EXCERPT_MAX_CHARS = 160;
/** Scheduled runs kept per bot (failures always kept first). */
export const DAILY_REPORT_BOT_RUNS_MAX = 5;
/** External peers narrated per bot (by DM volume). */
export const DAILY_REPORT_BOT_EXTERNAL_CHATS_MAX = 2;
export const DAILY_REPORT_EXTERNAL_EXCERPT_MAX_CHARS = 120;
/** OpenTeam tasks narrated per bot (active-in-window memberships). */
export const DAILY_REPORT_BOT_OPENTEAM_MAX = 2;
/** On-chain interaction kinds kept per bot (path-derived). */
export const DAILY_REPORT_BOT_CHAIN_KINDS_MAX = 3;
export const DAILY_REPORT_CHAIN_SUMMARY_MAX_CHARS = 120;
/** Rows scanned for the per-bot run grouping (window cap, not output cap). */
export const DAILY_REPORT_SCHEDULED_RUNS_SCAN_CAP = 60;
/** Active session rows scanned for the bot bucket (safety valve). */
export const DAILY_REPORT_BOT_SESSION_SCAN_CAP = 200;
/** Upcoming scheduled fires listed (the total count is kept separately). */
export const DAILY_REPORT_UPCOMING_FIRES_MAX = 12;
export const DAILY_REPORT_UPCOMING_ORCHESTRATIONS_MAX = 8;
export const DAILY_REPORT_UPCOMING_TITLE_MAX_CHARS = 120;

// ── Fact shapes ────────────────────────────────────────────────────────────

export interface DailyReportPendingFollowUp {
  sessionId: string;
  title: string;
  botName: string | null;
  source: string | null;
  ageDays: number | null;
  overdue: boolean;
  /** The session's work waits on an external condition (e.g. its long-term
   * sub-project is waiting_external). Waiting items keep the age suffix but
   * never carry the overdue badge. */
  waitingOnExternal: boolean;
}

export interface DailyReportOwnerOrchestration {
  taskId: string;
  title: string;
  status: string;
  stepsDone: number;
  stepsTotal: number;
  percentComplete: number | null;
  workerSessionIds: string[];
  updatedAt: string | null;
}

export interface DailyReportHumanSession {
  sessionId: string;
  title: string;
  botName: string | null;
  sessionType: string | null;
  humanUserMessages: number;
  assistantMessages: number;
  lastAssistantExcerpt: string | null;
  /** Latest human-submitted user message in the window (cerebellum triage). */
  lastUserExcerpt: string | null;
}

export interface DailyReportScheduledRun {
  taskName: string;
  botName: string | null;
  status: string;
  skipReason: string | null;
  startedAt: string | null;
  error: string | null;
}

export interface DailyReportGroupTaskTransition {
  taskId: number;
  title: string;
  fromStatus: string | null;
  toStatus: string;
  actor: string | null;
  reason: string | null;
  createdAt: string | null;
}

export interface DailyReportLongTermEvent {
  taskId: string;
  taskTitle: string;
  subtaskId: string | null;
  kind: string;
  actor: string;
  detail: string;
  createdAt: string | null;
}

export interface DailyReportLongTermProgress {
  taskId: string;
  title: string;
  stage: string;
  subtasksAccepted: number;
  subtasksTotal: number;
  percentComplete: number;
}

export interface DailyReportOnlineActivity {
  botName: string;
  privateMessageCount: number;
  groupMessageCount: number;
}

/** One local session a bot was active in during the window (any session type). */
export interface DailyReportBotSessionFact {
  sessionId: string;
  title: string;
  sessionType: string | null;
  messageCount: number;
  lastAssistantExcerpt: string | null;
}

/** One external peer a bot exchanged DMs with during the window. */
export interface DailyReportExternalChatFact {
  peerName: string;
  messageCount: number;
  lastExcerpt: string | null;
}

/** One OpenTeam task a bot was actively participating in during the window. */
export interface DailyReportOpenTeamFact {
  taskTitle: string;
  memberStatus: string;
  windowMessageCount: number;
}

/** One on-chain interaction kind a bot performed during the window
 * (surf comments/likes/publishes — kind is the last path segment, e.g.
 * 'paylike' from '/protocols/paylike'). */
export interface DailyReportChainInteractionFact {
  kind: string;
  count: number;
  lastSummary: string | null;
}

export interface DailyReportBotScheduledRunFact {
  taskName: string;
  status: string;
}

/**
 * Per-bot activity rollup for the v2 briefing — the "what did each bot DO
 * today" bucket the brain distills into one-liners. Aggregates ALL session
 * types (standard / a2a / browser / group_task / longterm), scheduled runs,
 * external DM peers, OpenTeam participation and on-chain interactions.
 */
export interface DailyReportBotActivity {
  botName: string;
  isTwin: boolean;
  totalSessions: number;
  totalMessages: number;
  sessions: DailyReportBotSessionFact[];
  scheduledRuns: DailyReportBotScheduledRunFact[];
  scheduledRunCount: number;
  externalChats: DailyReportExternalChatFact[];
  openTeam: DailyReportOpenTeamFact[];
  chainInteractions: DailyReportChainInteractionFact[];
  groupMessages: number;
}

export interface DailyReportUpcomingFire {
  /** Local 'HH:MM' of the next fire (date implied by the report date). */
  fireAtLocal: string;
  taskName: string;
  botName: string | null;
}

export interface DailyReportUpcoming {
  scheduledFires: DailyReportUpcomingFire[];
  scheduledFiresTotal: number;
  openOrchestrations: DailyReportBotScheduledRunFact[];
  openOrchestrationByStatus: Record<string, number>;
}

/** 12 two-hour buckets of message volume for the visual timeline. */
export interface DailyReportHourlyActivity {
  local: number[];
  online: number[];
}

export interface DailyReportFacts {
  generatedAtMs: number;
  windowStartMs: number;
  windowEndMs: number;
  pendingFollowUps: DailyReportPendingFollowUp[];
  ownerOrchestrations: DailyReportOwnerOrchestration[];
  humanSessions: DailyReportHumanSession[];
  machineActivity: {
    scheduledRuns: DailyReportScheduledRun[];
    groupTaskTransitions: DailyReportGroupTaskTransition[];
    longTermEvents: DailyReportLongTermEvent[];
    longTermProgress: DailyReportLongTermProgress[];
    twinDelegateOrchestrationsInWindow: number;
  };
  onlineActivity: DailyReportOnlineActivity[];
  /** v2: per-bot "what did this bot do" rollup (all session types + runs + external). */
  botActivity: DailyReportBotActivity[];
  /** v2: what the next 24h holds (scheduled fires, open orchestrations). */
  upcoming: DailyReportUpcoming;
  /** v2: 12×2h message buckets for the visual timeline. */
  hourlyActivity: DailyReportHourlyActivity;
  /** v2: total bots known on this machine (for the X/Y active KPI). */
  knownBotCount: number;
  /** Any cowork session created in the window (the E10 "new sessions" bit). */
  newSessionCount: number;
  /** E10 skip bit: true only when the window holds literally zero activity. */
  hasAnyActivity: boolean;
}

// ── Pure helpers (unit-tested directly) ────────────────────────────────────

/** Local YYYY-MM-DD for a ms timestamp (the report's date vocabulary). */
export const formatDailyReportLocalDate = (ms: number): string => {
  const d = new Date(ms);
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Report window: since the last SUCCESSFUL run's windowEndMs; a first report
 * covers yesterday 00:00 local → now. Lookback is hard-capped (a machine that
 * slept for two weeks must not digest fourteen days).
 */
export const computeDailyReportWindow = (input: {
  nowMs: number;
  lastSuccessfulWindowEndMs?: number | null;
  maxLookbackDays?: number;
}): { windowStartMs: number; windowEndMs: number } => {
  const windowEndMs = input.nowMs;
  const maxLookbackMs = Math.max(1, Math.floor(input.maxLookbackDays ?? DAILY_REPORT_MAX_LOOKBACK_DAYS)) * DAY_MS;
  const last = Number(input.lastSuccessfulWindowEndMs);
  let windowStartMs: number;
  if (Number.isFinite(last) && last > 0) {
    windowStartMs = last;
  } else {
    const yesterday = new Date(windowEndMs);
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    windowStartMs = yesterday.getTime();
  }
  windowStartMs = Math.max(windowStartMs, windowEndMs - maxLookbackMs);
  if (windowStartMs >= windowEndMs) {
    // Degenerate (clock skew / immediate re-run): keep a 1s window instead of
    // an inverted one so downstream SQL stays sane.
    windowStartMs = windowEndMs - 1000;
  }
  return { windowStartMs, windowEndMs };
};

/** Whitespace-collapse + UTF-16-safe prefix cut with an ellipsis marker. */
export const capDailyReportText = (text: unknown, maxChars: number): string => {
  const collapsed = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length <= maxChars) return collapsed;
  if (maxChars <= 1) return '…';
  const cut = collapsed.slice(0, maxChars - 1);
  const last = cut.charCodeAt(cut.length - 1);
  return `${last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut}…`;
};

export const shapePendingFollowUpRows = (
  rows: ReadonlyArray<Record<string, unknown>>,
  windowEndMs: number,
  maxItems: number = DAILY_REPORT_MAX_PENDING_FOLLOW_UPS,
  waitingExternalSessionIds?: ReadonlySet<string>,
): DailyReportPendingFollowUp[] =>
  rows.slice(0, maxItems).map((row) => {
    const followUpAtMs = row.follow_up_at ? Date.parse(String(row.follow_up_at)) : NaN;
    const ageDays = Number.isFinite(followUpAtMs)
      ? Math.max(0, Math.floor((windowEndMs - followUpAtMs) / DAY_MS))
      : null;
    const sessionId = String(row.id ?? '');
    const waitingOnExternal = waitingExternalSessionIds?.has(sessionId) ?? false;
    return {
      sessionId,
      title: capDailyReportText(row.title, DAILY_REPORT_FOLLOW_UP_TITLE_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      source: row.follow_up_source ? String(row.follow_up_source) : null,
      ageDays,
      // Waiting-on-external items show a waiting badge instead of overdue —
      // nobody on this machine is late, the clock is simply not ours.
      overdue: !waitingOnExternal && ageDays !== null && ageDays >= DAILY_REPORT_FOLLOW_UP_OVERDUE_DAYS,
      waitingOnExternal,
    };
  }).filter((item) => item.sessionId);

// ── Pending follow-up lifecycle cross-check (2026-10-28) ───────────────────
//
// A follow_up_state='pending' marker is set at turn end by the cerebellum
// classifier and only ever cleared by a LATER turn on the same session. When
// the underlying work finishes without another turn — a scheduled task gets
// disabled or deleted after a successful one-shot run, an orchestration task
// closes, a long-term sub-project is accepted — the marker goes stale forever
// and the report used to list it as "pending · overdue" indefinitely. This
// cross-check drops rows whose work is verifiably done or stopped, BEFORE the
// 10-item cap slice, and flags rows that wait on an external condition so the
// generator shows them as waiting instead of overdue.
//
// 'manual' follow-up pins are exempt: the owner deliberately parked those rows
// (setSessionFollowUp's manual stickiness), so an explicit pin outranks any
// task lifecycle. Design: docs/design/2026-10-28-daily-report-pending-criteria.md

/** IN(?) chunk size for the lifecycle queries — SQLite's default host-parameter
 * cap is 999, so 400 keeps every statement comfortably below it. */
const PENDING_FOLLOW_UP_IN_CHUNK = 400;

/** Terminal orchestration statuses (schema CHECK, orchestrationStore.ts):
 * the task closed and will never run again. */
const CLOSED_ORCHESTRATION_STATUSES: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);

/** Long-term subtask statuses that mean the sub-project is finished. */
const DONE_SUBTASK_STATUSES: ReadonlySet<string> = new Set(['accepted', 'skipped', 'rejected']);

export interface PendingFollowUpLifecycle {
  /** Session ids whose underlying work is verifiably done or stopped. */
  excluded: Set<string>;
  /** Session ids whose work waits on an external condition (never overdue). */
  waitingExternal: Set<string>;
}

const chunkStrings = (values: readonly string[], size: number): string[][] => {
  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += size) chunks.push(values.slice(i, i + size));
  return chunks;
};

/** Parse a session_history_json array ("["id1","id2"]") without trusting it. */
const parseSessionHistoryIds = (raw: unknown): string[] => {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is string => typeof entry === 'string');
  } catch {
    return [];
  }
};

/** Long-term subtask row flattened by the lane query. */
interface SubtaskLaneRow {
  sessionId: string;
  status: string;
  waitUntil: string | null;
  parentStage: string | null;
  parentDoneAt: string | null;
  historyIds: string[];
}

/** A sub-project is finished when its own status is a done verdict or its
 * parent long-term task is done/cancelled. */
const isSubtaskDone = (row: SubtaskLaneRow): boolean =>
  DONE_SUBTASK_STATUSES.has(row.status)
  || row.parentStage === 'done'
  || row.parentStage === 'cancelled'
  || (row.parentDoneAt !== null && row.parentDoneAt.length > 0);

/** A live sub-project waits on an external condition. */
const isSubtaskWaiting = (row: SubtaskLaneRow): boolean =>
  row.status === 'waiting_external'
  || (row.waitUntil !== null && row.waitUntil.length > 0);

const toSubtaskLaneRow = (row: Record<string, unknown>): SubtaskLaneRow => ({
  sessionId: typeof row.session_id === 'string' ? row.session_id : '',
  status: row.status ? String(row.status) : '',
  waitUntil: typeof row.wait_until === 'string' && row.wait_until.length > 0 ? row.wait_until : null,
  parentStage: typeof row.parent_stage === 'string' && row.parent_stage.length > 0 ? row.parent_stage : null,
  parentDoneAt: typeof row.parent_done_at === 'string' && row.parent_done_at.length > 0 ? row.parent_done_at : null,
  historyIds: parseSessionHistoryIds(row.session_history_json),
});

/**
 * Lifecycle cross-check over the RAW pending follow-up rows. Four lanes, each
 * fail-soft on its own (a broken query degrades to "no verdict from that
 * lane", never to an exception):
 *  - scheduled tasks linked via cowork_session_id / target_session_id:
 *    exclude when at least one task row links AND every linked task is
 *    stopped (enabled=0, or its expires_at day is already over — the
 *    scheduler skips expired tasks but never disables them);
 *  - orphan schedule sessions (no task row at all, auto_origin='schedule'):
 *    exclude when the latest scheduled_task_runs row succeeded (one-shot
 *    'at' tasks self-disable after execution, scheduler.ts; a deleted task
 *    row with a successful last run is the same done state). A failed last
 *    run keeps the row — a genuinely failed one-shot may still need the
 *    owner's attention;
 *  - orchestration worker sessions (orchestration_attempts.worker_session_id
 *    → steps → tasks): exclude when EVERY task the session worked for is
 *    terminal (completed/cancelled/failed);
 *  - long-term subtasks (primary seat via session_id, participation via
 *    session_history_json): primary-seat sub-project done ⇒ exclude;
 *    otherwise exclude only when EVERY linked sub-project is done, and flag
 *    waitingExternal when a live linked sub-project waits externally. Done
 *    beats waiting.
 */
export const collectPendingFollowUpLifecycle = (
  db: DailyReportDb,
  rows: ReadonlyArray<Record<string, unknown>>,
): PendingFollowUpLifecycle => {
  const excluded = new Set<string>();
  const waitingExternal = new Set<string>();
  // Manual pins are the owner's explicit parking decision — never lifecycle-excluded.
  const candidateIds = rows
    .filter((row) => String(row.follow_up_source ?? '') !== 'manual')
    .map((row) => String(row.id ?? ''))
    .filter(Boolean);
  if (candidateIds.length === 0) return { excluded, waitingExternal };
  const candidateIdSet = new Set(candidateIds);
  const scheduleOriginIds = new Set(
    rows
      .filter((row) => String(row.auto_origin ?? '') === 'schedule')
      .map((row) => String(row.id ?? ''))
      .filter(Boolean),
  );

  // ── Scheduled lanes: live task rows + run history ────────────────────────
  const todayDate = new Date().toISOString().slice(0, 10);
  const scheduleLanes = safeCollect('pendingFollowUps.scheduleLane', { taskRows: [], runRows: [] }, () => {
    const taskRows: Record<string, unknown>[] = [];
    const runRows: Record<string, unknown>[] = [];
    for (const chunk of chunkStrings(candidateIds, PENDING_FOLLOW_UP_IN_CHUNK)) {
      const placeholders = chunk.map(() => '?').join(',');
      taskRows.push(...db.queryAll<Record<string, unknown>>(`
        SELECT st.cowork_session_id AS session_id, st.target_session_id AS target_session_id,
               st.enabled AS enabled, st.expires_at AS expires_at
        FROM scheduled_tasks st
        WHERE st.cowork_session_id IN (${placeholders})
           OR st.target_session_id IN (${placeholders})
      `, [...chunk, ...chunk]));
      runRows.push(...db.queryAll<Record<string, unknown>>(`
        SELECT r.session_id AS session_id, r.status AS status
        FROM scheduled_task_runs r
        WHERE r.session_id IN (${placeholders})
        ORDER BY r.started_at ASC
      `, [...chunk]));
    }
    return { taskRows, runRows };
  });

  // session → linked task rows (either linkage column counts).
  const linkedTasks = new Map<string, { enabled: unknown; expiresAt: unknown }[]>();
  for (const row of scheduleLanes.taskRows) {
    for (const key of ['session_id', 'target_session_id']) {
      const sessionId = row[key] ? String(row[key]) : '';
      if (!sessionId) continue;
      const list = linkedTasks.get(sessionId) ?? [];
      list.push({ enabled: row.enabled, expiresAt: row.expires_at });
      linkedTasks.set(sessionId, list);
    }
  }
  // Latest run status per session (rows arrive started_at ASC, last write wins).
  const latestRunStatus = new Map<string, string>();
  for (const row of scheduleLanes.runRows) {
    const sessionId = row.session_id ? String(row.session_id) : '';
    const status = row.status ? String(row.status) : '';
    if (sessionId && status) latestRunStatus.set(sessionId, status);
  }
  const isStoppedTask = (task: { enabled: unknown; expiresAt: unknown }): boolean =>
    Number(task.enabled ?? 1) === 0
    || (typeof task.expiresAt === 'string' && task.expiresAt.slice(0, 10) <= todayDate && task.expiresAt.trim().length >= 10);
  for (const sessionId of candidateIds) {
    const tasks = linkedTasks.get(sessionId);
    if (tasks && tasks.length > 0) {
      // Any live (enabled, unexpired) task keeps the session listed.
      if (tasks.every(isStoppedTask)) excluded.add(sessionId);
      continue;
    }
    // Orphan: no task row references the session at all.
    if (scheduleOriginIds.has(sessionId) && latestRunStatus.get(sessionId) === 'success') {
      excluded.add(sessionId);
    }
  }

  // ── Orchestration lane: worker sessions of attempts ─────────────────────
  const orchestrationStatuses = safeCollect('pendingFollowUps.orchestrationLane', new Map<string, Set<string>>(), () => {
    const statuses = new Map<string, Set<string>>();
    for (const chunk of chunkStrings(candidateIds, PENDING_FOLLOW_UP_IN_CHUNK)) {
      const placeholders = chunk.map(() => '?').join(',');
      for (const row of db.queryAll<Record<string, unknown>>(`
        SELECT a.worker_session_id AS session_id, t.status AS status
        FROM orchestration_attempts a
        JOIN orchestration_steps sp ON sp.id = a.step_id
        JOIN orchestration_tasks t ON t.id = sp.task_id
        WHERE a.worker_session_id IN (${placeholders})
      `, [...chunk])) {
        const sessionId = row.session_id ? String(row.session_id) : '';
        const status = row.status ? String(row.status) : '';
        if (!sessionId || !status) continue;
        const set = statuses.get(sessionId) ?? new Set<string>();
        set.add(status);
        statuses.set(sessionId, set);
      }
    }
    return statuses;
  });
  for (const [sessionId, statuses] of orchestrationStatuses) {
    if (statuses.size > 0 && [...statuses].every((status) => CLOSED_ORCHESTRATION_STATUSES.has(status))) {
      excluded.add(sessionId);
    }
  }

  // ── Long-term lane: primary seats + participation history ───────────────
  // Small table (one row per sub-project), so a full scan + TS-side JSON
  // matching beats LIKE-injection-prone SQL containment.
  const subtaskRows = safeCollect('pendingFollowUps.longtermLane', [], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT l.session_id AS session_id, l.session_history_json AS session_history_json,
             l.status AS status, l.wait_until AS wait_until,
             lt.stage AS parent_stage, lt.done_at AS parent_done_at
      FROM long_term_subtasks l
      LEFT JOIN long_term_tasks lt ON lt.id = l.task_id
    `)).map(toSubtaskLaneRow);
  const primarySubtasks = new Map<string, SubtaskLaneRow[]>();
  const linkedSubtasks = new Map<string, SubtaskLaneRow[]>();
  const linkSubtask = (map: Map<string, SubtaskLaneRow[]>, sessionId: string, row: SubtaskLaneRow): void => {
    const list = map.get(sessionId) ?? [];
    list.push(row);
    map.set(sessionId, list);
  };
  for (const row of subtaskRows) {
    if (row.sessionId) linkSubtask(primarySubtasks, row.sessionId, row);
    for (const historyId of row.historyIds) linkSubtask(linkedSubtasks, historyId, row);
  }
  for (const sessionId of candidateIdSet) {
    // Primary seat: the session IS a sub-project's work seat.
    if ((primarySubtasks.get(sessionId) ?? []).some(isSubtaskDone)) {
      excluded.add(sessionId);
      continue;
    }
    const linked = linkedSubtasks.get(sessionId) ?? [];
    if (linked.length === 0) continue;
    // Participation history only: every linked sub-project must be done
    // before the session itself counts as stopped.
    if (linked.every(isSubtaskDone)) {
      excluded.add(sessionId);
      continue;
    }
    if (linked.some((row) => !isSubtaskDone(row) && isSubtaskWaiting(row))) {
      waitingExternal.add(sessionId);
    }
  }

  return { excluded, waitingExternal };
};

export const shapeOwnerOrchestrationRows = (
  taskRows: ReadonlyArray<Record<string, unknown>>,
  stepRows: ReadonlyArray<Record<string, unknown>>,
  attemptRows: ReadonlyArray<Record<string, unknown>>,
  maxItems: number = DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS,
): DailyReportOwnerOrchestration[] =>
  taskRows.slice(0, maxItems).map((row) => {
    const taskId = String(row.id ?? '');
    const steps = stepRows.filter((s) => String(s.task_id ?? '') === taskId);
    const stepsTotal = steps.length;
    const stepsDone = steps.filter((s) => s.status === 'completed').length;
    const workerSessionIds = [
      ...new Set(
        attemptRows
          .filter((a) => String(a.task_id ?? '') === taskId && a.worker_session_id)
          .map((a) => String(a.worker_session_id)),
      ),
    ].slice(0, 5);
    return {
      taskId,
      title: capDailyReportText(row.owner_intent, DAILY_REPORT_ORCHESTRATION_TITLE_MAX_CHARS) || '(untitled)',
      status: String(row.status ?? 'planning'),
      stepsDone,
      stepsTotal,
      percentComplete: stepsTotal > 0 ? Math.round((stepsDone / stepsTotal) * 100) : null,
      workerSessionIds,
      updatedAt: row.updated_at ? String(row.updated_at) : null,
    };
  }).filter((item) => item.taskId);

export const shapeHumanSessionRows = (
  sessionRows: ReadonlyArray<Record<string, unknown>>,
  excerptBySessionId: ReadonlyMap<string, { assistant: string | null; user: string | null }>,
  maxItems: number = DAILY_REPORT_MAX_HUMAN_SESSIONS,
): DailyReportHumanSession[] =>
  sessionRows.slice(0, maxItems).map((row) => {
    const sessionId = String(row.id ?? '');
    const excerpts = excerptBySessionId.get(sessionId) ?? { assistant: null, user: null };
    return {
      sessionId,
      title: capDailyReportText(row.title, DAILY_REPORT_SESSION_TITLE_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      sessionType: row.session_type ? String(row.session_type) : null,
      humanUserMessages: Number(row.human_user_count ?? 0) || 0,
      assistantMessages: Number(row.assistant_count ?? 0) || 0,
      lastAssistantExcerpt: excerpts.assistant
        ? capDailyReportText(excerpts.assistant, DAILY_REPORT_SESSION_EXCERPT_MAX_CHARS)
        : null,
      lastUserExcerpt: excerpts.user
        ? capDailyReportText(excerpts.user, DAILY_REPORT_SESSION_USER_EXCERPT_MAX_CHARS)
        : null,
    };
  }).filter((item) => item.sessionId);

// ── v2 shaping: per-bot activity / upcoming / hourly (pure, unit-tested) ───

/** Fold the host-generated delegation/schedule prefixes away so fallback
 * bot-lines read like work, not protocol labels (fixed generated markers,
 * not natural-language intent matching). */
export const stripDailyReportSessionTitlePrefix = (title: string): string =>
  title.replace(/^\[(?:编排任务|Orchestration Task|定时)\]\s*/, '').trim() || title;

export interface ShapedBotSessions {
  sessions: DailyReportBotSessionFact[];
  totalSessions: number;
  totalMessages: number;
}

/** One bot's window sessions: every row counts toward the totals, only the
 * top-N by message volume are narrated (with excerpts). */
export const shapeBotSessionsForBot = (
  rows: ReadonlyArray<Record<string, unknown>>,
  excerptBySessionId: ReadonlyMap<string, string | null>,
  maxItems: number = DAILY_REPORT_BOT_SESSIONS_MAX,
): ShapedBotSessions => {
  const mapped = rows
    .map((row) => ({
      sessionId: String(row.session_id ?? row.id ?? ''),
      title: capDailyReportText(row.session_title ?? row.title, DAILY_REPORT_BOT_SESSION_TITLE_MAX_CHARS) || '(untitled)',
      sessionType: row.session_type ? String(row.session_type) : null,
      messageCount: Math.max(0, Number(row.message_count ?? 0) || 0),
    }))
    .filter((session) => session.sessionId);
  const sorted = [...mapped].sort((a, b) => b.messageCount - a.messageCount);
  const sessions = sorted.slice(0, maxItems).map((session) => {
    const excerpt = excerptBySessionId.get(session.sessionId);
    return { ...session, lastAssistantExcerpt: excerpt ? capDailyReportText(excerpt, DAILY_REPORT_BOT_EXCERPT_MAX_CHARS) : null };
  });
  return {
    sessions,
    totalSessions: mapped.length,
    totalMessages: mapped.reduce((sum, session) => sum + session.messageCount, 0),
  };
};

/** One bot's external DM peers: top-N by volume with a last-message excerpt. */
export const shapeExternalChatFacts = (
  rows: ReadonlyArray<Record<string, unknown>>,
  excerptByPeerGlobal: ReadonlyMap<string, string | null>,
  maxItems: number = DAILY_REPORT_BOT_EXTERNAL_CHATS_MAX,
): DailyReportExternalChatFact[] =>
  rows
    .map((row) => {
      const peerGlobal = row.peer_global ? String(row.peer_global) : '';
      const named = row.peer_name ? String(row.peer_name) : '';
      return {
        peerGlobal,
        peerName: named || peerGlobal.slice(0, 10),
        messageCount: Math.max(0, Number(row.message_count ?? 0) || 0),
      };
    })
    .filter((entry) => entry.peerName && entry.peerGlobal)
    .sort((a, b) => b.messageCount - a.messageCount)
    .slice(0, maxItems)
    .map((entry) => {
      const excerpt = excerptByPeerGlobal.get(entry.peerGlobal);
      return {
        peerName: entry.peerName,
        messageCount: entry.messageCount,
        lastExcerpt: excerpt ? capDailyReportText(excerpt, DAILY_REPORT_EXTERNAL_EXCERPT_MAX_CHARS) : null,
      };
    });

/** On-chain interaction kind from a protocol path ('/protocols/paylike' → 'paylike'). */
export const chainKindFromPath = (path: unknown): string => {
  const segments = String(path ?? '').split('/').filter(Boolean);
  return segments[segments.length - 1] || 'write';
};

export const shapeChainInteractionFacts = (
  rows: ReadonlyArray<Record<string, unknown>>,
  summaryByKind: ReadonlyMap<string, string | null>,
  maxItems: number = DAILY_REPORT_BOT_CHAIN_KINDS_MAX,
): DailyReportChainInteractionFact[] =>
  rows
    .map((row) => ({
      rawPath: String(row.path ?? ''),
      count: Math.max(0, Number(row.cnt ?? 0) || 0),
    }))
    .filter((row) => row.count > 0 && row.rawPath)
    .sort((a, b) => b.count - a.count)
    .slice(0, maxItems)
    .map((row) => {
      const summary = summaryByKind.get(row.rawPath);
      return {
        kind: chainKindFromPath(row.rawPath),
        count: row.count,
        lastSummary: summary ? capDailyReportText(summary, DAILY_REPORT_CHAIN_SUMMARY_MAX_CHARS) : null,
      };
    });

/** Local 'HH:MM' for a ms timestamp. */
const formatLocalHourMinute = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export const shapeUpcomingFires = (
  rows: ReadonlyArray<Record<string, unknown>>,
  maxItems: number = DAILY_REPORT_UPCOMING_FIRES_MAX,
): Pick<DailyReportUpcoming, 'scheduledFires' | 'scheduledFiresTotal'> => {
  const mapped = rows
    .map((row) => ({
      fireAtMs: Number(row.next_run_at_ms ?? 0) || 0,
      taskName: capDailyReportText(row.name, DAILY_REPORT_TASK_NAME_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
    }))
    .filter((fire) => fire.fireAtMs > 0)
    .sort((a, b) => a.fireAtMs - b.fireAtMs);
  return {
    scheduledFires: mapped.slice(0, maxItems).map((fire) => ({
      fireAtLocal: formatLocalHourMinute(fire.fireAtMs),
      taskName: fire.taskName,
      botName: fire.botName,
    })),
    scheduledFiresTotal: mapped.length,
  };
};

/** Fill the 12×2h bucket arrays from (hour, count) rows. */
export const shapeHourlyActivity = (
  localRows: ReadonlyArray<Record<string, unknown>>,
  onlineRows: ReadonlyArray<Record<string, unknown>>,
): DailyReportHourlyActivity => {
  const local = new Array<number>(12).fill(0);
  const online = new Array<number>(12).fill(0);
  const fill = (target: number[], rows: ReadonlyArray<Record<string, unknown>>): void => {
    for (const row of rows) {
      const hour = Math.trunc(Number(row.h ?? row.bucket ?? NaN));
      const count = Math.max(0, Number(row.cnt ?? 0) || 0);
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) continue;
      const index = Math.max(0, Math.min(11, Math.floor(hour / 2)));
      target[index] += count;
    }
  };
  fill(local, localRows);
  fill(online, onlineRows);
  return { local, online };
};

/** E10 skip bit over the collected buckets. */
export const computeDailyReportHasAnyActivity = (facts: {
  pendingFollowUps: readonly unknown[];
  ownerOrchestrations: readonly unknown[];
  humanSessions: readonly unknown[];
  machineActivity: {
    scheduledRuns: readonly unknown[];
    groupTaskTransitions: readonly unknown[];
    longTermEvents: readonly unknown[];
    twinDelegateOrchestrationsInWindow: number;
  };
  onlineActivity: ReadonlyArray<{ privateMessageCount: number; groupMessageCount: number }>;
  newSessionCount: number;
}): boolean =>
  facts.pendingFollowUps.length > 0
  || facts.ownerOrchestrations.length > 0
  || facts.humanSessions.length > 0
  || facts.machineActivity.scheduledRuns.length > 0
  || facts.machineActivity.groupTaskTransitions.length > 0
  || facts.machineActivity.longTermEvents.length > 0
  || facts.machineActivity.twinDelegateOrchestrationsInWindow > 0
  || facts.onlineActivity.some((entry) => entry.privateMessageCount > 0 || entry.groupMessageCount > 0)
  || facts.newSessionCount > 0;

/**
 * Final JSON-level cap: shrink the cheapest-to-lose text fields until the
 * serialized facts fit the ledger budget (80KB — one idle-time brain call a
 * day, raised from 20KB with the v2 per-bot bucket). Bot-dropping is the LAST
 * resort — the whole point of the v2 briefing is one line per ACTIVE bot, so
 * the ladder trims per-item text first, then sessions/peers per bot, and only
 * then gives up entire bots.
 */
export const enforceDailyReportFactsCap = (
  facts: DailyReportFacts,
  maxBytes: number = DAILY_REPORT_MAX_FACTS_JSON_BYTES,
): DailyReportFacts => {
  const fits = (value: DailyReportFacts): boolean => Buffer.byteLength(JSON.stringify(value), 'utf8') <= maxBytes;
  if (fits(facts)) return facts;

  const shrinkBotExcerpts = (source: DailyReportFacts, excerptChars: number, summaryChars: number): DailyReportFacts => ({
    ...source,
    botActivity: source.botActivity.map((bot) => ({
      ...bot,
      sessions: bot.sessions.map((session) => ({
        ...session,
        lastAssistantExcerpt: session.lastAssistantExcerpt
          ? capDailyReportText(session.lastAssistantExcerpt, excerptChars)
          : null,
      })),
      externalChats: bot.externalChats.map((chat) => ({
        ...chat,
        lastExcerpt: chat.lastExcerpt
          ? capDailyReportText(chat.lastExcerpt, Math.min(excerptChars, DAILY_REPORT_EXTERNAL_EXCERPT_MAX_CHARS))
          : null,
      })),
      chainInteractions: bot.chainInteractions.map((chain) => ({
        ...chain,
        lastSummary: chain.lastSummary ? capDailyReportText(chain.lastSummary, summaryChars) : null,
      })),
    })),
  });

  let candidate = shrinkBotExcerpts(facts, 100, 60);
  if (fits(candidate)) return candidate;

  candidate = {
    ...candidate,
    humanSessions: candidate.humanSessions.map((s) => ({
      ...s,
      lastAssistantExcerpt: s.lastAssistantExcerpt ? capDailyReportText(s.lastAssistantExcerpt, 300) : null,
    })),
  };
  if (fits(candidate)) return candidate;

  // Structural trim that keeps every bot: fewer narrated sessions/peers.
  candidate = {
    ...candidate,
    botActivity: candidate.botActivity.map((bot) => ({
      ...bot,
      sessions: bot.sessions.slice(0, 2),
      externalChats: bot.externalChats.slice(0, 1),
    })),
  };
  if (fits(candidate)) return candidate;

  candidate = {
    ...candidate,
    botActivity: candidate.botActivity.slice(0, 14).map((bot) => ({ ...bot, sessions: bot.sessions.slice(0, 1) })),
  };
  if (fits(candidate)) return candidate;

  return {
    ...candidate,
    botActivity: candidate.botActivity.slice(0, 10),
    humanSessions: candidate.humanSessions.slice(0, 6),
  };
};

// ── Collection ─────────────────────────────────────────────────────────────

const safeCollect = <T>(bucket: string, fallback: T, fn: () => T): T => {
  try {
    return fn();
  } catch (error) {
    console.warn(`[DailyReportCollector] bucket '${bucket}' failed soft to empty:`, error);
    return fallback;
  }
};

/**
 * Human-submitted turn predicate: a user message whose metadata carries no
 * origin (legacy/local composer) or explicitly origin 'user'. JSON tags are
 * matched literally — the write path JSON.stringify's metadata with no spaces.
 */
const HUMAN_USER_MESSAGE_SQL = `
  m.type = 'user'
  AND (m.metadata IS NULL
       OR m.metadata NOT LIKE '%"origin"%'
       OR m.metadata LIKE '%"origin":"user"%')`;

/** Daily-report sessions are excluded from the human-work bucket by title. */
const DAILY_REPORT_TITLE_LIKE = '每日汇报 %';

/** Run statuses that count as not-succeeded (mirrors the generator's set). */
const isFailedOrSkippedRunStatus = (status: string): boolean =>
  status === 'failed' || status === 'error' || status === 'skipped';

export const collectDailyReportFacts = (input: {
  db: DailyReportDb;
  windowStartMs: number;
  windowEndMs: number;
  twinId: number;
}): DailyReportFacts => {
  const { db } = input;
  const isoStart = new Date(input.windowStartMs).toISOString();
  const isoEnd = new Date(input.windowEndMs).toISOString();
  const msStart = input.windowStartMs;
  const msEnd = input.windowEndMs;
  // Coarse B-tree range bounds for TEXT created_at columns storing either
  // SQLite's `YYYY-MM-DD HH:MM:SS` (space = 0x20) or ISO `YYYY-MM-DDTHH:MM:SS.sssZ`
  // ('T' = 0x54). Adding `created_at >= sqlRangeLower AND created_at < sqlRangeUpper`
  // lets SQLite seek idx_private_chat_msg_created_at / idx_group_chat_msg_created_at
  // instead of full-scanning 200k+ rows, while `datetime(...)` preserves exact borders.
  const sqlRangeLower = new Date(Math.max(0, msStart - 60_000)).toISOString().slice(0, 19).replace('T', ' ');
  const sqlRangeUpper = `${new Date(msEnd + 86_400_000).toISOString().slice(0, 10)}~`;

  const pendingFollowUps = safeCollect('pendingFollowUps', [], () => {
    const rows = db.queryAll<Record<string, unknown>>(`
      SELECT s.id, s.title, s.follow_up_source, s.follow_up_at, s.auto_origin, mb.name AS bot_name
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE s.follow_up_state = 'pending'
        AND COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.archived_at IS NULL
      ORDER BY COALESCE(s.follow_up_at, '') ASC, s.updated_at DESC
    `);
    // Drop rows whose underlying work is verifiably done or stopped BEFORE
    // the 10-item cap slice, so surviving legitimate items do not lose slots
    // to stale markers ahead of them in follow_up_at order.
    const lifecycle = collectPendingFollowUpLifecycle(db, rows);
    return shapePendingFollowUpRows(
      rows.filter((row) => !lifecycle.excluded.has(String(row.id ?? ''))),
      msEnd,
      DAILY_REPORT_MAX_PENDING_FOLLOW_UPS,
      lifecycle.waitingExternal,
    );
  });

  const ownerOrchestrations = safeCollect('ownerOrchestrations', [], () => {
    const taskRows = db.queryAll<Record<string, unknown>>(`
      SELECT t.id, t.owner_intent, t.status, t.updated_at
      FROM orchestration_tasks t
      WHERE t.origin = 'owner'
        AND ((t.updated_at >= ? AND t.updated_at < ?)
             OR t.status IN ('planning', 'running', 'review'))
      ORDER BY t.updated_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS * 2]);
    const taskIds = taskRows.slice(0, DAILY_REPORT_MAX_OWNER_ORCHESTRATIONS).map((r) => String(r.id));
    const placeholders = taskIds.length ? taskIds.map(() => '?').join(',') : "''";
    const stepRows = taskIds.length
      ? db.queryAll<Record<string, unknown>>(`SELECT task_id, status FROM orchestration_steps WHERE task_id IN (${placeholders})`, taskIds)
      : [];
    const attemptRows = taskIds.length
      ? db.queryAll<Record<string, unknown>>(`
          SELECT s.task_id, a.worker_session_id
          FROM orchestration_attempts a
          JOIN orchestration_steps s ON s.id = a.step_id
          WHERE s.task_id IN (${placeholders}) AND a.worker_session_id IS NOT NULL AND a.worker_session_id != ''
        `, taskIds)
      : [];
    return shapeOwnerOrchestrationRows(taskRows, stepRows, attemptRows);
  });

  const humanSessions = safeCollect('humanSessions', [], () => {
    const sessionRows = db.queryAll<Record<string, unknown>>(`
      SELECT s.id, s.title, s.session_type, s.updated_at, mb.name AS bot_name,
        (SELECT COUNT(*) FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND ${HUMAN_USER_MESSAGE_SQL}) AS human_user_count,
        (SELECT COUNT(*) FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND m.type = 'assistant') AS assistant_count
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE s.archived_at IS NULL
        AND COALESCE(s.hidden_from_session_list, 0) = 0
        AND s.title NOT LIKE ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ? AND ${HUMAN_USER_MESSAGE_SQL}
        )
        AND NOT EXISTS(
          SELECT 1 FROM cowork_messages dm
          WHERE dm.session_id = s.id AND dm.metadata LIKE '%"origin":"daily_report"%'
        )
      ORDER BY s.updated_at DESC
      LIMIT ?
    `, [msStart, msEnd, msStart, msEnd, DAILY_REPORT_TITLE_LIKE, msStart, msEnd, DAILY_REPORT_MAX_HUMAN_SESSIONS]);
    const excerptBySessionId = new Map<string, { assistant: string | null; user: string | null }>();
    for (const row of sessionRows) {
      const sessionId = String(row.id ?? '');
      if (!sessionId) continue;
      const excerpts: { assistant: string | null; user: string | null } = { assistant: null, user: null };
      try {
        const assistantRows = db.queryAll<{ content: string | null }>(`
          SELECT m.content FROM cowork_messages m
          WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
            AND m.type = 'assistant' AND COALESCE(m.content, '') != ''
          ORDER BY m.created_at DESC LIMIT 1
        `, [sessionId, msStart, msEnd]);
        excerpts.assistant = assistantRows[0]?.content ?? null;
      } catch {
        // One session's excerpt is not worth the bucket.
      }
      try {
        const userRows = db.queryAll<{ content: string | null }>(`
          SELECT m.content FROM cowork_messages m
          WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
            AND ${HUMAN_USER_MESSAGE_SQL} AND COALESCE(m.content, '') != ''
          ORDER BY m.created_at DESC LIMIT 1
        `, [sessionId, msStart, msEnd]);
        excerpts.user = userRows[0]?.content ?? null;
      } catch {
        // One session's excerpt is not worth the bucket.
      }
      excerptBySessionId.set(sessionId, excerpts);
    }
    return shapeHumanSessionRows(sessionRows, excerptBySessionId);
  });

  const scheduledRuns = safeCollect('scheduledRuns', [] as DailyReportScheduledRun[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT t.name AS task_name, mb.name AS bot_name, r.status, r.skip_reason, r.started_at, r.error
      FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      LEFT JOIN metabots mb ON mb.id = t.metabot_id
      WHERE r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_SCHEDULED_RUNS]).map((row) => ({
      taskName: capDailyReportText(row.task_name, DAILY_REPORT_TASK_NAME_MAX_CHARS) || '(untitled)',
      botName: row.bot_name ? String(row.bot_name) : null,
      status: String(row.status ?? 'unknown'),
      skipReason: row.skip_reason ? String(row.skip_reason) : null,
      startedAt: row.started_at ? String(row.started_at) : null,
      error: row.error ? capDailyReportText(row.error, 200) : null,
    })));

  const groupTaskTransitions = safeCollect('groupTaskTransitions', [] as DailyReportGroupTaskTransition[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT tr.task_id, gt.title, tr.from_status, tr.to_status, tr.actor, tr.reason, tr.created_at
      FROM group_task_transitions tr
      JOIN group_tasks gt ON gt.id = tr.task_id
      WHERE datetime(tr.created_at) >= datetime(?) AND datetime(tr.created_at) < datetime(?)
      ORDER BY tr.created_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_GROUP_TASK_TRANSITIONS]).map((row) => ({
      taskId: Number(row.task_id ?? 0) || 0,
      title: capDailyReportText(row.title, DAILY_REPORT_GROUP_TASK_TITLE_MAX_CHARS) || '(untitled)',
      fromStatus: row.from_status ? String(row.from_status) : null,
      toStatus: String(row.to_status ?? ''),
      actor: row.actor ? String(row.actor) : null,
      reason: row.reason ? capDailyReportText(row.reason, 200) : null,
      createdAt: row.created_at ? String(row.created_at) : null,
    })));

  const longTermEvents = safeCollect('longTermEvents', [] as DailyReportLongTermEvent[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT e.task_id, lt.title AS task_title, e.subtask_id, e.kind, e.actor, e.detail, e.created_at
      FROM long_term_events e
      JOIN long_term_tasks lt ON lt.id = e.task_id
      WHERE e.created_at >= ? AND e.created_at < ?
      ORDER BY e.created_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_MAX_LONG_TERM_EVENTS]).map((row) => ({
      taskId: String(row.task_id ?? ''),
      taskTitle: capDailyReportText(row.task_title, DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS) || '(untitled)',
      subtaskId: row.subtask_id ? String(row.subtask_id) : null,
      kind: String(row.kind ?? ''),
      actor: String(row.actor ?? ''),
      detail: capDailyReportText(row.detail, 300),
      createdAt: row.created_at ? String(row.created_at) : null,
    })));

  const longTermProgress = safeCollect('longTermProgress', [] as DailyReportLongTermProgress[], () =>
    db.queryAll<Record<string, unknown>>(`
      SELECT t.id, t.title, t.stage,
        SUM(CASE WHEN st.status != 'skipped' THEN 1 ELSE 0 END) AS live_total,
        SUM(CASE WHEN st.status = 'accepted' THEN 1 ELSE 0 END) AS accepted
      FROM long_term_tasks t
      LEFT JOIN long_term_subtasks st ON st.task_id = t.id
      WHERE t.stage IN ('defining', 'active', 'paused')
      GROUP BY t.id
      ORDER BY t.updated_at DESC
      LIMIT ?
    `, [DAILY_REPORT_MAX_LONG_TERM_TASKS]).map((row) => {
      const liveTotal = Number(row.live_total ?? 0) || 0;
      const accepted = Number(row.accepted ?? 0) || 0;
      return {
        taskId: String(row.id ?? ''),
        title: capDailyReportText(row.title, DAILY_REPORT_LONG_TERM_TITLE_MAX_CHARS) || '(untitled)',
        stage: String(row.stage ?? 'defining'),
        subtasksAccepted: accepted,
        subtasksTotal: liveTotal,
        percentComplete: liveTotal === 0 ? 0 : Math.round((accepted / liveTotal) * 100),
      };
    }));

  const twinDelegateOrchestrationsInWindow = safeCollect('twinDelegateOrchestrations', 0, () => {
    const row = db.queryAll<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM orchestration_tasks
      WHERE origin = 'twin_delegate' AND updated_at >= ? AND updated_at < ?
    `, [isoStart, isoEnd])[0];
    return Number(row?.cnt ?? 0) || 0;
  });

  // botDigests (dream daily summaries) were dropped with the v2 rework: at the
  // 08:00 report time they mostly do not exist yet (bots dream late night),
  // and facts.botActivity now covers their information surface — owner call
  // 2026-10-26, keep the facts lean.

  const onlineActivity = safeCollect('onlineActivity', [] as DailyReportOnlineActivity[], () => {
    const privateRows = db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, COUNT(*) AS message_count
      FROM private_chat_messages m
      JOIN metabots mb ON (mb.globalmetaid IS NOT NULL AND mb.globalmetaid != ''
        AND (mb.globalmetaid = m.from_global_metaid OR mb.globalmetaid = m.to_global_metaid))
      WHERE m.created_at >= ? AND m.created_at < ?
        AND datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
      GROUP BY mb.id
    `, [sqlRangeLower, sqlRangeUpper, isoStart, isoEnd]);
    const groupRows = db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, COUNT(*) AS message_count
      FROM group_chat_messages m
      JOIN metabots mb ON (mb.globalmetaid IS NOT NULL AND mb.globalmetaid != ''
        AND mb.globalmetaid = m.sender_global_metaid)
      WHERE m.created_at >= ? AND m.created_at < ?
        AND datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
      GROUP BY mb.id
    `, [sqlRangeLower, sqlRangeUpper, isoStart, isoEnd]);
    const byBot = new Map<number, { botName: string; privateMessageCount: number; groupMessageCount: number }>();
    for (const row of privateRows) {
      const id = Number(row.metabot_id);
      if (!Number.isFinite(id)) continue;
      const entry = byBot.get(id) ?? { botName: String(row.bot_name ?? '(bot)'), privateMessageCount: 0, groupMessageCount: 0 };
      entry.privateMessageCount += Number(row.message_count ?? 0) || 0;
      byBot.set(id, entry);
    }
    for (const row of groupRows) {
      const id = Number(row.metabot_id);
      if (!Number.isFinite(id)) continue;
      const entry = byBot.get(id) ?? { botName: String(row.bot_name ?? '(bot)'), privateMessageCount: 0, groupMessageCount: 0 };
      entry.groupMessageCount += Number(row.message_count ?? 0) || 0;
      byBot.set(id, entry);
    }
    return [...byBot.entries()]
      .sort((a, b) => (b[1].privateMessageCount + b[1].groupMessageCount) - (a[1].privateMessageCount + a[1].groupMessageCount))
      .slice(0, DAILY_REPORT_MAX_ONLINE_BOTS)
      .map(([, entry]) => entry);
  });

  const newSessionCount = safeCollect('newSessionCount', 0, () => {
    const row = db.queryAll<{ cnt: number }>(`
      SELECT COUNT(*) AS cnt FROM cowork_sessions
      WHERE created_at >= ? AND created_at < ?
    `, [msStart, msEnd])[0];
    return Number(row?.cnt ?? 0) || 0;
  });

  // ── v2: per-bot "what did this bot do" rollup ────────────────────────────
  const botActivity = safeCollect('botActivity', [] as DailyReportBotActivity[], () => {
    interface BotAccumulator {
      metabotId: number;
      botName: string;
      isTwin: boolean;
      sessionRows: Record<string, unknown>[];
      runRows: Record<string, unknown>[];
      externalRows: Record<string, unknown>[];
      openTeamRows: Record<string, unknown>[];
      chainRows: Record<string, unknown>[];
      groupMessages: number;
    }
    const byBot = new Map<string, BotAccumulator>();
    const accumulator = (botName: string): BotAccumulator | null => {
      const name = typeof botName === 'string' ? botName.trim() : '';
      if (!name) return null;
      const existing = byBot.get(name);
      if (existing) return existing;
      const created: BotAccumulator = {
        metabotId: 0,
        botName: name,
        isTwin: false,
        sessionRows: [],
        runRows: [],
        externalRows: [],
        openTeamRows: [],
        chainRows: [],
        groupMessages: 0,
      };
      byBot.set(name, created);
      return created;
    };

    // 1. sessions (all types) with in-window message counts. Worker sessions
    //    (orchestration/surf/group-task delegation) are hidden_from_session_list
    //    but ARE the bot's work — only archived rows and the daily report's
    //    own sessions stay out, otherwise bots whose only activity is worker
    //    sessions vanish from the fleet section.
    const sessionRows = db.queryAll<Record<string, unknown>>(`
      SELECT s.metabot_id AS metabot_id, mb.name AS bot_name,
        s.id AS session_id, s.title AS session_title, s.session_type AS session_type,
        (SELECT COUNT(*) FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?) AS message_count
      FROM cowork_sessions s
      LEFT JOIN metabots mb ON mb.id = s.metabot_id
      WHERE s.metabot_id IS NOT NULL
        AND s.archived_at IS NULL
        AND s.title NOT LIKE ?
        AND s.updated_at >= ? AND s.updated_at < ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?
        )
        AND NOT EXISTS(
          SELECT 1 FROM cowork_messages dm
          WHERE dm.session_id = s.id AND dm.metadata LIKE '%"origin":"daily_report"%'
        )
      ORDER BY s.updated_at DESC
      LIMIT ?
    `, [msStart, msEnd, DAILY_REPORT_TITLE_LIKE, msStart, msEnd, msStart, msEnd, DAILY_REPORT_BOT_SESSION_SCAN_CAP]);
    const sessionIdsForHourly: string[] = [];
    for (const row of sessionRows) {
      const acc = accumulator(String(row.bot_name ?? ''));
      if (!acc) continue;
      acc.metabotId = Number(row.metabot_id ?? 0) || acc.metabotId;
      acc.isTwin = acc.metabotId === input.twinId;
      acc.sessionRows.push(row);
      const sessionId = String(row.session_id ?? '');
      if (sessionId) sessionIdsForHourly.push(sessionId);
    }

    // 2. scheduled runs (scan-capped; grouped per bot below)
    const runRows = db.queryAll<Record<string, unknown>>(`
      SELECT t.name AS task_name, mb.name AS bot_name, r.status, r.started_at
      FROM scheduled_task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      LEFT JOIN metabots mb ON mb.id = t.metabot_id
      WHERE r.started_at >= ? AND r.started_at < ?
      ORDER BY r.started_at DESC
      LIMIT ?
    `, [isoStart, isoEnd, DAILY_REPORT_SCHEDULED_RUNS_SCAN_CAP]);
    for (const row of runRows) {
      const acc = accumulator(String(row.bot_name ?? ''));
      if (acc) acc.runRows.push(row);
    }

    // 3. external DM peers (who the bot talked to, how much, about what)
    const externalRows = db.queryAll<Record<string, unknown>>(`
      SELECT mb.id AS metabot_id, mb.name AS bot_name, mb.globalmetaid AS bot_global,
        CASE WHEN mb.globalmetaid = m.from_global_metaid THEN m.to_global_metaid ELSE m.from_global_metaid END AS peer_global,
        MAX(CASE WHEN mb.globalmetaid != m.from_global_metaid THEN m.from_name END) AS peer_name,
        COUNT(*) AS message_count
      FROM private_chat_messages m
      JOIN metabots mb ON (mb.globalmetaid IS NOT NULL AND mb.globalmetaid != ''
        AND (mb.globalmetaid = m.from_global_metaid OR mb.globalmetaid = m.to_global_metaid))
      WHERE m.created_at >= ? AND m.created_at < ?
        AND datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
      GROUP BY mb.id, peer_global
      ORDER BY message_count DESC
      LIMIT 60
    `, [sqlRangeLower, sqlRangeUpper, isoStart, isoEnd]);
    for (const row of externalRows) {
      const acc = accumulator(String(row.bot_name ?? ''));
      if (acc) acc.externalRows.push(row);
    }

    // 4. OpenTeam participation: active memberships that joined / changed task
    //    status / carried group messages in the window.
    const openTeamRows = db.queryAll<Record<string, unknown>>(`
      SELECT om.metabot_id, mb.name AS bot_name, om.task_title, om.status AS member_status,
        om.group_id,
        (datetime(om.created_at) >= datetime(?) AND datetime(om.created_at) < datetime(?)) AS joined_in_window,
        (datetime(COALESCE(om.task_status_updated_at, om.created_at)) >= datetime(?)
          AND datetime(COALESCE(om.task_status_updated_at, om.created_at)) < datetime(?)) AS status_in_window
      FROM openteam_memberships om
      JOIN metabots mb ON mb.id = om.metabot_id
      WHERE om.status = 'active'
      LIMIT 200
    `, [isoStart, isoEnd, isoStart, isoEnd]);
    for (const row of openTeamRows) {
      const groupId = row.group_id ? String(row.group_id) : '';
      let windowMessageCount = 0;
      if (groupId) {
        try {
          const countRow = db.queryAll<{ cnt: number }>(`
            SELECT COUNT(*) AS cnt FROM group_chat_messages g
            WHERE g.group_id = ? AND datetime(g.created_at) >= datetime(?) AND datetime(g.created_at) < datetime(?)
          `, [groupId, isoStart, isoEnd])[0];
          windowMessageCount = Number(countRow?.cnt ?? 0) || 0;
        } catch {
          // One group's count is not worth the bucket.
        }
      }
      const activeNow = Number(row.joined_in_window ?? 0) === 1
        || Number(row.status_in_window ?? 0) === 1
        || windowMessageCount > 0;
      if (!activeNow) continue;
      const acc = accumulator(String(row.bot_name ?? ''));
      if (!acc) continue;
      acc.openTeamRows.push({ ...row, window_message_count: windowMessageCount });
    }

    // 5. on-chain interactions (surf comments/likes/publishes)
    const chainRows = db.queryAll<Record<string, unknown>>(`
      SELECT w.metabot_id, mb.name AS bot_name, w.path, COUNT(*) AS cnt
      FROM metabot_chain_writes w
      JOIN metabots mb ON mb.id = w.metabot_id
      WHERE w.occurred_at_ms >= ? AND w.occurred_at_ms < ?
      GROUP BY w.metabot_id, w.path
      ORDER BY cnt DESC
      LIMIT 60
    `, [msStart, msEnd]);
    for (const row of chainRows) {
      const acc = accumulator(String(row.bot_name ?? ''));
      if (acc) acc.chainRows.push(row);
    }

    // 6. online group messages merge (already counted per bot above)
    for (const online of onlineActivity) {
      const acc = accumulator(online.botName);
      if (acc) acc.groupMessages += online.groupMessageCount;
    }

    const activityScore = (bot: BotAccumulator): number =>
      bot.sessionRows.reduce((sum, row) => sum + (Number(row.message_count ?? 0) || 0), 0)
      + bot.runRows.length * 5
      + bot.externalRows.reduce((sum, row) => sum + (Number(row.message_count ?? 0) || 0), 0) * 2
      + bot.groupMessages * 2
      + bot.chainRows.reduce((sum, row) => sum + (Number(row.cnt ?? 0) || 0), 0)
      + bot.openTeamRows.length * 5;

    const bots = [...byBot.values()]
      .filter((bot) => bot.sessionRows.length > 0 || bot.runRows.length > 0
        || bot.externalRows.length > 0 || bot.openTeamRows.length > 0
        || bot.chainRows.length > 0 || bot.groupMessages > 0)
      .sort((a, b) => activityScore(b) - activityScore(a) || a.botName.localeCompare(b.botName))
      .slice(0, DAILY_REPORT_MAX_BOT_ACTIVITY);

    return bots.map((bot) => {
      // Sessions: shape first (top-N by volume), then fetch excerpts for kept ids only.
      const shaped = shapeBotSessionsForBot(bot.sessionRows, new Map());
      const excerptBySessionId = new Map<string, string | null>();
      for (const session of shaped.sessions) {
        try {
          const rows = db.queryAll<{ content: string | null }>(`
            SELECT m.content FROM cowork_messages m
            WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
              AND m.type = 'assistant' AND COALESCE(m.content, '') != ''
            ORDER BY m.created_at DESC LIMIT 1
          `, [session.sessionId, msStart, msEnd]);
          excerptBySessionId.set(session.sessionId, rows[0]?.content ?? null);
        } catch {
          excerptBySessionId.set(session.sessionId, null);
        }
      }
      const sessionFacts = shapeBotSessionsForBot(bot.sessionRows, excerptBySessionId);

      // Runs: failures first, then recency; a couple of names for the brain.
      const failedFirst = [
        ...bot.runRows.filter((row) => isFailedOrSkippedRunStatus(String(row.status ?? ''))),
        ...bot.runRows.filter((row) => !isFailedOrSkippedRunStatus(String(row.status ?? ''))),
      ];
      const scheduledRuns = failedFirst.slice(0, DAILY_REPORT_BOT_RUNS_MAX).map((row) => ({
        taskName: capDailyReportText(row.task_name, DAILY_REPORT_TASK_NAME_MAX_CHARS) || '(untitled)',
        status: String(row.status ?? 'unknown'),
      }));

      // External chats: top peers, then one excerpt per kept peer.
      const shapedPeers = shapeExternalChatFacts(bot.externalRows, new Map());
      const peerGlobals = bot.externalRows
        .map((row) => ({ peerGlobal: String(row.peer_global ?? ''), count: Number(row.message_count ?? 0) || 0 }))
        .filter((entry) => entry.peerGlobal)
        .sort((a, b) => b.count - a.count);
      const excerptByPeerGlobal = new Map<string, string | null>();
      for (const entry of peerGlobals.slice(0, shapedPeers.length)) {
        const botGlobal = String(bot.externalRows.find((row) => String(row.peer_global ?? '') === entry.peerGlobal)?.bot_global ?? '');
        if (!botGlobal) continue;
        try {
          const rows = db.queryAll<{ content: string | null }>(`
            SELECT m.content FROM private_chat_messages m
            WHERE ((m.from_global_metaid = ? AND m.to_global_metaid = ?)
                OR (m.from_global_metaid = ? AND m.to_global_metaid = ?))
              AND datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
            ORDER BY m.created_at DESC LIMIT 1
          `, [botGlobal, entry.peerGlobal, entry.peerGlobal, botGlobal, isoStart, isoEnd]);
          excerptByPeerGlobal.set(entry.peerGlobal, rows[0]?.content ?? null);
        } catch {
          excerptByPeerGlobal.set(entry.peerGlobal, null);
        }
      }
      const externalChats = shapeExternalChatFacts(bot.externalRows, excerptByPeerGlobal);

      const openTeam = [...bot.openTeamRows]
        .sort((a, b) => (Number(b.window_message_count ?? 0) || 0) - (Number(a.window_message_count ?? 0) || 0))
        .slice(0, DAILY_REPORT_BOT_OPENTEAM_MAX)
        .map((row) => ({
          taskTitle: capDailyReportText(row.task_title, DAILY_REPORT_BOT_SESSION_TITLE_MAX_CHARS) || '(untitled)',
          memberStatus: String(row.member_status ?? 'active'),
          windowMessageCount: Number(row.window_message_count ?? 0) || 0,
        }));

      const chainKinds = shapeChainInteractionFacts(bot.chainRows, new Map());
      const summaryByKind = new Map<string, string | null>();
      for (const kind of chainKinds) {
        const rawPath = String(bot.chainRows.find((row) => chainKindFromPath(row.path) === kind.kind)?.path ?? '');
        if (!rawPath || !bot.metabotId) continue;
        try {
          const rows = db.queryAll<{ summary: string | null }>(`
            SELECT w.summary FROM metabot_chain_writes w
            WHERE w.metabot_id = ? AND w.path = ? AND w.occurred_at_ms >= ? AND w.occurred_at_ms < ?
              AND COALESCE(w.summary, '') != ''
            ORDER BY w.occurred_at_ms DESC LIMIT 1
          `, [bot.metabotId, rawPath, msStart, msEnd]);
          summaryByKind.set(rawPath, rows[0]?.summary ?? null);
        } catch {
          summaryByKind.set(rawPath, null);
        }
      }
      const chainInteractions = shapeChainInteractionFacts(bot.chainRows, summaryByKind);

      return {
        botName: bot.botName,
        isTwin: bot.isTwin,
        totalSessions: sessionFacts.totalSessions,
        totalMessages: sessionFacts.totalMessages,
        sessions: sessionFacts.sessions,
        scheduledRuns,
        scheduledRunCount: bot.runRows.length,
        externalChats,
        openTeam,
        chainInteractions,
        groupMessages: bot.groupMessages,
      };
    });
  });

  // ── v2: what the next 24h holds ──────────────────────────────────────────
  const upcoming = safeCollect('upcoming', {
    scheduledFires: [] as DailyReportUpcomingFire[],
    scheduledFiresTotal: 0,
    openOrchestrations: [] as DailyReportBotScheduledRunFact[],
    openOrchestrationByStatus: {} as Record<string, number>,
  } as DailyReportUpcoming, () => {
    const fireRows = db.queryAll<Record<string, unknown>>(`
      SELECT t.next_run_at_ms, t.name, mb.name AS bot_name
      FROM scheduled_tasks t
      LEFT JOIN metabots mb ON mb.id = t.metabot_id
      WHERE t.enabled = 1 AND t.next_run_at_ms >= ? AND t.next_run_at_ms < ?
      ORDER BY t.next_run_at_ms
      LIMIT 64
    `, [msEnd, msEnd + DAY_MS]);
    const orchRows = db.queryAll<Record<string, unknown>>(`
      SELECT o.owner_intent, o.status
      FROM orchestration_tasks o
      WHERE o.status IN ('planning','running','review')
      ORDER BY o.updated_at DESC
      LIMIT ?
    `, [DAILY_REPORT_UPCOMING_ORCHESTRATIONS_MAX]);
    const statusRows = db.queryAll<{ status: string; cnt: number }>(`
      SELECT o.status, COUNT(*) AS cnt
      FROM orchestration_tasks o
      WHERE o.status IN ('planning','running','review')
      GROUP BY o.status
    `);
    const openOrchestrationByStatus: Record<string, number> = {};
    for (const row of statusRows) {
      openOrchestrationByStatus[String(row.status ?? '')] = Number(row.cnt ?? 0) || 0;
    }
    return {
      ...shapeUpcomingFires(fireRows),
      openOrchestrations: orchRows.map((row) => ({
        taskName: capDailyReportText(row.owner_intent, DAILY_REPORT_UPCOMING_TITLE_MAX_CHARS) || '(untitled)',
        status: String(row.status ?? 'planning'),
      })),
      openOrchestrationByStatus,
    };
  });

  // ── v2: hourly buckets for the visual timeline ───────────────────────────
  const hourlyActivity = safeCollect('hourlyActivity', {
    local: new Array<number>(12).fill(0),
    online: new Array<number>(12).fill(0),
  } as DailyReportHourlyActivity, () => {
    // Local: per active session over the (session_id, created_at) index —
    // cowork_messages has no standalone created_at index, so a bare window
    // scan of the whole table is off the table.
    const activeSessionIds = db.queryAll<{ id: string }>(`
      SELECT s.id FROM cowork_sessions s
      WHERE s.updated_at >= ? AND s.updated_at < ?
        AND EXISTS(
          SELECT 1 FROM cowork_messages m
          WHERE m.session_id = s.id AND m.created_at >= ? AND m.created_at < ?
        )
      LIMIT 250
    `, [msStart, msEnd, msStart, msEnd]).map((row) => String(row.id ?? '')).filter(Boolean);
    const localRows: Record<string, unknown>[] = [];
    for (const sessionId of activeSessionIds) {
      try {
        localRows.push(...db.queryAll<Record<string, unknown>>(`
          SELECT CAST(strftime('%H', Datetime(m.created_at/1000,'unixepoch','localtime')) AS INTEGER) AS h, COUNT(*) AS cnt
          FROM cowork_messages m
          WHERE m.session_id = ? AND m.created_at >= ? AND m.created_at < ?
          GROUP BY h
        `, [sessionId, msStart, msEnd]));
      } catch {
        // One session's buckets are not worth the section.
      }
    }
    const onlineRows: Record<string, unknown>[] = [];
      for (const [table] of [['private_chat_messages'], ['group_chat_messages']] as const) {
        try {
          onlineRows.push(...db.queryAll<Record<string, unknown>>(`
            SELECT CAST(strftime('%H', m.created_at, 'localtime') AS INTEGER) AS h, COUNT(*) AS cnt
            FROM ${table} m
            WHERE m.created_at >= ? AND m.created_at < ?
              AND datetime(m.created_at) >= datetime(?) AND datetime(m.created_at) < datetime(?)
            GROUP BY h
          `, [sqlRangeLower, sqlRangeUpper, isoStart, isoEnd]));
        } catch {
        // One table's buckets are not worth the section.
      }
    }
    return shapeHourlyActivity(localRows, onlineRows);
  });

  const knownBotCount = safeCollect('knownBotCount', 0, () => {
    const row = db.queryAll<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM metabots')[0];
    return Number(row?.cnt ?? 0) || 0;
  });

  const partial: DailyReportFacts = {
    generatedAtMs: msEnd,
    windowStartMs: msStart,
    windowEndMs: msEnd,
    pendingFollowUps,
    ownerOrchestrations,
    humanSessions,
    machineActivity: {
      scheduledRuns,
      groupTaskTransitions,
      longTermEvents,
      longTermProgress,
      twinDelegateOrchestrationsInWindow,
    },
    onlineActivity,
    botActivity,
    upcoming,
    hourlyActivity,
    knownBotCount,
    newSessionCount,
    hasAnyActivity: false,
  };
  return enforceDailyReportFactsCap({
    ...partial,
    hasAnyActivity: computeDailyReportHasAnyActivity(partial),
  });
};
