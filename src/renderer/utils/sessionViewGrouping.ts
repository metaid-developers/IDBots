/**
 * Grouping and ordering for the bot-home sidebar session list's "filter & sort"
 * modes. Pure functions only (no React / i18n / electron imports) so they can
 * be unit-tested with tsx directly.
 *
 * Two view modes, both for the local-chats list:
 *  - timeline: buckets sessions by last-activity (or creation) date into
 *    Today / Yesterday / This Week (2-7 days) / Last Week (8-14 days) /
 *    This Month / calendar-month groups. Time buckets are static headers.
 *  - bot: one group per local bot, whatever the working directory — every
 *    enabled bot from the live metabot list gets a group even with zero
 *    conversations. Groups are ordered Twin first, then by bot creation time
 *    ascending (the oldest bot sits on top), and are collapsible in the UI.
 *
 * Sorting within every bucket (and the pinned section) follows the chosen sort
 * mode: updatedAt (default) or createdAt. Pinned sessions are always pulled
 * into a leading section, mirroring the historic flat-list behavior.
 */

import type { CoworkSessionSummary } from '../types/cowork';

export type SessionViewMode = 'timeline' | 'bot';
export type SessionSortMode = 'updatedAt' | 'createdAt';

/** The timeline bucket a session lands in; month buckets carry a `YYYY-MM` key. */
export interface SessionTimelineGroup {
  key: string;
  /** i18n key for the fixed buckets; null for calendar-month buckets. */
  labelKey: string | null;
  /** Preformatted label for calendar-month buckets (e.g. "Jul 2026" / "2026年7月"). */
  monthLabel?: string;
  sessions: CoworkSessionSummary[];
}

export interface GroupedSessions<TGroup> {
  /** Pinned sessions first, ordered by the active sort mode. */
  pinned: CoworkSessionSummary[];
  groups: TGroup[];
}

export const DEFAULT_SESSION_VIEW_MODE: SessionViewMode = 'bot';
export const DEFAULT_SESSION_SORT_MODE: SessionSortMode = 'updatedAt';

/** Latest-first ordering for one sort mode; timestamps tie-break each other,
 * then id, so the order is deterministic across renders. */
export const compareSessionsBySortMode = (
  a: CoworkSessionSummary,
  b: CoworkSessionSummary,
  sortMode: SessionSortMode,
): number => {
  const primary = sortMode === 'createdAt' ? a.createdAt - b.createdAt : a.updatedAt - b.updatedAt;
  if (primary !== 0) return -primary;
  const secondary = sortMode === 'createdAt' ? a.updatedAt - b.updatedAt : a.createdAt - b.createdAt;
  if (secondary !== 0) return -secondary;
  return b.id.localeCompare(a.id);
};

export const sortSessionsByMode = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
): CoworkSessionSummary[] => [...sessions].sort((a, b) => compareSessionsBySortMode(a, b, sortMode));

const splitPinned = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
): { pinned: CoworkSessionSummary[]; rest: CoworkSessionSummary[] } => {
  const pinned: CoworkSessionSummary[] = [];
  const rest: CoworkSessionSummary[] = [];
  for (const session of sessions) {
    (session.pinned ? pinned : rest).push(session);
  }
  return { pinned: sortSessionsByMode(pinned, sortMode), rest };
};

const startOfDayLocal = (t: number): number => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** Start of the local day `days` days before `t`; uses calendar-date math so
 * DST transitions cannot shift the boundary by an hour. */
const daysAgoStartLocal = (t: number, days: number): number => {
  const d = new Date(t);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Month-name formatter for the English calendar-month buckets. Built once at
 * module scope: constructing an Intl.DateTimeFormat is orders of magnitude more
 * expensive than formatting with it, and the timeline regroups the whole list
 * (900+ sessions, one format call per month bucket) on every list refresh.
 */
const enMonthFormatter = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });

/** "Jul 2026" (en) / "2026年7月" (zh) label for a calendar-month bucket. */
export const formatMonthLabel = (year: number, month: number, language: string): string => {
  if (language === 'zh') return `${year}年${month}月`;
  const monthName = enMonthFormatter.format(new Date(Date.UTC(2000, month - 1, 15)));
  return `${monthName} ${year}`;
};

/**
 * Bucket sessions into the timeline groups, in display order: Today,
 * Yesterday, This Week (2-7 days back), Last Week (8-14 days back), This
 * Month (same calendar month, older), then one group per older month, newest
 * month first. The bucket timestamp follows the active sort mode so a session
 * lands in the group matching the position it sorts to.
 */
