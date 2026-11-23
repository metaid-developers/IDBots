/**
 * Process Hub (进程中心) — the pure placement/derivation model.
 *
 * Owner ruling 2026-11-21 (23:27–00:24; layout spec
 * reports/process-center-layout-v1.html): the machine-started runs that used to
 * fold into the local-chats list are now their OWN panel — a task-manager-shaped
 * surface reached from the left function rail. The local conversation list goes
 * back to being purely human↔bot chats: no process row, no follow-up row, no
 * fold.
 *
 * The placement precedence is NOT re-implemented here: `splitSessionsWithFollowUp`
 * (sessionAutoGrouping.ts) stays the one source of truth for "where does this row
 * belong", and this module only reinterprets its output for the hub —
 *
 *   process set = (followUpSessions ∪ autoSessions) ∩ processes
 *   human set   = everything else               ← what the local list renders
 *
 * so a manual placement keeps working in both directions: 'out' lands a process
 * row back in the human list (that is what 移出进程中心 means) and 'in' picks a
 * human row up into the hub — with no second policy to keep in sync.
 *
 * PURE module (no React / i18n / electron imports) so it is unit-testable with
 * tsx directly, mirroring sessionAutoGrouping.ts.
 */

import type { CoworkSessionAutoOrigin, CoworkSessionSummary } from '../types/cowork';
import {
  isInFollowUpSection,
  shouldFoldIntoAutonomousTasks,
  splitSessionsWithFollowUp,
} from './sessionAutoGrouping';

/** How long a process counts as "running" after its last activity. */
export const PROCESS_RUNNING_WINDOW_MS = 30 * 60 * 1000;

/** The three kinds the 类型签 column names. */
export type ProcessKind = 'build' | 'orchestrate' | 'scheduled';

/** The row's status dot: red = waiting on the owner, green = moved recently, grey = quiet. */
export type ProcessState = 'awaiting' | 'running' | 'idle';

/** The panel's three tabs, in rail order. */
export type ProcessTab = 'awaiting' | 'running' | 'archived';

/** A process row: the session summary plus the two derived verdicts. */
export interface ProcessEntry {
  session: CoworkSessionSummary;
  kind: ProcessKind;
  /** Legacy dot state (kept for the detail header): pending→awaiting, live→running, dead→idle. */
  state: ProcessState;
  /** v2.1 three-state language — the sort key and the row's visual band. */
  statusKind: ProcessStatusKind;
  /** Variant D: an error row reads RED, not grey. */
  error: boolean;
  /** Variant C: overdue pending, downgraded to dead. */
  stalePending: boolean;
  /** Owed an owner verdict right now (the red dot / the 待你拍板 rail badge). */
  awaitingVerdict: boolean;
}

const KIND_BY_ORIGIN: Record<CoworkSessionAutoOrigin, ProcessKind> = {
  longterm: 'build',
  orchestration: 'orchestrate',
  schedule: 'scheduled',
};

/**
 * The 类型签 of a process, derived from the CREATION fact (`autoOrigin`) and
 * never from the title. A human row parked in the hub by hand has no creation
 * fact, so it reads as 施工 — the generic run kind — instead of inventing a
 * fourth tag.
 */
/** kind → i18n key. ONE map: the hub row and the detail header must resolve the
 * same run to the same word (a missing key here rendered the raw key name in the
 * detail header — caught on the live app, not by types). */
/* ─────────────── 状态语言 v2.1 (owner ruling 2026-11-22 00:41) ───────────────
 *
 * Three mutually exclusive states REPLACE the old "moved within 30 min = green"
 * rule — that rule painted 32 rows green on the live DB while only ONE was
 * actually running (30 had just finished, 1 was an error): 97% false green.
 *
 *   pending  等人类：follow_up_state='pending' OR a board decision session
 *   live     真的在跑：status === 'running'
 *   dead     终态（completed / error / stopped / idle）且不在等人类
 *
 * Priority is pending > live > dead, then newest-first inside a band.
 */

