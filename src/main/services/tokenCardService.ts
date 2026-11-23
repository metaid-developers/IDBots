import Decimal from 'decimal.js';
import type { Mrc20Asset } from './mrc20Service';
import type { MvcFtIssuanceRecord } from './mvcFtIssueService';
import type { MvcFtTokenBalance } from './mvcTokenSellService';
import type { WalletBalanceQueryResult, WalletQueryChain } from './walletQueryService';
import {
  deriveChangeDir,
  sanitizeTokenIconUrl,
  serializeTokenCardFence,
  type TokenCardChain,
  type TokenCardData,
  type TokenCardMode,
  type TokenCardStandard,
} from '../../renderer/components/chat/tokenCardSyntax';
import {
  formatFtQuoteCardFence,
  type FtCardRail,
  type FtMyOrderItem,
  type FtQuoteCardData,
  type FtQuoteRow,
} from '../../renderer/components/chat/ftCardSyntax';

const METAID_MARKET_BASE = 'https://api.metaid.market/api-market';
const METALET_HOST = 'https://www.metalet.space';
const METASO_DEFAULT_BASE = 'https://so.metaid.io';
const SATOSHI_PER_COIN = 100_000_000;
const DEFAULT_HTTP_TIMEOUT_MS = 4_500;

export interface TokenCardMetabotSummary {
  id: number;
  name: string;
  globalMetaId?: string;
  mvcAddress?: string;
  btcAddress?: string;
  dogeAddress?: string;
}

export interface BuildTokenCardInput {
  /** Ticker (`"$METAID"`, `"METAID"`, `"BTC"`, `"SPACE"`), `assetKey` (`"mrc20:..."`, `"mvc-ft:..."`), or `mrc20Id` (`"<64hex>i0"`). */
  query: string;
  /** `'simple'` for quick price + Bot balance check; `'detailed'` for full market overview. */
  mode?: TokenCardMode;
  /** Optional chain hint when disambiguating identical tickers across BTC and MVC. */
  chain?: TokenCardChain;
  /** Active session MetaBot ID whose wallet balance should be displayed on the card. */
  metabotId?: number;
}

export interface TokenCardServiceDeps {
  getBalances?: (input: {
    metabotIds?: number[];
    chains?: WalletQueryChain[];
  }) => Promise<WalletBalanceQueryResult>;
  listMrc20s?: (input: {
    metabotIds?: number[];
    address?: string;
  }) => Promise<Array<{
    metabotId: number | null;
    address: string;
    assets?: Mrc20Asset[];
    error?: string;
  }>>;
  listMvcFtTokens?: (input: {
    metabotIds?: number[];
    address?: string;
  }) => Promise<Array<{
    metabotId: number | null;
    address: string;
    balance?: MvcFtTokenBalance;
    error?: string;
  }>>;
  listIssuedTokens?: (filter?: {
    metabotId?: number;
    assetKey?: string;
    sensibleId?: string;
    symbol?: string;
    limit?: number;
  }) => MvcFtIssuanceRecord[];
  getMetabotSummary?: (metabotId: number) => TokenCardMetabotSummary | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  httpTimeoutMs?: number;
  metasoApiBase?: string;
}

export interface BuildTokenCardResult {
  card: TokenCardData;
  fence: string;
  summaryText: string;
}

interface CoinSpotPrices {
  btcUsd?: number;
  spaceUsd?: number;
  dogeUsd?: number;
}

interface MetaidMarketRawInfo {
  kind: 'idcoin' | 'mrc20';
  tick: string;
  tokenName?: string;
  mrc20Id: string;
  decimals: number;
  mintable?: boolean;
  holders?: number;
  followersCount?: number;
  txCount?: number;
  supply?: string;
  totalSupply?: string;
  amtPerMint?: string;
  mintCount?: string;
  totalMinted?: string;
  marketPriceSats?: number;
  marketPriceUsd?: number;
  floorPriceSats?: number;
  floorPriceUsd?: number;
  change24h?: string;
  marketCapSats?: number;
  marketCapUsd?: number;
  totalVolumeSats?: number;
  icon?: string;
}

interface MetaletMrc20PriceEntry {
  mrc20Id: string;
  symbol: string;
  usdPrice: number;
}

function normalizeQuery(raw: string): string {
  return String(raw ?? '').trim();
}

function normalizeTicker(raw: string): string {
  return raw.trim().replace(/^\$+/, '').trim().toUpperCase();
}

