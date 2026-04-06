import Decimal from 'decimal.js';
import {
  AddressType,
  BtcWallet,
  CoinType,
  SignType,
} from '@metalet/utxo-wallet-service';
import type { MetabotStore } from '../metabotStore';
import { parseAddressIndexFromPath } from './metabotWalletService';
import {
  attachRawTxToMrc20Utxos,
  buildMrc20TransferSignOptions,
} from './tokenTransferAdapters';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";

export interface Mrc20Asset {
  kind: 'mrc20';
  chain: 'btc';
  symbol: string;
  tokenName: string;
  mrc20Id: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    pendingIn: string;
    pendingOut: string;
    display: string;
  };
}

export interface ExecuteMrc20TransferResult {
  commitTxId: string;
  revealTxId: string;
  totalFeeSats: number;
}

interface RawMrc20BalanceRow {
  tick?: string;
  mrc20Id?: string;
  decimals?: string | number;
  balance?: string;
  unsafeBalance?: string;
  pendingInBalance?: string;
  pendingOutBalance?: string;
  tokenName?: string;
  metaData?: string;
}

interface FundingUtxo {
  txId: string;
  outputIndex: number;
  satoshis?: number;
  rawTx?: string;
  address?: string;
  [key: string]: unknown;
}

interface Mrc20TokenUtxo {
  txId: string;
  outputIndex: number;
  rawTx?: string;
  mrc20s?: Array<{
    amount?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

interface WalletContext {
  wallet: BtcWallet;
  address: string;
}

interface SignTransferResult {
  commitTxHex: string;
  revealTxHex: string;
  totalFeeSats: number;
}

interface Mrc20ServiceDeps {
  fetchBalanceList: (address: string) => Promise<RawMrc20BalanceRow[]>;
  deriveWalletContext: (store: MetabotStore, metabotId: number) => Promise<WalletContext>;
  fetchFundingUtxos: (address: string) => Promise<FundingUtxo[]>;
  fetchMrc20Utxos: (address: string, mrc20Id: string) => Promise<Mrc20TokenUtxo[]>;
  signTransfer: (params: {
    context: WalletContext;
    fundingUtxos: FundingUtxo[];
    tokenUtxos: Mrc20TokenUtxo[];
    input: {
      metabotId: number;
      asset: { mrc20Id: string; decimal: number; address: string; symbol: string };
      toAddress: string;
      amount: string;
      feeRate: number;
    };
    amountAtomic: string;
  }) => Promise<SignTransferResult>;
  broadcastCommit: (hex: string) => Promise<string>;
  broadcastReveal: (hex: string) => Promise<string>;
}

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
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

function normalizeDecimal(value: unknown): number {
  const decimal = Number(value);
  if (!Number.isInteger(decimal) || decimal < 0) return 0;
  return decimal;
}

function toAtomicFromDisplay(value: unknown, decimal: number): string {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('amount is required');
  const parsed = new Decimal(text);
  if (!parsed.isFinite() || parsed.lte(0)) throw new Error('amount must be positive');
  return parsed.mul(new Decimal(10).pow(decimal)).toFixed(0);
}

function formatDisplay(value: unknown, decimal: number): string {
  return new Decimal(String(value ?? '0'))
    .toDecimalPlaces(decimal)
    .toFixed(decimal);
}

function parseIcon(metaData: unknown): string | undefined {
  if (typeof metaData !== 'string' || !metaData.trim()) return undefined;
  try {
    const parsed = JSON.parse(metaData);
    return typeof parsed?.icon === 'string' ? parsed.icon : undefined;
  } catch {
    return undefined;
  }
}

function mapBalanceRow(address: string, row: RawMrc20BalanceRow): Mrc20Asset {
  const decimal = normalizeDecimal(row.decimals);
  const confirmed = formatDisplay(row.balance ?? '0', decimal);
  const unconfirmed = formatDisplay(row.unsafeBalance ?? '0', decimal);
  const pendingIn = formatDisplay(row.pendingInBalance ?? '0', decimal);
  const pendingOut = formatDisplay(row.pendingOutBalance ?? '0', decimal);
  const display = new Decimal(confirmed).add(pendingIn).sub(pendingOut).toFixed(decimal);

  return {
    kind: 'mrc20',
    chain: 'btc',
    symbol: String(row.tick || ''),
    tokenName: String(row.tokenName || row.tick || ''),
    mrc20Id: String(row.mrc20Id || ''),
    address,
    decimal,
    icon: parseIcon(row.metaData),
    balance: {
      confirmed,
      unconfirmed,
      pendingIn,
      pendingOut,
      display,
    },
  };
}

async function fetchFundingUtxosDefault(address: string): Promise<FundingUtxo[]> {
  const list = await fetchJson<Array<{ txId: string; outputIndex: number; satoshis: number; address?: string; confirmed?: boolean }>>(
    `${METALET_HOST}/wallet-api/v3/address/btc-utxo?net=${NET}&address=${encodeURIComponent(address)}&unconfirmed=1`,
  );
  const filtered = (list ?? []).filter((item) => item.satoshis >= 600 && item.confirmed !== false);
  const resolved = filtered.length > 0 ? filtered : (list ?? []).filter((item) => item.satoshis >= 600);

  return await Promise.all(resolved.map(async (item) => {
    const raw = await fetchJson<{ rawTx?: string; hex?: string }>(
      `${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(item.txId)}&chain=btc`,
    );
    return {
      txId: item.txId,
      outputIndex: item.outputIndex,
      satoshis: item.satoshis,
      address: item.address || address,
      rawTx: raw.rawTx ?? raw.hex ?? '',
    };
  }));
}

async function fetchMrc20UtxosDefault(address: string, mrc20Id: string): Promise<Mrc20TokenUtxo[]> {
  const response = await fetchJson<{ list: Mrc20TokenUtxo[] }>(
    `${METALET_HOST}/wallet-api/v3/mrc20/address/utxo?net=${NET}&address=${encodeURIComponent(address)}&tickId=${encodeURIComponent(mrc20Id)}&source=mrc20-v2`,
  );
  const list = response?.list ?? [];
  return await attachRawTxToMrc20Utxos(list, async (txId) => {
    const raw = await fetchJson<{ rawTx?: string; hex?: string }>(
      `${METALET_HOST}/wallet-api/v3/tx/raw?net=${NET}&txId=${encodeURIComponent(txId)}&chain=btc`,
    );
    return raw.rawTx ?? raw.hex ?? '';
  });
}

async function deriveWalletContextDefault(store: MetabotStore, metabotId: number): Promise<WalletContext> {
  const wallet = store.getMetabotWalletByMetabotId(metabotId);
  if (!wallet?.mnemonic?.trim()) throw new Error('MetaBot wallet not found');
  const addressIndex = parseAddressIndexFromPath(wallet.path || DEFAULT_PATH);
  const btcWallet = new BtcWallet({
    coinType: CoinType.MVC,
    addressType: AddressType.SameAsMvc,
    addressIndex,
    network: 'livenet',
    mnemonic: wallet.mnemonic,
  });
  return {
    wallet: btcWallet,
    address: btcWallet.getAddress(),
  };
}

async function signTransferDefault(params: {
  context: WalletContext;
  fundingUtxos: FundingUtxo[];
  tokenUtxos: Mrc20TokenUtxo[];
  input: {
    metabotId: number;
    asset: { mrc20Id: string; decimal: number; address: string; symbol: string };
    toAddress: string;
    amount: string;
    feeRate: number;
  };
  amountAtomic: string;
}): Promise<SignTransferResult> {
  const signOptions = buildMrc20TransferSignOptions({
    amount: params.input.amount,
    decimal: params.input.asset.decimal,
    mrc20Id: params.input.asset.mrc20Id,
    toAddress: params.input.toAddress,
    feeRate: params.input.feeRate,
    changeAddress: params.context.address,
    fundingUtxos: params.fundingUtxos as Array<Record<string, unknown>>,
    tokenUtxos: params.tokenUtxos,
  });

  const signed = params.context.wallet.signTx(SignType.MRC20_TRANSFER, signOptions as any) as {
    commitTx: { rawTx: string; fee?: number | string };
    revealTx: { rawTx: string; fee?: number | string };
  };

  const commitFee = Number(signed.commitTx?.fee ?? 0);
  const revealFee = Number(signed.revealTx?.fee ?? 0);

  return {
    commitTxHex: signed.commitTx.rawTx,
    revealTxHex: signed.revealTx.rawTx,
    totalFeeSats: Number.isFinite(commitFee + revealFee) ? commitFee + revealFee : 0,
  };
}

async function broadcastBtc(hex: string): Promise<string> {
  return await postJson<string>(`${METALET_HOST}/wallet-api/v3/tx/broadcast`, {
    chain: 'btc',
    net: NET,
    rawTx: hex,
  });
}

const defaultDeps: Mrc20ServiceDeps = {
  fetchBalanceList: async (address) => {
    const response = await fetchJson<{ list: RawMrc20BalanceRow[] }>(
      `${METALET_HOST}/wallet-api/v3/mrc20/address/balance-list?net=${NET}&address=${encodeURIComponent(address)}&cursor=0&size=1000&source=mrc20-v2`,
    );
    return response?.list ?? [];
  },
  deriveWalletContext: deriveWalletContextDefault,
  fetchFundingUtxos: fetchFundingUtxosDefault,
  fetchMrc20Utxos: fetchMrc20UtxosDefault,
  signTransfer: signTransferDefault,
  broadcastCommit: broadcastBtc,
  broadcastReveal: broadcastBtc,
};

export async function listMrc20Assets(
  address: string,
  deps: Pick<Mrc20ServiceDeps, 'fetchBalanceList'> = defaultDeps,
): Promise<Mrc20Asset[]> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const rows = await deps.fetchBalanceList(address);
  return rows.map((row) => mapBalanceRow(address, row));
}

export async function executeMrc20Transfer(
  store: MetabotStore,
  input: {
    metabotId: number;
    asset: { mrc20Id: string; decimal: number; address: string; symbol: string };
    toAddress: string;
    amount: string;
    feeRate: number;
  },
  deps: Mrc20ServiceDeps = defaultDeps,
): Promise<ExecuteMrc20TransferResult> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.asset?.mrc20Id) throw new Error('asset.mrc20Id is required');
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const amountAtomic = toAtomicFromDisplay(input.amount, normalizeDecimal(input.asset.decimal));
  const context = await deps.deriveWalletContext(store, input.metabotId);
  const [fundingUtxos, tokenUtxos] = await Promise.all([
    deps.fetchFundingUtxos(context.address),
    deps.fetchMrc20Utxos(context.address, input.asset.mrc20Id),
  ]);
  if (fundingUtxos.length === 0) throw new Error('No BTC funding UTXOs available');
  if (tokenUtxos.length === 0) throw new Error('No MRC20 UTXOs available');

  const signed = await deps.signTransfer({
    context,
    fundingUtxos,
    tokenUtxos,
    input,
    amountAtomic,
  });

  if (!signed.commitTxHex || !signed.revealTxHex) {
    throw new Error('Failed to sign MRC20 transfer');
  }

  try {
    const commitTxId = await deps.broadcastCommit(signed.commitTxHex);
    const revealTxId = await deps.broadcastReveal(signed.revealTxHex);
    return {
      commitTxId,
      revealTxId,
      totalFeeSats: signed.totalFeeSats,
    };
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
