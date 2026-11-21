/**
 * ftCardSyntax — DOM-free parser, validator, anti-spoofing formatter, and
 * serializer for the three FT Commerce ritual chat cards (Contract C4.2):
 *   - `ft-quote-card`: tri-rail price & depth comparison card
 *   - `ft-order-card`: seller multi-lot order seat & viral poster card
 *   - `ft-fill-card`: buyer/seller execution summary & utility handoff card
 */

export type FtCardRail = 'btc-psbt' | 'mvc-tokensell' | 'me-escrow';

export const FT_QUOTE_CARD_FENCE_TAG = 'ft-quote-card';
export const FT_ORDER_CARD_FENCE_TAG = 'ft-order-card';
export const FT_FILL_CARD_FENCE_TAG = 'ft-fill-card';

const FT_QUOTE_FENCE_TAGS = new Set(['ft-quote-card', 'ft-quote', 'ftquotecard']);
const FT_ORDER_FENCE_TAGS = new Set(['ft-order-card', 'ft-order', 'ftordercard']);
const FT_FILL_FENCE_TAGS = new Set(['ft-fill-card', 'ft-fill', 'ftfillcard']);

const VALID_RAILS = new Set<FtCardRail>(['btc-psbt', 'mvc-tokensell', 'me-escrow']);

export interface FtQuoteRow {
  rail: FtCardRail;
  label: string;
  floorUnit: string;
  depthDisplay: string;
  recommended?: boolean;
}

export interface FtQuoteCardData {
  assetKey: string;
  symbol: string;
  caVerified: boolean;
  quotes: FtQuoteRow[];
  suggestion?: string;
}

export interface FtOrderCardData {
  batchGroupId: string;
  assetKey: string;
  symbol: string;
  caVerified: boolean;
  rail: FtCardRail;
  lotAmountDisplay: string;
  totalLots: number;
  filledLots: number;
  unitPriceLabel: string;
  autoFulfill: boolean;
  sellerGlobalMetaId?: string;
  sellerName?: string;
  shopMetaAppPinId?: string;
  orderRefs: string[];
}

export type FtFillNextAction = 'browse_token_goods' | 'browse_paybuzz';

export interface FtFillCardData {
  side: 'buy' | 'sell';
  assetKey?: string;
  symbol: string;
  caVerified?: boolean;
  rail?: FtCardRail;
  totalTokenDisplay: string;
  filledOrderCount: number;
  totalPaidLabel: string;
  avgUnitPriceLabel?: string;
  txids: string[];
  nextActions: FtFillNextAction[];
}

function cleanStr(val: unknown, maxLen = 160): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function normalizeFenceLang(lang: string | undefined | null): string {
  return String(lang ?? '').trim().toLowerCase();
}

export function isFtQuoteCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_QUOTE_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtOrderCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_ORDER_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtFillCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_FILL_FENCE_TAGS.has(normalizeFenceLang(lang));
}

/**
 * Formats an anti-spoofing short identifier from a canonical FT `assetKey`
 * (`mrc20:<pinId>` or `mvc-ft:<codehash>:<genesis>`) so unverified tickers
 * with identical symbols can always be distinguished visually.
 */
export function formatFtAssetBadge(assetKey: string): string {
  const raw = cleanStr(assetKey, 200);
  if (!raw) return 'ID: unknown';
  if (raw.startsWith('mrc20:')) {
    const id = raw.slice('mrc20:'.length);
    if (id.length <= 14) return `ID: ${id}`;
    return `ID: ${id.slice(0, 6)}…${id.slice(-6)}`;
  }
  if (raw.startsWith('mvc-ft:')) {
    const rest = raw.slice('mvc-ft:'.length);
    const [codehash = '', genesis = ''] = rest.split(':');
    const shortGenesis =
      genesis.length > 12 ? `${genesis.slice(0, 6)}…${genesis.slice(-4)}` : genesis;
    const shortCode = codehash.length > 8 ? `${codehash.slice(0, 4)}…` : codehash;
    return shortGenesis ? `ID: ${shortCode}:${shortGenesis}` : `ID: ${rest.slice(0, 14)}`;
  }
  return raw.length > 16 ? `ID: ${raw.slice(0, 6)}…${raw.slice(-6)}` : `ID: ${raw}`;
}

export function formatFtRailLabel(rail: FtCardRail): string {
  if (rail === 'btc-psbt') return 'BTC MRC-20 PSBT';
  if (rail === 'mvc-tokensell') return 'MVC TokenSell';
  return 'ME Instant Escrow';
}

