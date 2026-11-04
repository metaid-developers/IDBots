/**
 * MetaBot Advanced Actions Section
 *
 * Wallet / Backup / Delete actions for the Advanced tab of the MetaBot edit
 * view. Layout mirrors the OAC (/ui/bot) "Advanced" tab: a "Chain & Wallet"
 * card hosting Wallet + Backup buttons, and a red "Danger Zone" card hosting
 * the Delete Bot action. These are immediate-action controls (they open
 * panels / trigger the delete flow) and sit outside the tab's homepage save.
 */

import React, { useState } from 'react';
import {
  ArrowDownTrayIcon,
  ExclamationTriangleIcon,
  PhotoIcon,
  TrashIcon,
  WalletIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import MetaBotBackupMnemonicModal from './MetaBotBackupMnemonicModal';
import MetaBotNftWalletModal from './MetaBotNftWalletModal';
import MetaBotWalletBalanceModal from './MetaBotWalletBalanceModal';

interface MetaBotAdvancedActionsSectionProps {
  metabot: Metabot;
  /** Trigger the manager-level safe-delete flow (opens MetaBotDeleteConfirmModal). */
  onDelete: () => void;
}

const MetaBotAdvancedActionsSection: React.FC<MetaBotAdvancedActionsSectionProps> = ({
  metabot,
  onDelete,
}) => {
  const [showWalletModal, setShowWalletModal] = useState(false);
  const [showNftWalletModal, setShowNftWalletModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);

  const cardBase =
    'rounded-xl border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 space-y-3';
  const cardHead =
    'flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider dark:text-claude-darkTextSecondary text-claude-textSecondary';
  const cardDivider = 'h-px dark:bg-claude-darkBorder bg-claude-border';
  const actionBtn =
    'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors';

  return (
    <div className="space-y-3 pt-2">
      {/* Chain & Wallet */}
      <div className={cardBase} data-slot="metabot-advanced-chain-wallet-card">
        <div className={cardHead}>
          <WalletIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{i18nService.t('metabotSectionChainWallet')}</span>
        </div>
        <div className={cardDivider} />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-slot="metabot-advanced-open-wallet"
            onClick={() => setShowWalletModal(true)}
            className={actionBtn}
          >
            <WalletIcon className="h-4 w-4" aria-hidden />
            {i18nService.t('metabotWallet')}
          </button>
          <button
            type="button"
            data-slot="metabot-advanced-open-nft-wallet"
            onClick={() => setShowNftWalletModal(true)}
            className={actionBtn}
          >
            <PhotoIcon className="h-4 w-4" aria-hidden />
            {i18nService.t('metabotNftWallet')}
          </button>
          <button
            type="button"
            data-slot="metabot-advanced-open-backup"
            onClick={() => setShowBackupModal(true)}
            className={actionBtn}
          >
            <ArrowDownTrayIcon className="h-4 w-4" aria-hidden />
            {i18nService.t('metabotBackup')}
          </button>
        </div>
      </div>

      {/* Danger Zone */}
      <div
        className={`${cardBase} border-red-500/40 dark:border-red-500/40 bg-red-500/5 dark:bg-red-500/5`}
        data-slot="metabot-advanced-danger-card"
      >
        <div className={`${cardHead} text-red-600 dark:text-red-400`}>
          <ExclamationTriangleIcon className="h-3.5 w-3.5" aria-hidden />
          <span>{i18nService.t('metabotSectionDangerZone')}</span>
        </div>
        <div className={`${cardDivider} dark:bg-red-500/30 bg-red-500/30`} />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary flex-1 min-w-[200px]">
            {i18nService.t('metabotDeleteBotWarning')}
          </p>
          <button
            type="button"
            data-slot="metabot-advanced-open-delete"
            onClick={onDelete}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-red-500/50 dark:border-red-500/50 text-red-600 dark:text-red-400 hover:bg-red-500/10 dark:hover:bg-red-500/10 transition-colors"
          >
            <TrashIcon className="h-4 w-4" aria-hidden />
            {i18nService.t('metabotDeleteBot')}
          </button>
        </div>
      </div>

      {showWalletModal && (
        <MetaBotWalletBalanceModal
          isOpen={showWalletModal}
          metabot={metabot}
          onClose={() => setShowWalletModal(false)}
        />
      )}
      {showNftWalletModal && (
        <MetaBotNftWalletModal
          metabot={metabot}
          onClose={() => setShowNftWalletModal(false)}
        />
      )}
      {showBackupModal && (
        <MetaBotBackupMnemonicModal
          metabot={metabot}
          onClose={() => setShowBackupModal(false)}
        />
      )}
    </div>
  );
};

export default MetaBotAdvancedActionsSection;
