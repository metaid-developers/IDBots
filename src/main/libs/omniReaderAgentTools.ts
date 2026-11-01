import { z } from 'zod';
import { truncateUtf16Units } from './llmSafeText';
import { readInputFromOmniJson, recordChainReadSafe } from './chainReadLedger';

/**
 * Control surface the host (main.ts) provides for the omni_read tool. Pure
 * HTTP reads against the public MetaID/MetaWeb indexers; injected so tests
 * can stub the network. Endpoints and params are sourced from the retired
 * metabot-omni-reader skill's references/00-user.md .. 03-file.md.
 */
export type OmniReaderControl = {
  fetchJson(url: string): Promise<unknown>;
  fetchText(url: string): Promise<string>;
};

/** Minimal shape of the claude-agent-sdk tool() helper we depend on. */
type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

// Indexer base URLs (see the skill references).
const MANAPI_BASE = 'https://manapi.metaid.io';
const METAFILE_INDEXER_BASE = 'https://file.metaid.io/metafile-indexer';

// Social reads were single-pointed at the retired man/show.now service layer
// (offline 2026-11-01, verified from two machines: man.metaid.io whole-site
// 502, show.now 301 → www.show.now 504 upstream-unreachable). They now target
// the metaso-p2p aggregation layer — the same live backend behind
// search_social_posts, confirmed to carry same-day data. Degradation
// contract: if this layer goes down too, every social action fails with an
// explicit isError naming the failed endpoint; an empty/blank page is never
// fabricated, because a fabricated empty list would read as "no data" — a
// different fact from "cannot read".
const SOCIAL_AGG_BASE = 'https://so.metaid.io';

/** Keep large indexer payloads from flooding the conversation. */
const MAX_RESULT_CHARS = 20000;
// The dsh-runtime tool-result shaper (plugins/idbots-tool-result-shaping.mjs)
// head+tail-cuts any result over MAX_RESULT_CHARS — H-71: a 238KB indexer page
// came back as a spill file cut at char 16000 (mid-JSON, cursor field gone)
// under a "Full formatted result stored at:" banner. Reserve room for the
// truncation note so omni_read output always stays under that cap: the spill
// file then holds this tool's complete, honestly-declared output, unshaped.
const TRUNCATION_NOTE_RESERVE = 256;

/**
 * The pagination token echoed by the indexer, if any. manapi paged responses
 * carry cursor/nextCursor at the top level or under `data`; the aggregation
 * layer's social pages echo nextCursor under `data`. A truncated page is only
 * recoverable if the note names the token and its value — the old note
 * pointed at a field it had just cut out of the JSON.
 */
function responseCursor(data: unknown): { key: string; value: string } | null {
  if (data === null || typeof data !== 'object') return null;
  const scopes: Array<Record<string, unknown>> = [data as Record<string, unknown>];
  const nested = (data as Record<string, unknown>).data;
  if (nested !== null && typeof nested === 'object') scopes.push(nested as Record<string, unknown>);
  for (const scope of scopes) {
    for (const key of ['cursor', 'nextCursor', 'lastId'] as const) {
      const value = scope[key];
      if (typeof value === 'string' && value.trim()) return { key, value: value.trim() };
    }
  }
  return null;
}

function truncationNote(kept: number, total: number, cursor: { key: string; value: string } | null): string {
  if (cursor) {
    return `[omni_read: first ${kept} of ${total} chars — ${cursor.key} "${cursor.value}" present; re-run with ${cursor.key}="${cursor.value}" for the next page]`;
  }
  return `[omni_read: first ${kept} of ${total} chars — no pagination cursor in the response; narrow the query (page/size) to reach the rest]`;
}

/**
 * Tag a response served by a substitute read path so a caller cannot mistake
 * it for the retired backend's native semantics (e.g. the personalized
 * recommended feed served as sort=hot, the notification list served as the
 * aggregation layer's interactions inbox). Adds a `_degraded` field to the
 * envelope — the only mutation omni_read performs on indexer JSON besides
 * list-page truncation.
 */
function markDegraded(json: unknown, note: string): unknown {
  if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
    return { ...(json as Record<string, unknown>), _degraded: note };
  }
  return json;
}

/**
 * Row-array keys the indexers are known to put list pages under (MANAPI
 * `data.list`, the metaso feeds' `data.items`, follower lists). A known key
 * always wins over an unknown array, wherever the two sit (root or one level
 * down), so an incidental array such as a root-level `trace` or a bigger array
 * in a sibling container can never be mistaken for the page.
 */
