/**
 * MetaBot List Card
 * Displays MetaBot with async balance loading, copy address, role and goal.
 * Addresses are collapsed by default; delete button triggers safe-delete flow.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, CpuChipIcon, DocumentDuplicateIcon, TrashIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import MetaBotBackupMnemonicModal from './MetaBotBackupMnemonicModal';
import MetaBotTransferModal from './MetaBotTransferModal';
import MetaBotWalletAssetsModal, {
  type MetaBotWalletAssetsBundle,
  type WalletDisplayAsset,
} from './MetaBotWalletAssetsModal';
import MetaBotTokenTransferModal, { type TokenTransferAsset } from './MetaBotTokenTransferModal';
import {
  buildMetaBotToggleViewModel,
  copyGlobalMetaIdToClipboard,
  formatGlobalMetaIdShort,
} from './metaBotCardPresentation.js';

interface MetaBotListCardProps {
  metabot: Metabot;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onDelete: () => void;
  isChainSynced: boolean;
  onSyncToChain: () => void;
}

interface BalanceState {
  btc?: string;
  mvc?: string;
  doge?: string;
  loading: boolean;
}

function balanceStateFromApi(balance: {
  btc?: { value: number; unit: string };
  mvc?: { value: number; unit: string };
  doge?: { value: number; unit: string };
}): Omit<BalanceState, 'loading'> {
  return {
    btc: balance.btc != null ? `${balance.btc.value.toFixed(8)} ${balance.btc.unit}` : undefined,
    mvc: balance.mvc != null ? `${balance.mvc.value.toFixed(8)} ${balance.mvc.unit}` : undefined,
    doge: balance.doge != null ? `${balance.doge.value.toFixed(8)} ${balance.doge.unit}` : undefined,
  };
}

const MetaBotListCard: React.FC<MetaBotListCardProps> = ({
  metabot,
  onEdit,
  onToggleEnabled,
  onDelete,
  isChainSynced,
  onSyncToChain,
}) => {
  const [balance, setBalance] = useState<BalanceState>({ loading: true });
  const [isAddressExpanded, setIsAddressExpanded] = useState(false);
  const [showBackupMnemonicModal, setShowBackupMnemonicModal] = useState(false);
  const [transferModal, setTransferModal] = useState<{ chain: 'mvc' | 'doge' | 'btc' } | null>(null);
  const [showWalletAssetsModal, setShowWalletAssetsModal] = useState(false);
  const [walletAssets, setWalletAssets] = useState<MetaBotWalletAssetsBundle | null>(null);
  const [walletAssetsLoading, setWalletAssetsLoading] = useState(false);
  const [walletAssetsError, setWalletAssetsError] = useState('');
  const [tokenTransferAsset, setTokenTransferAsset] = useState<TokenTransferAsset | null>(null);

  const refreshAllBalances = useCallback(() => {
    setBalance((prev) => ({ ...prev, loading: true }));
    return window.electron.idbots
      .getAddressBalance({ metabotId: metabot.id })
      .then((res) => {
        if (!res.success || !res.balance) {
          setBalance((prev) => ({ ...prev, loading: false }));
          return;
        }
        setBalance({
          loading: false,
          ...balanceStateFromApi(res.balance),
        });
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

  useEffect(() => {
    if (!showWalletAssetsModal) return;
    void refreshWalletAssets();
  }, [showWalletAssetsModal, refreshWalletAssets]);

  useEffect(() => {
    let cancelled = false;
    setBalance((prev) => ({ ...prev, loading: true }));

    window.electron.idbots
      .getAddressBalance({ metabotId: metabot.id })
      .then((res) => {
        if (cancelled || !res.success || !res.balance) return;
        setBalance({
          loading: false,
          ...balanceStateFromApi(res.balance),
        });
      })
      .catch(() => {
        if (!cancelled) {
          setBalance({
            loading: false,
            btc: i18nService.t('metabotBalanceError'),
            mvc: i18nService.t('metabotBalanceError'),
            doge: i18nService.t('metabotBalanceError'),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [metabot.id]);

  const copyAddress = (addr: string) => {
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
    });
  };

  const copyGlobalMetaId = (globalMetaId: string) => {
    copyGlobalMetaIdToClipboard(globalMetaId, navigator.clipboard).then((didCopy: boolean) => {
      if (!didCopy) return;
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotGlobalMetaIdCopied') }));
    });
  };

  const formatShort = (addr: string) => {
    if (!addr || addr.length < 16) return addr;
    return `${addr.slice(0, 6)}...${addr.slice(-6)}`;
  };

  const parseBalanceValue = (balanceStr: string | undefined): string => {
    if (!balanceStr || balanceStr === i18nService.t('metabotBalanceLoading') || balanceStr === i18nService.t('metabotBalanceError')) return '0';
    const parts = balanceStr.trim().split(/\s+/);
    return parts[0] ?? '0';
  };

  const btcAddr = metabot.btc_address ?? '';
  const mvcAddr = metabot.mvc_address ?? '';
  const dogeAddr = metabot.doge_address ?? '';
  const globalMetaId = metabot.globalmetaid?.trim() ?? '';
  const shortGlobalMetaId = formatGlobalMetaIdShort(globalMetaId);
  const enabledToggleView = buildMetaBotToggleViewModel({
    enabled: metabot.enabled,
    variant: 'enable',
  });

  const handleWalletAssetTransfer = (asset: WalletDisplayAsset) => {
    if (asset.kind === 'native') {
      setTransferModal({ chain: asset.chain });
      return;
    }
    setTokenTransferAsset(asset);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={onEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onEdit();
          }
        }}
        className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-4 transition-colors hover:border-claude-accent/50 cursor-pointer text-left"
      >
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
            {metabot.avatar && (metabot.avatar.startsWith('data:') || metabot.avatar.startsWith('http')) ? (
              <img
                src={metabot.avatar}
                alt=""
                className="w-12 h-12 rounded-xl object-cover"
              />
            ) : (
              <div className="w-12 h-12 rounded-xl dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center">
                <CpuChipIcon className="h-6 w-6 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </div>
            )}
            {shortGlobalMetaId && (
              <div className="flex items-center gap-1 max-w-[136px] text-[11px] leading-4 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                <span className="truncate">metaid:{shortGlobalMetaId}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyGlobalMetaId(globalMetaId);
                  }}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                  }}
                  className="shrink-0 p-0.5 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyGlobalMetaId')}
                  aria-label={i18nService.t('metabotCopyGlobalMetaId')}
                >
                  <DocumentDuplicateIcon className="h-3 w-3 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <span className="text-base font-medium dark:text-claude-darkText text-claude-text block truncate">
              {metabot.name}
            </span>
            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary truncate block">
              {metabot.role || '—'}
            </span>
          </div>
        </div>
        <div
          className={enabledToggleView.trackClass}
          onClick={(e) => {
            e.stopPropagation();
            onToggleEnabled(!metabot.enabled);
          }}
          role="switch"
          aria-checked={metabot.enabled}
          title={metabot.enabled ? i18nService.t('metabotActive') : i18nService.t('metabotInactive')}
        >
          <div
            className={enabledToggleView.knobClass}
          />
        </div>
      </div>

      {metabot.goal && (
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mb-3 line-clamp-2">
          {metabot.goal}
        </p>
      )}

      {!isChainSynced && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSyncToChain();
          }}
          className="mb-3 inline-flex items-center gap-2 text-xs text-red-500 dark:text-red-400 hover:underline"
          title={i18nService.t('metabotUnsyncedSyncNow')}
        >
          <span className="inline-block h-2 w-2 rounded-full bg-red-500 dark:bg-red-400" aria-hidden />
          <span>{i18nService.t('metabotUnsyncedSyncNow')}</span>
        </button>
      )}

      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setIsAddressExpanded((v) => !v);
          }}
          className="text-xs text-claude-accent hover:underline"
        >
          {isAddressExpanded ? i18nService.t('metabotHideAddresses') : i18nService.t('metabotShowAddresses')}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="text-sm text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 transition-colors"
          title={i18nService.t('metabotDelete')}
        >
          <TrashIcon className="h-4 w-4" />
        </button>
      </div>

        {isAddressExpanded && (
          <div className="space-y-2 mt-2">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void refreshAllBalances();
                }}
                className="shrink-0 p-1 rounded-md hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors disabled:opacity-50"
                title={i18nService.t('metabotRefreshBalances')}
                aria-label={i18nService.t('metabotRefreshBalances')}
                disabled={balance.loading}
              >
                <ArrowPathIcon className={`h-4 w-4 ${balance.loading ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {btcAddr && (
              <div className="flex items-center gap-1.5 text-xs overflow-hidden">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-10 shrink-0">BTC</span>
                <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
                  {formatShort(btcAddr)}
                </code>
                <span className="shrink-0 dark:text-claude-darkText text-claude-text text-[11px] tabular-nums truncate max-w-[100px]">
                  {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.btc ?? '0.00'}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyAddress(btcAddr);
                  }}
                  className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyAddress')}
                >
                  <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTransferModal({ chain: 'btc' });
                  }}
                  className="shrink-0 px-1.5 py-0.5 rounded text-xs bg-claude-accent/20 dark:bg-claude-accent/30 text-claude-accent hover:bg-claude-accent/30 dark:hover:bg-claude-accent/40"
                  title={i18nService.t('metabotTransfer')}
                >
                  {i18nService.t('metabotTransfer')}
                </button>
              </div>
            )}
            {mvcAddr && (
              <div className="flex items-center gap-1.5 text-xs overflow-hidden">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-10 shrink-0">MVC</span>
                <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
                  {formatShort(mvcAddr)}
                </code>
                <span className="shrink-0 dark:text-claude-darkText text-claude-text text-[11px] tabular-nums truncate max-w-[100px]">
                  {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.mvc ?? '0.00'}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyAddress(mvcAddr);
                  }}
                  className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyAddress')}
                >
                  <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTransferModal({ chain: 'mvc' });
                  }}
                  className="shrink-0 px-1.5 py-0.5 rounded text-xs bg-claude-accent/20 dark:bg-claude-accent/30 text-claude-accent hover:bg-claude-accent/30 dark:hover:bg-claude-accent/40"
                  title={i18nService.t('metabotTransfer')}
                >
                  {i18nService.t('metabotTransfer')}
                </button>
              </div>
            )}
            {dogeAddr && (
              <div className="flex items-center gap-1.5 text-xs overflow-hidden">
                <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-10 shrink-0">DOGE</span>
                <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
                  {formatShort(dogeAddr)}
                </code>
                <span className="shrink-0 dark:text-claude-darkText text-claude-text text-[11px] tabular-nums truncate max-w-[100px]">
                  {balance.loading ? i18nService.t('metabotBalanceLoading') : balance.doge ?? '0.00'}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    copyAddress(dogeAddr);
                  }}
                  className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  title={i18nService.t('metabotCopyAddress')}
                >
                  <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setTransferModal({ chain: 'doge' });
                  }}
                  className="shrink-0 px-1.5 py-0.5 rounded text-xs bg-claude-accent/20 dark:bg-claude-accent/30 text-claude-accent hover:bg-claude-accent/30 dark:hover:bg-claude-accent/40"
                  title={i18nService.t('metabotTransfer')}
                >
                  {i18nService.t('metabotTransfer')}
                </button>
              </div>
            )}
            <div className="pt-1 flex items-center gap-3">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowBackupMnemonicModal(true);
                }}
                className="text-xs text-claude-accent hover:underline"
              >
                {i18nService.t('metabotBackupMnemonic')}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowWalletAssetsModal(true);
                }}
                className="text-xs text-claude-accent hover:underline"
              >
                {i18nService.t('metabotViewMoreTokenBalances')}
              </button>
            </div>
          </div>
        )}
      </div>
      {showBackupMnemonicModal && (
        <MetaBotBackupMnemonicModal
          metabot={metabot}
          onClose={() => setShowBackupMnemonicModal(false)}
        />
      )}
      <MetaBotWalletAssetsModal
        isOpen={showWalletAssetsModal}
        metabot={metabot}
        assets={walletAssets}
        loading={walletAssetsLoading}
        error={walletAssetsError}
        onClose={() => setShowWalletAssetsModal(false)}
        onRefresh={() => {
          void refreshWalletAssets();
        }}
        onTransfer={handleWalletAssetTransfer}
      />
      {transferModal && (
        <MetaBotTransferModal
          metabot={metabot}
          chain={transferModal.chain}
          fromAddress={transferModal.chain === 'mvc' ? mvcAddr : transferModal.chain === 'btc' ? btcAddr : dogeAddr}
          maxBalance={parseBalanceValue(transferModal.chain === 'mvc' ? balance.mvc : transferModal.chain === 'btc' ? balance.btc : balance.doge)}
          unit={transferModal.chain === 'mvc' ? 'SPACE' : transferModal.chain === 'btc' ? 'BTC' : 'DOGE'}
          onClose={() => setTransferModal(null)}
          onSuccess={() => {
            setTransferModal(null);
            void refreshAllBalances();
          }}
        />
      )}
      {tokenTransferAsset && (
        <MetaBotTokenTransferModal
          metabot={metabot}
          asset={tokenTransferAsset}
          onClose={() => setTokenTransferAsset(null)}
          onSuccess={() => {
            void refreshAllBalances();
            void refreshWalletAssets();
          }}
        />
      )}
    </>
  );
};

export default MetaBotListCard;
