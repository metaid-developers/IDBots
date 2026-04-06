import type {
  HeartbeatDiscoverySnapshot,
  HeartbeatProviderState,
} from './heartbeatPollingService';
import type { LocalPresenceSnapshot } from './p2pPresenceClient';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';

const PRESENCE_POLL_INTERVAL_MS = 10 * 1000;

type ProviderGroup = {
  key: string;
  globalMetaId: string;
  address: string;
  services: any[];
};

type RefreshOptions = {
  rebroadcast?: boolean;
  triggerHeartbeatRefresh?: boolean;
};

type ResolvedRefreshOptions = {
  rebroadcast: boolean;
  triggerHeartbeatRefresh: boolean;
};

export interface ProviderDiscoveryHeartbeatBackend {
  startPolling(getServices: () => any[]): void;
  stopPolling(): void;
  refreshNow(): Promise<void>;
  recordLocalHeartbeat(input: {
    globalMetaId?: string | null;
    address?: string | null;
    timestampSec?: number | null;
  }): void;
  markOffline(globalMetaId: string): void;
  forceOffline(globalMetaId: string): void;
  clearForceOffline(globalMetaId: string): void;
  getDiscoverySnapshot(): HeartbeatDiscoverySnapshot;
  subscribe(listener: (snapshot: HeartbeatDiscoverySnapshot) => void): () => void;
}

export interface ProviderDiscoveryServiceDeps {
  heartbeat: ProviderDiscoveryHeartbeatBackend;
  fetchPresence: () => Promise<LocalPresenceSnapshot>;
  now?: () => number;
}

export type DiscoverySnapshot = HeartbeatDiscoverySnapshot;
export type DiscoveryServiceCandidate = {
  id?: string | null;
  pinId?: string | null;
  sourceServicePinId?: string | null;
  currentPinId?: string | null;
  serviceName?: string | null;
  displayName?: string | null;
  providerGlobalMetaId?: string | null;
  globalMetaId?: string | null;
  providerAddress?: string | null;
  createAddress?: string | null;
  address?: string | null;
};

type DiscoveryListener = (snapshot: DiscoverySnapshot) => void;

const EMPTY_SNAPSHOT: DiscoverySnapshot = {
  onlineBots: {},
  availableServices: [],
  providers: {},
};

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

const normalizeComparableGlobalMetaId = (value: unknown): string => {
  return normalizeRawGlobalMetaId(value) ?? toSafeString(value);
};

const resolveServiceGlobalMetaId = (service: any): string => {
  return normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId);
};

const resolveServiceProviderAddress = (service: any): string => {
  return toSafeString(service?.providerAddress || service?.createAddress || service?.address);
};

const buildProviderKey = (globalMetaId: string, address: string): string => {
  return `${globalMetaId}::${address}`;
};

const resolveServicePinCandidates = (service: DiscoveryServiceCandidate): string[] => (
  [...new Set([
    toSafeString(service.id),
    toSafeString(service.pinId),
    toSafeString(service.currentPinId),
    toSafeString(service.sourceServicePinId),
  ].filter(Boolean))]
);

const resolveServiceMatchKeys = (service: DiscoveryServiceCandidate): string[] => {
  const globalMetaId = normalizeComparableGlobalMetaId(
    service.providerGlobalMetaId || service.globalMetaId,
  );
  const address = toSafeString(service.providerAddress || service.createAddress || service.address);
  const serviceName = toSafeString(service.serviceName || service.displayName).toLowerCase();
  const keys = new Set<string>();

  for (const pinId of resolveServicePinCandidates(service)) {
    if (globalMetaId) keys.add(`pin:${globalMetaId}:${pinId}`);
    if (address) keys.add(`pin-address:${address}:${pinId}`);
  }

  if (globalMetaId && address) keys.add(`provider:${globalMetaId}:${address}`);
  if (globalMetaId && serviceName) keys.add(`name:${globalMetaId}:${serviceName}`);
  if (address && serviceName) keys.add(`name-address:${address}:${serviceName}`);

  return [...keys];
};

export const isServiceCallableInDiscoverySnapshot = (
  service: DiscoveryServiceCandidate,
  snapshot: Pick<DiscoverySnapshot, 'availableServices'>,
): boolean => {
  const availableKeys = new Set(
    snapshot.availableServices.flatMap((candidate) => resolveServiceMatchKeys(candidate as DiscoveryServiceCandidate)),
  );
  return resolveServiceMatchKeys(service).some((key) => availableKeys.has(key));
};

export const filterServicesByDiscoverySnapshot = <T extends DiscoveryServiceCandidate>(
  services: T[],
  snapshot: Pick<DiscoverySnapshot, 'availableServices'>,
): T[] => services.filter((service) => isServiceCallableInDiscoverySnapshot(service, snapshot));

const cloneProviderState = (state: HeartbeatProviderState): HeartbeatProviderState => ({ ...state });

