import { randomBytes } from 'node:crypto';
import { fetchFromLocalOrFallback, fetchJsonWithFallbackOnMiss } from './localIndexerProxy';
import { resolveBroadcastTxResult } from '../libs/mvcSpend';
import type { MetabotStore } from '../metabotStore';

/**
 * MRC-721 (pin-based MetaID NFT) service — the read/write layer behind the
 * `mrc721_*` agent tools. Distinct from the MetaContract (contract-based) NFT
 * stack in mvcNftService.ts: MRC-721 items are identified by pinid paths under
 * /nft/mrc721/{collectionName}/..., not genesis/codehash/tokenIndex.
 *
 * Protocol semantics (MetaSo MRC-721 issuer-only revision, 2026-11-07, see
 * metaso-p2p docs/mrc721-protocol-revision-issuer-only.md):
 *   - A collection_desc pin registers the album keyed by the
 *     (collectionName, issuer address) pair; its pinId is the collectionid —
 *     the album's identity. Collection names are NOT unique: two issuers'
 *     same-name albums are independent (like two ERC-721 contracts sharing a
 *     display name), and a duplicate desc by the same issuer is ignored.
 *   - Minting is issuer-only: a create pin under
 *     /nft/mrc721/{collectionName}/{itemPath} is indexed only into the
 *     same-name album whose collection_desc author minted it (supply-checked
 *     by the indexer); pins by anyone else are never collected.
 *   - item_desc pins backfill name/desc/cover/metadata per field (first
 *     write wins, issuer-gated to the item's album issuer).
 *   - Transfer is a PLAIN spend of the item pin's UTXO: the indexer keys new
 *     ownership on the FIRST tx input and takes the new owner from output 0 —
 *     so the transfer tx must spend the item outpoint as input 0 and pay the
 *     item value to the recipient at output 0.
 *
 * Reads follow the standard remote-first path: fetchFromLocalOrFallback —
 * local sqlite/P2P override (IDBOTS_MAN_P2P_LOCAL_BASE) when set, then the
 * MetaSo-P2P base (getMetasoApiBase, production https://so.metaid.io).
 * MetaSo has served the manapi byte-compatible /api/mrc721/* read surface
 * since 2026-11-05 (release 41eeebc; see metaso-p2p
 * docs/mrc721-nft-downstream-guide.md). Rollback = point the base back at
 * https://manapi.metaid.io.
 *
 * metaid value convention (the ONE deliberate divergence from manapi):
 * metaid/createMetaId/ownerMetaId carry GLOBAL metaids (IDAddress `id...`
 * format), not man-p2p's legacy sha256-hex. Never compare these fields
 * across the two bases or against persisted legacy values — key identities
 * by address or pinId (both unchanged and authoritative); treat legacy
 * metaids in old cached rows as display history only.
 */

export const MRC721_PATH_ROOT = '/nft/mrc721';
const MRC721_RESERVED_SEGMENTS = new Set(['collection_desc', 'item_desc']);

/** MVC/SPACE livenet addresses are base58 (start with 1, 20+ chars). */
export function isMvcAddress(value: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{20,}$/.test(value);
}

/** pinId convention: `<64-hex txid>i<output index>`, e.g. `abc…i0`. */
export function isMrc721PinId(value: string): boolean {
  return /^[0-9a-f]{64}i\d+$/.test(value);
}

// ---------------------------------------------------------------------------
// Content builders + validators (pure; shared by the service and the tools)
// ---------------------------------------------------------------------------

export const MRC721_FIELD_LIMITS = {
  collectionName: 64,
  itemPath: 64,
  name: 256,
  desc: 4096,
  website: 512,
  cover: 256,
  metadataSerialized: 16_384,
} as const;

/**
 * collectionName rules: `[a-z0-9-]`, must start alphanumeric, no `/`
 * (paths split on '/'), never the reserved op segments.
 */
export function validateMrc721CollectionName(rawName: unknown): string {
  const name = String(rawName ?? '').trim();
  if (!name) throw new Error('collection_name is required');
  if (name.length > MRC721_FIELD_LIMITS.collectionName) {
    throw new Error(`collection_name must be at most ${MRC721_FIELD_LIMITS.collectionName} characters`);
  }
  if (MRC721_RESERVED_SEGMENTS.has(name)) {
    throw new Error(`collection_name "${name}" is a reserved protocol segment`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error('collection_name must be lowercase [a-z0-9-] and start with a letter or digit');
  }
  return name;
}

/**
 * itemPath rules: lowercase `[a-z0-9._-]`, starts alphanumeric, and its
 * lowercase form must never collide with collection_desc/item_desc — the
 * indexer dispatches the 4th path segment by lowercased name, so a reserved
 * itemPath would silently NOT mint.
 */
export function validateMrc721ItemPath(rawPath: unknown): string {
  const itemPath = String(rawPath ?? '').trim();
  if (!itemPath) throw new Error('item_path is required');
  if (itemPath.length > MRC721_FIELD_LIMITS.itemPath) {
    throw new Error(`item_path must be at most ${MRC721_FIELD_LIMITS.itemPath} characters`);
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(itemPath)) {
    throw new Error('item_path must be lowercase [a-z0-9._-] and start with a letter or digit');
  }
  if (MRC721_RESERVED_SEGMENTS.has(itemPath)) {
    throw new Error(`item_path "${itemPath}" is reserved (collection_desc/item_desc); pick another path`);
  }
  return itemPath;
}

export function validateMrc721TotalSupply(raw: unknown): number {
  const value = Number(raw);
  if (raw == null || raw === '') return -1;
  if (!Number.isInteger(value) || value < -1 || value > 1_000_000_000_000) {
    throw new Error('total_supply must be an integer in [-1, 1e12] (-1 = unlimited)');
  }
  return value;
}

export function validateMrc721RoyaltyRate(raw: unknown): number {
  const value = Number(raw);
  if (raw == null || raw === '') return 0;
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new Error('royalty_rate must be an integer percentage in [0, 20]');
  }
  return value;
}

function validateMrc721TextField(raw: unknown, field: string, limit: number): string | undefined {
  if (raw == null) return undefined;
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (!text) return undefined;
  if (text.length > limit) {
    throw new Error(`${field} must be at most ${limit} characters`);
  }
  return text;
}

/**
 * A metafile reference: a bare pinid gets the metafile:// prefix; anything
 * else (metafile://, https://) passes through unchanged.
 */
