import { fetchJsonWithFallbackOnMiss } from './localIndexerProxy';
import { getP2PLocalBase } from './p2pLocalEndpoint';

const HEARTBEAT_ONLINE_WINDOW_SEC = 10 * 60; // 10 minutes
const HEARTBEAT_POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const HEARTBEAT_FETCH_CONCURRENCY = 6;
const HEARTBEAT_PROTOCOL_PATH = '/protocols/metabot-heartbeat';
const MANAPI_HOST = 'https://manapi.metaid.io';

export interface HeartbeatFetchResult {
  timestamp?: number | null;
  source?: string;
  error?: string | null;
}

export interface HeartbeatProviderState {
  key: string;
  globalMetaId: string;
  address: string;
  lastSeenSec: number | null;
  lastCheckAt: number | null;
  lastSource: string | null;
  lastError: string | null;
  online: boolean;
  optimisticLocal: boolean;
}

export interface HeartbeatDiscoverySnapshot {
  onlineBots: Record<string, number>;
  availableServices: any[];
  providers: Record<string, HeartbeatProviderState>;
}

export interface HeartbeatDeps {
  fetchHeartbeat: (mvcAddress: string) => Promise<HeartbeatFetchResult | null>;
  now?: () => number;
}

type ProviderGroup = {
  key: string;
  globalMetaId: string;
  address: string;
  services: any[];
};

type HeartbeatListener = (snapshot: HeartbeatDiscoverySnapshot) => void;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const resolveServiceGlobalMetaId = (service: any): string => {
  return toSafeString(service?.providerGlobalMetaId || service?.globalMetaId);
};

const resolveServiceProviderAddress = (service: any): string => {
  return toSafeString(service?.providerAddress || service?.createAddress || service?.address);
};

const buildProviderKey = (globalMetaId: string, address: string): string => {
  return `${globalMetaId}::${address}`;
};

const pickLatestTimestamp = (...values: Array<number | null | undefined>): number | null => {
  let latest: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (latest == null || value > latest) {
      latest = value;
    }
  }
  return latest;
};

const normalizeHeartbeatSource = (value: unknown): string | null => {
  const normalized = toSafeString(value);
  return normalized || null;
};

const isHeartbeatSemanticMiss = (payload: unknown): boolean => {
  const list = (
    (payload as { data?: { list?: unknown } } | null)?.data?.list
    ?? (payload as { list?: unknown } | null)?.list
    ?? (payload as { result?: { list?: unknown } } | null)?.result?.list
  );
  return !Array.isArray(list) || list.length === 0;
};

export class HeartbeatPollingService {
  private deps: HeartbeatDeps;
  private _onlineBots: Map<string, number> = new Map();
  private _availableServices: any[] = [];
  private _providerStates: Map<string, HeartbeatProviderState> = new Map();
  private _localHeartbeatsByAddress: Map<string, { globalMetaId: string; lastSeenSec: number }> = new Map();
  private _forcedOfflineGlobalMetaIds: Set<string> = new Set();
  private _listeners: Set<HeartbeatListener> = new Set();
  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _getServices: (() => any[]) | null = null;
  private _pollPromise: Promise<void> | null = null;
  private _pendingRefresh = false;

  constructor(deps: HeartbeatDeps) {
    this.deps = deps;
  }

  get onlineBots(): Map<string, number> {
    return this._onlineBots;
  }

  get availableServices(): any[] {
    return this._availableServices;
  }

  get providerStates(): Map<string, HeartbeatProviderState> {
    return this._providerStates;
  }

  getDiscoverySnapshot(): HeartbeatDiscoverySnapshot {
    return {
      onlineBots: Object.fromEntries(this._onlineBots),
      availableServices: this._availableServices.map((service) => ({ ...service })),
      providers: Object.fromEntries(
        [...this._providerStates.entries()].map(([key, state]) => [key, { ...state }]),
      ),
    };
  }

