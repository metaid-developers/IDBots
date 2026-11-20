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
 * MVC truth layer (2026-11-21 余额读数线): a balance number is only as
 * trustworthy as the indexer behind it. The MVC headline now comes from the
 * SAME aggregate Metalet displays (`balance-info` confirmed + unconfirmed) and
 * is cross-checked against the UTXO-list walk; suspicious reads (sources
 * disagree, wallet looks empty, `deep` requested) escalate to a bounded
 * transaction-history walk (Σ(income − outcome) over `tx-list` pages — the
 * tx-level ground truth) and the snapshot carries a verdict: `ok` or
 * `degraded` with a reason + fixed guidance. A degraded read must never be
 * reported as "wallet is empty / funds are spent" — that claim class caused
 * the 2026-11-20 incident where a lost indexer row made a funded wallet read
 * as 0 (session c3171c2c forensics).
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
// Cross-source tolerance: 1-sat carrier UTXOs are filtered from the UTXO list
// but counted in the balance endpoint's utxoCount, so |index − list| may
// legitimately reach ~1 sat per UTXO plus rounding slack.
const TRUTH_TOLERANCE_BASE_SATS = 1_000;
const TRUTH_TOLERANCE_PER_UTXO_SATS = 2;
// tx-list pages are fixed at 10 rows server-side; the history walk stops at
// 300 pages (~3000 txs) or the tx bound below, whichever comes first.
const MAX_TX_HISTORY_PAGES = 300;
const MAX_TX_HISTORY_TXS = 3_000;
// Cheap probe for the "index says the wallet is empty" case: one page tells
// us whether the address has ANY transaction history (tx-list `total`).
const TX_EMPTY_PROBE_TXS = 10;

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
  /**
   * MVC only: the truth layer's verdict over this read (sources, divergence,
   * history verification). Absent on BTC/DOGE snapshots.
   */
  mvc_truth?: MvcBalanceTruth;
}

export type MvcBalanceVerdict = 'ok' | 'degraded';

export interface MvcBalanceTruth {
  verdict: MvcBalanceVerdict;
  /** Set when degraded: one English sentence explaining what looks wrong. */
  reason?: string;
  /** What Metalet displays: balance-info confirmed + unconfirmed. */
  index_total_sats: number;
  index_confirmed_sats: number;
  index_unconfirmed_sats: number;
  /** Server-reported UTXO count (carriers included) from the balance endpoint. */
  index_utxo_count?: number;
  /** The UTXO list's own view: rows the list actually returned. */
  utxo_listed_sum_sats: number;
  utxo_listed_count: number;
  /** Σ(income − outcome) over the tx history walk, when it ran. */
  history_total_sats?: number;
  history_confirmed_sats?: number;
  history_unconfirmed_sats?: number;
  history_tx_count?: number;
  /** False when the history walk stopped at the bounded bound instead of exhausting. */
  history_complete?: boolean;
  /** Fixed owner-facing instruction the tool renders when degraded. */
  guidance?: string;
}

export interface WalletQueryOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /**
   * MVC only: force the deep transaction-history verification even when the
   * cheap sources agree. Answers "is this number REALLY right?" — the tool
   * exposes it when a balance is disputed or a chain write just failed.
   */
  deep?: boolean;
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

// ── MVC truth layer ──────────────────────────────────────────────────────

interface BalanceInfoPayload {
  address?: string;
  confirmed?: number;
  unconfirmed?: number;
  utxoCount?: number;
}

/** Metalet's aggregate view — the exact number the Metalet wallet UI displays. */
async function fetchMvcBalanceInfo(
  address: string,
  options: WalletQueryOptions,
): Promise<BalanceInfoPayload> {
  const url = `${METALET_HOST}/wallet-api/v4/mvc/address/balance-info?net=${NET}&address=${encodeURIComponent(address)}`;
  const json = await fetchMetaletJson<BalanceInfoPayload>(url, options);
  if (json.code !== 0) {
    throw new Error(json.message || 'mvc balance-info failed');
  }
  return json.data;
}

interface V4TxItem {
  txid?: string;
  income?: number;
  outcome?: number;
  height?: number;
  flag?: string;
}

