/**
 * BTC network API: fetch UTXOs, balance, raw tx, and broadcast.
 * Uses Metalet first, then falls back to mempool.space when the public BTC
 * provider is slow or returning transient backend errors.
 */

const METALET_HOST = 'https://www.metalet.space';
const MEMPOOL_HOST = 'https://mempool.space';
const NET = 'livenet';
const DEFAULT_METALET_TIMEOUT_MS = 1_500;

export interface BtcUTXO {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  rawTx?: string;
  confirmed?: boolean;
}

export interface BtcBalanceSnapshot {
  totalSatoshis: number;
  confirmedSatoshis: number;
  unconfirmedSatoshis: number;
}

interface BtcApiOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  preferMempool?: boolean;
}

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[btc-api] ${msg}\n`);
  } catch { /* noop */ }
}

function getErrorMessage(error: unknown): string {
  if (error != null && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error ?? '');
}

function isRetryableBtcProviderError(error: unknown): boolean {
  const normalized = getErrorMessage(error).toLowerCase();
  return (
    normalized.includes('higun request error')
    || normalized.includes('rpc error')
    || normalized.includes('timeout')
    || normalized.includes('timed out')
    || normalized.includes('fetch failed')
    || normalized.includes('failed to fetch')
    || normalized.includes('network error')
    || normalized.includes('networkerror')
  );
}

function resolveTimeoutMs(timeoutMs?: number): number {
  return Number.isFinite(timeoutMs) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_METALET_TIMEOUT_MS;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  options: Pick<BtcApiOptions, 'timeoutMs' | 'fetchImpl'> = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs = resolveTimeoutMs(options.timeoutMs);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`request timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function metaletV3Get<T>(
  path: string,
  params: Record<string, string>,
  options: Pick<BtcApiOptions, 'timeoutMs' | 'fetchImpl'> = {},
): Promise<T> {
  const search = new URLSearchParams({ ...params, net: NET });
  const url = `${METALET_HOST}/wallet-api/v3${path}?${search}`;
  const res = await fetchWithTimeout(url, {}, options);
  const json = (await res.json()) as { code?: number; message?: string; data?: T };
  if (json?.code !== 0 && json?.code != null) {
    throw new Error(json?.message || 'Metalet API error');
  }
  return (json?.data ?? json) as T;
}

async function metaletV3Post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const url = `${METALET_HOST}/wallet-api/v3${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, net: NET }),
  });
  const text = await res.text();
  debugLog(`broadcast response status=${res.status} body=${text.slice(0, 500)}`);
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Broadcast response not JSON: ${text.slice(0, 200)}`);
  }
  if (json?.code !== 0 && json?.code != null) {
    throw new Error(json?.message || `Broadcast failed (code=${json?.code})`);
  }
  return (json?.data ?? json) as T;
}

