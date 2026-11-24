import React, { useMemo } from 'react';
import { useSelector } from 'react-redux';
import {
  ArchiveBoxIcon,
  BellAlertIcon,
  BellIcon,
  Cog6ToothIcon,
  MapIcon,
  ShoppingBagIcon,
} from '@heroicons/react/24/outline';
import Tooltip from '../ui/Tooltip';
import NotificationCenter from '../notifications/NotificationCenter';
import ComposeIcon from '../icons/ComposeIcon';
import { UserProfileAvatarButton } from '../../features/userProfile';
import { i18nService } from '../../services/i18n';
import { getRailHomeNavModel, getRailInternetNavModel } from '../sidebar/sidebarNavigation.js';
import { selectTrackedTasksNeedingAttention } from '../../utils/trackedTaskAttention';
import { countAwaitingProcesses, splitProcessHub } from '../../utils/processCenter';
import { useLineageOverrides } from '../../utils/processHubLineageStore';
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
  /** Numeric red badge (进程 count): rendered inside the dot, per spec ①. */
  badgeCount?: number;
}

/**
 * Icon tokens → assets. Everything is an in-repo icon (heroicons or
 * components/icons) or an inline in-file SVG; the rail never introduces a new
 * icon dependency. The two brand glyphs drawn in-file (我的 BOT, Bot Browser)
 * share the rail's eye language — LEFT eye ink (currentColor), RIGHT eye amber
 * #F5A93B, the 元 avatar's background color — so the two entries answer each
 * other across the column (窗里住着 bot 的眼睛).
 */
const renderRailIcon = (icon: string): React.ReactNode => {
  switch (icon) {
    case 'compose':
      return <ComposeIcon className="h-6 w-6" />;
    case 'clock':
      // 长期任务: a roadmap (Heroicons map) — the board is a route to walk,
      // not a point in time.
      return <MapIcon className="h-6 w-6" />;
    case 'userGroup': {
      // 多人任务: Tabler "users-plus" glyph (tabler.io/icons, MIT license),
      // copied verbatim into this file (same inline pattern as squares2x2
      // below); strokeWidth 2 → 1.5 to match the rail's stroke family.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <path d="M5 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0" />
          <path d="M3 21v-2a4 4 0 0 1 4 -4h4c.96 0 1.84 .338 2.53 .901" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          <path d="M16 19h6" />
          <path d="M19 16v6" />
        </svg>
      );
    }
    case 'bell':
      // 定时任务: a bell (Heroicons bell-alert) — a scheduled run rings.
      return <BellAlertIcon className="h-6 w-6" />;
    case 'archive':
      // 任务记录: an archive box (Heroicons archive-box).
      return <ArchiveBoxIcon className="h-6 w-6" />;
    case 'shoppingBag':
      return <ShoppingBagIcon className="h-6 w-6" />;
    case 'cpuChip': {
      // 我的 BOT: Lucide "bot" skeleton (lucide.dev, ISC license) — antenna,
      // head, side ears — strokeWidth 1.5 like the rest of the family. The
      // filled eyes carry the rail's brand pair: left ink (currentColor),
      // right amber #F5A93B = the 元 avatar's background color. Filled shapes
      // set stroke="none": a 1.5 stroke around a 2.6px rect would nearly
      // double it (same reasoning as the Bot Browser eyes below).
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <path d="M12 8V4H8" />
          <rect x="4" y="8" width="16" height="12" rx="2" />
          <path d="M2 14h2" />
          <path d="M20 14h2" />
          <rect x="7.6" y="11.2" width="2.6" height="2.6" rx="0.4" fill="currentColor" stroke="none" />
          <rect x="13.8" y="11.2" width="2.6" height="2.6" rx="0.4" fill="#F5A93B" stroke="none" />
        </svg>
      );
    }
    case 'processQueue': {
      // 进程 (spec §③ candidate A): a queue window — a framed pane with a title
      // bar and three rows, the Windows-task-manager reading. Drawn in-file
      // (same pattern as squares2x2/userGroup); strokeWidth 1.5 to match the
      // rail's stroke family.
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
          <line x1="3" y1="8.2" x2="21" y2="8.2" />
          <line x1="6.4" y1="11.6" x2="17.6" y2="11.6" />
          <line x1="6.4" y1="14.6" x2="17.6" y2="14.6" />
          <line x1="6.4" y1="17.6" x2="12.4" y2="17.6" />
        </svg>
      );
    }
    case 'squares2x2':
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-6 w-6"
        >
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
      );
    case 'globe':
    default: {
      // Bot Browser: a browser window (frame + address row + traffic dots)
      // with the SAME square eyes living inside it — left ink, right amber
      // #F5A93B (元 avatar's background color). 窗里住着 bot 的眼睛; the
      // window answers the 我的 BOT bot below it (same eye pair, two worlds).
      return (
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          className="h-6 w-6"
        >
          <rect x="3" y="4.5" width="18" height="15" rx="2.4" />
          <line x1="3" y1="7.9" x2="21" y2="7.9" />
          <circle cx="5.9" cy="6.2" r="0.45" fill="currentColor" stroke="none" />
          <circle cx="8.1" cy="6.2" r="0.45" fill="currentColor" stroke="none" />
          <rect x="7.6" y="12.2" width="3.2" height="3.2" rx="0.7" fill="currentColor" stroke="none" />
          <rect x="13.2" y="12.2" width="3.2" height="3.2" rx="0.7" fill="#F5A93B" stroke="none" />
        </svg>
      );
    }
  }
};