const cloneDiscoverySnapshot = (snapshot: DiscoverySnapshot): DiscoverySnapshot => ({
  onlineBots: { ...snapshot.onlineBots },
  availableServices: snapshot.availableServices.map((service) => ({ ...service })),
  providers: Object.fromEntries(
    Object.entries(snapshot.providers).map(([key, state]) => [key, cloneProviderState(state)]),
  ),
});

const normalizeForComparison = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeForComparison(entry));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeForComparison(nestedValue)]),
  );
};

const serializeSnapshot = (snapshot: DiscoverySnapshot): string => {
  return JSON.stringify(normalizeForComparison(snapshot));
};

const resolvePresenceCheckAtSec = (
  presence: LocalPresenceSnapshot,
  fallbackNowSec: number,
): number => {
  return typeof presence.nowSec === 'number' && Number.isFinite(presence.nowSec)
    ? presence.nowSec
    : fallbackNowSec;
};

const buildProviderGroups = (services: any[]): ProviderGroup[] => {
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
};

const buildPresenceSnapshot = (
  services: any[],
  presence: LocalPresenceSnapshot,
  fallbackNowSec: number,
  forcedOfflineGlobalMetaIds: ReadonlySet<string>,
): DiscoverySnapshot => {
  const onlineBots = Object.fromEntries(
    Object.entries(presence.onlineBots)
      .filter(([globalMetaId]) => !forcedOfflineGlobalMetaIds.has(globalMetaId))
      .map(([globalMetaId, state]) => [globalMetaId, state.lastSeenSec]),
  );
  const availableServices: any[] = [];
  const providers: Record<string, HeartbeatProviderState> = {};
  const lastCheckAt = resolvePresenceCheckAtSec(presence, fallbackNowSec);

  for (const group of buildProviderGroups(services)) {
    const forcedOffline =
      Boolean(group.globalMetaId) && forcedOfflineGlobalMetaIds.has(group.globalMetaId);
    const presenceState =
      !forcedOffline && group.globalMetaId ? presence.onlineBots[group.globalMetaId] : undefined;
    const online = Boolean(presenceState);

    providers[group.key] = {
      key: group.key,
      globalMetaId: group.globalMetaId,
      address: group.address,
      lastSeenSec: presenceState?.lastSeenSec ?? null,
      lastCheckAt,
      lastSource: 'presence',
      lastError: forcedOffline ? 'locally_disabled' : null,
      online,
      optimisticLocal: false,
    };

    if (online) {
      availableServices.push(...group.services);
    }
  }

  return {
    onlineBots,
    availableServices,
    providers,
  };
};

const unhealthyPresenceSnapshot = (reason: string): LocalPresenceSnapshot => ({
  healthy: false,
  peerCount: 0,
  onlineBots: {},
  unhealthyReason: reason,
  lastConfigReloadError: null,
  nowSec: null,
});

const normalizeRefreshOptions = (options?: RefreshOptions): ResolvedRefreshOptions => ({
  rebroadcast: Boolean(options?.rebroadcast),
  triggerHeartbeatRefresh: options?.triggerHeartbeatRefresh ?? true,
});

const mergeRefreshOptions = (
  left: ResolvedRefreshOptions,
  right: ResolvedRefreshOptions,
): ResolvedRefreshOptions => ({
  rebroadcast: left.rebroadcast || right.rebroadcast,
  triggerHeartbeatRefresh: left.triggerHeartbeatRefresh || right.triggerHeartbeatRefresh,
});

export class ProviderDiscoveryService {
  private readonly deps: ProviderDiscoveryServiceDeps;
  private readonly listeners: Set<DiscoveryListener> = new Set();
  private readonly unsubscribeHeartbeat: () => void;
  private readonly forcedOfflineGlobalMetaIds: Set<string> = new Set();
  private snapshot: DiscoverySnapshot = cloneDiscoverySnapshot(EMPTY_SNAPSHOT);
  private snapshotSignature = serializeSnapshot(EMPTY_SNAPSHOT);
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private getServices: (() => any[]) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pendingRefresh = false;
  private pendingRefreshOptions: ResolvedRefreshOptions = normalizeRefreshOptions({
    rebroadcast: false,
    triggerHeartbeatRefresh: false,
  });
  private activeSource: 'presence' | 'heartbeat' | null = null;
  private suppressHeartbeatListener = false;

  constructor(deps: ProviderDiscoveryServiceDeps) {
    this.deps = deps;
    this.unsubscribeHeartbeat = this.deps.heartbeat.subscribe((snapshot) => {
      if (this.activeSource !== 'heartbeat' || this.suppressHeartbeatListener) {
        return;
      }
      this.applySnapshot(snapshot, false);
    });
  }

  get availableServices(): any[] {
    return this.snapshot.availableServices;
  }

  getDiscoverySnapshot(): DiscoverySnapshot {
    return cloneDiscoverySnapshot(this.snapshot);
  }

