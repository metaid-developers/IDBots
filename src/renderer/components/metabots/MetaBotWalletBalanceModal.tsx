/**
 * MetaBot Wallet Balance Modal (W1 — Studio Linear Unified Multi-Tab Sheet)
 *
 * Single-axis tabbed wallet combining Native chains (BTC / MVC / DOGE),
 * MRC-20 tokens on BTC, and MCP02 fungible tokens on MVC, with an inline
 * 3-step transfer flow, official chain vector icons, and MVC degraded-read
 * truth-layer warnings.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ArrowTopRightOnSquareIcon,
  CheckCircleIcon,
  CheckIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  PaperAirplaneIcon,
  PhotoIcon,
  WalletIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import { ChainIcon, TokenAvatar, type NativeChainKey } from './ChainIcon';
import type {
  MetaBotWalletAssetsBundle,
  Mrc20WalletAsset,
  MvcFtWalletAsset,
} from './MetaBotWalletAssetsModal';
import type { TokenTransferAsset } from './MetaBotTokenTransferModal';
import {
  buildTokenTransferExecutePayload,
  buildTokenTransferPreviewPayload,
  validateTokenTransferDraft,
} from './metabotWalletPresentation.js';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_CLEAN_INPUT_CLASS,
  METABOT_GROUP_BOX_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MICRO_BADGE_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
  METABOT_MODAL_SUBSURFACE_CLASS,
} from './metaBotCardPresentation.js';

export type WalletTabKey = 'native' | 'mrc20' | 'mvc-ft';

export interface MetaBotWalletBalanceModalProps {
  isOpen: boolean;
  metabot: Metabot;
  onClose: () => void;
  /** Optional quick jump from On-Chain Wallet directly to the NFT Vault. */
  onOpenNftWallet?: () => void;
}

interface BalanceState {
  btc?: string;
  mvc?: string;
  doge?: string;
  /** MVC only: degraded-verdict note from the truth layer (read path suspect). */
  mvcNote?: string;
  loading: boolean;
}

type ChainBalanceRow = { value: number | null; unit: string; degraded?: string; error?: string };

interface FeeOption {
  title: string;
  desc: string;
  feeRate: number;
}

interface NativeTransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  total: string;
  totalUnit: string;
  feeRateSatPerVb: number;
}

interface TokenTransferPreview {
  fromAddress: string;
  toAddress: string;
  amount: string;
  amountUnit: string;
  feeEstimated: string;
  feeEstimatedUnit: string;
  chainSymbol: 'BTC' | 'SPACE';
  feeRate: number;
}

type ActiveTransferTarget =
  | {
      mode: 'native';
      chain: NativeChainKey;
      symbol: 'BTC' | 'SPACE' | 'DOGE';
      fromAddress: string;
      maxBalance: string;
    }
  | {
      mode: 'token';
      asset: TokenTransferAsset;
    };

function chainBalanceText(row: ChainBalanceRow | undefined): string | undefined {
  if (row == null) return undefined;
  if (row.value == null) return i18nService.t('metabotBalanceUnavailable');
  return `${row.value.toFixed(8)} ${row.unit}`;
}

function balanceStateFromApi(balance: {
  btc?: ChainBalanceRow;
  mvc?: ChainBalanceRow;
  doge?: ChainBalanceRow;
}): Omit<BalanceState, 'loading'> {
  return {
    btc: chainBalanceText(balance.btc),
    mvc: chainBalanceText(balance.mvc),
    doge: chainBalanceText(balance.doge),
    mvcNote: balance.mvc?.degraded
      ? `${i18nService.t('metabotBalanceDegraded')} ${balance.mvc.degraded}`
      : undefined,
  };
}

function formatShortAddress(addr: string, head = 8, tail = 6): string {
  if (!addr || addr.length <= head + tail + 3) return addr;
  return `${addr.slice(0, head)}...${addr.slice(-tail)}`;
}

function isNonZeroBalancePart(val?: string): boolean {
  if (!val) return false;
  const trimmed = val.trim();
  if (!trimmed || trimmed === '0' || trimmed === '0.0' || trimmed === '+0' || trimmed === '-0') return false;
  const num = Number(trimmed);
  return Number.isNaN(num) ? true : num !== 0;
}

const CHAIN_META: ReadonlyArray<{
  chain: NativeChainKey;
  title: string;
  symbol: 'BTC' | 'SPACE' | 'DOGE';
  networkBadge: string;
}> = [
  { chain: 'mvc', title: 'MicroVisionChain', symbol: 'SPACE', networkBadge: 'MVC · SPACE' },
  { chain: 'btc', title: 'Bitcoin', symbol: 'BTC', networkBadge: 'BTC · Mainnet' },
  { chain: 'doge', title: 'Dogecoin', symbol: 'DOGE', networkBadge: 'DOGE · Mainnet' },
];

