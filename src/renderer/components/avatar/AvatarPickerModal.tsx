/**
 * Unified Avatar Picker Modal (A1 — Studio Linear Fixed-Width 3-Source Segmented Picker)
 *
 * Shared by Edit MetaBot, User Settings, and Mobile Profile/Bot Editor.
 * Fixed width (`max-w-[540px]`) prevents layout jumping across sources:
 *   1. Built-in avatars (20 curated portraits, no noisy text labels)
 *   2. Local image upload (click or drag-and-drop with size guard)
 *   3. Owned MRC-721 NFTs (with album filter pills + pagination)
 * Bottom live-preview bar renders the active selection in `NftAvatarFrame`.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowPathIcon,
  ArrowUpTrayIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PhotoIcon,
  SparklesIcon,
  Squares2X2Icon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import {
  BUILTIN_AVATARS,
  builtinAvatarSrc,
  getBuiltinAvatarByReference,
} from '../../assets/builtinAvatars';
import { i18nService } from '../../services/i18n';
import { NftArtworkImage } from '../metabots/NftArtworkImage';
import NftAvatarFrame from '../metabots/NftAvatarFrame';
import {
  buildNftAlbumGroups,
  buildNftAvatarUri,
  buildNftTileViewModel,
  paginateNftItems,
} from '../metabots/metabotNftPresentation.js';
import { parseNftAvatarReference } from '../metabots/nftAvatarPresentation.js';
import {
  METABOT_BTN_FLAT_CLASS,
  METABOT_BTN_PRIMARY_CLASS,
  METABOT_ICON_BTN_CLASS,
  METABOT_MODAL_BACKDROP_CLASS,
  METABOT_MODAL_FOOTER_CLASS,
  METABOT_MODAL_HEADER_CLASS,
  METABOT_MODAL_SCRIM_CLASS,
  METABOT_MODAL_SHELL_CLASS,
  METABOT_MODAL_SUBSURFACE_CLASS,
} from '../metabots/metaBotCardPresentation.js';

export interface AvatarPickerNftItem {
  kind: 'mrc721';
  key: string;
  name: string;
  collectionName: string;
  imageRef?: string;
  imageUrl?: string;
  number?: number;
  raw?: Record<string, unknown>;
}

interface AvatarPickerModalProps {
  /** MVC address that owns the candidate MRC-721 NFTs. */
  ownerAddress: string;
  /** Optional globalMetaId of the owner (recorded in the nft:// URI). */
  ownerGlobalMetaId?: string | null;
  /** Current avatar string (`data:image/...`, `metafile://...`, `nft://mrc721/...`, etc.). */
  currentReference?: string;
  /** Lazy loader invoked when the user switches to the NFT tab. */
  loadNfts: () => Promise<AvatarPickerNftItem[]>;
  /** Max local image byte size before rejecting. Default 200KB. */
  maxLocalBytes?: number;
  /** Whether to show the built-in avatar source (default true). */
  allowBuiltin?: boolean;
  /** Whether to show the MRC-721 NFT source (default true). */
  allowNft?: boolean;
  /** Optional custom local file reader (used by mobile clients for compression/resize). */
  readLocalFile?: (file: File) => Promise<string>;
  /** Commit an `nft://...` or `metafile://...` avatar reference. */
  onPick: (reference: string) => void;
  /** Commit a local `data:image/...` avatar upload. */
  onPickLocal: (dataUrl: string) => void;
  /** Optional error callback (e.g. local file too large). */
  onError?: (message: string) => void;
  onClose: () => void;
}

type AvatarSourceTab = 'builtin' | 'local' | 'nft';

const NFT_PAGE_SIZE = 12;

