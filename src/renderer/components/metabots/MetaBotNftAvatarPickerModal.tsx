/**
 * MetaBot NFT avatar picker modal.
 *
 * Opened from the Basic tab's avatar row ("Set NFT Avatar"). Lists the bot's
 * own MRC-721 holdings via the same `idbots:getMetabotNfts` read the NFT
 * Wallet modal uses (kind 'mrc721'), and picking a tile hands the
 * `nft://mrc721/<itemPinId>` reference back to the edit form — nothing is
 * written on-chain from here (the avatar is a local display-only decoration).
 * Artwork walks the same ordered content routes as the wallet tiles via
 * NftArtworkImage, so a tile never shows a broken image.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { ArrowPathIcon, PhotoIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { buildNftTileViewModel } from './metabotNftPresentation.js';
import { NftArtworkImage } from './NftArtworkImage';

interface PickerItem {
  key: string;
  name: string;
  collectionName: string;
  imageRef?: string;
  imageUrl?: string;
  number?: number;
  kind: 'mrc721';
  raw: Record<string, unknown>;
}

interface PickerState {
  loading: boolean;
  error: string;
  items: PickerItem[];
}

interface MetaBotNftAvatarPickerModalProps {
  metabotId: number;
  onPick: (reference: string) => void;
  onClose: () => void;
}

const MetaBotNftAvatarPickerModal: React.FC<MetaBotNftAvatarPickerModalProps> = ({ metabotId, onPick, onClose }) => {
  const [state, setState] = useState<PickerState>({ loading: true, error: '', items: [] });

  const load = useCallback(() => {
    setState((current) => ({ loading: true, error: '', items: current.items }));
    window.electron.idbots
      .getMetabotNfts({ metabotId, kind: 'mrc721' })
      .then((response) => {
        setState(
          response.success && response.items
            ? { loading: false, error: '', items: (response.items as unknown as PickerItem[]) }
            : { loading: false, error: response.error || i18nService.t('metabotNftLoadFailed'), items: [] },
        );
      })
      .catch((error) => {
        setState({
          loading: false,
          error: error instanceof Error ? error.message : i18nService.t('metabotNftLoadFailed'),
          items: [],
        });
      });
  }, [metabotId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const tiles = state.items
    .filter((item) => item?.kind === 'mrc721' && item.key)
    .map((item) => ({ item, tile: buildNftTileViewModel(item) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-slot="metabot-nft-avatar-picker">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('metabotNftAvatarPickerTitle')}
            </div>
            <div className="truncate text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {i18nService.t('metabotNftAvatarPickerHint')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              data-slot="metabot-nft-avatar-picker-refresh"
              onClick={() => load()}
              className="rounded p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
              aria-label={i18nService.t('metabotWalletAssetsRefresh')}
              title={i18nService.t('metabotWalletAssetsRefresh')}
            >
              <ArrowPathIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
              aria-label={i18nService.t('close')}
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {state.loading && (
            <div className="flex h-32 items-center justify-center text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
              ...
            </div>
          )}
          {!state.loading && state.error && state.items.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-8">
              <p className="text-sm text-red-500 dark:text-red-400">{state.error}</p>
              <button
                type="button"
                data-slot="metabot-nft-avatar-picker-retry"
                onClick={() => load()}
                className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
              >
                {i18nService.t('metabotNftRetry')}
              </button>
            </div>
          )}
          {!state.loading && !state.error && tiles.length === 0 && (
            <div className="flex flex-col items-center gap-2 py-10 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              <PhotoIcon className="h-8 w-8 opacity-50" aria-hidden />
              <p className="text-sm">{i18nService.t('metabotNftEmpty')}</p>
            </div>
          )}
          {tiles.length > 0 && (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {tiles.map(({ item, tile }) => (
                <button
                  key={tile.key}
                  type="button"
                  data-slot="metabot-nft-avatar-picker-tile"
                  onClick={() => onPick(`nft://mrc721/${item.key}`)}
                  className="overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50"
                >
                  <NftArtworkImage sources={tile.artworkSources} initials={tile.artworkInitials} alt={tile.title} />
                  <div className="space-y-0.5 px-2 py-1.5">
                    <div className="truncate text-xs font-semibold dark:text-claude-darkText text-claude-text">{tile.title}</div>
                    <div className="truncate text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {tile.subtitle || '—'}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default MetaBotNftAvatarPickerModal;
