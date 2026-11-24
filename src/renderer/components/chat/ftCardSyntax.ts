/**
 * ftCardSyntax — DOM-free parser, validator, chain/venue disambiguator,
 * anti-spoofing formatter, and serializer for the unified Token & FT Card
 * Suite (aligned with approved S1/D1 visual language):
 *
 *   1. `ft-order-card`     — L2 Seller listing seat & batch progress ledger
 *   2. `ft-quote-card`     — Q1 Four-rail route quote comparison (incl. MVCSwap preview)
 *   3. `ft-fill-card`      — F2 Dual-flow buy/sell & passive fill receipt
 *   4. `ft-my-orders-card` — O1 Cross-rail active seller orders & cancel desk
 *   5. `ft-portfolio-card` — P2 Per-chain (BTC MRC-20 vs MVC MetaContract) token portfolio
 *   6. `ft-bridge-card`    — B1 Cross-chain Octopus Bridge flow & confirmation tracker
 *   7. `ft-action-card`    — M1 (Genesis Issue certificate) & M2 (Transfer / Mint receipt)
 */

export type FtCardRail = 'btc-psbt' | 'mvc-tokensell' | 'me-escrow' | 'mvc-swap';
export type FtAssetChain = 'btc' | 'mvc' | 'doge';
export type FtAssetStandard = 'idcoin' | 'mrc20' | 'mvc-ft' | 'native';

export const FT_QUOTE_CARD_FENCE_TAG = 'ft-quote-card';
export const FT_ORDER_CARD_FENCE_TAG = 'ft-order-card';
export const FT_FILL_CARD_FENCE_TAG = 'ft-fill-card';
export const FT_MY_ORDERS_CARD_FENCE_TAG = 'ft-my-orders-card';
export const FT_PORTFOLIO_CARD_FENCE_TAG = 'ft-portfolio-card';
export const FT_BRIDGE_CARD_FENCE_TAG = 'ft-bridge-card';
export const FT_ACTION_CARD_FENCE_TAG = 'ft-action-card';
export const FT_ORDERBOOK_CARD_FENCE_TAG = 'ft-orderbook-card';

const FT_QUOTE_FENCE_TAGS = new Set(['ft-quote-card', 'ft-quote', 'ftquotecard']);
const FT_ORDER_FENCE_TAGS = new Set(['ft-order-card', 'ft-order', 'ftordercard']);
const FT_FILL_FENCE_TAGS = new Set(['ft-fill-card', 'ft-fill', 'ftfillcard']);
const FT_MY_ORDERS_FENCE_TAGS = new Set([
  'ft-my-orders-card',
  'ft-my-orders',
  'ftmyorderscard',
  'token-my-orders-card',
]);
const FT_PORTFOLIO_FENCE_TAGS = new Set([
  'ft-portfolio-card',
  'ft-portfolio',
  'ftportfoliocard',
  'token-portfolio-card',
]);
const FT_BRIDGE_FENCE_TAGS = new Set([
  'ft-bridge-card',
  'ft-bridge',
  'ftbridgecard',
  'token-bridge-card',
]);
const FT_ACTION_FENCE_TAGS = new Set([
  'ft-action-card',
  'ft-action',
  'ftactioncard',
  'token-action-card',
  'ft-receipt-card',
]);
const FT_ORDERBOOK_FENCE_TAGS = new Set([
  'ft-orderbook-card',
  'ft-orderbook',
  'ftorderbookcard',
  'ft-orders-card',
  'token-orderbook-card',
]);

const VALID_RAILS = new Set<FtCardRail>(['btc-psbt', 'mvc-tokensell', 'me-escrow', 'mvc-swap']);
const VALID_CHAINS = new Set<FtAssetChain>(['btc', 'mvc', 'doge']);
const VALID_STANDARDS = new Set<FtAssetStandard>(['idcoin', 'mrc20', 'mvc-ft', 'native']);

export interface FtQuoteRow {
  rail: FtCardRail;
  label: string;
  floorUnit: string;
  depthDisplay: string;
  recommended?: boolean;
  status?: 'active' | 'coming_soon';
  usdHint?: string;
  subMeta?: string;
  chainStandardHint?: string;
}

