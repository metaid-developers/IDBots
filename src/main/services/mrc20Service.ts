import Decimal from 'decimal.js';
import {
  AddressType,
  BtcWallet,
  CoinType,
  SignType,
  Transaction,
  getAddressFromScript,
} from '@metalet/utxo-wallet-service';
import type { MetabotStore } from '../metabotStore';
import { parseAddressIndexFromPath } from './metabotWalletService';
import {
  attachRawTxToMrc20Utxos,
  buildMrc20TransferSignOptions,
} from './tokenTransferAdapters';
import { fetchBtcTxHex, fetchBtcUtxos } from '../libs/btcApi';

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

interface RawMrc20ActivityRow {
  txId?: string;
  from?: string;
  to?: string;
  amount?: string;
  height?: number;
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

interface DecodedTxInput {
  txId: string;
  outputIndex: number;
}

interface DecodedTxOutput {
  outputIndex: number;
  satoshis: number;
  address?: string | null;
}

interface PendingMrc20CacheEntry extends Mrc20TokenUtxo {
  createdAt: number;
}

interface PendingFundingCacheEntry extends FundingUtxo {
  createdAt: number;
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
  fetchMrc20Activities: (address: string, mrc20Id: string) => Promise<RawMrc20ActivityRow[]>;
  fetchTxHex: (txId: string) => Promise<string>;
  decodeTx: (hex: string) => { inputs: DecodedTxInput[]; outputs: DecodedTxOutput[] };
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
  wait: (ms: number) => Promise<void>;
}

const MRC20_UTXO_RETRY_DELAYS_MS = [750, 1500, 3000];
const PENDING_MRC20_CACHE_TTL_MS = 30 * 60 * 1000;
const pendingMrc20UtxoCache = new Map<string, PendingMrc20CacheEntry[]>();
const pendingBtcFundingUtxoCache = new Map<string, PendingFundingCacheEntry[]>();

function getErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string') {
    return (error as Error).message;
  }
  return String(error);
}

function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function hasPositiveDisplayAmount(value: unknown): boolean {
  const text = String(value ?? '').trim();
  if (!text) return false;
  try {
    return new Decimal(text).gt(0);
  } catch {
    return false;
  }
}

function getPendingMrc20CacheKey(address: string, mrc20Id: string): string {
  return `${address}::${mrc20Id}`;
}

function cloneMrc20TokenUtxo(utxo: Mrc20TokenUtxo): Mrc20TokenUtxo {
  return {
    ...utxo,
    mrc20s: Array.isArray(utxo.mrc20s)
      ? utxo.mrc20s.map((entry) => ({ ...entry }))
      : utxo.mrc20s,
  };
}

function getCachedPendingMrc20Utxos(address: string, mrc20Id: string): Mrc20TokenUtxo[] {
  const key = getPendingMrc20CacheKey(address, mrc20Id);
  const cached = pendingMrc20UtxoCache.get(key);
  if (!cached || cached.length === 0) return [];

  const now = Date.now();
  const fresh = cached.filter((entry) => now - entry.createdAt <= PENDING_MRC20_CACHE_TTL_MS);
  if (fresh.length === 0) {
    pendingMrc20UtxoCache.delete(key);
    return [];
  }
  if (fresh.length !== cached.length) {
    pendingMrc20UtxoCache.set(key, fresh);
  }
  return fresh.map((entry) => cloneMrc20TokenUtxo(entry));
}

function setCachedPendingMrc20Utxos(address: string, mrc20Id: string, utxos: Mrc20TokenUtxo[]): void {
  const key = getPendingMrc20CacheKey(address, mrc20Id);
  if (utxos.length === 0) {
    pendingMrc20UtxoCache.delete(key);
    return;
  }
  const createdAt = Date.now();
  pendingMrc20UtxoCache.set(key, utxos.map((utxo) => ({
    ...cloneMrc20TokenUtxo(utxo),
    createdAt,
  })));
}

function cloneFundingUtxo(utxo: FundingUtxo): FundingUtxo {
  return { ...utxo };
}

