/**
 * Post-backup mnemonic reminder. A completed chain backup is only recoverable
 * through the user mnemonic (the backup key is derived from it alone), so every
 * successful backup that actually published new data ends with this prompt:
 * view the mnemonic now, keep it offline. Escape closes (restoring is not
 * blocked — the backup itself is already done).
 */

import React, { useEffect } from 'react';
import { ExclamationTriangleIcon, KeyIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';

export interface ChainBackupMnemonicReminderModalProps {
  onViewMnemonic: () => void;
  onClose: () => void;
}

const ChainBackupMnemonicReminderModal: React.FC<ChainBackupMnemonicReminderModalProps> = ({
  onViewMnemonic,
  onClose,
}) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={i18nService.t('userSettingsChainBackupMnemonicReminderTitle')}>
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} role="presentation" />
      <div className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        <div className="px-6 py-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 w-10 h-10 rounded-full bg-amber-500/15 flex items-center justify-center">
              <ExclamationTriangleIcon className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            </div>
            <div>
              <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('userSettingsChainBackupMnemonicReminderTitle')}
              </h2>
              <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('userSettingsChainBackupMnemonicReminderBody')}
              </p>
              <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-400">
                {i18nService.t('userSettingsChainBackupMnemonicReminderWarning')}
              </p>
            </div>
          </div>

          <div className="mt-6 flex justify-end gap-3">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:opacity-90"
            >
              {i18nService.t('userSettingsChainBackupMnemonicReminderDismiss')}
            </button>
            <button
              type="button"
              onClick={onViewMnemonic}
              className="btn-idchat-primary-filled px-4 py-2 text-sm inline-flex items-center"
            >
              <KeyIcon className="h-4 w-4 mr-1.5 inline" />
              {i18nService.t('userSettingsChainBackupMnemonicReminderView')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChainBackupMnemonicReminderModal;
