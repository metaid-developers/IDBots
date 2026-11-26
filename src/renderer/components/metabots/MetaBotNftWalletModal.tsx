/**
 * MetaBot NFT Wallet Modal (N2 — Studio Linear Stacked Album Shelf + Pagination + Inspector Drawer)
 *
 * - Protocol tabs: MRC-721 (default) / MetaContract
 * - View mode toggle: Albums (2-level stacked deck shelf, default) / All Items (flat grid)
 * - Search, Official CA Verified filter, Sort (recent / serial #↑ / name A–Z)
 * - Deterministic Pagination bar (6 / 12 / 24 per page) for 500+ holdings
 * - Persistent Right Inspector Drawer (`data-slot="metabot-nft-detail"`) with:
 *   - One-click "Set as Bot Avatar" for MRC-721 items
 *   - Send to Chat (`nft-card` fence)
 *   - On-chain Transfer (MRC-721 & MetaContract)
 *   - MRC-721 Atomic-Swap Direct Sell + header Paste-Listing Buy & My Listings
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  ChatBubbleLeftRightIcon,
  CheckBadgeIcon,
  CheckCircleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClipboardDocumentCheckIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  MagnifyingGlassIcon,
  PaperAirplaneIcon,
  PhotoIcon,
  QueueListIcon,
  SparklesIcon,
  Squares2X2Icon,
  TagIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import { getNftCaRegistryCached, type NftCaRegistry } from '../../services/nftCaRegistryService';
import type { Metabot } from '../../types/metabot';
import { serializeNftCardFence, type NftCardData } from '../chat/nftCardSyntax';
import { dispatchSuiteComposerDraft } from '../chat/tokenSuiteUi';
import { NftArtworkImage } from './NftArtworkImage';
import {
  buildNftAlbumGroups,
  buildNftAvatarUri,
  buildNftDetailRows,
  buildNftTileViewModel,
  buildNftTransferPayload,
  buildPaginationTokens,
  filterAndSortNftItems,
  isNftItemCertified,
  MRC721_MIN_SELL_PRICE_SATS,
  mrc721SellOrderStatusKey,
  paginateNftItems,
  validateMrc721SellDraft,
  validateNftTransferDraft,
} from './metabotNftPresentation.js';
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

export type MetabotNftKind = 'mrc721' | 'metacontract';
export type MetabotNftViewMode = 'albums' | 'all';
export type MetabotNftSortMode = 'recent' | 'serial' | 'name';

export interface MetabotNftListItem {
  kind: MetabotNftKind;
  key: string;
  name: string;
  collectionName: string;
  imageRef?: string;
  imageUrl?: string;
  number?: number;
  tokenIndex?: string;
  createTime?: number;
  height?: number;
  raw: Record<string, unknown>;
}

interface NftAlbumGroup {
  key: string;
  kind: MetabotNftKind;
  title: string;
  collectionPinId: string;
  genesis: string;
  codeHash: string;
  tokenSupply: number | null;
  certified: boolean;
  count: number;
  coverSources: string[];
  coverInitials: string;
  items: MetabotNftListItem[];
}

interface Mrc721SellOrderRow {
  id: string;
  status: 'valid' | 'invalid' | 'expired';
  reason?: string;
  itemPinId: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
}

interface Mrc721ListingSummary {
  itemPinId: string;
  collectionPinId: string;
  sellerAddress: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
  createdAt: number;
  expiresAt: number;
  feeRate: number;
}

interface Mrc721BuyResult {
  txId: string;
  itemPinId: string;
  priceSats: number;
  sellerAddress: string;
  feeSats: number;
  feeRateEffective: number;
}

type ModalSubView =
  | { name: 'browse' }
  | { name: 'transfer'; item: MetabotNftListItem }
  | { name: 'sell'; item: MetabotNftListItem }
  | { name: 'buy' }
  | { name: 'myListings' };

export interface MetaBotNftWalletModalProps {
  isOpen?: boolean;
  metabot: Metabot;
  onClose: () => void;
  /** Current Bot avatar URI (e.g. `nft://mrc721/...`) to mark active item. */
  currentAvatar?: string;
  /** One-click set MRC-721 item as Bot avatar. */
  onSetBotAvatar?: (avatarRef: string) => Promise<void> | void;
}

const PAGE_SIZE_OPTIONS = [6, 12, 24] as const;

const copyToClipboard = (value: string, toastKey: string = 'metabotAddressCopied') => {
  if (!value) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(value).then(() => {
      window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t(toastKey) }));
    });
  }
};

function formatSatsSpace(sats: number): string {
  const space = sats / 1e8;
  const trimmed = space.toFixed(8).replace(/\.?0+$/, '');
  return `${sats.toLocaleString()} sats (${trimmed || '0'} SPACE)`;
}

