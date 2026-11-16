import React from 'react';
import { i18nService } from '../../services/i18n';
import { XMarkIcon } from '@heroicons/react/24/outline';
import GroupTaskRatingStars from './GroupTaskRatingStars';
import AcceptanceSummaryCard from './AcceptanceSummaryCard';
import { formatGroupTaskTime } from './groupTaskUtils';
import type { GroupTaskDetail } from '../../types/groupTask';

interface GroupTaskInfoModalProps {
  detail: GroupTaskDetail;
  onClose: () => void;
  onAccept?: () => void;
  onRework?: () => void;
  reworking?: boolean;
}

/**
 * Modal that displays task metadata: goal, acceptance criteria, summary, and rating.
 * Accessed via the compact info bar buttons.
 */
const GroupTaskInfoModal: React.FC<GroupTaskInfoModalProps> = ({
  detail,
  onClose,
  onAccept,
  onRework,
  reworking,
}) => {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      onClick={onClose}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border w-full max-w-2xl max-h-[80vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b dark:border-claude-darkBorder border-claude-border shrink-0">
          <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('groupTasksTaskInfo')}
          </h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-[8px] dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Task goal */}
          <div>
            <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
              {i18nService.t('groupTasksGoalLabel')}
            </h4>
            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap break-words">
              {detail.goal ?? '—'}
            </p>
          </div>

          {/* Acceptance summary */}
          {detail.acceptanceSummary && (
            <div>
              <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
                {i18nService.t('groupTasksAcceptanceSummaryTitle')}
              </h4>
              <AcceptanceSummaryCard
                summary={detail.acceptanceSummary}
                actions={
                  onAccept && onRework
                    ? { onAccept, onRework, reworking: reworking ?? false }
                    : undefined
                }
              />
            </div>
          )}

          {/* Acceptance criteria */}
          {detail.acceptanceCriteria && (
            <div>
              <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
                {i18nService.t('groupTasksFormAcceptance')}
              </h4>
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap break-words">
                {detail.acceptanceCriteria}
              </p>
            </div>
          )}

          {/* User rating (when task is done) */}
          {detail.status === 'done' && detail.rating != null && (
            <div>
              <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
                {i18nService.t('groupTasksYourRating')}
              </h4>
              <div className="rounded-lg border dark:border-claude-darkBorder/60 border-claude-border/60 px-3 py-2">
                <div className="flex items-center gap-2">
                  <GroupTaskRatingStars value={detail.rating} sizeClass="h-4 w-4" />
                  {detail.ratedAt && (
                    <span className="text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                      {formatGroupTaskTime(detail.ratedAt)}
                    </span>
                  )}
                </div>
                {detail.ratingComment && (
                  <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary whitespace-pre-wrap">
                    {detail.ratingComment}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Closed/driver info */}
          {detail.status === 'done' || detail.status === 'cancelled' ? (
            <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {i18nService.t('groupTasksClosedState')}
              {detail.closedAt ? ` · ${formatGroupTaskTime(detail.closedAt)}` : ''}
            </p>
          ) : null}
          {detail.driver && (
            <p className="text-xs dark:text-claude-darkTextSecondary/60 text-claude-textSecondary/60">
              {i18nService.t('groupTasksDriverInfo')}
              {` ${detail.driver.instanceId.slice(0, 8)} · ${formatGroupTaskTime(detail.driver.atMs)}`}
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2 text-sm rounded-[8px] dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('close')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GroupTaskInfoModal;