export interface FtQuoteCardData {
  assetKey: string;
  symbol: string;
  caVerified: boolean;
  quotes: FtQuoteRow[];
  suggestion?: string;
  budgetLabel?: string;
  bridgedDualChain?: boolean;
  hideUpcomingSwap?: boolean;
  icon?: string;
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
  totalValueLabel?: string;
  autoFulfill: boolean;
  chain?: FtAssetChain;
  standard?: FtAssetStandard;
  icon?: string;
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
  chain?: FtAssetChain;
  standard?: FtAssetStandard;
  totalTokenDisplay: string;
  filledOrderCount: number;
  totalPaidLabel: string;
  avgUnitPriceLabel?: string;
  feeLabel?: string;
  counterpartyName?: string;
  txids: string[];
  nextActions: FtFillNextAction[];
}

export interface FtMyOrderItem {
  id: string;
  batchGroupId?: string;
  assetKey: string;
  symbol: string;
  caVerified?: boolean;
  rail: FtCardRail;
  unitPriceLabel: string;
  lotSummaryText: string;
  filledLots: number;
  totalLots: number;
  sellTxid?: string;
  sellOutputIndex?: number;
  sellPriceSats?: number;
  sellerAddress?: string;
}

export interface FtMyOrdersCardData {
  botName?: string;
  metabotId?: number;
  totalOrdersCount: number;
  totalValuationText?: string;
  orders: FtMyOrderItem[];
}

export interface FtPortfolioHolding {
  assetKey: string;
  symbol: string;
  name?: string;
  chain: 'btc' | 'mvc';
  standard: 'idcoin' | 'mrc20' | 'mvc-ft';
  caVerified: boolean;
  totalDisplay: string;
  availableDisplay?: string;
  lockedDisplay?: string;
  usdText?: string;
  bridgedPeer?: boolean;
}

export interface FtPortfolioCardData {
  botName?: string;
  metabotId?: number;
  totalUsdText?: string;
  meBalanceText?: string;
  btcGasText?: string;
  mvcGasText?: string;
  dogeGasText?: string;
  btcHoldings: FtPortfolioHolding[];
  mvcHoldings: FtPortfolioHolding[];
}

export interface FtBridgeCardData {
  symbol: string;
  assetKey?: string;
  direction: 'mvc-to-btc' | 'btc-to-mvc';
  status: 'bridging' | 'completed' | 'paused' | 'quote';
  sendAmountDisplay: string;
  receiveAmountDisplay?: string;
  feeLabel?: string;
  stepCurrent?: 1 | 2 | 3;
  confirmationsText?: string;
  etaText?: string;
  txid?: string;
  statusNotice?: string;
  availableBalanceText?: string;
}

export interface FtActionCardData {
  action: 'issue' | 'mint' | 'transfer';
  symbol: string;
  name?: string;
  chain: FtAssetChain;
  standard: FtAssetStandard;
  assetKey: string;
  caVerified?: boolean;
  icon?: string;
  amountDisplay: string;
  decimals?: number;
  mintable?: boolean;
  receiverLabel?: string;
  receiverAddress?: string;
  genesisId?: string;
  txid: string;
  feeLabel?: string;
  costPerUnitLabel?: string;
  supplyProgressText?: string;
}

export interface FtOrderBookRow {
  rank?: number;
  orderId: string;
  rail?: FtCardRail;
  amountDisplay: string;
  unitPricePrimary: string;
  unitPriceSecondary?: string;
  totalPriceLabel: string;
  currencyUnit?: string;
  sellerAddress?: string;
  utxoOutpoint?: string;
  sellTxid?: string;
  sellOutputIndex?: number;
  sellPriceSats?: number;
}

export interface FtOrderBookCardData {
  assetKey: string;
  symbol: string;
  caVerified: boolean;
  chain?: FtAssetChain;
  standard?: FtAssetStandard;
  rail?: FtCardRail;
  icon?: string;
  totalOrdersCount?: number;
  floorPriceLabel?: string;
  floorUsdText?: string;
  holdersCount?: number;
  pageSize?: number;
  totalCurrencyUnit?: string;
  orders: FtOrderBookRow[];
}

