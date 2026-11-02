/**
 * NftCard — an on-chain NFT rendered as a chat card, dual format.
 *
 * Any markdown surface that routes through MarkdownContent (CoWork
 * conversation bubbles, A2A private-chat bubbles, group/group-task
 * transcripts) renders a `nft-card` fenced block through this component
 * instead of a code fence. MRC-721 (pin-based MetaID NFT) is the primary
 * format; MetaContract cards stay compatible (transitional). The card always
 * shows the identity (series/collection · number/tokenIndex · pinId or
 * genesis) plus the artwork and, when the emitter embedded them, the owner,
 * issuer and price at broadcast time; clicking opens a PORTAL-level detail
 * modal (document.body, shared verbatim by every chat surface).
 *
 * Visual contract (S3 acceptance): the card is a framed, labeled block —
 * distinct from a plain markdown image bubble, which stays a bare rounded
 * <img> — and carries a format tag ('MRC-721' / 'MetaContract') at the
 * artwork's bottom-right corner (the detail modal's tag sits at the IMAGE's
 * corner too — its wrapper never stretches past the artwork). Holder and
 * issuer render as avatar + name chips (address → identity via the existing
 * metaid info IPC); every resolution failure degrades to the emitter label,
 * then a short address — never a blank card. Artwork degradation is
 * layered and size-aware (owner-finalized dual image-host spec): the card
 * tries the MetaLet compress direct link (wallet-api icons are MetaLet
 * image-host ids, not MetaID metafiles) then the wire imgUrl; the detail
 * view puts the showpay OSS original first, falling back to compress;
 * MRC-721 keeps the imgUrl → metafile routes chain; the floor is the
 * initials placeholder — the card never renders a broken image glyph.
 *
 * The component is display-only: data comes verbatim from the fence payload
 * the emitter (usually a wallet/mrc721 tool result) built at action time.
 * Two side channels exist, both cached per identity: the identity lookup
 * (per address), and the heal channel (per card identity — fills missing
 * artwork / the metacontract issuer after first paint; see nftCardHeal).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { DocumentDuplicateIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import { useNftCardIdentity, shortAddress } from './nftCardIdentity';
import { useNftCardHeal } from './nftCardHeal';
import type { NftCardData } from './nftCardSyntax';

const ACTION_LABELS: Record<string, string> = {
  listed: 'LISTED',
  transferred: 'TRANSFERRED',
  sold: 'SOLD',
  bought: 'BOUGHT',
  escrow: 'ESCROW',
  delisted: 'DELISTED',
  minted: 'MINTED',
  info: 'NFT',
};

const ACTION_BADGE_CLASS: Record<string, string> = {
  listed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  sold: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  bought: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  transferred: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  escrow: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  delisted: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
  minted: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  info: 'bg-claude-accent/15 text-claude-accent',
};

export const shortId = (id: string, head = 10, tail = 6): string =>
  id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;

export const formatNftPrice = (priceSats: number | undefined): string | null => {
  if (priceSats === undefined || priceSats === null) return null;
  const sats = `${priceSats.toLocaleString('en-US')} sats`;
  if (priceSats === 0) return sats;
  const space = priceSats / 1e8;
  const spaceText = space >= 0.01 ? space.toFixed(space >= 1000 ? 0 : 2) : space.toPrecision(2);
  return `${sats} · ${Number(spaceText).toString()} SPACE`;
};

/** The card's serial display: MetaContract tokenIndex, or MRC-721 mint number. */
export const nftCardSerial = (data: NftCardData): string | null => {
  if (data.tokenIndex) return data.tokenIndex;
  if (data.number != null) return String(data.number);
  return null;
};

const FORMAT_TAG_LABEL: Record<NftCardData['format'], string> = {
  mrc721: 'MRC-721',
  metacontract: 'MetaContract',
};

export interface NftCardArtwork {
  /** Ordered candidate <img> sources; empty when nothing renderable. */
  sources: string[];
  /** true when the payload carried no artwork reference at all. */
  missing: boolean;
}

