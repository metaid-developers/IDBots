import { randomBytes } from 'node:crypto';
import {
  broadcastMrc721Pin,
  fetchMetasoJson,
  fetchMrc721ItemInfo,
  fetchMrc721RawPin,
  isMvcAddress,
  isMrc721PinId,
  type Mrc721CreatePinFn,
  type Mrc721MarketListing,
  type Mrc721MarketPrices,
  type Mrc721MarketPriceToken,
} from './mrc721Service';
import { listMrc20Assets } from './mrc20Service';
import { listMvcFtAssets } from './mvcFtService';
import type { MetabotStore } from '../metabotStore';

/**
 * MRC-721 sell-intent protocol ("NFT 售", docs/nft-sell-protocol-draft.md):
 * an on-chain declaration pin at the FIXED path /protocols/mrc721sell that
 * says the holder wants to sell an item, on discoverable, currency-agnostic
 * terms. It moves no funds and transfers nothing — settlement runs over the
 * locked atomic-swap rail (native SPACE) or the escrow/guarantor rail (any
 * currency).
 *
 * Protocol shape (owner decisions 2026-11-04):
 *  - Path /protocols/mrc721sell, NOT /nft/*: /nft/ is the OFFICIAL protocol
 *    namespace indexers must index; this protocol stays unofficial for now.
 *    The fixed path also keeps it away from the /nft/mrc721/ item-mint rule
 *    (a sell pin under that root would mint a phantom item).
 *  - No per-item path suffix: itemPinId lives in the content; the protocol
 *    carries no ambiguous duplicates.
 *  - No protocol/version fields in the payload: the MetaID pin 7-tuple
 *    already carries the protocol identity (path) and version (pin version).
 *  - Append-only declaration log (buzz pattern): every declaration is a
 *    CREATE pin on the fixed path; per itemPinId the LATEST pin wins
 *    (cancel = a new declaration with active:false).
 *  - contact.metabotId never goes on-chain: local ids are per-machine and
 *    mutable; sellerMetaId is the only identity.
 */

export const MRC721_SELL_INTENT_PATH = '/protocols/mrc721sell';
export const MRC721_TRADE_RECEIPT_PATH = '/protocols/mrc721trade';
export const MRC721_SELL_MIN_ME_MILLI = 1000;
export const MRC721_SELL_MIN_CNY_CENTS = 100;

export type Mrc721SellIntentPriceToken = Mrc721MarketPriceToken;

export interface Mrc721SellIntentPriceTokenInput {
  assetKey: string;
  amountDisplay: string;
  symbol?: string;
  decimals?: number;
}

export interface Mrc721SellIntentPrices {
  me?: {
    amountMilli: number;
  };
  fiat?: {
    currency: 'CNY';
    amountCents: number;
  };
  tokens?: Mrc721SellIntentPriceToken[];
}

export interface Mrc721SellIntentContent {
  active: boolean;
  itemPinId: string;
  collectionName?: string;
  collectionPinId?: string;
  itemOutpoint?: { txid: string; vout: number; satoshis: number };
  sellerAddress: string;
  sellerMetaId?: string;
  prices?: Mrc721SellIntentPrices;
  autoFulfillMe?: boolean;
  autoFulfillTokens?: boolean;
  negotiable?: boolean;
  shopMetaAppPinId?: string;
  priceHintSats?: number;
  acceptedCurrencies: string[];
  settlement: string[];
  note?: string;
  /** Epoch SECONDS (doc schema §2.2 — the indexer keys on this unit). */
  createdAt: number;
  /** Epoch SECONDS; display-only expiry window. */
  expiresAt?: number;
}

export interface Mrc721SellIntentRecord {
  id: string;
  metabotId: number;
  intent: Mrc721SellIntentContent;
  sellPinId?: string;
  status: 'active' | 'cancelled' | 'sold';
  /** Local authorization mirror for SellerAutoFulfillDaemon. */
  autoFulfillMe?: boolean;
  autoFulfillTokens?: boolean;
  soldOrderId?: string;
  soldTxId?: string;
  soldAt?: number;
  updatedAt: number;
}

/** Listed-view status: local record status joined with the live holder view. */
export type Mrc721SellIntentStatus = 'active' | 'cancelled' | 'sold' | 'stale';

export interface Mrc721SellIntentView {
  id: string;
  itemPinId: string;
  status: Mrc721SellIntentStatus;
  reason?: string;
  intent: Mrc721SellIntentContent;
  sellPinId?: string;
}

export type SellIntentKv = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
};

function intentsKey(metabotId: number): string {
  return `mrc721_sell_intents:${metabotId}`;
}

function acceptedQuotesKey(metabotId: number): string {
  return `goods_accepted_quotes:${metabotId}`;
}

function sellerAuthorizedQuotesKey(metabotId: number): string {
  return `goods_seller_authorized_quotes:${metabotId}`;
}

export interface GoodsAcceptedQuoteRecord {
  inquiryId: string;
  itemPinId: string;
  agreedCurrency: 'me';
  agreedAmountMilli: number;
  sellerBotAddress: string;
  sellerPayeeAddress?: string;
  buyerNftAddress?: string;
  buyerGlobalMetaId?: string;
  validUntil: number;
  status: 'active' | 'used' | 'expired';
  orderId?: string;
  createdAt: number;
  updatedAt: number;
}

