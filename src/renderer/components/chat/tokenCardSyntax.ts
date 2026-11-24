/**
 * tokenCardSyntax — DOM-free parser, validator, anti-spoofing badge formatter,
 * serializer, and standalone-bubble markdown splitter for `token-card` blocks.
 *
 * Shared across Electron main (`tokenCardService`, `walletAgentTools`,
 * `nftCardTurnBackstop`), Desktop renderer (`TokenCard`, `MarkdownContent`,
 * `CoworkSessionDetail`, `BotBrowserCoworkPanel`), and Cloud Mobile (`ChatScreen`).
 */

import {
  isAnyFtSuiteFenceLanguage,
  isFtActionCardFenceLanguage,
  isFtBridgeCardFenceLanguage,
  isFtFillCardFenceLanguage,
  isFtMyOrdersCardFenceLanguage,
  isFtOrderCardFenceLanguage,
  isFtPortfolioCardFenceLanguage,
  isFtQuoteCardFenceLanguage,
  parseFtActionCardFence,
  parseFtBridgeCardFence,
  parseFtFillCardFence,
  parseFtMyOrdersCardFence,
  parseFtOrderCardFence,
  parseFtPortfolioCardFence,
  parseFtQuoteCardFence,
  type FtActionCardData,
  type FtBridgeCardData,
  type FtFillCardData,
  type FtMyOrdersCardData,
  type FtOrderCardData,
  type FtPortfolioCardData,
  type FtQuoteCardData,
} from './ftCardSyntax';
import {
  isNftCardFenceLanguage,
  isNftCardGroupFenceLanguage,
  isNftCollectionCardFenceLanguage,
  parseNftCardFence,
  parseNftCardGroupFence,
  parseNftCollectionCardFence,
  type NftCardData,
  type NftCollectionCardData,
} from './nftCardSyntax';
import {
  isAnyNftSuiteFenceLanguage,
  isNftActionCardFenceLanguage,
  isNftFillCardFenceLanguage,
  isNftListingCardFenceLanguage,
  isNftMyListingsCardFenceLanguage,
  isNftNegotiateCardFenceLanguage,
  isNftPortfolioCardFenceLanguage,
  isNftSwapCardFenceLanguage,
  parseNftActionCardFence,
  parseNftFillCardFence,
  parseNftListingCardFence,
  parseNftMyListingsCardFence,
  parseNftNegotiateCardFence,
  parseNftPortfolioCardFence,
  parseNftSwapCardFence,
  type NftActionCardData,
  type NftFillCardData,
  type NftListingCardData,
  type NftMyListingsCardData,
  type NftNegotiateCardData,
  type NftPortfolioCardData,
  type NftSwapCardData,
} from './nftSuiteSyntax';
import {
  isEscrowCardFenceLanguage,
  parseEscrowCardFence,
  type EscrowCardData,
} from './escrowCardCore';

export const TOKEN_CARD_FENCE_TAG = 'token-card';

const TOKEN_CARD_FENCE_TAGS = new Set(['token-card', 'tokencard']);

export type TokenCardMode = 'simple' | 'detailed';
export type TokenCardChain = 'btc' | 'mvc' | 'doge';
export type TokenCardStandard = 'idcoin' | 'mrc20' | 'mvc-ft' | 'native';
export type TokenCardChangeDir = 'up' | 'down' | 'flat';
export type TokenCardQuickAction = 'orders' | 'trades' | 'trade';

const VALID_MODES = new Set<TokenCardMode>(['simple', 'detailed']);
const VALID_CHAINS = new Set<TokenCardChain>(['btc', 'mvc', 'doge']);
const VALID_STANDARDS = new Set<TokenCardStandard>(['idcoin', 'mrc20', 'mvc-ft', 'native']);
const VALID_CHANGE_DIRS = new Set<TokenCardChangeDir>(['up', 'down', 'flat']);
const VALID_QUICK_ACTIONS = new Set<TokenCardQuickAction>(['orders', 'trades', 'trade']);