/**
 * MetaLet image-host file id for a wallet-api icon. wallet-api v4 `icon`
 * values (even the metafile://-prefixed ones) are MetaLet image-host file
 * names whose id is NOT a MetaID metafile — the accelerate chain 404s on
 * them (live-verified 2026-11-02: icon metafile://47ff4ea0….png rendered
 * the placeholder while the MetaLet compress route answered 200
 * image/png). The id is the file name minus the metafile:// scheme and
 * any extension (owner-finalized image spec, 2026-11-02 23:08).
 */
export const metaletFileIdOf = (icon: string): string | null => {
  const base = icon.trim().replace(/^metafile:\/\//i, '').split(/[?#]/)[0] ?? '';
  const fileId = base.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  return /^[0-9a-f]{64}$/i.test(fileId) ? fileId.toLowerCase() : null;
};

/**
 * Card thumbnail host (owner-finalized): the no-www compress route. The
 * host answers 301 → www which <img> follows transparently, landing on
 * 200 image/png (live-verified 2026-11-02 on MetaBot Avatar icons).
 */
export const metaletCompressUrlOf = (icon: string): string | null => {
  const fileId = metaletFileIdOf(icon);
  return fileId ? `https://metalet.space/metafile/compress/${fileId}` : null;
};

/**
 * Detail-page large image (owner-finalized): the showpay OSS original —
 * measurably sharper than the compress variant (97KB vs 14KB on the
 * MetaBot Avatar sample, both answering 200 image/png).
 */
export const showpayOriginalUrlOf = (icon: string): string | null => {
  const fileId = metaletFileIdOf(icon);
  return fileId ? `https://showpay.oss-cn-beijing.aliyuncs.com/metaFile/original/${fileId}.png` : null;
};

/**
 * Pure artwork resolution (exported for SSR tests). MetaContract follows
 * the owner-finalized dual image-host spec: the card prefers the MetaLet
 * compress direct link derived from the icon, then the wire imgUrl; the
 * DETAIL view (large) puts the showpay OSS original first — falling back
 * to compress, then the wire imgUrl — before the icon metafile routes.
 * MRC-721 keeps the original three-level chain (imgUrl → accelerate →
 * direct) at both sizes. Only exact https URLs and parseable metafile://
 * URIs survive the syntax layer, so building the chain needs no extra
 * sanitizing.
 */
export const resolveNftCardArtwork = (data: NftCardData, opts?: { large?: boolean }): NftCardArtwork => {
  const sources: string[] = [];
  if (data.format === 'metacontract' && data.icon) {
    if (opts?.large) {
      const original = showpayOriginalUrlOf(data.icon);
      if (original) sources.push(original);
    }
    const compress = metaletCompressUrlOf(data.icon);
    if (compress) sources.push(compress);
  }
  if (data.imgUrl && !sources.includes(data.imgUrl)) sources.push(data.imgUrl);
  if (data.icon) {
    const parsed = parseMetafileUri(data.icon);
    if (parsed) {
      if (!sources.includes(parsed.sourceUrl)) sources.push(parsed.sourceUrl);
      if (!sources.includes(parsed.fallbackUrl)) sources.push(parsed.fallbackUrl);
    }
  }
  return { sources, missing: sources.length === 0 };
};

const initialsOf = (data: NftCardData): string => {
  const base = data.name?.trim() || data.series?.trim() || 'NFT';
  return base.slice(0, 2).toUpperCase();
};

const copyTextToClipboard = (value: string): void => {
  if (!value || typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return;
  void navigator.clipboard.writeText(value).catch(() => {});
};

const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      copyTextToClipboard(value);
    }}
    className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-current opacity-60 transition-opacity hover:opacity-100"
    title={`Copy ${label}`}
    aria-label={`Copy ${label}`}
  >
    <DocumentDuplicateIcon className="h-3 w-3" />
  </button>
);

/**
 * Format tag pinned at the artwork's bottom-right corner — the visual
 * contract that makes a card distinguishable at a glance and names the
 * identity format (MRC-721 primary / MetaContract transitional).
 */
