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
// The dsh-runtime tool-result shaper (plugins/idbots-tool-result-shaping.mjs)
// head+tail-cuts any result over MAX_RESULT_CHARS — H-71: a 238KB indexer page
// came back as a spill file cut at char 16000 (mid-JSON, cursor field gone)
// under a "Full formatted result stored at:" banner. Reserve room for the
// truncation note so omni_read output always stays under that cap: the spill
// file then holds this tool's complete, honestly-declared output, unshaped.
const TRUNCATION_NOTE_RESERVE = 256;

/**
 * The pagination token echoed by the indexer, if any. manapi paged responses
 * carry cursor/nextCursor at the top level or under `data`; show.now buzz
 * lists echo lastId. A truncated page is only recoverable if the note names
 * the token and its value — the old note pointed at a field it had just cut
 * out of the JSON.
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

/**
 * Read-side honesty for cursor-paged chain reads.
 *
 * Some indexer routes answer a continuation page with ZERO rows while the
 * envelope's own accounting still says rows exist beyond the cursor (observed
 * 2026-11: a publisher-scoped `pins_by_metaid` continuation answered
 * `list: null` on every page, so a reader concluded "the rest does not
 * exist"). A silent empty page is worse than an error: nothing in the answer
 * tells the caller the read was incomplete.
 *
 * Measured counter-constraint (live manapi, 2026-11-04): a NORMAL walk also
 * ends with an empty page, not with the last non-empty one —
 * `/protocols/agentpedia/challenge` (total 16, size 5) answers 5/5/5/1 rows and
 * then a 0-row page with the cursor cleared; a 2-row list behaves the same. A
 * `total` alone therefore cannot decide: judging on it would flag every
 * completed walk. The walk ledger carries how many rows this session has
 * actually seen for the same (action, identity, path), which is what separates
 * "the list is exhausted" from "the envelope reports rows this walk never
 * received".
 *
 * The layer never changes what upstream is asked for. It only annotates the
 * parsed answer, and passes it through unchanged whenever the page is
 * trustworthy or cannot be judged:
 *  - no cursor on the request (page 1 — also resets the walk ledger),
 *  - an error response (including HTTP 200 whose body carries a non-success
 *    `code`, as manapi does for a bad route),
 *  - the page has rows,
 *  - the envelope exposes no usable total AND no continuation token,
 *  - the list is provably exhausted: `offset + returned >= total`, the whole
 *    list fits one page (`total <= size`), or the rows this walk has seen
 *    already reach the envelope's total.
 *
 * On detection it adds a machine-readable `pagination` block at the payload
 * root, so an empty continuation page can never be read as completeness.
 */
type PageEnvelopeShape = {
  returned: number;
  total: number | null;
  totalField: string | null;
  size: number | null;
  nextCursor: string | null;
  offset: number | null;
};

/** Rows seen so far per cursor walk, keyed by action + identity + path. */
export type PaginationWalkLedger = Map<string, number>;

const TOTAL_FIELDS = ['total', 'totalCount', 'count'] as const;
const SIZE_FIELDS = ['size', 'pageSize', 'limit'] as const;
const OFFSET_FIELDS = ['offset', 'skip', 'start'] as const;
/** Bounded so a long session cannot accumulate walk keys without limit. */
const PAGINATION_WALK_LIMIT = 64;
/** `code` values the indexer families use for a successful answer. */
const SUCCESS_CODES = new Set([0, 1, 200]);

function toNonNegativeInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function isErrorEnvelope(envelope: Record<string, unknown>): boolean {
  if (envelope.error) return true;
  if (envelope.success === false) return true;
  const code = envelope.code;
  if (typeof code === 'number') return !SUCCESS_CODES.has(code);
  if (typeof code === 'string' && code.trim() !== '') {
    const numeric = Number(code);
    if (Number.isFinite(numeric)) return !SUCCESS_CODES.has(numeric);
    const word = code.trim().toLowerCase();
    return word !== 'ok' && word !== 'success';
  }
  return false;
}