function getCachedPendingFundingUtxos(address: string): FundingUtxo[] {
  const cached = pendingBtcFundingUtxoCache.get(address);
  if (!cached || cached.length === 0) return [];

  const now = Date.now();
  const fresh = cached.filter((entry) => now - entry.createdAt <= PENDING_MRC20_CACHE_TTL_MS);
  if (fresh.length === 0) {
    pendingBtcFundingUtxoCache.delete(address);
    return [];
  }
  if (fresh.length !== cached.length) {
    pendingBtcFundingUtxoCache.set(address, fresh);
  }
  return fresh.map((entry) => cloneFundingUtxo(entry));
}

function setCachedPendingFundingUtxos(address: string, utxos: FundingUtxo[]): void {
  if (utxos.length === 0) {
    pendingBtcFundingUtxoCache.delete(address);
    return;
  }
  const createdAt = Date.now();
  pendingBtcFundingUtxoCache.set(address, utxos.map((utxo) => ({
    ...cloneFundingUtxo(utxo),
    createdAt,
  })));
}

function toAtomicBigIntFromDisplay(value: unknown, decimal: number): bigint {
  return BigInt(toAtomicFromDisplay(value, decimal));
}

function sumTokenAmountAtomic(utxos: Mrc20TokenUtxo[], decimal: number): bigint {
  return utxos.reduce((total, utxo) => {
    const entries = Array.isArray(utxo.mrc20s) ? utxo.mrc20s : [];
    const entryTotal = entries.reduce((innerTotal, entry) => {
      if (!entry?.amount) return innerTotal;
      try {
        return innerTotal + toAtomicBigIntFromDisplay(entry.amount, decimal);
      } catch {
        return innerTotal;
      }
    }, 0n);
    return total + entryTotal;
  }, 0n);
}

function formatDisplayFromAtomic(raw: bigint, decimal: number): string {
  return new Decimal(raw.toString())
    .div(new Decimal(10).pow(decimal))
    .toFixed(decimal);
}

function normalizeSpendableMrc20Utxos(utxos: Mrc20TokenUtxo[]): Mrc20TokenUtxo[] {
  return utxos.flatMap((utxo) => {
    const entries = Array.isArray(utxo.mrc20s) ? utxo.mrc20s : [];
    const positiveEntries = entries.filter((entry) => hasPositiveDisplayAmount(entry?.amount));
    if (entries.length > 0 && positiveEntries.length === 0) {
      return [];
    }
    return [{
      ...cloneMrc20TokenUtxo(utxo),
      mrc20s: positiveEntries.length > 0 ? positiveEntries : utxo.mrc20s,
    }];
  });
}

function buildCachedPendingMrc20Utxos(params: {
  address: string;
  toAddress: string;
  decimal: number;
  amountAtomic: string;
  sourceTokenUtxos: Mrc20TokenUtxo[];
  revealTxId: string;
  revealTxHex: string;
  decodeTx: (hex: string) => { inputs: DecodedTxInput[]; outputs: DecodedTxOutput[] };
}): Mrc20TokenUtxo[] {
  const decoded = params.decodeTx(params.revealTxHex);
  const localDustOutputs = decoded.outputs
    .filter((output) => output.address === params.address && output.satoshis <= 546)
    .sort((left, right) => left.outputIndex - right.outputIndex);
  if (localDustOutputs.length === 0) return [];

  const transferAtomic = BigInt(params.amountAtomic);
  const totalInputAtomic = sumTokenAmountAtomic(params.sourceTokenUtxos, params.decimal);
  const changeAtomic = totalInputAtomic - transferAtomic;
  const cached: Mrc20TokenUtxo[] = [];

  if (params.toAddress === params.address && localDustOutputs[0]) {
    cached.push({
      txId: params.revealTxId,
      outputIndex: localDustOutputs[0].outputIndex,
      satoshis: localDustOutputs[0].satoshis,
      address: params.address,
      rawTx: params.revealTxHex,
      mrc20s: [{ amount: formatDisplayFromAtomic(transferAtomic, params.decimal) }],
    });
  }

  if (changeAtomic > 0n) {
    const changeOutput = params.toAddress === params.address
      ? localDustOutputs[1]
      : localDustOutputs[0];
    if (changeOutput) {
      cached.push({
        txId: params.revealTxId,
        outputIndex: changeOutput.outputIndex,
        satoshis: changeOutput.satoshis,
        address: params.address,
        rawTx: params.revealTxHex,
        mrc20s: [{ amount: formatDisplayFromAtomic(changeAtomic, params.decimal) }],
      });
    }
  }

  return cached;
}

