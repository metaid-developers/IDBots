/**
 * nftSuiteSyntax — DOM-free types, parsers, validators, and serializers for
 * the 7 expanded NFT & Digital Goods chat card scenarios:
 *   1. `nft-listing-card`      (L2: Thumbnail header + vertical listing ledger / delisted receipt)
 *   2. `nft-fill-card`         (F1: Dual-flow sold / bought / token-swap receipt)
 *   3. `nft-my-listings-card`  (O1: Single-column thumbnail ticket stack + shop/promo actions)
 *   4. `nft-portfolio-card`    (P1: Dual-compartment MRC-721 vs Legacy MetaContract holdings)
 *   5. `nft-swap-card`         (S2: Per-item legacy -> MRC-721 1-Conf upgrade matrix)
 *   6. `nft-action-card`       (A1: Verified NFT avatar ring / Genesis mint / Friend transfer certificate)
 *   7. `nft-negotiate-card`    (Q1: Strikethrough quote comparison + countdown / buyer inquiry / offer)
 *
 * Shared across Electron main (`goodsTradeAgentTools`, `mrc721AgentTools`,
 * `walletAgentTools`, `nftSwapAgentTools`, `metabotManageAgentTools`, `main.ts`,
 * `nftCardTurnBackstop`), Desktop renderer, and Cloud Mobile.
 */

import type { NftCardFormat, NftCardPriceToken } from './nftCardSyntax';

export const NFT_LISTING_CARD_FENCE_TAG = 'nft-listing-card';
export const NFT_FILL_CARD_FENCE_TAG = 'nft-fill-card';
export const NFT_MY_LISTINGS_CARD_FENCE_TAG = 'nft-my-listings-card';
export const NFT_PORTFOLIO_CARD_FENCE_TAG = 'nft-portfolio-card';
export const NFT_SWAP_CARD_FENCE_TAG = 'nft-swap-card';
export const NFT_ACTION_CARD_FENCE_TAG = 'nft-action-card';
export const NFT_NEGOTIATE_CARD_FENCE_TAG = 'nft-negotiate-card';

const LISTING_TAGS = new Set(['nft-listing-card', 'nftlistingcard']);
const FILL_TAGS = new Set(['nft-fill-card', 'nftfillcard']);
const MY_LISTINGS_TAGS = new Set(['nft-my-listings-card', 'nftmylistingscard']);
const PORTFOLIO_TAGS = new Set(['nft-portfolio-card', 'nftportfoliocard']);
const SWAP_TAGS = new Set(['nft-swap-card', 'nftswapcard']);
const ACTION_TAGS = new Set(['nft-action-card', 'nftactioncard']);
const NEGOTIATE_TAGS = new Set(['nft-negotiate-card', 'nftnegotiatecard']);

export type NftListingRail = 'multi-intent' | 'mvc-contract' | 'onchain-sell' | 'open-offer';
export type NftListingStatus = 'active' | 'delisted';