function readNumericField(
  scopes: Array<Record<string, unknown>>,
  fields: readonly string[],
): { value: number; field: string } | null {
  for (const field of fields) {
    for (const scope of scopes) {
      if (!(field in scope)) continue;
      const value = toNonNegativeInteger(scope[field]);
      if (value !== null) return { value, field };
    }
  }
  return null;
}

/** Locate the page envelope and its row count, allowing an empty/null page. */
function readPageShape(envelope: Record<string, unknown>): PageEnvelopeShape | null {
  const scopes: Array<Record<string, unknown>> = [envelope];
  const nested = envelope.data;
  if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
    scopes.push(nested as Record<string, unknown>);
  }
  for (const scope of scopes) {
    const rowKey = LIST_ROW_KEYS.find((key) => key in scope);
    if (rowKey === undefined) continue;
    const value = scope[rowKey];
    let returned: number;
    if (value === null || value === undefined) returned = 0;
    else if (Array.isArray(value)) returned = value.length;
    else return null; // unknown shape — cannot judge
    const total = readNumericField(scopes, TOTAL_FIELDS);
    const size = readNumericField(scopes, SIZE_FIELDS);
    const offset = readNumericField(scopes, OFFSET_FIELDS);
    const cursor = responseCursor(envelope);
    return {
      returned,
      // A total smaller than the rows already returned is not a total (live
      // case: pins_by_address answers total: 0 beside two rows) — treat it as
      // unusable rather than judging on it.
      total: total !== null && total.value >= returned ? total.value : null,
      totalField: total !== null && total.value >= returned ? total.field : null,
      size: size !== null ? size.value : null,
      nextCursor: cursor ? cursor.value : null,
      offset: offset !== null ? offset.value : null,
    };
  }
  return null;
}

/** Record a walk's progress; re-inserting keeps eviction least-recently-used. */
function rememberWalk(ledger: PaginationWalkLedger, key: string, seen: number): void {
  ledger.delete(key);
  ledger.set(key, seen);
  while (ledger.size > PAGINATION_WALK_LIMIT) {
    const oldest = ledger.keys().next().value;
    if (oldest === undefined) break;
    ledger.delete(oldest);
  }
}

