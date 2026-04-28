import Decimal from 'decimal.js';

const METALET_HOST = 'https://www.metalet.space';
const METAID_MARKET_HOST = 'https://api.metaid.market/api-market';
const NET = 'livenet';
const TXID_RE = /^[0-9a-fA-F]{64}$/;

interface RawMrc20BalanceRow {
  tick?: string;
  mrc20Id?: string;
  decimals?: string | number;
}

interface RawMrc20TickInfoResponse {
  tick?: string;
  mrc20Id?: string;
  decimals?: string | number;
}

export interface Mrc20TokenInfo {
  mrc20Id: string;
  ticker: string;
  decimal: number;
}

export interface Mrc20TokenUtxo {
  txId?: string;
  txid?: string;
  amount?: string;
  mrc20s?: Array<{
    amount?: string;
    tick?: string;
    ticker?: string;
    mrc20Id?: string;
    tickId?: string;
  }>;
}

export interface VerifyMrc20PaymentInput {
  txid: string;
  recipientAddress: string;
  mrc20Id: string;
  mrc20Ticker: string;
  expectedAmountDisplay: string | number;
}

export interface VerifyMrc20PaymentResult {
  valid: boolean;
  reason: string;
  mrc20Ticker?: string;
  mrc20Id?: string;
  recipientAddress?: string;
  currency?: string;
  amountDisplay?: string;
  matchedAmountAtomic?: string;
  expectedAmountAtomic?: string;
}

