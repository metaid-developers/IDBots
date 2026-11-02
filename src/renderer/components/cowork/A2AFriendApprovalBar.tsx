import React, { useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { friendActionOf } from './permissionPromptLayout';
import { buildAllowResult } from './CoworkPermissionOverlay';

const questionText = (permission: CoworkPermissionRequest): string => {
  const questions = permission.toolInput?.questions;
  if (!Array.isArray(questions)) return '';
  const first = questions.find((item) => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as Record<string, unknown>).question === 'string'
  ));
  return first ? String((first as Record<string, unknown>).question) : '';
};

/**
 * In-conversation seat for an A2A friend invite or unfollow. The same
 * request is answered here or from the corner notification; answering
 * either one resolves both.
 */
const A2AFriendApprovalBar: React.FC<{ permission: CoworkPermissionRequest }> = ({ permission }) => {
  const action = friendActionOf(permission);
  const [responding, setResponding] = useState(false);
  if (!action) return null;

  const respond = (result: CoworkPermissionResult) => {
    if (responding) return;
    setResponding(true);
    void coworkService.respondToPermission(permission.requestId, result).finally(() => {
      setResponding(false);
    });
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-claude-border bg-claude-surface dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      data-a2a-friend-approval={action}
    >
      <div className="px-3 py-2.5">
        <p className="text-sm font-medium text-claude-text dark:text-claude-darkText">
          {i18nService.t(action === 'invite' ? 'a2aFriendApprovalInviteTitle' : 'a2aFriendApprovalRemoveTitle')}
        </p>
        {questionText(permission) && (
          <p className="mt-1 line-clamp-3 text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {questionText(permission)}
          </p>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-claude-border/70 px-3 py-2.5 dark:border-claude-darkBorder/70">
        <button
          type="button"
          disabled={responding}
          onClick={() => respond({ behavior: 'deny', message: 'Permission denied' })}
          className="rounded-lg border border-red-300 bg-red-50 px-4 py-1.5 text-xs font-semibold text-red-600 transition-colors hover:border-red-400 hover:bg-red-100 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-60 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300 dark:hover:bg-red-900/40 dark:hover:text-red-200"
        >
          {i18nService.t('coworkDeny')}
        </button>
        <button
          type="button"
          disabled={responding}
          onClick={() => respond(buildAllowResult(permission))}
          className="btn-idchat-primary-filled rounded-lg px-4 py-1.5 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          {responding ? i18nService.t('processing') : i18nService.t('coworkApprove')}
        </button>
      </div>
    </div>
  );
};

export default A2AFriendApprovalBar;
