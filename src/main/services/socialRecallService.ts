/**
 * Thin client for the metaso-p2p Social Recall API
 * (metaso-p2p docs/downstream/social-recall-api.md): GET /api/social/feed,
 * GET /api/social/post/:pinId and GET /api/social/post/:pinId/comments.
 * Same conventions as the MetaID/MetaApp aggregation APIs: {code, data,
 * message} envelope, HTTP always 200, business error codes 40000/40400/50000.
 *
 * The feed is a coarse candidate set (newest or hot, unranked by preference);
 * hosts pick and rank 3-5 items for the user and may verify them with the
 * detail endpoint.
 */

export const DEFAULT_SOCIAL_RECALL_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;

export type SocialPostAuthor = {
  globalMetaId: string;
  /** Legacy MetaID string — kept for reference only; do not build URIs from it. */
  metaId: string;
  address: string;
};

export type SocialPostPayload = {
  /** Normalized post text (simplebuzz `content` field). */
  content: string;
  contentType: string;
  /** metafile:// references, when the post carries attachments. */
  attachments: string[];
} | null;

export type SocialPostItem = {
  /** Stable source PIN of the first version in the post's chain. */
  pinId: string;
  sourcePinId: string;
  /** Latest version PIN (modify/revoke folded into the same record). */
  currentPinId: string;
  chainName: string;
  protocolPath: string;
  author: SocialPostAuthor;
  contentType: string;
  payload: SocialPostPayload;
  createdAt: number;
  updatedAt: number;
  /**
   * Engagement counts. `null` means the source offered no count for this pin —
   * the index is buzz-only, so metaTask roots, metaapp pins and witness
   * submissions come back without counts. Never coerce a missing count to 0:
   * "unreadable" and a real 0 are different facts downstream.
   */
  likeCount: number | null;
  commentCount: number | null;
  donateCount: number | null;
  quoteCount: number | null;
  /**
   * Which read surface produced the counts above. Today a single surface feeds
   * this type — the metaso-p2p Social Recall API — so every item carries
   * `SOCIAL_COUNTS_CALIBER`; consumers must compare counts only within one
   * caliber. When additional surfaces feed `SocialPostItem` (the remaining
   * scope of issue #58: metaTask roots, metaapp pins, witness submissions),
   * each item names its own surface here.
   */
  countsCaliber: string;
  /** Present only for sort=hot; raw engagement total. */
  hotScore?: number;
};

export type SocialPostPage = {
  items: SocialPostItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type SocialFeedParams = {
  /** Single case-insensitive substring term; mutually exclusive with `keywords`. */
  keyword?: string;
  /** Multi-term search, OR semantics (comma-joined on the wire). */
  keywords?: string[];
  /** One author: GlobalMetaID, MetaID, or address; mutually exclusive with `publishers`. */
  publisher?: string;
  /** Multiple authors, OR semantics. */
  publishers?: string[];
  since?: number;
  until?: number;
  /** `newest` (default) or `hot` (top engagement within the last 48h, no pagination). */
  sort?: 'newest' | 'hot';
  chainName?: string;
  /** `following` = posts by authors the `user` follows (requires `user`). */
  scope?: 'following';
  /** Subject for scope=following. */
  user?: string;
  size?: number;
  cursor?: string;
};

export type SocialCommentItem = {
  pinId: string;
  chainName: string;
  targetPinId: string;
  authorGlobalMetaId: string;
  authorMetaId: string;
  authorAddress: string;
  content: string;
  contentType: string;
  timestamp: number;
};

export type SocialCommentPage = {
  items: SocialCommentItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export class SocialRecallNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SocialRecallNotFoundError';
  }
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

/**
 * Reading caliber (口径) for social engagement counts: names the read surface
 * that produced them. A constant on purpose — every item from this surface
 * must carry the identical value, so cross-channel comparisons can key off it.
 */
export const SOCIAL_COUNTS_CALIBER = 'metaso-p2p:/api/social';

/**
 * Engagement count from a Social Recall payload, or `null` when the source
 * offered nothing. A present finite number — including an explicit 0 — is a
 * real count; an absent/null/empty/non-numeric field is unreadable and stays
 * `null`. The distinction matters because the index is buzz-only: pins
 * outside its coverage (metaTask roots, metaapp pins, witness submissions)
 * legitimately carry no counts, and collapsing that into 0 fabricates
 * engagement that does not exist.
 */
function countOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePayload(raw: unknown): SocialPostPayload {
  if (typeof raw === 'string') {
    const content = raw.trim();
    return content ? { content, contentType: 'text/plain;utf-8', attachments: [] } : null;
  }
  if (raw && typeof raw === 'object') {
    const record = raw as Record<string, unknown>;
    const content = text(record.content);
    if (!content) return null;
    return {
      content,
      contentType: text(record.contentType) || 'text/plain;utf-8',
      attachments: textList(record.attachments),
    };
  }
  return null;
}

function normalizePost(raw: unknown): SocialPostItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const authorRaw = record.author && typeof record.author === 'object'
    ? record.author as Record<string, unknown>
    : {};
  return {
    pinId: text(record.pinId),
    sourcePinId: text(record.sourcePinId),
    currentPinId: text(record.currentPinId),
    chainName: text(record.chainName),
    protocolPath: text(record.protocolPath),
    author: {
      globalMetaId: text(authorRaw.globalMetaId),
      metaId: text(authorRaw.metaId),
      address: text(authorRaw.address),
    },
    contentType: text(record.contentType),
    payload: normalizePayload(record.payload),
    createdAt: Number(record.createdAt) || 0,
    updatedAt: Number(record.updatedAt) || 0,
    likeCount: countOrNull(record.likeCount),
    commentCount: countOrNull(record.commentCount),
    donateCount: countOrNull(record.donateCount),
    quoteCount: countOrNull(record.quoteCount),
    countsCaliber: SOCIAL_COUNTS_CALIBER,
    hotScore: typeof record.hotScore === 'number' ? record.hotScore : undefined,
  };
}

