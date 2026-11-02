import type { MetabotStore } from '../metabotStore';
import { buildMvcNftTransferRawTx, buildMvcNftTradeRawTx, type MvcNftSellUtxoRef } from './walletRawTxService';
import { isRetryableMvcBroadcastError, resolveBroadcastTxResult } from '../libs/mvcSpend';
import { freshGetUrlAndInit } from './freshFetch';

const METALET_HOST = 'https://www.metalet.space';
const NET = 'livenet';
const RETRYABLE_MVC_NFT_BUILD_ATTEMPTS = 3;
const RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS = 750;
// NftManager floors the sell price at 22000 sats; validate on this side with
// the same message so callers fail before any UTXO work.
export const MVC_NFT_MIN_SELL_PRICE_SATS = 22000;

export interface MvcNftItem {
  tokenIndex: string;
  name: string;
  satoshi: number;
  txId: string;
  outputIndex: number;
  height: number;
  icon?: string;
  /** https direct artwork link (wallet-api v4 utxo-list `imgUrl`). */
  imgUrl?: string;
  metaTxId?: string;
}

export interface MvcNftCollection {
  genesis: string;
  codeHash: string;
  sensibleId?: string;
  seriesName: string;
  tokenSupply?: number;
  count: number;
  items: MvcNftItem[];
}

export interface MvcNftBalance {
  address: string;
  count: number;
  collections: MvcNftCollection[];
}

interface RawMvcNftSummaryRow {
  codeHash?: string;
  genesis?: string;
  sensibleId?: string;
  tokenSupply?: number | string;
  count?: number | string;
  seriesName?: string;
}

export interface RawMvcNftUtxoRow {
  address?: string;
  txId?: string;
  txIndex?: number | string;
  codeHash?: string;
  genesis?: string;
  sensibleId?: string;
  height?: number | string;
  metaTxId?: string;
  tokenSupply?: number | string;
  tokenIndex?: number | string;
  satoshi?: number | string;
  satoshiString?: string;
  flag?: string;
  name?: string;
  icon?: string;
  imgUrl?: string;
  seriesName?: string;
  /** Series issuer when wallet-api knows it ("--"/empty for legacy series; live wire 2026-11-02). */
  issuerAddress?: string;
  issuerName?: string;
}

/**
 * wallet-api sell utxo row (live wire shape, mainnet 2026-10-28): camelCase
 * keys, NO outputIndex and NO ask price. The outputIndex is derivable — the
 * NftManager always appends the sell-contract output first (createSellTx
 * adds the contract output before change/op_return), so it sits at vout 0;
 * cross-checked on-chain against open-api-mvc /contract/nft/sell/address/
 * <addr>/utxo (txIndex=0) during the S2 live-fire drill. The ask price is
 * embedded in the sell contract script — the cancel/buy signer resolves it
 * on-chain, so this listing view carries the contract utxo ref + NFT facts.
 */
interface RawMvcNftSellUtxoRow {
  address?: string;
  txId?: string;
  txIndex?: number | string;
  codeHash?: string;
  genesis?: string;
  tokenIndex?: number | string;
  sensibleId?: string;
  satoshi?: number | string;
  satoshiString?: string;
  height?: number | string;
  metaTxId?: string;
  tokenSupply?: number | string;
  flag?: string;
  name?: string;
  icon?: string;
  seriesName?: string;
  // Legacy PascalCase fallbacks (open-api-mvc rows use txid/txIndex/address).
  TxId?: string;
  TxIndex?: number | string;
  Address?: string;
  ContractAddress?: string;
  Price?: number | string;
  IsReady?: boolean | string | number;
}

interface MvcNftServiceDeps {
  fetchCount: (address: string) => Promise<number>;
  fetchSummaryList: (address: string) => Promise<RawMvcNftSummaryRow[]>;
  fetchUtxoList: (address: string) => Promise<RawMvcNftUtxoRow[]>;
  fetchSellUtxoList: (address: string) => Promise<RawMvcNftSellUtxoRow[]>;
  buildRawTx: typeof buildMvcNftTransferRawTx;
  buildTradeRawTx: typeof buildMvcNftTradeRawTx;
  broadcastTx: (rawTx: string) => Promise<string>;
}

function normalizeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) return 0;
  return count;
}

function normalizeTokenIndex(value: unknown): string {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? text : '';
}

function normalizeOutpointIndex(value: unknown): number {
  const index = Number(value);
  if (!Number.isInteger(index) || index < 0) return 0;
  return index;
}

