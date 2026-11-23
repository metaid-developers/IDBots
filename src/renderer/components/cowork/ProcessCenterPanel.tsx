import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import {
  ArchiveBoxIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuChipIcon,
  EllipsisHorizontalIcon,
  HandRaisedIcon,
  LockClosedIcon,
} from '@heroicons/react/24/outline';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { SessionAvatarCircle, formatRelativeTime } from './CoworkSessionItem';
import {
  buildArchivedProcessEntries,
  buildProcessZones,
  countAwaitingProcesses,
  countBotSelfDigested,
  PROCESS_KIND_LABEL_KEY,
  processTreeKeyOf,
  PROCESS_STATE_DOT_COLOR,
  PROCESS_TAG_CLASS,
  lineageBucketOf,
  splitProcessHub,
  type ProcessEntry,
  type ProcessState,
  type LineageBucket,
  type ProcessHubViewState,
  type ProcessTreeNode,
  type ProcessZone,
} from '../../utils/processCenter';
import { setLineageBucket, useLineageOverrides } from '../../utils/processHubLineageStore';

/**
 * 进程中心 (Process Hub) v2 — the machine-started runs, as their own panel.
 *
 * Owner ruling 2026-11-21 (23:27–00:24, v1; 16:37, v2 返工):
 *  - v1 made the runs their own panel reached from the left function rail;
 *  - v2 turns the 2k+ ROW LIST into a TREE (task = parent, its runs = children)
 *    and demotes 待你拍板 from a tab to one always-on strip.
 *
 * Shape (v2):
 *  - header: title + three ZONE tabs — 编排树 / 定时任务 / 长期工作. The three
 *    zones are separate TABS rather than three blocks of one scroll: measured
 *    on this machine, one zone alone holds 1,381 runs (752 top-level nodes), so
 *    a single unified scroll would be ~1,425 items — not browsable. Numbers are
 *    in the delivery report's Mon-decision section.
 *  - 待你拍板 strip: pinned under the header, pale yellow (#fffbe8 on #e6c93e),
 *    with the count badge on the right; clicking it expands the awaited list in
 *    place. This is the ONE home of an awaited run — zones exclude them, so the
 *    old "tab1 renders awaiting twice" double semantics is gone.
 *  - tree: a parent row (36px) groups a task's runs; expanding it reveals the
 *    children (32px, 16px indent, 1px #e3e6ea connector). Rows that cannot be
 *    grouped stay top-level leaves — no parent is ever fabricated.
 *  - ⋯ valve (归档 / 移出) rides RUN rows only: a task group is a view over
 *    runs, not an object with its own lifecycle.
 *  - read-only contract: opening any run renders the SAME transcript read-only
 *    (the composer gate lives in CoworkSessionDetail, keyed on the shared
 *    membership rule).
 */

const RELATIVE_TIME_TICK_MS = 60_000;

/** How many top-level nodes mount before the "show more" step takes over. */
const VISIBLE_NODE_BUDGET = 80;

const ZONE_LABEL_KEY: Record<ProcessZone, string> = {
  orch: 'processZoneOrch',
  scheduled: 'processZoneScheduled',
  longterm: 'processZoneLongterm',
};

const ZONE_ORDER: ProcessZone[] = ['orch', 'scheduled', 'longterm'];

/**
 * The in-row type tag. Copied from the app's existing tag spec (MetaTaskBoard /
 * MetaTaskDetail: `px-1.5 py-0.5 text-[11px] rounded`), with the shared border
 * tokens — replacing this panel's earlier self-invented 10px / rounded-[4px].
 */
/** Derived once per render: the panel's live model (awaiting / running / human). */
const useProcessHubModel = (lineageOverrides: ReturnType<typeof useLineageOverrides>) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  const decisionSessionIds = useMemo(
    () => new Set((longTermBoard?.cards ?? []).flatMap((card) => card.decisionSessionIds ?? [])),
    [longTermBoard],
  );
  // One clock for every row's relative stamp, ticked once a minute — the same
  // contract the session list uses, so "5m" cannot freeze on a memoized row.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const model = useMemo(
    () => splitProcessHub(sessions, decisionSessionIds, nowMs, undefined, lineageOverrides),
    [sessions, decisionSessionIds, nowMs, lineageOverrides],
  );
  return { model, nowMs };
};

