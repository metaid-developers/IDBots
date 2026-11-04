import { fetchContentWithFallback } from './localIndexerProxy';
import { getPinData } from './metaidCore';

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

/** `<64hex>i<n>` pin id convention (same shape as mrc721Service.isMrc721PinId). */
const PIN_ID_PATTERN = /^[0-9a-fA-F]{64}i\d+$/;

const METAID_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface NftCaCollectionEntry {
  /** The certified collection's collection_desc pin id. */
  collectionPinId: string;
  collectionName?: string;
  note?: string;
  /** Unix seconds at which IDBots certified the collection. */
  certifiedAt?: number;
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
    fetchedAt: Date.now(),
  };
}

/**
 * The CA pin id to read: the official registry pin by default, overridden by
 * IDBOTS_NFT_CA_PINID for testing/staging. An explicitly-set-but-invalid env
 * value still falls back to the official default (the env is an override,
 * not a kill switch — killing the trust root is a build change, not an env
 * typo away).
 */
export function getConfiguredNftCaPinId(): string | null {
  const raw = String(process.env.IDBOTS_NFT_CA_PINID ?? '').trim();
  if (raw && PIN_ID_PATTERN.test(raw)) {
    return raw.toLowerCase();
  }
  return DEFAULT_NFT_CA_PINID;
}

/**
 * Parse a CA pin content body. Returns the normalized collection list, or
 * null when the body is not a well-formed idbots-nft-ca payload (collections
 * not an array). Per the approved protocol the payload carries NO
 * protocol/version fields (the pin 7-tuple carries them); any legacy
 * protocol/version keys that may appear are ignored, not validated. Entries
 * without a usable collectionPinId are dropped; a list emptied that way
 * still counts as a valid (if odd) pin.
 */
export function parseNftCaPinContent(raw: string | null | undefined): NftCaCollectionEntry[] | null {
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
    const note = typeof item.note === 'string' ? item.note.trim() : '';
    if (note) normalized.note = note;
    const certifiedAt = Number(item.certifiedAt);
    if (Number.isFinite(certifiedAt) && certifiedAt > 0) {
      normalized.certifiedAt = Math.round(certifiedAt);
    }
    collections.push(normalized);
  }
  return collections;
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
    for (const field of ['globalMetaId', 'metaid', 'createMetaId', 'creator']) {
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

async function fetchCaPinContent(pinId: string): Promise<string | null> {
  try {
    const response = await fetchContentWithFallback(
      pinId,
      `${METAID_CONTENT_BASE}/${encodeURIComponent(pinId)}`,
    );
    if (!response.ok) {
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) {
      return null;
    }
    return buffer.toString('utf8');
  } catch {
    return null;
  }
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

async function fetchNftCaRegistryUncached(): Promise<NftCaRegistry> {
  const pinId = getConfiguredNftCaPinId();
  if (!pinId) {
    // The CA pin does not exist yet / is not pointed at: no certification
    // marks. Deliberately not an error — this is the expected state until
    // the owner publishes the pin and configures the pointer.
    return buildEmptyNftCaRegistry(
      'empty-no-pin-configured',
      'IDBOTS_NFT_CA_PINID is unset or not a valid pin id; the IDBots NFT CA pin does not exist yet.',
    );
  }

  const raw = await fetchCaPinContent(pinId);
  const collections = parseNftCaPinContent(raw);
  if (!collections) {
    return {
      ...buildEmptyNftCaRegistry(
        'unavailable',
        'The configured CA pin is missing, empty, or not a well-formed idbots-nft-ca payload.',
      ),
      pinId,
    };
  }

  const creatorMetaId = await resolveNftCaPinCreator(pinId);
  const verified = !!creatorMetaId && creatorMetaId === OFFICIAL_IDBOTS_METAID.toLowerCase();
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
    collections,
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