export type ProcessStatusKind = 'pending' | 'live' | 'dead';

/** Variant C: a pending row older than this downgrades to dead (keeps an amber
 * mini-dot so the overdue verdict is still visible). Measured: 7 rows had been
 * waiting 28 days. */
export const PROCESS_STALE_PENDING_MS = 7 * 24 * 60 * 60 * 1000;

export const PROCESS_STATUS_RANK: Record<ProcessStatusKind, number> = {
  pending: 0,
  live: 1,
  dead: 2,
};

export interface ProcessStatusInfo {
  kind: ProcessStatusKind;
  /** Variant D: error rows keep the dead band but read red, not grey. */
  error: boolean;
  /** Variant C: was pending, has been waiting too long, downgraded to dead. */
  stalePending: boolean;
}

export const resolveProcessStatus = (
  session: Pick<CoworkSessionSummary, 'status' | 'followUpState' | 'updatedAt' | 'id'>,
  options?: { decisionSessionIds?: ReadonlySet<string>; nowMs?: number },
): ProcessStatusInfo => {
  const nowMs = options?.nowMs ?? Date.now();
  const error = session.status === 'error' || session.status === 'error_retried';
  const awaiting = session.followUpState === 'pending'
    || (options?.decisionSessionIds?.has(session.id) ?? false);
  const age = nowMs - Number(session.updatedAt ?? 0);
  if (awaiting) {
    if (Number.isFinite(age) && age > PROCESS_STALE_PENDING_MS) {
      return { kind: 'dead', error, stalePending: true };
    }
    return { kind: 'pending', error, stalePending: false };
  }
  if (session.status === 'running') return { kind: 'live', error, stalePending: false };
  return { kind: 'dead', error, stalePending: false };
};

/** pending > live > dead, then newest-first inside the same band. */
export const byStatusThenRecency = (a: ProcessEntry, b: ProcessEntry): number => {
  const rank = PROCESS_STATUS_RANK[a.statusKind] - PROCESS_STATUS_RANK[b.statusKind];
  if (rank !== 0) return rank;
  if (b.session.updatedAt !== a.session.updatedAt) return b.session.updatedAt - a.session.updatedAt;
  return b.session.createdAt - a.session.createdAt;
};

export const PROCESS_KIND_LABEL_KEY: Record<ProcessKind, string> = {
  build: 'processKindBuild',
  orchestrate: 'processKindOrchestrate',
  scheduled: 'processKindScheduled',
};

/** zone → i18n key (the family name, used by the return key's title). */
export const PROCESS_ZONE_LABEL_KEY: Record<ProcessZone, string> = {
  orch: 'processZoneOrch',
  scheduled: 'processZoneScheduled',
  longterm: 'processZoneLongterm',
};

/** The 类型签 of a process row — ONE class string, shared by the hub list and
 * the detail header (owner-facing rule: the same run must not change its tag
 * when you open it). Values are the spec's own. */
export const PROCESS_TAG_CLASS = 'flex-shrink-0 rounded border border-claude-border px-1.5 py-0.5 text-[11px] dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary';

/** The status dot colours: red = the owner is the blocker, green = moving,
 * grey = quiet. Same hexes in the list and in the detail header. */
/** v2.1 palette: pending = amber (lit, not breathing), live = green (breathing),
 * dead = grey, error = red (variant D). */
export const PROCESS_STATE_DOT_COLOR = {
  pending: '#e6c93e',
  live: '#22a06b',
  dead: '#c4cad1',
  error: '#e5484d',
} as const satisfies Record<ProcessStatusKind | 'error', string>;

export const processKindOf = (session: Pick<CoworkSessionSummary, 'autoOrigin'>): ProcessKind =>
  (session.autoOrigin ? KIND_BY_ORIGIN[session.autoOrigin] : undefined) ?? 'build';

