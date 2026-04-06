import Decimal from 'decimal.js';

export interface Mrc20TokenUtxoLike {
  txId: string;
  outputIndex: number;
  rawTx?: string;
  mrc20s?: Array<{ amount?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface MvcFundingUtxoLike {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address?: string;
  wif?: string;
  [key: string]: unknown;
}

function normalizeDisplayAmount(amount: string, decimal: number): string {
  const text = String(amount ?? '').trim();
  if (!text) throw new Error('amount is required');
  const parsed = new Decimal(text);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error('amount must be positive');
  return parsed.toFixed(decimal);
}

export function buildMrc20TransferSignOptions(input: {
  amount: string;
  decimal: number;
  mrc20Id: string;
  toAddress: string;
  feeRate: number;
  changeAddress: string;
  fundingUtxos: Array<Record<string, unknown>>;
  tokenUtxos: Mrc20TokenUtxoLike[];
}): {
  amount: string;
  body: string;
  flag: 'metaid';
  mrc20TickId: string;
  revealAddr: string;
  commitFeeRate: number;
  revealFeeRate: number;
  changeAddress: string;
  utxos: Array<Record<string, unknown>>;
  mrc20Utxos: Mrc20TokenUtxoLike[];
} {
  const amount = normalizeDisplayAmount(input.amount, input.decimal);

  return {
    amount,
    body: JSON.stringify([{
      vout: 1,
      id: String(input.mrc20Id || '').trim(),
      amount,
    }]),
    flag: 'metaid',
    mrc20TickId: String(input.mrc20Id || '').trim(),
    revealAddr: String(input.toAddress || '').trim(),
    commitFeeRate: input.feeRate,
    revealFeeRate: input.feeRate,
    changeAddress: String(input.changeAddress || '').trim(),
    utxos: input.fundingUtxos,
    mrc20Utxos: input.tokenUtxos,
  };
}

export async function attachRawTxToMrc20Utxos<T extends Mrc20TokenUtxoLike>(
  utxos: T[],
  fetchRawTx: (txId: string) => Promise<string>,
): Promise<Array<T & { rawTx: string }>> {
  return await Promise.all(utxos.map(async (utxo) => ({
    ...utxo,
    rawTx: String(utxo.rawTx || '') || await fetchRawTx(String(utxo.txId || '')),
  })));
}

export function attachMvcFundingSignatureContext<T extends MvcFundingUtxoLike>(
  utxos: T[],
  input: {
    senderWif: string;
    senderAddress: string;
  },
): Array<T & { wif: string; address: string }> {
  const senderWif = String(input.senderWif || '').trim();
  const senderAddress = String(input.senderAddress || '').trim();
  if (!senderWif) throw new Error('senderWif is required');
  if (!senderAddress) throw new Error('senderAddress is required');

  return utxos.map((utxo) => ({
    ...utxo,
    wif: senderWif,
    address: String(utxo.address || '').trim() || senderAddress,
  }));
}

export function selectMvcFundingUtxos<T extends MvcFundingUtxoLike>(
  utxos: T[],
  input: {
    maxCount?: number;
  } = {},
): T[] {
  const maxCount = Number.isInteger(input.maxCount) && Number(input.maxCount) > 0
    ? Number(input.maxCount)
    : 3;

  return [...utxos]
    .filter((utxo) => Number.isFinite(Number(utxo?.satoshis)) && Number(utxo.satoshis) > 0)
    .sort((left, right) => Number(right.satoshis) - Number(left.satoshis))
    .slice(0, maxCount);
}
