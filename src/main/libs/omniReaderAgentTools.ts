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
const SHOWNOW_BASE = 'https://show.now/man';
const MAN_BASE = 'https://man.metaid.io';

/** Keep large indexer payloads from flooding the conversation. */
const MAX_RESULT_CHARS = 20000;

/**
 * Row-array keys the indexers are known to put list pages under (MANAPI
 * `data.list`, the metaso feeds' `data.items`, follower lists). A known key
 * always wins over an unknown array, wherever the two sit (root or one level
 * down), so an incidental array such as a root-level `trace` or a bigger array
 * in a sibling container can never be mistaken for the page.
 */
const LIST_ROW_KEYS = ['list', 'items', 'followerList', 'followingList'] as const;

/** Marks a container as a paged envelope rather than an incidental object. */
const PAGE_MARKER_KEYS = ['nextCursor', 'cursor', 'total', 'hasMore', 'page'] as const;

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
 * Locate the page among the candidates at the root and one level down. Order of
 * precedence: a KNOWN row key first (a container carrying page markers wins a
 * tie, else the first in key order), and only when no known key qualifies the
 * largest array of plain objects at the root or one level down. Arrays nested
 * inside a row are never candidates — only a container's own properties are
 * inspected.
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
  if (known.length > 0) {
    return known.find((location) => isPageContainer(location.container)) ?? known[0];
  }
  const marked = unknown.filter((location) => isPageContainer(location.container));
  const pool = marked.length > 0 ? marked : unknown;
  return pool.reduce<ListRowsLocation | null>(
    (best, location) => (!best || location.rows.length > best.rows.length ? location : best),
    null,
  );
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
 * guessing. When not even one whole row fits, the raw head of the row array is
 * carried as a STRING (`head`); and when a SIBLING (not the page) is itself
 * bigger than the whole budget, the siblings are clamped — labelled as trimmed —
 * rather than letting them push the page back onto the torn-string path.
 *
 * Returns null when the payload carries no usable page (no array of plain
 * objects at the root or one level down, e.g. a bare top-level array or a page
 * whose rows are not objects): the caller then keeps the legacy narrowing note,
 * which still announces the cut instead of hiding it.
 */
