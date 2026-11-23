/**
 * MetaWeb study jobs panel ("夜间自主学习") in Studio Linear Style B.
 * Read-only status view at the bottom of the Knowledge Base tab.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { AcademicCapIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { MetawebStudyJobInfo, MetawebStudyJobStatus } from '../../types/metawebStudy';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_NOTE_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';

interface MetawebStudyJobsPanelProps {
  metabotId: number;
}

const STATUS_BADGE_CLASS: Record<MetawebStudyJobStatus, string> = {
  pending: 'bg-amber-500/12 text-amber-700 dark:text-amber-400 border-amber-500/25',
  running: 'bg-sky-500/12 text-sky-600 dark:text-sky-400 border-sky-500/25',
  done: 'bg-emerald-500/12 text-[#0f9d68] dark:text-[#34d399] border-emerald-500/25',
  failed: 'bg-red-500/12 text-red-600 dark:text-rose-400 border-red-500/25',
};

const STATUS_LABEL_KEY: Record<MetawebStudyJobStatus, string> = {
  pending: 'metawebStudyStatusPending',
  running: 'metawebStudyStatusRunning',
  done: 'metawebStudyStatusDone',
  failed: 'metawebStudyStatusFailed',
};

const formatRunAt = (iso: string | null): string => {
  if (!iso) return i18nService.t('metawebStudyNever');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString();
};

const MetawebStudyJobsPanel: React.FC<MetawebStudyJobsPanelProps> = ({ metabotId }) => {
  const [jobs, setJobs] = useState<MetawebStudyJobInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [panelError, setPanelError] = useState('');

  const loadJobs = useCallback(async () => {
    try {
      const result = await window.electron.metawebStudy.list(metabotId);
      if (result.success && result.jobs) {
        setJobs(result.jobs);
        setPanelError('');
      } else {
        setPanelError(result.error || i18nService.t('metawebStudyLoadFailed'));
      }
    } catch (error) {
      setPanelError(error instanceof Error ? error.message : i18nService.t('metawebStudyLoadFailed'));
    } finally {
      setLoaded(true);
    }
  }, [metabotId]);

  useEffect(() => {
    setJobs([]);
    setLoaded(false);
    setPanelError('');
    void loadJobs();
  }, [loadJobs]);

  const renderJobRow = (job: MetawebStudyJobInfo) => (
    <div key={job.id} className="px-4 py-3.5 space-y-1.5" data-slot={`metaweb-study-job-${job.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <AcademicCapIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
          <div className="min-w-0 flex-1">
            <div className={`${METABOT_ROW_TITLE_CLASS} break-all`}>{job.topic}</div>
            <p className={`${METABOT_ROW_HINT_CLASS} tabular-nums`}>
              {i18nService.t('metawebStudyJobStats')
                .replace('{runs}', String(job.runCount))
                .replace('{pins}', String(job.processedPinIds.length))
                .replace('{budget}', String(job.budgetPins))}
              {' · '}
              {i18nService.t('metawebStudyLastRun').replace('{time}', formatRunAt(job.lastRunAt))}
            </p>
          </div>
        </div>
        <span
          className={`shrink-0 inline-flex items-center px-2 py-0.5 text-[11px] font-semibold rounded-[5px] border ${STATUS_BADGE_CLASS[job.status] ?? ''}`}
        >
          {i18nService.t(STATUS_LABEL_KEY[job.status] ?? 'metawebStudyStatusPending')}
        </span>
      </div>
      {job.lastRunSummary ? (
        <p className="sm:pl-[28px] text-[12px] text-[#5a6577] dark:text-[#94a3b8] whitespace-pre-wrap break-words">
          {job.lastRunSummary}
        </p>
      ) : null}
      {job.lastError ? (
        <p className="sm:pl-[28px] text-xs text-red-600 dark:text-rose-400 whitespace-pre-wrap break-words">
          {job.lastError}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className="space-y-1.5">
      <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
        <div className="min-w-0">
          <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metawebStudyPanelTitle')}</span>
          <span className={`ml-2 ${METABOT_GROUP_NOTE_CLASS}`}>{i18nService.t('metawebStudyPanelHint')}</span>
        </div>
        <button
          type="button"
          data-slot="metaweb-study-refresh"
          onClick={() => void loadJobs()}
          className={METABOT_BTN_FLAT_CLASS}
        >
          <ArrowPathIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{i18nService.t('metawebStudyRefresh')}</span>
        </button>
      </div>

      {panelError ? (
        <p className="text-xs text-red-600 dark:text-rose-400">{panelError}</p>
      ) : null}

      <div className={METABOT_GROUP_BOX_CLASS}>
        {loaded && !panelError && jobs.length === 0 ? (
          <div className="px-4 py-5 text-center text-[12px] text-[#8c96a6] dark:text-[#64748b]">
            {i18nService.t('metawebStudyEmpty')}
          </div>
        ) : (
          jobs.map(renderJobRow)
        )}
      </div>
    </div>
  );
};

export default MetawebStudyJobsPanel;
