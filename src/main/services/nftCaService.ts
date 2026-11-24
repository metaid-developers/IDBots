import { fetchContentWithFallback } from './localIndexerProxy';
import { getPinData } from './metaidCore';
import { getMetasoApiBase } from './mrc721Service';

/**
 * NFT "CA" registry reader — the trust root behind IDBots-certified MRC-721
 * collection badges on MetaBot NFT avatars.
 *
 * Trust model (owner decision; protocol APPROVED 2026-11-05, see
 * docs/idbots-nft-ca-protocol.md): IDBots publishes an official certification
 * pin on-chain via its official MetaID, and clients READ that pin as the
 * trust root.
 *
 *   - Pin path: /protocols/idbots-nft-ca (unofficial namespace, single
 *     registry pin; registry updates are MODIFY pins on the same path).
 *   - Read rule: the LATEST pin on the path wins (same latest-wins
 *     convention as the rest of the MetaID ecosystem) — no ambiguity even
 *     though history keeps every create/modify pin.
 *   - Content (the pin 7-tuple already carries protocol identity and
 *     version, so the payload carries none of those):
 *
 *   {
 *     "collections": [
 *       {
 *         "collectionPinId": "<collection_desc pinid>",
 *         "collectionName": "pixel-cats",
 *         "note": "free text",
 *         "certifiedAt": 1793868000
 *       }
 *     ]
 *   }
 *
 *   - Trust verification: the pin's on-chain creator must equal
 *     OFFICIAL_IDBOTS_METAID (the official IDBots bot "Bob"). Badges render
 *     only when verified === true AND the collection is listed.
 *
 * Every failure path (network error, non-JSON body, bad schema, missing
 * creator record, creator mismatch) degrades to an EMPTY or
 * `verified:false` registry — this module never throws.
 */

const METAID_CONTENT_BASE = 'https://file.metaid.io/metafile-indexer/content';
const MANAPI_BASE = 'https://manapi.metaid.io';
const NFT_CA_PATH = '/protocols/idbots-nft-ca';

/**
 * The IDBots official identity (owner designation 2026-11-05): the local
 * MetaBot "Bob". Its metaID is the trust root every CA pin creator is
 * checked against. globalMetaId idq1w8ye5psdkqrn6ugxxwvf5p4kkeuzufa6n9tt47,
 * MVC address 1BNesCuvJeW2DAF42xkyCU1ifZVuNZ61mv.
 */
export const OFFICIAL_IDBOTS_METAID = '2379692b225136b2b54e83aac52174f622b80181b17254bb7b5cf7b0aa323212';

/**
 * The official CA registry pin (owner-issued 2026-11-05 via Bob, initially
 * empty — honest baseline until collections are certified). IDBOTS_NFT_CA_
 * PINID overrides it for testing/staging.
 */
export const DEFAULT_NFT_CA_PINID = '77da77280b9b218cf1edd62f658ca2be561dd7e377f3980182e280487ec38c56i0';

export const NFT_CA_PROTOCOL = 'idbots-nft-ca';
export const NFT_CA_SCHEMA_VERSION = 1;
/** Process-lifetime cache TTL for the fetched registry. */
export const NFT_CA_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Built-in CA trust root entries for the early official IDBots escrow
 * guarantor bots (owner designation). On-chain CA pins signed by
 * OFFICIAL_IDBOTS_METAID may still override or revoke (`active: false`) any
 * entry here; entries not listed on-chain remain trusted from this root.
 */
export const BUILTIN_OFFICIAL_ESCROW_GUARANTORS: readonly NftCaOfficialBotEntry[] = Object.freeze([
  Object.freeze({
    globalMetaId: 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
    metaId: '2eb21238314aca030b67ed7b7c4c613f2e8cb7e42ee9140589a4df9da3854aa2',
    mvcAddress: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
    role: 'escrow_guarantor' as const,
    badgeType: 'official_escrow_guarantor',
    badgeLabel: 'Official Escrow Guarantor',
    escrowConfig: Object.freeze({
      custodyAddress: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
      supportedCurrencies: ['CNY'],
    }),
    active: true,
  }),
  Object.freeze({
    globalMetaId: 'idq1d5m392ahkhp79wsy9ur79e3vhak7tg729dwdr5',
    metaId: '3752b67637874d4886b7f0f27b6958c2b44f3e1795dfea42988aaa4be02b7859',
    mvcAddress: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
    role: 'escrow_guarantor' as const,
    badgeType: 'official_escrow_guarantor',
    badgeLabel: 'Official Escrow Guarantor',
    escrowConfig: Object.freeze({
      custodyAddress: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
      supportedCurrencies: ['CNY'],
    }),
    active: true,
  }),
]);