function extractAvatarPinId(avatarRef?: string): string {
  const raw = String(avatarRef || '').trim();
  const match = /^nft:\/\/mrc721\/([^?#]+)/i.exec(raw);
  return match ? match[1].trim().toLowerCase() : '';
}

const MetaBotNftWalletModal: React.FC<MetaBotNftWalletModalProps> = ({
  isOpen = true,
  metabot,
  onClose,
  currentAvatar,
  onSetBotAvatar,
}) => {
  const [kind, setKind] = useState<MetabotNftKind>('mrc721');
  const [viewMode, setViewMode] = useState<MetabotNftViewMode>('albums');
  const [activeAlbumKey, setActiveAlbumKey] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<MetabotNftSortMode>('recent');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(12);

  const [itemsByKind, setItemsByKind] = useState<Record<MetabotNftKind, MetabotNftListItem[] | null>>({
    mrc721: null,
    metacontract: null,
  });
  const [loadingKind, setLoadingKind] = useState<MetabotNftKind | null>(null);
  const [errorByKind, setErrorByKind] = useState<Record<MetabotNftKind, string>>({
    mrc721: '',
    metacontract: '',
  });
  const [caRegistry, setCaRegistry] = useState<NftCaRegistry | null>(null);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [subView, setSubView] = useState<ModalSubView>({ name: 'browse' });
  const [applyingAvatarKey, setApplyingAvatarKey] = useState<string | null>(null);
  const [copiedRowKey, setCopiedRowKey] = useState<string>('');
  const requestSeqRef = useRef(0);

  const loadKind = useCallback(
    async (targetKind: MetabotNftKind) => {
      if (typeof window === 'undefined' || !window.electron?.idbots) return;
      const reqId = ++requestSeqRef.current;
      setLoadingKind(targetKind);
      setErrorByKind((prev) => ({ ...prev, [targetKind]: '' }));
      try {
        const res = await window.electron.idbots.getMetabotNfts({
          metabotId: metabot.id,
          kind: targetKind,
        });
        if (requestSeqRef.current !== reqId) return;
        if (!res.success) {
          setErrorByKind((prev) => ({
            ...prev,
            [targetKind]: res.error || i18nService.t('metabotNftLoadFailed'),
          }));
          return;
        }
        const normalized = ((res.items ?? []) as unknown as MetabotNftListItem[]).map((item) => ({
          ...item,
          kind: targetKind,
        }));
        setItemsByKind((prev) => ({ ...prev, [targetKind]: normalized }));
      } catch (err) {
        if (requestSeqRef.current !== reqId) return;
        setErrorByKind((prev) => ({
          ...prev,
          [targetKind]: err instanceof Error ? err.message : i18nService.t('metabotNftLoadFailed'),
        }));
      } finally {
        if (requestSeqRef.current === reqId) {
          setLoadingKind((curr) => (curr === targetKind ? null : curr));
        }
      }
    },
    [metabot.id],
  );

  useEffect(() => {
    if (!isOpen) {
      setSubView({ name: 'browse' });
      setActiveAlbumKey(null);
      setSearchQuery('');
      setVerifiedOnly(false);
      setPage(1);
      return;
    }
    void loadKind(kind);
    void getNftCaRegistryCached().then((reg) => setCaRegistry(reg)).catch(() => undefined);
  }, [isOpen, kind, loadKind]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (subView.name !== 'browse') {
        setSubView({ name: 'browse' });
      } else if (viewMode === 'albums' && activeAlbumKey) {
        setActiveAlbumKey(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, subView, viewMode, activeAlbumKey, onClose]);

  const rawItems = itemsByKind[kind] ?? [];
  const isInitialLoading = loadingKind === kind && itemsByKind[kind] == null;
  const isRefreshing = loadingKind === kind;
  const currentError = errorByKind[kind];

  const albums = useMemo(
    () => buildNftAlbumGroups(rawItems, caRegistry) as NftAlbumGroup[],
    [rawItems, caRegistry],
  );

  const filteredAlbums = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return albums.filter((album) => {
      if (verifiedOnly && !album.certified) return false;
      if (!q) return true;
      return (
        album.title.toLowerCase().includes(q) ||
        album.collectionPinId.toLowerCase().includes(q) ||
        album.genesis.toLowerCase().includes(q) ||
        album.items.some((item) => item.name.toLowerCase().includes(q))
      );
    });
  }, [albums, searchQuery, verifiedOnly]);

  const activeAlbum = useMemo(
    () => (activeAlbumKey ? albums.find((a) => a.key === activeAlbumKey) ?? null : null),
    [albums, activeAlbumKey],
  );

  const scopedItems = useMemo(() => {
    if (viewMode === 'albums' && activeAlbum) {
      return activeAlbum.items;
    }
    return rawItems;
  }, [viewMode, activeAlbum, rawItems]);

  const filteredItems = useMemo(
    () =>
      filterAndSortNftItems(scopedItems, {
        query: searchQuery,
        verifiedOnly,
        sortBy,
        registry: caRegistry,
      }) as MetabotNftListItem[],
    [scopedItems, searchQuery, verifiedOnly, sortBy, caRegistry],
  );

  const pagination = useMemo(
    () => paginateNftItems(filteredItems, page, pageSize),
    [filteredItems, page, pageSize],
  );

  useEffect(() => {
    if (page !== pagination.page) {
      setPage(pagination.page);
    }
  }, [page, pagination.page]);

  const isShelfLevel = subView.name === 'browse' && viewMode === 'albums' && !activeAlbum;

  // Keep right inspector drawer populated with a valid item when in grid view
  const inspectedItem = useMemo(() => {
    if (isShelfLevel) return null;
    if (selectedKey) {
      const found = filteredItems.find((i) => i.key === selectedKey);
      if (found) return found;
    }
    return pagination.items[0] ?? filteredItems[0] ?? null;
  }, [isShelfLevel, selectedKey, filteredItems, pagination.items]);

  const activeAvatarPinId = useMemo(
    () => extractAvatarPinId(currentAvatar ?? metabot.avatar ?? ''),
    [currentAvatar, metabot.avatar],
  );

  if (!isOpen) return null;

  const handleSwitchKind = (nextKind: MetabotNftKind) => {
    setKind(nextKind);
    setActiveAlbumKey(null);
    setSelectedKey(null);
    setPage(1);
    setSubView({ name: 'browse' });
  };

  const handleSwitchViewMode = (nextMode: MetabotNftViewMode) => {
    setViewMode(nextMode);
    if (nextMode === 'all') {
      setActiveAlbumKey(null);
    }
    setPage(1);
  };

  const handleSendToChat = (item: MetabotNftListItem) => {
    const raw = item.raw ?? {};
    const rawPinId =
      typeof raw.itemPinId === 'string' && raw.itemPinId.trim()
        ? raw.itemPinId.trim()
        : item.kind === 'mrc721'
          ? item.key
          : undefined;
    const cardPayload: NftCardData =
      item.kind === 'mrc721'
        ? {
            format: 'mrc721',
            pinId: rawPinId,
            number: item.number,
            name: item.name || undefined,
            series: item.collectionName || undefined,
            icon: item.imageRef,
            imgUrl: item.imageUrl,
            owner: metabot.mvc_address || undefined,
            ownerLabel: metabot.name || undefined,
            action: 'info',
          }
        : {
            format: 'metacontract',
            genesis: typeof raw.genesis === 'string' ? raw.genesis : undefined,
            codehash: typeof raw.codeHash === 'string' ? raw.codeHash : undefined,
            tokenIndex: item.tokenIndex || '0',
            name: item.name || undefined,
            series: item.collectionName || undefined,
            icon: item.imageRef,
            imgUrl: item.imageUrl,
            owner: metabot.mvc_address || undefined,
            ownerLabel: metabot.name || undefined,
            action: 'info',
          };
    const fence = serializeNftCardFence(cardPayload);
    if (fence) {
      dispatchSuiteComposerDraft(`${fence}\n`);
      onClose();
    }
  };

  const handleSetAsAvatar = async (item: MetabotNftListItem) => {
    if (!onSetBotAvatar || item.kind !== 'mrc721') return;
    const ownerAddress = metabot.mvc_address || String(item.raw?.ownerAddress || '');
    const uri = buildNftAvatarUri({
      itemPinId: item.key,
      ownerAddress,
      ownerGlobalMetaId: metabot.globalmetaid ?? undefined,
    });
    if (!uri) return;
    setApplyingAvatarKey(item.key);
    try {
      await onSetBotAvatar(uri);
    } finally {
      setApplyingAvatarKey((curr) => (curr === item.key ? null : curr));
    }
  };

  const handleCopyField = (rowKey: string, val: string) => {
    setCopiedRowKey(rowKey);
    window.setTimeout(() => setCopiedRowKey((curr) => (curr === rowKey ? '' : curr)), 1600);
    copyToClipboard(val, 'tokenTransferTxIdCopied');
  };

  const showHeaderBack = subView.name !== 'browse';
  const headerTitle =
    subView.name === 'transfer'
      ? i18nService.t('metabotNftTransferTitle')
      : subView.name === 'sell'
        ? i18nService.t('metabotNftSellTitle')
        : subView.name === 'buy'
          ? i18nService.t('metabotNftBuyTitle')
          : subView.name === 'myListings'
            ? i18nService.t('metabotNftMyListings')
            : i18nService.t('metabotNftWallet');

  return (
    <div className={METABOT_MODAL_BACKDROP_CLASS} data-slot="metabot-nft-wallet-modal">
      <div className={METABOT_MODAL_SCRIM_CLASS} onClick={onClose} aria-hidden />
      <div
        className={`${METABOT_MODAL_SHELL_CLASS} w-full max-w-[960px] h-[84vh] max-h-[760px]`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={headerTitle}
      >
        {/* Studio Linear Top Bar */}
        <div className={METABOT_MODAL_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2.5">
            {showHeaderBack ? (
              <button
                type="button"
                data-slot="metabot-nft-back"
                onClick={() => setSubView({ name: 'browse' })}
                className={METABOT_ICON_BTN_CLASS}
                aria-label={i18nService.t('back')}
                title={i18nService.t('back')}
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </button>
            ) : (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8]">
                <PhotoIcon className="h-4 w-4" aria-hidden />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {headerTitle}
                </span>
                {subView.name === 'browse' && itemsByKind[kind] != null && (
                  <span className={METABOT_MICRO_BADGE_CLASS}>
                    {rawItems.length}
                  </span>
                )}
              </div>
              <div className="truncate text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                {metabot.name}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {subView.name === 'browse' && kind === 'mrc721' && (
              <>
                <button
                  type="button"
                  data-slot="metabot-nft-open-buy"
                  onClick={() => setSubView({ name: 'buy' })}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  <ClipboardDocumentCheckIcon className="h-3.5 w-3.5 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
                  <span>{i18nService.t('metabotNftBuy')}</span>
                </button>
                <button
                  type="button"
                  data-slot="metabot-nft-open-my-listings"
                  onClick={() => setSubView({ name: 'myListings' })}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  <QueueListIcon className="h-3.5 w-3.5 text-[#5a6577] dark:text-[#94a3b8]" aria-hidden />
                  <span>{i18nService.t('metabotNftMyListings')}</span>
                </button>
              </>
            )}
            {subView.name === 'browse' && (
              <button
                type="button"
                data-slot="metabot-nft-refresh"
                onClick={() => void loadKind(kind)}
                disabled={isRefreshing}
                className={METABOT_ICON_BTN_CLASS}
                aria-label={i18nService.t('metabotNftRefresh')}
                title={i18nService.t('metabotNftRefresh')}
              >
                <ArrowPathIcon className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
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

        {/* Browse Toolbar (Protocol Tabs + View Mode + Search/Filter/Sort) */}
        {subView.name === 'browse' && (
          <div className="border-b border-slate-900/[0.08] dark:border-white/[0.08] bg-white dark:bg-[#141e2e] px-5 py-2.5 shrink-0 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2.5">
              {/* Protocol Switcher */}
              <div className="inline-flex items-center rounded-[8px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f1f5f9] dark:bg-[#0f1724] p-0.5">
                {(
                  [
                    { key: 'mrc721' as const, label: i18nService.t('metabotNftTabMrc721') },
                    { key: 'metacontract' as const, label: i18nService.t('metabotNftTabMetaContract') },
                  ]
                ).map((tab) => {
                  const active = kind === tab.key;
                  const count = itemsByKind[tab.key]?.length;
                  return (
                    <button
                      key={tab.key}
                      type="button"
                      data-slot={`metabot-nft-tab-${tab.key}`}
                      onClick={() => handleSwitchKind(tab.key)}
                      className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12px] font-semibold transition-colors ${
                        active
                          ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                          : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                      }`}
                    >
                      <span>{tab.label}</span>
                      {count != null && (
                        <span className="rounded bg-black/[0.06] dark:bg-white/[0.08] px-1.5 py-0.5 text-[10px] font-bold tabular-nums leading-none">
                          {count}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* View Mode Switcher: Albums (2-level) vs All Items */}
              <div className="inline-flex items-center rounded-[8px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-[#f1f5f9] dark:bg-[#0f1724] p-0.5">
                <button
                  type="button"
                  data-slot="metabot-nft-view-albums"
                  onClick={() => handleSwitchViewMode('albums')}
                  className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    viewMode === 'albums'
                      ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                      : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                  }`}
                >
                  <Squares2X2Icon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('metabotNftViewAlbums')}</span>
                </button>
                <button
                  type="button"
                  data-slot="metabot-nft-view-all"
                  onClick={() => handleSwitchViewMode('all')}
                  className={`inline-flex items-center gap-1.5 rounded-[6px] px-2.5 py-1.5 text-[12px] font-semibold transition-colors ${
                    viewMode === 'all'
                      ? 'bg-white dark:bg-[#1e2d44] text-[#181d25] dark:text-[#f3f5f8] shadow-sm'
                      : 'text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                  }`}
                >
                  <QueueListIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('metabotNftViewAllItems')}</span>
                </button>
              </div>
            </div>

            {/* Search + Verified Filter + Sort + Album Breadcrumb */}
            <div className="flex flex-wrap items-center gap-2">
              {viewMode === 'albums' && activeAlbum && (
                <button
                  type="button"
                  data-slot="metabot-nft-album-back"
                  onClick={() => {
                    setActiveAlbumKey(null);
                    setPage(1);
                  }}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  <ArrowLeftIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('metabotNftBackToAlbums')}</span>
                </button>
              )}

              {viewMode === 'albums' && activeAlbum && (
                <div className="inline-flex min-w-0 items-center gap-1.5 rounded-[7px] border border-slate-900/[0.08] dark:border-white/[0.08] bg-[#f8fafc] dark:bg-[#182538] px-2.5 py-1 text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  <span className="max-w-[180px] truncate">{activeAlbum.title}</span>
                  {activeAlbum.certified && (
                    <CheckBadgeIcon className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
                  )}
                  <span className="text-[11px] font-semibold tabular-nums text-[#5a6577] dark:text-[#94a3b8]">
                    ({activeAlbum.count})
                  </span>
                </div>
              )}

              <div className="relative min-w-[180px] flex-1">
                <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#8c96a6]" aria-hidden />
                <input
                  type="text"
                  data-slot="metabot-nft-search"
                  value={searchQuery}
                  onChange={(event) => {
                    setSearchQuery(event.target.value);
                    setPage(1);
                  }}
                  placeholder={i18nService.t('metabotNftSearchPlaceholder')}
                  className={`${METABOT_CLEAN_INPUT_CLASS} h-8 pl-8 pr-7 py-1 text-[12px]`}
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchQuery('');
                      setPage(1);
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-[#8c96a6] hover:text-[#181d25] dark:hover:text-[#f3f5f8]"
                    aria-label={i18nService.t('clear')}
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>

              {caRegistry?.verified && (
                <button
                  type="button"
                  data-slot="metabot-nft-filter-verified"
                  aria-pressed={verifiedOnly}
                  onClick={() => {
                    setVerifiedOnly((prev) => !prev);
                    setPage(1);
                  }}
                  className={`inline-flex h-8 shrink-0 items-center gap-1 rounded-[7px] border px-2.5 text-[12px] font-semibold transition-colors ${
                    verifiedOnly
                      ? 'border-emerald-500/45 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                      : 'border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#182538] text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                  }`}
                >
                  <CheckBadgeIcon className="h-3.5 w-3.5" aria-hidden />
                  <span>{i18nService.t('metabotNftFilterVerifiedOnly')}</span>
                </button>
              )}

              {!isShelfLevel && (
                <select
                  data-slot="metabot-nft-sort"
                  value={sortBy}
                  onChange={(event) => {
                    setSortBy(event.target.value as MetabotNftSortMode);
                    setPage(1);
                  }}
                  className="h-8 rounded-[7px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#182538] px-2.5 text-[12px] font-semibold text-[#181d25] dark:text-[#f3f5f8] outline-none focus:border-[#d4af1f]"
                >
                  <option value="recent">{i18nService.t('metabotNftSortRecent')}</option>
                  <option value="serial">{i18nService.t('metabotNftSortSerial')}</option>
                  <option value="name">{i18nService.t('metabotNftSortName')}</option>
                </select>
              )}
            </div>
          </div>
        )}

        {/* Body Area */}
        {subView.name === 'browse' && (
          <div className="min-h-0 flex-1 overflow-hidden flex flex-col">
            {isInitialLoading ? (
              <div className="flex flex-1 items-center justify-center p-8">
                <div className="text-[13px] text-[#5a6577] dark:text-[#94a3b8]">
                  {i18nService.t('loading')}
                </div>
              </div>
            ) : currentError && rawItems.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
                <p className="max-w-md text-[13px] text-red-600 dark:text-rose-400">{currentError}</p>
                <button
                  type="button"
                  data-slot="metabot-nft-retry"
                  onClick={() => void loadKind(kind)}
                  className={METABOT_BTN_FLAT_CLASS}
                >
                  {i18nService.t('metabotNftRetry')}
                </button>
              </div>
            ) : rawItems.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-[#eef1f5] dark:bg-white/[0.06] text-[#8c96a6]">
                  <PhotoIcon className="h-5 w-5" />
                </div>
                <div className="text-[13.5px] font-semibold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotNftEmpty')}
                </div>
              </div>
            ) : isShelfLevel ? (
              /* LEVEL 1: Stacked Deck Album Shelf */
              <div className="min-h-0 flex-1 overflow-y-auto p-5">
                {filteredAlbums.length === 0 ? (
                  <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-10 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
                    {i18nService.t('metabotNftEmpty')}
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
                    {filteredAlbums.map((album) => (
                      <button
                        key={album.key}
                        type="button"
                        data-slot="metabot-nft-album-card"
                        onClick={() => {
                          setActiveAlbumKey(album.key);
                          setSelectedKey(album.items[0]?.key ?? null);
                          setPage(1);
                        }}
                        className="group relative text-left pt-2 focus:outline-none"
                      >
                        {/* Stacked deck back layers */}
                        <div className="pointer-events-none absolute inset-x-3 top-0 h-3 rounded-t-[9px] border border-slate-900/[0.09] dark:border-white/[0.09] bg-[#eef1f5] dark:bg-[#1d2b40] transition-transform duration-150 group-hover:-translate-y-0.5" />
                        <div className="pointer-events-none absolute inset-x-1.5 top-1 h-3 rounded-t-[9px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-[#f8fafc] dark:bg-[#19263a]" />

                        {/* Main album cover card */}
                        <div className="relative overflow-hidden rounded-[10px] border border-slate-900/[0.11] dark:border-white/[0.11] bg-white dark:bg-[#182538] transition-[border-color,transform,box-shadow] duration-150 group-hover:-translate-y-0.5 group-hover:border-[#d4af1f] group-hover:shadow-md">
                          <div className="relative aspect-square w-full bg-[#eef1f5] dark:bg-[#0f1724]">
                            <NftArtworkImage
                              sources={album.coverSources}
                              alt={album.title}
                              initials={album.coverInitials}
                              className="h-full w-full"
                            />
                            <div className="absolute left-2 top-2 flex items-center gap-1">
                              <span className="rounded-[5px] bg-slate-950/75 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white backdrop-blur-sm">
                                {album.kind === 'mrc721' ? 'MRC-721' : 'MetaContract'}
                              </span>
                            </div>
                            {album.certified && (
                              <span
                                title={i18nService.t('metabotNftOfficialVerified')}
                                className="absolute right-2 top-2 inline-flex items-center gap-0.5 rounded-[5px] bg-emerald-600/90 px-1.5 py-0.5 text-[10px] font-bold text-white shadow-sm"
                              >
                                <CheckBadgeIcon className="h-3 w-3" aria-hidden />
                                <span>CA</span>
                              </span>
                            )}
                          </div>

                          <div className="p-2.5">
                            <div className="truncate text-[13px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                              {album.title}
                            </div>
                            <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
                              <span className="inline-flex items-center rounded-[5px] bg-[#FFDC51]/35 dark:bg-[#FFDC51]/18 px-1.5 py-0.5 font-bold tabular-nums text-[#24210c] dark:text-[#FFDC51]">
                                {i18nService
                                  .t('metabotNftAlbumHoldCount')
                                  .replace('{count}', String(album.count))}
                              </span>
                              <span className="inline-flex items-center gap-0.5 text-[#5a6577] dark:text-[#94a3b8] tabular-nums">
                                {album.tokenSupply
                                  ? i18nService
                                      .t('metabotNftAlbumSupply')
                                      .replace('{supply}', String(album.tokenSupply))
                                  : ''}
                                <ChevronRightIcon className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" />
                              </span>
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              /* LEVEL 2 / ALL ITEMS: Master-Detail Split (Left Grid + Pagination, Right Inspector Drawer) */
              <div className="min-h-0 flex-1 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_316px] overflow-hidden">
                {/* Left Column: Tile Grid + Bottom Pagination */}
                <div className="min-h-0 flex flex-col border-r border-slate-900/[0.08] dark:border-white/[0.08] overflow-hidden">
                  <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    {pagination.items.length === 0 ? (
                      <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} px-4 py-10 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
                        {i18nService.t('metabotNftEmpty')}
                      </div>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                        {pagination.items.map((item) => {
                          const vm = buildNftTileViewModel(item);
                          const isSelected = inspectedItem?.key === item.key;
                          const isCertified = isNftItemCertified(caRegistry, item);
                          const isCurrentAvatar =
                            item.kind === 'mrc721' &&
                            Boolean(activeAvatarPinId) &&
                            item.key.toLowerCase() === activeAvatarPinId;

                          return (
                            <button
                              key={item.key}
                              type="button"
                              data-slot="metabot-nft-tile"
                              aria-pressed={isSelected}
                              onClick={() => setSelectedKey(item.key)}
                              className={`group overflow-hidden rounded-[10px] border text-left transition-[border-color,box-shadow,transform] duration-150 focus:outline-none ${
                                isSelected
                                  ? 'border-[#d4af1f] ring-2 ring-[#FFDC51]/55 bg-[#FFDC51]/[0.07] dark:border-[#FFDC51] dark:ring-[#FFDC51]/30 dark:bg-[#FFDC51]/[0.06]'
                                  : 'border-slate-900/[0.095] dark:border-white/[0.095] bg-white dark:bg-[#182538] hover:border-slate-900/[0.22] dark:hover:border-white/[0.22]'
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
                                  <span className="absolute left-1.5 top-1.5 rounded-[5px] bg-slate-950/75 px-1.5 py-0.5 font-mono text-[10px] font-bold tabular-nums text-white backdrop-blur-sm">
                                    {vm.badge}
                                  </span>
                                )}
                                {isCurrentAvatar && (
                                  <span
                                    className="absolute right-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-[5px] bg-[#FFDC51] px-1.5 py-0.5 text-[10px] font-bold text-[#24210c] shadow-sm"
                                    title={i18nService.t('metabotNftCurrentBotAvatar')}
                                  >
                                    <SparklesIcon className="h-3 w-3" aria-hidden />
                                    <span>Avatar</span>
                                  </span>
                                )}
                                {!isCurrentAvatar && isCertified && (
                                  <span className="absolute right-1.5 top-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full bg-emerald-600/90 text-white shadow-sm">
                                    <CheckBadgeIcon className="h-3.5 w-3.5" aria-hidden />
                                  </span>
                                )}
                              </div>
                              <div className="px-2.5 py-2">
                                <div className="truncate text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                                  {vm.title}
                                </div>
                                {vm.subtitle && (
                                  <div className="mt-0.5 truncate text-[11px] text-[#5a6577] dark:text-[#94a3b8]">
                                    {vm.subtitle}
                                  </div>
                                )}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  {/* Pagination Bar */}
                  <div
                    data-slot="metabot-nft-pagination"
                    className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-900/[0.08] dark:border-white/[0.08] bg-[#f8fafc] dark:bg-[#182538] px-4 py-2 shrink-0"
                  >
                    <div className="flex items-center gap-2 text-[11.5px] text-[#5a6577] dark:text-[#94a3b8] tabular-nums">
                      <span>
                        {i18nService
                          .t('metabotNftPaginationSummary')
                          .replace('{total}', String(pagination.totalItems))
                          .replace('{page}', String(pagination.page))
                          .replace('{pages}', String(pagination.totalPages))}
                      </span>
                      <select
                        data-slot="metabot-nft-page-size"
                        value={pageSize}
                        onChange={(event) => {
                          setPageSize(Number(event.target.value));
                          setPage(1);
                        }}
                        className="h-6 rounded-[5px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] px-1.5 text-[11px] font-semibold text-[#181d25] dark:text-[#f3f5f8] outline-none"
                      >
                        {PAGE_SIZE_OPTIONS.map((sizeOpt) => (
                          <option key={sizeOpt} value={sizeOpt}>
                            {i18nService
                              .t('metabotNftPageSizeUnit')
                              .replace('{size}', String(sizeOpt))}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        disabled={pagination.page <= 1}
                        onClick={() => setPage((p) => Math.max(1, p - 1))}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.08] disabled:opacity-40"
                        aria-label={i18nService.t('metabotNftPrevPage')}
                      >
                        <ChevronLeftIcon className="h-3.5 w-3.5" />
                      </button>

                      {buildPaginationTokens(pagination.page, pagination.totalPages).map((token) => {
                        if (typeof token !== 'number') {
                          return (
                            <span key={token} className="px-1 text-[11px] text-[#8c96a6]">
                              …
                            </span>
                          );
                        }
                        const active = token === pagination.page;
                        return (
                          <button
                            key={token}
                            type="button"
                            onClick={() => setPage(token)}
                            className={`inline-flex h-6 min-w-[24px] items-center justify-center rounded-[5px] px-1.5 text-[11px] font-bold tabular-nums transition-colors ${
                              active
                                ? 'bg-[#FFDC51] text-[#24210c] border border-black/[0.12]'
                                : 'border border-slate-900/[0.09] dark:border-white/[0.09] bg-white dark:bg-[#141e2e] text-[#5a6577] dark:text-[#94a3b8] hover:text-[#181d25] dark:hover:text-[#f3f5f8]'
                            }`}
                          >
                            {token}
                          </button>
                        );
                      })}

                      <button
                        type="button"
                        disabled={pagination.page >= pagination.totalPages}
                        onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-[5px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] text-[#181d25] dark:text-[#f3f5f8] hover:bg-[#eef1f5] dark:hover:bg-white/[0.08] disabled:opacity-40"
                        aria-label={i18nService.t('metabotNftNextPage')}
                      >
                        <ChevronRightIcon className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>

                {/* Right Persistent Inspector Drawer */}
                <aside
                  data-slot="metabot-nft-detail"
                  className="min-h-0 flex flex-col bg-[#f8fafc] dark:bg-[#101826] overflow-y-auto p-4"
                >
                  {!inspectedItem ? (
                    <div className="flex flex-1 flex-col items-center justify-center text-center text-[12px] text-[#5a6577] dark:text-[#94a3b8] px-3">
                      <PhotoIcon className="mb-2 h-6 w-6 opacity-40" />
                      <p>{i18nService.t('metabotNftInspectorEmpty')}</p>
                    </div>
                  ) : (
                    (() => {
                      const vm = buildNftTileViewModel(inspectedItem);
                      const detailRows = buildNftDetailRows(inspectedItem);
                      const isCertified = isNftItemCertified(caRegistry, inspectedItem);
                      const isCurrentAvatar =
                        inspectedItem.kind === 'mrc721' &&
                        Boolean(activeAvatarPinId) &&
                        inspectedItem.key.toLowerCase() === activeAvatarPinId;
                      const isApplyingThis = applyingAvatarKey === inspectedItem.key;

                      return (
                        <div className="space-y-3.5">
                          <div className="relative overflow-hidden rounded-[10px] border border-slate-900/[0.10] dark:border-white/[0.10] bg-white dark:bg-[#141e2e] aspect-square w-full">
                            <NftArtworkImage
                              sources={vm.artworkSources}
                              alt={vm.title}
                              initials={vm.artworkInitials}
                              className="h-full w-full"
                            />
                            {vm.badge && (
                              <span className="absolute left-2 top-2 rounded-[5px] bg-slate-950/75 px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums text-white backdrop-blur-sm">
                                {vm.badge}
                              </span>
                            )}
                            {isCertified && (
                              <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-[5px] bg-emerald-600/90 px-2 py-0.5 text-[10.5px] font-bold text-white shadow-sm">
                                <CheckBadgeIcon className="h-3.5 w-3.5" aria-hidden />
                                <span>{i18nService.t('metabotNftOfficialVerified')}</span>
                              </span>
                            )}
                          </div>

                          <div>
                            <h4 className="text-[14px] font-bold text-[#181d25] dark:text-[#f3f5f8] break-words">
                              {vm.title}
                            </h4>
                            {vm.subtitle && (
                              <div className="mt-0.5 text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                                {vm.subtitle}
                              </div>
                            )}
                          </div>

                          {/* Primary & Secondary Actions */}
                          <div className="space-y-2">
                            {inspectedItem.kind === 'mrc721' && onSetBotAvatar && (
                              <button
                                type="button"
                                data-slot="metabot-nft-set-avatar"
                                disabled={isApplyingThis || isCurrentAvatar}
                                onClick={() => void handleSetAsAvatar(inspectedItem)}
                                className={`w-full ${isCurrentAvatar ? METABOT_BTN_FLAT_CLASS : METABOT_BTN_PRIMARY_CLASS}`}
                              >
                                <SparklesIcon className="h-3.5 w-3.5" aria-hidden />
                                <span>
                                  {isApplyingThis
                                    ? i18nService.t('metabotNftSettingBotAvatar')
                                    : isCurrentAvatar
                                      ? i18nService.t('metabotNftCurrentBotAvatar')
                                      : i18nService.t('metabotNftSetAsBotAvatar')}
                                </span>
                              </button>
                            )}

                            <div className="grid grid-cols-2 gap-1.5">
                              <button
                                type="button"
                                data-slot="metabot-nft-send-to-chat"
                                onClick={() => handleSendToChat(inspectedItem)}
                                className={`w-full ${METABOT_BTN_FLAT_CLASS}`}
                              >
                                <ChatBubbleLeftRightIcon className="h-3.5 w-3.5" aria-hidden />
                                <span className="truncate">{i18nService.t('metabotNftSendToChat')}</span>
                              </button>

                              <button
                                type="button"
                                data-slot="metabot-nft-open-transfer"
                                onClick={() => setSubView({ name: 'transfer', item: inspectedItem })}
                                className={`w-full ${METABOT_BTN_FLAT_CLASS}`}
                              >
                                <PaperAirplaneIcon className="h-3.5 w-3.5 -rotate-12" aria-hidden />
                                <span className="truncate">{i18nService.t('metabotNftTransfer')}</span>
                              </button>
                            </div>

                            {inspectedItem.kind === 'mrc721' && (
                              <button
                                type="button"
                                data-slot="metabot-nft-open-sell"
                                onClick={() => setSubView({ name: 'sell', item: inspectedItem })}
                                className={`w-full ${METABOT_BTN_FLAT_CLASS}`}
                              >
                                <TagIcon className="h-3.5 w-3.5" aria-hidden />
                                <span>{i18nService.t('metabotNftSell')}</span>
                              </button>
                            )}
                          </div>

                          {/* Metadata Table */}
                          <div className={`${METABOT_GROUP_BOX_CLASS} text-[11.5px]`}>
                            {detailRows.map((row) => {
                              const rowId = `${inspectedItem.key}:${row.labelKey}`;
                              const isCopied = copiedRowKey === rowId;
                              return (
                                <div key={row.labelKey} className="px-3 py-2">
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="text-[10.5px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                                      {i18nService.t(row.labelKey)}
                                    </span>
                                    {row.mono && (
                                      <button
                                        type="button"
                                        onClick={() => handleCopyField(rowId, row.value)}
                                        className="inline-flex h-5 w-5 items-center justify-center rounded text-[#5a6577] hover:bg-[#eef1f5] hover:text-[#181d25] dark:text-[#94a3b8] dark:hover:bg-white/[0.08] dark:hover:text-[#f3f5f8]"
                                        aria-label={i18nService.t('metabotCopyAddress')}
                                      >
                                        {isCopied ? (
                                          <CheckIcon className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
                                        ) : (
                                          <DocumentDuplicateIcon className="h-3 w-3" />
                                        )}
                                      </button>
                                    )}
                                  </div>
                                  <div
                                    className={`mt-0.5 break-all text-[#181d25] dark:text-[#f3f5f8] ${
                                      row.mono ? 'font-mono text-[11px]' : 'font-medium'
                                    }`}
                                  >
                                    {row.value}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()
                  )}
                </aside>
              </div>
            )}
          </div>
        )}

        {/* Sub-view: Transfer */}
        {subView.name === 'transfer' && (
          <NftTransferSubView
            metabot={metabot}
            item={subView.item}
            onDone={() => {
              setSubView({ name: 'browse' });
              void loadKind(subView.item.kind);
            }}
            onCancel={() => setSubView({ name: 'browse' })}
          />
        )}

        {/* Sub-view: MRC-721 Direct Sell */}
        {subView.name === 'sell' && (
          <Mrc721SellSubView
            metabot={metabot}
            item={subView.item}
            onDone={() => {
              setSubView({ name: 'browse' });
              void loadKind('mrc721');
            }}
            onCancel={() => setSubView({ name: 'browse' })}
          />
        )}

        {/* Sub-view: Paste Listing Buy */}
        {subView.name === 'buy' && (
          <Mrc721BuySubView
            metabot={metabot}
            onDone={() => {
              setSubView({ name: 'browse' });
              void loadKind('mrc721');
            }}
            onCancel={() => setSubView({ name: 'browse' })}
          />
        )}

        {/* Sub-view: My Listings */}
        {subView.name === 'myListings' && (
          <Mrc721MyListingsSubView
            metabot={metabot}
            onBack={() => {
              setSubView({ name: 'browse' });
              void loadKind('mrc721');
            }}
          />
        )}
      </div>
    </div>
  );
};

/* ---------- Sub-View 1: On-Chain NFT Transfer ---------- */

const NftTransferSubView: React.FC<{
  metabot: Metabot;
  item: MetabotNftListItem;
  onDone: () => void;
  onCancel: () => void;
}> = ({ metabot, item, onDone, onCancel }) => {
  const vm = buildNftTileViewModel(item);
  const [toAddress, setToAddress] = useState('');
  const [feeRate, setFeeRate] = useState<number>(1);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [txId, setTxId] = useState('');

  const handleSubmit = async () => {
    setError('');
    const check = validateNftTransferDraft({ toAddress });
    if (!check.valid) {
      setError(i18nService.t(check.errorKey));
      return;
    }
    setSubmitting(true);
    try {
      const payload = buildNftTransferPayload({
        metabotId: metabot.id,
        item,
        toAddress,
        feeRate: Number.isFinite(feeRate) && feeRate > 0 ? feeRate : 1,
      });
      const res =
        item.kind === 'metacontract'
          ? await window.electron.idbots.transferMetabotMvcNft(
              payload as Parameters<typeof window.electron.idbots.transferMetabotMvcNft>[0],
            )
          : await window.electron.idbots.transferMetabotMrc721(
              payload as Parameters<typeof window.electron.idbots.transferMetabotMrc721>[0],
            );
      if (!res.success || !res.result?.txId) {
        setError(res.error || i18nService.t('transferFailed'));
        return;
      }
      setTxId(res.result.txId);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('transferFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[500px] space-y-4">
          <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center gap-3 p-3`}>
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09]">
              <NftArtworkImage sources={vm.artworkSources} alt={vm.title} initials={vm.artworkInitials} className="h-full w-full" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                {vm.title}
              </div>
              <div className="mt-0.5 truncate text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                {vm.subtitle} {vm.badge}
              </div>
            </div>
          </div>

          {txId ? (
            <div data-slot="metabot-nft-transfer-receipt" className={`${METABOT_GROUP_BOX_CLASS} p-4 space-y-3`}>
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircleIcon className="h-5 w-5" />
                <span className="text-[14px] font-bold">{i18nService.t('transferSuccess')}</span>
              </div>
              <div className="space-y-1">
                <div className="text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">TxID</div>
                <code
                  data-slot="metabot-nft-transfer-txid"
                  className="block break-all rounded-[7px] bg-[#f8fafc] dark:bg-[#0f1724] p-2.5 font-mono text-[11.5px] text-[#181d25] dark:text-[#f3f5f8]"
                >
                  {txId}
                </code>
              </div>
              <button
                type="button"
                onClick={() => copyToClipboard(txId, 'tokenTransferTxIdCopied')}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                <span>{i18nService.t('metabotCopyAddress')}</span>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-[8px] border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <span>{i18nService.t('metabotNftTransferWarning')}</span>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('transferReceiver')} (MVC)
                </label>
                <input
                  type="text"
                  data-slot="metabot-nft-transfer-to"
                  value={toAddress}
                  onChange={(event) => setToAddress(event.target.value)}
                  placeholder={i18nService.t('transferReceiverPlaceholder')}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2`}
                />
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('transferFeeRate')} (sat/vB)
                </label>
                <input
                  type="number"
                  min={1}
                  step={1}
                  data-slot="metabot-nft-transfer-fee-rate"
                  value={feeRate}
                  onChange={(event) => setFeeRate(Number(event.target.value) || 1)}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2 max-w-[160px]`}
                />
              </div>

              {error && (
                <div
                  data-slot="metabot-nft-transfer-error"
                  className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400"
                >
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={METABOT_MODAL_FOOTER_CLASS}>
        {txId ? (
          <div className="flex w-full justify-end">
            <button type="button" onClick={onDone} className={METABOT_BTN_PRIMARY_CLASS}>
              {i18nService.t('close')}
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onCancel} disabled={submitting} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              data-slot="metabot-nft-transfer-submit"
              disabled={submitting}
              onClick={() => void handleSubmit()}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {submitting ? i18nService.t('loading') : i18nService.t('metabotNftTransfer')}
            </button>
          </>
        )}
      </div>
    </>
  );
};

/* ---------- Sub-View 2: MRC-721 Atomic-Swap Direct Sell ---------- */

const Mrc721SellSubView: React.FC<{
  metabot: Metabot;
  item: MetabotNftListItem;
  onDone: () => void;
  onCancel: () => void;
}> = ({ metabot, item, onDone, onCancel }) => {
  const vm = buildNftTileViewModel(item);
  const [priceSats, setPriceSats] = useState(String(MRC721_MIN_SELL_PRICE_SATS));
  const [buyerAddress, setBuyerAddress] = useState('');
  const [localBots, setLocalBots] = useState<Array<{ id: number; name: string; mvc_address: string }>>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [listingJson, setListingJson] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electron?.idbots
      ?.getMetaBots?.()
      .then((res) => {
        if (cancelled || !res?.success || !Array.isArray(res.list)) return;
        setLocalBots(
          (res.list as Array<{ id: number; name: string; mvc_address?: string }>)
            .map((b) => ({
              id: Number(b.id),
              name: String(b.name ?? ''),
              mvc_address: String(b.mvc_address ?? '').trim(),
            }))
            .filter((b) => b.id !== metabot.id && Boolean(b.mvc_address)),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [metabot.id]);

  const handleCreateListing = async () => {
    setError('');
    const parsedPrice = Number(priceSats.trim());
    const check = validateMrc721SellDraft({ priceSats: parsedPrice, buyerAddress });
    if (!check.valid) {
      setError(i18nService.t(check.errorKey));
      return;
    }
    setSubmitting(true);
    try {
      const res = await window.electron.idbots.sellMrc721Listing({
        metabotId: metabot.id,
        itemPinId: String(item.key || ''),
        priceSats: parsedPrice,
        buyerAddress: buyerAddress.trim(),
      });
      if (!res.success || !res.result?.listingJson) {
        setError(res.error || i18nService.t('metabotNftSellFailed'));
        return;
      }
      setListingJson(res.result.listingJson);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotNftSellFailed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[520px] space-y-4">
          <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} flex items-center gap-3 p-3`}>
            <div className="h-14 w-14 shrink-0 overflow-hidden rounded-[8px] border border-slate-900/[0.08] dark:border-white/[0.09]">
              <NftArtworkImage sources={vm.artworkSources} alt={vm.title} initials={vm.artworkInitials} className="h-full w-full" />
            </div>
            <div className="min-w-0">
              <div className="truncate text-[13.5px] font-bold text-[#181d25] dark:text-[#f3f5f8]">{vm.title}</div>
              <div className="mt-0.5 truncate text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                {vm.subtitle} {vm.badge}
              </div>
            </div>
          </div>

          {listingJson ? (
            <div data-slot="metabot-nft-sell-created" className={`${METABOT_GROUP_BOX_CLASS} p-4 space-y-3`}>
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircleIcon className="h-5 w-5" />
                <span className="text-[14px] font-bold">{i18nService.t('metabotNftSellSuccessTitle')}</span>
              </div>
              <p className="text-[12px] text-[#5a6577] dark:text-[#94a3b8]">
                {i18nService.t('metabotNftSellNotBroadcastHint')}
              </p>
              <label className="block text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                {i18nService.t('metabotNftSellListingJsonLabel')}
              </label>
              <textarea
                readOnly
                rows={5}
                data-slot="metabot-nft-sell-code"
                value={listingJson}
                className={`${METABOT_CLEAN_INPUT_CLASS} font-mono text-[11px]`}
              />
              <button
                type="button"
                data-slot="metabot-nft-sell-copy"
                onClick={() => copyToClipboard(listingJson, 'tokenTransferTxIdCopied')}
                className={METABOT_BTN_PRIMARY_CLASS}
              >
                <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                <span>{i18nService.t('copy')}</span>
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-start gap-2 rounded-[8px] border border-amber-500/30 bg-amber-500/[0.08] px-3 py-2 text-[12px] text-amber-800 dark:text-amber-300">
                <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
                <span>{i18nService.t('metabotNftSellWarning')}</span>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotNftSellPriceLabel')}
                </label>
                <input
                  type="number"
                  min={MRC721_MIN_SELL_PRICE_SATS}
                  step={1000}
                  data-slot="metabot-nft-sell-price"
                  value={priceSats}
                  onChange={(event) => setPriceSats(event.target.value)}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2`}
                />
                <div className="mt-1 flex items-center justify-between text-[11.5px] text-[#5a6577] dark:text-[#94a3b8] tabular-nums">
                  <span>{i18nService.t('metabotNftSellPriceFloorHint')}</span>
                  {Number.isFinite(Number(priceSats)) && Number(priceSats) > 0 && (
                    <span>≈ {formatSatsSpace(Number(priceSats))}</span>
                  )}
                </div>
              </div>

              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotNftSellBuyerLabel')}
                </label>
                <input
                  type="text"
                  data-slot="metabot-nft-sell-buyer"
                  value={buyerAddress}
                  onChange={(event) => setBuyerAddress(event.target.value)}
                  placeholder={i18nService.t('transferReceiverPlaceholder')}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono py-2`}
                />
                {localBots.length > 0 && (
                  <div className="mt-2">
                    <label className="mb-1 block text-[11px] font-semibold text-[#5a6577] dark:text-[#94a3b8]">
                      {i18nService.t('metabotNftSellBuyerPickLabel')}
                    </label>
                    <select
                      value=""
                      onChange={(event) => {
                        if (event.target.value) setBuyerAddress(event.target.value);
                      }}
                      className={`${METABOT_CLEAN_INPUT_CLASS} py-1.5 text-[12px]`}
                    >
                      <option value="">{i18nService.t('metabotNftSellBuyerPickPlaceholder')}</option>
                      {localBots.map((bot) => (
                        <option key={bot.id} value={bot.mvc_address}>
                          {bot.name} ({bot.mvc_address.slice(0, 8)}...{bot.mvc_address.slice(-6)})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>

              {error && (
                <div
                  data-slot="metabot-nft-sell-error"
                  className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400"
                >
                  {error}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={METABOT_MODAL_FOOTER_CLASS}>
        {listingJson ? (
          <div className="flex w-full justify-end">
            <button type="button" onClick={onDone} className={METABOT_BTN_PRIMARY_CLASS}>
              {i18nService.t('close')}
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onCancel} disabled={submitting} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              data-slot="metabot-nft-sell-submit"
              disabled={submitting}
              onClick={() => void handleCreateListing()}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {submitting ? i18nService.t('loading') : i18nService.t('metabotNftSell')}
            </button>
          </>
        )}
      </div>
    </>
  );
};

/* ---------- Sub-View 3: Paste Listing Buy ---------- */

const Mrc721BuySubView: React.FC<{
  metabot: Metabot;
  onDone: () => void;
  onCancel: () => void;
}> = ({ metabot, onDone, onCancel }) => {
  const [listingText, setListingText] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState('');
  const [verifiedListing, setVerifiedListing] = useState<Mrc721ListingSummary | null>(null);
  const [buyResult, setBuyResult] = useState<Mrc721BuyResult | null>(null);

  const buyerMismatch = Boolean(
    verifiedListing &&
      metabot.mvc_address &&
      verifiedListing.buyerAddress &&
      verifiedListing.buyerAddress !== metabot.mvc_address,
  );

  const handleVerify = async () => {
    setError('');
    setVerifiedListing(null);
    const trimmed = listingText.trim();
    if (!trimmed) {
      setError(i18nService.t('metabotNftBuyPasteRequired'));
      return;
    }
    setVerifying(true);
    try {
      const res = await window.electron.idbots.verifyMrc721Listing({ listing: trimmed });
      if (!res.success || !res.result) {
        setError(res.error || i18nService.t('metabotNftBuyVerifiedFailed'));
        return;
      }
      if (!res.result.ok || !res.result.listing) {
        setError(
          [res.result.check, res.result.error].filter(Boolean).join(': ') ||
            i18nService.t('metabotNftBuyVerifiedFailed'),
        );
        return;
      }
      setVerifiedListing(res.result.listing);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotNftBuyVerifiedFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const handleBuy = async () => {
    if (!verifiedListing || buyerMismatch) return;
    setError('');
    setBuying(true);
    try {
      const res = await window.electron.idbots.buyMrc721Listing({
        metabotId: metabot.id,
        listing: listingText.trim(),
      });
      if (!res.success || !res.result) {
        setError(res.error || i18nService.t('metabotNftBuyFailed'));
        return;
      }
      setBuyResult(res.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotNftBuyFailed'));
    } finally {
      setBuying(false);
    }
  };

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <div className="mx-auto max-w-[540px] space-y-4">
          {buyResult ? (
            <div data-slot="metabot-nft-buy-receipt" className={`${METABOT_GROUP_BOX_CLASS} p-4 space-y-3`}>
              <div className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
                <CheckCircleIcon className="h-5 w-5" />
                <span className="text-[14px] font-bold">{i18nService.t('metabotNftBuySuccessTitle')}</span>
              </div>
              <div className="grid grid-cols-2 gap-2 text-[12px]">
                <div className="text-[#5a6577] dark:text-[#94a3b8]">{i18nService.t('metabotNftBuyPriceLabel')}</div>
                <div className="text-right font-mono font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                  {formatSatsSpace(buyResult.priceSats)}
                </div>
                <div className="text-[#5a6577] dark:text-[#94a3b8]">{i18nService.t('metabotNftBuyFeeLabel')}</div>
                <div className="text-right font-mono tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                  {buyResult.feeSats} sats ({buyResult.feeRateEffective.toFixed(2)} sat/vB)
                </div>
              </div>
              <code
                data-slot="metabot-nft-buy-txid"
                className="block break-all rounded-[7px] bg-[#f8fafc] dark:bg-[#0f1724] p-2.5 font-mono text-[11.5px] text-[#181d25] dark:text-[#f3f5f8]"
              >
                {buyResult.txId}
              </code>
              <button
                type="button"
                onClick={() => copyToClipboard(buyResult.txId, 'tokenTransferTxIdCopied')}
                className={METABOT_BTN_FLAT_CLASS}
              >
                <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                <span>{i18nService.t('metabotCopyAddress')}</span>
              </button>
            </div>
          ) : (
            <>
              <div>
                <label className="mb-1.5 block text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                  {i18nService.t('metabotNftBuyPasteLabel')}
                </label>
                <textarea
                  rows={5}
                  data-slot="metabot-nft-buy-code"
                  value={listingText}
                  onChange={(event) => {
                    setListingText(event.target.value);
                    setVerifiedListing(null);
                  }}
                  placeholder={i18nService.t('metabotNftBuyPastePlaceholder')}
                  className={`${METABOT_CLEAN_INPUT_CLASS} font-mono text-[11.5px]`}
                />
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    data-slot="metabot-nft-buy-parse"
                    disabled={verifying}
                    onClick={() => void handleVerify()}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    {verifying ? i18nService.t('metabotNftBuyVerifying') : i18nService.t('metabotNftBuyVerify')}
                  </button>
                </div>
              </div>

              {verifiedListing && (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 rounded-[8px] border border-emerald-500/35 bg-emerald-500/[0.08] px-3 py-2 text-[12px] font-semibold text-emerald-700 dark:text-emerald-300">
                    <CheckCircleIcon className="h-4 w-4 shrink-0" />
                    <span>{i18nService.t('metabotNftBuyVerifiedOk')}</span>
                  </div>

                  {buyerMismatch && (
                    <div className="flex items-start gap-2 rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400">
                      <ExclamationTriangleIcon className="mt-0.5 h-4 w-4 shrink-0" />
                      <span>{i18nService.t('metabotNftBuyBuyerMismatchWarning')}</span>
                    </div>
                  )}

                  <div data-slot="metabot-nft-buy-preview" className={`${METABOT_GROUP_BOX_CLASS} text-[12px]`}>
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-[#5a6577] dark:text-[#94a3b8]">Pin ID</span>
                      <code className="truncate font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                        {verifiedListing.itemPinId}
                      </code>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-[#5a6577] dark:text-[#94a3b8]">{i18nService.t('metabotNftBuyPriceLabel')}</span>
                      <span className="font-mono font-bold tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                        {formatSatsSpace(verifiedListing.priceSats)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-[#5a6577] dark:text-[#94a3b8]">{i18nService.t('metabotNftBuySellerLabel')}</span>
                      <code className="truncate font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                        {verifiedListing.sellerAddress}
                      </code>
                    </div>
                    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
                      <span className="text-[#5a6577] dark:text-[#94a3b8]">{i18nService.t('metabotNftBuyBuyerLabel')}</span>
                      <code className="truncate font-mono text-[11px] text-[#181d25] dark:text-[#f3f5f8]">
                        {verifiedListing.buyerAddress}
                      </code>
                    </div>
                  </div>

                  <p className="text-[11.5px] text-[#5a6577] dark:text-[#94a3b8]">
                    {i18nService.t('metabotNftBuyWarning')}
                  </p>
                </div>
              )}

              {error && (
                <div
                  data-slot="metabot-nft-buy-error"
                  className="rounded-[8px] border border-rose-500/35 bg-rose-500/[0.08] px-3 py-2 text-[12px] text-red-600 dark:text-rose-400"
                >
                  {error}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div className={METABOT_MODAL_FOOTER_CLASS}>
        {buyResult ? (
          <div className="flex w-full justify-end">
            <button type="button" onClick={onDone} className={METABOT_BTN_PRIMARY_CLASS}>
              {i18nService.t('close')}
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onCancel} disabled={buying} className={METABOT_BTN_FLAT_CLASS}>
              {i18nService.t('cancel')}
            </button>
            <button
              type="button"
              data-slot="metabot-nft-buy-submit"
              disabled={!verifiedListing || buyerMismatch || buying}
              onClick={() => void handleBuy()}
              className={METABOT_BTN_PRIMARY_CLASS}
            >
              {buying ? i18nService.t('loading') : i18nService.t('metabotNftBuy')}
            </button>
          </>
        )}
      </div>
    </>
  );
};

/* ---------- Sub-View 4: My Listings ---------- */

const Mrc721MyListingsSubView: React.FC<{
  metabot: Metabot;
  onBack: () => void;
}> = ({ metabot, onBack }) => {
  const [orders, setOrders] = useState<Mrc721SellOrderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await window.electron.idbots.listMrc721SellOrders({ metabotId: metabot.id });
      if (!res.success || !res.orders) {
        setError(res.error || i18nService.t('metabotNftLoadFailed'));
        setOrders([]);
        return;
      }
      setOrders(res.orders);
    } catch (err) {
      setError(err instanceof Error ? err.message : i18nService.t('metabotNftLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [metabot.id]);

  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="py-12 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]">
            {i18nService.t('loading')}
          </div>
        ) : error ? (
          <div className="rounded-[10px] border border-rose-500/35 bg-rose-500/[0.08] p-4 text-center text-[12.5px] text-red-600 dark:text-rose-400">
            {error}
          </div>
        ) : orders.length === 0 ? (
          <div className={`${METABOT_MODAL_SUBSURFACE_CLASS} py-12 text-center text-[13px] text-[#5a6577] dark:text-[#94a3b8]`}>
            {i18nService.t('metabotNftMyListingsEmpty')}
          </div>
        ) : (
          <div data-slot="metabot-nft-listings-list" className={METABOT_GROUP_BOX_CLASS}>
            {orders.map((order) => {
              const statusKey = mrc721SellOrderStatusKey(order.status);
              return (
                <div
                  key={order.id}
                  data-slot="metabot-nft-listing-row"
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="truncate font-mono text-[12px] font-bold text-[#181d25] dark:text-[#f3f5f8]">
                        {order.itemPinId}
                      </code>
                      <span
                        data-slot="metabot-nft-listing-status"
                        className={`rounded-[5px] px-1.5 py-0.5 text-[10.5px] font-bold ${
                          order.status === 'valid'
                            ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400'
                            : 'bg-[#eef1f5] text-[#5a6577] dark:bg-white/[0.08] dark:text-[#94a3b8]'
                        }`}
                      >
                        {i18nService.t(statusKey)}
                      </span>
                    </div>
                    <div className="text-[12px] font-mono tabular-nums text-[#181d25] dark:text-[#f3f5f8]">
                      {formatSatsSpace(order.priceSats)}
                    </div>
                    <div className="text-[11px] font-mono text-[#5a6577] dark:text-[#94a3b8] truncate">
                      {i18nService.t('metabotNftListingBuyerLabel')}: {order.buyerAddress}
                    </div>
                    {order.reason && (
                      <div className="text-[11px] text-[#8c96a6] dark:text-[#64748b]">{order.reason}</div>
                    )}
                  </div>

                  <button
                    type="button"
                    data-slot="metabot-nft-listing-copy"
                    onClick={() => copyToClipboard(order.itemPinId, 'tokenTransferTxIdCopied')}
                    className={METABOT_BTN_FLAT_CLASS}
                  >
                    <DocumentDuplicateIcon className="h-3.5 w-3.5" />
                    <span>Pin ID</span>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className={METABOT_MODAL_FOOTER_CLASS}>
        <button type="button" onClick={onBack} className={METABOT_BTN_FLAT_CLASS}>
          {i18nService.t('back')}
        </button>
        <button type="button" onClick={() => void loadOrders()} className={METABOT_BTN_FLAT_CLASS}>
          <ArrowPathIcon className="h-3.5 w-3.5" />
          <span>{i18nService.t('metabotNftRefresh')}</span>
        </button>
      </div>
    </>
  );
};

export default MetaBotNftWalletModal;
