/**
 * nft-card fence builder for the wallet and mrc721 tools (S3 chat NFT cards).
 *
 * The sell/transfer/buy/cancel/mint tools append one fenced block to their
 * success results; the bot broadcasts that block verbatim in its announcement
 * message and every markdown surface (CoWork conversation, A2A private chat,
 * group / group-task transcript) renders it as an NftCard. The renderer-side
 * contract lives in src/renderer/components/chat/nftCardSyntax.ts — key order
 * and the fence tag are pinned by tests on both sides so the two shapes can
 * never drift apart.
 *
 * Dual format (MRC-721 primary, MetaContract transitional): MetaContract cards
 * carry `format:"metacontract"` + the genesis triple; MRC-721 cards carry
 * `format:"mrc721"` + `pinId` (+ `number`/`issuer`). Legacy fences without a
 * format field parse as metacontract, so old payloads never regress.
 *
 * This module is pure (no fetch): the tools resolve artwork/series facts from
 * wallet-api through control.listMvcNfts / the mrc721 index reads through
 * control.fetchItemInfo and pass them in.
 */

import type { MvcNftBalance } from '../services/mvcNftService';

export const NFT_CARD_FENCE_TAG = 'nft-card';

export const NFT_CARD_RESULT_HINT =
  'Chat NFT card — include this fenced block verbatim in your broadcast/announcement message so every chat client (CoWork, private chat, group chat) renders the NFT card:';

export type NftCardEmitFormat = 'metacontract' | 'mrc721';

export interface NftCardEmitFields {
  format?: NftCardEmitFormat;
  /** MRC-721 item pinId (required for mrc721 cards). */
  pinId?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  /** MRC-721 mint serial inside the collection. */
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  owner?: string;
  ownerLabel?: string;
  /** MRC-721 collection issuer address (authenticity signal). */
  issuer?: string;
  issuerLabel?: string;
  priceSats?: number;
  action?: string;
  /**
   * Host source signature (S4 Correction slice, owner decision A): stamped by
   * tradeActivityStamp when the host actually executes this card's trade —
   * only stamps allow the trade-mark scanner to produce trade markers.
   */
  hostStamp?: string;
}

const NFT_CARD_KEY_ORDER: Array<keyof NftCardEmitFields> = [
  'format', 'pinId', 'genesis', 'codehash', 'tokenIndex', 'number', 'name',
  'series', 'imgUrl', 'icon', 'owner', 'ownerLabel', 'issuer', 'issuerLabel',
  'priceSats', 'action', 'hostStamp',
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

/**
 * Normalize one artwork reference (the MRC-721 item cover) into the fence's
 * artwork fields: https direct link → imgUrl, metafile:// or bare pinId
 * (extension allowed) → icon. Anything else is dropped — the renderer's
 * first-letter placeholder is the floor, never a broken image.
 */
export const normalizeMrc721Cover = (cover: string | undefined): { imgUrl?: string; icon?: string } => {
  const value = String(cover ?? '').trim();
  if (!value) return {};
  if (/^https:\/\//i.test(value) && !/\s/.test(value)) return { imgUrl: value.slice(0, 512) };
  const stripped = value.toLowerCase().startsWith('metafile://') ? value.slice('metafile://'.length) : value;
  const base = (stripped.split(/[?#]/)[0] || '').trim();
  if (!base) return {};
  const pin = base.includes('.') ? base.slice(0, base.lastIndexOf('.')) : base;
  if (!/^[0-9a-fA-F]{64}i\d+$/.test(pin)) return {};
  return { icon: `metafile://${pin.toLowerCase()}` };
};

/**
 * Display facts the mrc721 tools hold at action time (Mrc721ItemSummary
 * subset — intentionally structural so tests can stub it without the service).
 */
export interface Mrc721CardFactsInput {
  item?: {
    name?: string;
    collectionName?: string;
    number?: number;
    cover?: string;
    ownerAddress?: string;
  } | null;
  issuerAddress?: string;
}

/**
 * Build the MRC-721 emit fields from index facts + the action context. Facts
 * degrade field by field: a missing item snapshot yields an identity-only
 * card (format+pinId+owner+action), never a missing card.
 */
export const buildMrc721CardFields = (input: {
  pinId: string;
  facts?: Mrc721CardFactsInput | null;
  owner?: string;
  ownerLabel?: string;
  priceSats?: number;
  action?: string;
}): NftCardEmitFields => {
  const item = input.facts?.item ?? null;
  const cover = normalizeMrc721Cover(item?.cover);
  const fields: NftCardEmitFields = {
    format: 'mrc721',
    pinId: input.pinId,
  };
  if (item?.number != null && Number.isInteger(item.number) && item.number >= 0) {
    fields.number = item.number;
  }
  const name = cleanOptional(item?.name, 64);
  if (name) fields.name = name;
  const series = cleanOptional(item?.collectionName, 64);
  if (series) fields.series = series;
  if (cover.imgUrl) fields.imgUrl = cover.imgUrl;
  if (cover.icon) fields.icon = cover.icon;
  const owner = cleanOptional(input.owner, 80);
  if (owner) fields.owner = owner;
  const ownerLabel = cleanOptional(input.ownerLabel, 64);
  if (ownerLabel) fields.ownerLabel = ownerLabel;
  const issuer = cleanOptional(input.facts?.issuerAddress, 80);
  if (issuer) fields.issuer = issuer;
  if (input.priceSats != null && Number.isInteger(input.priceSats) && input.priceSats >= 0) {
    fields.priceSats = input.priceSats;
  }
  const action = cleanOptional(input.action, 16);
  if (action) fields.action = action.toLowerCase();
  return fields;
};
