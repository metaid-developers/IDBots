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

const METAID_MARKET_BASE = 'https://api.metaid.market/api-market';
const METALET_HOST = 'https://www.metalet.space';
const METASO_DEFAULT_BASE = 'https://so.metaid.io';
const SATOSHI_PER_COIN = 100_000_000;
const DEFAULT_HTTP_TIMEOUT_MS = 4_500;

export interface TokenCardMetabotSummary {
  id: number;
  name: string;
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
        botBalDec = new Decimal(walletMvcMatch.balance).div(
          new Decimal(10).pow(mvcContractInfo.decimals),
        );
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
