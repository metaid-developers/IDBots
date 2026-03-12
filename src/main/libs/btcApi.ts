/**
 * BTC network API: fetch UTXOs, fee rates, raw tx, broadcast.
 * Uses Metalet wallet-api v3 for BTC.
 */

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

export interface BtcUTXO {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  rawTx?: string;
  confirmed?: boolean;
}

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[btc-api] ${msg}\n`);
  } catch { /* noop */ }
}

async function metaletV3Get<T>(path: string, params: Record<string, string>): Promise<T> {
  const search = new URLSearchParams({ ...params, net: NET });
  const url = `${METALET_HOST}/wallet-api/v3${path}?${search}`;
  const res = await fetch(url);
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

export async function fetchBtcUtxos(
  address: string,
  needRawTx = false
): Promise<BtcUTXO[]> {
  const list = await metaletV3Get<Array<{
    txId: string;
    outputIndex: number;
    satoshis: number;
    address?: string;
    confirmed?: boolean;
  }>>('/address/btc-utxo', { address, unconfirmed: '1' });

  const all: BtcUTXO[] = (list ?? [])
    .filter((u) => u.satoshis >= 600)
    .map((u) => ({
      txId: u.txId,
      outputIndex: u.outputIndex,
      satoshis: u.satoshis,
      address: u.address || address,
      confirmed: u.confirmed,
    }));

  const confirmed = all.filter((u) => u.confirmed !== false);
  const filtered = confirmed.length > 0 ? confirmed : all;

  if (needRawTx) {
    for (const utxo of filtered) {
      utxo.rawTx = await fetchBtcTxHex(utxo.txId);
    }
  }

  return filtered;
}

export async function fetchBtcTxHex(txId: string): Promise<string> {
  const res = await metaletV3Get<{ rawTx?: string; hex?: string }>('/tx/raw', {
    txId,
    chain: 'btc',
  });
  return res?.rawTx ?? res?.hex ?? '';
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