/**
 * Whether this row is a PROCESS at all — the one membership rule, shared by the
 * hub, the local list (which renders the complement) and the read-only gate in
 * CoworkSessionDetail. A manual 'out' wins over everything (the owner pushed it
 * back into the human list); 'in' or the closed auto-origin set makes it one.
 */
export const isProcessSession = (
  session: Pick<CoworkSessionSummary, 'autoOrigin' | 'foldOverride'>,
): boolean => {
  if (session.foldOverride === 'out') return false;
  if (session.foldOverride === 'in') return true;
  return shouldFoldIntoAutonomousTasks(session);
};

/**
 * The status dot of a LIVE process. The awaiting verdict is decided by the
 * caller (the owner is the blocker, so it must read red even when the bot
 * touched the row a second ago); otherwise recent activity, else quiet.
 */
export const processStateOf = (
  updatedAt: number,
  nowMs: number,
  runningWindowMs: number = PROCESS_RUNNING_WINDOW_MS,
): ProcessState => {
  const age = nowMs - Number(updatedAt ?? 0);
  return Number.isFinite(age) && age >= 0 && age < runningWindowMs ? 'running' : 'idle';
};

/** Newest-first; the hub is a task manager, so an older run never outranks a newer one. */
export const byRecency = (a: CoworkSessionSummary, b: CoworkSessionSummary): number => {
  if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
  return b.createdAt - a.createdAt;
};

const STATE_FOR_DOT: Record<ProcessStatusKind, ProcessState> = {
  pending: 'awaiting',
  live: 'running',
  dead: 'idle',
};

const toEntry = (
  session: CoworkSessionSummary,
  awaitingVerdict: boolean,
  decisionSessionIds?: ReadonlySet<string>,
  nowMs?: number,
): ProcessEntry => {
  const status = resolveProcessStatus(session, { decisionSessionIds, nowMs });
  return {
    session,
    kind: processKindOf(session),
    // Legacy dot state follows the v2.1 band, so the detail header and the row
    // can never disagree about what colour a run is.
    state: STATE_FOR_DOT[status.kind],
    statusKind: status.kind,
    error: status.error,
    stalePending: status.stalePending,
    awaitingVerdict,
  };
};

const sortEntries = (entries: ProcessEntry[]): ProcessEntry[] =>
  entries.sort(byStatusThenRecency);

/* ─────────────── 出口路由（lineage v1, owner ruling 17:30）───────────────
 *
 * A pending run is not automatically the OWNER's business. The hub now sorts
 * every awaited run into one of two buckets:
 *   · 'bot'   — the bot digests it itself (the DEFAULT for everything);
 *   · 'human' — it genuinely needs the owner's verdict (red dot + strip).
 *
 * The choice is an OVERRIDE map, kept in localStorage only (`sessionId →
 * 'human' | 'bot'`). Deliberately not a DB column: this is a view-level routing
 * decision, reversible per row, and it must never migrate on its own.
 */

export type LineageBucket = 'human' | 'bot';

/** localStorage key for the override map — never renamed (deployed state). */
export const LINEAGE_OVERRIDE_STORAGE_KEY = 'idbots.processHub.lineageOverrides';

export type LineageOverrides = Readonly<Record<string, LineageBucket>>;

/** Parse the stored map defensively: anything unreadable degrades to {}. */
export const parseLineageOverrides = (raw: string | null | undefined): Record<string, LineageBucket> => {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, LineageBucket> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id === 'string' && (value === 'human' || value === 'bot')) out[id] = value;
    }
    return out;
  } catch {
    return {};
  }
};

export const serializeLineageOverrides = (overrides: LineageOverrides): string => {
  const clean: Record<string, LineageBucket> = {};
  for (const [id, bucket] of Object.entries(overrides)) {
    if (bucket === 'human' || bucket === 'bot') clean[id] = bucket;
  }
  return JSON.stringify(clean);
};

