import { fetchProtocolPinsFromIndexer, type ProtocolPinRecord } from '../protocolPinFetch';
import { looksLikeContentUrl } from '../protocolPinContent';
import {
  METATASK_COLLECTED_PATHS,
  METATASK_ROSTER_SEGMENT,
  metataskPoolPath,
  type MetaTaskCollectedPath,
} from './constants';
import type { MetaTaskChainEvent } from './types';

/**
 * MetaTask chain-event collector: walks all ten /protocols/metatask* pools
 * (the nine event paths + the flat /protocols/metatask-roster pool) via
 * pins_by_path with cursor pagination to the empty page (protocol §10.8;
 * an empty pool returns `"list": null` and must be tolerated), merges the
 * local P2P base with manapi, dedups by pinId, and normalizes each item into
 * the engine's MetaTaskChainEvent shape (body parsed from contentBody base64,
 * falling back to contentSummary — same decoding order as the reference
 * Python engine).
 *
 * Content recovery (MAN-p2p f23e8ec): list rows now carry `contentSummary`
 * truncated to the first 4096 bytes of the body, an empty `contentBody`, and
 * `content` = a download URL serving the raw full body. A truncated body makes
 * the replay drop every node of a large tree pin, so rows whose inline body is
 * missing or visibly shorter than the row's declared `contentLength` are
 * refetched from that URL (bounded concurrency, one extra request only for the
 * rows that need it; a healthy small pin issues none).
 */

/** manapi silently falls back to 20 rows/page for size > 100. */
const DEFAULT_PAGE_SIZE = 100;
/**
 * Page the walk to the EMPTY cursor page. The indexer caps each page by
 * response bytes (~19KB), so a pool carrying giant payloads yields only a few
 * rows per page regardless of `size` — a 281-row pool can then need hundreds
 * of pages. The cap below is a runaway guard, not a budget: live cursors are
 * surfaced through onTruncated instead of silently dropped (deep-event loss,
 * 2026-10-13 RSI case).
 */
const DEFAULT_MAX_PAGES = 1000;

/** Extra content downloads per sweep (rows needing recovery only). */
const CONTENT_RECOVERY_CONCURRENCY = 4;
const CONTENT_FETCH_TIMEOUT_MS = 8_000;
/** Refuse a pathological download rather than buffering it on the main thread. */
const CONTENT_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The indexer truncates `contentSummary` to the first 4096 bytes, but JSON
 * escaping can legitimately shift the byte count, so a declared length only
 * counts as "longer than what we have" past this margin.
 */
const TRUNCATION_MARGIN_BYTES = 16;

const parseBody = (item: Record<string, unknown>): Record<string, unknown> => {
  const contentBody = item.contentBody;
  if (typeof contentBody === 'string' && contentBody) {
    try {
      const parsed = JSON.parse(Buffer.from(contentBody, 'base64').toString('utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to contentSummary
    }
  }
  const contentSummary = item.contentSummary;
  if (typeof contentSummary === 'string' && contentSummary) {
    try {
      const parsed = JSON.parse(contentSummary);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through to empty body
    }
  }
  return {};
};

const normalizeTimestampMs = (value: unknown): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed >= 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
};

const isEmptyBody = (body: Record<string, unknown>): boolean => Object.keys(body).length === 0;

/** Byte length of the inline summary exactly as the indexer would count it. */
const inlineSummaryByteLength = (item: Record<string, unknown>): number =>
  typeof item.contentSummary === 'string' ? Buffer.byteLength(item.contentSummary, 'utf8') : 0;

const declaredContentLength = (item: Record<string, unknown>): number | null => {
  const value = Number(item.contentLength);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
};

/**
 * The download URL to refetch when this row's inline body may be truncated,
 * or null when the inline body is complete (a healthy small pin must never
 * cost a request).
 *
 *  - no usable body at all ({} = parse failure or absent) + a content URL → refetch;
 *  - the row declares more bytes than the inline summary holds (beyond the
 *    escaping margin) → refetch even though the summary parsed. A non-empty
 *    `contentBody` is the full payload by contract (pre-f23e8ec list format), so
 *    such rows never qualify.
 */
export const contentRecoveryUrl = (
  item: Record<string, unknown>,
  body: Record<string, unknown>
): string | null => {
  const url = typeof item.content === 'string' ? item.content.trim() : '';
  // A content-download URL is never the body (protocolPinContent semantics).
  if (!looksLikeContentUrl(url)) return null;
  if (isEmptyBody(body)) return url;
  const contentBody = item.contentBody;
  if (typeof contentBody === 'string' && contentBody.trim()) return null;
  const declared = declaredContentLength(item);
  if (declared === null) return null;
  return declared > inlineSummaryByteLength(item) + TRUNCATION_MARGIN_BYTES ? url : null;
};

/**
 * Fetch a pin's full body from its content URL (plain text → JSON object).
 * Any failure — non-2xx, timeout, transport error, non-object JSON, oversized
 * body — returns null so the caller keeps whatever it parsed inline.
 */
const fetchContentBody = async (
  url: string,
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
): Promise<Record<string, unknown> | null> => {
  const impl = fetchImpl ?? fetch;
  const init: RequestInit = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(CONTENT_FETCH_TIMEOUT_MS);
  }
  try {
    const response = await impl(url, init);
    if (!response.ok) return null;
    const text = await response.text();
    if (text.length > CONTENT_MAX_BYTES) return null;
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Refetch the pending rows with bounded concurrency, patching bodies in place. */
export const recoverTruncatedBodies = async (
  pending: { event: { body: Record<string, unknown> }; url: string }[],
  fetchImpl: ((input: string, init?: RequestInit) => Promise<Response>) | undefined
): Promise<void> => {
  if (pending.length === 0) return;
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONTENT_RECOVERY_CONCURRENCY, pending.length) },
    async () => {
      while (cursor < pending.length) {
        const index = cursor;
        cursor += 1;
        const { event, url } = pending[index];
        const body = await fetchContentBody(url, fetchImpl);
        if (body) event.body = body; // else keep the inline (possibly empty) body
      }
    }
  );
  await Promise.all(workers);
};