function normalizeHeight(value: unknown): number {
  const height = Number(value);
  if (!Number.isInteger(height) || height < 0) return 0;
  return height;
}

function normalizeSatoshi(value: unknown): number {
  const satoshis = Number(value);
  if (!Number.isFinite(satoshis) || satoshis < 0) return 0;
  return Math.round(satoshis);
}

function normalizeIcon(value: unknown): string | undefined {
  const icon = String(value ?? '').trim();
  return icon || undefined;
}

/**
 * v4 utxo-list `imgUrl` is an https direct artwork link (compress variant on
 * metalet.space). Only https survives: the value flows into chat cards that
 * render it as an <img> source.
 */
function normalizeImgUrl(value: unknown): string | undefined {
  const url = String(value ?? '').trim();
  if (!url || !/^https:\/\//i.test(url) || /\s/.test(url)) return undefined;
  return url.slice(0, 512);
}

async function fetchJson<T>(url: string): Promise<T> {
  const freshRequest = freshGetUrlAndInit(url);
  const response = await fetch(freshRequest.url, freshRequest.init);
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

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const defaultDeps: MvcNftServiceDeps = {
  fetchCount: async (address) => {
    const response = await fetchJson<{ count?: number | string }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/count?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return normalizeCount(response?.count);
  },
  fetchSummaryList: async (address) => {
    const response = await fetchJson<{ list?: RawMvcNftSummaryRow[] }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/summary-list?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return Array.isArray(response?.list) ? response.list : [];
  },
  fetchUtxoList: async (address) => {
    const all: RawMvcNftUtxoRow[] = [];
    let flag: string | undefined;
    // The endpoint echoes flag "0" on the last page — a truthy string, so an
    // unguarded `if (!flag) break` would loop forever on it (the MVC utxo
    // endpoints return an empty page for flag=0; this one repeats the list).
    // Treat "0" (or an unchanged cursor) as the end, plus a hard page cap.
    for (let page = 0; page < 50; page += 1) {
      const params = new URLSearchParams({ net: NET, address });
      if (flag) params.set('flag', flag);
      const previousFlag = flag;
      const response = await fetchJson<{ list?: RawMvcNftUtxoRow[] }>(
        `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/utxo-list?${params}`,
      );
      const list = Array.isArray(response?.list) ? response.list : [];
      if (!list.length) break;
      all.push(...list);
      const nextFlag = typeof list[list.length - 1]?.flag === 'string' ? String(list[list.length - 1].flag) : undefined;
      if (!nextFlag || nextFlag === '0' || nextFlag === previousFlag) break;
      flag = nextFlag;
    }
    return all;
  },
  buildRawTx: buildMvcNftTransferRawTx,
  buildTradeRawTx: buildMvcNftTradeRawTx,
  fetchSellUtxoList: async (address) => {
    const response = await fetchJson<{ list?: RawMvcNftSellUtxoRow[] }>(
      `${METALET_HOST}/wallet-api/v4/mvc/address/contract/nft/sell/utxo-list?net=${NET}&address=${encodeURIComponent(address)}`,
    );
    return Array.isArray(response?.list) ? response.list : [];
  },
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
}

/**
 * The default v4 utxo-list fetcher, exposed for the NftCard heal service
 * (same pagination guards; read-only).
 */
export const fetchMvcNftUtxoListByAddress = defaultDeps.fetchUtxoList;

/**
 * Aggregate one address's NFT holdings from the wallet-api read endpoints:
 * utxo-list carries per-item facts (tokenIndex/name/satoshi), summary-list
 * carries series facts (seriesName/tokenSupply per genesis) — summary-list is
 * NOT filtered by genesis on the wire, so group by genesis locally. The count
 * endpoint is the address-level total used for cross-checking the grouped sum.
 */
export async function getMvcNftBalance(
  address: string,
  deps: Pick<MvcNftServiceDeps, 'fetchCount' | 'fetchSummaryList' | 'fetchUtxoList'> = defaultDeps,
): Promise<MvcNftBalance> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const [count, summaries, utxoRows] = await Promise.all([
    deps.fetchCount(address),
    deps.fetchSummaryList(address),
    deps.fetchUtxoList(address),
  ]);

  const summaryByGenesis = new Map<string, RawMvcNftSummaryRow>();
  for (const row of summaries) {
    const genesis = String(row.genesis || '').trim();
    if (genesis) summaryByGenesis.set(genesis, row);
  }

  const groups = new Map<string, MvcNftCollection>();
  for (const row of utxoRows) {
    const genesis = String(row.genesis || '').trim();
    const codeHash = String(row.codeHash || '').trim();
    const tokenIndex = normalizeTokenIndex(row.tokenIndex);
    if (!genesis || !tokenIndex) continue;
    const summary = summaryByGenesis.get(genesis);
    let collection = groups.get(genesis);
    if (!collection) {
      collection = {
        genesis,
        codeHash: codeHash || String(summary?.codeHash || ''),
        sensibleId: (row.sensibleId || summary?.sensibleId) ? String(row.sensibleId || summary?.sensibleId) : undefined,
        seriesName: String(summary?.seriesName || row.seriesName || ''),
        tokenSupply: summary?.tokenSupply != null ? normalizeCount(summary.tokenSupply) : undefined,
        count: 0,
        items: [],
      };
      groups.set(genesis, collection);
    }
    if (!collection.codeHash && codeHash) collection.codeHash = codeHash;
    if (!collection.seriesName && row.seriesName) collection.seriesName = String(row.seriesName);
    collection.items.push({
      tokenIndex,
      name: String(row.name || ''),
      satoshi: normalizeSatoshi(row.satoshi ?? row.satoshiString),
      txId: String(row.txId || ''),
      outputIndex: normalizeOutpointIndex(row.txIndex),
      height: normalizeHeight(row.height),
      icon: normalizeIcon(row.icon),
      imgUrl: normalizeImgUrl(row.imgUrl),
      metaTxId: row.metaTxId ? String(row.metaTxId) : undefined,
    });
  }

  const collections = Array.from(groups.values()).map((collection) => {
    collection.items.sort((a, b) => (Number(a.tokenIndex) || 0) - (Number(b.tokenIndex) || 0));
    collection.count = collection.items.length;
    return collection;
  }).sort((a, b) => a.genesis.localeCompare(b.genesis));

  return {
    address,
    count: count > 0 ? count : collections.reduce((total, collection) => total + collection.count, 0),
    collections,
  };
}

export async function executeMvcNftTransfer(
  store: MetabotStore,
  input: {
    metabotId: number;
    genesis: string;
    codehash: string;
    tokenIndex: string;
    toAddress: string;
    feeRate: number;
  },
  deps: MvcNftServiceDeps = defaultDeps,
): Promise<{ txId: string; rawTx: string }> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (!input?.genesis?.trim() || !input?.codehash?.trim()) {
    throw new Error('genesis and codehash are required');
  }
  const tokenIndex = normalizeTokenIndex(input.tokenIndex);
  if (!tokenIndex) throw new Error('tokenIndex must be a positive integer string');
  if (!input?.toAddress?.trim()) throw new Error('toAddress is required');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  const excludedOutpoints = new Set<string>();
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= RETRYABLE_MVC_NFT_BUILD_ATTEMPTS; attempt += 1) {
    const raw = await deps.buildRawTx(store, {
      metabotId: input.metabotId,
      genesis: input.genesis.trim(),
      codehash: input.codehash.trim(),
      tokenIndex,
      toAddress: input.toAddress.trim(),
      feeRate: input.feeRate,
      excludeOutpoints: Array.from(excludedOutpoints),
    });

    try {
      const txId = await deps.broadcastTx(raw.raw_tx);
      return { txId, rawTx: raw.raw_tx };
    } catch (error) {
      lastError = error;
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_NFT_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const outpoint of raw.spent_outpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS);
        continue;
      }
      throw error;
    }
  }

  throw new Error(getErrorMessage(lastError ?? 'MVC NFT transfer failed'));
}