function parseFiniteNum(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(/,/g, '');
    if (!cleaned) return undefined;
    const n = Number(cleaned);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function formatWithCommas(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function formatTokenAmountDisplay(raw: string | number, maxFracDigits = 4): string {
  try {
    const dec = new Decimal(String(raw ?? '0').trim() || '0');
    if (!dec.isFinite() || dec.eq(0)) return '0';
    const abs = dec.abs();
    if (abs.gte(1_000_000_000)) {
      return `${dec.div(1_000_000_000).toDecimalPlaces(2).toString()}B`;
    }
    const fixed = dec.toDecimalPlaces(maxFracDigits).toFixed();
    const [intPart, fracPart] = fixed.split('.');
    const formattedInt = formatWithCommas(intPart);
    if (!fracPart) return formattedInt;
    const trimmedFrac = fracPart.replace(/0+$/, '');
    return trimmedFrac ? `${formattedInt}.${trimmedFrac}` : formattedInt;
  } catch {
    return String(raw ?? '0');
  }
}

export function formatUsdPrice(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd < 0) return undefined;
  if (usd === 0) return '$0.00';
  if (usd >= 1000) {
    const [i, f] = usd.toFixed(2).split('.');
    return `$${formatWithCommas(i)}.${f}`;
  }
  if (usd >= 1) return `$${usd.toFixed(3).replace(/0$/, '')}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd >= 0.0001) return `$${usd.toFixed(4)}`;
  return `$${usd.toPrecision(2)}`;
}

export function formatUsdValuation(usd: number | undefined): string | undefined {
  if (usd === undefined || !Number.isFinite(usd) || usd <= 0) return undefined;
  if (usd >= 1_000_000) {
    return `≈ $${(usd / 1_000_000).toFixed(2)}M`;
  }
  if (usd >= 1) {
    const [i, f] = usd.toFixed(2).split('.');
    return `≈ $${formatWithCommas(i)}.${f}`;
  }
  if (usd >= 0.01) return `≈ $${usd.toFixed(2)}`;
  return `≈ $${usd.toPrecision(2)}`;
}

function formatBtcFromSats(sats: number, compact = false): string {
  const btc = sats / SATOSHI_PER_COIN;
  if (!Number.isFinite(btc) || btc <= 0) return '0 BTC';
  if (compact) {
    if (btc >= 1000) {
      const [i, f] = btc.toFixed(1).split('.');
      return `${formatWithCommas(i)}${f && f !== '0' ? `.${f}` : ''} BTC`;
    }
    if (btc >= 10) return `${btc.toFixed(2).replace(/\.?0+$/, '')} BTC`;
    if (btc >= 0.01) return `${btc.toFixed(3).replace(/\.?0+$/, '')} BTC`;
    return `${btc.toFixed(6).replace(/\.?0+$/, '')} BTC`;
  }
  return `${btc.toFixed(8).replace(/\.?0+$/, '')} BTC`;
}

function formatSatsHeadline(sats: number): { main: string; unit: string } {
  if (sats >= 1) {
    const rounded = sats >= 100 ? Math.round(sats) : Number(sats.toFixed(2));
    const [intPart, fracPart] = String(rounded).split('.');
    const formatted = fracPart ? `${formatWithCommas(intPart)}.${fracPart}` : formatWithCommas(intPart);
    return { main: formatted, unit: 'sat' };
  }
  return { main: sats.toPrecision(3), unit: 'sat' };
}

function normalizeChange24h(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const str = String(raw).trim();
  if (!str) return undefined;
  const num = Number(str.replace(/[+%\s,]/g, ''));
  if (!Number.isFinite(num)) return undefined;
  if (Math.abs(num) < 0.005) return '0.00%';
  const sign = num > 0 ? '+' : '';
  return `${sign}${num.toFixed(2)}%`;
}

async function fetchJsonWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (!text || text.trimStart().startsWith('<')) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchCoinSpotPrices(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<CoinSpotPrices> {
  const json = await fetchJsonWithTimeout<{
    code?: number;
    data?: Record<string, unknown>;
  }>(
    fetchImpl,
    `${METALET_HOST}/wallet-api/v3/coin/price?net=livenet`,
    timeoutMs,
  );
  const rawData = json?.data;
  const info =
    rawData && typeof rawData.priceInfo === 'object' && rawData.priceInfo
      ? (rawData.priceInfo as Record<string, unknown>)
      : rawData && typeof rawData.coinPrice === 'object' && rawData.coinPrice
        ? (rawData.coinPrice as Record<string, unknown>)
        : (rawData ?? {});
  return {
    btcUsd: parseFiniteNum(info.btc ?? info.BTC),
    spaceUsd: parseFiniteNum(info.space ?? info.SPACE ?? info.mvc ?? info.MVC),
    dogeUsd: parseFiniteNum(info.doge ?? info.DOGE),
  };
}

async function fetchMetaletMrc20PriceMap(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<MetaletMrc20PriceEntry[]> {
  const json = await fetchJsonWithTimeout<{
    code?: number;
    data?: Record<string, unknown>;
  }>(
    fetchImpl,
    `${METALET_HOST}/wallet-api/v3/coin/mrc20/price?net=livenet`,
    timeoutMs,
  );
  const rawData = json?.data;
  const info =
    rawData && typeof rawData.priceInfo === 'object' && rawData.priceInfo
      ? (rawData.priceInfo as Record<string, unknown>)
      : rawData;
  if (!info || typeof info !== 'object') return [];
  const entries: MetaletMrc20PriceEntry[] = [];
  for (const [key, val] of Object.entries(info)) {
    const slashIdx = key.indexOf('/');
    if (slashIdx <= 0) continue;
    const mrc20Id = key.slice(0, slashIdx).trim();
    const symbol = key.slice(slashIdx + 1).trim().toUpperCase();
    const usdPrice = parseFiniteNum(val) ?? 0;
    if (mrc20Id && symbol) {
      entries.push({ mrc20Id, symbol, usdPrice });
    }
  }
  return entries;
}

async function fetchMetaletMvcFtPriceMap(
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, number>> {
  const json = await fetchJsonWithTimeout<{
    code?: number;
    data?: Record<string, unknown>;
  }>(
    fetchImpl,
    `${METALET_HOST}/wallet-api/v3/coin/contract/ft/price?net=livenet`,
    timeoutMs,
  );
  const rawData = json?.data;
  const info =
    rawData && typeof rawData.priceInfo === 'object' && rawData.priceInfo
      ? (rawData.priceInfo as Record<string, unknown>)
      : rawData && typeof rawData.contractFtPrice === 'object' && rawData.contractFtPrice
        ? (rawData.contractFtPrice as Record<string, unknown>)
        : rawData;
  const out: Record<string, number> = {};
  if (!info || typeof info !== 'object') return out;
  for (const [k, v] of Object.entries(info)) {
    const n = parseFiniteNum(v);
    if (n !== undefined && n > 0) {
      out[k.trim().toUpperCase()] = n;
    }
  }
  return out;
}

async function fetchMetaidMarketToken(
  fetchImpl: typeof fetch,
  params: { tick?: string; tickId?: string },
  timeoutMs: number,
): Promise<MetaidMarketRawInfo | null> {
  const qs = new URLSearchParams();
  if (params.tick) qs.set('tick', params.tick.toUpperCase());
  if (params.tickId) qs.set('tickId', params.tickId);

  const [idCoinJson, mrc20Json] = await Promise.all([
    fetchJsonWithTimeout<{ code?: number; data?: Record<string, unknown> }>(
      fetchImpl,
      `${METAID_MARKET_BASE}/api/v1/id-coins/coins-info?${qs.toString()}`,
      timeoutMs,
    ),
    fetchJsonWithTimeout<{ code?: number; data?: Record<string, unknown> }>(
      fetchImpl,
      `${METAID_MARKET_BASE}/api/v1/common/mrc20/tick/info?${qs.toString()}`,
      timeoutMs,
    ),
  ]);

  const unwrapItem = (raw: Record<string, unknown> | undefined): Record<string, unknown> | null => {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.mrc20Id === 'string' && raw.mrc20Id.trim()) return raw;
    if (Array.isArray(raw.list)) {
      const list = raw.list.filter(
        (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === 'object'),
      );
      if (params.tickId) {
        const byId = list.find(
          (entry) => String(entry.mrc20Id || '').trim().toLowerCase() === params.tickId!.toLowerCase(),
        );
        if (byId) return byId;
      }
      if (params.tick) {
        const target = params.tick.toUpperCase();
        const byTick = list.find(
          (entry) => String(entry.tick || '').trim().toUpperCase() === target,
        );
        if (byTick) return byTick;
      }
      if (list[0] && typeof list[0].mrc20Id === 'string' && list[0].mrc20Id.trim()) {
        return list[0];
      }
    }
    return null;
  };

  const idData = idCoinJson?.code === 0 ? unwrapItem(idCoinJson.data) : null;
  const mrcData = mrc20Json?.code === 0 ? unwrapItem(mrc20Json.data) : null;
  const chosen = idData ?? mrcData;
  if (!chosen) return null;

  const kind: 'idcoin' | 'mrc20' = idData ? 'idcoin' : 'mrc20';
  const deployerUser =
    chosen.deployerUserInfo && typeof chosen.deployerUserInfo === 'object'
      ? (chosen.deployerUserInfo as Record<string, unknown>)
      : null;

  let metaIcon: string | undefined;
  if (typeof chosen.metaData === 'string' && chosen.metaData.trim().startsWith('{')) {
    try {
      const parsedMeta = JSON.parse(chosen.metaData) as Record<string, unknown>;
      metaIcon = sanitizeTokenIconUrl(parsedMeta.icon);
    } catch {
      // Ignore malformed metadata JSON
    }
  }
  const avatarIcon = deployerUser ? sanitizeTokenIconUrl(deployerUser.avatar) : undefined;

  const rawPriceSats =
    parseFiniteNum(chosen.marketPrice) ??
    (kind === 'mrc20' ? parseFiniteNum(chosen.price) : undefined);

  return {
    kind,
    tick: String(chosen.tick || params.tick || '').trim().toUpperCase(),
    tokenName: String(chosen.tokenName || deployerUser?.name || '').trim() || undefined,
    mrc20Id: String(chosen.mrc20Id || '').trim(),
    decimals: Number.isInteger(Number(chosen.decimals)) ? Number(chosen.decimals) : 8,
    mintable: typeof chosen.mintable === 'boolean' ? chosen.mintable : undefined,
    holders: parseFiniteNum(chosen.holders),
    followersCount: parseFiniteNum(chosen.followersCount),
    txCount: parseFiniteNum(chosen.txCount),
    supply: chosen.supply != null ? String(chosen.supply) : undefined,
    totalSupply: chosen.totalSupply != null ? String(chosen.totalSupply) : undefined,
    amtPerMint: chosen.amtPerMint != null ? String(chosen.amtPerMint) : undefined,
    mintCount: chosen.mintCount != null ? String(chosen.mintCount) : undefined,
    totalMinted: chosen.totalMinted != null ? String(chosen.totalMinted) : undefined,
    marketPriceSats: rawPriceSats && rawPriceSats > 0 ? rawPriceSats : undefined,
    marketPriceUsd: parseFiniteNum(chosen.marketPriceUsd ?? chosen.priceUsd),
    floorPriceSats: parseFiniteNum(chosen.floorPrice),
    floorPriceUsd: parseFiniteNum(chosen.floorPriceUsd),
    change24h: normalizeChange24h(chosen.change24h),
    marketCapSats: parseFiniteNum(chosen.marketCap),
    marketCapUsd: parseFiniteNum(chosen.marketCapUsd),
    totalVolumeSats: parseFiniteNum(chosen.totalVolume),
    icon: metaIcon ?? avatarIcon,
  };
}

async function fetchMetaletMrc20TickInfo(
  fetchImpl: typeof fetch,
  params: { tick?: string; tickId?: string },
  timeoutMs: number,
): Promise<Partial<MetaidMarketRawInfo> | null> {
  const qs = new URLSearchParams({ net: 'livenet' });
  if (params.tickId) qs.set('tickId', params.tickId);
  else if (params.tick) qs.set('tick', params.tick.toUpperCase());
  else return null;

  const json = await fetchJsonWithTimeout<{
    code?: number;
    data?: Record<string, unknown>;
  }>(
    fetchImpl,
    `${METALET_HOST}/wallet-api/v3/mrc20/tick/info?${qs.toString()}`,
    timeoutMs,
  );
  const d = json?.data;
  if (!d || !d.mrc20Id || !String(d.mrc20Id).trim()) return null;

  let metaIcon: string | undefined;
  if (typeof d.metaData === 'string' && d.metaData.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(d.metaData) as Record<string, unknown>;
      metaIcon = sanitizeTokenIconUrl(parsed.icon);
    } catch {
      // Ignore
    }
  }
  const hasIdCoinFollowers =
    d.qual && typeof d.qual === 'object' && String((d.qual as Record<string, unknown>).path || '').includes('/follow');

  return {
    kind: hasIdCoinFollowers ? 'idcoin' : 'mrc20',
    tick: String(d.tick || params.tick || '').trim().toUpperCase(),
    tokenName: String(d.tokenName || '').trim() || undefined,
    mrc20Id: String(d.mrc20Id).trim(),
    decimals: Number.isInteger(Number(d.decimals)) ? Number(d.decimals) : 8,
    mintable: typeof d.mintable === 'boolean' ? d.mintable : undefined,
    holders: parseFiniteNum(d.holders),
    txCount: parseFiniteNum(d.txCount),
    supply: d.supply != null && String(d.supply) !== '0' ? String(d.supply) : undefined,
    totalSupply: d.totalSupply != null && String(d.totalSupply) !== '0' ? String(d.totalSupply) : undefined,
    amtPerMint: d.amtPerMint != null ? String(d.amtPerMint) : undefined,
    mintCount: d.mintCount != null ? String(d.mintCount) : undefined,
    totalMinted: d.totalMinted != null ? String(d.totalMinted) : undefined,
    icon: metaIcon,
  };
}

interface MetasoFtSummary {
  assetKey?: string;
  symbol?: string;
  caVerified?: boolean;
  floorSats?: number;
  priceUsd?: number;
}

async function fetchMetasoFtVerification(
  fetchImpl: typeof fetch,
  metasoBase: string,
  assetKey: string,
  symbol: string,
  timeoutMs: number,
): Promise<MetasoFtSummary | null> {
  const summary = await fetchJsonWithTimeout<{
    code?: number;
    data?: Record<string, unknown>;
  }>(
    fetchImpl,
    `${metasoBase.replace(/\/+$/, '')}/api/ft/market/token/${encodeURIComponent(assetKey)}/summary`,
    timeoutMs,
  );
  if (summary?.data && typeof summary.data === 'object') {
    const d = summary.data;
    return {
      assetKey,
      symbol: typeof d.symbol === 'string' ? d.symbol : symbol,
      caVerified: d.caVerified === true,
      floorSats: parseFiniteNum(d.floorSats ?? d.floorPriceSats),
      priceUsd: parseFiniteNum(d.priceUsd),
    };
  }
  return null;
}

function computeSupplyDisplay(info: Partial<MetaidMarketRawInfo>): {
  supplyMain?: string;
  mintProgressPct?: number;
  mintable?: boolean;
} {
  let mintedNum = parseFiniteNum(info.supply);
  let maxNum = parseFiniteNum(info.totalSupply);

  const amtPerMint = parseFiniteNum(info.amtPerMint);
  const mintCount = parseFiniteNum(info.mintCount);
  const totalMinted = parseFiniteNum(info.totalMinted);

  if ((mintedNum === undefined || mintedNum <= 0) && amtPerMint && totalMinted !== undefined) {
    mintedNum = amtPerMint * totalMinted;
  }
  if ((maxNum === undefined || maxNum <= 0) && amtPerMint && mintCount) {
    maxNum = amtPerMint * mintCount;
  }

  if (mintedNum === undefined && maxNum === undefined) {
    return { mintable: info.mintable };
  }

  const mintable = info.mintable;
  if (mintedNum !== undefined && maxNum !== undefined && maxNum > 0) {
    const pct = Math.max(0, Math.min(100, (mintedNum / maxNum) * 100));
    if (mintable && pct < 99.95) {
      return {
        supplyMain: `${formatTokenAmountDisplay(mintedNum, 2)} / ${formatTokenAmountDisplay(maxNum, 2)}`,
        mintProgressPct: Number(pct.toFixed(1)),
        mintable: true,
      };
    }
    return {
      supplyMain: formatTokenAmountDisplay(maxNum, 2),
      mintProgressPct: Number(pct.toFixed(1)),
      mintable: mintable ?? pct < 99.95,
    };
  }

  const single = mintedNum ?? maxNum ?? 0;
  return {
    supplyMain: single > 0 ? formatTokenAmountDisplay(single, 2) : undefined,
    mintable,
  };
}

function resolveNativeChainFromSymbol(
  ticker: string,
  chainHint?: TokenCardChain,
): { chain: TokenCardChain; symbol: string; name: string } | null {
  if (ticker === 'BTC' || ticker === 'BITCOIN') {
    return { chain: 'btc', symbol: 'BTC', name: 'Bitcoin' };
  }
  if (ticker === 'SPACE' || ticker === 'MVC') {
    return { chain: 'mvc', symbol: 'SPACE', name: 'MicrovisionChain' };
  }
  if (ticker === 'DOGE' || ticker === 'DOGECOIN') {
    return { chain: 'doge', symbol: 'DOGE', name: 'Dogecoin' };
  }
  if (!ticker && chainHint) {
    if (chainHint === 'btc') return { chain: 'btc', symbol: 'BTC', name: 'Bitcoin' };
    if (chainHint === 'mvc') return { chain: 'mvc', symbol: 'SPACE', name: 'MicrovisionChain' };
    if (chainHint === 'doge') return { chain: 'doge', symbol: 'DOGE', name: 'Dogecoin' };
  }
  return null;
}

export async function buildTokenCardSnapshot(
  input: BuildTokenCardInput,
  deps: TokenCardServiceDeps,
): Promise<BuildTokenCardResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
  const mode: TokenCardMode = input.mode === 'detailed' ? 'detailed' : 'simple';
  const metasoBase = deps.metasoApiBase || process.env.METASO_API_BASE || METASO_DEFAULT_BASE;

  const rawQuery = normalizeQuery(input.query);
  if (!rawQuery) {
    throw new Error('token query is required (pass a symbol such as "METAID" or an asset_key).');
  }

  const metabotSummary =
    input.metabotId != null && deps.getMetabotSummary
      ? deps.getMetabotSummary(input.metabotId)
      : null;
  let botName = metabotSummary?.name;

  // 1. Check Native L1 Coin (`BTC`, `SPACE`/`MVC`, `DOGE`) unless an explicit FT assetKey was passed.
  const isExplicitFtKey = rawQuery.startsWith('mrc20:') || rawQuery.startsWith('mvc-ft:') || /^[0-9a-f]{64}i\d+$/i.test(rawQuery);
  const tickerCandidate = isExplicitFtKey ? '' : normalizeTicker(rawQuery);
  const nativeSpec = !isExplicitFtKey ? resolveNativeChainFromSymbol(tickerCandidate, undefined) : null;

  if (nativeSpec) {
    const [spotPrices, balanceRes] = await Promise.all([
      fetchCoinSpotPrices(fetchImpl, timeoutMs),
      input.metabotId != null && deps.getBalances
        ? deps.getBalances({ metabotIds: [input.metabotId], chains: [nativeSpec.chain] }).catch(() => null)
        : Promise.resolve(null),
    ]);

    const entry = balanceRes?.entries?.[0];
    if (!botName && entry?.name) botName = entry.name;
    const snap = entry?.balances?.[nativeSpec.chain];
    const totalSats = snap?.total_sats ?? 0;
    const coinBalance = totalSats / SATOSHI_PER_COIN;
    const isZero = totalSats <= 0;

    const unitUsd =
      nativeSpec.chain === 'btc'
        ? spotPrices.btcUsd
        : nativeSpec.chain === 'mvc'
          ? spotPrices.spaceUsd
          : spotPrices.dogeUsd;

    const priceUsdFormatted = formatUsdPrice(unitUsd);
    const botUsdFormatted = !isZero && unitUsd ? formatUsdValuation(coinBalance * unitUsd) : undefined;
    const balanceDisplay = isZero
      ? `0 ${nativeSpec.symbol}`
      : `${formatTokenAmountDisplay(coinBalance.toFixed(8), nativeSpec.chain === 'btc' ? 8 : 4)} ${nativeSpec.symbol}`;

    const card: TokenCardData = {
      mode,
      symbol: nativeSpec.symbol,
      name: nativeSpec.name,
      chain: nativeSpec.chain,
      standard: 'native',
      assetKey: `native:${nativeSpec.chain}`,
      caVerified: true,
      snapshotAt: nowIso,
      priceMain: priceUsdFormatted ?? '—',
      priceUnit: priceUsdFormatted ? 'USD' : undefined,
      priceNativeText:
        nativeSpec.chain === 'mvc' && spotPrices.btcUsd && spotPrices.spaceUsd
          ? `≈ ${Math.round((spotPrices.spaceUsd / spotPrices.btcUsd) * SATOSHI_PER_COIN).toLocaleString('en-US')} sat (BTC)`
          : `1 ${nativeSpec.symbol} = 100,000,000 sats`,
      ...(botName ? { botName } : {}),
      botBalanceText: balanceDisplay,
      ...(isZero ? { botZeroHolding: true } : {}),
      ...(botUsdFormatted ? { botBalanceUsdText: botUsdFormatted } : {}),
    };

    const fence = serializeTokenCardFence(card);
    return {
      card,
      fence,
      summaryText: buildToolSummaryText(card, fence),
    };
  }

  // 2. Parse explicit FT keys if provided
  let explicitMrc20Id: string | undefined;
  let explicitMvcCodehash: string | undefined;
  let explicitMvcGenesis: string | undefined;

  if (rawQuery.toLowerCase().startsWith('mrc20:')) {
    explicitMrc20Id = rawQuery.slice('mrc20:'.length).trim();
  } else if (/^[0-9a-f]{64}i\d+$/i.test(rawQuery)) {
    explicitMrc20Id = rawQuery.trim();
  } else if (rawQuery.toLowerCase().startsWith('mvc-ft:')) {
    const rest = rawQuery.slice('mvc-ft:'.length).trim();
    const [ch = '', gen = ''] = rest.split(':');
    explicitMvcCodehash = ch.trim().toLowerCase() || undefined;
    explicitMvcGenesis = gen.trim().toLowerCase() || undefined;
  }

  const preferMvc = input.chain === 'mvc' || Boolean(explicitMvcGenesis);
  const preferBtc = input.chain === 'btc' || Boolean(explicitMrc20Id);

  // 3. Kick off parallel data gathering across Bot wallet + Market APIs
  const [
    spotPrices,
    metaletMrc20Prices,
    metaletMvcFtPrices,
    mrc20WalletEntries,
    mvcFtWalletEntries,
    metaidMarketHit,
  ] = await Promise.all([
    fetchCoinSpotPrices(fetchImpl, timeoutMs),
    preferMvc && !preferBtc ? Promise.resolve([] as MetaletMrc20PriceEntry[]) : fetchMetaletMrc20PriceMap(fetchImpl, timeoutMs),
    preferBtc && !preferMvc ? Promise.resolve({} as Record<string, number>) : fetchMetaletMvcFtPriceMap(fetchImpl, timeoutMs),
    input.metabotId != null && deps.listMrc20s
      ? deps.listMrc20s({ metabotIds: [input.metabotId] }).catch(() => [])
      : Promise.resolve([]),
    input.metabotId != null && deps.listMvcFtTokens
      ? deps.listMvcFtTokens({ metabotIds: [input.metabotId] }).catch(() => [])
      : Promise.resolve([]),
    preferMvc && !preferBtc
      ? Promise.resolve(null)
      : fetchMetaidMarketToken(
          fetchImpl,
          explicitMrc20Id ? { tickId: explicitMrc20Id } : { tick: tickerCandidate },
          timeoutMs,
        ),
  ]);

  const botMrc20Assets = mrc20WalletEntries[0]?.assets ?? [];
  const botMvcFtTokens = mvcFtWalletEntries[0]?.balance?.tokens ?? [];
  const localIssuances = deps.listIssuedTokens
    ? deps.listIssuedTokens({
        ...(explicitMvcCodehash && explicitMvcGenesis
          ? { assetKey: `mvc-ft:${explicitMvcCodehash}:${explicitMvcGenesis}` }
          : tickerCandidate
            ? { symbol: tickerCandidate }
            : {}),
        limit: 10,
      })
    : [];

  // 4. Resolve BTC MRC-20 / ID-Coin candidate
  const curatedMrc20Match = explicitMrc20Id
    ? metaletMrc20Prices.find((p) => p.mrc20Id.toLowerCase() === explicitMrc20Id!.toLowerCase())
    : metaletMrc20Prices.find((p) => p.symbol === tickerCandidate);

  const walletMrc20Match = explicitMrc20Id
    ? botMrc20Assets.find((a) => a.mrc20Id.toLowerCase() === explicitMrc20Id!.toLowerCase())
    : botMrc20Assets.find((a) => a.symbol.trim().toUpperCase() === tickerCandidate);

  const resolvedMrc20Id =
    metaidMarketHit?.mrc20Id ||
    explicitMrc20Id ||
    curatedMrc20Match?.mrc20Id ||
    walletMrc20Match?.mrc20Id;

  // If `api.metaid.market` missed/timed out, supplement from Metalet `mrc20/tick/info` (~4ms)
  let mrc20Merged: Partial<MetaidMarketRawInfo> | null = metaidMarketHit ? { ...metaidMarketHit } : null;
  if (!preferMvc && (resolvedMrc20Id || (!preferMvc && tickerCandidate))) {
    if (!mrc20Merged || !mrc20Merged.mrc20Id) {
      const fallbackInfo = await fetchMetaletMrc20TickInfo(
        fetchImpl,
        resolvedMrc20Id ? { tickId: resolvedMrc20Id } : { tick: tickerCandidate },
        timeoutMs,
      );
      if (fallbackInfo?.mrc20Id) {
        mrc20Merged = fallbackInfo;
      }
    }
  }

  // 5. Resolve MVC MetaContract FT candidate
  const walletMvcMatch =
    explicitMvcCodehash && explicitMvcGenesis
      ? botMvcFtTokens.find(
          (t) =>
            t.codeHash.toLowerCase() === explicitMvcCodehash &&
            t.genesis.toLowerCase() === explicitMvcGenesis,
        )
      : botMvcFtTokens.find((t) => t.symbol.trim().toUpperCase() === tickerCandidate);

  const localMvcIssuance =
    explicitMvcCodehash && explicitMvcGenesis
      ? localIssuances.find(
          (r) =>
            r.codehash.toLowerCase() === explicitMvcCodehash &&
            r.genesis.toLowerCase() === explicitMvcGenesis,
        )
      : localIssuances.find((r) => r.tokenSymbol.trim().toUpperCase() === tickerCandidate);

  let mvcContractInfo: {
    symbol: string;
    name?: string;
    codehash: string;
    genesis: string;
    decimals: number;
    supply?: string;
    holders?: number;
    icon?: string;
  } | null = null;

  const targetMvcCodehash =
    explicitMvcCodehash || walletMvcMatch?.codeHash?.toLowerCase() || localMvcIssuance?.codehash?.toLowerCase();
  const targetMvcGenesis =
    explicitMvcGenesis || walletMvcMatch?.genesis?.toLowerCase() || localMvcIssuance?.genesis?.toLowerCase();

  if ((preferMvc || !mrc20Merged?.mrc20Id) && targetMvcCodehash && targetMvcGenesis) {
    const ftInfoJson = await fetchJsonWithTimeout<{
      code?: number;
      data?: Record<string, unknown>;
    }>(
      fetchImpl,
      `${METALET_HOST}/wallet-api/v4/mvc/contract/ft/info?net=livenet&codeHash=${encodeURIComponent(targetMvcCodehash)}&genesis=${encodeURIComponent(targetMvcGenesis)}`,
      timeoutMs,
    );
    const d = ftInfoJson?.data;
    const rawIcon = typeof d?.icon === 'string' && d.icon
      ? d.icon.startsWith('http') || d.icon.startsWith('metafile://') || d.icon.startsWith('/content/')
        ? d.icon
        : d.icon.startsWith('/')
          ? `${METALET_HOST}/wallet-api${d.icon}`
          : d.icon
      : undefined;
    const resolvedMvcDecimals = Number.isInteger(Number(d?.decimal ?? d?.decimals))
      ? Number(d?.decimal ?? d?.decimals)
      : (walletMvcMatch?.decimal ?? localMvcIssuance?.decimals ?? 8);
    let resolvedMvcSupplyDisplay: string | undefined = localMvcIssuance?.totalMintedDisplay;
    if (d?.totalSupply != null && String(d.totalSupply).trim() !== '') {
      try {
        resolvedMvcSupplyDisplay = new Decimal(String(d.totalSupply).trim())
          .div(new Decimal(10).pow(resolvedMvcDecimals))
          .toFixed();
      } catch {
        resolvedMvcSupplyDisplay = String(d.totalSupply);
      }
    }
    mvcContractInfo = {
      symbol: String(d?.symbol || walletMvcMatch?.symbol || localMvcIssuance?.tokenSymbol || tickerCandidate || 'TOKEN').trim().toUpperCase(),
      name: String(d?.name || walletMvcMatch?.tokenName || localMvcIssuance?.tokenName || '').trim() || undefined,
      codehash: targetMvcCodehash,
      genesis: targetMvcGenesis,
      decimals: resolvedMvcDecimals,
      supply: resolvedMvcSupplyDisplay,
      holders: parseFiniteNum(d?.holders ?? d?.holderCount),
      icon: sanitizeTokenIconUrl(rawIcon),
    };
  }

  // Decide between BTC MRC-20/ID-Coin and MVC FT
  const useMrc20 =
    Boolean(mrc20Merged?.mrc20Id || walletMrc20Match) &&
    !(preferMvc && mvcContractInfo);

  if (useMrc20) {
    const finalMrc20Id = mrc20Merged?.mrc20Id || walletMrc20Match!.mrc20Id;
    const finalSymbol = (mrc20Merged?.tick || walletMrc20Match?.symbol || tickerCandidate).toUpperCase();
    const finalStandard: TokenCardStandard = mrc20Merged?.kind === 'idcoin' ? 'idcoin' : 'mrc20';
    const assetKey = `mrc20:${finalMrc20Id}`;

    // Check MetaSo CA verification in parallel-safe bounded call
    const metasoSummary = await fetchMetasoFtVerification(
      fetchImpl,
      metasoBase,
      assetKey,
      finalSymbol,
      Math.min(timeoutMs, 2_500),
    );

    const exactCurated = metaletMrc20Prices.find(
      (p) => p.mrc20Id.toLowerCase() === finalMrc20Id.toLowerCase() && p.symbol === finalSymbol,
    );
    const caVerified = metasoSummary?.caVerified === true || Boolean(exactCurated);

    // Price resolution: prefer live orderbook `marketPriceSats` + `marketPriceUsd`, fall back to Metalet curated USD + BTC spot conversion
    const btcUsd = spotPrices.btcUsd;
    let priceUsd =
      mrc20Merged?.marketPriceUsd ??
      metasoSummary?.priceUsd ??
      (exactCurated && exactCurated.usdPrice > 0 ? exactCurated.usdPrice : undefined);

    let priceSats = mrc20Merged?.marketPriceSats;
    if ((priceSats === undefined || priceSats <= 0) && priceUsd && btcUsd && btcUsd > 0) {
      priceSats = (priceUsd / btcUsd) * SATOSHI_PER_COIN;
    }
    if ((priceUsd === undefined || priceUsd <= 0) && priceSats && btcUsd && btcUsd > 0) {
      priceUsd = (priceSats / SATOSHI_PER_COIN) * btcUsd;
    }

    const priceHeadline =
      priceSats !== undefined && priceSats > 0
        ? formatSatsHeadline(priceSats)
        : priceUsd !== undefined && priceUsd > 0
          ? { main: formatUsdPrice(priceUsd)!, unit: 'USD' }
          : { main: '—', unit: '' };

    const priceNativeText =
      priceSats !== undefined && priceSats > 0
        ? `≈ ${formatBtcFromSats(priceSats, false)}`
        : undefined;
    const priceUsdText = formatUsdPrice(priceUsd);

    const floorSats = mrc20Merged?.floorPriceSats ?? metasoSummary?.floorSats;
    const floorHeadline = floorSats && floorSats > 0 ? formatSatsHeadline(floorSats) : null;
    const floorPriceText = floorHeadline ? `${floorHeadline.main} ${floorHeadline.unit}` : undefined;
    const floorUsd =
      mrc20Merged?.floorPriceUsd ??
      (floorSats && btcUsd ? (floorSats / SATOSHI_PER_COIN) * btcUsd : undefined);
    const floorUsdText = formatUsdPrice(floorUsd);

    const marketVsFloorPct =
      priceSats && priceSats > 0 && floorSats && floorSats > 0
        ? Number((((priceSats - floorSats) / floorSats) * 100).toFixed(2))
        : undefined;

    // Supply & Market Cap
    const supplyInfo = computeSupplyDisplay(mrc20Merged ?? {});
    const numericSupply =
      parseFiniteNum(mrc20Merged?.supply) ??
      parseFiniteNum(mrc20Merged?.totalSupply) ??
      (parseFiniteNum(mrc20Merged?.amtPerMint) && parseFiniteNum(mrc20Merged?.totalMinted)
        ? parseFiniteNum(mrc20Merged?.amtPerMint)! * parseFiniteNum(mrc20Merged?.totalMinted)!
        : undefined);

    const mcapSats =
      mrc20Merged?.marketCapSats ??
      (numericSupply && priceSats ? numericSupply * priceSats : undefined);
    const mcapUsd =
      mrc20Merged?.marketCapUsd ??
      (numericSupply && priceUsd ? numericSupply * priceUsd : mcapSats && btcUsd ? (mcapSats / SATOSHI_PER_COIN) * btcUsd : undefined);

    const marketCapMain = mcapSats && mcapSats > 0 ? formatBtcFromSats(mcapSats, true) : undefined;

    const volSats = mrc20Merged?.totalVolumeSats;
    const volumeMain = volSats !== undefined && volSats > 0 ? formatBtcFromSats(volSats, true) : undefined;
    const volumeUsd =
      volSats !== undefined && volSats > 0 && btcUsd ? (volSats / SATOSHI_PER_COIN) * btcUsd : undefined;

    // Bot wallet holding for this exact `mrc20Id`
    const botHolding = botMrc20Assets.find(
      (a) => a.mrc20Id.toLowerCase() === finalMrc20Id.toLowerCase(),
    );
    const rawBotBal = botHolding?.balance?.display ?? '0';
    const botBalDec = new Decimal(rawBotBal || '0');
    const isZero = !botBalDec.isFinite() || botBalDec.lte(0);
    const botBalanceText = isZero
      ? `0 ${finalSymbol}`
      : `${formatTokenAmountDisplay(rawBotBal, 4)} ${finalSymbol}`;
    const botBalanceUsdText =
      !isZero && priceUsd && priceUsd > 0
        ? formatUsdValuation(botBalDec.toNumber() * priceUsd)
        : undefined;

    const icon = mrc20Merged?.icon ?? sanitizeTokenIconUrl(walletMrc20Match?.icon);
    const change24h = mrc20Merged?.change24h;
    const changeDir = deriveChangeDir(change24h);

    const card: TokenCardData = {
      mode,
      symbol: finalSymbol,
      ...(mrc20Merged?.tokenName || walletMrc20Match?.tokenName
        ? { name: mrc20Merged?.tokenName || walletMrc20Match?.tokenName }
        : {}),
      chain: 'btc',
      standard: finalStandard,
      assetKey,
      caVerified,
      ...(icon ? { icon } : {}),
      snapshotAt: nowIso,
      priceMain: priceHeadline.main,
      ...(priceHeadline.unit ? { priceUnit: priceHeadline.unit } : {}),
      ...(priceNativeText ? { priceNativeText } : {}),
      ...(priceUsdText ? { priceUsdText } : {}),
      ...(change24h ? { change24h } : {}),
      ...(changeDir ? { changeDir } : {}),
      ...(floorPriceText ? { floorPriceText } : {}),
      ...(floorUsdText ? { floorUsdText } : {}),
      ...(marketVsFloorPct !== undefined ? { marketVsFloorPct } : {}),
      ...(marketCapMain ? { marketCapMain } : {}),
      ...(mcapUsd !== undefined && mcapUsd > 0 ? { marketCapUsd: mcapUsd } : {}),
      ...(volumeMain ? { volumeMain } : {}),
      ...(volumeUsd !== undefined && volumeUsd > 0 ? { volumeUsd } : {}),
      ...(mrc20Merged?.holders !== undefined ? { holdersCount: mrc20Merged.holders } : {}),
      ...(mrc20Merged?.followersCount !== undefined ? { followersCount: mrc20Merged.followersCount } : {}),
      ...(mrc20Merged?.txCount !== undefined ? { txCount: mrc20Merged.txCount } : {}),
      ...(supplyInfo.supplyMain ? { supplyMain: supplyInfo.supplyMain } : {}),
      ...(supplyInfo.mintProgressPct !== undefined ? { mintProgressPct: supplyInfo.mintProgressPct } : {}),
      ...(supplyInfo.mintable !== undefined ? { mintable: supplyInfo.mintable } : {}),
      ...(botName ? { botName } : {}),
      botBalanceText,
      ...(isZero ? { botZeroHolding: true } : {}),
      ...(botBalanceUsdText ? { botBalanceUsdText } : {}),
      ...(mode === 'detailed' ? { quickActions: ['orders', 'trades', 'trade'] } : {}),
    };

    const fence = serializeTokenCardFence(card);
    return {
      card,
      fence,
      summaryText: buildToolSummaryText(card, fence),
    };
  }

  // 6. MVC MetaContract FT card path
  if (mvcContractInfo) {
    const assetKey = `mvc-ft:${mvcContractInfo.codehash}:${mvcContractInfo.genesis}`;
    const metasoSummary = await fetchMetasoFtVerification(
      fetchImpl,
      metasoBase,
      assetKey,
      mvcContractInfo.symbol,
      Math.min(timeoutMs, 2_500),
    );
    const caVerified = metasoSummary?.caVerified === true;

    const spaceUsd = spotPrices.spaceUsd;
    const priceUsd =
      metasoSummary?.priceUsd ??
      metaletMvcFtPrices[mvcContractInfo.genesis.toUpperCase()] ??
      metaletMvcFtPrices[mvcContractInfo.symbol];
    const floorSpaceSats = metasoSummary?.floorSats;
    const floorSpace = floorSpaceSats && floorSpaceSats > 0 ? floorSpaceSats / SATOSHI_PER_COIN : undefined;

    let priceMain = '—';
    let priceUnit: string | undefined;
    let priceNativeText: string | undefined;

    if (floorSpace && floorSpace > 0) {
      priceMain = formatTokenAmountDisplay(floorSpace.toFixed(8), 6);
      priceUnit = 'SPACE';
      priceNativeText = `${Math.round(floorSpaceSats!).toLocaleString('en-US')} sat (MVC)`;
    } else if (priceUsd && priceUsd > 0 && spaceUsd && spaceUsd > 0) {
      const inSpace = priceUsd / spaceUsd;
      priceMain = formatTokenAmountDisplay(inSpace.toFixed(8), 6);
      priceUnit = 'SPACE';
    } else if (priceUsd && priceUsd > 0) {
      priceMain = formatUsdPrice(priceUsd)!;
      priceUnit = 'USD';
    }

    const effectiveUsd =
      priceUsd ?? (floorSpace && spaceUsd ? floorSpace * spaceUsd : undefined);
    const priceUsdText = formatUsdPrice(effectiveUsd);

    let botBalDec = new Decimal(0);
    if (walletMvcMatch?.balance) {
      try {
        const rawBalStr = String(walletMvcMatch.balance).trim();
        const alreadyDisplay =
          rawBalStr.includes('.') ||
          walletMvcMatch.confirmed !== undefined ||
          walletMvcMatch.unconfirmed !== undefined;
        botBalDec = alreadyDisplay
          ? new Decimal(rawBalStr)
          : new Decimal(rawBalStr).div(new Decimal(10).pow(mvcContractInfo.decimals));
      } catch {
        botBalDec = new Decimal(0);
      }
    }
    const isZero = !botBalDec.isFinite() || botBalDec.lte(0);
    const botBalanceText = isZero
      ? `0 ${mvcContractInfo.symbol}`
      : `${formatTokenAmountDisplay(botBalDec.toFixed(), 4)} ${mvcContractInfo.symbol}`;
    const botBalanceUsdText =
      !isZero && effectiveUsd && effectiveUsd > 0
        ? formatUsdValuation(botBalDec.toNumber() * effectiveUsd)
        : undefined;

    const supplyNum = parseFiniteNum(mvcContractInfo.supply);
    const mcapUsd =
      supplyNum && effectiveUsd ? supplyNum * effectiveUsd : undefined;
    const mcapSpace =
      supplyNum && floorSpace
        ? `${formatTokenAmountDisplay((supplyNum * floorSpace).toFixed(2), 2)} SPACE`
        : mcapUsd && spaceUsd
          ? `${formatTokenAmountDisplay((mcapUsd / spaceUsd).toFixed(2), 2)} SPACE`
          : undefined;

    const card: TokenCardData = {
      mode,
      symbol: mvcContractInfo.symbol,
      ...(mvcContractInfo.name ? { name: mvcContractInfo.name } : {}),
      chain: 'mvc',
      standard: 'mvc-ft',
      assetKey,
      caVerified,
      ...(mvcContractInfo.icon ? { icon: mvcContractInfo.icon } : {}),
      snapshotAt: nowIso,
      priceMain,
      ...(priceUnit ? { priceUnit } : {}),
      ...(priceNativeText ? { priceNativeText } : {}),
      ...(priceUsdText ? { priceUsdText } : {}),
      ...(floorSpace ? { floorPriceText: `${formatTokenAmountDisplay(floorSpace.toFixed(8), 6)} SPACE` } : {}),
      ...(mcapSpace ? { marketCapMain: mcapSpace } : {}),
      ...(mcapUsd && mcapUsd > 0 ? { marketCapUsd: mcapUsd } : {}),
      ...(mvcContractInfo.holders !== undefined ? { holdersCount: mvcContractInfo.holders } : {}),
      ...(supplyNum && supplyNum > 0 ? { supplyMain: formatTokenAmountDisplay(supplyNum, 2) } : {}),
      ...(localMvcIssuance ? { mintable: localMvcIssuance.allowIncreaseMints } : {}),
      ...(botName ? { botName } : {}),
      botBalanceText,
      ...(isZero ? { botZeroHolding: true } : {}),
      ...(botBalanceUsdText ? { botBalanceUsdText } : {}),
      ...(mode === 'detailed' ? { quickActions: ['orders', 'trade'] } : {}),
    };

    const fence = serializeTokenCardFence(card);
    return {
      card,
      fence,
      summaryText: buildToolSummaryText(card, fence),
    };
  }

  throw new Error(
    `Token "${rawQuery}" could not be resolved on BTC (MRC-20 / ID-Coin), MVC (MetaContract FT), or native L1 chains. ` +
      'If it is a newly issued MVC token not yet in this Bot wallet, pass its canonical asset_key ("mvc-ft:<codehash>:<genesis>") or mrc20Id ("<64hex>i0").',
  );
}

function buildToolSummaryText(card: TokenCardData, fence: string): string {
  const lines: string[] = [
    `Token Card ready (${card.mode} mode): $${card.symbol} [${card.assetKey}]`,
    `- Price: ${card.priceMain}${card.priceUnit ? ` ${card.priceUnit}` : ''}${card.priceUsdText ? ` (${card.priceUsdText})` : ''}${card.change24h ? `, 24h ${card.change24h}` : ''}`,
    `- Bot wallet holding${card.botName ? ` (${card.botName})` : ''}: ${card.botBalanceText}${card.botBalanceUsdText ? ` (${card.botBalanceUsdText})` : ''}`,
  ];
  if (card.floorPriceText) {
    lines.push(
      `- Floor: ${card.floorPriceText}${card.marketVsFloorPct !== undefined ? ` (market vs floor: ${card.marketVsFloorPct > 0 ? '+' : ''}${card.marketVsFloorPct}%)` : ''}`,
    );
  }
  if (card.marketCapMain) lines.push(`- Market cap: ${card.marketCapMain}`);
  if (card.volumeMain) lines.push(`- Total volume: ${card.volumeMain}`);
  if (card.holdersCount !== undefined || card.followersCount !== undefined) {
    lines.push(
      `- Community: ${card.holdersCount !== undefined ? `${card.holdersCount} holders` : 'n/a'}${card.followersCount !== undefined ? `, ${card.followersCount} followers` : ''}`,
    );
  }
  if (card.supplyMain) {
    lines.push(`- Supply: ${card.supplyMain}${card.mintable !== undefined ? ` (mintable=${card.mintable})` : ''}`);
  }
  lines.push(
    '',
    'IMPORTANT PRESENTATION RULE:',
    '1. Include the ```token-card fenced block below VERBATIM in your reply. The UI renders it as its own standalone native Token Card bubble.',
    '2. Do NOT repeat the card\'s numbers as a bullet list or Markdown table. Add at most 1-2 short natural sentences of takeaway or next-step suggestion (or nothing else if the card already answers the user completely).',
    '',
    fence,
  );
  return lines.join('\n');
}