export interface TokenCardData {
  mode: TokenCardMode;
  symbol: string;
  name?: string;
  chain: TokenCardChain;
  standard: TokenCardStandard;
  /** Canonical asset identifier: `mrc20:<mrc20Id>`, `mvc-ft:<codehash>:<genesis>`, or `native:<chain>`. */
  assetKey: string;
  /** True for native L1 coins or verified canonical tokens; false triggers anti-spoofing short-ID warning badge. */
  caVerified: boolean;
  /** Optional token avatar (`https://...` or `metafile://<pinId>`). */
  icon?: string;
  /** Snapshot timestamp (ISO-8601) for detailed card header. */
  snapshotAt?: string;

  /** Primary display price value, e.g. `"970"`, `"0.0042"`, `"$60,632.23"`, `"—"`. */
  priceMain: string;
  /** Unit suffix next to `priceMain`, e.g. `"sat"`, `"SPACE"`, `"USD"`. */
  priceUnit?: string;
  /** Native chain conversion text, e.g. `"≈ 0.0000097 BTC"`. */
  priceNativeText?: string;
  /** USD conversion text, e.g. `"$0.590"`. */
  priceUsdText?: string;
  /** 24h percentage change display, e.g. `"+7.77%"`, `"-4.32%"`. */
  change24h?: string;
  /** Trend direction (`"up" | "down" | "flat"`). */
  changeDir?: TokenCardChangeDir;

  // ----- Detailed mode market & on-chain metrics -----
  /** Floor listing price, e.g. `"1,580 sat"`, `"0.0040 SPACE"`. */
  floorPriceText?: string;
  /** Floor USD conversion, e.g. `"$0.961"`. */
  floorUsdText?: string;
  /** Signed percentage spread of market price vs floor (`(market - floor) / floor * 100`). */
  marketVsFloorPct?: number;

  /** Market cap headline, e.g. `"48.5 BTC"`. */
  marketCapMain?: string;
  /** Market cap numeric USD value for locale-aware compact formatting. */
  marketCapUsd?: number;
  /** Optional explicit subtitle override under Market Cap. */
  marketCapSubText?: string;

  /** Cumulative volume headline, e.g. `"7.615 BTC"`. */
  volumeMain?: string;
  /** Cumulative volume numeric USD value for locale-aware compact formatting. */
  volumeUsd?: number;
  /** Optional explicit subtitle override under Volume (e.g. token volume or tx count). */
  volumeSubText?: string;

  /** On-chain holder address count. */
  holdersCount?: number;
  /** Follower count (for ID-Coins). */
  followersCount?: number;
  /** Optional transfer/activity count. */
  txCount?: number;

  /** Supply headline, e.g. `"5,000,000"` or `"6.2M / 10M"`. */
  supplyMain?: string;
  /** Mint progress `0..100` when supply cap is known. */
  mintProgressPct?: number;
  /** Whether additional supply can still be minted (`true`) or is permanently locked (`false`). */
  mintable?: boolean;

  // ----- Current Bot wallet holding -----
  botName?: string;
  /** Formatted token holding of the active Bot wallet, e.g. `"1,250 METAID"` or `"0 METAID"`. */
  botBalanceText: string;
  /** True when the Bot currently holds 0 of this asset. */
  botZeroHolding?: boolean;
  /** Formatted USD valuation of the Bot's holding, e.g. `"≈ $737.50"`. */
  botBalanceUsdText?: string;

  /** Quick follow-up chips shown at the bottom of `detailed` cards. */
  quickActions?: TokenCardQuickAction[];
}

export type TokenCardMessageSegment =
  | { kind: 'markdown'; content: string }
  | { kind: 'token-card'; data: TokenCardData; rawFence: string }
  | { kind: 'ft-order-card'; data: FtOrderCardData; rawFence: string }
  | { kind: 'ft-quote-card'; data: FtQuoteCardData; rawFence: string }
  | { kind: 'ft-fill-card'; data: FtFillCardData; rawFence: string }
  | { kind: 'ft-my-orders-card'; data: FtMyOrdersCardData; rawFence: string }
  | { kind: 'ft-portfolio-card'; data: FtPortfolioCardData; rawFence: string }
  | { kind: 'ft-bridge-card'; data: FtBridgeCardData; rawFence: string }
  | { kind: 'ft-action-card'; data: FtActionCardData; rawFence: string }
  | { kind: 'nft-card'; data: NftCardData; rawFence: string }
  | { kind: 'nft-card-group'; data: NftCardData[]; rawFence: string }
  | { kind: 'nft-collection-card'; data: NftCollectionCardData; rawFence: string }
  | { kind: 'nft-listing-card'; data: NftListingCardData; rawFence: string }
  | { kind: 'nft-fill-card'; data: NftFillCardData; rawFence: string }
  | { kind: 'nft-my-listings-card'; data: NftMyListingsCardData; rawFence: string }
  | { kind: 'nft-portfolio-card'; data: NftPortfolioCardData; rawFence: string }
  | { kind: 'nft-swap-card'; data: NftSwapCardData; rawFence: string }
  | { kind: 'nft-action-card'; data: NftActionCardData; rawFence: string }
  | { kind: 'nft-negotiate-card'; data: NftNegotiateCardData; rawFence: string }
  | { kind: 'escrow-card'; data: EscrowCardData; rawFence: string }
  | { kind: 'token-card-streaming' };

