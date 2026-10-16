import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import type { CoworkSessionSummary } from '../../types/cowork';
import CoworkSessionItem, { SessionAvatarCircle, formatRelativeTime } from './CoworkSessionItem';
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
  groupSessionsByProject,
  groupSessionsByTimeline,
  sortSessionsByMode,
  type SessionSortMode,
  type SessionViewMode,
} from '../../utils/sessionViewGrouping';
import {
  AUTO_TASKS_EXPANDED_STORAGE_KEY,
  parseAutoTasksExpandedPreference,
  serializeAutoTasksExpandedPreference,
} from '../../utils/sessionAutoGrouping';
import { ChevronDownIcon, FolderIcon } from '@heroicons/react/24/outline';

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
   * Auto-folded sessions (long-term task runs, orchestration/delegation runs)
   * for the local-chats list — scheduled-task runs are NOT folded, they stay in
   * the main list. Folded rows are NEVER mixed into the main list: they render
   * as one collapsed "Autonomous Tasks" folder directly under the pinned
   * section and above the content groups, independent of the view mode — tucked
   * out of the human conversations, but visible at a glance instead of buried
   * at the bottom. Only the local tab passes this; every other caller leaves
   * it off and its output is unchanged.
   */
  autoSessions?: CoworkSessionSummary[];
  /**
   * Sessions owed an owner verdict right now (long-term sub-projects parked in
   * waiting_owner, board-derived): each matching row carries
   * decisionPending so its fold menu reflects where it actually renders (the
   * main list). Only the local tab passes this, mirroring autoSessions.
   */
  decisionSessionIds?: ReadonlySet<string>;
  /**
   * Move one session in or out of the Autonomous Tasks fold (the row menu's
   * 移入自主任务 / 移出自主任务 entry). Optional: callers that do not offer the
   * move (and every non-local list) simply leave it off, and the row then hides
   * the menu entry. `currentlyFolded` is the membership at menu-open time, so
   * the caller decides the next override without re-deriving it.
   */
  onToggleAutonomousFold?: (sessionId: string, currentlyFolded: boolean) => void;
  /** Online-chats (A2A) Bot selector — that list's ONLY selector. When on, the
   * list reuses the shared MetaBotSelector (the same component the cowork home
   * and Bot Internet composer use) above the flat list, with `allowAll` adding
   * the leading 全部 Bot entry. The bots come from the live metabot list
   * (enabled bots, Twin first), so a deleted bot never reappears; it opens on
   * the Twin (the bot you converse with; workers are picked on purpose), and
   * picking an entry scopes the flat list to that bot while 全部 Bot restores
   * it. Each option row carries the bot's conversation count on its right.
   * There is no grouping header and no view mode behind it, and a lone local
   * bot gets no control (a single option would only repeat the list). Every
   * other caller leaves it off, so their output is unchanged. */
  botSelector?: boolean;
  /**
   * i18n generation marker. The rows and the group headers read their copy from
   * i18nService at render time, so a memoized list needs the language among its
   * props — without it, switching language would leave every label in this list
   * in the previous language until the session data happened to change. Callers
   * pass i18nService.getLanguage() (they re-render on a language switch through
   * App's i18n subscription).
   */
  language?: string;
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

/** Placeholder for the optional fold move; hidden behind the menu entry's own guard. */
const noopToggleAutonomousFold = (): void => {};

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
  autoSessions?: CoworkSessionSummary[],
): [CoworkSessionSummary[], CoworkSessionSummary[] | undefined] => {
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
    const result: [CoworkSessionSummary[], CoworkSessionSummary[] | undefined] = [
      stabilize(sessions),
      autoSessions ? stabilize(autoSessions) : undefined,
    ];
    cacheRef.current = nextCache;
    return result;
  }, [sessions, autoSessions]);
};

