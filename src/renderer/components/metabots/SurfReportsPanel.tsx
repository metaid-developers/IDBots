/**
 * MetaWeb surf run-history panel ("AI 冲浪" reports), indexed by day.
 *
 * A mini month calendar sits in the header where the manual refresh button
 * used to live: days that hold surf runs carry a marker dot, and picking a
 * day lists that day's runs (newest first) with the same expandable report
 * cards. The panel opens on the most recent day that has records, so the
 * newest report is visible immediately instead of a blank list.
 *
 * Freshness is push-based: the parent bumps refreshToken on every
 * surfStatusChanged event for this bot, which reloads the day markers and
 * re-reads the selected day's runs — there is no manual refresh.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MarkdownContent from '../MarkdownContent';
import MiniMonthCalendar from '../ui/MiniMonthCalendar';
import type { MetawebSurfRunInfo, MetawebSurfRunStats, MetawebSurfRunStatus, MetawebSurfTrigger } from '../../types/metawebSurf';

interface SurfReportsPanelProps {
  metabotId: number;
  /** Bumped by the parent when a surfStatusChanged event arrives for this bot. */
  refreshToken: number;
}

// Replicated from MetawebStudyJobsPanel (kept in sync with the edit-tab chrome).
const hintClass = 'text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1';
const cardClass = 'rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 space-y-3';

const STATUS_BADGE_CLASS: Record<MetawebSurfRunStatus, string> = {
  running: 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/30',
  done: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  failed: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
};

const STATUS_LABEL_KEY: Record<MetawebSurfRunStatus, string> = {
  running: 'surfStatusRunning',
  done: 'surfStatusDone',
  failed: 'surfStatusFailed',
};

const TRIGGER_LABEL_KEY: Record<MetawebSurfTrigger, string> = {
  'manual-chat': 'surfTriggerManualChat',
  'manual-ui': 'surfTriggerManualUi',
  'pre-dream': 'surfTriggerPreDream',
};

const formatStartedAt = (iso: string): string => {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
};

/** One-line stats summary: only the non-zero parts, i18n fragments joined by '·'. */
const formatRunStats = (stats: MetawebSurfRunStats): string => {
  const acted = stats.liked + stats.commented + stats.answered + stats.posted + stats.challenged;
  const parts: string[] = [];
  if (stats.fetched > 0) parts.push(i18nService.t('surfRunStatsFetched').replace('{count}', String(stats.fetched)));
  if (stats.deepRead > 0) parts.push(i18nService.t('surfRunStatsRead').replace('{count}', String(stats.deepRead)));
  if (stats.savedToKb > 0) parts.push(i18nService.t('surfRunStatsSaved').replace('{count}', String(stats.savedToKb)));
  if (acted > 0) parts.push(i18nService.t('surfRunStatsActed').replace('{count}', String(acted)));
  if (stats.tasksScheduled > 0) parts.push(i18nService.t('surfRunStatsTasks').replace('{count}', String(stats.tasksScheduled)));
  if (stats.inboxPresented > 0) parts.push(i18nService.t('surfRunStatsInbox').replace('{count}', String(stats.inboxPresented)));
  return parts.join(' · ');
};

/**
 * Half-open UTC-day boundaries (`>=` start, `<` end) of a `YYYY-MM-DD` day
 * key, as ISO strings for the store's range query. Day attribution follows
 * `created_at`'s own UTC prefix — the same coordinate system as the
 * `listRunDays` markers — so a marker dot, the day it selects, and the runs
 * that day view loads always agree.
 */