export function normalizeMrc721CoverUri(raw: unknown, field = 'cover'): string | undefined {
  const text = validateMrc721TextField(raw, field, MRC721_FIELD_LIMITS.cover);
  if (!text) return undefined;
  if (/^[0-9a-f]{64}i\d+$/.test(text)) return `metafile://${text}`;
  return text;
}

/**
 * collection_desc pin content. Fields absent from the input are omitted so
 * the indexer defaults apply (totalSupply -1 = unlimited, royaltyRate 0).
 */
export function buildMrc721CollectionDescContent(input: {
  name?: string;
  totalSupply?: number;
  royaltyRate?: number;
  desc?: string;
  website?: string;
  cover?: string;
  metadata?: unknown;
}): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  const name = typeof input.name === 'string' ? input.name.trim() : input.name;
  const desc = typeof input.desc === 'string' ? input.desc.trim() : input.desc;
  const website = typeof input.website === 'string' ? input.website.trim() : input.website;
  const cover = typeof input.cover === 'string' ? input.cover.trim() : input.cover;
  if (name) content.name = name;
  if (input.totalSupply != null) content.totalSupply = input.totalSupply;
  if (input.royaltyRate != null) content.royaltyRate = input.royaltyRate;
  if (desc) content.desc = desc;
  if (website) content.website = website;
  if (cover) content.cover = cover;
  if (input.metadata != null) {
    const serialized = typeof input.metadata === 'string'
      ? input.metadata.trim()
      : JSON.stringify(input.metadata);
    if (!serialized) throw new Error('metadata must not be empty when provided');
    if (serialized.length > MRC721_FIELD_LIMITS.metadataSerialized) {
      throw new Error(`metadata must serialize to at most ${MRC721_FIELD_LIMITS.metadataSerialized} characters`);
    }
    // Round-trip: reject non-JSON strings early (the indexer would just drop
    // the collection as invalid content otherwise).
    let normalized: unknown = serialized;
    if (typeof input.metadata !== 'string') {
      normalized = input.metadata;
    } else {
      try {
        normalized = JSON.parse(serialized);
      } catch {
        normalized = serialized;
      }
    }
    content.metadata = normalized;
  }
  return content;
}

/** item_desc pin content: per-field first-write-wins backfill for item pins. */
export function buildMrc721ItemDescContent(items: Array<{
  pinid: string;
  name?: string;
  desc?: string;
  cover?: string;
  metadata?: unknown;
}>): { items: Array<Record<string, unknown>> } {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('item_desc requires at least one item reference');
  }
  const refs = items.map((item) => {
    const ref: Record<string, unknown> = { pinid: String(item.pinid || '') };
    if (!ref.pinid) throw new Error('item_desc entries need a pinid');
    if (item.name) ref.name = item.name;
    if (item.desc) ref.desc = item.desc;
    if (item.cover) ref.cover = item.cover;
    if (item.metadata != null) {
      ref.metadata = typeof item.metadata === 'string'
        ? (() => {
            try {
              return JSON.parse(item.metadata);
            } catch {
              return item.metadata;
            }
          })()
        : item.metadata;
    }
    return ref;
  });
  return { items: refs };
}

// ---------------------------------------------------------------------------
// Indexer read layer (8 endpoints, requirements §2)
// ---------------------------------------------------------------------------

interface ManapiEnvelope<T> {
  code?: number;
  data?: T;
  message?: string;
}

/** Indexer list page: `{items, cursor}` (cursor absent = end of list). */
export interface Mrc721Page<T> {
  items: T[];
  cursor?: string;
}

export interface Mrc721CollectionSummary {
  collectionName: string;
  name?: string;
  totalSupply?: number;
  royaltyRate?: number;
  desc?: string;
  website?: string;
  cover?: string;
  metadata?: string;
  /** collectionid = the collection_desc pin id. */
  pinid?: string;
  createAddress?: string;
  createMetaId?: string;
  createTime?: number;
  genesisChainName?: string;
  genesisHeight?: number;
  genesisTx?: string;
  /** Authoritative minted count (MetaSo rows; falls back to totalnum). */
  mintedCount?: number;
  totalnum?: number;
}

export interface Mrc721ItemSummary {
  itemPinId: string;
  collectionName?: string;
  collectionPinId?: string;
  number?: number;
  name?: string;
  desc?: string;
  cover?: string;
  metadata?: string;
  ownerAddress?: string;
  ownerMetaId?: string;
  creatorMinted?: boolean;
  burned?: boolean;
  contentType?: string;
  contentSummary?: string;
  genesisChainName?: string;
  genesisHeight?: number;
  genesisTx?: string;
  genesisFee?: number;
  /** Current UTXO ("txid:vout") — the transfer/trade spend target. */
  output?: string;
  outputValue?: number;
  createTime?: number;
  transferCount?: number;
}

export interface Mrc721ItemTransferRecord {
  itemPinId?: string;
  fromAddress?: string;
  toAddress?: string;
  chainName?: string;
  height?: number;
  txId?: string;
  time?: number;
}

/**
 * Verify facts (item/verify): index-inclusion status, collectionid, genesis,
 * creatorMinted, transferCount — the issuer-only minting basis. Under the
 * revised protocol every indexed item is issuer-minted (creatorMinted true by
 * construction; a false value means the row predates the revision or comes
 * from an upstream source the indexer does not collect).
 * Keys stay permissive until man-p2p P2 freezes the response shape.
 */
export interface Mrc721VerifyInfo {
  collected?: boolean;
  collectionid?: string;
  collectionPinId?: string;
  creatorMinted?: boolean;
  transferCount?: number;
  burned?: boolean;
  genesisChainName?: string;
  genesisHeight?: number;
  genesisTx?: string;
  itemPinId?: string;
}

function buildMrc721Url(localPath: string, query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return `${getMetasoApiBase()}${localPath}${qs ? `?${qs}` : ''}`;
}

/**
 * One indexer read through the standard remote-first path. Transport errors
 * propagate; a server-answered failure is a structured miss (single) or an
 * error (list) depending on the caller.
 */
async function fetchMrc721Json(localPath: string, query: Record<string, string | number | undefined>): Promise<unknown> {
  const response = await fetchFromLocalOrFallback(localPath, buildMrc721Url(localPath, query));
  let json: ManapiEnvelope<unknown> | null = null;
  try {
    json = (await response.json()) as ManapiEnvelope<unknown>;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw Object.assign(new Error(`mrc721 index read failed (HTTP ${response.status}): ${localPath}`), {
      mrc721Status: response.status,
    });
  }
  if (json?.code !== 1) {
    throw Object.assign(new Error(`mrc721 index read failed: ${json?.message || `code ${json?.code}`}`), {
      mrc721Code: json?.code,
    });
  }
  return json.data;
}