const MetaBotWalletBalanceModal: React.FC<MetaBotWalletBalanceModalProps> = ({
  isOpen,
  metabot,
  onClose,
  onOpenNftWallet,
}) => {
  const [activeTab, setActiveTab] = useState<WalletTabKey>('native');
  const [balance, setBalance] = useState<BalanceState>({ loading: true });
  const [walletAssets, setWalletAssets] = useState<MetaBotWalletAssetsBundle | null>(null);
  const [walletAssetsLoading, setWalletAssetsLoading] = useState(false);
  const [walletAssetsError, setWalletAssetsError] = useState('');
  const [copiedValue, setCopiedValue] = useState('');
  const [activeTransfer, setActiveTransfer] = useState<ActiveTransferTarget | null>(null);

  const refreshAllBalances = useCallback(() => {
    if (typeof window === 'undefined' || !window.electron?.idbots) return Promise.resolve();
    setBalance((prev) => ({ ...prev, loading: true }));
    return window.electron.idbots
      .getAddressBalance({ metabotId: metabot.id })
      .then((res) => {
        if (!res.success || !res.balance) {
          setBalance((prev) => ({ ...prev, loading: false }));
          return;
        }
        setBalance({ loading: false, ...balanceStateFromApi(res.balance) });
      })
      .catch(() => {
        setBalance({
          loading: false,
          btc: i18nService.t('metabotBalanceError'),
          mvc: i18nService.t('metabotBalanceError'),
          doge: i18nService.t('metabotBalanceError'),
        });
      });
  }, [metabot.id]);

  const refreshWalletAssets = useCallback(() => {
    if (typeof window === 'undefined' || !window.electron?.idbots) return Promise.resolve();
    setWalletAssetsLoading(true);
    setWalletAssetsError('');
    return window.electron.idbots
      .getMetabotWalletAssets({ metabotId: metabot.id })
      .then((res) => {
        if (!res.success || !res.assets) {
          setWalletAssetsError(res.error || i18nService.t('metabotWalletAssetsLoadFailed'));
          return;
        }
        setWalletAssets(res.assets);
      })
      .catch((error) => {
        setWalletAssetsError(error instanceof Error ? error.message : i18nService.t('metabotWalletAssetsLoadFailed'));
      })
      .finally(() => {
        setWalletAssetsLoading(false);
      });
  }, [metabot.id]);

  const refreshEverything = useCallback(() => {
    void refreshAllBalances();
    void refreshWalletAssets();
  }, [refreshAllBalances, refreshWalletAssets]);

  useEffect(() => {
    if (!isOpen) {
      setActiveTransfer(null);
      return;
    }
    refreshEverything();
  }, [isOpen, refreshEverything]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (activeTransfer) setActiveTransfer(null);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, activeTransfer, onClose]);

  if (!isOpen) return null;

  const copyText = (val: string, toastKey: string = 'metabotAddressCopied') => {
    if (!val) return;
    setCopiedValue(val);
    window.setTimeout(() => {
      setCopiedValue((curr) => (curr === val ? '' : curr));
    }, 1800);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(val).then(() => {
        window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(toastKey) }));
      });
    }
  };

  const parseNumericBalance = (balanceStr: string | undefined): string => {
    if (
      !balanceStr ||
      balanceStr === i18nService.t('metabotBalanceLoading') ||
      balanceStr === i18nService.t('metabotBalanceError') ||
      balanceStr === i18nService.t('metabotBalanceUnavailable')
    ) {
      return '0';
    }
    const parts = balanceStr.trim().split(/\s+/);
    return parts[0] ?? '0';
  };

  const btcAddr = metabot.btc_address ?? '';
  const mvcAddr = metabot.mvc_address ?? '';
  const dogeAddr = metabot.doge_address ?? '';

  const addressByChain: Record<NativeChainKey, string> = {
    btc: btcAddr,
    mvc: mvcAddr,
    doge: dogeAddr,
  };

  const balanceByChain: Record<NativeChainKey, string | undefined> = {
    btc: balance.btc,
    mvc: balance.mvc,
    doge: balance.doge,
  };

  const mrc20List: Mrc20WalletAsset[] = walletAssets?.mrc20Assets ?? [];
  const mvcFtList: MvcFtWalletAsset[] = walletAssets?.mvcFtAssets ?? [];
  const nativeCount = CHAIN_META.filter((item) => Boolean(addressByChain[item.chain])).length;
  const isAnyLoading = balance.loading || walletAssetsLoading;

  const transferSymbol = activeTransfer
    ? activeTransfer.mode === 'native'
      ? activeTransfer.symbol
      : activeTransfer.asset.symbol
    : '';

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-wallet-modal">
      <div
        className={METABOT_MODAL_SCRIM_CLASS}
        onClick={() => {
          if (activeTransfer) setActiveTransfer(null);
          else onClose();
        }}
        aria-hidden
      />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[600px] max-h-[86vh]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('metabotWallet')}
      >
        {/* Studio Linear Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            {activeTransfer ? (
              <button
                type="button"
                data-slot="metabot-wallet-transfer-back"
                onClick={() => setActiveTransfer(null)}
                className={METABOT_ICON_BTN_CLASS}
                aria-label={i18nService.t('metabotWalletBackToAssets')}
                title={i18nService.t('metabotWalletBackToAssets')}
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
                <WalletIcon className="h-4 w-4" aria-hidden />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {activeTransfer
                  ? `${i18nService.t('transferTitle')} · ${transferSymbol}`
                  : i18nService.t('metabotWallet')}
              </div>
              <div className="truncate text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {metabot.name}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!activeTransfer && onOpenNftWallet && (
              <button
                type="button"
                data-slot="metabot-wallet-open-nft"
                onClick={() => {
                  onClose();
                  onOpenNftWallet();
                }}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <PhotoIcon className="h-3.5 w-3.5 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
                <span>{i18nService.t('metabotWalletJumpNft')}</span>
                <ArrowTopRightOnSquareIcon className="h-3 w-3 opacity-65" aria-hidden />
              </button>
            )}
            {!activeTransfer && (
              <button
                type="button"
                data-slot="metabot-wallet-refresh"
                onClick={refreshEverything}
                disabled={isAnyLoading}
                className={METABOT_ICON_BTN_CLASS}
                title={i18nService.t('metabotRefreshBalances')}
                aria-label={i18nService.t('metabotRefreshBalances')}
              >
                <ArrowPathIcon className={`h-4 w-4 ${isAnyLoading ? 'animate-spin' : ''}`} />
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              className={METABOT_ICON_BTN_CLASS}
              aria-label={i18nService.t('close')}
              title={i18nService.t('close')}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        {activeTransfer ? (
          <InlineWalletTransferPanel
            metabot={metabot}
            target={activeTransfer}
            onBack={() => setActiveTransfer(null)}
            onCompleted={() => {
              setActiveTransfer(null);
              refreshEverything();
            }}
            onCopy={copyText}
            copiedValue={copiedValue}
          />
        ) : (
          <>
            {/* Single-Axis Underline Tabs */}
            <div
              className="flex items-center gap-1 border-b border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-5 pt-1 shrink-0"
              role="tablist"
              data-slot="metabot-wallet-tabs"
            >
              {(
                [
                  { key: 'native' as const, label: i18nService.t('metabotWalletTabNative'), count: nativeCount },
                  { key: 'mrc20' as const, label: i18nService.t('metabotWalletTabMrc20'), count: walletAssets ? mrc20List.length : null },
                  { key: 'mvc-ft' as const, label: i18nService.t('metabotWalletTabMvcFt'), count: walletAssets ? mvcFtList.length : null },
                ]
              ).map((tab) => {
                const selected = activeTab === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    role="tab"
                    data-slot={`metabot-wallet-tab-${tab.key}`}
                    aria-selected={selected}
                    onClick={() => setActiveTab(tab.key)}
                    className={`relative inline-flex items-center gap-1.5 px-3 py-2.5 text-[12.5px] font-semibold transition-colors ${
                      selected
                        ? 'text-[#181d25] dark:text-[#f3f5f8]'
                        : 'text-[#5a6577] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:text-[#f3f5f8]'
                    }`}
                  >
                    <span>{tab.label}</span>
                    {tab.count != null && (
                      <span
                        className={`rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-bold tabular-nums leading-none ${
                          selected
                            ? 'bg-[#FFDC51]/45 text-[#24210c] dark:bg-[#FFDC51]/20 dark:text-[#FFDC51]'
                            : 'bg-[#eef1f5] text-[#5a6577] dark:bg-white/[0.06] dark:text-[#94a3b8]'
                        }`}
                      >
                        {tab.count}
                      </span>
                    )}
                    {selected && (
                      <span className="absolute inset-x-2 bottom-0 h-[2px] rounded-full bg-[#181d25] dark:bg-[#FFDC51]" />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Tab Content */}
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              {activeTab === 'native' && (
                <div className="space-y-3" data-slot="metabot-wallet-panel-native">
                  {nativeCount === 0 ? (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-8 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
                      {i18nService.t('metabotWalletAssetsEmpty')}
                    </div>
                  ) : (
                    <div className={METABOT_GROUP_BOX_CLASS}>
                      {CHAIN_META.map((meta) => {
                        const addr = addressByChain[meta.chain];
                        if (!addr) return null;
                        const balText = balanceByChain[meta.chain];
                        const maxNumeric = parseNumericBalance(balText);
                        const degradedNote = meta.chain === 'mvc' ? balance.mvcNote : undefined;
                        const isCopied = copiedValue === addr;

                        return (
                          <div key={meta.chain} className="px-4 py-3.5" data-slot={`metabot-wallet-chain-${meta.chain}`}>
                            <div className="flex items-center justify-between gap-3">
                              <div className="flex min-w-0 items-center gap-3">
                                <ChainIcon chain={meta.chain} size={34} />
                                <div className="min-w-0">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    <span className="text-[13.5px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                                      {meta.symbol}
                                    </span>
                                    <span className={METABOT_MICRO_BADGE_CLASS}>{meta.networkBadge}</span>
                                  </div>
                                  <div className="mt-1 flex items-center gap-1.5">
                                    <code
                                      className="truncate font-mono text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]"
                                      title={addr}
                                    >
                                      {formatShortAddress(addr, 8, 8)}
                                    </code>
                                    <button
                                      type="button"
                                      onClick={() => copyText(addr)}
                                      className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#5a6577] hover:bg-[#eef1f5] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:bg-white/[0.08] dark:hover:text-[#f3f5f8]"
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
                                </div>
                              </div>

                              <div className="flex shrink-0 items-center gap-3">
                                <div className="text-right">
                                  <div className="text-[13.5px] font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                                    {balance.loading
                                      ? i18nService.t('metabotBalanceLoading')
                                      : balText ?? i18nService.t('metabotBalanceUnavailable')}
                                  </div>
                                  <div className="text-[11px] text-[#8c96a6] dark:text-[#64748b]">
                                    {meta.title}
                                  </div>
                                </div>
                                <button
                                  type="button"
                                  data-slot={`metabot-wallet-transfer-${meta.chain}`}
                                  onClick={() =>
                                    setActiveTransfer({
                                      mode: 'native',
                                      chain: meta.chain,
                                      symbol: meta.symbol,
                                      fromAddress: addr,
                                      maxBalance: maxNumeric,
                                    })
                                  }
                                  className={METABOT_BTN_FLAT_CLASS}
                                >
                                  <PaperAirplaneIcon className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                                  <span>{i18nService.t('metabotTransfer')}</span>
                                </button>
                              </div>
                            </div>

                            {degradedNote && (
                              <div
                                data-slot="metabot-wallet-mvc-degraded"
                                className="mt-2.5 flex items-start gap-2 rounded-[7px] border border-amber-500/30 bg-amber-500/[0.08] px-2.5 py-1.5 text-[11.5px] leading-snug text-amber-700 dark:text-amber-300"
                              >
                                <ExclamationTriangleIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                                <span>{degradedNote}</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'mrc20' && (
                <div className="space-y-3" data-slot="metabot-wallet-panel-mrc20">
                  {btcAddr && (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center justify-between gap-2 px-3.5 py-2`}>
                      <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                        <ChainIcon chain="btc" size={16} />
                        <span className="shrink-0 font-semibold">{i18nService.t('metabotWalletReceiveAddress')}:</span>
                        <code className="truncate font-mono text-[#181d25] dark:text-[#f3f5f8]" title={btcAddr}>
                          {formatShortAddress(btcAddr, 10, 8)}
                        </code>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText(btcAddr)}
                        className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold text-[#5a6577] hover:bg-[#eef1f5] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:bg-white/[0.08] dark:hover:text-[#f3f5f8]"
                      >
                        {copiedValue === btcAddr ? (
                          <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  )}

                  {walletAssetsLoading && !walletAssets ? (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-8 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
                      {i18nService.t('loading')}
                    </div>
                  ) : walletAssetsError && !walletAssets ? (
                    <div className="rounded-[10px] border border-rose-500/35 bg-rose-500/[0.08] px-4 py-4 text-center space-y-2.5">
                      <p className="text-[12.5px] text-red-600 dark:text-rose-400">{walletAssetsError}</p>
                      <button type="button" onClick={() => void refreshWalletAssets()} className={METABOT_BTN_FLAT_CLASS}>
                        {i18nService.t('metabotNftRetry')}
                      </button>
                    </div>
                  ) : mrc20List.length === 0 ? (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-8 text-center space-y-1`}>
                      <div className="text-[13px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                        {i18nService.t('metabotWalletAssetsEmpty')}
                      </div>
                      <p className="text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                        {i18nService.t('metabotWalletEmptyMrc20Hint')}
                      </p>
                    </div>
                  ) : (
                    <div className={METABOT_GROUP_BOX_CLASS}>
                      {mrc20List.map((asset) => {
                        const hasPendingIn = isNonZeroBalancePart(asset.balance.pendingIn);
                        const hasPendingOut = isNonZeroBalancePart(asset.balance.pendingOut);
                        return (
                          <div
                            key={`${asset.mrc20Id}-${asset.address}`}
                            className="px-4 py-3.5 flex items-center justify-between gap-3"
                            data-slot="metabot-wallet-mrc20-row"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <TokenAvatar symbol={asset.symbol} icon={asset.icon} chain="btc" size={34} />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate text-[13.5px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                                    {asset.symbol}
                                  </span>
                                  {asset.tokenName && asset.tokenName !== asset.symbol && (
                                    <span className="truncate text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                                      {asset.tokenName}
                                    </span>
                                  )}
                                  <span className={METABOT_MICRO_BADGE_CLASS}>MRC-20</span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <code
                                    className="font-mono text-[11px] text-[#5a6577] dark:text-[#94a3b8]"
                                    title={asset.mrc20Id}
                                  >
                                    {formatShortAddress(asset.mrc20Id, 8, 6)}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() => copyText(asset.mrc20Id, 'tokenTransferTxIdCopied')}
                                    className="inline-flex h-4 w-4 items-center justify-center rounded text-[#5a6577] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:text-[#f3f5f8]"
                                    aria-label={i18nService.t('metabotCopyAddress')}
                                  >
                                    <DocumentDuplicateIcon className="h-3 w-3" />
                                  </button>
                                  {hasPendingIn && (
                                    <span className="rounded-[4px] bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                                      +{asset.balance.pendingIn} {i18nService.t('metabotWalletPendingIn')}
                                    </span>
                                  )}
                                  {hasPendingOut && (
                                    <span className="rounded-[4px] bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                                      -{asset.balance.pendingOut} {i18nService.t('metabotWalletPendingOut')}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-3">
                              <div className="text-right">
                                <div className="text-[13.5px] font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                                  {asset.balance.display}
                                </div>
                                <div className="text-[11px] text-[#8c96a6] dark:text-[#64748b]">
                                  {asset.symbol}
                                </div>
                              </div>
                              <button
                                type="button"
                                data-slot="metabot-wallet-transfer-token"
                                onClick={() => setActiveTransfer({ mode: 'token', asset })}
                                className={METABOT_BTN_FLAT_CLASS}
                              >
                                <PaperAirplaneIcon className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                                <span>{i18nService.t('metabotTransfer')}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}

              {activeTab === 'mvc-ft' && (
                <div className="space-y-3" data-slot="metabot-wallet-panel-mvc-ft">
                  {mvcAddr && (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center justify-between gap-2 px-3.5 py-2`}>
                      <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                        <ChainIcon chain="mvc" size={16} />
                        <span className="shrink-0 font-semibold">{i18nService.t('metabotWalletReceiveAddress')}:</span>
                        <code className="truncate font-mono text-[#181d25] dark:text-[#f3f5f8]" title={mvcAddr}>
                          {formatShortAddress(mvcAddr, 10, 8)}
                        </code>
                      </div>
                      <button
                        type="button"
                        onClick={() => copyText(mvcAddr)}
                        className="inline-flex items-center gap-1 rounded-[5px] px-1.5 py-0.5 text-[11px] font-semibold text-[#5a6577] hover:bg-[#eef1f5] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:bg-white/[0.08] dark:hover:text-[#f3f5f8]"
                      >
                        {copiedValue === mvcAddr ? (
                          <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                        ) : (
                          <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                        )}
                      </button>
                    </div>
                  )}

                  {walletAssetsLoading && !walletAssets ? (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-8 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
                      {i18nService.t('loading')}
                    </div>
                  ) : walletAssetsError && !walletAssets ? (
                    <div className="rounded-[10px] border border-rose-500/35 bg-rose-500/[0.08] px-4 py-4 text-center space-y-2.5">
                      <p className="text-[12.5px] text-red-600 dark:text-rose-400">{walletAssetsError}</p>
                      <button type="button" onClick={() => void refreshWalletAssets()} className={METABOT_BTN_FLAT_CLASS}>
                        {i18nService.t('metabotNftRetry')}
                      </button>
                    </div>
                  ) : mvcFtList.length === 0 ? (
                    <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-8 text-center space-y-1`}>
                      <div className="text-[13px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                        {i18nService.t('metabotWalletAssetsEmpty')}
                      </div>
                      <p className="text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                        {i18nService.t('metabotWalletEmptyMvcFtHint')}
                      </p>
                    </div>
                  ) : (
                    <div className={METABOT_GROUP_BOX_CLASS}>
                      {mvcFtList.map((asset) => {
                        const hasUnconfirmed = isNonZeroBalancePart(asset.balance.unconfirmed);
                        return (
                          <div
                            key={`${asset.genesis}-${asset.address}`}
                            className="px-4 py-3.5 flex items-center justify-between gap-3"
                            data-slot="metabot-wallet-mvc-ft-row"
                          >
                            <div className="flex min-w-0 items-center gap-3">
                              <TokenAvatar symbol={asset.symbol} icon={asset.icon} chain="mvc" size={34} />
                              <div className="min-w-0">
                                <div className="flex flex-wrap items-center gap-1.5">
                                  <span className="truncate text-[13.5px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                                    {asset.symbol}
                                  </span>
                                  {asset.tokenName && asset.tokenName !== asset.symbol && (
                                    <span className="truncate text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                                      {asset.tokenName}
                                    </span>
                                  )}
                                  <span className={METABOT_MICRO_BADGE_CLASS}>MCP02</span>
                                </div>
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  <code
                                    className="font-mono text-[11px] text-[#5a6577] dark:text-[#94a3b8]"
                                    title={asset.genesis}
                                  >
                                    {formatShortAddress(asset.genesis, 8, 6)}
                                  </code>
                                  <button
                                    type="button"
                                    onClick={() => copyText(asset.genesis, 'tokenTransferTxIdCopied')}
                                    className="inline-flex h-4 w-4 items-center justify-center rounded text-[#5a6577] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:text-[#f3f5f8]"
                                    aria-label={i18nService.t('metabotCopyAddress')}
                                  >
                                    <DocumentDuplicateIcon className="h-3 w-3" />
                                  </button>
                                  {hasUnconfirmed && (
                                    <span className="rounded-[4px] bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-400">
                                      {asset.balance.unconfirmed} {i18nService.t('metabotWalletUnconfirmed')}
                                    </span>
                                  )}
                                </div>
                              </div>
                            </div>

                            <div className="flex shrink-0 items-center gap-3">
                              <div className="text-right">
                                <div className="text-[13.5px] font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                                  {asset.balance.display}
                                </div>
                                <div className="text-[11px] text-[#8c96a6] dark:text-[#64748b]">
                                  {asset.symbol}
                                </div>
                              </div>
                              <button
                                type="button"
                                data-slot="metabot-wallet-transfer-token"
                                onClick={() => setActiveTransfer({ mode: 'token', asset })}
                                className={METABOT_BTN_FLAT_CLASS}
                              >
                                <PaperAirplaneIcon className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                                <span>{i18nService.t('metabotTransfer')}</span>
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className={METABOT_MODAL_FOOTER_CLASS}>
              <span className="text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {i18nService.t('metabotWalletHint')}
              </span>
              <button type="button" onClick={onClose} className={METABOT_BTN_FLAT_CLASS}>
                {i18nService.t('close')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};

const InlineWalletTransferPanel: React.FC<{
  metabot: Metabot;
  target: ActiveTransferTarget;
  onBack: () => void;
  onCompleted: () => void;
  onCopy: (val: string, toastKey?: string) => void;
  copiedValue: string;
}> = ({ metabot, target, onBack, onCompleted, onCopy, copiedValue }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [receiver, setReceiver] = useState('');
  const [amount, setAmount] = useState('');
  const [feeOptions, setFeeOptions] = useState<FeeOption[]>([]);
  const [selectedFeeRate, setSelectedFeeRate] = useState(0);
  const [feeLoading, setFeeLoading] = useState(true);
  const [validationError, setValidationError] = useState('');
  const [previewLoading, setPreviewLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [nativePreview, setNativePreview] = useState<NativeTransferPreview | null>(null);
  const [tokenPreview, setTokenPreview] = useState<TokenTransferPreview | null>(null);
  const [receipt, setReceipt] = useState<{ txId: string; commitTxId?: string; revealTxId?: string } | null>(null);

  const isNative = target.mode === 'native';
  const symbol = isNative ? target.symbol : target.asset.symbol;
  const maxBalance = isNative ? target.maxBalance : target.asset.balance.display;
  const fromAddress = isNative ? target.fromAddress : target.asset.address;
  const chainKey: NativeChainKey = isNative ? target.chain : target.asset.chain;

  useEffect(() => {
    let cancelled = false;
    setFeeLoading(true);
    setValidationError('');
    const loadPromise = isNative
      ? window.electron.idbots.getTransferFeeSummary(target.chain)
      : window.electron.idbots.getTokenTransferFeeSummary({ kind: target.asset.kind });

    loadPromise
      .then((res) => {
        if (cancelled) return;
        if (res.success && res.list?.length) {
          setFeeOptions(res.list);
          if (res.defaultFeeRate != null) {
            setSelectedFeeRate(res.defaultFeeRate);
          } else {
            const avg = res.list.find((opt) => opt.title === 'Avg');
            setSelectedFeeRate(avg ? avg.feeRate : res.list[0].feeRate);
          }
        } else if (!res.success && res.error) {
          setValidationError(res.error);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setValidationError(err instanceof Error ? err.message : i18nService.t('transferFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) setFeeLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [isNative, target]);

  const formatFeeRateText = useCallback(
    (rate: number) => {
      if (isNative && target.chain === 'doge') {
        return `${(rate / 1e6).toFixed(2)} sat/kB`;
      }
      return `${rate} sat/vB`;
    },
    [isNative, target],
  );

  const handleNext = async () => {
    setValidationError('');
    const to = receiver.trim();

    if (isNative) {
      if (!to) {
        setValidationError(i18nService.t('transferReceiverRequired'));
        return;
      }
      const amountNum = parseFloat(amount);
      const maxNum = parseFloat(maxBalance) || 0;
      if (!Number.isFinite(amountNum) || amountNum <= 0) {
        setValidationError(i18nService.t('transferAmountInvalid'));
        return;
      }
      if (amountNum > maxNum) {
        setValidationError(i18nService.t('transferAmountExceedsBalance'));
        return;
      }
      if (target.chain === 'doge' && amountNum < 0.01) {
        setValidationError('Minimum 0.01 DOGE');
        return;
      }

      setPreviewLoading(true);
      try {
        const res = await window.electron.idbots.buildTransferPreview({
          metabotId: metabot.id,
          chain: target.chain,
          toAddress: to,
          amountSpaceOrDoge: amount.trim(),
          feeRate: selectedFeeRate,
        });
        if (!res.success || !res.preview) {
          setValidationError(res.error || i18nService.t('transferFailed'));
          return;
        }
        setNativePreview(res.preview);
        setStep(2);
      } catch (err) {
        setValidationError(err instanceof Error ? err.message : i18nService.t('transferFailed'));
      } finally {
        setPreviewLoading(false);
      }
      return;
    }

    const validation = validateTokenTransferDraft({
      amount,
      receiver: to,
      maxDisplayBalance: maxBalance,
    });
    if (!validation.valid) {
      setValidationError(i18nService.t(validation.errorKey));
      return;
    }

    setPreviewLoading(true);
    try {
      const res = await window.electron.idbots.buildTokenTransferPreview(
        buildTokenTransferPreviewPayload({
          metabotId: metabot.id,
          kind: target.asset.kind,
          asset: target.asset,
          receiver: to,
          amount,
          feeRate: selectedFeeRate,
        }),
      );
      if (!res.success || !res.preview) {
        setValidationError(res.error || i18nService.t('transferFailed'));
        return;
      }
      setTokenPreview(res.preview);
      setStep(2);
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : i18nService.t('transferFailed'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleConfirmBroadcast = async () => {
    setValidationError('');
    setSending(true);
    try {
      if (isNative) {
        if (!nativePreview) return;
        const res = await window.electron.idbots.executeTransfer({
          metabotId: metabot.id,
          chain: target.chain,
          toAddress: nativePreview.toAddress,
          amountSpaceOrDoge: amount.trim(),
          feeRate: selectedFeeRate,
        });
        if (!res.success) {
          setValidationError(res.error || i18nService.t('transferFailed'));
          return;
        }
        setReceipt({ txId: res.txId || '' });
        setStep(3);
      } else {
        const res = await window.electron.idbots.executeTokenTransfer(
          buildTokenTransferExecutePayload({
            metabotId: metabot.id,
            kind: target.asset.kind,
            asset: target.asset,
            receiver: receiver.trim(),
            amount: amount.trim(),
            feeRate: selectedFeeRate,
          }),
        );
        if (!res.success || !res.result) {
          setValidationError(res.error || i18nService.t('transferFailed'));
          return;
        }
        setReceipt({
          txId: res.result.revealTxId || res.result.txId || '',
          commitTxId: res.result.commitTxId,
          revealTxId: res.result.revealTxId,
        });
        setStep(3);
      }
    } catch (err) {
      setValidationError(err instanceof Error ? err.message : i18nService.t('transferFailed'));
    } finally {
      setSending(false);
    }
  };

  const stepsMeta = useMemo(
    () => [
      { id: 1, label: i18nService.t('metabotWalletStepInput') },
      { id: 2, label: i18nService.t('metabotWalletStepPreview') },
      { id: 3, label: i18nService.t('metabotWalletStepReceipt') },
    ],
    [],
  );

  return (
    <>
      {/* 3-Step Indicator Bar */}
      <div className="flex items-center gap-2 border-b border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-5 py-2.5 shrink-0">
        {stepsMeta.map((s, idx) => {
          const active = step === s.id;
          const done = step > s.id;
          return (
            <React.Fragment key={s.id}>
              {idx > 0 && <span className="h-[1px] flex-1 bg-slate-900/[0.08] dark:bg-white/[0.08]" />}
              <div className="inline-flex items-center gap-1.5">
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold tabular-nums ${
                    active
                      ? 'bg-[#FFDC51] text-[#24210c] border border-black/[0.12]'
                      : done
                        ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                        : 'bg-[#eef1f5] text-[#5a6577] dark:bg-white/[0.07] dark:text-[#94a3b8]'
                  }`}
                >
                  {done ? '✓' : s.id}
                </span>
                <span
                  className={`text-[12px] font-semibold ${
                    active
                      ? 'text-[#181d25] dark:text-[#f3f5f8]'
                      : 'text-[#5a6577] dark:text-[#94a3b8]'
                  }`}
                >
                  {s.label}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 space-y-4">
        {step === 1 && (
          <>
            {/* Asset Summary Strip */}
            <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center justify-between gap-3 px-3.5 py-2.5`}>
              <div className="flex min-w-0 items-center gap-2.5">
                {isNative ? (
                  <ChainIcon chain={chainKey} size={30} />
                ) : (
                  <TokenAvatar
                    symbol={target.asset.symbol}
                    icon={target.asset.icon}
                    chain={target.asset.chain}
                    size={30}
                  />
                )}
                <div className="min-w-0">
                  <div className="text-[13px] font-bold text-[#181d25] dark:text-[#f3f5f8]">{symbol}</div>
                  <code className="block truncate font-mono text-[11px] text-[#5a6577] dark:text-[#94a3b8]">
                    {formatShortAddress(fromAddress, 8, 8)}
                  </code>
                </div>
              </div>
              <div className="text-right shrink-0">
                <div className="text-[11px] text-[#5a6577] dark:text-[#94a3b8]">
                  {i18nService.t('transferAmountMax')}
                </div>
                <div className="text-[13px] font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                  {maxBalance} {symbol}
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('transferReceiver')}
              </label>
              <input
                type="text"
                data-slot="metabot-wallet-transfer-receiver"
                value={receiver}
                onChange={(event) => setReceiver(event.target.value)}
                placeholder={i18nService.t('transferReceiverPlaceholder')}
                className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2`}
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('transferAmount')}
                </label>
                <button
                  type="button"
                  data-slot="metabot-wallet-transfer-max"
                  onClick={() => setAmount(maxBalance)}
                  className="rounded-[5px] border border-slate-900/[0.1] dark:border-white/[0.1] bg-[#eef1f5] dark:bg-white/[0.06] px-2 py-0.5 text-[11px] font-bold text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#e2e8f0] dark:hover:bg-white/[0.12] transition-colors"
                >
                  {i18nService.t('metabotWalletMaxAction')} · {maxBalance}
                </button>
              </div>
              <div className="relative">
                <input
                  type="text"
                  inputMode="decimal"
                  data-slot="metabot-wallet-transfer-amount"
                  value={amount}
                  onChange={(event) => setAmount(event.target.value)}
                  placeholder="0.00000000"
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono tabular-nums py-2 pr-16`}
                />
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-[11.5px] font-bold text-[#5a6577] dark:text-[#94a3b8]">
                  {symbol}
                </span>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('transferFeeRate')}
              </label>
              {feeLoading ? (
                <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-3 py-2.5 text-[12px] text-[#5a6577] dark:text-[#94a3b8]`}>
                  {i18nService.t('loading')}
                </div>
              ) : feeOptions.length > 0 ? (
                <div className="grid grid-cols-3 gap-2" data-slot="metabot-wallet-fee-pills">
                  {feeOptions.map((opt) => {
                    const selected = selectedFeeRate === opt.feeRate;
                    return (
                      <button
                        key={`${opt.title}-${opt.feeRate}`}
                        type="button"
                        onClick={() => setSelectedFeeRate(opt.feeRate)}
                        className={`rounded-[8px] border px-2.5 py-2 text-left transition-colors ${
                          selected
                            ? 'border-[#d4af1f] bg-[#FFDC51]/20 dark:border-[#FFDC51]/65 dark:bg-[#FFDC51]/12'
                            : 'border-slate-900/[0.095] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#131d2c] hover:bg-[#eef1f5] dark:hover:bg-white/[0.05]'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                            {opt.title}
                          </span>
                          {selected && (
                            <CheckIcon className="h-3.5 w-3.5 text-[#8a6d00] dark:text-[#FFDC51]" />
                          )}
                        </div>
                        <div className="mt-0.5 font-mono text-[11.5px] font-semibold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                          {formatFeeRateText(opt.feeRate)}
                        </div>
                        {opt.desc && (
                          <div className="truncate text-[10.5px] text-[#5a6577] dark:text-[#94a3b8]">
                            {opt.desc}
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-3 py-2 font-mono text-[12px] text-[#181d25] dark:text-[#f3f5f8]`}>
                  {formatFeeRateText(selectedFeeRate)}
                </div>
              )}
            </div>

            {validationError && (
              <div className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400">
                {validationError}
              </div>
            )}
          </>
        )}

        {step === 2 && (nativePreview || tokenPreview) && (
          <>
            <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-4 text-center`}>
              <div className="mx-auto mb-2 inline-flex items-center justify-center">
                {isNative ? (
                  <ChainIcon chain={chainKey} size={38} />
                ) : (
                  <TokenAvatar
                    symbol={target.asset.symbol}
                    icon={target.asset.icon}
                    chain={target.asset.chain}
                    size={38}
                  />
                )}
              </div>
              <div className="text-[20px] font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                {(nativePreview ?? tokenPreview)?.amount} {(nativePreview ?? tokenPreview)?.amountUnit}
              </div>
            </div>

            <div className={`${METABOT_GROUP_BOX_CLASS} text-[12.5px]`}>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-[#5a6577] dark:text-[#94a3b8] shrink-0">{i18nService.t('transferFrom')}</span>
                <code className="truncate font-mono text-[12px] text-[#181d25] dark:text-[#f3f5f8]" title={(nativePreview ?? tokenPreview)?.fromAddress}>
                  {formatShortAddress((nativePreview ?? tokenPreview)?.fromAddress ?? '', 10, 10)}
                </code>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-[#5a6577] dark:text-[#94a3b8] shrink-0">{i18nService.t('transferTo')}</span>
                <code className="truncate font-mono text-[12px] text-[#181d25] dark:text-[#f3f5f8]" title={(nativePreview ?? tokenPreview)?.toAddress}>
                  {formatShortAddress((nativePreview ?? tokenPreview)?.toAddress ?? '', 10, 10)}
                </code>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                <span className="text-[#5a6577] dark:text-[#94a3b8] shrink-0">{i18nService.t('transferFeeEstimated')}</span>
                <span className="font-mono tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                  {(nativePreview ?? tokenPreview)?.feeEstimated} {(nativePreview ?? tokenPreview)?.feeEstimatedUnit}
                </span>
              </div>
              {nativePreview && (
                <div className="flex items-center justify-between gap-3 px-4 py-2.5 font-bold">
                  <span className="text-[#181d25] dark:text-[#f3f5f8]">{i18nService.t('transferTotal')}</span>
                  <span className="font-mono tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                    {nativePreview.total} {nativePreview.totalUnit}
                  </span>
                </div>
              )}
            </div>

            {validationError && (
              <div className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400">
                {validationError}
              </div>
            )}
          </>
        )}

        {step === 3 && receipt && (
          <div className="space-y-4 py-2" data-slot="metabot-wallet-transfer-receipt">
            <div className="text-center">
              <div className="mx-auto mb-2.5 inline-flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <CheckCircleIcon className="h-7 w-7" />
              </div>
              <h4 className="text-[16px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {i18nService.t('transferSuccess')}
              </h4>
            </div>

            <div className={`${METABOT_GROUP_BOX_CLASS} text-[12px]`}>
              <div className="px-4 py-3 space-y-1">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-bold uppercase tracking-wide text-[#5a6577] dark:text-[#94a3b8]">
                    TxID
                  </span>
                  <button
                    type="button"
                    onClick={() => onCopy(receipt.txId, 'tokenTransferTxIdCopied')}
                    className="inline-flex items-center gap-1 text-[11px] font-semibold text-[#5a6577] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:text-[#f3f5f8]"
                  >
                    {copiedValue === receipt.txId ? (
                      <CheckIcon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    ) : (
                      <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                    )}
                    <span>{i18nService.t('metabotCopyAddress')}</span>
                  </button>
                </div>
                <code className="block break-all font-mono text-[11.5px] text-[#181d25] dark:text-[#f3f5f8] select-all">
                  {receipt.txId}
                </code>
              </div>

              {receipt.commitTxId && (
                <div className="px-4 py-2.5 space-y-1">
                  <span className="text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('tokenTransferCommitTxId')}
                  </span>
                  <code className="block break-all font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                    {receipt.commitTxId}
                  </code>
                </div>
              )}

              {receipt.revealTxId && (
                <div className="px-4 py-2.5 space-y-1">
                  <span className="text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('tokenTransferRevealTxId')}
                  </span>
                  <code className="block break-all font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                    {receipt.revealTxId}
                  </code>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Transfer Footer */}
      <div className={METABOT_MODAL_FOOTER_CLASS}>
        {step === 1 && (
          <>
            <button type="button" onClick={onBack} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('metabotWalletBackToAssets')}
            </button>
            <button
              type="button"
              data-slot="metabot-wallet-transfer-next"
              onClick={() => void handleNext()}
              disabled={previewLoading || feeLoading}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {previewLoading ? i18nService.t('loading') : i18nService.t('transferNext')}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <button
              type="button"
              onClick={() => setStep(1)}
              disabled={sending}
              className={METABOT_BTN_FLAT_CLASS}
            >
              {i18nService.t('transferCancel')}
            </button>
            <button
              type="button"
              data-slot="metabot-wallet-transfer-confirm"
              onClick={() => void handleConfirmBroadcast()}
              disabled={sending}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {sending ? i18nService.t('loading') : i18nService.t('metabotWalletBroadcastConfirm')}
            </button>
          </>
        )}

        {step === 3 && (
          <div className="flex w-full justify-end">
            <button
              type="button"
              onClick={onCompleted}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {i18nService.t('close')}
            </button>
          </div>
        )}
      </div>
    </>
  );
};

export default MetaBotWalletBalanceModal;