function cleanStr(val: unknown, maxLen = 160): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function cleanSymbol(val: unknown): string {
  return cleanStr(val, 32).replace(/^\$+/, '').trim();
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

export function isFtMyOrdersCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_MY_ORDERS_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtPortfolioCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_PORTFOLIO_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtBridgeCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_BRIDGE_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtActionCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_ACTION_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isFtOrderBookCardFenceLanguage(lang: string | undefined | null): boolean {
  return FT_ORDERBOOK_FENCE_TAGS.has(normalizeFenceLang(lang));
}

export function isAnyFtSuiteFenceLanguage(lang: string | undefined | null): boolean {
  const norm = normalizeFenceLang(lang);
  return (
    FT_QUOTE_FENCE_TAGS.has(norm) ||
    FT_ORDER_FENCE_TAGS.has(norm) ||
    FT_FILL_FENCE_TAGS.has(norm) ||
    FT_MY_ORDERS_FENCE_TAGS.has(norm) ||
    FT_PORTFOLIO_FENCE_TAGS.has(norm) ||
    FT_BRIDGE_FENCE_TAGS.has(norm) ||
    FT_ACTION_FENCE_TAGS.has(norm) ||
    FT_ORDERBOOK_FENCE_TAGS.has(norm)
  );
}

/**
 * Derives canonical `{ chain, standard }` from an `assetKey` when explicit
 * fields are omitted (`mrc20:<pinId>` -> `btc / mrc20`, `mvc-ft:...` -> `mvc / mvc-ft`).
 */
export function inferFtChainAndStandard(
  assetKey?: string,
  explicitChain?: FtAssetChain,
  explicitStandard?: FtAssetStandard,
  rail?: FtCardRail,
): { chain: FtAssetChain; standard: FtAssetStandard } {
  const key = cleanStr(assetKey, 220).toLowerCase();
  if (explicitChain && VALID_CHAINS.has(explicitChain) && explicitStandard && VALID_STANDARDS.has(explicitStandard)) {
    return { chain: explicitChain, standard: explicitStandard };
  }
  if (key.startsWith('mvc-ft:')) {
    return { chain: 'mvc', standard: 'mvc-ft' };
  }
  if (key.startsWith('mrc20:')) {
    return { chain: 'btc', standard: explicitStandard === 'idcoin' ? 'idcoin' : 'mrc20' };
  }
  if (key.startsWith('native:')) {
    const ch = key.slice('native:'.length) as FtAssetChain;
    return { chain: VALID_CHAINS.has(ch) ? ch : 'mvc', standard: 'native' };
  }
  if (rail === 'mvc-tokensell' || rail === 'mvc-swap') {
    return { chain: 'mvc', standard: 'mvc-ft' };
  }
  return {
    chain: explicitChain && VALID_CHAINS.has(explicitChain) ? explicitChain : 'btc',
    standard: explicitStandard && VALID_STANDARDS.has(explicitStandard) ? explicitStandard : 'mrc20',
  };
}

/**
 * Bilingual human-friendly chain + token standard label:
 * - BTC · ID-Coin / BTC · MRC-20
 * - MVC · MetaContract (MCP02)
 */
export function formatFtChainStandardLabel(
  chain: FtAssetChain,
  standard: FtAssetStandard,
  locale: 'en' | 'zh' = 'en',
): string {
  if (standard === 'native') {
    return `${chain.toUpperCase()} · Native`;
  }
  if (chain === 'mvc' || standard === 'mvc-ft') {
    return locale === 'zh' ? 'MVC · MetaContract' : 'MVC · MetaContract';
  }
  if (standard === 'idcoin') {
    return 'BTC · ID-Coin';
  }
  return 'BTC · MRC-20';
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

/**
 * Clean English default rail label (replaces legacy "ME Instant Escrow" jargon;
 * clearly marks ME points trading without emphasizing centralization).
 */
export function formatFtRailLabel(rail: FtCardRail, locale: 'en' | 'zh' = 'en'): string {
  if (rail === 'btc-psbt') {
    return locale === 'zh' ? 'BTC · metaid.market (PSBT)' : 'BTC · metaid.market (PSBT)';
  }
  if (rail === 'mvc-tokensell') {
    return locale === 'zh' ? 'MVC · 链上合约挂单' : 'MVC · TokenSell Contract';
  }
  if (rail === 'mvc-swap') {
    return locale === 'zh' ? 'MVC · MVCSwap 闪兑' : 'MVC · MVCSwap Pool';
  }
  return locale === 'zh' ? '✦ ME 积分交易' : '✦ ME Points Trade';
}

export function parseFtQuoteCardFence(raw: string): FtQuoteCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const assetKey = cleanStr(obj.assetKey, 180);
    const symbol = cleanSymbol(obj.symbol);
    if (!assetKey || !symbol) return null;
    if (!Array.isArray(obj.quotes) || obj.quotes.length === 0) return null;

    const quotes: FtQuoteRow[] = [];
    for (const item of obj.quotes.slice(0, 6)) {
      if (!item || typeof item !== 'object') continue;
      const q = item as Record<string, unknown>;
      const rail = cleanStr(q.rail, 24) as FtCardRail;
      if (!VALID_RAILS.has(rail)) continue;
      const status = q.status === 'coming_soon' ? 'coming_soon' : 'active';
      const label = cleanStr(q.label, 64) || formatFtRailLabel(rail);
      const floorUnit = cleanStr(q.floorUnit, 64) || (status === 'coming_soon' ? '—' : '');
      const depthDisplay = cleanStr(q.depthDisplay, 48) || '0';
      if (!floorUnit) continue;
      const usdHint = cleanStr(q.usdHint, 40);
      const subMeta = cleanStr(q.subMeta, 120);
      const chainStandardHint = cleanStr(q.chainStandardHint, 48);
      quotes.push({
        rail,
        label,
        floorUnit,
        depthDisplay,
        recommended: q.recommended === true,
        ...(status === 'coming_soon' ? { status } : {}),
        ...(usdHint ? { usdHint } : {}),
        ...(subMeta ? { subMeta } : {}),
        ...(chainStandardHint ? { chainStandardHint } : {}),
      });
    }
    if (quotes.length === 0) return null;

    const suggestion = cleanStr(obj.suggestion, 240);
    const budgetLabel = cleanStr(obj.budgetLabel, 48);
    const icon = cleanStr(obj.icon, 300);
    return {
      assetKey,
      symbol,
      caVerified: obj.caVerified === true,
      quotes,
      ...(suggestion ? { suggestion } : {}),
      ...(budgetLabel ? { budgetLabel } : {}),
      ...(obj.bridgedDualChain === true ? { bridgedDualChain: true } : {}),
      ...(obj.hideUpcomingSwap === true ? { hideUpcomingSwap: true } : {}),
      ...(icon ? { icon } : {}),
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
    const symbol = cleanSymbol(obj.symbol);
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
    const totalValueLabel = cleanStr(obj.totalValueLabel, 80);
    const chainRaw = cleanStr(obj.chain, 12).toLowerCase() as FtAssetChain;
    const stdRaw = cleanStr(obj.standard, 16).toLowerCase() as FtAssetStandard;
    const icon = cleanStr(obj.icon, 300);

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
      ...(totalValueLabel ? { totalValueLabel } : {}),
      autoFulfill: obj.autoFulfill === true,
      ...(VALID_CHAINS.has(chainRaw) ? { chain: chainRaw } : {}),
      ...(VALID_STANDARDS.has(stdRaw) ? { standard: stdRaw } : {}),
      ...(icon ? { icon } : {}),
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

    const symbol = cleanSymbol(obj.symbol);
    const totalTokenDisplay = cleanStr(obj.totalTokenDisplay, 64);
    const totalPaidLabel = cleanStr(obj.totalPaidLabel, 96);
    const filledOrderCount = Math.max(1, Math.min(500, Math.floor(Number(obj.filledOrderCount ?? 1))));
    if (!symbol || !totalTokenDisplay || !totalPaidLabel) return null;

    const avgUnitPriceLabel = cleanStr(obj.avgUnitPriceLabel, 80);
    const feeLabel = cleanStr(obj.feeLabel, 80);
    const counterpartyName = cleanStr(obj.counterpartyName, 48);
    const assetKey = cleanStr(obj.assetKey, 180);
    const railRaw = cleanStr(obj.rail, 24) as FtCardRail;
    const chainRaw = cleanStr(obj.chain, 12).toLowerCase() as FtAssetChain;
    const stdRaw = cleanStr(obj.standard, 16).toLowerCase() as FtAssetStandard;
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
      ...(VALID_CHAINS.has(chainRaw) ? { chain: chainRaw } : {}),
      ...(VALID_STANDARDS.has(stdRaw) ? { standard: stdRaw } : {}),
      totalTokenDisplay,
      filledOrderCount,
      totalPaidLabel,
      ...(avgUnitPriceLabel ? { avgUnitPriceLabel } : {}),
      ...(feeLabel ? { feeLabel } : {}),
      ...(counterpartyName ? { counterpartyName } : {}),
      txids,
      nextActions,
    };
  } catch {
    return null;
  }
}