/** `<64hex>i<n>` pin id convention (same shape as mrc721Service.isMrc721PinId). */
const PIN_ID_PATTERN = /^[0-9a-fA-F]{64}i\d+$/;

const METAID_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface NftCaLegacySeriesRef {
  codehash: string;
  genesis: string;
  swapStationGlobalMetaId?: string;
}

export interface NftCaCollectionEntry {
  /** The certified collection's collection_desc pin id. */
  collectionPinId: string;
  collectionName?: string;
  displayTitle?: string;
  legacySeries?: NftCaLegacySeriesRef;
  note?: string;
  /** Unix seconds at which IDBots certified the collection. */
  certifiedAt?: number;
}

export type NftCaOfficialBotRole = 'swap_station' | 'escrow_guarantor' | 'official_announcer';

export interface NftCaSwapSeriesConfig {
  collectionSlug: string;
  targetCollectionPinId: string;
  codehash: string;
  genesis: string;
  maxTokenIndex?: number;
  minConfirmations?: number;
}

export interface NftCaSwapConfig {
  vaultAddress: string;
  supportedSeries: NftCaSwapSeriesConfig[];
}

export interface NftCaEscrowConfig {
  custodyAddress: string;
  supportedCurrencies?: string[];
  maxOrderCnyCents?: number;
}

export interface NftCaOfficialBotEntry {
  globalMetaId: string;
  metaId?: string;
  mvcAddress: string;
  role: NftCaOfficialBotRole;
  badgeType: string;
  badgeLabel: string;
  swapConfig?: NftCaSwapConfig;
  escrowConfig?: NftCaEscrowConfig;
  active: boolean;
  certifiedAt?: number;
}

export interface NftCaParsedPayload {
  collections: NftCaCollectionEntry[];
  officialBots: NftCaOfficialBotEntry[];
}

export type NftCaRegistryStatus =
  | 'empty-no-pin-configured'
  | 'unavailable'
  | 'verified'
  | 'unverified';

export interface NftCaRegistry {
  protocol: typeof NFT_CA_PROTOCOL;
  version: number;
  /**
   * True only when the CA pin's on-chain creator was resolved and matches
   * OFFICIAL_IDBOTS_METAID. Renderers must not draw certification badges
   * off an unverified registry.
   */
  verified: boolean;
  status: NftCaRegistryStatus;
  /** Human-readable reason for the current state (payload honesty). */
  detail?: string;
  /** The CA pin id that was read (null when none is configured). */
  pinId: string | null;
  /** The pin's resolved creator MetaID, when the chain record carried one. */
  creatorMetaId: string | null;
  officialMetaId: string;
  collections: NftCaCollectionEntry[];
  officialBots: NftCaOfficialBotEntry[];
  /** Epoch ms when this registry snapshot was fetched. */
  fetchedAt: number;
}

export function buildEmptyNftCaRegistry(status: NftCaRegistryStatus, detail?: string): NftCaRegistry {
  return {
    protocol: NFT_CA_PROTOCOL,
    version: NFT_CA_SCHEMA_VERSION,
    verified: false,
    status,
    detail,
    pinId: null,
    creatorMetaId: null,
    officialMetaId: OFFICIAL_IDBOTS_METAID,
    collections: [],
    officialBots: [],
    fetchedAt: Date.now(),
  };
}

/**
 * Returns the explicit env override pin id when set and valid, or null when
 * using the official built-in CA pin chain.
 */
