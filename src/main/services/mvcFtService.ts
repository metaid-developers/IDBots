import Decimal from 'decimal.js';
import { mvc } from 'meta-contract';
import type { MetabotStore } from '../metabotStore';
import { buildMvcFtTransferRawTx } from './walletRawTxService';
import { isRetryableMvcBroadcastError, resolveBroadcastTxResult } from '../libs/mvcSpend';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const RETRYABLE_MVC_FT_CHILD_BROADCAST_ATTEMPTS = 3;
const RETRYABLE_MVC_FT_BUILD_ATTEMPTS = 3;
const RETRYABLE_MVC_FT_BROADCAST_DELAY_MS = 750;

export interface MvcFtAsset {
  kind: 'mvc-ft';
  chain: 'mvc';
  symbol: string;
  tokenName: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    display: string;
  };
}

interface RawMvcFtBalanceRow {
  codeHash?: string;
  genesis?: string;
  name?: string;
  symbol?: string;
  icon?: string;
  decimal?: number | string;
  sensibleId?: string;
  confirmedString?: string;
  unconfirmedString?: string;
}

interface MvcFtServiceDeps {
  fetchBalanceList: (address: string) => Promise<RawMvcFtBalanceRow[]>;
  buildRawTx: typeof buildMvcFtTransferRawTx;
  broadcastTx: (rawTx: string) => Promise<string>;
}

function normalizeDecimal(value: unknown): number {
  const decimal = Number(value);
  if (!Number.isInteger(decimal) || decimal < 0) return 0;
  return decimal;
}

function formatFixedDisplayValue(raw: unknown, decimal: number): string {
  const normalized = normalizeDecimal(decimal);
  return new Decimal(String(raw ?? '0'))
    .toDecimalPlaces(normalized)
    .toFixed(normalized);
}

function formatAtomicValue(raw: unknown, decimal: number): string {
  const normalized = normalizeDecimal(decimal);
  const text = String(raw ?? '0').trim();
  const value = /^-?\d+$/.test(text) ? BigInt(text) : 0n;
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  if (normalized === 0) return `${sign}${absolute.toString()}`;
  const base = 10n ** BigInt(normalized);
  const integerPart = absolute / base;
  const fractionPart = absolute % base;
  return `${sign}${integerPart.toString()}.${fractionPart.toString().padStart(normalized, '0')}`;
}

function formatBalanceValue(raw: unknown, decimal: number): string {
  const text = String(raw ?? '').trim();
  if (!text) return formatFixedDisplayValue('0', decimal);
  if (/^-?\d+$/.test(text)) return formatAtomicValue(text, decimal);
  return formatFixedDisplayValue(text, decimal);
}

function toAtomicAmount(value: string, decimal: number): string {
  const parsed = new Decimal(String(value ?? '').trim());
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error('amount must be positive');
  return parsed.mul(new Decimal(10).pow(decimal)).toFixed(0);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const json = await response.json() as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  return (json.data ?? json) as T;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error ?? '');
}

function normalizeSpentOutpoints(outpoints: unknown): string[] {
  if (!Array.isArray(outpoints)) return [];
  return Array.from(new Set(
    outpoints
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => /^[0-9a-f]{64}:\d+$/.test(value)),
  ));
}

function extractSpentOutpointsFromRawTx(rawTx: unknown): string[] {
  const raw = String(rawTx || '').trim();
  if (!raw) return [];
  try {
    const tx = new mvc.Transaction(raw);
    return normalizeSpentOutpoints(
      tx.inputs.map((input: any) => `${input.prevTxId.toString('hex')}:${Number(input.outputIndex)}`),
    );
  } catch {
    return [];
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: MvcFtServiceDeps = {
  fetchBalanceList: async (address) => {
    const response = await fetchJson<{ list: RawMvcFtBalanceRow[] }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/ft/balance-list?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return response?.list ?? [];
  },
  buildRawTx: buildMvcFtTransferRawTx,
  broadcastTx: async (rawTx) => {
    const response = await fetch(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chain: 'mvc',
        net: NET,
        rawTx,
      }),
    });
    const json = await response.json() as { code?: number; message?: string; data?: string };
    return resolveBroadcastTxResult(rawTx, json);
  },
};