  subscribe(listener: DiscoveryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  startPolling(getServices: () => any[]): void {
    this.stopPolling();
    this.getServices = getServices;
    this.deps.heartbeat.startPolling(getServices);
    void this.refreshNow().catch((error) => {
      console.warn('[ProviderDiscovery] initial refresh failed:', error);
    });
    this.intervalId = setInterval(() => {
      void this.refreshNow({ triggerHeartbeatRefresh: false }).catch((error) => {
        console.warn('[ProviderDiscovery] interval refresh failed:', error);
      });
    }, PRESENCE_POLL_INTERVAL_MS);
    this.intervalId.unref?.();
  }

  stopPolling(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.getServices = null;
    this.deps.heartbeat.stopPolling();
  }

  recordLocalHeartbeat(input: {
    globalMetaId?: string | null;
    address?: string | null;
    timestampSec?: number | null;
  }): void {
    this.deps.heartbeat.recordLocalHeartbeat(input);
  }

  markOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.deps.heartbeat.markOffline(normalizedGlobalMetaId);
    this.applyPresenceOfflineMutation(normalizedGlobalMetaId, 'manually_marked_offline');
  }

  forceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.add(normalizedGlobalMetaId);
    this.deps.heartbeat.forceOffline(normalizedGlobalMetaId);
    this.applyPresenceOfflineMutation(normalizedGlobalMetaId, 'locally_disabled');
  }

  clearForceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.delete(normalizedGlobalMetaId);
    this.deps.heartbeat.clearForceOffline(normalizedGlobalMetaId);
  }

  async refreshNow(options?: RefreshOptions): Promise<void> {
    const requested = normalizeRefreshOptions(options);

    if (this.refreshPromise) {
      this.pendingRefresh = true;
      this.pendingRefreshOptions = mergeRefreshOptions(this.pendingRefreshOptions, requested);
      return this.refreshPromise;
    }

    this.refreshPromise = (async () => {
      let currentOptions = requested;
      do {
        this.pendingRefresh = false;
        this.pendingRefreshOptions = normalizeRefreshOptions({
          rebroadcast: false,
          triggerHeartbeatRefresh: false,
        });
        await this.performRefresh(currentOptions);
        currentOptions = this.pendingRefreshOptions;
      } while (this.pendingRefresh);
    })().finally(() => {
      this.refreshPromise = null;
    });

    return this.refreshPromise;
  }

  dispose(): void {
    this.stopPolling();
    this.unsubscribeHeartbeat();
    this.listeners.clear();
  }

  private async performRefresh(options: ResolvedRefreshOptions): Promise<void> {
    let presence: LocalPresenceSnapshot;
    try {
      presence = await this.deps.fetchPresence();
    } catch (error) {
      console.warn('[ProviderDiscovery] presence fetch failed:', error);
      presence = unhealthyPresenceSnapshot('request_failed');
    }

    if (presence.healthy) {
      this.activeSource = 'presence';
      const services = this.getServices ? this.getServices() : [];
      const snapshot = buildPresenceSnapshot(
        services,
        presence,
        this.nowSec(),
        this.forcedOfflineGlobalMetaIds,
      );
      this.applySnapshot(snapshot, options.rebroadcast);
      return;
    }

    this.activeSource = 'heartbeat';
    if (options.triggerHeartbeatRefresh) {
      this.suppressHeartbeatListener = true;
      try {
        await this.deps.heartbeat.refreshNow();
      } finally {
        this.suppressHeartbeatListener = false;
      }
    }

    this.applySnapshot(this.deps.heartbeat.getDiscoverySnapshot(), options.rebroadcast);
  }

  private nowSec(): number {
    const now = this.deps.now ? this.deps.now() : Date.now();
    return Math.floor(now / 1000);
  }

  private applySnapshot(nextSnapshot: DiscoverySnapshot, forceEmit: boolean): void {
    const clonedSnapshot = cloneDiscoverySnapshot(nextSnapshot);
    const nextSignature = serializeSnapshot(clonedSnapshot);
    const changed = nextSignature !== this.snapshotSignature;

    this.snapshot = clonedSnapshot;
    this.snapshotSignature = nextSignature;

    if (!changed && !forceEmit) {
      return;
    }

    for (const listener of this.listeners) {
      try {
        listener(this.getDiscoverySnapshot());
      } catch (error) {
        console.warn('[ProviderDiscovery] change listener failed:', error);
      }
    }
  }

  private applyPresenceOfflineMutation(globalMetaId: string, reason: string): void {
    if (this.activeSource !== 'presence') {
      return;
    }

    const nextSnapshot = this.getDiscoverySnapshot();
    delete nextSnapshot.onlineBots[globalMetaId];
    nextSnapshot.availableServices = nextSnapshot.availableServices.filter(
      (service) => resolveServiceGlobalMetaId(service) !== globalMetaId,
    );

    for (const state of Object.values(nextSnapshot.providers)) {
      if (state.globalMetaId !== globalMetaId) {
        continue;
      }
      state.online = false;
      state.lastError = reason;
      state.optimisticLocal = false;
    }

    this.applySnapshot(nextSnapshot, false);
  }
}
