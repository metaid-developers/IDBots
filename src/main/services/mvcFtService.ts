import Decimal from 'decimal.js';
import type { MetabotStore } from '../metabotStore';
import { buildMvcFtTransferRawTx } from './walletRawTxService';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';

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

async function postJson<T>(url: string, body: Record<string, string>): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await response.json() as { code?: number; message?: string; data?: T };
  if (json.code !== 0 && json.code !== undefined) {
    throw new Error(json.message || 'API request failed');
  }
  return (json.data ?? json) as T;
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
    return await postJson<string>(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
      chain: 'mvc',
      net: NET,
      rawTx,
    });
  },
};

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
): Promise<{ txId: string; rawTx: string }> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.asset?.genesis || !input?.asset?.codeHash) {
    throw new Error('asset genesis and codeHash are required');
  }
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const amount = toAtomicAmount(input.amount, normalizeDecimal(input.asset.decimal));
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
  });

  const txId = await deps.broadcastTx(raw.raw_tx);
  return {
    txId,
    rawTx: raw.raw_tx,
  };
}
