/**
 * NftCard — an on-chain MVC MetaContract NFT rendered as a chat card.
 *
 * Any markdown surface that routes through MarkdownContent (CoWork
 * conversation bubbles, A2A private-chat bubbles, group/group-task
 * transcripts) renders a `nft-card` fenced block through this component
 * instead of a code fence. The card always shows the identity triple
 * (series · #tokenIndex · genesis) plus the artwork and, when the emitter
 * embedded them, the owner and price at broadcast time; clicking opens a
 * detail overlay with every field and copy buttons.
 *
 * Visual contract (S3 acceptance): the card is a framed, labeled block —
 * distinct from a plain markdown image bubble, which stays a bare rounded
 * <img>. Degradation is layered: imgUrl (https direct) → icon metafile
 * content route → initials placeholder; the card never renders a broken
 * image glyph.
 *
 * The component is display-only and makes no network calls beyond the
 * artwork <img> itself (same as any markdown image). Data comes verbatim
 * from the fence payload the emitter (usually a wallet tool result) built
 * at action time.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { DocumentDuplicateIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import type { NftCardData } from './nftCardSyntax';

const ACTION_LABELS: Record<string, string> = {
  listed: 'LISTED',
  transferred: 'TRANSFERRED',
  sold: 'SOLD',
  bought: 'BOUGHT',
  escrow: 'ESCROW',
  delisted: 'DELISTED',
  info: 'NFT',
};

const ACTION_BADGE_CLASS: Record<string, string> = {
  listed: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  sold: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  bought: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
  transferred: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  escrow: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  delisted: 'bg-rose-500/15 text-rose-600 dark:text-rose-400',
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

export interface NftCardArtwork {
  /** Ordered candidate <img> sources; empty when nothing renderable. */
  sources: string[];
  /** true when the payload carried no artwork reference at all. */
  missing: boolean;
}

/**
 * Pure artwork resolution (exported for SSR tests): https imgUrl first, then
 * the icon metafile's accelerate→direct content routes. Only exact https
 * URLs and parseable metafile:// URIs survive the syntax layer, so building
 * the fallback chain here needs no extra sanitizing.
 */
