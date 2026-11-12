import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import SessionViewOptionsMenu from './cowork/SessionViewOptionsMenu';
import { clearCurrentSession, setNewTaskMetabotId, setNewTaskOrigin } from '../store/slices/coworkSlice';
import {
  ArchiveBoxIcon,
  MagnifyingGlassIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import Tooltip from './ui/Tooltip';
import FilterLinesIcon from './icons/FilterLinesIcon';
import BackgroundTasksBadge from './cowork/BackgroundTasksBadge';
import { SleepGuardBadge } from './SleepGuardBadge';
import BotBrowserModeSwitch from '../features/botBrowser/BotBrowserModeSwitch';
import { UserProfilePage } from '../features/userProfile';
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

/**
 * BOTWORKS THREE-COLUMN FINAL RULING 2026-11-09 (supersedes the single-column
 * composition this file carried through the 2026-11-08 restore): the BotWorks
 * face is now the three-column shell — left icon rail | THIS records column |
 * right column. This component is the MIDDLE column: the three task entries
 * moved to the rail (App.tsx's home-face rail mount, old rows' behavior
 * verbatim), the 「工作区」 section is preserved dormant in
 * ./HomeWorkspaceSection.tsx and mounts nowhere, and the records body sits
 * directly below the shared surface header with the Studio face's spacing.
 *
 * The restored Bot Home sidebar (owner ruling 2026-11-08 14:22: "Bot home 界面
 * 先恢复到原来的状态，目前的 bot internet 界面的改动不变").
 *
 * This is the baseline (pre-three-column) Home composition, not a new design:
 *
 *   header: band row (用户 pill + Studio | BotWorks band) + the light
 *     actions row (records search / collapse / update) — the shared-header
 *     shape, same as Sidebar.tsx's on the other face
 *   records block: 任务记录 header + local/online tabs + list
 *   footer: Settings + background/sleep badges
 *
 * OWNER ORDER 2026-11-09 11:16 「两面一致性令」 (supersedes the 14:22 text
 * menu above): the three task entries — 新建任务 / 长期任务 / 多人任务 —
 * moved OUT of this sidebar INTO the left function bar (the SAME
 * WorkspaceRail the Studio face mounts: same RailButton form, size,
 * spacing and interaction states). Their behavior is unchanged; the
 * re-homed wiring lives in App.tsx's home-face rail mount. This sidebar
 * renders no task rows any more.
 *
 * OWNER RULING 2026-11-08 15:46 (supersedes the 14:22 menu/tabs restored above):
 *   · the 「我的 Bot」menu row is retired — the Bot roster keeps its entry on
 *     the Bot Internet surface (rail myBots pane, same metabotsView);
 *   · the 「群任务」record tab is retired — the 多人任务 row still opens the
 *     group-task management view (GroupTasksView), so task management keeps its
 *     door. The group_task CHAT CHANNELS no longer render inside Home.
 *   · no data is deleted anywhere: sessions stay in the store and the task rows
 *     stay in the groupTasks slice. Only the two Home signboards are gone.
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
 *   · the amber 「待拍板」 dot rides the LEFT FUNCTION BAR's 长期任务 entry
 *     now (the rail's own indicator machinery, pinned in
 *     trackedTaskDecisionBadge.test.ts; this column's row copy moved out
 *     together with the row).
 *
 * The record-type DRAWER does not come back: the selector is the tab row above
 * the list (text entry point), as the owner ruled when retiring the drawer.
 */

/** The two record scopes the owner kept on Home (2026-11-08 15:46).
 *  The third baseline scope (`group`, the group-task chat channels) is retired:
 *  its sign is gone from the tab row, and the management view stays reachable
 *  from the 多人任务 menu row. */
type TaskRecordTab = 'local' | 'a2a';

const TASK_RECORD_TABS: Array<{ id: TaskRecordTab; labelKey: string; emptyKey: string }> = [
  { id: 'local', labelKey: 'coworkTabLocal', emptyKey: 'coworkEmptyLocal' },
  { id: 'a2a', labelKey: 'coworkTabA2A', emptyKey: 'coworkEmptyA2A' },
];

/** localStorage key for the remembered record tab (shared with the baseline). */
const TASK_RECORD_TAB_STORAGE_KEY = 'taskRecordTab';

const loadTaskRecordTab = (): TaskRecordTab => {
  try {
    const stored = window.localStorage.getItem(TASK_RECORD_TAB_STORAGE_KEY);
    // Only the kept scopes restore. A 'group' value persisted before the 15:46
    // ruling falls back to the default tab instead of resurrecting a dead sign.
    if (stored === 'a2a') return stored;
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
  onShowCowork: () => void;
  /** Still needed: the footer's background-tasks badge opens the group-task
   * management view (the rail's 多人任务 entry opens the same view). */
  onShowGroupTasks: () => void;
  mode: BotBrowserSurfaceMode;
  /** Return to the Home surface from the switcher menu. */
  onSelectHome: () => void;
  /** Switch surface (the switcher's two transitions). */
  onSelectSurface: (mode: BotBrowserSurfaceMode) => void;
  isCollapsed: boolean;
  /** Expanded sidebar width in px (resizable by the user). */
  width?: number;
  /** True while the shell animates the width (seam drag OR the double-click snap tween); strips the width transition so the pointer/tween stays the single animator. */
  isResizing?: boolean;
  updateBadge?: React.ReactNode;
}

const HomeSidebar: React.FC<HomeSidebarProps> = ({
  onShowCowork,
  onShowGroupTasks,
  mode,
  onSelectHome,
  onSelectSurface,
  isCollapsed,
  width = defaultSidebarWidth('home'),
  isResizing = false,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const unreadSessionIds = useSelector((state: RootState) => state.cowork.unreadSessionIds);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const dispatch = useDispatch();

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

  // BotWorks history lists EVERY cowork session, including the Studio
  // (Bot Internet) browser co-work sessions — owner ruling 2026-11-12,
  // restoring the pre-2026-11-08 listing. They appear in the local bucket
  // with a Studio badge (CoworkSessionItem; copy renamed 浏览器→Studio the
  // same day) and open in the BotWorks chat view in the professional
  // presentation (thinking transcript), NOT by routing back to the Studio
  // surface.
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

  // Sessions grouped by category: local (human↔MetaBot chats, INCLUDING the
  // Studio browser co-work sessions per the owner ruling 2026-11-12 — they
  // carry a Studio badge and open in the professional BotWorks transcript) and
  // a2a (MetaBot↔MetaBot). IM rows belong to the LOCAL list even when an older
  // row is still stored as 'a2a' — the mapping channel is the display source
  // of truth, so this is a render-time reclassification.
  //
  // There is deliberately NO `group` bucket any more (owner ruling 15:46: the
  // 群任务 sign is retired). Nothing was deleted: group_task sessions stay in
  // `homeSessions`/the store and the 多人任务 management view lists the tasks;
  // this list just stops deriving a Home bucket that no sign could ever select.
  const sessionGroups = useMemo(() => {
    const isImSession = (session: CoworkSessionSummary) => Boolean(session.imChannel);
    const isLocal = (session: CoworkSessionSummary) =>
      session.sessionType !== 'group_task'
      && (session.sessionType !== 'a2a' || isImSession(session));
    return {
      local: homeSessions.filter(isLocal),
      a2a: homeSessions.filter((session) => session.sessionType === 'a2a' && !isImSession(session)),
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
  const hasFaceSessions = taskRecordTab === 'local'
    ? localHumanSessions.length > 0
    : sessionGroups.a2a.length > 0;

  const language = i18nService.getLanguage();

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

  // Switching faces ends any batch-archive selection in progress: the picked
  // ids belong to the face they were picked on, and the two faces' session
  // buckets never overlap. Batch archive itself exists on BOTH faces now.
  useEffect(() => {
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
    // Every session on this face — Studio browser sessions included (owner
    // ruling 2026-11-12) — opens in the BotWorks chat view. A browser session
    // renders there with the professional presentation (full thinking
    // transcript); its turns still run with the Studio assistant prompt
    // (session-owned execution, see assistantModeSessionGate).
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

  /** Quick-create a new task with the bot of a group header (the trailing +).
   * The composer's wording follows the ORIGIN face: + pressed on 线上对话
   * arms an a2a composer (the bot goes to the chain to talk to another bot),
   * while the local face keeps the owner-task wording. */
  const handleQuickCreateTask = useStableCallback((botId: number) => {
    dispatch(clearCurrentSession());
    dispatch(setNewTaskMetabotId(botId));
    dispatch(setNewTaskOrigin(taskRecordTab === 'a2a' ? 'a2a' : 'local'));
    onShowCowork();
  });

  /** The face's light actions in the shared header's actions row — the update
   * badge only (总裁办侧栏微调批单 2026-11-09 12:23, superseding the
   * 11:16 两面一致性令's row composition): the records SEARCH button moved
   * into the 「按 Bot」 toolbar row beside the filter/sort and archive
   * controls, and the sidebar-collapse » toggle is GONE from this row — the
   * shell's seam tab (the floating toggle on App's boundary handle)
   * remains the one collapse control, so no collapse affordance is lost. */
  const surfaceHeaderActions = <>{updateBadge}</>;

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
      {/* Same header wrapper as Sidebar.tsx's mid column (three-column
          final ruling 2026-11-09): Row 1 = the traffic lights' own 52 px
          strip; row 2 = the band ALONE — the identity avatar moved into the
          rail's top slot (owner D-line final ruling 2026-11-09), so this
          header carries no pill; row 3 = the face's light actions,
          right-aligned — the update badge only since the 侧栏微调批单
          (2026-11-09 12:23): the records search moved into the 按 Bot
          toolbar row and the collapse » toggle is gone (the shell's seam
          tab stays the one collapse control). The three task entries live
          in the left rail (the same WorkspaceRail the Studio face mounts,
          same RailButton form). */}
      <div data-slot="mid-column-header" className="shrink-0">
        <BotBrowserModeSwitch
          mode={mode}
          onSelectHome={onSelectHome}
          onSelectBrowser={() => onSelectSurface('browser')}
          actions={surfaceHeaderActions}
        />
      </div>

      {/* The 「工作区」 section does NOT mount here any more (three-column
          final ruling 2026-11-09: no column of the new shell carries it).
          Its code is preserved VERBATIM in ./HomeWorkspaceSection.tsx — a
          dormant, type-checked component the Studio-face relocation order
          will import. The records body starts right below the surface
          header stack, with the SAME band→content spacing as the Studio
          face's mid column (pt-1, vs Sidebar's `px-2 pt-1` body). */}
      <div className="flex-1 min-h-0 flex flex-col px-2.5 pt-1">
        {/* Fixed header + tabs; only the list below scrolls. */}
        <div className="px-3 pb-2 shrink-0">
          <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('coworkHistory')}
          </div>
          <div
            data-slot="home-session-scope"
            role="group"
            aria-label={i18nService.t('coworkHistory')}
            className="grid w-full grid-cols-2 gap-1 rounded-lg border border-claude-border/70 bg-claude-bg/80 p-1 mt-2 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
          >
            {TASK_RECORD_TABS.map((tab, index) => {
              const isActive = taskRecordTab === tab.id;
              const stats = tabStats[tab.id];
              // Both remaining signs count CHATS; the group-task count tip
              // belonged to the retired 群任务 sign.
              const countTipKey = 'coworkTabCountChats';
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
                      // Same flat accent fill as the mid-column scope row
                      // (aesthetic pass 2026-11-08): the primary-button class
                      // brought rem padding + a 2px offset shadow that made the
                      // active segment wider than its grid cell.
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
        {/* Toolbar row above the list: current view label on the left;
            search, filter & sort and batch archive on the right. The search
            button lives HERE since the 侧栏微调批单 (2026-11-09 12:23,
            superseding its old seat in the header's actions row): same row,
            same 28 px-class controls, same handlers — records search opens
            the same CoworkSearchModal, nothing regressed. The same controls
            on both faces — putting sessions away is a list operation, not a
            local-face privilege. */}
        {hasFaceSessions && (
          <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5 shrink-0">
            <span className="min-w-0 truncate text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t(faceViewMode === 'bot' ? 'sessionViewByBot' : 'sessionViewTimeline')}
            </span>
            <div className="flex items-center gap-1.5">
              <Tooltip content={i18nService.t('search')} position="bottom">
                <button
                  type="button"
                  onClick={() => {
                    onShowCowork();
                    setIsSearchOpen(true);
                  }}
                  aria-label={i18nService.t('search')}
                  className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-claude-accent/10 hover:text-claude-accent dark:text-claude-darkTextSecondary"
                >
                  <MagnifyingGlassIcon className="h-4 w-4" />
                </button>
              </Tooltip>
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
          open={isViewMenuOpen && !isBatchArchiveMode}
          onClose={() => setIsViewMenuOpen(false)}
          viewMode={faceViewMode}
          sortMode={sessionSortMode}
          onViewModeChange={handleSetFaceViewMode}
          onSortModeChange={handleSetSessionSortMode}
        />
        {/* Scrollable list area */}
        <div className="flex-1 min-h-0 overflow-y-auto pb-4">
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
            /** Local chats: machine-started runs fold into one collapsed
             * "Autonomous Tasks" folder below the Follow-Up section. */
            autoSessions={taskRecordTab === 'local' ? localAutoSessions : undefined}
            /** Local chats: sessions awaiting a human decision or reply
             * render in the Follow-Up section above the fold. */
            followUpSessions={taskRecordTab === 'local' ? localFollowUpSessions : undefined}
            decisionSessionIds={taskRecordTab === 'local' ? decisionSessionIds : undefined}
            /** The trailing + on a bot group header starts a new task with
             * that bot. Same action and same handler on BOTH faces. */
            onQuickCreateTask={handleQuickCreateTask}
          />
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

      {/* The footer's 「⚙ 设置」 text row is GONE (设置按钮共享化, 总裁办
          侧栏微调批单 2026-11-09 12:23, superseding the 11:16 order that kept
          this row): the ONE settings entry is the left rail's bottom icon —
          the same WorkspaceRail RailButton and the shared settings chain on
          both faces. The badges keep their seat, right-aligned. */}
      <div className="px-3 pb-3 pt-1">
        <div className="flex items-center justify-end gap-2">
          <BackgroundTasksBadge onShowGroupTasks={onShowGroupTasks} />
          <SleepGuardBadge />
        </div>
      </div>

      {/* The user page overlay. Mounted by the face that is on screen, so
          App.tsx (and the keep-alive Bot Browser pane it hosts) stays
          untouched. */}
      <UserProfilePage />
    </aside>
  );
};

export default HomeSidebar;