export function mrc721SellIntentsFromSqlite(store: { get(key: string): unknown; set(key: string, value: unknown): void }): SellIntentKv {
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export interface ParsedFtAssetKey {
  assetKey: string;
  chain: 'btc' | 'mvc';
  standard: 'mrc20' | 'metacontract-ft';
  mrc20Id?: string;
  codehash?: string;
  genesis?: string;
}

const MRC20_ID_RE = /^[0-9a-f]{64}i\d+$/i;
const HEX_40_RE = /^[0-9a-f]{40}$/i;
const HEX_40_OR_64_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export function parseCanonicalFtAssetKey(rawAssetKey: unknown): ParsedFtAssetKey {
  const raw = String(rawAssetKey ?? '').trim().toLowerCase();
  if (!raw) {
    throw new Error('assetKey is required');
  }
  if (raw.startsWith('mrc20:')) {
    const mrc20Id = raw.slice('mrc20:'.length).trim();
    if (!mrc20Id || /\s/.test(mrc20Id) || (!MRC20_ID_RE.test(mrc20Id) && mrc20Id.length < 3)) {
      throw new Error(`invalid MRC-20 assetKey "${raw}" (expected mrc20:<mrc20Id>)`);
    }
    return {
      assetKey: `mrc20:${mrc20Id}`,
      chain: 'btc',
      standard: 'mrc20',
      mrc20Id,
    };
  }
  if (raw.startsWith('mvc-ft:')) {
    const parts = raw.slice('mvc-ft:'.length).split(':');
    if (parts.length !== 2) {
      throw new Error(`invalid MVC FT assetKey "${raw}" (expected mvc-ft:<codehash>:<genesis>)`);
    }
    const [codehash, genesis] = parts.map((p) => p.trim());
    if (!HEX_40_RE.test(codehash) || !HEX_40_OR_64_RE.test(genesis)) {
      throw new Error(`invalid MVC FT assetKey "${raw}" (codehash must be 40 hex, genesis 40/64 hex)`);
    }
    return {
      assetKey: `mvc-ft:${codehash}:${genesis}`,
      chain: 'mvc',
      standard: 'metacontract-ft',
      codehash,
      genesis,
    };
  }
  throw new Error(`unsupported assetKey "${raw}" (expected mrc20:<id> or mvc-ft:<codehash>:<genesis>)`);
}

export function decimalDisplayToBaseUnits(amountDisplay: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer between 0 and 36 (got ${decimals})`);
  }
  const text = String(amountDisplay ?? '').trim();
  if (!/^(?:\d+)(?:\.\d+)?$/.test(text)) {
    throw new Error(`amount_display "${text}" must be a positive decimal string`);
  }
  const [intPartRaw, fracPart = ''] = text.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`amount_display "${text}" exceeds token precision (${decimals} decimals)`);
  }
  const intPart = intPartRaw.replace(/^0+(?=\d)/, '') || '0';
  const paddedFrac = fracPart.padEnd(decimals, '0');
  const combined = `${intPart}${paddedFrac}`.replace(/^0+/, '') || '0';
  const base = BigInt(combined);
  if (base <= 0n) {
    throw new Error('amount_display must be greater than zero');
  }
  return base.toString();
}

export function baseUnitsToDecimalDisplay(amountBase: string, decimals: number): string {
  if (!/^[1-9]\d*$/.test(String(amountBase ?? '').trim())) {
    throw new Error(`amountBase must be a positive integer string (got ${amountBase})`);
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`decimals must be an integer between 0 and 36 (got ${decimals})`);
  }
  const base = BigInt(amountBase);
  if (decimals === 0) return base.toString();
  const scale = 10n ** BigInt(decimals);
  const whole = base / scale;
  const frac = (base % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

function isLikelyBtcReceiveAddress(address: string): boolean {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) return false;
  if (/^(bc1|tb1|bcrt1)[ac-hj-np-z02-9]{11,90}$/i.test(trimmed)) return true;
  return /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,62}$/.test(trimmed);
}

function parsePriceTokenEntry(raw: unknown): Mrc721SellIntentPriceToken {
  const obj = asRecord(raw);
  const parsedKey = parseCanonicalFtAssetKey(obj.assetKey ?? obj.asset_key);
  const decimals = Number(obj.decimals ?? 0);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`prices.tokens[${parsedKey.assetKey}].decimals must be an integer in [0, 36]`);
  }
  const symbol = String(obj.symbol ?? '').trim();
  if (!symbol) {
    throw new Error(`prices.tokens[${parsedKey.assetKey}].symbol is required`);
  }
  let amountBase = String(obj.amountBase ?? obj.amount_base ?? '').trim();
  const rawDisplay = String(obj.amountDisplay ?? obj.amount_display ?? '').trim();
  if (!amountBase && rawDisplay) {
    amountBase = decimalDisplayToBaseUnits(rawDisplay, decimals);
  }
  if (!/^[1-9]\d*$/.test(amountBase)) {
    throw new Error(`prices.tokens[${parsedKey.assetKey}].amountBase must be a positive integer string`);
  }
  const amountDisplay = rawDisplay || baseUnitsToDecimalDisplay(amountBase, decimals);
  const sellerReceiveAddress = String(obj.sellerReceiveAddress ?? obj.seller_receive_address ?? '').trim();
  if (parsedKey.chain === 'btc') {
    if (!isLikelyBtcReceiveAddress(sellerReceiveAddress)) {
      throw new Error(`prices.tokens[${parsedKey.assetKey}].sellerReceiveAddress must be a valid BTC address`);
    }
  } else if (!isMvcAddress(sellerReceiveAddress)) {
    throw new Error(`prices.tokens[${parsedKey.assetKey}].sellerReceiveAddress must be a valid MVC address`);
  }
  return {
    assetKey: parsedKey.assetKey,
    chain: parsedKey.chain,
    standard: parsedKey.standard,
    ...(parsedKey.mrc20Id ? { mrc20Id: parsedKey.mrc20Id } : {}),
    ...(parsedKey.codehash ? { codehash: parsedKey.codehash } : {}),
    ...(parsedKey.genesis ? { genesis: parsedKey.genesis } : {}),
    symbol,
    decimals,
    amountBase,
    amountDisplay,
    sellerReceiveAddress,
  };
}

function parsePricesInput(raw: unknown): Mrc721SellIntentPrices | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const prices: Mrc721SellIntentPrices = {};
  if (obj.me && typeof obj.me === 'object' && !Array.isArray(obj.me)) {
    const amountMilli = Number((obj.me as Record<string, unknown>).amountMilli);
    if (!Number.isInteger(amountMilli) || amountMilli < MRC721_SELL_MIN_ME_MILLI) {
      throw new Error(`prices.me.amountMilli must be an integer >= ${MRC721_SELL_MIN_ME_MILLI} (1 ME)`);
    }
    prices.me = { amountMilli };
  }
  if (obj.fiat && typeof obj.fiat === 'object' && !Array.isArray(obj.fiat)) {
    const fiatObj = obj.fiat as Record<string, unknown>;
    const currency = String(fiatObj.currency ?? 'CNY').trim().toUpperCase();
    if (currency !== 'CNY') {
      throw new Error('prices.fiat.currency currently only supports "CNY"');
    }
    const amountCents = Number(fiatObj.amountCents);
    if (!Number.isInteger(amountCents) || amountCents < MRC721_SELL_MIN_CNY_CENTS) {
      throw new Error(`prices.fiat.amountCents must be an integer >= ${MRC721_SELL_MIN_CNY_CENTS} (¥1.00)`);
    }
    prices.fiat = { currency: 'CNY', amountCents };
  }
  if (Array.isArray(obj.tokens) && obj.tokens.length > 0) {
    const seen = new Set<string>();
    const tokens: Mrc721SellIntentPriceToken[] = [];
    for (const entry of obj.tokens) {
      const parsed = parsePriceTokenEntry(entry);
      if (seen.has(parsed.assetKey)) {
        throw new Error(`duplicate assetKey in prices.tokens: ${parsed.assetKey}`);
      }
      seen.add(parsed.assetKey);
      tokens.push(parsed);
    }
    prices.tokens = tokens;
  }
  return prices.me || prices.fiat || (prices.tokens && prices.tokens.length > 0) ? prices : undefined;
}

function mergeTermsWithPrices(
  prices: Mrc721SellIntentPrices | undefined,
  rawCurrencies: string[],
  rawSettlement: string[],
  hasPriceHintSats: boolean,
): { acceptedCurrencies: string[]; settlement: string[] } {
  const currencies = new Set(rawCurrencies.map((s) => s.trim()).filter(Boolean));
  const settlement = new Set(rawSettlement.map((s) => s.trim()).filter(Boolean));
  if (prices?.me) {
    currencies.add('me');
    settlement.add('me-escrow');
  }
  if (prices?.fiat) {
    currencies.add(`fiat:${prices.fiat.currency}`);
    settlement.add('fiat-escrow');
  }
  if (prices?.tokens?.length) {
    for (const token of prices.tokens) {
      currencies.add(`ft:${token.assetKey}`);
      if (token.chain === 'mvc') settlement.add('atomic-swap');
      else settlement.add('token-direct');
    }
  }
  if (hasPriceHintSats) {
    if (!currencies.size) currencies.add('space');
    if (!settlement.size) {
      settlement.add('atomic-swap');
      settlement.add('escrow');
    }
  }
  return {
    acceptedCurrencies: currencies.size ? [...currencies] : ['space'],
    settlement: settlement.size ? [...settlement] : ['atomic-swap', 'escrow'],
  };
}

/** Validate + normalize a sell-intent content object (tolerant on optional fields). */
export function parseMrc721SellIntent(input: unknown): Mrc721SellIntentContent {
  const record = asRecord(input);
  const itemPinId = String(record.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  const sellerAddress = String(record.sellerAddress ?? '').trim();
  if (!isMvcAddress(sellerAddress)) {
    throw new Error('sellerAddress must be an MVC address');
  }
  const priceHintSats = record.priceHintSats == null ? undefined : Number(record.priceHintSats);
  if (priceHintSats != null && (!Number.isInteger(priceHintSats) || priceHintSats <= 0)) {
    throw new Error('priceHintSats must be a positive integer (it is a display hint, not an on-chain ask)');
  }
  const prices = parsePricesInput(record.prices);
  const shopMetaAppPinIdRaw = typeof record.shopMetaAppPinId === 'string' ? record.shopMetaAppPinId.trim().toLowerCase() : '';
  const shopMetaAppPinId = shopMetaAppPinIdRaw && isMrc721PinId(shopMetaAppPinIdRaw) ? shopMetaAppPinIdRaw : undefined;
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
  const mergedTerms = mergeTermsWithPrices(
    prices,
    asStringArray(record.acceptedCurrencies),
    asStringArray(record.settlement),
    priceHintSats != null,
  );
  return {
    active: record.active !== false,
    itemPinId,
    collectionName: typeof record.collectionName === 'string' && record.collectionName.trim() ? record.collectionName.trim() : undefined,
    collectionPinId: typeof record.collectionPinId === 'string' && record.collectionPinId.trim() ? record.collectionPinId.trim() : undefined,
    itemOutpoint: asRecord(record.itemOutpoint).txid
      ? {
        txid: String(record.itemOutpoint && (record.itemOutpoint as Record<string, unknown>).txid),
        vout: Number((record.itemOutpoint as Record<string, unknown>).vout ?? 0),
        satoshis: Number((record.itemOutpoint as Record<string, unknown>).satoshis ?? 0),
      }
      : undefined,
    sellerAddress,
    sellerMetaId: typeof record.sellerMetaId === 'string' && record.sellerMetaId.trim() ? record.sellerMetaId.trim() : undefined,
    ...(prices ? { prices } : {}),
    ...(typeof record.autoFulfillMe === 'boolean' ? { autoFulfillMe: record.autoFulfillMe } : {}),
    ...(typeof record.autoFulfillTokens === 'boolean' ? { autoFulfillTokens: record.autoFulfillTokens } : {}),
    ...(typeof record.negotiable === 'boolean' ? { negotiable: record.negotiable } : {}),
    ...(shopMetaAppPinId ? { shopMetaAppPinId } : {}),
    priceHintSats,
    acceptedCurrencies: mergedTerms.acceptedCurrencies,
    settlement: mergedTerms.settlement,
    note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined,
    createdAt: Number(record.createdAt) || Math.floor(Date.now() / 1000),
    expiresAt: Number(record.expiresAt) || undefined,
  };
}

/**
 * Race-safety note: the KV intent book relies on read→write sections staying
 * SYNCHRONOUS (no await between readIntents and the following writeIntents —
 * Node's single thread makes that atomic). Inserting an await in between
 * would reintroduce lost updates across concurrent tool calls.
 */
function readIntents(kv: SellIntentKv, metabotId: number): Mrc721SellIntentRecord[] {
  const stored = kv.get<Mrc721SellIntentRecord[]>(intentsKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

function writeIntents(kv: SellIntentKv, metabotId: number, records: Mrc721SellIntentRecord[]): void {
  kv.set(intentsKey(metabotId), records);
}

export interface Mrc721SellIntentDeclareInput {
  metabotId: number;
  itemPinId: string;
  priceMe?: number;
  priceMeMilli?: number;
  priceCnyYuan?: number;
  priceCnyCents?: number;
  priceTokens?: Mrc721SellIntentPriceTokenInput[];
  autoFulfillMe?: boolean;
  autoFulfillTokens?: boolean;
  negotiable?: boolean;
  shopMetaAppPinId?: string;
  priceHintSats?: number;
  acceptedCurrencies?: string[];
  settlement?: string[];
  note?: string;
  expiresInHours?: number;
  network?: 'mvc' | 'btc';
  origin?: string;
}

export interface Mrc721SellIntentWriteResult {
  sellPinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  intent: Mrc721SellIntentContent;
}

export interface TokenMetadataResolverResult {
  symbol: string;
  decimals: number;
}

async function resolveDefaultTokenMetadata(params: {
  parsedKey: ParsedFtAssetKey;
  btcAddress?: string;
  mvcAddress?: string;
}): Promise<TokenMetadataResolverResult | null> {
  const { parsedKey, btcAddress, mvcAddress } = params;
  if (parsedKey.chain === 'btc' && parsedKey.mrc20Id) {
    try {
      const res = await fetch(
        `https://api.metaid.market/api-market/api/v1/common/mrc20/tick/info?tickId=${encodeURIComponent(parsedKey.mrc20Id)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (res.ok) {
        const json = await res.json() as { code?: number; data?: { tick?: string; decimals?: number | string } };
        const data = json?.data ?? (json as { tick?: string; decimals?: number | string });
        if (data?.tick != null && data?.decimals != null && Number.isInteger(Number(data.decimals))) {
          return { symbol: String(data.tick).trim(), decimals: Number(data.decimals) };
        }
      }
    } catch {
      // Fall back to wallet asset list
    }
    if (btcAddress) {
      try {
        const assets = await listMrc20Assets(btcAddress);
        const hit = assets.find((a) => a.mrc20Id.toLowerCase() === parsedKey.mrc20Id);
        if (hit) return { symbol: hit.symbol, decimals: hit.decimal };
      } catch {
        // Ignore fallback lookup errors
      }
    }
    return null;
  }

  if (parsedKey.chain === 'mvc' && parsedKey.codehash && parsedKey.genesis) {
    if (mvcAddress) {
      try {
        const assets = await listMvcFtAssets(mvcAddress);
        const hit = assets.find(
          (a) =>
            a.codeHash.toLowerCase() === parsedKey.codehash
            && a.genesis.toLowerCase() === parsedKey.genesis,
        );
        if (hit) return { symbol: hit.symbol, decimals: hit.decimal };
      } catch {
        // Fall through to Metalet token info endpoint
      }
    }
    try {
      const res = await fetch(
        `https://www.metalet.space/wallet-api/v4/mvc/contract/ft/info?net=livenet&codeHash=${encodeURIComponent(parsedKey.codehash)}&genesis=${encodeURIComponent(parsedKey.genesis)}`,
        { signal: AbortSignal.timeout(8_000) },
      );
      if (res.ok) {
        const json = await res.json() as { data?: { symbol?: string; decimal?: number | string; decimals?: number | string } };
        const row = json?.data;
        const dec = Number(row?.decimal ?? row?.decimals);
        if (row?.symbol && Number.isInteger(dec) && dec >= 0) {
          return { symbol: String(row.symbol).trim(), decimals: dec };
        }
      }
    } catch {
      // Ignore
    }
  }
  return null;
}

