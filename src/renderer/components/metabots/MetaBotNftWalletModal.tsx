/**
 * MetaBot NFT Wallet Modal
 *
 * Opened from the Advanced tab's Chain & Wallet card ("NFT Wallet" button
 * beside the Wallet button). Two tabs — MRC721 (pin-based MetaID NFTs) and
 * MetaContract (sensible-contract MVC NFTs) — each showing the bot's
 * holdings as an image tile grid ordered by acquisition time (mint time for
 * MRC721, acquiring-tx height for MetaContract), name above collection
 * name. Clicking a tile opens an in-modal detail view (referencing the
 * Metalet wallet's detail fields) with a Transfer entry that reuses the
 * existing transfer services end to end.
 *
 * Artwork rendering walks the same ordered content routes as the chat
 * NftCard (https direct → metafile accelerate → indexer content) and falls
 * back to an initials placeholder, so a tile never shows a broken image.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  DocumentDuplicateIcon,
  PhotoIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { i18nService } from '../../services/i18n';
import type { Metabot } from '../../types/metabot';
import {
  buildNftDetailRows,
  buildNftTileViewModel,
  buildNftTransferPayload,
  MRC721_MIN_SELL_PRICE_SATS,
  mrc721SellOrderStatusKey,
  validateMrc721SellDraft,
  validateNftTransferDraft,
} from './metabotNftPresentation.js';
import { NftArtworkImage } from './NftArtworkImage';

type NftKind = 'mrc721' | 'metacontract';

interface NftListItem {
  kind: NftKind;
  key: string;
  name: string;
  collectionName: string;
  imageRef?: string;
  imageUrl?: string;
  number?: number;
  tokenIndex?: string;
  createTime?: number;
  height?: number;
  raw: Record<string, unknown> & {
    genesis?: string;
    codeHash?: string;
    satoshi?: number;
    txId?: string;
    metaTxId?: string;
    ownerAddress?: string;
    desc?: string;
    genesisChainName?: string;
    genesisTx?: string;
    contentType?: string;
    contentSummary?: string;
    outputValue?: number;
    transferCount?: number;
  };
}

interface TabState {
  loading: boolean;
  error: string;
  items: NftListItem[];
}

interface FeeOption {
  title: string;
  desc: string;
  feeRate: number;
}

/** Verified-listing summary (idbots:verifyMrc721Listing ok:true). */
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

/** One local sell-order record (idbots:listMrc721SellOrders). */
interface Mrc721SellOrderRow {
  id: string;
  status: 'valid' | 'invalid' | 'expired';
  reason?: string;
  itemPinId: string;
  buyerAddress: string;
  priceSats: number;
  outpoint: string;
}

/** idbots:buyMrc721Listing result. */
interface Mrc721BuyResult {
  txId: string;
  itemPinId: string;
  priceSats: number;
  sellerAddress: string;
  feeSats: number;
  feeRateEffective: number;
}

interface MetaBotNftWalletModalProps {
  metabot: Metabot;
  onClose: () => void;
}

const copyTextToClipboard = (value: string): void => {
  if (!value) return;
  void navigator.clipboard.writeText(value).catch(() => {});
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('tokenTransferTxIdCopied') }));
};

