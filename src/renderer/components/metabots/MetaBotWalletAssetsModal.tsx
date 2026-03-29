import React from 'react';
import { ArrowPathIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import { buildWalletAssetsSectionsViewModel } from './metabotWalletPresentation.js';

export interface NativeWalletAsset {
  kind: 'native';
  chain: 'btc' | 'doge' | 'mvc';
  symbol: 'BTC' | 'DOGE' | 'SPACE';
  address: string;
  balance: {
    confirmed: string;
    display: string;
  };
}

export interface Mrc20WalletAsset {
  kind: 'mrc20';
  chain: 'btc';
  symbol: string;
  tokenName: string;
  mrc20Id: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    pendingIn: string;
    pendingOut: string;
    display: string;
  };
}

export interface MvcFtWalletAsset {
  kind: 'mvc-ft';
  chain: 'mvc';
  symbol: string;
  tokenName: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    display: string;
  };
}

export type WalletDisplayAsset = NativeWalletAsset | Mrc20WalletAsset | MvcFtWalletAsset;

export interface MetaBotWalletAssetsBundle {
  metabotId: number;
  nativeAssets: NativeWalletAsset[];
  mrc20Assets: Mrc20WalletAsset[];
  mvcFtAssets: MvcFtWalletAsset[];
}

interface MetaBotWalletAssetsModalProps {
  isOpen: boolean;
  metabot: Metabot;
  assets: MetaBotWalletAssetsBundle | null;
  loading: boolean;
  error: string;
  onClose: () => void;
  onRefresh: () => void;
  onTransfer: (asset: WalletDisplayAsset) => void;
}

function formatShortAddress(address: string): string {
  if (!address || address.length < 18) return address;
  return `${address.slice(0, 8)}...${address.slice(-8)}`;
}

function copyAddress(address: string): void {
  if (!address) return;
  void navigator.clipboard.writeText(address).then(() => {
    window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('metabotAddressCopied') }));
  });
}

const MetaBotWalletAssetsModal: React.FC<MetaBotWalletAssetsModalProps> = ({
  isOpen,
  metabot,
  assets,
  loading,
  error,
  onClose,
  onRefresh,
  onTransfer,
}) => {
  if (!isOpen) return null;

  const viewModel = buildWalletAssetsSectionsViewModel({ assets, loading, error });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative w-full max-w-3xl rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b dark:border-claude-darkBorder border-claude-border px-6 py-5">
          <div>
            <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('metabotWalletAssetsTitle')}
            </h3>
            <p className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {metabot.name}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onRefresh}
              className="inline-flex items-center gap-2 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              <ArrowPathIcon className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              {i18nService.t('metabotWalletAssetsRefresh')}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
            >
              {i18nService.t('close')}
            </button>
          </div>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-6 py-5 space-y-6">
          {viewModel.sections.map((section) => (
            <section key={section.key} className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold uppercase tracking-wide dark:text-claude-darkText text-claude-text">
                  {section.title}
                </h4>
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {section.items.length}
                </span>
              </div>

              {section.state === 'loading' && (
                <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-4 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('loading')}
                </div>
              )}

              {section.state === 'error' && (
                <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-4 text-sm text-red-500 dark:text-red-400">
                  {error || i18nService.t('metabotWalletAssetsLoadFailed')}
                </div>
              )}

              {section.state === 'empty' && (
                <div className="rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-4 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('metabotWalletAssetsEmpty')}
                </div>
              )}

              {section.state === 'loaded' && section.items.map((asset: WalletDisplayAsset) => (
                <div
                  key={`${asset.kind}-${asset.address}-${asset.kind === 'mrc20' ? asset.mrc20Id : asset.kind === 'mvc-ft' ? asset.genesis : asset.symbol}`}
                  className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-3"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                          {asset.kind === 'native' ? asset.symbol : (asset.tokenName || asset.symbol)}
                        </span>
                        <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                          {asset.symbol}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-1.5 text-xs font-mono dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        <span>{formatShortAddress(asset.address)}</span>
                        <button
                          type="button"
                          onClick={() => copyAddress(asset.address)}
                          className="p-1 rounded hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                          title={i18nService.t('metabotCopyAddress')}
                        >
                          <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-2 shrink-0">
                      <span className="text-sm font-semibold tabular-nums dark:text-claude-darkText text-claude-text">
                        {asset.balance.display}
                      </span>
                      <button
                        type="button"
                        onClick={() => onTransfer(asset)}
                        className="shrink-0 px-2 py-1 rounded text-xs bg-claude-accent/20 dark:bg-claude-accent/30 text-claude-accent hover:bg-claude-accent/30 dark:hover:bg-claude-accent/40"
                      >
                        {i18nService.t('metabotTransfer')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
};

export default MetaBotWalletAssetsModal;