/** The bucket a session falls in. No override = 'bot' (self-digested). */
export const lineageBucketOf = (
  sessionId: string,
  overrides?: LineageOverrides | null,
): LineageBucket => (overrides?.[sessionId] === 'human' ? 'human' : 'bot');

/** Everything the hub and the local list read out of one session array. */
export interface ProcessHubModel {
  /** 待你拍板: awaited runs that need the OWNER (the strip + the rail badge). */
  awaiting: ProcessEntry[];
  /** bot 自行消化: awaited runs the bot handles itself (the silent bar). */
  botSelfDigested: ProcessEntry[];
  /** 运行中: every other live process (moving, or settled-but-still-here). */
  running: ProcessEntry[];
  /** The complement — what the local conversation list renders now. */
  humanSessions: CoworkSessionSummary[];
}

/**
 * Split one session array into the hub's two live tabs and the human list.
 * ONE pass of `splitSessionsWithFollowUp` feeds both outputs, so the list and
 * the hub can never disagree about where a row belongs.
 */
export const splitProcessHub = (
  sessions: readonly CoworkSessionSummary[],
  decisionSessionIds: ReadonlySet<string> | undefined,
  nowMs: number,
  /** Retired by v2.1 (the 30-minute rule is gone); kept so the existing call
   * sites keep their positional contract while they migrate. */
  _runningWindowMs: number = PROCESS_RUNNING_WINDOW_MS,
  lineageOverrides?: LineageOverrides | null,
): ProcessHubModel => {
  const { followUpSessions, autoSessions } = splitSessionsWithFollowUp(
    sessions,
    decisionSessionIds,
  );
  // `autoSessions` is membership-resolved by construction (manual 'in' or the
  // closed auto-origin policy). The follow-up lane is precedence lane 2 and can
  // hold HUMAN rows (a human session carrying a persisted marker), so its
  // membership is re-checked per row — those rows are not processes.
  const processRows = [
    ...autoSessions,
    ...followUpSessions.filter((session) => isProcessSession(session)),
  ];
  const awaiting: ProcessEntry[] = [];
  const botSelfDigested: ProcessEntry[] = [];
  const running: ProcessEntry[] = [];
  for (const session of processRows) {
    const awaitingVerdict = isInFollowUpSection(
      session,
      decisionSessionIds?.has(session.id) ?? false,
    );
    if (awaitingVerdict) {
      // The bucket decides WHERE it surfaces, not whether it is awaited: a
      // bot-bucket row still carries the awaited state, it just doesn't ask
      // the owner for anything.
      if (lineageBucketOf(session.id, lineageOverrides) === 'human') {
        awaiting.push(toEntry(session, true, decisionSessionIds, nowMs));
      } else {
        botSelfDigested.push(toEntry(session, false, decisionSessionIds, nowMs));
      }
    } else {
      running.push(toEntry(session, false, decisionSessionIds, nowMs));
    }
  }
  // The human list is the COMPLEMENT of the process set, not the split's
  // humanSessions: since the Follow-Up section retired from the list, a human
  // session that still carries a pending marker has no section to go to up
  // there — dropping it would make a conversation disappear from the UI. The
  // hub is the only place a verdict is SURFACED; the row itself stays a chat.
  const processIds = new Set(processRows.map((session) => session.id));
  const humanSessions = sessions.filter((session) => !processIds.has(session.id));
  return {
    awaiting: sortEntries(awaiting),
    botSelfDigested: sortEntries(botSelfDigested),
    running: sortEntries(running),
    humanSessions,
  };
};

/** The rail badge + the 待你拍板 tab label: how many processes want the owner. */
export const countAwaitingProcesses = (model: Pick<ProcessHubModel, 'awaiting'>): number =>
  model.awaiting.length;

