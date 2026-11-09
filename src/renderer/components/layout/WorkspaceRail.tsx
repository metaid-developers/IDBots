import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  ArchiveBoxIcon,
  ClockIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  GlobeAltIcon,
  ShoppingBagIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import Tooltip from '../ui/Tooltip';
import ComposeIcon from '../icons/ComposeIcon';
import { UserProfileAvatarButton } from '../../features/userProfile';
import { i18nService } from '../../services/i18n';
import { getRailHomeNavModel, getRailInternetNavModel } from '../sidebar/sidebarNavigation.js';
import { selectTrackedTasksNeedingAttention } from '../../utils/trackedTaskAttention';
import type { RootState } from '../../store';
import type {
  BotBrowserSurfaceMode,
  BotHomeSection,
  BotInternetPane,
} from '../../features/botBrowser/types';

/** The rail's fixed track width — inside the ≈48–64 px icon-column budget. */
export const WORKSPACE_RAIL_WIDTH_PX = 64;

interface RailNavItem {
  id: string;
  label: string;
  icon: string;
  hidden?: boolean;
  hasIndicator?: boolean;
  indicatorKind?: 'running' | 'decision';
  indicatorLabel?: string;
}

/**
 * Icon tokens → assets. Everything is already an in-repo icon (heroicons or
 * components/icons); the rail never introduces a new icon dependency.
 */
const renderRailIcon = (icon: string): React.ReactNode => {
  switch (icon) {
    case 'compose':
      return <ComposeIcon className="h-5 w-5" />;
    case 'clock':
      return <ClockIcon className="h-5 w-5" />;
    case 'userGroup':
      return <UserGroupIcon className="h-5 w-5" />;
    case 'archive':
      return <ArchiveBoxIcon className="h-5 w-5" />;
    case 'shoppingBag':
      return <ShoppingBagIcon className="h-5 w-5" />;
    case 'cpuChip':
      return <CpuChipIcon className="h-5 w-5" />;
    case 'squares2x2':
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-5 w-5"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'globe':
    default:
      return <GlobeAltIcon className="h-5 w-5" />;
  }
};

const RailButton: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  itemId: string;
  hasIndicator?: boolean;
  indicatorKind?: 'running' | 'decision';
  indicatorLabel?: string;
  children: React.ReactNode;
}> = ({ label, active, onClick, itemId, hasIndicator, indicatorKind, indicatorLabel, children }) => (
  <Tooltip content={label} position="right" delay={200}>
    <button
      type="button"
      data-slot="rail-item"
      data-rail-item={itemId}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={`non-draggable relative inline-flex h-10 w-10 items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
        active
          ? 'dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text'
          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover hover:dark:text-claude-darkText hover:text-claude-text'
      }`}
    >
      {children}
      {active && (
        // The one "you are here" mark in the rail: a 3 px accent bar, 24 px
        // tall, sitting on the column's own edge. (Aesthetic pass: 2 px × 20 px
        // disappeared next to a 40 px tile at 1x display scale.)
        <span aria-hidden className="absolute left-[-6px] top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-full bg-claude-accent" />
      )}
      {hasIndicator ? (
        indicatorKind === 'decision' ? (
          // A parked owner decision: same amber family as the running dot, but
          // its own class so the two meanings stay distinguishable in the
          // DOM/CSS, and labelled — this dot means "you are the blocker".
          <span
            role="img"
            aria-label={indicatorLabel}
            title={indicatorLabel}
            className="tracked-task-decision-indicator absolute right-1 top-1 shrink-0"
          />
        ) : (
          <span aria-hidden className="scheduled-task-running-indicator absolute right-1.5 top-1.5 shrink-0" />
        )
      ) : null}
    </button>
  </Tooltip>
);

interface WorkspaceRailProps {
  mode: BotBrowserSurfaceMode;
  internetPane: BotInternetPane;
  homeSection: BotHomeSection;
  onSelectInternetPane: (pane: BotInternetPane) => void;
  onSelectHomeSection: (section: BotHomeSection) => void;
  onNewChat: () => void;
  onShowSettings: () => void;
  /** Update dot (rendered above Settings when one is available). */
  updateBadge?: React.ReactNode;
  /** Whether the rail pins its own Settings entry to the bottom. Default
   * true. Since the 设置按钮共享化 (总裁办侧栏微调批单 2026-11-09 12:23,
   * superseding the 11:16 order) BOTH faces default to true — the rail's
   * bottom RailButton is the ONE shared settings entry (same component,
   * same onShowSettings chain), and the wide sidebars carry no settings row
   * of their own. The prop stays for a surface that would genuinely need
   * the entry hidden. */
  showSettings?: boolean;
}

