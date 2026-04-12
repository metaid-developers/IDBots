import fs from 'fs';
import path from 'path';
import type { SqliteStore } from '../sqliteStore';
import { normalizeRawGlobalMetaId } from '../shared/globalMetaId';
import { getP2PLocalBase } from './p2pLocalEndpoint';

export interface P2PConfig {
  p2p_sync_mode: 'self' | 'selective' | 'full';
  p2p_selective_addresses?: string[];
  p2p_selective_paths?: string[];
  p2p_block_addresses?: string[];
  p2p_block_paths?: string[];
  p2p_max_content_size_kb?: number;
  p2p_bootstrap_nodes: string[];
  p2p_enable_relay: boolean;
  p2p_storage_limit_gb: number;
  p2p_enable_chain_source: boolean;
  p2p_own_addresses: string[];
  p2p_presence_global_metaids?: string[];
}

export const LEGACY_OFFICIAL_P2P_BOOTSTRAP_NODES = [
  '/ip4/8.217.14.206/tcp/4001/p2p/12D3KooWSvVfJ7s37hsCfRHuhccWxocxyjU6uKGKF4czBGZk8f5H',
  '/dns4/manapi.metaid.io/tcp/4001/p2p/12D3KooWSvVfJ7s37hsCfRHuhccWxocxyjU6uKGKF4czBGZk8f5H',
] as const;

export const OFFICIAL_P2P_BOOTSTRAP_NODES = [
  ...LEGACY_OFFICIAL_P2P_BOOTSTRAP_NODES,
  '/ip4/8.129.223.128/tcp/4001/p2p/12D3KooWBTHrWigtJyPGVvAu5uTU7BEJocPHHX5D5buuFuaQdrxw',
] as const;

export const LEGACY_P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY = 'p2p.bootstrap_defaults_migrated.v1';
export const P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY = 'p2p.bootstrap_defaults_migrated.v2';

export const DEFAULT_P2P_CONFIG: P2PConfig = {
  p2p_sync_mode: 'self',
  p2p_bootstrap_nodes: [...OFFICIAL_P2P_BOOTSTRAP_NODES],
  p2p_enable_relay: true,
  p2p_storage_limit_gb: 10,
  p2p_enable_chain_source: false,
  p2p_own_addresses: [],
  p2p_presence_global_metaids: [],
};

type OwnAddressSource = {
  mvc_address?: string | null;
  btc_address?: string | null;
  doge_address?: string | null;
};

type PresenceGlobalMetaIdSource = {
  heartbeat_enabled?: unknown;
  globalmetaid?: string | null;
  globalMetaId?: string | null;
};

export type RuntimeConfigMetabotSource = OwnAddressSource & PresenceGlobalMetaIdSource;

export function collectOwnAddresses(metabots: OwnAddressSource[]): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const metabot of metabots) {
    for (const value of [metabot.mvc_address, metabot.btc_address, metabot.doge_address]) {
      const normalized = typeof value === 'string' ? value.trim() : '';
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      collected.push(normalized);
    }
  }

  return collected;
}

function normalizePresenceGlobalMetaId(value: unknown): string | null {
  return normalizeRawGlobalMetaId(value);
}

function isHeartbeatEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== 'string') return false;
  return value.trim() === '1';
}

export function collectPresenceGlobalMetaIds(metabots: PresenceGlobalMetaIdSource[]): string[] {
  const seen = new Set<string>();
  const collected: string[] = [];

  for (const metabot of metabots) {
    if (!isHeartbeatEnabled(metabot?.heartbeat_enabled)) continue;

    const normalized = normalizePresenceGlobalMetaId(metabot.globalmetaid ?? metabot.globalMetaId);
    if (!normalized || seen.has(normalized)) continue;

    seen.add(normalized);
    collected.push(normalized);
  }

  return collected;
}

