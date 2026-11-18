import React from 'react';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import type { ScheduledTaskRun } from '../../types/scheduledTask';

interface TaskRunHistoryProps {
  taskId: string;
  runs: ScheduledTaskRun[];
}

function formatDuration(ms: number | null): string {
  if (!ms) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60000)}m`;
}

const statusIcons: Record<string, { icon: string; color: string }> = {
  success: { icon: '✓', color: 'text-green-500' },
  error: { icon: '✗', color: 'text-red-500' },
  running: { icon: '●', color: 'text-blue-500' },
  skipped: { icon: '⊘', color: 'text-amber-500' },
  // T-A tiered outcomes: completed_empty must NOT read as success (amber),
  // crashed stays in the red ✗ family, timeout gets the clock.
  completed: { icon: '✓', color: 'text-green-500' },
  completed_empty: { icon: '◌', color: 'text-amber-500' },
  crashed: { icon: '✗', color: 'text-red-500' },
  timeout: { icon: '⏱', color: 'text-red-500' },
};

const skipReasonLabels: Record<string, string> = {
  already_running: 'scheduledTasksSkipReasonAlreadyRunning',
  expired: 'scheduledTasksSkipReasonExpired',
  disabled: 'scheduledTasksSkipReasonDisabled',
  stuck_running: 'scheduledTasksSkipReasonStuckRunning',
};

const TaskRunHistory: React.FC<TaskRunHistoryProps> = ({ taskId, runs }) => {
  const handleLoadMore = async () => {
    await scheduledTaskService.loadRuns(taskId, 50, runs.length);
  };

  if (runs.length === 0) {
    return (
      <div className="text-center py-6 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {i18nService.t('scheduledTasksNoRuns')}
      </div>
    );
  }

  return (
    <div>
      <div className="divide-y dark:divide-claude-darkBorder/50 divide-claude-border/50">
        {runs.map((run) => {
          const statusInfo = statusIcons[run.status] || { icon: '?', color: '' };
          return (
            <div key={run.id} className="flex items-center justify-between py-2.5 px-1">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`text-sm font-bold ${statusInfo.color}`}>{statusInfo.icon}</span>
                <div className="min-w-0">
                  <span className="text-sm dark:text-claude-darkText text-claude-text">
                    {new Date(run.startedAt).toLocaleString()}
                  </span>
                  <span className="ml-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {run.trigger === 'manual'
                      ? i18nService.t('scheduledTasksManual')
                      : i18nService.t('scheduledTasksScheduled')}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0 ml-2">
                {run.durationMs !== null && (
                  <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {formatDuration(run.durationMs)}
                  </span>
                )}
                {(run.status === 'error' || run.status === 'crashed' || run.status === 'timeout') && run.error && (
                  <span
                    className="text-xs text-red-500 max-w-[150px] truncate"
                    title={run.error}
                  >
                    {run.error}
                  </span>
                )}
                {run.status === 'skipped' && run.skipReason && (
                  <span className="text-xs text-amber-500">
                    {i18nService.t(skipReasonLabels[run.skipReason] || run.skipReason)}
                  </span>
                )}
                {run.sessionId && (
                  <button
                    type="button"
                    onClick={() => {
                      // Navigate to the cowork session
                      window.dispatchEvent(new CustomEvent('scheduledTask:viewSession', {
                        detail: { sessionId: run.sessionId },
                      }));
                    }}
                    className="text-xs text-claude-accent hover:text-claude-accentHover transition-colors"
                  >
                    {i18nService.t('scheduledTasksViewSession')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {runs.length >= 20 && (
        <button
          type="button"
          onClick={handleLoadMore}
          className="w-full py-2 mt-2 text-sm text-claude-accent hover:text-claude-accentHover transition-colors"
        >
          {i18nService.t('scheduledTasksLoadMore')}
        </button>
      )}
    </div>
  );
};

export default TaskRunHistory;