/**
 * The left icon rail of the three-column shell (slice 1).
 *
 * One column, 64 px, shared by both surfaces: the surface's destinations in the
 * middle, Settings + ME pinned to the bottom. Every entry is an icon with a
 * hover tooltip — the old text rows are gone. The rail is a container: selecting
 * an entry only tells App which destination is current, it renders no
 * destination content itself.
 *
 * The SURFACE switcher does not live here any more (owner ruling 2026-11-08
 * 14:15): it moved to the middle column's header, where it can carry the
 * current surface's name in a Codex-style capsule instead of a bare icon.
 * The identity entry DOES live here now (owner D-line final ruling
 * 2026-11-09): the user avatar takes the rail's top slot — the Mac-WeChat
 * form — and the function icons start below it.
 */
export const WorkspaceRail: React.FC<WorkspaceRailProps> = ({
  mode,
  internetPane,
  homeSection,
  onSelectInternetPane,
  onSelectHomeSection,
  onNewChat,
  onShowSettings,
  updateBadge,
  showSettings = true,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const language = i18nService.getLanguage();

  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running',
  );
  const trackedTaskAttention = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }),
    [longTermBoard],
  );

  const internetItems: RailNavItem[] = useMemo(
    () => getRailInternetNavModel({ t: (key: string) => i18nService.t(key) }).filter((item: RailNavItem) => !item.hidden),
    [language],
  );
  const homeItems: RailNavItem[] = useMemo(
    () =>
      getRailHomeNavModel({
        t: (key: string) => i18nService.t(key),
        hasRunningScheduledTask,
        needsDecisionCount: trackedTaskAttention.total,
      }).filter((item: RailNavItem) => !item.hidden),
    [hasRunningScheduledTask, trackedTaskAttention.total, language],
  );

  const handleHomeItem = (id: string) => {
    if (id === 'newTask') {
      onNewChat();
      return;
    }
    onSelectHomeSection(id as BotHomeSection);
  };

  return (
    <aside
      data-slot="workspace-rail"
      data-rail-surface={mode}
      aria-label={i18nService.t('workspaceRailLabel')}
      className="relative z-30 flex w-16 shrink-0 flex-col items-center dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted"
    >
      {/* Row 1 is the pure traffic-light reservation (52 px on mac — the
          lights, trafficLightPosition y=20, own it alone). Row 2 is the
          identity AVATAR slot (owner D-line final ruling 2026-11-09): the
          same 52 px height as the mid column's band row (the switch's
          surface-header-bar), so the avatar's centerline rides the band
          labels' centerline, and the rail's own centerline puts it on the
          icon column's X — the Mac-WeChat form. The nav's 8 px top margin
          then lands the first function icon at 52 + 52 + 8 = 112 px — below
          the avatar, never in the top cell. */}
      <div className={`draggable w-full shrink-0 ${isMac ? 'h-[52px]' : 'h-3'}`} />
      <div
        data-slot="workspace-rail-avatar-slot"
        className="flex h-[52px] w-full shrink-0 items-center justify-center"
      >
        <UserProfileAvatarButton />
      </div>
      {mode === 'browser' ? (
        <nav
          aria-label={i18nService.t('botInternet')}
          className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1.5 overflow-y-auto px-1.5 pb-2"
        >
          {internetItems.map((item) => (
            <RailButton
              key={item.id}
              itemId={item.id}
              label={item.label}
              active={internetPane === item.id}
              onClick={() => onSelectInternetPane(item.id as BotInternetPane)}
            >
              {renderRailIcon(item.icon)}
            </RailButton>
          ))}
        </nav>
      ) : (
        <nav
          aria-label={i18nService.t('botHome')}
          className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5 pb-2"
        >
          {/* 两面一致性令 (owner order 2026-11-09 11:16): the Home face's
              rail carries exactly the three entries that used to be the
              sidebar's stacked text rows — 新建任务 / 长期任务 / 多人任务.
              The records archive selector stays out: on this surface the
              records body is always on screen below, so a fourth icon would
              add a door the face never had. */}
          {homeItems.filter((item) => item.id !== 'records').map((item) => (
            <RailButton
              key={item.id}
              itemId={item.id}
              label={item.label}
              active={item.id === 'newTask' ? false : homeSection === item.id}
              hasIndicator={item.hasIndicator}
              indicatorKind={item.indicatorKind}
              indicatorLabel={item.indicatorLabel}
              onClick={() => handleHomeItem(item.id)}
            >
              {renderRailIcon(item.icon)}
            </RailButton>
          ))}
        </nav>
      )}
      <div className="mt-auto flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-1">
        {updateBadge ? <div className="flex w-full justify-center">{updateBadge}</div> : null}
        {showSettings ? (
          <RailButton
            itemId="settings"
            label={i18nService.t('settings')}
            active={false}
            onClick={onShowSettings}
          >
            <Cog6ToothIcon className="h-5 w-5" />
          </RailButton>
        ) : null}
        {/* The old compact ME badge is GONE from the rail (owner ruling
            2026-11-09 10:05, D5): the standalone user page — opened from the
            header's top-left User pill — is now the ONE home of the ME credits
            panel, and a second copy in this corner would be exactly the
            duplication D5 removes. The MeBalanceBadge component file stays on
            disk; the page's MeCreditsPanel carries every value it showed. */}
      </div>
    </aside>
  );
};

export default WorkspaceRail;
