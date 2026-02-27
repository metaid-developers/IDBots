/**
 * MetaID API helpers for main process: fetch MVC UTXOs and broadcast transactions.
 * Uses Metalet public API (no credential required for these endpoints).
 */

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

export type MvcUtxo = {
  flag?: string;
  address: string;
  txid: string;
  outIndex: number;
  value: number;
  height: number;
};

interface MetaletV4Response<T> {
  code: number;
  message?: string;
  data: T;
}

/**
 * Fetch MVC UTXOs for an address (paginated).
 */
export async function fetchMVCUtxos(
  address: string,
  useUnconfirmed = true
): Promise<MvcUtxo[]> {
  const allUtxos: MvcUtxo[] = [];
  let flag: string | undefined;
  let hasMore = true;

  while (hasMore) {
    const params = new URLSearchParams({
      address,
      net: NET,
      ...(flag ? { flag } : {}),
    });
    const url = `${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`;
    const res = await fetch(url);
    const json = (await res.json()) as MetaletV4Response<{ list: MvcUtxo[] }>;
    if (json.code !== 0) {
      throw new Error(json.message || 'Failed to fetch UTXOs');
    }
    const list = json.data?.list ?? [];
    if (list.length === 0) {
      break;
    }
    const filtered = list.filter(
      (u) => u.value >= 600 && (useUnconfirmed || u.height > 0)
    );
    allUtxos.push(...filtered);
    flag = list[list.length - 1]?.flag;
    if (!flag) hasMore = false;
  }

  return allUtxos;
}

/**
 * Broadcast a raw transaction to the MVC chain.
 */
export async function broadcastTx(rawTx: string): Promise<string> {
  const url = `${METALET_HOST}/wallet-api/v3/tx/broadcast`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
  });
  const json = (await res.json()) as MetaletV4Response<string>;
  if (json.code !== 0) {
    throw new Error(json.message || 'Broadcast failed');
  }
  return json.data;
}
