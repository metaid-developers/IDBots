import React, { useState } from 'react';
import type { CoworkPermissionRequest, CoworkPermissionResult } from '../../types/cowork';
import { i18nService } from '../../services/i18n';
import { coworkService } from '../../services/cowork';
import { a2aApprovalOf } from './permissionPromptLayout';
import { buildAllowResult } from './CoworkPermissionOverlay';

const firstQuestion = (permission: CoworkPermissionRequest): Record<string, unknown> | null => {
  const questions = permission.toolInput?.questions;
  if (!Array.isArray(questions)) return null;
  const first = questions.find((item) => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as Record<string, unknown>).question === 'string'
  ));
  return first ? first as Record<string, unknown> : null;
};

const A2AApprovalBar: React.FC<{ permission: CoworkPermissionRequest }> = ({ permission }) => {
  const approval = a2aApprovalOf(permission);
  const [responding, setResponding] = useState(false);
  if (!approval) return null;

  const action = approval.friendAction;
  const question = firstQuestion(permission);
  const questionText = typeof question?.question === 'string' ? question.question : '';
  const questionHeader = typeof question?.header === 'string' ? question.header.trim() : '';
  const title = action
    ? i18nService.t(action === 'invite' ? 'a2aFriendApprovalInviteTitle' : 'a2aFriendApprovalRemoveTitle')
    : questionHeader || i18nService.t('a2aApprovalRequestTitle');

  const respond = (result: CoworkPermissionResult) => {
    if (responding) return;
    setResponding(true);
    void coworkService.respondToPermission(permission.requestId, result).finally(() => {
      setResponding(false);
    });
  };

  return (
    <section
      className="mx-auto w-full overflow-hidden rounded-xl border border-amber-300/80 bg-claude-surface shadow-sm dark:border-amber-700/60 dark:bg-claude-darkSurface"
      data-a2a-approval={approval.category}
      data-a2a-friend-approval={action ?? undefined}
      aria-label={i18nService.t('a2aApprovalWaiting')}
    >
      <div className="flex items-center justify-center gap-2 border-b border-amber-200/70 bg-amber-50/70 px-3 py-2 text-xs font-medium text-amber-700 dark:border-amber-800/50 dark:bg-amber-900/20 dark:text-amber-300">
        <span className="h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_0_4px_rgba(245,158,11,0.12)]" />
        <span>{i18nService.t('a2aApprovalWaiting')}</span>
      </div>
      <div className="px-3 py-2.5 text-center">
        <p className="text-sm font-medium text-claude-text dark:text-claude-darkText">{title}</p>
        {questionText && (
          <p className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-left text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {questionText}
          </p>
        )}
      </div>
      <div className="flex items-center justify-center gap-2 border-t border-claude-border/70 px-3 py-2.5 dark:border-claude-darkBorder/70">
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
    </section>
  );
};

export default A2AApprovalBar;
