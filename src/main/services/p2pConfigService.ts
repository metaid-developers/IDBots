import fs from 'fs';
import path from 'path';
import type { SqliteStore } from '../sqliteStore';
import { getP2PLocalBase } from './p2pLocalEndpoint';
import { validateGlobalMetaId } from './globalMetaid';

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

export const DEFAULT_P2P_CONFIG: P2PConfig = {
  p2p_sync_mode: 'self',
  p2p_bootstrap_nodes: [],
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
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('metaid:')) return null;
  if (!validateGlobalMetaId(normalized)) return null;
  return normalized;
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

export function getConfig(store: SqliteStore): P2PConfig {
  const stored = normalizeStoredConfig(store.getP2PConfig())
    ?? normalizeStoredConfig(store.get('p2p_config'));
  return { ...DEFAULT_P2P_CONFIG, ...(stored ?? {}) };
}

export function setConfig(store: SqliteStore, config: Partial<P2PConfig>): P2PConfig {
  const existing = getConfig(store);
  const updated: P2PConfig = { ...existing, ...config };
  store.setP2PConfig(updated as unknown as Record<string, unknown>);
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
