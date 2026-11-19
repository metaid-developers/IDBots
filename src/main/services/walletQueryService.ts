/**
 * Wallet Query Service (R1)
 *
 * UTXO-sum balance snapshots for MetaBot wallet addresses, per the wallet
 * tools requirement: MVC/DOGE walk the Metalet `wallet-api/v4/<chain>/address
 * /utxo-list` pages (flag pagination) and sum `value` (height <= 0 is mempool
 * / unconfirmed); BTC uses `wallet-api/v3/address/btc-utxo?unconfirmed=1`
 * (item `confirmed !== false` is confirmed). Snapshot = confirmed /
 * unconfirmed / total in satoshis.
 *
 * Also owns the R3 helper `appendMvcBalanceHint`: when a chain-write error
 * looks like a funding failure, append the bot's current MVC balance so the
 * chair can diagnose the root cause from one message.
 */

import type { MetabotStore } from '../metabotStore';
import { getMetabotAccountSummary } from './metabotAccountService';
import { freshGetUrlAndInit } from './freshFetch';
import { BTC_MIN_SPENDABLE_SATS } from './btcSpendPolicy';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const SATOSHI_PER_UNIT = 100_000_000;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
// Guard against a provider pagination loop; 250 pages × 100 UTXOs is far
// beyond any wallet this app manages.
const MAX_UTXO_PAGES = 250;
// Polite concurrency for batch queries (AC7: 18 bots × 3 chains < 10s).
const BATCH_CONCURRENCY = 8;

export type WalletQueryChain = 'mvc' | 'btc' | 'doge';

export const WALLET_QUERY_CHAINS: WalletQueryChain[] = ['mvc', 'btc', 'doge'];

export function normalizeWalletQueryChain(value: unknown): WalletQueryChain | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (raw === 'space') return 'mvc';
  return (WALLET_QUERY_CHAINS as string[]).includes(raw) ? (raw as WalletQueryChain) : null;
}

export interface WalletBalanceSnapshot {
  chain: WalletQueryChain;
  address: string;
  unit: 'SPACE' | 'BTC' | 'DOGE';
  confirmed_sats: number;
  unconfirmed_sats: number;
  total_sats: number;
  utxo_count: number;
  /**
   * BTC only: sats locked in sub-1000-sat UTXOs (MRC20 / Pin inscription
   * carriers per btcSpendPolicy). These are counted in total_sats but are
   * NOT plain-spendable — the send-side carrier floor refuses them as
   * inputs. Absent on MVC/DOGE snapshots.
   */
  carrier_locked_sats?: number;
}

export interface MetabotWalletBalanceEntry {
  metabot_id: number;
  name: string;
  addresses: { mvc: string; btc: string; doge: string };
  balances: Partial<Record<WalletQueryChain, WalletBalanceSnapshot>>;
  errors: Partial<Record<WalletQueryChain, string>>;
}

export interface WalletBalanceQueryResult {
  entries: MetabotWalletBalanceEntry[];
  queried_at: string;
}

interface WalletQueryOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function walletFetchImpl(options: WalletQueryOptions): typeof fetch {
  return options.fetchImpl ?? fetch;
}

async function fetchMetaletJson<T>(
  url: string,
  options: WalletQueryOptions,
): Promise<{ code: number; message?: string; data: T }> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  try {
    const fresh = freshGetUrlAndInit(url, { signal: controller.signal });
    const res = await walletFetchImpl(options)(fresh.url, fresh.init);
    if (!res.ok) {
      throw new Error(`metalet api http ${res.status} for ${url}`);
    }
    return (await res.json()) as { code: number; message?: string; data: T };
  } finally {
    clearTimeout(timer);
  }
}

interface V4UtxoItem {
  txid?: string;
  outIndex?: number;
  value?: number;
  height?: number;
  flag?: string;
}