export interface VerifyMrc20PaymentDeps {
  fetchTokenInfo: (params: {
    recipientAddress: string;
    mrc20Id: string;
  }) => Promise<Mrc20TokenInfo | null>;
  fetchRecipientTokenUtxos: (params: {
    recipientAddress: string;
    mrc20Id: string;
  }) => Promise<Mrc20TokenUtxo[]>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTicker(value: unknown): string {
  return normalizeText(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeDecimal(value: unknown): number {
  const decimal = Number(value);
  if (!Number.isInteger(decimal) || decimal < 0) return 0;
  return decimal;
}

function normalizeDisplayAmount(value: unknown): string {
  return String(value ?? '').trim();
}

function isLikelyBtcAddress(value: unknown): boolean {
  const address = normalizeText(value);
  if (!address) return false;
  if (/^(bc1|tb1)[ac-hj-np-z02-9]{11,71}$/i.test(address)) {
    return true;
  }
  return /^[123mn2][1-9A-HJ-NP-Za-km-z]{25,62}$/.test(address);
}

function parseAtomicAmount(value: unknown): bigint {
  const text = String(value ?? '').trim();
  if (!/^[0-9]+$/.test(text)) return 0n;
  try {
    return BigInt(text);
  } catch {
    return 0n;
  }
}

function toAtomicAmountOrZero(value: unknown, decimal: number): bigint {
  const text = String(value ?? '').trim();
  if (!text) return 0n;
  try {
    return toAtomicFromDisplay(text, decimal);
  } catch {
    return 0n;
  }
}

function toAtomicFromDisplay(value: string | number, decimal: number): bigint {
  const text = String(value ?? '').trim();
  if (!text) {
    throw new Error('amount is required');
  }
  const parsed = new Decimal(text);
  if (!parsed.isFinite() || parsed.lt(0)) {
    throw new Error('amount must be non-negative');
  }
  const atomic = parsed.mul(new Decimal(10).pow(decimal)).toFixed(0);
  return parseAtomicAmount(atomic);
}

function getUtxoTxid(utxo: Mrc20TokenUtxo): string {
  return normalizeText(utxo.txId || utxo.txid);
}

function sumAtomicAmountFromEntry(
  utxo: Mrc20TokenUtxo,
  mrc20Id: string,
  ticker: string,
  decimal: number
): bigint {
  const entries = Array.isArray(utxo.mrc20s) ? utxo.mrc20s : [];
  if (entries.length === 0) {
    return toAtomicAmountOrZero(utxo.amount, decimal);
  }

  let total = 0n;
  for (const entry of entries) {
    const entryId = normalizeText(entry.mrc20Id || entry.tickId);
    const entryTicker = normalizeTicker(entry.tick || entry.ticker);
    if (entryId && entryId !== mrc20Id) continue;
    if (entryTicker && entryTicker !== ticker) continue;
    total += toAtomicAmountOrZero(entry.amount, decimal);
  }
  return total;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const json = await response.json() as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  return (json.data ?? json) as T;
}

async function fetchTokenInfoDefault(params: {
  recipientAddress: string;
  mrc20Id: string;
}): Promise<Mrc20TokenInfo | null> {
  try {
    const response = await fetchJson<RawMrc20TickInfoResponse>(
      `${METAID_MARKET_HOST}/api/v1/common/mrc20/tick/info?tickId=${encodeURIComponent(params.mrc20Id)}`,
    );
    if (normalizeText(response?.mrc20Id) === params.mrc20Id) {
      return {
        mrc20Id: params.mrc20Id,
        ticker: normalizeTicker(response.tick),
        decimal: normalizeDecimal(response.decimals),
      };
    }
  } catch {
    // Fall back to the recipient balance-list path for environments where the
    // public tick-info endpoint is unavailable.
  }

  const response = await fetchJson<{ list: RawMrc20BalanceRow[] }>(
    `${METALET_HOST}/wallet-api/v3/mrc20/address/balance-list?net=${NET}&address=${encodeURIComponent(params.recipientAddress)}&cursor=0&size=1000&source=mrc20-v2`,
  );
  const list = response?.list ?? [];
  const row = list.find((item) => normalizeText(item.mrc20Id) === params.mrc20Id);
  if (!row) return null;

  return {
    mrc20Id: params.mrc20Id,
    ticker: normalizeTicker(row.tick),
    decimal: normalizeDecimal(row.decimals),
  };
}

async function fetchRecipientTokenUtxosDefault(params: {
  recipientAddress: string;
  mrc20Id: string;
}): Promise<Mrc20TokenUtxo[]> {
  const response = await fetchJson<{ list: Mrc20TokenUtxo[] }>(
    `${METALET_HOST}/wallet-api/v3/mrc20/address/utxo?net=${NET}&address=${encodeURIComponent(params.recipientAddress)}&tickId=${encodeURIComponent(params.mrc20Id)}&source=mrc20-v2`,
  );
  return response?.list ?? [];
}

const defaultDeps: VerifyMrc20PaymentDeps = {
  fetchTokenInfo: fetchTokenInfoDefault,
  fetchRecipientTokenUtxos: fetchRecipientTokenUtxosDefault,
};

export function isMrc20TransientVerificationReason(reason: string): boolean {
  const normalized = normalizeText(reason);
  return normalized.startsWith('fetch_token_info_failed:')
    || normalized.startsWith('fetch_token_utxos_failed:')
    || normalized === 'recipient_txid_not_observable';
}

export async function verifyMrc20Payment(
  input: VerifyMrc20PaymentInput,
  deps: VerifyMrc20PaymentDeps = defaultDeps
): Promise<VerifyMrc20PaymentResult> {
  const txid = normalizeText(input.txid);
  if (!TXID_RE.test(txid)) {
    return { valid: false, reason: 'invalid_txid' };
  }

  const recipientAddress = normalizeText(input.recipientAddress);
  if (!isLikelyBtcAddress(recipientAddress)) {
    return { valid: false, reason: 'invalid_recipient_address' };
  }

  const mrc20Id = normalizeText(input.mrc20Id);
  if (!mrc20Id) {
    return { valid: false, reason: 'invalid_mrc20_id' };
  }

  const expectedTicker = normalizeTicker(input.mrc20Ticker);
  if (!expectedTicker) {
    return { valid: false, reason: 'invalid_mrc20_ticker' };
  }

  const amountDisplay = normalizeDisplayAmount(input.expectedAmountDisplay);
  let tokenInfo: Mrc20TokenInfo | null = null;
  try {
    tokenInfo = await deps.fetchTokenInfo({
      recipientAddress,
      mrc20Id,
    });
  } catch (error) {
    return {
      valid: false,
      reason: `fetch_token_info_failed:${getErrorMessage(error)}`,
      mrc20Id,
      recipientAddress,
    };
  }

  if (!tokenInfo) {
    return {
      valid: false,
      reason: 'mrc20_id_not_found',
      mrc20Id,
      recipientAddress,
    };
  }

  const resolvedTicker = normalizeTicker(tokenInfo.ticker);
  if (!resolvedTicker) {
    return {
      valid: false,
      reason: 'invalid_token_ticker',
      mrc20Id,
      recipientAddress,
    };
  }
  if (resolvedTicker !== expectedTicker) {
    return {
      valid: false,
      reason: `ticker_mismatch:${resolvedTicker}:${expectedTicker}`,
      mrc20Id,
      mrc20Ticker: resolvedTicker,
      recipientAddress,
      currency: `${resolvedTicker}-MRC20`,
      amountDisplay,
    };
  }

  let expectedAmountAtomic = 0n;
  try {
    expectedAmountAtomic = toAtomicFromDisplay(input.expectedAmountDisplay, normalizeDecimal(tokenInfo.decimal));
  } catch (error) {
    return {
      valid: false,
      reason: `invalid_expected_amount:${getErrorMessage(error)}`,
      mrc20Id,
      mrc20Ticker: resolvedTicker,
      recipientAddress,
      currency: `${resolvedTicker}-MRC20`,
      amountDisplay,
    };
  }

  const expectedAmountAtomicText = expectedAmountAtomic.toString();
  let utxos: Mrc20TokenUtxo[] = [];
  try {
    utxos = await deps.fetchRecipientTokenUtxos({
      recipientAddress,
      mrc20Id,
    });
  } catch (error) {
    return {
      valid: false,
      reason: `fetch_token_utxos_failed:${getErrorMessage(error)}`,
      mrc20Id,
      mrc20Ticker: resolvedTicker,
      recipientAddress,
      currency: `${resolvedTicker}-MRC20`,
      amountDisplay,
      expectedAmountAtomic: expectedAmountAtomicText,
    };
  }

  let matchedAmountAtomic = 0n;
  for (const utxo of utxos) {
    if (getUtxoTxid(utxo) !== txid) continue;
    matchedAmountAtomic += sumAtomicAmountFromEntry(
      utxo,
      mrc20Id,
      resolvedTicker,
      normalizeDecimal(tokenInfo.decimal)
    );
  }

  const matchedAmountAtomicText = matchedAmountAtomic.toString();
  if (matchedAmountAtomic <= 0n) {
    // Current public APIs only expose the recipient's present token UTXO set.
    // If the recipient already consolidated or spent that output, the transfer
    // becomes unobservable from current state even though it may have happened.
    return {
      valid: false,
      reason: 'recipient_txid_not_observable',
      mrc20Id,
      mrc20Ticker: resolvedTicker,
      recipientAddress,
      currency: `${resolvedTicker}-MRC20`,
      amountDisplay,
      matchedAmountAtomic: matchedAmountAtomicText,
      expectedAmountAtomic: expectedAmountAtomicText,
    };
  }

  if (matchedAmountAtomic < expectedAmountAtomic) {
    return {
      valid: false,
      reason: `insufficient_token_amount:${matchedAmountAtomicText}:${expectedAmountAtomicText}`,
      mrc20Id,
      mrc20Ticker: resolvedTicker,
      recipientAddress,
      currency: `${resolvedTicker}-MRC20`,
      amountDisplay,
      matchedAmountAtomic: matchedAmountAtomicText,
      expectedAmountAtomic: expectedAmountAtomicText,
    };
  }

  return {
    valid: true,
    reason: 'verified',
    mrc20Id,
    mrc20Ticker: resolvedTicker,
    recipientAddress,
    currency: `${resolvedTicker}-MRC20`,
    amountDisplay,
    matchedAmountAtomic: matchedAmountAtomicText,
    expectedAmountAtomic: expectedAmountAtomicText,
  };
}

export const verifyMrc20Transfer = verifyMrc20Payment;
