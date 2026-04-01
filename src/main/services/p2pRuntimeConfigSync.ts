import type { SqliteStore } from '../sqliteStore';
import {
  buildRuntimeConfig,
  collectOwnAddresses,
  getConfig,
  reloadConfig,
  writeConfigFile,
  type P2PConfig,
  type RuntimeConfigMetabotSource,
} from './p2pConfigService';

export interface SyncP2PRuntimeConfigParams {
  store: SqliteStore;
  metabots: RuntimeConfigMetabotSource[];
  configPath: string;
}

export interface SyncP2PRuntimeConfigResult {
  reloadOk: boolean;
  runtimeConfig: P2PConfig;
}

export async function syncP2PRuntimeConfig(
  params: SyncP2PRuntimeConfigParams,
): Promise<SyncP2PRuntimeConfigResult> {
  const config = getConfig(params.store);
  const ownAddresses = collectOwnAddresses(params.metabots);
  const runtimeConfig = buildRuntimeConfig(config, ownAddresses, params.metabots);

  writeConfigFile(runtimeConfig, params.configPath);

  let reloadOk = false;
  try {
    reloadOk = await reloadConfig();
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    console.log(`[p2p-config] reload failed: ${reason}`);
    reloadOk = false;
  }

  return { reloadOk, runtimeConfig };
}
