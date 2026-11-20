/**
 * MetaBot Wallet Balance Modal
 *
 * Per-chain address balances (BTC / MVC / DOGE) with copy, transfer and a
 * "view more tokens" entry into the full wallet-assets modal. This is the
 * "balance panel for each address" surfaced by the Wallet action in the
 * Advanced tab. The logic was extracted verbatim from MetaBotListCard so the
 * wallet surface can live deeper in the UI without changing behaviour.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import MetaBotTransferModal from './MetaBotTransferModal';
import MetaBotWalletAssetsModal, {
  type MetaBotWalletAssetsBundle,
  type WalletDisplayAsset,
} from './MetaBotWalletAssetsModal';
import MetaBotTokenTransferModal, { type TokenTransferAsset } from './MetaBotTokenTransferModal';

interface MetaBotWalletBalanceModalProps {
  isOpen: boolean;
  metabot: Metabot;
  onClose: () => void;
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
    // A degraded MVC read is flagged, never stated as fact (2026-11-21
    // balance-truth line: indexer outages used to render as a fake 0).
    mvcNote: balance.mvc?.degraded
      ? `${i18nService.t('metabotBalanceDegraded')} ${balance.mvc.degraded}`
      : undefined,
  };
}

const MetaBotWalletBalanceModal: React.FC<MetaBotWalletBalanceModalProps> = ({
  isOpen,
  metabot,
  onClose,
}) => {
  const [balance, setBalance] = useState<BalanceState>({ loading: true });
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

  // Load balances every time the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    void refreshAllBalances();
  }, [isOpen, refreshAllBalances]);

  // Load wallet assets only when the assets modal is opened.
  useEffect(() => {
    if (!showWalletAssetsModal) return;
    void refreshWalletAssets();
  }, [showWalletAssetsModal, refreshWalletAssets]);

  if (!isOpen) return null;

  const copyAddress = (addr: string) => {
    if (!addr) return;
    navigator.clipboard.writeText(addr).then(() => {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
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

  const handleWalletAssetTransfer = (asset: WalletDisplayAsset) => {
    if (asset.kind === 'native') {
      setTransferModal({ chain: asset.chain });
      return;
    }
    // NFT cards render no transfer button (transfers go through the agent
    // tool); this branch only satisfies the widened WalletDisplayAsset type.
    if (asset.kind === 'mvc-nft') return;
    setTokenTransferAsset(asset);
  };

  const renderChainRow = (
    label: string,
    addr: string,
    balanceValue: string | undefined,
    chain: 'btc' | 'mvc' | 'doge',
    note?: string,
  ) => {
    if (!addr) return null;
    return (
      <div className="space-y-1">
      <div className="flex items-center gap-1.5 text-xs overflow-hidden rounded-lg border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2">
        <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary w-12 shrink-0">{label}</span>
        <code className="truncate flex-1 min-w-0 dark:text-claude-darkText text-claude-text">
          {formatShort(addr)}
        </code>
        <span className="shrink-0 dark:text-claude-darkText text-claude-text text-[11px] tabular-nums truncate max-w-[110px]">
          {balance.loading
            ? i18nService.t('metabotBalanceLoading')
            : balanceValue ?? i18nService.t('metabotBalanceUnavailable')}
        </span>
        <button
          type="button"
          onClick={() => copyAddress(addr)}
          className="shrink-0 p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          title={i18nService.t('metabotCopyAddress')}
        >
          <DocumentDuplicateIcon className="h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
        </button>
        <button
          type="button"
          onClick={() => setTransferModal({ chain })}
          className="shrink-0 px-1.5 py-0.5 rounded text-xs bg-claude-accent/20 dark:bg-claude-accent/30 text-claude-accent hover:bg-claude-accent/30 dark:hover:bg-claude-accent/40"
          title={i18nService.t('metabotTransfer')}
        >
          {i18nService.t('metabotTransfer')}
        </button>
      </div>
      {note && (
        <p className="px-3 text-[11px] leading-snug text-amber-600 dark:text-amber-400">{note}</p>
      )}
      </div>
    );
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
        <div
          className="relative w-full max-w-lg rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-start justify-between gap-4 border-b dark:border-claude-darkBorder border-claude-border px-6 py-5">
            <div>
              <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('metabotWallet')}
              </h3>
              <p className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {metabot.name}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshAllBalances()}
                disabled={balance.loading}
                className="inline-flex items-center gap-2 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
                title={i18nService.t('metabotRefreshBalances')}
                aria-label={i18nService.t('metabotRefreshBalances')}
              >
                <ArrowPathIcon className={`h-4 w-4 ${balance.loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-[8px] border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('close')}
              </button>
            </div>
          </div>

          <div className="px-6 py-5 space-y-2">
            {renderChainRow('BTC', btcAddr, balance.btc, 'btc')}
            {renderChainRow('MVC', mvcAddr, balance.mvc, 'mvc', balance.mvcNote)}
            {renderChainRow('DOGE', dogeAddr, balance.doge, 'doge')}
            {!btcAddr && !mvcAddr && !dogeAddr && (
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('metabotWalletAssetsEmpty')}
              </p>
            )}

            <div className="pt-2">
              <button
                type="button"
                onClick={() => setShowWalletAssetsModal(true)}
                className="text-xs text-claude-accent hover:underline"
              >
                {i18nService.t('metabotViewMoreTokenBalances')}
              </button>
            </div>
          </div>
        </div>
      </div>

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

export default MetaBotWalletBalanceModal;
