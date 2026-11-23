import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { ChatBubbleLeftRightIcon } from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem, { SessionAvatarCircle } from './CoworkSessionItem';
import MetaBotSelector, {
  ALL_METABOTS_SELECTOR_ID,
  type MetaBotForSelector,
} from './MetaBotSelector';
import { i18nService } from '../../services/i18n';
import { useStableCallback } from '../../utils/useStableCallback';
import { useChatExperienceMode } from '../../hooks/useChatExperienceMode';
import { isAssistantModeOwnerChatSession } from './assistantModeSessionGate';
import { useProgressiveRowReveal } from './sessionListRevealBudget';
import {
  buildBotSessionCounts,
  buildBotUnreadCounts,
  groupSessionsByBot,
  groupSessionsByTimeline,
  type BotViewBot,
  type SessionSortMode,
  type SessionViewMode,
} from '../../utils/sessionViewGrouping';
import {
  loadCollapsedSessionGroups,
  saveCollapsedSessionGroups,
  type SessionGroupFace,
} from '../../utils/sessionGroupStorage';
import type { SessionSidebarSection } from '../../utils/sessionAutoGrouping';
import { ChevronDownIcon, FolderIcon, PlusIcon } from '@heroicons/react/24/outline';
import { a2aApprovalOf } from './permissionPromptLayout';

interface CoworkSessionListProps {
  sessions: CoworkSessionSummary[];
  currentSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePin: (sessionId: string, pinned: boolean) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  /** Empty-state message; defaults to the generic "no tasks" text. */
  emptyText?: string;
  /** Batch-selection mode (batch archive): rows render a checkbox and clicking
   * a row toggles its selection instead of opening the session. */
  selectionMode?: boolean;
  selectedSessionIds?: string[];
  onToggleSessionSelected?: (sessionId: string) => void;
  /** Grouping mode for the sidebar's local-chats list. Undefined keeps the
   * historic flat list (search modal, A2A tab). */
  viewMode?: SessionViewMode;
  /** Ordering within the flat list and inside every group. */
  sortMode?: SessionSortMode;
  /**
   * Online-chats (A2A) Bot selector — restored 2026-11-13 (owner request,
   * superseding the 2026-11-09 removal ruling). When on, the list reuses the
   * shared MetaBotSelector (the same component the composers use) above the
   * rows, with `allowAll` adding the leading 全部 Bot entry — the default, so
   * the face opens unfiltered and the dropdown is a deliberate narrowing. The
   * bots come from the live metabot list (enabled bots, Twin first), so a
   * deleted bot never reappears as an option; each option row carries the
   * bot's conversation count, and a lone local bot gets no control (a single
   * option would only repeat the list). Every other caller leaves it off, so
   * their output is unchanged.
   */
  botSelector?: boolean;
  /**
   * Sessions owed an owner verdict right now (long-term sub-projects parked in
   * waiting_owner, board-derived). The verdict itself now renders in the PROCESS
   * HUB, not here (owner ruling 2026-11-21: this list is human↔bot chats only),
   * so the flag no longer has a section to place a row in — the row menu's
   * "current section" resolver is what still reads it, keeping the move-out
   * override honest for a decision-owed row.
   */
  decisionSessionIds?: ReadonlySet<string>;
  /**
   * Move one session to one of the three placement lanes the row menu's
   * "Move to…" submenu names: the process hub, the hub's awaiting layer, or the
   * normal list. Optional: callers that do not offer the move (and every
   * non-local list) simply leave it off, and the row then hides the menu entry.
   * The row disables the lane it already sits in, so the caller never receives
   * a same-lane move.
   */
  onMoveSessionToSection?: (sessionId: string, target: SessionSidebarSection) => void;
  /**
   * i18n generation marker. The rows and the group headers read their copy from
   * i18nService at render time, so a memoized list needs the language among its
   * props — without it, switching language would leave every label in this list
   * in the previous language until the session data happened to change. Callers
   * pass i18nService.getLanguage() (they re-render on a language switch through
   * App's i18n subscription).
   */
  language?: string;
  /**
   * Quick-create new task with selected bot. When passed, bot group headers in
   * "by bot" view show a plus button on hover that creates a new task with that
   * bot pre-selected.
   */
  onQuickCreateTask?: (botId: number) => void;
  /**
   * Which session face owns this instance (Bot Home records: 'local' or the
   * online 'a2a' list). The grouped view is the SAME template on both faces —
   * one collapsible group per bot, header = avatar + name, trailing + to start
   * a new task with that bot — but the two memories must never be shared:
   * collapsing a bot group on one face must not collapse it on the other.
   * The face therefore keys both the persisted collapsed-group set and the
   * empty-bot policy (the online list never seeds a group for a bot with no
   * conversation). Callers that render flat (search modal) omit it.
   */
  groupFace?: SessionGroupFace;
  /**
   * Badge browser-type rows with the Studio source label (owner ruling
   * 2026-11-12; copy renamed 浏览器→Studio same day). Defaults ON: both
   * sidebars' lists (and the search modal) show it wherever a browser row
   * renders. The Studio panel history renders CoworkSessionItem directly
   * without the flag and stays badge-free (its own 2026-11-11 17:28 ruling).
   */
  showBrowserBadge?: boolean;
}