export const groupSessionsByTimeline = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
  now: number = Date.now(),
  language: string = 'en',
): GroupedSessions<SessionTimelineGroup> => {
  const { pinned, rest } = splitPinned(sessions, sortMode);
  const todayStart = startOfDayLocal(now);
  const yesterdayStart = daysAgoStartLocal(now, 1);
  const weekStart = daysAgoStartLocal(now, 7);
  const twoWeeksStart = daysAgoStartLocal(now, 14);
  const nowDate = new Date(now);

  const byKey = new Map<string, SessionTimelineGroup>();
  const ensureGroup = (key: string, labelKey: string | null, monthLabel?: string): SessionTimelineGroup => {
    let group = byKey.get(key);
    if (!group) {
      group = { key, labelKey, monthLabel, sessions: [] };
      byKey.set(key, group);
    }
    return group;
  };

  for (const session of rest) {
    const t = sortMode === 'createdAt' ? session.createdAt : session.updatedAt;
    if (t >= todayStart) {
      ensureGroup('today', 'timelineToday').sessions.push(session);
      continue;
    }
    if (t >= yesterdayStart) {
      ensureGroup('yesterday', 'timelineYesterday').sessions.push(session);
      continue;
    }
    if (t >= weekStart) {
      ensureGroup('thisWeek', 'timelineThisWeek').sessions.push(session);
      continue;
    }
    if (t >= twoWeeksStart) {
      ensureGroup('lastWeek', 'timelineLastWeek').sessions.push(session);
      continue;
    }
    const date = new Date(t);
    if (date.getFullYear() === nowDate.getFullYear() && date.getMonth() === nowDate.getMonth()) {
      ensureGroup('thisMonth', 'timelineThisMonth').sessions.push(session);
      continue;
    }
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const monthKey = `month:${year}-${String(month).padStart(2, '0')}`;
    ensureGroup(monthKey, null, formatMonthLabel(year, month, language)).sessions.push(session);
  }

  const fixedOrder = ['today', 'yesterday', 'thisWeek', 'lastWeek', 'thisMonth'];
  const fixedGroups = fixedOrder
    .map((key) => byKey.get(key))
    .filter((group): group is SessionTimelineGroup => Boolean(group));
  const monthGroups = [...byKey.values()]
    .filter((group) => group.key.startsWith('month:'))
    .sort((a, b) => b.key.localeCompare(a.key));

  const groups = [...fixedGroups, ...monthGroups];
  for (const group of groups) {
    group.sessions = sortSessionsByMode(group.sessions, sortMode);
  }
  return { pinned, groups };
};

/** A live bot the by-Bot view builds its groups from (the enabled metabot
 * list: identity, twin flag for the fixed first slot, and creation time for
 * the group order). */
export interface BotViewBot {
  id: number;
  name: string | null;
  avatar: string | null;
  isTwin: boolean;
  createdAt: number;
  role?: string;
}

export interface SessionBotListGroup {
  key: string;
  kind: 'bot' | 'other';
  /** Bot identity (drives the avatar + name header). */
  bot?: { id: number; name: string | null; avatar: string | null; role?: string };
  sessions: CoworkSessionSummary[];
}

/** Order for the seeded bot groups: Twin first, then creation time ascending
 * (the earliest-created bot sits on top), id as the deterministic tie-break. */
const compareBotViewBots = (a: BotViewBot, b: BotViewBot): number => {
  if (a.isTwin !== b.isTwin) return a.isTwin ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id - b.id;
};

/**
 * Group sessions by bot — one group per bot, independent of any working
 * directory. This is the ONE grouping implementation both session faces use
 * (本地对话 and 线上对话): the caller only chooses the data source and whether
 * empty bots get a group.
 *
 * `includeEmptyBots` (default true) mirrors the local list's roster reading:
 * every bot in `bots` gets a group even with zero sessions, and the roster's
 * empty groups render their own "no conversations yet" line (20 bots → 20
 * groups). The online face turns it off: an A2A list seeded with one empty
 * group per local bot would be 20 rows of noise, so there a group exists only
 * when the bot actually has a conversation.
 *
 * Sessions whose bot is not in the live list (legacy rows without a
 * metabotId, or the bot was deleted/disabled since) fall into one trailing
 * "other" group so no conversation silently disappears from the view. When
 * `bots` is empty (the live list is still loading, or its IPC failed) the
 * groups are derived straight from the sessions — per bot id, identity from
 * the freshest row snapshot, most recently active bot first — so the list
 * still groups by bot instead of dumping everything into "other".
 */