const AvatarPickerModal: React.FC<AvatarPickerModalProps> = ({
  ownerAddress,
  ownerGlobalMetaId,
  currentReference = '',
  loadNfts,
  maxLocalBytes = 200 * 1024,
  allowBuiltin = true,
  allowNft = true,
  readLocalFile,
  onPick,
  onPickLocal,
  onError,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<AvatarSourceTab>(allowBuiltin ? 'builtin' : 'local');
  const [draftKind, setDraftKind] = useState<'none' | 'ref' | 'local'>('none');
  const [draftValue, setDraftValue] = useState<string>('');
  const [draftLabel, setDraftLabel] = useState<string>('');
  const [localError, setLocalError] = useState<string>('');
  const [dragOver, setDragOver] = useState(false);

  const [nftItems, setNftItems] = useState<AvatarPickerNftItem[] | null>(null);
  const [nftLoading, setNftLoading] = useState(false);
  const [nftError, setNftError] = useState('');
  const [selectedAlbumKey, setSelectedAlbumKey] = useState<string>('__all__');
  const [nftPage, setNftPage] = useState(1);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const fetchNfts = () => {
    setNftLoading(true);
    setNftError('');
    loadNfts()
      .then((list) => {
        setNftItems(Array.isArray(list) ? list : []);
      })
      .catch((err) => {
        setNftError(err instanceof Error ? err.message : i18nService.t('metabotNftLoadFailed'));
      })
      .finally(() => {
        setNftLoading(false);
      });
  };

  useEffect(() => {
    if (activeTab === 'nft' && nftItems === null && !nftLoading) {
      fetchNfts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const effectivePreview = draftKind === 'none' ? currentReference : draftValue;
  const activeBuiltinPinId = useMemo(() => {
    return getBuiltinAvatarByReference(effectivePreview)?.pinId.toLowerCase() ?? '';
  }, [effectivePreview]);

  const activeNftPinId = useMemo(() => {
    const parsed = parseNftAvatarReference(effectivePreview);
    return parsed?.pinId?.toLowerCase() ?? '';
  }, [effectivePreview]);

  const nftAlbums = useMemo(
    () => buildNftAlbumGroups(nftItems ?? []),
    [nftItems],
  );

  const scopedNftItems = useMemo(() => {
    const list = nftItems ?? [];
    if (selectedAlbumKey === '__all__') return list;
    const match = nftAlbums.find((a: { key: string }) => a.key === selectedAlbumKey);
    return (match?.items ?? list) as AvatarPickerNftItem[];
  }, [nftItems, nftAlbums, selectedAlbumKey]);

  const nftPagination = useMemo(
    () => paginateNftItems(scopedNftItems, nftPage, NFT_PAGE_SIZE),
    [scopedNftItems, nftPage],
  );

  const handleLocalFile = async (file: File | null | undefined) => {
    if (!file) return;
    setLocalError('');
    if (!file.type.startsWith('image/')) {
      const msg = i18nService.t('avatarPickerLocalInvalidType') || 'Please select an image file';
      setLocalError(msg);
      onError?.(msg);
      return;
    }
    if (readLocalFile) {
      try {
        const dataUrl = await readLocalFile(file);
        if (dataUrl) {
          setDraftKind('local');
          setDraftValue(dataUrl);
          setDraftLabel(file.name);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : (i18nService.t('metabotAvatarTooLarge') || 'Failed to read image');
        setLocalError(msg);
        onError?.(msg);
      }
      return;
    }
    if (file.size > maxLocalBytes) {
      const kb = Math.round(maxLocalBytes / 1024);
      const msg = i18nService.t('metabotAvatarTooLarge') || `Image must be <= ${kb}KB`;
      setLocalError(msg);
      onError?.(msg);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setDraftKind('local');
        setDraftValue(reader.result);
        setDraftLabel(file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSelectBuiltin = (metafileUri: string, name: string) => {
    setDraftKind('ref');
    setDraftValue(metafileUri);
    setDraftLabel(name);
  };

  const handleSelectNft = (item: AvatarPickerNftItem) => {
    const uri = buildNftAvatarUri({
      itemPinId: item.key,
      ownerAddress,
      ownerGlobalMetaId: ownerGlobalMetaId ?? undefined,
    });
    if (!uri) return;
    setDraftKind('ref');
    setDraftValue(uri);
    setDraftLabel(item.name || item.collectionName || 'NFT');
  };

  const handleCommit = () => {
    if (draftKind === 'local' && draftValue) {
      onPickLocal(draftValue);
      return;
    }
    if (draftKind === 'ref' && draftValue) {
      onPick(draftValue);
      return;
    }
    onClose();
  };

  const maxKb = Math.round(maxLocalBytes / 1024);

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="avatar-picker-modal">
      <div className={METABOT_MODAL_SCRIM_CLASS} onClick={onClose} aria-hidden />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[540px] max-h-[84vh]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={i18nService.t('avatarPickerTitle')}
      >
        {/* Studio Linear Header */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
              <PhotoIcon className="h-4 w-4" aria-hidden />
            </div>
            <h3 className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
              {i18nService.t('avatarPickerTitle')}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className={METABOT_ICON_BTN_CLASS}
            aria-label={i18nService.t('close')}
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Fixed-Width Body with Segmented 3-Source Switcher */}
        <div className="flex flex-col min-h-0 flex-1 overflow-hidden" data-slot="avatar-source-list">
          <div className="border-b border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-5 py-3 shrink-0">
            <div className="grid grid-flow-col auto-cols-fr gap-1 rounded-[9px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f1f5f9] dark:bg-[#0f1724] p-1">
              {allowBuiltin && (
                <button
                  type="button"
                  data-slot="avatar-source-builtin"
                  aria-pressed={activeTab === 'builtin'}
                  onClick={() => setActiveTab('builtin')}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    activeTab === 'builtin'
                      ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                      : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                  }`}
                >
                  <Squares2X2Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('avatarPickerBuiltin')}</span>
                </button>
              )}

              <button
                type="button"
                data-slot="avatar-source-local"
                aria-pressed={activeTab === 'local'}
                onClick={() => setActiveTab('local')}
                className={`inline-flex items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                  activeTab === 'local'
                    ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                    : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                }`}
              >
                <ArrowUpTrayIcon className="h-3.5 w-3.5" aria-hidden />
                <span>{i18nService.t('avatarPickerLocal')}</span>
              </button>

              {allowNft && (
                <button
                  type="button"
                  data-slot="avatar-source-nft"
                  aria-pressed={activeTab === 'nft'}
                  onClick={() => setActiveTab('nft')}
                  className={`inline-flex items-center justify-center gap-1.5 rounded-[7px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    activeTab === 'nft'
                      ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                      : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                  }`}
                >
                  <SparklesIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('avatarPickerNft')}</span>
                </button>
              )}
            </div>
          </div>

          {/* Active Source Panel */}
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {activeTab === 'builtin' && allowBuiltin && (
              <div className="grid grid-cols-5 gap-2.5" data-slot="avatar-panel-builtin">
                {BUILTIN_AVATARS.map((avatar) => {
                  const selected = activeBuiltinPinId === avatar.pinId.toLowerCase();
                  return (
                    <button
                      key={avatar.code}
                      type="button"
                      data-slot="metabot-builtin-avatar-picker-tile"
                      data-avatar-code={avatar.code}
                      data-pin-id={avatar.pinId}
                      aria-pressed={selected}
                      title={avatar.name}
                      onClick={() => handleSelectBuiltin(avatar.metafileUri, avatar.name)}
                      onDoubleClick={() => onPick(avatar.metafileUri)}
                      className={`group relative aspect-square overflow-hidden rounded-[10px] border transition-[border-color,transform,box-shadow] duration-150 focus:outline-none ${
                        selected
                          ? 'border-[#d4af1f] ring-2 ring-[#FFDC51]/65 scale-[0.98]'
                          : 'border-slate-900/[0.10] dark:border-white/[0.10] hover:border-slate-900/[0.25] dark:hover:border-white/[0.25]'
                      }`}
                    >
                      <img
                        src={builtinAvatarSrc(avatar)}
                        alt={avatar.name}
                        className="h-full w-full object-cover"
                      />
                      {selected && (
                        <span className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#FFDC51] text-[#24210c] shadow-sm">
                          <CheckIcon className="h-2.5 w-2.5 stroke-[3]" />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {activeTab === 'local' && (
              <div className="space-y-3" data-slot="avatar-panel-local">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(event) => {
                    handleLocalFile(event.target.files?.[0]);
                    event.target.value = '';
                  }}
                />
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => fileInputRef.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      fileInputRef.current?.click();
                    }
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOver(true);
                  }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(event) => {
                    event.preventDefault();
                    setDragOver(false);
                    handleLocalFile(event.dataTransfer.files?.[0]);
                  }}
                  className={`flex flex-col items-center justify-center rounded-[12px] border-2 border-dashed px-6 py-10 text-center transition-colors cursor-pointer ${
                    dragOver
                      ? 'border-[#d4af1f] bg-[#FFDC51]/10'
                      : 'border-slate-900/[0.14] dark:border-white/[0.14] bg-[#f8fafc] dark:bg-[#101826] hover:border-[#d4af1f]'
                  }`}
                >
                  <div className="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-white dark:bg-[#182538] border border-slate-900/[0.08] dark:border-white/[0.09] text-[#5a6577] dark:text-[#94a3b8]">
                    <ArrowUpTrayIcon className="h-5 w-5" aria-hidden />
                  </div>
                  <div className="text-[13px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                    {i18nService.t('avatarPickerDropzoneTitle')}
                  </div>
                  <div className="mt-1 text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('avatarPickerDropzoneFormats')} · ≤ {maxKb} KB
                  </div>
                  <span className={`mt-4 ${METABOT_BTN_FLAT_CLASS}`}>
                    {i18nService.t('avatarPickerLocal')}
                  </span>
                </div>

                {localError && (
                  <div className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400">
                    {localError}
                  </div>
                )}
              </div>
            )}

            {activeTab === 'nft' && allowNft && (
              <div className="space-y-3" data-slot="avatar-panel-nft">
                {nftLoading && nftItems === null ? (
                  <div className="py-12 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('loading')}
                  </div>
                ) : nftError ? (
                  <div className="rounded-[10px] border border-rose-500/35 bg-rose-500/[0.08] p-4 text-center space-y-2.5">
                    <p className="text-[12.5px] text-red-600 dark:text-rose-400">{nftError}</p>
                    <button type="button" onClick={fetchNfts} className={METABOT_BTN_FLAT_CLASS}>
                      <ArrowPathIcon className="h-3.5 w-3.5" />
                      <span>{i18nService.t('metabotNftRetry')}</span>
                    </button>
                  </div>
                ) : (nftItems?.length ?? 0) === 0 ? (
                  <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} py-10 text-center text-[12.5px] text-[#5a6577] dark:text-[#94a3b8]`}>
                    {i18nService.t('avatarPickerNftEmpty') || i18nService.t('metabotNftEmpty')}
                  </div>
                ) : (
                  <>
                    {/* Album Filter Pills */}
                    {nftAlbums.length > 1 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setSelectedAlbumKey('__all__');
                            setNftPage(1);
                          }}
                          className={`rounded-[6px] border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                            selectedAlbumKey === '__all__'
                              ? 'border-[#d4af1f] bg-[#FFDC51]/30 text-[#24210c] dark:bg-[#FFDC51]/20 dark:text-[#FFDC51]'
                              : 'border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#182538] text-[#5a6577] dark:text-[#94a3b8]'
                          }`}
                        >
                          {i18nService.t('avatarPickerAllAlbums')} ({nftItems?.length ?? 0})
                        </button>
                        {nftAlbums.map((album: { key: string; title: string; count: number }) => (
                          <button
                            key={album.key}
                            type="button"
                            onClick={() => {
                              setSelectedAlbumKey(album.key);
                              setNftPage(1);
                            }}
                            className={`max-w-[160px] truncate rounded-[6px] border px-2.5 py-1 text-[11px] font-semibold transition-colors ${
                              selectedAlbumKey === album.key
                                ? 'border-[#d4af1f] bg-[#FFDC51]/30 text-[#24210c] dark:bg-[#FFDC51]/20 dark:text-[#FFDC51]'
                                : 'border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f8fafc] dark:bg-[#182538] text-[#5a6577] dark:text-[#94a3b8]'
                            }`}
                          >
                            {album.title} ({album.count})
                          </button>
                        ))}
                      </div>
                    )}

                    {/* Paginated 4-Col NFT Grid */}
                    <div className="grid grid-cols-4 gap-2.5">
                      {(nftPagination.items as AvatarPickerNftItem[]).map((item) => {
                        const vm = buildNftTileViewModel(item);
                        const selected = activeNftPinId === item.key.toLowerCase();
                        return (
                          <button
                            key={item.key}
                            type="button"
                            data-slot="avatar-picker-nft-tile"
                            aria-pressed={selected}
                            onClick={() => handleSelectNft(item)}
                            onDoubleClick={() => {
                              const uri = buildNftAvatarUri({
                                itemPinId: item.key,
                                ownerAddress,
                                ownerGlobalMetaId: ownerGlobalMetaId ?? undefined,
                              });
                              if (uri) onPick(uri);
                            }}
                            className={`group overflow-hidden rounded-[9px] border text-left transition-[border-color,box-shadow] focus:outline-none ${
                              selected
                                ? 'border-[#d4af1f] ring-2 ring-[#FFDC51]/60'
                                : 'border-slate-900/[0.10] dark:border-white/[0.10] hover:border-slate-900/[0.24] dark:hover:border-white/[0.24]'
                            }`}
                          >
                            <div className="relative aspect-square w-full bg-[#eef1f5] dark:bg-[#0f1724]">
                              <NftArtworkImage
                                sources={vm.artworkSources}
                                alt={vm.title}
                                initials={vm.artworkInitials}
                                className="h-full w-full"
                              />
                              {vm.badge && (
                                <span className="absolute left-1 top-1 rounded bg-slate-950/75 px-1 py-0.5 font-mono text-[9.5px] font-bold text-white">
                                  {vm.badge}
                                </span>
                              )}
                              {selected && (
                                <span className="absolute right-1 top-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-[#FFDC51] text-[#24210c] shadow-sm">
                                  <CheckIcon className="h-2.5 w-2.5 stroke-[3]" />
                                </span>
                              )}
                            </div>
                            <div className="px-1.5 py-1">
                              <div className="truncate text-[10.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                                {vm.title}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {nftPagination.totalPages > 1 && (
                      <div className="flex items-center justify-between pt-1 text-[11.5px] text-[#5a6577] dark:text-[#94a3b8] tabular-nums">
                        <span>
                          {i18nService
                            .t('metabotNftPaginationSummary')
                            .replace('{total}', String(nftPagination.totalItems))
                            .replace('{page}', String(nftPagination.page))
                            .replace('{pages}', String(nftPagination.totalPages))}
                        </span>
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            disabled={nftPagination.page <= 1}
                            onClick={() => setNftPage((p) => Math.max(1, p - 1))}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-900/[0.10] dark:border-white/[0.10] disabled:opacity-40"
                            aria-label={i18nService.t('metabotNftPrevPage')}
                          >
                            <ChevronLeftIcon className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={nftPagination.page >= nftPagination.totalPages}
                            onClick={() => setNftPage((p) => Math.min(nftPagination.totalPages, p + 1))}
                            className="inline-flex h-6 w-6 items-center justify-center rounded border border-slate-900/[0.10] dark:border-white/[0.10] disabled:opacity-40"
                            aria-label={i18nService.t('metabotNftNextPage')}
                          >
                            <ChevronRightIcon className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Live Preview Footer */}
        <div className={METABOT_MODAL_FOOTER_CLASS} data-slot="avatar-picker-footer">
          <div className="flex min-w-0 items-center gap-2.5">
            <NftAvatarFrame
              avatar={effectivePreview || null}
              alt={draftLabel || 'Avatar'}
              frameClassName="h-9 w-9 shrink-0 rounded-[9px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] overflow-hidden flex items-center justify-center"
              imgClassName="h-full w-full object-cover"
              fallback={<PhotoIcon className="h-4 w-4 text-[#8c96a6]" aria-hidden />}
            />
            <div className="min-w-0">
              <div className="text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                {i18nService.t('avatarPickerSelectedPreview')}
              </div>
              <div className="truncate text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {draftLabel || (effectivePreview ? 'Current' : '—')}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button type="button" onClick={onClose} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              data-slot="avatar-picker-apply"
              disabled={draftKind === 'none'}
              onClick={handleCommit}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {i18nService.t('avatarPickerApply')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default AvatarPickerModal;