const groupHeaderLabelClass =
  'text-[11px] font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary';

/**
 * Cadence of the shared clock the rows stamp their relative time with. One
 * minute matches the "5m" granularity of the label: a row that is memoized no
 * longer recomputes anything on its own, so the list is what turns "5m" into
 * "6m" (and the group-memo timestamp into the current minute).
 */
const RELATIVE_TIME_TICK_MS = 60_000;

/**
 * Stand-in for an omitted `onToggleSessionSelected` (a caller that never enters
 * batch-selection mode leaves it out), so the rows always receive a callable.
 */
const noopToggleSelected = (): void => {};

/** Placeholder for the optional section move; hidden behind the menu entry's own guard. */
const noopMoveToSection = (): void => {};

/**
 * Shallow equality, one level deep: `Object.is` per key, and for nested objects
 * a key-wise comparison of their own fields (session summaries carry at most
 * `serviceOrderSummary`, which is an object). Deliberately conservative — any
 * field that differs, at any depth, reports unequal, so a changed session is
 * never mistaken for an unchanged one. It only has to be good enough to reuse
 * the previous object when nothing changed.
 */
const sameSummaryValue = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => Object.is(
    (a as Record<string, unknown>)[key],
    (b as Record<string, unknown>)[key],
  ));
};

const sameSessionSummary = (a: CoworkSessionSummary, b: CoworkSessionSummary): boolean =>
  sameSummaryValue(a, b);

/**
 * Hold on to the previous summary object for every session whose fields did not
 * change. `coworkSlice.setSessions` replaces the whole array — and each summary
 * with it — on every list read, so without this the row-level memo would compare
 * unequal on every refresh and nothing would ever bail out. Reusing the object
 * for unchanged rows is what lets a refresh re-render only the rows that moved;
 * changed rows keep their fresh object, so no update can be swallowed.
 *
 * The returned arrays are new whenever the inputs are (the list has to re-derive
 * its sorting and grouping then anyway); only the row objects are stabilized.
 */
const useStableSessionSummaries = (
  sessions: CoworkSessionSummary[],
): [CoworkSessionSummary[]] => {
  const cacheRef = useRef<Map<string, CoworkSessionSummary>>(new Map());
  return useMemo(() => {
    const nextCache = new Map<string, CoworkSessionSummary>();
    const stabilize = (list: CoworkSessionSummary[]): CoworkSessionSummary[] =>
      list.map((session) => {
        const previous = cacheRef.current.get(session.id);
        const kept = previous && sameSessionSummary(previous, session) ? previous : session;
        nextCache.set(session.id, kept);
        return kept;
      });
    const result: [CoworkSessionSummary[]] = [stabilize(sessions)];
    cacheRef.current = nextCache;
    return result;
  }, [sessions]);
};