function cleanStr(val: unknown, maxLen = 160): string {
  if (typeof val !== 'string') return '';
  return val.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
}

function cleanSymbol(val: unknown): string {
  const raw = cleanStr(val, 32).replace(/^\$+/, '').trim();
  return raw;
}

function cleanOptionalNumber(val: unknown): number | undefined {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  if (typeof val === 'string' && val.trim() !== '') {
    const parsed = Number(val);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function cleanOptionalNonNegInt(val: unknown): number | undefined {
  const num = cleanOptionalNumber(val);
  if (num === undefined || num < 0) return undefined;
  return Math.floor(num);
}

/**
 * Normalizes safe icon references (`https://...`, `metafile://<pinId>`, or
 * `/content/<pinId>` from `api.metaid.market` deployerUserInfo.avatar).
 */
export function sanitizeTokenIconUrl(raw: unknown): string | undefined {
  const text = cleanStr(raw, 400);
  if (!text) return undefined;
  if (/^https:\/\/[^\s"'<>]+$/i.test(text)) return text;
  if (/^metafile:\/\/[A-Za-z0-9._-]+$/i.test(text)) return text;
  const contentMatch = text.match(/^\/content\/([0-9a-fA-F]{64}i\d+)$/);
  if (contentMatch) {
    return `metafile://${contentMatch[1]}`;
  }
  return undefined;
}

export function isTokenCardFenceLanguage(lang: string | undefined | null): boolean {
  return TOKEN_CARD_FENCE_TAGS.has(String(lang ?? '').trim().toLowerCase());
}

/**
 * Formats a compact anti-spoofing short ID from canonical `assetKey`:
 * - `mrc20:8ce59091...8b78f4i0` -> `8ce590…78f4i0`
 * - `mvc-ft:a242...005d:49c1...e210` -> `a242:49c1…e210`
 * - `native:btc` -> `Native L1`
 */
export function formatTokenAssetShortId(assetKey: string): string {
  const raw = cleanStr(assetKey, 220);
  if (!raw) return 'unknown';
  if (raw.startsWith('native:')) {
    return `${raw.slice('native:'.length).toUpperCase()} Native`;
  }
  if (raw.startsWith('mrc20:')) {
    const id = raw.slice('mrc20:'.length);
    if (id.length <= 14) return id;
    return `${id.slice(0, 6)}…${id.slice(-6)}`;
  }
  if (raw.startsWith('mvc-ft:')) {
    const rest = raw.slice('mvc-ft:'.length);
    const [codehash = '', genesis = ''] = rest.split(':');
    const shortCode = codehash.length > 4 ? codehash.slice(0, 4) : codehash;
    const shortGen = genesis.length > 10 ? `${genesis.slice(0, 4)}…${genesis.slice(-4)}` : genesis;
    return shortCode && shortGen ? `${shortCode}:${shortGen}` : rest.slice(0, 14);
  }
  return raw.length > 14 ? `${raw.slice(0, 6)}…${raw.slice(-6)}` : raw;
}

export function formatTokenStandardLabel(chain: TokenCardChain, standard: TokenCardStandard): string {
  const chainUpper = chain.toUpperCase();
  if (standard === 'idcoin') return `${chainUpper} · ID-Coin`;
  if (standard === 'mrc20') return `${chainUpper} · MRC-20`;
  if (standard === 'mvc-ft') return `${chainUpper} · MCP02`;
  return `${chainUpper} · Native`;
}

export function deriveChangeDir(change24h: string | undefined): TokenCardChangeDir | undefined {
  if (!change24h) return undefined;
  const trimmed = change24h.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed.replace(/[+%$,\s]/g, ''));
  if (Number.isFinite(numeric)) {
    if (numeric > 0.0001) return 'up';
    if (numeric < -0.0001) return 'down';
    return 'flat';
  }
  if (trimmed.startsWith('-')) return 'down';
  if (trimmed.startsWith('+')) return 'up';
  return 'flat';
}

export function parseTokenCardFence(raw: string): TokenCardData | null {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim()) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;

    const modeRaw = cleanStr(obj.mode, 16).toLowerCase() as TokenCardMode;
    const mode: TokenCardMode = VALID_MODES.has(modeRaw) ? modeRaw : 'simple';

    const symbol = cleanSymbol(obj.symbol);
    const chain = cleanStr(obj.chain, 12).toLowerCase() as TokenCardChain;
    const standard = cleanStr(obj.standard, 16).toLowerCase() as TokenCardStandard;
    const assetKey = cleanStr(obj.assetKey, 220);
    const priceMain = cleanStr(obj.priceMain, 64);
    const botBalanceText = cleanStr(obj.botBalanceText, 80);

    if (!symbol || !VALID_CHAINS.has(chain) || !VALID_STANDARDS.has(standard)) return null;
    if (!assetKey || !priceMain || !botBalanceText) return null;

    const name = cleanStr(obj.name, 64);
    const icon = sanitizeTokenIconUrl(obj.icon);
    const snapshotAt = cleanStr(obj.snapshotAt, 48);
    const priceUnit = cleanStr(obj.priceUnit, 24);
    const priceNativeText = cleanStr(obj.priceNativeText, 64);
    const priceUsdText = cleanStr(obj.priceUsdText, 48);
    const change24h = cleanStr(obj.change24h, 24);
    const explicitDir = cleanStr(obj.changeDir, 12).toLowerCase() as TokenCardChangeDir;
    const changeDir = VALID_CHANGE_DIRS.has(explicitDir)
      ? explicitDir
      : deriveChangeDir(change24h);

    const floorPriceText = cleanStr(obj.floorPriceText, 64);
    const floorUsdText = cleanStr(obj.floorUsdText, 48);
    const marketVsFloorPct = cleanOptionalNumber(obj.marketVsFloorPct);

    const marketCapMain = cleanStr(obj.marketCapMain, 64);
    const marketCapUsd = cleanOptionalNumber(obj.marketCapUsd);
    const marketCapSubText = cleanStr(obj.marketCapSubText, 64);

    const volumeMain = cleanStr(obj.volumeMain, 64);
    const volumeUsd = cleanOptionalNumber(obj.volumeUsd);
    const volumeSubText = cleanStr(obj.volumeSubText, 64);

    const holdersCount = cleanOptionalNonNegInt(obj.holdersCount);
    const followersCount = cleanOptionalNonNegInt(obj.followersCount);
    const txCount = cleanOptionalNonNegInt(obj.txCount);

    const supplyMain = cleanStr(obj.supplyMain, 64);
    const mintProgressRaw = cleanOptionalNumber(obj.mintProgressPct);
    const mintProgressPct =
      mintProgressRaw !== undefined ? Math.max(0, Math.min(100, mintProgressRaw)) : undefined;
    const mintable = typeof obj.mintable === 'boolean' ? obj.mintable : undefined;

    const botName = cleanStr(obj.botName, 48);
    const botZeroHolding = obj.botZeroHolding === true;
    const botBalanceUsdText = cleanStr(obj.botBalanceUsdText, 48);

    const quickActions = Array.isArray(obj.quickActions)
      ? obj.quickActions
          .map((item) => cleanStr(item, 16).toLowerCase() as TokenCardQuickAction)
          .filter((item): item is TokenCardQuickAction => VALID_QUICK_ACTIONS.has(item))
          .slice(0, 4)
      : undefined;

    return {
      mode,
      symbol,
      ...(name ? { name } : {}),
      chain,
      standard,
      assetKey,
      caVerified: obj.caVerified === true,
      ...(icon ? { icon } : {}),
      ...(snapshotAt ? { snapshotAt } : {}),
      priceMain,
      ...(priceUnit ? { priceUnit } : {}),
      ...(priceNativeText ? { priceNativeText } : {}),
      ...(priceUsdText ? { priceUsdText } : {}),
      ...(change24h ? { change24h } : {}),
      ...(changeDir ? { changeDir } : {}),
      ...(floorPriceText ? { floorPriceText } : {}),
      ...(floorUsdText ? { floorUsdText } : {}),
      ...(marketVsFloorPct !== undefined ? { marketVsFloorPct } : {}),
      ...(marketCapMain ? { marketCapMain } : {}),
      ...(marketCapUsd !== undefined ? { marketCapUsd } : {}),
      ...(marketCapSubText ? { marketCapSubText } : {}),
      ...(volumeMain ? { volumeMain } : {}),
      ...(volumeUsd !== undefined ? { volumeUsd } : {}),
      ...(volumeSubText ? { volumeSubText } : {}),
      ...(holdersCount !== undefined ? { holdersCount } : {}),
      ...(followersCount !== undefined ? { followersCount } : {}),
      ...(txCount !== undefined ? { txCount } : {}),
      ...(supplyMain ? { supplyMain } : {}),
      ...(mintProgressPct !== undefined ? { mintProgressPct } : {}),
      ...(mintable !== undefined ? { mintable } : {}),
      ...(botName ? { botName } : {}),
      botBalanceText,
      ...(botZeroHolding ? { botZeroHolding: true } : {}),
      ...(botBalanceUsdText ? { botBalanceUsdText } : {}),
      ...(quickActions && quickActions.length > 0 ? { quickActions } : {}),
    };
  } catch {
    return null;
  }
}

export function serializeTokenCardFence(data: TokenCardData): string {
  return `\`\`\`${TOKEN_CARD_FENCE_TAG}\n${JSON.stringify(data)}\n\`\`\``;
}

const FAST_HINT_RE =
  /```[ \t]*(?:token-card|tokencard|ft-(?:quote|order|fill|my-orders|portfolio|bridge|action|receipt)(?:-card)?|ft(?:quote|order|fill|myorders|portfolio|bridge|action)card|token-(?:my-orders|portfolio|bridge|action)-card|nft-card-group|nft-collection-card|nft-(?:listing|fill|my-listings|portfolio|swap|action|negotiate)-card|nft(?:listing|fill|mylistings|portfolio|swap|action|negotiate)card|nft-card|nftcard|nft|escrow-card|escrowcard)\b/i;

function isAnyStandaloneNftOrEscrowFence(lang: string): boolean {
  return (
    isNftCardFenceLanguage(lang) ||
    isNftCardGroupFenceLanguage(lang) ||
    isNftCollectionCardFenceLanguage(lang) ||
    isAnyNftSuiteFenceLanguage(lang) ||
    isEscrowCardFenceLanguage(lang)
  );
}

function parseStandaloneTokenSuiteFence(
  fenceLang: string,
  rawBody: string,
  rawFence: string,
): TokenCardMessageSegment | null {
  if (isTokenCardFenceLanguage(fenceLang)) {
    const data = parseTokenCardFence(rawBody);
    return data ? { kind: 'token-card', data, rawFence } : null;
  }
  if (isFtOrderCardFenceLanguage(fenceLang)) {
    const data = parseFtOrderCardFence(rawBody);
    return data ? { kind: 'ft-order-card', data, rawFence } : null;
  }
  if (isFtQuoteCardFenceLanguage(fenceLang)) {
    const data = parseFtQuoteCardFence(rawBody);
    return data ? { kind: 'ft-quote-card', data, rawFence } : null;
  }
  if (isFtFillCardFenceLanguage(fenceLang)) {
    const data = parseFtFillCardFence(rawBody);
    return data ? { kind: 'ft-fill-card', data, rawFence } : null;
  }
  if (isFtMyOrdersCardFenceLanguage(fenceLang)) {
    const data = parseFtMyOrdersCardFence(rawBody);
    return data ? { kind: 'ft-my-orders-card', data, rawFence } : null;
  }
  if (isFtPortfolioCardFenceLanguage(fenceLang)) {
    const data = parseFtPortfolioCardFence(rawBody);
    return data ? { kind: 'ft-portfolio-card', data, rawFence } : null;
  }
  if (isFtBridgeCardFenceLanguage(fenceLang)) {
    const data = parseFtBridgeCardFence(rawBody);
    return data ? { kind: 'ft-bridge-card', data, rawFence } : null;
  }
  if (isFtActionCardFenceLanguage(fenceLang)) {
    const data = parseFtActionCardFence(rawBody);
    return data ? { kind: 'ft-action-card', data, rawFence } : null;
  }
  if (isNftCardGroupFenceLanguage(fenceLang)) {
    const data = parseNftCardGroupFence(rawBody);
    return data ? { kind: 'nft-card-group', data, rawFence } : null;
  }
  if (isNftCollectionCardFenceLanguage(fenceLang)) {
    const data = parseNftCollectionCardFence(rawBody);
    return data ? { kind: 'nft-collection-card', data, rawFence } : null;
  }
  if (isNftListingCardFenceLanguage(fenceLang)) {
    const data = parseNftListingCardFence(rawBody);
    return data ? { kind: 'nft-listing-card', data, rawFence } : null;
  }
  if (isNftFillCardFenceLanguage(fenceLang)) {
    const data = parseNftFillCardFence(rawBody);
    return data ? { kind: 'nft-fill-card', data, rawFence } : null;
  }
  if (isNftMyListingsCardFenceLanguage(fenceLang)) {
    const data = parseNftMyListingsCardFence(rawBody);
    return data ? { kind: 'nft-my-listings-card', data, rawFence } : null;
  }
  if (isNftPortfolioCardFenceLanguage(fenceLang)) {
    const data = parseNftPortfolioCardFence(rawBody);
    return data ? { kind: 'nft-portfolio-card', data, rawFence } : null;
  }
  if (isNftSwapCardFenceLanguage(fenceLang)) {
    const data = parseNftSwapCardFence(rawBody);
    return data ? { kind: 'nft-swap-card', data, rawFence } : null;
  }
  if (isNftActionCardFenceLanguage(fenceLang)) {
    const data = parseNftActionCardFence(rawBody);
    return data ? { kind: 'nft-action-card', data, rawFence } : null;
  }
  if (isNftNegotiateCardFenceLanguage(fenceLang)) {
    const data = parseNftNegotiateCardFence(rawBody);
    return data ? { kind: 'nft-negotiate-card', data, rawFence } : null;
  }
  if (isNftCardFenceLanguage(fenceLang)) {
    const data = parseNftCardFence(rawBody);
    return data ? { kind: 'nft-card', data, rawFence } : null;
  }
  if (isEscrowCardFenceLanguage(fenceLang)) {
    const data = parseEscrowCardFence(rawBody);
    return data ? { kind: 'escrow-card', data, rawFence } : null;
  }
  return null;
}

function coalesceAdjacentNftCardSegments(
  segments: TokenCardMessageSegment[],
): TokenCardMessageSegment[] {
  if (segments.length < 2) return segments;
  const out: TokenCardMessageSegment[] = [];
  for (let i = 0; i < segments.length; i += 1) {
    const current = segments[i];
    if (current.kind === 'nft-card') {
      const run: Array<Extract<TokenCardMessageSegment, { kind: 'nft-card' }>> = [current];
      while (i + 1 < segments.length && segments[i + 1].kind === 'nft-card') {
        i += 1;
        run.push(segments[i] as Extract<TokenCardMessageSegment, { kind: 'nft-card' }>);
      }
      if (run.length >= 2) {
        out.push({
          kind: 'nft-card-group',
          data: run.map((item) => item.data),
          rawFence: run.map((item) => item.rawFence).join('\n\n'),
        });
      } else {
        out.push(current);
      }
    } else {
      out.push(current);
    }
  }
  return out;
}

/**
 * Splits a chat message's markdown into ordered segments so `token-card`,
 * `ft-*-card`, `nft-card` / `nft-*-card`, and `escrow-card` blocks render as
 * standalone card bubbles rather than nested inside a gray prose bubble.
 *
 * - Respects outer 4+ backtick / tilde fences so nested examples stay intact.
 * - Coalesces runs of >=2 adjacent `nft-card` fences (blank lines only between
 *   them) into one `{ kind: 'nft-card-group' }` horizontal scroller segment.
 * - Malformed JSON inside a closed card fence stays in markdown so
 *   `MarkdownContent` degrades cleanly to a code block instead of dropping text.
 * - When `options.isStreaming` is true, an unclosed trailing card fence
 *   becomes `{ kind: 'token-card-streaming' }` so partial JSON never flashes
 *   inside a text bubble mid-stream.
 */
export function splitTokenCardMessageSegments(
  markdown: string,
  options?: { isStreaming?: boolean },
): TokenCardMessageSegment[] {
  const source = String(markdown ?? '');
  if (!source || !FAST_HINT_RE.test(source)) {
    return [{ kind: 'markdown', content: source }];
  }

  const lines = source.split('\n');
  const segments: TokenCardMessageSegment[] = [];
  let mdBuffer: string[] = [];

  const flushMarkdown = () => {
    if (mdBuffer.length === 0) return;
    const joined = mdBuffer.join('\n');
    mdBuffer = [];
    if (joined.trim().length > 0) {
      segments.push({ kind: 'markdown', content: joined.trim() });
    }
  };

  let outerFence: { char: '`' | '~'; len: number } | null = null;
  let i = 0;

  while (i < lines.length) {
    const rawLine = lines[i];
    const lineNoCr = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (outerFence) {
      mdBuffer.push(rawLine);
      const closeRe = new RegExp(`^[ \\t]{0,3}${outerFence.char}{${outerFence.len},}[ \\t]*$`);
      if (closeRe.test(lineNoCr)) {
        outerFence = null;
      }
      i += 1;
      continue;
    }

    const fenceOpenMatch = lineNoCr.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([^\s`~]*)(.*)$/);
    if (!fenceOpenMatch) {
      mdBuffer.push(rawLine);
      i += 1;
      continue;
    }

    const fenceMarks = fenceOpenMatch[1];
    const fenceChar = fenceMarks[0] as '`' | '~';
    const fenceLen = fenceMarks.length;
    const fenceLang = fenceOpenMatch[2] ?? '';

    const isSuiteCandidate =
      fenceChar === '`' &&
      (isTokenCardFenceLanguage(fenceLang) ||
        isAnyFtSuiteFenceLanguage(fenceLang) ||
        isAnyStandaloneNftOrEscrowFence(fenceLang));

    if (isSuiteCandidate) {
      const closeRe = new RegExp(`^[ \\t]{0,3}\`{${fenceLen},}[ \\t]*$`);
      let closeIdx = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        const candidate = lines[j].endsWith('\r') ? lines[j].slice(0, -1) : lines[j];
        if (closeRe.test(candidate)) {
          closeIdx = j;
          break;
        }
      }

      if (closeIdx === -1) {
        if (options?.isStreaming) {
          flushMarkdown();
          segments.push({ kind: 'token-card-streaming' });
          return coalesceAdjacentNftCardSegments(segments);
        }
        for (let j = i; j < lines.length; j += 1) {
          mdBuffer.push(lines[j]);
        }
        break;
      }

      const bodyLines = lines.slice(i + 1, closeIdx);
      const rawBody = bodyLines.join('\n').trim();
      const rawFence = lines.slice(i, closeIdx + 1).join('\n');
      const parsedSeg = parseStandaloneTokenSuiteFence(fenceLang, rawBody, rawFence);
      if (parsedSeg) {
        flushMarkdown();
        segments.push(parsedSeg);
      } else {
        for (let j = i; j <= closeIdx; j += 1) {
          mdBuffer.push(lines[j]);
        }
      }
      i = closeIdx + 1;
      continue;
    }

    outerFence = { char: fenceChar, len: fenceLen };
    mdBuffer.push(rawLine);
    i += 1;
  }

  flushMarkdown();
  if (segments.length === 0) {
    return [{ kind: 'markdown', content: source }];
  }
  return coalesceAdjacentNftCardSegments(segments);
}

export function hasStandaloneTokenCardSegment(segments: readonly TokenCardMessageSegment[]): boolean {
  return segments.some((seg) => seg.kind !== 'markdown');
}
