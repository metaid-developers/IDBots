import type { Database } from 'sql.js';

export interface PrivateChatHistoryEndpoint {
  baseUrl: string;
}

export interface PrivateChatHistoryMessage {
  index: number | null;
  txId: string;
  pinId: string;
  from: string;
  fromGlobalMetaId: string;
  fromUserInfo: Record<string, unknown> | null;
  to: string;
  toGlobalMetaId: string;
  toUserInfo: Record<string, unknown> | null;
  protocol: string;
  content: string;
  contentType: string;
  encryption: string;
  replyPin: string;
  timestamp: number | null;
  chain: string;
  raw: Record<string, unknown>;
}

interface PrivateChatHistoryPagePayload {
  data?: {
    list?: unknown[];
  };
}

interface PrivateChatHistorySyncServiceDeps {
  endpoints?: PrivateChatHistoryEndpoint[];
  fetchJson?: (url: string) => Promise<PrivateChatHistoryPagePayload>;
}

export interface FetchRecentPrivateChatMessagesParams {
  metaId: string;
  otherMetaId: string;
  lookback?: number;
}

export interface StorePrivateChatHistoryMessagesParams {
  db: Database;
  saveDb: () => void;
  messages: PrivateChatHistoryMessage[];
  unprocessedAfterTimestampSec?: number;
}

const DEFAULT_ENDPOINTS: PrivateChatHistoryEndpoint[] = [
  { baseUrl: 'https://www.show.now/chat-api/group-chat/private-chat-list-by-index' },
  { baseUrl: 'https://api.idchat.io/chat-api/group-chat/private-chat-list-by-index' },
];

const DEFAULT_LOOKBACK = 64;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toNullableNumber = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value);
};

const getUserInfoRecord = (value: unknown): Record<string, unknown> | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
};

const buildConversationCacheKey = (
  endpoint: PrivateChatHistoryEndpoint,
  metaId: string,
  otherMetaId: string,
): string => `${endpoint.baseUrl}|${metaId}|${otherMetaId}`;

const scoreMessage = (message: PrivateChatHistoryMessage): number => {
  return [
    message.txId,
    message.pinId,
    message.from,
    message.fromGlobalMetaId,
    message.to,
    message.toGlobalMetaId,
    message.protocol,
    message.content,
    message.contentType,
    message.encryption,
    message.replyPin,
    message.chain,
  ].filter(Boolean).length;
};

function normalizeHistoryMessage(raw: unknown): PrivateChatHistoryMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }

  const record = raw as Record<string, unknown>;
  const fromUserInfo = getUserInfoRecord(record.fromUserInfo);
  const toUserInfo = getUserInfoRecord(record.toUserInfo);
  const userInfo = getUserInfoRecord(record.userInfo);
  const txId = toSafeString(record.txId);
  const pinId = toSafeString(record.pinId) || (txId ? `${txId}i0` : '');
  if (!pinId) {
    return null;
  }

  return {
    index: toNullableNumber(record.index),
    txId,
    pinId,
    from: toSafeString(record.from) || toSafeString(fromUserInfo?.metaid) || toSafeString(record.fromGlobalMetaId),
    fromGlobalMetaId: toSafeString(record.fromGlobalMetaId)
      || toSafeString(fromUserInfo?.globalMetaId)
      || toSafeString(record.globalMetaId)
      || toSafeString(userInfo?.globalMetaId),
    fromUserInfo,
    to: toSafeString(record.to) || toSafeString(toUserInfo?.metaid) || toSafeString(record.toGlobalMetaId),
    toGlobalMetaId: toSafeString(record.toGlobalMetaId) || toSafeString(toUserInfo?.globalMetaId),
    toUserInfo,
    protocol: toSafeString(record.protocol),
    content: toSafeString(record.content),
    contentType: toSafeString(record.contentType),
    encryption: toSafeString(record.encryption) || toSafeString(record.encrypt),
    replyPin: toSafeString(record.replyPin),
    timestamp: toNullableNumber(record.timestamp),
    chain: toSafeString(record.chain),
    raw: record,
  };
}

export class PrivateChatHistorySyncService {
  private readonly endpoints: PrivateChatHistoryEndpoint[];

  private readonly fetchJson: (url: string) => Promise<PrivateChatHistoryPagePayload>;

  private readonly latestIndexCache = new Map<string, number>();