const NftCardFormatTag: React.FC<{ format: NftCardData['format'] }> = ({ format }) => (
  <span
    data-nft-format={format}
    className={`pointer-events-none absolute bottom-1.5 right-1.5 rounded px-1.5 py-px text-[10px] font-semibold leading-tight shadow-sm backdrop-blur-sm ${
      format === 'mrc721' ? 'bg-violet-600/85 text-white' : 'bg-slate-600/80 text-white'
    }`}
  >
    {FORMAT_TAG_LABEL[format]}
  </span>
);

const NftCardPlaceholder: React.FC<{ data: NftCardData; large?: boolean }> = ({ data, large }) => (
  <div
    className={`flex w-full items-center justify-center bg-gradient-to-br from-claude-accent/10 to-violet-500/10 dark:from-claude-accent/20 dark:to-violet-500/20 ${
      large ? 'min-h-[280px] text-4xl' : 'aspect-square text-2xl'
    } font-semibold tracking-wide text-claude-accent`}
  >
    {initialsOf(data)}
  </div>
);

const NftCardImage: React.FC<{ data: NftCardData; large?: boolean }> = ({ data, large }) => {
  const artwork = useMemo(() => resolveNftCardArtwork(data, { large }), [data, large]);
  const [failedCount, setFailedCount] = useState(0);
  const exhausted = failedCount >= artwork.sources.length;

  if (artwork.missing || exhausted) {
    return <NftCardPlaceholder data={data} large={large} />;
  }
  const serial = nftCardSerial(data);
  return (
    <img
      src={artwork.sources[failedCount]}
      alt={data.name ? `${data.name}${serial ? ` #${serial}` : ''}` : `NFT${serial ? ` #${serial}` : ''}`}
      loading="lazy"
      className={`block w-full bg-black/5 object-cover dark:bg-white/5 ${large ? 'max-h-[60vh]' : 'aspect-square'}`}
      onError={() => setFailedCount((n) => n + 1)}
    />
  );
};

const ActionBadge: React.FC<{ action?: string }> = ({ action }) => {
  if (!action) return null;
  const label = ACTION_LABELS[action] ?? (action.length <= 10 ? action.toUpperCase() : null);
  if (!label) return null;
  return (
    <span
      className={`shrink-0 rounded px-1.5 py-px text-[10px] font-semibold leading-tight ${
        ACTION_BADGE_CLASS[action] ?? ACTION_BADGE_CLASS.info
      }`}
    >
      {label}
    </span>
  );
};

/** Circular avatar with an initial fallback — never a broken image. */
const IdentityAvatar: React.FC<{ name: string | null; avatarUrl?: string | null; className?: string }> = ({
  name,
  avatarUrl,
  className = 'h-4 w-4 text-[9px]',
}) => {
  const [failed, setFailed] = useState(false);
  const initial = (name || '?').trim().slice(0, 1).toUpperCase() || '?';
  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
        className={`shrink-0 rounded-full bg-black/10 object-cover dark:bg-white/10 ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`flex shrink-0 items-center justify-center rounded-full bg-claude-accent/15 font-semibold text-claude-accent ${className}`}
    >
      {initial}
    </span>
  );
};

/**
 * Avatar + name chip for an address (NFT holder / collection issuer). The
 * identity resolves through the existing metaid info IPC; display order is
 * resolved name → emitter label → short address, so the chip always renders.
 */
export const NftCardIdentityChip: React.FC<{
  address?: string;
  label?: string;
  className?: string;
}> = ({ address, label, className = '' }) => {
  const identity = useNftCardIdentity(address);
  const displayName = identity?.name || label || (address ? shortAddress(address) : null);
  if (!displayName) return null;
  return (
    <span
      data-nft-identity={address || displayName}
      title={address || undefined}
      className={`flex min-w-0 items-center gap-1 ${className}`}
    >
      <IdentityAvatar name={displayName} avatarUrl={identity?.avatarUrl ?? null} />
      <span className="truncate">{displayName}</span>
    </span>
  );
};

interface DetailField {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}

const buildDetailFields = (data: NftCardData): DetailField[] => {
  const fields: DetailField[] = [];
  if (data.name) fields.push({ label: 'Name', value: data.name });
  if (data.series) {
    fields.push({ label: data.format === 'mrc721' ? 'Collection' : 'Series', value: data.series });
  }
  if (data.format === 'mrc721') {
    if (data.number != null) fields.push({ label: 'Number', value: `#${data.number}`, mono: true });
    if (data.pinId) fields.push({ label: 'Pin id', value: data.pinId, mono: true, copy: true });
  } else {
    if (data.tokenIndex) fields.push({ label: 'Token index', value: `#${data.tokenIndex}`, mono: true, copy: true });
    if (data.genesis) fields.push({ label: 'Genesis', value: data.genesis, mono: true, copy: true });
    if (data.codehash) fields.push({ label: 'Codehash', value: data.codehash, mono: true, copy: true });
  }
  const price = formatNftPrice(data.priceSats);
  if (price) fields.push({ label: 'Price', value: price });
  return fields;
};

const DetailIdentityRow: React.FC<{ label: string; address?: string; labelFallback?: string }> = ({
  label,
  address,
  labelFallback,
}) => {
  if (!address && !labelFallback) return null;
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
        {label}
      </div>
      <div className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 dark:text-claude-darkText text-claude-text">
        <NftCardIdentityChip address={address} label={labelFallback} className="min-w-0 flex-1" />
        {address && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
            {shortAddress(address)}
            <CopyButton value={address} label={label.toLowerCase()} />
          </span>
        )}
      </div>
    </div>
  );
};

