import path from 'node:path';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
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

type HeartbeatListener = (snapshot: HeartbeatDiscoverySnapshot) => void;

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeComparableGlobalMetaId = (value: unknown): string => {
  return normalizeRawGlobalMetaId(value) ?? toSafeString(value);
};

const toNumberOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const isHeartbeatSemanticMiss = (payload: unknown): boolean => {
  const list = (
    (payload as { data?: { list?: unknown } } | null)?.data?.list
    ?? (payload as { list?: unknown } | null)?.list
    ?? (payload as { result?: { list?: unknown } } | null)?.result?.list
  );
  return !Array.isArray(list) || list.length === 0;
};

interface SharedPresenceRegistryInstance {
  readonly onlineBots: Map<string, number>;
  readonly availableServices: any[];
  readonly providerStates: Map<string, HeartbeatProviderState>;
  getDiscoverySnapshot(): HeartbeatDiscoverySnapshot;
  subscribe(listener: HeartbeatListener): () => void;
  checkOnlineStatus(timestampSec: number | null): boolean;
  recordLocalHeartbeat(input: {
    globalMetaId?: string | null;
    address?: string | null;
    timestampSec?: number | null;
  }): void;
  pollAll(services: any[]): Promise<void>;
  startPolling(getServices: () => any[]): void;
  refreshNow(): Promise<void>;
  stopPolling(): void;
  markOffline(globalMetaId: string): void;
  forceOffline(globalMetaId: string): void;
  clearForceOffline(globalMetaId: string): void;
}

interface SharedPresenceRegistryConstructor {
  new (deps: HeartbeatDeps): SharedPresenceRegistryInstance;
}

interface SharedPresenceRegistryModule {
  PresenceRegistry: SharedPresenceRegistryConstructor;
}

let cachedSharedPresenceRegistryModule: SharedPresenceRegistryModule | null = null;

const loadSharedPresenceRegistryModule = (): SharedPresenceRegistryModule => {
  if (cachedSharedPresenceRegistryModule) {
    return cachedSharedPresenceRegistryModule;
  }
  const modulePath = path.resolve(__dirname, '../../metabot/dist/core/discovery/presenceRegistry.js');
  cachedSharedPresenceRegistryModule = require(modulePath) as SharedPresenceRegistryModule;
  return cachedSharedPresenceRegistryModule;
};

const SharedPresenceRegistryBase = loadSharedPresenceRegistryModule().PresenceRegistry;

export class HeartbeatPollingService extends SharedPresenceRegistryBase {
  constructor(deps: HeartbeatDeps) {
    super(deps);
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
