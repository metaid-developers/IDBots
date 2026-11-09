import { getConfiguredP2PLocalBase } from './p2pLocalEndpoint';
import { selectProtocolPinContent } from './protocolPinContent';

export interface ProtocolPinRecord {
  pinId: string;
  content: unknown;
  timestampMs?: number | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchProtocolPinsOptions {
  pageSize?: number;
  maxPages?: number;
  /**
   * Per-page fetch timeout. Defaults to DEFAULT_TIMEOUT_MS. Callers may pass
   * a tighter budget, but a per-page threshold below real-world cold-start
   * latency (~2.1-2.2s on proxied/TUN paths, measured 2026-10-22 against the
   * same endpoint family) aborts every cold page into a whole-walk
   * fetch-error, so the default deliberately keeps multiple seconds of
   * headroom.
   */
  timeoutMs?: number;
  localBaseUrl?: string;
  remoteBaseUrl?: string;
  fetchImpl?: FetchLike;
  selectContent?: (item: Record<string, unknown>) => unknown;
  /**
   * Invoked when a page walk ends short of the empty cursor page:
   *  - reason 'max-pages': the walk stopped at `maxPages` with a live cursor
   *    (the indexer caps each page by response bytes, so giant payloads can
   *    shrink a page to a handful of rows);
   *  - reason 'fetch-error': a page fetch failed mid-walk (timeout, non-2xx,
   *    transport error) — the rows fetched so far are a partial prefix.
   * Callers that must reach the empty page (metaTask sweeps) need to know the
   * walk fell short instead of silently losing deep events.
   */
  onTruncated?: (info: {
    baseUrl: string;
    protocolPath: string;
    pages: number;
    rows: number;
    reason: 'max-pages' | 'fetch-error';
  }) => void;
  /**
   * Egress-guard ticket 2026-11-08 (staging polling flood): TTL for the
   * process-wide memo of complete full walks. Repeat calls for the same
   * (path, pageSize, maxPages) inside the window are served from memory —
   * zero requests. 0 disables the memo. Default 5 minutes.
   */
  memoTtlMs?: number;
  /**
   * Egress-guard: incremental head-stop. The indexer lists pins by timestamp
   * descending (verified 2026-11-08: cursor embeds the last row's timestamp),
   * so new pins surface at the head. After one complete full walk per
   * (path, params), subsequent walks probe at most `probeMaxPages` head pages
   * and stop at the first page whose rows are ALL already known; if no
   * all-known page is found within the probe budget, the walk falls back to a
   * full walk (never worse than the old behavior). A periodic full re-walk
   * (`fullRewalkMs`) heals any theoretically deep late-confirmation insert.
   * Consumers must tolerate receiving a subset (they all merge into a durable
   * local store keyed by pinId). Default true.
   */
  incremental?: boolean;
  /** Full re-walk cadence for the incremental mode (default 6h). */
  fullRewalkMs?: number;
  /** Head-page probe budget before falling back to a full walk (default 3). */
  probeMaxPages?: number;
  /**
   * Skip the memo READ for this call (write-following sweeps must observe
   * pins pinned after the memo was filled). The incremental probe still runs
   * — it walks head pages and necessarily covers freshly pinned rows.
   */
  bypassCache?: boolean;
  /** Clock seam (default Date.now) — tests. */
  now?: () => number;
}

interface ProtocolPinRecordWithOrder extends ProtocolPinRecord {
  sourceOrder: number;
}

/** A raw list row kept before selectContent, so the memo can serve any mapper. */
interface RawPinRow {
  pinId: string;
  timestampMs: number | null;
  sourceOrder: number;
  rawItem: Record<string, unknown>;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 10;
// 2026-10-24: the previous 2s default aborted every cold page fetch on
// proxied/TUN paths (dual-machine measurement: cold pages 2.06-2.18s vs warm
// 0.4s on the same endpoint), turning one slow page into a whole-walk
// fetch-error (rows:0) for any user whose RTT crosses the threshold — a
// 100% false-failure rate for those users, plus a full-walk retry on top.
// 10s keeps a 10-page worst-case walk bounded (~100s) while leaving ~4x
// headroom over the observed worst cold page, matching the JSON-fetch budget
// other indexer calls in this codebase already use (8-15s). Exported for the
// default-value regression test.
export const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_REMOTE_BASE_URL = 'https://manapi.metaid.io';

// ---- Egress guard (ticket 2026-11-08: staging polling flood) ----------------
// Ops measured ~940k/day requests from ~20 tenant instances against
// manapi.metaid.io/pin/path/list — every background poller re-walked its
// pools in full, with no cache, no increment and a bare `node` UA. The memo +
// head-stop below turn a quiet pool's cost from "every page, every sweep"
// into "one head page per sweep, one full walk per fullRewalkMs".

const DEFAULT_MEMO_TTL_MS = 5 * 60_000;
const DEFAULT_FULL_REWALK_MS = 6 * 3_600_000;
const DEFAULT_PROBE_MAX_PAGES = 3;
const MEMO_MAX_ENTRIES = 64;
const SEEN_PIN_CAP = 50_000;

interface WalkMemoEntry {
  rawRows: RawPinRow[];
  fetchedAtMs: number;
}
interface WalkState {
  seenPinIds: Set<string>;
  lastFullWalkAtMs: number;
}
/** key = `path|pageSize|maxPages` → memoized complete full walk. */
const walkMemo = new Map<string, WalkMemoEntry>();
/** key = `path|pageSize|maxPages` → pins this process has already served. */
const walkState = new Map<string, WalkState>();

const walkKey = (protocolPath: string, pageSize: number, maxPages: number): string =>
  `${protocolPath}|${pageSize}|${maxPages}`;

const memoPut = (key: string, rawRows: RawPinRow[], nowMs: number): void => {
  if (walkMemo.size >= MEMO_MAX_ENTRIES) {
    const oldest = walkMemo.keys().next().value;
    if (oldest !== undefined) walkMemo.delete(oldest);
  }
  walkMemo.set(key, { rawRows, fetchedAtMs: nowMs });
};

const mergeSeenPins = (state: WalkState, rows: RawPinRow[]): void => {
  for (const row of rows) state.seenPinIds.add(row.pinId);
  if (state.seenPinIds.size > SEEN_PIN_CAP) {
    // Overflow: keep only the freshly seen head rows — the next probe then
    // degrades to (at worst) today's full walk, never to a wrong subset.
    const fresh = new Set<string>();
    for (const row of rows) fresh.add(row.pinId);
    state.seenPinIds = fresh;
  }
};

// ---- UA + egress observability (ticket P3) ----------------------------------

let userAgentOverride = '';
/**
 * Override the bare `node` UA undici sends by default — ops cannot tell
 * tenants apart in nginx logs otherwise. main.ts installs
 * `IDBots/<version>/<tenant-id>` at startup; the default keeps a stable
 * prefix so the traffic family stays recognizable even before that.
 */
export const setIndexerUserAgent = (ua: string): void => {
  userAgentOverride = String(ua || '').trim();
};
/** Shared header value for fetchers that bypass this module (e.g. GigSquare). */
export const indexerUserAgentHeader = (): string =>
  userAgentOverride || `IDBots/unknown/${process.env.IDBOTS_TENANT_ID || 'standalone'}`;
const currentUserAgent = indexerUserAgentHeader;

const EGRESS_LOG_WINDOW_MS = 10 * 60_000;
let egressPages = 0;
let egressWalks = 0;
let egressWindowStartedAtMs = 0;
const countEgressPage = (nowMs: number): void => {
  if (!egressWindowStartedAtMs || nowMs - egressWindowStartedAtMs >= EGRESS_LOG_WINDOW_MS) {
    if (egressWindowStartedAtMs) {
      console.log(
        `[protocolPinFetch] manapi egress ${Math.round(EGRESS_LOG_WINDOW_MS / 60_000)}min:`
        + ` walks=${egressWalks} pages=${egressPages}`
      );
    }
    egressWindowStartedAtMs = nowMs;
    egressPages = 0;
    egressWalks = 0;
  }
  egressPages += 1;
};
const countEgressWalk = (nowMs: number): void => {
  countEgressPage(nowMs); // ensure the window is current
  egressPages -= 1; // the walk marker is not itself a page
  egressWalks += 1;
};

/** Test seam: drop all memo/probe state (per-file process isolation helper). */
export const __resetProtocolPinFetchStateForTests = (): void => {
  walkMemo.clear();
  walkState.clear();
  egressPages = 0;
  egressWalks = 0;
  egressWindowStartedAtMs = 0;
};

const normalizeBaseUrl = (value: string): string => String(value || '').replace(/\/+$/, '');

const normalizeTimestampMs = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed >= 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
};

// Select the decoded pin body, skipping MAN content-download URLs so they never
// poison downstream parsing. See protocolPinContent.ts for the full rationale.
const defaultSelectContent = (item: Record<string, unknown>): unknown => (
  selectProtocolPinContent(item)
);

const buildPathListUrl = (
  baseUrl: string,
  pathname: string,
  protocolPath: string,
  pageSize: number,
  cursor?: string
): string => {
  const url = new URL(pathname, `${normalizeBaseUrl(baseUrl)}/`);
  url.searchParams.set('path', protocolPath);
  url.searchParams.set('size', String(pageSize));
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }
  return url.toString();
};

