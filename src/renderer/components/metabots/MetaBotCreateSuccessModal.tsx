/**
 * MetaBot Create Success Modal
 * Shows celebration UI, subsidy result, identity and addresses after creation.
 * Supports sync-to-chain flow with loading and success states.
 */

import React from 'react';
import { CpuChipIcon, CheckCircleIcon, ArrowPathIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';

export interface MetaBotCreateSuccessModalProps {
  metabot: Metabot;
  subsidySuccess: boolean;
  subsidyError?: string;
  syncStatus?: SyncStatus;
  syncError?: string;
  onClose: () => void;
  onSyncToChain: () => void;
}

const SYNC_STEPS = [
  { key: 'name', labelKey: 'metabotSyncStepName' as const },
  { key: 'avatar', labelKey: 'metabotSyncStepAvatar' as const },
  { key: 'chatpubkey', labelKey: 'metabotSyncStepChatPubKey' as const },
  { key: 'bio', labelKey: 'metabotSyncStepBio' as const },
];

const MetaBotCreateSuccessModal: React.FC<MetaBotCreateSuccessModalProps> = ({
  metabot,
  subsidySuccess,
  subsidyError,
  syncStatus = 'idle',
  syncError,
  onClose,
  onSyncToChain,
}) => {
  const btcAddr = metabot.btc_address ?? '';
  const mvcAddr = metabot.mvc_address ?? '';
  const dogeAddr = metabot.doge_address ?? '';

  const copyAddress = (addr: string) => {
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
    });
  };

  const formatShort = (addr: string) => {
    if (!addr || addr.length < 16) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
  };

  const isSyncing = syncStatus === 'syncing';
  const isSyncSuccess = syncStatus === 'success';
  const isSyncError = syncStatus === 'error';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60"
        onClick={isSyncing ? undefined : onClose}
        role="presentation"
        style={{ cursor: isSyncing ? 'wait' : undefined }}
      />
      <div className="relative w-full max-w-md rounded-2xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg shadow-xl overflow-hidden">
        {/* Celebration header */}
        <div className="px-6 py-6 text-center border-b dark:border-claude-darkBorder border-claude-border">
          <div className="text-4xl mb-2 animate-bounce" role="img" aria-hidden>
            🎉 🤖 ✨
          </div>
          <h2 className="text-xl font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('metabotCreateSuccess')}
          </h2>
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">
            {i18nService.t('metabotCreateSuccessSubtitle')}
          </p>
          <div
            className={`mt-3 text-sm px-3 py-2 rounded-lg ${
              subsidySuccess
                ? 'dark:bg-emerald-900/30 bg-emerald-100 dark:text-emerald-400 text-emerald-700'
                : 'dark:bg-red-900/30 bg-red-100 dark:text-red-400 text-red-700'
            }`}
          >
            {subsidySuccess
              ? i18nService.t('metabotMvcSubsidySuccess')
              : `${i18nService.t('metabotMvcSubsidyFailed')}${subsidyError ? `: ${subsidyError}` : ''}`}
          </div>
        </div>

        {/* Identity */}
        <div className="px-6 py-4 flex items-center gap-4">
          {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
            <img
              src={metabot.avatar}
              alt=""
              className="w-16 h-16 rounded-xl object-cover flex-shrink-0"
            />
          ) : (
            <div className="w-16 h-16 rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
              <CpuChipIcon className="h-8 w-8 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium dark:text-claude-darkText text-claude-text truncate">
              {metabot.name}
            </div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate">
              {metabot.role || '—'}
            </div>
          </div>
        </div>

        {/* Addresses */}
        <div className="px-6 pb-4 space-y-2">
          {btcAddr && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">BTC</span>
              <code className="text-xs dark:text-claude-darkText text-claude-text truncate flex-1 min-w-0">
                {formatShort(btcAddr)}
              </code>
              <button
                type="button"
                onClick={() => copyAddress(btcAddr)}
                className="shrink-0 px-2 py-1 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
              >
                {i18nService.t('metabotCopyAddress')}
              </button>
            </div>
          )}
          {mvcAddr && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">MVC</span>
              <code className="text-xs dark:text-claude-darkText text-claude-text truncate flex-1 min-w-0">
                {formatShort(mvcAddr)}
              </code>
              <button
                type="button"
                onClick={() => copyAddress(mvcAddr)}
                className="shrink-0 px-2 py-1 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
              >
                {i18nService.t('metabotCopyAddress')}
              </button>
            </div>
          )}
          {dogeAddr && (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary shrink-0">DOGE</span>
              <code className="text-xs dark:text-claude-darkText text-claude-text truncate flex-1 min-w-0">
                {formatShort(dogeAddr)}
              </code>
              <button
                type="button"
                onClick={() => copyAddress(dogeAddr)}
                className="shrink-0 px-2 py-1 text-xs rounded-lg dark:bg-claude-darkSurface bg-claude-surface dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
              >
                {i18nService.t('metabotCopyAddress')}
              </button>
            </div>
          )}
        </div>

        {/* Sync status: success with 4 checkmarks */}
        {isSyncSuccess && (
          <div className="px-6 py-3 border-t dark:border-claude-darkBorder border-claude-border">
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400 font-medium mb-2">
              <CheckCircleIcon className="h-5 w-5 shrink-0" />
              {i18nService.t('metabotSyncSuccess')}
            </div>
            <div className="grid grid-cols-2 gap-2">
              {SYNC_STEPS.map((step) => (
                <div
                  key={step.key}
                  className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                >
                  <CheckCircleIcon className="h-4 w-4 text-emerald-500 dark:text-emerald-400 shrink-0" />
                  {i18nService.t(step.labelKey)}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Sync error */}
        {isSyncError && syncError && (
          <div className="mx-6 mb-3 px-3 py-2 rounded-lg text-sm bg-red-500/10 dark:bg-red-500/10 text-red-600 dark:text-red-400">
            {i18nService.t('metabotSyncError')}: {syncError}
          </div>
        )}

        {/* Buttons */}
        <div className="px-6 pb-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSyncing}
            className="px-4 py-2 text-sm rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {i18nService.t('metabotClose')}
          </button>
          {!isSyncSuccess && (
            <button
              type="button"
              onClick={onSyncToChain}
              disabled={isSyncing}
              className="btn-idchat-primary-filled px-4 py-2 text-sm disabled:opacity-70 disabled:cursor-wait flex items-center gap-2"
            >
              {isSyncing ? (
                <>
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  {i18nService.t('metabotSyncSyncing')}
                </>
              ) : (
                i18nService.t('metabotSyncToChain')
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export default MetaBotCreateSuccessModal;