/** The silent bar's count: everything the bot is digesting on its own. */
export const countBotSelfDigested = (model: Pick<ProcessHubModel, 'botSelfDigested'>): number =>
  model.botSelfDigested.length;

/**
 * Archived processes (已归档 tab). The live session list query never returns
 * archived rows (`WHERE archived_at IS NULL`), so the panel asks the archived
 * reader (cowork:session:listArchived) and filters to processes here — the
 * membership/kind verdicts are the same, the dot is always grey: an archived run
 * is a closed receipt, never a decision and never "running".
 */
export const buildArchivedProcessEntries = (
  archivedSessions: readonly CoworkSessionSummary[],
): ProcessEntry[] =>
  sortEntries(
    archivedSessions
      .filter((session) => isProcessSession(session))
      .map((session) => toEntry(session, false)),
  );

/* ───────────────────────── v2: the process TREE ─────────────────────────
 *
 * Owner ruling 2026-11-21 16:37 (v2 返工): a flat list of 2k+ runs is not a
 * task manager. The hub now shows a TREE — a task (调度任务 / 编排任务 / 长期
 * 任务) is the parent, its runs are the children — inside three zones.
 *
 * Measured on this machine's live DB (2026-11-21 16:4x): 2,255 live process
 * sessions collapse to 1,425 top-level nodes (36.8% fewer) with the exact-title
 * key below. 1,239 of them are one-shot runs that CANNOT be grouped without
 * inventing a parent, and the order explicitly forbids that, so they stay as
 * top-level leaves — the honest number is reported, not rounded up.
 *
 * Grouping is best-effort and purely derived from what the row already carries:
 *   · the `[定时]` / `[编排任务]` / `[督办]` / `[长期]` title prefix is stripped;
 *   · a long-term sub-project ` · #N …` suffix is trimmed to its parent task;
 *   · nothing else is normalised — no colon-splitting, no year-stripping.
 * A colon split was measured too (38.7%, +1.9 pp) and REJECTED: the extra 1.9
 * points are not worth silently merging genuinely different runs.
 *
 * `parentSessionId` is NOT used as a key: the live DB has exactly ONE row with
 * it set (out of 2,766), so a parentSessionId-based tree would be empty in
 * practice. It is still consulted first, so a real fork parent wins when it
 * exists.
 */

/** The three v2 zones, in rail order. */
export type ProcessZone = 'orch' | 'scheduled' | 'longterm';

/**
 * Which zone a row belongs to. Derived from the CREATION fact, never the title:
 * `[督办]` rows are orchestrations and land in the orchestration tree, and a
 * hand-parked human row (no origin) is a generic run, so it joins that zone too.
 */
export const processZoneOf = (
  session: Pick<CoworkSessionSummary, 'autoOrigin'>,
): ProcessZone => {
  switch (session.autoOrigin) {
    case 'schedule':
      return 'scheduled';
    case 'longterm':
      return 'longterm';
    default:
      return 'orch';
  }
};

/** `[定时] Foo · #2 Bar` → `Foo`; nothing matches → the title, trimmed. */
export const processTreeKeyOf = (title: string): string => {
  let stripped = String(title ?? '').trim();
  stripped = stripped.replace(/^\[(定时|编排任务|督办|长期)\]\s*/, '');
  const subProject = stripped.indexOf(' · #');
  if (subProject > 0) stripped = stripped.slice(0, subProject);
  return stripped.trim();
};

/** One node of the tree: a real task group, or a single run standing alone. */
export interface ProcessTreeNode {
  /** Stable key — the normalised title, so a collapse survives re-sorting. */
  key: string;
  /** What the parent row reads. */
  title: string;
  kind: ProcessKind;
  /** Newest activity inside the node (sorts the tree newest-first). */
  latestAt: number;
  /** Every run of this task, newest first. A leaf node holds exactly one. */
  children: ProcessEntry[];
  /** True only when the node really groups ≥ 2 runs (drives the fold). */
  grouped: boolean;
  /** True for the 「未归类进程」 bucket (no task to hang from). */
  unassigned?: boolean;
  /** The orchestrator avatar/name of the newest run (parent row's identity). */
  orchestratorName: string | null;
  orchestratorAvatar: string | null;
}

