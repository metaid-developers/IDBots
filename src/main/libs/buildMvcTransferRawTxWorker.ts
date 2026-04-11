import { TxComposer, mvc } from 'meta-contract';
import { getMvcWallet, parseAddressIndexFromPath } from '../services/metabotWalletService';
import {
  getUtxoOutpointKey,
  pickUtxo,
  type SpendableMvcUtxo,
} from './mvcSpend';

const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const ESTIMATED_TX_SIZE_WITHOUT_INPUTS = 4 + 1 + 1 + 43 + 43 + 4;

function logStep(message: string, details?: Record<string, unknown>): void {
  try {
    const suffix = details ? ` ${JSON.stringify(details)}` : '';
    process.stderr.write(`[buildMvcTransferRawTxWorker] ${message}${suffix}\n`);
  } catch {
    // ignore logging failures
  }
}

function getMessage(err: unknown): string {
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as Error).message === 'string') {
    return (err as Error).message;
  }
  return String(err);
}

function normalizeExcludeOutpoints(input: unknown): Set<string> {
  if (!Array.isArray(input)) return new Set();
  return new Set(
    input
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  );
}

export function normalizeMvcWalletUtxos(input: unknown, address: string): SpendableMvcUtxo[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((item) => {
      const record = item as Record<string, unknown>;
      const txId = String(record.txId ?? record.txid ?? '').trim();
      const outputIndex = Number(record.outputIndex ?? record.outIndex ?? record.vout);
      const satoshis = Number(record.satoshis ?? record.value ?? 0);
      const height = Number(record.height ?? 0);
      return {
        txId,
        outputIndex,
        satoshis,
        address: String(record.address || address).trim() || address,
        height: Number.isFinite(height) ? height : 0,
      };
    })
    .filter((utxo) => /^[0-9a-fA-F]{64}$/.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600);
}

async function fetchMVCUtxos(address: string): Promise<Array<{ txid: string; outIndex: number; value: number; height: number }>> {
  const all: Array<{ txid: string; outIndex: number; value: number; height: number }> = [];
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

export function buildMvcTransferRawTxLocally(params: {
  senderWif: string;
  senderAddress: string;
  toAddress: string;
  amountSats: number;
  feeRate: number;
  utxos: SpendableMvcUtxo[];
  excludeOutpoints?: ReadonlySet<string>;
}): {
  txHex: string;
  txId: string;
  spentOutpoints: string[];
  changeOutpoint: string | null;
} {
  const network = mvc.Networks.livenet;
  const privateKey = mvc.PrivateKey.fromWIF(params.senderWif);
  const senderAddressObj = new mvc.Address(params.senderAddress, network as any);
  const recipientAddressObj = new mvc.Address(params.toAddress, network as any);

  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({
    address: recipientAddressObj,
    satoshis: params.amountSats,
  });

  const picked = pickUtxo(
    params.utxos,
    params.amountSats,
    params.feeRate,
    ESTIMATED_TX_SIZE_WITHOUT_INPUTS,
    params.excludeOutpoints ?? new Set(),
  );

  for (const utxo of picked) {
    txComposer.appendP2PKHInput({
      address: senderAddressObj,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      satoshis: utxo.satoshis,
    });
  }
  txComposer.appendChangeOutput(senderAddressObj, params.feeRate);

  const tx = txComposer.tx;
  for (let inputIndex = 0; inputIndex < tx.inputs.length; inputIndex += 1) {
    txComposer.unlockP2PKHInput(privateKey, inputIndex);
  }

  const txHex = txComposer.getRawHex();
  const txId = tx.id;
  const changeIndex = tx.outputs.length > 1 ? tx.outputs.length - 1 : -1;

  return {
    txHex,
    txId,
    spentOutpoints: picked.map((utxo) => getUtxoOutpointKey(utxo)),
    changeOutpoint: changeIndex >= 0 ? `${txId}:${changeIndex}` : null,
  };
}

async function main(): Promise<void> {
  const mnemonic = process.env.IDBOTS_METABOT_MNEMONIC?.trim();
  const pathStr = (process.env.IDBOTS_METABOT_PATH || DEFAULT_PATH).trim();
  if (!mnemonic) {
    console.log(JSON.stringify({ success: false, error: 'IDBOTS_METABOT_MNEMONIC required' }));
    process.exit(1);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as {
    toAddress: string;
    amountSats: number;
    feeRate: number;
    excludeOutpoints?: string[];
  };
  const { toAddress, amountSats, feeRate } = payload;
  if (!toAddress || !Number.isInteger(amountSats) || amountSats <= 0 || !Number.isFinite(feeRate) || feeRate <= 0) {
    console.log(JSON.stringify({ success: false, error: 'Invalid payload: toAddress, amountSats (>0), feeRate (>0) required' }));
    process.exit(1);
  }

  const addressIndex = parseAddressIndexFromPath(pathStr);
  const mvcWallet = await getMvcWallet(mnemonic, addressIndex);
  const senderWif = mvcWallet.getPrivateKey();
  const senderAddress = mvcWallet.getAddress();
  const excludeOutpoints = normalizeExcludeOutpoints(payload.excludeOutpoints);
  const utxos = normalizeMvcWalletUtxos(await fetchMVCUtxos(senderAddress), senderAddress);
  logStep('Fetched MVC raw-tx funding candidates', {
    candidateOutpoints: utxos.map((utxo) => getUtxoOutpointKey(utxo)),
    excludedOutpoints: Array.from(excludeOutpoints),
  });
  const availableUtxos = utxos.filter((utxo) => !excludeOutpoints.has(getUtxoOutpointKey(utxo)));
  if (availableUtxos.length === 0) {
    console.log(JSON.stringify({ success: false, error: 'No spendable MVC UTXOs after exclusions' }));
    process.exit(1);
  }

  const result = buildMvcTransferRawTxLocally({
    senderWif,
    senderAddress,
    toAddress,
    amountSats,
    feeRate,
    utxos,
    excludeOutpoints,
  });
  logStep('Built MVC raw-tx transfer locally', {
    pickedOutpoints: result.spentOutpoints,
    txid: result.txId,
    changeOutpoint: result.changeOutpoint,
  });

  console.log(
    JSON.stringify({
      success: true,
      txHex: result.txHex,
      txid: result.txId,
      spentOutpoints: result.spentOutpoints,
      changeOutpoint: result.changeOutpoint,
    }),
  );
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(JSON.stringify({ success: false, error: getMessage(err) }));
    process.exit(1);
  });
}