/** Remembered open/closed state of the Autonomous Tasks fold, read once on mount. */
const loadAutoTasksExpanded = (): boolean => {
  try {
    return parseAutoTasksExpandedPreference(window.localStorage.getItem(AUTO_TASKS_EXPANDED_STORAGE_KEY));
  } catch {
    // localStorage unavailable; fall through to the collapsed default.
  }
  return false;
};

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
  autoSessions: incomingAutoSessions,
  decisionSessionIds,
  onToggleAutonomousFold,
  language: languageProp,
}) => {
  // Same summary objects for the rows whose fields did not change (see the
  // hook); everything below reads these instead of the raw props.
  const [sessions, autoSessions] = useStableSessionSummaries(incomingSessions, incomingAutoSessions);
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
  const toggleAutonomousFold = useStableCallback(onToggleAutonomousFold ?? noopToggleAutonomousFold);
  // Batch selection is the one optional action (the search modal never enters
  // selection mode). A no-op keeps the memoized prop a function, so the row's
  // guard cannot silently let an undefined callback through to a click.
  const toggleSessionSelected = useStableCallback(onToggleSessionSelected ?? noopToggleSelected);
  // How many rows may mount right now (see useProgressiveRowReveal), and the
  // cursor renderItem consumes it with.
  const rootRef = useRef<HTMLDivElement>(null);
  const revealedRows = useProgressiveRowReveal(rootRef);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const unreadSessionIdSet = useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const selectedSessionIdSet = useMemo(() => new Set(selectedSessionIds ?? []), [selectedSessionIds]);
  // Project-group collapse state lives here (not in the parent) so the search
  // modal and A2A tab, which render flat, never see it. Defaults to expanded.
  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(new Set);
  // The Autonomous Tasks fold, unlike the project groups, remembers its state
  // across restarts: it holds background runs, so it opens collapsed every
  // launch.
  const [isAutoTasksExpanded, setIsAutoTasksExpanded] = useState<boolean>(loadAutoTasksExpanded);
  const toggleAutoTasksExpanded = () => {
    setIsAutoTasksExpanded((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(
          AUTO_TASKS_EXPANDED_STORAGE_KEY,
          serializeAutoTasksExpandedPreference(next),
        );
      } catch {
        // localStorage unavailable; the fold still toggles for this session.
      }
      return next;
    });
  };
  const [pickedBotId, setPickedBotId] = useState<number | null>(null);
  // null = the live bot list has not settled yet. The control waits for it:
  // while it is pending the row is held open by a value-less placeholder (same
  // boxes as the trigger), so the control never paints a bot and then jumps to
  // the Twin default a frame later — the default-Twin promise is kept on the
  // very first painted frame.
  const [selectorBots, setSelectorBots] = useState<MetaBotForSelector[] | null>(null);
  // The caller's language, with a standalone fallback (see the prop's docs).
  const language = languageProp ?? i18nService.getLanguage();

  // The selector's bots come from the same read-only IPC the composers use
  // (enabled bots only, Twin first) — NOT from the sessions, so a deleted or
  // disabled bot can never reappear as a filter option. Best effort: any
  // failure leaves the selector off (empty list).
  useEffect(() => {
    if (!botSelector) return;
    let cancelled = false;
    window.electron?.idbots
      ?.getMetaBots?.()
      .then((result) => {
        if (!cancelled) setSelectorBots(result?.success && result.list ? result.list : []);
      })
      .catch(() => {
        if (!cancelled) setSelectorBots([]);
      });
    return () => {
      cancelled = true;
    };
  }, [botSelector]);

  // Per-bot conversation counts for the selector's option rows (each live bot
  // pre-seeded at 0, 'all' carrying the total). They exist only for the online
  // list; every other caller computes nothing.
  const sessionCounts = useMemo(
    () => (botSelector ? buildBotSessionCounts(sessions, (selectorBots ?? []).map((bot) => bot.id)) : undefined),
    [botSelector, sessions, selectorBots],
  );
  // A lone local bot needs no selector (the same "zero noise" rule as the
  // single-group degradation), so the control stays off below two local bots.
  const showBotSelector = (selectorBots?.length ?? 0) > 1;
  // The selector opens on the Twin — the bot you converse with — falling back
  // to 全部 Bot when there is no Twin or it has no online sessions yet, so the
  // list never opens scoped to an empty selection.
  const twinMetabotId = selectorBots?.find((bot) => bot.metabot_type === 'twin')?.id ?? null;
  const defaultBotId =
    twinMetabotId != null && (sessionCounts?.[twinMetabotId] ?? 0) > 0
      ? twinMetabotId
      : ALL_METABOTS_SELECTOR_ID;
  // An explicit pick wins while its bot still exists; otherwise the list falls
  // back to the default, so the filtered state cannot get stuck (e.g. on a bot
  // deleted after the pick). With the selector hidden there is no control to
  // escape a filter, so the list must show everything — legacy A2A rows with
  // no metabotId and sessions of since-deleted/disabled bots included.
  const activeBotId = showBotSelector
    ? (pickedBotId != null
        && (pickedBotId === ALL_METABOTS_SELECTOR_ID || selectorBots?.some((bot) => bot.id === pickedBotId))
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

  const projectGrouped = useMemo(
    () => (viewMode === 'project' ? groupSessionsByProject(visibleSessions, sortMode) : null),
    [visibleSessions, viewMode, sortMode],
  );

  // The Autonomous Tasks fold: machine-started runs, ordered like the main list
  // (pinned first, then the active sort mode) inside ONE flat section that
  // always sits directly under the pinned block, whatever the view mode. A pin
  // keeps its place inside the fold — it never rescues an autonomous run back
  // into the human list.
  const sortedAutoSessions = useMemo(() => {
    const list = autoSessions ?? [];
    if (list.length === 0) return [];
    return [
      ...sortSessionsByMode(list.filter((session) => session.pinned), sortMode),
      ...sortSessionsByMode(list.filter((session) => !session.pinned), sortMode),
    ];
  }, [autoSessions, sortMode]);
  // Newest activity in the fold (updatedAt is the session's last-activity
  // anchor, the same value the row's own timestamp shows).
  const autoLatestActivityAt = useMemo(
    () => sortedAutoSessions.reduce((latest, session) => Math.max(latest, session.updatedAt), 0),
    [sortedAutoSessions],
  );
  // Unread sessions inside the fold. This — not the total — is the header's
  // number: the user watches for background runs with news, and the local
  // tab's red dot lights from the same unread set in the sidebar's tabStats.
  const autoUnreadCount = useMemo(
    () => sortedAutoSessions.filter((session) => unreadSessionIdSet.has(session.id)).length,
    [sortedAutoSessions, unreadSessionIdSet],
  );

  const toggleGroupCollapsed = (key: string) => {
    setCollapsedGroupKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

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
        isActive={session.id === currentSessionId}
        selectionMode={selectionMode}
        isSelected={selectedSessionIdSet.has(session.id)}
        nowMs={nowMs}
        language={language}
        assistantMode={isAssistantModeOwnerChatSession(chatExperienceMode, session)}
        onSelect={selectSession}
        onDelete={deleteSession}
        onTogglePin={togglePin}
        onRename={renameSession}
        onToggleSelected={toggleSessionSelected}
        onToggleAutonomousFold={onToggleAutonomousFold ? toggleAutonomousFold : undefined}
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

  /**
   * The Autonomous Tasks fold. Rendered in every view mode directly under the
   * pinned block (above the timeline/project groups, where it is seen without
   * scrolling), and only when there is something to fold — an empty folder
   * would be noise of its own.
   *
   * Membership = the auto-origin policy (long-term task runs, orchestration
   * delegations) with the row's manual placement winning over it ('in' parks a
   * human row here, 'out' keeps an autonomous run in the main list) — see
   * isInAutonomousFold. Rows leave the fold by being archived, and the whole
   * section disappears once nothing is left in it.
   *
   * The header is styled like the project groups' folder header (subdued
   * secondary text + folder glyph) so it reads as a container, not as a
   * conversation, and carries a red dot at the row's left + the fold's UNREAD
   * session count in red (both only when > 0 — the signal the user actually
   * watches; the total survives only in the hover tooltip) + the fold's newest
   * activity time.
   * Per-row dots inside the EXPANDED fold stay — that is where "which run has
   * news" is actually traceable.
   */
  const renderAutoTasksSection = () =>
    revealBudgetLeft() && sortedAutoSessions.length > 0 && (
      <section data-testid="autonomous-tasks-section">
        <button
          type="button"
          aria-expanded={isAutoTasksExpanded}
          onClick={toggleAutoTasksExpanded}
          title={(autoUnreadCount > 0
            ? i18nService.t('coworkAutonomousTasksUnread').replace('{count}', String(autoUnreadCount))
            : i18nService.t('coworkAutonomousTasksCount').replace('{count}', String(sortedAutoSessions.length)))}
          className={`flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left transition-colors hover:text-claude-text dark:hover:text-claude-darkText ${groupHeaderLabelClass}`}
        >
          {autoUnreadCount > 0 && (
            <span className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-red-500" aria-hidden />
          )}
          <ChevronDownIcon
            className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${isAutoTasksExpanded ? '' : '-rotate-90'}`}
          />
          <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="truncate">{i18nService.t('coworkAutonomousTasks')}</span>
          {autoUnreadCount > 0 && (
            <span className="flex-shrink-0 font-medium tabular-nums text-red-500">{autoUnreadCount}</span>
          )}
          {autoLatestActivityAt > 0 && (
            <span className="ml-auto flex-shrink-0 font-normal tabular-nums" title={formatRelativeTime(autoLatestActivityAt).full}>
              {formatRelativeTime(autoLatestActivityAt).compact}
            </span>
          )}
        </button>
        {isAutoTasksExpanded && sortedAutoSessions.map(renderItem)}
      </section>
    );

  // The online list's only selector: the SAME MetaBotSelector the composers
  // use (cowork home, Bot Internet panel), so the two surfaces can never drift
  // apart again. allowAll adds the leading 全部 Bot entry, the option rows
  // carry each bot's conversation count on their right, and the dropdown
  // floats fixed so the sidebar's scroll container cannot clip it.
  const botSelectorRow = showBotSelector ? (
    selectorBots ? (
      <div data-testid="bot-selector-row" className="px-2.5 pb-1.5 pt-0.5">
        <MetaBotSelector
          metabots={selectorBots}
          selectedId={activeBotId}
          onSelect={(id) => setPickedBotId(id ?? ALL_METABOTS_SELECTOR_ID)}
          label={i18nService.t('coworkMetaBotLabel')}
          placeholder={i18nService.t('coworkMetaBotPlaceholder')}
          compact
          allowAll
          sessionCounts={sessionCounts}
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

  // An empty human list still renders the fold when background runs exist:
  // showing "no chats yet" above a folder of them would be a lie. Every caller
  // that passes no autoSessions (A2A tab, search modal) keeps the old empty
  // state exactly — the fold belongs to the local list only, so the selector
  // path never counts it either.
  const hasAutoTasks = sortedAutoSessions.length > 0 && !showBotSelector;
  if (visibleSessions.length === 0 && !hasAutoTasks) {
    return (
      <div ref={rootRef} className="text-center py-8">
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {emptyText ?? i18nService.t('coworkNoSessions')}
        </p>
      </div>
    );
  }

  // Timeline view: static time headers (never collapsible), pinned first.
  if (timelineGrouped) {
    return (
      <div ref={rootRef}>
        {renderPinnedSection(timelineGrouped.pinned)}
        {renderAutoTasksSection()}
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

  // Project view: collapsible per-project / per-bot groups, pinned first.
  if (projectGrouped) {
    return (
      <div ref={rootRef}>
        {renderPinnedSection(projectGrouped.pinned)}
        {renderAutoTasksSection()}
        {projectGrouped.groups.map((group) => {
          if (!revealBudgetLeft()) return null;
          const collapsed = collapsedGroupKeys.has(group.key);
          let headerLabel: React.ReactNode;
          if (group.kind === 'bot' && group.bot) {
            headerLabel = (
              <>
                <SessionAvatarCircle
                  src={group.bot.avatar}
                  name={group.bot.name}
                  sizeClass="h-4 w-4"
                />
                <span className="truncate">{group.bot.name || `Bot ${group.bot.id}`}</span>
              </>
            );
          } else if (group.kind === 'directory') {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate" title={group.directoryPath}>
                  {group.directoryName}
                </span>
              </>
            );
          } else {
            headerLabel = (
              <>
                <FolderIcon className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{i18nService.t('sessionGroupOther')}</span>
              </>
            );
          }
          return (
            <section key={group.key}>
              <button
                type="button"
                aria-expanded={!collapsed}
                onClick={() => toggleGroupCollapsed(group.key)}
                className={`flex w-full items-center gap-1.5 px-2.5 pb-1 pt-2.5 text-left transition-colors hover:text-claude-text dark:hover:text-claude-darkText ${groupHeaderLabelClass}`}
              >
                <ChevronDownIcon
                  className={`h-3 w-3 flex-shrink-0 transition-transform duration-150 ${collapsed ? '-rotate-90' : ''}`}
                />
                {headerLabel}
              </button>
              {!collapsed && group.sessions.map(renderItem)}
            </section>
          );
        })}
      </div>
    );
  }

  // Flat list — what the online-chats (A2A) tab renders: no grouping header and
  // no view mode. When the selector is shown it sits directly above the list and
  // is its sole selector: 全部 Bot renders every session, an entry narrows the
  // list to that bot. A lone local bot gets no control at all (the live-list
  // length rule in showBotSelector), and the list is then simply flat.
  if (botSelectorRow) {
    return (
      <div ref={rootRef}>
        {botSelectorRow}
        {/* Hairline between the control area and the list area, using the host's
         * own separator token (SessionViewOptionsMenu.tsx:149). It is a plain
         * static line inside the scroll container — NOT sticky — so the control
         * and its boundary scroll away with the rows and never compete with the
         * list for attention. */}
        <div
          data-testid="bot-selector-divider"
          className="mt-0.5 border-t dark:border-claude-darkBorder border-claude-border"
        />
        <div className="space-y-1">{sortedSessions.map(renderItem)}</div>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="space-y-1">
      {/* Flat mode has no group headers, so the fold's anchor is the pinned
       * block itself: pinned rows first, then the fold, then the rest —
       * the same "under pinned, above everything else" spot the grouped
       * views give it. */}
      {sortedSessions.filter((session) => session.pinned).map(renderItem)}
      {renderAutoTasksSection()}
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
