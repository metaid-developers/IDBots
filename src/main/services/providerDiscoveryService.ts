import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import type { IdchatOnlineStatusEntry, IdchatPresenceService } from './idchatPresenceService';
import type { LocalPresenceSnapshot } from './p2pPresenceClient';

const PRESENCE_POLL_INTERVAL_MS = 10 * 1000;

type ProviderGroup = {
  key: string;
  globalMetaId: string;
  address: string;
  services: any[];
};

type RefreshOptions = {
  rebroadcast?: boolean;
};

type ResolvedRefreshOptions = {
  rebroadcast: boolean;
};

export interface DiscoveryProviderState {
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

export interface DiscoverySnapshot {
  onlineBots: Record<string, number>;
  availableServices: any[];
  providers: Record<string, DiscoveryProviderState>;
}

export interface ProviderDiscoveryServiceDeps {
  presence: Pick<IdchatPresenceService, 'fetchOnlineStatus'>;
  fetchP2PPresence?: () => Promise<LocalPresenceSnapshot>;
  now?: () => number;
}

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

const cloneProviderState = (state: DiscoveryProviderState): DiscoveryProviderState => ({ ...state });

const cloneDiscoverySnapshot = (snapshot: DiscoverySnapshot): DiscoverySnapshot => ({
  onlineBots: { ...snapshot.onlineBots },
  availableServices: snapshot.availableServices.map((service) => ({ ...service })),
  providers: Object.fromEntries(
    Object.entries(snapshot.providers).map(([key, state]) => [key, cloneProviderState(state)]),
  ),
});

const normalizeForComparison = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((entry) => normalizeForComparison(entry));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nestedValue]) => [key, normalizeForComparison(nestedValue)]),
  );
};

const serializeSnapshot = (snapshot: DiscoverySnapshot): string => {
  return JSON.stringify(normalizeForComparison(snapshot));
};

const normalizeRefreshOptions = (options?: RefreshOptions): ResolvedRefreshOptions => ({
  rebroadcast: Boolean(options?.rebroadcast),
});

const mergeRefreshOptions = (
  left: ResolvedRefreshOptions,
  right: ResolvedRefreshOptions,
): ResolvedRefreshOptions => ({
  rebroadcast: left.rebroadcast || right.rebroadcast,
});

const buildProviderGroups = (services: any[]): ProviderGroup[] => {
  const groups = new Map<string, ProviderGroup>();
  for (const service of services) {
    const status = Number(service?.status ?? 0);
    if (Number.isFinite(status) && status < 0) continue;
    const available = Number(service?.available ?? 1);
    if (Number.isFinite(available) && available === 0) continue;
    const address = resolveServiceProviderAddress(service);
    if (!address) continue;
    const globalMetaId = resolveServiceGlobalMetaId(service);
    const key = buildProviderKey(globalMetaId, address);
    const existing = groups.get(key);
    if (existing) {
      existing.services.push(service);
      continue;
    }
    groups.set(key, { key, globalMetaId, address, services: [service] });
  }
  return [...groups.values()];
};

const toLastSeenSec = (entry: IdchatOnlineStatusEntry | undefined): number | null => {
  if (!entry || !entry.isOnline || !Number.isFinite(entry.lastSeenAt) || entry.lastSeenAt <= 0) return null;
  return Math.floor(entry.lastSeenAt / 1000);
};

const shouldUseP2PPresence = (presence: LocalPresenceSnapshot): boolean => {
  if (!presence.healthy) return false;
  const peerCount = Number.isFinite(presence.peerCount) ? Math.max(0, Math.trunc(presence.peerCount)) : 0;
  return peerCount > 0 || Object.keys(presence.onlineBots || {}).length > 0;
};

const p2pCheckAtSec = (presence: LocalPresenceSnapshot, fallbackNowSec: number): number => {
  return typeof presence.nowSec === 'number' && Number.isFinite(presence.nowSec)
    ? presence.nowSec
    : fallbackNowSec;
};

const uniqueGlobalMetaIds = (groups: ProviderGroup[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const group of groups) {
    if (!group.globalMetaId || seen.has(group.globalMetaId)) continue;
    seen.add(group.globalMetaId);
    result.push(group.globalMetaId);
  }
  return result;
};

export class ProviderDiscoveryService {
  private readonly deps: ProviderDiscoveryServiceDeps;
  private readonly listeners: Set<DiscoveryListener> = new Set();
  private readonly forcedOfflineGlobalMetaIds: Set<string> = new Set();
  private snapshot: DiscoverySnapshot = cloneDiscoverySnapshot(EMPTY_SNAPSHOT);
  private snapshotSignature = serializeSnapshot(EMPTY_SNAPSHOT);
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private getServices: (() => any[]) | null = null;
  private refreshPromise: Promise<void> | null = null;
  private pendingRefresh = false;
  private pendingRefreshOptions: ResolvedRefreshOptions = normalizeRefreshOptions({ rebroadcast: false });