export interface MvcNftSellOrder {
  address: string;
  contractAddress?: string;
  /** txid of the tx carrying the sell contract utxo. */
  txId: string;
  outputIndex: number;
  codeHash?: string;
  genesis?: string;
  tokenIndex?: string;
  sensibleId?: string;
  /** Ask price in satoshis (the amount a buyer pays for the token). */
  priceSats?: number;
  satoshis?: number;
  isReady?: boolean;
  height?: number;
  name?: string;
  seriesName?: string;
  icon?: string;
}

export interface MvcNftSellOrders {
  address: string;
  count: number;
  orders: MvcNftSellOrder[];
}

export function normalizeMvcNftSellOrderRow(row: RawMvcNftSellUtxoRow): MvcNftSellOrder | null {
  const txId = String(row.txId ?? row.TxId ?? '').trim();
  const rawIndex = row.txIndex ?? row.TxIndex;
  // The wallet-api sell view carries no output index: the NftManager always
  // places the sell-contract output at vout 0 (see interface doc).
  const outputIndex = rawIndex != null ? normalizeOutpointIndex(rawIndex) : 0;
  if (!/^[0-9a-fA-F]{64}$/.test(txId)) return null;
  const price = Number(row.Price);
  const satoshis = Number(row.satoshi ?? row.satoshiString);
  const tokenIndex = normalizeTokenIndex(row.tokenIndex);
  const height = normalizeHeight(row.height);
  const isReadyRaw = row.IsReady;
  const order: MvcNftSellOrder = {
    address: String(row.address ?? row.Address ?? '').trim(),
    contractAddress: String(row.ContractAddress ?? '').trim() || undefined,
    txId,
    outputIndex,
    codeHash: String(row.codeHash ?? '').trim() || undefined,
    genesis: String(row.genesis ?? '').trim() || undefined,
    tokenIndex: tokenIndex || undefined,
    sensibleId: String(row.sensibleId ?? '').trim() || undefined,
    priceSats: Number.isFinite(price) && price > 0 ? Math.round(price) : undefined,
    satoshis: Number.isFinite(satoshis) && satoshis > 0 ? Math.round(satoshis) : undefined,
    height: height > 0 ? height : undefined,
    name: String(row.name ?? '').trim() || undefined,
    seriesName: String(row.seriesName ?? '').trim() || undefined,
    icon: normalizeIcon(row.icon),
  };
  if (typeof isReadyRaw === 'boolean') order.isReady = isReadyRaw;
  else if (isReadyRaw === 1 || String(isReadyRaw ?? '').toLowerCase() === 'true') order.isReady = true;
  else if (isReadyRaw != null) order.isReady = false;
  return order;
}