export function getEnvOverrideNftCaPinId(): string | null {
  const raw = String(process.env.IDBOTS_NFT_CA_PINID ?? '').trim();
  if (raw && PIN_ID_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }
  return null;
}

/**
 * The CA pin id to read: the official registry pin by default, overridden by
 * IDBOTS_NFT_CA_PINID for testing/staging. An explicitly-set-but-invalid env
 * value still falls back to the official default (the env is an override,
 * not a kill switch — killing the trust root is a build change, not an env
 * typo away).
 */
export function getConfiguredNftCaPinId(): string | null {
  return getEnvOverrideNftCaPinId() ?? DEFAULT_NFT_CA_PINID;
}

const VALID_OFFICIAL_BOT_ROLES = new Set<NftCaOfficialBotRole>([
  'swap_station',
  'escrow_guarantor',
  'official_announcer',
]);

function parseLegacySeriesRef(raw: unknown): NftCaLegacySeriesRef | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const codehash = typeof obj.codehash === 'string' ? obj.codehash.trim().toLowerCase() : '';
  const genesis = typeof obj.genesis === 'string' ? obj.genesis.trim().toLowerCase() : '';
  if (!codehash || !genesis) {
    return undefined;
  }
  const ref: NftCaLegacySeriesRef = { codehash, genesis };
  const swapStationGlobalMetaId =
    typeof obj.swapStationGlobalMetaId === 'string' ? obj.swapStationGlobalMetaId.trim() : '';
  if (swapStationGlobalMetaId) {
    ref.swapStationGlobalMetaId = swapStationGlobalMetaId;
  }
  return ref;
}

function parseSwapConfig(raw: unknown): NftCaSwapConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const vaultAddress = typeof obj.vaultAddress === 'string' ? obj.vaultAddress.trim() : '';
  if (!vaultAddress || !Array.isArray(obj.supportedSeries)) {
    return undefined;
  }
  const supportedSeries: NftCaSwapSeriesConfig[] = [];
  for (const item of obj.supportedSeries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const s = item as Record<string, unknown>;
    const collectionSlug = typeof s.collectionSlug === 'string' ? s.collectionSlug.trim() : '';
    const rawTarget = typeof s.targetCollectionPinId === 'string' ? s.targetCollectionPinId.trim() : '';
    const targetCollectionPinId = PIN_ID_PATTERN.test(rawTarget) ? rawTarget.toLowerCase() : rawTarget;
    const codehash = typeof s.codehash === 'string' ? s.codehash.trim().toLowerCase() : '';
    const genesis = typeof s.genesis === 'string' ? s.genesis.trim().toLowerCase() : '';
    if (!collectionSlug || !targetCollectionPinId || !codehash || !genesis) continue;
    const parsedSeries: NftCaSwapSeriesConfig = {
      collectionSlug,
      targetCollectionPinId,
      codehash,
      genesis,
    };
    const maxTokenIndex = Number(s.maxTokenIndex);
    if (Number.isFinite(maxTokenIndex) && maxTokenIndex >= 0) {
      parsedSeries.maxTokenIndex = Math.round(maxTokenIndex);
    }
    const minConfirmations = Number(s.minConfirmations);
    if (Number.isFinite(minConfirmations) && minConfirmations >= 0) {
      parsedSeries.minConfirmations = Math.round(minConfirmations);
    }
    supportedSeries.push(parsedSeries);
  }
  return { vaultAddress, supportedSeries };
}

function parseEscrowConfig(raw: unknown): NftCaEscrowConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const custodyAddress = typeof obj.custodyAddress === 'string' ? obj.custodyAddress.trim() : '';
  if (!custodyAddress) {
    return undefined;
  }
  const config: NftCaEscrowConfig = { custodyAddress };
  if (Array.isArray(obj.supportedCurrencies)) {
    const currencies = obj.supportedCurrencies
      .map((c) => (typeof c === 'string' ? c.trim() : ''))
      .filter(Boolean);
    if (currencies.length) {
      config.supportedCurrencies = currencies;
    }
  }
  const maxOrderCnyCents = Number(obj.maxOrderCnyCents);
  if (Number.isFinite(maxOrderCnyCents) && maxOrderCnyCents > 0) {
    config.maxOrderCnyCents = Math.round(maxOrderCnyCents);
  }
  return config;
}

