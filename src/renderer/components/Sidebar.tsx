import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { browserCoworkService } from '../services/browserCowork';
import { sessionTabBinding } from '../services/sessionTabBinding';
import { groupTaskService } from '../services/groupTaskService';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import SessionViewOptionsMenu from './cowork/SessionViewOptionsMenu';
import { UnifiedTaskList } from './groupTasks/UnifiedTaskList';
import type { GroupTaskTypeVariant } from './groupTasks/GroupTaskSidebarList';
import { OPEN_TEAM_COLLAB_POLL_INTERVAL_MS } from './groupTasks/OpenTeamCollabsSection';
import { openTeamCollabService } from '../services/openTeamCollabService';
import { selectCollab, selectTask as selectGroupTask } from '../store/slices/groupTasksSlice';
import { selectTask as selectLongTermTask } from '../store/slices/longTermTaskSlice';
import { clearCurrentSession, setNewTaskMetabotId, setNewTaskOrigin } from '../store/slices/coworkSlice';
import type { OpenTeamCollabSummary } from '../types/openTeamCollab';
import { buildUnifiedTaskList } from '../utils/unifiedTaskList';
import { MagnifyingGlassIcon, ArchiveBoxIcon, XMarkIcon, ClockIcon } from '@heroicons/react/24/outline';
import ComposeIcon from './icons/ComposeIcon';
import Tooltip from './ui/Tooltip';
import FilterLinesIcon from './icons/FilterLinesIcon';
import BackgroundTasksBadge from './cowork/BackgroundTasksBadge';
import { SleepGuardBadge } from './SleepGuardBadge';
import BotBrowserCoworkPanel from '../features/botBrowser/BotBrowserCoworkPanel';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import { UserProfilePage } from '../features/userProfile';
import { defaultSidebarWidth } from '../utils/sidebarWidth';
import type { BotBrowserSurfaceMode, BotHomeSection } from '../features/botBrowser/types';
import type { CoworkSessionSummary } from '../types/cowork';
import type {
  SessionSortMode,
  SessionViewMode,
} from '../utils/sessionViewGrouping';
import { shouldFoldIntoAutonomousTasks, splitSessionsWithFollowUp } from '../utils/sessionAutoGrouping';
import { loadSessionViewMode, saveSessionViewMode } from '../utils/sessionGroupStorage';
import type { SessionSidebarSection } from '../utils/sessionAutoGrouping';
import { useStableCallback } from '../utils/useStableCallback';
import { LONG_TERM_COLUMN_LABEL_KEYS, type LongTermTaskSummary } from '../types/longTermTask';
import type { SettingsOpenOptions } from './Settings';

/**
 * The middle column of the three-column shell (slice 1).
 *
 * Container ownership moved here from the old single sidebar: this component no
 * longer renders navigation (the left rail owns it) and no longer renders the
 * settings/ME footer (the rail owns it too). What stays is the column's own
 * content: the Bot Browser Co-Work panel on the Bot Internet surface, and the
 * three task-list sections (long-term / group tasks / records) on Bot Home.
 */
interface SidebarProps {
  onShowSettings: (options?: SettingsOpenOptions) => void;
  onShowLogin?: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowGroupTasks: () => void;
  mode: BotBrowserSurfaceMode;
  /** Bot Home: which of the three list sections is expanded. The left rail is
   * the ONLY selector that sets it — the middle column renders the body of
   * whatever the rail picked and owns no record-type control of its own. */
  homeSection: BotHomeSection;
  /** Open the Bot Home surface from the Co-Work panel. */
  onSelectHome: () => void;
  /** Switch surface. The switcher lives in THIS column's header (owner ruling
   * 2026-11-08 14:15: moved out of the 64 px rail so it can show the current
   * surface's name in a Codex-style capsule). Both surfaces are always listed
   * in its menu, so the header control is the ONE place a surface is chosen. */
  onSelectSurface: (mode: BotBrowserSurfaceMode) => void;
  /** Open a browser-type session back in the Bot Browser co-work surface.
   * Browser sessions are listed in the Bot Home history (one list, no dead
   * ends), but they run in the Bot Browser panel — selecting one must return
   * the user there instead of the home chat view. */
  onSelectBrowserSession?: (sessionId: string) => void | Promise<void>;
  isCollapsed: boolean;
  /** Expanded middle-column width in px (resizable by the user). */
  width?: number;
  /** True while the user is dragging the resize handle; disables the width transition for lag-free dragging. */
  isResizing?: boolean;
}

/**
 * Task-record SESSION SCOPES (owner ruling 2026-11-08): the record list filters
 * by who is talking — local owner↔Bot chats, or online Bot↔Bot chats.
 *
 * Group-task chat channels are deliberately NOT a third scope any more: group
 * tasks are their own RECORD TYPE («多人任务»), and their chat channels are
 * listed under that type instead (see the group-task section). Keeping them as
 * a scope as well duplicated the same rows under a second selector that
 * visually collided with the record-type selector above it.
 *
 * Layers (top → bottom): record TYPE (long-term / group tasks / records) →
 * session SCOPE (local / a2a) → the list itself.
 */