  subscribe(listener: HeartbeatListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  checkOnlineStatus(timestampSec: number | null): boolean {
    if (timestampSec == null) return false;
    const nowSec = Math.floor(this.nowMs() / 1000);
    return nowSec - timestampSec <= HEARTBEAT_ONLINE_WINDOW_SEC;
  }

  recordLocalHeartbeat(input: {
    globalMetaId?: string | null;
    address?: string | null;
    timestampSec?: number | null;
  }): void {
    const address = toSafeString(input.address);
    if (!address) return;
    const timestampSec = toNumberOrNull(input.timestampSec) ?? Math.floor(this.nowMs() / 1000);
    this._localHeartbeatsByAddress.set(address, {
      globalMetaId: toSafeString(input.globalMetaId),
      lastSeenSec: timestampSec,
    });
  }

  async pollAll(services: any[]): Promise<void> {
    const providerGroups = this.buildProviderGroups(services);
    const results = await this.mapWithConcurrency(
      providerGroups,
      HEARTBEAT_FETCH_CONCURRENCY,
      async (group) => this.evaluateProviderGroup(group),
    );

    const nextOnlineBots: Map<string, number> = new Map();
    const nextAvailableServices: any[] = [];
    const nextProviderStates: Map<string, HeartbeatProviderState> = new Map();

    for (const result of results) {
      nextProviderStates.set(result.state.key, result.state);
      if (!result.state.online) continue;

      if (result.state.globalMetaId && result.state.lastSeenSec != null) {
        const existing = nextOnlineBots.get(result.state.globalMetaId);
        if (existing == null || result.state.lastSeenSec > existing) {
          nextOnlineBots.set(result.state.globalMetaId, result.state.lastSeenSec);
        }
      }

      nextAvailableServices.push(...result.services);
    }

    this._onlineBots = nextOnlineBots;
    this._availableServices = nextAvailableServices;
    this._providerStates = nextProviderStates;
    this.emitChange();
  }

  startPolling(getServices: () => any[]): void {
    this.stopPolling();
    this._getServices = getServices;
    void this.refreshNow().catch((err) => {
      console.warn('[HeartbeatPolling] initial poll error:', err);
    });

    this._intervalId = setInterval(() => {
      void this.refreshNow().catch((err) => {
        console.warn('[HeartbeatPolling] interval poll error:', err);
      });
    }, HEARTBEAT_POLL_INTERVAL_MS);
  }

  async refreshNow(): Promise<void> {
    if (!this._getServices) {
      return;
    }

    if (this._pollPromise) {
      this._pendingRefresh = true;
      return this._pollPromise;
    }

    this._pollPromise = (async () => {
      do {
        this._pendingRefresh = false;
        await this.pollAll(this._getServices ? this._getServices() : []);
      } while (this._pendingRefresh);
    })().finally(() => {
      this._pollPromise = null;
    });

    return this._pollPromise;
  }

  stopPolling(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
  }

  markOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = toSafeString(globalMetaId);
    if (!normalizedGlobalMetaId) return;

    this._onlineBots.delete(normalizedGlobalMetaId);
    this._availableServices = this._availableServices.filter(
      (service: any) => resolveServiceGlobalMetaId(service) !== normalizedGlobalMetaId,
    );
    this._providerStates = new Map(
      [...this._providerStates.entries()].filter(([, state]) => state.globalMetaId !== normalizedGlobalMetaId),
    );
    this._localHeartbeatsByAddress = new Map(
      [...this._localHeartbeatsByAddress.entries()].filter(
        ([, state]) => state.globalMetaId !== normalizedGlobalMetaId,
      ),
    );
    this.emitChange();
  }

  forceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = toSafeString(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this._forcedOfflineGlobalMetaIds.add(normalizedGlobalMetaId);
    this.markOffline(normalizedGlobalMetaId);
  }

  clearForceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = toSafeString(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this._forcedOfflineGlobalMetaIds.delete(normalizedGlobalMetaId);
  }