  constructor(deps: PrivateChatHistorySyncServiceDeps = {}) {
    this.endpoints = deps.endpoints ?? DEFAULT_ENDPOINTS;
    this.fetchJson = deps.fetchJson ?? (async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch private chat history: ${response.status}`);
      }
      return await response.json() as PrivateChatHistoryPagePayload;
    });
  }

  async fetchRecentConversationMessages(
    params: FetchRecentPrivateChatMessagesParams,
  ): Promise<PrivateChatHistoryMessage[]> {
    const metaId = toSafeString(params.metaId);
    const otherMetaId = toSafeString(params.otherMetaId);
    const lookback = Math.max(1, Math.trunc(params.lookback ?? DEFAULT_LOOKBACK));
    if (!metaId || !otherMetaId) {
      return [];
    }

    const lists = await Promise.all(this.endpoints.map(async (endpoint) => {
      try {
        const maxIndex = await this.findMaxIndex(endpoint, metaId, otherMetaId);
        if (maxIndex < 1) {
          return [];
        }
        const startIndex = Math.max(0, maxIndex - lookback + 1);
        return await this.fetchPage(endpoint, metaId, otherMetaId, startIndex, lookback);
      } catch {
        return [];
      }
    }));

    const merged = new Map<string, PrivateChatHistoryMessage>();
    for (const message of lists.flat()) {
      const key = message.pinId || message.txId;
      const existing = merged.get(key);
      if (!existing || scoreMessage(message) >= scoreMessage(existing)) {
        merged.set(key, message);
      }
    }

    return [...merged.values()].sort((left, right) => {
      const leftIndex = left.index ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.index ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      const leftTimestamp = left.timestamp ?? Number.MAX_SAFE_INTEGER;
      const rightTimestamp = right.timestamp ?? Number.MAX_SAFE_INTEGER;
      return leftTimestamp - rightTimestamp;
    });
  }

  private async findMaxIndex(
    endpoint: PrivateChatHistoryEndpoint,
    metaId: string,
    otherMetaId: string,
  ): Promise<number> {
    const cacheKey = buildConversationCacheKey(endpoint, metaId, otherMetaId);
    const cachedIndex = this.latestIndexCache.get(cacheKey) ?? 0;

    if (cachedIndex > 0) {
      const nextExists = await this.hasMessageAtIndex(endpoint, metaId, otherMetaId, cachedIndex + 1);
      if (!nextExists) {
        return cachedIndex;
      }

      let low = cachedIndex + 1;
      let high = low;
      while (await this.hasMessageAtIndex(endpoint, metaId, otherMetaId, high)) {
        low = high;
        high *= 2;
      }

      const discovered = await this.binarySearchMaxIndex(endpoint, metaId, otherMetaId, low, high - 1);
      this.latestIndexCache.set(cacheKey, discovered);
      return discovered;
    }

    const hasAnyMessages = await this.hasMessageAtIndex(endpoint, metaId, otherMetaId, 0);
    if (!hasAnyMessages) {
      this.latestIndexCache.set(cacheKey, 0);
      return 0;
    }

    let low = 1;
    let high = 1;
    while (await this.hasMessageAtIndex(endpoint, metaId, otherMetaId, high)) {
      low = high;
      high *= 2;
    }

    const discovered = await this.binarySearchMaxIndex(endpoint, metaId, otherMetaId, low, high - 1);
    this.latestIndexCache.set(cacheKey, discovered);
    return discovered;
  }

  private async binarySearchMaxIndex(
    endpoint: PrivateChatHistoryEndpoint,
    metaId: string,
    otherMetaId: string,
    low: number,
    high: number,
  ): Promise<number> {
    let left = low;
    let right = Math.max(low, high);
    let best = low;

    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (await this.hasMessageAtIndex(endpoint, metaId, otherMetaId, mid)) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }

    return best;
  }

  private async hasMessageAtIndex(
    endpoint: PrivateChatHistoryEndpoint,
    metaId: string,
    otherMetaId: string,
    startIndex: number,
  ): Promise<boolean> {
    const page = await this.fetchPage(endpoint, metaId, otherMetaId, startIndex, 1);
    return page.length > 0;
  }

  private async fetchPage(
    endpoint: PrivateChatHistoryEndpoint,
    metaId: string,
    otherMetaId: string,
    startIndex: number,
    size: number,
  ): Promise<PrivateChatHistoryMessage[]> {
    const url = new URL(endpoint.baseUrl);
    url.searchParams.set('metaId', metaId);
    url.searchParams.set('otherMetaId', otherMetaId);
    url.searchParams.set('size', String(Math.max(1, Math.trunc(size))));
    url.searchParams.set('startIndex', String(Math.max(0, Math.trunc(startIndex))));

    const json = await this.fetchJson(url.toString());
    const list = Array.isArray(json?.data?.list) ? json.data.list : [];
    return list
      .map((item) => normalizeHistoryMessage(item))
      .filter((item): item is PrivateChatHistoryMessage => Boolean(item));
  }
}

export function storePrivateChatHistoryMessages(
  params: StorePrivateChatHistoryMessagesParams,
): number {
  let insertedCount = 0;

  for (const message of params.messages) {
    const isProcessed = (
      typeof params.unprocessedAfterTimestampSec === 'number'
      && typeof message.timestamp === 'number'
      && message.timestamp >= params.unprocessedAfterTimestampSec
    ) ? 0 : 1;

    const fromUserInfo = message.fromUserInfo ?? {};
    const rawData = JSON.stringify(message.raw);

    params.db.run(
      `INSERT OR IGNORE INTO private_chat_messages (
        pin_id, tx_id, from_metaid, from_global_metaid, from_name, from_avatar, from_chat_pubkey,
        to_metaid, to_global_metaid, protocol, content, content_type, encryption, reply_pin,
        chain_timestamp, chain, raw_data, is_processed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.pinId,
        message.txId || null,
        message.from || null,
        message.fromGlobalMetaId || null,
        toSafeString((fromUserInfo as Record<string, unknown>).name) || null,
        toSafeString((fromUserInfo as Record<string, unknown>).avatar) || null,
        toSafeString((fromUserInfo as Record<string, unknown>).chatPublicKey) || null,
        message.to || null,
        message.toGlobalMetaId || null,
        message.protocol || null,
        message.content || null,
        message.contentType || null,
        message.encryption || null,
        message.replyPin || '',
        message.timestamp,
        message.chain || null,
        rawData,
        isProcessed,
      ],
    );

    insertedCount += (params.db as { getRowsModified?: () => number }).getRowsModified?.() ?? 0;
  }

  if (insertedCount > 0) {
    params.saveDb();
  }

  return insertedCount;
}