export async function broadcastMvcFtTransferBundle(
  bundle: {
    amountCheckRawTx: string;
    rawTx: string;
  },
  broadcastTx: (rawTx: string) => Promise<string>,
): Promise<{ amountCheckTxId: string; txId: string }> {
  const amountCheckRawTx = String(bundle?.amountCheckRawTx || '').trim();
  const rawTx = String(bundle?.rawTx || '').trim();
  if (!amountCheckRawTx || !rawTx) {
    throw new Error('amountCheckRawTx and rawTx are required');
  }

  const amountCheckTxId = await broadcastTx(amountCheckRawTx);
  let lastRawTxError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_FT_CHILD_BROADCAST_ATTEMPTS; attempt += 1) {
    try {
      const txId = await broadcastTx(rawTx);
      return { amountCheckTxId, txId };
    } catch (error) {
      lastRawTxError = error;
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_FT_CHILD_BROADCAST_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        await sleep(RETRYABLE_MVC_FT_BROADCAST_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw new Error(getErrorMessage(lastRawTxError ?? 'MVC FT broadcast failed'));
}

export async function listMvcFtAssets(
  address: string,
  deps: Pick<MvcFtServiceDeps, 'fetchBalanceList'> = defaultDeps,
): Promise<MvcFtAsset[]> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const rows = await deps.fetchBalanceList(address);
  return rows.map((row) => {
    const decimal = normalizeDecimal(row.decimal);
    const icon = typeof row.icon === 'string' && row.icon
      ? row.icon.startsWith('http')
        ? row.icon
        : `https://www.metalet.space/wallet-api${row.icon}`
      : undefined;
    const confirmed = formatBalanceValue(row.confirmedString, decimal);
    const unconfirmed = formatBalanceValue(row.unconfirmedString, decimal);
    const display = new Decimal(confirmed).add(unconfirmed).toFixed(decimal);
    return {
      kind: 'mvc-ft',
      chain: 'mvc',
      symbol: String(row.symbol || ''),
      tokenName: String(row.name || row.symbol || ''),
      genesis: String(row.genesis || ''),
      codeHash: String(row.codeHash || ''),
      sensibleId: row.sensibleId,
      address,
      decimal,
      icon,
      balance: {
        confirmed,
        unconfirmed,
        display,
      },
    };
  });
}

export async function executeMvcFtTransfer(
  store: MetabotStore,
  input: {
    metabotId: number;
    asset: {
      symbol: string;
      genesis: string;
      codeHash: string;
      decimal: number;
      address: string;
    };
    toAddress: string;
    amount: string;
    feeRate: number;
  },
  deps: MvcFtServiceDeps = defaultDeps,
): Promise<{ txId: string; rawTx: string; amountCheckTxId: string }> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.asset?.genesis || !input?.asset?.codeHash) {
    throw new Error('asset genesis and codeHash are required');
  }
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const amount = toAtomicAmount(input.amount, normalizeDecimal(input.asset.decimal));
  const excludedOutpoints = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_FT_BUILD_ATTEMPTS; attempt += 1) {
    const raw = await deps.buildRawTx(store, {
      metabotId: input.metabotId,
      token: {
        symbol: input.asset.symbol,
        tokenID: input.asset.genesis,
        genesisHash: input.asset.genesis,
        codeHash: input.asset.codeHash,
        decimal: input.asset.decimal,
      },
      toAddress: input.toAddress,
      amount,
      feeRate: input.feeRate,
      excludeOutpoints: Array.from(excludedOutpoints),
    });

    try {
      const { txId, amountCheckTxId } = await broadcastMvcFtTransferBundle({
        amountCheckRawTx: raw.amount_check_raw_tx,
        rawTx: raw.raw_tx,
      }, deps.broadcastTx);
      return {
        txId,
        rawTx: raw.raw_tx,
        amountCheckTxId,
      };
    } catch (error) {
      lastError = error;
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_FT_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        const retryBlacklist = normalizeSpentOutpoints([
          ...extractSpentOutpointsFromRawTx(raw.amount_check_raw_tx),
          ...normalizeSpentOutpoints(raw.spent_outpoints),
        ]);
        for (const outpoint of retryBlacklist) {
          excludedOutpoints.add(outpoint);
        }
        await sleep(RETRYABLE_MVC_FT_BROADCAST_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw new Error(getErrorMessage(lastError ?? 'MVC FT transfer failed'));
}