export const normalizeChainEvent = (
  pinId: string,
  rawItem: Record<string, unknown>,
  fallbackTimestampMs: number | null
): MetaTaskChainEvent | null => {
  const path = String(rawItem.path ?? '').split('/').pop() ?? '';
  const heightRaw = Number(rawItem.genesisHeight);
  const height = Number.isFinite(heightRaw) ? Math.floor(heightRaw) : -1;
  if (!pinId || !path) return null;
  return {
    pinId,
    path: path as MetaTaskCollectedPath,
    author: typeof rawItem.globalMetaId === 'string' ? rawItem.globalMetaId : '',
    height,
    txIndex: Number.isFinite(Number(rawItem.txIndex)) ? Number(rawItem.txIndex) : 0,
    timestampMs: normalizeTimestampMs(rawItem.timestamp) || (fallbackTimestampMs ?? 0),
    body: parseBody(rawItem),
  };
};

/**
 * Index collected roster pins by pinId for the engine's `rosterPins` option
 * (same-side review filtering). The body is the parsed pin content as-is:
 * `metatask_publish` writes `{ groups: string[][], owner, createdAt }`, which
 * is exactly the shape `rosterGroupsFor` reads. Roster bodies are reference
 * data — a malformed one yields no groups and therefore no filtering.
 */
export const rosterPinsFromEvents = (
  events: MetaTaskChainEvent[]
): Record<string, unknown> => {
  const pins: Record<string, unknown> = {};
  for (const event of events) {
    if (event.path === METATASK_ROSTER_SEGMENT) pins[event.pinId] = event.body;
  }
  return pins;
};

export interface CollectMetaTaskEventsOptions {
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  /**
   * Skip the process-wide walk memo (write-following sweeps must observe pins
   * pinned after the memo snapshot). See protocolPinFetch for the memo/probe
   * mechanics (egress guard, ticket 2026-11-08).
   */
  bypassCache?: boolean;
}

export interface CollectMetaTaskEventsResult {
  events: MetaTaskChainEvent[];
  perPath: { path: MetaTaskCollectedPath; count: number; error?: string }[];
}

export async function collectMetaTaskEvents(
  options: CollectMetaTaskEventsOptions = {}
): Promise<CollectMetaTaskEventsResult> {
  const events: MetaTaskChainEvent[] = [];
  const perPath: { path: MetaTaskCollectedPath; count: number }[] = [];
  // Rows whose inline body looks truncated; fetched once, after the walk.
  const pendingRecoveries: { event: MetaTaskChainEvent; url: string }[] = [];

  // Keep the whole raw item as "content" so the normalizer can read
  // genesisHeight / txIndex / globalMetaId / contentBody.
  const keepRaw = (item: Record<string, unknown>): unknown => item;

  for (const segment of METATASK_COLLECTED_PATHS) {
    // A single slow page (8s timeout) must not silently zero an entire pool:
    // one retry, then surface the failure in perPath instead of swallowing it
    // (2026-10-13: a transient submission-walk timeout starved the health-
    // metrics task projection while every pin sat readable on chain).
    let pins: ProtocolPinRecord[] = [];
    let walkError: string | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let failed = false;
      try {
        pins = await fetchProtocolPinsFromIndexer(metataskPoolPath(segment), {
          pageSize: options.pageSize ?? DEFAULT_PAGE_SIZE,
          maxPages: options.maxPages ?? DEFAULT_MAX_PAGES,
          timeoutMs: options.timeoutMs ?? 8_000,
          fetchImpl: options.fetchImpl,
          bypassCache: options.bypassCache,
          selectContent: keepRaw,
          onTruncated: (info) => {
            console.warn('[metatask/collector] pool walk ended short of the empty page:', info);
            if (info.reason === 'fetch-error') failed = true;
          },
        });
        walkError = undefined;
        if (!failed) break;
        walkError = 'page walk aborted mid-pool (fetch error)';
      } catch (error) {
        pins = []; // a failed path must not fail the whole sweep
        walkError = error instanceof Error ? error.message : String(error);
      }
      if (attempt === 0) continue;
      console.warn(`[metatask/collector] pool walk failed after retry (${segment}):`, walkError);
    }
    let count = 0;
    for (const pin of pins) {
      const rawItem = (pin.content && typeof pin.content === 'object' ? pin.content : {}) as Record<string, unknown>;
      const event = normalizeChainEvent(pin.pinId, rawItem, pin.timestampMs ?? null);
      if (event && event.path === segment) {
        events.push(event);
        // The row may come from the local P2P base, but the content URL is
        // absolute — fetch it as-is.
        const recoveryUrl = contentRecoveryUrl(rawItem, event.body);
        if (recoveryUrl) pendingRecoveries.push({ event, url: recoveryUrl });
        count += 1;
      }
    }
    perPath.push({ path: segment, count, ...(walkError ? { error: walkError } : {}) });
  }

  await recoverTruncatedBodies(pendingRecoveries, options.fetchImpl);
  return { events, perPath };
}
