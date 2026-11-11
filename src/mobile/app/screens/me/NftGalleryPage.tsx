import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowPathIcon,
  CheckBadgeIcon,
  ClipboardDocumentIcon,
  PhotoIcon,
  PlusIcon,
} from '@heroicons/react/24/outline';
import { buildNftDetailRows, buildNftTileViewModel } from '@/components/metabots/metabotNftPresentation.js';
import { t } from '../../../i18n';
import type { MockMetabot } from '../../../bridge/types';
import { getMobileElectron } from '../../appBridge';
import { resolveTwinMetabotId } from '../../activity';
import { copyTextToClipboard } from '../../../login/inAppBrowser';
import { BottomSheet } from '../../components/BottomSheet';
import { SecondaryPageShell } from './SecondaryPageShell';
import { buildMobileNftMintPrompt, validateMobileNftMintRequest, type MobileNftMintRequest } from '../../me/nftMint';

type NftKind = 'mrc721' | 'metacontract';
type NftItem = NonNullable<Awaited<ReturnType<Window['electron']['idbots']['getMetabotNfts']>>['items']>[number];
type NftRegistry = NonNullable<Awaited<ReturnType<Window['electron']['idbots']['getNftCaRegistry']>>['registry']>;

function NftArtwork(props: { sources: string[]; initials: string; alt: string; large?: boolean }): JSX.Element {
  const [failedCount, setFailedCount] = useState(0);
  const sourceKey = props.sources.join('|');
  useEffect(() => setFailedCount(0), [sourceKey]);
  if (!props.sources.length || failedCount >= props.sources.length) {
    return (
      <div className={props.large ? 'mobile-nft-art mobile-nft-art-large mobile-nft-placeholder' : 'mobile-nft-art mobile-nft-placeholder'}>
        {props.initials}
      </div>
    );
  }
  return (
    <img
      src={props.sources[failedCount]}
      alt={props.alt}
      loading="lazy"
      className={props.large ? 'mobile-nft-art mobile-nft-art-large' : 'mobile-nft-art'}
      onError={() => setFailedCount((count) => count + 1)}
    />
  );
}

function certifiedCollection(item: NftItem, registry: NftRegistry | null): boolean {
  if (!registry?.verified || item.kind !== 'mrc721') return false;
  const raw = item.raw as { collectionPinId?: string };
  return Boolean(raw.collectionPinId && registry.collections.some((entry) => entry.collectionPinId === raw.collectionPinId));
}

function MintSheet(props: {
  bots: MockMetabot[];
  selectedBotId: number | null;
  onSelectBot: (botId: number) => void;
  onClose: () => void;
  onMint: (request: MobileNftMintRequest, prompt: string) => void;
}): JSX.Element {
  const [createCollection, setCreateCollection] = useState(false);
  const [collectionName, setCollectionName] = useState('');
  const [collectionDisplayName, setCollectionDisplayName] = useState('');
  const [itemName, setItemName] = useState('');
  const [description, setDescription] = useState('');
  const [artwork, setArtwork] = useState<{ path: string; label: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pickArtwork = async () => {
    setBusy(true);
    setError('');
    try {
      const selectFile = getMobileElectron().dialog.selectFile as unknown as (options: Record<string, unknown>) => Promise<{
        success?: boolean;
        path?: string | null;
        error?: string;
      }>;
      const result = await selectFile({
        title: t('mobile.nfts.mint.artworkPick'),
        source: 'photos',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
      });
      if (!result.success || !result.path) {
        if (result.error) setError(result.error);
        return;
      }
      setArtwork({ path: result.path, label: result.path.split('/').pop() ?? result.path });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('mobile.nfts.mint.artworkFailed'));
    } finally {
      setBusy(false);
    }
  };

  const review = () => {
    if (!props.selectedBotId) {
      setError(t('mobile.nfts.mint.botRequired'));
      return;
    }
    const request: MobileNftMintRequest = {
      botId: props.selectedBotId,
      collectionName: collectionName.trim(),
      collectionDisplayName: collectionDisplayName.trim(),
      createCollection,
      itemName: itemName.trim(),
      description: description.trim(),
      ...(artwork ? { artworkPath: artwork.path } : {}),
    };
    const validation = validateMobileNftMintRequest(request);
    if (validation) {
      setError(t(validation));
      return;
    }
    props.onMint(request, buildMobileNftMintPrompt(request));
  };

  return (
    <BottomSheet title={t('mobile.nfts.mint.title')} onClose={props.onClose}>
      <div className="space-y-3" data-testid="nft-mint-form">
        <p className="text-xs leading-relaxed text-[var(--text-secondary)]">{t('mobile.nfts.mint.body')}</p>
        <label className="mobile-nft-field">
          <span>{t('mobile.nfts.owner')}</span>
          <select value={props.selectedBotId ?? ''} onChange={(event) => props.onSelectBot(Number(event.target.value))} className="twin-input" data-testid="nft-mint-bot">
            {props.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>
        <label className="mobile-nft-check">
          <input type="checkbox" checked={createCollection} onChange={(event) => setCreateCollection(event.target.checked)} />
          <span>{t('mobile.nfts.mint.createCollection')}</span>
        </label>
        <label className="mobile-nft-field">
          <span>{t('mobile.nfts.mint.collectionId')}</span>
          <input value={collectionName} onChange={(event) => setCollectionName(event.target.value.toLowerCase())} placeholder="my-collection" autoCapitalize="none" autoCorrect="off" className="twin-input" data-testid="nft-mint-collection" />
        </label>
        {createCollection ? (
          <label className="mobile-nft-field">
            <span>{t('mobile.nfts.mint.collectionDisplayName')}</span>
            <input value={collectionDisplayName} onChange={(event) => setCollectionDisplayName(event.target.value)} className="twin-input" data-testid="nft-mint-collection-name" />
          </label>
        ) : null}
        <label className="mobile-nft-field">
          <span>{t('mobile.nfts.mint.itemName')}</span>
          <input value={itemName} onChange={(event) => setItemName(event.target.value)} maxLength={256} className="twin-input" data-testid="nft-mint-item-name" />
        </label>
        <label className="mobile-nft-field">
          <span>{t('mobile.nfts.mint.description')}</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} maxLength={2048} className="me-textarea" />
        </label>
        <button type="button" className="twin-button twin-button-secondary twin-button-full" disabled={busy} onClick={() => void pickArtwork()}>
          <PhotoIcon className="h-4 w-4" aria-hidden />
          {busy ? t('mobile.common.loading') : artwork ? artwork.label : t('mobile.nfts.mint.artworkPick')}
        </button>
        {error ? <p className="me-inline-error" role="alert">{error}</p> : null}
        <p className="rounded-xl bg-[var(--bg-main)] p-3 text-[11px] leading-relaxed text-[var(--text-secondary)]">
          {t('mobile.nfts.mint.reviewNotice')}
        </p>
        <button type="button" className="twin-button twin-button-primary twin-button-full" disabled={busy || !props.selectedBotId} onClick={review} data-testid="nft-mint-review">
          {t('mobile.nfts.mint.review')}
        </button>
      </div>
    </BottomSheet>
  );
}

