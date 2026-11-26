/**
 * MetaBot Create / Sync Status Modal (S1 — Studio Linear)
 *
 * Crisp status header (no bouncing emojis), subsidy badge, Bot identity strip,
 * official BTC/MVC/DOGE chain icons on address rows, grouped sync-step
 * checklist, and full preservation of `chainSetupPending` subsidy/self-fund
 * fallback flows.
 */

import React, { useState } from 'react';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  CheckIcon,
  CpuChipIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import { ChainIcon, type NativeChainKey } from './ChainIcon';
import NftAvatarFrame from './NftAvatarFrame';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
  METABOT_MODAL_SUBSURFACE_CLASS,
} from './metaBotCardPresentation.js';

export type SyncStatus = 'idle' | 'syncing' | 'success' | 'error';
export type SyncStepKey =
  | 'name'
  | 'avatar'
  | 'nftAvatar'
  | 'chatpubkey'
  | 'bio'
  | 'persona'
  | 'llm'
  | 'chatSkills'
  | 'homepage'
  | 'owner';

export interface MetaBotCreateSuccessModalProps {
  metabot: Metabot;
  subsidySuccess: boolean;
  subsidyError?: string;
  syncStatus?: SyncStatus;
  syncError?: string;
  mode?: 'create' | 'syncOnly' | 'editSync';
  syncStepKeys?: SyncStepKey[];
  showSubsidyStatus?: boolean;
  /** Create-fallback: nothing landed on-chain; show retry-subsidy / self-funded actions. */
  chainSetupPending?: boolean;
  /** Create mode only: jump straight into the edit view to complete the profile. */
  onContinueEditing?: () => void;
  onClose: () => void;
  onSyncToChain: () => void;
  onRetrySubsidy?: () => void;
  onSelfFundBroadcast?: () => void;
}

const FULL_SYNC_STEP_KEYS: SyncStepKey[] = [
  'name',
  'avatar',
  'nftAvatar',
  'chatpubkey',
  'bio',
  'persona',
  'llm',
  'chatSkills',
  'homepage',
];

const SYNC_STEP_LABEL_KEYS: Record<
  SyncStepKey,
  | 'metabotSyncStepName'
  | 'metabotSyncStepAvatar'
  | 'metabotSyncStepNftAvatar'
  | 'metabotSyncStepChatPubKey'
  | 'metabotSyncStepBio'
  | 'metabotSyncStepPersona'
  | 'metabotSyncStepLlm'
  | 'metabotSyncStepChatSkills'
  | 'metabotHomepage'
  | 'metabotSyncStepOwner'
> = {
  name: 'metabotSyncStepName',
  avatar: 'metabotSyncStepAvatar',
  nftAvatar: 'metabotSyncStepNftAvatar',
  chatpubkey: 'metabotSyncStepChatPubKey',
  bio: 'metabotSyncStepBio',
  persona: 'metabotSyncStepPersona',
  llm: 'metabotSyncStepLlm',
  chatSkills: 'metabotSyncStepChatSkills',
  homepage: 'metabotHomepage',
  owner: 'metabotSyncStepOwner',
};

