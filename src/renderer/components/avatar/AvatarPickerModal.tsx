import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  CheckIcon,
  ChevronRightIcon,
  PhotoIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { BUILTIN_AVATARS, builtinAvatarSrc } from '../../assets/builtinAvatars';
import { i18nService } from '../../services/i18n';
import { buildNftTileViewModel } from '../metabots/metabotNftPresentation.js';
import { NftArtworkImage } from '../metabots/NftArtworkImage';

export interface AvatarPickerNftItem {
  key: string;
  name: string;
  collectionName: string;
  imageRef?: string;
  imageUrl?: string;
  number?: number;
  kind: 'mrc721';
  raw: Record<string, unknown>;
}

interface AvatarPickerModalProps {
  ownerAddress: string;
  ownerGlobalMetaId?: string | null;
  currentReference?: string;
  loadNfts: () => Promise<AvatarPickerNftItem[]>;
  onPick: (reference: string) => void;
  onPickLocal: (dataUrl: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  maxLocalBytes: number;
  allowBuiltin?: boolean;
  allowNft?: boolean;
  readLocalFile?: (file: File) => Promise<string>;
}

const AvatarPickerModal: React.FC<AvatarPickerModalProps> = ({
  ownerAddress,
  ownerGlobalMetaId,
  currentReference = '',
  loadNfts,
  onPick,
  onPickLocal,
  onClose,
  onError,
  maxLocalBytes,
  allowBuiltin = true,
  allowNft = true,
  readLocalFile,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<'choice' | 'builtin' | 'nft'>('choice');
  const [state, setState] = useState<{ loading: boolean; error: string; items: AvatarPickerNftItem[] }>({
    loading: false,
    error: '',
    items: [],
  });

  const load = useCallback(() => {
    setState((current) => ({ loading: true, error: '', items: current.items }));
    void loadNfts()
      .then((items) => setState({ loading: false, error: '', items }))
      .catch((error) => {
        const message = error instanceof Error ? error.message : i18nService.t('metabotNftLoadFailed');
        setState({ loading: false, error: message, items: [] });
      });
  }, [loadNfts]);

  useEffect(() => {
    if (source === 'nft') load();
  }, [source, load]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > maxLocalBytes) {
      onError(i18nService.t('metabotAvatarSizeError'));
      return;
    }
    if (readLocalFile) {
      void readLocalFile(file)
        .then(onPickLocal)
        .catch(() => onError(i18nService.t('metabotAvatarUploadFailed')));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') onPickLocal(reader.result);
    };
    reader.onerror = () => onError(i18nService.t('metabotAvatarUploadFailed'));
    reader.readAsDataURL(file);
  };

  const tiles = state.items
    .filter((item) => item?.kind === 'mrc721' && item.key)
    .map((item) => ({ item, tile: buildNftTileViewModel(item) }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-slot="avatar-picker">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={onClose} aria-hidden />
      <div
        className={`relative flex max-h-[76vh] w-full flex-col overflow-hidden rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl ${
          source === 'builtin' ? 'max-w-2xl' : 'max-w-lg'
        }`}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('avatarPickerTitle')}
            </div>
            <div className="truncate text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {source === 'builtin'
                ? i18nService.t('metabotBuiltinAvatarHint')
                : source === 'nft'
                  ? i18nService.t('metabotNftAvatarPickerHint')
                  : i18nService.t('avatarPickerHint')}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {source === 'nft' && (
              <button
                type="button"
                data-slot="avatar-picker-refresh"
                onClick={load}
                className="rounded p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
                aria-label={i18nService.t('metabotWalletAssetsRefresh')}
              >
                <ArrowPathIcon className="h-4 w-4" />
              </button>
            )}
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
          {source === 'choice' && (
            <div className="flex flex-col gap-2.5" data-slot="avatar-source-list">
              <input
                ref={inputRef}
                type="file"
                accept="image/png,image/jpeg,image/jpg,image/webp,image/gif"
                className="hidden"
                onChange={handleFile}
              />
              {allowBuiltin && (
                <button
                  type="button"
                  data-slot="avatar-source-builtin"
                  onClick={() => setSource('builtin')}
                  className="flex w-full items-center gap-3.5 rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3.5 text-left dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surfaceInset/60 dark:bg-claude-darkSurfaceInset/50">
                    <Squares2X2Icon className="h-5 w-5 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{i18nService.t('avatarPickerBuiltin')}</div>
                    <div className="truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('metabotBuiltinAvatarHint')}
                    </div>
                  </div>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                </button>
              )}
              <button
                type="button"
                data-slot="avatar-source-local"
                onClick={() => inputRef.current?.click()}
                className="flex w-full items-center gap-3.5 rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3.5 text-left dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surfaceInset/60 dark:bg-claude-darkSurfaceInset/50">
                  <PhotoIcon className="h-5 w-5 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{i18nService.t('avatarPickerLocal')}</div>
                  <div className="truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {i18nService.t('metabotAvatarSizeError')}
                  </div>
                </div>
                <ChevronRightIcon className="h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
              </button>
              {allowNft && (
                <button
                  type="button"
                  data-slot="avatar-source-nft"
                  disabled={!ownerAddress}
                  onClick={() => setSource('nft')}
                  className="flex w-full items-center gap-3.5 rounded-xl border dark:border-claude-darkBorder border-claude-border px-4 py-3.5 text-left dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-40"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border dark:border-claude-darkBorder border-claude-border bg-claude-surfaceInset/60 dark:bg-claude-darkSurfaceInset/50 text-xs font-semibold tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    NFT
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{i18nService.t('avatarPickerNft')}</div>
                    <div className="truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t('metabotNftAvatarPickerHint')}
                    </div>
                  </div>
                  <ChevronRightIcon className="h-4 w-4 shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary" />
                </button>
              )}
            </div>
          )}

          {source === 'builtin' && (
            <div>
              <button
                type="button"
                data-slot="avatar-picker-back"
                onClick={() => setSource('choice')}
                className="mb-3 inline-flex items-center gap-1 text-xs text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText"
              >
                <ArrowLeftIcon className="h-3.5 w-3.5" />
                {i18nService.t('avatarPickerBack')}
              </button>
              <div className="grid grid-cols-4 gap-3 sm:grid-cols-5">
                {BUILTIN_AVATARS.map((avatar) => {
                  const selected = avatar.metafileUri === currentReference.trim();
                  return (
                    <button
                      key={avatar.code}
                      type="button"
                      data-slot="metabot-builtin-avatar-picker-tile"
                      data-avatar-code={avatar.code}
                      data-pin-id={avatar.pinId}
                      aria-pressed={selected}
                      onClick={() => onPick(avatar.metafileUri)}
                      className={`group relative overflow-hidden rounded-xl border transition-shadow hover:shadow-md dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 ${selected ? 'border-amber-500 ring-2 ring-amber-200 dark:ring-amber-900' : ''}`}
                    >
                      <img
                        src={builtinAvatarSrc(avatar)}
                        alt={avatar.name}
                        className="aspect-square w-full object-cover"
                        loading="lazy"
                      />
                      {selected && (
                        <span className="absolute right-1.5 top-1.5 rounded-full bg-amber-500 p-1 text-white shadow-sm">
                          <CheckIcon className="h-3 w-3" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {i18nService.t('metabotBuiltinAvatarReferenceHint')}
              </p>
            </div>
          )}

          {source === 'nft' && (
            <div>
              <button
                type="button"
                data-slot="avatar-picker-back"
                onClick={() => setSource('choice')}
                className="mb-3 inline-flex items-center gap-1 text-xs text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText"
              >
                <ArrowLeftIcon className="h-3.5 w-3.5" />
                {i18nService.t('avatarPickerBack')}
              </button>
              {state.loading && <div className="flex h-32 items-center justify-center text-sm text-claude-textSecondary">...</div>}
              {!state.loading && state.error && state.items.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <p className="text-sm text-red-500 dark:text-red-400">{state.error}</p>
                  <button
                    type="button"
                    data-slot="avatar-picker-retry"
                    onClick={load}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-1.5 text-sm dark:text-claude-darkText text-claude-text"
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
                      data-slot="avatar-picker-nft-tile"
                      onClick={() => {
                        const params = new URLSearchParams({ owner: ownerAddress });
                        if (ownerGlobalMetaId) params.set('metaid', ownerGlobalMetaId);
                        onPick(`nft://mrc721/${item.key}?${params.toString()}`);
                      }}
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
          )}
        </div>
      </div>
    </div>
  );
};

export default AvatarPickerModal;