export function parseFtMyOrdersCardFence(raw: string): FtMyOrdersCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (!Array.isArray(obj.orders)) return null;

    const orders: FtMyOrderItem[] = [];
    for (const item of obj.orders.slice(0, 30)) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const id = cleanStr(r.id, 120) || cleanStr(r.batchGroupId, 120);
      const assetKey = cleanStr(r.assetKey, 180);
      const symbol = cleanSymbol(r.symbol);
      const rail = cleanStr(r.rail, 24) as FtCardRail;
      const unitPriceLabel = cleanStr(r.unitPriceLabel, 80);
      const lotSummaryText = cleanStr(r.lotSummaryText, 96);
      const totalLots = Math.max(1, Math.min(500, Math.floor(Number(r.totalLots ?? 1))));
      const filledLots = Math.max(0, Math.min(totalLots, Math.floor(Number(r.filledLots ?? 0))));
      if (!id || !assetKey || !symbol || !VALID_RAILS.has(rail) || !unitPriceLabel) continue;
      const batchGroupId = cleanStr(r.batchGroupId, 96);
      const sellTxid = cleanStr(r.sellTxid, 80);
      const sellerAddress = cleanStr(r.sellerAddress, 80);
      orders.push({
        id,
        ...(batchGroupId ? { batchGroupId } : {}),
        assetKey,
        symbol,
        ...(typeof r.caVerified === 'boolean' ? { caVerified: r.caVerified } : {}),
        rail,
        unitPriceLabel,
        lotSummaryText: lotSummaryText || `${totalLots - filledLots}/${totalLots}`,
        filledLots,
        totalLots,
        ...(sellTxid ? { sellTxid } : {}),
        ...(typeof r.sellOutputIndex === 'number' ? { sellOutputIndex: Math.floor(r.sellOutputIndex) } : {}),
        ...(typeof r.sellPriceSats === 'number' ? { sellPriceSats: Math.floor(r.sellPriceSats) } : {}),
        ...(sellerAddress ? { sellerAddress } : {}),
      });
    }

    const botName = cleanStr(obj.botName, 48);
    const totalValuationText = cleanStr(obj.totalValuationText, 64);
    const totalOrdersCount = Math.max(
      orders.length,
      Math.max(0, Math.floor(Number(obj.totalOrdersCount ?? orders.length))),
    );
    const metabotId =
      typeof obj.metabotId === 'number' && Number.isInteger(obj.metabotId) && obj.metabotId > 0
        ? obj.metabotId
        : undefined;

    return {
      ...(botName ? { botName } : {}),
      ...(metabotId !== undefined ? { metabotId } : {}),
      totalOrdersCount,
      ...(totalValuationText ? { totalValuationText } : {}),
      orders,
    };
  } catch {
    return null;
  }
}