function normalizeMrc721List<T>(payload: unknown): Mrc721Page<T> {
  const data = payload as { list?: unknown; cursor?: unknown } | unknown[] | null;
  const items = Array.isArray(data) ? data : ((data?.list as T[] | undefined) ?? []);
  const cursor = !Array.isArray(data) && typeof data?.cursor === 'string' ? data.cursor : undefined;
  return { items: (items ?? []) as T[], cursor: cursor || undefined };
}

/** Single-object read: a server-answered miss (404 / code!==1) returns null. */
async function fetchMrc721Single<T>(
  localPath: string,
  query: Record<string, string | number | undefined>,
): Promise<T | null> {
  try {
    const data = await fetchMrc721Json(localPath, query);
    return (data ?? null) as T | null;
  } catch (error) {
    const status = (error as { mrc721Status?: number }).mrc721Status;
    if (status === 404) return null;
    const code = (error as { mrc721Code?: unknown }).mrc721Code;
    if (code !== undefined) return null;
    throw error;
  }
}

async function fetchMrc721List<T>(
  localPath: string,
  query: Record<string, string | number | undefined>,
): Promise<Mrc721Page<T>> {
  return normalizeMrc721List<T>(await fetchMrc721Json(localPath, query));
}

/** 市场广场页:专辑分页列表 (requirements R5). */
export async function fetchMrc721CollectionPageList(params?: {
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721Page<Mrc721CollectionSummary>> {
  return fetchMrc721List<Mrc721CollectionSummary>('/api/mrc721/collection/pageList', {
    cursor: params?.cursor,
    size: params?.size,
  });
}

/** 专辑详情 (发行预检/确认轮询; miss = 尚未收录). */
export async function fetchMrc721CollectionInfo(params: {
  name?: string;
  pinId?: string;
}): Promise<Mrc721CollectionSummary | null> {
  return fetchMrc721Single<Mrc721CollectionSummary>('/api/mrc721/collection/info', {
    name: params.name,
    pinId: params.pinId,
  });
}

/** 专辑内条目分页. */
export async function fetchMrc721CollectionItems(params: {
  pinid: string;
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721Page<Mrc721ItemSummary>> {
  return fetchMrc721List<Mrc721ItemSummary>('/api/mrc721/collection/items/pageList', {
    pinid: params.pinid,
    cursor: params.cursor,
    size: params.size,
  });
}

/** 地址持有的专辑 ("我发行的/我持有的专辑" 持有人视图). */
export async function fetchMrc721AddressCollections(params: {
  address: string;
}): Promise<Mrc721CollectionSummary[]> {
  const page = await fetchMrc721List<Mrc721CollectionSummary>('/api/mrc721/address/collection', {
    address: params.address,
  });
  return page.items;
}

/** 地址持有的 NFT (转移/交易前的持仓源; 可按专辑过滤). */
export async function fetchMrc721AddressItems(params: {
  address: string;
  pinId?: string;
}): Promise<Mrc721ItemSummary[]> {
  const page = await fetchMrc721List<Mrc721ItemSummary>('/api/mrc721/address/item', {
    address: params.address,
    pinId: params.pinId,
  });
  return page.items;
}

/** 地址持有的 NFT 原始分页形态 (cursor + size; NFT 钱包聚合端翻页拉全量用). */
export async function fetchMrc721AddressItemsPage(params: {
  address: string;
  pinId?: string;
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721Page<Mrc721ItemSummary>> {
  return fetchMrc721List<Mrc721ItemSummary>('/api/mrc721/address/item', {
    address: params.address,
    pinId: params.pinId,
    cursor: params.cursor,
    size: params.size,
  });
}

/** NFT 详情 (output/outputValue 为当前 UTXO,转移与交易构建直接使用). */
export async function fetchMrc721ItemInfo(params: {
  pinId: string;
}): Promise<Mrc721ItemSummary | null> {
  return fetchMrc721Single<Mrc721ItemSummary>('/api/mrc721/item/info', {
    pinId: params.pinId,
  });
}

/** 转移路径 (溯源时间线). */
export async function fetchMrc721ItemTransfers(params: {
  pinId: string;
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721Page<Mrc721ItemTransferRecord>> {
  return fetchMrc721List<Mrc721ItemTransferRecord>('/api/mrc721/item/transfers', {
    pinId: params.pinId,
    cursor: params.cursor,
    size: params.size,
  });
}

/** 真伪查验 (已收录 + creatorMinted + collectionid). */
export async function fetchMrc721ItemVerify(params: {
  pinId: string;
}): Promise<Mrc721VerifyInfo | null> {
  return fetchMrc721Single<Mrc721VerifyInfo>('/api/mrc721/item/verify', {
    pinId: params.pinId,
  });
}

/**
 * MetaSo-P2P production base (owner indexing architecture, 2026-11-05): all
 * NFT business indexes — the full manapi-compatible MRC-721 read surface
 * (this file's reads), sell-intent queries, collection search, issuer views —
 * are served by MetaSo, which builds on man-p2p's raw pin index. The
 * production base is BUILT IN (same posture as the old MANAPI_BASE constant);
 * the `IDBOTS_METASO_API_BASE` env only overrides it for staging/local
 * testing, and it doubles as the rollback lever (point it back at
 * https://manapi.metaid.io to revert reads without a rebuild).
 */
export const METASO_API_BASE_DEFAULT = 'https://so.metaid.io';

export function getMetasoApiBase(): string {
  const override = (process.env.IDBOTS_METASO_API_BASE ?? '').trim().replace(/\/+$/, '');
  return override || METASO_API_BASE_DEFAULT;
}

/**
 * One MetaSo read through the same envelope contract as the manapi reads
 * (identical error markers so callers degrade uniformly: HTTP status →
 * mrc721Status, envelope miss → mrc721Code).
 */
export async function fetchMetasoJson(
  localPath: string,
  query: Record<string, string | number | undefined>,
): Promise<unknown> {
  const base = getMetasoApiBase();
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  const response = await fetch(`${base}${localPath}${qs ? `?${qs}` : ''}`, {
    signal: AbortSignal.timeout(10_000),
  });
  let json: ManapiEnvelope<unknown> | null = null;
  try {
    json = (await response.json()) as ManapiEnvelope<unknown>;
  } catch {
    json = null;
  }
  if (!response.ok) {
    throw Object.assign(new Error(`metaso mrc721 read failed (HTTP ${response.status}): ${localPath}`), {
      mrc721Status: response.status,
    });
  }
  if (json?.code !== 1) {
    throw Object.assign(new Error(`metaso mrc721 read failed: ${json?.message || `code ${json?.code}`}`), {
      mrc721Code: json?.code,
    });
  }
  return json.data;
}

// ---------------------------------------------------------------------------
// Holder gate + collection search (P0: mrc721_verify_holding / search tools)
// ---------------------------------------------------------------------------

/**
 * MetaID (64-hex global metaid) → holder address, through the same
 * metafile-indexer user-info route the metaid:getUserInfo IPC uses
 * (local-first, then file.metaid.io). Returns null when the MetaID is unknown.
 */
export async function fetchMrc721AddressByMetaId(params: {
  metaId: string;
}): Promise<string | null> {
  const metaId = typeof params.metaId === 'string' ? params.metaId.trim() : '';
  if (!metaId) return null;
  const localPath = `/api/v1/users/info/metaid/${encodeURIComponent(metaId)}`;
  const fallbackUrl = `https://file.metaid.io/metafile-indexer/api/v1/info/metaid/${encodeURIComponent(metaId)}`;
  // A payload without a usable holder address counts as a semantic miss so
  // the fallback (and only the fallback) answers with a real record.
  const isMiss = (payload: unknown): boolean => {
    const data = (payload as { data?: { address?: unknown } } | null)?.data;
    return !data || typeof data.address !== 'string' || !data.address;
  };
  const response = await fetchJsonWithFallbackOnMiss(localPath, fallbackUrl, isMiss);
  const payload = (await response.json().catch(() => null)) as {
    data?: { address?: unknown };
  } | null;
  const address = payload?.data?.address;
  return typeof address === 'string' && address ? address : null;
}

function mrc721CollectionMatchesKeyword(row: Mrc721CollectionSummary, keyword: string): boolean {
  const haystacks = [row.name, row.collectionName, row.desc, row.pinid, row.createMetaId];
  return haystacks.some(
    (value) => typeof value === 'string' && value.toLowerCase().includes(keyword),
  );
}

export interface Mrc721CollectionSupplyState {
  totalSupply?: number;
  mintedCount: number;
  /** true = supply exhausted; false = slots left; null = unlimited or the count scan hit its page cap. */
  complete: boolean | null;
}

export interface Mrc721CollectionSearchResult {
  items: Mrc721CollectionSummary[];
  /** Total collection rows scanned from the indexer page list. */
  scanned: number;
  /** true = the page cap stopped the scan before the indexer list was exhausted. */
  truncated: boolean;
  /** When requested: minted-count state keyed by collectionid (pinid). */
  supplyState?: Record<string, Mrc721CollectionSupplyState>;
}

const MRC721_SEARCH_MAX_PAGES_DEFAULT = 20;
const MRC721_SEARCH_SUPPLY_STATE_CAP = 20;
const MRC721_SEARCH_SUPPLY_STATE_PAGE_CAP = 50;

/**
 * Collection search by keyword (name / namespace / description) and/or issuer
 * address. The indexer does not expose a keyword/issuer query yet
 * (docs/nft-indexer-requirements.md R-A/R-B), so filtering runs client-side
 * over the registered-collection page list — fine at today's scale, swapped
 * for server-side search when man-p2p ships it.
 */
export async function searchMrc721Collections(params: {
  keyword?: string;
  issuerAddress?: string;
  includeSupplyState?: boolean;
  maxPages?: number;
  pageSize?: number;
}): Promise<Mrc721CollectionSearchResult> {
  const keyword = (params.keyword ?? '').trim().toLowerCase();
  const issuerAddress = (params.issuerAddress ?? '').trim();
  if (!keyword && !issuerAddress) {
    throw new Error('collection search requires a keyword or an issuerAddress');
  }
  const maxPages = Math.min(Math.max(1, params.maxPages ?? MRC721_SEARCH_MAX_PAGES_DEFAULT), 50);
  const pageSize = Math.min(Math.max(1, params.pageSize ?? 100), 100);
  const items: Mrc721CollectionSummary[] = [];
  let scanned = 0;
  let truncated = false;
  let cursor: string | number | undefined;
  // MetaSo fast path (indexer requirements R-A): when a MetaSo base is
  // configured the server filters for us; on any transport/envelope error we
  // reset the accumulators and degrade to the client-side pageList scan.
  let serverSearch = true;
  for (let page = 0; page < maxPages; page++) {
    if (serverSearch) {
      try {
        const data = await fetchMetasoJson('/api/mrc721/collection/search', {
          keyword: keyword || undefined,
          issuer: issuerAddress || undefined,
          cursor,
          size: pageSize,
        }) as { list?: unknown; total?: unknown; cursor?: unknown } | null;
        const rows = Array.isArray(data?.list) ? (data.list as Mrc721CollectionSummary[]) : [];
        scanned = Number.isFinite(Number(data?.total)) ? Number(data?.total) : scanned + rows.length;
        items.push(...rows);
        const nextCursor = typeof data?.cursor === 'string' && data.cursor ? data.cursor : undefined;
        if (!nextCursor) break;
        cursor = nextCursor;
        if (page === maxPages - 1) truncated = true;
        continue;
      } catch {
        serverSearch = false;
        cursor = undefined;
        scanned = 0;
        items.length = 0;
        truncated = false;
      }
    }
    const result = await fetchMrc721CollectionPageList({ cursor, size: pageSize });
    const rows = result.items ?? [];
    scanned += rows.length;
    for (const row of rows) {
      if (issuerAddress && (row.createAddress ?? '') !== issuerAddress) continue;
      if (keyword && !mrc721CollectionMatchesKeyword(row, keyword)) continue;
      items.push(row);
    }
    if (!result.cursor) break;
    cursor = result.cursor;
    if (page === maxPages - 1) truncated = true;
  }

  const result: Mrc721CollectionSearchResult = { items, scanned, truncated };
  if (params.includeSupplyState) {
    const supplyState: Record<string, Mrc721CollectionSupplyState> = {};
    for (const row of items.slice(0, MRC721_SEARCH_SUPPLY_STATE_CAP)) {
      if (!row.pinid) continue;
      // MetaSo fast path: the server rows already carry the authoritative
      // minted count (mintedCount, falling back to totalnum) — no per-
      // collection item paging needed.
      const servedMinted = Number.isFinite(Number(row.mintedCount))
        ? Number(row.mintedCount)
        : Number.isFinite(Number(row.totalnum))
          ? Number(row.totalnum)
          : undefined;
      if (serverSearch && servedMinted != null) {
        supplyState[row.pinid] = {
          totalSupply: row.totalSupply,
          mintedCount: servedMinted,
          complete: row.totalSupply != null && row.totalSupply >= 0
            ? servedMinted >= row.totalSupply
            : null,
        };
        continue;
      }
      let mintedCount = 0;
      let exhausted = false;
      let itemCursor: string | number | undefined;
      for (let pages = 0; pages < MRC721_SEARCH_SUPPLY_STATE_PAGE_CAP; pages++) {
        const itemPage = await fetchMrc721CollectionItems({ pinid: row.pinid, cursor: itemCursor, size: 100 });
        mintedCount += itemPage.items.length;
        if (!itemPage.cursor) {
          exhausted = true;
          break;
        }
        itemCursor = itemPage.cursor;
      }
      supplyState[row.pinid] = {
        totalSupply: row.totalSupply,
        mintedCount,
        complete: exhausted && row.totalSupply != null && row.totalSupply >= 0
          ? mintedCount >= row.totalSupply
          : null,
      };
    }
    result.supplyState = supplyState;
  }
  return result;
}

export interface Mrc721IssuerNameScan {
  /**
   * The issuer's own album row under the exact collection name (null when
   * the issuer has not registered one under that name).
   */
  own: Mrc721CollectionSummary | null;
  /**
   * Same-name albums issued by OTHER addresses — independent albums under the
   * issuer-only revision (names are not unique; collectionid is the identity).
   */
  foreign: Mrc721CollectionSummary[];
}

/**
 * Issuer-scoped same-name album resolution (issuer-only protocol revision,
 * 2026-11-07): an album is identified by its collectionid, and the
 * human-level key is the (collectionName, issuer address) pair — collection
 * names are NOT unique and confer no ownership. Builds the R1/R2 prechecks
 * for the agent tools:
 *
 * 1. A conjunctive `collection/search` (issuer + keyword) finds the issuer's
 *    own row — a (collection_name, issuer) pair registers once, so an own row
 *    means "already issued by this MetaBot".
 * 2. When no own row exists, a keyword-only search surfaces foreign same-name
 *    albums (minting into those never collects — fee-guard refusals).
 *
 * `keyword` is a case-insensitive substring on the server, so rows are
 * exact-matched client-side on `collectionName`; `createAddress` is compared
 * exactly (base58 is case-sensitive). Throws when the search surface is
 * unavailable — callers own the proceed-with-warning posture.
 */
export async function scanMrc721CollectionNameForIssuer(params: {
  issuerAddress: string;
  collectionName: string;
}): Promise<Mrc721IssuerNameScan> {
  const issuerAddress = (params.issuerAddress ?? '').trim();
  const collectionName = (params.collectionName ?? '').trim();
  if (!issuerAddress) {
    throw new Error('scanMrc721CollectionNameForIssuer requires issuerAddress');
  }
  if (!collectionName) {
    throw new Error('scanMrc721CollectionNameForIssuer requires collectionName');
  }
  const exactName = (row: Mrc721CollectionSummary) => (row.collectionName ?? '') === collectionName;
  const byOwnAddress = (row: Mrc721CollectionSummary) => (row.createAddress ?? '') === issuerAddress;

  const scoped = await searchMrc721Collections({ keyword: collectionName, issuerAddress });
  const own = scoped.items.filter((row) => exactName(row) && byOwnAddress(row))[0] ?? null;
  if (own) return { own, foreign: [] };

  // No own album under the name: a keyword-only search (no issuer filter) is
  // the only way to see foreign same-name albums.
  const all = await searchMrc721Collections({ keyword: collectionName });
  return {
    own: null,
    foreign: all.items.filter((row) => exactName(row) && !byOwnAddress(row)),
  };
}

export interface Mrc721HoldingVerdict {
  holderAddress: string;
  collectionName?: string;
  collectionPinId?: string;
  holds: boolean;
  count: number;
  /** Live (non-burned) holdings of the collection, holder-view order. */
  items: Mrc721ItemSummary[];
}

/**
 * Hard holder gate (requirement S4): does this address currently hold at
 * least one live item of the given MRC-721 collection? Backs the
 * `mrc721_verify_holding` agent tool and is directly callable by host
 * internals (badge-gated replies, access checks). Read-only indexer lookups;
 * a moved-on item flips the verdict because the holder view is live.
 */
export async function verifyMrc721Holding(params: {
  holderAddress: string;
  collectionName?: string;
  collectionPinId?: string;
}): Promise<Mrc721HoldingVerdict> {
  const holderAddress = (params.holderAddress ?? '').trim();
  if (!holderAddress) throw new Error('verifyMrc721Holding requires holderAddress');
  const collectionName = (params.collectionName ?? '').trim() || undefined;
  let collectionPinId = (params.collectionPinId ?? '').trim() || undefined;
  if (!collectionPinId && !collectionName) {
    throw new Error('verifyMrc721Holding requires collectionName or collectionPinId');
  }
  if (!collectionPinId && collectionName) {
    // Issuer-only revision: names are not unique, and a name resolve hits the
    // earliest-created album under the name. When several albums share the
    // exact name, refuse with the candidate collectionids instead of silently
    // verifying against someone else's album; a single match (or an explicit
    // collectionPinId) verifies exactly.
    const scan = await searchMrc721Collections({ keyword: collectionName });
    const candidates = scan.items
      .filter((row) => (row.collectionName ?? '') === collectionName && row.pinid)
      .map((row) => row.pinid as string);
    const distinct = [...new Set(candidates)];
    if (distinct.length > 1) {
      throw new Error(
        `collection name "${collectionName}" is ambiguous — ${distinct.length} distinct albums share it `
        + `(${distinct.slice(0, 5).join(', ')}${distinct.length > 5 ? ' …' : ''}). `
        + 'Pass collectionPinId (the collection_desc pinId) to verify against a specific album.',
      );
    }
    if (distinct.length === 1) {
      collectionPinId = distinct[0];
    } else {
      // No search row under the exact name: keep the deterministic
      // collection/info resolve (and its "not indexed" teaching error).
      const collection = await fetchMrc721CollectionInfo({ name: collectionName });
      collectionPinId = collection?.pinid || undefined;
      if (!collectionPinId) {
        throw new Error(`collection "${collectionName}" is not indexed (yet) — holdings cannot be verified against an unindexed collection`);
      }
    }
  }
  const items = await fetchMrc721AddressItems({ address: holderAddress, pinId: collectionPinId });
  const live = (items ?? []).filter((item) => !item.burned);
  return {
    holderAddress,
    collectionName,
    collectionPinId,
    holds: live.length > 0,
    count: live.length,
    items: live,
  };
}

// ---------------------------------------------------------------------------
// Confirmation polling (indexing latency = pin confirmation latency)
// ---------------------------------------------------------------------------

const MRC721_POLL_INTERVAL_MS_DEFAULT = 5_000;
const MRC721_POLL_TIMEOUT_MS_DEFAULT = 45_000;

export interface Mrc721PollResult<T> {
  hit: T | null;
  lastError?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll a single-object read until it hits or the timeout elapses. */
export async function pollMrc721Read<T>(
  fetchOnce: () => Promise<T | null>,
  opts?: { timeoutMs?: number; intervalMs?: number },
): Promise<Mrc721PollResult<T>> {
  const timeoutMs = Math.max(0, opts?.timeoutMs ?? MRC721_POLL_TIMEOUT_MS_DEFAULT);
  const intervalMs = Math.max(250, opts?.intervalMs ?? MRC721_POLL_INTERVAL_MS_DEFAULT);
  const startedAt = Date.now();
  let lastError: string | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const hit = await fetchOnce();
      if (hit != null) return { hit };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(Math.min(intervalMs, Math.max(0, timeoutMs - (Date.now() - startedAt))));
  }
  return { hit: null, lastError };
}

/** 轮询 collection/info 直到命中 (R1 确认). */
export function waitForMrc721CollectionInfo(params: {
  name?: string;
  pinId?: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<Mrc721PollResult<Mrc721CollectionSummary>> {
  return pollMrc721Read(
    () => fetchMrc721CollectionInfo({ name: params.name, pinId: params.pinId }),
    { timeoutMs: params.timeoutMs, intervalMs: params.intervalMs },
  );
}

/** 轮询 item/info 直到命中 (R2 确认). */
export function waitForMrc721ItemInfo(params: {
  pinId: string;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<Mrc721PollResult<Mrc721ItemSummary>> {
  return pollMrc721Read(
    () => fetchMrc721ItemInfo({ pinId: params.pinId }),
    { timeoutMs: params.timeoutMs, intervalMs: params.intervalMs },
  );
}

// ---------------------------------------------------------------------------
// Write orchestration (pin construction + broadcast; transfer = plain spend)
// ---------------------------------------------------------------------------

/** Minimal shape of the host-injected createPin (fee/origin applied by caller). */
export type Mrc721CreatePinFn = (
  metabotId: number,
  metaidData: {
    operation: 'create' | 'modify';
    path: string;
    encryption?: '0' | '1' | '2';
    version?: string;
    contentType: string;
    payload: string;
  },
  options?: { feeRate?: number; network?: 'mvc' | 'btc'; origin?: string },
) => Promise<{ txids: string[]; pinId: string; totalCost: number; feeAssist?: unknown }>;

export interface Mrc721PinWriteResult {
  pinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
}

export async function broadcastMrc721Pin(
  createPin: Mrc721CreatePinFn,
  metabotId: number,
  metaidData: Parameters<Mrc721CreatePinFn>[1],
  options?: { network?: 'mvc' | 'btc'; origin?: string },
): Promise<Mrc721PinWriteResult> {
  const result = await createPin(metabotId, metaidData, options);
  return {
    pinId: result.pinId,
    txids: Array.isArray(result.txids) ? result.txids : [],
    totalCost: result.totalCost,
    feeAssist: result.feeAssist,
  };
}

export interface Mrc721CollectionCreateInput {
  metabotId: number;
  collectionName: string;
  name?: string;
  totalSupply?: number;
  royaltyRate?: number;
  desc?: string;
  website?: string;
  cover?: string;
  metadata?: unknown;
  network?: 'mvc' | 'btc';
  origin?: string;
}

/**
 * R1 发行专辑:collection_desc create pin at
 * /nft/mrc721/{collectionName}/collection_desc — registers the
 * (collectionName, issuer) album; a re-issue by the same issuer is ignored by
 * the indexer (no duplicate album, but the fee is still spent).
 */
export async function createMrc721Collection(
  deps: { createPin: Mrc721CreatePinFn },
  input: Mrc721CollectionCreateInput,
): Promise<Mrc721PinWriteResult & { collectionName: string }> {
  const collectionName = validateMrc721CollectionName(input.collectionName);
  const content = buildMrc721CollectionDescContent({
    name: validateMrc721TextField(input.name, 'name', MRC721_FIELD_LIMITS.name) ?? collectionName,
    totalSupply: validateMrc721TotalSupply(input.totalSupply),
    royaltyRate: validateMrc721RoyaltyRate(input.royaltyRate),
    desc: validateMrc721TextField(input.desc, 'desc', MRC721_FIELD_LIMITS.desc),
    website: validateMrc721TextField(input.website, 'website', MRC721_FIELD_LIMITS.website),
    cover: normalizeMrc721CoverUri(input.cover),
    metadata: input.metadata,
  });
  return {
    collectionName,
    ...(await broadcastMrc721Pin(deps.createPin, input.metabotId, {
      operation: 'create',
      path: `${MRC721_PATH_ROOT}/${collectionName}/collection_desc`,
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: JSON.stringify(content),
    }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_collection_create' })),
  };
}

export interface Mrc721CollectionUpdateInput {
  metabotId: number;
  collectionName: string;
  name?: string;
  desc?: string;
  website?: string;
  cover?: string;
  metadata?: unknown;
  network?: 'mvc' | 'btc';
  origin?: string;
  /** Pre-fetched current collection (tests); fetched from the indexer when omitted. */
  current?: Mrc721CollectionSummary | null;
}

export interface Mrc721CollectionUpdateResult extends Mrc721PinWriteResult {
  collectionName: string;
  /** Fields the caller overrode (the rest of the content rides unchanged). */
  updatedFields: string[];
}

/**
 * 收藏级修改:operation=modify pin at the SAME collection_desc path, carrying
 * the FULL latest content (current indexed fields merged with the caller's
 * overrides — a full rewrite, not a diff); the indexer resolves the modify
 * chain's latest version. Issuer-only: the session bot's MVC address must
 * equal the collection_desc creator recorded by the indexer.
 */
export async function updateMrc721Collection(
  deps: { createPin: Mrc721CreatePinFn; store: MetabotStore },
  input: Mrc721CollectionUpdateInput,
): Promise<Mrc721CollectionUpdateResult> {
  const collectionName = validateMrc721CollectionName(input.collectionName);

  const overrides = {
    name: validateMrc721TextField(input.name, 'name', MRC721_FIELD_LIMITS.name),
    desc: validateMrc721TextField(input.desc, 'desc', MRC721_FIELD_LIMITS.desc),
    website: validateMrc721TextField(input.website, 'website', MRC721_FIELD_LIMITS.website),
    cover: normalizeMrc721CoverUri(input.cover),
  };
  const hasMetadataOverride = input.metadata != null
    && (typeof input.metadata !== 'string' || input.metadata.trim() !== '');
  const updatedFields = [
    overrides.name ? 'name' : '',
    overrides.desc ? 'desc' : '',
    overrides.website ? 'website' : '',
    overrides.cover ? 'cover' : '',
    hasMetadataOverride ? 'metadata' : '',
  ].filter(Boolean);
  if (!updatedFields.length) {
    throw new Error('nothing to update — pass at least one of name/desc/website/cover/metadata');
  }

  let current = input.current;
  if (current === undefined) {
    // Issuer-only revision: names are not unique, so collection/info?name=
    // may resolve to the earliest album under the name — possibly someone
    // else's. Resolve the session issuer's OWN album through the issuer-
    // scoped search (mirrors the indexer's issuer-only modify rule).
    const issuerAddress = deps.store.getMetabotById(input.metabotId)?.mvc_address ?? '';
    if (!issuerAddress) {
      throw new Error('the session MetaBot has no MVC address');
    }
    const scan = await scanMrc721CollectionNameForIssuer({ issuerAddress, collectionName });
    if (!scan.own) {
      if (scan.foreign.length) {
        const foreign = scan.foreign[0];
        throw new Error(
          `collection "${collectionName}" is issued by another issuer (${foreign.createMetaId || foreign.createAddress || '?'}) `
          + '— under issuer-only modify rules you can only modify YOUR OWN album under this name, '
          + `and this session bot (${issuerAddress}) has not registered one.`,
        );
      }
      throw new Error(
        `collection "${collectionName}" is not in the index — nothing to modify yet. `
        + 'A collection can only be updated after it is registered and indexed (verify with mrc721_collection_info).',
      );
    }
    current = scan.own;
  }
  if (!current) {
    throw new Error(
      `collection "${collectionName}" is not in the index — nothing to modify yet. `
      + 'A collection can only be updated after it is registered and indexed (verify with mrc721_collection_info).',
    );
  }

  const botAddress = deps.store.getMetabotById(input.metabotId)?.mvc_address ?? '';
  if (!botAddress) {
    throw new Error('the session MetaBot has no MVC address');
  }
  if (!current.createAddress) {
    throw new Error(
      `the indexer did not return the issuer of "${collectionName}" — cannot verify the modify permission; refusing to broadcast.`,
    );
  }
  if (current.createAddress !== botAddress) {
    throw new Error(
      `only the issuing MetaBot can update a collection: "${collectionName}" was issued by `
      + `${current.createAddress}, but this session bot is ${botAddress}.`,
    );
  }

  // Full-content rewrite: latest indexed fields + overrides. totalSupply /
  // royaltyRate ride along unchanged (they are not modifiable in this
  // version); absent index fields stay absent unless overridden.
  const content = buildMrc721CollectionDescContent({
    name: overrides.name ?? current.name ?? collectionName,
    totalSupply: current.totalSupply != null ? validateMrc721TotalSupply(current.totalSupply) : undefined,
    royaltyRate: current.royaltyRate != null ? validateMrc721RoyaltyRate(current.royaltyRate) : undefined,
    desc: overrides.desc ?? current.desc,
    website: overrides.website ?? current.website,
    cover: overrides.cover ?? current.cover,
    metadata: hasMetadataOverride ? input.metadata : current.metadata,
  });

  return {
    collectionName,
    updatedFields,
    ...(await broadcastMrc721Pin(deps.createPin, input.metabotId, {
      operation: 'modify',
      path: `${MRC721_PATH_ROOT}/${collectionName}/collection_desc`,
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: JSON.stringify(content),
    }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_collection_update' })),
  };
}

export interface Mrc721MintInput {
  metabotId: number;
  collectionName: string;
  itemPath?: string;
  name?: string;
  desc?: string;
  cover?: string;
  metadata?: unknown;
  network?: 'mvc' | 'btc';
  origin?: string;
  /** Gap between the mint pin and the item_desc pin (UTXO race safety). */
  settleDelayMs?: number;
}

export interface Mrc721MintResult extends Mrc721PinWriteResult {
  collectionName: string;
  itemPath: string;
  itemDescPinId?: string;
}

/**
 * R2 铸造:an item create pin at /nft/mrc721/{collectionName}/{itemPath}
 * (issuer-only attribution — the pin is collected into the same-name album
 * whose collection_desc author is the minter, so callers must only mint into
 * the session bot's own album, or before it registers as the future issuer);
 * display fields (name/desc/cover/metadata) ride a follow-up item_desc pin
 * referencing the mint pinId (the indexer derives display info ONLY from
 * item_desc, per-field first-write-wins).
 */
export async function createMrc721Mint(
  deps: { createPin: Mrc721CreatePinFn },
  input: Mrc721MintInput,
): Promise<Mrc721MintResult> {
  const collectionName = validateMrc721CollectionName(input.collectionName);
  const itemPath = input.itemPath
    ? validateMrc721ItemPath(input.itemPath)
    : `nft-${randomBytes(4).toString('hex')}`;
  const mint = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: `${MRC721_PATH_ROOT}/${collectionName}/${itemPath}`,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify({}),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_mint' });

  const display = {
    name: validateMrc721TextField(input.name, 'name', MRC721_FIELD_LIMITS.name),
    desc: validateMrc721TextField(input.desc, 'desc', MRC721_FIELD_LIMITS.desc),
    cover: normalizeMrc721CoverUri(input.cover),
  };
  const hasMetadata = input.metadata != null
    && (typeof input.metadata !== 'string' || input.metadata.trim() !== '');
  if (!display.name && !display.desc && !display.cover && !hasMetadata) {
    return { ...mint, collectionName, itemPath };
  }

  // Sequential-pin gap: mirrors syncMetaBotToChain — the wallet-api UTXO list
  // lags behind a just-broadcast tx, so give the spend coordinator snapshot a
  // moment before the next pin re-picks funding.
  const settleDelayMs = Math.max(0, input.settleDelayMs ?? 3_000);
  if (settleDelayMs > 0) await sleep(settleDelayMs);

  const itemDesc = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: `${MRC721_PATH_ROOT}/${collectionName}/item_desc`,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(buildMrc721ItemDescContent([{
      pinid: mint.pinId,
      name: display.name,
      desc: display.desc,
      cover: display.cover,
      metadata: hasMetadata ? input.metadata : undefined,
    }])),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_mint' });
  return { ...mint, collectionName, itemPath, itemDescPinId: itemDesc.pinId };
}

/** Metalet wallet-api host for MVC broadcast (same channel as mvcNftService). */
export const MRC721_METALET_HOST = 'https://www.metalet.space';

/**
 * Broadcast a signed MVC raw tx via the wallet-api v3 endpoint (same channel
 * as the NFT/token backends). Exported so hosts can inject it as
 * transferMrc721Item's broadcastTx dep without re-deriving the contract.
 */
export async function broadcastMvcTx(rawTx: string): Promise<string> {
  const response = await fetch(`${MRC721_METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: 'livenet', rawTx }),
  });
  const json = await response.json() as { code?: number; message?: string; data?: string };
  return resolveBroadcastTxResult(rawTx, json);
}

/** Minimal raw-tx builder contract (satisfied by walletRawTxService). */
/** Minimal raw-tx builder contract (satisfied by walletRawTxService). */
export interface Mrc721RawTxBuildParams {
  metabotId: number;
  toAddress: string;
  amountSats: number;
  feeRate: number;
  includeOutpoints: Array<{ txid: string; vout: number; satoshis: number }>;
}

export interface Mrc721RawTxBuildResult {
  raw_tx: string;
  txid: string;
  spent_outpoints: string[];
}

export interface Mrc721TransferInput {
  store: MetabotStore;
  metabotId: number;
  pinId: string;
  toAddress: string;
  feeRate: number;
  /** Pre-fetched item info (tests); fetched from the indexer when omitted. */
  itemInfo?: Mrc721ItemSummary | null;
}

export interface Mrc721TransferResult {
  txId: string;
  pinId: string;
  toAddress: string;
  /** The item UTXO consumed (item/info output). */
  spentOutpoint: string;
  outputValue: number;
}

/**
 * R3 转移:spend the item pin's current UTXO as input 0 of a plain transfer
 * tx (no protocol message — the indexer rewrites ownership from the spend).
 * The forced outpoint (include_outpoints) + recipient-at-output-0 shape is
 * what the transfer detection keys on.
 */
export async function transferMrc721Item(
  deps: {
    buildRawTx: (store: MetabotStore, params: Mrc721RawTxBuildParams) => Promise<Mrc721RawTxBuildResult>;
    broadcastTx: (rawTx: string) => Promise<string>;
  },
  input: Mrc721TransferInput,
): Promise<Mrc721TransferResult> {
  const pinId = String(input.pinId ?? '').trim();
  if (!isMrc721PinId(pinId)) {
    throw new Error('mrc721_transfer requires a valid pin_id (64-hex txid + "i" + output index)');
  }
  const toAddress = String(input.toAddress ?? '').trim();
  if (!isMvcAddress(toAddress)) {
    throw new Error('mrc721_transfer requires a valid MVC address to send to');
  }

  const item = input.itemInfo !== undefined
    ? input.itemInfo
    : await fetchMrc721ItemInfo({ pinId });
  if (!item) {
    throw new Error(
      `MRC-721 item ${pinId} is not in the index yet (wrong pinId, or the pin is not confirmed/indexed). `
      + 'Verify with mrc721_item_info first.',
    );
  }
  if (item.burned) {
    throw new Error(`MRC-721 item ${pinId} is burned (melted down) and can no longer move.`);
  }
  if (item.genesisChainName && item.genesisChainName !== 'mvc') {
    throw new Error(
      `MRC-721 item ${pinId} is on chain "${item.genesisChainName}"; transfers in this version spend MVC UTXOs only `
      + '(BTC-side items are read-only for now).',
    );
  }

  const botAddress = input.store.getMetabotById(input.metabotId)?.mvc_address ?? '';
  if (!botAddress) {
    throw new Error('the session MetaBot has no MVC address');
  }
  if (item.ownerAddress && item.ownerAddress !== botAddress) {
    throw new Error(
      `MRC-721 item ${pinId} is currently owned by ${item.ownerAddress}, not this session bot (${botAddress}). `
      + 'The index may be stale — re-check with mrc721_item_info — or the item belongs to another wallet.',
    );
  }

  const outpoint = String(item.output ?? '').trim();
  const outpointMatch = /^([0-9a-fA-F]{64}):(\d+)$/.exec(outpoint);
  const outputValue = Number(item.outputValue);
  if (!outpointMatch || !Number.isInteger(outputValue) || outputValue <= 0) {
    throw new Error(
      `MRC-721 item ${pinId} has no spendable current UTXO in the index (output=${item.output || 'none'}). `
      + 'The index may be stale — re-check with mrc721_item_info.',
    );
  }

  const built = await deps.buildRawTx(input.store, {
    metabotId: input.metabotId,
    toAddress,
    amountSats: outputValue,
    feeRate: input.feeRate,
    includeOutpoints: [{
      txid: outpointMatch[1].toLowerCase(),
      vout: Number(outpointMatch[2]),
      satoshis: outputValue,
    }],
  });
  const txId = await deps.broadcastTx(built.raw_tx);
  return {
    txId,
    pinId,
    toAddress,
    spentOutpoint: outpoint,
    outputValue,
  };
}

export {
  buyMrc721Listing,
  listMrc721MySellOrders,
  listMrc721SellOrderRecords,
  mrc721SellOrdersFromSqlite,
  recordMrc721Listing,
  sellMrc721Item,
  verifyMrc721Listing,
  MRC721_ATOMIC_SWAP_SIGHASH,
  MRC721_MIN_SELL_PRICE_SATS,
} from './mrc721AtomicSwapService';
export type { Mrc721AtomicSwapListing, Mrc721SellOrderView } from './mrc721AtomicSwapService';