// ============================================================================
// Q1 Four-Rail Route Quote Comparison (`ft-quote-card`) & Live Seller Orders
// ============================================================================

export type FtQuoteBudgetUnit = 'me' | 'space' | 'btc' | 'sats' | 'usd';

export interface BuildFtQuoteCardInput {
  /** Ticker (`"$METAID"`, `"METAID"`, `"TDC"`), `assetKey` (`"mrc20:..."`, `"mvc-ft:..."`), or `mrc20Id` (`"<64hex>i0"`). */
  query: string;
  /** Optional budget amount (number or string like `"50"`, `"50 ME"`, `"0.1 SPACE"`, `"10000 sats"`). */
  budget?: number | string;
  /** Optional budget currency unit (`"me"`, `"space"`, `"btc"`, `"sats"`, `"usd"`). */
  budgetUnit?: string;
  /** Optional chain hint (`"btc"` or `"mvc"`). */
  chain?: TokenCardChain;
  /** Active MetaBot ID for resolving local wallet / issued token metadata. */
  metabotId?: number;
}

export interface BuildFtQuoteCardResult {
  card: FtQuoteCardData;
  fence: string;
  summaryText: string;
}

const KNOWN_BRIDGED_FT_SYMBOLS = new Set(['METAID', 'MSP']);