const dayKeyToUtcRangeIso = (dayKey: string): { dayStartIso: string; dayEndIso: string } | null => {
  const startMs = Date.parse(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(startMs)) return null;
  return {
    dayStartIso: new Date(startMs).toISOString(),
    dayEndIso: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
};

const SurfReportsPanel: React.FC<SurfReportsPanelProps> = ({ metabotId, refreshToken }) => {
  const [runs, setRuns] = useState<MetawebSurfRunInfo[]>([]);
  const [runDays, setRunDays] = useState<string[]>([]);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [panelError, setPanelError] = useState('');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [expandedDigestRunId, setExpandedDigestRunId] = useState<string | null>(null);
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  // Current selection, readable inside the load effect without becoming a
  // dependency (a pick re-loads its day itself; the effect must not re-fire).
  const selectedDayRef = useRef<string | null>(null);
  // Which bot's day index has seeded the default selection in this mounted
  // panel. A bot switch re-seeds; a push (refreshToken) must never yank the
  // user away from the day they are reading.
  const seededBotRef = useRef<number | null>(null);

  const loadRunsForDay = useCallback(async (dayKey: string) => {
    const range = dayKeyToUtcRangeIso(dayKey);
    if (!range) {
      setRuns([]);
      setLoaded(true);
      return;
    }
    try {
      const result = await window.electron.surf.listRunsByDay(metabotId, range.dayStartIso, range.dayEndIso);
      if (result.success && result.runs) {
        setRuns(result.runs);
        setPanelError('');
      } else {
        setPanelError(result.error || i18nService.t('surfReportsLoadFailed'));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : i18nService.t('surfReportsLoadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [metabotId]);

  const pickDay = useCallback((dayKey: string) => {
    selectedDayRef.current = dayKey;
    setSelectedDay(dayKey);
    void loadRunsForDay(dayKey);
  }, [loadRunsForDay]);

  // (Re)load the day index when a different bot is loaded into the same
  // mounted editor and whenever a surf run for this bot starts or finishes
  // (refreshToken bump — the push channel that replaced the manual refresh
  // button). On the first load for a bot the newest day with records becomes
  // the selection, so the panel opens on the freshest report; afterwards the
  // user's picked day is kept and only re-read.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const seed = seededBotRef.current !== metabotId;
      try {
        const result = await window.electron.surf.listRunDays(metabotId);
        if (cancelled) return;
        if (!result.success || !result.days) {
          setPanelError(result.error || i18nService.t('surfReportsLoadFailed'));
          setLoaded(true);
          return;
        }
        setRunDays(result.days);
        if (seed) {
          seededBotRef.current = metabotId;
          const newestDay = result.days[0] ?? null;
          selectedDayRef.current = newestDay;
          setSelectedDay(newestDay);
          if (newestDay) {
            await loadRunsForDay(newestDay);
            return;
          }
          setRuns([]);
          setLoaded(true);
          return;
        }
        const current = selectedDayRef.current;
        if (current) {
          await loadRunsForDay(current);
        }
      } catch (error) {
        if (cancelled) return;
        setPanelError(error instanceof Error ? error.message : i18nService.t('surfReportsLoadFailed'));
        setLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [metabotId, refreshToken, loadRunsForDay]);

  // Collapse any expanded report when switching bots.
  useEffect(() => {
    setExpandedRunId(null);
    setExpandedDigestRunId(null);
  }, [metabotId]);

  // The list lives in a height-capped scroll box, so a freshly expanded run
  // must be brought back into view (block: 'nearest' scrolls the minimum
  // amount, and is a no-op when already visible). Guarded because jsdom-style
  // test environments have no scrollIntoView.
  useEffect(() => {
    if (!expandedRunId) return;
    const card = cardRefs.current[expandedRunId];
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest' });
    }
  }, [expandedRunId]);

  const markedDayKeys = useMemo(() => new Set(runDays), [runDays]);

  const renderRunCard = (run: MetawebSurfRunInfo) => {
    const expanded = expandedRunId === run.id;
    const digestExpanded = expandedDigestRunId === run.id;
    const statsSummary = formatRunStats(run.stats);
    return (
      <div
        key={run.id}
        ref={(el) => {
          cardRefs.current[run.id] = el;
        }}
        className={cardClass}
        data-slot={`surf-report-run-${run.id}`}
      >
        <div
          role="button"
          tabIndex={0}
          onClick={() => setExpandedRunId(expanded ? null : run.id)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpandedRunId(expanded ? null : run.id);
            }
          }}
          className="flex items-center justify-between gap-3 cursor-pointer select-none"
        >
          <div className="flex items-center gap-2 min-w-0">
            {expanded ? (
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" aria-hidden />
            )}
            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text break-all">
              {i18nService.t(TRIGGER_LABEL_KEY[run.trigger] ?? 'surfTriggerManualUi')}
            </span>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">
              {formatStartedAt(run.startedAt)}
            </span>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 text-xs rounded-full border ${STATUS_BADGE_CLASS[run.status] ?? ''}`}
          >
            {run.status === 'running' ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 animate-pulse" aria-hidden />
            ) : null}
            {i18nService.t(STATUS_LABEL_KEY[run.status] ?? 'surfStatusRunning')}
          </span>
        </div>
        <p className={hintClass}>
          {statsSummary || '—'}
        </p>
        {expanded ? (
          <div className="space-y-2 pt-1">
            {run.error ? (
              <p className="text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">{run.error}</p>
            ) : null}
            {run.reportMarkdown ? (
              <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg p-3">
                <MarkdownContent content={run.reportMarkdown} compact />
              </div>
            ) : !run.error ? (
              <p className={hintClass}>—</p>
            ) : null}
            {run.briefingMarkdown ? (
              <div className="rounded-lg border dark:border-claude-darkBorder border-claude-border">
                <button
                  type="button"
                  data-slot={`surf-report-digest-toggle-${run.id}`}
                  onClick={() => setExpandedDigestRunId(digestExpanded ? null : run.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-lg transition-colors"
                >
                  {digestExpanded ? (
                    <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  {i18nService.t('surfReportDigestToggle')}
                </button>
                {digestExpanded ? (
                  <div className="border-t dark:border-claude-darkBorder border-claude-border p-3">
                    <MarkdownContent content={run.briefingMarkdown} compact />
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="space-y-3" data-slot="surf-reports-panel">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <span>{i18nService.t('surfReportsTitle')}</span>
          <span
            data-slot="surf-reports-count"
            className="inline-flex items-center rounded-full border dark:border-claude-darkBorder border-claude-border px-1.5 py-0.5 text-[10px] font-medium tabular-nums dark:text-claude-darkTextSecondary text-claude-textSecondary"
          >
            {runs.length}
          </span>
        </div>
        {loaded && runDays.length > 0 ? (
          <MiniMonthCalendar
            markedDayKeys={markedDayKeys}
            selectedDayKey={selectedDay}
            onPick={pickDay}
          />
        ) : null}
      </div>
      {panelError ? (
        <p className="text-xs text-red-600 dark:text-red-400">{panelError}</p>
      ) : loaded && runDays.length === 0 ? (
        <p className={hintClass}>{i18nService.t('surfReportsEmpty')}</p>
      ) : loaded && runs.length === 0 ? (
        <p className={hintClass}>{i18nService.t('surfReportsDayEmpty')}</p>
      ) : (
        <div
          data-slot="surf-reports-list"
          className="max-h-[min(420px,50vh)] overflow-y-auto overscroll-contain pr-1 space-y-3"
        >
          {runs.map(renderRunCard)}
        </div>
      )}
    </div>
  );
};

export default SurfReportsPanel;