export const resolveNftCardArtwork = (data: NftCardData): NftCardArtwork => {
  const sources: string[] = [];
  if (data.imgUrl) sources.push(data.imgUrl);
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
  const artwork = useMemo(() => resolveNftCardArtwork(data), [data]);
  const [failedCount, setFailedCount] = useState(0);
  const exhausted = failedCount >= artwork.sources.length;

  if (artwork.missing || exhausted) {
    return <NftCardPlaceholder data={data} large={large} />;
  }
  return (
    <img
      src={artwork.sources[failedCount]}
      alt={data.name ? `${data.name} #${data.tokenIndex}` : `NFT #${data.tokenIndex}`}
      loading="lazy"
      className={`w-full bg-black/5 object-cover dark:bg-white/5 ${large ? 'max-h-[60vh]' : 'aspect-square'}`}
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

interface DetailField {
  label: string;
  value: string;
  mono?: boolean;
  copy?: boolean;
}

const buildDetailFields = (data: NftCardData): DetailField[] => {
  const fields: DetailField[] = [];
  if (data.name) fields.push({ label: 'Name', value: data.name });
  if (data.series) fields.push({ label: 'Series', value: data.series });
  fields.push({ label: 'Token index', value: `#${data.tokenIndex}`, mono: true, copy: true });
  fields.push({ label: 'Genesis', value: data.genesis, mono: true, copy: true });
  fields.push({ label: 'Codehash', value: data.codehash, mono: true, copy: true });
  if (data.owner) {
    fields.push({
      label: 'Owner',
      value: data.ownerLabel ? `${data.ownerLabel} · ${data.owner}` : data.owner,
      mono: true,
      copy: true,
    });
  }
  const price = formatNftPrice(data.priceSats);
  if (price) fields.push({ label: 'Price', value: price });
  return fields;
};

const NftCardDetailOverlay: React.FC<{ data: NftCardData; onClose: () => void }> = ({ data, onClose }) => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const title = data.name ? `${data.name} #${data.tokenIndex}` : `NFT #${data.tokenIndex}`;
  return (
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
        <div className="flex items-center justify-between gap-2 border-b border-claude-border px-4 py-2.5 dark:border-claude-darkBorder">
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
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto sm:flex-row">
          <div className="shrink-0 sm:w-[46%]">
            <NftCardImage data={data} large />
          </div>
          <div className="flex-1 space-y-2.5 px-4 py-3">
            <p className="text-[11px] leading-4 text-claude-textSecondary dark:text-claude-darkTextSecondary">
              MVC MetaContract NFT · fields as of the broadcast message (owner and price reflect the action that emitted this card).
            </p>
            {buildDetailFields(data).map((field) => (
              <div key={field.label} className="min-w-0">
                <div className="text-[10px] font-medium uppercase tracking-wide text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {field.label}
                </div>
                <div
                  className={`flex items-start gap-1 text-[12px] leading-5 dark:text-claude-darkText text-claude-text ${
                    field.mono ? 'font-mono [overflow-wrap:anywhere]' : ''
                  }`}
                >
                  <span className="min-w-0 break-all">{field.value}</span>
                  {field.copy && <CopyButton value={field.value.replace(/^[^·]+·\s*/, '')} label={field.label.toLowerCase()} />}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

const NftCard: React.FC<{ data: NftCardData; className?: string }> = ({ data, className = '' }) => {
  const [detailOpen, setDetailOpen] = useState(false);
  const openDetail = useCallback(() => setDetailOpen(true), []);
  const closeDetail = useCallback(() => setDetailOpen(false), []);

  const title = data.name || `NFT #${data.tokenIndex}`;
  const price = formatNftPrice(data.priceSats);
  const ownerDisplay = data.ownerLabel || (data.owner ? shortId(data.owner, 10, 6) : null);

  return (
    <>
      <div className={`my-2 w-[280px] max-w-full ${className}`}>
        <button
          type="button"
          data-nft-card="true"
          data-nft-token-index={data.tokenIndex}
          onClick={openDetail}
          title="View NFT details"
          aria-label={`View NFT details: ${title}`}
          className="block w-full overflow-hidden rounded-xl border border-claude-border bg-claude-surface text-left shadow-subtle transition-shadow hover:shadow-md dark:border-claude-darkBorder dark:bg-claude-darkSurface"
        >
          <NftCardImage data={data} />
          <div className="space-y-1.5 px-3 py-2.5">
            <div className="flex min-w-0 items-center gap-1.5">
              <ActionBadge action={data.action} />
              {data.series ? (
                <span className="truncate text-[11px] font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {data.series}
                </span>
              ) : (
                <span className="truncate font-mono text-[11px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  {shortId(data.genesis, 8, 6)}
                </span>
              )}
            </div>
            <div className="flex min-w-0 items-baseline gap-1.5">
              <span className="truncate text-sm font-semibold dark:text-claude-darkText text-claude-text">{title}</span>
              <span className="shrink-0 font-mono text-xs text-claude-textSecondary dark:text-claude-darkTextSecondary">
                #{data.tokenIndex}
              </span>
            </div>
            <div className="flex min-w-0 items-center justify-between gap-2 pt-0.5 text-[11px] leading-4">
              {ownerDisplay ? (
                <span className="flex min-w-0 items-center gap-1 text-claude-textSecondary dark:text-claude-darkTextSecondary">
                  <span className="shrink-0 opacity-70">Owner</span>
                  <span className="truncate">{ownerDisplay}</span>
                </span>
              ) : (
                <span />
              )}
              {price && (
                <span className="shrink-0 font-semibold text-claude-accent">{price.split(' · ')[0]}</span>
              )}
            </div>
          </div>
        </button>
      </div>
      {detailOpen && <NftCardDetailOverlay data={data} onClose={closeDetail} />}
    </>
  );
};

export default NftCard;