  private nowMs(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private emitChange(): void {
    if (this._listeners.size === 0) return;
    const snapshot = this.getDiscoverySnapshot();
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[HeartbeatPolling] change listener failed:', error);
      }
    }
  }

  private buildProviderGroups(services: any[]): ProviderGroup[] {
    const groups = new Map<string, ProviderGroup>();

    for (const service of services) {
      const status = Number(service?.status ?? 0);
      if (Number.isFinite(status) && status < 0) {
        continue;
      }

      const available = Number(service?.available ?? 1);
      if (Number.isFinite(available) && available === 0) {
        continue;
      }

      const globalMetaId = resolveServiceGlobalMetaId(service);
      const address = resolveServiceProviderAddress(service);
      if (!address) {
        continue;
      }

      const key = buildProviderKey(globalMetaId, address);
      const existing = groups.get(key);
      if (existing) {
        existing.services.push(service);
        continue;
      }
      groups.set(key, {
        key,
        globalMetaId,
        address,
        services: [service],
      });
    }

    return [...groups.values()];
  }

  private async evaluateProviderGroup(group: ProviderGroup): Promise<{
    services: any[];
    state: HeartbeatProviderState;
  }> {
    const previousState = this._providerStates.get(group.key);
    const localHeartbeat = this._localHeartbeatsByAddress.get(group.address);
    let fetchResult: HeartbeatFetchResult | null = null;
    let fetchError: string | null = null;

    try {
      fetchResult = await this.deps.fetchHeartbeat(group.address);
    } catch (error) {
      fetchError = error instanceof Error ? error.message : String(error);
      console.warn(`[HeartbeatPolling] fetch error for ${group.address}:`, error);
    }

    const fetchedTimestamp = toNumberOrNull(fetchResult?.timestamp);
    const previousTimestamp = previousState?.lastSeenSec ?? null;
    const optimisticLocalTimestamp =
      localHeartbeat && this.checkOnlineStatus(localHeartbeat.lastSeenSec)
        ? localHeartbeat.lastSeenSec
        : null;
    const latestTimestamp = pickLatestTimestamp(
      fetchedTimestamp,
      previousTimestamp,
      optimisticLocalTimestamp,
    );
    const forcedOffline =
      Boolean(group.globalMetaId) && this._forcedOfflineGlobalMetaIds.has(group.globalMetaId);
    const online = forcedOffline ? false : this.checkOnlineStatus(latestTimestamp);
    const optimisticLocal =
      !forcedOffline
      &&
      optimisticLocalTimestamp != null
      && latestTimestamp === optimisticLocalTimestamp
      && fetchedTimestamp == null;
    const lastSource =
      latestTimestamp != null && fetchedTimestamp != null && latestTimestamp === fetchedTimestamp
        ? normalizeHeartbeatSource(fetchResult?.source) ?? 'remote'
        : optimisticLocal
          ? 'local-heartbeat'
          : previousState?.lastSource ?? normalizeHeartbeatSource(fetchResult?.source);
    const fetchResultError = toSafeString(fetchResult?.error || '');
    const lastError = forcedOffline
      ? 'locally_disabled'
      : (fetchError ?? (fetchResultError || null));
    const state: HeartbeatProviderState = {
      key: group.key,
      globalMetaId: group.globalMetaId,
      address: group.address,
      lastSeenSec: latestTimestamp,
      lastCheckAt: Math.floor(this.nowMs() / 1000),
      lastSource,
      lastError,
      online,
      optimisticLocal,
    };

    return {
      services: online ? group.services : [],
      state,
    };
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    worker: (item: T) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    const concurrency = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;

    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (true) {
          const index = nextIndex;
          nextIndex += 1;
          if (index >= items.length) {
            return;
          }
          results[index] = await worker(items[index]);
        }
      }),
    );

    return results;
  }
}

export async function fetchHeartbeatFromChain(
  mvcAddress: string,
): Promise<HeartbeatFetchResult | null> {
  const normalizedAddress = toSafeString(mvcAddress);
  if (!normalizedAddress) {
    return { timestamp: null, source: 'none', error: 'missing_address' };
  }

  const query = `cursor=0&size=1&path=${encodeURIComponent(HEARTBEAT_PROTOCOL_PATH)}`;
  const localPath = `/api/address/pin/list/${encodeURIComponent(normalizedAddress)}?${query}`;
  const fallbackUrl = `${MANAPI_HOST}/address/pin/list/${encodeURIComponent(normalizedAddress)}?${query}`;
  const localBase = getP2PLocalBase();

  try {
    const res = await fetchJsonWithFallbackOnMiss(localPath, fallbackUrl, isHeartbeatSemanticMiss);
    const source = res.url.startsWith(localBase) ? 'local' : 'remote';
    if (!res.ok) {
      console.warn(`[HeartbeatPolling] fetch ${res.url} → ${res.status}`);
      return { timestamp: null, source, error: `status_${res.status}` };
    }

    const json = await res.json();
    const list = json?.data?.list || json?.list || json?.result?.list;
    if (!Array.isArray(list) || list.length === 0) {
      return { timestamp: null, source, error: 'semantic_miss' };
    }

    const item = list[0];
    const timestamp = toNumberOrNull(item?.seenTime ?? item?.seen_time);
    if (timestamp == null) {
      console.warn('[HeartbeatPolling] heartbeat pin has no valid seenTime');
      return { timestamp: null, source, error: 'invalid_seen_time' };
    }

    return { timestamp, source, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[HeartbeatPolling] fetchHeartbeatFromChain error for ${normalizedAddress}:`, error);
    return { timestamp: null, source: 'error', error: message || 'network_error' };
  }
}
