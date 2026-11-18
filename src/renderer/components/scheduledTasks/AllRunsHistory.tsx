import React, { useEffect } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTaskRunWithName } from '../../types/scheduledTask';
import { ClockIcon } from '@heroicons/react/24/outline';

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

const statusConfig: Record<string, { label: string; color: string }> = {
  success: { label: 'scheduledTasksStatusSuccess', color: 'text-green-500' },
  error: { label: 'scheduledTasksStatusError', color: 'text-red-500' },
  running: { label: 'scheduledTasksStatusRunning', color: 'text-blue-500' },
  skipped: { label: 'scheduledTasksStatusSkipped', color: 'text-amber-500' },
  // T-A tiered outcomes (legacy success/error rows keep their keys).
  completed: { label: 'scheduledTasksStatusCompleted', color: 'text-green-500' },
  completed_empty: { label: 'scheduledTasksStatusCompletedEmpty', color: 'text-amber-500' },
  crashed: { label: 'scheduledTasksStatusCrashed', color: 'text-red-500' },
  timeout: { label: 'scheduledTasksStatusTimeout', color: 'text-red-500' },
};

const AllRunsHistory: React.FC = () => {
  const allRuns = useSelector((state: RootState) => state.scheduledTask.allRuns);

  useEffect(() => {
    scheduledTaskService.loadAllRuns(50);
  }, []);

  const handleLoadMore = () => {
    scheduledTaskService.loadAllRuns(50, allRuns.length);
  };

  const handleViewSession = (run: ScheduledTaskRunWithName) => {
    if (run.sessionId) {
      window.dispatchEvent(new CustomEvent('scheduledTask:viewSession', {
        detail: { sessionId: run.sessionId },
      }));
    }
  };

  if (allRuns.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6">
        <ClockIcon className="h-12 w-12 dark:text-claude-darkTextSecondary/40 text-claude-textSecondary/40 mb-4" />
        <p className="text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksHistoryEmpty')}
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Column Headers */}
      <div className="grid grid-cols-[1fr_1fr_80px] items-center gap-3 px-4 py-2 border-b dark:border-claude-darkBorder/50 border-claude-border/50">
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksHistoryColTitle')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksHistoryColTime')}
        </div>
        <div className="text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('scheduledTasksHistoryColStatus')}
        </div>
      </div>

      {/* Run rows */}
      {allRuns.map((run) => {
        const cfg = statusConfig[run.status] || { label: '', color: '' };
        return (
          <div
            key={run.id}
            className={`grid grid-cols-[1fr_1fr_80px] items-center gap-3 px-4 py-3 border-b dark:border-claude-darkBorder/50 border-claude-border/50 transition-colors ${
              run.sessionId
                ? 'hover:bg-claude-surfaceHover/50 dark:hover:bg-claude-darkSurfaceHover/50 cursor-pointer'
                : ''
            }`}
            onClick={() => handleViewSession(run)}
          >
            {/* Task title */}
            <div className="text-sm dark:text-claude-darkText text-claude-text truncate">
              {run.taskName}
              {run.status === 'running' && (
                <svg className="inline-block w-3 h-3 ml-1.5 animate-spin text-blue-500" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
                  <path d="M4 12a8 8 0 018-8" stroke="currentColor" strokeWidth="4" strokeLinecap="round" className="opacity-75" />
                </svg>
              )}
            </div>

            {/* Run time + duration */}
            <div className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {new Date(run.startedAt).toLocaleString()}
              {run.durationMs !== null && (
                <span className="ml-1.5 text-xs opacity-70">({formatDuration(run.durationMs)})</span>
              )}
            </div>

            {/* Status */}
            <div className={`text-sm font-medium ${cfg.color}`}>
              {i18nService.t(cfg.label)}
            </div>
          </div>
        );
      })}

      {/* Load more */}
      {allRuns.length >= 50 && allRuns.length % 50 === 0 && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="w-full py-3 text-sm text-claude-accent hover:text-claude-accentHover transition-colors"
        >
          {i18nService.t('scheduledTasksLoadMore')}
        </button>
      )}
    </div>
  );
};

export default AllRunsHistory;