function parsePortfolioHoldings(rawList: unknown, expectedChain: 'btc' | 'mvc'): FtPortfolioHolding[] {
  if (!Array.isArray(rawList)) return [];
  const rows: FtPortfolioHolding[] = [];
  for (const item of rawList.slice(0, 30)) {
    if (!item || typeof item !== 'object') continue;
    const h = item as Record<string, unknown>;
    const assetKey = cleanStr(h.assetKey, 180);
    const symbol = cleanSymbol(h.symbol);
    const totalDisplay = cleanStr(h.totalDisplay, 64);
    if (!assetKey || !symbol || !totalDisplay) continue;
    const stdRaw = cleanStr(h.standard, 16).toLowerCase();
    const standard: 'idcoin' | 'mrc20' | 'mvc-ft' =
      expectedChain === 'mvc'
        ? 'mvc-ft'
        : stdRaw === 'idcoin'
          ? 'idcoin'
          : 'mrc20';
    const name = cleanStr(h.name, 48);
    const availableDisplay = cleanStr(h.availableDisplay, 64);
    const lockedDisplay = cleanStr(h.lockedDisplay, 64);
    const usdText = cleanStr(h.usdText, 40);
    rows.push({
      assetKey,
      symbol,
      ...(name ? { name } : {}),
      chain: expectedChain,
      standard,
      caVerified: h.caVerified === true,
      totalDisplay,
      ...(availableDisplay ? { availableDisplay } : {}),
      ...(lockedDisplay ? { lockedDisplay } : {}),
      ...(usdText ? { usdText } : {}),
      ...(h.bridgedPeer === true ? { bridgedPeer: true } : {}),
    });
  }
  return rows;
}