const LIST_ROW_KEYS = ['list', 'items', 'followerList', 'followingList'] as const;

/**
 * Marks a container as a paged envelope rather than an incidental object. Used
 * only to break ties: a property merely NAMED like a page is not treated as a
 * page marker, so the list stays free of speculative names.
 */
const PAGE_MARKER_KEYS = ['nextCursor', 'cursor', 'total', 'hasMore'] as const;

type ListRowsLocation = {
  /** Object that owns the row array (`data` for both indexer families). */
  container: Record<string, unknown>;
  /** Key path from the payload root to `container`; [] means the root itself. */
  containerPath: string[];
  /** Key holding the row array inside `container`. */
  key: string;
  rows: Record<string, unknown>[];
};

function isRowArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value)
    && value.length > 0
    && value.every((row) => row !== null && typeof row === 'object' && !Array.isArray(row));
}

const isPageContainer = (container: Record<string, unknown>): boolean =>
  PAGE_MARKER_KEYS.some((marker) => marker in container);

/**
 * A cursor is the strong paging signal: it only appears on a real page envelope,
 * whereas `total` also turns up on stats/summary blocks. Used ahead of the size
 * comparison so a summary block carrying a `total` cannot outrank the page it
 * summarises.
 */
const hasCursorToken = (container: Record<string, unknown>): boolean =>
  'nextCursor' in container || 'cursor' in container;

/** Largest page wins; a container carrying page markers breaks a size tie. */
function byPageSize(pool: ListRowsLocation[]): ListRowsLocation | null {
  let best: ListRowsLocation | null = null;
  for (const location of pool) {
    const longer = best === null || location.rows.length > best.rows.length;
    const tieWithMarker = best !== null
      && location.rows.length === best.rows.length
      && !isPageContainer(best.container)
      && isPageContainer(location.container);
    if (longer || tieWithMarker) best = location;
  }
  return best;
}

/**
 * Locate the page among the candidates at the root and one level down:
 *
 *  1. a KNOWN row key wins outright, whichever container it sits in — among
 *     those, a container carrying a cursor wins over one that does not, then the
 *     largest array, with page markers only breaking a size tie — so an
 *     incidental array (a root-level `trace`), a bigger unrelated array in a
 *     sibling container, or a summary block cannot be mistaken for the page;
 *  2. with no known key, the same order applies to unfamiliar arrays.
 *
 * Arrays nested inside a row are never candidates — only a container's own
 * properties are inspected.
 */
function findListRows(data: Record<string, unknown>): ListRowsLocation | null {
  const containers: Array<{ container: Record<string, unknown>; path: string[] }> = [{ container: data, path: [] }];
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      containers.push({ container: value as Record<string, unknown>, path: [key] });
    }
  }
  const known: ListRowsLocation[] = [];
  const unknown: ListRowsLocation[] = [];
  for (const { container, path } of containers) {
    for (const [key, value] of Object.entries(container)) {
      if (!isRowArray(value)) continue;
      const location: ListRowsLocation = { container, containerPath: path, key, rows: value };
      if ((LIST_ROW_KEYS as readonly string[]).includes(key)) known.push(location);
      else unknown.push(location);
    }
  }
  for (const pool of [known, unknown]) {
    if (pool.length === 0) continue;
    const withCursor = pool.filter((location) => hasCursorToken(location.container));
    if (withCursor.length > 0) return byPageSize(withCursor);
    const marked = pool.filter((location) => isPageContainer(location.container));
    return byPageSize(marked.length > 0 ? marked : pool);
  }
  return null;
}

/**
 * Row-level truncation for over-budget list pages. A plain string cut hands the
 * caller a TORN document: everything after the cut — including the server's own
 * `nextCursor` — is unrecoverable, so a leading slice of the rows reads like the
 * whole page. Live case (2026-09-24): `pins_by_path /protocols/agentpedia/rev
 * size=100` answered 430,281 bytes / 100 rows / nextCursor present, while the
 * tool returned 20,068 chars holding 5 whole rows and did not parse as JSON.
 *
 * The envelope therefore keeps every sibling field, drops only TRAILING rows,
 * and adds `truncated` / `returned` / `hint` beside the page so the partial page
 * is machine-checkable and the caller can page with `cursor` instead of
 * guessing. When a SIBLING (not the page) is itself bigger than the whole
 * budget, the siblings are clamped — labelled as trimmed — rather than letting
 * them push the page back onto the torn-string path.
 *
 * Returns null — deferring to the caller's H-71 truncation note — whenever no
 * list-shaped output can be built honestly: the payload carries no usable page
 * (no array of plain objects at the root or one level down, e.g. a bare
 * top-level array or a page whose rows are not objects), or not even ONE whole
 * row fits inside the budget. There is deliberately no `head`/empty-page
 * fallback: a page with no rows is not a page, and the note announces the cut,
 * names the pagination token, and never passes a torn document off as a whole
 * one.
 */
