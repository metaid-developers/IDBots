import React, { useEffect } from 'react';
import { ArrowPathIcon, CloudArrowDownIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

export interface ChainBackupRestorePromptProps {
  botCount: number;
  backupBotCount: number;
  restoring: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

const ChainBackupRestorePrompt: React.FC<ChainBackupRestorePromptProps> = ({
  botCount,
  backupBotCount,
  restoring,
  onConfirm,
  onCancel,
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !restoring) onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onCancel, restoring]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={i18nService.t('userSettingsChainBackupImportGuideTitle')}>
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={restoring ? undefined : onCancel} role="presentation" />
      <div className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-claude-accent/15 flex items-center justify-center">
              <CloudArrowDownIcon className="h-5 w-5 text-claude-accent" />
            </div>
            <div>
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('userSettingsChainBackupImportGuideTitle')}
              </h2>
              <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('userSettingsChainBackupImportGuideDescription')
                  .replace('{backup}', String(backupBotCount))
                  .replace('{total}', String(botCount))}
              </p>
              <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">
                {i18nService.t('userSettingsChainBackupImportGuideWarning')}
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={restoring}
              className="px-4 py-2 text-sm rounded-[8px] border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {i18nService.t('userSettingsChainBackupImportGuideLater')}
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={restoring}
              className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {restoring && <ArrowPathIcon className="h-4 w-4 mr-1.5 inline animate-spin" />}
              {restoring
                ? i18nService.t('userSettingsChainBackupRestoreRunning')
                : i18nService.t('userSettingsChainBackupImportGuideConfirm')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChainBackupRestorePrompt;