interface MvcHistorySum {
  total: number;
  confirmed: number;
  unconfirmed: number;
  txCount: number;
  /** False when the walk stopped at the bound instead of exhausting history. */
  complete: boolean;
  /** Server-reported total tx count for the address (when the API provides it). */
  serverTotal?: number;
}

/**
 * Tx-level ground truth: Σ(income − outcome) over the address's tx-list pages.
 * Rows carry per-tx income/outcome aggregates, so no raw decoding is needed.
 * Pages are fixed at 10 rows server-side and paged with the page `flag`
 * (every row echoes its page's flag; passing it back returns the next-older
 * page). `maxTransactions` bounds the walk — when the bound is hit,
 * `complete` stays false and the caller must not treat the sum as absolute.
 */
async function fetchMvcHistoryBalanceSum(
  address: string,
  options: WalletQueryOptions,
  maxTransactions: number,
): Promise<MvcHistorySum> {
  let flag: string | undefined;
  let total = 0;
  let confirmed = 0;
  let unconfirmed = 0;
  let txCount = 0;
  let serverTotal: number | undefined;
  const seenTxids = new Set<string>();
  for (let page = 0; page < MAX_TX_HISTORY_PAGES; page++) {
    const params = new URLSearchParams({ address, net: NET });
    if (flag) params.set('flag', flag);
    const url = `${METALET_HOST}/wallet-api/v4/mvc/address/tx-list?${params}`;
    const json = await fetchMetaletJson<{ list?: V4TxItem[]; total?: number }>(url, options);
    if (json.code !== 0) {
      throw new Error(json.message || 'mvc tx-list failed');
    }
    const list = json.data?.list ?? [];
    if (typeof json.data?.total === 'number') serverTotal = json.data.total;
    if (list.length === 0) {
      return { total, confirmed, unconfirmed, txCount, complete: true, serverTotal };
    }
    for (const item of list) {
      const txid = String(item?.txid ?? '').trim().toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(txid) || seenTxids.has(txid)) continue;
      seenTxids.add(txid);
      const income = Number(item?.income ?? 0);
      const outcome = Number(item?.outcome ?? 0);
      const net = (Number.isFinite(income) ? income : 0) - (Number.isFinite(outcome) ? outcome : 0);
      total += net;
      if (Number(item?.height) > 0) confirmed += net;
      else unconfirmed += net;
      txCount += 1;
      if (txCount >= maxTransactions) break;
    }
    if (txCount >= maxTransactions) {
      return { total, confirmed, unconfirmed, txCount, complete: false, serverTotal };
    }
    const nextFlag = String(list[0]?.flag ?? '').trim();
    if (!nextFlag || nextFlag === flag) {
      return { total, confirmed, unconfirmed, txCount, complete: true, serverTotal };
    }
    flag = nextFlag;
  }
  return { total, confirmed, unconfirmed, txCount, complete: false, serverTotal };
}

function truthToleranceSats(utxoCount: number | undefined): number {
  return TRUTH_TOLERANCE_BASE_SATS + TRUTH_TOLERANCE_PER_UTXO_SATS * Math.max(0, utxoCount ?? 0);
}

const MVC_DEGRADED_GUIDANCE =
  'Do NOT report this wallet as spent-out, empty, or zero: the read path looks unreliable. ' +
  'Cross-check Metalet / an on-chain explorer, tell the owner the indexer reading is suspect, ' +
  'and expect chain writes to fail until the index heals.';

/**
 * One MVC address through the truth layer. Headline = balance-info aggregate
 * (Metalet parity) while the UTXO-list walk agrees; suspicious reads escalate
 * to the bounded history walk and, when the history verdict disagrees
 * materially, the headline switches to the history sum (the on-chain truth)
 * with a degraded verdict explaining the divergence.
 */