/**
 * List the on-chain sell orders (sell contract utxos) held by one address via
 * the wallet-api sell utxo-list endpoint. This is the discovery side of the
 * trade flow: buyers and sellers read orders here, then feed the row's txId +
 * outputIndex (+ sellerAddress, price) into cancelSell/buy as sellUtxo.
 */
export async function getMvcNftSellOrders(
  address: string,
  deps: Pick<MvcNftServiceDeps, 'fetchSellUtxoList'> = defaultDeps,
): Promise<MvcNftSellOrders> {
  if (!address || typeof address !== 'string') throw new Error('address is required');
  const rows = await deps.fetchSellUtxoList(address);
  const orders: MvcNftSellOrder[] = [];
  for (const row of rows) {
    const order = normalizeMvcNftSellOrderRow(row);
    if (order) orders.push(order);
  }
  return { address, count: orders.length, orders };
}

export type MvcNftTradeAction = 'sell' | 'cancelSell' | 'buy';

export interface MvcNftTradeInput {
  metabotId: number;
  action: MvcNftTradeAction;
  genesis: string;
  codehash: string;
  tokenIndex: string;
  /** sell only: ask price in satoshis (>= MVC_NFT_MIN_SELL_PRICE_SATS). */
  priceSats?: number;
  /** cancelSell/buy only: on-chain sell order reference. */
  sellUtxo?: MvcNftSellUtxoRef;
  feeRate: number;
}

export interface MvcNftTradeResult {
  action: MvcNftTradeAction;
  /** Stage-2 (final state) tx: the listing, the cancel, or the purchase. */
  txId: string;
  rawTx: string;
  /** Stage-1 tx (sell contract funding / unlock check), broadcast first. */
  fundingTxId: string;
  fundingRawTx: string;
}

/**
 * Run one NftManager trade operation (sell/cancelSell/buy) through the
 * subprocess worker. Every operation mints two chained txs: stage 1 (sell:
 * contract funding; cancel/buy: unlock check) must confirm-index before stage
 * 2, which carries the final on-chain state. Broadcast policy:
 *  - stage-1 retryable failure: rebuild the whole pair excluding the spent
 *    wallet utxos (same loop as transfers);
 *  - stage-2 retryable failure: re-broadcast the SAME stage-2 hex after a
 *    short delay (its inputs are stage-1 outputs; a rebuild would orphan the
 *    already-broadcast stage-1 tx);
 *  - stage-2 hard failure: stage 1 may already be on chain, so the error
 *    carries the funding txid plus the preserved stage-2 hex for manual
 *    recovery instead of silently rebuilding.
 */
