import type { MetabotStore } from '../metabotStore';
import Decimal from 'decimal.js';
import { getAddressBalance } from './addressBalanceService';
import { getMetabotAccountAddresses } from './metabotAccountService';
import { listMrc20Assets as listMrc20AssetsService } from './mrc20Service';
import { listMvcFtAssets as listMvcFtAssetsService } from './mvcFtService';

export interface NativeAsset {
  kind: 'native';
  chain: 'btc' | 'doge' | 'mvc';
  symbol: 'BTC' | 'DOGE' | 'SPACE';
  address: string;
  balance: {
    confirmed: string;
    display: string;
  };
}

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

export interface MetabotWalletAssets {
  metabotId: number;
  nativeAssets: NativeAsset[];
  mrc20Assets: Mrc20Asset[];
  mvcFtAssets: MvcFtAsset[];
}

interface MetabotWalletAssetInput {
  metabotId: number;
}

interface NativeBalanceEntry {
  address: string;
  value: number;
  unit: string;
}

interface NativeBalances {
  btc: NativeBalanceEntry;
  doge: NativeBalanceEntry;
  mvc: NativeBalanceEntry;
}

interface Mrc20AssetInput {
  symbol: string;
  tokenName?: string;
  mrc20Id: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
    pendingIn: string;
    pendingOut: string;
  };
}

interface MvcFtAssetInput {
  symbol: string;
  tokenName?: string;
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  address: string;
  decimal: number;
  icon?: string;
  balance: {
    confirmed: string;
    unconfirmed: string;
  };
}

interface MetabotWalletAssetServiceDeps {
  getNativeBalances: (summary: {
    metabot_id: number;
    mvc_address: string;
    btc_address: string;
    doge_address: string;
  }) => Promise<NativeBalances>;
  listMrc20Assets: (btcAddress: string) => Promise<Mrc20AssetInput[]>;
  listMvcFtAssets: (mvcAddress: string) => Promise<MvcFtAssetInput[]>;
}

const SATOSHIS_PER_UNIT = 100_000_000;

function isTokenNoDataError(error: unknown): boolean {
  const message =
    error != null && typeof error === 'object' && 'message' in error && typeof (error as Error).message === 'string'
      ? (error as Error).message
      : String(error ?? '');
  return /no data found/i.test(message);
}

const defaultDeps: MetabotWalletAssetServiceDeps = {
  async getNativeBalances(summary) {
    const [btc, doge, mvc] = await Promise.all([
      getAddressBalance('btc', summary.btc_address),
      getAddressBalance('doge', summary.doge_address),
      getAddressBalance('mvc', summary.mvc_address),
    ]);
    return {
      btc: { address: summary.btc_address, value: btc.value, unit: btc.unit },
      doge: { address: summary.doge_address, value: doge.value, unit: doge.unit },
      mvc: { address: summary.mvc_address, value: mvc.value, unit: mvc.unit },
    };
  },
  async listMrc20Assets(btcAddress) {
    return await listMrc20AssetsService(btcAddress);
  },
  async listMvcFtAssets(mvcAddress) {
    return await listMvcFtAssetsService(mvcAddress);
  },
};

function normalizeDecimal(value: unknown): number {
  const decimal = Number(value);
  if (!Number.isInteger(decimal) || decimal < 0) return 0;
  return decimal;
}

function toAtomicString(value: unknown): string {
  const text = String(value ?? '').trim();
  if (/^-?\d+$/.test(text)) return text;
  return '0';
}

function toAtomicBigint(value: unknown): bigint {
  return BigInt(toAtomicString(value));
}

function formatAtomicValue(raw: bigint, decimal: number): string {
  const normalizedDecimal = normalizeDecimal(decimal);
  const sign = raw < 0n ? '-' : '';
  const absolute = raw < 0n ? -raw : raw;
  if (normalizedDecimal === 0) {
    return `${sign}${absolute.toString()}`;
  }
  const base = 10n ** BigInt(normalizedDecimal);
  const integerPart = absolute / base;
  const fractionPart = absolute % base;
  return `${sign}${integerPart.toString()}.${fractionPart.toString().padStart(normalizedDecimal, '0')}`;
}

function formatNativeValue(value: unknown): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return '0';
  const satoshis = Math.round(numeric * SATOSHIS_PER_UNIT);
  return formatAtomicValue(BigInt(satoshis), 8);
}

