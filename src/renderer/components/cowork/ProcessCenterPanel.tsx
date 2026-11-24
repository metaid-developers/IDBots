import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CpuChipIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  LockClosedIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { StopIcon } from '@heroicons/react/24/solid';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { setNewTaskMetabotId } from '../../store/slices/coworkSlice';
import { SessionAvatarCircle, formatRelativeTime } from './CoworkSessionItem';
import type { CoworkPermissionRequest } from '../../types/cowork';
import {
  autonomousChipCounts,
  buildArchivedProcessEntries,
  buildOrchestrationZone,
  buildProcessAutonomous,
  buildProcessDynamic,
  buildProcessGateEntries,
  buildUnassignedHumanEntries,
  buildTwinSteeringPrompt,
  countAwaitingProcesses,
  countAutonomousRuns,
  countBotSelfDigested,
  lastAssistantDigest,
  openDecisionIdsForSession,
  PROCESS_AUTONOMOUS_SOURCE_LABEL_KEY,
  PROCESS_AUTONOMOUS_SOURCE_ORDER,
  PROCESS_HUB_TAB_LABEL_KEY,
  PROCESS_HUB_TAB_ORDER,
  PROCESS_KIND_LABEL_KEY,
  PROCESS_RECENT_ENDED_BUDGET,
  processGateQuestionOf,
  processTreeKeyOf,
  PROCESS_STATE_DOT_COLOR,
  PROCESS_TAG_CLASS,
  ProcessGateClass,
  ProcessRowValveLevel,
  lineageBucketOf,
  resolveSourceTaskTitle,
  retrySteerVisible,
  rowValveLevelOf,
  splitProcessHub,
  type ProcessAutonomousSource,
  type ProcessEntry,
  type ProcessHubTab,
  type ProcessState,
  type LineageBucket,
  type ProcessHubViewState,
  type ProcessTreeNode,
  type ProcessZone,
} from '../../utils/processCenter';
import {
  automationEntriesFor,
  automationRunCounts,
  buildAutomationEntries,
  type ProcessAutomationEntry,
  type ProcessDreamRunLike,
  type ProcessSurfRunLike,
} from '../../utils/processAutomation';
import { setLineageBucket, useLineageOverrides } from '../../utils/processHubLineageStore';
import ProcessSparkline from './ProcessSparkline';
import {
  normalizeSparkReading,
  sparkHasData,
  type ProcessSparkReading,
} from '../../utils/processSpark';

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
 *
 * v4 (owner ruling 2026-11-23 00:09) — 动态进程优先:
 *  - the landing page is 动态: 正在运行 (breathing rows: 谁 · 任务名 · 开始多久 ·
 *    一句当前动作) with 最近结束 (完成/失败 counts, newest first, foldable) below;
 *  - 编排树 / 定时任务 / 长期工作 stop being the first screen and become three
 *    secondary tabs — 动态 | 编排 | 定时 | 长期, 动态 selected and first;
 *  - the 567/657 flat counts move into the tab badges (角标), and the 待你拍板
 *    strip stays pinned above every tab with unchanged count semantics;
 *  - no new table: 动态 is a re-projection of the same byStatus bands
 *    (pending / live / dead) — pending rows stay in the strip, never in a band.
 */

const RELATIVE_TIME_TICK_MS = 60_000;

/** How many top-level nodes mount before the "show more" step takes over. */
const VISIBLE_NODE_BUDGET = 80;

const ZONE_LABEL_KEY: Record<ProcessZone, string> = {
  orch: 'processZoneOrch',
  scheduled: 'processZoneScheduled',
  longterm: 'processZoneLongterm',
};

/**
 * The in-row type tag. Copied from the app's existing tag spec (MetaTaskBoard /
 * MetaTaskDetail: `px-1.5 py-0.5 text-[11px] rounded`), with the shared border
 * tokens — replacing this panel's earlier self-invented 10px / rounded-[4px].
 */
/** Derived once per render: the panel's live model (awaiting / running / human). */
const useProcessHubModel = (lineageOverrides: ReturnType<typeof useLineageOverrides>) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  // The one signal that is live (not a snapshot): which session the app is
  // streaming right now. The list's `status` lags the DB — measured: a running
  // session still read 'completed' in the list, so its row painted grey.
  const streamingSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  const decisionSessionIds = useMemo(
    () => new Set((longTermBoard?.cards ?? []).flatMap((card) => card.decisionSessionIds ?? [])),
    [longTermBoard],
  );
  // One clock for every row's relative stamp, ticked once a minute — the same
  // contract the session list uses, so "5m" cannot freeze on a memoized row.
  const [nowMs, setNowMs] = useState(() => Date.now());
  /**
   * Freshness on open (Mon's finding, 01:2x): the list snapshot's `status` lags
   * the DB — a session that IS running can still read 'completed' here, which
   * painted the only live process grey. `isStreaming` covers the in-turn case
   * but is false between turns, so the authoritative fix is to re-read the list
   * when the hub opens and again when a turn ends.
   */
  useEffect(() => {
    void coworkService.loadSessions();
  }, []);
  useEffect(() => {
    if (!isStreaming) void coworkService.loadSessions();
  }, [isStreaming]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const model = useMemo(
    () => splitProcessHub(
      sessions,
      decisionSessionIds,
      nowMs,
      undefined,
      lineageOverrides,
      isStreaming ? streamingSessionId : null,
    ),
    [sessions, decisionSessionIds, nowMs, lineageOverrides, isStreaming, streamingSessionId],
  );
  return { model, nowMs };
};

/**
 * 一句当前动作 (v4 动态页签): the last thing the bot SAID it was doing, read from
 * the same transcript the dossier reads. Only live rows are read (usually 0–2),
 * one newest-first page each, and the read is capped so a stuck DB can never
 * turn the landing page into a queue of IPC calls. A missing bridge or an empty
 * transcript simply yields no line — the row then shows the state fallback
 * instead of inventing an action.
 */
const LIVE_ACTION_READ_LIMIT = 6;
const LIVE_ACTION_PAGE_SIZE = 24;

const useLiveActionLines = (entries: readonly ProcessEntry[]): Record<string, string> => {
  const [lines, setLines] = useState<Record<string, string>>({});
  const idsKey = entries
    .slice(0, LIVE_ACTION_READ_LIMIT)
    .map((entry) => entry.session.id)
    .join('|');
  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    if (ids.length === 0) {
      setLines({});
      return;
    }
    let cancelled = false;
    const read = async () => {
      const reader = window.electron?.cowork?.getSessionMessagesPage;
      if (typeof reader !== 'function') return {};
      const next: Record<string, string> = {};
      for (const id of ids) {
        try {
          const result = await reader({ sessionId: id, limit: LIVE_ACTION_PAGE_SIZE });
          const messages = result?.success ? result.page?.messages : null;
          const digest = lastAssistantDigest(messages, 96);
          if (digest) next[id] = digest;
        } catch {
          // One unreadable transcript must not blank the other live rows.
        }
      }
      return next;
    };
    void read()
      .then((next) => {
        if (!cancelled) setLines(next);
      })
      .catch(() => {
        if (!cancelled) setLines({});
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey]);
  return lines;
};

/**
 * 火花线取数面 (2026-11-23): ONE batched read for every run row the hub renders.
 * The channel is thin (ids in, 24 counts per session out) and the worker does
 * the grouping, so this hook never fans out per row. `refreshKey` is the turn
 * boundary — a finished turn means new message timestamps, so the strip is
 * re-read then (and only then, plus when the row set itself changes).
 */
const SPARK_READ_LIMIT = 120;