/**
 * Parse a CA pin content body into both `collections` and `officialBots`.
 * Returns null when the body is not a well-formed idbots-nft-ca payload
 * (`collections` must be an array).
 */
export function parseNftCaPinPayload(raw: string | null | undefined): NftCaParsedPayload | null {
  if (!raw) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (!Array.isArray(record.collections)) {
    return null;
  }

  const collections: NftCaCollectionEntry[] = [];
  for (const entry of record.collections) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      continue;
    }
    const item = entry as Record<string, unknown>;
    const collectionPinId = String(item.collectionPinId ?? '').trim().toLowerCase();
    if (!collectionPinId || !PIN_ID_PATTERN.test(collectionPinId)) {
      continue;
    }
    const normalized: NftCaCollectionEntry = { collectionPinId };
    const collectionName = typeof item.collectionName === 'string' ? item.collectionName.trim() : '';
    if (collectionName) normalized.collectionName = collectionName;
    const displayTitle = typeof item.displayTitle === 'string' ? item.displayTitle.trim() : '';
    if (displayTitle) normalized.displayTitle = displayTitle;
    const legacySeries = parseLegacySeriesRef(item.legacySeries);
    if (legacySeries) normalized.legacySeries = legacySeries;
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (note) normalized.note = note;
    const certifiedAt = Number(item.certifiedAt);
    if (Number.isFinite(certifiedAt) && certifiedAt > 0) {
      normalized.certifiedAt = Math.round(certifiedAt);
    }
    collections.push(normalized);
  }

  const officialBots: NftCaOfficialBotEntry[] = [];
  if (Array.isArray(record.officialBots)) {
    for (const entry of record.officialBots) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        continue;
      }
      const item = entry as Record<string, unknown>;
      const globalMetaId = typeof item.globalMetaId === 'string' ? item.globalMetaId.trim() : '';
      const mvcAddress = typeof item.mvcAddress === 'string' ? item.mvcAddress.trim() : '';
      const role = typeof item.role === 'string' ? item.role.trim() : '';
      const badgeType = typeof item.badgeType === 'string' ? item.badgeType.trim() : '';
      const badgeLabel = typeof item.badgeLabel === 'string' ? item.badgeLabel.trim() : '';
      if (!globalMetaId || !mvcAddress || !VALID_OFFICIAL_BOT_ROLES.has(role as NftCaOfficialBotRole)) {
        continue;
      }
      const normalizedBot: NftCaOfficialBotEntry = {
        globalMetaId,
        mvcAddress,
        role: role as NftCaOfficialBotRole,
        badgeType: badgeType || 'official_service',
        badgeLabel: badgeLabel || 'IDBots Official Service',
        active: item.active === true,
      };
      const metaId = typeof item.metaId === 'string' ? item.metaId.trim().toLowerCase() : '';
      if (metaId && METAID_PATTERN.test(metaId)) {
        normalizedBot.metaId = metaId;
      }
      const swapConfig = parseSwapConfig(item.swapConfig);
      if (swapConfig) {
        normalizedBot.swapConfig = swapConfig;
      }
      const escrowConfig = parseEscrowConfig(item.escrowConfig);
      if (escrowConfig) {
        normalizedBot.escrowConfig = escrowConfig;
      }
      const certifiedAt = Number(item.certifiedAt);
      if (Number.isFinite(certifiedAt) && certifiedAt > 0) {
        normalizedBot.certifiedAt = Math.round(certifiedAt);
      }
      officialBots.push(normalizedBot);
    }
  }

  return { collections, officialBots };
}

/**
 * Parse a CA pin content body. Returns the normalized collection list, or
 * null when the body is not a well-formed idbots-nft-ca payload (collections
 * not an array). Kept for backward compatibility with existing callers/tests.
 */
export function parseNftCaPinContent(raw: string | null | undefined): NftCaCollectionEntry[] | null {
  return parseNftCaPinPayload(raw)?.collections ?? null;
}

