import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';

const DEFAULT_ENDPOINTS = [
  'https://api.idchat.io',
];

const ONLINE_STATUS_PATH = '/group-chat/socket/online-status';
const ONLINE_USERS_PATH = '/group-chat/socket/online-users';
const ONLINE_STATUS_BATCH_SIZE = 200;
const REQUEST_TIMEOUT_MS = 5000;

export interface IdchatOnlineStatusEntry {
  globalMetaId: string;
  isOnline: boolean;
  lastSeenAt: number;
  lastSeenAgoSeconds: number;
  deviceCount: number;
}

export interface IdchatOnlineStatusResult {
  total: number;
  onlineCount: number;
  list: IdchatOnlineStatusEntry[];
}

export interface IdchatOnlineUserEntry {
  globalMetaId: string;
  lastSeenAt: number;
  lastSeenAgoSeconds: number;
  deviceCount: number;
  userInfo?: Record<string, unknown> | null;
}

export interface IdchatOnlineUsersResult {
  total: number;
  cursor: number;
  size: number;
  onlineWindowSeconds: number;
  list: IdchatOnlineUserEntry[];
}

export interface IdchatPresenceServiceOptions {
  endpoints?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type ApiEnvelope<T> = {
  code?: unknown;
  data?: T;
  message?: unknown;
};

const normalizeEndpoint = (endpoint: string): string => endpoint.replace(/\/+$/, '');

const toFiniteNumber = (value: unknown, fallback = 0): number => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const normalizeGlobalMetaIds = (globalMetaIds: string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of globalMetaIds) {
    const normalized = normalizeRawGlobalMetaId(raw) ?? String(raw ?? '').trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
};

export class IdchatPresenceService {
  private readonly endpoints: string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: IdchatPresenceServiceOptions = {}) {
    this.endpoints = (options.endpoints && options.endpoints.length > 0 ? options.endpoints : DEFAULT_ENDPOINTS)
      .map(normalizeEndpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async fetchOnlineStatus(globalMetaIds: string[]): Promise<IdchatOnlineStatusResult> {
    const normalizedIds = normalizeGlobalMetaIds(globalMetaIds);
    if (normalizedIds.length === 0) {
      return { total: 0, onlineCount: 0, list: [] };
    }

    const list: IdchatOnlineStatusEntry[] = [];
    for (let index = 0; index < normalizedIds.length; index += ONLINE_STATUS_BATCH_SIZE) {
      const batch = normalizedIds.slice(index, index + ONLINE_STATUS_BATCH_SIZE);
      const result = await this.postOnlineStatusBatch(batch);
      list.push(...result.list);
    }

    return {
      total: list.length,
      onlineCount: list.filter((entry) => entry.isOnline).length,
      list,
    };
  }

  async fetchOnlineUsers(input: { cursor?: number; size?: number; withUserInfo?: boolean } = {}): Promise<IdchatOnlineUsersResult> {
    const params = new URLSearchParams();
    params.set('cursor', String(Math.max(0, Math.trunc(input.cursor ?? 0))));
    params.set('size', String(Math.max(1, Math.min(100, Math.trunc(input.size ?? 20)))));
    if (input.withUserInfo) {
      params.set('withUserInfo', 'true');
    }
    const data = await this.requestWithFallback<IdchatOnlineUsersResult>(`${ONLINE_USERS_PATH}?${params.toString()}`);
    return {
      total: toFiniteNumber((data as any)?.total),
      cursor: toFiniteNumber((data as any)?.cursor),
      size: toFiniteNumber((data as any)?.size),
      onlineWindowSeconds: toFiniteNumber((data as any)?.onlineWindowSeconds),
      list: Array.isArray((data as any)?.list)
        ? (data as any).list.map((entry: any) => ({
          globalMetaId: String(entry?.globalMetaId ?? '').trim(),
          lastSeenAt: toFiniteNumber(entry?.lastSeenAt),
          lastSeenAgoSeconds: toFiniteNumber(entry?.lastSeenAgoSeconds),
          deviceCount: toFiniteNumber(entry?.deviceCount),
          userInfo: entry?.userInfo ?? null,
        })).filter((entry: IdchatOnlineUserEntry) => entry.globalMetaId)
        : [],
    };
  }

  private async postOnlineStatusBatch(globalMetaIds: string[]): Promise<IdchatOnlineStatusResult> {
    const data = await this.requestWithFallback<IdchatOnlineStatusResult>(ONLINE_STATUS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ globalMetaIds }),
    });
    const list = Array.isArray((data as any)?.list)
      ? (data as any).list.map((entry: any) => ({
        globalMetaId: String(entry?.globalMetaId ?? '').trim(),
        isOnline: Boolean(entry?.isOnline),
        lastSeenAt: toFiniteNumber(entry?.lastSeenAt),
        lastSeenAgoSeconds: toFiniteNumber(entry?.lastSeenAgoSeconds),
        deviceCount: toFiniteNumber(entry?.deviceCount),
      })).filter((entry: IdchatOnlineStatusEntry) => entry.globalMetaId)
      : [];
    return {
      total: toFiniteNumber((data as any)?.total, list.length),
      onlineCount: toFiniteNumber((data as any)?.onlineCount, list.filter((entry) => entry.isOnline).length),
      list,
    };
  }

  private async requestWithFallback<T>(pathWithQuery: string, init?: RequestInit): Promise<T> {
    let lastError: unknown;
    for (const endpoint of this.endpoints) {
      try {
        const response = await this.fetchImpl(`${endpoint}${pathWithQuery}`, {
          ...init,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const envelope = await response.json() as ApiEnvelope<T>;
        if (envelope.code !== 0) {
          throw new Error(String(envelope.message || `API code ${String(envelope.code)}`));
        }
        if (envelope.data == null) {
          throw new Error('Missing response data');
        }
        return envelope.data;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error('idchat presence request failed');
  }
}
