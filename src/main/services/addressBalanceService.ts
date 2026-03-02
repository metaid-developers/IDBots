/**
 * Address Balance Service
 * Fetches balance for MVC, BTC, or DOGE addresses via Metalet public API.
 * For use by other features or Skills.
 */

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000; // 1 unit = 10^8 satoshis

export type BalanceChain = 'mvc' | 'btc' | 'doge';

export interface AddressBalanceResult {
  chain: BalanceChain;
  address: string;
  satoshis: number;
  unit: string; // 'SPACE' | 'BTC' | 'DOGE'
  value: number; // human-readable, e.g. 6.18325658 SPACE
}

interface MetaletResponse<T> {
  code: number;
  message?: string;
  data: T;
}

function satoshiToUnit(satoshis: number): number {
  return satoshis / SATOSHI_PER_UNIT;
}

/**
 * Get balance for an address by chain type.
 *
 * @param chain - 'mvc' | 'btc' | 'doge'
 * @param address - Blockchain address
 * @returns Balance in satoshis and human-readable unit, or throws on API error
 */
export async function getAddressBalance(
  chain: BalanceChain,
  address: string
): Promise<AddressBalanceResult> {
  if (!address || typeof address !== 'string') {
    throw new Error('address is required');
  }

  switch (chain) {
    case 'mvc':
      return getMvcBalance(address);
    case 'btc':
      return getBtcBalance(address);
    case 'doge':
      return getDogeBalance(address);
    default:
      throw new Error(`Unsupported chain: ${chain}`);
  }
}

/** MVC: uses confirmed as available balance (satoshi -> SPACE) */
async function getMvcBalance(address: string): Promise<AddressBalanceResult> {
  const url = `${METALET_HOST}/wallet-api/v4/mvc/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const json = (await res.json()) as MetaletResponse<{
    address: string;
    confirmed: number;
    unconfirmed: number;
    utxoCount: number;
  }>;
  if (json.code !== 0) {
    throw new Error(json.message || 'Failed to fetch MVC balance');
  }
  const satoshis = json.data?.confirmed ?? 0;
  return {
    chain: 'mvc',
    address,
    satoshis,
    unit: 'SPACE',
    value: satoshiToUnit(satoshis),
  };
}

/** BTC: uses balance as available balance (API returns BTC, convert to satoshis for consistency) */
async function getBtcBalance(address: string): Promise<AddressBalanceResult> {
  const url = `${METALET_HOST}/wallet-api/v3/address/btc-balance?net=${NET}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const json = (await res.json()) as MetaletResponse<{
    balance: number; // API returns balance in BTC
  }>;
  if (json.code !== 0) {
    throw new Error(json.message || 'Failed to fetch BTC balance');
  }
  const valueBtc = json.data?.balance ?? 0;
  const satoshis = Math.round(valueBtc * SATOSHI_PER_UNIT);
  return {
    chain: 'btc',
    address,
    satoshis,
    unit: 'BTC',
    value: valueBtc,
  };
}

/** DOGE: uses confirmed as available balance (satoshi -> DOGE) */
async function getDogeBalance(address: string): Promise<AddressBalanceResult> {
  const url = `${METALET_HOST}/wallet-api/v4/doge/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  const json = (await res.json()) as MetaletResponse<{
    address: string;
    confirmed: number;
    unconfirmed: number;
    utxoCount: number;
  }>;
  if (json.code !== 0) {
    throw new Error(json.message || 'Failed to fetch DOGE balance');
  }
  const satoshis = json.data?.confirmed ?? 0;
  return {
    chain: 'doge',
    address,
    satoshis,
    unit: 'DOGE',
    value: satoshiToUnit(satoshis),
  };
}
