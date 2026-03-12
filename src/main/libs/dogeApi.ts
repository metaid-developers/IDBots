/**
 * DOGE network API: fetch UTXOs, fee rates, broadcast. Used by createPinWorker when network is 'doge'.
 * Standalone fetch-based client for Metalet wallet-api v4 (no credential).
 */

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

export interface DogeUtxoApiItem {
  address: string;
  txid: string;
  outIndex: number;
  value: number;
  height: number;
  flag?: string;
}

export interface DogeUTXO {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  rawTx?: string;
  confirmed?: boolean;
  height?: number;
}

export interface DogeFeeRate {
  title: string;
  desc: string;
  feeRate: number;
}

async function metaletV4Get<T>(path: string, params: Record<string, string>): Promise<T> {
  const search = new URLSearchParams({ ...params, net: NET });
  const url = `${METALET_HOST}/wallet-api/v4${path}?${search}`;
  const res = await fetch(url);
  const json = (await res.json()) as { code?: number; message?: string; data?: T };
  if (json?.code !== 0 && json?.code != null) {
    throw new Error(json?.message || 'Metalet API error');
  }
  return (json?.data ?? json) as T;
}

async function metaletV4Post<T>(path: string, body: Record<string, string>): Promise<T> {
  const url = `${METALET_HOST}/wallet-api/v4${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, net: NET }),
  });
  const json = (await res.json()) as { code?: number; message?: string; data?: T };
  if (json?.code !== 0 && json?.code != null) {
    throw new Error(json?.message || 'Metalet API error');
  }
  return (json?.data ?? json) as T;
}

export async function fetchDogeFeeRates(): Promise<DogeFeeRate[]> {
  const data = await metaletV4Get<{ list: DogeFeeRate[] }>('/doge/fee/summary', {});
  return data?.list ?? [];
}

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[doge-api] ${msg}\n`);
  } catch {
    /* noop */
  }
}

/** Get the Fast tier fee rate (sat/KB) with 50% markup for reliable confirmation. */
export async function fetchDogeFeeRateFast(): Promise<number> {
  const list = await fetchDogeFeeRates();
  debugLog(`fee/summary list: ${JSON.stringify(list.map((r) => ({ title: r.title, feeRate: r.feeRate })))}`);
  const fastTier = list.find((r) => r.title === 'Fast');
  let base: number;
  if (fastTier && Number.isFinite(fastTier.feeRate)) {
    base = fastTier.feeRate;
    debugLog(`using Fast feeRate=${base}`);
  } else if (list.length > 0 && Number.isFinite(list[0].feeRate)) {
    base = list[0].feeRate;
    debugLog(`Fast not found, using first tier feeRate=${base}`);
  } else {
    base = 7500000;
    debugLog('no valid fee from API, fallback 7500000');
  }
  const boosted = Math.ceil(base * 1.5);
  debugLog(`boosted feeRate (Fast * 1.5) = ${boosted}`);
  return boosted;
}

export async function fetchDogeUtxos(
  address: string,
  needRawTx = false
): Promise<DogeUTXO[]> {
  const data = await metaletV4Get<{ list: DogeUtxoApiItem[] }>('/doge/address/utxo-list', {
    address,
  });
  const list = data?.list ?? [];
  const utxos: DogeUTXO[] = list.map((item) => ({
    txId: item.txid,
    outputIndex: item.outIndex,
    satoshis: item.value,
    address: item.address,
    height: item.height,
    confirmed: item.height > 0,
  }));
  const confirmed = utxos.filter((u) => u.height > 0 && u.satoshis >= 1000000);
  if (confirmed.length === 0) {
    debugLog('WARNING: no confirmed UTXOs >= 1000000 sat, falling back to unconfirmed');
  }
  const filtered = confirmed.length > 0 ? confirmed : utxos.filter((u) => u.satoshis >= 1000000);

  if (needRawTx) {
    for (const utxo of filtered) {
      utxo.rawTx = await fetchDogeTxHex(utxo.txId);
    }
  }
  return filtered;
}

export async function fetchDogeTxHex(txId: string): Promise<string> {
  const res = await metaletV4Get<{ hex?: string; rawTx?: string }>('/doge/tx/raw', { txId });
  return res?.hex ?? (res as { rawTx?: string })?.rawTx ?? '';
}

export async function broadcastDogeTx(rawTx: string): Promise<string> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/tx/broadcast`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rawTx, net: NET }),
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
  const txId = json?.data?.TxId ?? json?.data ?? '';
  if (!txId || typeof txId !== 'string' || txId.length < 10) {
    throw new Error(`Broadcast returned invalid txId: ${JSON.stringify(json?.data).slice(0, 200)}`);
  }
  debugLog(`broadcast txId=${txId}`);
  return txId;
}
