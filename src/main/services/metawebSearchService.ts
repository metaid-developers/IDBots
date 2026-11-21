/**
 * Thin client for the metaso-p2p MetaWeb unified search API
 * (metaso-p2p docs/specs/2026-08-23-metaweb-search-api.md):
 * GET /api/metaweb/search. Same conventions as the other aggregation APIs:
 * {code, data, message} envelope, HTTP always 200, business error codes
 * 40000/40400/50000.
 *
 * One keyword query fans out over every knowledge-bearing protocol the node
 * indexes (simplenote, simplebuzz, metaapp, metabot-skill, skill-service,
 * metaprotocol) and returns a relevance-ranked candidate list with
 * title/summary/pinId. This list is the search-engine results page, not the
 * content — the bot opens chosen pins via the pin-read API
 * (metawebPinService).
 */

export const DEFAULT_METAWEB_SEARCH_BASE_URL = 'https://so.metaid.io';
const DEFAULT_TIMEOUT_MS = 10_000;

/** Protocol keys the unified search can filter by (phase-1 coverage). */
export type MetawebSearchProtocol =
  | 'simplenote'
  | 'simplebuzz'
  | 'metaapp'
  | 'metabot-skill'
  | 'skill-service'
  | 'metaprotocol'
  | 'mrc721-collection'
  | 'mrc721-listing'
  | 'simplequestion'
  | 'simpleanswer';

export type MetawebSearchPublisher = {
  globalMetaId: string;
  metaid: string;
  name: string;
  /** Raw metafile:// URI (unresolved); the pin-read API resolves attachments server-side instead. */
  avatar: string;
};

export type MetawebSearchItem = {
  /** Protocol key from the spec's table, e.g. 'simplenote'. */
  protocol: string;
  /** Source PIN of the record's version chain. */
  pinId: string;
  /** Latest version PIN in the modify chain — open this one via the pin-read API. */
  currentPinId: string;
  chainName: string;
  title: string;
  summary: string;
  tags: string[];
  publisher: MetawebSearchPublisher;
  /** Unix seconds. */
  createdAt: number;
  /** Relevance score; 0 when sort=newest. */
  score: number;
  /** Protocol-specific highlights (metaapp runtime, service price, …); may be empty. */
  extra: Record<string, unknown>;
};

export type MetawebSearchPage = {
  items: MetawebSearchItem[];
  nextCursor: string | null;
  hasMore: boolean;
};

export type MetawebSearchParams = {
  /** Keyword query; CJK-aware tokenization server-side. Required. */
  q: string;
  /** Restrict to these protocol keys; default searches every indexed protocol. */
  protocols?: MetawebSearchProtocol[];
  /** Publisher filter: GlobalMetaID or MetaID, exact match. */
  publisher?: string;
  since?: number;
  until?: number;
  /** `relevance` (default, scored) or `newest` (createdAt desc, scoring bypassed). */
  sort?: 'relevance' | 'newest';
  /** Page size; the server clamps > 50 to 50. */
  size?: number;
  cursor?: string;
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim()).filter(Boolean);
}

function normalizePublisher(raw: unknown): MetawebSearchPublisher {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    globalMetaId: text(record.globalMetaId),
    metaid: text(record.metaid ?? record.metaId),
    name: text(record.name),
    avatar: text(record.avatar),
  };
}

function normalizeItem(raw: unknown): MetawebSearchItem {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    protocol: text(record.protocol),
    pinId: text(record.pinId),
    currentPinId: text(record.currentPinId) || text(record.pinId),
    chainName: text(record.chainName),
    title: text(record.title),
    summary: text(record.summary),
    tags: textList(record.tags),
    publisher: normalizePublisher(record.publisher),
    createdAt: Number(record.createdAt) || 0,
    score: Number(record.score) || 0,
    extra: (record.extra && typeof record.extra === 'object' ? record.extra : {}) as Record<string, unknown>,
  };
}

function normalizePage(raw: unknown): MetawebSearchPage {
  const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.map(normalizeItem) : [];
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
    let response: Response;
    try {
      response = await fetchImpl(url, {
        signal: controller.signal,
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      // Map the raw AbortError to an actionable timeout message — the model
      // sees this text verbatim in the tool result.
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`MetaWeb search API timed out after ${Math.round(timeoutMs / 1000)}s — try again, or narrow the query.`);
      }
      throw error;
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') {
      throw new Error(`MetaWeb search API returned an invalid response (HTTP ${response.status}).`);
    }
    const code = Number(body.code);
    if (code === 0) {
      return (body.data && typeof body.data === 'object' ? body.data : {}) as Record<string, unknown>;
    }
    const message = text(body.message) || 'unknown error';
    throw new Error(`MetaWeb search API error ${code}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

export type MetawebSearchServiceOptions = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

function resolveOptions(options: MetawebSearchServiceOptions | undefined): Required<MetawebSearchServiceOptions> {
  const fetchImpl = options?.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('A fetch implementation is required for MetaWeb search.');
  }
  return {
    baseUrl: (options?.baseUrl ?? DEFAULT_METAWEB_SEARCH_BASE_URL).replace(/\/+$/, ''),
    fetchImpl,
    timeoutMs: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}

/** GET /api/metaweb/search — unified cross-protocol knowledge search. */
export async function searchMetaweb(
  params: MetawebSearchParams,
  options?: MetawebSearchServiceOptions,
): Promise<MetawebSearchPage> {
  const { baseUrl, fetchImpl, timeoutMs } = resolveOptions(options);
  const q = params.q.trim();
  if (!q) throw new Error('q is required for MetaWeb search.');
  const query = new URLSearchParams();
  query.set('q', q);
  if (params.protocols?.length) {
    query.set('protocols', params.protocols.map((key) => key.trim()).filter(Boolean).join(','));
  }
  if (params.publisher?.trim()) query.set('publisher', params.publisher.trim());
  if (typeof params.since === 'number' && params.since > 0) query.set('since', String(Math.floor(params.since)));
  if (typeof params.until === 'number' && params.until > 0) query.set('until', String(Math.floor(params.until)));
  if (params.sort === 'newest') query.set('sort', 'newest');
  if (typeof params.size === 'number' && params.size > 0) query.set('size', String(Math.min(50, Math.floor(params.size))));
  if (params.cursor?.trim()) query.set('cursor', params.cursor.trim());
  const data = await fetchApiData(`${baseUrl}/api/metaweb/search?${query.toString()}`, fetchImpl, timeoutMs);
  return normalizePage(data);
}
