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

export interface NftCardPriceToken {
  assetKey: string;
  chain: 'btc' | 'mvc';
  symbol: string;
  decimals: number;
  amountBase: string;
  amountDisplay: string;
  sellerReceiveAddress?: string;
}

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
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceTokens?: NftCardPriceToken[];
  sellerGlobalMetaId?: string;
  sellerName?: string;
  sellerOnline?: boolean;
  shopMetaAppPinId?: string;
  caVerified?: boolean;
  negotiable?: boolean;
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
  'priceSats', 'priceMeMilli', 'priceCnyCents', 'priceTokens', 'sellerGlobalMetaId',
  'sellerName', 'sellerOnline', 'shopMetaAppPinId', 'caVerified', 'negotiable', 'action', 'hostStamp',
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
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceTokens?: NftCardPriceToken[];
  sellerGlobalMetaId?: string;
  sellerName?: string;
  sellerOnline?: boolean;
  shopMetaAppPinId?: string;
  caVerified?: boolean;
  negotiable?: boolean;
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
  if (input.priceMeMilli != null && Number.isInteger(input.priceMeMilli) && input.priceMeMilli >= 0) {
    fields.priceMeMilli = input.priceMeMilli;
  }
  if (input.priceCnyCents != null && Number.isInteger(input.priceCnyCents) && input.priceCnyCents >= 0) {
    fields.priceCnyCents = input.priceCnyCents;
  }
  if (Array.isArray(input.priceTokens) && input.priceTokens.length > 0) {
    fields.priceTokens = input.priceTokens
      .filter((t) => t && t.assetKey && t.symbol && t.amountBase && t.amountDisplay)
      .slice(0, 6)
      .map((t) => ({
        assetKey: String(t.assetKey).trim().toLowerCase(),
        chain: t.chain === 'btc' ? 'btc' : 'mvc',
        symbol: cleanOptional(t.symbol, 24) || 'TOKEN',
        decimals: Number.isInteger(Number(t.decimals)) ? Number(t.decimals) : 0,
        amountBase: String(t.amountBase).trim(),
        amountDisplay: String(t.amountDisplay).trim(),
        ...(t.sellerReceiveAddress ? { sellerReceiveAddress: String(t.sellerReceiveAddress).trim() } : {}),
      }));
    if (fields.priceTokens.length === 0) delete fields.priceTokens;
  }
  const sellerGlobalMetaId = cleanOptional(input.sellerGlobalMetaId, 128);
  if (sellerGlobalMetaId) fields.sellerGlobalMetaId = sellerGlobalMetaId;
  const sellerName = cleanOptional(input.sellerName, 64);
  if (sellerName) fields.sellerName = sellerName;
  if (typeof input.sellerOnline === 'boolean') {
    fields.sellerOnline = input.sellerOnline;
  }
  const shopMetaAppPinId = cleanOptional(input.shopMetaAppPinId, 80);
  if (shopMetaAppPinId) fields.shopMetaAppPinId = shopMetaAppPinId;
  if (typeof input.caVerified === 'boolean') {
    fields.caVerified = input.caVerified;
  }
  if (typeof input.negotiable === 'boolean') {
    fields.negotiable = input.negotiable;
  }
  const action = cleanOptional(input.action, 16);
  if (action) fields.action = action.toLowerCase();
  return fields;
};

// ---------------------------------------------------------------------------
// Collection card (album-level) — a separate fence tag, not an nft-card
// format: item-card identity rules (pinId/triple) do not apply, the heal
// pipeline stays item-only, and the pinned nft-card contracts are untouched.
// ---------------------------------------------------------------------------

export const NFT_COLLECTION_CARD_FENCE_TAG = 'nft-collection-card';

export interface NftCollectionPreviewEmitItem {
  pinId: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  icon?: string;
  imgUrl?: string;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerName?: string;
}