async function resolveDeclarePrices(
  input: Mrc721SellIntentDeclareInput,
  metabot: { mvc_address: string; btc_address?: string | null },
  resolveTokenMeta?: (params: { assetKey: string; metabotId: number }) => Promise<TokenMetadataResolverResult | null>,
): Promise<Mrc721SellIntentPrices | undefined> {
  const prices: Mrc721SellIntentPrices = {};
  if (input.priceMeMilli != null || input.priceMe != null) {
    let amountMilli: number;
    if (input.priceMeMilli != null) {
      amountMilli = Number(input.priceMeMilli);
      if (!Number.isInteger(amountMilli) || amountMilli < MRC721_SELL_MIN_ME_MILLI) {
        throw new Error(`priceMeMilli must be an integer >= ${MRC721_SELL_MIN_ME_MILLI} (1 ME)`);
      }
    } else {
      const meVal = Number(input.priceMe);
      if (!Number.isFinite(meVal) || meVal <= 0) {
        throw new Error('price_me must be a positive number (minimum 1 ME)');
      }
      amountMilli = Math.round(meVal * 1000);
      if (Math.abs(amountMilli - meVal * 1000) > 1e-6) {
        throw new Error('price_me supports at most 3 decimal places (1 milli-ME = 0.001 ME)');
      }
      if (amountMilli < MRC721_SELL_MIN_ME_MILLI) {
        throw new Error(`price_me must be at least 1 ME (${MRC721_SELL_MIN_ME_MILLI} milli-ME)`);
      }
    }
    prices.me = { amountMilli };
  }

  if (input.priceCnyCents != null || input.priceCnyYuan != null) {
    let amountCents: number;
    if (input.priceCnyCents != null) {
      amountCents = Number(input.priceCnyCents);
      if (!Number.isInteger(amountCents) || amountCents < MRC721_SELL_MIN_CNY_CENTS) {
        throw new Error(`priceCnyCents must be an integer >= ${MRC721_SELL_MIN_CNY_CENTS} (¥1.00)`);
      }
    } else {
      const yuanVal = Number(input.priceCnyYuan);
      if (!Number.isFinite(yuanVal) || yuanVal <= 0) {
        throw new Error('price_cny_yuan must be a positive number (minimum ¥1.00)');
      }
      amountCents = Math.round(yuanVal * 100);
      if (Math.abs(amountCents - yuanVal * 100) > 1e-6) {
        throw new Error('price_cny_yuan supports at most 2 decimal places (1 cent = ¥0.01)');
      }
      if (amountCents < MRC721_SELL_MIN_CNY_CENTS) {
        throw new Error(`price_cny_yuan must be at least ¥1.00 (${MRC721_SELL_MIN_CNY_CENTS} cents)`);
      }
    }
    prices.fiat = { currency: 'CNY', amountCents };
  }

  if (Array.isArray(input.priceTokens) && input.priceTokens.length > 0) {
    const seen = new Set<string>();
    const resolvedTokens: Mrc721SellIntentPriceToken[] = [];
    for (const rawEntry of input.priceTokens) {
      const parsedKey = parseCanonicalFtAssetKey(rawEntry.assetKey);
      if (seen.has(parsedKey.assetKey)) {
        throw new Error(`duplicate asset_key in price_tokens: ${parsedKey.assetKey}`);
      }
      seen.add(parsedKey.assetKey);

      const sellerReceiveAddress = parsedKey.chain === 'btc'
        ? String(metabot.btc_address ?? '').trim()
        : String(metabot.mvc_address ?? '').trim();
      if (parsedKey.chain === 'btc' && !isLikelyBtcReceiveAddress(sellerReceiveAddress)) {
        throw new Error(`declaring bot has no valid BTC address to receive MRC-20 token ${parsedKey.assetKey}`);
      }
      if (parsedKey.chain === 'mvc' && !isMvcAddress(sellerReceiveAddress)) {
        throw new Error(`declaring bot has no valid MVC address to receive FT ${parsedKey.assetKey}`);
      }

      let symbol = typeof rawEntry.symbol === 'string' ? rawEntry.symbol.trim() : '';
      let decimals = rawEntry.decimals != null && Number.isInteger(Number(rawEntry.decimals))
        ? Number(rawEntry.decimals)
        : undefined;
      if (!symbol || decimals === undefined) {
        const fetched = resolveTokenMeta
          ? await resolveTokenMeta({ assetKey: parsedKey.assetKey, metabotId: input.metabotId })
          : await resolveDefaultTokenMetadata({
              parsedKey,
              btcAddress: metabot.btc_address ?? undefined,
              mvcAddress: metabot.mvc_address,
            });
        if (fetched) {
          if (!symbol) symbol = fetched.symbol;
          if (decimals === undefined) decimals = fetched.decimals;
        }
      }
      if (!symbol) {
        throw new Error(`could not resolve token symbol for ${parsedKey.assetKey}; pass symbol explicitly`);
      }
      if (decimals === undefined || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new Error(`could not resolve valid decimals for ${parsedKey.assetKey}; pass decimals explicitly`);
      }

      const amountBase = decimalDisplayToBaseUnits(rawEntry.amountDisplay, decimals);
      const amountDisplay = baseUnitsToDecimalDisplay(amountBase, decimals);
      resolvedTokens.push({
        assetKey: parsedKey.assetKey,
        chain: parsedKey.chain,
        standard: parsedKey.standard,
        ...(parsedKey.mrc20Id ? { mrc20Id: parsedKey.mrc20Id } : {}),
        ...(parsedKey.codehash ? { codehash: parsedKey.codehash } : {}),
        ...(parsedKey.genesis ? { genesis: parsedKey.genesis } : {}),
        symbol,
        decimals,
        amountBase,
        amountDisplay,
        sellerReceiveAddress,
      });
    }
    prices.tokens = resolvedTokens;
  }

  return prices.me || prices.fiat || (prices.tokens && prices.tokens.length > 0) ? prices : undefined;
}