interface ParsedQuoteOrder {
  rail: 'btc-psbt' | 'mvc-tokensell' | 'me-escrow';
  orderId: string;
  assetKey: string;
  symbol: string;
  caVerified: boolean;
  decimals: number;
  amountDisplayNum: number;
  amountDisplayStr: string;
  /** Total lot price in rail native unit: sats for btc-psbt & mvc-tokensell, ME (not milli) for me-escrow. */
  lotTotalNative: number;
  /** Per-token unit price in sats (btc-psbt), SPACE (mvc-tokensell), or ME (me-escrow). */
  unitPriceMain: number;
  unitUsd?: number;
  sellerOnline: boolean;
  utxoOutpoint?: string;
  sellTxid?: string;
  sellOutputIndex?: number;
  sellPriceSats?: number;
  sellerAddress?: string;
  batchGroupId?: string;
}

function parseBudgetInput(
  rawBudget?: number | string,
  rawUnit?: string,
): { amount?: number; unit?: FtQuoteBudgetUnit; label?: string } {
  let unitNorm = String(rawUnit ?? '').trim().toLowerCase();
  let amountNum: number | undefined;

  if (typeof rawBudget === 'number' && Number.isFinite(rawBudget) && rawBudget > 0) {
    amountNum = rawBudget;
  } else if (typeof rawBudget === 'string' && rawBudget.trim()) {
    const text = rawBudget.trim();
    const match = text.match(/^\$?\s*([0-9]+(?:\.[0-9]+)?)\s*([a-zA-Z]+)?$/);
    if (match) {
      const n = Number(match[1]);
      if (Number.isFinite(n) && n > 0) amountNum = n;
      if (!unitNorm && match[2]) unitNorm = match[2].toLowerCase();
      if (!unitNorm && text.trim().startsWith('$')) unitNorm = 'usd';
    }
  }

  let unit: FtQuoteBudgetUnit | undefined;
  if (unitNorm === 'me' || unitNorm === 'mepoints' || unitNorm === 'energy') unit = 'me';
  else if (unitNorm === 'space' || unitNorm === 'mvc') unit = 'space';
  else if (unitNorm === 'btc' || unitNorm === 'bitcoin') unit = 'btc';
  else if (unitNorm === 'sat' || unitNorm === 'sats' || unitNorm === 'satoshi') unit = 'sats';
  else if (unitNorm === 'usd' || unitNorm === 'usdt' || unitNorm === '$') unit = 'usd';

  if (!amountNum) return {};
  const unitDisplay =
    unit === 'me'
      ? 'ME'
      : unit === 'space'
        ? 'SPACE'
        : unit === 'btc'
          ? 'BTC'
          : unit === 'sats'
            ? 'sats'
            : unit === 'usd'
              ? 'USD'
              : '';
  const label = unitDisplay
    ? `${formatTokenAmountDisplay(amountNum, 6)} ${unitDisplay}`
    : formatTokenAmountDisplay(amountNum, 6);
  return { amount: amountNum, unit, label };
}