export async function executeMvcNftTrade(
  store: MetabotStore,
  input: MvcNftTradeInput,
  deps: MvcNftServiceDeps = defaultDeps,
): Promise<MvcNftTradeResult> {
  if (!Number.isInteger(input?.metabotId) || input.metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  if (input.action !== 'sell' && input.action !== 'cancelSell' && input.action !== 'buy') {
    throw new Error('action must be sell, cancelSell, or buy');
  }
  if (!input?.genesis?.trim() || !input?.codehash?.trim()) {
    throw new Error('genesis and codehash are required');
  }
  const tokenIndex = normalizeTokenIndex(input.tokenIndex);
  if (!tokenIndex) throw new Error('tokenIndex must be a positive integer string');
  if (!Number.isFinite(input?.feeRate) || input.feeRate <= 0) throw new Error('feeRate must be positive');

  let priceSats: number | undefined;
  if (input.action === 'sell') {
    priceSats = Number(input.priceSats);
    if (!Number.isInteger(priceSats) || priceSats <= 0) {
      throw new Error('priceSats must be a positive integer for sell');
    }
    if (priceSats < MVC_NFT_MIN_SELL_PRICE_SATS) {
      throw new Error(`Selling Price must be greater than or equals to ${MVC_NFT_MIN_SELL_PRICE_SATS} satoshis. 销售价格最低为${MVC_NFT_MIN_SELL_PRICE_SATS}聪。`);
    }
  }

  let sellUtxo: MvcNftSellUtxoRef | undefined;
  if (input.action !== 'sell' && input.sellUtxo != null) {
    const txId = String(input.sellUtxo.txId || '').trim();
    const outputIndex = Number(input.sellUtxo.outputIndex);
    if (!/^[0-9a-fA-F]{64}$/.test(txId) || !Number.isInteger(outputIndex) || outputIndex < 0) {
      throw new Error('sellUtxo.txId (64 hex) and sellUtxo.outputIndex (integer >= 0) are required');
    }
    sellUtxo = {
      txId,
      outputIndex,
      sellerAddress: input.sellUtxo.sellerAddress?.trim() || undefined,
      price: Number.isFinite(Number(input.sellUtxo.price)) && Number(input.sellUtxo.price) > 0
        ? Math.round(Number(input.sellUtxo.price))
        : undefined,
    };
  }

  const excludedOutpoints = new Set<string>();
  let buildParams = {
    metabotId: input.metabotId,
    genesis: input.genesis.trim(),
    codehash: input.codehash.trim(),
    tokenIndex,
    priceSats,
    sellUtxo,
    feeRate: input.feeRate,
    excludeOutpoints: [] as string[],
  };

  for (let attempt = 1; attempt <= RETRYABLE_MVC_NFT_BUILD_ATTEMPTS; attempt += 1) {
    buildParams = {
      ...buildParams,
      excludeOutpoints: Array.from(excludedOutpoints),
    };
    const built = await deps.buildTradeRawTx(store, { action: input.action, ...buildParams });

    try {
      await deps.broadcastTx(built.funding_raw_tx);
    } catch (error) {
      const message = getErrorMessage(error);
      if (attempt < RETRYABLE_MVC_NFT_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
        for (const outpoint of built.funding_spent_outpoints || []) {
          excludedOutpoints.add(String(outpoint).toLowerCase());
        }
        await sleep(RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS);
        continue;
      }
      throw error;
    }

    for (let stage2Attempt = 1; stage2Attempt <= RETRYABLE_MVC_NFT_BUILD_ATTEMPTS; stage2Attempt += 1) {
      try {
        await deps.broadcastTx(built.raw_tx);
        return {
          action: input.action,
          txId: built.txid,
          rawTx: built.raw_tx,
          fundingTxId: built.funding_txid,
          fundingRawTx: built.funding_raw_tx,
        };
      } catch (error) {
        const message = getErrorMessage(error);
        if (stage2Attempt < RETRYABLE_MVC_NFT_BUILD_ATTEMPTS && isRetryableMvcBroadcastError(message)) {
          await sleep(RETRYABLE_MVC_NFT_BROADCAST_DELAY_MS);
          continue;
        }
        throw new Error(
          `${message} [stage-1 tx ${built.funding_txid} is already broadcast; stage-2 raw tx preserved for manual recovery: ${built.raw_tx}]`,
        );
      }
    }
  }

  throw new Error('MVC NFT trade failed after retries');
}