const useSessionSparks = (
  entries: readonly ProcessEntry[],
  refreshKey: string,
): Record<string, ProcessSparkReading> => {
  const [sparks, setSparks] = useState<Record<string, ProcessSparkReading>>({});
  const idsKey = useMemo(() => {
    const seen = new Set<string>();
    for (const entry of entries) {
      const id = entry?.session?.id;
      if (!id) continue;
      seen.add(id);
      if (seen.size >= SPARK_READ_LIMIT) break;
    }
    return [...seen].join('|');
  }, [entries]);
  useEffect(() => {
    const ids = idsKey ? idsKey.split('|') : [];
    if (ids.length === 0) {
      setSparks({});
      return;
    }
    let cancelled = false;
    const read = async () => {
      const reader = window.electron?.cowork?.activitySpark;
      if (typeof reader !== 'function') return {};
      const result = await reader({ sessionIds: ids });
      if (!result?.success || !result.sparks) return {};
      const next: Record<string, ProcessSparkReading> = {};
      for (const id of ids) next[id] = normalizeSparkReading(result.sparks[id]);
      return next;
    };
    void read()
      .then((next) => {
        if (!cancelled) setSparks(next);
      })
      .catch(() => {
        // An unreadable spark must never blank the hub — the row then shows
        // its empty state (no bars invented from a failed read).
        if (!cancelled) setSparks({});
      });
    return () => {
      cancelled = true;
    };
  }, [idsKey, refreshKey]);
  return sparks;
};

/* ─────────── 自主进程 · 做梦 / 冲浪 (owner 2026-11-24 17:23) ───────────
 *
 * Both are bot-initiated runs with their own existing read IPC:
 *   dream:listRuns({metabotId})   → metabot_dream_runs
 *   surf:listRuns(metabotId)      → metaweb_surf_runs
 * No new channel is introduced. The six-hour budget per bot is deliberate: a
 * hub mount is a read, and a bot with no automation rows is a cheap empty read.
 * A failed read degrades to "no automation rows" — the hub never invents one.
 */
const AUTOMATION_READ_PER_BOT = 6;

interface ProcessAutomationBot {
  id: number;
  name: string;
  avatar: string | null;
}

const useProcessAutomationRuns = (enabled: boolean): {
  entries: ProcessAutomationEntry[];
  bots: Record<number, ProcessAutomationBot>;
} => {
  const [entries, setEntries] = useState<ProcessAutomationEntry[]>([]);
  const [botsById, setBotsById] = useState<Record<number, ProcessAutomationBot>>({});
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const read = async () => {
      const listResult = await window.electron?.metabot?.list?.();
      const bots = listResult?.list ?? [];
      const ids = bots
        .map((bot) => Number(bot?.id))
        .filter((id) => Number.isInteger(id) && id > 0);
      const identity: Record<number, ProcessAutomationBot> = {};
      for (const bot of bots) {
        const id = Number(bot?.id);
        if (!Number.isInteger(id) || id <= 0) continue;
        identity[id] = {
          id,
          name: String(bot?.name ?? '').trim() || `#${id}`,
          avatar: typeof bot?.avatar === 'string' && bot.avatar ? bot.avatar : null,
        };
      }
      const dreamRows: ProcessDreamRunLike[] = [];
      const surfRows: ProcessSurfRunLike[] = [];
      for (const metabotId of ids) {
        try {
          const result = await window.electron?.dream?.listRuns?.({ metabotId, limit: AUTOMATION_READ_PER_BOT });
          for (const row of Array.isArray(result?.runs) ? result.runs : []) {
            if (row && typeof row.id === 'string') dreamRows.push(row as ProcessDreamRunLike);
          }
        } catch {
          // Degrade: one bot's failed read must not blank the section.
        }
        try {
          const result = await window.electron?.surf?.listRuns?.(metabotId, AUTOMATION_READ_PER_BOT);
          for (const row of Array.isArray(result?.runs) ? result.runs : []) {
            if (row && typeof row.id === 'string') surfRows.push(row as ProcessSurfRunLike);
          }
        } catch {
          // Same degrade rule as the dream read above.
        }
      }
      return { entries: buildAutomationEntries(dreamRows, surfRows), bots: identity };
    };
    void read()
      .then((next) => {
        if (cancelled) return;
        setEntries(next.entries);
        setBotsById(next.bots);
      })
      .catch(() => {
        if (cancelled) return;
        setEntries([]);
        setBotsById({});
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, isStreaming]);
  return { entries, bots: botsById };
};

/** 自主 · 做梦 / 冲浪 run row (owner requirement 2026-11-24 17:23).
 *
 * It reuses the run row's OWN semantics (dot = three-state band, bot = tail
 * signature, relative stamp) instead of inventing an automation card: a bot's
 * nightly dream and its surf are runs like any other, they just have no
 * cowork session to open. No valve, no jump — display only. */