function parseBtcMarketOrderItem(
  row: Record<string, unknown>,
  fallbackAssetKey: string,
  fallbackSymbol: string,
  fallbackDecimals: number,
  caVerified: boolean,
  btcUsd?: number,
): ParsedQuoteOrder | null {
  const decimals = Number.isInteger(Number(row.decimals)) ? Number(row.decimals) : fallbackDecimals;
  let amountDec = new Decimal(0);
  if (row.amountStr != null && String(row.amountStr).trim() !== '') {
    try {
      amountDec = new Decimal(String(row.amountStr).trim());
    } catch {
      amountDec = new Decimal(0);
    }
  } else if (row.amount != null && String(row.amount).trim() !== '') {
    const rawStr = String(row.amount).trim();
    try {
      amountDec = /^\d+$/.test(rawStr)
        ? new Decimal(rawStr).div(new Decimal(10).pow(decimals))
        : new Decimal(rawStr);
    } catch {
      amountDec = new Decimal(0);
    }
  }
  const amountNum = amountDec.toNumber();
  const priceSats = parseFiniteNum(row.priceAmount ?? row.totalPrice);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || !priceSats || priceSats <= 0) {
    return null;
  }
  const unitSats = priceSats / amountNum;
  const tickId = String(row.tickId || row.mrc20Id || '').trim();
  const assetKey = tickId ? `mrc20:${tickId}` : fallbackAssetKey;
  const symbol = String(row.tick || fallbackSymbol || 'TOKEN').trim().toUpperCase();
  const unitUsd = btcUsd && btcUsd > 0 ? (unitSats / SATOSHI_PER_COIN) * btcUsd : undefined;
  const utxoRaw = String(row.utxoId || '').trim();
  return {
    rail: 'btc-psbt',
    orderId: String(row.orderId || utxoRaw || ''),
    assetKey,
    symbol,
    caVerified,
    decimals,
    amountDisplayNum: amountNum,
    amountDisplayStr: formatTokenAmountDisplay(amountDec.toFixed(), 6),
    lotTotalNative: priceSats,
    unitPriceMain: unitSats,
    unitUsd,
    sellerOnline: true,
    utxoOutpoint: utxoRaw ? utxoRaw.replace('_', ':') : undefined,
    sellPriceSats: Math.round(priceSats),
    sellerAddress: String(row.sellerAddress || row.address || '').trim() || undefined,
  };
}

function parseMetasoListingOrders(
  listing: Record<string, unknown>,
  spotPrices: CoinSpotPrices,
): ParsedQuoteOrder[] {
  const asset =
    listing.asset && typeof listing.asset === 'object'
      ? (listing.asset as Record<string, unknown>)
      : {};
  const lot =
    listing.lot && typeof listing.lot === 'object'
      ? (listing.lot as Record<string, unknown>)
      : {};
  const rails =
    listing.rails && typeof listing.rails === 'object'
      ? (listing.rails as Record<string, unknown>)
      : {};
  const sellerObj =
    listing.seller && typeof listing.seller === 'object'
      ? (listing.seller as Record<string, unknown>)
      : {};

  const assetKey = String(asset.assetKey || listing.assetKey || '').trim();
  const symbol = String(asset.symbol || listing.symbol || 'TOKEN').trim().toUpperCase();
  const decimals = Number.isInteger(Number(asset.decimals)) ? Number(asset.decimals) : 8;
  const caVerified = asset.caVerified === true || listing.caVerified === true;

  let amountDec = new Decimal(0);
  const rawDisp = lot.amountDisplay ?? listing.amountDisplay;
  const rawBase = lot.amountBase ?? listing.amountBase;
  if (rawDisp != null && String(rawDisp).trim() !== '') {
    try {
      amountDec = new Decimal(String(rawDisp).trim());
    } catch {
      amountDec = new Decimal(0);
    }
  } else if (rawBase != null && String(rawBase).trim() !== '') {
    try {
      amountDec = new Decimal(String(rawBase).trim()).div(new Decimal(10).pow(decimals));
    } catch {
      amountDec = new Decimal(0);
    }
  }
  const amountNum = amountDec.toNumber();
  if (!Number.isFinite(amountNum) || amountNum <= 0) return [];
  const amountDisplayStr = formatTokenAmountDisplay(amountDec.toFixed(), 6);

  const sellerOnline =
    listing.sellerOnline !== undefined
      ? listing.sellerOnline !== false
      : sellerObj.isOnline !== undefined
        ? Boolean(sellerObj.isOnline)
        : true;
  const sellerAddress = String(
    listing.sellerAddress || sellerObj.botMvcAddress || sellerObj.botBtcAddress || sellerObj.address || '',
  ).trim();
  const batchGroupId = String(listing.batchGroupId || '').trim() || undefined;
  const listingKey = String(listing.listingKey || listing.sellPinId || listing.pinId || '').trim();
  const utxoOutpoint = String(lot.utxoOutpoint || listing.utxoOutpoint || '').trim() || undefined;

  const out: ParsedQuoteOrder[] = [];
  const flatRail = String(listing.rail || '').trim().toLowerCase();

  const tsObj: Record<string, unknown> | null =
    rails.mvcTokenSell && typeof rails.mvcTokenSell === 'object'
      ? (rails.mvcTokenSell as Record<string, unknown>)
      : flatRail === 'mvc-tokensell' || flatRail === 'mvctokensell'
        ? listing
        : null;

  if (tsObj) {
    let parsedTs: Record<string, unknown> = {};
    const rawTsJson =
      typeof tsObj.tokenSellJson === 'string' && tsObj.tokenSellJson.trim()
        ? tsObj.tokenSellJson
        : typeof listing.tokenSellJson === 'string' && listing.tokenSellJson.trim()
          ? listing.tokenSellJson
          : '';
    if (rawTsJson) {
      try {
        parsedTs = JSON.parse(rawTsJson) as Record<string, unknown>;
      } catch {
        parsedTs = {};
      }
    }
    const priceSats = parseFiniteNum(tsObj.priceSats ?? parsedTs.sell_price_sats ?? listing.priceSats);
    if (priceSats && priceSats > 0) {
      const unitSpace = priceSats / SATOSHI_PER_COIN / amountNum;
      const unitUsd = spotPrices.spaceUsd ? unitSpace * spotPrices.spaceUsd : undefined;
      const sellTxid = String(tsObj.sellTxid || parsedTs.sell_txid || tsObj.txid || '').trim() || undefined;
      const sellOutputIndex = Number(
        tsObj.tokenListOutputIndex ?? tsObj.sellOutputIndex ?? parsedTs.sell_output_index ?? 0,
      );
      out.push({
        rail: 'mvc-tokensell',
        orderId: String(sellTxid || listingKey || ''),
        assetKey,
        symbol,
        caVerified,
        decimals,
        amountDisplayNum: amountNum,
        amountDisplayStr,
        lotTotalNative: priceSats,
        unitPriceMain: unitSpace,
        unitUsd,
        sellerOnline: true, // On-chain TokenSell UTXO covenant does not require seller online
        utxoOutpoint: utxoOutpoint || (sellTxid ? `${sellTxid}:${sellOutputIndex}` : undefined),
        sellTxid,
        sellOutputIndex: Number.isInteger(sellOutputIndex) ? sellOutputIndex : 0,
        sellPriceSats: Math.round(priceSats),
        sellerAddress: String(tsObj.sellerAddress || parsedTs.seller_address || sellerAddress || '').trim() || undefined,
        batchGroupId,
      });
    }
  }

  const meObj: Record<string, unknown> | null =
    rails.me && typeof rails.me === 'object'
      ? (rails.me as Record<string, unknown>)
      : flatRail === 'me-escrow' || flatRail === 'me'
        ? listing
        : null;

  if (meObj) {
    const priceMeMilli = parseFiniteNum(meObj.priceMeMilli ?? meObj.amountMilli ?? listing.priceMeMilli);
    if (priceMeMilli && priceMeMilli > 0) {
      const lotMe = priceMeMilli / 1000;
      const unitMe = lotMe / amountNum;
      out.push({
        rail: 'me-escrow',
        orderId: String(listingKey || listing.orderId || ''),
        assetKey,
        symbol,
        caVerified,
        decimals,
        amountDisplayNum: amountNum,
        amountDisplayStr,
        lotTotalNative: lotMe,
        unitPriceMain: unitMe,
        sellerOnline,
        utxoOutpoint,
        sellerAddress: sellerAddress || undefined,
        batchGroupId,
      });
    }
  }

  return out;
}