/**
 * Broadcast the sell-intent declaration pin and record it locally. The item
 * must currently be held by the declaring bot (live holder view) — a sell
 * declaration for an item you do not hold is refused at the source.
 */
export async function declareMrc721SellIntent(
  deps: {
    createPin: Mrc721CreatePinFn;
    resolveTokenMeta?: (params: { assetKey: string; metabotId: number }) => Promise<TokenMetadataResolverResult | null>;
  },
  input: Mrc721SellIntentDeclareInput & { store: MetabotStore; intents: SellIntentKv },
): Promise<Mrc721SellIntentWriteResult> {
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  if (input.priceHintSats != null && (!Number.isInteger(input.priceHintSats) || input.priceHintSats <= 0)) {
    throw new Error('priceHintSats must be a positive integer');
  }
  const shopMetaAppPinIdRaw = typeof input.shopMetaAppPinId === 'string' ? input.shopMetaAppPinId.trim().toLowerCase() : '';
  if (shopMetaAppPinIdRaw && !isMrc721PinId(shopMetaAppPinIdRaw)) {
    throw new Error('shopMetaAppPinId must be a valid pinId (<64hex>i<index>)');
  }
  const metabot = input.store.getMetabotById(input.metabotId);
  if (!metabot?.mvc_address) {
    throw new Error('declaring bot has no MVC address');
  }
  const prices = await resolveDeclarePrices(input, metabot, deps.resolveTokenMeta);
  const item = await fetchMrc721ItemInfo({ pinId: itemPinId });
  if (!item) {
    throw new Error(`item ${itemPinId} is not indexed (yet) — the holder view is the only sell-authority source, so an unindexed item cannot be declared for sale`);
  }
  if (item.burned) {
    throw new Error(`item ${itemPinId} is burned and cannot be sold`);
  }
  if ((item.ownerAddress ?? '').toLowerCase() !== metabot.mvc_address.toLowerCase()) {
    throw new Error(`item ${itemPinId} is held by ${item.ownerAddress ?? 'someone else'}, not by the declaring bot`);
  }

  const nowMs = Date.now();
  // Pin content timestamps are epoch SECONDS (doc schema §2.2, manapi
  // convention); the local book's updatedAt stays ms (local bookkeeping only).
  const nowSeconds = Math.floor(nowMs / 1000);
  const autoFulfillMe = input.autoFulfillMe ?? true;
  const autoFulfillTokens = input.autoFulfillTokens ?? true;
  const negotiable = input.negotiable ?? true;
  const mergedTerms = mergeTermsWithPrices(
    prices,
    input.acceptedCurrencies ?? [],
    input.settlement ?? [],
    input.priceHintSats != null,
  );
  const intent: Mrc721SellIntentContent = {
    active: true,
    itemPinId,
    collectionName: item.collectionName,
    collectionPinId: item.collectionPinId,
    itemOutpoint: item.output
      ? {
        txid: item.output.split(':')[0] ?? item.output,
        vout: Number(item.output.split(':')[1] ?? 0),
        satoshis: Number(item.outputValue ?? 0),
      }
      : undefined,
    sellerAddress: metabot.mvc_address,
    sellerMetaId: metabot.globalmetaid ?? undefined,
    ...(prices ? { prices } : {}),
    autoFulfillMe,
    ...(prices?.tokens?.length || input.autoFulfillTokens !== undefined ? { autoFulfillTokens } : {}),
    negotiable,
    ...(shopMetaAppPinIdRaw ? { shopMetaAppPinId: shopMetaAppPinIdRaw } : {}),
    priceHintSats: input.priceHintSats,
    acceptedCurrencies: mergedTerms.acceptedCurrencies,
    settlement: mergedTerms.settlement,
    note: input.note?.trim() || undefined,
    createdAt: nowSeconds,
    expiresAt: input.expiresInHours && input.expiresInHours > 0 ? nowSeconds + input.expiresInHours * 3_600 : undefined,
  };

  // Append-only declaration log (buzz pattern, doc §2.1): every declaration —
  // first, re-declare, or post-cancel re-list — is a CREATE pin on the fixed
  // /protocols/mrc721sell path; per itemPinId the LATEST pin wins.
  // Only the id-reuse lookup happens before the await; the write-back below
  // RE-READS the book (a read→write section must not span an await, see the
  // race-safety note above readIntents).
  const existingId = readIntents(input.intents, input.metabotId)
    .find((record) => record.intent.itemPinId === itemPinId)?.id;

  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_SELL_INTENT_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(intent),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_sell_intent' });

  const record: Mrc721SellIntentRecord = {
    id: existingId ?? randomBytes(8).toString('hex'),
    metabotId: input.metabotId,
    intent,
    sellPinId: broadcast.pinId,
    status: 'active',
    autoFulfillMe,
    autoFulfillTokens,
    updatedAt: nowMs,
  };
  // Re-read AFTER the await: a concurrent tool call may have written the book
  // while the pin was broadcasting. Merge into the freshest array — replace a
  // same-item record that appeared meanwhile, else append — and write back
  // immediately (synchronous read→modify→write).
  const records = readIntents(input.intents, input.metabotId);
  const existing = records.findIndex((record) => record.intent.itemPinId === itemPinId);
  if (existing >= 0) records[existing] = record;
  else records.push(record);
  writeIntents(input.intents, input.metabotId, records);
  return {
    sellPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    intent,
  };
}