const ProcessAutomationRow: React.FC<{
  entry: ProcessAutomationEntry;
  nowMs: number;
  bot: ProcessAutomationBot | null;
}> = ({ entry, nowMs, bot }) => {
  const sourceLabel = i18nService.t(
    entry.source === 'dream' ? 'processSourceDream' : 'processSourceSurf',
  );
  const stateLabel = i18nService.t(entry.statusKind === 'live' ? 'processStateLive' : 'processStateDead');
  const dotColor = entry.error
    ? PROCESS_STATE_DOT_COLOR.error
    : entry.statusKind === 'live'
      ? PROCESS_STATE_DOT_COLOR.live
      : PROCESS_STATE_DOT_COLOR.dead;
  const stamp = formatRelativeTime(entry.startedAt, nowMs).compact;
  return (
    <div
      data-testid="process-automation-row"
      data-automation-source={entry.source}
      data-automation-status={entry.error ? 'failed' : entry.statusKind}
      title={[sourceLabel, entry.detail, stateLabel, entry.errorText].filter(Boolean).join(' · ')}
      className="flex h-[32px] items-center gap-2 rounded-[8px] border border-claude-border/60 px-2 dark:border-claude-darkBorder/60"
    >
      <span
        aria-hidden
        className={`h-2 w-2 flex-shrink-0 rounded-full ${entry.statusKind === 'live' && !entry.error ? 'process-dot-live' : ''}`}
        style={{ backgroundColor: dotColor }}
      />
      <span className="min-w-0 truncate text-[12.5px] font-medium dark:text-claude-darkText text-claude-text">
        {sourceLabel}
      </span>
      {entry.detail ? (
        <span className="min-w-0 truncate text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {entry.detail}
        </span>
      ) : null}
      <span className="ml-auto flex-shrink-0 text-[10.5px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {entry.error ? `${i18nService.t('notificationsGroupFailed')} · ` : ''}{stamp}
      </span>
      <span className="flex w-[86px] flex-shrink-0 items-center justify-end gap-1">
        {bot ? (
          <>
            <SessionAvatarCircle src={bot.avatar} name={bot.name} sizeClass="h-4 w-4" />
            <span className="min-w-0 truncate text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {bot.name}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('processUnattributedBot')}
          </span>
        )}
      </span>
    </div>
  );
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
  /**
   * S1 刹车阀 (Friday 稿四步②, brake class — lineage-exempt): stop the run's
   * current turn. Present ONLY on `statusKind === 'live'` rows; rides the
   * existing `cowork:session:stop` — zero new channel.
   */
  onStop?: (sessionId: string) => void;
  /**
   * R1 重试 (fork 2A, steer class): hand the failed run back to the Twin as a
   * pre-filled draft — never a direct rerun. Present only on failed rows whose
   * lineage is human (`retrySteerVisible` + valve level 'full').
   */
  onRetry?: (entry: ProcessEntry) => void;
  /**
   * L3 决策卡 row link (fork 5A: the row STAYS a session row): present when the
   * row's task has an open decision card — the click expands the strip and
   * focuses that card instead of only opening the read-only transcript.
   */
  onDecide?: () => void;
  /**
   * 火花线取数面: this session's 24 message-timestamp buckets. Absent/zero
   * reading renders the explicit empty state — never a fabricated bar.
   */
  spark?: ProcessSparkReading | null;
}> = ({ entry, nowMs, depth, onOpen, onArchive, onRemove, mutedDot = false, bucket, onSetBucket, onStop, onRetry, onDecide, spark = null }) => {
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
      data-status-kind={statusKind}
      data-session-status={String(session.status ?? '')}
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
              // 静默条行 = 待激活但由 bot 自行消化：琥珀语义，不是灰。
              ? PROCESS_STATE_DOT_COLOR.pending
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
      {/* 火花线 (取数面, 2026-11-23): real 24-bucket message activity. Shown on
          live rows (the old contract) and on any row that HAS activity in the
          window; a row with nothing to show renders no container at all, so an
          empty strip never reads as "no activity happened here". */}
      {(statusKind === 'live' || sparkHasData(spark)) && (
        <ProcessSparkline
          reading={spark}
          variant="row"
          testId="process-row-spark"
          className="flex-shrink-0"
        />
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
        onDecide ? (
          <button
            type="button"
            data-testid="process-row-decide-button"
            title={i18nService.t('processRowDecideButton')}
            onClick={(event) => {
              event.stopPropagation();
              onDecide();
            }}
            className="shrink-0 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 text-[11.5px] font-semibold text-[#7a5f14] transition-colors hover:bg-[#f2e9c5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:text-amber-300 dark:hover:bg-amber-900/25"
          >
            {i18nService.t('processRowDecideButton')}
          </button>
        ) : (
          <span
            data-testid="process-row-decide"
            className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-[#7a5f14] dark:text-amber-300"
          >
            {i18nService.t('processGoDecide')}
          </span>
        )
      )}
      {onStop && (
        <button
          type="button"
          data-testid="process-row-stop"
          aria-label={i18nService.t('processValveStop')}
          title={i18nService.t('processValveStop')}
          onClick={(event) => {
            event.stopPropagation();
            onStop(session.id);
          }}
          className="flex-shrink-0 rounded-[6px] p-1 text-[#b3261e] transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:text-red-400"
        >
          <StopIcon className="h-3.5 w-3.5" />
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          data-testid="process-row-retry"
          aria-label={i18nService.t('processRetryAction')}
          title={i18nService.t('processRetryAction')}
          onClick={(event) => {
            event.stopPropagation();
            onRetry(entry);
          }}
          className="flex-shrink-0 rounded-[6px] p-1 text-claude-accent transition-colors hover:bg-claude-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
        >
          <ArrowPathIcon className="h-3.5 w-3.5" />
        </button>
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
        style={{
          // The task band is derived from its children (moving / quiet); the
          // palette is keyed by the v2.1 bands, so map explicitly.
          backgroundColor: state === 'running'
            ? PROCESS_STATE_DOT_COLOR.live
            : PROCESS_STATE_DOT_COLOR.dead,
        }}
      />
      {/* Parent rows keep the SAME column order as their runs (dot · task ·
          [run-count] · kind · activity · signature), so the eye reads one grid
          all the way down. v2.1 (owner ruling 2026-11-23 00:41): the TASK leads
          — the orchestrator is a signature lane at the END, never the head of
          the line. (The pre-v2.1 comment here claimed the same order but put
          the bot first: it described a grid that no longer existed.) */}
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
      <span
        data-testid="process-task-activity"
        className="w-[46px] flex-shrink-0 text-right text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={relative.full}
      >
        {relative.compact}
      </span>
      {orchestratorName && (
        <span
          data-testid="process-task-orchestrator"
          className="flex w-[86px] flex-shrink-0 items-center justify-end gap-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
          title={`${i18nService.t('processOrchestratorLabel')}: ${orchestratorName}`}
        >
          <SessionAvatarCircle src={node.orchestratorAvatar} name={orchestratorName} sizeClass="h-4 w-4" />
          <span className="min-w-0 truncate">{orchestratorName}</span>
        </span>
      )}
    </div>
  );
};

/**
 * 动态 · 正在运行 row (v4): a breathing dot, then the four facts the owner asked
 * for — 任务名 · 开始多久 · 一句当前动作, with 谁 as the signature at the row's
 * end (v2.1, owner ruling 00:41: the task leads, the bot signs). It is
 * deliberately NOT the run row: a live process has no ⋯ valve (archiving a
 * running run is not a thing), and its action line is the elastic slot because
 * that is the part that actually changes while the owner watches.
 */
const ProcessLiveRow: React.FC<{
  entry: ProcessEntry;
  nowMs: number;
  action: string | undefined;
  onOpen: (sessionId: string) => void;
  /** S1 刹车阀: every row here is live by construction, so the brake valve is
   * passed whenever the handler exists — same contract as ProcessRunRow. */
  onStop?: (sessionId: string) => void;
  /** 火花线取数面: this row is live by construction, so the strip always has a
   * home here — real bars when messages exist, the explicit empty state when
   * the process has no message timestamps yet. */
  spark?: ProcessSparkReading | null;
}> = ({ entry, nowMs, action, onOpen, onStop, spark = null }) => {
  const { session, error } = entry;
  const who = session.metabotName?.trim() || i18nService.t('processUnattributedBot');
  const started = formatRelativeTime(session.createdAt, nowMs);
  const elapsedMs = Math.max(0, nowMs - Number(session.createdAt ?? 0));
  const title = processTreeKeyOf(session.title || '') || i18nService.t('coworkNewSession');
  return (
    <div
      data-testid="process-live-row"
      data-session-id={session.id}
      data-live-elapsed-ms={elapsedMs}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(session.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(session.id);
        }
      }}
      className="flex h-[40px] cursor-pointer items-center gap-2.5 rounded-[8px] border border-claude-border bg-claude-bg px-3 text-[12px] transition-colors hover:bg-claude-surfaceHover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:border-claude-darkBorder dark:bg-claude-darkBg dark:hover:bg-claude-darkSurfaceHover"
    >
      <span
        aria-hidden
        data-testid="process-state-dot"
        className="h-2 w-2 flex-shrink-0 rounded-full process-dot-live"
        style={{ backgroundColor: error ? PROCESS_STATE_DOT_COLOR.error : PROCESS_STATE_DOT_COLOR.live }}
      />
      {/* Same v2.1 grid as every other row — the live band is NOT an exception
          (owner ruling 2026-11-23 00:41: the TASK leads; a bot may never
          occupy the head of the line). The bot name moved to the signature
          lane at the END, exactly where ProcessRunRow keeps its orchestrator.
          dot · task · [spark] · elapsed · action · stop · signature · chevron */}
      <span
        data-testid="process-live-title"
        className="max-w-[40%] min-w-0 flex-shrink-0 truncate font-semibold dark:text-claude-darkText text-claude-text"
      >
        {title}
      </span>
      <ProcessSparkline reading={spark} variant="row" testId="process-live-spark" className="flex-shrink-0" />
      <span
        data-testid="process-live-elapsed"
        className="flex-shrink-0 whitespace-nowrap text-[11px] tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={started.full}
      >
        {i18nService.t('processLiveElapsed').replace('{duration}', started.compact)}
      </span>
      <span
        data-testid="process-live-action"
        className="min-w-0 flex-1 truncate text-[11.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
      >
        {action || i18nService.t('processLiveActionFallback')}
      </span>
      {onStop && (
        <button
          type="button"
          data-testid="process-live-stop"
          aria-label={i18nService.t('processValveStop')}
          title={i18nService.t('processValveStop')}
          onClick={(event) => {
            event.stopPropagation();
            onStop(entry.session.id);
          }}
          className="flex-shrink-0 rounded-[6px] p-1 text-[#b3261e] transition-colors hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:text-red-400"
        >
          <StopIcon className="h-3.5 w-3.5" />
        </button>
      )}
      {/* 署名区 (v2.1): the bot that runs this live process, ≤86px, right-aligned
          — the same lane, width and tooltip as the run row's orchestrator. */}
      <span
        data-testid="process-live-who"
        className="flex w-[86px] flex-shrink-0 items-center justify-end gap-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={`${i18nService.t('processOrchestratorLabel')}: ${who}`}
      >
        <SessionAvatarCircle src={session.metabotAvatar} name={who} sizeClass="h-4 w-4" />
        <span className="min-w-0 truncate">{who}</span>
      </span>
      <ChevronRightIcon aria-hidden className="h-3.5 w-3.5 flex-shrink-0 opacity-40" />
    </div>
  );
};