export function parseFtPortfolioCardFence(raw: string): FtPortfolioCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    if (!Array.isArray(obj.btcHoldings) && !Array.isArray(obj.mvcHoldings)) return null;

    const btcHoldings = parsePortfolioHoldings(obj.btcHoldings, 'btc');
    const mvcHoldings = parsePortfolioHoldings(obj.mvcHoldings, 'mvc');
    const botName = cleanStr(obj.botName, 48);
    const totalUsdText = cleanStr(obj.totalUsdText, 48);
    const meBalanceText = cleanStr(obj.meBalanceText, 48);
    const btcGasText = cleanStr(obj.btcGasText, 48);
    const mvcGasText = cleanStr(obj.mvcGasText, 48);
    const dogeGasText = cleanStr(obj.dogeGasText, 48);
    const metabotId =
      typeof obj.metabotId === 'number' && Number.isInteger(obj.metabotId) && obj.metabotId > 0
        ? obj.metabotId
        : undefined;

    return {
      ...(botName ? { botName } : {}),
      ...(metabotId !== undefined ? { metabotId } : {}),
      ...(totalUsdText ? { totalUsdText } : {}),
      ...(meBalanceText ? { meBalanceText } : {}),
      ...(btcGasText ? { btcGasText } : {}),
      ...(mvcGasText ? { mvcGasText } : {}),
      ...(dogeGasText ? { dogeGasText } : {}),
      btcHoldings,
      mvcHoldings,
    };
  } catch {
    return null;
  }
}

export function parseFtBridgeCardFence(raw: string): FtBridgeCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const symbol = cleanSymbol(obj.symbol);
    const dirRaw = cleanStr(obj.direction, 24).toLowerCase();
    const statusRaw = cleanStr(obj.status, 24).toLowerCase();
    const sendAmountDisplay = cleanStr(obj.sendAmountDisplay, 64);
    if (!symbol || !sendAmountDisplay) return null;
    if (dirRaw !== 'mvc-to-btc' && dirRaw !== 'btc-to-mvc') return null;
    if (
      statusRaw !== 'bridging' &&
      statusRaw !== 'completed' &&
      statusRaw !== 'paused' &&
      statusRaw !== 'quote'
    ) {
      return null;
    }
    const stepNum = Number(obj.stepCurrent);
    const stepCurrent: 1 | 2 | 3 | undefined =
      stepNum === 1 || stepNum === 2 || stepNum === 3 ? stepNum : undefined;

    const assetKey = cleanStr(obj.assetKey, 180);
    const receiveAmountDisplay = cleanStr(obj.receiveAmountDisplay, 64);
    const feeLabel = cleanStr(obj.feeLabel, 64);
    const confirmationsText = cleanStr(obj.confirmationsText, 64);
    const etaText = cleanStr(obj.etaText, 64);
    const txid = cleanStr(obj.txid, 100);
    const statusNotice = cleanStr(obj.statusNotice, 260);
    const availableBalanceText = cleanStr(obj.availableBalanceText, 64);

    return {
      symbol,
      ...(assetKey ? { assetKey } : {}),
      direction: dirRaw,
      status: statusRaw,
      sendAmountDisplay,
      ...(receiveAmountDisplay ? { receiveAmountDisplay } : {}),
      ...(feeLabel ? { feeLabel } : {}),
      ...(stepCurrent ? { stepCurrent } : {}),
      ...(confirmationsText ? { confirmationsText } : {}),
      ...(etaText ? { etaText } : {}),
      ...(txid ? { txid } : {}),
      ...(statusNotice ? { statusNotice } : {}),
      ...(availableBalanceText ? { availableBalanceText } : {}),
    };
  } catch {
    return null;
  }
}

