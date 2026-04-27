import { mvc } from 'meta-contract';

/** Size in bytes of one signed P2PKH input in the serialized tx. */
export const P2PKH_INPUT_SIZE = 148;

export interface SpendableMvcUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address: string;
  height: number;
}

export interface ClassifiedMvcSpendError {
  category: 'stale_inputs' | 'insufficient_balance' | 'network' | 'unknown';
  message: string;
  retryable: boolean;
}

export function computeMvcTxidFromRawTx(rawTx: string): string {
  const tx = new mvc.Transaction(rawTx);
  return tx.id;
}

export function isTxnAlreadyKnownError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return normalized.includes('txn-already-known') || normalized.includes('already known');
}

export function isRetryableMvcBroadcastError(message: string): boolean {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('missing inputs')
    || normalized.includes('missingorspent')
    || normalized.includes('inputs missing/spent')
    || normalized.includes('inputs missing or spent')
    || normalized.includes('txn-mempool-conflict')
  );
}

export function classifyMvcSpendError(error: unknown): ClassifiedMvcSpendError {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const normalized = message.toLowerCase();

  if (isRetryableMvcBroadcastError(message)) {
    return {
      category: 'stale_inputs',
      message,
      retryable: true,
    };
  }

  if (normalized.includes('not enough balance') || normalized.includes('余额不足')) {
    return {
      category: 'insufficient_balance',
      message,
      retryable: false,
    };
  }

  if (normalized.includes('fetch failed') || normalized.includes('networkerror') || normalized.includes('network error')) {
    return {
      category: 'network',
      message,
      retryable: false,
    };
  }

  return {
    category: 'unknown',
    message,
    retryable: false,
  };
}

export function resolveBroadcastTxResult(
  rawTx: string,
  json: { code?: number; message?: string; data?: string },
): string {
  if (json?.code === 0) {
    return json.data ?? computeMvcTxidFromRawTx(rawTx);
  }
  if (isTxnAlreadyKnownError(json?.message || '')) {
    return computeMvcTxidFromRawTx(rawTx);
  }
  throw new Error(json?.message || 'Broadcast failed');
}

export function getUtxoOutpointKey(utxo: Pick<SpendableMvcUtxo, 'txId' | 'outputIndex'>): string {
  return `${utxo.txId}:${utxo.outputIndex}`;
}

export function ensureFreshMvcFundingCandidates(
  utxos: SpendableMvcUtxo[],
  excludedOutpoints: ReadonlySet<string> = new Set(),
): void {
  if (excludedOutpoints.size === 0 || utxos.length === 0) {
    return;
  }

  const hasFreshCandidate = utxos.some((utxo) => !excludedOutpoints.has(getUtxoOutpointKey(utxo)));
  if (hasFreshCandidate) {
    return;
  }

  throw new Error('MVC funding inputs are stale on the provider; wait for the UTXO set to refresh and retry.');
}

export function pickUtxo(
  utxos: SpendableMvcUtxo[],
  totalOutput: number,
  feeRate: number,
  estimatedTxSizeWithoutInputs: number,
  excludedOutpoints: ReadonlySet<string> = new Set(),
  preferredOutpoints: ReadonlySet<string> = new Set(),
): SpendableMvcUtxo[] {
  ensureFreshMvcFundingCandidates(utxos, excludedOutpoints);
  const ordered = utxos.filter((u) => !excludedOutpoints.has(getUtxoOutpointKey(u)));
  const preferred = ordered.filter((utxo) => preferredOutpoints.has(getUtxoOutpointKey(utxo)));
  const remaining = ordered.filter((utxo) => !preferredOutpoints.has(getUtxoOutpointKey(utxo)));
  const prioritized = preferred.concat(remaining);

  let current = 0;
  const candidate: SpendableMvcUtxo[] = [];
  for (const u of prioritized) {
    current += u.satoshis;
    candidate.push(u);
    const numInputs = candidate.length;
    const estimatedTxSize = estimatedTxSizeWithoutInputs + numInputs * P2PKH_INPUT_SIZE;
    const requiredAmount = totalOutput + Math.ceil(estimatedTxSize * feeRate);
    if (current >= requiredAmount) return candidate;
  }

  throw new Error('Not enough balance');
}
