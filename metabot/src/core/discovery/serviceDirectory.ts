import { normalizeGlobalMetaId } from '../identity/deriveIdentity';

export interface PresenceProviderState {
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

export interface ServiceDirectorySnapshot {
  onlineBots: Record<string, number>;
  availableServices: any[];
  providers: Record<string, PresenceProviderState>;
}

export interface LocalPresenceState {
  lastSeenSec: number;
  expiresAtSec?: number | null;
  peerIds?: string[] | null;
}

export interface LocalPresenceSnapshot {
  healthy: boolean;
  peerCount: number;
  onlineBots: Record<string, LocalPresenceState>;
  unhealthyReason: string | null;
  lastConfigReloadError: string | null;
  nowSec: number | null;
}

export interface ProviderGroup {
  key: string;
  globalMetaId: string;
  address: string;
  services: any[];
}

const toSafeString = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (value == null) return '';
  return String(value).trim();
};

export const normalizeComparableGlobalMetaId = (value: unknown): string => {
  return normalizeGlobalMetaId(value) ?? toSafeString(value);
};

export const resolveServiceGlobalMetaId = (service: any): string => {
  return normalizeComparableGlobalMetaId(service?.providerGlobalMetaId || service?.globalMetaId);
};

export const resolveServiceProviderAddress = (service: any): string => {
  return toSafeString(service?.providerAddress || service?.createAddress || service?.address);
};

export const buildProviderKey = (globalMetaId: string, address: string): string => {
  return `${globalMetaId}::${address}`;
};

export const cloneProviderState = (state: PresenceProviderState): PresenceProviderState => ({ ...state });

export const cloneDiscoverySnapshot = (snapshot: ServiceDirectorySnapshot): ServiceDirectorySnapshot => ({
  onlineBots: { ...snapshot.onlineBots },
  availableServices: snapshot.availableServices.map((service) => ({ ...service })),
  providers: Object.fromEntries(
    Object.entries(snapshot.providers).map(([key, state]) => [key, cloneProviderState(state)])
  )
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
      .map(([key, nestedValue]) => [key, normalizeForComparison(nestedValue)])
  );
};

export const serializeDiscoverySnapshot = (snapshot: ServiceDirectorySnapshot): string => {
  return JSON.stringify(normalizeForComparison(snapshot));
};

const resolvePresenceCheckAtSec = (
  presence: LocalPresenceSnapshot,
  fallbackNowSec: number
): number => {
  return typeof presence.nowSec === 'number' && Number.isFinite(presence.nowSec)
    ? presence.nowSec
    : fallbackNowSec;
};

export const buildProviderGroups = (services: any[]): ProviderGroup[] => {
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
      services: [service]
    });
  }

  return [...groups.values()];
};

export const buildPresenceSnapshot = (
  services: any[],
  presence: LocalPresenceSnapshot,
  fallbackNowSec: number,
  forcedOfflineGlobalMetaIds: ReadonlySet<string>
): ServiceDirectorySnapshot => {
  const onlineBots = Object.fromEntries(
    Object.entries(presence.onlineBots)
      .filter(([globalMetaId]) => !forcedOfflineGlobalMetaIds.has(globalMetaId))
      .map(([globalMetaId, state]) => [globalMetaId, state.lastSeenSec])
  );
  const availableServices: any[] = [];
  const providers: Record<string, PresenceProviderState> = {};
  const lastCheckAt = resolvePresenceCheckAtSec(presence, fallbackNowSec);

  for (const group of buildProviderGroups(services)) {
    const forcedOffline = Boolean(group.globalMetaId) && forcedOfflineGlobalMetaIds.has(group.globalMetaId);
    const presenceState = !forcedOffline && group.globalMetaId ? presence.onlineBots[group.globalMetaId] : undefined;
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
      optimisticLocal: false
    };

    if (online) {
      availableServices.push(...group.services);
    }
  }

  return {
    onlineBots,
    availableServices,
    providers
  };
};