/**
 * Resolve a pin's creator MetaID through the house pin-record route
 * (getPinData: local sqlite first, then manapi). Returns the first 64-hex
 * creator-ish field the record carries, or null when the record is missing
 * or unverifiable.
 */
export async function resolveNftCaPinCreator(pinId: string): Promise<string | null> {
  try {
    const row = await getPinData(pinId, false);
    // Prefer immutable creator fields before current-owner fields so a pin
    // created by an attacker and transferred to Bob cannot spoof creatorMetaId.
    for (const field of ['createMetaId', 'creator', 'globalMetaId', 'metaid']) {
      const value = String(row?.[field] ?? '').trim();
      if (value && METAID_PATTERN.test(value)) {
        return value.toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}

function decodeManapiPinBodyText(rawBody: unknown, rawSummary: unknown): string | null {
  if (typeof rawBody === 'string' && rawBody.trim()) {
    const trimmed = rawBody.trim();
    if (parseNftCaPinPayload(trimmed)) {
      return trimmed;
    }
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim();
      if (decoded && parseNftCaPinPayload(decoded)) {
        return decoded;
      }
    } catch {
      // ignore non-base64 contentBody
    }
  }
  if (typeof rawSummary === 'string' && rawSummary.trim()) {
    const summary = rawSummary.trim();
    if (parseNftCaPinPayload(summary)) {
      return summary;
    }
  }
  return null;
}

async function fetchCaPinContent(pinId: string): Promise<string | null> {
  let fallbackCandidate: string | null = null;
  try {
    const response = await fetchContentWithFallback(
      pinId,
      `${METAID_CONTENT_BASE}/${encodeURIComponent(pinId)}`,
    );
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length) {
        const text = buffer.toString('utf8');
        if (parseNftCaPinPayload(text)) {
          return text;
        }
        fallbackCandidate = text;
      }
    }
  } catch {
    // continue to MANAPI fallbacks
  }

  // Fallback 1: MANAPI /content/<pinId> serves JSON protocol pins that
  // file.metaid.io rejects with {"code":40400,"message":"avatar not found"}.
  try {
    const res = await fetch(`${MANAPI_BASE}/content/${encodeURIComponent(pinId)}`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text && parseNftCaPinPayload(text)) {
        return text;
      }
    }
  } catch {
    // continue to pin-record fallback
  }

  // Fallback 2: MANAPI / local SQLite pin record (contentBody / contentSummary).
  try {
    const row = await getPinData(pinId, false);
    const decoded = decodeManapiPinBodyText(row?.contentBody, row?.contentSummary);
    if (decoded) {
      return decoded;
    }
  } catch {
    // ignore
  }

  return fallbackCandidate;
}

interface NftCaCache {
  registry: NftCaRegistry;
  fetchedAt: number;
}

let cache: NftCaCache | null = null;

/** Pure TTL check so tests can exercise freshness without fake timers. */
export function isNftCaCacheFresh(fetchedAt: number, now: number): boolean {
  return now - fetchedAt < NFT_CA_CACHE_TTL_MS;
}

export function clearNftCaRegistryCache(): void {
  cache = null;
}