// The old "Autonomous Tasks" fold and "Follow-Up Tasks" section are RETIRED
// (owner ruling 2026-11-21): both moved into the Process Hub panel
// (components/cowork/ProcessCenterPanel.tsx), and their two persisted
// preferences are no longer read. The localStorage keys stay frozen in
// utils/sessionAutoGrouping.ts — deployed user state is never renamed — they
// simply have no reader left on this list.

const CoworkSessionListRow: React.FC<CoworkSessionListProps> = ({
  sessions: incomingSessions,
  currentSessionId,
  onSelectSession,
  onDeleteSession,
  onTogglePin,
  onRenameSession,
  emptyText,
  selectionMode = false,
  selectedSessionIds,
  onToggleSessionSelected,
  viewMode,
  sortMode = 'updatedAt',
  botSelector = false,
  decisionSessionIds,
  onMoveSessionToSection,
  language: languageProp,
  onQuickCreateTask,
  groupFace = 'local',
  showBrowserBadge = true,
}) => {
  // Same summary objects for the rows whose fields did not change (see the
  // hook); everything below reads these instead of the raw props.
  const [sessions] = useStableSessionSummaries(incomingSessions);
  // One shared clock for the rows' relative-time stamps, ticked once a minute.
  // Rows are memoized, so a row that recomputed Date.now() itself would freeze
  // its label until its data changed; the tick is what keeps "5m" turning into
  // "6m" on its own (and what the group memo stamps with).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  /**
   * The rows are memoized, so the action callbacks they receive must keep one
   * identity: a fresh closure per render (which is what a parent's inline
   * handler gives us) would re-render every mounted row on every list render.
   */
  const selectSession = useStableCallback(onSelectSession);
  const deleteSession = useStableCallback(onDeleteSession);
  const togglePin = useStableCallback(onTogglePin);
  const renameSession = useStableCallback(onRenameSession);
  // Optional, so it needs the same no-op treatment as batch selection: a
  // memoized row must never receive an undefined callback and then have to
  // guard every click itself.
  const moveToSection = useStableCallback(onMoveSessionToSection ?? noopMoveToSection);
  // Batch selection is the one optional action (the search modal never enters
  // selection mode). A no-op keeps the memoized prop a function, so the row's
  // guard cannot silently let an undefined callback through to a click.
  const toggleSessionSelected = useStableCallback(onToggleSessionSelected ?? noopToggleSelected);
  // How many rows may mount right now (see useProgressiveRowReveal), and the
  // cursor renderItem consumes it with.
  const rootRef = useRef<HTMLDivElement>(null);
  const revealedRows = useProgressiveRowReveal(rootRef);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const approvalSessionIdSet = useMemo(() => new Set(
    pendingPermissions
      .filter((permission) => a2aApprovalOf(permission) !== null)
      .map((permission) => permission.sessionId),
  ), [pendingPermissions]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds ?? []), [selectedSessionIds]);
  // Per-bot group collapse state, remembered PER FACE (owner ruling 2026-11-08:
  // "分组状态每面各自记忆"). The search modal renders flat and never touches it.
  // Read lazily on mount and re-read when the face changes — the same list
  // instance serves both Bot Home faces, so the face is a real input here.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(
    () => loadCollapsedSessionGroups((key) => window.localStorage.getItem(key), groupFace),
  );
  useEffect(() => {
    setCollapsedGroupKeys(loadCollapsedSessionGroups((key) => window.localStorage.getItem(key), groupFace));
  }, [groupFace]);
  const [rosterBots, setRosterBots] = useState<MetaBotForSelector[] | null>(null);
  // null = the live bot roster has not settled yet; the by-Bot groups simply
  // wait for it (an empty roster degrades to session-derived groups).
  // The online face's bot filter remembers an explicit pick; null = no pick
  // (the 全部 Bot default).
  const [pickedBotId, setPickedBotId] = useState<number | null>(null);
  // The caller's language, with a standalone fallback (see the prop's docs).
  const language = languageProp ?? i18nService.getLanguage();

  // The by-Bot view's groups (and the online face's bot filter) read their
  // roster from the same read-only IPC the composers use (enabled bots only,
  // Twin first) — NOT from the sessions, so a deleted or disabled bot can
  // never reappear as a group or filter option. Best effort: any failure
  // leaves the roster empty and the grouping degrades to session-derived
  // groups. Only the by-Bot view and the bot-filter face need it; the
  // timeline/flat views never read it.
  useEffect(() => {
    if (!botSelector && viewMode !== 'bot') return;
    let cancelled = false;
    window.electron?.idbots
      ?.getMetaBots?.()
      .then((result) => {
        if (!cancelled) setRosterBots(result?.success && result.list ? result.list : []);
      })
      .catch(() => {
        if (!cancelled) setRosterBots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [botSelector, viewMode]);

  // Roster shaped for the by-Bot view: Twin flag + creation time for the
  // group order. An IPC row that predates created_at (impossible today, but
  // the field is optional on the roster type) orders as the oldest.
  const viewBots = useMemo<BotViewBot[]>(
    () =>
      (rosterBots ?? []).map((bot) => ({
        id: bot.id,
        name: bot.name,
        avatar: bot.avatar,
        isTwin: bot.metabot_type === 'twin',
        createdAt: bot.created_at ?? 0,
        role: bot.role,
      })),
    [rosterBots],
  );

  // Per-bot conversation counts for the selector's option rows (each live bot
  // pre-seeded at 0, 'all' carrying the total). They exist only for the online
  // list; every other caller computes nothing.
  const sessionCounts = useMemo(
    () => (botSelector ? buildBotSessionCounts(sessions, (rosterBots ?? []).map((bot) => bot.id)) : undefined),
    [botSelector, sessions, rosterBots],
  );
  // Per-bot unread counts for the selector's option unread indicators (yellow
  // dots). Each live bot is pre-seeded at 0, 'all' carrying the total unread
  // count. Only computed for the online list; every other caller gets nothing.
  const unreadCounts = useMemo(
    () => (botSelector ? buildBotUnreadCounts(sessions, (rosterBots ?? []).map((bot) => bot.id), unreadSessionIdSet) : undefined),
    [botSelector, sessions, rosterBots, unreadSessionIdSet],
  );
  // A lone local bot needs no selector (the same "zero noise" rule as the
  // single-group degradation), so the control stays off below two bots.
  // Gated on the botSelector PROP: the by-Bot view also loads the roster, but
  // it must never turn the selector logic on for the local list.
  const showBotSelector = botSelector && (rosterBots?.length ?? 0) > 1;
  // The selector opens on 全部 Bot (owner request 2026-11-13): the face opens
  // unfiltered, and picking a bot is a deliberate narrowing, never a default
  // that hides every other bot's rows behind a control the owner never touched.
  const defaultBotId = ALL_METABOTS_SELECTOR_ID;
  // An explicit pick wins while its bot still exists; otherwise the list falls
  // back to the default, so the filtered state cannot get stuck (e.g. on a bot
  // deleted after the pick). With the selector hidden there is no control to
  // escape a filter, so the list must show everything — legacy A2A rows with
  // no metabotId and sessions of since-deleted/disabled bots included.
  const activeBotId = showBotSelector
    ? (pickedBotId != null
        && (pickedBotId === ALL_METABOTS_SELECTOR_ID || rosterBots?.some((bot) => bot.id === pickedBotId))
      ? pickedBotId
      : defaultBotId)
    : ALL_METABOTS_SELECTOR_ID;
  const visibleSessions = useMemo(
    () =>
      activeBotId === ALL_METABOTS_SELECTOR_ID
        ? sessions
        : sessions.filter((session) => session.metabotId === activeBotId),
    [sessions, activeBotId],
  );

  const sortedSessions = useMemo(() => {
    const sortByRecentActivity = (a: CoworkSessionSummary, b: CoworkSessionSummary) => {
      if (b.updatedAt !== a.updatedAt) {
        return b.updatedAt - a.updatedAt;
      }
      return b.createdAt - a.createdAt;
    };

    const pinnedSessions = visibleSessions
      .filter((session) => session.pinned)
      .sort(sortByRecentActivity);
    const unpinnedSessions = visibleSessions
      .filter((session) => !session.pinned)
      .sort(sortByRecentActivity);
    return [...pinnedSessions, ...unpinnedSessions];
  }, [visibleSessions]);

  // Buckets are day-relative ("Today" / "Yesterday"), so the grouping has to be
  // re-derived as the clock moves on: it now depends on the shared tick, not
  // only on the session list. Without that, a sidebar left open past midnight
  // kept filing the new day's sessions under "Today" until something else
  // changed the list.
  const timelineGrouped = useMemo(
    () => (viewMode === 'timeline'
      ? groupSessionsByTimeline(visibleSessions, sortMode, nowMs, language)
      : null),
    [visibleSessions, viewMode, sortMode, language, nowMs],
  );

  const botGrouped = useMemo(
    () => (viewMode === 'bot'
      ? groupSessionsByBot(visibleSessions, sortMode, viewBots, { includeEmptyBots: groupFace === 'local' })
      : null),
    [visibleSessions, viewMode, sortMode, viewBots, groupFace],
  );

  // The Follow-Up section and the Autonomous fold that used to be derived here
  // are GONE from this list (owner ruling 2026-11-21): both live in the Process
  // Hub panel now, and the local list renders human↔bot chats only. What stayed
  // is the ROW-level verdict the move menu still needs (see decisionSessionIds).

  const toggleGroupCollapsed = (key: string) => {
    const next = new Set(collapsedGroupKeys);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    setCollapsedGroupKeys(next);
    try {
      saveCollapsedSessionGroups((storageKey, value) => window.localStorage.setItem(storageKey, value), groupFace, next);
    } catch {
      // localStorage unavailable; the groups still toggle for this session.
    }
  };

  // Double-click on blank space collapses every expanded bot group at once —
  // the only folders this list still has (the process folds left for the hub).
  // The collapse is explicit, not a toggle, so a stray second double-click
  // cannot re-open anything.
  //
  // Two triggers answer the owner's red-box spot (2026-11-10): the icon
  // rail's blank stretches — a sibling component with no list state, so
  // its ask rides the `idbots:collapse-session-folders` window event —
  // and the list viewport's own blank zones. In the viewport, "blank" is
  // decided by WHERE the double-click LANDED: the guard rejects actual
  // content (interactive elements and text/media nodes — titles, avatars,
  // timestamps), so a row's own empty box, the gaps between sections, and
  // the space under the last row all count. A double-click on any title,
  // avatar, or button keeps its own single-click behavior; the row's click
  // still fires first (two clicks = two selects) — only the folder collapse
  // rides on top.
  const collapseAllFolders = () => {
    if (!botGrouped) return;
    const next = new Set(collapsedGroupKeys);
    botGrouped.groups.forEach((group) => next.add(group.key));
    setCollapsedGroupKeys(next);
    try {
      saveCollapsedSessionGroups((storageKey, value) => window.localStorage.setItem(storageKey, value), groupFace, next);
    } catch {
      // localStorage unavailable; the groups still collapse for this session.
    }
  };

  const handleViewportDoubleClick = (event: MouseEvent) => {
    const target = event.target as HTMLElement | null;
    if (!target || !botGrouped) return;
    if (target.closest('button, a, [role="button"], input, textarea, select, [contenteditable="true"]')) return;
    if (target.closest('img, svg, span, time, p, h1, h2, h3, h4, h5, h6, label')) return;
    collapseAllFolders();
  };

  // The dblclick listener rides on the VIEWPORT — the list's scroll
  // container, this root's parent element — one level above the rows, so
  // every blank zone in the list is in one handler's reach. The rail event
  // rides on window. Both re-attach whenever the collapse inputs change so
  // the handlers never close over a stale set.
  useEffect(() => {
    if (!botGrouped) return;
    const viewport = rootRef.current?.parentElement;
    if (viewport) viewport.addEventListener('dblclick', handleViewportDoubleClick);
    window.addEventListener('idbots:collapse-session-folders', collapseAllFolders as EventListener);
    return () => {
      if (viewport) viewport.removeEventListener('dblclick', handleViewportDoubleClick);
      window.removeEventListener('idbots:collapse-session-folders', collapseAllFolders as EventListener);
    };
  }, [botGrouped, collapsedGroupKeys, groupFace]);

  // The row takes the session id for every action and one shared clock/language,
  // so that two consecutive renders of an unchanged row produce referentially
  // equal props and the memo on CoworkSessionItem bails out.
  //
  // It also spends the render budget: the maps below still walk the whole list,
  // but every row past the budget returns null and never mounts. Sections check
  // the budget before rendering their header (revealBudgetLeft), so an exhausted
  // budget cannot leave a header with no rows under it.
  let remainingRows = revealedRows;
  const revealBudgetLeft = () => remainingRows > 0;
  // One mode subscription for the whole list; each row's assistant-mode
  // verdict is then resolved per session through the shared gate
  // (isAssistantModeOwnerChatSession — mirrors the backend rule in
  // src/main/libs/coworkRunner.ts), so auto-created and non-standard sessions
  // keep the professional title treatment. Rows stay memoized: the passed
  // boolean stays referentially stable while (mode, session) are unchanged.
  const chatExperienceMode = useChatExperienceMode();
  const renderItem = (session: CoworkSessionSummary) => {
    if (remainingRows <= 0) return null;
    remainingRows -= 1;
    return (
      <CoworkSessionItem
        key={session.id}
        session={session}
        hasUnread={unreadSessionIdSet.has(session.id)}
        approvalPending={approvalSessionIdSet.has(session.id)}
        isActive={session.id === currentSessionId}
        selectionMode={selectionMode}
        isSelected={selectedSessionIdSet.has(session.id)}
        nowMs={nowMs}
        language={language}
        assistantMode={isAssistantModeOwnerChatSession(chatExperienceMode, session)}
        showBrowserBadge={showBrowserBadge}
        onSelect={selectSession}
        onDelete={deleteSession}
        onTogglePin={togglePin}
        onRename={renameSession}
        onToggleSelected={toggleSessionSelected}
        onMoveToSection={onMoveSessionToSection ? moveToSection : undefined}
        decisionPending={decisionSessionIds?.has(session.id)}
      />
    );
  };

  const renderPinnedSection = (pinned: CoworkSessionSummary[]) =>
    pinned.length > 0 && revealBudgetLeft() && (
      <section key="pinned">
        <div className={`px-2.5 pb-1 pt-2 ${groupHeaderLabelClass}`}>
          {i18nService.t('coworkPinnedGroup')}
        </div>
        {pinned.map(renderItem)}
      </section>
    );

  // 待跟进任务 + 自主任务 are GONE from this list (owner ruling 2026-11-21).
  // Both sections moved into the Process Hub panel — an independent surface
  // reached from the function rail — so the local conversation list is purely
  // human↔bot chats again: pinned block, bot groups, nothing else. Their
  // membership rule (followUpState / autoOrigin / manual placement) is still
  // shared with the hub through utils/processCenter.ts; only the RENDERING left.

  // The online list's only selector: the SAME MetaBotSelector the composers
  // use (cowork home, Bot Internet panel), so the two surfaces can never drift
  // apart again. allowAll adds the leading 全部 Bot entry (the default), the
  // option rows carry each bot's conversation count on their right, and the
  // dropdown floats fixed so the sidebar's scroll container cannot clip it.
  const botSelectorRow = showBotSelector ? (
    rosterBots ? (
      <div data-testid="bot-selector-row" className="px-2.5 pb-1.5 pt-0.5">
        <MetaBotSelector
          metabots={rosterBots}
          selectedId={activeBotId}
          onSelect={(id) => setPickedBotId(id ?? ALL_METABOTS_SELECTOR_ID)}
          label={i18nService.t('coworkMetaBotLabel')}
          placeholder={i18nService.t('coworkMetaBotPlaceholder')}
          compact
          allowAll
          sessionCounts={sessionCounts}
          unreadCounts={unreadCounts}
          useFixedDropdown
        />
      </div>
    ) : (
      /* Bot list pending: hold the control's row open with an inert
       * placeholder instead of painting a value. The boxes (row padding, 20px
       * avatar, label slot, 12px chevron) mirror the real compact trigger, so
       * settling swaps the content in place — nothing below the row moves, and
       * no value the lookup has not confirmed is ever shown. aria-hidden: a
       * loading shell must not enter the accessibility tree as a fake value;
       * the real control arrives with its own name one tick later. */
      <div
        data-testid="bot-selector-row"
        data-pending="true"
        aria-hidden="true"
        className="px-2.5 pb-1.5 pt-0.5"
      >
        <span className="flex w-full items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-xs">
          <span className="h-5 w-5 flex-shrink-0 animate-pulse rounded-md dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
          <span className="h-3 w-16 flex-shrink-0 animate-pulse rounded-sm dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
          <span className="ml-auto h-3 w-3 flex-shrink-0 animate-pulse rounded-sm dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover" />
        </span>
      </div>
    )
  ) : null;

  // The selector (online face) and the grouped body are ONE list, not two
  // competing selectors: the dropdown narrows WHICH bots are shown (全部 Bot
  // by default), the rows below it organize the shown sessions. The hairline
  // rides with the control and scrolls away with it — it is not sticky, so it
  // never competes with the list for attention.
  const selectorBlock = botSelectorRow ? (
    <>
      {botSelectorRow}
      <div
        data-testid="bot-selector-divider"
        className="mt-0.5 border-t dark:border-claude-darkBorder border-claude-border"
      />
    </>
  ) : null;

  // An empty list is simply empty now: the background runs that used to keep
  // this state from showing live in the Process Hub, not here.
  if (visibleSessions.length === 0) {
    return (
      // Same landing recipe as the Co-Work panel's empty state (aesthetic pass
      // 2026-11-08): one quiet mark over one sentence, centred in the list's
      // own width. Two empty states in one product should read as siblings.
      <div ref={rootRef} className="flex flex-col items-center justify-center gap-2 px-4 py-10 text-center">
        <ChatBubbleLeftRightIcon
          aria-hidden
          className="h-5 w-5 opacity-40 dark:text-claude-darkTextSecondary text-claude-textSecondary"
        />
        <p className="max-w-[16rem] text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  // Timeline view: static time headers (never collapsible), pinned first.
  if (timelineGrouped) {
    return (
      <div ref={rootRef}>
        {selectorBlock}
        {renderPinnedSection(timelineGrouped.pinned)}
        {timelineGrouped.groups.map((group) => {
          if (!revealBudgetLeft()) return null;
          return (
            <section key={group.key}>
              <div className={`px-2.5 pb-1 pt-2.5 ${groupHeaderLabelClass}`}>
                {group.labelKey ? i18nService.t(group.labelKey) : group.monthLabel}
              </div>
              {group.sessions.map(renderItem)}
            </section>
          );
        })}
      </div>
    );
  }

  // By-Bot view — the SAME template on both Bot Home faces (owner ruling
  // 2026-11-08): one collapsible group per bot, Twin first then oldest-created
  // first, pinned leading. The group header matches the session-row height
  // (same px-2.5 py-1.5 box + h-6 avatar) so the roster reads as rows of its
  // own, not as thin captions, and the trailing + starts a new task with that
  // bot. The local face includes empty bots (the roster is the reading); the
  // online face only groups bots that actually have a conversation.
  if (botGrouped) {
    return (
      <div ref={rootRef}>
        {selectorBlock}
        {renderPinnedSection(botGrouped.pinned)}
        {botGrouped.groups.map((group) => {
          if (!revealBudgetLeft()) return null;
          const collapsed = collapsedGroupKeys.has(group.key);
          let headerLabel: React.ReactNode;
          let roleTooltip: string | undefined;
          if (group.kind === 'bot' && group.bot) {
            headerLabel = (
              <>
                <SessionAvatarCircle
                  src={group.bot.avatar}
                  name={group.bot.name}
                  sizeClass="h-6 w-6"
                />
                <span className="truncate">{group.bot.name || `Bot ${group.bot.id}`}</span>
              </>
            );
            roleTooltip = group.bot.role || undefined;
          } else {
            headerLabel = (
              <>
                <FolderIcon className="h-4 w-4 flex-shrink-0" />
                <span className="truncate">{i18nService.t('sessionGroupOther')}</span>
              </>
            );
          }
          return (
            <section key={group.key}>
              <div className="relative group">
                <button
                  type="button"
                  aria-expanded={!collapsed}
                  onClick={() => toggleGroupCollapsed(group.key)}
                  title={roleTooltip}
                  className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm font-medium transition-colors dark:text-claude-darkText text-claude-text hover:text-claude-accent dark:hover:text-claude-accent"
                >
                  <ChevronDownIcon
                    className={`h-3.5 w-3.5 flex-shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                  />
                  {headerLabel}
                </button>
                {group.kind === 'bot' && group.bot && onQuickCreateTask && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onQuickCreateTask(group.bot.id);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded transition-all opacity-0 invisible group-hover:opacity-100 group-hover:visible group-focus-within:opacity-100 group-focus-within:visible focus-visible:opacity-100 focus-visible:visible focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 hover:bg-claude-accent/10 dark:hover:bg-claude-accent/10"
                    title={i18nService.t('newTask')}
                  >
                    <PlusIcon className="h-4 w-4 text-claude-accent dark:text-claude-accent" />
                  </button>
                )}
              </div>
              {!collapsed
                && (group.sessions.length > 0 ? (
                  group.sessions.map(renderItem)
                ) : (
                  <div className={`px-2.5 pb-1.5 pl-10 text-xs ${groupHeaderLabelClass}`}>
                    {i18nService.t('sessionGroupNoConversations')}
                  </div>
                ))}
            </section>
          );
        })}
      </div>
    );
  }

  // Flat list — callers that pass no view mode (the search modal). A selector
  // can still sit above it when the caller asked for one; every Bot Home face
  // passes a view mode, so the grouped branches above are what those render.
  return (
    <div ref={rootRef} className="space-y-1">
      {selectorBlock}
      {sortedSessions.filter((session) => session.pinned).map(renderItem)}
      {sortedSessions.filter((session) => !session.pinned).map(renderItem)}
    </div>
  );
};

/**
 * Memoized: the sidebar re-renders for reasons that have nothing to do with the
 * session list (long-term-task board pushes, the open-team poll), and this list
 * renders hundreds of rows. With the memo, such a re-render stops at the list —
 * provided the parent's props are stable, which is why Sidebar hands over
 * useStableCallback-wrapped handlers and state-backed arrays instead of inline
 * closures and freshly mapped lists.
 */
const CoworkSessionList = React.memo(CoworkSessionListRow);

export default CoworkSessionList;