const MetaBotCreateSuccessModal: React.FC<MetaBotCreateSuccessModalProps> = ({
  metabot,
  subsidySuccess,
  subsidyError,
  syncStatus = 'idle',
  syncError,
  mode = 'create',
  syncStepKeys,
  showSubsidyStatus = true,
  chainSetupPending = false,
  onContinueEditing,
  onClose,
  onSyncToChain,
  onRetrySubsidy,
  onSelfFundBroadcast,
}) => {
  const [copiedAddr, setCopiedAddr] = useState('');

  const btcAddr = metabot.btc_address ?? '';
  const mvcAddr = metabot.mvc_address ?? '';
  const dogeAddr = metabot.doge_address ?? '';

  const copyAddress = (addr: string) => {
    if (!addr) return;
    setCopiedAddr(addr);
    window.setTimeout(() => setCopiedAddr((c) => (c === addr ? '' : c)), 1800);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(addr).then(() => {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
      });
    }
  };

  const formatShort = (addr: string) => {
    if (!addr || addr.length < 18) return addr;
    return `${addr.slice(0, 9)}...${addr.slice(-8)}`;
  };

  const isSyncing = syncStatus === 'syncing';
  const isSyncSuccess = syncStatus === 'success';
  const isSyncError = syncStatus === 'error';
  const isCreateMode = mode === 'create';
  const isEditSyncMode = mode === 'editSync';
  const showSetupPendingActions = chainSetupPending && !isSyncSuccess;
  const showPrimaryAction = !showSetupPendingActions && (isEditSyncMode ? isSyncError : !isSyncSuccess);

  const title = isCreateMode
    ? i18nService.t('metabotCreateSuccess')
    : isEditSyncMode
      ? i18nService.t('metabotEditSyncTitle')
      : i18nService.t('metabotResyncTitle');
  const subtitle = isCreateMode
    ? i18nService.t('metabotCreateSuccessSubtitle')
    : isEditSyncMode
      ? i18nService.t('metabotEditSyncSubtitle')
      : i18nService.t('metabotResyncSubtitle');
  const stepsToRender = syncStepKeys && syncStepKeys.length > 0 ? syncStepKeys : FULL_SYNC_STEP_KEYS;

  const addressRows: Array<{ chain: NativeChainKey; label: string; addr: string }> = (
    [
      { chain: 'mvc' as const, label: 'MVC (SPACE)', addr: mvcAddr },
      { chain: 'btc' as const, label: 'BTC', addr: btcAddr },
      { chain: 'doge' as const, label: 'DOGE', addr: dogeAddr },
    ]
  ).filter((row) => Boolean(row.addr));

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-create-success-modal">
      <div
        className={METABOT_MODAL_SCRIM_CLASS}
        onClick={isSyncing ? undefined : onClose}
        role="presentation"
        style={{ cursor: isSyncing ? 'wait' : undefined }}
      />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[500px] max-h-[88vh]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        {/* Studio Linear Status Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border ${
                showSetupPendingActions
                  ? 'border-amber-500/35 bg-amber-500/12 text-amber-600 dark:text-amber-400'
                  : isSyncSuccess || isCreateMode
                    ? 'border-emerald-500/35 bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                    : 'border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]'
              }`}
            >
              {showSetupPendingActions ? (
                <ExclamationTriangleIcon className="h-4 w-4" aria-hidden />
              ) : isSyncSuccess || isCreateMode ? (
                <CheckCircleIcon className="h-4 w-4" aria-hidden />
              ) : (
                <LinkIcon className="h-4 w-4" aria-hidden />
              )}
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {title}
              </h2>
              <p className="truncate text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {subtitle}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={isSyncing}
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('metabotClose')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-3.5">
          {/* Subsidy Status Banner */}
          {showSubsidyStatus && (
            <div
              className={`rounded-[9px] border px-3.5 py-2.5 text-[12px] font-medium ${
                subsidySuccess
                  ? 'border-emerald-500/30 bg-emerald-500/[0.08] text-emerald-700 dark:text-emerald-300'
                  : 'border-rose-500/35 bg-rose-500/[0.08] text-red-700 dark:text-rose-300'
              }`}
            >
              {subsidySuccess
                ? i18nService.t('metabotMvcSubsidySuccess')
                : `${i18nService.t('metabotMvcSubsidyFailed')}${subsidyError ? `: ${subsidyError}` : ''}`}
            </div>
          )}

          {/* Setup-pending fallback */}
          {showSetupPendingActions && (
            <div className="rounded-[10px] border border-amber-500/35 bg-amber-500/[0.08] p-3.5 space-y-2">
              <div className="flex items-center gap-2 text-[12.5px] font-bold text-amber-700 dark:text-amber-300">
                <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden />
                <span>{i18nService.t('metabotSetupPendingTitle')}</span>
              </div>
              <p className="text-[12px] leading-relaxed text-[#5a6577] dark:text-[#94a3b8]">
                {i18nService.t('metabotSetupPendingHint')}
              </p>
              {mvcAddr && (
                <div className="space-y-1.5 pt-1">
                  <p className="text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('metabotSetupSelfFundHint')}
                  </p>
                  <div className="flex items-center gap-2 rounded-[7px] border border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-2.5 py-1.5">
                    <code className="min-w-0 flex-1 break-all font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                      {mvcAddr}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyAddress(mvcAddr)}
                      disabled={isSyncing}
                      className="shrink-0 text-[11px] font-semibold text-[#181d25] dark:text-[#f3f5f8] hover:underline disabled:opacity-50"
                    >
                      {i18nService.t('metabotCopyAddress')}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Identity Card */}
          <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center gap-3.5 p-3.5`}>
            <NftAvatarFrame
              avatar={metabot.avatar}
              alt={metabot.name}
              frameClassName="h-12 w-12 shrink-0 rounded-[10px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] overflow-hidden flex items-center justify-center"
              imgClassName="h-full w-full object-cover"
              fallback={<CpuChipIcon className="h-6 w-6 text-[#8c96a6]" aria-hidden />}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {metabot.name}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                {metabot.role || '—'}
              </div>
            </div>
          </div>

          {/* Multi-Chain Addresses with Official Icons */}
          {addressRows.length > 0 && (
            <div className={METABOT_GROUP_BOX_CLASS}>
              {addressRows.map((row) => {
                const isCopied = copiedAddr === row.addr;
                return (
                  <div key={row.chain} className="flex items-center justify-between gap-2.5 px-3.5 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <ChainIcon chain={row.chain} size={22} />
                      <span className="shrink-0 text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                        {row.label}
                      </span>
                      <code
                        className="truncate font-mono text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]"
                        title={row.addr}
                      >
                        {formatShort(row.addr)}
                      </code>
                    </div>
                    <button
                      type="button"
                      onClick={() => copyAddress(row.addr)}
                      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-[5px] text-[#5a6577] hover:bg-[#eef1f5] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:bg-white/[0.08] dark:hover:text-[#f3f5f8]"
                      title={i18nService.t('metabotCopyAddress')}
                      aria-label={i18nService.t('metabotCopyAddress')}
                    >
                      {isCopied ? (
                        <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          {/* Syncing Indicator */}
          {isEditSyncMode && isSyncing && (
            <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center gap-2.5 px-3.5 py-3 text-[12.5px] text-[#5a6577] dark:text-[#94a3b8]`}>
              <ArrowPathIcon className="h-4 w-4 animate-spin shrink-0 text-[#8a6d00] dark:text-[#FFDC51]" />
              <span>{i18nService.t('metabotSyncSyncing')}</span>
            </div>
          )}

          {/* Sync Success Checklist */}
          {isSyncSuccess && (
            <div className="rounded-[10px] border border-emerald-500/30 bg-emerald-500/[0.06] p-3.5 space-y-2.5">
              <div className="flex items-center gap-2 text-[12.5px] font-bold text-emerald-700 dark:text-emerald-400">
                <CheckCircleIcon className="h-4 w-4 shrink-0" />
                <span>{i18nService.t('metabotSyncSuccess')}</span>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                {stepsToRender.map((stepKey) => (
                  <div
                    key={stepKey}
                    className="flex items-center gap-1.5 rounded-[6px] bg-white/75 dark:bg-[#141e2e]/80 px-2 py-1 text-[11.5px] font-medium text-[#181d25] dark:text-[#f3f5f8]"
                  >
                    <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400 shrink-0" />
                    <span className="truncate">{i18nService.t(SYNC_STEP_LABEL_KEYS[stepKey])}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Sync Error */}
          {isSyncError && syncError && (
            <div className="rounded-[9px] border border-rose-500/35 bg-rose-500/[0.08] px-3.5 py-2.5 text-[12px] text-red-700 dark:text-rose-300">
              {i18nService.t('metabotSyncError')}: {syncError}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className={METABOT_MODAL_FOOTER_CLASS}>
          <div className="flex w-full flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSyncing}
              className={METABOT_BTN_FLAT_CLASS}
            >
              {i18nService.t('metabotClose')}
            </button>
            {isCreateMode && onContinueEditing && !showSetupPendingActions && (
              <button
                type="button"
                onClick={onContinueEditing}
                disabled={isSyncing}
                className={METABOT_BTN_FLAT_CLASS}
              >
                {i18nService.t('metabotContinueEditing')}
              </button>
            )}
            {showSetupPendingActions && onSelfFundBroadcast && (
              <button
                type="button"
                onClick={onSelfFundBroadcast}
                disabled={isSyncing}
                className={METABOT_BTN_FLAT_CLASS}
              >
                {i18nService.t('metabotSetupSelfFund')}
              </button>
            )}
            {showSetupPendingActions && onRetrySubsidy && (
              <button
                type="button"
                onClick={onRetrySubsidy}
                disabled={isSyncing}
                className={METABOT_BTN_PRIMARY_CLASS}
              >
                {isSyncing ? (
                  <>
                    <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                    <span>{i18nService.t('metabotSyncSyncing')}</span>
                  </>
                ) : (
                  i18nService.t('metabotSetupRetrySubsidy')
                )}
              </button>
            )}
            {showPrimaryAction && (
              <button
                type="button"
                onClick={onSyncToChain}
                disabled={isSyncing}
                className={METABOT_BTN_PRIMARY_CLASS}
              >
                {isSyncing ? (
                  <>
                    <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                    <span>{i18nService.t('metabotSyncSyncing')}</span>
                  </>
                ) : isEditSyncMode ? (
                  i18nService.t('onboardingRetry')
                ) : (
                  i18nService.t('metabotSyncToChain')
                )}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default MetaBotCreateSuccessModal;
