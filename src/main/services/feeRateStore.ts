/**
 * Global fee rate store (main process singleton).
 * - Loads tiers from Metalet API on init, falls back to defaults.
 * - Persists user-selected tier per chain in SQLite via kvStore.
 * - Exposes getRate(chain) for any main-process module (RPC server, createPin worker, etc.).
 * - IPC channels: feeRates:getTiers, feeRates:getSelected, feeRates:select, feeRates:refresh.
 */

import { ipcMain } from 'electron';

type ChainKey = 'btc' | 'mvc' | 'doge';
interface FeeRateTier { title: string; desc: string; feeRate: number; }

const FEE_APIS: Record<ChainKey, string> = {
  btc: 'https://www.metalet.space/wallet-api/v3/btc/fee/summary?net=livenet',
  mvc: 'https://www.metalet.space/wallet-api/v4/mvc/fee/summary?net=livenet',
  doge: 'https://www.metalet.space/wallet-api/v4/doge/fee/summary?net=livenet',
};

const DEFAULT_TIERS: Record<ChainKey, FeeRateTier[]> = {
  btc: [
    { title: 'Fast', desc: 'About 10 minutes', feeRate: 2 },
    { title: 'Avg', desc: 'About 30 minutes', feeRate: 2 },
    { title: 'Slow', desc: 'About 1 hours', feeRate: 2 },
  ],
  mvc: [
    { title: 'Fast', desc: 'About 10 minutes', feeRate: 1 },
    { title: 'Avg', desc: 'About 30 minutes', feeRate: 1 },
    { title: 'Slow', desc: 'About 1 hours', feeRate: 1 },
  ],
  doge: [
    { title: 'Fast', desc: 'About 10 minutes', feeRate: 7500000 },
    { title: 'Avg', desc: 'About 30 minutes', feeRate: 5000000 },
    { title: 'Slow', desc: 'About 1 hours', feeRate: 5000000 },
  ],
};

const STORAGE_KEY = 'fee_rate_selection';

let tiers: Record<ChainKey, FeeRateTier[]> = { ...DEFAULT_TIERS };
let selectedTier: Record<ChainKey, string> = { btc: 'Fast', mvc: 'Fast', doge: 'Fast' };
let kvStoreRef: { get(key: string): unknown; set(key: string, value: unknown): void } | null = null;

function persistSelection(): void {
  try {
    kvStoreRef?.set(STORAGE_KEY, JSON.stringify(selectedTier));
  } catch { /* ignore */ }
}

function loadSelection(): void {
  try {
    const raw = kvStoreRef?.get(STORAGE_KEY);
    if (raw && typeof raw === 'string') {
      const parsed = JSON.parse(raw) as Record<string, string>;
      for (const chain of ['btc', 'mvc', 'doge'] as ChainKey[]) {
        if (typeof parsed[chain] === 'string') {
          selectedTier[chain] = parsed[chain];
        }
      }
    }
  } catch { /* ignore */ }
}

async function fetchTiersFromApi(): Promise<void> {
  await Promise.all(
    (Object.entries(FEE_APIS) as [ChainKey, string][]).map(async ([chain, url]) => {
      try {
        const res = await fetch(url);
        const json = await res.json() as { code?: number; data?: { list?: FeeRateTier[] } };
        if (json?.code === 0 && Array.isArray(json.data?.list) && json.data!.list.length > 0) {
          tiers[chain] = json.data!.list;
        }
      } catch { /* keep defaults */ }
    })
  );
}

/** Get the fee rate value for a chain based on user's selected tier. */
export function getRate(chain: string): number {
  const c = chain.toLowerCase() as ChainKey;
  const tierName = selectedTier[c] ?? 'Fast';
  const list = tiers[c] ?? DEFAULT_TIERS[c] ?? [];
  const found = list.find((t) => t.title === tierName);
  if (found) return found.feeRate;
  const fast = list.find((t) => t.title === 'Fast');
  return fast?.feeRate ?? list[0]?.feeRate ?? 1;
}

/** Get all tiers for all chains. */
export function getAllTiers(): Record<string, FeeRateTier[]> {
  return { ...tiers };
}

/** Get the selected tier names for all chains. */
export function getSelectedTiers(): Record<string, string> {
  return { ...selectedTier };
}

/** Select a tier for a chain and persist immediately. */
export function selectTier(chain: string, tierTitle: string): void {
  const c = chain.toLowerCase() as ChainKey;
  if (c !== 'btc' && c !== 'mvc' && c !== 'doge') return;
  selectedTier[c] = tierTitle;
  persistSelection();
}

/** Initialize: load from DB, fetch from API, register IPC handlers. */
export async function initFeeRateStore(
  kvStore: { get(key: string): unknown; set(key: string, value: unknown): void }
): Promise<void> {
  kvStoreRef = kvStore;
  loadSelection();
  await fetchTiersFromApi();

  ipcMain.handle('feeRates:getTiers', () => getAllTiers());
  ipcMain.handle('feeRates:getSelected', () => getSelectedTiers());
  ipcMain.handle('feeRates:select', (_e, chain: string, tierTitle: string) => {
    selectTier(chain, tierTitle);
    return { success: true };
  });
  ipcMain.handle('feeRates:refresh', async () => {
    await fetchTiersFromApi();
    return getAllTiers();
  });
}
