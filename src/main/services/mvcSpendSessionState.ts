export interface MvcCachedFundingUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

interface MvcPendingFundingCacheEntry extends MvcCachedFundingUtxo {
  createdAt: number;
}

interface MvcSpendSessionState {
  excludedOutpoints: Map<string, number>;
  pendingFundingUtxos: MvcPendingFundingCacheEntry[];
}

const MVC_SPEND_SESSION_TTL_MS = 30 * 60 * 1000;
const mvcSpendSessionState = new Map<number, MvcSpendSessionState>();

export function getMvcCachedFundingOutpointKey(
  utxo: Pick<MvcCachedFundingUtxo, 'txId' | 'outputIndex'>,
): string {
  return `${String(utxo.txId || '').trim().toLowerCase()}:${Number(utxo.outputIndex)}`;
}

function normalizeMvcOutpoint(value: unknown): string | null {
  const normalized = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{64}:\d+$/.test(normalized) ? normalized : null;
}

export function normalizeMvcCachedFundingUtxo(input: unknown): MvcCachedFundingUtxo | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const txId = String(record.txId || '').trim().toLowerCase();
  const outputIndex = Number(record.outputIndex);
  const satoshis = Number(record.satoshis);
  const address = String(record.address || '').trim();
  const height = Number(record.height ?? -1);
  if (!/^[0-9a-f]{64}$/.test(txId)) return null;
  if (!Number.isInteger(outputIndex) || outputIndex < 0) return null;
  if (!Number.isFinite(satoshis) || satoshis < 600) return null;
  if (!address) return null;
  return {
    txId,
    outputIndex,
    satoshis,
    address,
    height: Number.isFinite(height) ? height : -1,
  };
}

function getOrCreateMvcSpendSessionState(metabotId: number): MvcSpendSessionState {
  const existing = mvcSpendSessionState.get(metabotId);
  if (existing) return existing;
  const next: MvcSpendSessionState = {
    excludedOutpoints: new Map(),
    pendingFundingUtxos: [],
  };
  mvcSpendSessionState.set(metabotId, next);
  return next;
}

function pruneMvcSpendSessionState(metabotId: number): MvcSpendSessionState {
  const state = getOrCreateMvcSpendSessionState(metabotId);
  const cutoff = Date.now() - MVC_SPEND_SESSION_TTL_MS;
  for (const [outpoint, timestamp] of state.excludedOutpoints.entries()) {
    if (timestamp < cutoff) {
      state.excludedOutpoints.delete(outpoint);
    }
  }
  state.pendingFundingUtxos = state.pendingFundingUtxos.filter((entry) => entry.createdAt >= cutoff);
  if (state.excludedOutpoints.size === 0 && state.pendingFundingUtxos.length === 0) {
    mvcSpendSessionState.delete(metabotId);
    return {
      excludedOutpoints: new Map(),
      pendingFundingUtxos: [],
    };
  }
  return state;
}

export function getMvcSpendSessionSnapshot(metabotId: number): {
  excludeOutpoints: string[];
  preferredFundingUtxos: MvcCachedFundingUtxo[];
} {
  const state = pruneMvcSpendSessionState(metabotId);
  return {
    excludeOutpoints: Array.from(state.excludedOutpoints.keys()),
    preferredFundingUtxos: state.pendingFundingUtxos
      .filter((entry) => !state.excludedOutpoints.has(getMvcCachedFundingOutpointKey(entry)))
      .map(({ createdAt: _createdAt, ...utxo }) => ({ ...utxo })),
  };
}

export function recordMvcSpentOutpoints(metabotId: number, outpoints: unknown): void {
  if (!Array.isArray(outpoints) || outpoints.length === 0) return;
  const state = getOrCreateMvcSpendSessionState(metabotId);
  const now = Date.now();
  const normalizedOutpoints = new Set<string>();
  for (const value of outpoints) {
    const normalized = normalizeMvcOutpoint(value);
    if (normalized) {
      normalizedOutpoints.add(normalized);
      state.excludedOutpoints.set(normalized, now);
    }
  }
  if (normalizedOutpoints.size > 0 && state.pendingFundingUtxos.length > 0) {
    state.pendingFundingUtxos = state.pendingFundingUtxos.filter(
      (entry) => !normalizedOutpoints.has(getMvcCachedFundingOutpointKey(entry)),
    );
  }
  pruneMvcSpendSessionState(metabotId);
}

export function clearMvcExcludedOutpoints(metabotId: number): void {
  const state = getOrCreateMvcSpendSessionState(metabotId);
  state.excludedOutpoints.clear();
  pruneMvcSpendSessionState(metabotId);
}

export function replaceMvcPendingFundingUtxos(metabotId: number, utxo: unknown): void {
  const state = getOrCreateMvcSpendSessionState(metabotId);
  const normalized = normalizeMvcCachedFundingUtxo(utxo);
  if (!normalized) {
    state.pendingFundingUtxos = [];
    pruneMvcSpendSessionState(metabotId);
    return;
  }
  state.pendingFundingUtxos = [{
    ...normalized,
    createdAt: Date.now(),
  }];
}

export function resetMvcSpendSessionStateForTests(): void {
  mvcSpendSessionState.clear();
}