type TaskRecordTab = 'local' | 'a2a';

const TASK_RECORD_TABS: Array<{ id: TaskRecordTab; labelKey: string; emptyKey: string }> = [
  { id: 'local', labelKey: 'coworkTabLocal', emptyKey: 'coworkEmptyLocal' },
  { id: 'a2a', labelKey: 'coworkTabA2A', emptyKey: 'coworkEmptyA2A' },
];

/** localStorage key for the remembered task-record tab. */
const TASK_RECORD_TAB_STORAGE_KEY = 'taskRecordTab';

/**
 * Column dot for the long-term cards previewed in the middle column. Same
 * palette as the board's column dots so the two readings never disagree.
 */
const LONG_TERM_COLUMN_DOT_CLASS: Record<string, string> = {
  waiting_owner: 'bg-amber-400',
  in_progress: 'bg-sky-400',
  waiting_external: 'bg-violet-400',
  defining: 'bg-claude-textSecondary dark:bg-claude-darkTextSecondary',
  paused: 'bg-zinc-500',
  done: 'bg-emerald-400',
};

const loadTaskRecordTab = (): TaskRecordTab => {
  try {
    const stored = window.localStorage.getItem(TASK_RECORD_TAB_STORAGE_KEY);
    // 'group' is the retired third scope: its rows now live under the
    // group-tasks record type, so an old profile folds back to the local tab.
    if (stored === 'a2a') return stored;
  } catch {
    // localStorage unavailable; fall through to the default tab.
  }
  return 'local';
};

/** localStorage key for the local-chats list sort choice. The VIEW choice
 * (按 Bot / 按时间线) is per face and lives in utils/sessionGroupStorage.ts —
 * the local and online lists must not share one grouping preference. */
const SESSION_SORT_MODE_STORAGE_KEY = 'sessionSortMode';

const loadSessionSortMode = (): SessionSortMode => {
  try {
    const stored = window.localStorage.getItem(SESSION_SORT_MODE_STORAGE_KEY);
    if (stored === 'createdAt') return 'createdAt';
  } catch {
    // localStorage unavailable; fall through to the default sort.
  }
  return 'updatedAt';
};