export interface NftCollectionCardEmitFields {
  /** The collectionid (= the collection_desc pinId) — the album's identity. */
  collectionId?: string;
  /** The path name under /nft/mrc721/. */
  collectionName?: string;
  name?: string;
  desc?: string;
  website?: string;
  /** metafile:// cover pinId (normalized; bare pinIds accepted). */
  icon?: string;
  imgUrl?: string;
  totalSupply?: number;
  minted?: number;
  royaltyRate?: number;
  issuer?: string;
  issuerLabel?: string;
  action?: string;
  caVerified?: boolean;
  listedCount?: number;
  holderCount?: number;
  floorPriceMeMilli?: number;
  floorPriceCnyCents?: number;
  medianPriceMeMilli?: number;
  tradeCount24h?: number;
  shopMetaAppPinId?: string;
  previewItems?: NftCollectionPreviewEmitItem[];
}

const NFT_COLLECTION_CARD_KEY_ORDER: Array<keyof NftCollectionCardEmitFields> = [
  'collectionId', 'collectionName', 'name', 'desc', 'website', 'icon',
  'totalSupply', 'minted', 'royaltyRate', 'issuer', 'issuerLabel', 'action',
  'imgUrl', 'caVerified', 'listedCount', 'holderCount', 'floorPriceMeMilli',
  'floorPriceCnyCents', 'medianPriceMeMilli', 'tradeCount24h', 'shopMetaAppPinId', 'previewItems',
];

