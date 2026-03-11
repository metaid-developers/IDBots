/**
 * Create Pin worker: runs in subprocess via ELECTRON_RUN_AS_NODE to avoid meta-contract
 * instanceof issues in the main process.
 * Reads mnemonic/path from env, metaidData from stdin, outputs result to stdout.
 */

import { TxComposer, mvc } from 'meta-contract';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

async function fetchMVCUtxos(address: string): Promise<{ txid: string; outIndex: number; value: number; height: number }[]> {
  const all: { txid: string; outIndex: number; value: number; height: number }[] = [];
  let flag: string | undefined;
  while (true) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`);
    const json = (await res.json()) as { data?: { list?: Array<{ txid: string; outIndex: number; value: number; height: number; flag?: string }> } };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    all.push(...list.filter((u) => u.value >= 600));
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

async function broadcastTx(rawTx: string): Promise<string> {
  const res = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chain: 'mvc', net: NET, rawTx }),
  });
  const json = (await res.json()) as { code?: number; message?: string; data?: string };
  if (json?.code !== 0) throw new Error(json?.message || 'Broadcast failed');
  return json.data ?? '';
}

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const P2PKH_UNLOCK_SIZE = 1 + 1 + 72 + 1 + 33;

interface RpcPayload {
  feeRate?: number;
  /** Target network: 'mvc' (default), 'doge', 'btc'. Omit or empty defaults to 'mvc'. */
  network?: string;
  metaidData: {
    operation: string;
    path?: string;
    encryption?: string;
    version?: string;
    contentType?: string;
    payload: string;
    encoding?: 'utf-8' | 'base64';
  };
}

interface SA_utxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

function parseAddressIndexFromPath(pathStr: string): number {
  if (!pathStr || typeof pathStr !== 'string') return 0;
  const m = pathStr.match(/\/0\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

function buildMvcOpReturn(data: RpcPayload['metaidData']): (string | Buffer)[] {
  const result: (string | Buffer)[] = ['metaid', data.operation];
  if (data.operation !== 'init') {
    result.push((data.path || '').toLowerCase());
    result.push(data.encryption || '0');
    result.push(data.version || '1.0');
    result.push(data.contentType || 'text/plain;utf-8');
    const encoding = data.encoding === 'base64' ? 'base64' : 'utf-8';
    const body = Buffer.from(data.payload, encoding);
    result.push(body);
  }
  return result;
}

function pickUtxo(utxos: SA_utxo[], amount: number, feeb: number): SA_utxo[] {
  let requiredAmount = amount + 34 * 2 * feeb + 100;
  if (requiredAmount <= 0) return [];
  const sum = utxos.reduce((acc, u) => acc + u.satoshis, 0);
  if (sum < requiredAmount) throw new Error('Not enough balance');

  const confirmed = utxos.filter((u) => u.height > 0).sort(() => Math.random() - 0.5);
  const unconfirmed = utxos.filter((u) => u.height <= 0).sort(() => Math.random() - 0.5);
  let current = 0;
  const candidate: SA_utxo[] = [];
  for (const u of [...confirmed, ...unconfirmed]) {
    current += u.satoshis;
    requiredAmount += feeb * P2PKH_UNLOCK_SIZE;
    candidate.push(u);
    if (current > requiredAmount) return candidate;
  }
  return candidate;
}

function isRetryableBroadcastError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('insufficient priority') ||
    m.includes('mempool min fee not met') ||
    m.includes('min relay fee not met') ||
    m.includes('insufficient fee') ||
    m.includes('too-long-mempool-chain')
  );
}

function buildFeeRatePlan(baseFeeRate: number): number[] {
  const base = Number.isFinite(baseFeeRate) && baseFeeRate > 0 ? Math.floor(baseFeeRate) : 1;
  const plan = [
    base,
    Math.max(2, base * 2),
    Math.max(4, base * 4),
    Math.max(8, base * 8),
    12,
    20,
  ];
  const dedup: number[] = [];
  for (const value of plan) {
    if (!dedup.includes(value)) dedup.push(value);
  }
  return dedup;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.error(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload: RpcPayload = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  const { metaidData, network: networkParam } = payload;
  const networkKind = (String(networkParam ?? '').toLowerCase().trim() || 'mvc') as string;

  if (networkKind === 'doge') {
    const { runDogeCreatePin } = await import('./dogeInscribe');
    const { fetchDogeFeeRates } = await import('./dogeApi');
    let feeRate = payload.feeRate;
    if (feeRate == null || !Number.isFinite(feeRate) || feeRate <= 0) {
      const feeRates = await fetchDogeFeeRates();
      feeRate = feeRates.length > 0 ? feeRates[0].feeRate : 5000000;
    }
    const result = await runDogeCreatePin(
      mnemonic,
      pathStr,
      metaidData,
      feeRate
    );
    console.log(
      JSON.stringify({
        success: true,
        txids: result.txids,
        pinId: result.pinId,
        totalCost: result.totalCost,
      })
    );
    return;
  }

  if (networkKind === 'btc') {
    console.error(
      JSON.stringify({ success: false, error: 'BTC chain not yet supported' })
    );
    process.exit(1);
  }

  const feeRates = buildFeeRatePlan(payload.feeRate ?? 1);
  const addressIndex = parseAddressIndexFromPath(pathStr);

  const network = mvc.Networks.livenet;
  const mneObj = mvc.Mnemonic.fromString(mnemonic);
  const hdpk = mneObj.toHDPrivateKey('', network as any);
  const derivePath = `m/44'/10001'/0'/0/${addressIndex}`;
  const childPk = hdpk.deriveChild(derivePath);
  const address = childPk.publicKey.toAddress(network as any).toString();
  const privateKey = childPk.privateKey;

  const utxos = await fetchMVCUtxos(address);
  const usableUtxos: SA_utxo[] = utxos.map((u) => ({
    txId: u.txid,
    outputIndex: u.outIndex,
    satoshis: u.value,
    address,
    height: u.height,
  }));

  const addressObj = new mvc.Address(address, network as any);
  let lastError = '';

  for (let i = 0; i < feeRates.length; i++) {
    const feeRate = feeRates[i];
    try {
      const txComposer = new TxComposer();
      txComposer.appendP2PKHOutput({
        address: addressObj,
        satoshis: 1,
      });
      txComposer.appendOpReturnOutput(buildMvcOpReturn(metaidData));

      const tx = txComposer.tx;
      const totalOutput = tx.outputs.reduce((acc, o) => acc + o.satoshis, 0);
      const picked = pickUtxo(usableUtxos, totalOutput, feeRate);

      for (const utxo of picked) {
        txComposer.appendP2PKHInput({
          address: addressObj,
          txId: utxo.txId,
          outputIndex: utxo.outputIndex,
          satoshis: utxo.satoshis,
        });
      }
      txComposer.appendChangeOutput(addressObj, feeRate);

      for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex++) {
        txComposer.unlockP2PKHInput(privateKey, inputIndex);
      }

      const rawHex = txComposer.getRawHex();
      const inputTotal = tx.inputs.reduce((s, inp) => s + (inp.output?.satoshis || 0), 0);
      const outputTotal = tx.outputs.reduce((s, o) => s + o.satoshis, 0);
      const totalCost = inputTotal - outputTotal;

      const txid = await broadcastTx(rawHex);
      const pinId = `${txid}i0`;
      console.log(JSON.stringify({ success: true, txids: [txid], pinId, totalCost, feeRate }));
      return;
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String((err as Error).message)
        : String(err);
      lastError = message;
      const canRetry = isRetryableBroadcastError(message) && i < feeRates.length - 1;
      if (!canRetry) {
        throw err;
      }
      await sleep(250);
    }
  }

  throw new Error(lastError || 'broadcast failed');
}

main().catch((err: unknown) => {
  const msg = err && typeof err === 'object' && 'message' in err
    ? String((err as Error).message)
    : String(err);
  console.error(JSON.stringify({ success: false, error: msg }));
  process.exit(1);
});