const NEWEST_FIRST = (a: ProcessEntry, b: ProcessEntry): number => {
  if (b.session.updatedAt !== a.session.updatedAt) return b.session.updatedAt - a.session.updatedAt;
  return b.session.createdAt - a.session.createdAt;
};

/**
 * Build the tree for ONE zone. Rows whose title groups with nothing stay
 * top-level leaves — the parent row is never fabricated (owner order).
 */
/** Sentinel key for runs with no task to hang from (owner ruling 23:41): they
 * form ONE group — 「未归类进程」 — instead of surfacing as anonymous leaves that
 * look like tasks of their own. */
export const PROCESS_UNASSIGNED_KEY = '__process_unassigned__';

export const buildProcessTree = (entries: readonly ProcessEntry[]): ProcessTreeNode[] => {
  const groups = new Map<string, ProcessEntry[]>();
  for (const entry of entries) {
    const key = processTreeKeyOf(entry.session.title) || PROCESS_UNASSIGNED_KEY;
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  const nodes: ProcessTreeNode[] = [];
  for (const [key, bucket] of groups) {
    bucket.sort(NEWEST_FIRST);
    const newest = bucket[0];
    nodes.push({
      key,
      // The panel localises this one key; every other title is data.
      title: key === PROCESS_UNASSIGNED_KEY ? '' : key,
      unassigned: key === PROCESS_UNASSIGNED_KEY,
      kind: newest.kind,
      latestAt: newest.session.updatedAt,
      children: bucket,
      grouped: bucket.length > 1,
      orchestratorName: newest.session.metabotName?.trim() || null,
      orchestratorAvatar: newest.session.metabotAvatar ?? null,
    });
  }
  // Grouped tasks sort BEFORE one-shot leaves, then newest-first inside each
  // band. Pure recency was measured to be wrong here: the orchestration zone's
  // newest 80 nodes were ALL one-shot runs, so the first screen showed a flat
  // list and not a single foldable task — the tree was invisible until the
  // owner clicked "show more" several times. A task manager lists TASKS first;
  // the runs that belong to nothing follow.
  return nodes.sort((a, b) => {
    if (a.grouped !== b.grouped) return a.grouped ? -1 : 1;
    return b.latestAt - a.latestAt;
  });
};

/** Everything one zone renders: its tree, in task-number terms. */
export interface ProcessZoneModel {
  zone: ProcessZone;
  nodes: ProcessTreeNode[];
  /** Runs represented in the zone (the leaf count, not the node count). */
  runCount: number;
}

/** The three zones, newest-first, each with its own tree. */
export const buildProcessZones = (
  entries: readonly ProcessEntry[],
): Record<ProcessZone, ProcessZoneModel> => {
  const buckets: Record<ProcessZone, ProcessEntry[]> = { orch: [], scheduled: [], longterm: [] };
  for (const entry of entries) buckets[processZoneOf(entry.session)].push(entry);
  return {
    orch: { zone: 'orch', nodes: buildProcessTree(buckets.orch), runCount: buckets.orch.length },
    scheduled: {
      zone: 'scheduled',
      nodes: buildProcessTree(buckets.scheduled),
      runCount: buckets.scheduled.length,
    },
    longterm: {
      zone: 'longterm',
      nodes: buildProcessTree(buckets.longterm),
      runCount: buckets.longterm.length,
    },
  };
};

/* ───────────── v3: hub view state + Twin steering prompt ─────────────
 *
 * Owner order 2026-11-21 17:45 (two interaction cuts):
 *  ① opening a process and coming BACK must land on the zone/scroll you left,
 *    not the default page — hence a view-state object the panel reads on mount
 *    and writes on every change;
 *  ② the read-only bar's 对 Twin 说 must hand the Twin a CONTEXT prompt, not an
 *    empty composer (mirroring 长期任务 → 继续讨论, which builds its draft from
 *    placeholders and rides the `cowork:newChatWithDraft` channel).
 *
 * Both live here as pure, testable pieces; the components only supply data.
 */

/** Where the hub was when the owner stepped into a process. */
export interface ProcessHubViewState {
  zone: ProcessZone;
  archivedMode: boolean;
  /** Scroll offset of the tree viewport, in px. */
  scrollTop: number;
  /**
   * Task keys whose fold was open. Without this the remounted list is SHORTER
   * than the one the owner left, so restoring `scrollTop` clamps to the new
   * max — measured on the live app: saved 2555 came back as 2484 (-71px), i.e.
   * exactly the height of the fold that was no longer expanded.
   */
  expandedTaskKeys: string[];
}

export const DEFAULT_PROCESS_HUB_VIEW_STATE: ProcessHubViewState = {
  zone: 'orch',
  archivedMode: false,
  scrollTop: 0,
  expandedTaskKeys: [],
};

/** Shown in the prompt where a field could not be read (never silently blank). */
export const PROCESS_PROMPT_PLACEHOLDER = '（未取到）';

interface SourceTaskCardLike {
  title?: string | null;
  originSessionId?: string | null;
  decisionSessionIds?: string[] | null;
}

/**
 * The source task's title for the steering prompt.
 * Precedence: a REAL task card bound to this session (origin or pending-verdict
 * link) → the `[定时]/[编排任务]/[督办]/[长期]` prefix, trimmed of a `· #N`
 * sub-project suffix → null (the caller renders the placeholder).
 *
 * Deliberately NOT reading `task_session_links`: that table is main-process
 * only, and adding an IPC just for a prompt line would widen the surface far
 * beyond this order. The board cards already carry the real title.
 */
export const resolveSourceTaskTitle = (
  session: Pick<CoworkSessionSummary, 'id' | 'title'>,
  cards?: readonly SourceTaskCardLike[] | null,
): string | null => {
  for (const card of cards ?? []) {
    const linked = card.originSessionId === session.id
      || (card.decisionSessionIds ?? []).includes(session.id);
    const title = (card.title ?? '').trim();
    if (linked && title) return title;
  }
  const fromPrefix = processTreeKeyOf(session.title);
  return fromPrefix || null;
};

export interface TwinSteeringPromptParts {
  task: string | null;
  process: string | null;
  state: string | null;
  progress: string | null;
  action: string | null;
}

/**
 * Fill the steering-prompt template. Every `{slot}` that the caller could not
 * resolve becomes the explicit placeholder, so the owner sees the gap instead
 * of an empty phrase.
 */
export const buildTwinSteeringPrompt = (
  template: string,
  parts: TwinSteeringPromptParts,
  placeholder: string = PROCESS_PROMPT_PLACEHOLDER,
): string => {
  const fill = (value: string | null | undefined): string => {
    const trimmed = (value ?? '').trim();
    return trimmed || placeholder;
  };
  return template
    .replace('{task}', fill(parts.task))
    .replace('{process}', fill(parts.process))
    .replace('{state}', fill(parts.state))
    .replace('{progress}', fill(parts.progress))
    .replace('{action}', fill(parts.action));
};

/**
 * The "latest progress" line: the last assistant message, flattened and cut to
 * a readable length. Empty when the transcript has no bot report yet.
 */
export const lastAssistantDigest = (
  messages: ReadonlyArray<{ type?: string | null; content?: string | null }> | null | undefined,
  maxChars = 120,
): string | null => {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages?.[index];
    if (message?.type !== 'assistant') continue;
    const flat = String(message.content ?? '').replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
  }
  return null;
};