async function mempoolGetJson<T>(path: string, fetchImpl: typeof fetch = fetch): Promise<T> {
  const url = `${MEMPOOL_HOST}/api${path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`mempool request failed (${res.status})`);
  }
  return await res.json() as T;
}

async function mempoolGetText(path: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const url = `${MEMPOOL_HOST}/api${path}`;
  const res = await fetchImpl(url);
  if (!res.ok) {
    throw new Error(`mempool request failed (${res.status})`);
  }
  return await res.text();
}

function normalizeBtcUtxos(
  list: Array<{
    txId?: string;
    txid?: string;
    outputIndex?: number;
    vout?: number;
    satoshis?: number;
    value?: number;
    address?: string;
    confirmed?: boolean;
    status?: { confirmed?: boolean };
  }>,
  address: string,
): BtcUTXO[] {
  const all = (Array.isArray(list) ? list : [])
    .map((utxo) => ({
      txId: String(utxo.txId || utxo.txid || '').trim(),
      outputIndex: Number.isInteger(utxo.outputIndex) ? Number(utxo.outputIndex) : Number(utxo.vout),
      satoshis: Number(utxo.satoshis ?? utxo.value ?? 0),
      address: utxo.address || address,
      confirmed: typeof utxo.confirmed === 'boolean'
        ? utxo.confirmed
        : typeof utxo.status?.confirmed === 'boolean'
          ? utxo.status.confirmed
          : undefined,
    }))
    .filter((utxo) => /^[0-9a-f]{64}$/i.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis >= 600);

  const confirmed = all.filter((utxo) => utxo.confirmed !== false);
  return confirmed.length > 0 ? confirmed : all;
}

export async function fetchBtcBalance(
  address: string,
  options: Pick<BtcApiOptions, 'timeoutMs' | 'fetchImpl'> = {},
): Promise<BtcBalanceSnapshot> {
  try {
    const data = await metaletV3Get<{
      balance?: number;
      safeBalance?: number;
      pendingBalance?: number;
    }>('/address/btc-balance', { address }, options);
    return {
      totalSatoshis: Math.max(0, Math.round(Number(data?.balance || 0) * 1e8)),
      confirmedSatoshis: Math.max(0, Math.round(Number(data?.safeBalance ?? data?.balance ?? 0) * 1e8)),
      unconfirmedSatoshis: Math.round(Number(data?.pendingBalance || 0) * 1e8),
    };
  } catch (error) {
    if (!isRetryableBtcProviderError(error)) {
      throw error;
    }
    debugLog(`falling back to mempool balance for ${address}: ${getErrorMessage(error)}`);
    const utxos = await mempoolGetJson<Array<{
      value: number;
      status?: { confirmed?: boolean };
    }>>(`/address/${address}/utxo`, options.fetchImpl ?? fetch);
    const confirmedSatoshis = (Array.isArray(utxos) ? utxos : [])
      .filter((utxo) => utxo?.status?.confirmed !== false)
      .reduce((sum, utxo) => sum + Number(utxo?.value || 0), 0);
    const unconfirmedSatoshis = (Array.isArray(utxos) ? utxos : [])
      .filter((utxo) => utxo?.status?.confirmed === false)
      .reduce((sum, utxo) => sum + Number(utxo?.value || 0), 0);
    return {
      totalSatoshis: Math.max(0, confirmedSatoshis + unconfirmedSatoshis),
      confirmedSatoshis,
      unconfirmedSatoshis,
    };
  }
}

export async function fetchBtcUtxos(
  address: string,
  needRawTx = false,
  options: BtcApiOptions = {},
): Promise<BtcUTXO[]> {
  let filtered: BtcUTXO[];
  let preferMempool = Boolean(options.preferMempool);

  if (preferMempool) {
    const list = await mempoolGetJson<Array<{
      txid: string;
      vout: number;
      value: number;
      status?: { confirmed?: boolean };
    }>>(`/address/${address}/utxo`, options.fetchImpl ?? fetch);
    filtered = normalizeBtcUtxos(list, address);
  } else {
    try {
      const list = await metaletV3Get<Array<{
        txId: string;
        outputIndex: number;
        satoshis: number;
        address?: string;
        confirmed?: boolean;
      }>>('/address/btc-utxo', { address, unconfirmed: '1' }, options);
      filtered = normalizeBtcUtxos(list, address);
    } catch (error) {
      if (!isRetryableBtcProviderError(error)) {
        throw error;
      }
      preferMempool = true;
      debugLog(`falling back to mempool utxos for ${address}: ${getErrorMessage(error)}`);
      const list = await mempoolGetJson<Array<{
        txid: string;
        vout: number;
        value: number;
        status?: { confirmed?: boolean };
      }>>(`/address/${address}/utxo`, options.fetchImpl ?? fetch);
      filtered = normalizeBtcUtxos(list, address);
    }
  }

  if (needRawTx) {
    for (const utxo of filtered) {
      utxo.rawTx = await fetchBtcTxHex(utxo.txId, {
        ...options,
        preferMempool,
      });
    }
  }

  return filtered;
}

export async function fetchBtcTxHex(
  txId: string,
  options: BtcApiOptions = {},
): Promise<string> {
  if (!options.preferMempool) {
    try {
      const res = await metaletV3Get<{ rawTx?: string; hex?: string }>(
        '/tx/raw',
        {
          txId,
          chain: 'btc',
        },
        options,
      );
      return res?.rawTx ?? res?.hex ?? '';
    } catch (error) {
      if (!isRetryableBtcProviderError(error)) {
        throw error;
      }
      debugLog(`falling back to mempool raw tx for ${txId}: ${getErrorMessage(error)}`);
    }
  }

  return await mempoolGetText(`/tx/${txId}/hex`, options.fetchImpl ?? fetch);
}

export async function broadcastBtcTx(rawTx: string): Promise<string> {
  const txId = await metaletV3Post<string>('/tx/broadcast', {
    chain: 'btc',
    rawTx,
  });
  if (!txId || typeof txId !== 'string') {
    throw new Error(`BTC broadcast returned invalid txId: ${JSON.stringify(txId)}`);
  }
  debugLog(`broadcast txId=${txId}`);
  return txId;
}