/** MVC/DOGE: walk utxo-list pages (flag pagination) and sum `value`. */
async function fetchV4UtxoBalanceSum(
  chain: 'mvc' | 'doge',
  address: string,
  options: WalletQueryOptions,
): Promise<Omit<WalletBalanceSnapshot, 'chain' | 'address' | 'unit'>> {
  let flag: string | undefined;
  let confirmed = 0;
  let unconfirmed = 0;
  let utxoCount = 0;
  for (let page = 0; page < MAX_UTXO_PAGES; page++) {
    const params = new URLSearchParams({ address, net: NET });
    if (flag) params.set('flag', flag);
    const url = `${METALET_HOST}/wallet-api/v4/${chain}/address/utxo-list?${params}`;
    const json = await fetchMetaletJson<{ list?: V4UtxoItem[] }>(url, options);
    if (json.code !== 0) {
      throw new Error(json.message || `${chain} utxo-list failed`);
    }
    const list = json.data?.list ?? [];
    if (list.length === 0) break;
    for (const utxo of list) {
      const value = Number(utxo?.value ?? 0);
      if (!Number.isFinite(value) || value <= 0) continue;
      // height <= 0 (typically -1) means the UTXO is still in mempool.
      if (Number(utxo?.height) > 0) confirmed += value;
      else unconfirmed += value;
      utxoCount++;
    }
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return {
    confirmed_sats: confirmed,
    unconfirmed_sats: unconfirmed,
    total_sats: confirmed + unconfirmed,
    utxo_count: utxoCount,
  };
}

interface BtcUtxoItem {
  txId?: string;
  txid?: string;
  outputIndex?: number;
  vout?: number;
  satoshis?: number;
  value?: number;
  confirmed?: boolean;
}

/** BTC: v3/address/btc-utxo with unconfirmed=1; `confirmed !== false` is confirmed. */
async function fetchBtcUtxoBalanceSum(
  address: string,
  options: WalletQueryOptions,
): Promise<Omit<WalletBalanceSnapshot, 'chain' | 'address' | 'unit'>> {
  const url =
    `${METALET_HOST}/wallet-api/v3/address/btc-utxo?net=${NET}` +
    `&address=${encodeURIComponent(address)}&unconfirmed=1`;
  const json = await fetchMetaletJson<BtcUtxoItem[] | { list?: BtcUtxoItem[] }>(url, options);
  if (json.code !== 0) {
    throw new Error(json.message || 'btc utxo-list failed');
  }
  const raw = json.data;
  const list = Array.isArray(raw) ? raw : raw?.list ?? [];
  let confirmed = 0;
  let unconfirmed = 0;
  let carrierLocked = 0;
  let utxoCount = 0;
  for (const utxo of list) {
    const value = Number(utxo?.satoshis ?? utxo?.value ?? 0);
    if (!Number.isFinite(value) || value <= 0) continue;
    if (utxo?.confirmed !== false) confirmed += value;
    else unconfirmed += value;
    // Carrier protection mirrors the send side (btcSpendPolicy): sub-1000-sat
    // UTXOs may carry MRC20 / Pin inscriptions and are not plain-spendable.
    // Reporting them separately keeps the agent's spendable math honest —
    // the raw total alone overstates what a transfer can actually move.
    if (value < BTC_MIN_SPENDABLE_SATS) carrierLocked += value;
    utxoCount++;
  }
  return {
    confirmed_sats: confirmed,
    unconfirmed_sats: unconfirmed,
    total_sats: confirmed + unconfirmed,
    utxo_count: utxoCount,
    carrier_locked_sats: carrierLocked,
  };
}

const CHAIN_UNITS: Record<WalletQueryChain, 'SPACE' | 'BTC' | 'DOGE'> = {
  mvc: 'SPACE',
  btc: 'BTC',
  doge: 'DOGE',
};

/** One address, one chain: UTXO-sum snapshot with confirmed/unconfirmed split. */
export async function getWalletBalanceSnapshot(
  chain: WalletQueryChain,
  address: string,
  options: WalletQueryOptions = {},
): Promise<WalletBalanceSnapshot> {
  const trimmed = String(address || '').trim();
  if (!trimmed) throw new Error('address is required');
  const sum =
    chain === 'btc'
      ? await fetchBtcUtxoBalanceSum(trimmed, options)
      : await fetchV4UtxoBalanceSum(chain, trimmed, options);
  return { chain, address: trimmed, unit: CHAIN_UNITS[chain], ...sum };
}

/** Simple bounded-concurrency map (keeps AC7 batch queries polite). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface MetabotBalanceQueryInput {
  metabotIds?: number[];
  chains?: WalletQueryChain[];
}

/**
 * Balance entries for a set of local MetaBots. Each entry carries the bot's
 * three addresses and a snapshot per requested chain; per-chain fetch errors
 * land in `errors` instead of failing the whole batch.
 */
export async function getMetabotWalletBalances(
  store: MetabotStore,
  input: MetabotBalanceQueryInput,
  options: WalletQueryOptions = {},
): Promise<WalletBalanceQueryResult> {
  const metabotIds = Array.isArray(input.metabotIds) ? input.metabotIds : [];
  const chains = (Array.isArray(input.chains) && input.chains.length > 0
    ? input.chains
    : WALLET_QUERY_CHAINS
  ).filter((chain) => WALLET_QUERY_CHAINS.includes(chain));

  const summaries = metabotIds.map((metabotId) => getMetabotAccountSummary(store, metabotId));
  const entries = await mapWithConcurrency(summaries, Math.max(1, Math.ceil(BATCH_CONCURRENCY / chains.length)), async (summary) => {
    const entry: MetabotWalletBalanceEntry = {
      metabot_id: summary.metabot_id,
      name: summary.name,
      addresses: {
        mvc: summary.mvc_address,
        btc: summary.btc_address,
        doge: summary.doge_address,
      },
      balances: {},
      errors: {},
    };
    await Promise.all(
      chains.map(async (chain) => {
        try {
          entry.balances[chain] = await getWalletBalanceSnapshot(
            chain,
            chain === 'btc' ? summary.btc_address : chain === 'doge' ? summary.doge_address : summary.mvc_address,
            options,
          );
        } catch (error) {
          entry.errors[chain] = error instanceof Error ? error.message : String(error);
        }
      }),
    );
    return entry;
  });

  return { entries, queried_at: new Date().toISOString() };
}

const BALANCE_ERROR_PATTERN = /not enough balance|insufficient balance|余额不足|no utxo/i;

/** True when a chain-write/transfer error message is a funding failure. */
export function isBalanceRelatedError(message: string): boolean {
  return BALANCE_ERROR_PATTERN.test(String(message || ''));
}

/**
 * R3: given a balance-related failure message for a bot, append the bot's
 * current MVC balance (`have X sats`) and a `need ~Y sats` figure when the
 * caller can provide one (exact for transfers, estimated for pins). Never
 * throws: balance lookup failures degrade to the original message.
 */
export async function appendMvcBalanceHint(
  store: MetabotStore,
  metabotId: number,
  message: string,
  options: { needSats?: number; needIsEstimate?: boolean; fetchOptions?: WalletQueryOptions } = {},
): Promise<string> {
  const original = String(message || '');
  if (!isBalanceRelatedError(original)) return original;
  let hint: string;
  try {
    const summary = getMetabotAccountSummary(store, metabotId);
    const snapshot = await getWalletBalanceSnapshot('mvc', summary.mvc_address, options.fetchOptions);
    const have = snapshot.total_sats;
    let havePart = `insufficient balance: have ${have} sats (${(have / SATOSHI_PER_UNIT).toFixed(8)} SPACE)`;
    const needSats = Number(options.needSats);
    if (Number.isFinite(needSats) && needSats > 0) {
      havePart += `, need ${options.needIsEstimate === false ? '' : '~'}${Math.ceil(needSats)} sats`;
    }
    hint =
      `${havePart}; confirmed ${snapshot.confirmed_sats} sats / unconfirmed ${snapshot.unconfirmed_sats} sats at ${summary.mvc_address}`;
  } catch {
    return original;
  }
  return `${original} [${hint}]`;
}

/**
 * R3 chokepoint wrapper: run a chain-write operation and, when it fails with
 * a funding error on the MVC network, re-throw the SAME error object with the
 * bot's current MVC balance appended to the message (original `error.data`,
 * e.g. feeAssist diagnostics, is preserved). Non-MVC networks and unrelated
 * errors pass through untouched. `estimateNeedSats` is injected by the host
 * (fee-rate aware); without it the hint reports `have` only.
 */
export async function withMvcBalanceHint<T>(
  store: MetabotStore,
  metabotId: number,
  network: string | undefined,
  run: () => Promise<T>,
  options: { estimateNeedSats?: () => number | undefined; fetchOptions?: WalletQueryOptions } = {},
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const normalizedNetwork = String(network || 'mvc').toLowerCase();
    if (normalizedNetwork !== 'mvc' && normalizedNetwork !== 'space') throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (!isBalanceRelatedError(message)) throw error;
    let needSats: number | undefined;
    try {
      const estimate = options.estimateNeedSats?.();
      if (Number.isFinite(estimate ?? NaN) && (estimate ?? 0) > 0) needSats = estimate;
    } catch {
      needSats = undefined;
    }
    const enhanced = await appendMvcBalanceHint(store, metabotId, message, {
      needSats,
      needIsEstimate: true,
      fetchOptions: options.fetchOptions,
    });
    if (error instanceof Error && enhanced !== message) {
      error.message = enhanced;
    } else if (!(error instanceof Error)) {
      throw new Error(enhanced);
    }
    throw error;
  }
}