export function parseFtActionCardFence(raw: string): FtActionCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const actionRaw = cleanStr(obj.action, 16).toLowerCase();
    if (actionRaw !== 'issue' && actionRaw !== 'mint' && actionRaw !== 'transfer') return null;
    const symbol = cleanSymbol(obj.symbol);
    const assetKey = cleanStr(obj.assetKey, 180);
    const amountDisplay = cleanStr(obj.amountDisplay, 64);
    const txid = cleanStr(obj.txid, 100);
    if (!symbol || !amountDisplay || !txid) return null;

    const chainRaw = cleanStr(obj.chain, 12).toLowerCase() as FtAssetChain;
    const stdRaw = cleanStr(obj.standard, 16).toLowerCase() as FtAssetStandard;
    const { chain, standard } = inferFtChainAndStandard(assetKey || undefined, chainRaw, stdRaw);

    const name = cleanStr(obj.name, 64);
    const icon = cleanStr(obj.icon, 300);
    const receiverLabel = cleanStr(obj.receiverLabel, 64);
    const receiverAddress = cleanStr(obj.receiverAddress, 80);
    const genesisId = cleanStr(obj.genesisId, 100);
    const feeLabel = cleanStr(obj.feeLabel, 80);
    const costPerUnitLabel = cleanStr(obj.costPerUnitLabel, 64);
    const supplyProgressText = cleanStr(obj.supplyProgressText, 64);
    const decimals =
      typeof obj.decimals === 'number' && Number.isInteger(obj.decimals) && obj.decimals >= 0
        ? obj.decimals
        : undefined;

    return {
      action: actionRaw,
      symbol,
      ...(name ? { name } : {}),
      chain,
      standard,
      assetKey,
      ...(typeof obj.caVerified === 'boolean' ? { caVerified: obj.caVerified } : {}),
      ...(icon ? { icon } : {}),
      amountDisplay,
      ...(decimals !== undefined ? { decimals } : {}),
      ...(typeof obj.mintable === 'boolean' ? { mintable: obj.mintable } : {}),
      ...(receiverLabel ? { receiverLabel } : {}),
      ...(receiverAddress ? { receiverAddress } : {}),
      ...(genesisId ? { genesisId } : {}),
      txid,
      ...(feeLabel ? { feeLabel } : {}),
      ...(costPerUnitLabel ? { costPerUnitLabel } : {}),
      ...(supplyProgressText ? { supplyProgressText } : {}),
    };
  } catch {
    return null;
  }
}