const cleanOptionalNumber = (value: number | undefined, min: number, max: number): number | undefined => {
  if (value == null || !Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
};

/** Serialize one collection card to the exact fence form (fixed key order, compact JSON). */
export const buildNftCollectionCardFence = (fields: NftCollectionCardEmitFields): string => {
  const ordered: Record<string, unknown> = {};
  for (const key of NFT_COLLECTION_CARD_KEY_ORDER) {
    const value = fields[key];
    if (value !== undefined && value !== null && value !== '') {
      ordered[key] = value;
    }
  }
  return `\`\`\`${NFT_COLLECTION_CARD_FENCE_TAG}\n${JSON.stringify(ordered)}\n\`\`\``;
};

/** Result text + blank line + hint + collection fence. Used by the album tools. */
export const appendNftCollectionCardBlock = (resultText: string, fields: NftCollectionCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftCollectionCardFence(fields)}`;

/**
 * Build the collection-card emit fields the mrc721 album tools hold at action
 * time (Mrc721CollectionSummary subset + action context). Fields degrade
 * independently — a missing cover yields a coverless card, never a missing
 * card; the collectionid is the only required identity.
 */
export const buildMrc721CollectionCardFields = (input: {
  collectionName: string;
  pinId: string;
  name?: string;
  desc?: string;
  website?: string;
  cover?: string;
  totalSupply?: number | null;
  minted?: number | null;
  royaltyRate?: number | null;
  issuerAddress?: string;
  issuerLabel?: string;
  action?: string;
}): NftCollectionCardEmitFields => {
  const cover = normalizeMrc721Cover(input.cover);
  const fields: NftCollectionCardEmitFields = {
    collectionId: input.pinId,
    collectionName: cleanOptional(input.collectionName, 64),
  };
  const name = cleanOptional(input.name, 64);
  if (name) fields.name = name;
  const desc = cleanOptional(input.desc, 200);
  if (desc) fields.desc = desc;
  const website = cleanOptional(input.website, 200);
  if (website) fields.website = website;
  if (cover.icon) fields.icon = cover.icon;
  const totalSupply = cleanOptionalNumber(input.totalSupply ?? undefined, -1, 1_000_000_000_000);
  if (totalSupply !== undefined) fields.totalSupply = totalSupply;
  const minted = cleanOptionalNumber(input.minted ?? undefined, 0, 1_000_000_000);
  if (minted !== undefined) fields.minted = minted;
  const royaltyRate = cleanOptionalNumber(input.royaltyRate ?? undefined, 0, 20);
  if (royaltyRate !== undefined) fields.royaltyRate = royaltyRate;
  const issuer = cleanOptional(input.issuerAddress, 80);
  if (issuer) fields.issuer = issuer;
  const issuerLabel = cleanOptional(input.issuerLabel, 64);
  if (issuerLabel) fields.issuerLabel = issuerLabel;
  const action = cleanOptional(input.action, 16);
  if (action) fields.action = action.toLowerCase();
  return fields;
};

// ---------------------------------------------------------------------------
// Expanded NFT & Digital Goods Suite Card Builders (L2, F1, O1, P1, S2, A1, Q1)
// ---------------------------------------------------------------------------

export const NFT_LISTING_CARD_FENCE_TAG = 'nft-listing-card';
export const NFT_FILL_CARD_FENCE_TAG = 'nft-fill-card';
export const NFT_MY_LISTINGS_CARD_FENCE_TAG = 'nft-my-listings-card';
export const NFT_PORTFOLIO_CARD_FENCE_TAG = 'nft-portfolio-card';
export const NFT_SWAP_CARD_FENCE_TAG = 'nft-swap-card';
export const NFT_ACTION_CARD_FENCE_TAG = 'nft-action-card';
export const NFT_NEGOTIATE_CARD_FENCE_TAG = 'nft-negotiate-card';

export interface NftListingCardEmitFields {
  status: 'active' | 'delisted';
  rail: 'multi-intent' | 'mvc-contract' | 'onchain-sell' | 'open-offer';
  format: NftCardEmitFormat;
  pinId?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  caVerified?: boolean;
  autoFulfill?: boolean;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  priceTokens?: NftCardPriceToken[];
  floorPriceMeMilli?: number;
  rankLabel?: string;
  sellerAddress?: string;
  sellerName?: string;
  sellerGlobalMetaId?: string;
  shopMetaAppPinId?: string;
  intentPinId?: string;
  txId?: string;
  cancelPinId?: string;
  hostStamp?: string;
}

export interface NftFillCardEmitFields {
  side: 'sold' | 'bought' | 'token_bought';
  rail?: 'me-escrow' | 'token-for-goods' | 'mvc-contract';
  format: NftCardEmitFormat;
  pinId?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  caVerified?: boolean;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  tokenSymbol?: string;
  tokenAmountDisplay?: string;
  tokenChain?: 'btc' | 'mvc';
  tokenAssetKey?: string;
  paymentTxId?: string;
  counterpartyName?: string;
  counterpartyAddress?: string;
  counterpartyGlobalMetaId?: string;
  txId?: string;
  deliveryTxId?: string;
  tradePinId?: string;
  orderId?: string;
  shopMetaAppPinId?: string;
  hostStamp?: string;
}

export interface NftMyListingEmitItem {
  format: NftCardEmitFormat;
  pinId?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  caVerified?: boolean;
  rail: 'multi-intent' | 'mvc-contract' | 'onchain-sell' | 'open-offer';
  autoFulfill?: boolean;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  priceTokens?: NftCardPriceToken[];
  intentPinId?: string;
  sellUtxo?: string;
  txId?: string;
}

export interface NftMyListingsCardEmitFields {
  metabotId?: number;
  botName?: string;
  sellerName?: string;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  shopMetaAppPinId?: string;
  items: NftMyListingEmitItem[];
  totalMeMilli?: number;
  totalCnyCents?: number;
  heldMrc721Count?: number;
}

export interface NftPortfolioPreviewEmitItem {
  format: NftCardEmitFormat;
  pinId?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  icon?: string;
  imgUrl?: string;
}

export interface NftPortfolioCollectionEmitRow {
  collectionId?: string;
  name: string;
  collectionName: string;
  count: number;
  floorPriceMeMilli?: number;
  estimatedMeMilli?: number;
  caVerified?: boolean;
  icon?: string;
  imgUrl?: string;
}

export interface NftPortfolioLegacyEmitSeries {
  name: string;
  seriesName: string;
  genesis: string;
  codehash: string;
  count: number;
  collectionSlug?: string;
  swappable?: boolean;
  sampleIndexes: string[];
  previewItems?: NftPortfolioPreviewEmitItem[];
}

export interface NftPortfolioCardEmitFields {
  metabotId?: number;
  ownerName?: string;
  ownerAddress?: string;
  ownerGlobalMetaId?: string;
  isThirdParty?: boolean;
  totalCount: number;
  mrc721Count: number;
  legacyCount: number;
  estimatedFloorMeMilli?: number;
  estimatedFloorCnyCents?: number;
  mrc721Collections: NftPortfolioCollectionEmitRow[];
  previewItems?: NftPortfolioPreviewEmitItem[];
  legacySeries: NftPortfolioLegacyEmitSeries[];
}

export interface NftSwapItemEmitRow {
  tokenIndex: string;
  name?: string;
  icon?: string;
  imgUrl?: string;
  status: 'pending' | 'confirming' | 'completed' | 'failed';
  confirmations?: number;
  depositTxId?: string;
  newItemPinId?: string;
  deliveryTxId?: string;
  error?: string;
}

export interface NftSwapCardEmitFields {
  requestId: string;
  status: 'confirming' | 'completed' | 'partial' | 'failed';
  collectionSlug: string;
  collectionName?: string;
  targetCollectionPinId?: string;
  stationGlobalMetaId?: string;
  stationName?: string;
  caVerified?: boolean;
  medianPriceMeMilli?: number;
  totalCount?: number;
  completedCount?: number;
  items: NftSwapItemEmitRow[];
}

export interface NftActionCardEmitFields {
  kind: 'avatar' | 'mint' | 'transfer';
  format: NftCardEmitFormat;
  pinId?: string;
  genesis?: string;
  codehash?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  caVerified?: boolean;
  txId?: string;
  feeSats?: number;
  senderLabel?: string;
  senderAddress?: string;
  recipientLabel?: string;
  recipientAddress?: string;
  recipientGlobalMetaId?: string;
  avatarPath?: string;
  hostStamp?: string;
}

export interface NftNegotiateCardEmitFields {
  kind: 'quote_accepted' | 'inquiry_received' | 'inquiry_sent' | 'open_offer';
  format?: NftCardEmitFormat;
  inquiryId?: string;
  pinId: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  series?: string;
  imgUrl?: string;
  icon?: string;
  caVerified?: boolean;
  originalPriceMeMilli?: number;
  listedPriceCnyCents?: number;
  proposedPriceMeMilli?: number;
  agreedPriceMeMilli?: number;
  agreedPriceCnyCents?: number;
  offerPriceSats?: number;
  quoteExpiresAt?: number;
  offerPinId?: string;
  txId?: string;
  sellerName?: string;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  sellerOnline?: boolean;
  buyerName?: string;
  buyerAddress?: string;
  buyerGlobalMetaId?: string;
  note?: string;
  shopMetaAppPinId?: string;
}

function compactObject<T extends object>(input: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined && v !== null && v !== '') {
      out[k] = v;
    }
  }
  return out;
}

export const buildNftListingCardFence = (fields: NftListingCardEmitFields): string =>
  `\`\`\`${NFT_LISTING_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftListingCardBlock = (resultText: string, fields: NftListingCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftListingCardFence(fields)}`;

export const buildNftFillCardFence = (fields: NftFillCardEmitFields): string =>
  `\`\`\`${NFT_FILL_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftFillCardBlock = (resultText: string, fields: NftFillCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftFillCardFence(fields)}`;

export const buildNftMyListingsCardFence = (fields: NftMyListingsCardEmitFields): string =>
  `\`\`\`${NFT_MY_LISTINGS_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftMyListingsCardBlock = (resultText: string, fields: NftMyListingsCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftMyListingsCardFence(fields)}`;

export const buildNftPortfolioCardFence = (fields: NftPortfolioCardEmitFields): string =>
  `\`\`\`${NFT_PORTFOLIO_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftPortfolioCardBlock = (resultText: string, fields: NftPortfolioCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftPortfolioCardFence(fields)}`;

export const buildNftSwapCardFence = (fields: NftSwapCardEmitFields): string =>
  `\`\`\`${NFT_SWAP_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftSwapCardBlock = (resultText: string, fields: NftSwapCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftSwapCardFence(fields)}`;

export const buildNftActionCardFence = (fields: NftActionCardEmitFields): string =>
  `\`\`\`${NFT_ACTION_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftActionCardBlock = (resultText: string, fields: NftActionCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftActionCardFence(fields)}`;

export const buildNftNegotiateCardFence = (fields: NftNegotiateCardEmitFields): string =>
  `\`\`\`${NFT_NEGOTIATE_CARD_FENCE_TAG}\n${JSON.stringify(compactObject(fields))}\n\`\`\``;

export const appendNftNegotiateCardBlock = (resultText: string, fields: NftNegotiateCardEmitFields): string =>
  `${resultText}\n\n${NFT_CARD_RESULT_HINT}\n${buildNftNegotiateCardFence(fields)}`;
