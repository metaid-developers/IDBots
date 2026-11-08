import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  ArchiveBoxIcon,
  ChatBubbleLeftRightIcon,
  ClockIcon,
  Cog6ToothIcon,
  CpuChipIcon,
  GlobeAltIcon,
  ShoppingBagIcon,
  UserGroupIcon,
} from '@heroicons/react/24/outline';
import Tooltip from '../ui/Tooltip';
import ComposeIcon from '../icons/ComposeIcon';
import BotBrowserModeSwitch from '../../features/botBrowser/BotBrowserModeSwitch';
import MeBalanceBadge from '../me/MeBalanceBadge';
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
    case 'chatBubbles':
      return <ChatBubbleLeftRightIcon className="h-5 w-5" />;
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
        <span aria-hidden className="absolute left-[-6px] top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-claude-accent" />
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
  onSelectSurface: (mode: BotBrowserSurfaceMode) => void;
  onSelectInternetPane: (pane: BotInternetPane) => void;
  onSelectHomeSection: (section: BotHomeSection) => void;
  onNewChat: () => void;
  onShowSettings: () => void;
  /** Update dot (rendered above Settings when one is available). */
  updateBadge?: React.ReactNode;
}

/**
 * The left icon rail of the three-column shell (slice 1).
 *
 * One column, 64 px, shared by both surfaces: the surface switcher at the very
 * top, the surface's own destinations in the middle, Settings + ME pinned to
 * the bottom. Every entry is an icon with a hover tooltip — the old text rows
 * are gone. The rail is a container: selecting an entry only tells App which
 * destination is current, it renders no destination content itself.
 */
export const WorkspaceRail: React.FC<WorkspaceRailProps> = ({
  mode,
  internetPane,
  homeSection,
  onSelectSurface,
  onSelectInternetPane,
  onSelectHomeSection,
  onNewChat,
  onShowSettings,
  updateBadge,
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
      {/* macOS traffic lights sit over this column's top-left corner: reserve
          the strip so the surface switcher never lands underneath them. */}
      <div className={`draggable w-full shrink-0 ${isMac ? 'h-[52px]' : 'h-3'}`} />
      <div className="w-full px-1.5">
        <BotBrowserModeSwitch
          mode={mode}
          onSelectBrowser={() => onSelectSurface('browser')}
          onSelectHome={() => onSelectSurface('home')}
        />
      </div>
      <div className="mt-2 w-full px-3">
        <div className="h-px w-full dark:bg-claude-darkBorder/70 bg-claude-border/70" />
      </div>
      {mode === 'browser' ? (
        <nav
          aria-label={i18nService.t('botInternet')}
          className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-1.5 pb-2"
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
          {homeItems.map((item) => (
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
        <RailButton
          itemId="settings"
          label={i18nService.t('settings')}
          active={false}
          onClick={onShowSettings}
        >
          <Cog6ToothIcon className="h-5 w-5" />
        </RailButton>
        {/* ME is the identity/credits corner: icon-only in the narrow rail, the
            amount and the full breakdown panel stay one click away. */}
        <MeBalanceBadge compact />
      </div>
    </aside>
  );
};

export default WorkspaceRail;
