/**
 * nft-card fence builder for the wallet tools (S3 chat NFT cards).
 *
 * The sell/transfer/buy/cancel tools append one fenced block to their success
 * results; the bot broadcasts that block verbatim in its announcement message
 * and every markdown surface (CoWork conversation, A2A private chat, group /
 * group-task transcript) renders it as an NftCard. The renderer-side contract
 * lives in src/renderer/components/chat/nftCardSyntax.ts — key order and the
 * fence tag are pinned by tests on both sides so the two shapes can never
 * drift apart.
 *
 * This module is pure (no fetch): the tools resolve artwork/series facts from
 * wallet-api through control.listMvcNfts and pass them in.
 */

import type { MvcNftBalance } from '../services/mvcNftService';

export const NFT_CARD_FENCE_TAG = 'nft-card';

export const NFT_CARD_RESULT_HINT =
  'Chat NFT card — include this fenced block verbatim in your broadcast/announcement message so every chat client (CoWork, private chat, group chat) renders the NFT card:';

export interface NftCardEmitFields {
  genesis: string;
  codehash: string;
  tokenIndex: string;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  owner?: string;
  ownerLabel?: string;
  priceSats?: number;
  action?: string;
}

const NFT_CARD_KEY_ORDER: Array<keyof NftCardEmitFields> = [
  'genesis', 'codehash', 'tokenIndex', 'name', 'series', 'imgUrl', 'icon',
  'owner', 'ownerLabel', 'priceSats', 'action',
];

const cleanOptional = (value: string | undefined, max: number): string | undefined => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/\s+/g, ' ').slice(0, max) || undefined;
};

/** Serialize one card to the exact fence form (fixed key order, compact JSON). */
export const buildNftCardFence = (fields: NftCardEmitFields): string => {
  const ordered: Record<string, unknown> = {};
  for (const key of NFT_CARD_KEY_ORDER) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== '') {
      ordered[key] = value;
    }
  }
  return `\`\`\`${NFT_CARD_FENCE_TAG}\n${JSON.stringify(ordered)}\n\`\`\``;
};

/** Result text + blank line + hint + fence. Used by every emitting tool. */
export const appendNftCardBlock = (resultText: string, fields: NftCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftCardFence(fields)}`;

export interface NftCardDetailFacts {
  name?: string;
  series?: string;
  icon?: string;
  imgUrl?: string;
}

/**
 * Pull the display facts (name/series/icon/imgUrl) for one token out of a
 * wallet-api NFT balance snapshot. Returns null when the genesis/tokenIndex
 * pair is not in the snapshot — callers then emit an identity-only card.
 */
export const findNftCardDetail = (
  balance: MvcNftBalance | undefined,
  genesis: string,
  tokenIndex: string,
): NftCardDetailFacts | null => {
  if (!balance?.collections) return null;
  const wantedGenesis = genesis.trim().toLowerCase();
  const wantedIndex = String(tokenIndex).trim();
  for (const collection of balance.collections) {
    if (String(collection.genesis || '').trim().toLowerCase() !== wantedGenesis) continue;
    const item = collection.items.find((candidate) => candidate.tokenIndex === wantedIndex);
    if (!item) continue;
    return {
      name: cleanOptional(item.name, 64),
      series: cleanOptional(collection.seriesName, 64),
      icon: cleanOptional(item.icon, 512),
      imgUrl: cleanOptional(item.imgUrl, 512),
    };
  }
  return null;
};