export function buildRuntimeConfig(
  config: P2PConfig,
  ownAddresses: string[],
  metabots?: PresenceGlobalMetaIdSource[],
): P2PConfig {
  const merged = [...(config.p2p_own_addresses || []), ...ownAddresses]
    .map((value) => value.trim())
    .filter(Boolean);

  const runtimeConfig: P2PConfig = {
    ...config,
    p2p_own_addresses: Array.from(new Set(merged)),
  };

  if (Array.isArray(metabots)) {
    runtimeConfig.p2p_presence_global_metaids = collectPresenceGlobalMetaIds(metabots);
  }

  return runtimeConfig;
}

function normalizeStoredConfig(raw: unknown): Partial<P2PConfig> | undefined {
  if (!raw) return undefined;

  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed as Partial<P2PConfig> : undefined;
    } catch {
      return undefined;
    }
  }

  return raw && typeof raw === 'object' ? raw as Partial<P2PConfig> : undefined;
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const item of value) {
    if (typeof item !== 'string') continue;

    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function normalizeOptionalStringList(value: unknown): string[] | undefined {
  if (typeof value === 'undefined') return undefined;
  return normalizeStringList(value);
}

function applyListNormalization(config: P2PConfig): P2PConfig {
  return {
    ...config,
    p2p_bootstrap_nodes: normalizeStringList(config.p2p_bootstrap_nodes),
    p2p_own_addresses: normalizeStringList(config.p2p_own_addresses),
    p2p_presence_global_metaids: normalizeStringList(config.p2p_presence_global_metaids),
    p2p_selective_addresses: normalizeOptionalStringList(config.p2p_selective_addresses),
    p2p_selective_paths: normalizeOptionalStringList(config.p2p_selective_paths),
    p2p_block_addresses: normalizeOptionalStringList(config.p2p_block_addresses),
    p2p_block_paths: normalizeOptionalStringList(config.p2p_block_paths),
  };
}

function hasBootstrapDefaultsMigration(store: SqliteStore): boolean {
  return store.get<boolean>(P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY) === true;
}

function markBootstrapDefaultsMigration(store: SqliteStore): void {
  store.set(LEGACY_P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY, true);
  store.set(P2P_BOOTSTRAP_DEFAULTS_MIGRATION_KEY, true);
}

function stringListsMatch(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;

  const expected = new Set(b);
  return a.every((value) => expected.has(value));
}

function shouldMigrateBootstrapDefaults(stored: Partial<P2PConfig> | undefined): boolean {
  if (!stored) return false;
  if (!Object.prototype.hasOwnProperty.call(stored, 'p2p_bootstrap_nodes')) return true;

  const nodes = normalizeStringList(stored.p2p_bootstrap_nodes);
  if (nodes.length === 0) return true;

  return stringListsMatch(nodes, LEGACY_OFFICIAL_P2P_BOOTSTRAP_NODES);
}

export function getConfig(store: SqliteStore): P2PConfig {
  const stored = normalizeStoredConfig(store.getP2PConfig())
    ?? normalizeStoredConfig(store.get('p2p_config'));
  const normalized = applyListNormalization({ ...DEFAULT_P2P_CONFIG, ...(stored ?? {}) });

  if (!hasBootstrapDefaultsMigration(store) && shouldMigrateBootstrapDefaults(stored)) {
    const migrated = {
      ...normalized,
      p2p_bootstrap_nodes: [...OFFICIAL_P2P_BOOTSTRAP_NODES],
    };
    store.setP2PConfig(migrated as unknown as Record<string, unknown>);
    markBootstrapDefaultsMigration(store);
    return migrated;
  }

  return normalized;
}

export function setConfig(store: SqliteStore, config: Partial<P2PConfig>): P2PConfig {
  const existing = getConfig(store);
  const updated = applyListNormalization({ ...existing, ...config });
  store.setP2PConfig(updated as unknown as Record<string, unknown>);
  markBootstrapDefaultsMigration(store);
  return updated;
}

export function writeConfigFile(config: P2PConfig, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

export async function reloadConfig(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${getP2PLocalBase()}/api/config/reload`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      console.log('[p2p-config] reload ok');
      return true;
    }
    console.log(`[p2p-config] reload failed: HTTP ${res.status}`);
    return false;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[p2p-config] reload failed: ${reason}`);
    return false;
  }
}