const PROCESS_GATE_CLASS_LABEL_KEY: Record<ProcessGateClass, string> = {
  delete: 'processGateClassDelete',
  funds: 'processGateClassFunds',
  capability: 'processGateClassCapability',
};

/**
 * 三例外闸只读条 (Friday 稿四步③, 判据③): the hub's window onto the pending
 * exception gates — G1 删文件 / G2 资金·链上 / G3 能力·定位. Data is the GLOBAL
 * pending-permission mirror (redux `cowork.pendingPermissions`, the same state
 * `cowork:permission:listPending` replays on reload) — zero new channel.
 *
 * READ-ONLY by ruling: the bar never carries allow/deny buttons. Those gates
 * are irreversible, context-bound decisions that already own two seats
 * (CoworkPermissionPanel in the chat composer, CoworkPermissionOverlay corner
 * card) — the hub adds a THIRD only as a doorway: 查看 + 跳转, nothing else.
 */
const ProcessGateBar: React.FC<{
  permissions: CoworkPermissionRequest[];
  sessionTitles: ReadonlyMap<string, string>;
  onJump: (sessionId: string) => void;
}> = ({ permissions, sessionTitles, onJump }) => {
  const entries = useMemo(() => buildProcessGateEntries(permissions), [permissions]);
  const questionById = useMemo(() => {
    const map = new Map<string, string | null>();
    for (const permission of permissions) map.set(permission.requestId, processGateQuestionOf(permission));
    return map;
  }, [permissions]);
  if (entries.length === 0) return null;
  return (
    <div
      data-testid="process-gate-bar"
      data-gate-count={entries.length}
      className="shrink-0 border-b border-[#e6c93e]/60 bg-[#fffdf4] dark:border-amber-700/40 dark:bg-amber-900/10"
    >
      <div className="flex h-[30px] items-center gap-2 px-4">
        <ExclamationTriangleIcon aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-[#8a6d1a] dark:text-amber-300" />
        <span
          data-testid="process-gate-bar-label"
          className="min-w-0 truncate text-[11.5px] font-semibold text-[#7a5f14] dark:text-amber-200"
        >
          {i18nService.t('processGateBarLabel')}
        </span>
        <span
          data-testid="process-gate-count"
          className="flex h-[14px] min-w-[14px] flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-[3px] text-[9.5px] font-bold leading-none text-white"
        >
          {entries.length}
        </span>
      </div>
      <div data-testid="process-gate-list" className="flex flex-col gap-1 px-4 pb-2">
        {entries.map((entry) => {
          const question = questionById.get(entry.requestId) ?? null;
          const sessionTitle = sessionTitles.get(entry.sessionId) ?? null;
          return (
            <div
              key={entry.requestId}
              data-testid="process-gate-row"
              data-gate-class={entry.gateClass}
              data-gate-request-id={entry.requestId}
              data-gate-session-id={entry.sessionId}
              className="flex min-h-[30px] items-center gap-2 rounded-[8px] border border-claude-border bg-claude-bg px-2.5 py-1 dark:border-claude-darkBorder dark:bg-claude-darkBg"
            >
              <span className={PROCESS_TAG_CLASS}>
                {i18nService.t(PROCESS_GATE_CLASS_LABEL_KEY[entry.gateClass])}
              </span>
              <span
                data-testid="process-gate-summary"
                className="min-w-0 flex-1 truncate text-[11.5px] dark:text-claude-darkText text-claude-text"
                title={question ?? entry.requestedToolName}
              >
                {question || entry.requestedToolName}
              </span>
              {sessionTitle && (
                <span
                  data-testid="process-gate-session"
                  className="w-[110px] flex-shrink-0 truncate text-right text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary"
                  title={sessionTitle}
                >
                  {sessionTitle}
                </span>
              )}
              <button
                type="button"
                data-testid="process-gate-jump"
                onClick={() => onJump(entry.sessionId)}
                className="flex-shrink-0 whitespace-nowrap rounded-[6px] px-1.5 py-0.5 text-[11px] font-semibold text-claude-accent transition-colors hover:bg-claude-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40"
              >
                {i18nService.t('processGateViewAction')}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** The sliver of a Studio decision-queue item the hub's decision card renders. */
interface ProcessOpenDecision {
  id: string;
  status: string;
  kind: string;
  title: string;
  question: string;
  recommendation?: string;
  backgroundSummary?: string;
  progressSummary?: string;
  nextStep?: string;
  longtermTaskId?: string | null;
  options?: Array<{ label: string; description?: string; recommended?: boolean }>;
  evidence?: Array<{ kind: string; uri: string; note?: string }>;
}

/**
 * L3 决策卡 (Friday 稿四步④, fork 3A): the hub's seat for owner rulings. Each
 * open Studio decision-queue item renders as a card — evidence links are
 * read-only, an option click (or 驳回 with a reason) records the ruling through
 * the new `longtermTask:decisionResolve` IPC, whose main-side handler is the
 * SAME shared function the Twin's studio_decision_resolve tool calls. Resolving
 * cancels redundant siblings and releases the linked subtask's waiting_owner
 * hold — then the store broadcast refreshes both this block and the strip.
 */
const ProcessDecisionCard: React.FC<{
  item: ProcessOpenDecision;
  highlighted: boolean;
  resolving: boolean;
  onResolve: (item: ProcessOpenDecision, note: string) => void;
}> = ({ item, highlighted, resolving, onResolve }) => {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [rejectText, setRejectText] = useState('');
  const options = item.options ?? [];
  const evidence = (item.evidence ?? []).slice(0, 3);
  const resolveWithOption = (label: string) => {
    if (resolving) return;
    onResolve(item, i18nService.t('processDecisionOptionNote').replace('{option}', label));
  };
  const resolveApprove = () => {
    if (resolving) return;
    onResolve(item, i18nService.t('processDecisionAcceptNote'));
  };
  const resolveReject = () => {
    const reason = rejectText.trim();
    if (resolving || !reason) return;
    onResolve(item, i18nService.t('processDecisionRejectNote').replace('{reason}', reason));
  };
  return (
    <div
      data-testid="process-decision-card"
      data-decision-id={item.id}
      data-decision-kind={item.kind}
      data-decision-highlighted={highlighted ? 'true' : 'false'}
      className={`rounded-[10px] border bg-claude-bg px-3 py-2 dark:bg-claude-darkBg ${
        highlighted
          ? 'border-claude-accent ring-2 ring-claude-accent/30'
          : 'border-claude-border dark:border-claude-darkBorder'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={PROCESS_TAG_CLASS}>{item.kind}</span>
        <span
          data-testid="process-decision-title"
          className="min-w-0 flex-1 truncate text-[12.5px] font-semibold dark:text-claude-darkText text-claude-text"
          title={item.title}
        >
          {item.title}
        </span>
        <span className="flex-shrink-0 text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {item.status}
        </span>
      </div>
      <p
        data-testid="process-decision-question"
        className="mt-1 line-clamp-2 text-[11.5px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary"
        title={item.question}
      >
        {item.question}
      </p>
      {evidence.length > 0 && (
        <div data-testid="process-decision-evidence" className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('processDecisionEvidenceLabel')}
          </span>
          {evidence.map((item2, index) => (
            <span
              key={`${item.id}:evidence:${index}`}
              className="max-w-[160px] truncate rounded-[6px] border border-claude-border px-1.5 py-0.5 text-[10.5px] dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary"
              title={`${item2.kind}: ${item2.uri}${item2.note ? ` · ${item2.note}` : ''}`}
            >
              {item2.kind}: {item2.uri}
            </span>
          ))}
        </div>
      )}
      {options.length > 0 ? (
        <div data-testid="process-decision-options" className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {options.map((option) => (
            <button
              key={`${item.id}:option:${option.label}`}
              type="button"
              data-testid="process-decision-option"
              data-decision-option={option.label}
              disabled={resolving}
              onClick={() => resolveWithOption(option.label)}
              title={option.description || undefined}
              className="inline-flex items-center gap-1 rounded-lg border border-claude-border px-2.5 py-1 text-[11.5px] font-medium dark:text-claude-darkText text-claude-text transition-colors hover:border-claude-accent hover:bg-claude-accent/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:hover:bg-claude-accent/10"
            >
              {option.label}
              {option.recommended && (
                <span className="rounded-[4px] bg-claude-accent/20 px-1 text-[9.5px] font-bold text-[#7a5f14] dark:text-amber-300">
                  {i18nService.t('processDecisionRecommend')}
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        <div className="mt-1.5 flex items-center gap-1.5">
          <button
            type="button"
            data-testid="process-decision-approve"
            disabled={resolving}
            onClick={resolveApprove}
            className="rounded-lg border border-claude-border px-2.5 py-1 text-[11.5px] font-medium dark:text-claude-darkText text-claude-text transition-colors hover:border-claude-accent hover:bg-claude-accent/10 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder"
          >
            {i18nService.t('processDecisionApprove')}
          </button>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-1.5">
        {!rejectOpen ? (
          <button
            type="button"
            data-testid="process-decision-reject"
            disabled={resolving}
            onClick={() => setRejectOpen(true)}
            className="rounded-lg border border-claude-border px-2 py-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:border-red-300 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-60 dark:border-claude-darkBorder dark:hover:text-red-300"
          >
            {i18nService.t('processDecisionReject')}
          </button>
        ) : (
          <>
            <input
              type="text"
              data-testid="process-decision-reject-input"
              value={rejectText}
              disabled={resolving}
              onChange={(event) => setRejectText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') resolveReject();
                if (event.key === 'Escape') setRejectOpen(false);
              }}
              placeholder={i18nService.t('processDecisionRejectPlaceholder')}
              className="h-[24px] min-w-0 flex-1 rounded-[6px] border border-claude-border bg-transparent px-2 text-[11.5px] dark:text-claude-darkText text-claude-text focus:border-claude-accent focus:outline-none dark:border-claude-darkBorder"
            />
            <button
              type="button"
              data-testid="process-decision-reject-confirm"
              disabled={resolving || !rejectText.trim()}
              onClick={resolveReject}
              className="flex-shrink-0 rounded-lg border border-red-300 px-2 py-0.5 text-[11px] font-semibold text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
            >
              {i18nService.t('processDecisionReject')}
            </button>
          </>
        )}
        {resolving && (
          <span data-testid="process-decision-resolving" className="text-[10.5px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('processDecisionResolving')}
          </span>
        )}
      </div>
    </div>
  );
};

const ProcessDecisionBlock: React.FC<{
  decisions: ProcessOpenDecision[];
  highlightedId: string | null;
  resolvingId: string | null;
  onResolve: (item: ProcessOpenDecision, note: string) => void;
}> = ({ decisions, highlightedId, resolvingId, onResolve }) => {
  if (decisions.length === 0) return null;
  return (
    <div
      data-testid="process-decision-block"
      data-decision-count={decisions.length}
      className="shrink-0 border-b border-claude-border bg-claude-bg/60 dark:border-claude-darkBorder dark:bg-claude-darkBg/60"
    >
      <div className="flex h-[30px] items-center gap-2 px-4">
        <HandRaisedIcon aria-hidden className="h-3.5 w-3.5 flex-shrink-0 text-claude-accent" />
        <span
          data-testid="process-decision-block-label"
          className="min-w-0 truncate text-[11.5px] font-semibold dark:text-claude-darkText text-claude-text"
        >
          {i18nService.t('processDecisionBlockLabelCount').replace('{count}', String(decisions.length))}
        </span>
        <span
          data-testid="process-decision-count"
          className="flex h-[14px] min-w-[14px] flex-shrink-0 items-center justify-center rounded-full bg-red-500 px-[3px] text-[9.5px] font-bold leading-none text-white"
        >
          {decisions.length}
        </span>
      </div>
      <div className="flex flex-col gap-1.5 px-4 pb-2">
        {decisions.map((item) => (
          <ProcessDecisionCard
            key={item.id}
            item={item}
            highlighted={highlightedId === item.id}
            resolving={resolvingId === item.id}
            onResolve={onResolve}
          />
        ))}
      </div>
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
  /**
   * Floatwin shell's explicit exit (M1=B). Rendered as the top-right X of the
   * header — the 右上显式关闭 — and only when the panel is mounted INSIDE the
   * floatwin (the pane mount passes none, so the pane has no fake close).
   */
  onRequestClose?: () => void;
}> = ({ onOpenProcess, viewStateRef, onRequestClose }) => {
  const dispatch = useDispatch();
  const lineageOverrides = useLineageOverrides();
  const { model, nowMs } = useProcessHubModel(lineageOverrides);
  const restored = viewStateRef?.current;
  // v4 (owner ruling 00:09): the landing page is 动态 — the live processes — and
  // the three sources are secondary tabs. 动态 is first AND selected by default.
  const [tab, setTab] = useState<ProcessHubTab>(restored?.tab ?? 'dynamic');
  const [archivedMode, setArchivedMode] = useState(restored?.archivedMode ?? false);
  const [awaitingExpanded, setAwaitingExpanded] = useState(false);
  const [botExpanded, setBotExpanded] = useState(false);
  // 最近结束 is open by default (it is the landing page's second half) but folds,
  // because on a busy day it is a long tail.
  const [endedExpanded, setEndedExpanded] = useState(true);
  const [endedVisible, setEndedVisible] = useState(PROCESS_RECENT_ENDED_BUDGET);
  // Default COLLAPSED: with 98 grouped tasks in the orchestration zone alone,
  // open-by-default would defeat the point of folding.
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(
    () => new Set(restored?.expandedTaskKeys ?? []),
  );
  const [visibleNodes, setVisibleNodes] = useState(VISIBLE_NODE_BUDGET);
  // Lazily read on the first visit of 已归档: the live list query never carries
  // archived rows, and nothing else in the panel needs them.
  const [archivedEntries, setArchivedEntries] = useState<ProcessEntry[] | null>(null);

  // ── L2 动作沉浸 / L3 决策沉浸 (Friday 稿四步, owner approval 06:07) ──
  // The global pending-permission mirror: the same redux state the corner
  // overlay reads (cowork:permission:listPending replays it on reload). The
  // gate bar is a VIEW over it — never a second decision seat.
  const pendingPermissions = useSelector((state: RootState) => state.cowork.pendingPermissions);
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const longTermBoard = useSelector((state: RootState) => state.longTermTask.board);
  // L3: open Studio decision items + their resolve-in-flight marker + the one
  // highlighted card (the row-level 拍板 jump scrolls here).
  const [openDecisions, setOpenDecisions] = useState<ProcessOpenDecision[]>([]);
  const [resolvingDecisionId, setResolvingDecisionId] = useState<string | null>(null);
  const [highlightedDecisionId, setHighlightedDecisionId] = useState<string | null>(null);
  // The row↔card linkage needs the board's decisionSessionIds; the redux board
  // is loaded by whichever surface opened first, so the hub keeps its OWN
  // snapshot — the linkage must not depend on another view having run.
  const [boardCards, setBoardCards] = useState<Array<{ id: string; decisionSessionIds?: string[] | null }>>([]);

  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<ProcessOpenDecision[]> => {
      const api = window.electron?.longtermTask;
      if (!api?.studioStatus) return [];
      const result = await api.studioStatus({});
      return result?.success && Array.isArray(result.openDecisions)
        ? (result.openDecisions as ProcessOpenDecision[])
        : [];
    };
    const sync = () => {
      void read()
        .then((items) => {
          if (!cancelled) setOpenDecisions(items);
        })
        .catch(() => {
          if (!cancelled) setOpenDecisions([]);
        });
      // The linkage snapshot rides the same refresh cycle.
      const api = window.electron?.longtermTask;
      void api?.board?.()
        .then((result) => {
          if (!cancelled && result?.success && Array.isArray(result.board?.cards)) {
            setBoardCards(result.board.cards);
          }
        })
        .catch(() => {
          // Keep the last good snapshot; the redux board (if loaded) still feeds
          // the linkage through the fallback below.
        });
    };
    sync();
    // The queue's own broadcast rides longtermTask:update (main: store onChange
    // → broadcastLongTermTaskUpdate), the same signal the Sidebar badge uses.
    const unsub = window.electron?.longtermTask?.onUpdate?.(() => sync());
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const sessionTitlesById = useMemo(
    () => new Map(sessions.map((session) => [session.id, session.title] as const)),
    [sessions],
  );

  const handleStopRun = useCallback((sessionId: string) => {
    // S1 刹车阀: the existing stop channel (cowork:session:stop) — zero new wire.
    void coworkService.stopSession(sessionId);
  }, []);

  const handleGateJump = useCallback((sessionId: string) => {
    // 查看 + 跳转 owner 确认: the SAME jump the corner overlay uses
    // (cowork:viewSession) — the chat's permission seat stays the only decider.
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId } }));
  }, []);

  const focusDecision = useCallback((itemId: string) => {
    setAwaitingExpanded(true);
    setHighlightedDecisionId(itemId);
    window.setTimeout(() => {
      document.querySelector(`[data-decision-id="${itemId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, 60);
  }, []);

  const resolveDecisionItem = useCallback(async (item: ProcessOpenDecision, note: string) => {
    if (resolvingDecisionId) return;
    setResolvingDecisionId(item.id);
    try {
      const api = window.electron?.longtermTask;
      const result = await api?.decisionResolve?.({ queueItemId: item.id, resolutionNote: note });
      if (!result?.success) {
        window.dispatchEvent(new CustomEvent('app:showToast', {
          detail: `${i18nService.t('processDecisionResolveFailed')}${result?.error ? ` (${result.error})` : ''}`,
        }));
      }
    } catch {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('processDecisionResolveFailed') }));
    } finally {
      setResolvingDecisionId(null);
    }
  }, [resolvingDecisionId]);

  const handleRetryToTwin = useCallback((entry: ProcessEntry) => {
    // R1 重试 (fork 2A): a FAILURE-CONTEXT draft into the Twin's composer via
    // the existing cowork:newChatWithDraft channel — the Twin decides rerun vs
    // reassign; the hub never reruns anything itself.
    void (async () => {
      let progress: string | null = null;
      try {
        const reader = window.electron?.cowork?.getSessionMessagesPage;
        if (typeof reader === 'function') {
          const result = await reader({ sessionId: entry.session.id, limit: 12 });
          progress = result?.success ? lastAssistantDigest(result.page?.messages, 96) : null;
        }
      } catch {
        // Unreadable transcript → the prompt builder shows the placeholder.
      }
      const draftText = buildTwinSteeringPrompt(i18nService.t('processRetryDraft'), {
        task: resolveSourceTaskTitle(entry.session, longTermBoard?.cards ?? boardCards),
        process: entry.session.title ?? null,
        state: i18nService.t('processRetryStateFailed'),
        progress,
        action: i18nService.t('processRetryActionDraft'),
      });
      const openWithDraft = () => {
        window.dispatchEvent(new CustomEvent('cowork:newChatWithDraft', { detail: { text: draftText } }));
      };
      try {
        const result = await window.electron?.idbots?.getMetaBots?.();
        const twin = result?.success ? (result.list ?? []).find((bot) => bot.metabot_type === 'twin') : null;
        if (twin) dispatch(setNewTaskMetabotId(twin.id));
        openWithDraft();
      } catch {
        // Roster unavailable: still hand over the context, default bot.
        openWithDraft();
      }
    })();
  }, [dispatch, longTermBoard, boardCards]);

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

  // Mirror tab/archived into the caller's ref, and restore the scroll offset
  // the owner left at (after the first paint, so the list has its height).
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewStateRef) return;
    viewStateRef.current = {
      ...viewStateRef.current,
      tab,
      archivedMode,
      expandedTaskKeys: [...expandedTasks],
    };
  }, [viewStateRef, tab, archivedMode, expandedTasks]);
  useEffect(() => {
    const el = bodyRef.current;
    const target = viewStateRef?.current.scrollTop ?? 0;
    if (el && target > 0) el.scrollTop = target;
    // restore once per mount (refs are stable — no deps to declare)
  }, []);
  const handleBodyScroll = (event: React.UIEvent<HTMLDivElement>) => {
    if (!viewStateRef) return;
    viewStateRef.current = { ...viewStateRef.current, scrollTop: event.currentTarget.scrollTop };
  };

  const awaitingCount = countAwaitingProcesses(model);
  const botCount = countBotSelfDigested(model);
  // 动态 is a re-projection of the SAME byStatus model (live / dead); pending
  // runs stay in the strip above, never in either band.
  const dynamic = useMemo(() => buildProcessDynamic(model.running), [model.running]);
  // v6 三入口 (owner approval 2026-11-24 17:23):
  //   自主 = 定时 + 长期 (chips) + 做梦 / 冲浪 (run rows);
  //   编排 = STRICTLY autoOrigin='orchestration' (N6 read-time prefix fallback);
  //   人开的会话 are lifted out of 编排 into the dynamic page's folded strip.
  const autonomousModel = useMemo(() => buildProcessAutonomous(model.running), [model.running]);
  const orchestrationZone = useMemo(
    () => buildOrchestrationZone(model.running),
    [model.running],
  );
  const unassignedHumanEntries = useMemo(
    () => buildUnassignedHumanEntries(model.running),
    [model.running],
  );
  const automation = useProcessAutomationRuns(true);
  const automationEntries = automation.entries;
  const automationBots = automation.bots;
  const automationCounts = useMemo(() => automationRunCounts(automationEntries), [automationEntries]);
  const chipCounts = useMemo(
    () => autonomousChipCounts(autonomousModel, automationCounts),
    [autonomousModel, automationCounts],
  );
  // The 自主 chip filter (M3=A): null = 全部, otherwise one source.
  const [autonomousChip, setAutonomousChip] = useState<ProcessAutonomousSource | null>(null);
  const [unassignedExpanded, setUnassignedExpanded] = useState(false);
  const liveActionLines = useLiveActionLines(dynamic.running);
  // 火花线: one batched read for every run row the hub can paint (the same
  // entries the two buckets above carry). A finished turn re-reads it.
  const isStreamingNow = useSelector((state: RootState) => state.cowork.isStreaming);
  const sparkEntries = useMemo(
    () => [...model.running, ...model.awaiting, ...model.botSelfDigested],
    [model.running, model.awaiting, model.botSelfDigested],
  );
  const sessionSparks = useSessionSparks(sparkEntries, isStreamingNow ? 'live' : 'idle');
  // The zone whose tree a NON-dynamic tab renders; 动态 has no zone of its own.
  const zoneModel = tab === 'orch' ? orchestrationZone : null;
  const nodes = zoneModel ? zoneModel.nodes.slice(0, visibleNodes) : [];
  const endedRows = dynamic.recentlyEnded.slice(0, endedVisible);
  /** 自主 chip filter, applied to the two session-backed sources. */
  const autonomousScheduledRows = autonomousChip == null || autonomousChip === 'scheduled'
    ? autonomousModel.scheduled
    : [];
  const autonomousLongtermRows = autonomousChip == null || autonomousChip === 'longterm'
    ? autonomousModel.longterm
    : [];
  const autonomousAutomationRows = automationEntriesFor(
    automationEntries,
    autonomousChip === 'dream' || autonomousChip === 'surf' ? autonomousChip : null,
  ).filter((entry) => autonomousChip == null || entry.source === autonomousChip);

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

  /**
   * L2 动作沉浸 (Friday 稿四步①, fork 1A): the row-valve gate is TRI-STATE.
   * 'none' (archived) → no valves; 'housekeeping' (bot-origin) → the three
   * 整理类 valves only; 'full' (human-origin) → housekeeping + steer valves.
   * The brake valve rides `onStop`, keyed on statusKind — NOT on the level.
   */
  const renderRun = (entry: ProcessEntry, depth: 0 | 1, valveLevel: ProcessRowValveLevel, mutedDot = false) => {
    // L3 row link: which open decision cards belong to this row's task (a jump,
    // not a steer — lineage-agnostic, and unreachable on archived rows anyway).
    // The redux board is the live source; the panel's own snapshot keeps the
    // linkage alive when no other surface has loaded the board yet.
    const linkageCards = longTermBoard?.cards ?? boardCards;
    const linkedDecisionIds = openDecisionIdsForSession(entry.session.id, linkageCards, openDecisions);
    return (
      <ProcessRunRow
        key={entry.session.id}
        entry={entry}
        nowMs={nowMs}
        depth={depth}
        onOpen={onOpenProcess}
        onArchive={valveLevel !== 'none' ? handleArchive : undefined}
        onRemove={valveLevel !== 'none' ? handleRemove : undefined}
        mutedDot={mutedDot}
        bucket={lineageBucketOf(entry.session.id, lineageOverrides)}
        onSetBucket={valveLevel !== 'none' ? (sessionId, next) => void setLineageBucket(sessionId, next) : undefined}
        onStop={entry.statusKind === 'live' ? handleStopRun : undefined}
        onRetry={valveLevel === 'full' && retrySteerVisible(entry) ? handleRetryToTwin : undefined}
        onDecide={linkedDecisionIds.length > 0 ? () => focusDecision(linkedDecisionIds[0]) : undefined}
        spark={sessionSparks[entry.session.id] ?? null}
      />
    );
  };

  return (
    <div
      data-testid="process-center-panel"
      data-process-tab={tab}
      data-process-archived-mode={archivedMode ? 'true' : 'false'}
      className="flex h-full min-h-0 flex-col bg-claude-bg dark:bg-claude-darkBg"
    >
      {/* Header: title + the four top tabs (v4: 动态 first, the three sources
          demoted to secondary tabs). */}
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
          data-process-tab-count="3"
          className="ml-auto grid h-[32px] grid-cols-3 gap-0 overflow-hidden rounded-[var(--shape-radius-sm)] border border-claude-border/70 bg-claude-bg/80 dark:border-claude-darkBorder/70 dark:bg-claude-darkBg/80"
        >
          {PROCESS_HUB_TAB_ORDER.map((key) => {
            const selected = key === tab;
            // 角标: the count lives ON the tab (v4) instead of a flat 567/657
            // band across the first screen.
            // ONE unit on every tab — runs, never tree nodes (owner batch-A
            // P1-4). Node count is not a usable unit here: it changes with the
            // portfolio's fold heuristic (one task node vs its N runs), so the
            // same content would read two different numbers, and 组数 cannot be
            // expressed for 动态 at all (live runs are not grouped). Runs are
            // the unit the rest of the panel already counts: the 正在运行 header,
            // the 最近结束 done/failed split, the rail's 待你拍板 badge, and the
            // task row's own "{n} 次执行" tag.
            // v6: 自主 = 定时 + 长期 + 做梦/冲浪 runs (owner 17:23 extended the
            // source set); 编排 = the strict orchestration run count.
            const count = key === 'dynamic'
              ? dynamic.running.length
              : key === 'autonomous'
                ? countAutonomousRuns(autonomousModel, automationEntries.length)
                : orchestrationZone.runCount;
            return (
              <button
                key={key}
                type="button"
                role="tab"
                data-process-tab-key={key}
                aria-selected={selected}
                onClick={() => {
                  setTab(key);
                  setArchivedMode(false);
                  setVisibleNodes(VISIBLE_NODE_BUDGET);
                  setEndedVisible(PROCESS_RECENT_ENDED_BUDGET);
                }}
                className={`inline-flex h-full min-w-0 items-center justify-center gap-1 px-2 text-[11.5px] font-medium leading-none transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                  selected
                    // Same fill pair as the switcher master: claude-accent = #FFDC51,
                    // claude-accentInk = #303133.
                    ? 'bg-claude-accent text-claude-accentInk'
                    : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover/70 dark:hover:bg-claude-darkSurfaceHover/70'
                }`}
              >
                {i18nService.t(PROCESS_HUB_TAB_LABEL_KEY[key])}
                <span
                  data-testid="process-tab-count"
                  data-tab-count-for={key}
                  data-count-unit="runs"
                  className={`ml-0.5 min-w-[15px] rounded-full px-1 text-[9.5px] leading-[13px] tabular-nums ${
                    selected ? 'bg-black/10' : 'bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover'
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        {onRequestClose ? (
          <button
            type="button"
            data-testid="process-floatwin-close"
            aria-label={i18nService.t('processFloatwinClose')}
            title={i18nService.t('processFloatwinClose')}
            onClick={onRequestClose}
            className="ml-1 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-[var(--shape-radius-xs)] text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover hover:text-claude-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover dark:hover:text-claude-darkText"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        ) : null}
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
            {model.awaiting.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session)))}
          </div>
        )}
      </div>

      {/* L3 决策卡 (Friday 稿四步④): open Studio rulings, resolvable HERE — the
          write rides the new longtermTask:decisionResolve IPC, same source as
          the Twin's agent tool. Empty when the queue is empty. */}
      <ProcessDecisionBlock
        decisions={openDecisions}
        highlightedId={highlightedDecisionId}
        resolvingId={resolvingDecisionId}
        onResolve={(item, note) => void resolveDecisionItem(item, note)}
      />

      {/* 三例外闸只读条 (Friday 稿四步③): pending G1/G2/G3 gates, view + jump
          only — the decisive seats stay in the chat composer / corner overlay. */}
      <ProcessGateBar
        permissions={pendingPermissions}
        sessionTitles={sessionTitlesById}
        onJump={handleGateJump}
      />

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
              {model.botSelfDigested.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session), true))}
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
              {(archivedEntries ?? []).map((entry) => renderRun(entry, 0, 'none'))}
            </div>
          )
        ) : tab === 'dynamic' ? (
          /* v4 landing page: 正在运行 first (the breathing rows), 最近结束 below.
             No zone heading, no 567/657 band — those counts live on the tabs. */
          <div data-testid="process-dynamic-body" className="flex flex-col gap-3">
            <section data-testid="process-live-section" data-live-count={dynamic.running.length}>
              <div className="flex items-center gap-1.5 px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span
                  aria-hidden
                  data-testid="process-live-heading-dot"
                  className="h-1.5 w-1.5 flex-shrink-0 rounded-full process-dot-live"
                  style={{ backgroundColor: PROCESS_STATE_DOT_COLOR.live }}
                />
                {i18nService.t('processLiveSection')}
                <span data-testid="process-live-heading-count" data-count-unit="runs" className="tabular-nums opacity-70">{dynamic.running.length}</span>
              </div>
              {dynamic.running.length === 0 ? (
                <p
                  data-testid="process-live-empty"
                  className="rounded-[8px] border border-dashed border-claude-border px-3 py-4 text-center text-[11.5px] leading-5 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  {i18nService.t('processLiveEmpty')}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {dynamic.running.map((entry) => (
                    <ProcessLiveRow
                      key={entry.session.id}
                      entry={entry}
                      nowMs={nowMs}
                      action={liveActionLines[entry.session.id]}
                      onOpen={onOpenProcess}
                      onStop={handleStopRun}
                      spark={sessionSparks[entry.session.id] ?? null}
                    />
                  ))}
                </div>
              )}
            </section>

            <section
              data-testid="process-ended-section"
              data-ended-count={dynamic.recentlyEnded.length}
              data-ended-completed={dynamic.completedCount}
              data-ended-failed={dynamic.failedCount}
            >
              <button
                type="button"
                data-testid="process-ended-toggle"
                aria-expanded={endedExpanded}
                onClick={() => setEndedExpanded((previous) => !previous)}
                className="flex w-full items-center gap-1.5 px-1 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"
              >
                <span aria-hidden className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                  {endedExpanded ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                </span>
                {i18nService.t('processEndedSection')}
                <span
                  data-testid="process-ended-counts"
                  className="rounded border border-claude-border px-1.5 py-0.5 text-[10.5px] font-medium normal-case tracking-normal dark:border-claude-darkBorder"
                >
                  {i18nService.t('processEndedCounts')
                    .replace('{done}', String(dynamic.completedCount))
                    .replace('{failed}', String(dynamic.failedCount))}
                </span>
                <span className="ml-auto tabular-nums opacity-70">{dynamic.recentlyEnded.length}</span>
              </button>
              {endedExpanded &&
                (dynamic.recentlyEnded.length === 0 ? (
                  <p
                    data-testid="process-ended-empty"
                    className="rounded-[8px] border border-dashed border-claude-border px-3 py-4 text-center text-[11.5px] leading-5 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary"
                  >
                    {i18nService.t('processEndedEmpty')}
                  </p>
                ) : (
                  <div data-testid="process-ended-list" className="flex flex-col gap-1.5">
                    {endedRows.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session)))}
                    {dynamic.recentlyEnded.length > endedRows.length && (
                      <button
                        type="button"
                        data-testid="process-ended-show-more"
                        onClick={() => setEndedVisible((previous) => previous + PROCESS_RECENT_ENDED_BUDGET)}
                        className="mt-1 flex h-8 w-full items-center justify-center rounded-[8px] border border-dashed border-claude-border text-[11.5px] dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                      >
                        {i18nService.t('processShowMore').replace('{count}', String(dynamic.recentlyEnded.length - endedRows.length))}
                      </button>
                    )}
                  </div>
                ))}
            </section>

            {/* M4=A 兜底: 人开的会话 no longer belong to 编排 — they would
                otherwise vanish from the hub while alive. Folded by default;
                the count is honest (only live/human-origin process rows). */}
            {unassignedHumanEntries.length > 0 ? (
              <section
                data-testid="process-unassigned-humans"
                data-unassigned-count={unassignedHumanEntries.length}
              >
                <button
                  type="button"
                  data-testid="process-unassigned-toggle"
                  aria-expanded={unassignedExpanded}
                  onClick={() => setUnassignedExpanded((previous) => !previous)}
                  className="flex w-full items-center gap-1.5 px-1 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  <span aria-hidden className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center">
                    {unassignedExpanded ? <ChevronDownIcon className="h-3 w-3" /> : <ChevronRightIcon className="h-3 w-3" />}
                  </span>
                  {i18nService.t('processUnassignedHumans').replace('{count}', String(unassignedHumanEntries.length))}
                </button>
                {unassignedExpanded ? (
                  <div data-testid="process-unassigned-list" className="flex flex-col gap-1.5">
                    {unassignedHumanEntries.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session)))}
                  </div>
                ) : null}
              </section>
            ) : null}
          </div>
        ) : tab === 'autonomous' ? (
          /* 自主进程 (M3=A): source chips + the source-filtered list. 做梦 /
             冲浪 ride the SAME row language as 定时 / 长期 runs; they are run
             rows, not sessions, and carry no valve (nothing to archive/remove). */
          <div data-testid="process-autonomous-body" className="flex flex-col gap-3">
            <div
              role="tablist"
              aria-label={i18nService.t('processTabAutonomous')}
              data-testid="process-autonomous-chips"
              className="flex flex-wrap items-center gap-1"
            >
              {([null, ...PROCESS_AUTONOMOUS_SOURCE_ORDER] as Array<ProcessAutonomousSource | null>).map((source) => {
                const selected = autonomousChip === source;
                const count = source == null ? chipCounts.all : chipCounts[source];
                const label = source == null
                  ? i18nService.t('processSourceAll')
                  : i18nService.t(PROCESS_AUTONOMOUS_SOURCE_LABEL_KEY[source]);
                return (
                  <button
                    key={source ?? 'all'}
                    type="button"
                    role="tab"
                    data-autonomous-chip={source ?? 'all'}
                    aria-selected={selected}
                    onClick={() => setAutonomousChip(source)}
                    className={`inline-flex h-[24px] items-center gap-1 rounded-[var(--shape-radius-xs)] border px-2 text-[11px] font-medium leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 ${
                      selected
                        ? 'border-claude-border bg-claude-accent text-claude-accentInk dark:border-claude-darkBorder'
                        : 'border-claude-border/70 text-claude-textSecondary hover:bg-claude-surfaceHover dark:border-claude-darkBorder/70 dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover'
                    }`}
                  >
                    {label}
                    <span data-count-unit="runs" className="tabular-nums opacity-70">{count}</span>
                  </button>
                );
              })}
            </div>

            {autonomousScheduledRows.length > 0 ? (
              <section data-testid="process-autonomous-scheduled" data-source-count={autonomousScheduledRows.length}>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('processSourceScheduled')} · {autonomousScheduledRows.length}
                </div>
                <div className="flex flex-col gap-1.5">
                  {autonomousScheduledRows.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session)))}
                </div>
              </section>
            ) : null}

            {autonomousLongtermRows.length > 0 ? (
              <section data-testid="process-autonomous-longterm" data-source-count={autonomousLongtermRows.length}>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('processSourceLongterm')} · {autonomousLongtermRows.length}
                </div>
                <div className="flex flex-col gap-1.5">
                  {autonomousLongtermRows.map((entry) => renderRun(entry, 0, rowValveLevelOf(entry.session)))}
                </div>
              </section>
            ) : null}

            {autonomousAutomationRows.length > 0 ? (
              <section
                data-testid="process-autonomous-automation"
                data-source-count={autonomousAutomationRows.length}
              >
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('processAutomationSection')} · {autonomousAutomationRows.length}
                </div>
                <div data-testid="process-automation-list" className="flex flex-col gap-1.5">
                  {autonomousAutomationRows.map((entry) => (
                    <ProcessAutomationRow
                      key={entry.key}
                      entry={entry}
                      nowMs={nowMs}
                      bot={automationBots[entry.metabotId] ?? null}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {autonomousScheduledRows.length === 0
              && autonomousLongtermRows.length === 0
              && autonomousAutomationRows.length === 0 ? (
              <p
                data-testid="process-autonomous-empty"
                className="rounded-[8px] border border-dashed border-claude-border px-3 py-4 text-center text-[11.5px] leading-5 dark:border-claude-darkBorder dark:text-claude-darkTextSecondary text-claude-textSecondary"
              >
                {i18nService.t('processAutonomousEmpty')}
              </p>
            ) : null}
          </div>
        ) : !zoneModel || zoneModel.nodes.length === 0 ? (
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
              data-count-unit="runs"
              className="text-[11px] font-semibold uppercase tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary"
            >
              {/* Same unit as the zone's tab badge (batch-A P1-4): a tab that
                  says 12 and a heading that says 4 for one zone is exactly the
                  "one position, two numbers" defect. */}
              {i18nService.t(ZONE_LABEL_KEY[zoneModel.zone])} · {zoneModel.runCount}
            </div>
            {nodes.map((node) => {
              if (!node.grouped) {
                return renderRun(node.children[0], 0, rowValveLevelOf(node.children[0].session));
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
                      {node.children.map((child) => renderRun(child, 1, rowValveLevelOf(child.session)))}
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
          className="ml-auto flex flex-shrink-0 items-center gap-1 text-[11.5px] font-semibold text-[#7A5F14] transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-claude-accent/40 dark:text-amber-200"
        >
          <ArchiveBoxIcon className="h-3.5 w-3.5" />
          {i18nService.t(archivedMode ? 'processArchivedBack' : 'processTabArchived')}
        </button>
      </div>
    </div>
  );
};

export default ProcessCenterPanel;