export function parseFtOrderBookCardFence(raw: string): FtOrderBookCardData | null {
  try {
    const obj = JSON.parse(String(raw ?? '').trim()) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const assetKey = cleanStr(obj.assetKey, 180);
    const symbol = cleanSymbol(obj.symbol);
    if (!assetKey || !symbol || !Array.isArray(obj.orders)) return null;

    const orders: FtOrderBookRow[] = [];
    for (let i = 0; i < Math.min(obj.orders.length, 60); i += 1) {
      const item = obj.orders[i];
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const orderId = cleanStr(r.orderId ?? r.id, 140) || `order_${i + 1}`;
      const amountDisplay = cleanStr(r.amountDisplay ?? r.qty, 64);
      const unitPricePrimary = cleanStr(r.unitPricePrimary ?? r.unitPriceLabel, 80);
      const totalPriceLabel = cleanStr(r.totalPriceLabel, 80);
      if (!amountDisplay || !unitPricePrimary || !totalPriceLabel) continue;

      const railRaw = cleanStr(r.rail, 24) as FtCardRail;
      const unitPriceSecondary = cleanStr(r.unitPriceSecondary, 64);
      const currencyUnit = cleanStr(r.currencyUnit, 16);
      const sellerAddress = cleanStr(r.sellerAddress, 80);
      const utxoOutpoint = cleanStr(r.utxoOutpoint, 96);
      const sellTxid = cleanStr(r.sellTxid, 80);
      const rankNum = Number(r.rank);

      orders.push({
        ...(Number.isInteger(rankNum) && rankNum > 0 ? { rank: rankNum } : { rank: orders.length + 1 }),
        orderId,
        ...(VALID_RAILS.has(railRaw) ? { rail: railRaw } : {}),
        amountDisplay,
        unitPricePrimary,
        ...(unitPriceSecondary ? { unitPriceSecondary } : {}),
        totalPriceLabel,
        ...(currencyUnit ? { currencyUnit } : {}),
        ...(sellerAddress ? { sellerAddress } : {}),
        ...(utxoOutpoint ? { utxoOutpoint } : {}),
        ...(sellTxid ? { sellTxid } : {}),
        ...(typeof r.sellOutputIndex === 'number' && Number.isFinite(r.sellOutputIndex)
          ? { sellOutputIndex: Math.floor(r.sellOutputIndex) }
          : {}),
        ...(typeof r.sellPriceSats === 'number' && Number.isFinite(r.sellPriceSats)
          ? { sellPriceSats: Math.floor(r.sellPriceSats) }
          : {}),
      });
    }

    const chainRaw = cleanStr(obj.chain, 12).toLowerCase() as FtAssetChain;
    const stdRaw = cleanStr(obj.standard, 16).toLowerCase() as FtAssetStandard;
    const railRaw = cleanStr(obj.rail, 24) as FtCardRail;
    const icon = cleanStr(obj.icon, 300);
    const floorPriceLabel = cleanStr(obj.floorPriceLabel, 64);
    const floorUsdText = cleanStr(obj.floorUsdText, 48);
    const totalCurrencyUnit = cleanStr(obj.totalCurrencyUnit, 16);
    const totalOrdersCountRaw = Number(obj.totalOrdersCount);
    const totalOrdersCount =
      Number.isFinite(totalOrdersCountRaw) && totalOrdersCountRaw >= 0
        ? Math.max(orders.length, Math.floor(totalOrdersCountRaw))
        : orders.length;
    const holdersCountRaw = Number(obj.holdersCount);
    const holdersCount =
      Number.isFinite(holdersCountRaw) && holdersCountRaw > 0
        ? Math.floor(holdersCountRaw)
        : undefined;
    const pageSizeRaw = Number(obj.pageSize);
    const pageSize =
      Number.isInteger(pageSizeRaw) && pageSizeRaw >= 1 && pageSizeRaw <= 10
        ? pageSizeRaw
        : 6;

    return {
      assetKey,
      symbol,
      caVerified: obj.caVerified === true,
      ...(VALID_CHAINS.has(chainRaw) ? { chain: chainRaw } : {}),
      ...(VALID_STANDARDS.has(stdRaw) ? { standard: stdRaw } : {}),
      ...(VALID_RAILS.has(railRaw) ? { rail: railRaw } : {}),
      ...(icon ? { icon } : {}),
      totalOrdersCount,
      ...(floorPriceLabel ? { floorPriceLabel } : {}),
      ...(floorUsdText ? { floorUsdText } : {}),
      ...(holdersCount !== undefined ? { holdersCount } : {}),
      pageSize,
      ...(totalCurrencyUnit ? { totalCurrencyUnit } : {}),
      orders,
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

export function formatFtMyOrdersCardFence(data: FtMyOrdersCardData): string {
  return `\`\`\`${FT_MY_ORDERS_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtPortfolioCardFence(data: FtPortfolioCardData): string {
  return `\`\`\`${FT_PORTFOLIO_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtBridgeCardFence(data: FtBridgeCardData): string {
  return `\`\`\`${FT_BRIDGE_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtActionCardFence(data: FtActionCardData): string {
  return `\`\`\`${FT_ACTION_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

export function formatFtOrderBookCardFence(data: FtOrderBookCardData): string {
  return `\`\`\`${FT_ORDERBOOK_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}