/** A run row: one session. `depth` 1 means it sits under a task parent. */
const ProcessRunRow: React.FC<{
  entry: ProcessEntry;
  nowMs: number;
  depth: 0 | 1;
  onOpen: (sessionId: string) => void;
  /** The ⋯ valve: archive a run, or pull it out of the hub (back to the list). */
  onArchive?: (sessionId: string) => void;
  onRemove?: (sessionId: string) => void;
  /** bot-bucket rows keep a grey dot: awaiting, but not asking the owner. */
  mutedDot?: boolean;
  /** 出口路由 valve: flip this row between the human and bot buckets. */
  bucket?: LineageBucket;
  onSetBucket?: (sessionId: string, bucket: LineageBucket) => void;
}> = ({ entry, nowMs, depth, onOpen, onArchive, onRemove, mutedDot = false, bucket, onSetBucket }) => {
  const { session, kind, state } = entry;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const relative = formatRelativeTime(session.updatedAt, nowMs);
  const kindLabel = i18nService.t(PROCESS_KIND_LABEL_KEY[kind]);
  const { statusKind, error, stalePending } = entry;
  const orchestratorName = session.metabotName?.trim() || '';

  const toggleMenu = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (menu) {
      setMenu(null);
      return;
    }
    const rect = menuButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const padding = 8;
    setMenu({
      x: Math.max(padding, Math.min(rect.right - 176, window.innerWidth - 176 - padding)),
      y: Math.min(rect.bottom + 4, window.innerHeight - 96),
    });
  };

  // Outside click / Escape closes the valve, like every other row menu here.
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && (menuRef.current?.contains(target) || menuButtonRef.current?.contains(target))) return;
      setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menu]);

  const runMenuAction = (action: 'archive' | 'remove') => (event: React.MouseEvent) => {
    event.stopPropagation();
    setMenu(null);
    if (action === 'archive') onArchive?.(session.id);
    else onRemove?.(session.id);
  };

  const hasValve = Boolean(onArchive || onRemove);
  // Spec ① pins PIXELS (parent 36px / child 32px). This app sets `html` to
  // 15px, so the rem-based utilities would render 33.75 / 30 — measured, not
  // assumed — hence explicit px classes instead of h-9 / h-8.
  const heightClass = depth === 1 ? 'h-[32px]' : 'h-[36px]';
  const textSize = depth === 1 ? 'text-[12px]' : 'text-[12.5px]';

  return (
    <div
      data-testid="process-row"
      data-process-row-depth={depth}
      data-process-state={state}
      data-process-kind={kind}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(session.id);
        }
      }}
      className={`flex ${heightClass} cursor-pointer items-center gap-2.5 rounded-[8px] border px-3 ${textSize} ${statusKind === 'pending' ? 'process-row-pending border-l-[2px] border-l-[#e6c93e]' : ''} ${statusKind === 'dead' ? 'process-row-dead' : ''} transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
        entry.awaitingVerdict
          ? 'border-[#e6c93e] bg-[#fffbe8] dark:border-amber-700/60 dark:bg-amber-900/15'
          : 'border-claude-border bg-claude-bg hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:bg-claude-darkBg dark:hover:bg-claude-darkSurfaceHover'
      }`}
    >
      {/* Column order (owner order 2026-11-21 20:15): the IDENTITY of who runs it
          and when it last moved come FIRST; the title (the long, variable-width
          string) moves to the elastic slot before the valve so it absorbs the
          remaining width instead of pushing the fixed columns around.
          dot · orchestrator · latest activity · title · kind tag · valve */}
      {/* v2.1 row (owner ruling 2026-11-22 00:41, superseding the 20:15 order):
          the TASK leads — a bot may never occupy the head of the line.
          dot · task name · [spark] · kind · time · signature · valve */}
      <span
        aria-hidden
        data-testid="process-state-dot"
        className={`h-2 w-2 flex-shrink-0 rounded-full ${statusKind === 'live' ? 'process-dot-live' : ''}`}
        style={{
          backgroundColor: error
            ? PROCESS_STATE_DOT_COLOR.error
            : mutedDot
              ? PROCESS_STATE_DOT_COLOR.dead
              : PROCESS_STATE_DOT_COLOR[statusKind],
        }}
      />
      <span
        data-testid="process-row-title"
        className={`min-w-0 flex-1 truncate font-semibold ${statusKind === 'dead' ? 'process-row-dead-text' : ''} dark:text-claude-darkText text-claude-text`}
      >
        {processTreeKeyOf(session.title || '') || i18nService.t('coworkNewSession')}
      </span>
      {stalePending && (
        <span
          aria-hidden
          data-testid="process-row-stale-pending"
          className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
          style={{ backgroundColor: PROCESS_STATE_DOT_COLOR.pending }}
        />
      )}
      {statusKind === 'live' && (
        <span
          aria-hidden
          data-testid="process-row-spark"
          className="flex h-3 w-[48px] flex-shrink-0 items-end gap-[1px]"
          title={i18nService.t('processStateLive')}
        >
          {Array.from({ length: 24 }, (_, index) => (
            <i key={index} className="block w-[2px] rounded-t-[1px] bg-[#22a06b]/40" style={{ height: '25%' }} />
          ))}
        </span>
      )}
      <span className={PROCESS_TAG_CLASS}>
        {kindLabel}
      </span>
      <span
        data-testid="process-row-activity"
        className="w-[52px] flex-shrink-0 text-right text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={relative.full}
      >
        {relative.compact}
      </span>
      {statusKind === 'pending' && (
        <span
          data-testid="process-row-decide"
          className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-[#7a5f14] dark:text-amber-300"
        >
          {i18nService.t('processGoDecide')}
        </span>
      )}
      {orchestratorName && (
        <span
          data-testid="process-row-orchestrator"
          className="flex w-[86px] flex-shrink-0 items-center justify-end gap-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={`${i18nService.t('processOrchestratorLabel')}: ${orchestratorName}`}
        >
          <SessionAvatarCircle src={session.metabotAvatar} name={orchestratorName} sizeClass="h-4 w-4" />
          <span className="min-w-0 truncate">{orchestratorName}</span>
        </span>
      )}
      {hasValve && (
        <button
          ref={menuButtonRef}
          type="button"
          data-testid="process-row-valve"
          aria-label={i18nService.t('coworkSessionActions')}
          aria-haspopup="menu"
          aria-expanded={menu != null}
          onClick={toggleMenu}
          className="flex-shrink-0 rounded-[6px] p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
        >
          <EllipsisHorizontalIcon className="h-4 w-4" />
        </button>
      )}
      {menu && (
        <div
          ref={menuRef}
          role="menu"
          data-testid="process-row-menu"
          className="fixed z-50 min-w-[176px] overflow-hidden rounded-xl border border-claude-border bg-claude-bg shadow-lg dark:border-claude-darkBorder dark:bg-claude-darkSurface"
          style={{ top: menu.y, left: menu.x }}
        >
          {onArchive && (
            <button
              type="button"
              role="menuitem"
              onClick={runMenuAction('archive')}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArchiveBoxIcon className="h-4 w-4" />
              {i18nService.t('processArchiveAction')}
            </button>
          )}
          {onRemove && (
            <button
              type="button"
              role="menuitem"
              onClick={runMenuAction('remove')}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover"
            >
              <HandRaisedIcon className="h-4 w-4" />
              {i18nService.t('processRemoveAction')}
            </button>
          )}
          {/* 出口路由 v1: the row-level valve that decides WHICH strip shows it.
              Gate on `state === 'awaiting'`, NOT on awaitingVerdict: a bot-bucket
              row deliberately carries awaitingVerdict=false (it is not asking the
              owner), and gating on it locked the row out of its own escalation. */}
          {onSetBucket && bucket && state === 'awaiting' && (
            <>
              <div aria-hidden className="my-1 border-t border-claude-border dark:border-claude-darkBorder" />
              {bucket === 'bot' ? (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="process-valve-escalate"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu(null);
                    onSetBucket(session.id, 'human');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover"
                >
                  <HandRaisedIcon className="h-4 w-4" />
                  {i18nService.t('processValveEscalate')}
                </button>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  data-testid="process-valve-demote"
                  onClick={(event) => {
                    event.stopPropagation();
                    setMenu(null);
                    onSetBucket(session.id, 'bot');
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-claude-surfaceHover dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover"
                >
                  <CpuChipIcon className="h-4 w-4" />
                  {i18nService.t('processValveDemote')}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * A task parent row (36px): the task title + how many runs it holds. Clicking
 * the row toggles the fold — the parent has no transcript of its own, so there
 * is nothing else a click could honestly mean.
 */
const ProcessTaskRow: React.FC<{
  node: ProcessTreeNode;
  nowMs: number;
  expanded: boolean;
  onToggle: () => void;
}> = ({ node, nowMs, expanded, onToggle }) => {
  const relative = formatRelativeTime(node.latestAt, nowMs);
  // A group is "moving" when any run inside it moved recently.
  const state: ProcessState = node.children.some((child) => child.state === 'running') ? 'running' : 'idle';
  const kindLabel = i18nService.t(PROCESS_KIND_LABEL_KEY[node.kind]);
  const orchestratorName = node.orchestratorName ?? '';

  return (
    <div
      data-testid="process-task-row"
      data-process-task-state={state}
      data-process-task-expanded={expanded ? 'true' : 'false'}
      data-process-run-count={node.children.length}
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggle}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onToggle();
        }
      }}
      className="flex h-[36px] cursor-pointer items-center gap-2 rounded-[8px] border border-claude-border bg-claude-bg px-3 text-[12.5px] transition-colors hover:bg-claude-surfaceHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:hover:bg-claude-darkSurfaceHover"
    >
      <span aria-hidden className="flex h-4 w-4 flex-shrink-0 items-center justify-center dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {expanded ? <ChevronDownIcon className="h-3.5 w-3.5" /> : <ChevronRightIcon className="h-3.5 w-3.5" />}
      </span>
      <span
        aria-hidden
        data-testid="process-task-dot"
        className="h-2 w-2 flex-shrink-0 rounded-full"
        style={{ backgroundColor: PROCESS_STATE_DOT_COLOR[state] }}
      />
      {/* Parent rows keep the SAME column order as their runs (dot ·
          orchestrator · activity · title · tags), so the eye reads one grid all
          the way down. */}
      {orchestratorName && (
        <span
          data-testid="process-task-orchestrator"
          className="flex w-[130px] flex-shrink-0 items-center gap-1.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={`${i18nService.t('processOrchestratorLabel')}: ${orchestratorName}`}
        >
          <SessionAvatarCircle src={node.orchestratorAvatar} name={orchestratorName} sizeClass="h-4 w-4" />
          <span className="min-w-0 truncate">{orchestratorName}</span>
        </span>
      )}
      <span
        data-testid="process-task-activity"
        className="w-[46px] flex-shrink-0 text-right text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={relative.full}
      >
        {relative.compact}
      </span>
      <span
        data-testid="process-task-title"
        className="min-w-0 flex-1 truncate font-semibold dark:text-claude-darkText text-claude-text"
      >
        {node.unassigned
          ? i18nService.t('processUnassignedGroup')
          : node.title || i18nService.t('coworkNewSession')}
      </span>
      <span className={PROCESS_TAG_CLASS}>
        {i18nService.t('processTreeRunCount').replace('{count}', String(node.children.length))}
      </span>
      <span className={PROCESS_TAG_CLASS}>
        {kindLabel}
      </span>
    </div>
  );
};

const ProcessCenterPanel: React.FC<{
  onOpenProcess: (sessionId: string) => void;
  /**
   * Where the hub was when the owner last left it. Read ONCE on mount (so a
   * return lands on the same zone / fold / scroll), then written back on every
   * change. A plain ref — not state — because scroll updates must not re-render
   * the App shell on every pixel.
   */
  viewStateRef?: React.MutableRefObject<ProcessHubViewState>;
}> = ({ onOpenProcess, viewStateRef }) => {
  const lineageOverrides = useLineageOverrides();
  const { model, nowMs } = useProcessHubModel(lineageOverrides);
  const restored = viewStateRef?.current;
  const [zone, setZone] = useState<ProcessZone>(restored?.zone ?? 'orch');
  const [archivedMode, setArchivedMode] = useState(restored?.archivedMode ?? false);
  const [awaitingExpanded, setAwaitingExpanded] = useState(false);
  const [botExpanded, setBotExpanded] = useState(false);
  // Default COLLAPSED: with 98 grouped tasks in the orchestration zone alone,
  // open-by-default would defeat the point of folding.
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set(restored?.expandedTaskKeys ?? []),
  );
  const [visibleNodes, setVisibleNodes] = useState(VISIBLE_NODE_BUDGET);
  // Lazily read on the first visit of 已归档: the live list query never carries
  // archived rows, and nothing else in the panel needs them.
  const [archivedEntries, setArchivedEntries] = useState<ProcessEntry[] | null>(null);

  useEffect(() => {
    if (!archivedMode || archivedEntries !== null) return;
    let cancelled = false;
    const read = async () => {
      const reader = window.electron?.cowork?.listArchivedSessions;
      if (typeof reader !== 'function') return [];
      const result = await reader({ limit: 100 });
      return result?.success && Array.isArray(result.sessions)
        ? buildArchivedProcessEntries(result.sessions)
        : [];
    };
    void read()
      .then((entries) => {
        if (!cancelled) setArchivedEntries(entries);
      })
      .catch(() => {
        if (!cancelled) setArchivedEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [archivedMode, archivedEntries]);

  // Mirror zone/archived into the caller's ref, and restore the scroll offset
  // the owner left at (after the first paint, so the list has its height).
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewStateRef) return;
    viewStateRef.current = {
      ...viewStateRef.current,
      zone,
      archivedMode,
      expandedTaskKeys: [...expandedTasks],
    };
  }, [viewStateRef, zone, archivedMode, expandedTasks]);
  useEffect(() => {
    const el = bodyRef.current;
    const target = viewStateRef?.current.scrollTop ?? 0;
    if (el && target > 0) el.scrollTop = target;
    // restore once per mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const handleBodyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!viewStateRef) return;
    viewStateRef.current = { ...viewStateRef.current, scrollTop: event.currentTarget.scrollTop };
  };

  const awaitingCount = countAwaitingProcesses(model);
  const botCount = countBotSelfDigested(model);
  const zones = useMemo(() => buildProcessZones(model.running), [model.running]);
  const zoneModel = zones[zone];
  const nodes = zoneModel.nodes.slice(0, visibleNodes);

  const handleArchive = (sessionId: string) => {
    void coworkService.archiveSession(sessionId);
  };
  /** 移出进程中心: a manual 'out' placement — the row lands back in the human
   * conversation list without touching its creation fact. */
  const handleRemove = (sessionId: string) => {
    void coworkService.setSessionFoldOverride(sessionId, 'out');
  };

  const toggleTask = (key: string) => {
    setExpandedTasks((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const renderRun = (entry: ProcessEntry, depth: 0 | 1, allowValve: boolean, mutedDot = false) => (
    <ProcessRunRow
      key={entry.session.id}
      entry={entry}
      nowMs={nowMs}
      depth={depth}
      onOpen={onOpenProcess}
      onArchive={allowValve ? handleArchive : undefined}
      onRemove={allowValve ? handleRemove : undefined}
      mutedDot={mutedDot}
      bucket={lineageBucketOf(entry.session.id, lineageOverrides)}
      onSetBucket={allowValve ? (sessionId, next) => void setLineageBucket(sessionId, next) : undefined}
    />
  );

  return (
    <div
      data-testid="process-center-panel"
      data-process-zone={zone}
      data-process-archived-mode={archivedMode ? 'true' : 'false'}
      className="flex h-full min-h-0 flex-col bg-claude-bg dark:bg-claude-darkBg"
    >
      {/* Header: title + the three zone tabs (spec ②). */}
      {/* Header = the reference panel's TWO-TIER bar (ScheduledTasksView:104):
          an h-12 outer strip with an h-8 inner content block, so the divider
          line keeps ~8px of breathing room above AND below it. A single 36px
          tier put the title and the 32px switcher too close to the line. */}
      <div
        data-slot="process-panel-header"
        className="flex h-12 shrink-0 items-center gap-2 border-b border-claude-border px-4 dark:border-claude-darkBorder"
      >
        <div data-slot="process-panel-header-inner" className="flex h-8 min-w-0 items-center gap-2">
          {/* Title size = the app's panel-title convention (text-lg font-semibold,
              copied from ScheduledTasksView / GroupTaskDetailView), not a bespoke 14.5px. */}
          <div className="flex min-w-0 items-center gap-2 text-lg font-semibold dark:text-claude-darkText text-claude-text">
            <CpuChipIcon className="h-4 w-4 shrink-0" />
            <span className="truncate">{i18nService.t('processCenterTitle')}</span>
          </div>
        </div>
        <div
          role="tablist"
          aria-label={i18nService.t('processCenterTitle')}
          data-testid="process-zones"
          className="ml-auto grid h-[32px] grid-cols-3 gap-0 overflow-hidden rounded-[var(--shape-radius-sm)] border border-claude-border/70 bg-claude-bg/80 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
        >
          {ZONE_ORDER.map((key) => {
            const selected = key === zone;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                data-process-zone-key={key}
                aria-selected={selected}
                onClick={() => {
                  setZone(key);
                  setArchivedMode(false);
                  setVisibleNodes(VISIBLE_NODE_BUDGET);
                }}
                className={`inline-flex h-full min-w-0 items-center justify-center gap-1 px-2 text-xs font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                  selected
                    // Same fill pair as the switcher master: claude-accent = #FFDC51,
                    // claude-accentInk = #303133.
                    ? 'bg-claude-accent text-claude-accentInk'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover/70 dark:hover:bg-claude-darkSurfaceHover/70'
                }`}
              >
                {i18nService.t(ZONE_LABEL_KEY[key])}
                <span className="ml-1 tabular-nums opacity-70">{zones[key].nodes.length}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 待你拍板 strip (spec ②): always on, above the tree, one source of truth
          with the rail badge. Awaited runs live HERE and nowhere else. */}
      <div
        data-testid="process-awaiting-strip"
        data-awaiting-count={awaitingCount}
        className="shrink-0 border-b border-[#e6c93e] bg-[#fffbe8] dark:border-amber-700/60 dark:bg-amber-900/15"
      >
        <button
          type="button"
          data-testid="process-awaiting-toggle"
          aria-expanded={awaitingExpanded}
          onClick={() => setAwaitingExpanded((previous) => !previous)}
          className="flex h-[36px] w-full items-center gap-2 px-4 text-left"
        >
          <span aria-hidden className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[#8a6d1a] dark:text-amber-300">
            {awaitingExpanded ? <ChevronDownIcon className="h-3.5 w-3.5" /> : <ChevronRightIcon className="h-3.5 w-3.5" />}
          </span>
          <HandRaisedIcon className="h-3.5 w-3.5 flex-shrink-0 text-[#8a6d1a] dark:text-amber-300" />
          <span className="min-w-0 truncate text-[12.5px] font-semibold text-[#7a5f14] dark:text-amber-200">
            {i18nService.t('processAwaitingStripLabel')}
          </span>
          <span
            data-testid="process-awaiting-count"
            // Verbatim copy of the rail badge (WorkspaceRail RailButton).
            className="flex h-[14px] min-w-[14px] flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-[3px] text-[9.5px] font-bold leading-none text-white"
          >
            {awaitingCount}
          </span>
          <span className="min-w-0 truncate text-[11px] text-[#8a6d1a] dark:text-amber-300/90">
            {awaitingCount > 0
              ? i18nService.t('processAwaitingStripHint')
              : i18nService.t('processAwaitingStripEmptyBot')}
          </span>
        </button>
        {awaitingExpanded && awaitingCount > 0 && (
          <div
            data-testid="process-awaiting-list"
            className="flex max-h-[min(45vh,420px)] flex-col gap-1.5 overflow-y-auto overscroll-contain px-4 pb-2"
          >
            {model.awaiting.map((entry) => renderRun(entry, 0, true))}
          </div>
        )}
      </div>

      {/* bot 自行消化 silent bar (出口路由 v1): the awaited runs the bot is
          handling itself. Grey, collapsed by default, and it NEVER asks for a
          verdict — no red dot, no badge contribution. */}
      {botCount > 0 && (
        <div
          data-testid="process-bot-bar"
          data-bot-count={botCount}
          className="shrink-0 border-b border-claude-border dark:border-claude-darkBorder"
        >
          <button
            type="button"
            data-testid="process-bot-toggle"
            aria-expanded={botExpanded}
            onClick={() => setBotExpanded((previous) => !previous)}
            className="flex h-[32px] w-full items-center gap-2 px-4 text-left text-claude-textSecondary dark:text-claude-darkTextSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            <span aria-hidden className="flex h-4 w-4 flex-shrink-0 items-center justify-center">
              {botExpanded ? <ChevronDownIcon className="h-3.5 w-3.5" /> : <ChevronRightIcon className="h-3.5 w-3.5" />}
            </span>
            <CpuChipIcon aria-hidden className="h-3.5 w-3.5 flex-shrink-0 opacity-70" />
            <span className="min-w-0 truncate text-[11.5px]">
              {i18nService.t('processBotBar').replace('{count}', String(botCount))}
            </span>
          </button>
          {botExpanded && (
            <div
              data-testid="process-bot-list"
              className="flex max-h-[min(45vh,420px)] flex-col gap-1.5 overflow-y-auto overscroll-contain px-4 pb-2"
            >
              {model.botSelfDigested.map((entry) => renderRun(entry, 0, true, true))}
            </div>
          )}
        </div>
      )}

      <div
        ref={bodyRef}
        onScroll={handleBodyScroll}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-2.5"
      >
        {archivedMode ? (
          (archivedEntries ?? []).length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center">
              <ArchiveBoxIcon aria-hidden className="h-5 w-5 opacity-40 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              <p className="max-w-[16rem] text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('processEmptyArchived')}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {(archivedEntries ?? []).map((entry) => renderRun(entry, 0, false))}
            </div>
          )
        ) : zoneModel.nodes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 py-10 text-center">
            <CpuChipIcon
              aria-hidden
              className="h-5 w-5 opacity-40 dark:text-claude-darkTextSecondary text-claude-textSecondary"
            />
            <p className="max-w-[16rem] text-xs leading-5 dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('processEmptyZone')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <div
              data-testid="process-zone-heading"
              className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              {i18nService.t(ZONE_LABEL_KEY[zone])} · {zoneModel.nodes.length}
            </div>
            {nodes.map((node) => {
              if (!node.grouped) {
                return renderRun(node.children[0], 0, true);
              }
              const expanded = expandedTasks.has(node.key);
              return (
                <div key={node.key} data-testid="process-tree-group" data-process-tree-key={node.key}>
                  <ProcessTaskRow
                    node={node}
                    nowMs={nowMs}
                    expanded={expanded}
                    onToggle={() => toggleTask(node.key)}
                  />
                  {expanded && (
                    // 16px indent + the 1px connector (spec ①).
                    <div
                      data-testid="process-tree-children"
                      className="ml-[16px] mt-1 flex flex-col gap-1 border-l border-[#e3e6ea] pl-2 dark:border-claude-darkBorder"
                    >
                      {node.children.map((child) => renderRun(child, 1, true))}
                    </div>
                  )}
                </div>
              );
            })}
            {zoneModel.nodes.length > nodes.length && (
              <button
                type="button"
                data-testid="process-show-more"
                onClick={() => setVisibleNodes((previous) => previous + VISIBLE_NODE_BUDGET)}
                className="mt-1 flex h-8 w-full items-center justify-center rounded-[8px] border border-dashed border-claude-border text-[11.5px] dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('processShowMore').replace('{count}', String(zoneModel.nodes.length - nodes.length))}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Footer: the read-only contract + the archived reader's only door (the
          archived list left the tab row in v2, so it needs one explicit entry
          rather than disappearing from the UI). */}
      <div className="flex shrink-0 items-center gap-2 border-t border-claude-border px-4 py-2 dark:border-claude-darkBorder">
        <LockClosedIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        <span className="min-w-0 truncate text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkProcessReadOnlyHint')}
        </span>
        <button
          type="button"
          data-testid="process-archived-toggle"
          aria-pressed={archivedMode}
          onClick={() => setArchivedMode((previous) => !previous)}
          className="ml-auto flex flex-shrink-0 items-center gap-1 text-[11.5px] font-semibold text-claude-accent transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        >
          <ArchiveBoxIcon className="h-3.5 w-3.5" />
          {i18nService.t(archivedMode ? 'processArchivedBack' : 'processTabArchived')}
        </button>
      </div>
    </div>
  );
};

export default ProcessCenterPanel;