const MetaBotNftWalletModal: React.FC<MetaBotNftWalletModalProps> = ({ metabot, onClose }) => {
  const [activeTab, setActiveTab] = useState<NftKind>('mrc721');
  const [tabStates, setTabStates] = useState<Record<NftKind, TabState | undefined>>({
    mrc721: undefined,
    metacontract: undefined,
  });
  // null = list; otherwise the detail/transfer subject.
  const [detailItem, setDetailItem] = useState<NftListItem | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  // MRC-721 trade surfaces (mrc721 tab only): sell flow opens from an item
  // detail, buy flow and "My Listings" from the wallet-level action row.
  const [sellOpen, setSellOpen] = useState(false);
  const [buyOpen, setBuyOpen] = useState(false);
  const [myListingsOpen, setMyListingsOpen] = useState(false);
  // Bumped after a successful sell so "My Listings" re-fetches on next open.
  const [sellOrdersVersion, setSellOrdersVersion] = useState(0);

  const loadTab = useCallback(
    (kind: NftKind, force = false) => {
      if (!force && tabStates[kind]) return;
      setTabStates((current) => ({
        ...current,
        [kind]: { loading: true, error: '', items: current[kind]?.items ?? [] },
      }));
      window.electron.idbots
        .getMetabotNfts({ metabotId: metabot.id, kind })
        .then((response) => {
          setTabStates((state) => ({
            ...state,
            [kind]: response.success && response.items
              ? { loading: false, error: '', items: response.items }
              : { loading: false, error: response.error || i18nService.t('metabotNftLoadFailed'), items: [] },
          }));
        })
        .catch((error) => {
          setTabStates((state) => ({
            ...state,
            [kind]: {
              loading: false,
              error: error instanceof Error ? error.message : i18nService.t('metabotNftLoadFailed'),
              items: [],
            },
          }));
        });
    },
    [metabot.id, tabStates],
  );

  useEffect(() => {
    loadTab('mrc721');
  }, [loadTab]);

  const switchTab = (kind: NftKind) => {
    setActiveTab(kind);
    if (!detailItem) loadTab(kind);
  };

  const backToList = useCallback(() => {
    setTransferOpen(false);
    setSellOpen(false);
    setBuyOpen(false);
    setMyListingsOpen(false);
    setDetailItem(null);
    // A finished transfer/purchase moved an item in or out of this wallet —
    // refresh lazily.
    loadTab(activeTab, true);
  }, [activeTab, loadTab]);

  const finishSell = useCallback(() => {
    // The new listing must show up in "My Listings" on next open.
    setSellOrdersVersion((version) => version + 1);
    backToList();
  }, [backToList]);

  const goBack = useCallback(() => {
    if (sellOpen) setSellOpen(false);
    else if (buyOpen) setBuyOpen(false);
    else if (myListingsOpen) setMyListingsOpen(false);
    else if (transferOpen) setTransferOpen(false);
    else if (detailItem) setDetailItem(null);
    else onClose();
  }, [buyOpen, detailItem, myListingsOpen, onClose, sellOpen, transferOpen]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') goBack();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [goBack]);

  const tabState = tabStates[activeTab] ?? { loading: true, error: '', items: [] };
  const tiles = useMemo(
    () => tabState.items.map((item) => buildNftTileViewModel(item)),
    [tabState.items],
  );
  const detailRows = useMemo(
    () => (detailItem ? buildNftDetailRows(detailItem) : []),
    [detailItem],
  );

  const headerTitle = sellOpen
    ? i18nService.t('metabotNftSellTitle')
    : buyOpen
      ? i18nService.t('metabotNftBuyTitle')
      : myListingsOpen
        ? i18nService.t('metabotNftMyListings')
        : detailItem
          ? (transferOpen ? i18nService.t('metabotNftTransferTitle') : (detailItem.name || i18nService.t('metabotNftWallet')))
          : i18nService.t('metabotNftWallet');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" data-slot="metabot-nft-wallet-modal">
      <div className="absolute inset-0 bg-black/50 dark:bg-black/60" onClick={goBack} aria-hidden />
      <div
        className="relative flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-main)] dark:bg-claude-darkSurface shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b dark:border-claude-darkBorder border-claude-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            {(detailItem || transferOpen || sellOpen || buyOpen || myListingsOpen) && (
              <button
                type="button"
                data-slot="metabot-nft-back"
                onClick={goBack}
                className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
                aria-label={i18nService.t('metabotNftBack')}
              >
                <ArrowLeftIcon className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{headerTitle}</div>
              {!detailItem && (
                <div className="truncate text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{metabot.name}</div>
              )}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!detailItem && !sellOpen && !buyOpen && !myListingsOpen && (
              <button
                type="button"
                data-slot="metabot-nft-refresh"
                onClick={() => loadTab(activeTab, true)}
                className="rounded p-1.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
                aria-label={i18nService.t('metabotWalletAssetsRefresh')}
                title={i18nService.t('metabotWalletAssetsRefresh')}
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

        {/* Body */}
        {!detailItem && !sellOpen && !buyOpen && !myListingsOpen && (
          <>
            <div className="flex gap-1 border-b dark:border-claude-darkBorder border-claude-border px-4 pt-2" role="tablist">
              {(['mrc721', 'metacontract'] as NftKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  role="tab"
                  data-slot={`metabot-nft-tab-${kind}`}
                  aria-selected={activeTab === kind}
                  onClick={() => switchTab(kind)}
                  className={`rounded-t-lg px-3 py-1.5 text-sm transition-colors ${
                    activeTab === kind
                      ? 'border-b-2 border-claude-accent font-semibold text-claude-accent'
                      : 'text-claude-textSecondary hover:text-claude-text dark:text-claude-darkTextSecondary dark:hover:text-claude-darkText'
                  }`}
                >
                  {kind === 'mrc721' ? i18nService.t('metabotNftTabMrc721') : i18nService.t('metabotNftTabMetaContract')}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {/* MRC-721 trade entry points: paste-listing purchase and the
                  local sell-order records. Wallet-level actions — a pasted
                  listing is not tied to any held item. */}
              {activeTab === 'mrc721' && (
                <div className="mb-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-slot="metabot-nft-open-buy"
                    onClick={() => setBuyOpen(true)}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {i18nService.t('metabotNftBuy')}
                  </button>
                  <button
                    type="button"
                    data-slot="metabot-nft-open-my-listings"
                    onClick={() => setMyListingsOpen(true)}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {i18nService.t('metabotNftMyListings')}
                  </button>
                </div>
              )}
              {tabState.loading && tabState.items.length === 0 && (
                <div className="flex h-32 items-center justify-center text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  ...
                </div>
              )}
              {!tabState.loading && tabState.error && tabState.items.length === 0 && (
                <div className="flex flex-col items-center gap-3 py-8">
                  <p className="text-sm text-red-500 dark:text-red-400">{tabState.error}</p>
                  <button
                    type="button"
                    data-slot="metabot-nft-retry"
                    onClick={() => loadTab(activeTab, true)}
                    className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {i18nService.t('metabotNftRetry')}
                  </button>
                </div>
              )}
              {!tabState.loading && !tabState.error && tabState.items.length === 0 && (
                <div className="flex flex-col items-center gap-2 py-10 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  <PhotoIcon className="h-8 w-8 opacity-50" aria-hidden />
                  <p className="text-sm">{i18nService.t('metabotNftEmpty')}</p>
                </div>
              )}
              {tiles.length > 0 && (
                <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
                  {tiles.map((tile) => (
                    <button
                      key={tile.key}
                      type="button"
                      data-slot="metabot-nft-tile"
                      onClick={() => {
                        const item = tabState.items.find((candidate) => String(candidate.key) === tile.key);
                        if (item) setDetailItem(item);
                      }}
                      className="overflow-hidden rounded-xl border text-left transition-shadow hover:shadow-md dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50"
                    >
                      <NftArtworkImage
                        sources={tile.artworkSources}
                        initials={tile.artworkInitials}
                        alt={tile.title}
                      />
                      <div className="space-y-0.5 px-2 py-1.5">
                        <div className="flex min-w-0 items-baseline gap-1">
                          <span className="truncate text-xs font-semibold dark:text-claude-darkText text-claude-text">{tile.title}</span>
                          {tile.badge && (
                            <span className="shrink-0 font-mono text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">{tile.badge}</span>
                          )}
                        </div>
                        <div className="truncate text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                          {tile.subtitle || '—'}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {detailItem && !transferOpen && !sellOpen && (
          <div className="min-h-0 flex-1 overflow-y-auto" data-slot="metabot-nft-detail">
            <div className="flex flex-col sm:flex-row">
              <div className="shrink-0 sm:w-[46%]">
                <NftArtworkImage
                  large
                  sources={buildNftTileViewModel(detailItem).artworkSources}
                  initials={buildNftTileViewModel(detailItem).artworkInitials}
                  alt={detailItem.name || 'NFT'}
                />
              </div>
              <div className="flex-1 space-y-2.5 px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="truncate text-base font-semibold dark:text-claude-darkText text-claude-text">
                    {detailItem.name || `#${detailItem.tokenIndex ?? detailItem.number ?? ''}`}
                  </span>
                  {detailItem.kind === 'mrc721' && detailItem.number != null && detailItem.number < 0 && (
                    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-px text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                      {i18nService.t('metabotNftUnconfirmed')}
                    </span>
                  )}
                </div>
                {detailRows.map((row) => (
                  <div key={row.labelKey} className="min-w-0">
                    <div className="text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                      {i18nService.t(row.labelKey)}
                    </div>
                    <div className={`flex items-start gap-1 text-[12px] leading-5 dark:text-claude-darkText text-claude-text ${row.mono ? 'font-mono [overflow-wrap:anywhere]' : ''}`}>
                      <span className="min-w-0 break-all">{row.value}</span>
                      {row.mono && (
                        <button
                          type="button"
                          onClick={() => copyTextToClipboard(row.value)}
                          className="shrink-0 rounded p-0.5 text-current opacity-60 transition-opacity hover:opacity-100"
                          aria-label={i18nService.t('metabotCopyAddress')}
                        >
                          <DocumentDuplicateIcon className="h-3 w-3" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-slot="metabot-nft-open-transfer"
                    onClick={() => setTransferOpen(true)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-claude-accent px-4 py-2 text-sm font-medium text-claude-accentInk hover:opacity-90"
                  >
                    {i18nService.t('metabotNftTransfer')}
                  </button>
                  {detailItem.kind === 'mrc721' && (
                    <button
                      type="button"
                      data-slot="metabot-nft-open-sell"
                      onClick={() => setSellOpen(true)}
                      className="inline-flex items-center gap-1.5 rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-2 text-sm font-medium dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                    >
                      {i18nService.t('metabotNftSell')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}

        {detailItem && transferOpen && (
          <NftTransferFlow
            metabot={metabot}
            item={detailItem}
            onCancel={() => setTransferOpen(false)}
            onTransferred={backToList}
          />
        )}

        {detailItem && sellOpen && (
          <Mrc721SellFlow
            metabot={metabot}
            item={detailItem}
            onCancel={() => setSellOpen(false)}
            onSold={finishSell}
          />
        )}

        {buyOpen && (
          <Mrc721BuyFlow
            metabot={metabot}
            onCancel={() => setBuyOpen(false)}
            onBought={backToList}
          />
        )}

        {myListingsOpen && (
          <Mrc721MyListingsPanel metabot={metabot} version={sellOrdersVersion} />
        )}
      </div>
    </div>
  );
};

const NftTransferFlow: React.FC<{
  metabot: Metabot;
  item: NftListItem;
  onCancel: () => void;
  onTransferred: () => void;
}> = ({ metabot, item, onCancel, onTransferred }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [receiver, setReceiver] = useState('');
  const [feeOptions, setFeeOptions] = useState<FeeOption[]>([]);
  const [selectedFeeRate, setSelectedFeeRate] = useState(0);
  const [showFeeSelect, setShowFeeSelect] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [sending, setSending] = useState(false);
  const [resultTxId, setResultTxId] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.electron.idbots
      .getTransferFeeSummary('mvc')
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !response.list?.length) {
          setValidationError(response.error || i18nService.t('transferFailed'));
          return;
        }
        setFeeOptions(response.list);
        setSelectedFeeRate(response.defaultFeeRate ?? response.list[0].feeRate);
      })
      .catch((error) => {
        if (!cancelled) {
          setValidationError(error instanceof Error ? error.message : i18nService.t('transferFailed'));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const tile = useMemo(() => buildNftTileViewModel(item), [item]);

  const handleConfirm = async () => {
    setValidationError('');
    setSending(true);
    try {
      const payload = buildNftTransferPayload({
        metabotId: metabot.id,
        item,
        toAddress: receiver,
        feeRate: selectedFeeRate,
      });
      const response = item.kind === 'metacontract'
        ? await window.electron.idbots.transferMetabotMvcNft(payload as Parameters<typeof window.electron.idbots.transferMetabotMvcNft>[0])
        : await window.electron.idbots.transferMetabotMrc721(payload as Parameters<typeof window.electron.idbots.transferMetabotMrc721>[0]);
      if (!response.success || !response.result) {
        setValidationError(response.error || i18nService.t('transferFailed'));
        return;
      }
      setResultTxId(response.result.txId);
      setStep(3);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : i18nService.t('transferFailed'));
    } finally {
      setSending(false);
    }
  };

  const inputClass =
    'w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text';

  if (step === 3) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-transfer-success">
        <div className="mb-4 text-center">
          <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 text-green-500">
            <span className="text-xl">OK</span>
          </div>
          <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('transferSuccess')}</p>
        </div>
        <div className="mb-6 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">TxID</span>
            <span className="break-all text-right font-mono dark:text-claude-darkText text-claude-text">{resultTxId}</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => copyTextToClipboard(resultTxId)}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('metabotCopyAddress')}
          </button>
          <button
            type="button"
            onClick={onTransferred}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90"
          >
            {i18nService.t('close')}
          </button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-transfer-confirm">
        <div className="mb-4 flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
            <NftArtworkImage sources={tile.artworkSources} initials={tile.artworkInitials} alt={tile.title} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{tile.title}</p>
            <p className="truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {tile.subtitle || (item.kind === 'metacontract' ? 'MetaContract' : 'MRC721')}
            </p>
          </div>
        </div>
        <div className="mb-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFrom')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text" title={metabot.mvc_address}>{metabot.mvc_address}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferTo')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{receiver.trim()}</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFeeRate')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{selectedFeeRate} sat/vB</span>
          </div>
        </div>
        <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
          {i18nService.t('metabotNftTransferWarning')}
        </p>
        {validationError && <p className="mb-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('transferCancel')}
          </button>
          <button
            type="button"
            data-slot="metabot-nft-transfer-confirm"
            onClick={handleConfirm}
            disabled={sending}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90 disabled:opacity-50"
          >
            {sending ? '...' : i18nService.t('transferConfirm')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-transfer-form">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('transferReceiver')}
          </label>
          <input
            type="text"
            value={receiver}
            onChange={(event) => setReceiver(event.target.value)}
            placeholder={i18nService.t('transferReceiverPlaceholder')}
            className={inputClass}
            data-slot="metabot-nft-transfer-receiver"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('transferFeeRate')}
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowFeeSelect((value) => !value)}
              className="flex w-full items-center justify-between rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text"
            >
              <span>{feeOptions.length ? `${selectedFeeRate} sat/vB` : '...'}</span>
            </button>
            {showFeeSelect && feeOptions.length > 0 && (
              <div className="absolute left-0 right-0 top-full z-10 mt-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface py-1 shadow-lg">
                {feeOptions.map((option) => (
                  <button
                    key={`${option.title}-${option.feeRate}`}
                    type="button"
                    onClick={() => {
                      setSelectedFeeRate(option.feeRate);
                      setShowFeeSelect(false);
                    }}
                    className="w-full px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  >
                    {option.title} - {option.feeRate} sat/vB ({option.desc})
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      {validationError && <p className="mt-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>}
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-6 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
        >
          {i18nService.t('close')}
        </button>
        <button
          type="button"
          data-slot="metabot-nft-transfer-next"
          onClick={() => {
            const validation = validateNftTransferDraft({ toAddress: receiver });
            if (!validation.valid) {
              setValidationError(i18nService.t(validation.errorKey));
              return;
            }
            setValidationError('');
            setStep(2);
          }}
          disabled={!feeOptions.length}
          className="rounded-xl bg-claude-accent px-6 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90 disabled:opacity-50"
        >
          {i18nService.t('transferNext')}
        </button>
      </div>
    </div>
  );
};

/** Shared input style for the MRC-721 trade flows (same as the transfer flow). */
const MRC721_FLOW_INPUT_CLASS =
  'w-full rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text';

/**
 * Sell flow (mrc721 tab): price + locked buyer → confirm → success with the
 * copyable listing JSON. Mirrors NftTransferFlow's 3-step conventions. The
 * sell builds and seller-signs the atomic-swap partial transaction but
 * broadcasts nothing — the buyer completes the swap.
 */
const Mrc721SellFlow: React.FC<{
  metabot: Metabot;
  item: NftListItem;
  onCancel: () => void;
  onSold: () => void;
}> = ({ metabot, item, onCancel, onSold }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [priceSats, setPriceSats] = useState('');
  const [buyer, setBuyer] = useState('');
  const [botOptions, setBotOptions] = useState<Array<{ id: number; name: string; mvcAddress: string }>>([]);
  const [validationError, setValidationError] = useState('');
  const [selling, setSelling] = useState(false);
  const [listingJson, setListingJson] = useState('');

  // Optional local-bot picker: the same metabot listing IPC as the wallet
  // list. Failures just hide the picker.
  useEffect(() => {
    let cancelled = false;
    window.electron.idbots
      .getMetaBots()
      .then((response) => {
        if (cancelled || !response.success || !response.list) return;
        const options = (response.list as Array<{ id: number; name: string; mvc_address?: string }>)
          .map((bot) => ({ id: Number(bot.id), name: String(bot.name ?? ''), mvcAddress: String(bot.mvc_address ?? '').trim() }))
          .filter((bot) => bot.mvcAddress && bot.id !== metabot.id);
        setBotOptions(options);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [metabot.id]);

  const tile = useMemo(() => buildNftTileViewModel(item), [item]);

  const handleConfirm = async () => {
    setValidationError('');
    setSelling(true);
    try {
      const response = await window.electron.idbots.sellMrc721Listing({
        metabotId: metabot.id,
        itemPinId: String(item.key || ''),
        buyerAddress: buyer.trim(),
        priceSats: Number(priceSats),
      });
      if (!response.success || !response.result) {
        setValidationError(response.error || i18nService.t('metabotNftSellFailed'));
        return;
      }
      setListingJson(response.result.listingJson);
      setStep(3);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : i18nService.t('metabotNftSellFailed'));
    } finally {
      setSelling(false);
    }
  };

  if (step === 3) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-sell-success">
        <div className="mb-4 text-center">
          <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 text-green-500">
            <span className="text-xl">OK</span>
          </div>
          <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('metabotNftSellSuccessTitle')}</p>
        </div>
        <div className="mb-4">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('metabotNftSellListingJsonLabel')}
          </div>
          <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-all rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-3 py-2 font-mono text-[11px] leading-5 dark:text-claude-darkText text-claude-text" data-slot="metabot-nft-sell-listing-json">
            {listingJson}
          </pre>
        </div>
        <p className="mb-6 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
          {i18nService.t('metabotNftSellNotBroadcastHint')}
        </p>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => copyTextToClipboard(listingJson)}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('metabotCopyAddress')}
          </button>
          <button
            type="button"
            onClick={onSold}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90"
          >
            {i18nService.t('close')}
          </button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-sell-confirm">
        <div className="mb-4 flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-lg">
            <NftArtworkImage sources={tile.artworkSources} initials={tile.artworkInitials} alt={tile.title} />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{tile.title}</p>
            <p className="truncate text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">{tile.subtitle || 'MRC721'}</p>
          </div>
        </div>
        <div className="mb-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('transferFrom')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text" title={metabot.mvc_address}>{metabot.mvc_address}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftSellBuyerLabel')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{buyer.trim()}</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftSellPriceLabel')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{priceSats} sats</span>
          </div>
        </div>
        <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
          {i18nService.t('metabotNftSellWarning')}
        </p>
        {validationError && <p className="mb-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('transferCancel')}
          </button>
          <button
            type="button"
            data-slot="metabot-nft-sell-confirm"
            onClick={handleConfirm}
            disabled={selling}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90 disabled:opacity-50"
          >
            {selling ? '...' : i18nService.t('transferConfirm')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-sell-form">
      <div className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('metabotNftSellPriceLabel')}
          </label>
          <input
            type="text"
            inputMode="numeric"
            value={priceSats}
            onChange={(event) => setPriceSats(event.target.value)}
            placeholder={String(MRC721_MIN_SELL_PRICE_SATS)}
            className={MRC721_FLOW_INPUT_CLASS}
            data-slot="metabot-nft-sell-price"
          />
          <p className="mt-1 text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {i18nService.t('metabotNftSellPriceFloorHint')}
          </p>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('metabotNftSellBuyerLabel')}
          </label>
          <input
            type="text"
            value={buyer}
            onChange={(event) => setBuyer(event.target.value)}
            placeholder={i18nService.t('transferReceiverPlaceholder')}
            className={MRC721_FLOW_INPUT_CLASS}
            data-slot="metabot-nft-sell-buyer"
          />
        </div>
        {botOptions.length > 0 && (
          <div>
            <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('metabotNftSellBuyerPickLabel')}
            </label>
            <select
              value=""
              onChange={(event) => {
                const option = botOptions.find((candidate) => String(candidate.id) === event.target.value);
                if (option?.mvcAddress) setBuyer(option.mvcAddress);
              }}
              className={MRC721_FLOW_INPUT_CLASS}
              data-slot="metabot-nft-sell-bot-picker"
            >
              <option value="">{i18nService.t('metabotNftSellBuyerPickPlaceholder')}</option>
              {botOptions.map((option) => (
                <option key={option.id} value={String(option.id)}>{option.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>
      {validationError && <p className="mt-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>}
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-6 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
        >
          {i18nService.t('close')}
        </button>
        <button
          type="button"
          data-slot="metabot-nft-sell-next"
          onClick={() => {
            const validation = validateMrc721SellDraft({ priceSats, buyerAddress: buyer });
            if (!validation.valid) {
              setValidationError(i18nService.t(validation.errorKey));
              return;
            }
            setValidationError('');
            setStep(2);
          }}
          className="rounded-xl bg-claude-accent px-6 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90"
        >
          {i18nService.t('transferNext')}
        </button>
      </div>
    </div>
  );
};

/**
 * Buy flow (mrc721 tab): paste a seller's listing JSON → verify (checks 1–5,
 * blocked on failure) → confirm (buyer-lock warning) → success with txid +
 * fee. Confirming broadcasts the completed atomic swap — irreversible.
 */
const Mrc721BuyFlow: React.FC<{
  metabot: Metabot;
  onCancel: () => void;
  onBought: () => void;
}> = ({ metabot, onCancel, onBought }) => {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [listingText, setListingText] = useState('');
  const [verifying, setVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState('');
  const [verifiedListing, setVerifiedListing] = useState<Mrc721ListingSummary | null>(null);
  const [buying, setBuying] = useState(false);
  const [validationError, setValidationError] = useState('');
  const [result, setResult] = useState<Mrc721BuyResult | null>(null);

  const handleVerify = async () => {
    setVerifyError('');
    setVerifiedListing(null);
    const text = listingText.trim();
    if (!text) {
      setVerifyError(i18nService.t('metabotNftBuyPasteRequired'));
      return;
    }
    setVerifying(true);
    try {
      // Read-only pre-buy check. The handler never throws raw: shape errors,
      // failed ownership checks and indexer/node hiccups all come back as
      // ok:false with the failing check.
      const response = await window.electron.idbots.verifyMrc721Listing({ listing: text });
      if (!response.success || !response.result) {
        setVerifyError(response.error || i18nService.t('metabotNftBuyVerifiedFailed'));
        return;
      }
      if (!response.result.ok) {
        setVerifyError([response.result.check, response.result.error].filter(Boolean).join(': '));
        return;
      }
      if (!response.result.listing) {
        setVerifyError(i18nService.t('metabotNftBuyVerifiedFailed'));
        return;
      }
      setVerifiedListing(response.result.listing);
    } catch (error) {
      setVerifyError(error instanceof Error ? error.message : i18nService.t('metabotNftBuyVerifiedFailed'));
    } finally {
      setVerifying(false);
    }
  };

  const handleConfirm = async () => {
    setValidationError('');
    setBuying(true);
    try {
      const response = await window.electron.idbots.buyMrc721Listing({
        metabotId: metabot.id,
        listing: listingText.trim(),
      });
      if (!response.success || !response.result) {
        setValidationError(response.error || i18nService.t('metabotNftBuyFailed'));
        return;
      }
      setResult(response.result);
      setStep(3);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : i18nService.t('metabotNftBuyFailed'));
    } finally {
      setBuying(false);
    }
  };

  if (step === 3) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-buy-success">
        <div className="mb-4 text-center">
          <div className="mb-3 inline-flex h-14 w-14 items-center justify-center rounded-full bg-green-500/15 text-green-500">
            <span className="text-xl">OK</span>
          </div>
          <p className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('metabotNftBuySuccessTitle')}</p>
        </div>
        <div className="mb-6 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">TxID</span>
            <span className="break-all text-right font-mono dark:text-claude-darkText text-claude-text">{result?.txId}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftFieldItemId')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{result?.itemPinId}</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuyPriceLabel')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{result?.priceSats} sats</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuyFeeLabel')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{result?.feeSats} sats</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuyFeeRateLabel')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{result?.feeRateEffective}</span>
          </div>
        </div>
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => copyTextToClipboard(result?.txId ?? '')}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('metabotCopyAddress')}
          </button>
          <button
            type="button"
            onClick={onBought}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90"
          >
            {i18nService.t('close')}
          </button>
        </div>
      </div>
    );
  }

  if (step === 2) {
    const buyerLockedToOtherBot = Boolean(
      verifiedListing && metabot.mvc_address && verifiedListing.buyerAddress !== metabot.mvc_address,
    );
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-buy-confirm">
        <div className="mb-4 space-y-2 text-sm">
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftFieldItemId')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{verifiedListing?.itemPinId}</span>
          </div>
          <div className="flex justify-between">
            <span className="dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuyPriceLabel')}</span>
            <span className="dark:text-claude-darkText text-claude-text">{verifiedListing?.priceSats} sats</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuySellerLabel')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{verifiedListing?.sellerAddress}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('metabotNftBuyBuyerLabel')}</span>
            <span className="break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{verifiedListing?.buyerAddress}</span>
          </div>
        </div>
        {buyerLockedToOtherBot && (
          <p className="mb-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-400" data-slot="metabot-nft-buy-buyer-mismatch">
            {i18nService.t('metabotNftBuyBuyerMismatchWarning')}
          </p>
        )}
        <p className="mb-4 rounded-lg bg-amber-500/10 px-3 py-2 text-xs leading-5 text-amber-600 dark:text-amber-400">
          {i18nService.t('metabotNftBuyWarning')}
        </p>
        {validationError && <p className="mb-2 text-sm text-red-500 dark:text-red-400">{validationError}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={() => setStep(1)}
            className="flex-1 rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-4 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
          >
            {i18nService.t('transferCancel')}
          </button>
          <button
            type="button"
            data-slot="metabot-nft-buy-confirm"
            onClick={handleConfirm}
            disabled={buying}
            className="flex-1 rounded-xl bg-claude-accent px-4 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90 disabled:opacity-50"
          >
            {buying ? '...' : i18nService.t('transferConfirm')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5" data-slot="metabot-nft-buy-form">
      <div>
        <label className="mb-1 block text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('metabotNftBuyPasteLabel')}
        </label>
        <textarea
          rows={6}
          value={listingText}
          onChange={(event) => setListingText(event.target.value)}
          placeholder={i18nService.t('metabotNftBuyPastePlaceholder')}
          className={`${MRC721_FLOW_INPUT_CLASS} font-mono text-[11px] leading-5`}
          data-slot="metabot-nft-buy-listing-input"
        />
      </div>
      <div className="mt-3">
        <button
          type="button"
          data-slot="metabot-nft-buy-verify"
          onClick={handleVerify}
          disabled={verifying}
          className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover disabled:opacity-50"
        >
          {verifying ? i18nService.t('metabotNftBuyVerifying') : i18nService.t('metabotNftBuyVerify')}
        </button>
      </div>
      {verifyError && (
        <div className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs leading-5 text-red-600 dark:text-red-400" data-slot="metabot-nft-buy-verify-failed">
          <p className="font-medium">{i18nService.t('metabotNftBuyVerifiedFailed')}</p>
          <p className="break-all">{verifyError}</p>
        </div>
      )}
      {verifiedListing && (
        <div className="mt-3 space-y-1.5 rounded-lg bg-green-500/10 px-3 py-2 text-xs leading-5 text-green-700 dark:text-green-400" data-slot="metabot-nft-buy-verify-ok">
          <p className="font-medium">{i18nService.t('metabotNftBuyVerifiedOk')}</p>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 opacity-80">{i18nService.t('metabotNftFieldItemId')}</span>
            <span className="break-all text-right font-mono">{verifiedListing.itemPinId}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 opacity-80">{i18nService.t('metabotNftBuyPriceLabel')}</span>
            <span>{verifiedListing.priceSats} sats</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="shrink-0 opacity-80">{i18nService.t('metabotNftBuySellerLabel')}</span>
            <span className="break-all text-right font-mono">{verifiedListing.sellerAddress}</span>
          </div>
        </div>
      )}
      <div className="mt-6 flex justify-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-xl border dark:border-claude-darkBorder border-claude-border bg-[var(--bg-panel)] dark:bg-claude-darkSurface px-6 py-2.5 text-sm font-medium dark:text-claude-darkText text-claude-text"
        >
          {i18nService.t('close')}
        </button>
        <button
          type="button"
          data-slot="metabot-nft-buy-next"
          onClick={() => {
            setValidationError('');
            setStep(2);
          }}
          disabled={!verifiedListing}
          className="rounded-xl bg-claude-accent px-6 py-2.5 text-sm font-medium text-claude-accentInk hover:opacity-90 disabled:opacity-50"
        >
          {i18nService.t('transferNext')}
        </button>
      </div>
    </div>
  );
};

/**
 * "My Listings" (mrc721 tab): the bot's local sell-order records, each
 * re-verified per read — status badge plus the failing check as reason.
 */
const Mrc721MyListingsPanel: React.FC<{
  metabot: Metabot;
  version: number;
}> = ({ metabot, version }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [orders, setOrders] = useState<Mrc721SellOrderRow[]>([]);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    window.electron.idbots
      .listMrc721SellOrders({ metabotId: metabot.id })
      .then((response) => {
        if (cancelled) return;
        if (!response.success || !response.orders) {
          setError(response.error || i18nService.t('metabotNftLoadFailed'));
          setOrders([]);
        } else {
          setOrders(response.orders);
        }
        setLoading(false);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : i18nService.t('metabotNftLoadFailed'));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [metabot.id, version, reload]);

  const statusBadgeClass = (status: Mrc721SellOrderRow['status']): string => {
    if (status === 'valid') return 'bg-green-500/15 text-green-600 dark:text-green-400';
    if (status === 'expired') return 'bg-amber-500/15 text-amber-600 dark:text-amber-400';
    return 'bg-red-500/15 text-red-600 dark:text-red-400';
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4" data-slot="metabot-nft-my-listings">
      {loading && orders.length === 0 && (
        <div className="flex h-32 items-center justify-center text-sm text-claude-textSecondary dark:text-claude-darkTextSecondary">
          ...
        </div>
      )}
      {!loading && error && orders.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-8">
          <p className="text-sm text-red-500 dark:text-red-400">{error}</p>
          <button
            type="button"
            data-slot="metabot-nft-my-listings-retry"
            onClick={() => setReload((value) => value + 1)}
            className="rounded-lg border dark:border-claude-darkBorder border-claude-border px-4 py-1.5 text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
          >
            {i18nService.t('metabotNftRetry')}
          </button>
        </div>
      )}
      {!loading && !error && orders.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-10 text-claude-textSecondary dark:text-claude-darkTextSecondary">
          <p className="text-sm">{i18nService.t('metabotNftMyListingsEmpty')}</p>
        </div>
      )}
      {orders.length > 0 && (
        <div className="space-y-2">
          {orders.map((order) => (
            <div
              key={order.id}
              data-slot="metabot-nft-sell-order"
              className="space-y-1.5 rounded-xl border px-3 py-2.5 dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono text-[11px] dark:text-claude-darkText text-claude-text">{order.itemPinId}</span>
                <span className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold ${statusBadgeClass(order.status)}`}>
                  {i18nService.t(mrc721SellOrderStatusKey(order.status))}
                </span>
              </div>
              <div className="flex justify-between gap-3 text-xs">
                <span className="shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('metabotNftSellPriceLabel')}</span>
                <span className="dark:text-claude-darkText text-claude-text">{order.priceSats} sats</span>
              </div>
              <div className="flex justify-between gap-3 text-xs">
                <span className="shrink-0 text-claude-textSecondary dark:text-claude-darkTextSecondary">{i18nService.t('metabotNftListingBuyerLabel')}</span>
                <span className="min-w-0 break-all text-right font-mono text-[11px] dark:text-claude-darkText text-claude-text">{order.buyerAddress}</span>
              </div>
              {order.reason && (
                <p className="break-all text-[11px] leading-4 text-amber-600 dark:text-amber-400">{order.reason}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MetaBotNftWalletModal;