function normalizePostPage(raw: unknown): SocialPostPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.map(normalizePost) : [];
  return {
    items,
    nextCursor: text(record.nextCursor) || null,
    hasMore: record.hasMore === true,
  };
}

function normalizeComment(raw: unknown): SocialCommentItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    pinId: text(record.pinId),
    chainName: text(record.chainName),
    targetPinId: text(record.targetPinId),
    authorGlobalMetaId: text(record.authorGlobalMetaId),
    authorMetaId: text(record.authorMetaId),
    authorAddress: text(record.authorAddress),
    content: text(record.content),
    contentType: text(record.contentType),
    timestamp: Number(record.timestamp) || 0,
  };
}

function normalizeCommentPage(raw: unknown): SocialCommentPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.map(normalizeComment) : [];
  return {
    items,
    nextCursor: text(record.nextCursor) || null,
    hasMore: record.hasMore === true,
  };
}

async function fetchApiData(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`Social Recall API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(body.code);
    if (code === 0) {
      return (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    }
    const message = text(body.message) || 'unknown error';
    if (code === 40400) {
      throw new SocialRecallNotFoundError(message);
    }
    throw new Error(`Social Recall API error ${code}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export type SocialRecallServiceOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: SocialRecallServiceOptions | undefined): Required<SocialRecallServiceOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for Social Recall.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_SOCIAL_RECALL_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** GET /api/social/feed — coarse candidate post retrieval (newest or hot). */
export async function getSocialFeed(
  params: SocialFeedParams,
  options?: SocialRecallServiceOptions,
): Promise<SocialPostPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const query = new URLSearchParams();
  if (params.keywords?.length) {
    query.set('keywords', params.keywords.map((term) => term.trim()).filter(Boolean).join(','));
  } else if (params.keyword?.trim()) {
    query.set('keyword', params.keyword.trim());
  }
  if (params.publishers?.length) {
    query.set('publishers', params.publishers.map((id) => id.trim()).filter(Boolean).join(','));
  } else if (params.publisher?.trim()) {
    query.set('publisher', params.publisher.trim());
  }
  if (typeof params.since === 'number' && params.since > 0) query.set('since', String(Math.floor(params.since)));
  if (typeof params.until === 'number' && params.until > 0) query.set('until', String(Math.floor(params.until)));
  if (params.sort === 'hot') query.set('sort', 'hot');
  if (params.chainName?.trim()) query.set('chainName', params.chainName.trim());
  if (params.scope === 'following') {
    query.set('scope', 'following');
    if (params.user?.trim()) query.set('user', params.user.trim());
  }
  if (typeof params.size === 'number' && params.size > 0) query.set('size', String(Math.min(100, Math.floor(params.size))));
  if (params.cursor?.trim()) query.set('cursor', params.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(`${baseUrl}/api/social/feed${qs ? `?${qs}` : ''}`, fetchImpl, timeoutMs);
  return normalizePostPage(data);
}

/** GET /api/social/post/:pinId — aggregated post detail by any version PIN. */
export async function getSocialPost(
  pinId: string,
  options?: SocialRecallServiceOptions,
): Promise<SocialPostItem> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const trimmed = pinId.trim();
  if (!trimmed) throw new Error('pinId is required to fetch a social post.');
  const data = await fetchApiData(`${baseUrl}/api/social/post/${encodeURIComponent(trimmed)}`, fetchImpl, timeoutMs);
  return normalizePost(data);
}

/** GET /api/social/post/:pinId/comments — comments attached to a post. */
export async function getSocialPostComments(
  input: { pinId: string; size?: number; cursor?: string },
  options?: SocialRecallServiceOptions,
): Promise<SocialCommentPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const pinId = input.pinId.trim();
  if (!pinId) throw new Error('pinId is required to list social post comments.');
  const query = new URLSearchParams();
  if (typeof input.size === 'number' && input.size > 0) query.set('size', String(Math.min(100, Math.floor(input.size))));
  if (input.cursor?.trim()) query.set('cursor', input.cursor.trim());
  const qs = query.toString();
  const data = await fetchApiData(
    `${baseUrl}/api/social/post/${encodeURIComponent(pinId)}/comments${qs ? `?${qs}` : ''}`,
    fetchImpl,
    timeoutMs,
  );
  return normalizeCommentPage(data);
}
