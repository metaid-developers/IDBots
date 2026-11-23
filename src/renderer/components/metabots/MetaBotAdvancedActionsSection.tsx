/**
 * MetaBot Advanced Actions Section (Studio Linear Style B)
 *
 * Unified grouped list for On-Chain Wallet, NFT Vault, Mnemonic Backup, and
 * safe local Bot removal. Preserves all data-slot markers and modal flows.
 */

import React, { useState } from 'react';
import {
  PhotoIcon,
  ShieldCheckIcon,
  TrashIcon,
  WalletIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import MetaBotBackupMnemonicModal from './MetaBotBackupMnemonicModal';
import MetaBotNftWalletModal from './MetaBotNftWalletModal';
import MetaBotWalletBalanceModal from './MetaBotWalletBalanceModal';
import {
  METABOT_BTN_DANGER_CLASS,
  METABOT_BTN_FLAT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_GROUP_LABEL_CLASS,
  METABOT_GROUP_LABEL_ROW_CLASS,
  METABOT_GROUP_ROW_CLASS,
  METABOT_ROW_HINT_CLASS,
  METABOT_ROW_ICON_CLASS,
  METABOT_ROW_TITLE_CLASS,
} from './metaBotCardPresentation.js';

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

  return (
    <div>
      <div className={METABOT_GROUP_LABEL_ROW_CLASS}>
        <span className={METABOT_GROUP_LABEL_CLASS}>{i18nService.t('metabotSectionChainWallet')}</span>
      </div>

      <div className={METABOT_GROUP_BOX_CLASS} data-slot="metabot-advanced-chain-wallet-card">
        <div
          onClick={() => setShowWalletModal(true)}
          className={`${METABOT_GROUP_ROW_CLASS} cursor-pointer hover:bg-[#f9fafb] dark:hover:bg-[#1c2b40] transition-colors`}
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <WalletIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
            <div className="min-w-0">
              <div className={METABOT_ROW_TITLE_CLASS}>{i18nService.t('metabotWallet')}</div>
              <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotWalletHint')}</p>
            </div>
          </div>
          <button
            type="button"
            data-slot="metabot-advanced-open-wallet"
            onClick={(e) => {
              e.stopPropagation();
              setShowWalletModal(true);
            }}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {i18nService.t('metabotWalletOpenAction')}
          </button>
        </div>

        <div
          onClick={() => setShowNftWalletModal(true)}
          className={`${METABOT_GROUP_ROW_CLASS} cursor-pointer hover:bg-[#f9fafb] dark:hover:bg-[#1c2b40] transition-colors`}
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <PhotoIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
            <div className="min-w-0">
              <div className={METABOT_ROW_TITLE_CLASS}>{i18nService.t('metabotNftWallet')}</div>
              <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotNftWalletHint')}</p>
            </div>
          </div>
          <button
            type="button"
            data-slot="metabot-advanced-open-nft-wallet"
            onClick={(e) => {
              e.stopPropagation();
              setShowNftWalletModal(true);
            }}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {i18nService.t('metabotNftWalletOpenAction')}
          </button>
        </div>

        <div
          onClick={() => setShowBackupModal(true)}
          className={`${METABOT_GROUP_ROW_CLASS} cursor-pointer hover:bg-[#f9fafb] dark:hover:bg-[#1c2b40] transition-colors`}
        >
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <ShieldCheckIcon className={METABOT_ROW_ICON_CLASS} aria-hidden />
            <div className="min-w-0">
              <div className={METABOT_ROW_TITLE_CLASS}>{i18nService.t('metabotBackup')}</div>
              <p className={METABOT_ROW_HINT_CLASS}>{i18nService.t('metabotBackupHint')}</p>
            </div>
          </div>
          <button
            type="button"
            data-slot="metabot-advanced-open-backup"
            onClick={(e) => {
              e.stopPropagation();
              setShowBackupModal(true);
            }}
            className={METABOT_BTN_FLAT_CLASS}
          >
            {i18nService.t('metabotBackupOpenAction')}
          </button>
        </div>

        <div className={METABOT_GROUP_ROW_CLASS} data-slot="metabot-advanced-danger-card">
          <div className="flex items-start gap-2.5 min-w-0 flex-1">
            <TrashIcon className="h-[18px] w-[18px] text-red-600 dark:text-rose-400 mt-0.5 shrink-0" aria-hidden />
            <div className="min-w-0">
              <div className="text-[13.5px] font-semibold text-red-600 dark:text-rose-400">
                {i18nService.t('metabotDeleteBotTitle')}
              </div>
              <p className={METABOT_ROW_HINT_CLASS}>
                {i18nService.t('metabotDeleteBotWarning')}
              </p>
            </div>
          </div>
          <button
            type="button"
            data-slot="metabot-advanced-open-delete"
            onClick={onDelete}
            className={METABOT_BTN_DANGER_CLASS}
          >
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