async function fetchLatestCaFromMetaso(): Promise<{ pinId: string } | null> {
  try {
    const base = getMetasoApiBase();
    const res = await fetch(`${base}/api/mrc721/ca/registry`, {
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: unknown;
      data?: {
        pinId?: unknown;
      };
    };
    const code = Number(json?.code);
    if (code !== 0 && code !== 1) return null;
    const data = json?.data;
    if (!data || typeof data !== 'object') return null;
    const pinId = typeof data.pinId === 'string' ? data.pinId.trim().toLowerCase() : '';
    if (!pinId || !PIN_ID_PATTERN.test(pinId)) return null;
    return { pinId };
  } catch {
    return null;
  }
}

async function resolveLatestPinIdFromHistory(rootPinId: string): Promise<string> {
  const officialMetaId = OFFICIAL_IDBOTS_METAID.toLowerCase();
  try {
    const row = await getPinData(rootPinId, false);
    const rawHistory = row?.modify_history;
    let list: unknown[] = [];
    if (Array.isArray(rawHistory)) {
      list = rawHistory;
    } else if (typeof rawHistory === 'string' && rawHistory.trim()) {
      try {
        const parsed = JSON.parse(rawHistory);
        if (Array.isArray(parsed)) list = parsed;
      } catch {
        // ignore malformed modify_history
      }
    }
    const seen = new Set<string>();
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const entry = list[i];
      const candidate = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
      if (!candidate || !PIN_ID_PATTERN.test(candidate) || seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      const creatorMetaId = await resolveNftCaPinCreator(candidate);
      if (creatorMetaId !== officialMetaId) {
        continue;
      }
      const candidateRaw = await fetchCaPinContent(candidate);
      if (parseNftCaPinPayload(candidateRaw)) {
        return candidate;
      }
    }
  } catch {
    // fall back to rootPinId
  }
  return rootPinId;
}

async function resolveLatestCaFromManapiPath(): Promise<{
  pinId: string;
  raw: string;
  creatorMetaId: string;
} | null> {
  const officialMetaId = OFFICIAL_IDBOTS_METAID.toLowerCase();
  try {
    const url = `${MANAPI_BASE}/pin/path/list?path=${encodeURIComponent(NFT_CA_PATH)}&size=20`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      code?: unknown;
      list?: unknown[];
      data?: { list?: unknown[] };
    };
    const code = Number(json?.code);
    if (code !== 0 && code !== 1) return null;
    const items = Array.isArray(json?.data?.list)
      ? json.data.list
      : Array.isArray(json?.list)
        ? json.list
        : [];
    if (!items.length) return null;

    const candidates = items
      .filter((it): it is Record<string, unknown> => !!it && typeof it === 'object')
      .slice()
      .sort((a, b) => {
        const ha = Number(a.genesisHeight ?? 0);
        const hb = Number(b.genesisHeight ?? 0);
        if (hb !== ha) return hb - ha;
        const ta = Number(a.timestamp ?? 0);
        const tb = Number(b.timestamp ?? 0);
        if (tb !== ta) return tb - ta;
        return String(b.id ?? '').localeCompare(String(a.id ?? ''));
      });

    const seen = new Set<string>();
    for (const item of candidates) {
      const candidateId = typeof item.id === 'string' ? item.id.trim().toLowerCase() : '';
      if (!candidateId || !PIN_ID_PATTERN.test(candidateId) || seen.has(candidateId)) {
        continue;
      }
      seen.add(candidateId);
      // Skip unconfirmed negative-height entries on MANAPI path list unless no confirmed pin exists.
      if (Number(item.genesisHeight ?? 0) < 0) {
        continue;
      }
      const creatorMetaId = await resolveNftCaPinCreator(candidateId);
      if (creatorMetaId !== officialMetaId) {
        continue;
      }
      const inlineRaw = decodeManapiPinBodyText(item.contentBody, item.contentSummary);
      const contentLength = Number(item.contentLength ?? 0);
      const needsFullFetch =
        !inlineRaw ||
        (Number.isFinite(contentLength) &&
          contentLength > 0 &&
          Buffer.byteLength(inlineRaw, 'utf8') < contentLength);
      const candidateRaw = needsFullFetch ? await fetchCaPinContent(candidateId) : inlineRaw;
      if (candidateRaw && parseNftCaPinPayload(candidateRaw)) {
        return { pinId: candidateId, raw: candidateRaw, creatorMetaId };
      }
    }
  } catch {
    // ignore MANAPI path list failures
  }
  return null;
}