/**
 * Cancel a sell intent: broadcast a closing declaration (active=false) on the
 * fixed path — per the append-only log, that new pin becomes the item's
 * latest declaration — and flip the local record. The item itself is
 * untouched.
 */
export async function cancelMrc721SellIntent(
  deps: { createPin: Mrc721CreatePinFn },
  input: { metabotId: number; itemPinId: string; network?: 'mvc' | 'btc'; origin?: string; store: MetabotStore; intents: SellIntentKv },
): Promise<Mrc721SellIntentWriteResult> {
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  const records = readIntents(input.intents, input.metabotId);
  const record = records.find((entry) => entry.intent.itemPinId === itemPinId);
  if (!record) {
    throw new Error(`no sell intent recorded for item ${itemPinId}`);
  }
  if (record.status === 'cancelled' && record.intent.active === false) {
    throw new Error(`sell intent for item ${itemPinId} is already cancelled`);
  }
  const content: Mrc721SellIntentContent = { ...record.intent, active: false };
  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_SELL_INTENT_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(content),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_sell_intent_cancel' });
  record.intent = content;
  record.status = 'cancelled';
  record.updatedAt = Date.now();
  writeIntents(input.intents, input.metabotId, records);
  return {
    sellPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    intent: content,
  };
}

export function listMrc721SellIntentRecords(kv: SellIntentKv, metabotId: number): Mrc721SellIntentRecord[] {
  return readIntents(kv, metabotId);
}

