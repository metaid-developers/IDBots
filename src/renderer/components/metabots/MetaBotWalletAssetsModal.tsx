import React, { useEffect, useState } from 'react';
import { ArrowPathIcon, DocumentDuplicateIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import {
  buildMvcNftItemDetailRows,
  buildMvcNftItemTileViewModel,
  buildWalletAssetsSectionsViewModel,
} from './metabotWalletPresentation.js';
import { NftArtworkImage } from './NftArtworkImage';

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

export interface MvcNftWalletAsset {
  kind: 'mvc-nft';
  chain: 'mvc';
  seriesName: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  address: string;
  count: number;
  tokenSupply?: number;
  items: Array<{
    tokenIndex: string;
    name: string;
    satoshi: number;
    icon?: string;
    /** https direct artwork link (wallet-api v4 utxo-list `imgUrl`). */
    imgUrl?: string;
  }>;
}

export type WalletDisplayAsset = NativeWalletAsset | Mrc20WalletAsset | MvcFtWalletAsset | MvcNftWalletAsset;

export interface MetaBotWalletAssetsBundle {
  metabotId: number;
  nativeAssets: NativeWalletAsset[];
  mrc20Assets: Mrc20WalletAsset[];
  mvcFtAssets: MvcFtWalletAsset[];
  mvcNftAssets: MvcNftWalletAsset[];
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

interface MvcNftItemDetail {
  asset: MvcNftWalletAsset;
  item: MvcNftWalletAsset['items'][number];
}

/**
 * Fullscreen (within the wallet modal) detail layer for one held NFT — same
 * shape as the chat NftCard detail modal: large artwork with the format tag
 * at its corner, field rows with copy affordances on the right. Rendered as
 * an absolute overlay inside the modal's fixed container, so it stacks above
 * every modal panel without a portal.
 */
const MvcNftDetailOverlay: React.FC<{ detail: MvcNftItemDetail; onClose: () => void }> = ({ detail, onClose }) => {
  const { asset, item } = detail;
  const tile = buildMvcNftItemTileViewModel(item);
  const rows = buildMvcNftItemDetailRows(asset, item);
  const title = `${tile.title}${tile.badge ? ` ${tile.badge}` : ''}`;

  return (
    <div
      data-slot="metabot-wallet-nft-detail"
      className="absolute inset-0 z-10 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`NFT detail: ${title}`}
    >
      <div
        className="flex max-h-[86vh] w-[min(94vw,640px)] flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-claude-border px-4 py-2.5 dark:border-claude-darkBorder">
          <span className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{title}</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row">
          <div className="relative shrink-0 sm:w-[46%]">
            <NftArtworkImage large sources={tile.artworkSources} initials={tile.artworkInitials} alt={tile.title} />
            <span
              data-nft-format="metacontract"
              className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-slate-600/80 px-1.5 py-px text-[10px] font-semibold leading-tight text-white shadow-sm backdrop-blur-sm"
            >
              MetaContract
            </span>
          </div>
          <div className="flex-1 space-y-2.5 px-4 py-3">
            {rows.map((row) => (
              <div key={row.labelKey} className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {i18nService.t(row.labelKey)}
                </div>
                <div
                  className={`flex items-start gap-1 text-[12px] leading-5 dark:text-claude-darkText text-claude-text ${
                    row.mono ? 'font-mono [overflow-wrap:anywhere]' : ''
                  }`}
                >
                  <span className="min-w-0 break-all">{row.value}</span>
                  {row.mono && (
                    <button
                      type="button"
                      onClick={() => copyAddress(row.value)}
                      className="shrink-0 rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100"
                      aria-label={i18nService.t('metabotCopyAddress')}
                    >
                      <DocumentDuplicateIcon className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

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
  // null = no detail open; the { asset, item } pair a clicked tile showed.
  const [nftDetail, setNftDetail] = useState<MvcNftItemDetail | null>(null);

  useEffect(() => {
    if (!isOpen) setNftDetail(null);
  }, [isOpen]);

  useEffect(() => {
    if (!nftDetail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNftDetail(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [nftDetail]);

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
                  {i18nService.t(section.titleKey)}
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
                  key={`${asset.kind}-${asset.address}-${asset.kind === 'mrc20' ? asset.mrc20Id : asset.kind === 'mvc-ft' ? asset.genesis : asset.kind === 'mvc-nft' ? asset.genesis : asset.symbol}`}
                  className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-3"
                >
                  {asset.kind === 'mvc-nft' ? (
                    <div>
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                              {asset.seriesName || asset.genesis}
                            </span>
                            <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                              MVC NFT
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
                        <span className="text-sm font-semibold tabular-nums dark:text-claude-darkText text-claude-text shrink-0">
                          {asset.count}
                        </span>
                      </div>
                      {asset.items.length > 0 && (
                        <div className="mt-2 grid grid-cols-3 gap-2 border-t dark:border-claude-darkBorder border-claude-border pt-2 sm:grid-cols-4">
                          {asset.items.map((item) => {
                            const tile = buildMvcNftItemTileViewModel(item);
                            return (
                              <button
                                key={item.tokenIndex}
                                type="button"
                                data-slot="metabot-wallet-nft-tile"
                                onClick={() => setNftDetail({ asset, item })}
                                aria-label={`${i18nService.t('metabotWalletMvcNftAssets')}: ${tile.title}${tile.badge ? ` ${tile.badge}` : ''}`}
                                className="overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50"
                              >
                                <NftArtworkImage
                                  sources={tile.artworkSources}
                                  initials={tile.artworkInitials}
                                  alt={tile.title}
                                />
                                <div className="space-y-0.5 px-2 py-1.5">
                                  <div className="flex min-w-0 items-baseline gap-1">
                                    <span className="truncate text-xs font-semibold dark:text-claude-darkText text-claude-text">
                                      {tile.title}
                                    </span>
                                    {tile.badge && (
                                      <span className="shrink-0 font-mono text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                                        {tile.badge}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  ) : (
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
                  )}
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
      {nftDetail && <MvcNftDetailOverlay detail={nftDetail} onClose={() => setNftDetail(null)} />}
    </div>
  );
};

export default MetaBotWalletAssetsModal;