function buildCachedPendingFundingUtxos(params: {
  address: string;
  commitTxId: string;
  commitTxHex: string;
  decodeTx: (hex: string) => { inputs: DecodedTxInput[]; outputs: DecodedTxOutput[] };
}): FundingUtxo[] {
  const decoded = params.decodeTx(params.commitTxHex);
  return decoded.outputs
    .filter((output) => output.address === params.address && output.satoshis >= 600)
    .sort((left, right) => left.outputIndex - right.outputIndex)
    .map((output) => ({
      txId: params.commitTxId,
      outputIndex: output.outputIndex,
      satoshis: output.satoshis,
      rawTx: params.commitTxHex,
      address: params.address,
    }));
}

async function fetchGovernedFundingUtxos(
  deps: Pick<Mrc20ServiceDeps, 'fetchFundingUtxos'>,
  address: string,
): Promise<FundingUtxo[]> {
  const cached = getCachedPendingFundingUtxos(address);
  if (cached.length > 0) {
    console.warn(`[mrc20Service] Using locally cached BTC funding UTXOs for ${address}`);
    return cached;
  }
  return await deps.fetchFundingUtxos(address);
}

function isRetryableMrc20UtxoFetchError(error: unknown): boolean {
  const message = getErrorMessage(error);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('no data found')
    || normalized.includes('rpc error')
    || normalized.includes('request error')
    || normalized.includes('fetch failed')
    || normalized.includes('network error')
    || normalized.includes('networkerror')
    || normalized.includes('timeout')
  );
}

