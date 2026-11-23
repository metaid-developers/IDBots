/**
 * MetaWeb surf run-history panel ("冲浪报告") in Studio Linear Style B.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDaysIcon, ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import MarkdownContent from '../MarkdownContent';
import MiniMonthCalendar from '../ui/MiniMonthCalendar';
import type { MetawebSurfRunInfo, MetawebSurfRunStats, MetawebSurfRunStatus, MetawebSurfTrigger } from '../../types/metawebSurf';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_MICRO_BADGE_CLASS,
} from './metaBotCardPresentation.js';

interface SurfReportsPanelProps {
  metabotId: number;
  refreshToken: number;
}

const STATUS_BADGE_CLASS: Record<MetawebSurfRunStatus, string> = {
  running: 'bg-sky-500/12 text-sky-600 dark:text-sky-400 border-sky-500/25',
  done: 'bg-emerald-500/12 text-[#0f9d68] dark:text-[#34d399] border-emerald-500/25',
  failed: 'bg-red-500/12 text-red-600 dark:text-rose-400 border-red-500/25',
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
  const selectedDayRef = useRef<string | null>(null);
  const seededBotRef = useRef<number | null>(null);

  const [calOpen, setCalOpen] = useState(false);
  const [calPos, setCalPos] = useState<{ top: number; left: number } | null>(null);
  const calAnchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!calOpen) return;
    const close = (event: MouseEvent) => {
      if (!calAnchorRef.current?.contains(event.target as Node)) setCalOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [calOpen]);

  const openCal = () => {
    const rect = calAnchorRef.current?.getBoundingClientRect();
    if (rect) setCalPos({ top: rect.bottom + 4, left: Math.max(8, rect.right - 224) });
    setCalOpen((prev) => !prev);
  };

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

  useEffect(() => {
    setExpandedRunId(null);
    setExpandedDigestRunId(null);
    setCalOpen(false);
  }, [metabotId]);

  useEffect(() => {
    if (!expandedRunId) return;
    const card = cardRefs.current[expandedRunId];
    if (card && typeof card.scrollIntoView === 'function') {
      card.scrollIntoView({ block: 'nearest' });
    }
  }, [expandedRunId]);

  const markedDayKeys = useMemo(() => new Set(runDays), [runDays]);

  const renderRunRow = (run: MetawebSurfRunInfo) => {
    const expanded = expandedRunId === run.id;
    const digestExpanded = expandedDigestRunId === run.id;
    const statsSummary = formatRunStats(run.stats);
    return (
      <div
        key={run.id}
        ref={(el) => {
          cardRefs.current[run.id] = el;
        }}
        className="px-4 py-3 space-y-2"
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
              <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
            ) : (
              <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
            )}
            <span className="text-[13px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
              {i18nService.t(TRIGGER_LABEL_KEY[run.trigger] ?? 'surfTriggerManualUi')}
            </span>
            <span className="text-[11.5px] tabular-nums text-[#8c96a6] dark:text-[#64748b] shrink-0">
              {formatStartedAt(run.startedAt)}
            </span>
          </div>
          <span
            className={`shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 text-[11px] font-semibold rounded-[5px] border ${STATUS_BADGE_CLASS[run.status] ?? ''}`}
          >
            {run.status === 'running' ? (
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-sky-500 animate-pulse" aria-hidden />
            ) : null}
            {i18nService.t(STATUS_LABEL_KEY[run.status] ?? 'surfStatusRunning')}
          </span>
        </div>

        <p className="pl-[22px] text-[12px] tabular-nums text-[#5a6577] dark:text-[#94a3b8]">
          {statsSummary || '—'}
        </p>

        {expanded ? (
          <div className="pl-[22px] space-y-2 pt-1">
            {run.error ? (
              <p className="text-xs text-red-600 dark:text-rose-400 whitespace-pre-wrap break-words">{run.error}</p>
            ) : null}
            {run.reportMarkdown ? (
              <div className="rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.08] bg-[#f8fafc] dark:bg-[#131d2c] p-3">
                <MarkdownContent content={run.reportMarkdown} compact />
              </div>
            ) : !run.error ? (
              <p className="text-xs text-[#8c96a6] dark:text-[#64748b]">—</p>
            ) : null}
            {run.briefingMarkdown ? (
              <div className="rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.08] overflow-hidden">
                <button
                  type="button"
                  data-slot={`surf-report-digest-toggle-${run.id}`}
                  onClick={() => setExpandedDigestRunId(digestExpanded ? null : run.id)}
                  className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-[#5a6577] dark:text-[#94a3b8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.05] transition-colors"
                >
                  {digestExpanded ? (
                    <ChevronDownIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  ) : (
                    <ChevronRightIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  )}
                  {i18nService.t('surfReportDigestToggle')}
                </button>
                {digestExpanded ? (
                  <div className="border-t border-slate-900/[0.08] dark:border-white/[0.08] bg-[#f8fafc] dark:bg-[#131d2c] p-3">
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
    <div className="space-y-1.5" data-slot="surf-reports-panel">
      <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
        <div className="flex items-center gap-1.5">
          <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('surfReportsTitle')}</span>
          <span
            data-slot="surf-reports-count"
            className={`${METABOT_MICRO_BADGE_CLASS} tabular-nums`}
          >
            {runs.length}
          </span>
        </div>

        {loaded && runDays.length > 0 ? (
          <div className="relative shrink-0" ref={calAnchorRef}>
            <button
              type="button"
              onClick={openCal}
              className={`${METABOT_BTN_FLAT_CLASS} !h-7 !px-2 !text-[11.5px] tabular-nums`}
            >
              <CalendarDaysIcon className="h-3.5 w-3.5" aria-hidden />
              <span>{selectedDay ?? ''}</span>
            </button>
            {calOpen && calPos && (
              <div
                className="fixed z-40 rounded-[10px] border border-slate-900/[0.12] dark:border-white/[0.12] dark:bg-[#182538] bg-white shadow-2xl p-2"
                style={{ top: calPos.top, left: calPos.left }}
              >
                <MiniMonthCalendar
                  markedDayKeys={markedDayKeys}
                  selectedDayKey={selectedDay}
                  onPick={(dayKey) => {
                    pickDay(dayKey);
                    setCalOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        ) : null}
      </div>

      {panelError ? (
        <p className="text-xs text-red-600 dark:text-rose-400">{panelError}</p>
      ) : (
        <div className={METABOT_GROUP_BOX_CLASS}>
          {loaded && runDays.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-[#8c96a6] dark:text-[#64748b]">
              {i18nService.t('surfReportsEmpty')}
            </div>
          ) : loaded && runs.length === 0 ? (
            <div className="px-4 py-6 text-center text-[12px] text-[#8c96a6] dark:text-[#64748b]">
              {i18nService.t('surfReportsDayEmpty')}
            </div>
          ) : (
            <div
              data-slot="surf-reports-list"
              className="max-h-[min(420px,50vh)] overflow-y-auto overscroll-contain divide-y divide-slate-900/[0.065] dark:divide-white/[0.065]"
            >
              {runs.map(renderRunRow)}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SurfReportsPanel;