async function fetchJson(fetchImpl: FetchLike, url: string, timeoutMs: number): Promise<unknown> {
  const init: RequestInit = { headers: { 'User-Agent': currentUserAgent() } };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

interface PageWalkInput {
  baseUrl: string;
  pathname: string;
  protocolPath: string;
  pageSize: number;
  maxPages: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  requireEnvelopeHit: boolean;
  sourceOrderStart: number;
  /** Head-stop probe (egress guard): stop at the first all-known page. */
  knownPinIds?: Set<string> | null;
  countEgress?: boolean;
  now?: () => number;
}

interface PageWalkResult {
  rows: RawPinRow[];
  hasMore: boolean;
  failed: boolean;
  /** Probe stopped because every row of a head page was already known. */
  stoppedOnKnownPage: boolean;
}

async function fetchProtocolPinPages(input: PageWalkInput): Promise<PageWalkResult> {
  const rows: RawPinRow[] = [];
  let cursor: string | undefined;
  let sourceOrder = input.sourceOrderStart;
  let stoppedAtMaxPages = false;
  let failed = false;
  let stoppedOnKnownPage = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    const url = buildPathListUrl(
      input.baseUrl,
      input.pathname,
      input.protocolPath,
      input.pageSize,
      cursor
    );

    let payload: unknown;
    try {
      if (input.countEgress) countEgressPage((input.now ?? Date.now)());
      payload = await fetchJson(input.fetchImpl, url, input.timeoutMs);
    } catch {
      // A mid-walk transport failure is NOT completion: the walk aborts with
      // a partial prefix and the caller must be able to tell (2026-10-13:
      // one slow page silently zeroed an entire pool for the refresher).
      failed = true;
      break;
    }
    if (!payload || typeof payload !== 'object') {
      failed = true;
      break;
    }

    if (
      input.requireEnvelopeHit
      && (payload as { code?: unknown }).code !== 1
    ) {
      break;
    }

    const data = (payload as { data?: unknown }).data;
    if (!data || typeof data !== 'object') {
      break;
    }

    const list = (data as { list?: unknown }).list;
    if (!Array.isArray(list)) {
      break;
    }

    let pageRows = 0;
    for (const rawItem of list) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const pinId = typeof item.id === 'string' ? item.id.trim() : String(item.id || '').trim();
      if (!pinId) {
        continue;
      }
      rows.push({
        pinId,
        rawItem: item,
        timestampMs: normalizeTimestampMs(item.timestamp),
        sourceOrder,
      });
      sourceOrder += 1;
      pageRows += 1;
    }

    // Egress-guard head-stop: the listing is timestamp-desc, so an entirely
    // known page proves the rest of the pool is at least as old — and this
    // process has persisted every row it ever fetched. (An unknown row
    // anywhere in the page keeps the walk alive.)
    const knownPinIds = input.knownPinIds;
    if (knownPinIds && knownPinIds.size > 0 && pageRows > 0) {
      const allKnown = rows
        .slice(rows.length - pageRows)
        .every((row) => knownPinIds.has(row.pinId));
      if (allKnown) {
        stoppedOnKnownPage = true;
        break;
      }
    }

    const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
    cursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor : undefined;
    if (!cursor) {
      break;
    }
    if (page + 1 >= input.maxPages) {
      // Stop only via the natural loop bound; remember that the cursor was
      // still live so the caller can tell truncation from completion.
      stoppedAtMaxPages = true;
    }
  }

  return { rows, hasMore: stoppedAtMaxPages && Boolean(cursor), failed, stoppedOnKnownPage };
}