export interface NftListingCardData {
  status: NftListingStatus;
  rail: NftListingRail;
  format: NftCardFormat;
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

export type NftFillSide = 'sold' | 'bought' | 'token_bought';
export type NftFillRail = 'me-escrow' | 'token-for-goods' | 'mvc-contract';

export interface NftFillCardData {
  side: NftFillSide;
  rail?: NftFillRail;
  format: NftCardFormat;
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
  amountMeMilli?: number;
  priceCnyCents?: number;
  amountCnyCents?: number;
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

export interface NftMyListingItem {
  format: NftCardFormat;
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
  rail: NftListingRail;
  autoFulfill?: boolean;
  priceMeMilli?: number;
  priceCnyCents?: number;
  priceSats?: number;
  priceTokens?: NftCardPriceToken[];
  intentPinId?: string;
  sellUtxo?: string;
  txId?: string;
}

export interface NftMyListingsCardData {
  metabotId?: number;
  botName?: string;
  sellerName?: string;
  sellerAddress?: string;
  sellerGlobalMetaId?: string;
  shopMetaAppPinId?: string;
  items: NftMyListingItem[];
  listings?: NftMyListingItem[];
  totalMeMilli?: number;
  totalValueMeMilli?: number;
  totalCnyCents?: number;
  totalValueCnyCents?: number;
  heldMrc721Count?: number;
}

export interface NftPortfolioPreviewItem {
  format: NftCardFormat;
  pinId?: string;
  tokenIndex?: string;
  number?: number;
  name?: string;
  icon?: string;
  imgUrl?: string;
}

export interface NftPortfolioCollectionRow {
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

export interface NftPortfolioLegacySeries {
  name: string;
  seriesName: string;
  genesis: string;
  codehash: string;
  count: number;
  collectionSlug?: string;
  swappable?: boolean;
  sampleIndexes: string[];
  previewItems?: NftPortfolioPreviewItem[];
}

export interface NftPortfolioCardData {
  metabotId?: number;
  ownerName?: string;
  ownerAddress?: string;
  ownerGlobalMetaId?: string;
  isThirdParty?: boolean;
  totalCount: number;
  mrc721Count: number;
  legacyCount: number;
  estimatedFloorMeMilli?: number;
  estimatedTotalMeMilli?: number;
  estimatedFloorCnyCents?: number;
  estimatedTotalCnyCents?: number;
  mrc721Collections: NftPortfolioCollectionRow[];
  previewItems?: NftPortfolioPreviewItem[];
  mrc721Previews?: NftPortfolioPreviewItem[];
  legacySeries: NftPortfolioLegacySeries[];
  legacyCollections?: NftPortfolioLegacySeries[];
}

export type NftSwapItemStatus = 'pending' | 'confirming' | 'completed' | 'failed';
export type NftSwapOrderStatus = 'confirming' | 'completed' | 'partial' | 'failed';

export interface NftSwapItemRow {
  tokenIndex: string;
  name?: string;
  icon?: string;
  imgUrl?: string;
  status: NftSwapItemStatus;
  confirmations?: number;
  depositTxId?: string;
  legacyTxId?: string;
  newItemPinId?: string;
  newPinId?: string;
  deliveryTxId?: string;
  error?: string;
}

export interface NftSwapCardData {
  requestId: string;
  orderId?: string;
  status: NftSwapOrderStatus;
  collectionSlug: string;
  collectionName?: string;
  targetCollectionPinId?: string;
  stationGlobalMetaId?: string;
  stationName?: string;
  badgeLabel?: string;
  caVerified?: boolean;
  medianPriceMeMilli?: number;
  totalCount?: number;
  completedCount?: number;
  items: NftSwapItemRow[];
}

export type NftActionKind = 'avatar' | 'mint' | 'transfer';

export interface NftActionCardData {
  kind: NftActionKind;
  format: NftCardFormat;
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
  fromName?: string;
  senderLabel?: string;
  fromAddress?: string;
  senderAddress?: string;
  toName?: string;
  recipientLabel?: string;
  toAddress?: string;
  recipientAddress?: string;
  toGlobalMetaId?: string;
  recipientGlobalMetaId?: string;
  avatarPath?: string;
  hostStamp?: string;
}

export type NftNegotiateMode =
  | 'quote_accepted'
  | 'inquiry_received'
  | 'inquiry_sent'
  | 'open_offer';

export interface NftNegotiateCardData {
  kind: NftNegotiateMode;
  mode: NftNegotiateMode;
  format: NftCardFormat;
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
  listedPriceMeMilli?: number;
  listedPriceCnyCents?: number;
  proposedPriceMeMilli?: number;
  offerPriceMeMilli?: number;
  agreedPriceMeMilli?: number;
  agreedPriceCnyCents?: number;
  offerPriceSats?: number;
  quoteExpiresAt?: number;
  validUntil?: number;
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

// ---------------------------------------------------------------------------
// Fence language predicates
// ---------------------------------------------------------------------------

export function isNftListingCardFenceLanguage(lang: string): boolean {
  return LISTING_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftFillCardFenceLanguage(lang: string): boolean {
  return FILL_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftMyListingsCardFenceLanguage(lang: string): boolean {
  return MY_LISTINGS_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftPortfolioCardFenceLanguage(lang: string): boolean {
  return PORTFOLIO_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftSwapCardFenceLanguage(lang: string): boolean {
  return SWAP_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftActionCardFenceLanguage(lang: string): boolean {
  return ACTION_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isNftNegotiateCardFenceLanguage(lang: string): boolean {
  return NEGOTIATE_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

export function isAnyNftSuiteFenceLanguage(lang: string): boolean {
  const norm = String(lang ?? '').trim().toLowerCase();
  return (
    LISTING_TAGS.has(norm) ||
    FILL_TAGS.has(norm) ||
    MY_LISTINGS_TAGS.has(norm) ||
    PORTFOLIO_TAGS.has(norm) ||
    SWAP_TAGS.has(norm) ||
    ACTION_TAGS.has(norm) ||
    NEGOTIATE_TAGS.has(norm)
  );
}

// ---------------------------------------------------------------------------
// Sanitizers
// ---------------------------------------------------------------------------

const PIN_RE = /^[0-9a-f]{64}i\d{1,6}$/i;
const HEX_ID_RE = /^[0-9a-f]{40,64}$/i;

function cleanStr(val: unknown, max = 120): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim().replace(/\s+/g, ' ');
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function cleanPin(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim().toLowerCase().replace(/^metafile:\/\//, '').replace(/^pin:\/\//, '');
  return PIN_RE.test(trimmed) ? trimmed : undefined;
}

function cleanHttps(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!/^https:\/\//i.test(trimmed) || /\s/.test(trimmed)) return undefined;
  return trimmed.slice(0, 512);
}

function cleanIcon(val: unknown): string | undefined {
  if (typeof val !== 'string') return undefined;
  const trimmed = val.trim();
  if (!trimmed || /\s/.test(trimmed)) return undefined;
  if (trimmed.toLowerCase().startsWith('metafile://')) return trimmed.slice(0, 512);
  if (/^[0-9a-fA-F]{64}i\d+(\.[A-Za-z0-9]{1,8})?$/.test(trimmed)) {
    return `metafile://${trimmed}`.slice(0, 512);
  }
  return undefined;
}

function cleanNonNegInt(val: unknown, max = 2_100_000_000_000_000): number | undefined {
  const n =
    typeof val === 'number'
      ? val
      : typeof val === 'string' && /^\d+$/.test(val.trim())
        ? Number(val.trim())
        : NaN;
  if (!Number.isInteger(n) || n < 0 || n > max) return undefined;
  return n;
}

function cleanFormat(val: unknown, fallback: NftCardFormat = 'mrc721'): NftCardFormat {
  const s = typeof val === 'string' ? val.trim().toLowerCase() : '';
  return s === 'metacontract' ? 'metacontract' : fallback;
}

function cleanHostStamp(val: unknown): string | undefined {
  const s = cleanStr(val, 256);
  return s && /^v1\.\d+\.[A-Za-z0-9-]+\.[0-9a-f]{64}$/.test(s) ? s : undefined;
}

function cleanRail(val: unknown): NftListingRail {
  const s = cleanStr(val, 32);
  if (s === 'mvc-contract' || s === 'onchain-sell' || s === 'open-offer') return s;
  return 'multi-intent';
}

function cleanPriceTokens(val: unknown): NftCardPriceToken[] | undefined {
  if (!Array.isArray(val) || val.length === 0) return undefined;
  const out: NftCardPriceToken[] = [];
  for (const raw of val.slice(0, 6)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const assetKey = typeof item.assetKey === 'string' ? item.assetKey.trim().toLowerCase() : '';
    if (!assetKey || (!assetKey.startsWith('mrc20:') && !assetKey.startsWith('mvc-ft:'))) continue;
    const chain: 'btc' | 'mvc' = item.chain === 'btc' || assetKey.startsWith('mrc20:') ? 'btc' : 'mvc';
    const symbol = cleanStr(item.symbol, 24);
    const amountBase = typeof item.amountBase === 'string' ? item.amountBase.trim() : '';
    const amountDisplay = cleanStr(item.amountDisplay, 40);
    const decimals = cleanNonNegInt(item.decimals, 36) ?? 0;
    if (!symbol || !/^[1-9]\d*$/.test(amountBase) || !amountDisplay) continue;
    const sellerReceiveAddress = cleanStr(item.sellerReceiveAddress, 128);
    out.push({
      assetKey: assetKey.slice(0, 160),
      chain,
      symbol,
      decimals,
      amountBase,
      amountDisplay,
      ...(sellerReceiveAddress ? { sellerReceiveAddress } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

function parseJsonRecord(codeText: string): Record<string, unknown> | null {
  const text = String(codeText ?? '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsers & Serializers
// ---------------------------------------------------------------------------

export function parseNftListingCardFence(codeText: string): NftListingCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const pinId = cleanPin(row.pinId);
  const genesis = cleanStr(row.genesis, 80)?.toLowerCase();
  const codehash = cleanStr(row.codehash, 80)?.toLowerCase();
  const tokenIndex =
    typeof row.tokenIndex === 'number'
      ? String(row.tokenIndex)
      : cleanStr(row.tokenIndex, 24);

  const hasMrc721 = Boolean(pinId);
  const hasMc = Boolean(genesis && HEX_ID_RE.test(genesis) && tokenIndex);
  if (!hasMrc721 && !hasMc) return null;

  const status: NftListingStatus = row.status === 'delisted' ? 'delisted' : 'active';
  const rail = cleanRail(row.rail);
  const format = cleanFormat(row.format, hasMrc721 ? 'mrc721' : 'metacontract');
  const number = cleanNonNegInt(row.number, 1_000_000_000);
  const priceMeMilli = cleanNonNegInt(row.priceMeMilli);
  const priceCnyCents = cleanNonNegInt(row.priceCnyCents);
  const priceSats = cleanNonNegInt(row.priceSats);
  const priceTokens = cleanPriceTokens(row.priceTokens);
  const floorPriceMeMilli = cleanNonNegInt(row.floorPriceMeMilli);

  return {
    status,
    rail,
    format,
    ...(pinId ? { pinId } : {}),
    ...(genesis ? { genesis } : {}),
    ...(codehash ? { codehash } : {}),
    ...(tokenIndex ? { tokenIndex } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(cleanStr(row.name, 80) ? { name: cleanStr(row.name, 80) } : {}),
    ...(cleanStr(row.series, 80) ? { series: cleanStr(row.series, 80) } : {}),
    ...(cleanHttps(row.imgUrl) ? { imgUrl: cleanHttps(row.imgUrl) } : {}),
    ...(cleanIcon(row.icon) ? { icon: cleanIcon(row.icon) } : {}),
    ...(typeof row.caVerified === 'boolean' ? { caVerified: row.caVerified } : {}),
    ...(typeof row.autoFulfill === 'boolean' ? { autoFulfill: row.autoFulfill } : {}),
    ...(priceMeMilli !== undefined ? { priceMeMilli } : {}),
    ...(priceCnyCents !== undefined ? { priceCnyCents } : {}),
    ...(priceSats !== undefined ? { priceSats } : {}),
    ...(priceTokens ? { priceTokens } : {}),
    ...(floorPriceMeMilli !== undefined ? { floorPriceMeMilli } : {}),
    ...(cleanStr(row.rankLabel, 64) ? { rankLabel: cleanStr(row.rankLabel, 64) } : {}),
    ...(cleanStr(row.sellerAddress, 80) ? { sellerAddress: cleanStr(row.sellerAddress, 80) } : {}),
    ...(cleanStr(row.sellerName, 64) ? { sellerName: cleanStr(row.sellerName, 64) } : {}),
    ...(cleanStr(row.sellerGlobalMetaId, 128) ? { sellerGlobalMetaId: cleanStr(row.sellerGlobalMetaId, 128) } : {}),
    ...(cleanPin(row.shopMetaAppPinId) ? { shopMetaAppPinId: cleanPin(row.shopMetaAppPinId) } : {}),
    ...(cleanStr(row.intentPinId, 120) ? { intentPinId: cleanStr(row.intentPinId, 120) } : {}),
    ...(cleanStr(row.txId, 120) ? { txId: cleanStr(row.txId, 120) } : {}),
    ...(cleanStr(row.cancelPinId, 120) ? { cancelPinId: cleanStr(row.cancelPinId, 120) } : {}),
    ...(cleanHostStamp(row.hostStamp) ? { hostStamp: cleanHostStamp(row.hostStamp) } : {}),
  };
}

export function serializeNftListingCardFence(data: NftListingCardData): string {
  return `\`\`\`${NFT_LISTING_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseNftFillCardFence(codeText: string): NftFillCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const sideRaw = cleanStr(row.side, 24);
  if (sideRaw !== 'sold' && sideRaw !== 'bought' && sideRaw !== 'token_bought') return null;

  const pinId = cleanPin(row.pinId);
  const genesis = cleanStr(row.genesis, 80)?.toLowerCase();
  const codehash = cleanStr(row.codehash, 80)?.toLowerCase();
  const tokenIndex =
    typeof row.tokenIndex === 'number'
      ? String(row.tokenIndex)
      : cleanStr(row.tokenIndex, 24);

  if (!pinId && !(genesis && tokenIndex)) return null;
  const format = cleanFormat(row.format, pinId ? 'mrc721' : 'metacontract');
  const railRaw = cleanStr(row.rail, 32);
  const rail: NftFillRail | undefined =
    railRaw === 'me-escrow' || railRaw === 'token-for-goods' || railRaw === 'mvc-contract'
      ? railRaw
      : undefined;

  const priceMeMilli = cleanNonNegInt(row.priceMeMilli ?? row.amountMeMilli);
  const priceCnyCents = cleanNonNegInt(row.priceCnyCents ?? row.amountCnyCents);
  const priceSats = cleanNonNegInt(row.priceSats);
  const number = cleanNonNegInt(row.number, 1_000_000_000);
  const txId = cleanStr(row.txId ?? row.deliveryTxId, 120);

  return {
    side: sideRaw,
    ...(rail ? { rail } : {}),
    format,
    ...(pinId ? { pinId } : {}),
    ...(genesis ? { genesis } : {}),
    ...(codehash ? { codehash } : {}),
    ...(tokenIndex ? { tokenIndex } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(cleanStr(row.name, 80) ? { name: cleanStr(row.name, 80) } : {}),
    ...(cleanStr(row.series, 80) ? { series: cleanStr(row.series, 80) } : {}),
    ...(cleanHttps(row.imgUrl) ? { imgUrl: cleanHttps(row.imgUrl) } : {}),
    ...(cleanIcon(row.icon) ? { icon: cleanIcon(row.icon) } : {}),
    ...(typeof row.caVerified === 'boolean' ? { caVerified: row.caVerified } : {}),
    ...(priceMeMilli !== undefined ? { priceMeMilli, amountMeMilli: priceMeMilli } : {}),
    ...(priceCnyCents !== undefined ? { priceCnyCents, amountCnyCents: priceCnyCents } : {}),
    ...(priceSats !== undefined ? { priceSats } : {}),
    ...(cleanStr(row.tokenSymbol, 24) ? { tokenSymbol: cleanStr(row.tokenSymbol, 24) } : {}),
    ...(cleanStr(row.tokenAmountDisplay, 40) ? { tokenAmountDisplay: cleanStr(row.tokenAmountDisplay, 40) } : {}),
    ...(row.tokenChain === 'btc' || row.tokenChain === 'mvc' ? { tokenChain: row.tokenChain } : {}),
    ...(cleanStr(row.tokenAssetKey, 160) ? { tokenAssetKey: cleanStr(row.tokenAssetKey, 160) } : {}),
    ...(cleanStr(row.paymentTxId, 120) ? { paymentTxId: cleanStr(row.paymentTxId, 120) } : {}),
    ...(cleanStr(row.counterpartyName, 64) ? { counterpartyName: cleanStr(row.counterpartyName, 64) } : {}),
    ...(cleanStr(row.counterpartyAddress, 80)
      ? { counterpartyAddress: cleanStr(row.counterpartyAddress, 80) }
      : {}),
    ...(cleanStr(row.counterpartyGlobalMetaId, 128)
      ? { counterpartyGlobalMetaId: cleanStr(row.counterpartyGlobalMetaId, 128) }
      : {}),
    ...(txId ? { txId, deliveryTxId: txId } : {}),
    ...(cleanStr(row.tradePinId, 120) ? { tradePinId: cleanStr(row.tradePinId, 120) } : {}),
    ...(cleanStr(row.orderId, 120) ? { orderId: cleanStr(row.orderId, 120) } : {}),
    ...(cleanPin(row.shopMetaAppPinId) ? { shopMetaAppPinId: cleanPin(row.shopMetaAppPinId) } : {}),
    ...(cleanHostStamp(row.hostStamp) ? { hostStamp: cleanHostStamp(row.hostStamp) } : {}),
  };
}

export function serializeNftFillCardFence(data: NftFillCardData): string {
  return `\`\`\`${NFT_FILL_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseNftMyListingsCardFence(codeText: string): NftMyListingsCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;
  const rawList = Array.isArray(row.items)
    ? row.items
    : Array.isArray(row.listings)
      ? row.listings
      : null;
  if (!rawList) return null;

  const items: NftMyListingItem[] = [];
  for (const raw of rawList.slice(0, 30)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const pinId = cleanPin(it.pinId);
    const genesis = cleanStr(it.genesis, 80)?.toLowerCase();
    const codehash = cleanStr(it.codehash, 80)?.toLowerCase();
    const tokenIndex =
      typeof it.tokenIndex === 'number'
        ? String(it.tokenIndex)
        : cleanStr(it.tokenIndex, 24);
    if (!pinId && !(genesis && tokenIndex)) continue;
    const rail = cleanRail(it.rail);
    const number = cleanNonNegInt(it.number, 1_000_000_000);
    const priceMeMilli = cleanNonNegInt(it.priceMeMilli);
    const priceCnyCents = cleanNonNegInt(it.priceCnyCents);
    const priceSats = cleanNonNegInt(it.priceSats);
    const priceTokens = cleanPriceTokens(it.priceTokens);
    const sellUtxo = cleanStr(it.sellUtxo, 120);
    const txId = cleanStr(it.txId ?? it.sellUtxo, 120);
    items.push({
      format: cleanFormat(it.format, pinId ? 'mrc721' : 'metacontract'),
      ...(pinId ? { pinId } : {}),
      ...(genesis ? { genesis } : {}),
      ...(codehash ? { codehash } : {}),
      ...(tokenIndex ? { tokenIndex } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(cleanStr(it.name, 80) ? { name: cleanStr(it.name, 80) } : {}),
      ...(cleanStr(it.series, 80) ? { series: cleanStr(it.series, 80) } : {}),
      ...(cleanHttps(it.imgUrl) ? { imgUrl: cleanHttps(it.imgUrl) } : {}),
      ...(cleanIcon(it.icon) ? { icon: cleanIcon(it.icon) } : {}),
      ...(typeof it.caVerified === 'boolean' ? { caVerified: it.caVerified } : {}),
      rail,
      ...(typeof it.autoFulfill === 'boolean' ? { autoFulfill: it.autoFulfill } : {}),
      ...(priceMeMilli !== undefined ? { priceMeMilli } : {}),
      ...(priceCnyCents !== undefined ? { priceCnyCents } : {}),
      ...(priceSats !== undefined ? { priceSats } : {}),
      ...(priceTokens ? { priceTokens } : {}),
      ...(cleanStr(it.intentPinId, 120) ? { intentPinId: cleanStr(it.intentPinId, 120) } : {}),
      ...(sellUtxo ? { sellUtxo } : {}),
      ...(txId ? { txId } : {}),
    });
  }

  const metabotId = cleanNonNegInt(row.metabotId, 1_000_000);
  const botName = cleanStr(row.botName ?? row.sellerName, 64);
  const totalMeMilli = cleanNonNegInt(row.totalMeMilli ?? row.totalValueMeMilli);
  const totalCnyCents = cleanNonNegInt(row.totalCnyCents ?? row.totalValueCnyCents);
  const heldMrc721Count = cleanNonNegInt(row.heldMrc721Count, 1_000_000);

  return {
    ...(metabotId !== undefined ? { metabotId } : {}),
    ...(botName ? { botName, sellerName: botName } : {}),
    ...(cleanStr(row.sellerAddress, 80) ? { sellerAddress: cleanStr(row.sellerAddress, 80) } : {}),
    ...(cleanStr(row.sellerGlobalMetaId, 128) ? { sellerGlobalMetaId: cleanStr(row.sellerGlobalMetaId, 128) } : {}),
    ...(cleanPin(row.shopMetaAppPinId) ? { shopMetaAppPinId: cleanPin(row.shopMetaAppPinId) } : {}),
    items,
    listings: items,
    ...(totalMeMilli !== undefined ? { totalMeMilli, totalValueMeMilli: totalMeMilli } : {}),
    ...(totalCnyCents !== undefined ? { totalCnyCents, totalValueCnyCents: totalCnyCents } : {}),
    ...(heldMrc721Count !== undefined ? { heldMrc721Count } : {}),
  };
}

export function serializeNftMyListingsCardFence(data: NftMyListingsCardData): string {
  return `\`\`\`${NFT_MY_LISTINGS_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

function cleanPortfolioPreviews(val: unknown): NftPortfolioPreviewItem[] | undefined {
  if (!Array.isArray(val) || val.length === 0) return undefined;
  const out: NftPortfolioPreviewItem[] = [];
  for (const raw of val.slice(0, 8)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const pinId = cleanPin(it.pinId);
    const tokenIndex =
      typeof it.tokenIndex === 'number'
        ? String(it.tokenIndex)
        : cleanStr(it.tokenIndex, 24);
    const number = cleanNonNegInt(it.number, 1_000_000_000);
    out.push({
      format: cleanFormat(it.format, pinId ? 'mrc721' : 'metacontract'),
      ...(pinId ? { pinId } : {}),
      ...(tokenIndex ? { tokenIndex } : {}),
      ...(number !== undefined ? { number } : {}),
      ...(cleanStr(it.name, 80) ? { name: cleanStr(it.name, 80) } : {}),
      ...(cleanIcon(it.icon) ? { icon: cleanIcon(it.icon) } : {}),
      ...(cleanHttps(it.imgUrl) ? { imgUrl: cleanHttps(it.imgUrl) } : {}),
    });
  }
  return out.length > 0 ? out : undefined;
}

export function parseNftPortfolioCardFence(codeText: string): NftPortfolioCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const totalCount = cleanNonNegInt(row.totalCount, 1_000_000_000);
  const mrc721Count = cleanNonNegInt(row.mrc721Count, 1_000_000_000);
  const legacyCount = cleanNonNegInt(row.legacyCount, 1_000_000_000);
  if (
    totalCount === undefined &&
    mrc721Count === undefined &&
    legacyCount === undefined &&
    !Array.isArray(row.mrc721Collections) &&
    !Array.isArray(row.legacySeries) &&
    !Array.isArray(row.legacyCollections)
  ) {
    return null;
  }

  const mrc721Collections: NftPortfolioCollectionRow[] = [];
  if (Array.isArray(row.mrc721Collections)) {
    for (const raw of row.mrc721Collections.slice(0, 20)) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const it = raw as Record<string, unknown>;
      const colName = cleanStr(it.name ?? it.collectionName, 80);
      const count = cleanNonNegInt(it.count, 1_000_000_000);
      if (!colName || count === undefined) continue;
      const floorPriceMeMilli = cleanNonNegInt(it.floorPriceMeMilli);
      const estimatedMeMilli = cleanNonNegInt(it.estimatedMeMilli);
      mrc721Collections.push({
        ...(cleanPin(it.collectionId) ? { collectionId: cleanPin(it.collectionId) } : {}),
        name: colName,
        collectionName: cleanStr(it.collectionName, 80) || colName,
        count,
        ...(floorPriceMeMilli !== undefined ? { floorPriceMeMilli } : {}),
        ...(estimatedMeMilli !== undefined ? { estimatedMeMilli } : {}),
        ...(typeof it.caVerified === 'boolean' ? { caVerified: it.caVerified } : {}),
        ...(cleanIcon(it.icon) ? { icon: cleanIcon(it.icon) } : {}),
        ...(cleanHttps(it.imgUrl) ? { imgUrl: cleanHttps(it.imgUrl) } : {}),
      });
    }
  }

  const rawLegacy = Array.isArray(row.legacySeries)
    ? row.legacySeries
    : Array.isArray(row.legacyCollections)
      ? row.legacyCollections
      : [];
  const legacySeries: NftPortfolioLegacySeries[] = [];
  for (const raw of rawLegacy.slice(0, 20)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const seriesName = cleanStr(it.name ?? it.seriesName, 80) || 'Legacy MetaContract';
    const genesis = cleanStr(it.genesis, 80)?.toLowerCase() || '';
    const codehash = cleanStr(it.codehash, 80)?.toLowerCase() || '';
    const count = cleanNonNegInt(it.count, 1_000_000_000);
    if (!genesis || count === undefined) continue;
    const sampleIndexes = Array.isArray(it.sampleIndexes)
      ? it.sampleIndexes
          .map((x) => (typeof x === 'number' ? String(x) : cleanStr(x, 24)))
          .filter((x): x is string => Boolean(x))
          .slice(0, 8)
      : [];
    const previewItems = cleanPortfolioPreviews(it.previewItems);
    legacySeries.push({
      name: seriesName,
      seriesName,
      genesis,
      codehash,
      count,
      ...(cleanStr(it.collectionSlug, 64) ? { collectionSlug: cleanStr(it.collectionSlug, 64) } : {}),
      ...(typeof it.swappable === 'boolean' ? { swappable: it.swappable } : {}),
      sampleIndexes,
      ...(previewItems ? { previewItems } : {}),
    });
  }

  const effMrc721 = mrc721Count ?? mrc721Collections.reduce((s, c) => s + c.count, 0);
  const effLegacy = legacyCount ?? legacySeries.reduce((s, c) => s + c.count, 0);
  const effTotal = totalCount ?? effMrc721 + effLegacy;
  const previews = cleanPortfolioPreviews(row.previewItems ?? row.mrc721Previews);
  const metabotId = cleanNonNegInt(row.metabotId, 1_000_000);
  const estFloorMe = cleanNonNegInt(row.estimatedFloorMeMilli ?? row.estimatedTotalMeMilli);
  const estFloorCny = cleanNonNegInt(row.estimatedFloorCnyCents ?? row.estimatedTotalCnyCents);

  return {
    ...(metabotId !== undefined ? { metabotId } : {}),
    ...(cleanStr(row.ownerName, 64) ? { ownerName: cleanStr(row.ownerName, 64) } : {}),
    ...(cleanStr(row.ownerAddress, 80) ? { ownerAddress: cleanStr(row.ownerAddress, 80) } : {}),
    ...(cleanStr(row.ownerGlobalMetaId, 128) ? { ownerGlobalMetaId: cleanStr(row.ownerGlobalMetaId, 128) } : {}),
    ...(typeof row.isThirdParty === 'boolean' ? { isThirdParty: row.isThirdParty } : {}),
    totalCount: effTotal,
    mrc721Count: effMrc721,
    legacyCount: effLegacy,
    ...(estFloorMe !== undefined ? { estimatedFloorMeMilli: estFloorMe, estimatedTotalMeMilli: estFloorMe } : {}),
    ...(estFloorCny !== undefined ? { estimatedFloorCnyCents: estFloorCny, estimatedTotalCnyCents: estFloorCny } : {}),
    mrc721Collections,
    ...(previews ? { previewItems: previews, mrc721Previews: previews } : {}),
    legacySeries,
    legacyCollections: legacySeries,
  };
}

export function serializeNftPortfolioCardFence(data: NftPortfolioCardData): string {
  return `\`\`\`${NFT_PORTFOLIO_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseNftSwapCardFence(codeText: string): NftSwapCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const requestId = cleanStr(row.requestId ?? row.orderId, 120);
  const collectionSlug = cleanStr(row.collectionSlug ?? row.collectionName, 80);
  if (!requestId || !collectionSlug || !Array.isArray(row.items) || row.items.length === 0) {
    return null;
  }

  const items: NftSwapItemRow[] = [];
  for (const raw of row.items.slice(0, 30)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const it = raw as Record<string, unknown>;
    const tokenIndex =
      typeof it.tokenIndex === 'number'
        ? String(it.tokenIndex)
        : cleanStr(it.tokenIndex, 24);
    if (!tokenIndex) continue;
    const stRaw = cleanStr(it.status, 24);
    const status: NftSwapItemStatus =
      stRaw === 'completed' || stRaw === 'failed' || stRaw === 'confirming'
        ? stRaw
        : 'pending';
    const confirmations = cleanNonNegInt(it.confirmations, 1_000_000);
    const depositTxId = cleanStr(it.depositTxId ?? it.legacyTxId, 120);
    const newItemPinId = cleanPin(it.newItemPinId ?? it.newPinId);
    items.push({
      tokenIndex,
      ...(cleanStr(it.name, 80) ? { name: cleanStr(it.name, 80) } : {}),
      ...(cleanIcon(it.icon) ? { icon: cleanIcon(it.icon) } : {}),
      ...(cleanHttps(it.imgUrl) ? { imgUrl: cleanHttps(it.imgUrl) } : {}),
      status,
      ...(confirmations !== undefined ? { confirmations } : {}),
      ...(depositTxId ? { depositTxId, legacyTxId: depositTxId } : {}),
      ...(newItemPinId ? { newItemPinId, newPinId: newItemPinId } : {}),
      ...(cleanStr(it.deliveryTxId, 120) ? { deliveryTxId: cleanStr(it.deliveryTxId, 120) } : {}),
      ...(cleanStr(it.error, 160) ? { error: cleanStr(it.error, 160) } : {}),
    });
  }
  if (items.length === 0) return null;

  const stRaw = cleanStr(row.status, 24);
  const status: NftSwapOrderStatus =
    stRaw === 'completed' || stRaw === 'partial' || stRaw === 'failed'
      ? stRaw
      : 'confirming';
  const stationName = cleanStr(row.stationName ?? row.badgeLabel, 64);
  const medianPriceMeMilli = cleanNonNegInt(row.medianPriceMeMilli);
  const totalCount = cleanNonNegInt(row.totalCount, 10_000);
  const completedCount = cleanNonNegInt(row.completedCount, 10_000);

  return {
    requestId,
    orderId: requestId,
    status,
    collectionSlug,
    ...(cleanStr(row.collectionName, 80) ? { collectionName: cleanStr(row.collectionName, 80) } : {}),
    ...(cleanPin(row.targetCollectionPinId) ? { targetCollectionPinId: cleanPin(row.targetCollectionPinId) } : {}),
    ...(cleanStr(row.stationGlobalMetaId, 128)
      ? { stationGlobalMetaId: cleanStr(row.stationGlobalMetaId, 128) }
      : {}),
    ...(stationName ? { stationName, badgeLabel: stationName } : {}),
    ...(typeof row.caVerified === 'boolean' ? { caVerified: row.caVerified } : {}),
    ...(medianPriceMeMilli !== undefined ? { medianPriceMeMilli } : {}),
    ...(totalCount !== undefined ? { totalCount } : {}),
    ...(completedCount !== undefined ? { completedCount } : {}),
    items,
  };
}

export function serializeNftSwapCardFence(data: NftSwapCardData): string {
  return `\`\`\`${NFT_SWAP_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseNftActionCardFence(codeText: string): NftActionCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const kindRaw = cleanStr(row.kind, 24);
  if (kindRaw !== 'avatar' && kindRaw !== 'mint' && kindRaw !== 'transfer') return null;

  const pinId = cleanPin(row.pinId);
  const genesis = cleanStr(row.genesis, 80)?.toLowerCase();
  const codehash = cleanStr(row.codehash, 80)?.toLowerCase();
  const tokenIndex =
    typeof row.tokenIndex === 'number'
      ? String(row.tokenIndex)
      : cleanStr(row.tokenIndex, 24);
  if (!pinId && !(genesis && tokenIndex)) return null;

  const format = cleanFormat(row.format, pinId ? 'mrc721' : 'metacontract');
  const number = cleanNonNegInt(row.number, 1_000_000_000);
  const feeSats = cleanNonNegInt(row.feeSats);
  const fromName = cleanStr(row.senderLabel ?? row.fromName, 64);
  const fromAddress = cleanStr(row.senderAddress ?? row.fromAddress, 80);
  const toName = cleanStr(row.recipientLabel ?? row.toName, 64);
  const toAddress = cleanStr(row.recipientAddress ?? row.toAddress, 80);
  const toGlobalMetaId = cleanStr(row.recipientGlobalMetaId ?? row.toGlobalMetaId, 128);

  return {
    kind: kindRaw,
    format,
    ...(pinId ? { pinId } : {}),
    ...(genesis ? { genesis } : {}),
    ...(codehash ? { codehash } : {}),
    ...(tokenIndex ? { tokenIndex } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(cleanStr(row.name, 80) ? { name: cleanStr(row.name, 80) } : {}),
    ...(cleanStr(row.series, 80) ? { series: cleanStr(row.series, 80) } : {}),
    ...(cleanHttps(row.imgUrl) ? { imgUrl: cleanHttps(row.imgUrl) } : {}),
    ...(cleanIcon(row.icon) ? { icon: cleanIcon(row.icon) } : {}),
    ...(typeof row.caVerified === 'boolean' ? { caVerified: row.caVerified } : {}),
    ...(cleanStr(row.txId, 120) ? { txId: cleanStr(row.txId, 120) } : {}),
    ...(feeSats !== undefined ? { feeSats } : {}),
    ...(fromName ? { fromName, senderLabel: fromName } : {}),
    ...(fromAddress ? { fromAddress, senderAddress: fromAddress } : {}),
    ...(toName ? { toName, recipientLabel: toName } : {}),
    ...(toAddress ? { toAddress, recipientAddress: toAddress } : {}),
    ...(toGlobalMetaId ? { toGlobalMetaId, recipientGlobalMetaId: toGlobalMetaId } : {}),
    ...(cleanStr(row.avatarPath, 64) ? { avatarPath: cleanStr(row.avatarPath, 64) } : {}),
    ...(cleanHostStamp(row.hostStamp) ? { hostStamp: cleanHostStamp(row.hostStamp) } : {}),
  };
}

export function serializeNftActionCardFence(data: NftActionCardData): string {
  return `\`\`\`${NFT_ACTION_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function parseNftNegotiateCardFence(codeText: string): NftNegotiateCardData | null {
  const row = parseJsonRecord(codeText);
  if (!row) return null;

  const modeRaw = cleanStr(row.kind ?? row.mode, 32);
  if (
    modeRaw !== 'quote_accepted' &&
    modeRaw !== 'inquiry_received' &&
    modeRaw !== 'inquiry_sent' &&
    modeRaw !== 'open_offer'
  ) {
    return null;
  }

  const pinId = cleanPin(row.pinId);
  if (!pinId) return null;

  const format = cleanFormat(row.format, 'mrc721');
  const tokenIndex =
    typeof row.tokenIndex === 'number'
      ? String(row.tokenIndex)
      : cleanStr(row.tokenIndex, 24);
  const number = cleanNonNegInt(row.number, 1_000_000_000);
  const listedPriceMeMilli = cleanNonNegInt(row.originalPriceMeMilli ?? row.listedPriceMeMilli);
  const listedPriceCnyCents = cleanNonNegInt(row.listedPriceCnyCents);
  const offerPriceMeMilli = cleanNonNegInt(row.proposedPriceMeMilli ?? row.offerPriceMeMilli);
  const agreedPriceMeMilli = cleanNonNegInt(row.agreedPriceMeMilli);
  const agreedPriceCnyCents = cleanNonNegInt(row.agreedPriceCnyCents);
  const offerPriceSats = cleanNonNegInt(row.offerPriceSats);
  const validUntil = cleanNonNegInt(row.quoteExpiresAt ?? row.validUntil, 9_999_999_999_999);
  const offerPinId = cleanPin(row.offerPinId);

  return {
    kind: modeRaw,
    mode: modeRaw,
    format,
    ...(cleanStr(row.inquiryId, 120) ? { inquiryId: cleanStr(row.inquiryId, 120) } : {}),
    pinId,
    ...(tokenIndex ? { tokenIndex } : {}),
    ...(number !== undefined ? { number } : {}),
    ...(cleanStr(row.name, 80) ? { name: cleanStr(row.name, 80) } : {}),
    ...(cleanStr(row.series, 80) ? { series: cleanStr(row.series, 80) } : {}),
    ...(cleanHttps(row.imgUrl) ? { imgUrl: cleanHttps(row.imgUrl) } : {}),
    ...(cleanIcon(row.icon) ? { icon: cleanIcon(row.icon) } : {}),
    ...(typeof row.caVerified === 'boolean' ? { caVerified: row.caVerified } : {}),
    ...(listedPriceMeMilli !== undefined
      ? { originalPriceMeMilli: listedPriceMeMilli, listedPriceMeMilli }
      : {}),
    ...(listedPriceCnyCents !== undefined ? { listedPriceCnyCents } : {}),
    ...(offerPriceMeMilli !== undefined
      ? { proposedPriceMeMilli: offerPriceMeMilli, offerPriceMeMilli }
      : {}),
    ...(agreedPriceMeMilli !== undefined ? { agreedPriceMeMilli } : {}),
    ...(agreedPriceCnyCents !== undefined ? { agreedPriceCnyCents } : {}),
    ...(offerPriceSats !== undefined ? { offerPriceSats } : {}),
    ...(validUntil !== undefined ? { quoteExpiresAt: validUntil, validUntil } : {}),
    ...(offerPinId ? { offerPinId } : {}),
    ...(cleanStr(row.txId, 120) ? { txId: cleanStr(row.txId, 120) } : {}),
    ...(cleanStr(row.sellerName, 64) ? { sellerName: cleanStr(row.sellerName, 64) } : {}),
    ...(cleanStr(row.sellerAddress, 80) ? { sellerAddress: cleanStr(row.sellerAddress, 80) } : {}),
    ...(cleanStr(row.sellerGlobalMetaId, 128)
      ? { sellerGlobalMetaId: cleanStr(row.sellerGlobalMetaId, 128) }
      : {}),
    ...(typeof row.sellerOnline === 'boolean' ? { sellerOnline: row.sellerOnline } : {}),
    ...(cleanStr(row.buyerName, 64) ? { buyerName: cleanStr(row.buyerName, 64) } : {}),
    ...(cleanStr(row.buyerAddress, 80) ? { buyerAddress: cleanStr(row.buyerAddress, 80) } : {}),
    ...(cleanStr(row.buyerGlobalMetaId, 128)
      ? { buyerGlobalMetaId: cleanStr(row.buyerGlobalMetaId, 128) }
      : {}),
    ...(cleanStr(row.note, 240) ? { note: cleanStr(row.note, 240) } : {}),
    ...(cleanPin(row.shopMetaAppPinId) ? { shopMetaAppPinId: cleanPin(row.shopMetaAppPinId) } : {}),
  };
}

export function serializeNftNegotiateCardFence(data: NftNegotiateCardData): string {
  return `\`\`\`${NFT_NEGOTIATE_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}