export function NftGalleryPage(props: {
  bots: MockMetabot[];
  botsLoading?: boolean;
  onBack: () => void;
  onMint: (request: MobileNftMintRequest, prompt: string) => void;
  onOpenUri?: (uri: string) => void;
}): JSX.Element {
  const [selectedBotId, setSelectedBotId] = useState<number | null>(null);
  const [kind, setKind] = useState<NftKind>('mrc721');
  const [items, setItems] = useState<NftItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<NftItem | null>(null);
  const [mintOpen, setMintOpen] = useState(false);
  const [registry, setRegistry] = useState<NftRegistry | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!props.bots.length) {
      setSelectedBotId(null);
      return;
    }
    setSelectedBotId((current) => props.bots.some((bot) => bot.id === current)
      ? current
      : resolveTwinMetabotId(props.bots) ?? props.bots[0].id);
  }, [props.bots]);

  useEffect(() => {
    let cancelled = false;
    void getMobileElectron().idbots.getNftCaRegistry({}).then((result) => {
      if (!cancelled && result.success && result.registry) setRegistry(result.registry);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  const load = useCallback(async () => {
    if (!selectedBotId) {
      setItems([]);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await getMobileElectron().idbots.getMetabotNfts({ metabotId: selectedBotId, kind });
      if (!result.success) throw new Error(result.error || t('mobile.nfts.loadFailed'));
      setItems(result.items ?? []);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t('mobile.nfts.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [selectedBotId, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  const tiles = useMemo(() => items.map((item) => ({ item, view: buildNftTileViewModel(item) })), [items]);
  const detailTile = detail ? buildNftTileViewModel(detail) : null;
  const detailRows = detail ? buildNftDetailRows(detail) : [];
  const selectedBot = props.bots.find((bot) => bot.id === selectedBotId) ?? null;

  return (
    <SecondaryPageShell
      title={t('mobile.nfts.title')}
      onBack={props.onBack}
      testId="me-page-nfts"
      action={
        <button type="button" className="twin-button twin-button-secondary twin-button-small" data-testid="nft-mint-open" onClick={() => setMintOpen(true)} disabled={!selectedBotId}>
          <PlusIcon className="h-4 w-4" aria-hidden />
          {t('mobile.nfts.mint.action')}
        </button>
      }
    >
      <section className="twin-panel twin-panel-padded">
        <label className="mobile-nft-field">
          <span>{t('mobile.nfts.owner')}</span>
          <select value={selectedBotId ?? ''} onChange={(event) => setSelectedBotId(Number(event.target.value))} className="twin-input" data-testid="nft-owner-select">
            {props.bots.map((bot) => <option key={bot.id} value={bot.id}>{bot.name}</option>)}
          </select>
        </label>
        <div className="me-segment me-segment-two mt-3" role="tablist" aria-label={t('mobile.nfts.title')}>
          {(['mrc721', 'metacontract'] as const).map((value) => (
            <button key={value} type="button" role="tab" aria-selected={kind === value} data-testid={`nft-kind-${value}`} onClick={() => setKind(value)} className={kind === value ? 'me-segment-item me-segment-active' : 'me-segment-item'}>
              {value === 'mrc721' ? 'MRC-721' : 'MetaContract'}
            </button>
          ))}
        </div>
      </section>

      <div className="flex items-center justify-between px-1">
        <p className="text-xs text-[var(--text-secondary)]">
          {selectedBot ? t('mobile.nfts.holdings', { name: selectedBot.name, count: items.length }) : t('mobile.nfts.noBot')}
        </p>
        <button type="button" className="twin-icon-button" aria-label={t('mobile.common.retry')} onClick={() => void load()} disabled={loading || !selectedBotId}>
          <ArrowPathIcon className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
        </button>
      </div>

      {loading && !items.length ? (
        <div className="mobile-nft-grid" data-testid="nft-loading">
          {[0, 1, 2, 3].map((value) => <div key={value} className="mobile-nft-skeleton" />)}
        </div>
      ) : null}
      {error ? (
        <div className="twin-notice twin-notice-error" role="alert">
          <p className="text-sm">{error}</p>
          <button type="button" className="twin-button twin-button-secondary twin-button-full mt-2" onClick={() => void load()}>{t('mobile.common.retry')}</button>
        </div>
      ) : null}
      {!loading && !error && !items.length ? (
        <section className="twin-panel twin-panel-padded flex flex-col items-center py-8 text-center" data-testid="nft-empty">
          <PhotoIcon className="h-9 w-9 text-[var(--text-secondary)]" aria-hidden />
          <h2 className="mt-3 text-sm font-semibold">{t('mobile.nfts.emptyTitle')}</h2>
          <p className="mt-1 text-xs leading-relaxed text-[var(--text-secondary)]">{t('mobile.nfts.emptyBody')}</p>
          <button type="button" className="twin-button twin-button-secondary mt-4" onClick={() => setMintOpen(true)}>{t('mobile.nfts.mint.action')}</button>
        </section>
      ) : null}
      {tiles.length ? (
        <div className="mobile-nft-grid" data-testid="nft-grid">
          {tiles.map(({ item, view }) => (
            <button key={`${item.kind}-${view.key}`} type="button" className="mobile-nft-tile" data-testid={`nft-item-${view.key}`} onClick={() => setDetail(item)}>
              <div className="relative">
                <NftArtwork sources={view.artworkSources} initials={view.artworkInitials} alt={view.title} />
                {certifiedCollection(item, registry) ? (
                  <span className="mobile-nft-certified" title={t('mobile.nfts.certified')}><CheckBadgeIcon className="h-4 w-4" aria-hidden /></span>
                ) : null}
              </div>
              <span className="mobile-nft-tile-copy">
                <span className="mobile-nft-tile-title">{view.title}</span>
                <span className="mobile-nft-tile-subtitle">{view.subtitle || (item.kind === 'mrc721' ? 'MRC-721' : 'MetaContract')}{view.badge ? ` · ${view.badge}` : ''}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {detail && detailTile ? (
        <BottomSheet title={detailTile.title} onClose={() => { setDetail(null); setCopied(false); }}>
          <div data-testid="nft-detail">
            <NftArtwork large sources={detailTile.artworkSources} initials={detailTile.artworkInitials} alt={detailTile.title} />
            <div className="mt-3 space-y-3">
              {detailRows.map((row) => (
                <div key={row.labelKey}>
                  <p className="text-[10px] font-medium uppercase tracking-wide text-[var(--text-secondary)]">{t(`mobile.nfts.field.${row.labelKey}`)}</p>
                  <p className={row.mono ? 'break-all font-mono text-xs leading-5' : 'text-xs leading-5'}>{row.value}</p>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button type="button" className="twin-button twin-button-secondary flex-1" onClick={() => { void copyTextToClipboard(detail.key).then((ok) => setCopied(ok)); }}>
                <ClipboardDocumentIcon className="h-4 w-4" aria-hidden />
                {copied ? t('mobile.nfts.copied') : t('mobile.nfts.copyId')}
              </button>
              {detail.kind === 'mrc721' && props.onOpenUri ? (
                <button type="button" className="twin-button twin-button-primary flex-1" data-testid="nft-open-browser" onClick={() => props.onOpenUri?.(`pin://${detail.key}`)}>
                  {t('mobile.nfts.openBrowser')}
                </button>
              ) : null}
            </div>
          </div>
        </BottomSheet>
      ) : null}

      {mintOpen ? (
        <MintSheet
          bots={props.bots}
          selectedBotId={selectedBotId}
          onSelectBot={setSelectedBotId}
          onClose={() => setMintOpen(false)}
          onMint={(request, prompt) => {
            setMintOpen(false);
            props.onMint(request, prompt);
          }}
        />
      ) : null}
    </SecondaryPageShell>
  );
}