interface RemoteWalkResult {
  rows: RawPinRow[];
  hasMore: boolean;
  failed: boolean;
}

const applySelectContent = (
  rows: RawPinRow[],
  selectContent: (item: Record<string, unknown>) => unknown
): ProtocolPinRecordWithOrder[] =>
  rows.map((row) => ({
    pinId: row.pinId,
    content: selectContent(row.rawItem),
    timestampMs: row.timestampMs,
    sourceOrder: row.sourceOrder,
  }));

export async function fetchProtocolPinsFromIndexer(
  protocolPath: string,
  options: FetchProtocolPinsOptions = {}
): Promise<ProtocolPinRecord[]> {
  const normalizedProtocolPath = String(protocolPath || '').trim();
  if (!normalizedProtocolPath) {
    return [];
  }

  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const selectContent = options.selectContent ?? defaultSelectContent;
  const now = options.now ?? Date.now;
  const memoTtlMs = options.memoTtlMs ?? DEFAULT_MEMO_TTL_MS;
  const incremental = options.incremental ?? true;
  const fullRewalkMs = options.fullRewalkMs ?? DEFAULT_FULL_REWALK_MS;
  const probeMaxPages = Math.max(1, options.probeMaxPages ?? DEFAULT_PROBE_MAX_PAGES);
  const key = walkKey(normalizedProtocolPath, pageSize, maxPages);

  const localBase = options.localBaseUrl ?? getConfiguredP2PLocalBase();
  const walkSeen = (baseUrl: string, walk: { hasMore: boolean; failed: boolean; rowsNumber: number }) => {
    if (!walk.hasMore && !walk.failed) return;
    const info = {
      baseUrl,
      protocolPath: normalizedProtocolPath,
      pages: maxPages,
      rows: walk.rowsNumber,
      reason: (walk.failed ? 'fetch-error' : 'max-pages') as 'fetch-error' | 'max-pages',
    };
    console.warn('[protocolPinFetch] page walk ended short of the empty page:', info);
    options.onTruncated?.(info);
  };
  const localWalk = localBase
    ? await fetchProtocolPinPages({
        baseUrl: localBase,
        pathname: '/api/pin/path/list',
        protocolPath: normalizedProtocolPath,
        pageSize,
        maxPages,
        timeoutMs,
        fetchImpl,
        requireEnvelopeHit: true,
        sourceOrderStart: 0,
      })
    : { rows: [], hasMore: false, failed: false, stoppedOnKnownPage: false };

  let remoteRows: RawPinRow[] | null = null;
  let remoteHasMore = false;
  let remoteFailed = false;

  // 1) Memo of the last complete full walk — repeat callers inside the TTL
  //    window (tool-triggered sweeps, IPC syncs) cost zero requests.
  const memo = memoTtlMs > 0 ? walkMemo.get(key) : undefined;
  if (
    memo
    && !options.bypassCache
    && now() - memo.fetchedAtMs < memoTtlMs
  ) {
    remoteRows = memo.rawRows;
  } else {
    const state = walkState.get(key) ?? { seenPinIds: new Set<string>(), lastFullWalkAtMs: 0 };
    walkState.set(key, state);
    const countEgress = true;
    const runWalk = (walk: {
      maxPages: number;
      knownPinIds?: Set<string> | null;
    }): Promise<PageWalkResult> => {
      countEgressWalk(now());
      return fetchProtocolPinPages({
        baseUrl: options.remoteBaseUrl ?? DEFAULT_REMOTE_BASE_URL,
        pathname: '/pin/path/list',
        protocolPath: normalizedProtocolPath,
        pageSize,
        timeoutMs,
        fetchImpl,
        requireEnvelopeHit: false,
        sourceOrderStart: 1_000_000,
        countEgress,
        now,
        maxPages: walk.maxPages,
        knownPinIds: walk.knownPinIds ?? null,
      });
    };

    const probeEligible = incremental
      && state.seenPinIds.size > 0
      && now() - state.lastFullWalkAtMs < fullRewalkMs;

    let result: PageWalkResult | null = null;
    if (probeEligible) {
      const probe = await runWalk({ maxPages: probeMaxPages, knownPinIds: state.seenPinIds });
      const probeComplete = probe.stoppedOnKnownPage || (!probe.failed && !probe.hasMore);
      if (probeComplete) {
        if (!probe.stoppedOnKnownPage) {
          // The probe reached the empty cursor page inside its budget: it WAS
          // a full walk. Reward it with a fresh memo + full-walk stamp.
          state.lastFullWalkAtMs = now();
          if (memoTtlMs > 0) memoPut(key, probe.rows, now());
        }
        mergeSeenPins(state, probe.rows);
        result = probe;
      }
      // else: probe inconclusive (live cursor past the head-page budget) or
      // the transport failed mid-probe — fall through to the full walk so
      // coverage never regresses below the pre-guard behavior.
    }

    if (!result) {
      result = await runWalk({ maxPages });
      if (!result.failed && !result.hasMore) {
        // Complete full walk: memoize it and stamp the state so probes are
        // eligible until the periodic re-walk comes due.
        state.lastFullWalkAtMs = now();
        if (memoTtlMs > 0) memoPut(key, result.rows, now());
      }
      mergeSeenPins(state, result.rows);
    }

    remoteRows = result.rows;
    remoteHasMore = result.hasMore;
    remoteFailed = result.failed;
  }

  const remoteWalk = {
    rows: remoteRows ?? [],
    hasMore: remoteHasMore,
    failed: remoteFailed,
  };

  const localPins = applySelectContent(localWalk.rows, selectContent);
  const remotePins = applySelectContent(remoteWalk.rows, selectContent);
  walkSeen(localBase ?? '', { hasMore: localWalk.hasMore, failed: localWalk.failed, rowsNumber: localPins.length });
  walkSeen(options.remoteBaseUrl ?? DEFAULT_REMOTE_BASE_URL, {
    hasMore: remoteWalk.hasMore,
    failed: remoteWalk.failed,
    rowsNumber: remotePins.length,
  });

  const mergedByPinId = new Map<string, ProtocolPinRecordWithOrder>();
  for (const pin of [...localPins, ...remotePins]) {
    if (!mergedByPinId.has(pin.pinId)) {
      mergedByPinId.set(pin.pinId, pin);
    }
  }

  return Array.from(mergedByPinId.values())
    .sort((left, right) => {
      const timeDelta = (right.timestampMs ?? 0) - (left.timestampMs ?? 0);
      if (timeDelta !== 0) return timeDelta;
      return left.sourceOrder - right.sourceOrder;
    })
    .map((pin) => ({
      pinId: pin.pinId,
      content: pin.content,
      timestampMs: pin.timestampMs,
    }));
}