/**
 * Global (portal-level) detail modal — one shared implementation for every
 * chat surface. Rendered into document.body so no bubble transform/overflow
 * clipping can trap it; content is identical wherever the card lives.
 * Exported for SSR tests (the badge-at-image contract).
 */
export const NftCardDetailModal: React.FC<{ data: NftCardData; onClose: () => void }> = ({ data, onClose }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const serial = nftCardSerial(data);
  const title = data.name ? `${data.name}${serial ? ` #${serial}` : ''}` : `NFT${serial ? ` #${serial}` : ''}`;
  const note =
    data.format === 'mrc721'
      ? 'MRC-721 pin-based MetaID NFT · fields as of the broadcast message (owner and price reflect the action that emitted this card).'
      : 'MVC MetaContract NFT · fields as of the broadcast message (owner and price reflect the action that emitted this card).';

  const content = (
    <div
      data-nft-card-detail="true"
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`NFT detail: ${title}`}
    >
      <div
        className="flex max-h-[86vh] w-[min(94vw,640px)] flex-col overflow-hidden rounded-2xl border border-claude-border bg-claude-surface shadow-xl dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-2 border-b border-claude-border px-4 py-2 dark:border-claude-darkBorder">
          <div className="flex min-w-0 items-center gap-2">
            <ActionBadge action={data.action ?? 'info'} />
            <span className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">
              {title}
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
            aria-label="Close NFT detail"
          >
            <XMarkIcon className="h-4 w-4" />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col items-start overflow-y-auto sm:flex-row">
          {/* self-start keeps the wrapper at the artwork's own height so the
              format tag sits at the IMAGE's bottom-right corner, not at the
              (stretched) container's. */}
          <div className="relative w-full shrink-0 self-start sm:w-[46%]">
            <NftCardImage data={data} large />
            <NftCardFormatTag format={data.format} />
          </div>
          <div className="flex w-full min-w-0 flex-1 flex-col gap-3 px-4 py-3">
            <p className="text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              {note}
            </p>
            <div className="flex flex-col gap-2.5">
              <DetailIdentityRow label="Owner" address={data.owner} labelFallback={data.ownerLabel} />
              {(data.issuer || data.issuerLabel) && (
                <DetailIdentityRow label="Issuer" address={data.issuer} labelFallback={data.issuerLabel} />
              )}
            </div>
            <div className="flex flex-col gap-2 border-t border-claude-border pt-3 dark:border-claude-darkBorder">
              {buildDetailFields(data).map((field) => (
                <div key={field.label} className="min-w-0">
                  <div className="text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    {field.label}
                  </div>
                  <div
                    className={`flex items-start gap-1 text-[12px] leading-4 dark:text-claude-darkText text-claude-text ${
                      field.mono ? 'font-mono [overflow-wrap:anywhere]' : ''
                    }`}
                  >
                    <span className="min-w-0 break-all">{field.value}</span>
                    {field.copy && <CopyButton value={field.value} label={field.label.toLowerCase()} />}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') return content; // SSR fallback — modal is click-only anyway
  return createPortal(content, document.body);
};

const NftCard: React.FC<{ data: NftCardData; className?: string }> = ({ data, className = '' }) => {
  const [detailOpen, setDetailOpen] = useState(false);
  const openDetail = useCallback(() => setDetailOpen(true), []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);
  // Fallback lookups (missing artwork / metacontract issuer) fill in
  // asynchronously after first paint; until then the placeholder and short
  // address render as-is.
  const healed = useNftCardHeal(data);

  const serial = nftCardSerial(healed);
  const title = healed.name || `NFT${serial ? ` #${serial}` : ''}`;
  const price = formatNftPrice(healed.priceSats);
  const identityLine = healed.format === 'mrc721' ? healed.pinId : healed.genesis;

  return (
    <>
      <div className={`my-2 w-[280px] max-w-full ${className}`}>
        <button
          type="button"
          data-nft-card="true"
          data-nft-format={healed.format}
          data-nft-token-index={healed.tokenIndex}
          data-nft-pin-id={healed.pinId}
          onClick={openDetail}
          title="View NFT details"
          aria-label={`View NFT details: ${title}`}
          className="block w-full overflow-hidden rounded-xl border border-claude-border bg-claude-surface text-left shadow-subtle transition-shadow hover:shadow-md dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        >
          <div className="relative">
            <NftCardImage data={healed} />
            <NftCardFormatTag format={healed.format} />
          </div>
          <div className="flex flex-col gap-1 px-3 py-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <ActionBadge action={healed.action} />
              {healed.series ? (
                <span className="truncate text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {healed.series}
                </span>
              ) : (
                <span className="truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {identityLine ? shortId(identityLine, 8, 6) : 'NFT'}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-baseline gap-1">
              <span className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{title}</span>
              {serial && (
                <span className="shrink-0 font-mono text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  #{serial}
                </span>
              )}
            </div>
            {(healed.owner || healed.ownerLabel || healed.issuer || healed.issuerLabel || price) && (
              <div className="flex flex-col gap-0.5 pt-0 text-[11px] leading-tight">
                {(healed.owner || healed.ownerLabel) && (
                  <div className="flex min-w-0 items-center gap-1.5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    <span className="shrink-0 opacity-70">Owner</span>
                    <NftCardIdentityChip address={healed.owner} label={healed.ownerLabel} className="min-w-0 flex-1" />
                  </div>
                )}
                {(healed.issuer || healed.issuerLabel) && (
                  <div className="flex min-w-0 items-center gap-1.5 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                    <span className="shrink-0 opacity-70">Issuer</span>
                    <NftCardIdentityChip address={healed.issuer} label={healed.issuerLabel} className="min-w-0 flex-1" />
                  </div>
                )}
                {price && (
                  <div className="flex items-center justify-end">
                    <span className="shrink-0 font-semibold text-claude-accent">{price.split(' · ')[0]}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </button>
      </div>
      {detailOpen && <NftCardDetailModal data={healed} onClose={closeDetail} />}
    </>
  );
};

const cardKeyOf = (data: NftCardData, index: number): string =>
  data.pinId || (data.genesis && data.tokenIndex ? `${data.genesis}:${data.tokenIndex}` : `card-${index}`);

/**
 * Side-by-side layout for several cards in one message (the nft-card-group
 * fence MarkdownContent produces from adjacent nft-card fences). Horizontal
 * scroll when the row overflows; a single fence never enters this path.
 */
export const NftCardGroup: React.FC<{ cards: NftCardData[]; className?: string }> = ({ cards, className = '' }) => {
  if (!cards.length) return null;
  return (
    <div data-nft-card-group="true" className={`my-2 flex items-start gap-2 overflow-x-auto pb-1 ${className}`}>
      {cards.map((card, index) => (
        <NftCard key={cardKeyOf(card, index)} data={card} className="my-0 shrink-0" />
      ))}
    </div>
  );
};

export default NftCard;