  constructor(deps: ProviderDiscoveryServiceDeps) {
    this.deps = deps;
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
    void this.refreshNow().catch((error) => {
      console.warn('[ProviderDiscovery] initial refresh failed:', error);
    });
    this.intervalId = setInterval(() => {
      void this.refreshNow().catch((error) => {
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
  }

  markOffline(globalMetaId: string): void {
    this.forceOffline(globalMetaId, 'manually_marked_offline');
  }

  forceOffline(globalMetaId: string, reason = 'locally_disabled'): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.add(normalizedGlobalMetaId);
    this.applyOfflineMutation(normalizedGlobalMetaId, reason);
  }

  clearForceOffline(globalMetaId: string): void {
    const normalizedGlobalMetaId = normalizeComparableGlobalMetaId(globalMetaId);
    if (!normalizedGlobalMetaId) return;
    this.forcedOfflineGlobalMetaIds.delete(normalizedGlobalMetaId);
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
        this.pendingRefreshOptions = normalizeRefreshOptions({ rebroadcast: false });
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
    this.listeners.clear();
  }

  private async performRefresh(options: ResolvedRefreshOptions): Promise<void> {
    const services = this.getServices ? this.getServices() : [];
    const groups = buildProviderGroups(services);
    const ids = uniqueGlobalMetaIds(groups);
    let statusByGlobalMetaId = new Map<string, IdchatOnlineStatusEntry>();

    if (ids.length > 0) {
      try {
        const status = await this.deps.presence.fetchOnlineStatus(ids);
        statusByGlobalMetaId = new Map(
          status.list.map((entry) => [normalizeComparableGlobalMetaId(entry.globalMetaId), entry]),
        );
        this.applySnapshot(
          this.buildIdchatSnapshot(groups, statusByGlobalMetaId),
          options.rebroadcast,
        );
        return;
      } catch (error) {
        console.warn('[ProviderDiscovery] idchat online-status fetch failed:', error);
      }
    }

    if (this.deps.fetchP2PPresence) {
      try {
        const p2pPresence = await this.deps.fetchP2PPresence();
        if (shouldUseP2PPresence(p2pPresence)) {
          this.applySnapshot(
            this.buildP2PSnapshot(groups, p2pPresence),
            options.rebroadcast,
          );
          return;
        }
      } catch (error) {
        console.warn('[ProviderDiscovery] P2P presence fallback failed:', error);
      }
    }

    this.applySnapshot(
      this.buildIdchatSnapshot(groups, statusByGlobalMetaId, ids.length > 0 ? 'online_status_failed' : null),
      options.rebroadcast,
    );
  }

  private buildIdchatSnapshot(
    groups: ProviderGroup[],
    statusByGlobalMetaId: Map<string, IdchatOnlineStatusEntry>,
    refreshError: string | null = null,
  ): DiscoverySnapshot {
    const onlineBots: Record<string, number> = {};
    const availableServices: any[] = [];
    const providers: Record<string, DiscoveryProviderState> = {};
    const lastCheckAt = this.nowSec();

    for (const group of groups) {
      const forcedOffline = Boolean(group.globalMetaId) && this.forcedOfflineGlobalMetaIds.has(group.globalMetaId);
      const status = group.globalMetaId ? statusByGlobalMetaId.get(group.globalMetaId) : undefined;
      const lastSeenSec = toLastSeenSec(status);
      const online = Boolean(group.globalMetaId && status?.isOnline && !forcedOffline && !refreshError);
      const lastError = !group.globalMetaId
        ? 'missing_global_metaid'
        : forcedOffline
          ? 'locally_disabled'
          : refreshError;

      providers[group.key] = {
        key: group.key,
        globalMetaId: group.globalMetaId,
        address: group.address,
        lastSeenSec,
        lastCheckAt,
        lastSource: 'idchat',
        lastError,
        online,
        optimisticLocal: false,
      };

      if (online) {
        onlineBots[group.globalMetaId] = lastSeenSec ?? lastCheckAt;
        availableServices.push(...group.services);
      }
    }

    return { onlineBots, availableServices, providers };
  }

  private buildP2PSnapshot(groups: ProviderGroup[], presence: LocalPresenceSnapshot): DiscoverySnapshot {
    const onlineBots: Record<string, number> = {};
    const availableServices: any[] = [];
    const providers: Record<string, DiscoveryProviderState> = {};
    const lastCheckAt = p2pCheckAtSec(presence, this.nowSec());

    for (const group of groups) {
      const forcedOffline = Boolean(group.globalMetaId) && this.forcedOfflineGlobalMetaIds.has(group.globalMetaId);
      const state = !forcedOffline && group.globalMetaId ? presence.onlineBots[group.globalMetaId] : undefined;
      const online = Boolean(state);

      providers[group.key] = {
        key: group.key,
        globalMetaId: group.globalMetaId,
        address: group.address,
        lastSeenSec: state?.lastSeenSec ?? null,
        lastCheckAt,
        lastSource: 'p2p_presence',
        lastError: !group.globalMetaId ? 'missing_global_metaid' : forcedOffline ? 'locally_disabled' : null,
        online,
        optimisticLocal: false,
      };

      if (online) {
        onlineBots[group.globalMetaId] = state!.lastSeenSec;
        availableServices.push(...group.services);
      }
    }

    return { onlineBots, availableServices, providers };
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
    if (!changed && !forceEmit) return;
    for (const listener of this.listeners) {
      try {
        listener(this.getDiscoverySnapshot());
      } catch (error) {
        console.warn('[ProviderDiscovery] change listener failed:', error);
      }
    }
  }

  private applyOfflineMutation(globalMetaId: string, reason: string): void {
    const nextSnapshot = this.getDiscoverySnapshot();
    delete nextSnapshot.onlineBots[globalMetaId];
    nextSnapshot.availableServices = nextSnapshot.availableServices.filter(
      (service) => resolveServiceGlobalMetaId(service) !== globalMetaId,
    );
    for (const state of Object.values(nextSnapshot.providers)) {
      if (state.globalMetaId !== globalMetaId) continue;
      state.online = false;
      state.lastError = reason;
      state.optimisticLocal = false;
    }
    this.applySnapshot(nextSnapshot, false);
  }
}