function simulateLotSweep(
  orders: ParsedQuoteOrder[],
  budgetInLotNative: number,
): { sweptLots: number; sweptTokens: number; spentNative: number; nextLotCost?: number } {
  let remaining = budgetInLotNative;
  let sweptLots = 0;
  let sweptTokens = 0;
  let spentNative = 0;
  let nextLotCost: number | undefined;
  for (const o of orders) {
    if (o.lotTotalNative <= remaining + 1e-9) {
      remaining -= o.lotTotalNative;
      spentNative += o.lotTotalNative;
      sweptTokens += o.amountDisplayNum;
      sweptLots += 1;
    } else if (nextLotCost === undefined) {
      nextLotCost = o.lotTotalNative;
    }
  }
  return { sweptLots, sweptTokens, spentNative, nextLotCost };
}

export async function buildFtQuoteCardSnapshot(
  input: BuildFtQuoteCardInput,
  deps: TokenCardServiceDeps,
): Promise<BuildFtQuoteCardResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const metasoBase = (deps.metasoApiBase || process.env.METASO_API_BASE || METASO_DEFAULT_BASE).replace(/\/+$/, '');

  const rawQuery = normalizeQuery(input.query);
  if (!rawQuery) {
    throw new Error('token query is required for wallet_token_quote (e.g. "$METAID" or an asset_key).');
  }

  const budgetParsed = parseBudgetInput(input.budget, input.budgetUnit);

  let explicitMrc20Id: string | undefined;
  let explicitMvcCodehash: string | undefined;
  let explicitMvcGenesis: string | undefined;

  if (rawQuery.toLowerCase().startsWith('mrc20:')) {
    explicitMrc20Id = rawQuery.slice('mrc20:'.length).trim();
  } else if (/^[0-9a-f]{64}i\d+$/i.test(rawQuery)) {
    explicitMrc20Id = rawQuery.trim();
  } else if (rawQuery.toLowerCase().startsWith('mvc-ft:')) {
    const rest = rawQuery.slice('mvc-ft:'.length).trim();
    const [ch = '', gen = ''] = rest.split(':');
    explicitMvcCodehash = ch.trim().toLowerCase() || undefined;
    explicitMvcGenesis = gen.trim().toLowerCase() || undefined;
  }

  const isExplicitKey = Boolean(explicitMrc20Id || explicitMvcGenesis);
  const tickerCandidate = isExplicitKey ? '' : normalizeTicker(rawQuery);
  const explicitAssetKey = explicitMrc20Id
    ? `mrc20:${explicitMrc20Id}`
    : explicitMvcCodehash && explicitMvcGenesis
      ? `mvc-ft:${explicitMvcCodehash}:${explicitMvcGenesis}`
      : undefined;

  const [
    spotPrices,
    metaletMrc20Prices,
    metaletMvcFtPrices,
    mrc20WalletEntries,
    mvcFtWalletEntries,
    metaidMarketHit,
    metasoListingsJson,
  ] = await Promise.all([
    fetchCoinSpotPrices(fetchImpl, timeoutMs),
    fetchMetaletMrc20PriceMap(fetchImpl, timeoutMs),
    fetchMetaletMvcFtPriceMap(fetchImpl, timeoutMs),
    input.metabotId != null && deps.listMrc20s
      ? deps.listMrc20s({ metabotIds: [input.metabotId] }).catch(() => [])
      : Promise.resolve([]),
    input.metabotId != null && deps.listMvcFtTokens
      ? deps.listMvcFtTokens({ metabotIds: [input.metabotId] }).catch(() => [])
      : Promise.resolve([]),
    explicitMvcGenesis
      ? Promise.resolve(null)
      : fetchMetaidMarketToken(
          fetchImpl,
          explicitMrc20Id ? { tickId: explicitMrc20Id } : { tick: tickerCandidate },
          timeoutMs,
        ),
    fetchJsonWithTimeout<{ code?: number; data?: { list?: Record<string, unknown>[] } | Record<string, unknown>[] }>(
      fetchImpl,
      `${metasoBase}/api/ft/market/listings?${new URLSearchParams({
        ...(explicitAssetKey
          ? { assetKey: explicitAssetKey }
          : tickerCandidate
            ? { symbol: tickerCandidate }
            : {}),
        sort: 'unit_price_asc',
        cursor: '0',
        size: '50',
      }).toString()}`,
      timeoutMs,
    ),
  ]);

  const botMrc20Assets = mrc20WalletEntries[0]?.assets ?? [];
  const botMvcFtTokens = mvcFtWalletEntries[0]?.balance?.tokens ?? [];
  const localIssuances = deps.listIssuedTokens
    ? deps.listIssuedTokens({
        ...(explicitMvcCodehash && explicitMvcGenesis
          ? { assetKey: `mvc-ft:${explicitMvcCodehash}:${explicitMvcGenesis}` }
          : tickerCandidate
            ? { symbol: tickerCandidate }
            : {}),
        limit: 10,
      })
    : [];

  const curatedMrc20 = explicitMrc20Id
    ? metaletMrc20Prices.find((p) => p.mrc20Id.toLowerCase() === explicitMrc20Id!.toLowerCase())
    : metaletMrc20Prices.find((p) => p.symbol === tickerCandidate);
  const walletMrc20 = explicitMrc20Id
    ? botMrc20Assets.find((a) => a.mrc20Id.toLowerCase() === explicitMrc20Id!.toLowerCase())
    : botMrc20Assets.find((a) => a.symbol.trim().toUpperCase() === tickerCandidate);

  let mrc20Info: Partial<MetaidMarketRawInfo> | null = metaidMarketHit ? { ...metaidMarketHit } : null;
  let resolvedMrc20Id =
    mrc20Info?.mrc20Id || explicitMrc20Id || curatedMrc20?.mrc20Id || walletMrc20?.mrc20Id;

  if (!explicitMvcGenesis && !mrc20Info?.mrc20Id && (resolvedMrc20Id || tickerCandidate)) {
    const fallbackTick = await fetchMetaletMrc20TickInfo(
      fetchImpl,
      resolvedMrc20Id ? { tickId: resolvedMrc20Id } : { tick: tickerCandidate },
      timeoutMs,
    );
    if (fallbackTick?.mrc20Id) {
      mrc20Info = fallbackTick;
      resolvedMrc20Id = fallbackTick.mrc20Id;
    }
  }

  const walletMvc =
    explicitMvcCodehash && explicitMvcGenesis
      ? botMvcFtTokens.find(
          (t) =>
            t.codeHash.toLowerCase() === explicitMvcCodehash &&
            t.genesis.toLowerCase() === explicitMvcGenesis,
        )
      : botMvcFtTokens.find((t) => t.symbol.trim().toUpperCase() === tickerCandidate);
  const localMvc =
    explicitMvcCodehash && explicitMvcGenesis
      ? localIssuances.find(
          (r) =>
            r.codehash.toLowerCase() === explicitMvcCodehash &&
            r.genesis.toLowerCase() === explicitMvcGenesis,
        )
      : localIssuances.find((r) => r.tokenSymbol.trim().toUpperCase() === tickerCandidate);

  const resolvedMvcCodehash =
    explicitMvcCodehash || walletMvc?.codeHash?.toLowerCase() || localMvc?.codehash?.toLowerCase();
  const resolvedMvcGenesis =
    explicitMvcGenesis || walletMvc?.genesis?.toLowerCase() || localMvc?.genesis?.toLowerCase();
  const resolvedMvcAssetKey =
    resolvedMvcCodehash && resolvedMvcGenesis
      ? `mvc-ft:${resolvedMvcCodehash}:${resolvedMvcGenesis}`
      : undefined;

  const finalSymbol = (
    mrc20Info?.tick ||
    walletMrc20?.symbol ||
    walletMvc?.symbol ||
    localMvc?.tokenSymbol ||
    tickerCandidate ||
    'TOKEN'
  )
    .trim()
    .toUpperCase();

  // Fetch BTC PSBT orderbook + MetaSo verification in parallel when BTC leg exists
  const [btcOrdersJson, metasoVerify] = await Promise.all([
    resolvedMrc20Id
      ? fetchJsonWithTimeout<{ code?: number; data?: { list?: Record<string, unknown>[] } }>(
          fetchImpl,
          `${METAID_MARKET_BASE}/api/v1/market/mrc20/orders?${new URLSearchParams({
            assetType: 'mrc20',
            orderState: '1',
            tickId: resolvedMrc20Id,
            sortKey: 'tokenPriceRate',
            sortType: '1',
            cursor: '0',
            size: '50',
          }).toString()}`,
          timeoutMs,
        )
      : Promise.resolve(null),
    fetchMetasoFtVerification(
      fetchImpl,
      metasoBase,
      resolvedMrc20Id
        ? `mrc20:${resolvedMrc20Id}`
        : resolvedMvcAssetKey || explicitAssetKey || `symbol:${finalSymbol}`,
      finalSymbol,
      Math.min(timeoutMs, 2_500),
    ),
  ]);

  const rawMetasoList: Record<string, unknown>[] = Array.isArray(metasoListingsJson?.data)
    ? metasoListingsJson!.data
    : Array.isArray((metasoListingsJson?.data as { list?: unknown[] } | undefined)?.list)
      ? ((metasoListingsJson!.data as { list: Record<string, unknown>[] }).list ?? [])
      : Array.isArray((metasoListingsJson?.data as { items?: unknown[] } | undefined)?.items)
        ? ((metasoListingsJson!.data as { items: Record<string, unknown>[] }).items ?? [])
        : [];

  const allMetasoParsed = rawMetasoList.flatMap((item) => parseMetasoListingOrders(item, spotPrices));

  const isTrustedOrOfficial =
    Boolean(curatedMrc20) ||
    mrc20Info?.kind === 'idcoin' ||
    metasoVerify?.caVerified === true ||
    Boolean(metaletMvcFtPrices[finalSymbol]) ||
    (resolvedMvcGenesis ? Boolean(metaletMvcFtPrices[resolvedMvcGenesis.toUpperCase()]) : false);

  // Filter MetaSo listings so unverified copycat tickers never pollute a verified asset's quote
  const filteredMetasoOrders = allMetasoParsed.filter((o) => {
    const keyLower = o.assetKey.toLowerCase();
    if (explicitAssetKey) {
      return keyLower === explicitAssetKey.toLowerCase();
    }
    if (keyLower.startsWith('mrc20:')) {
      if (resolvedMrc20Id) return keyLower === `mrc20:${resolvedMrc20Id.toLowerCase()}`;
      return o.caVerified || !isTrustedOrOfficial;
    }
    if (keyLower.startsWith('mvc-ft:')) {
      if (resolvedMvcAssetKey && keyLower === resolvedMvcAssetKey.toLowerCase()) return true;
      const parts = keyLower.split(':');
      const genUpper = (parts[2] || '').toUpperCase();
      if (o.caVerified || (genUpper && metaletMvcFtPrices[genUpper])) return true;
      return !isTrustedOrOfficial;
    }
    return !isTrustedOrOfficial;
  });

  const caVerified =
    isTrustedOrOfficial || filteredMetasoOrders.some((o) => o.caVerified);

  const hasMvcPeerInListings = filteredMetasoOrders.some((o) =>
    o.assetKey.toLowerCase().startsWith('mvc-ft:'),
  );
  const hasMvcLeg =
    Boolean(resolvedMvcAssetKey) ||
    hasMvcPeerInListings ||
    Boolean(metaletMvcFtPrices[finalSymbol]) ||
    KNOWN_BRIDGED_FT_SYMBOLS.has(finalSymbol) ||
    input.chain === 'mvc';
  const hasBtcLeg = Boolean(resolvedMrc20Id) || filteredMetasoOrders.some((o) => o.assetKey.toLowerCase().startsWith('mrc20:'));

  if (!hasBtcLeg && !hasMvcLeg && filteredMetasoOrders.length === 0) {
    throw new Error(
      `Token "${rawQuery}" could not be resolved on BTC (MRC-20 / ID-Coin) or MVC (MetaContract FT). ` +
        'Pass a canonical asset_key ("mrc20:<id>" or "mvc-ft:<codehash>:<genesis>") if it is a newly issued unindexed token.',
    );
  }

  const bridgedDualChain = hasBtcLeg && hasMvcLeg;
  const primaryAssetKey =
    explicitAssetKey ||
    (input.chain === 'mvc' && resolvedMvcAssetKey
      ? resolvedMvcAssetKey
      : resolvedMrc20Id
        ? `mrc20:${resolvedMrc20Id}`
        : resolvedMvcAssetKey || filteredMetasoOrders[0]?.assetKey || `symbol:${finalSymbol}`);

  const btcDecimals = mrc20Info?.decimals ?? walletMrc20?.decimal ?? 8;
  const btcOrders: ParsedQuoteOrder[] = ((btcOrdersJson?.data?.list ?? []) as Record<string, unknown>[])
    .map((r) =>
      parseBtcMarketOrderItem(
        r,
        resolvedMrc20Id ? `mrc20:${resolvedMrc20Id}` : primaryAssetKey,
        finalSymbol,
        btcDecimals,
        caVerified,
        spotPrices.btcUsd,
      ),
    )
    .filter((x): x is ParsedQuoteOrder => Boolean(x))
    .sort((a, b) => a.unitPriceMain - b.unitPriceMain);

  const mvcOrders = filteredMetasoOrders
    .filter((o) => o.rail === 'mvc-tokensell')
    .sort((a, b) => a.unitPriceMain - b.unitPriceMain);

  const meOrders = filteredMetasoOrders
    .filter((o) => o.rail === 'me-escrow' && o.sellerOnline)
    .sort((a, b) => a.unitPriceMain - b.unitPriceMain);

  // Build Quote Rows
  const quotes: FtQuoteRow[] = [];

  if (hasBtcLeg) {
    const totalDepth = btcOrders.reduce((s, o) => s + o.amountDisplayNum, 0);
    const floorOrder = btcOrders[0];
    const floorHeadline = floorOrder ? formatSatsHeadline(floorOrder.unitPriceMain) : null;
    quotes.push({
      rail: 'btc-psbt',
      label: 'BTC PSBT 订单簿',
      floorUnit: floorHeadline ? `${floorHeadline.main} ${floorHeadline.unit}` : '暂无挂单',
      depthDisplay:
        btcOrders.length > 0
          ? `${formatTokenAmountDisplay(totalDepth, 4)} ${finalSymbol} (${btcOrders.length} 单)`
          : `0 ${finalSymbol} (0 单)`,
      status: 'active',
      ...(floorOrder?.unitUsd ? { usdHint: formatUsdPrice(floorOrder.unitUsd) } : {}),
      chainStandardHint: mrc20Info?.kind === 'idcoin' ? 'BTC · ID-Coins (MRC-20)' : 'BTC · MRC-20',
      subMeta:
        floorOrder
          ? `最小单 ${floorOrder.amountDisplayStr} ${finalSymbol} (${Math.round(floorOrder.lotTotalNative).toLocaleString('en-US')} sats)`
          : 'BTC L1 原子化 PSBT 撮合',
    });
  }

  if (hasMvcLeg) {
    const totalDepth = mvcOrders.reduce((s, o) => s + o.amountDisplayNum, 0);
    const floorOrder = mvcOrders[0];
    quotes.push({
      rail: 'mvc-tokensell',
      label: 'MVC TokenSell 合约单',
      floorUnit: floorOrder
        ? `${formatTokenAmountDisplay(floorOrder.unitPriceMain.toFixed(8), 6)} SPACE`
        : '暂无挂单',
      depthDisplay:
        mvcOrders.length > 0
          ? `${formatTokenAmountDisplay(totalDepth, 4)} ${finalSymbol} (${mvcOrders.length} 单)`
          : `0 ${finalSymbol} (0 单)`,
      status: 'active',
      ...(floorOrder?.unitUsd ? { usdHint: formatUsdPrice(floorOrder.unitUsd) } : {}),
      chainStandardHint: 'MVC · MetaContract FT',
      subMeta: floorOrder
        ? `最小单 ${floorOrder.amountDisplayStr} ${finalSymbol} (${formatTokenAmountDisplay((floorOrder.lotTotalNative / SATOSHI_PER_COIN).toFixed(8), 6)} SPACE)`
        : 'MVC 链上自托管合约 (极低 Gas)',
    });
  }

  {
    const totalDepth = meOrders.reduce((s, o) => s + o.amountDisplayNum, 0);
    const floorOrder = meOrders[0];
    quotes.push({
      rail: 'me-escrow',
      label: 'ME 能量点担保单',
      floorUnit: floorOrder
        ? `${formatTokenAmountDisplay(floorOrder.unitPriceMain.toFixed(4), 4)} ME`
        : '暂无在线挂单',
      depthDisplay:
        meOrders.length > 0
          ? `${formatTokenAmountDisplay(totalDepth, 4)} ${finalSymbol} (${meOrders.length} 单)`
          : `0 ${finalSymbol} (0 单)`,
      status: 'active',
      chainStandardHint: bridgedDualChain
        ? 'BTC / MVC · 平台担保免 BTC Gas'
        : hasMvcLeg && !hasBtcLeg
          ? 'MVC · 平台担保'
          : 'BTC · 平台担保免 BTC Gas',
      subMeta: floorOrder
        ? `最小单 ${floorOrder.amountDisplayStr} ${finalSymbol} (${formatTokenAmountDisplay(floorOrder.lotTotalNative, 3)} ME)`
        : '消耗 ME 能量点购买在线卖家挂单',
    });
  }

  if (hasMvcLeg) {
    quotes.push({
      rail: 'mvc-swap',
      label: 'MVCSwap 流动性池',
      floorUnit: '—',
      depthDisplay: '0',
      status: 'coming_soon',
      chainStandardHint: 'MVC · AMM Pool',
      subMeta: 'AMM 自动做市池即将接入',
    });
  }

  // Choose recommended rail + build budget sweep suggestion
  let recommendedRail: FtCardRail | undefined;
  const suggestionParts: string[] = [];

  if (budgetParsed.amount && budgetParsed.unit === 'me') {
    if (meOrders.length > 0) {
      const sim = simulateLotSweep(meOrders, budgetParsed.amount);
      if (sim.sweptLots > 0) {
        recommendedRail = 'me-escrow';
        const avgMe = sim.spentNative / sim.sweptTokens;
        suggestionParts.push(
          `${budgetParsed.label} 预算可在 ME 担保渠道扫入 ${sim.sweptLots} 单，共约 ${formatTokenAmountDisplay(sim.sweptTokens, 4)} ${finalSymbol}（花费 ${formatTokenAmountDisplay(sim.spentNative, 3)} ME，均价 ≈ ${formatTokenAmountDisplay(avgMe, 3)} ME/${finalSymbol}，免 BTC Gas）。`,
        );
        if (sim.sweptLots === meOrders.length && sim.spentNative < budgetParsed.amount) {
          suggestionParts.push(
            `当前在线 ME 挂单深度仅 ${meOrders.length} 单（剩余预算无需动用），大额建仓可搭配 BTC PSBT 订单簿（${btcOrders.length} 单深池）。`,
          );
        }
      } else {
        suggestionParts.push(
          `当前最便宜的在线 ME 挂单整包总价为 ${formatTokenAmountDisplay(meOrders[0].lotTotalNative, 3)} ME（超出 ${budgetParsed.label} 预算，FT 挂单按整包成交）。`,
        );
      }
    } else {
      suggestionParts.push(
        `当前 ME 能量点担保渠道暂无在线 $${finalSymbol} 挂单；若改用 BTC 或 SPACE，可走链上订单簿成交。`,
      );
    }
  } else if (budgetParsed.amount && budgetParsed.unit === 'space') {
    if (mvcOrders.length > 0) {
      const sim = simulateLotSweep(mvcOrders, budgetParsed.amount * SATOSHI_PER_COIN);
      if (sim.sweptLots > 0) {
        recommendedRail = 'mvc-tokensell';
        const spentSpace = sim.spentNative / SATOSHI_PER_COIN;
        suggestionParts.push(
          `${budgetParsed.label} 预算可在 MVC TokenSell 扫入 ${sim.sweptLots} 单，共约 ${formatTokenAmountDisplay(sim.sweptTokens, 4)} ${finalSymbol}（花费 ${formatTokenAmountDisplay(spentSpace, 6)} SPACE）。`,
        );
      }
    }
  } else if (budgetParsed.amount && (budgetParsed.unit === 'btc' || budgetParsed.unit === 'sats')) {
    const budgetSats =
      budgetParsed.unit === 'btc' ? budgetParsed.amount * SATOSHI_PER_COIN : budgetParsed.amount;
    if (btcOrders.length > 0) {
      const sim = simulateLotSweep(btcOrders, budgetSats);
      if (sim.sweptLots > 0) {
        recommendedRail = 'btc-psbt';
        suggestionParts.push(
          `${budgetParsed.label} 预算可在 BTC PSBT 订单簿扫入 ${sim.sweptLots} 单，共约 ${formatTokenAmountDisplay(sim.sweptTokens, 4)} ${finalSymbol}（订单总价 ${Math.round(sim.spentNative).toLocaleString('en-US')} sats，另需 BTC 矿工费）。`,
        );
      }
    }
  }

  // Fallback recommended rail: lowest USD unit price among active rails, else deepest rail
  if (!recommendedRail) {
    const usdCandidates: Array<{ rail: FtCardRail; usd: number }> = [];
    if (btcOrders[0]?.unitUsd) usdCandidates.push({ rail: 'btc-psbt', usd: btcOrders[0].unitUsd });
    if (mvcOrders[0]?.unitUsd) usdCandidates.push({ rail: 'mvc-tokensell', usd: mvcOrders[0].unitUsd });
    if (usdCandidates.length > 0) {
      usdCandidates.sort((a, b) => a.usd - b.usd);
      recommendedRail = usdCandidates[0].rail;
    } else if (meOrders.length > 0) {
      recommendedRail = 'me-escrow';
    } else if (btcOrders.length > 0) {
      recommendedRail = 'btc-psbt';
    } else if (mvcOrders.length > 0) {
      recommendedRail = 'mvc-tokensell';
    }
  }

  if (recommendedRail) {
    for (const q of quotes) {
      if (q.rail === recommendedRail) {
        q.recommended = true;
        break;
      }
    }
  }

  if (suggestionParts.length === 0) {
    if (btcOrders.length > 0 && meOrders.length > 0) {
      suggestionParts.push(
        `小额免 BTC Gas 可优先选 ME 能量点担保单（${meOrders.length} 单在线）；大额扫货深度建议走 BTC PSBT 订单簿（${btcOrders.length} 单在售）。`,
      );
    } else if (btcOrders.length > 0) {
      suggestionParts.push(
        `当前流动性集中在 BTC PSBT 订单簿（共 ${btcOrders.length} 单在售），可直接按地板价吃单。`,
      );
    } else if (mvcOrders.length > 0) {
      suggestionParts.push(
        `当前 MVC TokenSell 有 ${mvcOrders.length} 单链上合约挂单，可直接用 SPACE 低 Gas 成交。`,
      );
    } else if (meOrders.length > 0) {
      suggestionParts.push(
        `当前 ME 能量点担保渠道有 ${meOrders.length} 单在线挂单，支持 0 BTC Gas 快速成交。`,
      );
    } else {
      suggestionParts.push(`当前各渠道暂无活跃卖单。`);
    }
  }

  const icon = sanitizeTokenIconUrl(mrc20Info?.icon ?? walletMrc20?.icon);
  const card: FtQuoteCardData = {
    assetKey: primaryAssetKey,
    symbol: finalSymbol,
    caVerified,
    quotes,
    ...(budgetParsed.label ? { budgetLabel: budgetParsed.label } : {}),
    ...(suggestionParts.length > 0 ? { suggestion: suggestionParts.join(' ') } : {}),
    ...(bridgedDualChain ? { bridgedDualChain: true } : {}),
    ...(icon ? { icon } : {}),
  };

  const fence = formatFtQuoteCardFence(card);
  const summaryLines = [
    `Multi-Rail FT Quote Card ready: $${finalSymbol} [${primaryAssetKey}] (caVerified=${caVerified}, bridgedDualChain=${bridgedDualChain})`,
    ...quotes.map(
      (q) =>
        `- ${q.label} (${q.rail}): floor=${q.floorUnit}${q.usdHint ? ` (${q.usdHint})` : ''}, depth=${q.depthDisplay}${q.recommended ? ' [RECOMMENDED]' : ''}`,
    ),
    ...(card.suggestion ? [`- Suggestion: ${card.suggestion}`] : []),
    '',
    'IMPORTANT PRESENTATION RULE:',
    '1. Include the ```ft-quote-card fenced block below VERBATIM in your reply. The UI renders it as a native 4-rail Quote Comparison Card.',
    '2. Do NOT duplicate the rail floor prices and depths as a Markdown table or long bullet list. Add at most 1-2 short natural sentences of recommendation or ask if the user wants to execute.',
    '',
    fence,
  ];

  return {
    card,
    fence,
    summaryText: summaryLines.join('\n'),
  };
}

