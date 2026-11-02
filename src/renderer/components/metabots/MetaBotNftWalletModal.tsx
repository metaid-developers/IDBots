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
  validateNftTransferDraft,
} from './metabotNftPresentation.js';

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

interface MetaBotNftWalletModalProps {
  metabot: Metabot;
  onClose: () => void;
}

const copyTextToClipboard = (value: string): void => {
  if (!value) return;
  void navigator.clipboard.writeText(value).catch(() => {});
  window.dispatchEvent(new CustomEvent('app:showToast', { detail: i18nService.t('tokenTransferTxIdCopied') }));
};

const NftArtworkPlaceholder: React.FC<{ initials: string; large?: boolean }> = ({ initials, large }) => (
  <div
    className={`flex w-full items-center justify-center bg-gradient-to-br from-claude-accent/10 to-violet-500/10 dark:from-claude-accent/20 dark:to-violet-500/20 ${
      large ? 'min-h-[240px] text-4xl' : 'aspect-square text-xl'
    } font-semibold tracking-wide text-claude-accent`}
  >
    {initials}
  </div>
);

const NftArtworkImage: React.FC<{ sources: string[]; initials: string; alt: string; large?: boolean }> = ({
  sources,
  initials,
  alt,
  large,
}) => {
  const [failedCount, setFailedCount] = useState(0);
  const sourceKey = sources.join('|');
  useEffect(() => {
    setFailedCount(0);
  }, [sourceKey]);

  if (!sources.length || failedCount >= sources.length) {
    return <NftArtworkPlaceholder initials={initials} large={large} />;
  }
  return (
    <img
      src={sources[failedCount]}
      alt={alt}
      loading="lazy"
      className={`w-full bg-black/5 object-cover dark:bg-white/5 ${large ? 'max-h-[55vh]' : 'aspect-square'}`}
      onError={() => setFailedCount((count) => count + 1)}
    />
  );
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
    setDetailItem(null);
    // A finished transfer moved an item out of this wallet — refresh lazily.
    loadTab(activeTab, true);
  }, [activeTab, loadTab]);

  const goBack = useCallback(() => {
    if (transferOpen) setTransferOpen(false);
    else if (detailItem) setDetailItem(null);
    else onClose();
  }, [detailItem, onClose, transferOpen]);

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

  const headerTitle = detailItem
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
            {(detailItem || transferOpen) && (
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
            {!detailItem && (
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
        {!detailItem && (
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

        {detailItem && !transferOpen && (
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
                <button
                  type="button"
                  data-slot="metabot-nft-open-transfer"
                  onClick={() => setTransferOpen(true)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-claude-accent px-4 py-2 text-sm font-medium text-claude-accentInk hover:opacity-90"
                >
                  {i18nService.t('metabotNftTransfer')}
                </button>
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

export default MetaBotNftWalletModal;
