import path from 'node:path';
import type {
  HeartbeatDiscoverySnapshot,
  HeartbeatProviderState,
} from './heartbeatPollingService';
import type { LocalPresenceSnapshot } from './p2pPresenceClient';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { resolveMetabotDistModulePath } from '../libs/runtimePaths';

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
  return loadSharedServiceDirectoryModule().normalizeComparableGlobalMetaId(value);
};

const resolveServiceGlobalMetaId = (service: any): string => {
  return loadSharedServiceDirectoryModule().resolveServiceGlobalMetaId(service);
};

const resolveServiceProviderAddress = (service: any): string => {
  return toSafeString(service?.providerAddress || service?.createAddress || service?.address);
};

const buildProviderKey = (globalMetaId: string, address: string): string => {
  return `${globalMetaId}::${address}`;
};

interface SharedServiceDirectoryModule {
  normalizeComparableGlobalMetaId(value: unknown): string;
  resolveServiceGlobalMetaId(service: any): string;
  cloneDiscoverySnapshot(snapshot: DiscoverySnapshot): DiscoverySnapshot;
  serializeDiscoverySnapshot(snapshot: DiscoverySnapshot): string;
  buildPresenceSnapshot(
    services: any[],
    presence: LocalPresenceSnapshot,
    fallbackNowSec: number,
    forcedOfflineGlobalMetaIds: ReadonlySet<string>
  ): DiscoverySnapshot;
}

let cachedSharedServiceDirectoryModule: SharedServiceDirectoryModule | null = null;

const loadSharedServiceDirectoryModule = (): SharedServiceDirectoryModule => {
  if (cachedSharedServiceDirectoryModule) {
    return cachedSharedServiceDirectoryModule;
  }
  const modulePath = resolveMetabotDistModulePath('core/discovery/serviceDirectory.js', { startDir: __dirname });
  cachedSharedServiceDirectoryModule = require(modulePath) as SharedServiceDirectoryModule;
  return cachedSharedServiceDirectoryModule;
};

const cloneDiscoverySnapshot = (snapshot: DiscoverySnapshot): DiscoverySnapshot => {
  return loadSharedServiceDirectoryModule().cloneDiscoverySnapshot(snapshot);
};

const serializeSnapshot = (snapshot: DiscoverySnapshot): string => {
  return loadSharedServiceDirectoryModule().serializeDiscoverySnapshot(snapshot);
};

const buildPresenceSnapshot = (
  services: any[],
  presence: LocalPresenceSnapshot,
  fallbackNowSec: number,
  forcedOfflineGlobalMetaIds: ReadonlySet<string>
): DiscoverySnapshot => {
  return loadSharedServiceDirectoryModule().buildPresenceSnapshot(
    services,
    presence,
    fallbackNowSec,
    forcedOfflineGlobalMetaIds
  );
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