function formatDisplayValue(value: unknown, decimal: number): string {
  const normalizedDecimal = normalizeDecimal(decimal);
  return new Decimal(String(value ?? '0'))
    .toDecimalPlaces(normalizedDecimal)
    .toFixed(normalizedDecimal);
}

function mapNativeAssets(balances: NativeBalances): NativeAsset[] {
  return [
    {
      kind: 'native',
      chain: 'btc',
      symbol: 'BTC',
      address: String(balances.btc?.address || ''),
      balance: {
        confirmed: formatNativeValue(balances.btc?.value),
        display: formatNativeValue(balances.btc?.value),
      },
    },
    {
      kind: 'native',
      chain: 'doge',
      symbol: 'DOGE',
      address: String(balances.doge?.address || ''),
      balance: {
        confirmed: formatNativeValue(balances.doge?.value),
        display: formatNativeValue(balances.doge?.value),
      },
    },
    {
      kind: 'native',
      chain: 'mvc',
      symbol: 'SPACE',
      address: String(balances.mvc?.address || ''),
      balance: {
        confirmed: formatNativeValue(balances.mvc?.value),
        display: formatNativeValue(balances.mvc?.value),
      },
    },
  ];
}

function mapMrc20Assets(rows: Mrc20AssetInput[]): Mrc20Asset[] {
  return rows.map((row) => {
    const decimal = normalizeDecimal(row.decimal);
    const confirmed = formatDisplayValue(row.balance?.confirmed, decimal);
    const unconfirmed = formatDisplayValue(row.balance?.unconfirmed, decimal);
    const pendingIn = formatDisplayValue(row.balance?.pendingIn, decimal);
    const pendingOut = formatDisplayValue(row.balance?.pendingOut, decimal);
    const display = new Decimal(confirmed).add(pendingIn).sub(pendingOut).toFixed(decimal);
    return {
      kind: 'mrc20',
      chain: 'btc',
      symbol: String(row.symbol || ''),
      tokenName: String(row.tokenName || row.symbol || ''),
      mrc20Id: String(row.mrc20Id || ''),
      address: String(row.address || ''),
      decimal,
      icon: row.icon,
      balance: {
        confirmed,
        unconfirmed,
        pendingIn,
        pendingOut,
        display,
      },
    };
  });
}

function mapMvcFtAssets(rows: MvcFtAssetInput[]): MvcFtAsset[] {
  return rows.map((row) => {
    const decimal = normalizeDecimal(row.decimal);
    const confirmed = formatDisplayValue(row.balance?.confirmed, decimal);
    const unconfirmed = formatDisplayValue(row.balance?.unconfirmed, decimal);
    const display = new Decimal(confirmed).add(unconfirmed).toFixed(decimal);
    return {
      kind: 'mvc-ft',
      chain: 'mvc',
      symbol: String(row.symbol || ''),
      tokenName: String(row.tokenName || row.symbol || ''),
      genesis: String(row.genesis || ''),
      codeHash: String(row.codeHash || ''),
      sensibleId: row.sensibleId,
      address: String(row.address || ''),
      decimal,
      icon: row.icon,
      balance: {
        confirmed,
        unconfirmed,
        display,
      },
    };
  });
}

export async function getMetabotWalletAssets(
  store: MetabotStore,
  input: MetabotWalletAssetInput,
  deps: MetabotWalletAssetServiceDeps = defaultDeps,
): Promise<MetabotWalletAssets> {
  if (!input || !Number.isInteger(input.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }

  const summary = getMetabotAccountAddresses(store, input.metabotId);
  const [nativeBalances, mrc20Assets, mvcFtAssets] = await Promise.all([
    deps.getNativeBalances(summary),
    deps.listMrc20Assets(summary.btc_address).catch((error) => {
      if (isTokenNoDataError(error)) return [];
      throw error;
    }),
    deps.listMvcFtAssets(summary.mvc_address).catch((error) => {
      if (isTokenNoDataError(error)) return [];
      throw error;
    }),
  ]);

  return {
    metabotId: summary.metabot_id,
    nativeAssets: mapNativeAssets(nativeBalances),
    mrc20Assets: mapMrc20Assets(mrc20Assets),
    mvcFtAssets: mapMvcFtAssets(mvcFtAssets),
  };
}