export function parseFtQuoteCardFence(raw: string): FtQuoteCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const assetKey = cleanStr(obj.assetKey, 180);
    const symbol = cleanStr(obj.symbol, 32);
    if (!assetKey || !symbol) return null;
    if (!Array.isArray(obj.quotes) || obj.quotes.length === 0) return null;

    const quotes: FtQuoteRow[] = [];
    for (const item of obj.quotes.slice(0, 6)) {
      if (!item || typeof item !== 'object') continue;
      const q = item as Record<string, unknown>;
      const rail = cleanStr(q.rail, 24) as FtCardRail;
      if (!VALID_RAILS.has(rail)) continue;
      const label = cleanStr(q.label, 64) || formatFtRailLabel(rail);
      const floorUnit = cleanStr(q.floorUnit, 64);
      const depthDisplay = cleanStr(q.depthDisplay, 48) || '0';
      if (!floorUnit) continue;
      quotes.push({
        rail,
        label,
        floorUnit,
        depthDisplay,
        recommended: q.recommended === true,
      });
    }
    if (quotes.length === 0) return null;

    const suggestion = cleanStr(obj.suggestion, 240);
    return {
      assetKey,
      symbol,
      caVerified: obj.caVerified === true,
      quotes,
      ...(suggestion ? { suggestion } : {}),
    };
  } catch {
    return null;
  }
}

export function parseFtOrderCardFence(raw: string): FtOrderCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const batchGroupId = cleanStr(obj.batchGroupId, 96);
    const assetKey = cleanStr(obj.assetKey, 180);
    const symbol = cleanStr(obj.symbol, 32);
    const rail = cleanStr(obj.rail, 24) as FtCardRail;
    const lotAmountDisplay = cleanStr(obj.lotAmountDisplay, 48);
    const unitPriceLabel = cleanStr(obj.unitPriceLabel, 96);
    const totalLots = Math.max(1, Math.min(500, Math.floor(Number(obj.totalLots ?? 0))));
    const filledLotsRaw = Math.max(0, Math.floor(Number(obj.filledLots ?? 0)));

    if (!batchGroupId || !assetKey || !symbol || !VALID_RAILS.has(rail)) return null;
    if (!lotAmountDisplay || !unitPriceLabel || !Number.isFinite(totalLots)) return null;

    const orderRefs = Array.isArray(obj.orderRefs)
      ? obj.orderRefs.map((r) => cleanStr(r, 140)).filter(Boolean).slice(0, 100)
      : [];
    const sellerGlobalMetaId = cleanStr(obj.sellerGlobalMetaId, 80);
    const sellerName = cleanStr(obj.sellerName, 48);
    const shopMetaAppPinId = cleanStr(obj.shopMetaAppPinId, 96);

    return {
      batchGroupId,
      assetKey,
      symbol,
      caVerified: obj.caVerified === true,
      rail,
      lotAmountDisplay,
      totalLots,
      filledLots: Math.min(totalLots, filledLotsRaw),
      unitPriceLabel,
      autoFulfill: obj.autoFulfill === true,
      ...(sellerGlobalMetaId ? { sellerGlobalMetaId } : {}),
      ...(sellerName ? { sellerName } : {}),
      ...(shopMetaAppPinId ? { shopMetaAppPinId } : {}),
      orderRefs,
    };
  } catch {
    return null;
  }
}

export function parseFtFillCardFence(raw: string): FtFillCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const sideRaw = cleanStr(obj.side, 12).toLowerCase();
    const side: 'buy' | 'sell' = sideRaw === 'sell' ? 'sell' : 'buy';
    if (sideRaw !== 'buy' && sideRaw !== 'sell') return null;

    const symbol = cleanStr(obj.symbol, 32);
    const totalTokenDisplay = cleanStr(obj.totalTokenDisplay, 64);
    const totalPaidLabel = cleanStr(obj.totalPaidLabel, 96);
    const filledOrderCount = Math.max(1, Math.min(500, Math.floor(Number(obj.filledOrderCount ?? 1))));
    if (!symbol || !totalTokenDisplay || !totalPaidLabel) return null;

    const avgUnitPriceLabel = cleanStr(obj.avgUnitPriceLabel, 80);
    const assetKey = cleanStr(obj.assetKey, 180);
    const railRaw = cleanStr(obj.rail, 24) as FtCardRail;
    const txids = Array.isArray(obj.txids)
      ? obj.txids.map((t) => cleanStr(t, 120)).filter(Boolean).slice(0, 50)
      : [];
    const nextActions: FtFillNextAction[] = Array.isArray(obj.nextActions)
      ? obj.nextActions
          .map((a) => cleanStr(a, 40))
          .filter((a): a is FtFillNextAction => a === 'browse_token_goods' || a === 'browse_paybuzz')
      : [];

    return {
      side,
      ...(assetKey ? { assetKey } : {}),
      symbol,
      ...(typeof obj.caVerified === 'boolean' ? { caVerified: obj.caVerified } : {}),
      ...(VALID_RAILS.has(railRaw) ? { rail: railRaw } : {}),
      totalTokenDisplay,
      filledOrderCount,
      totalPaidLabel,
      ...(avgUnitPriceLabel ? { avgUnitPriceLabel } : {}),
      txids,
      nextActions,
    };
  } catch {
    return null;
  }
}

export function formatFtQuoteCardFence(data: FtQuoteCardData): string {
  return `\`\`\`${FT_QUOTE_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtOrderCardFence(data: FtOrderCardData): string {
  return `\`\`\`${FT_ORDER_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtFillCardFence(data: FtFillCardData): string {
  return `\`\`\`${FT_FILL_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}