/**
 * Find an active, non-expired local sell-intent record for an item.
 * Used by SellerAutoFulfillDaemon check #1.
 */
export function findLocalActiveSellIntentForItem(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Mrc721SellIntentRecord | null {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  if (!normalizedPinId) return null;
  const records = readIntents(kv, metabotId);
  const found = records.find((r) => r.intent?.itemPinId?.toLowerCase() === normalizedPinId);
  if (!found) return null;
  if (found.status !== 'active' || found.intent.active !== true) return null;
  if (found.intent.expiresAt && found.intent.expiresAt > 0 && found.intent.expiresAt <= nowSeconds) {
    return null;
  }
  return found;
}

/**
 * Mark a local sell-intent record as sold after SellerAutoFulfillDaemon
 * completes delivery & settlement. Synchronous read->modify->write.
 */
export function markMrc721SellIntentSold(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  meta?: { orderId?: string; txId?: string },
): boolean {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  const records = readIntents(kv, metabotId);
  const index = records.findIndex((r) => r.intent?.itemPinId?.toLowerCase() === normalizedPinId);
  if (index < 0) return false;
  const nowMs = Date.now();
  records[index] = {
    ...records[index],
    status: 'sold',
    intent: {
      ...records[index].intent,
      active: false,
    },
    ...(meta?.orderId ? { soldOrderId: meta.orderId } : {}),
    ...(meta?.txId ? { soldTxId: meta.txId } : {}),
    soldAt: Math.floor(nowMs / 1000),
    updatedAt: nowMs,
  };
  writeIntents(kv, metabotId, records);
  return true;
}

function readAcceptedQuotes(kv: SellIntentKv, metabotId: number): GoodsAcceptedQuoteRecord[] {
  const stored = kv.get<GoodsAcceptedQuoteRecord[]>(acceptedQuotesKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

function writeAcceptedQuotes(kv: SellIntentKv, metabotId: number, records: GoodsAcceptedQuoteRecord[]): void {
  kv.set(acceptedQuotesKey(metabotId), records);
}

export function recordAcceptedGoodsQuote(
  kv: SellIntentKv,
  metabotId: number,
  quote: Omit<GoodsAcceptedQuoteRecord, 'status' | 'createdAt' | 'updatedAt'>,
): GoodsAcceptedQuoteRecord {
  const nowMs = Date.now();
  const normalizedPinId = quote.itemPinId.trim().toLowerCase();
  const entry: GoodsAcceptedQuoteRecord = {
    ...quote,
    itemPinId: normalizedPinId,
    status: 'active',
    createdAt: Math.floor(nowMs / 1000),
    updatedAt: nowMs,
  };
  const records = readAcceptedQuotes(kv, metabotId);
  const idx = records.findIndex((r) => r.inquiryId === entry.inquiryId || (r.itemPinId === normalizedPinId && r.status === 'active'));
  if (idx >= 0) records[idx] = entry;
  else records.push(entry);
  writeAcceptedQuotes(kv, metabotId, records);
  return entry;
}

export function findAcceptedGoodsQuoteForItem(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GoodsAcceptedQuoteRecord | null {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  const records = readAcceptedQuotes(kv, metabotId);
  const found = records.find(
    (r) =>
      r.itemPinId.toLowerCase() === normalizedPinId
      && r.status === 'active'
      && (!r.validUntil || r.validUntil > nowSeconds),
  );
  return found ?? null;
}

export function markAcceptedGoodsQuoteUsed(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  orderId?: string,
): boolean {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  const records = readAcceptedQuotes(kv, metabotId);
  let changed = false;
  const nowMs = Date.now();
  for (let i = 0; i < records.length; i += 1) {
    if (records[i].itemPinId.toLowerCase() === normalizedPinId && records[i].status === 'active') {
      records[i] = {
        ...records[i],
        status: 'used',
        ...(orderId ? { orderId } : {}),
        updatedAt: nowMs,
      };
      changed = true;
    }
  }
  if (changed) writeAcceptedQuotes(kv, metabotId, records);
  return changed;
}

function readSellerAuthorizedQuotes(kv: SellIntentKv, metabotId: number): GoodsAcceptedQuoteRecord[] {
  const stored = kv.get<GoodsAcceptedQuoteRecord[]>(sellerAuthorizedQuotesKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

function writeSellerAuthorizedQuotes(kv: SellIntentKv, metabotId: number, records: GoodsAcceptedQuoteRecord[]): void {
  kv.set(sellerAuthorizedQuotesKey(metabotId), records);
}

export function recordSellerAuthorizedQuote(
  kv: SellIntentKv,
  metabotId: number,
  quote: Omit<GoodsAcceptedQuoteRecord, 'status' | 'createdAt' | 'updatedAt'>,
): GoodsAcceptedQuoteRecord {
  const nowMs = Date.now();
  const normalizedPinId = quote.itemPinId.trim().toLowerCase();
  const entry: GoodsAcceptedQuoteRecord = {
    ...quote,
    itemPinId: normalizedPinId,
    status: 'active',
    createdAt: Math.floor(nowMs / 1000),
    updatedAt: nowMs,
  };
  const records = readSellerAuthorizedQuotes(kv, metabotId);
  const idx = records.findIndex((r) => r.inquiryId === entry.inquiryId);
  if (idx >= 0) records[idx] = entry;
  else records.push(entry);
  writeSellerAuthorizedQuotes(kv, metabotId, records);
  return entry;
}

export function findSellerAuthorizedQuoteForOrder(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  buyerNftAddress?: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): GoodsAcceptedQuoteRecord | null {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  const normalizedBuyer = String(buyerNftAddress ?? '').trim().toLowerCase();
  const records = readSellerAuthorizedQuotes(kv, metabotId);
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const r = records[i];
    if (r.itemPinId.toLowerCase() !== normalizedPinId) continue;
    if (r.status !== 'active') continue;
    if (r.validUntil && r.validUntil <= nowSeconds) continue;
    if (r.buyerNftAddress && (!normalizedBuyer || r.buyerNftAddress.toLowerCase() !== normalizedBuyer)) {
      continue;
    }
    return r;
  }
  return null;
}

export function markSellerAuthorizedQuoteUsed(
  kv: SellIntentKv,
  metabotId: number,
  itemPinId: string,
  meta?: { inquiryId?: string; orderId?: string },
): boolean {
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  const records = readSellerAuthorizedQuotes(kv, metabotId);
  let changed = false;
  const nowMs = Date.now();
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (r.status !== 'active') continue;
    if (r.itemPinId.toLowerCase() !== normalizedPinId) continue;
    if (meta?.inquiryId && r.inquiryId !== meta.inquiryId) continue;
    records[i] = {
      ...r,
      status: 'used',
      ...(meta?.orderId ? { orderId: meta.orderId } : {}),
      updatedAt: nowMs,
    };
    changed = true;
  }
  if (changed) writeSellerAuthorizedQuotes(kv, metabotId, records);
  return changed;
}

/**
 * Best-effort lightweight trade receipt broadcast on `/protocols/mrc721trade`
 * after ABS escrow delivery/settlement so MetaSo market trade feeds index it.
 */
export async function broadcastMrc721TradeReceipt(
  deps: { createPin: Mrc721CreatePinFn },
  input: {
    metabotId: number;
    txId: string;
    orderId: string;
    itemPinId: string;
    collectionPinId?: string;
    sellerAddress: string;
    sellerMetaId?: string;
    buyerAddress: string;
    buyerMetaId?: string;
    currency: 'me' | 'fiat:CNY' | 'space' | `ft:${string}`;
    amountMilli?: number;
    amountCents?: number;
    priceSats?: number;
    assetKey?: string;
    amountBase?: string;
    amountDisplay?: string;
    settledAt?: number;
    verifiedSource?: 'abs_escrow' | 'chain_offer' | 'escrow_bot' | 'atomic_ft_swap' | 'token_verify';
    network?: 'mvc' | 'btc';
  },
): Promise<{ pinId: string; txids: string[] }> {
  const payload = {
    txId: input.txId,
    orderId: input.orderId,
    itemPinId: input.itemPinId,
    ...(input.collectionPinId ? { collectionPinId: input.collectionPinId } : {}),
    sellerAddress: input.sellerAddress,
    ...(input.sellerMetaId ? { sellerMetaId: input.sellerMetaId } : {}),
    buyerAddress: input.buyerAddress,
    ...(input.buyerMetaId ? { buyerMetaId: input.buyerMetaId } : {}),
    currency: input.currency,
    ...(input.amountMilli != null ? { amountMilli: input.amountMilli } : {}),
    ...(input.amountCents != null ? { amountCents: input.amountCents } : {}),
    ...(input.priceSats != null ? { priceSats: input.priceSats } : {}),
    ...(input.assetKey ? { assetKey: input.assetKey } : {}),
    ...(input.amountBase ? { amountBase: input.amountBase } : {}),
    ...(input.amountDisplay ? { amountDisplay: input.amountDisplay } : {}),
    settledAt: input.settledAt ?? Math.floor(Date.now() / 1000),
    verifiedSource: input.verifiedSource ?? 'abs_escrow',
  };
  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_TRADE_RECEIPT_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  }, { network: input.network ?? 'mvc', origin: 'daemon:seller_auto_fulfill' });
  return { pinId: broadcast.pinId, txids: broadcast.txids };
}

/**
 * Listed view: local records joined with the live holder view. `stale` = the
 * item is no longer held by the seller (transferred away, or the holder view
 * cannot confirm it) — displayed honestly instead of silently dropped.
 */
export async function listMrc721MySellIntents(
  kv: SellIntentKv,
  metabotId: number,
  filter?: { collectionName?: string; collectionPinId?: string },
): Promise<Mrc721SellIntentView[]> {
  const records = readIntents(kv, metabotId);
  const views: Mrc721SellIntentView[] = [];
  for (const record of records) {
    if (filter?.collectionName && record.intent.collectionName !== filter.collectionName) continue;
    if (filter?.collectionPinId && record.intent.collectionPinId !== filter.collectionPinId) continue;
    if (record.status === 'cancelled' || record.status === 'sold') {
      views.push({ id: record.id, itemPinId: record.intent.itemPinId, status: record.status, intent: record.intent, sellPinId: record.sellPinId });
      continue;
    }
    let status: Mrc721SellIntentStatus = 'active';
    let reason: string | undefined;
    try {
      const item = await fetchMrc721ItemInfo({ pinId: record.intent.itemPinId });
      if (!item || (item.ownerAddress ?? '').toLowerCase() !== record.intent.sellerAddress.toLowerCase()) {
        status = 'stale';
        reason = 'the item is no longer held by the seller address';
      }
    } catch (error) {
      status = 'stale';
      reason = `holder re-check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    views.push({
      id: record.id,
      itemPinId: record.intent.itemPinId,
      status,
      reason,
      intent: record.intent,
      sellPinId: record.sellPinId,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Market reads (S2): other bots' declared sell intents via the indexer
// ---------------------------------------------------------------------------

/**
 * One sell-intent row as served by the indexer (man-p2p ships camelCase plus
 * lowercase duplicates; we read the camelCase shape). Chain facts ride along.
 */
export interface Mrc721SellIntentRow {
  itemPinId: string;
  sellPinId?: string;
  active?: boolean;
  collectionName?: string;
  collectionPinId?: string;
  sellerAddress?: string;
  sellerMetaId?: string;
  prices?: Mrc721SellIntentPrices;
  autoFulfillMe?: boolean;
  autoFulfillTokens?: boolean;
  negotiable?: boolean;
  shopMetaAppPinId?: string;
  priceHintSats?: number;
  acceptedCurrencies?: string[];
  settlement?: string[];
  note?: string;
  contact?: { metaId?: string; metabotId?: number };
  createdAt?: number;
  expiresAt?: number;
  chainName?: string;
  height?: number;
  txId?: string;
  updatedAt?: number;
}

function sellIntentRowFrom(raw: unknown): Mrc721SellIntentRow {
  const record = asRecord(raw);
  const row: Mrc721SellIntentRow = {
    itemPinId: String(record.itemPinId ?? record.itempinid ?? ''),
    active: record.active === undefined ? undefined : record.active !== false,
  };
  const pickString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  row.sellPinId = pickString('sellPinId', 'sellpinid');
  row.collectionName = pickString('collectionName', 'collectionname');
  row.collectionPinId = pickString('collectionPinId', 'collectionpinid');
  row.sellerAddress = pickString('sellerAddress', 'selleraddress');
  row.sellerMetaId = pickString('sellerMetaId', 'sellermetaid');
  row.shopMetaAppPinId = pickString('shopMetaAppPinId', 'shopmetaapppinid');
  row.note = pickString('note');
  row.chainName = pickString('chainName', 'chainname');
  row.txId = pickString('txId', 'txid');
  if (typeof record.autoFulfillMe === 'boolean') row.autoFulfillMe = record.autoFulfillMe;
  if (typeof record.autoFulfillTokens === 'boolean') row.autoFulfillTokens = record.autoFulfillTokens;
  if (typeof record.negotiable === 'boolean') row.negotiable = record.negotiable;
  try {
    const parsedPrices = parsePricesInput(record.prices);
    if (parsedPrices) row.prices = parsedPrices;
  } catch {
    // Ignore malformed remote price blocks on read
  }
  if (Number.isFinite(Number(record.priceHintSats ?? record.pricehintsats))) {
    row.priceHintSats = Number(record.priceHintSats ?? record.pricehintsats) || undefined;
  }
  const currencies = record.acceptedCurrencies ?? record.acceptedcurrencies;
  if (Array.isArray(currencies)) {
    row.acceptedCurrencies = currencies.map((entry) => String(entry)).filter(Boolean);
  }
  if (Array.isArray(record.settlement)) {
    row.settlement = record.settlement.map((entry) => String(entry)).filter(Boolean);
  }
  if (Number.isFinite(Number(record.createdAt ?? record.createdat))) {
    row.createdAt = Number(record.createdAt ?? record.createdat) || undefined;
  }
  if (Number.isFinite(Number(record.expiresAt ?? record.expiresat))) {
    row.expiresAt = Number(record.expiresAt ?? record.expiresat) || undefined;
  }
  if (Number.isFinite(Number(record.updatedAt ?? record.updatedat))) {
    row.updatedAt = Number(record.updatedAt ?? record.updatedat) || undefined;
  }
  if (Number.isFinite(Number(record.height))) row.height = Number(record.height);
  return row;
}

/**
 * Backward-compatible fallback: if an older MetaSo-P2P indexer omits
 * `prices.tokens` on a v2.2 `/protocols/mrc721sell` listing/intent, read the
 * raw pin body and extract `prices.tokens` + `autoFulfillTokens`.
 */
export async function hydrateTokenPricesFromRawPin<
  T extends {
    sellPinId?: string;
    intentPinId?: string;
    prices?: Mrc721MarketPrices;
    autoFulfillTokens?: boolean;
    acceptedCurrencies?: string[];
  },
>(
  row: T,
  fetchRawPinFn: typeof fetchMrc721RawPin = fetchMrc721RawPin,
): Promise<T> {
  if (row.prices?.tokens && row.prices.tokens.length > 0) return row;
  const pinId = String(row.sellPinId ?? row.intentPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(pinId)) return row;
  const mentionsFt = Array.isArray(row.acceptedCurrencies)
    && row.acceptedCurrencies.some((c) => c.startsWith('ft:'));
  if (!mentionsFt && row.prices?.me) {
    // Only probe raw pin when acceptedCurrencies hints ft: or prices is completely empty
    return row;
  }
  try {
    const raw = await fetchRawPinFn(pinId);
    if (!raw?.content) return row;
    const parsedJson = JSON.parse(raw.content) as Record<string, unknown>;
    const parsedPrices = parsePricesInput(parsedJson.prices);
    if (!parsedPrices?.tokens?.length) return row;
    return {
      ...row,
      prices: {
        ...(row.prices ?? {}),
        ...parsedPrices,
        tokens: parsedPrices.tokens,
      },
      ...(typeof parsedJson.autoFulfillTokens === 'boolean' && row.autoFulfillTokens === undefined
        ? { autoFulfillTokens: parsedJson.autoFulfillTokens }
        : {}),
    };
  } catch {
    return row;
  }
}

export async function hydrateMarketListingTokens(
  listing: Mrc721MarketListing,
  fetchRawPinFn: typeof fetchMrc721RawPin = fetchMrc721RawPin,
): Promise<Mrc721MarketListing> {
  return hydrateTokenPricesFromRawPin<Mrc721MarketListing>(listing, fetchRawPinFn);
}

export interface Mrc721SellIntentPage {
  items: Mrc721SellIntentRow[];
  total?: number;
  cursor?: string;
}

/**
 * Query the indexer for declared sell intents (docs/nft-sell-protocol-draft.md
 * §2.3, indexer requirement R-C). Served by man-p2p; indexers without the
 * endpoint surface a structured 404 that callers must degrade on honestly.
 */
export async function fetchMrc721SellIntents(params: {
  collectionPinId?: string;
  collectionName?: string;
  itemPinId?: string;
  sellerAddress?: string;
  tokenAssetKey?: string;
  active?: boolean;
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721SellIntentPage> {
  // MetaSo-P2P owns the sell-intent index (indexing architecture 2026-11-05);
  // the production base is built into getMetasoApiBase (env override for
  // staging only). Transport/envelope errors propagate with the structured
  // markers so the tool degrades honestly.
  const query = {
    collectionPinId: params.collectionPinId,
    collectionName: params.collectionName,
    itemPinId: params.itemPinId,
    sellerAddress: params.sellerAddress,
    tokenAssetKey: params.tokenAssetKey,
    active: params.active == null ? undefined : (params.active ? 'true' : 'false'),
    cursor: params.cursor,
    size: params.size,
  };
  const data = await fetchMetasoJson('/api/mrc721/sell/intents', query) as { list?: unknown; total?: unknown; cursor?: unknown } | null;
  const rawItems = Array.isArray(data?.list) ? data.list.map(sellIntentRowFrom) : [];
  const items = await Promise.all(rawItems.map((row) => hydrateTokenPricesFromRawPin(row)));
  const filtered = params.tokenAssetKey
    ? items.filter((row) => row.prices?.tokens?.some((t) => t.assetKey === params.tokenAssetKey?.trim().toLowerCase()))
    : items;
  return {
    items: filtered,
    total: Number.isFinite(Number(data?.total)) ? Number(data?.total) : undefined,
    cursor: typeof data?.cursor === 'string' && data.cursor ? data.cursor : undefined,
  };
}

/** Single sell-intent lookup by item; a server-answered miss returns null. */
export async function fetchMrc721SellIntentInfo(params: {
  itemPinId: string;
}): Promise<Mrc721SellIntentRow | null> {
  try {
    const data = await fetchMetasoJson('/api/mrc721/sell/intent/info', { itemPinId: params.itemPinId });
    return data ? await hydrateTokenPricesFromRawPin(sellIntentRowFrom(data)) : null;
  } catch (error) {
    const status = (error as { mrc721Status?: number }).mrc721Status;
    const code = (error as { mrc721Code?: unknown }).mrc721Code;
    if (status === 404 || code !== undefined) return null;
    throw error;
  }
}