async function waitDefault(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function decodeTxDefault(hex: string): { inputs: DecodedTxInput[]; outputs: DecodedTxOutput[] } {
  const tx = Transaction.fromHex(hex);
  return {
    inputs: tx.ins.map((input) => ({
      txId: Buffer.from(input.hash).reverse().toString('hex'),
      outputIndex: input.index,
    })),
    outputs: tx.outs.map((output, index) => ({
      outputIndex: index,
      satoshis: output.value,
      address: (() => {
        try {
          return getAddressFromScript(output.script, undefined);
        } catch {
          return null;
        }
      })(),
    })),
  };
}

async function fetchMrc20ActivitiesDefault(address: string, mrc20Id: string): Promise<RawMrc20ActivityRow[]> {
  const response = await fetchJson<{ list: RawMrc20ActivityRow[] }>(
    `${METALET_HOST}/wallet-api/v3/mrc20/address/activities?net=${NET}&address=${encodeURIComponent(address)}&tickId=${encodeURIComponent(mrc20Id)}&cursor=0&size=20&source=mrc20-v2`,
  );
  return response?.list ?? [];
}

async function derivePendingMrc20UtxosFromActivities(
  deps: Pick<Mrc20ServiceDeps, 'fetchMrc20Activities' | 'fetchTxHex' | 'decodeTx'>,
  address: string,
  mrc20Id: string,
): Promise<Mrc20TokenUtxo[]> {
  const activityRows = await deps.fetchMrc20Activities(address, mrc20Id);
  const relevantRows = activityRows.filter((row) => normalizeText(row.txId) && hasPositiveDisplayAmount(row.amount));
  if (relevantRows.length === 0) return [];

  const groupedRows = new Map<string, RawMrc20ActivityRow[]>();
  for (const row of relevantRows) {
    const txId = normalizeText(row.txId);
    const existing = groupedRows.get(txId);
    if (existing) {
      existing.push(row);
    } else {
      groupedRows.set(txId, [row]);
    }
  }

  const decodedByTxId = new Map<string, { rawTx: string; inputs: DecodedTxInput[]; outputs: DecodedTxOutput[] }>();
  for (const txId of groupedRows.keys()) {
    try {
      const rawTx = await deps.fetchTxHex(txId);
      const decoded = deps.decodeTx(rawTx);
      decodedByTxId.set(txId, {
        rawTx,
        inputs: decoded.inputs,
        outputs: decoded.outputs,
      });
    } catch (error) {
      console.warn(`[mrc20Service] Failed to decode recent MRC20 activity tx ${txId}: ${getErrorMessage(error)}`);
    }
  }

  if (decodedByTxId.size === 0) return [];

  const spentOutpoints = new Set<string>();
  for (const decoded of decodedByTxId.values()) {
    for (const input of decoded.inputs) {
      spentOutpoints.add(`${input.txId}:${input.outputIndex}`);
    }
  }

  const derived: Mrc20TokenUtxo[] = [];
  for (const [txId, rows] of groupedRows.entries()) {
    const decoded = decodedByTxId.get(txId);
    if (!decoded) continue;

    const localRows = rows.filter((row) => {
      const toAddress = normalizeText(row.to);
      const fromAddress = normalizeText(row.from);
      if (toAddress) return toAddress === address;
      return fromAddress === address;
    });
    if (localRows.length === 0) continue;

    const candidateOutputs = decoded.outputs
      .filter((output) => output.address === address && output.satoshis <= 546)
      .sort((left, right) => left.outputIndex - right.outputIndex);
    if (candidateOutputs.length === 0) continue;

    const matchedCount = Math.min(localRows.length, candidateOutputs.length);
    for (let index = 0; index < matchedCount; index += 1) {
      const output = candidateOutputs[index];
      const outpoint = `${txId}:${output.outputIndex}`;
      if (spentOutpoints.has(outpoint)) continue;
      derived.push({
        txId,
        outputIndex: output.outputIndex,
        satoshis: output.satoshis,
        address: output.address || address,
        rawTx: decoded.rawTx,
        mrc20s: [{
          amount: String(localRows[index]?.amount ?? ''),
        }],
      });
    }
  }

  return derived;
}

async function fetchGovernedMrc20Utxos(
  deps: Pick<Mrc20ServiceDeps, 'fetchMrc20Utxos' | 'fetchMrc20Activities' | 'fetchTxHex' | 'decodeTx' | 'wait'>,
  address: string,
  mrc20Id: string,
): Promise<Mrc20TokenUtxo[]> {
  const cached = getCachedPendingMrc20Utxos(address, mrc20Id);
  if (cached.length > 0) {
    console.warn(`[mrc20Service] Using locally cached pending token UTXOs for ${address}`);
    return cached;
  }

  let primaryError: unknown;

  for (let attempt = 0; attempt <= MRC20_UTXO_RETRY_DELAYS_MS.length; attempt += 1) {
    primaryError = undefined;

    try {
      const fetched = normalizeSpendableMrc20Utxos(await deps.fetchMrc20Utxos(address, mrc20Id));
      if (fetched.length > 0) {
        return fetched;
      }
    } catch (error) {
      primaryError = error;
      if (!isRetryableMrc20UtxoFetchError(error)) {
        throw error;
      }
    }

    try {
      const derived = await derivePendingMrc20UtxosFromActivities(deps, address, mrc20Id);
      if (derived.length > 0) {
        console.warn(`[mrc20Service] Using activity-derived pending token UTXOs for ${address}`);
        return derived;
      }
    } catch (error) {
      console.warn(`[mrc20Service] Failed to derive pending token UTXOs from activities: ${getErrorMessage(error)}`);
    }

    if (attempt === MRC20_UTXO_RETRY_DELAYS_MS.length) {
      break;
    }

    const delayMs = MRC20_UTXO_RETRY_DELAYS_MS[attempt];
    const reason = primaryError ? getErrorMessage(primaryError) : 'empty provider MRC20 UTXO set';
    console.warn(
      `[mrc20Service] Retrying token UTXO fetch after transient provider miss: ${reason} (attempt ${attempt + 2}/${MRC20_UTXO_RETRY_DELAYS_MS.length + 1}, wait ${delayMs}ms)`,
    );
    await deps.wait(delayMs);
  }

  if (primaryError) {
    throw primaryError;
  }
  return [];
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
  const list = await fetchBtcUtxos(address, true);
  return list.map((item) => ({
    txId: item.txId,
    outputIndex: item.outputIndex,
    satoshis: item.satoshis,
    address: item.address || address,
    rawTx: item.rawTx ?? '',
  }));
}

async function fetchMrc20UtxosDefault(address: string, mrc20Id: string): Promise<Mrc20TokenUtxo[]> {
  const response = await fetchJson<{ list: Mrc20TokenUtxo[] }>(
    `${METALET_HOST}/wallet-api/v3/mrc20/address/utxo?net=${NET}&address=${encodeURIComponent(address)}&tickId=${encodeURIComponent(mrc20Id)}&source=mrc20-v2`,
  );
  const list = response?.list ?? [];
  return await attachRawTxToMrc20Utxos(list, async (txId) => await fetchBtcTxHex(txId));
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
  fetchMrc20Activities: fetchMrc20ActivitiesDefault,
  fetchTxHex: fetchBtcTxHex,
  decodeTx: decodeTxDefault,
  signTransfer: signTransferDefault,
  broadcastCommit: broadcastBtc,
  broadcastReveal: broadcastBtc,
  wait: waitDefault,
};

export async function listMrc20Assets(
  address: string,
  deps: Partial<Pick<Mrc20ServiceDeps, 'fetchBalanceList'>> = defaultDeps,
): Promise<Mrc20Asset[]> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const resolvedDeps = { ...defaultDeps, ...deps };
  const rows = await resolvedDeps.fetchBalanceList(address);
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
  deps: Partial<Mrc20ServiceDeps> = defaultDeps,
): Promise<ExecuteMrc20TransferResult> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.asset?.mrc20Id) throw new Error('asset.mrc20Id is required');
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const amountAtomic = toAtomicFromDisplay(input.amount, normalizeDecimal(input.asset.decimal));
  const resolvedDeps: Mrc20ServiceDeps = { ...defaultDeps, ...deps };
  const context = await resolvedDeps.deriveWalletContext(store, input.metabotId);
  const fundingUtxosPromise = fetchGovernedFundingUtxos(resolvedDeps, context.address);
  const tokenUtxosPromise = fetchGovernedMrc20Utxos(resolvedDeps, context.address, input.asset.mrc20Id);
  const [fundingUtxos, tokenUtxos] = await Promise.all([
    fundingUtxosPromise,
    tokenUtxosPromise,
  ]);
  if (fundingUtxos.length === 0) throw new Error('No BTC funding UTXOs available');
  if (tokenUtxos.length === 0) throw new Error('No MRC20 UTXOs available');

  const signed = await resolvedDeps.signTransfer({
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
    const commitTxId = await resolvedDeps.broadcastCommit(signed.commitTxHex);
    const revealTxId = await resolvedDeps.broadcastReveal(signed.revealTxHex);
    try {
      const cachedFundingUtxos = buildCachedPendingFundingUtxos({
        address: context.address,
        commitTxId,
        commitTxHex: signed.commitTxHex,
        decodeTx: resolvedDeps.decodeTx,
      });
      setCachedPendingFundingUtxos(context.address, cachedFundingUtxos);
    } catch (error) {
      console.warn(`[mrc20Service] Failed to prime local BTC funding cache: ${getErrorMessage(error)}`);
    }
    try {
      const cachedPendingUtxos = buildCachedPendingMrc20Utxos({
        address: context.address,
        toAddress: input.toAddress,
        decimal: normalizeDecimal(input.asset.decimal),
        amountAtomic,
        sourceTokenUtxos: tokenUtxos,
        revealTxId,
        revealTxHex: signed.revealTxHex,
        decodeTx: resolvedDeps.decodeTx,
      });
      setCachedPendingMrc20Utxos(context.address, input.asset.mrc20Id, cachedPendingUtxos);
    } catch (error) {
      console.warn(`[mrc20Service] Failed to prime local pending token cache: ${getErrorMessage(error)}`);
    }
    return {
      commitTxId,
      revealTxId,
      totalFeeSats: signed.totalFeeSats,
    };
  } catch (error) {
    throw new Error(getErrorMessage(error));
  }
}