export function withPaginationIntegrity(
  action: string,
  payload: unknown,
  requestedCursor: string,
  walkKey: string,
  ledger: PaginationWalkLedger,
): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const envelope = payload as Record<string, unknown>;
  if (isErrorEnvelope(envelope)) return payload;
  const shape = readPageShape(envelope);
  if (!requestedCursor) {
    rememberWalk(ledger, walkKey, shape ? shape.returned : 0); // page 1 opens a fresh walk
    return payload;
  }
  if (shape === null) return payload; // cannot judge
  const rowsSeen = (ledger.get(walkKey) ?? 0) + shape.returned;
  rememberWalk(ledger, walkKey, rowsSeen);
  if (shape.returned > 0) return payload;
  // Empty continuation page: pass only when the envelope itself proves the walk
  // finished. An explicit offset is conclusive...
  if (shape.offset !== null && shape.total !== null && shape.offset + shape.returned >= shape.total) {
    return payload;
  }
  // ...a live continuation token is positive evidence that it did not (and
  // overrides a zero total, which pins_by_address hands out beside real rows)...
  if (!shape.nextCursor) {
    if (shape.total === null) return payload; // cannot judge
    if (shape.total === 0) return payload;
    if (shape.size !== null && shape.total <= shape.size) return payload; // one page holds it all
    if (rowsSeen >= shape.total) return payload; // this walk already has every row
  }
  return {
    ...envelope,
    pagination: {
      action,
      requestedCursor,
      returned: 0,
      rowsSeen,
      total: shape.total,
      totalField: shape.totalField,
      unaccounted: shape.total !== null ? Math.max(0, shape.total - rowsSeen) : null,
      nextCursor: shape.nextCursor,
      complete: false,
      note: shape.total !== null && shape.total > 0
        ? `continuation returned no rows while this walk has seen ${rowsSeen} of the ${shape.total} rows the envelope reports — this read is INCOMPLETE; do not treat this as the end of the list`
        : 'continuation returned no rows but the envelope still carries a continuation token — this read is INCOMPLETE; do not treat this as the end of the list',
    },
  };
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

  // Per-session witness of how many rows each cursor walk has actually
  // returned; read by withPaginationIntegrity (see its note on why a total
  // alone cannot distinguish an exhausted walk from a silent empty page).
  const pagedWalks: PaginationWalkLedger = new Map();

  const omniRead = tool(
    'omni_read',
    [
      'Read-only raw MetaID/MetaWeb indexer queries — the low-level fallback returning raw indexer JSON; never writes on-chain.',
      'Actions: user_info, search_users, buzz_newest | buzz_recommended | buzz_hot | buzz_search | buzz_info, notifications, followers | following, pin, pin_version, pin_list, metaid_list, block_list, mempool_list, pins_by_path | pins_by_metaid | pins_by_address, pin_content, file_info, file_latest, files_by_creator | files_by_metaid | files_by_extension, indexer_status | indexer_stats, global_counts.',
      'List pages that exceed the result budget come back as VALID JSON holding whole rows only, with `truncated: true` and `returned` telling you how much of the page you got; the server\'s own `total`/`nextCursor` are preserved, so when `truncated` is true the page is PARTIAL — page with cursor/size instead of treating it as the full list. When not even one whole row fits, the result falls back to a declared `[omni_read: first N of M chars — …]` cut instead (still page with cursor/size); either way an over-budget result is never a silently torn document.',
      'When a continuation page (a cursor was supplied) comes back with no rows while its own envelope says rows exist beyond that cursor, the result carries a `pagination` block with `complete: false` and the cursor that was tried — that page is an INCOMPLETE read, not the end of the list; do not conclude the remaining rows do not exist.',
      'Parameters per action are documented on the fields below; paged actions echo lastId/cursor — pass it back for the next page (notifications lastId returns entries NEWER than that id and excludes answers to your questions; poll get_question_answers for those). Prefer search_metaids / metaid_profile for identity discovery and search_social_posts for full-text social search when those fit.',
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
            const cursor = asString(args.cursor);
            const url = buildUrl(MANAPI_BASE, 'api/pin/path/list', {
              path,
              size: args.size,
              cursor: cursor || undefined,
            });
            const json = await control.fetchJson(url);
            return textResult(formatData(
              withPaginationIntegrity(args.action, json, cursor, `pins_by_path|${path}`, pagedWalks),
            ));
          }

          case 'pins_by_metaid': {
            const metaid = asString(args.metaid);
            if (!metaid) return textResult('omni_read pins_by_metaid requires metaid.', true);
            const cursor = asString(args.cursor);
            const url = buildUrl(MANAPI_BASE, `api/metaid/pin/list/${encodeURIComponent(metaid)}`, {
              path: asString(args.path) || undefined,
              size: args.size,
              cursor: cursor || undefined,
            });
            const json = await control.fetchJson(url);
            return textResult(formatData(
              withPaginationIntegrity(args.action, json, cursor, `pins_by_metaid|${metaid}|${asString(args.path)}`, pagedWalks),
            ));
          }

          case 'pins_by_address': {
            const address = asString(args.address);
            if (!address) return textResult('omni_read pins_by_address requires address.', true);
            const path = asString(args.path);
            if (!path) return textResult('omni_read pins_by_address requires path.', true);
            const cursor = asString(args.cursor);
            const url = buildUrl(MANAPI_BASE, `api/address/pin/list/${encodeURIComponent(address)}`, {
              path,
              size: args.size,
              cursor: cursor || undefined,
            });
            const json = await control.fetchJson(url);
            return textResult(formatData(
              withPaginationIntegrity(args.action, json, cursor, `pins_by_address|${address}|${path}`, pagedWalks),
            ));
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
