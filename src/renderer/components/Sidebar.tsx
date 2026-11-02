import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { groupTaskService } from '../services/groupTaskService';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import SessionViewOptionsMenu from './cowork/SessionViewOptionsMenu';
import GroupTaskSidebarList, { type GroupTaskTypeVariant } from './groupTasks/GroupTaskSidebarList';
import {
  OPEN_TEAM_COLLAB_POLL_INTERVAL_MS,
  OpenTeamCollabSidebarRow,
} from './groupTasks/OpenTeamCollabsSection';
import { openTeamCollabService } from '../services/openTeamCollabService';
import { splitGroupTasksByOpenTeam } from './groupTasks/groupTaskUtils.js';
import { selectCollab, selectTask as selectGroupTask } from '../store/slices/groupTasksSlice';
import { clearCurrentSession, setNewTaskMetabotId } from '../store/slices/coworkSlice';
import type { OpenTeamCollabSummary } from '../types/openTeamCollab';
import {
  buildUnifiedTaskList,
  extractGroupTask,
  getUnifiedTaskType,
  type UnifiedTaskItem,
} from '../utils/unifiedTaskList';
import { MagnifyingGlassIcon, ClockIcon, CpuChipIcon, ShoppingBagIcon, UserGroupIcon, GlobeAltIcon, ArchiveBoxIcon, XMarkIcon } from '@heroicons/react/24/outline';
import Tooltip from './ui/Tooltip';
import ComposeIcon from './icons/ComposeIcon';
import FilterLinesIcon from './icons/FilterLinesIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import BackgroundTasksBadge from './cowork/BackgroundTasksBadge';
import { getSidebarInternetNavModel, getSidebarPrimaryNavModel } from './sidebar/sidebarNavigation.js';
import { SleepGuardBadge } from './SleepGuardBadge';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import BotBrowserCoworkPanel from '../features/botBrowser/BotBrowserCoworkPanel';
import { defaultSidebarWidth } from '../utils/sidebarWidth';
import type { BotBrowserSurfaceMode, BotInternetPane } from '../features/botBrowser/types';
import type { CoworkSessionSummary } from '../types/cowork';
import type {
  SessionSortMode,
  SessionViewMode,
} from '../utils/sessionViewGrouping';
import { shouldFoldIntoAutonomousTasks, splitSessionsWithFollowUp } from '../utils/sessionAutoGrouping';
import type { SessionSidebarSection } from '../utils/sessionAutoGrouping';
import { useStableCallback } from '../utils/useStableCallback';
import { selectTrackedTasksNeedingAttention } from '../utils/trackedTaskAttention';
import type { SettingsOpenOptions } from './Settings';

interface SidebarProps {
  onShowSettings: (options?: SettingsOpenOptions) => void;
  onShowLogin?: () => void;
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'groupTasks' | 'metabots';
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowGroupTasks: () => void;
  onShowMetabots: () => void;
  onNewChat: () => void;
  mode: BotBrowserSurfaceMode;
  internetPane: BotInternetPane;
  onSelectHome: () => void;
  onSelectBrowser: () => void;
  onSelectInternetPane: (pane: BotInternetPane) => void;
  /** Open a browser-type session back in the Bot Browser co-work surface.
   * Browser sessions are listed in the Bot Home history (one list, no dead
   * ends), but they run in the Bot Browser panel — selecting one must return
   * the user there instead of the home chat view. */
  onSelectBrowserSession?: (sessionId: string) => void | Promise<void>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Expanded sidebar width in px (resizable by the user). */
  width?: number;
  /** True while the user is dragging the resize handle; disables the width transition for lag-free dragging. */
  isResizing?: boolean;
  updateBadge?: React.ReactNode;
}

/**
 * Task-record list categories: standard human↔MetaBot chats, A2A MetaBot↔MetaBot
 * chats, and group-task chat channels (session_type = 'group_task', created by
 * the Group Task daemon). The sidebar keeps them in separate tabs so the
 * history list does not mix unrelated conversation kinds.
 */
type TaskRecordTab = 'local' | 'a2a' | 'group';

const TASK_RECORD_TABS: Array<{ id: TaskRecordTab; labelKey: string; emptyKey: string }> = [
  { id: 'local', labelKey: 'coworkTabLocal', emptyKey: 'coworkEmptyLocal' },
  { id: 'a2a', labelKey: 'coworkTabA2A', emptyKey: 'coworkEmptyA2A' },
  { id: 'group', labelKey: 'coworkTabGroup', emptyKey: 'coworkEmptyGroup' },
];

