import React from 'react';
import { i18nService } from '../../services/i18n';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';

interface GroupTaskKickConfirmModalProps {
  memberName: string;
  kicking: boolean;
  error?: string | null;
  /** Optional kick reason (recorded on-chain and sent with the kick notification). */
  reason: string;
  onReasonChange: (reason: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

const GroupTaskKickConfirmModal: React.FC<GroupTaskKickConfirmModalProps> = ({
  memberName,
  kicking,
  error,
  reason,
  onReasonChange,
  onConfirm,
  onCancel,
}) => {
  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={kicking ? undefined : onCancel}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 dark:bg-black/60" />

      {/* Modal */}
      <div
        className="relative w-80 rounded-xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center text-center">
          <div className="w-10 h-10 rounded-full flex items-center justify-center mb-3 bg-red-100 dark:bg-red-900/30">
            <ExclamationTriangleIcon className="w-5 h-5 text-red-500" />
          </div>
          <h3 className="text-sm font-semibold dark:text-claude-darkText text-claude-text mb-2">
            {i18nService.t('groupTasksRemoveMember')}
          </h3>
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
            {i18nService.t('groupTasksRemoveMemberConfirm').replace('{name}', memberName)}
          </p>
          {/* Optional reason — recorded on the removeuser pin and forwarded in
              the [OPENTEAM_KICK] notification. English placeholder by design. */}
          <input
            type="text"
            value={reason}
            onChange={(e) => onReasonChange(e.target.value)}
            disabled={kicking}
            placeholder="Reason for removal (optional)"
            className="w-full mb-4 px-3 py-2 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/60 placeholder:text-claude-textSecondary/60 focus:outline-none focus:ring-1 focus:ring-red-400 disabled:opacity-50"
          />
          {error && (
            <p className="text-xs text-red-500 mb-4 w-full text-left">{error}</p>
          )}
          <div className="flex items-center gap-3 w-full">
            <button
              type="button"
              onClick={onCancel}
              disabled={kicking}
              className="flex-1 px-4 py-2 text-sm rounded-lg dark:text-claude-darkText text-claude-text border dark:border-claude-darkBorder border-claude-border hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50"
            >
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={kicking}
              className="border border-red-600 flex-1 px-4 py-2 text-sm rounded-lg text-white transition-colors disabled:opacity-50 bg-red-500 hover:bg-red-600"
            >
              {kicking ? i18nService.t('groupTasksRemovingMember') : i18nService.t('groupTasksRemoveMember')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GroupTaskKickConfirmModal;