function truncateListPayload(data: Record<string, unknown>, budget: number): string | null {
  const found = findListRows(data);
  if (!found) return null;
  const { container, containerPath, key, rows } = found;
  const hint = (kept: number): string =>
    `${key}: ${kept}/${rows.length} rows returned (result budget ${budget} chars) — treat this page as PARTIAL and continue with cursor/size; the server's own fields (total, nextCursor) are preserved.`;
  const render = (pageContainer: Record<string, unknown>, outerSiblings: Record<string, unknown>, kept: number, extra: Record<string, unknown> = {}): string => {
    const page = { ...pageContainer, [key]: rows.slice(0, kept), truncated: true, returned: kept, hint: hint(kept), ...extra };
    const outer = containerPath.length === 0 ? page : { ...outerSiblings, [containerPath[0]]: page };
    return JSON.stringify(outer, null, 2);
  };
  const rowsJson = JSON.stringify(rows);
  const attempt = (pageContainer: Record<string, unknown>, outerSiblings: Record<string, unknown>): string | null => {
    for (let kept = rows.length - 1; kept >= 1; kept -= 1) {
      const text = render(pageContainer, outerSiblings, kept);
      if (text.length <= budget) return text;
    }
    // Not a single whole row fits: hand back the raw head of the row array as a
    // string, so the caller sees its shape instead of a torn tail.
    for (let take = Math.min(rowsJson.length, budget); take >= 1; take = Math.floor(take * 0.9)) {
      const text = render(pageContainer, outerSiblings, 0, { head: rowsJson.slice(0, take) });
      if (text.length <= budget) return text;
    }
    const emptyPage = render(pageContainer, outerSiblings, 0);
    return emptyPage.length <= budget ? emptyPage : null;
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
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (text.length <= MAX_RESULT_CHARS) return text;
  if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
    const trimmedList = truncateListPayload(data as Record<string, unknown>, MAX_RESULT_CHARS);
    if (trimmedList) return trimmedList;
  }
  return `${truncateUtf16Units(text, MAX_RESULT_CHARS)}\n...(truncated, narrow the query with cursor/size)`;
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
      'Read-only raw MetaID/MetaWeb indexer queries over HTTP.',
      'Users: action "user_info" with exactly one of metaid | address | globalmetaid (metafile-indexer first, falls back to manapi for metaid/address); "search_users" with keyword plus optional keytype metaid|name and limit (default 10).',
      'Social/buzz: "buzz_newest" (lastId, size, metaid, followed 0/1), "buzz_recommended" (lastId, size, userAddress), "buzz_hot" (lastId, size <= 50), "buzz_search" (key required), "buzz_info" (pinId required); "notifications" (address required, size, lastId; lastId returns entries NEWER than that id, not a page-down cursor; answers to YOUR questions are NOT included — poll get_question_answers per own question pin); "followers"/"following" (metaid required, cursor default 0, size).',
      'Pins: "pin" (pinId), "pin_version" (pinId + ver int, 0 = initial), "pin_list"/"metaid_list"/"block_list"/"mempool_list" (page, size), "pins_by_path" (path required, e.g. /protocols/simplebuzz, size 1-100, cursor), "pins_by_metaid" (metaid required, optional path), "pins_by_address" (address + path required), "pin_content" (pinId, returns the raw content body).',
      'Metafile index: "file_info" (pinId), "file_latest" (firstPinId), "files_by_creator" (address), "files_by_metaid" (metaid), "files_by_extension" (extension like .jpg required, optional metaid/timestamp/size); plus "indexer_status", "indexer_stats", "global_counts".',
      'Paged actions echo lastId/cursor in the response; pass it back for the next page. All parameters are URL-encoded automatically.',
      'List pages that exceed the result budget come back as VALID JSON holding whole rows only, with `truncated: true` and `returned` telling you how much of the page you got; the server\'s own `total`/`nextCursor` are preserved, so when `truncated` is true the page is PARTIAL — page with cursor/size instead of treating it as the full list.',
      'Prefer search_metaids / metaid_profile for identity discovery and search_social_posts for full-text social search when those fit; omni_read is the low-level fallback returning raw indexer JSON. It never writes on-chain.',
    ].join(' '),
    {
      action: z.enum(ACTIONS).describe('Which indexer query to run.'),
      metaid: z.string().optional().describe('MetaID (hex id) for user_info, followers/following, pins_by_metaid, files_by_metaid, files_by_extension.'),
      address: z.string().optional().describe('Wallet address for user_info, notifications, pins_by_address, files_by_creator.'),
      globalmetaid: z.string().optional().describe('Global MetaID (idq...) for user_info; metafile-indexer only, no manapi fallback.'),
      keyword: z.string().optional().describe('Search keyword for search_users.'),
      keytype: z.enum(['metaid', 'name']).optional().describe('search_users key type; omit to search both.'),
      limit: z.number().int().optional().describe('search_users result limit (default 10).'),
      lastId: z.string().optional().describe('Paging cursor echoed by buzz/notification list responses.'),
      size: z.number().int().optional().describe('Page size. buzz_hot caps at 50; pins_by_path allows 1-100.'),
      followed: z.number().int().min(0).max(1).optional().describe('buzz_newest filter: 1 = followed users only, 0 = all.'),
      userAddress: z.string().optional().describe('Wallet address for buzz_recommended personalization.'),
      key: z.string().optional().describe('Search keyword for buzz_search.'),
      pinId: z.string().optional().describe('Pin id (txid+iN) for pin, pin_version, buzz_info, pin_content, file_info.'),
      ver: z.number().int().optional().describe('pin_version version number; 0 = initial version, >= 1 = history.'),
      page: z.number().int().optional().describe('Page number for pin_list, metaid_list, block_list, mempool_list.'),
      path: z.string().optional().describe('MetaID protocol path, e.g. /protocols/simplebuzz. Required for pins_by_path and pins_by_address.'),
      cursor: z.string().optional().describe('Cursor-based paging token (string). followers/following default to 0.'),
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
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/newest', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              metaid: asString(args.metaid) || undefined,
              followed: args.followed,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_recommended': {
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/recommended', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              userAddress: asString(args.userAddress) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_hot': {
            if (args.size !== undefined && args.size > 50) {
              return textResult('omni_read buzz_hot size must be <= 50.', true);
            }
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/hot', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_search': {
            const key = asString(args.key);
            if (!key) return textResult('omni_read buzz_search requires key.', true);
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/search', {
              lastId: asString(args.lastId) || undefined,
              size: args.size,
              key,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'buzz_info': {
            const pinId = asString(args.pinId);
            if (!pinId) return textResult('omni_read buzz_info requires pinId.', true);
            const url = buildUrl(SHOWNOW_BASE, 'social/buzz/info', { pinId });
            const json = await control.fetchJson(url);
            // Fire-and-forget chain-read ledger entry; the raw indexer JSON
            // is not normalized, so extraction is best-effort.
            recordChainReadSafe(readInputFromOmniJson(args.action, json, pinId, resolveMetabotId?.(sessionId ?? '')));
            return textResult(formatData(json));
          }

          case 'notifications': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read notifications requires address.', true);
            // The "notifcation" spelling is the backend's; keep it verbatim.
            // Served by the MAN indexer: manapi answers this route with a
            // perpetual empty list for every address, while man.metaid.io
            // returns real notifications with the identical shape.
            const url = buildUrl(MAN_BASE, 'api/notifcation/list', {
              address,
              size: args.size,
              lastId: asString(args.lastId) || undefined,
            });
            return textResult(formatData(await control.fetchJson(url)));
          }

          case 'followers':
          case 'following': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult(`omni_read ${args.action} requires metaid.`, true);
            const endpoint = args.action === 'followers' ? 'followerList' : 'followingList';
            const url = buildUrl(MAN_BASE, `api/metaid/${endpoint}/${encodeURIComponent(metaid)}`, {
              cursor: asString(args.cursor) || '0',
              size: args.size,
              followDetail: 'true',
            });
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
            const text = body.length > MAX_RESULT_CHARS
              ? `${truncateUtf16Units(body, MAX_RESULT_CHARS)}\n...(truncated, narrow the query with cursor/size)`
              : body;
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