export async function resolveMvcBalanceTruth(
  address: string,
  options: WalletQueryOptions = {},
): Promise<WalletBalanceSnapshot> {
  // Plain nullable locals — NOT `{ok} | {error}` unions: this project
  // compiles without `strict`, where boolean-discriminant narrowing under
  // `!x.ok` does not fire (verified: TS 5.9 non-strict). Each source may
  // fail independently; null means "this source did not answer".
  let balanceInfo: BalanceInfoPayload | null = null;
  let balanceInfoError: unknown = null;
  let utxoSum: Omit<WalletBalanceSnapshot, 'chain' | 'address' | 'unit'> | null = null;
  let utxoError: unknown = null;
  try {
    const payload = await fetchMvcBalanceInfo(address, options);
    // A code:0 envelope with missing/non-numeric fields is MALFORMED, not a
    // zero balance: treating it as zero would fabricate an empty wallet
    // (2026-11-20 incident class). Only finite confirmed/unconfirmed count.
    if (Number.isFinite(Number(payload?.confirmed)) && Number.isFinite(Number(payload?.unconfirmed))) {
      balanceInfo = payload;
    } else {
      balanceInfoError = new Error('balance-info response malformed (missing confirmed/unconfirmed)');
    }
  } catch (error) {
    balanceInfoError = error;
  }
  try {
    utxoSum = await fetchV4UtxoBalanceSum('mvc', address, options);
  } catch (error) {
    utxoError = error;
  }

  if (balanceInfo == null && utxoSum == null) {
    const fmt = (error: unknown) => (error instanceof Error ? error.message : String(error));
    throw new Error(`mvc balance unavailable: balance-info ${fmt(balanceInfoError)}; utxo-list ${fmt(utxoError)}`);
  }

  const indexTotal = balanceInfo != null
    ? Math.max(0, Number(balanceInfo.confirmed ?? 0)) + Math.max(0, Number(balanceInfo.unconfirmed ?? 0))
    : null;
  const indexConfirmed = balanceInfo != null ? Math.max(0, Number(balanceInfo.confirmed ?? 0)) : null;
  const indexUnconfirmed = balanceInfo != null ? Math.max(0, Number(balanceInfo.unconfirmed ?? 0)) : null;
  const indexUtxoCount = balanceInfo != null && Number.isFinite(Number(balanceInfo.utxoCount))
    ? Math.max(0, Math.trunc(Number(balanceInfo.utxoCount)))
    : undefined;

  // Headline baseline: the balance endpoint when alive (Metalet parity), the
  // UTXO walk otherwise.
  let confirmed: number;
  let unconfirmed: number;
  let total: number;
  let verdict: MvcBalanceVerdict = 'ok';
  let reason: string | undefined;
  if (balanceInfo != null) {
    confirmed = indexConfirmed!;
    unconfirmed = indexUnconfirmed!;
    total = indexTotal!;
  } else {
    confirmed = utxoSum != null ? utxoSum.confirmed_sats : 0;
    unconfirmed = utxoSum != null ? utxoSum.unconfirmed_sats : 0;
    total = utxoSum != null ? utxoSum.total_sats : 0;
    verdict = 'degraded';
    const fmt = (error: unknown) => (error instanceof Error ? error.message : String(error));
    reason = `balance endpoint unavailable (${fmt(balanceInfoError)}); figures come from the UTXO list walk`;
  }

  // Cross-source suspicion → escalate to the history walk (also on `deep`).
  const listedSum = utxoSum != null ? utxoSum.total_sats : null;
  const listedCount = utxoSum != null ? utxoSum.utxo_count : null;
  const tolerance = truthToleranceSats(indexUtxoCount ?? listedCount ?? 0);
  const zeroWallet = balanceInfo != null && indexTotal === 0 && (indexUtxoCount ?? 0) === 0
    && (utxoSum == null || (utxoSum.total_sats === 0 && utxoSum.utxo_count === 0));
  const sourcesDisagree = balanceInfo != null && utxoSum != null
    && (Math.abs(indexTotal! - utxoSum.total_sats) > tolerance
      || (indexUtxoCount != null && listedCount != null
        && indexUtxoCount - listedCount > 0
        && indexTotal! - utxoSum.total_sats > tolerance));
  const needDeep = options.deep === true || zeroWallet || sourcesDisagree
    || (balanceInfo == null && utxoSum != null && utxoSum.total_sats === 0);

  let history: MvcHistorySum | null = null;
  if (needDeep) {
    try {
      history = await fetchMvcHistoryBalanceSum(
        address,
        options,
        options.deep === true ? MAX_TX_HISTORY_TXS : TX_EMPTY_PROBE_TXS,
      );
    } catch {
      history = null;
    }
  }

  if (history) {
    const historyFields = { total: history.total, confirmed: history.confirmed, unconfirmed: history.unconfirmed };
    const anyHistoryRows = (history.serverTotal ?? history.txCount) > 0;
    if (options.deep === true && !history.complete) {
      // An explicit deep question on a too-large history: report what the
      // walk covered, never claim full verification.
      verdict = 'degraded';
      reason = `transaction history walk stopped at the ${history.txCount}-tx bound ` +
        `(address has ${history.serverTotal ?? history.txCount}+ txs) — the balance could not be fully verified from history`;
    } else if (history.complete && Math.abs(historyFields.total - total) > tolerance) {
      // The index view is provably wrong: headline switches to the history
      // sum (the on-chain truth) and the divergence is spelled out.
      verdict = 'degraded';
      confirmed = historyFields.confirmed;
      unconfirmed = historyFields.unconfirmed;
      total = historyFields.total;
      reason = `indexer balance view (${balanceInfo != null ? indexTotal : listedSum} sats) disagrees with ` +
        `transaction history (${historyFields.total} sats over ${history.txCount} txs) — ` +
        'the address index may be missing rows; the history sum is the on-chain truth';
    } else if (zeroWallet && anyHistoryRows) {
      verdict = 'degraded';
      reason = 'index reports an empty wallet but the address has transaction history ' +
        `(${history.serverTotal ?? history.txCount}+ txs) — the index may be under-reporting; ` +
        'verify before claiming the wallet is empty';
    } else if (zeroWallet) {
      // History agrees the wallet is empty (no history at all): a genuine zero.
      verdict = 'ok';
      reason = undefined;
    } else if (!history.complete && sourcesDisagree) {
      verdict = 'degraded';
      reason = `balance endpoint and UTXO list disagree (index ${indexTotal} vs list ${listedSum} sats) ` +
        `and the history walk stopped at the ${TX_EMPTY_PROBE_TXS}-tx probe bound — unverified`;
    }
  }

  const truth: MvcBalanceTruth = {
    verdict,
    ...(reason ? { reason } : {}),
    index_total_sats: indexTotal ?? listedSum ?? 0,
    index_confirmed_sats: indexConfirmed ?? 0,
    index_unconfirmed_sats: indexUnconfirmed ?? 0,
    ...(indexUtxoCount != null ? { index_utxo_count: indexUtxoCount } : {}),
    utxo_listed_sum_sats: listedSum ?? 0,
    utxo_listed_count: listedCount ?? 0,
    ...(history ? {
      history_total_sats: history.total,
      history_confirmed_sats: history.confirmed,
      history_unconfirmed_sats: history.unconfirmed,
      history_tx_count: history.txCount,
      history_complete: history.complete,
    } : {}),
    ...(verdict === 'degraded' ? { guidance: MVC_DEGRADED_GUIDANCE } : {}),
  };

  return {
    chain: 'mvc',
    address,
    unit: 'SPACE',
    confirmed_sats: confirmed,
    unconfirmed_sats: unconfirmed,
    total_sats: total,
    utxo_count: listedCount ?? 0,
    mvc_truth: truth,
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
  if (chain === 'mvc') {
    // Truth layer: balance-info headline (Metalet parity) + UTXO-list
    // cross-check + bounded history arbitration. BTC/DOGE keep the plain walk.
    return resolveMvcBalanceTruth(trimmed, options);
  }
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
  /** Per-request read options (e.g. MVC deep verification) from the tool. */
  options?: WalletQueryOptions;
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
  const mergedOptions: WalletQueryOptions = { ...input.options, ...options };
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
            mergedOptions,
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
    const truth = snapshot.mvc_truth;
    if (truth?.verdict === 'degraded') {
      // The funding error may be the indexer, not an empty wallet: say so, or
      // the bot will report "funds are gone" on a broken read (2026-11-20).
      hint += `; WARNING the balance read is DEGRADED (${truth.reason || 'read path unreliable'}) — ` +
        'the wallet may NOT actually be empty; do not claim funds are spent/gone';
    }
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
