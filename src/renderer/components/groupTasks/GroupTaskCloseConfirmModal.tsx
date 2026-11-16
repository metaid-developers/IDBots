import React, { useState } from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon, CheckCircleIcon } from '@heroicons/react/24/outline';
import GroupTaskRatingStars from './GroupTaskRatingStars';

interface GroupTaskCloseConfirmModalProps {
  action: 'done' | 'cancelled';
  taskTitle: string;
  closing: boolean;
  error?: string | null;
  /** Accepting ('done') passes the owner's star rating + optional review. */
  onConfirm: (rating?: number, ratingComment?: string) => void;
  onCancel: () => void;
}

const GroupTaskCloseConfirmModal: React.FC<GroupTaskCloseConfirmModalProps> = ({
  action,
  taskTitle,
  closing,
  error,
  onConfirm,
  onCancel,
}) => {
  const isDone = action === 'done';
  const titleKey = isDone ? 'groupTasksAcceptClose' : 'groupTasksCancelTask';
  const confirmKey = isDone ? 'groupTasksAcceptCloseConfirm' : 'groupTasksCancelTaskConfirm';
  const [rating, setRating] = useState<number | null>(null);
  const [ratingComment, setRatingComment] = useState('');

  const handleConfirm = () => {
    if (isDone) {
      if (rating == null) return;
      onConfirm(rating, ratingComment.trim() || undefined);
    } else {
      onConfirm();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={closing ? undefined : onCancel}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className={`relative rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border p-5 ${
          isDone ? 'w-96' : 'w-80'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center">
          <div className={`w-10 h-10 rounded-full flex items-center justify-center mb-3 ${
            isDone ? 'bg-emerald-100 dark:bg-emerald-900/30' : 'bg-red-100 dark:bg-red-900/30'
          }`}>
            {isDone ? (
              <CheckCircleIcon className="w-5 h-5 text-emerald-500" />
            ) : (
              <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
            )}
          </div>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t(titleKey)}
          </h3>
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-5">
            {i18nService.t(confirmKey).replace('{title}', taskTitle)}
          </p>
          {isDone && (
            <div className="w-full mb-5">
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3">
                {i18nService.t('groupTasksRatingHint')}
              </p>
              <div className="mb-1 text-left">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('groupTasksRatingLabel')}
                </span>
              </div>
              <div className="flex justify-center mb-4">
                <GroupTaskRatingStars value={rating} onChange={setRating} />
              </div>
              <div className="mb-1 text-left">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  {i18nService.t('groupTasksRatingCommentLabel')}
                </span>
              </div>
              <textarea
                value={ratingComment}
                onChange={(e) => setRatingComment(e.target.value)}
                rows={3}
                disabled={closing}
                className="w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm text-left dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50 resize-none"
                placeholder={i18nService.t('groupTasksRatingCommentPlaceholder')}
              />
            </div>
          )}
          {error && (
            <p className="text-xs text-red-500 mb-4 w-full text-left">{error}</p>
          )}
          {isDone && rating == null && !error && (
            <p className="text-xs dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70 mb-4 w-full text-left">
              {i18nService.t('groupTasksRatingRequired')}
            </p>
          )}
          <div className="flex items-center gap-3 w-full">
            <button
              type="button"
              onClick={onCancel}
              disabled={closing}
              className="flex-1 px-4 py-2 text-sm rounded-[8px] dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={closing || (isDone && rating == null)}
              className={`flex-1 px-4 py-2 text-sm rounded-[8px] text-white transition-colors disabled:opacity-50 ${
                isDone ? 'bg-emerald-500 border border-emerald-600 hover:bg-emerald-600' : 'bg-red-500 border border-red-600 hover:bg-red-600'
              }`}
            >
              {i18nService.t(titleKey)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupTaskCloseConfirmModal;
