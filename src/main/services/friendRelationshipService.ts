/**
 * Thin client for the metaso-p2p social relationship APIs — the friend &
 * block aggregation of docs/specs/2026-10-29-social-friend-block-api.md
 * (batch relationships, friends list, counts, blocks) plus the shipped
 * follow lists of docs/specs/2026-06-20-social-follow-api.md. Same
 * transport conventions as metaIdSearchService: {code, data, message}
 * envelope, HTTP always 200, business error codes 40000/40400/50000.
 *
 * The provider half (MetasoFriendRelationshipProvider) backs
 * MetaIDRelationshipResolver's FriendRelationshipProvider seam: one batch
 * call answers the friend fold AND the bidirectional block flags, with a
 * short TTL cache and a failure circuit breaker so an unreachable or not
 * yet deployed API degrades to 'unknown' without taxing every chat turn.
 */

import type {
  FriendPairState,
  FriendRelationshipProvider,
  FriendRelationshipStatus,
} from './metaidRelationshipResolver';
import { normalizeGlobalMetaID } from '../shared/globalMetaId';

export const DEFAULT_SOCIAL_API_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_FAILURE_THRESHOLD = 2;
const DEFAULT_BREAKER_COOLDOWN_MS = 60_000;

export type SocialRelation = 'friend' | 'follower' | 'following' | 'stranger' | 'blocked';

export type SocialPairRelationship = {
  /** Canonical GlobalMetaID of the target (echoed by the API). */
  globalMetaId: string;
  /** Single-value fold: blocked > friend > following > follower > stranger. */
  relation: SocialRelation;
  isFriend: boolean;
  /** target→source active follow edge (the peer follows the source). */
  followsMe: boolean;
  /** source→target active follow edge (the source follows the peer). */
  followedByMe: boolean;
  /** source currently blocks target. */
  blocking: boolean;
  /** target currently blocks source. */
  blockedBy: boolean;
};

export type SocialProfileItem = {
  globalMetaId: string;
  name: string;
  nameId: string;
  avatarId: string;
  bio: string;
  bioId: string;
  followedAt: number;
  followPinId: string;
  friendSince: number;
};

export type SocialBlockItem = SocialProfileItem & {
  direction: 'blocking' | 'blockedBy';
  blockedAt: number;
  blockPinId: string;
};

export type SocialListPage<Item = SocialProfileItem> = {
  items: Item[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type SocialCounts = {
  followers: number;
  following: number;
  friends: number;
  blockedCount: number;
  blockedByCount: number;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function flag(value: unknown): boolean {
  return value === true;
}

function normalizeRelation(value: unknown): SocialRelation {
  const relation = text(value);
  return relation === 'friend' || relation === 'follower' || relation === 'following'
    || relation === 'stranger' || relation === 'blocked'
    ? relation
    : 'stranger';
}

function normalizePairRelationship(raw: unknown): SocialPairRelationship {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    globalMetaId: text(record.globalMetaId),
    relation: normalizeRelation(record.relation),
    isFriend: flag(record.isFriend),
    followsMe: flag(record.followsMe),
    followedByMe: flag(record.followedByMe),
    blocking: flag(record.blocking),
    blockedBy: flag(record.blockedBy),
  };
}

function normalizeProfileItem(raw: unknown): SocialProfileItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    globalMetaId: text(record.globalMetaId),
    name: text(record.name),
    nameId: text(record.nameId),
    avatarId: text(record.avatarId),
    bio: text(record.bio),
    bioId: text(record.bioId),
    followedAt: Number(record.followedAt) || 0,
    followPinId: text(record.followPinId),
    friendSince: Number(record.friendSince) || 0,
  };
}

function normalizeBlockItem(raw: unknown): SocialBlockItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    ...normalizeProfileItem(record),
    direction: text(record.direction) === 'blockedBy' ? 'blockedBy' : 'blocking',
    blockedAt: Number(record.blockedAt) || 0,
    blockPinId: text(record.blockPinId),
  };
}

function normalizeListPage<Item>(raw: unknown, normalizeItem: (entry: unknown) => Item): SocialListPage<Item> {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const nextCursor = text(record.nextCursor);
  return {
    items: Array.isArray(record.list) ? record.list.map(normalizeItem) : [],
    nextCursor: nextCursor || null,
    hasMore: Boolean(nextCursor),
  };
}

function normalizeCounts(raw: unknown): SocialCounts {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    followers: Number(record.followers) || 0,
    following: Number(record.following) || 0,
    friends: Number(record.friends) || 0,
    blockedCount: Number(record.blockedCount) || 0,
    blockedByCount: Number(record.blockedByCount) || 0,
  };
}

export type SocialApiOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: SocialApiOptions | undefined): Required<SocialApiOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for the social relationship API.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_SOCIAL_API_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

async function fetchApiData(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
  init?: { method?: 'GET' | 'POST'; body?: string },
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      method: init?.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(init?.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init?.body ? { body: init.body } : {}),
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`Social relationship API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(body.code);
    if (code === 0) {
      return (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    }
    const message = text(body.message) || 'unknown error';
    if (code === 40400) {
      throw new SocialSubjectNotFoundError(message);
    }
    throw new Error(`Social relationship API error ${code}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export class SocialSubjectNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialSubjectNotFoundError';
  }
}

/** POST /api/social/relationships/batch — one call answers the relation to each target. */
export async function fetchSocialRelationships(
  params: { source: string; targets: string[] },
  options?: SocialApiOptions,
): Promise<SocialPairRelationship[]> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const targets = params.targets.map((target) => target.trim()).filter(Boolean);
  if (!params.source.trim() || targets.length === 0 || targets.length > 100) {
    throw new Error('fetchSocialRelationships requires a source and 1..100 targets.');
  }
  const data = await fetchApiData(`${baseUrl}/api/social/relationships/batch`, fetchImpl, timeoutMs, {
    method: 'POST',
    body: JSON.stringify({ sourceGlobalMetaId: params.source.trim(), targets }),
  });
  return Array.isArray(data.list) ? data.list.map(normalizePairRelationship) : [];
}

async function fetchListPage(
  path: string,
  query: { cursor?: string; size?: number; extra?: Record<string, string> },
  options: SocialApiOptions | undefined,
  normalizeItem: (entry: unknown) => SocialProfileItem,
): Promise<SocialListPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const search = new URLSearchParams();
  if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
  if (typeof query.size === 'number' && query.size > 0) {
    search.set('size', String(Math.min(100, Math.floor(query.size))));
  }
  for (const [key, value] of Object.entries(query.extra ?? {})) {
    if (value) search.set(key, value);
  }
  const qs = search.toString();
  const data = await fetchApiData(`${baseUrl}${path}${qs ? `?${qs}` : ''}`, fetchImpl, timeoutMs);
  return normalizeListPage(data, normalizeItem);
}

/** GET /api/social/globalmetaid/:id/friends — mutual-follow list (block-filtered). */
export function fetchFriendList(
  identity: string,
  query: { cursor?: string; size?: number } = {},
  options?: SocialApiOptions,
): Promise<SocialListPage> {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch a friends list.');
  return fetchListPage(`/api/social/globalmetaid/${encodeURIComponent(trimmed)}/friends`, query, options, normalizeProfileItem);
}

/** GET /api/social/globalmetaid/:id/following — whom the subject follows. */
export function fetchFollowingList(
  identity: string,
  query: { cursor?: string; size?: number } = {},
  options?: SocialApiOptions,
): Promise<SocialListPage> {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch a following list.');
  return fetchListPage(`/api/social/globalmetaid/${encodeURIComponent(trimmed)}/following`, query, options, normalizeProfileItem);
}

/** GET /api/social/globalmetaid/:id/followers — who follows the subject. */
export function fetchFollowerList(
  identity: string,
  query: { cursor?: string; size?: number } = {},
  options?: SocialApiOptions,
): Promise<SocialListPage> {
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch a followers list.');
  return fetchListPage(`/api/social/globalmetaid/${encodeURIComponent(trimmed)}/followers`, query, options, normalizeProfileItem);
}

/** GET /api/social/globalmetaid/:id/blocks — simpleblock aggregation read model. */
export async function fetchBlockList(
  identity: string,
  query: { type?: 'all' | 'blocking' | 'blockedBy'; cursor?: string; size?: number } = {},
  options?: SocialApiOptions,
): Promise<SocialListPage<SocialBlockItem>> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch a blocks list.');
  const type = query.type === 'blocking' || query.type === 'blockedBy' ? query.type : 'all';
  const search = new URLSearchParams({ type });
  if (query.cursor?.trim()) search.set('cursor', query.cursor.trim());
  if (typeof query.size === 'number' && query.size > 0) {
    search.set('size', String(Math.min(100, Math.floor(query.size))));
  }
  const data = await fetchApiData(
    `${baseUrl}/api/social/globalmetaid/${encodeURIComponent(trimmed)}/blocks?${search.toString()}`,
    fetchImpl,
    timeoutMs,
  );
  return normalizeListPage<SocialBlockItem>(data, normalizeBlockItem);
}