export const groupSessionsByBot = (
  sessions: CoworkSessionSummary[],
  sortMode: SessionSortMode,
  bots: readonly BotViewBot[],
  options: { includeEmptyBots?: boolean } = {},
): GroupedSessions<SessionBotListGroup> => {
  const includeEmptyBots = options.includeEmptyBots !== false;
  const { pinned, rest } = splitPinned(sessions, sortMode);

  // The trailing bucket for rows no live bot claims. Created lazily so the
  // header never renders for an empty roster edge case.
  let other: SessionBotListGroup | null = null;
  const pushToOther = (session: CoworkSessionSummary): void => {
    if (!other) other = { key: 'other', kind: 'other', sessions: [] };
    other.sessions.push(session);
  };

  const groups: SessionBotListGroup[] = [];

  if (bots.length > 0) {
    const byId = new Map<number, SessionBotListGroup>();
    const botsWithSessions = includeEmptyBots
      ? null
      : new Set(rest.map((session) => session.metabotId).filter((id): id is number => id != null));
    for (const bot of [...bots].sort(compareBotViewBots)) {
      if (botsWithSessions && !botsWithSessions.has(bot.id)) continue;
      const group: SessionBotListGroup = {
        key: `bot:${bot.id}`,
        kind: 'bot',
        bot: { id: bot.id, name: bot.name, avatar: bot.avatar, role: bot.role },
        sessions: [],
      };
      byId.set(bot.id, group);
      groups.push(group);
    }
    for (const session of rest) {
      const group = session.metabotId != null ? byId.get(session.metabotId) : undefined;
      if (group) group.sessions.push(session);
      else pushToOther(session);
    }
  } else {
    // Degraded roster: derive one group per bot id from the sessions
    // themselves. The freshest row that carries a name/avatar snapshot wins
    // the header identity (same freshness rule the retired project view used).
    interface DerivedBotEntry {
      group: SessionBotListGroup;
      latestActivityAt: number;
      snapshotUpdatedAt: number;
    }
    const derived = new Map<number, DerivedBotEntry>();
    for (const session of rest) {
      if (session.metabotId == null) {
        pushToOther(session);
        continue;
      }
      let entry = derived.get(session.metabotId);
      if (!entry) {
        const group: SessionBotListGroup = {
          key: `bot:${session.metabotId}`,
          kind: 'bot',
          bot: { id: session.metabotId, name: null, avatar: null },
          sessions: [],
        };
        entry = { group, latestActivityAt: Number.MIN_SAFE_INTEGER, snapshotUpdatedAt: -1 };
        derived.set(session.metabotId, entry);
      }
      entry.group.sessions.push(session);
      entry.latestActivityAt = Math.max(entry.latestActivityAt, session.updatedAt);
      const hasIdentity = Boolean(session.metabotName || session.metabotAvatar);
      if (hasIdentity && session.updatedAt >= entry.snapshotUpdatedAt) {
        entry.group.bot = {
          id: session.metabotId,
          name: session.metabotName ?? entry.group.bot?.name ?? null,
          avatar: session.metabotAvatar ?? entry.group.bot?.avatar ?? null,
        };
        entry.snapshotUpdatedAt = session.updatedAt;
      }
    }
    // Most recently active bot first: with no roster there is no creation
    // time to order by, so activity recency is the closest stable stand-in.
    groups.push(
      ...[...derived.values()]
        .sort((a, b) => {
          if (a.latestActivityAt !== b.latestActivityAt) return b.latestActivityAt - a.latestActivityAt;
          return (a.group.bot?.id ?? 0) - (b.group.bot?.id ?? 0);
        })
        .map((entry) => entry.group),
    );
  }

  if (other && other.sessions.length > 0) groups.push(other);
  for (const group of groups) {
    group.sessions = sortSessionsByMode(group.sessions, sortMode);
  }
  return { pinned, groups };
};

/**
 * Per-bot conversation counts for the online-chats Bot selector's option rows
 * (restored 2026-11-13 with the dropdown the owner asked back). Every bot id
 * in `botIds` is pre-seeded at 0 so each option row shows a count, and 'all'
 * carries the list's total (legacy rows without a metabotId have no bot entry
 * but still count toward it — they only render under 全部 Bot).
 */
export type BotSessionCounts = Partial<Record<number | 'all', number>>;

export const buildBotSessionCounts = (
  sessions: CoworkSessionSummary[],
  botIds: readonly number[],
): BotSessionCounts => {
  const counts: Record<number, number> = {};
  for (const id of botIds) {
    counts[id] = 0;
  }
  let total = 0;
  for (const session of sessions) {
    if (session.metabotId != null) {
      counts[session.metabotId] = (counts[session.metabotId] ?? 0) + 1;
    }
    total += 1;
  }
  return { ...counts, all: total };
};

/**
 * Per-bot unread counts for the selector's option unread indicators (yellow
 * dots), same seeding rule as the conversation counts; 'all' carries the
 * list's total unread count.
 */
export type BotUnreadCounts = Partial<Record<number | 'all', number>>;

export const buildBotUnreadCounts = (
  sessions: CoworkSessionSummary[],
  botIds: readonly number[],
  unreadSessionIds: ReadonlySet<string>,
): BotUnreadCounts => {
  const unreads: Record<number, number> = {};
  for (const id of botIds) {
    unreads[id] = 0;
  }
  let total = 0;
  for (const session of sessions) {
    if (unreadSessionIds.has(session.id)) {
      if (session.metabotId != null) {
        unreads[session.metabotId] = (unreads[session.metabotId] ?? 0) + 1;
      }
      total += 1;
    }
  }
  return { ...unreads, all: total };
};
