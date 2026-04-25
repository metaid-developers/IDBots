import { getP2PLocalBase } from './p2pLocalEndpoint';

export interface ProtocolPinRecord {
  pinId: string;
  content: unknown;
  timestampMs?: number | null;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface FetchProtocolPinsOptions {
  pageSize?: number;
  maxPages?: number;
  timeoutMs?: number;
  localBaseUrl?: string;
  remoteBaseUrl?: string;
  fetchImpl?: FetchLike;
  selectContent?: (item: Record<string, unknown>) => unknown;
}

interface ProtocolPinRecordWithOrder extends ProtocolPinRecord {
  sourceOrder: number;
}

const DEFAULT_PAGE_SIZE = 200;
const DEFAULT_MAX_PAGES = 10;
const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_REMOTE_BASE_URL = 'https://manapi.metaid.io';

const normalizeBaseUrl = (value: string): string => String(value || '').replace(/\/+$/, '');

const normalizeTimestampMs = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed >= 10_000_000_000 ? Math.floor(parsed) : Math.floor(parsed * 1000);
};

const defaultSelectContent = (item: Record<string, unknown>): unknown => (
  item.contentSummary
  ?? item.contentBody
  ?? item.content
  ?? item.originalContentBody
  ?? item.originalContentSummary
  ?? null
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
  const init: RequestInit = {};
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(timeoutMs);
  }
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    return null;
  }
  return response.json();
}

async function fetchProtocolPinPages(input: {
  baseUrl: string;
  pathname: string;
  protocolPath: string;
  pageSize: number;
  maxPages: number;
  timeoutMs: number;
  fetchImpl: FetchLike;
  selectContent: (item: Record<string, unknown>) => unknown;
  requireEnvelopeHit: boolean;
  sourceOrderStart: number;
}): Promise<ProtocolPinRecordWithOrder[]> {
  const pins: ProtocolPinRecordWithOrder[] = [];
  let cursor: string | undefined;
  let sourceOrder = input.sourceOrderStart;

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
      payload = await fetchJson(input.fetchImpl, url, input.timeoutMs);
    } catch {
      break;
    }
    if (!payload || typeof payload !== 'object') {
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

    for (const rawItem of list) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
        continue;
      }
      const item = rawItem as Record<string, unknown>;
      const pinId = typeof item.id === 'string' ? item.id.trim() : String(item.id || '').trim();
      if (!pinId) {
        continue;
      }
      pins.push({
        pinId,
        content: input.selectContent(item),
        timestampMs: normalizeTimestampMs(item.timestamp),
        sourceOrder,
      });
      sourceOrder += 1;
    }

    const nextCursor = (data as { nextCursor?: unknown }).nextCursor;
    cursor = typeof nextCursor === 'string' && nextCursor.trim() ? nextCursor : undefined;
    if (!cursor) {
      break;
    }
  }

  return pins;
}

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

  const localPins = await fetchProtocolPinPages({
    baseUrl: options.localBaseUrl ?? getP2PLocalBase(),
    pathname: '/api/pin/path/list',
    protocolPath: normalizedProtocolPath,
    pageSize,
    maxPages,
    timeoutMs,
    fetchImpl,
    selectContent,
    requireEnvelopeHit: true,
    sourceOrderStart: 0,
  });
  const remotePins = await fetchProtocolPinPages({
    baseUrl: options.remoteBaseUrl ?? DEFAULT_REMOTE_BASE_URL,
    pathname: '/pin/path/list',
    protocolPath: normalizedProtocolPath,
    pageSize,
    maxPages,
    timeoutMs,
    fetchImpl,
    selectContent,
    requireEnvelopeHit: false,
    sourceOrderStart: 1_000_000,
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