/** localStorage key for the remembered task-record tab. */
const TASK_RECORD_TAB_STORAGE_KEY = 'taskRecordTab';

const loadTaskRecordTab = (): TaskRecordTab => {
  try {
    const stored = window.localStorage.getItem(TASK_RECORD_TAB_STORAGE_KEY);
    if (stored === 'a2a' || stored === 'group') return stored;
  } catch {
    // localStorage unavailable; fall through to the default tab.
  }
  return 'local';
};

/** localStorage keys for the local-chats list view ("filter & sort") choices. */
const SESSION_VIEW_MODE_STORAGE_KEY = 'sessionViewMode';
const SESSION_SORT_MODE_STORAGE_KEY = 'sessionSortMode';

const loadSessionViewMode = (): SessionViewMode => {
  try {
    const stored = window.localStorage.getItem(SESSION_VIEW_MODE_STORAGE_KEY);
    // 'project' is the retired directory-based view; its closest successor is
    // the by-Bot view, so the stored choice carries over instead of snapping
    // back to the timeline default.
    if (stored === 'project') return 'bot';
    if (stored === 'bot') return 'bot';
  } catch {
    // localStorage unavailable; fall through to the default view.
  }
  return 'timeline';
};

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
  activeView,
  onShowSkills,
  onShowCowork,
  onShowScheduledTasks,
  onShowGroupTasks,
  onShowMetabots,
  onNewChat,
  mode,
  internetPane,
  onSelectHome,
  onSelectBrowser,
  onSelectInternetPane,
  onSelectBrowserSession,
  isCollapsed,
  onToggleCollapse,
  width = defaultSidebarWidth('home'),
  isResizing = false,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  // Bot Home history lists EVERY cowork session, including the Bot Browser
  // co-work sessions (session_type = 'browser'). They are ordinary cowork
  // sessions the user can come back to; the browser surface only supplies the
  // panel they were started from. Hiding them here left a browser chat with no
  // entry point once the user switched away from Bot Browser. They are shown
  // in the "local chats" tab and carry a type badge (see CoworkSessionItem),
  // and selecting one routes back to the Bot Browser surface (see
  // handleSelectSession below).
  const homeSessions = sessions;
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const groupTasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const selectedGroupTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  // Joined OpenTeam collabs for the records "Group Tasks" tab (remote-hosted
  // tasks this machine's bots participate in; loaded/polled only while that
  // tab is visible).
  const [openTeamCollabs, setOpenTeamCollabs] = useState<OpenTeamCollabSummary[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const dispatch = useDispatch();
  // Which task-record category the home history list shows. Persisted across
  // app restarts; the header + tabs stay fixed while only the list scrolls.
  const [taskRecordTab, setTaskRecordTab] = useState<TaskRecordTab>(loadTaskRecordTab);
  // Batch-archive selection mode for the local-chats list. The toolbar row
  // above the list hosts this and the view "filter & sort" controls.
  const [isBatchArchiveMode, setIsBatchArchiveMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  // View + sort choices for the local-chats list, persisted across app
  // restarts; the menu itself is a transient popover anchored to the toolbar.
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(loadSessionViewMode);
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>(loadSessionSortMode);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);
  const handleSetSessionViewMode = (mode: SessionViewMode) => {
    setSessionViewMode(mode);
    try {
      window.localStorage.setItem(SESSION_VIEW_MODE_STORAGE_KEY, mode);
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
  // Sessions grouped by category: local (human↔MetaBot, including browser
  // sessions started from the Bot Browser panel), a2a (MetaBot↔MetaBot), group
  // (group-task chat channels). a2a / group_task keep their dedicated tabs and
  // are matched by their own session type, so browser sessions can never leak
  // into them.
  const sessionGroups = useMemo(() => {
    // IM rows belong to the LOCAL list even when an older row is still stored
    // as 'a2a' (direct IM chats used to be created that way). The mapping
    // channel is the display source of truth, so this is a render-time
    // reclassification — no data migration.
    const isImSession = (session: CoworkSessionSummary) => Boolean(session.imChannel);
    const isLocal = (session: CoworkSessionSummary) =>
      session.sessionType !== 'group_task'
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

  // Extract only the GroupTaskSummary items for GroupTaskSidebarList (filters
  // out collabs, which render as OpenTeamCollabSidebarRow).
  const groupTaskItems = useMemo(
    () => unifiedTaskList.map(extractGroupTask).filter((task): task is NonNullable<typeof task> => task !== null),
    [unifiedTaskList],
  );

  // Type lookup for each task id (used by GroupTaskSidebarList).
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
      group: { count: groupTasks.length + openTeamCollabs.length, unread: unreadOf(sessionGroups.group) },
    };
  }, [sessionGroups, localHumanSessions, localFollowUpSessions, unreadSessionIds, groupTasks, openTeamCollabs]);
  const isMac = window.electron.platform === 'darwin';
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running'
  );
  // The 跟踪任务 nav entry's dot: a parked owner decision (waiting_owner) is the
  // stronger signal, and the board behind it is kept live app-wide (App.tsx
  // init) so the dot is correct even if the 长期任务 tab was never opened.
  // (longTermBoard itself is selected above, where the fold split needs it.)
  const trackedTaskAttention = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }),
    [longTermBoard],
  );
  // Labels come from i18nService at call time, so the language is an input of
  // every memo below (and of the session list): this component re-renders on a
  // language switch through App's i18n subscription, and the memo has to see
  // the new language to rebuild what it cached.
  const language = i18nService.getLanguage();
  // The nav models only change when something they actually show changes —
  // rebuilding both on every sidebar render (board pushes, unread changes) was
  // wasted work and a fresh array identity for the nav lists each time.
  const primaryNavItems = useMemo(
    () =>
      getSidebarPrimaryNavModel({
        t: (key) => i18nService.t(key),
        hasRunningScheduledTask,
        needsDecisionCount: trackedTaskAttention.total,
      }).filter((item) => !item.hidden),
    [hasRunningScheduledTask, trackedTaskAttention.total, language],
  );
  const internetNavItems = useMemo(
    () => getSidebarInternetNavModel({ t: (key) => i18nService.t(key) }).filter((item) => !item.hidden),
    [language],
  );

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

  useEffect(() => {
    if (taskRecordTab !== 'group') return;
    void groupTaskService.loadTasks();
  }, [taskRecordTab]);

  // Collab rows ride the same tab gate: load on entering the tab, then poll so
  // new remote collaborations surface without leaving the sidebar.
  useEffect(() => {
    if (taskRecordTab !== 'group') return;
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
  }, [taskRecordTab]);

  // Leaving the local tab ends any batch-archive selection in progress.
  useEffect(() => {
    if (taskRecordTab === 'local') return;
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
    // Only archive ids still present in the local list (a session may have
    // been archived individually while selection mode was open).
    const archivableIds = batchSelectedIds.filter((id) =>
      sessionGroups.local.some((session) => session.id === id),
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
   *  - to the normal list: an auto-created run (the fold's own policy put it
   *    there) needs an explicit 'out' to survive the policy, a row with no
   *    policy pull only has to drop its override back to null; the follow-up
   *    marker is cleared either way (clearSessionFollowUp clears ANY pending
   *    source main-side — the same manual move-out the old menu performed).
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
      await coworkService.setSessionFoldOverride(
        sessionId,
        shouldFoldIntoAutonomousTasks(session) ? 'out' : null,
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

  const handlePrimaryNavClick = (itemId: string) => {
    setIsSearchOpen(false);
    if (itemId === 'scheduledTasks') {
      onShowScheduledTasks();
      return;
    }
    if (itemId === 'groupTasks') {
      // The nav entry is a fixed home-page entry point: never re-open whatever
      // task/collab was drilled into last time.
      dispatch(selectGroupTask(null));
      onShowGroupTasks();
      return;
    }
    if (itemId === 'metabots') {
      onShowMetabots();
    }
  };

  const renderNavIcon = (icon: string) => {
    if (icon === 'clock') return <ClockIcon className="h-4 w-4" />;
    if (icon === 'userGroup') return <UserGroupIcon className="h-4 w-4" />;
    if (icon === 'shoppingBag') return <ShoppingBagIcon className="h-4 w-4 shrink-0" />;
    if (icon === 'globe') return <GlobeAltIcon className="h-4 w-4" />;
    if (icon === 'squares2x2') return <MagnifyingGlassIcon className="h-4 w-4 opacity-0 absolute pointer-events-none" />;
    return <CpuChipIcon className="h-4 w-4" />;
  };

  const renderNavContent = (item: {
    id: string;
    label: string;
    hasIndicator?: boolean;
    indicatorKind?: 'running' | 'decision';
    indicatorLabel?: string;
    badge?: string;
  }) => {
    if (item.id === 'scheduledTasks') {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          {item.hasIndicator ? (
            item.indicatorKind === 'decision' ? (
              // A parked owner decision: same amber family as the running dot,
              // but its own class so the two meanings stay distinguishable in
              // the DOM/CSS, and labelled — this dot means "you are the
              // blocker", not "work is happening".
              <span
                role="img"
                aria-label={item.indicatorLabel}
                title={item.indicatorLabel}
                className="tracked-task-decision-indicator shrink-0"
              />
            ) : (
              <span
                aria-hidden
                className="scheduled-task-running-indicator shrink-0"
              />
            )
          ) : null}
          <span className="truncate">{item.label}</span>
        </span>
      );
    }

    if (item.id === 'gigSquare') {
      return (
        <span className="inline-flex items-center gap-1 min-w-0">
          <span className="truncate">{item.label}</span>
          <span
            className="shrink-0 rounded px-0.5 py-px text-[9px] font-medium leading-none text-claude-textSecondary dark:text-claude-darkTextSecondary border border-claude-border dark:border-claude-darkBorder bg-claude-surfaceMuted dark:bg-claude-darkSurfaceMuted"
            aria-hidden
          >
            {item.badge}
          </span>
        </span>
      );
    }

    return <span className="truncate">{item.label}</span>;
  };

  const renderPrimaryNavIcon = (item: { icon: string }) => {
    if (item.icon === 'squares2x2') {
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-4 w-4"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    }

    return renderNavIcon(item.icon);
  };

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col overflow-hidden ${
        isResizing ? '' : 'sidebar-transition'
      }`}
      style={{ width: isCollapsed ? 0 : width }}
    >
      <div className="pt-3 pb-3">
        <div className="draggable sidebar-header-drag h-8 flex items-center px-3">
          <button
            type="button"
            onClick={onToggleCollapse}
            className={`non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors ${isMac ? 'ml-[68px]' : ''}`}
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
          <div className="ml-auto">
            {updateBadge}
          </div>
        </div>
        <div className="mt-3 px-3">
          <BotBrowserModeSwitch
            mode={mode}
            onSelectHome={onSelectHome}
            onSelectBrowser={onSelectBrowser}
          />
        </div>
        {mode === 'browser' ? (
          <nav aria-label={i18nService.t('botInternet')} className="mt-3 space-y-1 px-3">
            {internetNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-pressed={internetPane === item.id}
                onClick={() => onSelectInternetPane(item.id as BotInternetPane)}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  internetPane === item.id
                    ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {renderPrimaryNavIcon(item)}
                {renderNavContent(item)}
              </button>
            ))}
          </nav>
        ) : (
          <nav aria-label={i18nService.t('botHome')} className="mt-3 space-y-1 px-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onNewChat}
                className="flex-1 inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
                {i18nService.t('newChat')}
              </button>
              <button
                type="button"
                onClick={() => {
                  onShowCowork();
                  setIsSearchOpen(true);
                }}
                className="shrink-0 h-[36px] w-[36px] inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                aria-label={i18nService.t('search')}
              >
                <MagnifyingGlassIcon className="h-4 w-4" />
              </button>
            </div>
            {primaryNavItems.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => handlePrimaryNavClick(item.id)}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === item.id
                    ? 'dark:text-claude-darkText text-claude-text dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {renderPrimaryNavIcon(item)}
                {renderNavContent(item)}
              </button>
            ))}
          </nav>
        )}
      </div>
      {mode === 'home' ? (
        <div className="flex-1 min-h-0 flex flex-col px-2.5 pt-2 mt-1">
          {/* Fixed header + tabs; only the list below scrolls. */}
          <div className="px-3 pb-2 shrink-0">
            <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkHistory')}
            </div>
            <div
              role="group"
              aria-label={i18nService.t('coworkHistory')}
              className="grid w-full grid-cols-3 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 mt-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
            >
              {TASK_RECORD_TABS.map((tab, index) => {
                const isActive = taskRecordTab === tab.id;
                const stats = tabStats[tab.id];
                // Per-tab item count is only shown on hover, as a tip under the
                // tab; the label itself stays clean. Edge tabs align the tip to
                // the outer edge so it never clips at the sidebar boundary.
                const countTipKey = tab.id === 'group' ? 'coworkTabCountGroup' : 'coworkTabCountChats';
                const countTip = i18nService.t(countTipKey).replace('{count}', String(stats.count));
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
                        ? 'btn-idchat-primary-filled still'
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
          {/* Toolbar row above the local list: current view label on the
              left, filter & sort + batch archive on the right. Fixed with the
              header; only the list scrolls. */}
          {taskRecordTab === 'local' && localHumanSessions.length > 0 && (
            <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5 shrink-0">
              <span className="min-w-0 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t(sessionViewMode === 'bot' ? 'sessionViewByBot' : 'sessionViewTimeline')}
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
                        className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText"
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
                        className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-claude-accent/10 hover:text-claude-accent dark:text-claude-darkTextSecondary"
                      >
                        <FilterLinesIcon className="h-4 w-4" />
                      </button>
                    </Tooltip>
                    <Tooltip content={i18nService.t('batchArchive')} position="bottom">
                      <button
                        type="button"
                        onClick={handleEnterBatchArchiveMode}
                        aria-label={i18nService.t('batchArchive')}
                        className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-claude-accent/10 hover:text-claude-accent dark:text-claude-darkTextSecondary"
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
            open={isViewMenuOpen && taskRecordTab === 'local' && !isBatchArchiveMode}
            onClose={() => setIsViewMenuOpen(false)}
            viewMode={sessionViewMode}
            sortMode={sessionSortMode}
            onViewModeChange={handleSetSessionViewMode}
            onSortModeChange={handleSetSessionSortMode}
          />
          {/* Scrollable list area */}
          <div className="flex-1 min-h-0 overflow-y-auto pb-4">
            {taskRecordTab === 'group' ? (
              unifiedTaskList.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t(activeTaskRecordTab.emptyKey)}
                  </p>
                </div>
              ) : (
                <div className="space-y-1">
                  <GroupTaskSidebarList
                    tasks={groupTaskItems}
                    selectedTaskId={selectedGroupTaskId}
                    onSelectTask={handleSelectGroupTask}
                    onTogglePin={handleToggleGroupTaskPin}
                    onRename={handleRenameGroupTask}
                    onArchive={handleArchiveGroupTask}
                    emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
                    getTaskType={(task) => taskTypeById.get(task.id) ?? 'local'}
                  />
                  {unifiedTaskList.map((item) => {
                    if (item.kind === 'openteam-guest') {
                      return (
                        <OpenTeamCollabSidebarRow
                          key={`collab-${item.collab.id}`}
                          collab={item.collab}
                          onSelect={() => handleSelectOpenTeamCollab(item.collab.id)}
                        />
                      );
                    }
                    return null;
                  })}
                </div>
              )
                </div>
              )
            ) : (
              <CoworkSessionList
                sessions={localListSessions}
                currentSessionId={currentSessionId}
                onSelectSession={listOnSelectSession}
                onDeleteSession={listOnDeleteSession}
                onTogglePin={listOnTogglePin}
                onMoveSessionToSection={taskRecordTab === 'local' ? listOnMoveSessionToSection : undefined}
                onRenameSession={listOnRenameSession}
                emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
                selectionMode={isBatchArchiveMode && taskRecordTab === 'local'}
                selectedSessionIds={batchSelectedIds}
                onToggleSessionSelected={listOnToggleSessionSelected}
                viewMode={taskRecordTab === 'local' ? sessionViewMode : undefined}
                sortMode={taskRecordTab === 'local' ? sessionSortMode : undefined}
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
                /** Online chats: the Bot selector is this list's only
                 * selector, so it is switched on here — nothing else changes. */
                botSelector={taskRecordTab === 'a2a'}
                /** Quick-create task with selected bot. */
                onQuickCreateTask={taskRecordTab === 'local' ? handleQuickCreateTask : undefined}
              />
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 px-2.5 pb-3 pt-2 mt-1 flex flex-col">
          <BotBrowserCoworkPanel
            onShowSkills={onShowSkills}
            onOpenNewProject={() => onShowSettings({ initialTab: 'projects', openNewProjectForm: true })}
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
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onShowSettings()}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-text dark:hover:text-claude-darkText hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('settings')}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
              <path d="M14 17H5" />
              <path d="M19 7h-9" />
              <circle cx="17" cy="17" r="3" />
              <circle cx="7" cy="7" r="3" />
            </svg>
            {i18nService.t('settings')}
          </button>
          <BackgroundTasksBadge onShowGroupTasks={onShowGroupTasks} />
          <SleepGuardBadge />
        </div>
      </div>
    </aside>
  );
};

export default Sidebar;