export interface FetchLiveFtSellerOrdersInput {
  metabotId?: number;
  btcAddress?: string;
  mvcAddress?: string;
  symbol?: string;
  rail?: FtCardRail;
}

/**
 * Fetch open seller orders from live external venues (`metaid.market` BTC MRC-20
 * PSBT orderbook + MetaSo `/api/ft/market/listings` for MVC TokenSell & ME Escrow)
 * so `wallet_token_my_orders` (`O1`) shows orders even when placed outside the
 * local SQLite `ft_active_orders` ledger.
 */
export async function fetchLiveFtSellerOrders(
  input: FetchLiveFtSellerOrdersInput,
  deps: Pick<TokenCardServiceDeps, 'fetchImpl' | 'httpTimeoutMs' | 'metasoApiBase'> = {},
): Promise<{ items: FtMyOrderItem[]; mvcSatsTotal: number; meTotal: number; btcSatsTotal: number }> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.httpTimeoutMs ?? 3_500;
  const metasoBase = (deps.metasoApiBase || process.env.METASO_API_BASE || METASO_DEFAULT_BASE).replace(/\/+$/, '');
  const symFilter = input.symbol ? normalizeTicker(input.symbol) : '';
  const railFilter = input.rail;

  const btcAddress = String(input.btcAddress || '').trim();
  const mvcAddress = String(input.mvcAddress || '').trim();

  const wantBtcPsbt = !railFilter || railFilter === 'btc-psbt';
  const wantMetaso = !railFilter || railFilter === 'mvc-tokensell' || railFilter === 'me-escrow';

  const sellerAddresses = Array.from(new Set([mvcAddress, btcAddress].filter(Boolean)));

  const [btcOrdersJson, ...metasoSellerJsons] = await Promise.all([
    wantBtcPsbt && btcAddress
      ? fetchJsonWithTimeout<{ code?: number; data?: { list?: Record<string, unknown>[] } }>(
          fetchImpl,
          `${METAID_MARKET_BASE}/api/v1/market/mrc20/orders?${new URLSearchParams({
            assetType: 'mrc20',
            orderState: '1',
            address: btcAddress,
            sortKey: 'tokenPriceRate',
            sortType: '1',
            cursor: '0',
            size: '50',
          }).toString()}`,
          timeoutMs,
        )
      : Promise.resolve(null),
    ...(wantMetaso
      ? sellerAddresses.map((seller) =>
          fetchJsonWithTimeout<{
            code?: number;
            data?: { list?: Record<string, unknown>[] } | Record<string, unknown>[];
          }>(
            fetchImpl,
            `${metasoBase}/api/ft/market/listings?${new URLSearchParams({
              seller,
              size: '50',
            }).toString()}`,
            timeoutMs,
          ),
        )
      : []),
  ]);

  const items: FtMyOrderItem[] = [];
  let mvcSatsTotal = 0;
  let meTotal = 0;
  let btcSatsTotal = 0;
  const seenKeys = new Set<string>();

  for (const rawRow of (btcOrdersJson?.data?.list ?? []) as Record<string, unknown>[]) {
    const parsed = parseBtcMarketOrderItem(rawRow, 'mrc20:unknown', 'TOKEN', 8, true);
    if (!parsed) continue;
    if (symFilter && parsed.symbol !== symFilter) continue;
    const dedupKey = `btc-psbt:${parsed.orderId || parsed.utxoOutpoint || ''}`;
    if (seenKeys.has(dedupKey)) continue;
    seenKeys.add(dedupKey);
    btcSatsTotal += parsed.lotTotalNative;
    const unitHeadline = formatSatsHeadline(parsed.unitPriceMain);
    items.push({
      id: parsed.orderId || parsed.utxoOutpoint || `btc-${items.length}`,
      assetKey: parsed.assetKey,
      symbol: parsed.symbol,
      caVerified: parsed.caVerified,
      rail: 'btc-psbt',
      unitPriceLabel: `${unitHeadline.main} ${unitHeadline.unit} (${Math.round(parsed.lotTotalNative).toLocaleString('en-US')} sats/单)`,
      lotSummaryText: `1/1 份 · ${parsed.amountDisplayStr} ${parsed.symbol}`,
      filledLots: 0,
      totalLots: 1,
      ...(parsed.sellPriceSats ? { sellPriceSats: parsed.sellPriceSats } : {}),
      ...(parsed.sellerAddress ? { sellerAddress: parsed.sellerAddress } : {}),
    });
  }

  for (const metasoJson of metasoSellerJsons) {
    const list: Record<string, unknown>[] = Array.isArray(metasoJson?.data)
      ? metasoJson!.data
      : Array.isArray((metasoJson?.data as { list?: unknown[] } | undefined)?.list)
        ? ((metasoJson!.data as { list: Record<string, unknown>[] }).list ?? [])
        : Array.isArray((metasoJson?.data as { items?: unknown[] } | undefined)?.items)
          ? ((metasoJson!.data as { items: Record<string, unknown>[] }).items ?? [])
          : [];
    for (const rawListing of list) {
      for (const parsed of parseMetasoListingOrders(rawListing, {})) {
        if (railFilter && parsed.rail !== railFilter) continue;
        if (symFilter && parsed.symbol !== symFilter) continue;
        const dedupKey = `${parsed.rail}:${parsed.orderId || parsed.utxoOutpoint || ''}`;
        if (seenKeys.has(dedupKey)) continue;
        seenKeys.add(dedupKey);

        if (parsed.rail === 'mvc-tokensell') {
          mvcSatsTotal += parsed.lotTotalNative;
          const lotSpace = formatTokenAmountDisplay((parsed.lotTotalNative / SATOSHI_PER_COIN).toFixed(8), 6);
          const unitSpace = formatTokenAmountDisplay(parsed.unitPriceMain.toFixed(8), 6);
          items.push({
            id: parsed.orderId || parsed.utxoOutpoint || `mvc-${items.length}`,
            ...(parsed.batchGroupId ? { batchGroupId: parsed.batchGroupId } : {}),
            assetKey: parsed.assetKey,
            symbol: parsed.symbol,
            caVerified: parsed.caVerified,
            rail: 'mvc-tokensell',
            unitPriceLabel:
              parsed.amountDisplayNum === 1
                ? `${lotSpace} SPACE`
                : `${unitSpace} SPACE / ${parsed.symbol} (${lotSpace} SPACE)`,
            lotSummaryText: `1/1 份 · ${parsed.amountDisplayStr} ${parsed.symbol}`,
            filledLots: 0,
            totalLots: 1,
            ...(parsed.sellTxid ? { sellTxid: parsed.sellTxid } : {}),
            ...(parsed.sellOutputIndex !== undefined ? { sellOutputIndex: parsed.sellOutputIndex } : {}),
            ...(parsed.sellPriceSats ? { sellPriceSats: parsed.sellPriceSats } : {}),
            ...(parsed.sellerAddress ? { sellerAddress: parsed.sellerAddress } : {}),
          });
        } else if (parsed.rail === 'me-escrow') {
          meTotal += parsed.lotTotalNative;
          const lotMe = formatTokenAmountDisplay(parsed.lotTotalNative, 3);
          const unitMe = formatTokenAmountDisplay(parsed.unitPriceMain, 3);
          items.push({
            id: parsed.orderId || parsed.utxoOutpoint || `me-${items.length}`,
            ...(parsed.batchGroupId ? { batchGroupId: parsed.batchGroupId } : {}),
            assetKey: parsed.assetKey,
            symbol: parsed.symbol,
            caVerified: parsed.caVerified,
            rail: 'me-escrow',
            unitPriceLabel:
              parsed.amountDisplayNum === 1
                ? `${lotMe} ME`
                : `${unitMe} ME / ${parsed.symbol} (${lotMe} ME)`,
            lotSummaryText: `1/1 份 · ${parsed.amountDisplayStr} ${parsed.symbol}`,
            filledLots: 0,
            totalLots: 1,
            ...(parsed.sellerAddress ? { sellerAddress: parsed.sellerAddress } : {}),
          });
        }
      }
    }
  }

  return { items, mvcSatsTotal, meTotal, btcSatsTotal };
}

