import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
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
import { clearCurrentSession, setNewTaskMetabotId } from '../store/slices/coworkSlice';
import type { OpenTeamCollabSummary } from '../types/openTeamCollab';
import { buildUnifiedTaskList } from '../utils/unifiedTaskList';
import {
  ArchiveBoxIcon,
  ClockIcon,
  CpuChipIcon,
  MagnifyingGlassIcon,
  UserGroupIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import Tooltip from './ui/Tooltip';
import ComposeIcon from './icons/ComposeIcon';
import FilterLinesIcon from './icons/FilterLinesIcon';
import PanelToggleIcon from './icons/PanelToggleIcon';
import BackgroundTasksBadge from './cowork/BackgroundTasksBadge';
import { SleepGuardBadge } from './SleepGuardBadge';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import MeBalanceBadge from './me/MeBalanceBadge';
import { getSidebarPrimaryNavModel } from './sidebar/sidebarNavigation.js';
import { selectTrackedTasksNeedingAttention } from '../utils/trackedTaskAttention';
import { defaultSidebarWidth } from '../utils/sidebarWidth';
import type { BotBrowserSurfaceMode } from '../features/botBrowser/types';
import type { CoworkSessionSummary } from '../types/cowork';
import type {
  SessionSortMode,
  SessionViewMode,
} from '../utils/sessionViewGrouping';
import { shouldFoldIntoAutonomousTasks, splitSessionsWithFollowUp } from '../utils/sessionAutoGrouping';
import type { SessionSidebarSection } from '../utils/sessionAutoGrouping';
import { loadSessionViewMode, saveSessionViewMode } from '../utils/sessionGroupStorage';
import { useStableCallback } from '../utils/useStableCallback';
import type { SettingsOpenOptions } from './Settings';

/**
 * The restored Bot Home sidebar (owner ruling 2026-11-08 14:22: "Bot home 界面
 * 先恢复到原来的状态，目前的 bot internet 界面的改动不变").
 *
 * This is the baseline (pre-three-column) Home composition, not a new design:
 *
 *   header (collapse toggle + update badge)
 *   surface switcher (the SAME Codex×IDBots capsule; original sidebar-top slot)
 *   text MENU: 新建任务 / 长期任务 / 多人任务 / 我的 Bot
 *   records block: 任务记录 header + local/online/group tabs + list
 *   footer: Settings + background/sleep badges + ME balance
 *
 * The Bot Internet surface keeps the three-column shell (rail + mid column +
 * browser/panel) untouched; this component is mounted only while
 * `surfaceMode === 'home'`, and `Sidebar.tsx` keeps its mid-column role for
 * the Internet face.
 *
 * FUSION (carried over from the accepted 6165d6449 work, not re-implemented):
 *   · the records list defaults to the by-Bot grouped template — collapsible
 *     group header (avatar + name), trailing + that starts a new task with
 *     that bot, no empty groups on the online face;
 *   · the grouping + collapsed-group memories keep their per-face storage
 *     keys (`idbots.sessionViewMode.*` / `idbots.sessionGroups.*`);
 *   · the amber 「待拍板」 dot is back on the 长期任务 row, same derivation
 *     (selectTrackedTasksNeedingAttention), same condition (total > 0), same
 *     class (`tracked-task-decision-indicator`).
 *
 * The record-type DRAWER does not come back: the selector is the tab row above
 * the list (text entry point), as the owner ruled when retiring the drawer.
 */

/** The three baseline record scopes. `group` is the group-task chat channels. */
type TaskRecordTab = 'local' | 'a2a' | 'group';

const TASK_RECORD_TABS: Array<{ id: TaskRecordTab; labelKey: string; emptyKey: string }> = [
  { id: 'local', labelKey: 'coworkTabLocal', emptyKey: 'coworkEmptyLocal' },
  { id: 'a2a', labelKey: 'coworkTabA2A', emptyKey: 'coworkEmptyA2A' },
  { id: 'group', labelKey: 'coworkTabGroup', emptyKey: 'coworkEmptyGroup' },
];

/** localStorage key for the remembered record tab (shared with the baseline). */
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

/** localStorage key for the list sort choice; the VIEW choice (按 Bot /
 * 按时间线) is per face and lives in utils/sessionGroupStorage.ts — the local
 *  and online lists must not share one grouping preference. */
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

interface HomeSidebarProps {
  /** The main view currently on the right; drives the row highlight. */
  activeView: 'cowork' | 'skills' | 'scheduledTasks' | 'groupTasks' | 'metabots';
  onShowSettings: (options?: SettingsOpenOptions) => void;
  onShowCowork: () => void;
  onShowScheduledTasks: () => void;
  onShowGroupTasks: () => void;
  onShowMetabots: () => void;
  onNewChat: () => void;
  mode: BotBrowserSurfaceMode;
  /** Return to the Home surface from the switcher menu. */
  onSelectHome: () => void;
  /** Switch surface (the switcher's two transitions). */
  onSelectSurface: (mode: BotBrowserSurfaceMode) => void;
  /** Open a browser-type session back in the Bot Browser co-work surface. */
  onSelectBrowserSession?: (sessionId: string) => void | Promise<void>;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  /** Expanded sidebar width in px (resizable by the user). */
  width?: number;
  /** True while the user drags the resize handle; disables the width transition. */
  isResizing?: boolean;
  updateBadge?: React.ReactNode;
}

const HomeSidebar: React.FC<HomeSidebarProps> = ({
  activeView,
  onShowSettings,
  onShowCowork,
  onShowScheduledTasks,
  onShowGroupTasks,
  onShowMetabots,
  onNewChat,
  mode,
  onSelectHome,
  onSelectSurface,
  onSelectBrowserSession,
  isCollapsed,
  onToggleCollapse,
  width = defaultSidebarWidth('home'),
  isResizing = false,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const groupTasks = useSelector((state: RootState) => state.groupTasks.tasks);
  const selectedGroupTaskId = useSelector((state: RootState) => state.groupTasks.selectedTaskId);
  const selectedCollabId = useSelector((state: RootState) => state.groupTasks.selectedCollabId);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const dispatch = useDispatch();

  const [openTeamCollabs, setOpenTeamCollabs] = useState<OpenTeamCollabSummary[]>([]);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [taskRecordTab, setTaskRecordTab] = useState<TaskRecordTab>(loadTaskRecordTab);
  const [isBatchArchiveMode, setIsBatchArchiveMode] = useState(false);
  const [batchSelectedIds, setBatchSelectedIds] = useState<string[]>([]);
  const [sessionViewMode, setSessionViewMode] = useState<SessionViewMode>(() =>
    loadSessionViewMode((key) => window.localStorage.getItem(key), 'local'),
  );
  const [a2aViewMode, setA2aViewMode] = useState<SessionViewMode>(() =>
    loadSessionViewMode((key) => window.localStorage.getItem(key), 'a2a'),
  );
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>(loadSessionSortMode);
  const [isViewMenuOpen, setIsViewMenuOpen] = useState(false);
  const viewMenuButtonRef = useRef<HTMLButtonElement>(null);

  // Bot Home history is backed by the full session list (search spans it);
  // browser co-work sessions are filtered out of the local bucket below and
  // remain reachable from the Bot Internet panel + from search rows, which
  // route back to that surface.
  const homeSessions = sessions;

  const handleSetSessionViewMode = (next: SessionViewMode) => {
    setSessionViewMode(next);
    try {
      saveSessionViewMode(
        (storageKey, value) => window.localStorage.setItem(storageKey, value),
        'local',
        next,
      );
    } catch {
      // localStorage unavailable; the view still switches for this session.
    }
  };
  const handleSetA2aViewMode = (next: SessionViewMode) => {
    setA2aViewMode(next);
    try {
      saveSessionViewMode(
        (storageKey, value) => window.localStorage.setItem(storageKey, value),
        'a2a',
        next,
      );
    } catch {
      // localStorage unavailable; the view still switches for this session.
    }
  };
  const handleSetSessionSortMode = (next: SessionSortMode) => {
    setSessionSortMode(next);
    try {
      window.localStorage.setItem(SESSION_SORT_MODE_STORAGE_KEY, next);
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

  // Sessions grouped by category: local (human↔MetaBot chats, EXCLUDING both
  // browser co-work sessions and group-task channels), a2a (MetaBot↔MetaBot),
  // group (group-task chat channels). IM rows belong to the LOCAL list even
  // when an older row is still stored as 'a2a' — the mapping channel is the
  // display source of truth, so this is a render-time reclassification.
  const sessionGroups = useMemo(() => {
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

  // Sessions currently owed an owner verdict (waiting_owner sub-projects' bound
  // sessions, board-derived): they land in the Follow-Up section.
  const decisionSessionIds = useMemo(
    () => new Set((longTermBoard?.cards ?? []).flatMap((card) => card.decisionSessionIds ?? [])),
    [longTermBoard],
  );
  const { humanSessions: localHumanSessions, followUpSessions: localFollowUpSessions, autoSessions: localAutoSessions } = useMemo(
    () => splitSessionsWithFollowUp(sessionGroups.local, decisionSessionIds),
    [sessionGroups.local, decisionSessionIds],
  );
  const localListSessions = taskRecordTab === 'local' ? localHumanSessions : sessionGroups[taskRecordTab];
  const tabbedSessions = sessionGroups[taskRecordTab];

  // Unified task list for the group-task tab: local group tasks + OpenTeam
  // collabs, newest first. Each item carries its type badge variant.
  const unifiedTaskList = useMemo(
    () => buildUnifiedTaskList(groupTasks, openTeamCollabs),
    [groupTasks, openTeamCollabs],
  );
  const taskTypeById = useMemo(() => {
    const map = new Map<number, GroupTaskTypeVariant>();
    for (const item of unifiedTaskList) {
      if (item.kind !== 'openteam-guest') {
        map.set(item.task.id, item.kind);
      }
    }
    return map;
  }, [unifiedTaskList]);

  const tabStats = useMemo(() => {
    const unreadSet = new Set(unreadSessionIds);
    const unreadOf = (list: CoworkSessionSummary[]) => list.filter((session) => unreadSet.has(session.id)).length;
    return {
      local: {
        count: localHumanSessions.length + localFollowUpSessions.length,
        unread: unreadOf(localHumanSessions) + unreadOf(localFollowUpSessions),
      },
      a2a: { count: sessionGroups.a2a.length, unread: unreadOf(sessionGroups.a2a) },
      group: { count: unifiedTaskList.length, unread: unreadOf(sessionGroups.group) },
    };
  }, [sessionGroups, localHumanSessions, localFollowUpSessions, unreadSessionIds, unifiedTaskList.length]);

  // The view mode of the face currently on screen, and its setter. Both faces
  // render the same grouped component; only the remembered choice differs.
  const faceViewMode = taskRecordTab === 'local' ? sessionViewMode : a2aViewMode;
  const handleSetFaceViewMode = taskRecordTab === 'local' ? handleSetSessionViewMode : handleSetA2aViewMode;
  const hasFaceSessions = taskRecordTab === 'local'
    ? localHumanSessions.length > 0
    : taskRecordTab === 'a2a'
      ? sessionGroups.a2a.length > 0
      : false;

  // The 长期任务 row's attention dot. Same derivation and condition as the
  // three-column rail's copy — the rail is not mounted on the Home face, so
  // this row is the dot's only home there.
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running',
  );
  const trackedTaskAttention = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }),
    [longTermBoard],
  );

  const language = i18nService.getLanguage();
  const primaryNavItems = useMemo(
    () =>
      getSidebarPrimaryNavModel({
        t: (key: string) => i18nService.t(key),
        hasRunningScheduledTask,
        needsDecisionCount: trackedTaskAttention.total,
      }).filter((item: { hidden?: boolean }) => !item.hidden),
    [hasRunningScheduledTask, trackedTaskAttention.total, language],
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

  // The group-task rows live in their own record tab again, so the load gate
  // follows the tab (baseline behaviour) instead of the removed rail section.
  useEffect(() => {
    if (taskRecordTab !== 'group') return;
    void groupTaskService.loadTasks();
  }, [taskRecordTab]);

  // Collab rows ride the same gate: load on entering the group tab, then poll
  // so new remote collaborations surface without leaving it.
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

  useEffect(() => {
    if (localHumanSessions.length > 0) return;
    setIsViewMenuOpen(false);
  }, [localHumanSessions.length]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
  }, [isCollapsed]);

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
   * Move a session to the Autonomous Tasks fold, the Follow-Up section, or the
   * normal list — the single write path behind the row menu's "Move to…".
   * See the long comment this was carried from in Sidebar.tsx: the fold
   * override outranks both the auto-origin policy and a live decision owed, so
   * a move back to the normal list writes an explicit 'out' whenever any lane
   * would pull the row out again.
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

  const listOnSelectSession = useStableCallback(handleSelectSession);
  const listOnDeleteSession = useStableCallback(handleDeleteSession);
  const listOnTogglePin = useStableCallback(handleTogglePin);
  const listOnMoveSessionToSection = useStableCallback(handleMoveSessionToSection);
  const listOnRenameSession = useStableCallback(handleRenameSession);
  const listOnToggleSessionSelected = useStableCallback(handleToggleBatchSelected);

  /** Quick-create a new task with the bot of a group header (the trailing +). */
  const handleQuickCreateTask = useStableCallback((botId: number) => {
    dispatch(clearCurrentSession());
    dispatch(setNewTaskMetabotId(botId));
    onShowCowork();
  });

  const handleSelectGroupTask = (taskId: number) => {
    onShowGroupTasks();
    dispatch(selectGroupTask(taskId));
  };

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
    return <CpuChipIcon className="h-4 w-4" />;
  };

  const renderNavContent = (item: {
    id: string;
    label: string;
    hasIndicator?: boolean;
    indicatorKind?: 'running' | 'decision';
    indicatorLabel?: string;
  }) => {
    if (item.id === 'scheduledTasks') {
      return (
        <span className="inline-flex min-w-0 items-center gap-2">
          {item.hasIndicator ? (
            item.indicatorKind === 'decision' ? (
              // A parked owner decision: the amber dot means "you are the
              // blocker", not "work is happening" — same class/style/condition
              // as the accepted decision-dot work.
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
    return <span className="truncate">{item.label}</span>;
  };

  return (
    <aside
      data-slot="workspace-home-sidebar"
      data-home-sidebar-face={mode}
      aria-label={i18nService.t('botHome')}
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
            <PanelToggleIcon className="h-4 w-4" collapsed={isCollapsed} />
          </button>
          <div className="ml-auto">
            {updateBadge}
          </div>
        </div>
        {/* Original switcher slot: the sidebar top, right under the drag
            header. The control itself is the accepted Codex-structure ×
            IDBots-token capsule — same component as the Internet header. */}
        <div className="mt-3 px-3">
          <BotBrowserModeSwitch
            mode={mode}
            onSelectHome={onSelectHome}
            onSelectBrowser={() => onSelectSurface('browser')}
          />
        </div>
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
          {primaryNavItems.map((item: {
            id: string;
            label: string;
            icon: string;
            hasIndicator?: boolean;
            indicatorKind?: 'running' | 'decision';
            indicatorLabel?: string;
          }) => (
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
              {renderNavIcon(item.icon)}
              {renderNavContent(item)}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 min-h-0 flex flex-col px-2.5 pt-2 mt-1">
        {/* Fixed header + tabs; only the list below scrolls. */}
        <div className="px-3 pb-2 shrink-0">
          <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('coworkHistory')}
          </div>
          <div
            data-slot="home-session-scope"
            role="group"
            aria-label={i18nService.t('coworkHistory')}
            className="grid w-full grid-cols-3 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 mt-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
          >
            {TASK_RECORD_TABS.map((tab, index) => {
              const isActive = taskRecordTab === tab.id;
              const stats = tabStats[tab.id];
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
        {/* Toolbar row above the list: current view label on the left,
            filter & sort (+ batch archive on the local face) on the right. */}
        {hasFaceSessions && (
          <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5 shrink-0">
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
                  {taskRecordTab === 'local' && (
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
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <SessionViewOptionsMenu
          anchorRef={viewMenuButtonRef}
          open={isViewMenuOpen && taskRecordTab !== 'group' && !isBatchArchiveMode}
          onClose={() => setIsViewMenuOpen(false)}
          viewMode={faceViewMode}
          sortMode={sessionSortMode}
          onViewModeChange={handleSetFaceViewMode}
          onSortModeChange={handleSetSessionSortMode}
        />
        {/* Scrollable list area */}
        <div className="flex-1 min-h-0 overflow-y-auto pb-4">
          {taskRecordTab === 'group' ? (
            <>
              {unifiedTaskList.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {i18nService.t(activeTaskRecordTab.emptyKey)}
                  </p>
                </div>
              ) : (
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
                  emptyText={i18nService.t(activeTaskRecordTab.emptyKey)}
                />
              )}
              {/* Group-task CHAT CHANNELS: the baseline group tab listed only
                  the task cards, which left standalone channels with no entry.
                  They stay listed here (fusion from the accepted reshuffle) so
                  every session_type='group_task' session remains reachable. */}
              <div
                data-slot="group-task-sessions"
                className="mt-1 border-t border-claude-border/60 pt-1 dark:border-claude-darkBorder/60"
              >
                <div className="px-2 pb-1 pt-1 text-[10px] font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
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
            </>
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
              /** Both faces render the SAME by-Bot grouped template and
               * default to 按 Bot; each keeps its own remembered choice. */
              viewMode={faceViewMode}
              sortMode={sessionSortMode}
              groupFace={taskRecordTab}
              language={language}
              /** Local chats: machine-started runs fold into one collapsed
               * "Autonomous Tasks" folder below the Follow-Up section. */
              autoSessions={taskRecordTab === 'local' ? localAutoSessions : undefined}
              /** Local chats: sessions awaiting a human decision or reply
               * render in the Follow-Up section above the fold. */
              followUpSessions={taskRecordTab === 'local' ? localFollowUpSessions : undefined}
              decisionSessionIds={taskRecordTab === 'local' ? decisionSessionIds : undefined}
              /** Online chats: the bot dropdown narrows WHICH bots' groups
               * are shown (全部 Bot by default). */
              botSelector={taskRecordTab === 'a2a'}
              /** The trailing + on a bot group header starts a new task with
               * that bot. Same action and same handler on BOTH faces. */
              onQuickCreateTask={handleQuickCreateTask}
            />
          )}
        </div>
      </div>

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
          <div className="ml-auto flex items-center gap-2">
            <BackgroundTasksBadge onShowGroupTasks={onShowGroupTasks} />
            <SleepGuardBadge />
            <MeBalanceBadge />
          </div>
        </div>
      </div>
    </aside>
  );
};

export default HomeSidebar;