async function fetchNftCaRegistryUncached(): Promise<NftCaRegistry> {
  const envOverridePinId = getEnvOverrideNftCaPinId();
  const officialMetaId = OFFICIAL_IDBOTS_METAID.toLowerCase();
  let pinId: string | null = envOverridePinId;
  let raw: string | null = null;
  let resolvedCreatorMetaId: string | null | undefined;

  if (envOverridePinId) {
    raw = await fetchCaPinContent(envOverridePinId);
  } else {
    const metasoLatest = await fetchLatestCaFromMetaso();
    let acceptedMetaso = false;
    if (metasoLatest) {
      const candidateRaw = await fetchCaPinContent(metasoLatest.pinId);
      const candidateParsed = parseNftCaPinPayload(candidateRaw);
      const candidateCreator = candidateParsed ? await resolveNftCaPinCreator(metasoLatest.pinId) : null;
      if (candidateParsed && candidateCreator === officialMetaId) {
        pinId = metasoLatest.pinId;
        raw = candidateRaw;
        resolvedCreatorMetaId = candidateCreator;
        acceptedMetaso = true;
        // If MetaSo is still serving an empty baseline before syncing a newly
        // mined CA pin, check MANAPI path list once for a newer Bob-signed pin.
        if (candidateParsed.collections.length === 0 && candidateParsed.officialBots.length === 0) {
          const pathLatest = await resolveLatestCaFromManapiPath();
          if (pathLatest) {
            pinId = pathLatest.pinId;
            raw = pathLatest.raw;
            resolvedCreatorMetaId = pathLatest.creatorMetaId;
          }
        }
      }
    }
    if (!acceptedMetaso) {
      const basePinId = getConfiguredNftCaPinId();
      if (!basePinId) {
        return buildEmptyNftCaRegistry(
          'empty-no-pin-configured',
          'IDBOTS_NFT_CA_PINID is unset or not a valid pin id; the IDBots NFT CA pin does not exist yet.',
        );
      }
      const historyPinId = await resolveLatestPinIdFromHistory(basePinId);
      if (historyPinId !== basePinId) {
        pinId = historyPinId;
        raw = await fetchCaPinContent(pinId);
      } else {
        const pathLatest = await resolveLatestCaFromManapiPath();
        if (pathLatest) {
          pinId = pathLatest.pinId;
          raw = pathLatest.raw;
          resolvedCreatorMetaId = pathLatest.creatorMetaId;
        } else {
          pinId = basePinId;
          raw = await fetchCaPinContent(pinId);
        }
      }
    }
  }

  if (!pinId) {
    return buildEmptyNftCaRegistry(
      'empty-no-pin-configured',
      'IDBOTS_NFT_CA_PINID is unset or not a valid pin id; the IDBots NFT CA pin does not exist yet.',
    );
  }

  const parsed = parseNftCaPinPayload(raw);
  if (!parsed) {
    return {
      ...buildEmptyNftCaRegistry(
        'unavailable',
        'The configured CA pin is missing, empty, or not a well-formed idbots-nft-ca payload.',
      ),
      pinId,
    };
  }

  const creatorMetaId = resolvedCreatorMetaId !== undefined
    ? resolvedCreatorMetaId
    : await resolveNftCaPinCreator(pinId);
  const verified = !!creatorMetaId && creatorMetaId === officialMetaId;
  return {
    protocol: NFT_CA_PROTOCOL,
    version: NFT_CA_SCHEMA_VERSION,
    verified,
    status: verified ? 'verified' : 'unverified',
    detail: verified
      ? 'CA pin creator matches the official IDBots MetaID.'
      : creatorMetaId
        ? 'CA pin creator does not match the official IDBots MetaID; collections are unverified.'
        : 'CA pin creator could not be resolved from the chain record; collections are unverified.',
    pinId,
    creatorMetaId,
    officialMetaId: OFFICIAL_IDBOTS_METAID,
    collections: parsed.collections,
    officialBots: parsed.officialBots,
    fetchedAt: Date.now(),
  };
}

/**
 * Read the IDBots NFT CA registry (process-lifetime cached, 10 min TTL).
 * Never throws and never rejects: every failure degrades to an empty or
 * `verified:false` registry. `refresh: true` bypasses (and clears) the cache
 * for manual refresh flows.
 */
export async function getNftCaRegistry(options?: { refresh?: boolean }): Promise<NftCaRegistry> {
  if (options?.refresh === true) {
    cache = null;
  }
  const now = Date.now();
  if (cache && isNftCaCacheFresh(cache.fetchedAt, now)) {
    return cache.registry;
  }
  const registry = await fetchNftCaRegistryUncached();
  cache = { registry, fetchedAt: now };
  return registry;
}
