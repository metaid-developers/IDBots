import { getUtxoOutpointKey, isRetryableMvcBroadcastError, type SpendableMvcUtxo } from './mvcSpend';

export interface ChunkedUploadFundingUtxo extends SpendableMvcUtxo {
  flag: string;
}

export function normalizeChunkedUploadUtxos(input: unknown, address: string): ChunkedUploadFundingUtxo[] {
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
        flag: String(record.flag || ''),
      };
    })
    .filter((utxo) => /^[0-9a-fA-F]{64}$/.test(utxo.txId) && Number.isInteger(utxo.outputIndex) && utxo.outputIndex >= 0 && utxo.satoshis > 600);
}

export function pickChunkedUploadFundingUtxos(
  utxos: ChunkedUploadFundingUtxo[],
  amount: number,
  feeRate: number,
  excludedOutpoints: ReadonlySet<string> = new Set(),
): ChunkedUploadFundingUtxo[] {
  let requiredAmount = amount + 34 * 2 * feeRate + 100;
  const candidateUtxos: ChunkedUploadFundingUtxo[] = [];

  let current = 0;
  for (const utxo of utxos) {
    if (excludedOutpoints.has(getUtxoOutpointKey(utxo))) continue;
    current += utxo.satoshis;
    requiredAmount += feeRate * 148;
    candidateUtxos.push(utxo);
    if (current > requiredAmount) {
      return candidateUtxos;
    }
  }

  throw new Error('Insufficient MVC balance for chunked upload');
}

export function isRetryableChunkedUploadError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    isRetryableMvcBroadcastError(message)
    || (normalized.includes('failed to broadcast') && isRetryableMvcBroadcastError(message))
    || normalized.includes('failed to broadcast merge transaction: [-25]missing inputs')
    || normalized.includes('failed to broadcast merge transaction: 258: txn-mempool-conflict')
  );
}
