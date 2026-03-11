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
  if (needRawTx) {
    for (const utxo of utxos) {
      utxo.rawTx = await fetchDogeTxHex(utxo.txId);
    }
  }
  return utxos.filter((u) => u.satoshis >= 1000000);
}

export async function fetchDogeTxHex(txId: string): Promise<string> {
  const res = await metaletV4Get<{ rawTx: string }>('/doge/tx/raw', { txId });
  return (res as { rawTx?: string })?.rawTx ?? '';
}

export async function broadcastDogeTx(rawTx: string): Promise<string> {
  const data = await metaletV4Post<{ TxId: string }>('/doge/tx/broadcast', { rawTx });
  return data?.TxId ?? '';
}