/** GET /api/social/globalmetaid/:id/counts — all relationship counters in one call. */
export async function fetchSocialCounts(identity: string, options?: SocialApiOptions): Promise<SocialCounts> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const trimmed = identity.trim();
  if (!trimmed) throw new Error('identity is required to fetch social counts.');
  const data = await fetchApiData(
    `${baseUrl}/api/social/globalmetaid/${encodeURIComponent(trimmed)}/counts`,
    fetchImpl,
    timeoutMs,
  );
  return normalizeCounts(data);
}

export interface MetasoFriendProviderOptions extends SocialApiOptions {
  /** Result cache TTL; short by design — friend state is per-turn context. */
  cacheTtlMs?: number;
  /** Consecutive failures before the breaker opens. */
  failureThreshold?: number;
  /** How long the breaker stays open once tripped. */
  breakerCooldownMs?: number;
  now?: () => number;
}

interface CachedPairState {
  state: FriendPairState;
  expiresAt: number;
}

/**
 * FriendRelationshipProvider implementation backed by the metaso-p2p social
 * API. Failure policy: any throw propagates to the resolver (which folds it
 * into 'unknown'), but after `failureThreshold` consecutive failures the
 * breaker opens and subsequent calls short-circuit to unknown without
 * touching the network — an absent endpoint must not add latency to every
 * private-chat turn.
 */
export class MetasoFriendRelationshipProvider implements FriendRelationshipProvider {
  private readonly options: SocialApiOptions;
  private readonly cacheTtlMs: number;
  private readonly failureThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CachedPairState>();
  private consecutiveFailures = 0;
  private breakerOpenUntil = 0;

  constructor(options: MetasoFriendProviderOptions = {}) {
    this.options = options;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.breakerCooldownMs = options.breakerCooldownMs ?? DEFAULT_BREAKER_COOLDOWN_MS;
    this.now = options.now ?? Date.now;
  }

  async resolveFriendStatus(input: {
    firstGlobalMetaID: string;
    secondGlobalMetaID: string;
  }): Promise<FriendRelationshipStatus> {
    const pair = await this.resolvePairState(input);
    return pair.status;
  }

  async resolvePairState(input: {
    firstGlobalMetaID: string;
    secondGlobalMetaID: string;
  }): Promise<FriendPairState> {
    const first = normalizeGlobalMetaID(input.firstGlobalMetaID);
    const second = normalizeGlobalMetaID(input.secondGlobalMetaID);
    if (!first || !second || first === second) {
      return { status: 'unknown', blocking: null, blockedBy: null, followsMe: null, followedByMe: null };
    }
    const key = `${first}\u0000${second}`;
    const now = this.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) return cached.state;
    if (this.breakerOpenUntil > now) {
      return { status: 'unknown', blocking: null, blockedBy: null, followsMe: null, followedByMe: null };
    }
    try {
      const [relationship] = await fetchSocialRelationships(
        { source: first, targets: [second] },
        this.options,
      );
      if (!relationship || !relationship.globalMetaId) {
        throw new Error('Social relationship API returned no entry for the requested target.');
      }
      // The fold carries 'blocked' separately from friendship; the resolver's
      // friend fact stays tri-state while the block flags ride alongside.
      // The directional /follow flags (S6 defect #4) ride along the same
      // record so callers can distinguish the three pre-friend states
      // (neither follows / peer follows me / I follow the peer).
      const state: FriendPairState = {
        status: relationship.relation === 'friend' ? 'confirmed' : 'not_confirmed',
        blocking: relationship.blocking,
        blockedBy: relationship.blockedBy,
        followsMe: relationship.followsMe,
        followedByMe: relationship.followedByMe,
      };
      this.cache.set(key, { state, expiresAt: now + this.cacheTtlMs });
      this.consecutiveFailures = 0;
      return state;
    } catch (error) {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.breakerOpenUntil = now + this.breakerCooldownMs;
        this.consecutiveFailures = 0;
      }
      throw error;
    }
  }
}
