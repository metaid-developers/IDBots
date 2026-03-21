import fs from 'fs';
import path from 'path';
import type { SqliteStore } from '../sqliteStore';

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
}

export const DEFAULT_P2P_CONFIG: P2PConfig = {
  p2p_sync_mode: 'self',
  p2p_bootstrap_nodes: [],
  p2p_enable_relay: true,
  p2p_storage_limit_gb: 10,
  p2p_enable_chain_source: false,
  p2p_own_addresses: [],
};

type OwnAddressSource = {
  mvc_address?: string | null;
  btc_address?: string | null;
  doge_address?: string | null;
};

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

export function buildRuntimeConfig(config: P2PConfig, ownAddresses: string[]): P2PConfig {
  const merged = [...(config.p2p_own_addresses || []), ...ownAddresses]
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    ...config,
    p2p_own_addresses: Array.from(new Set(merged)),
  };
}

export function getConfig(store: SqliteStore): P2PConfig {
  const stored = store.getP2PConfig();
  return { ...DEFAULT_P2P_CONFIG, ...(stored as Partial<P2PConfig> | undefined) };
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
    const res = await fetch('http://localhost:7281/api/config/reload', {
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