function truncateListPayload(data: Record<string, unknown>, budget: number): string | null {
  const found = findListRows(data);
  if (!found) return null;
  const { container, containerPath, key, rows } = found;
  const hint = (kept: number): string =>
    `${key}: ${kept}/${rows.length} rows returned (result budget ${budget} chars) — treat this page as PARTIAL and continue with cursor/size; the server's own fields (total, nextCursor) are preserved.`;
  const render = (pageContainer: Record<string, unknown>, outerSiblings: Record<string, unknown>, kept: number): string => {
    const page = { ...pageContainer, [key]: rows.slice(0, kept), truncated: true, returned: kept, hint: hint(kept) };
    const outer = containerPath.length === 0 ? page : { ...outerSiblings, [containerPath[0]]: page };
    return JSON.stringify(outer, null, 2);
  };
  const attempt = (pageContainer: Record<string, unknown>, outerSiblings: Record<string, unknown>): string | null => {
    for (let kept = rows.length - 1; kept >= 1; kept -= 1) {
      const text = render(pageContainer, outerSiblings, kept);
      if (text.length <= budget) return text;
    }
    // Not even one whole row fits: no list-shaped page can be built inside the
    // budget, so hand the decision back to formatData, which declares the cut in
    // the H-71 note. An empty page or a `head` string would only dress up a
    // document the caller cannot page from.
    return null;
  };
  const exact = attempt(container, data);
  if (exact) return exact;
  // A sibling larger than the whole budget must not defeat the page: clamp
  // siblings (keeping a labelled preview) and retry. The page itself is never
  // clamped this way.
  return attempt(clampSiblings(container, key), clampSiblings(data, containerPath[0]));
}

/** Preview length kept for a sibling value that is clamped to make room for the page. */
const SIBLING_PREVIEW_CHARS = 200;

/**
 * Shallow copy of `container` with every property except the page key bounded to
 * a short, CLEARLY LABELLED preview. Used only as a second attempt, after the
 * exact envelope failed to fit, so an oversized sibling cannot push the page
 * back onto the torn-string path. The page itself is never passed through here.
 */
function clampSiblings(container: Record<string, unknown>, pageKey: string | undefined): Record<string, unknown> {
  const clamped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(container)) {
    if (key === pageKey) {
      clamped[key] = value;
    } else if (typeof value === 'string' && value.length > SIBLING_PREVIEW_CHARS) {
      clamped[key] = `${value.slice(0, SIBLING_PREVIEW_CHARS)}…[sibling trimmed: ${value.length} chars; omitted from this truncated page]`;
    } else if (value !== null && typeof value === 'object') {
      const size = (JSON.stringify(value) ?? '').length;
      clamped[key] = size > SIBLING_PREVIEW_CHARS
        ? `[sibling omitted from this truncated page: ${Array.isArray(value) ? `array of ${value.length}` : 'object'} / ${size} chars]`
        : value;
    } else {
      clamped[key] = value;
    }
  }
  return clamped;
}

function formatData(data: unknown): string {
  const budget = MAX_RESULT_CHARS - TRUNCATION_NOTE_RESERVE;
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text.length <= budget) return text;
  // A list page keeps whole rows (see truncateListPayload); everything else
  // falls through to the H-71 note below, so no over-budget result is ever a
  // silently torn document.
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const trimmed = truncateListPayload(data as Record<string, unknown>, budget);
    if (trimmed) return trimmed;
  }
  const kept = truncateUtf16Units(text, budget);
  return `${kept}\n${truncationNote(kept.length, text.length, responseCursor(data))}`;
}

/**
 * Build an indexer URL. `path` is resolved against the base (which may carry a
 * path prefix like /metafile-indexer); query entries that are undefined or
 * empty are dropped, everything else is URL-encoded by URLSearchParams.
 */