const Sidebar: React.FC<SidebarProps> = ({
  onShowSettings,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowGroupTasks,
  mode,
  homeSection,
  onSelectHome,
  onSelectSurface,
  onSelectBrowserSession,
  isCollapsed,
  width = defaultSidebarWidth('home'),
  isResizing = false,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  // Bot Browser co-work sessions (session_type = 'browser') live on the Bot
  // Internet surface: the panel's own history overlay is their entry point.
  // Bot Home is the task surface — browser chat rows no longer mix into its
  // history list (two-surface split, owner ruling 2026-11-08). Reachability is
  // preserved two ways: selecting a browser row from search still routes back
  // to the Bot Browser surface (handleSelectSession below), and the panel
  // history still lists every browser session.
  const homeSessions = sessions;
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const groupTasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const selectedGroupTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const selectedCollabId = useSelector((state: RootState) => state.groupTasks.selectedCollabId);
  // Joined OpenTeam collabs for the records "Group Tasks" tab (remote-hosted
  // tasks this machine's bots participate in; loaded/polled only while that
  // tab is visible).
  const [openTeamCollabs, setOpenTeamCollabs] = useState<OpenTeamCollabSummary[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // BotHub session-records overlay (owner spec 2026-11-08 21:31, kept by the
  // 22:19 re-ruling): the toggle lives in the shared surface header bar, so its
  // state is owned here and the panel below is controlled. Switching to
  // BotWorks closes it — the panel unmounts on that face anyway, and a stale
  // "open" must not greet the next visit.
  const [panelHistoryOpen, setPanelHistoryOpen] = useState(false);
  const dispatch = useDispatch();
  // Which task-record category the home history list shows. Persisted across
  // app restarts; the header + tabs stay fixed while only the list scrolls.
  const [taskRecordTab, setTaskRecordTab] = useState<TaskRecordTab>(loadTaskRecordTab);
  // Batch-archive selection mode for the session list — one mode shared by
  // both faces (local and online). The toolbar row above the list hosts this
  // and the view "filter & sort" controls.
  const [isBatchArchiveMode, setIsBatchArchiveMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  // View + sort choices for the local-chats list, persisted across app
  // restarts; the menu itself is a transient popover anchored to the toolbar.
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(() =>
    loadSessionViewMode((key) => window.localStorage.getItem(key), 'local'),
  );
  // The online face has its own remembered view (same default, same storage
  // family, different key): switching the local list to the timeline must not
  // drag the online list with it.
  const [a2aViewMode, setA2aViewMode] = useState<SessionViewMode>(() =>
    loadSessionViewMode((key) => window.localStorage.getItem(key), 'a2a'),
  );
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>(loadSessionSortMode);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const handleSetSessionViewMode = (mode: SessionViewMode) => {
    setSessionViewMode(mode);
    try {
      saveSessionViewMode(
        (storageKey, value) => window.localStorage.setItem(storageKey, value),
        'local',
        mode,
      );
    } catch {
      // localStorage unavailable; the view still switches for this session.
    }
  };
  const handleSetA2aViewMode = (mode: SessionViewMode) => {
    setA2aViewMode(mode);
    try {
      saveSessionViewMode(
        (storageKey, value) => window.localStorage.setItem(storageKey, value),
        'a2a',
        mode,
      );
    } catch {
      // localStorage unavailable; the view still switches for this session.
    }
  };
  const handleSetSessionSortMode = (mode: SessionSortMode) => {
    setSessionSortMode(mode);
    try {
      window.localStorage.setItem(SESSION_SORT_MODE_STORAGE_KEY, mode);
    } catch {
      // localStorage unavailable; the sort still switches for this session.
    }
  };
  const activeTaskRecordTab = TASK_RECORD_TABS.find((tab) => tab.id === taskRecordTab) ?? TASK_RECORD_TABS[0];
  const handleSetTaskRecordTab = (tab: TaskRecordTab) => {
    setTaskRecordTab(tab);
    try {
      window.localStorage.setItem(TASK_RECORD_TAB_STORAGE_KEY, tab);
    } catch {
      // localStorage unavailable; the tab still switches for this session.
    }
  };
  // Sessions grouped by category: local (human↔MetaBot chats, EXCLUDING
  // browser co-work sessions which stay on the Bot Internet surface), a2a
  // (MetaBot↔MetaBot), group (group-task chat channels). a2a / group_task
  // keep their dedicated tabs and are matched by their own session type, so
  // browser sessions can never leak into them.
  const sessionGroups = useMemo(() => {
    // IM rows belong to the LOCAL list even when an older row is still stored
    // as 'a2a' (direct IM chats used to be created that way). The mapping
    // channel is the display source of truth, so this is a render-time
    // reclassification — no data migration.
    const isImSession = (session: CoworkSessionSummary) => Boolean(session.imChannel);
    const isLocal = (session: CoworkSessionSummary) =>
      session.sessionType !== 'group_task'
      && session.sessionType !== 'browser'
      && (session.sessionType !== 'a2a' || isImSession(session));
    return {
      local: homeSessions.filter(isLocal),
      a2a: homeSessions.filter((session) => session.sessionType === 'a2a' && !isImSession(session)),
      group: homeSessions.filter((session) => session.sessionType === 'group_task'),
    };
  }, [homeSessions]);
  // The 跟踪任务 nav entry's dot: a parked owner decision (waiting_owner) is the
  // stronger signal, and the board behind it is kept live app-wide (App.tsx
  // init) so the dot is correct even if the 长期任务 tab was never opened.
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  // Sessions currently owed an owner verdict (waiting_owner sub-projects' bound
  // sessions, board-derived): with no manual placement they land in the
  // Follow-Up section — the owner must SEE the decision, not find it buried in
  // the collapsed fold. Folds back automatically once the verdict lands.
  const decisionSessionIds = useMemo(
    () => new Set((longTermBoard?.cards ?? []).flatMap((card) => card.decisionSessionIds ?? [])),
    [longTermBoard],
  );
  // The local tab's list is split three ways (spec §3.1): the human's own
  // conversations stay in the main list; sessions that currently need a human
  // decision or reply (followUpState 'pending', or a live board decision owed)
  // go to the "Follow-Up Tasks" section; the remaining machine-started runs
  // fold into the collapsed "Autonomous Tasks" section. A manual fold
  // placement always wins over both buckets. Search still sees every session.
  const { humanSessions: localHumanSessions, followUpSessions: localFollowUpSessions, autoSessions: localAutoSessions } = useMemo(
    () => splitSessionsWithFollowUp(sessionGroups.local, decisionSessionIds),
    [sessionGroups.local, decisionSessionIds],
  );
  const localListSessions = taskRecordTab === 'local' ? localHumanSessions : sessionGroups[taskRecordTab];
  // The tab-scoped list the search modal searches: intentionally the WHOLE
  // bucket (folded auto sessions included), so a hidden background run is still
  // findable by name.
  const tabbedSessions = sessionGroups[taskRecordTab];

  // Unified task list: merge local group tasks with OpenTeam collabs, sorted
  // newest first. Each item carries its type badge variant (local / host / guest).
  const unifiedTaskList = useMemo(
    () => buildUnifiedTaskList(groupTasks, openTeamCollabs),
    [groupTasks, openTeamCollabs],
  );

  // Type lookup for each task id (used by UnifiedTaskList).
  const taskTypeById = useMemo(() => {
    const map = new Map<number, GroupTaskTypeVariant>();
    for (const item of unifiedTaskList) {
      if (item.kind !== 'openteam-guest') {
        map.set(item.task.id, item.kind);
      }
    }
    return map;
  }, [unifiedTaskList]);

  // Per-tab totals and unread counts, shown on the tab buttons. The local tab
  // counts the main list PLUS the Follow-Up section — pending decisions are the
  // point of the feature and must light the tab badge (user decision #5),
  // including their heartbeat-driven turns. The Autonomous fold stays excluded:
  // its sessions carry their own red dot + unread count on the fold's header
  // row, and letting plain background runs also light the tab would be the
  // noise the fold exists to remove.
  const tabStats = useMemo(() => {
    const unreadSet = new Set(unreadSessionIds);
    const unreadOf = (list: CoworkSessionSummary[]) => list.filter((session) => unreadSet.has(session.id)).length;
    return {
      local: {
        count: localHumanSessions.length + localFollowUpSessions.length,
        unread: unreadOf(localHumanSessions) + unreadOf(localFollowUpSessions),
      },
      a2a: { count: sessionGroups.a2a.length, unread: unreadOf(sessionGroups.a2a) },
    };
  }, [sessionGroups, localHumanSessions, localFollowUpSessions, unreadSessionIds]);
  // The view mode of the face currently on screen, and its setter. Both faces
  // render the same grouped component; only the remembered choice differs.
  const faceViewMode = taskRecordTab === 'local' ? sessionViewMode : a2aViewMode;
  const handleSetFaceViewMode = taskRecordTab === 'local' ? handleSetSessionViewMode : handleSetA2aViewMode;
  // The toolbar (view label + filter & sort + batch archive) shows while the
  // face on screen has rows to control; both faces get the same controls.
  const hasFaceSessions = taskRecordTab === 'local'
    ? localHumanSessions.length > 0
    : sessionGroups.a2a.length > 0;

  // Labels come from i18nService at call time, so the language is an input of
  // every memo below (and of the session list): this component re-renders on a
  // language switch through App's i18n subscription, and the memo has to see
  // the new language to rebuild what it cached.
  const language = i18nService.getLanguage();
  // Long-term cards in board order (waiting-owner column first), so the section
  // shows what needs the owner before the parked tasks.
  const longTermCards = useMemo<LongTermTaskSummary[]>(() => {
    if (!longTermBoard) return [];
    const byId = new Map(longTermBoard.cards.map((card) => [card.id, card]));
    return longTermBoard.columns.flatMap((column) =>
      column.cardIds
        .map((id) => byId.get(id))
        .filter((card): card is LongTermTaskSummary => Boolean(card)),
    );
  }, [longTermBoard]);

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  // The group-task rows moved from a session-scope tab to their own record
  // type, so the load gate follows the record type, not the scope tabs.
  useEffect(() => {
    if (homeSection !== 'groupTasks') return;
    void groupTaskService.loadTasks();
  }, [homeSection]);

  // Collab rows ride the same gate: load on entering the group-tasks record
  // type, then poll so new remote collaborations surface without leaving it.
  useEffect(() => {
    if (homeSection !== 'groupTasks') return;
    let cancelled = false;
    const load = () => {
      openTeamCollabService
        .list()
        .then((list) => {
          if (!cancelled) setOpenTeamCollabs(list);
        })
        .catch(() => {
          // Traceability rows must never break the records list.
        });
    };
    load();
    const timer = setInterval(load, OPEN_TEAM_COLLAB_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [homeSection]);

  // Switching faces ends any batch-archive selection in progress: the picked
  // ids belong to the face they were picked on, and the two faces' session
  // buckets never overlap. Batch archive itself exists on BOTH faces now.
  useEffect(() => {
    setIsBatchArchiveMode(false);
    setBatchSelectedIds([]);
    setIsViewMenuOpen(false);
  }, [taskRecordTab]);

  // The toolbar row (and its filter & sort menu) only exists while the human
  // list is non-empty: over an empty list (only folded background runs left) it
  // would control nothing the user can see.
  useEffect(() => {
    if (localHumanSessions.length > 0) return;
    setIsViewMenuOpen(false);
  }, [localHumanSessions.length]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
  }, [isCollapsed]);

  useEffect(() => {
    if (mode === 'browser') {
      setIsSearchOpen(false);
    }
  }, [mode]);

  const handleSelectSession = async (sessionId: string) => {
    // Browser sessions run in the Bot Browser co-work panel, so "coming back"
    // to one means returning to that surface with the session loaded there —
    // not the home chat view. Fall back to the home view when the host did not
    // wire the browser route (keeps the row usable either way).
    const target = sessions.find((session) => session.id === sessionId);
    if (target?.sessionType === 'browser' && onSelectBrowserSession) {
      await onSelectBrowserSession(sessionId);
      return;
    }
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.archiveSession(sessionId);
  };

  const handleEnterBatchArchiveMode = () => {
    setBatchSelectedIds([]);
    setIsBatchArchiveMode(true);
  };

  const handleExitBatchArchiveMode = () => {
    setIsBatchArchiveMode(false);
    setBatchSelectedIds([]);
  };

  const handleToggleBatchSelected = (sessionId: string) => {
    setBatchSelectedIds((prev) =>
      prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : [...prev, sessionId],
    );
  };

  const handleConfirmBatchArchive = async () => {
    // Only archive ids still present on the face that is on screen (a session
    // may have been archived individually while selection mode was open). The
    // bucket is the face's own: the local face keeps its full local set (fold
    // and Follow-Up rows included), the online face its a2a set — before this
    // the local bucket was hard-coded, which silently dropped every a2a pick.
    const faceSessions = sessionGroups[taskRecordTab];
    const archivableIds = batchSelectedIds.filter((id) =>
      faceSessions.some((session) => session.id === id),
    );
    handleExitBatchArchiveMode();
    for (const sessionId of archivableIds) {
      await coworkService.archiveSession(sessionId);
    }
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  /**
   * Move a session to one of the three sidebar sections — the Autonomous Tasks
   * fold, the Follow-Up Tasks section, or the normal list — the single write
   * path behind the row menu's "Move to…" submenu (the row disables the
   * section the session already sits in, so a same-section pick never lands
   * here and nothing changes for it).
   *
   * Placement is two independent persisted lanes, so each target normalizes
   * BOTH of them (order within a pair does not matter — each write patches its
   * own field):
   *  - to the fold: 'in' parks the row there whatever its origin, and any
   *    follow-up pending is cleared so no stale marker resurfaces the row in
   *    Follow-Up if the override is later dropped;
   *  - to Follow-Up: the override must stop fighting the marker (both 'in'
   *    and 'out' outrank it in the placement precedence), so it resets to
   *    null, and the marker persists 'pending' with source 'manual';
   *  - to the normal list: an explicit 'out' is written whenever ANY lane
   *    would pull the row back out of the normal list — the auto-origin fold
   *    policy, or a live board decision owed on the session
   *    (decisionSessionIds: waiting_owner sub-projects bound to it) — because
   *    foldOverride outranks both in the placement precedence; without the
   *    'out', a decision-owed row dropped its marker, wrote null, and stayed
   *    in Follow-Up — a silent no-op (the reported bug). A row with no pull
   *    at all only drops its override back to null; the follow-up marker is
   *    cleared either way (clearSessionFollowUp clears ANY pending source
   *    main-side — the same manual move-out the old menu performed).
   */
  const handleMoveSessionToSection = async (sessionId: string, target: SessionSidebarSection) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (target === 'autonomous') {
      await coworkService.setSessionFollowUp(sessionId, false);
      await coworkService.setSessionFoldOverride(sessionId, 'in');
    } else if (target === 'follow-up') {
      await coworkService.setSessionFoldOverride(sessionId, null);
      await coworkService.setSessionFollowUp(sessionId, true);
    } else {
      await coworkService.setSessionFollowUp(sessionId, false);
      const needsExplicitOut =
        shouldFoldIntoAutonomousTasks(session) || decisionSessionIds.has(sessionId);
      await coworkService.setSessionFoldOverride(
        sessionId,
        needsExplicitOut ? 'out' : null,
      );
    }
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  // The session list is memoized, and its rows are memoized on the callbacks it
  // receives. The handlers above are plain closures — rebuilt on every render
  // (handleSelectSession also closes over the sessions array, which is replaced
  // on every list read) — so the list gets one stable identity per action
  // instead, which still invokes the newest handler. Rebinding them per render
  // would re-render every mounted row of the list.
  const listOnSelectSession = useStableCallback(handleSelectSession);
  const listOnDeleteSession = useStableCallback(handleDeleteSession);
  const listOnTogglePin = useStableCallback(handleTogglePin);
  const listOnMoveSessionToSection = useStableCallback(handleMoveSessionToSection);
  const listOnRenameSession = useStableCallback(handleRenameSession);
  const listOnToggleSessionSelected = useStableCallback(handleToggleBatchSelected);

  /** Quick-create new task with selected bot from bot group header. */
  const handleQuickCreateTask = useStableCallback((botId: number) => {
    // Clear current session to show new task view
    dispatch(clearCurrentSession());
    // Set the selected bot for the new task
    dispatch(setNewTaskMetabotId(botId));
    // The composer's wording follows the face the + was pressed on: this face
    // shows 本地对话 tasks AND 线上对话 (a2a) sessions, and only the a2a tabs arm
    // the Bot-to-Bot copy. Every other opener resets the origin to 'local'.
    dispatch(setNewTaskOrigin(taskRecordTab === 'a2a' ? 'a2a' : 'local'));
    // Switch to cowork view if not already there
    onShowCowork();
  });

  /** Open a group task from the sidebar: switch to the Group Tasks view and select the task. */
  const handleSelectGroupTask = (taskId: number) => {
    onShowGroupTasks();
    dispatch(selectGroupTask(taskId));
  };

  /** Open a joined OpenTeam collab from the sidebar records list. */
  const handleSelectOpenTeamCollab = (collabId: number) => {
    onShowGroupTasks();
    dispatch(selectCollab(collabId));
  };

  const handleToggleGroupTaskPin = async (taskId: number, pinned: boolean) => {
    await groupTaskService.setTaskPinned(taskId, pinned);
  };

  const handleRenameGroupTask = async (taskId: number, title: string) => {
    await groupTaskService.renameTask(taskId, title);
  };

  const handleArchiveGroupTask = async (taskId: number) => {
    await groupTaskService.archiveTask(taskId);
  };

  // The shared header's action row, directly below the top-track band. BotWorks
  // keeps the records search and the shell's live indicators; BotHub carries
  // the session window's two light actions — new session and session records.
  // Both sets are 28 px controls (aesthetic grid v1).
  const surfaceHeaderActions = mode === 'home' ? (
    <>
      <button
        type="button"
        onClick={() => {
          onShowCowork();
          setIsSearchOpen(true);
        }}
        className="non-draggable inline-flex h-7 w-7 items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        aria-label={i18nService.t('search')}
      >
        <MagnifyingGlassIcon className="h-4 w-4" />
      </button>
      <BackgroundTasksBadge onShowGroupTasks={onShowGroupTasks} />
      <SleepGuardBadge />
    </>
  ) : (
    <>
      <button
        type="button"
        data-slot="cowork-new-session"
        onClick={() => {
          setPanelHistoryOpen(false);
          browserCoworkService.startNewDraft();
          // The upcoming session owns one tab (owner request 2026-11-10): a
          // page-carrying active tab gets a fresh blank sibling; a blank
          // active tab is reused. Best-effort — no tab when the bridge is down.
          void sessionTabBinding.prepareDraftTab();
        }}
        className="non-draggable inline-flex h-7 w-7 items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:dark:text-claude-darkText hover:text-claude-text transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        aria-label={i18nService.t('botBrowserCoworkNew')}
        title={i18nService.t('botBrowserCoworkNew')}
      >
        <ComposeIcon className="h-4 w-4" />
      </button>
      <button
        type="button"
        data-slot="cowork-toggle-history"
        aria-expanded={panelHistoryOpen}
        onClick={() => setPanelHistoryOpen((value) => !value)}
        className={`non-draggable inline-flex h-7 w-7 items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
          panelHistoryOpen
            ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
            : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover hover:dark:text-claude-darkText hover:text-claude-text'
        }`}
        aria-label={i18nService.t('botBrowserCoworkHistory')}
        title={i18nService.t('botBrowserCoworkHistory')}
      >
        <ClockIcon className="h-4 w-4" />
      </button>
      <BackgroundTasksBadge onShowGroupTasks={onShowGroupTasks} />
      <SleepGuardBadge />
    </>
  );

  return (
    <aside
      data-slot="workspace-mid-column"
      aria-label={mode === 'home' ? i18nService.t('botHome') : i18nService.t('botBrowserCoworkTitle')}
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col overflow-hidden ${
        isResizing ? '' : 'sidebar-transition'
      }`}
      style={{ width: isCollapsed ? 0 : width }}
    >
      {/* The ONE shared surface header (owner red-box order 2026-11-09
          10:58; identity relocated by the D-line final ruling 2026-11-09):
          row 1 = the traffic lights' own 52 px strip, row 2 = the
          BotHub | BotWorks band ALONE — the identity avatar moved into the
          rail's top slot (WorkspaceRail), so this header carries no pill.
          The face's light actions sit on the row below the band,
          right-aligned. */}
      <div data-slot="mid-column-header" className="shrink-0">
        <BotBrowserModeSwitch
          mode={mode}
          onSelectBrowser={() => onSelectSurface('browser')}
          onSelectHome={() => onSelectSurface('home')}
          actions={surfaceHeaderActions}
        />
      </div>

      {mode === 'home' ? (
        <div className="flex min-h-0 flex-1 flex-col px-2 pt-1">
          {/* The record TYPE (long-term / group tasks / records) is chosen in
              the LEFT RAIL — the four Bot Home icons — and only there. The
              middle column owns no type selector: an earlier native select drawer
              sat right here and duplicated the rail, while its amber decision
              dot duplicated the one on the rail's 长期任务 entry. The column
              now renders the body of whatever the rail picked (the type is the
              `homeSection` prop, derived from App's mainView) and nothing else.
              The one control that stays is the records BODY's own scope row
              (local / online), which filters rows inside this list and is not
              a destination selector. */}
          {homeSection === 'longTerm' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-home-section="longTerm">
              {longTermCards.length === 0 ? (
                <p className="px-2 py-1.5 text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('homeMidLongTermEmpty')}
                </p>
              ) : (
                longTermCards.slice(0, 5).map((card) => (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => {
                      dispatch(selectLongTermTask(card.id));
                      onShowScheduledTasks();
                    }}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
                  >
                    <span
                      aria-hidden
                      className={`h-1.5 w-1.5 shrink-0 rounded-full ${LONG_TERM_COLUMN_DOT_CLASS[card.column] ?? 'bg-claude-textSecondary'}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs dark:text-claude-darkText text-claude-text">
                      {card.title}
                    </span>
                    <span className="shrink-0 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                      {i18nService.t(LONG_TERM_COLUMN_LABEL_KEYS[card.column])}
                    </span>
                  </button>
                ))
              )}
              <p className="px-2 pt-1 text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('homeMidLongTermHint')}
              </p>
            </div>
          ) : homeSection === 'groupTasks' ? (
            <div className="min-h-0 flex-1 overflow-y-auto pb-2" data-home-section="groupTasks">
              <UnifiedTaskList
                items={unifiedTaskList}
                selectedTaskId={selectedGroupTaskId}
                selectedCollabId={selectedCollabId}
                onSelectTask={handleSelectGroupTask}
                onSelectCollab={handleSelectOpenTeamCollab}
                onTogglePin={handleToggleGroupTaskPin}
                onRename={handleRenameGroupTask}
                onArchive={handleArchiveGroupTask}
                getTaskType={(task) => taskTypeById.get(task.id) ?? 'local'}
                emptyText={i18nService.t('homeMidGroupTasksEmpty')}
              />
              {/* Group-task CHAT CHANNELS live here, under their own record
                  type - that is why the records scope tabs no longer carry a
                  group tab (owner ruling 2026-11-08). Reachability is the
                  point: every session_type='group_task' session is listed. */}
              <div
                data-slot="group-task-sessions"
                className="mt-1 border-t border-claude-border/60 pt-1 dark:border-claude-darkBorder/60"
              >
                <div className="px-2 pb-1 pt-1 text-[11px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('homeMidGroupSessionsTitle')}
                </div>
                <CoworkSessionList
                  sessions={sessionGroups.group}
                  currentSessionId={currentSessionId}
                  onSelectSession={listOnSelectSession}
                  onDeleteSession={listOnDeleteSession}
                  onTogglePin={listOnTogglePin}
                  onRenameSession={listOnRenameSession}
                  emptyText={i18nService.t('coworkEmptyGroup')}
                  language={language}
                />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-1 flex-col pb-2" data-home-section="records">
              {/* Layer 2 - session SCOPE of the record list. It sits strictly
                  BELOW the record-type row; two scopes only. */}
              <div className="shrink-0 pb-2">
                <div
                  data-slot="home-session-scope"
                  role="group"
                  aria-label={i18nService.t('coworkHistory')}
                  className="grid w-full grid-cols-2 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
                >
                  {TASK_RECORD_TABS.map((tab, index) => {
                    const isActive = taskRecordTab === tab.id;
                    const stats = tabStats[tab.id];
                    // Per-tab item count is only shown on hover, as a tip under
                    // the tab; the label itself stays clean. Edge tabs align the
                    // tip to the outer edge so it never clips at the boundary.
                    const countTip = i18nService
                      .t('coworkTabCountChats')
                      .replace('{count}', String(stats.count));
                    const tooltipAlign = index === 0
                      ? 'left-0'
                      : index === TASK_RECORD_TABS.length - 1
                        ? 'right-0'
                        : 'left-1/2 -translate-x-1/2';
                    return (
                      <button
                        key={tab.id}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => handleSetTaskRecordTab(tab.id)}
                        className={`non-draggable group relative inline-flex h-7 min-w-0 items-center justify-center gap-1 rounded-md px-1 text-xs font-medium leading-none transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                          isActive
                            // Scope tab, aesthetic pass 2026-11-08: this used
                            // the primary-button class, whose fixed rem padding
                            // and 2px offset shadow are designed for a free-
                            // standing CTA — inside a 2-segment grid the pill
                            // overflowed its cell and grew a grey second edge.
                            // The fill comes straight from the accent tokens
                            // now, same as the batch-confirm button beside it.
                            ? 'bg-claude-accent text-claude-accentInk'
                            : 'text-claude-textSecondary hover:bg-claude-surfaceHover/70 hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover/70 dark:hover:text-claude-darkText'
                        }`}
                      >
                        {stats.unread > 0 && (
                          <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" aria-hidden />
                        )}
                        <span className="truncate">{i18nService.t(tab.labelKey)}</span>
                        <span
                          className={`pointer-events-none absolute top-full mt-1.5 z-50 ${tooltipAlign} whitespace-nowrap rounded-md border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2 py-1 text-[11px] font-normal leading-none dark:text-claude-darkText text-claude-text shadow-lg opacity-0 transition-opacity duration-150 group-hover:opacity-100`}
                          aria-hidden
                        >
                          {countTip}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* Toolbar row above the list: current view label on the left,
                  filter & sort + batch archive on the right. The same controls
                  on both faces — putting sessions away is a list operation,
                  not a local-face privilege. Fixed with the header; only the
                  list scrolls. */}
              {hasFaceSessions && (
                <div className="flex shrink-0 items-center justify-between gap-1.5 px-2 pb-1.5">
                  <span className="min-w-0 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t(faceViewMode === 'bot' ? 'sessionViewByBot' : 'sessionViewTimeline')}
                  </span>
                  <div className="flex items-center gap-1.5">
                    {isBatchArchiveMode ? (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleConfirmBatchArchive()}
                          disabled={batchSelectedIds.length === 0}
                          className="inline-flex h-6 items-center rounded-md bg-claude-accent px-2.5 text-xs font-medium text-claude-accentInk transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {i18nService.t('batchArchiveConfirm')}
                          {batchSelectedIds.length > 0 ? ` (${batchSelectedIds.length})` : ''}
                        </button>
                        <Tooltip content={i18nService.t('batchArchiveCancel')} position="bottom">
                          <button
                            type="button"
                            onClick={handleExitBatchArchiveMode}
                            aria-label={i18nService.t('batchArchiveCancel')}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
                          >
                            <XMarkIcon className="h-4 w-4" />
                          </button>
                        </Tooltip>
                      </>
                    ) : (
                      <>
                        <Tooltip content={i18nService.t('sessionViewFilterSort')} position="bottom">
                          <button
                            ref={viewMenuButtonRef}
                            type="button"
                            onClick={() => setIsViewMenuOpen((open) => !open)}
                            aria-label={i18nService.t('sessionViewFilterSort')}
                            aria-haspopup="menu"
                            aria-expanded={isViewMenuOpen}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
                          >
                            <FilterLinesIcon className="h-4 w-4" />
                          </button>
                        </Tooltip>
                        <Tooltip content={i18nService.t('batchArchive')} position="bottom">
                          <button
                            type="button"
                            onClick={handleEnterBatchArchiveMode}
                            aria-label={i18nService.t('batchArchive')}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
                          >
                            <ArchiveBoxIcon className="h-4 w-4" />
                          </button>
                        </Tooltip>
                      </>
                    )}
                  </div>
                </div>
              )}
              <SessionViewOptionsMenu
                anchorRef={viewMenuButtonRef}
                open={isViewMenuOpen && !isBatchArchiveMode}
                onClose={() => setIsViewMenuOpen(false)}
                viewMode={faceViewMode}
                sortMode={sessionSortMode}
                onViewModeChange={handleSetFaceViewMode}
                onSortModeChange={handleSetSessionSortMode}
              />
              {/* Scrollable list area */}
              <div className="min-h-0 flex-1 overflow-y-auto pb-4">
                <CoworkSessionList
                  sessions={localListSessions}
                  currentSessionId={currentSessionId}
                  onSelectSession={listOnSelectSession}
                  onDeleteSession={listOnDeleteSession}
                  onTogglePin={listOnTogglePin}
                  onMoveSessionToSection={taskRecordTab === 'local' ? listOnMoveSessionToSection : undefined}
                  onRenameSession={listOnRenameSession}
                  emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
                  selectionMode={isBatchArchiveMode}
                  selectedSessionIds={batchSelectedIds}
                  onToggleSessionSelected={listOnToggleSessionSelected}
                  /** Both faces render the SAME by-Bot grouped template and
                   * default to 按 Bot; each keeps its own remembered choice. */
                  viewMode={faceViewMode}
                  sortMode={sessionSortMode}
                  groupFace={taskRecordTab}
                  language={language}
                  /** Local chats: the machine-started runs (long-term task,
                   * orchestration, scheduled) that need no human follow-up fold
                   * into one collapsed folder below the Follow-Up section
                   * instead of mixing into the human list. */
                  autoSessions={taskRecordTab === 'local' ? localAutoSessions : undefined}
                  /** Local chats: sessions awaiting a human decision or reply
                   * (persisted pending marker or a live board decision owed)
                   * render in the Follow-Up section above the fold. */
                  followUpSessions={taskRecordTab === 'local' ? localFollowUpSessions : undefined}
                  decisionSessionIds={taskRecordTab === 'local' ? decisionSessionIds : undefined}
                  /** The trailing + on a bot group header starts a new task with
                   * that bot. Same action and same handler on BOTH faces — the
                   * template is shared, not re-implemented per face. */
                  onQuickCreateTask={handleQuickCreateTask}
                />
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col px-2.5 pb-3 pt-1">
          <BotBrowserCoworkPanel
            onShowSkills={onShowSkills}
            onOpenNewProject={() => onShowSettings({ initialTab: 'projects', openNewProjectForm: true })}
            onOpenBotHome={onSelectHome}
            historyOpen={panelHistoryOpen}
            onHistoryOpenChange={setPanelHistoryOpen}
          />
        </div>
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={homeSessions}
        scopedSessions={tabbedSessions}
        scopeLabel={i18nService.t(activeTaskRecordTab.labelKey)}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onMoveSessionToSection={handleMoveSessionToSection}
        onRenameSession={handleRenameSession}
      />
      {/* The user page overlay. Mounted by whichever face is on screen, so
          App.tsx (and the keep-alive Bot Browser pane it hosts) stays
          untouched. */}
      <UserProfilePage />
    </aside>
  );
};

export default Sidebar;