/**
 * THE rail entry form — one component, every entry.
 *
 * 通知中心 and 进程中心 are the two SYSTEM entries at the rail's foot, and the
 * owner asked for them to be aligned (2026-11-24 00:38). The alignment is not a
 * copied class string: the notification bell is rendered BY this component —
 * NotificationCenter hands its trigger slot back to the rail (see its
 * `renderTrigger` prop) — so geometry (h-10 w-10 / rounded-[8px]: 37.5×37.5 px
 * on this app's 15 px root, measured), the hover
 * language and the count badge below are shared by construction. Change one,
 * both move.
 */
const RailButton: React.FC<{
  label: string;
  active: boolean;
  onClick: () => void;
  itemId: string;
  hasIndicator?: boolean;
  indicatorKind?: 'running' | 'decision';
  indicatorLabel?: string;
  badgeCount?: number;
  /** The unit the count badge renders: 进程 = runs, 通知 = unread. */
  countUnit?: 'runs' | 'unread';
  /** Cap the RENDERED number ("99+"); data-rail-badge-count keeps the raw count. */
  badgeMaxDisplay?: number;
  /** The badge's own test hook. */
  badgeTestId?: string;
  /** The button's own test hook (entries are otherwise found by data-rail-item). */
  testId?: string;
  /** Extra data-* attributes for probes (count snapshots and the like). */
  buttonDataAttributes?: { [key: `data-${string}`]: string | number };
  /** A popover entry publishes its panel state on top of the pressed state. */
  ariaExpanded?: boolean;
  children: React.ReactNode;
}> = ({
  label,
  active,
  onClick,
  itemId,
  hasIndicator,
  indicatorKind,
  indicatorLabel,
  badgeCount,
  countUnit = 'runs',
  badgeMaxDisplay,
  badgeTestId,
  testId,
  buttonDataAttributes,
  ariaExpanded,
  children,
}) => (
  <Tooltip content={label} position="right" delay={200}>
    <button
      type="button"
      data-slot="rail-item"
      data-rail-item={itemId}
      {...buttonDataAttributes}
      data-testid={testId}
      aria-label={label}
      aria-pressed={active}
      aria-expanded={ariaExpanded}
      onClick={onClick}
      className={`non-draggable relative inline-flex h-10 w-10 items-center justify-center rounded-[8px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
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
          typeof badgeCount === 'number' ? (
            // The COUNT badge (进程中心's 待你拍板 number): red, top-right,
            // min 14px. It deliberately does NOT carry
            // `.tracked-task-decision-indicator` — that class is a 0.375rem
            // amber dot with its own background and glow, and it WINS over the
            // utilities (same specificity, later source order), which rendered
            // this badge as a 5.63px amber dot with the number spilling out.
            // Measured, not assumed: see the v2 alignment probe.
            <span
              role="img"
              aria-label={indicatorLabel}
              title={indicatorLabel}
              data-rail-badge-count={badgeCount}
              data-count-unit={countUnit}
              data-testid={badgeTestId}
              className="absolute -right-[3px] -top-[3px] flex h-[14px] min-w-[14px] shrink-0 items-center justify-center rounded-full bg-red-500 px-[3px] text-[9.5px] font-bold leading-none text-white"
            >
              {typeof badgeMaxDisplay === 'number' && badgeCount > badgeMaxDisplay
                ? `${badgeMaxDisplay}+`
                : badgeCount}
            </span>
          ) : (
            // The plain decision dot: the amber glow that means "you are the
            // blocker", unchanged.
            <span
              role="img"
              aria-label={indicatorLabel}
              title={indicatorLabel}
              className="tracked-task-decision-indicator absolute -right-[3px] -top-[3px] shrink-0"
            />
          )
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
  /** Whether the rail pins its own Settings entry to the bottom. Default
   * true. Since the 设置按钮共享化 (总裁办侧栏微调批单 2026-11-09 12:23,
   * superseding the 11:16 order) BOTH faces default to true — the rail's
   * bottom RailButton is the ONE shared settings entry (same component,
   * same onShowSettings chain), and the wide sidebars carry no settings row
   * of their own. The prop stays for a surface that would genuinely need
   * the entry hidden. */
  showSettings?: boolean;
  /** 进程中心 is a PANEL destination on both faces (owner ruling 22:17); the
   * active state reads this, the entry itself is always mounted. */
  processCenterActive?: boolean;
  /**
   * The bottom-left version/update block (owner order 2026-11-21 17:46 — the
   * ONE update control surface: version, red dot, status, check action and the
   * auto-check switch all live in its popover). App passes one node shared by
   * both faces; the rail only lays it out under the Settings gear.
   */
  updateModule?: React.ReactNode;
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
  showSettings = true,
  processCenterActive = false,
  updateModule,
}) => {
  // Row-1 top band is platform+face aware (owner alignment ruling
  // 2026-11-17): darwin keeps the 42.375 px traffic-light reservation; win32
  // + browser face rises to 36 px (h-9) to sit strictly level with the right
  // column's Windows title-bar strip — App.tsx mounts that h-9 strip at the
  // browser pane's top ONLY while the pane is visible, so every other
  // platform/face keeps the quiet 12 px breath (the mid column's switch
  // header parses the matching tier from its own top-gap helper).
  const isMac = window.electron.platform === 'darwin';
  const isWindowsBrowserFace = window.electron.platform === 'win32' && mode === 'browser';
  const language = i18nService.getLanguage();

  const scheduledTasks = useSelector((state: RootState) => state.scheduledTask.tasks);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  // The 进程 entry's badge: the SAME model the panel renders (one source of
  // truth), so the rail count and the 待你拍板 tab can never disagree. The
  // decision set comes from the board, exactly like the panel's.
  const coworkSessions = useSelector((state: RootState) => state.cowork.sessions);
  // Same override map the hub reads — the rail badge and the strip must agree
  // on the very same tick (三源同步), so both subscribe to the one store.
  const lineageOverrides = useLineageOverrides();
  const awaitingProcessCount = useMemo(() => {
    const decisionSessionIds = new Set(
      (longTermBoard?.cards ?? []).flatMap((card) => card.decisionSessionIds ?? []),
    );
    return countAwaitingProcesses(
      splitProcessHub(coworkSessions, decisionSessionIds, Date.now(), undefined, lineageOverrides),
    );
  }, [coworkSessions, longTermBoard, lineageOverrides]);
  const hasRunningScheduledTask = scheduledTasks.some(
    (task) => task.enabled && task.state.runningAtMs !== null && task.state.lastStatus === 'running',
  );
  const trackedTaskAttention = useMemo(
    () => selectTrackedTasksNeedingAttention({ longTermTask: { board: longTermBoard } }),
    [longTermBoard],
  );

  const internetItems: RailNavItem[] = useMemo(
    () =>
      getRailInternetNavModel({
        t: (key: string) => i18nService.t(key),
        needsDecisionCount: trackedTaskAttention.total,
        awaitingProcessCount,
      }).filter((item: RailNavItem) => !item.hidden),
    [trackedTaskAttention.total, awaitingProcessCount, language],
  );
  const homeItems: RailNavItem[] = useMemo(
    () =>
      getRailHomeNavModel({
        t: (key: string) => i18nService.t(key),
        hasRunningScheduledTask,
        awaitingProcessCount,
      }).filter((item: RailNavItem) => !item.hidden),
    [hasRunningScheduledTask, awaitingProcessCount, language],
  );

  // 进程中心 is a SYSTEM entry (owner order 2026-11-21 17:00): it renders in the
  // rail's bottom group — directly above Settings, inside the group the rail
  // already reserves for system controls (the `mt-auto` container below) — not
  // beside the common buttons. Same model object, same badge, same icon; only
  // the mount point moved, so all four properties stay single-sourced.
  const processesItem = useMemo(
    () => (mode === 'browser'
      ? internetItems.find((item: RailNavItem) => item.id === 'processes')
      : homeItems.find((item: RailNavItem) => item.id === 'processes')) as RailNavItem | undefined,
    [mode, internetItems, homeItems],
  );

  const handleHomeItem = (id: string) => {
    if (id === 'newTask') {
      onNewChat();
      return;
    }
    onSelectHomeSection(id as BotHomeSection);
  };

  // Double-click on the rail's blank stretches — the icon column's empty
  // zones around its buttons (owner's red-box spot 2026-11-10) — asks the
  // records list to collapse every expanded folder at once. The rail is a
  // sibling of the list's column and holds no list state, so the ask rides
  // the `idbots:collapse-session-folders` window event, which
  // CoworkSessionList answers on the by-Bot faces. Rail content (buttons,
  // icons, the avatar) keeps its own behavior.
  const handleRailDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('button, a, [role="button"], input, img, svg, span')) return;
    window.dispatchEvent(new CustomEvent('idbots:collapse-session-folders'));
  };

  return (
    <aside
      data-slot="workspace-rail"
      data-rail-surface={mode}
      aria-label={i18nService.t('workspaceRailLabel')}
      onDoubleClick={handleRailDoubleClick}
      /* Dark hairline must be a literal alpha-capable color (white/10):
         the claude border tokens resolve to var(--border-color), on which
         Tailwind silently drops the /60 modifier — the full-strength
         #6b7280 read as a bright white line in dark mode (11-17 report). */
      className="relative z-30 flex w-16 shrink-0 flex-col items-center dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted border-r border-claude-border/60 dark:border-white/10"
    >
      {/* Row 1 is the pure top reservation, three tiers (owner alignment
          ruling 2026-11-17): darwin 42.375 px — owner baseline ruling
          2026-11-15 08:27: sized so the tray's visible top edge lands on the
          bot-home panel's header divider y=50.625 (mirrors the switch's
          TOP_GAP_MAC_PX); win32 + browser face 36 px (h-9), strictly level
          with the right column's Windows title-bar strip — that h-9 strip
          exists only while the browser pane is visible, so home/catalog
          faces keep the next tier down; every other platform/face 12 px of
          quiet air. Row 2 is the identity AVATAR slot (owner D-line final
          ruling 2026-11-09): the same 52 px height as the mid column's band
          row (the switch's surface-header-bar), so the avatar's centerline
          rides the band labels' centerline, and the rail's own centerline
          puts it on the icon column's X — the Mac-WeChat form. The nav's
          8 px top margin then lands the first function icon below the
          avatar, never in the top cell: darwin 42.375 + 52 + 8 = 102.375 px;
          win32 + browser face 36 + 52 + 8 = 96 px. */}
      <div
        className={`draggable w-full shrink-0 ${
          isMac ? 'h-[42.375px]' : isWindowsBrowserFace ? 'h-9' : 'h-3'
        }`}
      />
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
          {internetItems.filter((item: RailNavItem) => item.id !== 'processes').map((item) => (
            <RailButton
              key={item.id}
              itemId={item.id}
              label={item.label}
              active={internetPane === item.id}
              hasIndicator={item.hasIndicator}
              indicatorKind={item.indicatorKind}
              indicatorLabel={item.indicatorLabel}
              badgeCount={item.badgeCount}
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
              sidebar's stacked text rows — 新建任务 / 定时任务 / 多人任务.
              The records archive selector stays out: on this surface the
              records body is always on screen below, so a fourth icon would
              add a door the face never had. */}
          {homeItems.filter((item) => item.id !== 'records' && item.id !== 'processes').map((item) => (
            <RailButton
              key={item.id}
              itemId={item.id}
              label={item.label}
              active={item.id === 'newTask'
                ? false
                : item.id === 'processes'
                  ? processCenterActive
                  : homeSection === item.id}
              hasIndicator={item.hasIndicator}
              indicatorKind={item.indicatorKind}
              indicatorLabel={item.indicatorLabel}
              badgeCount={item.badgeCount}
              onClick={() => handleHomeItem(item.id)}
            >
              {renderRailIcon(item.icon)}
            </RailButton>
          ))}
        </nav>
      )}
      <div className="mt-auto flex w-full flex-col items-center gap-1.5 px-1.5 pb-3 pt-1">
        {/* System zone, in this order (top → bottom): 通知中心 → 进程中心 →
            设置 → 版本更新模块. The two count-bearing entries sit adjacent so
            the owner reads them as one pair (owner order 2026-11-24 00:38).
            通知中心 (批 B · P0-4): the faucet for the notification pipeline the
            host already writes. The panel hands its trigger slot BACK to the
            rail, so the bell below is the very RailButton 进程中心 uses —
            same h-10 w-10/rounded-[8px] tile, same hover language, same 14 px
            count badge — instead of a second, privately styled button. */}
        <NotificationCenter
          onOpenProcesses={() => {
            if (mode === 'browser') onSelectInternetPane('processes' as BotInternetPane);
            else handleHomeItem('processes');
          }}
          renderTrigger={({ open: notificationsOpen, unreadCount, decisionCount, label, toggle }) => (
            <RailButton
              itemId="notifications"
              label={label}
              active={notificationsOpen}
              onClick={toggle}
              hasIndicator={unreadCount > 0}
              indicatorKind="decision"
              indicatorLabel={unreadCount > 0
                ? i18nService.t('notificationsUnreadBadge').replace('{count}', String(unreadCount))
                : label}
              badgeCount={unreadCount}
              countUnit="unread"
              badgeMaxDisplay={99}
              badgeTestId="notification-bell-badge"
              testId="notification-bell"
              buttonDataAttributes={{
                'data-unread-count': unreadCount,
                'data-decision-count': decisionCount,
              }}
              ariaExpanded={notificationsOpen}
            >
              <BellIcon className="h-6 w-6" />
            </RailButton>
          )}
        />
        {/* System zone (the rail's existing `mt-auto` group): 进程中心 sits
            directly above Settings and outside the common button group. */}
        {processesItem ? (
          <RailButton
            itemId={processesItem.id}
            label={processesItem.label}
            // The entry is a CONTROL now (floatwin §1.2): its active state is
            // "the floatwin is open", on BOTH faces — not "this pane is the
            // destination" (the rail never switches the pane for it anymore).
            active={processCenterActive || (mode === 'browser' && internetPane === 'processes')}
            hasIndicator={processesItem.hasIndicator}
            indicatorKind={processesItem.indicatorKind}
            indicatorLabel={processesItem.indicatorLabel}
            badgeCount={processesItem.badgeCount}
            onClick={() => {
              if (mode === 'browser') onSelectInternetPane('processes' as BotInternetPane);
              else handleHomeItem('processes');
            }}
          >
            {renderRailIcon(processesItem.icon)}
          </RailButton>
        ) : null}
        {/* The update badge does NOT ride the rail (it squeezed into the 64px
            column on the browser face): BOTH faces render it in their mid
            column's header instead — HomeSidebar's actions row on the home
            face, Sidebar's Studio task header row on the browser face.
            Owner order 2026-11-21 17:46: the bottom-left slot under the
            Settings gear carries the version/update module — the ONE control
            surface (red dot, status, check action, auto-check switch). */}
        {showSettings ? (
          <RailButton
            itemId="settings"
            label={i18nService.t('settings')}
            active={false}
            onClick={onShowSettings}
          >
            <Cog6ToothIcon className="h-6 w-6" />
          </RailButton>
        ) : null}
        {updateModule}
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