function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(path, base.endsWith('/') ? base : `${base}/`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

const ACTIONS = [
  'user_info',
  'search_users',
  'buzz_newest',
  'buzz_recommended',
  'buzz_hot',
  'buzz_search',
  'buzz_info',
  'notifications',
  'followers',
  'following',
  'pin',
  'pin_version',
  'pin_list',
  'metaid_list',
  'block_list',
  'mempool_list',
  'pins_by_path',
  'pins_by_metaid',
  'pins_by_address',
  'pin_content',
  'file_info',
  'file_latest',
  'files_by_creator',
  'files_by_metaid',
  'files_by_extension',
  'indexer_status',
  'indexer_stats',
  'global_counts',
] as const;

type OmniReadAction = (typeof ACTIONS)[number];

type OmniReadArgs = {
  action: OmniReadAction;
  metaid?: string;
  address?: string;
  globalmetaid?: string;
  keyword?: string;
  keytype?: 'metaid' | 'name';
  limit?: number;
  lastId?: string;
  size?: number;
  followed?: number;
  userAddress?: string;
  key?: string;
  pinId?: string;
  ver?: number;
  page?: number;
  path?: string;
  cursor?: string;
  firstPinId?: string;
  extension?: string;
  timestamp?: string;
};

/**
 * Inline MCP tool exposing read-only MetaID/MetaWeb indexer queries. Registered
 * for every cowork surface when the host provides OmniReaderControl (see
 * coworkRunner). Replaces the external metabot-omni-reader skill; the endpoint
 * shapes (including the `/api/notifcation/list` typo) are unchanged.
 */
export function buildOmniReaderAgentTools(deps: {
  tool: SdkToolFactory;
  control: OmniReaderControl;
  /** Session attribution for the chain-read ledger; omit to disable recording. */
  sessionId?: string;
  resolveMetabotId?: (sessionId: string) => number | null | undefined;
}): unknown[] {
  const { tool, control, sessionId, resolveMetabotId } = deps;

  const omniRead = tool(
    'omni_read',
    [
      'Read-only raw MetaID/MetaWeb indexer queries — the low-level fallback returning raw indexer JSON; never writes on-chain.',
      'Actions: user_info, search_users, buzz_newest | buzz_recommended | buzz_hot | buzz_search | buzz_info, notifications, followers | following, pin, pin_version, pin_list, metaid_list, block_list, mempool_list, pins_by_path | pins_by_metaid | pins_by_address, pin_content, file_info, file_latest, files_by_creator | files_by_metaid | files_by_extension, indexer_status | indexer_stats, global_counts.',
      'Social reads (buzz_*, notifications, followers/following) are served by the metaso-p2p aggregation layer (so.metaid.io) — the retired show.now / man.metaid.io service layer went offline 2026-11-01. Engagement counts are TRI-STATE: a number (including 0) is a real count; a pin the buzz-only index does not cover has NO counts (buzz_info answers code 40400 "social post not found") — that is UNKNOWN, NEVER 0 (unknown ≠ 0). Responses served by a substitute semantics carry a `_degraded` field (buzz_recommended → sort=hot; notifications → interactions inbox).',
      'List pages that exceed the result budget come back as VALID JSON holding whole rows only, with `truncated: true` and `returned` telling you how much of the page you got; the server\'s own `total`/`nextCursor` are preserved, so when `truncated` is true the page is PARTIAL — page with cursor/size instead of treating it as the full list. When not even one whole row fits, the result falls back to a declared `[omni_read: first N of M chars — …]` cut instead (still page with cursor/size); either way an over-budget result is never a silently torn document.',
      'Parameters per action are documented on the fields below; paged actions echo cursor/nextCursor — pass it back for the next page (buzz feeds and followers/following page with cursor; notifications-lastId-style paging retired with the old backend). Prefer search_metaids / metaid_profile for identity discovery and search_social_posts for full-text social search when those fit.',
    ].join(' '),
    {
      action: z.enum(ACTIONS).describe('Which indexer query to run.'),
      metaid: z.string().optional().describe('MetaID (hex id) for user_info, followers/following, pins_by_metaid, files_by_metaid, files_by_extension.'),
      address: z.string().optional().describe('Wallet address for user_info, notifications, pins_by_address, files_by_creator.'),
      globalmetaid: z.string().optional().describe('Global MetaID (idq...) for user_info; metafile-indexer only, no manapi fallback.'),
      keyword: z.string().optional().describe('Search keyword for search_users.'),
      keytype: z.enum(['metaid', 'name']).optional().describe('search_users key type; omit to search both.'),
      limit: z.number().int().optional().describe('search_users result limit (default 10).'),
      lastId: z.string().optional().describe('Legacy paging cursor from the retired show.now feeds; buzz actions still accept it and forward it as cursor. Prefer cursor.'),
      size: z.number().int().optional().describe('Page size. buzz_hot caps at 50; pins_by_path allows 1-100.'),
      followed: z.number().int().min(0).max(1).optional().describe('buzz_newest filter: 1 = posts by authors the given metaid follows (requires metaid), 0/omitted = all posts.'),
      userAddress: z.string().optional().describe('buzz_recommended: accepted for compatibility only — personalization retired with the old backend; the feed degrades to sort=hot (response carries _degraded).'),
      key: z.string().optional().describe('Search keyword for buzz_search.'),
      pinId: z.string().optional().describe('Pin id (txid+iN) for pin, pin_version, buzz_info, pin_content, file_info.'),
      ver: z.number().int().optional().describe('pin_version version number; 0 = initial version, >= 1 = history.'),
      page: z.number().int().optional().describe('Page number for pin_list, metaid_list, block_list, mempool_list.'),
      path: z.string().optional().describe('MetaID protocol path, e.g. /protocols/simplebuzz. Required for pins_by_path and pins_by_address.'),
      cursor: z.string().optional().describe('Cursor-based paging token (string). Used by buzz feeds, notifications (interactions inbox) and followers/following on the aggregation layer.'),
      firstPinId: z.string().optional().describe('First pin id of a file chain for file_latest.'),
      extension: z.string().optional().describe('File extension like .jpg for files_by_extension.'),
      timestamp: z.string().optional().describe('Optional timestamp filter for files_by_extension.'),
    },
    async (args: OmniReadArgs) => {
      try {
        switch (args.action) {
          case 'user_info': {
            const candidates: Array<['metaid' | 'address' | 'globalmetaid', string]> = [];
            if (asString(args.metaid)) candidates.push(['metaid', asString(args.metaid)]);
            if (asString(args.address)) candidates.push(['address', asString(args.address)]);
            if (asString(args.globalmetaid)) candidates.push(['globalmetaid', asString(args.globalmetaid)]);
            if (candidates.length !== 1) {
              return textResult('omni_read user_info requires exactly one of metaid, address, or globalmetaid.', true);
            }
            const [idType, idValue] = candidates[0];
            const encoded = encodeURIComponent(idValue);
            const primaryUrl = buildUrl(METAFILE_INDEXER_BASE, `api/v1/info/${idType}/${encoded}`);
            try {
              return textResult(formatData(await control.fetchJson(primaryUrl)));
            } catch (primaryError) {
              // The manapi fallback has no globalmetaid endpoint.
              if (idType === 'globalmetaid') throw primaryError;
              const fallbackUrl = buildUrl(MANAPI_BASE, `api/info/${idType}/${encoded}`);
              try {
                return textResult(formatData(await control.fetchJson(fallbackUrl)));
              } catch (fallbackError) {
                const pm = primaryError instanceof Error ? primaryError.message : String(primaryError);
                const fm = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
                return textResult(
                  `omni_read user_info failed: metafile-indexer: ${pm}; manapi fallback: ${fm}`,
                  true,
                );
              }
            }
          }

          case 'search_users': {
            const keyword = asString(args.keyword);
            if (!keyword) return textResult('omni_read search_users requires keyword.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/info/search', {
              keyword,
              keytype: args.keytype,
              limit: args.limit ?? 10,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_newest': {
            // Aggregation feed (metaso-p2p /api/social/feed): newest first,
            // cursor-paged (echoes nextCursor). Engagement counts in each row
            // are tri-state: a number (including a real 0) is a count the
            // buzz-only index covers; for pins it does not cover the detail
            // read answers 40400 instead — unknown, NEVER 0.
            const followed = args.followed === 1;
            const subject = asString(args.metaid);
            if (followed && !subject) {
              return textResult(
                'omni_read buzz_newest followed=1 requires metaid (the subject whose followed-authors feed is requested).',
                true,
              );
            }
            const url = buildUrl(SOCIAL_AGG_BASE, 'api/social/feed', {
              size: args.size,
              cursor: asString(args.cursor) || asString(args.lastId) || undefined,
              publisher: !followed && subject ? subject : undefined,
              scope: followed ? 'following' : undefined,
              user: followed ? subject : undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_recommended': {
            // The personalized recommended feed retired with show.now; the
            // aggregation layer has no per-user ranking, so this action
            // degrades to sort=hot (top engagement within the last 48h) and
            // the payload says so via _degraded.
            const url = buildUrl(SOCIAL_AGG_BASE, 'api/social/feed', {
              sort: 'hot',
              size: args.size,
            });
            const json = await control.fetchJson(url);
            return textResult(formatData(markDegraded(
              json,
              'buzz_recommended: personalized ranking retired with show.now; serving sort=hot (top engagement, last 48h) from the metaso-p2p aggregation layer. userAddress is not used for ranking.',
            )));
          }

          case 'buzz_hot': {
            if (args.size !== undefined && args.size > 50) {
              return textResult('omni_read buzz_hot size must be <= 50.', true);
            }
            // sort=hot is a single page (top engagement within the last 48h);
            // the aggregation layer does not paginate it.
            const url = buildUrl(SOCIAL_AGG_BASE, 'api/social/feed', {
              sort: 'hot',
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_search': {
            const key = asString(args.key);
            if (!key) return textResult('omni_read buzz_search requires key.', true);
            // Single case-insensitive substring term (aggregation-layer
            // semantics); multiple terms are OR-joined only by the higher
            // level search_social_posts tool.
            const url = buildUrl(SOCIAL_AGG_BASE, 'api/social/feed', {
              keyword: key,
              size: args.size,
              cursor: asString(args.cursor) || asString(args.lastId) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_info': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read buzz_info requires pinId.', true);
            // Aggregated post detail. code 40400 "social post not found" is
            // the buzz-only index saying it does not COVER the pin (metaTask
            // roots, metaapp pins, witness submissions...) — an explicit
            // unknown, never zero counts; read the raw pin with `pin` /
            // `pin_content` instead.
            const url = buildUrl(SOCIAL_AGG_BASE, `api/social/post/${encodeURIComponent(pinId)}`);
            const json = await control.fetchJson(url);
            // Fire-and-forget chain-read ledger entry; the raw indexer JSON
            // is not normalized, so extraction is best-effort.
            recordChainReadSafe(readInputFromOmniJson(args.action, json, pinId, resolveMetabotId?.(sessionId ?? '')));
            return textResult(formatData(json));
          }

          case 'notifications': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read notifications requires address.', true);
            // The native notification backend (man.metaid.io
            // /api/notifcation/list) went offline 2026-11-01 (whole-site
            // 502), and manapi's same route answers a perpetual empty list —
            // indistinguishable from "no notifications", i.e. a fabricated
            // blank. Degrade to the aggregation layer's deterministic inbox
            // instead (likes/comments on the owner's pins + answers to their
            // questions) and mark the payload _degraded so the semantic
            // change is machine-checkable.
            const url = buildUrl(SOCIAL_AGG_BASE, 'api/metaweb/interactions', {
              owner: address,
              size: args.size,
              cursor: asString(args.cursor) || asString(args.lastId) || undefined,
            });
            const json = await control.fetchJson(url);
            return textResult(formatData(markDegraded(
              json,
              'notifications: the man.metaid.io notification list is offline; serving the metaso-p2p interactions inbox (likes/comments on your pins + answers to your questions) instead.',
            )));
          }

          case 'followers':
          case 'following': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult(`omni_read ${args.action} requires metaid.`, true);
            // man.metaid.io's follow-list routes are offline (whole-site 502
            // since 2026-11-01); the aggregation layer serves the same lists
            // (globalMetaId OR legacy hex metaId both key the route),
            // cursor-paged, block-filtered.
            const endpoint = args.action === 'followers' ? 'followers' : 'following';
            const url = buildUrl(
              SOCIAL_AGG_BASE,
              `api/social/globalmetaid/${encodeURIComponent(metaid)}/${endpoint}`,
              {
                cursor: asString(args.cursor) || undefined,
                size: args.size,
              },
            );
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin requires pinId.', true);
            const url = buildUrl(MANAPI_BASE, `api/pin/${encodeURIComponent(pinId)}`);
            const json = await control.fetchJson(url);
            // Fire-and-forget chain-read ledger entry; the raw indexer JSON
            // is not normalized, so extraction is best-effort.
            recordChainReadSafe(readInputFromOmniJson(args.action, json, pinId, resolveMetabotId?.(sessionId ?? '')));
            return textResult(formatData(json));
          }

          case 'pin_version': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin_version requires pinId.', true);
            if (args.ver === undefined || !Number.isInteger(args.ver) || args.ver < 0) {
              return textResult('omni_read pin_version requires ver (int, 0 = initial version).', true);
            }
            const url = buildUrl(MANAPI_BASE, `api/pin/ver/${encodeURIComponent(pinId)}/${args.ver}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin_list':
          case 'metaid_list':
          case 'block_list':
          case 'mempool_list': {
            const segment = args.action.replace('_list', '');
            const url = buildUrl(MANAPI_BASE, `api/${segment}/list`, {
              page: args.page,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_path': {
            const path = asString(args.path);
            if (!path) return textResult('omni_read pins_by_path requires path (e.g. /protocols/simplebuzz).', true);
            if (args.size !== undefined && (args.size < 1 || args.size > 100)) {
              return textResult('omni_read pins_by_path size must be between 1 and 100.', true);
            }
            const url = buildUrl(MANAPI_BASE, 'api/pin/path/list', {
              path,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_metaid': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult('omni_read pins_by_metaid requires metaid.', true);
            const url = buildUrl(MANAPI_BASE, `api/metaid/pin/list/${encodeURIComponent(metaid)}`, {
              path: asString(args.path) || undefined,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pins_by_address': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read pins_by_address requires address.', true);
            const path = asString(args.path);
            if (!path) return textResult('omni_read pins_by_address requires path.', true);
            const url = buildUrl(MANAPI_BASE, `api/address/pin/list/${encodeURIComponent(address)}`, {
              path,
              size: args.size,
              cursor: asString(args.cursor) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'pin_content': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read pin_content requires pinId.', true);
            const url = buildUrl(MANAPI_BASE, `content/${encodeURIComponent(pinId)}`);
            const body = await control.fetchText(url);
            // Fire-and-forget chain-read ledger entry; the raw content body
            // has no metadata, so only pin id + text are recorded.
            recordChainReadSafe(readInputFromOmniJson(args.action, body, pinId, resolveMetabotId?.(sessionId ?? '')));
            let text = body;
            if (body.length > MAX_RESULT_CHARS - TRUNCATION_NOTE_RESERVE) {
              const kept = truncateUtf16Units(body, MAX_RESULT_CHARS - TRUNCATION_NOTE_RESERVE);
              text = `${kept}\n[omni_read: first ${kept.length} of ${body.length} chars — raw content body; no pagination cursor]`;
            }
            return textResult(text);
          }

          case 'file_info': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read file_info requires pinId.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/${encodeURIComponent(pinId)}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'file_latest': {
            const firstPinId = asString(args.firstPinId);
            if (!firstPinId) return textResult('omni_read file_latest requires firstPinId.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/latest/${encodeURIComponent(firstPinId)}`);
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_creator': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read files_by_creator requires address.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/creator/${encodeURIComponent(address)}`, {
              cursor: asString(args.cursor) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_metaid': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult('omni_read files_by_metaid requires metaid.', true);
            const url = buildUrl(METAFILE_INDEXER_BASE, `api/v1/files/metaid/${encodeURIComponent(metaid)}`, {
              cursor: asString(args.cursor) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'files_by_extension': {
            const extension = asString(args.extension);
            if (!extension) return textResult('omni_read files_by_extension requires extension (e.g. .jpg).', true);
            const metaid = asString(args.metaid);
            const path = metaid
              ? `api/v1/files/metaid/${encodeURIComponent(metaid)}/extension`
              : 'api/v1/files/extension';
            const url = buildUrl(METAFILE_INDEXER_BASE, path, {
              extension,
              timestamp: asString(args.timestamp) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'indexer_status': {
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/status');
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'indexer_stats': {
            const url = buildUrl(METAFILE_INDEXER_BASE, 'api/v1/stats');
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'global_counts': {
            const url = buildUrl(MANAPI_BASE, 'debug/count');
            return textResult(formatData(await control.fetchJson(url)));
          }

          default:
            return textResult(`omni_read does not support action "${String(args.action)}".`, true);
        }
      } catch (error) {
        return textResult(
          `omni_read ${String(args.action)} failed: ${error instanceof Error ? error.message : String(error)}`,
          true,
        );
      }
    }
  );

  return [omniRead];
}
