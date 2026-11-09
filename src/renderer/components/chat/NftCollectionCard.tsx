/**
 * NftCollectionCard — an MRC-721 collection (album) rendered as a chat card.
 *
 * Emitted by the mrc721 album tools (collection_create / collection_update
 * receipts) through the `nft-collection-card` fence; MarkdownContent
 * dispatches the tag here, while item `nft-card` fences keep rendering
 * through NftCard. Display-only: the emitter holds the facts at action time —
 * no heal channel (an album is not an item UTXO) and no detail modal (the
 * album lives in the app's NFT wallet and the issue wizard's result page).
 *
 * Visual contract: same framed-card language as NftCard (rounded border,
 * artwork with a corner tag, compact text rows), plus the album-specific
 * rows — path chip, mint progress (N / supply, or unlimited), royalty, the
 * copyable collectionid and the issuer. Fields degrade independently; the
 * collectionid is the floor.
 */

import React, { useMemo, useState } from 'react';
import { CheckIcon, DocumentDuplicateIcon } from '@heroicons/react/24/outline';
import { parseMetafileUri } from '../cowork/A2AMessageItem';
import { shortAddress } from './nftCardIdentity';
import { shortId } from './NftCard';
import type { NftCollectionCardData } from './nftCardSyntax';

const ACTION_LABELS: Record<string, string> = {
  issued: 'ISSUED',
  updated: 'UPDATED',
  info: 'COLLECTION',
};

const ACTION_BADGE_CLASS: Record<string, string> = {
  issued: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
  updated: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
  info: 'bg-claude-accent/15 text-claude-accent',
};

/** Mint progress label: "3 / 100", "3 minted · unlimited", "3 minted". */
export const collectionProgressLabel = (data: NftCollectionCardData): string | null => {
  if (data.totalSupply === -1) {
    return data.minted != null ? `${data.minted} minted · unlimited` : 'unlimited';
  }
  if (data.totalSupply != null) {
    return `${data.minted ?? 0} / ${data.totalSupply}`;
  }
  return data.minted != null ? `${data.minted} minted` : null;
};

/** Cover sources: the MRC-721 metafile route chain (compress routes are for wallet-api host ids, not album covers). */
const collectionCoverSources = (icon: string | undefined): string[] => {
  if (!icon) return [];
  const parsed = parseMetafileUri(icon);
  if (!parsed) return [];
  return [parsed.sourceUrl, parsed.fallbackUrl].filter((value, index, all) => value && all.indexOf(value) === index);
};

const CollectionCover: React.FC<{ data: NftCollectionCardData }> = ({ data }) => {
  const sources = useMemo(() => collectionCoverSources(data.icon), [data.icon]);
  const [sourceIndex, setSourceIndex] = useState(0);
  const initials = (data.name || data.collectionName || 'NFT').trim().charAt(0).toUpperCase() || 'N';
  if (sourceIndex >= sources.length) {
    return (
      <div className="flex h-[150px] w-full items-center justify-center bg-gradient-to-br from-claude-accent/10 to-claude-accent/5">
        <span className="text-3xl font-bold text-claude-accent/60">{initials}</span>
      </div>
    );
  }
  return (
    <img
      src={sources[sourceIndex]}
      alt={data.name || data.collectionName || 'Collection cover'}
      className="h-[150px] w-full object-cover"
      loading="lazy"
      onError={() => setSourceIndex((index) => index + 1)}
    />
  );
};

const CollectionIdCopy: React.FC<{ value: string }> = ({ value }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy collection id"
      title="Copy collection id"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1500);
        }).catch(() => { /* clipboard unavailable — the id stays readable */ });
      }}
      className="shrink-0 rounded p-0.5 text-claude-textSecondary transition-colors hover:bg-black/5 dark:text-claude-darkTextSecondary dark:hover:bg-white/10"
    >
      {copied
        ? <CheckIcon className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        : <DocumentDuplicateIcon className="h-3 w-3" />}
    </button>
  );
};

const NftCollectionCard: React.FC<{ data: NftCollectionCardData; className?: string }> = ({ data, className = '' }) => {
  const progress = collectionProgressLabel(data);
  const action = data.action && ACTION_LABELS[data.action] ? data.action : 'info';
  const badgeClass = ACTION_BADGE_CLASS[action] ?? ACTION_BADGE_CLASS.info;
  const royalty = data.royaltyRate != null ? `${data.royaltyRate}% royalty` : null;
  return (
    <div className={`my-2 w-[280px] max-w-full ${className}`}>
      <div
        data-nft-collection-card="true"
        data-nft-collection-id={data.collectionId}
        data-nft-collection-name={data.collectionName}
        title="MRC-721 collection"
        className="flex h-full w-full flex-col overflow-hidden rounded-xl border border-claude-border bg-claude-surface shadow-subtle dark:border-claude-darkBorder dark:bg-claude-darkSurface"
      >
        <div className="relative">
          <CollectionCover data={data} />
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
            MRC-721
          </span>
        </div>
        <div className="flex flex-col gap-[3px] px-2.5 pt-1.5 pb-2">
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] leading-tight" data-nft-collection-row="meta">
            <span className={`shrink-0 rounded px-1 py-0.5 text-[9px] font-bold tracking-wide ${badgeClass}`}>
              {ACTION_LABELS[action]}
            </span>
            {data.collectionName && (
              <span className="truncate font-mono text-claude-textSecondary dark:text-claude-darkTextSecondary">
                /{data.collectionName}
              </span>
            )}
            {progress && (
              <span className="ml-auto shrink-0 font-medium text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {progress}
              </span>
            )}
          </div>
          <div className="flex min-w-0 items-baseline gap-1 leading-tight" data-nft-collection-row="name">
            <span className="truncate text-sm font-semibold text-claude-text dark:text-claude-darkText">
              {data.name || data.collectionName || 'Collection'}
            </span>
            {royalty && (
              <span className="ml-auto shrink-0 text-[10px] text-claude-textSecondary dark:text-claude-darkTextSecondary">
                {royalty}
              </span>
            )}
          </div>
          {data.desc && (
            <p
              className="line-clamp-2 text-[11px] leading-snug text-claude-textSecondary dark:text-claude-darkTextSecondary"
              data-nft-collection-row="desc"
            >
              {data.desc}
            </p>
          )}
          <div
            className="flex min-w-0 items-center gap-1 text-[10px] leading-tight text-claude-textSecondary dark:text-claude-darkTextSecondary"
            data-nft-collection-row="id"
          >
            <span className="truncate font-mono">{shortId(data.collectionId)}</span>
            <CollectionIdCopy value={data.collectionId} />
          </div>
          {(data.issuer || data.issuerLabel) && (
            <div
              className="min-w-0 truncate text-[10px] leading-tight text-claude-textSecondary dark:text-claude-darkTextSecondary"
              data-nft-collection-row="issuer"
            >
              Issuer: {data.issuerLabel || (data.issuer ? shortAddress(data.issuer) : '')}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NftCollectionCard;
