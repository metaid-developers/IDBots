/**
 * MRC-721 V1.1 atomic-swap orchestration: listing verify, sell, buy, and the
 * local record of listings this client created. Chain reads go through the
 * existing indexer helpers; the partial transaction itself is built by the
 * sell/buy workers.
 */

import { randomBytes } from 'node:crypto';
import { mvc } from 'meta-contract';
import type { MetabotStore } from '../metabotStore';
import type { SqliteStore } from '../sqliteStore';
import {
  getMvcSpendSessionSnapshot,
  recordMvcSpentOutpoints,
} from './mvcSpendSessionState';
import {
  fetchMrc721ItemInfo,
  isMrc721PinId,
  isMvcAddress,
  MRC721_METALET_HOST,
  type Mrc721ItemSummary,
} from './mrc721Service';
import {
  MRC721_ATOMIC_SWAP_SIGHASH,
  MRC721_LISTING_KIND,
  MRC721_LISTING_VERSION,
  MRC721_MIN_SELL_PRICE_SATS,
  MRC721_WALLET_UTXO_FLOOR_SATS,
  assertPartialTxShape,
  buildMrc721AtomicSwapListing,
  loadPartialComposer,
  mrc721ListingError,
  mrc721PriceFloorError,
  normalizeMrc721Outpoint,
  outpointKey,
  verifySellerSignature,
  type Mrc721AtomicSwapListing,
  type Mrc721Outpoint,
} from '../libs/mrc721AtomicSwapTx';

export type { Mrc721AtomicSwapListing, Mrc721Outpoint };
export { MRC721_MIN_SELL_PRICE_SATS, MRC721_ATOMIC_SWAP_SIGHASH };

const NET = 'livenet';
const RECENT_TX_SCAN = 20;

export interface Mrc721ListingVerifyDeps {
  fetchItemInfo?: (pinId: string) => Promise<Mrc721ItemSummary | null>;
  isOutpointUnspent?: (input: { address: string; outpoint: Mrc721Outpoint }) => Promise<boolean>;
  excludedOutpoints?: ReadonlySet<string>;
  nowSeconds?: number;
}

export interface Mrc721SellOrderRecord {
  id: string;
  metabotId: number;
  listing: Mrc721AtomicSwapListing;
  createdAt: number;
}

export interface Mrc721SellOrderView {
  id: string;
  listing: Mrc721AtomicSwapListing;
  status: 'valid' | 'invalid' | 'expired';
  reason?: string;
}

type SellOrderKv = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
};

function ordersKey(metabotId: number): string {
  return `mrc721_sell_orders:${metabotId}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

export function parseMrc721AtomicSwapListing(input: unknown): Mrc721AtomicSwapListing {
  const raw = typeof input === 'string'
    ? (() => {
      try {
        return JSON.parse(input) as unknown;
      } catch {
        throw mrc721ListingError('check 1 (listing)', 'the listing text is not JSON. Paste the seller\'s listing object unchanged.');
      }
    })()
    : input;
  const record = asRecord(raw);
  if (Number(record.version) !== MRC721_LISTING_VERSION || record.kind !== MRC721_LISTING_KIND) {
    throw mrc721ListingError(
      'check 1 (listing)',
      `expected version ${MRC721_LISTING_VERSION} kind "${MRC721_LISTING_KIND}". This is not an MRC-721 atomic-swap listing.`,
    );
  }
  const sellerAddress = String(record.sellerAddress ?? '').trim();
  const buyerAddress = String(record.buyerAddress ?? '').trim();
  if (!isMvcAddress(sellerAddress) || !isMvcAddress(buyerAddress)) {
    throw mrc721ListingError('check 1 (listing)', 'sellerAddress and buyerAddress must be MVC addresses');
  }
  const priceSats = Number(record.priceSats);
  if (!Number.isInteger(priceSats) || priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw mrc721PriceFloorError();
  }
  const sigtype = Number(record.sigtype);
  if (sigtype !== MRC721_ATOMIC_SWAP_SIGHASH) {
    throw mrc721ListingError(
      'check 1 (sigtype)',
      `listing sigtype is ${sigtype}, not SIGHASH_ALL|FORKID|ANYONECANPAY (${MRC721_ATOMIC_SWAP_SIGHASH})`,
    );
  }
  const itemPinId = String(record.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw mrc721ListingError('check 1 (listing)', 'itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  const partialTx = String(record.partialTx ?? '');
  if (!partialTx) {
    throw mrc721ListingError('check 1 (partial tx)', 'partialTx is missing');
  }
  const outpoint = normalizeMrc721Outpoint(record.outpoint);
  const feeRate = Number(record.feeRate);
  const createdAt = Number(record.createdAt);
  const expiresAt = Number(record.expiresAt);
  return {
    version: MRC721_LISTING_VERSION,
    kind: MRC721_LISTING_KIND,
    itemPinId,
    collectionPinId: String(record.collectionPinId ?? ''),
    outpoint,
    sellerAddress,
    buyerAddress,
    priceSats,
    partialTx,
    sigtype,
    feeRate: Number.isFinite(feeRate) ? feeRate : 0,
    createdAt: Number.isFinite(createdAt) ? createdAt : 0,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

async function metaletJson(url: string, fetchImpl: typeof fetch): Promise<{ code?: number; message?: string; data?: unknown }> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`wallet-api HTTP ${response.status}`);
  }
  return response.json() as Promise<{ code?: number; message?: string; data?: unknown }>;
}

function txSpendsOutpoint(rawHex: string, outpoint: Mrc721Outpoint): boolean {
  const tx = new mvc.Transaction(rawHex);
  return tx.inputs.some((input) => (
    input.prevTxId.toString('hex').toLowerCase() === outpoint.txid
    && Number(input.outputIndex) === outpoint.vout
  ));
}

/**
 * Node unspent check. Dust NFT outputs never appear in wallet-api utxo-list,
 * so absence below the funding floor is not a spend. A spend is a recent
 * transaction input, a session exclude entry, or a missing funding-sized coin.
 */
export async function isMrc721OutpointUnspent(input: {
  address: string;
  outpoint: Mrc721Outpoint;
  excludedOutpoints?: ReadonlySet<string>;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const outpoint = normalizeMrc721Outpoint(input.outpoint);
  const key = outpointKey(outpoint);
  if (input.excludedOutpoints?.has(key)) return false;
  const fetchImpl = input.fetchImpl ?? fetch;
  const address = input.address;

  let flag: string | undefined;
  for (let page = 0; page < 5; page += 1) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const json = await metaletJson(`${MRC721_METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`, fetchImpl);
    if (json.code !== 0) {
      throw mrc721ListingError(
        'check 4 (unspent)',
        `the wallet API could not list UTXOs (${json.message || 'unknown error'}), so the purchase was not signed. Retry shortly.`,
      );
    }
    const list = ((json.data as { list?: Array<{ txid?: string; outIndex?: number; flag?: string }> } | undefined)?.list) ?? [];
    if (list.some((utxo) => String(utxo.txid || '').toLowerCase() === outpoint.txid && Number(utxo.outIndex) === outpoint.vout)) {
      return true;
    }
    if (!list.length) break;
    const next = list[list.length - 1]?.flag;
    if (!next || next === flag) break;
    flag = next;
  }

  const recent: string[] = [];
  let txFlag = '';
  while (recent.length < RECENT_TX_SCAN) {
    const params = new URLSearchParams({ address, net: NET, ...(txFlag ? { flag: txFlag } : {}) });
    const json = await metaletJson(`${MRC721_METALET_HOST}/wallet-api/v4/mvc/address/tx-list?${params}`, fetchImpl);
    if (json.code !== 0) {
      throw mrc721ListingError(
        'check 4 (unspent)',
        `the wallet API could not list recent transactions (${json.message || 'unknown error'}), so the purchase was not signed. Retry shortly.`,
      );
    }
    const list = ((json.data as { list?: Array<{ txid?: string; flag?: string }> } | undefined)?.list) ?? [];
    if (!list.length) break;
    for (const item of list) {
      const txid = String(item.txid || '').trim().toLowerCase();
      if (/^[0-9a-f]{64}$/.test(txid) && !recent.includes(txid)) recent.push(txid);
      if (recent.length >= RECENT_TX_SCAN) break;
    }
    const next = String(list[list.length - 1]?.flag || '').trim();
    if (!next || next === txFlag) break;
    txFlag = next;
  }
  if (recent.length === 0) {
    throw mrc721ListingError(
      'check 4 (unspent)',
      `no MVC transactions were visible for ${address}, so the NFT outpoint ${key} could not be confirmed unspent. Nothing was signed.`,
    );
  }

  let checked = 0;
  let failures = 0;
  for (const txid of recent) {
    if (txid === outpoint.txid) continue;
    checked += 1;
    try {
      const json = await metaletJson(
        `${MRC721_METALET_HOST}/wallet-api/v4/mvc/tx/raw?net=${NET}&txId=${txid}`,
        fetchImpl,
      );
      const hex = typeof (json.data as { hex?: string } | undefined)?.hex === 'string'
        ? (json.data as { hex: string }).hex
        : '';
      if (json.code !== 0 || !hex) {
        failures += 1;
        continue;
      }
      if (txSpendsOutpoint(hex, outpoint)) return false;
    } catch {
      failures += 1;
    }
  }
  if (checked > 0 && failures === checked) {
    throw mrc721ListingError(
      'check 4 (unspent)',
      'recent MVC transactions could not be read, so the NFT outpoint was not treated as unspent. Nothing was signed. Retry shortly.',
    );
  }
  if (outpoint.satoshis >= MRC721_WALLET_UTXO_FLOOR_SATS) return false;
  return true;
}

async function assertIndexerOwnership(
  listing: Mrc721AtomicSwapListing,
  fetchItemInfo: (pinId: string) => Promise<Mrc721ItemSummary | null>,
): Promise<void> {
  const item = await fetchItemInfo(listing.itemPinId);
  if (!item) {
    throw mrc721ListingError(
      'check 3 (index)',
      `MRC-721 item ${listing.itemPinId} is not in the index yet (wrong pinId, or the pin is not confirmed/indexed). Verify with mrc721_item_info first.`,
    );
  }
  if (item.burned) {
    throw mrc721ListingError(
      'check 3 (burned)',
      `MRC-721 item ${listing.itemPinId} is burned (melted down) and can no longer move.`,
    );
  }
  if (item.genesisChainName && item.genesisChainName !== 'mvc') {
    throw mrc721ListingError(
      'check 3 (chain)',
      `MRC-721 item ${listing.itemPinId} is on chain "${item.genesisChainName}"; atomic swaps in this version spend MVC UTXOs only.`,
    );
  }
  const owner = String(item.ownerAddress ?? '').trim();
  if (!owner || owner !== listing.sellerAddress) {
    throw mrc721ListingError(
      'check 3 (ownership)',
      `MRC-721 item ${listing.itemPinId} is currently owned by ${owner || 'an unknown address'}, not the seller ${listing.sellerAddress}. The NFT is no longer in the seller's hand — the listing is void. Re-check with mrc721_item_info.`,
    );
  }
  const output = String(item.output ?? '').trim().toLowerCase();
  const expected = outpointKey(listing.outpoint);
  const outputValue = Number(item.outputValue);
  if (output !== expected || outputValue !== listing.outpoint.satoshis) {
    throw mrc721ListingError(
      'check 3 (outpoint)',
      `MRC-721 item ${listing.itemPinId} current UTXO is ${item.output || 'none'} (${item.outputValue ?? '?'} sats), not ${expected} (${listing.outpoint.satoshis} sats). The index may be stale — re-check with mrc721_item_info.`,
    );
  }
}

/** Checks 1–5. Buy and sell-order refresh both call this. */
export async function verifyMrc721Listing(
  input: unknown,
  deps: Mrc721ListingVerifyDeps = {},
): Promise<{ listing: Mrc721AtomicSwapListing }> {
  const listing = parseMrc721AtomicSwapListing(input);
  const composer = loadPartialComposer(listing.partialTx);
  assertPartialTxShape({
    composer,
    outpoint: listing.outpoint,
    buyerAddress: listing.buyerAddress,
    sellerAddress: listing.sellerAddress,
    priceSats: listing.priceSats,
  });
  verifySellerSignature(composer.tx, listing.sellerAddress, listing.outpoint.satoshis);
  const fetchItemInfo = deps.fetchItemInfo
    ?? ((pinId: string) => fetchMrc721ItemInfo({ pinId }));
  await assertIndexerOwnership(listing, fetchItemInfo);
  const unspent = deps.isOutpointUnspent
    ?? ((probe: { address: string; outpoint: Mrc721Outpoint }) => isMrc721OutpointUnspent({
      ...probe,
      excludedOutpoints: deps.excludedOutpoints,
    }));
  let stillThere = false;
  try {
    stillThere = await unspent({ address: listing.sellerAddress, outpoint: listing.outpoint });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('MRC-721 listing failed')) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw mrc721ListingError(
      'check 4 (unspent)',
      `the node unspent check failed (${message}). Nothing was signed. Retry shortly, or re-check with mrc721_item_info.`,
    );
  }
  if (!stillThere) {
    throw mrc721ListingError(
      'check 4 (unspent)',
      `outpoint ${outpointKey(listing.outpoint)} is already spent. Another buyer broadcast first, or the seller moved the NFT. The listing is void — re-check with mrc721_item_info.`,
    );
  }
  return { listing };
}

function readOrders(kv: SellOrderKv, metabotId: number): Mrc721SellOrderRecord[] {
  const stored = kv.get<Mrc721SellOrderRecord[]>(ordersKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

export function recordMrc721Listing(
  kv: SellOrderKv,
  metabotId: number,
  listing: Mrc721AtomicSwapListing,
): Mrc721SellOrderRecord {
  const record: Mrc721SellOrderRecord = {
    id: randomBytes(8).toString('hex'),
    metabotId,
    listing,
    createdAt: listing.createdAt,
  };
  kv.set(ordersKey(metabotId), [...readOrders(kv, metabotId), record]);
  return record;
}

export function listMrc721SellOrderRecords(kv: SellOrderKv, metabotId: number): Mrc721SellOrderRecord[] {
  return readOrders(kv, metabotId);
}

export async function sellMrc721Item(
  deps: {
    buildPartialTx: (
      store: MetabotStore,
      params: {
        metabotId: number;
        buyerAddress: string;
        priceSats: number;
        outpoint: Mrc721Outpoint;
      },
    ) => Promise<{ partialTx: string; sigtype: number }>;
  },
  input: {
    store: MetabotStore;
    metabotId: number;
    itemPinId: string;
    buyerAddress: string;
    priceSats: number;
    feeRate: number;
    itemInfo?: Mrc721ItemSummary | null;
    orders?: SellOrderKv;
    nowSeconds?: number;
  },
): Promise<Mrc721AtomicSwapListing> {
  const pinId = String(input.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(pinId)) {
    throw new Error('mrc721_sell requires a valid pin_id (64-hex txid + "i" + output index)');
  }
  const buyerAddress = String(input.buyerAddress ?? '').trim();
  if (!isMvcAddress(buyerAddress)) {
    throw new Error('mrc721_sell requires a valid MVC address for the buyer');
  }
  if (!Number.isInteger(input.priceSats) || input.priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw mrc721PriceFloorError();
  }
  if (!Number.isFinite(input.feeRate) || input.feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const botAddress = input.store.getMetabotById(input.metabotId)?.mvc_address ?? '';
  if (!botAddress) {
    throw new Error('the session MetaBot has no MVC address');
  }
  const item = input.itemInfo !== undefined
    ? input.itemInfo
    : await fetchMrc721ItemInfo({ pinId });
  if (!item) {
    throw new Error(
      `MRC-721 item ${pinId} is not in the index yet (wrong pinId, or the pin is not confirmed/indexed). Verify with mrc721_item_info first.`,
    );
  }
  if (item.burned) {
    throw new Error(`MRC-721 item ${pinId} is burned (melted down) and can no longer be listed.`);
  }
  if (item.genesisChainName && item.genesisChainName !== 'mvc') {
    throw new Error(
      `MRC-721 item ${pinId} is on chain "${item.genesisChainName}"; listings in this version spend MVC UTXOs only.`,
    );
  }
  if (item.ownerAddress && item.ownerAddress !== botAddress) {
    throw new Error(
      `MRC-721 item ${pinId} is currently owned by ${item.ownerAddress}, not this session bot (${botAddress}). `
      + 'The index may be stale — re-check with mrc721_item_info — or the item belongs to another wallet.',
    );
  }
  const outpointText = String(item.output ?? '').trim();
  const match = /^([0-9a-fA-F]{64}):(\d+)$/.exec(outpointText);
  const outputValue = Number(item.outputValue);
  if (!match || !Number.isInteger(outputValue) || outputValue <= 0) {
    throw new Error(
      `MRC-721 item ${pinId} has no spendable current UTXO in the index (output=${item.output || 'none'}). `
      + 'The index may be stale — re-check with mrc721_item_info.',
    );
  }
  const outpoint = normalizeMrc721Outpoint({
    txid: match[1],
    vout: Number(match[2]),
    satoshis: outputValue,
  });
  const built = await deps.buildPartialTx(input.store, {
    metabotId: input.metabotId,
    buyerAddress,
    priceSats: input.priceSats,
    outpoint,
  });
  const listing = buildMrc721AtomicSwapListing({
    itemPinId: pinId,
    collectionPinId: item.collectionPinId,
    outpoint,
    sellerAddress: botAddress,
    buyerAddress,
    priceSats: input.priceSats,
    partialTx: built.partialTx,
    sigtype: built.sigtype,
    feeRate: input.feeRate,
    nowSeconds: input.nowSeconds,
  });
  const composer = loadPartialComposer(listing.partialTx);
  assertPartialTxShape({
    composer,
    outpoint,
    buyerAddress,
    sellerAddress: botAddress,
    priceSats: input.priceSats,
  });
  verifySellerSignature(composer.tx, botAddress, outpoint.satoshis);
  if (input.orders) recordMrc721Listing(input.orders, input.metabotId, listing);
  return listing;
}

export async function buyMrc721Listing(
  deps: {
    completeBuy: (
      store: MetabotStore,
      params: {
        metabotId: number;
        listing: Mrc721AtomicSwapListing;
        feeRate: number;
        excludeOutpoints: string[];
      },
    ) => Promise<{
      txId: string;
      spentOutpoints: string[];
      feeSats: number;
      feeRateEffective: number;
    }>;
  },
  input: {
    store: MetabotStore;
    metabotId: number;
    listing: unknown;
    feeRate: number;
    verifyDeps?: Mrc721ListingVerifyDeps;
  },
): Promise<{
  txId: string;
  spentOutpoints: string[];
  feeSats: number;
  feeRateEffective: number;
  itemPinId: string;
  priceSats: number;
  sellerAddress: string;
  buyerAddress: string;
}> {
  const botAddress = input.store.getMetabotById(input.metabotId)?.mvc_address ?? '';
  if (!botAddress) {
    throw new Error('the session MetaBot has no MVC address');
  }
  if (!Number.isFinite(input.feeRate) || input.feeRate <= 0) {
    throw new Error('feeRate must be a positive number');
  }
  const excluded = new Set(getMvcSpendSessionSnapshot(input.metabotId).excludeOutpoints);
  for (const extra of input.verifyDeps?.excludedOutpoints ?? []) excluded.add(extra);
  const verified = await verifyMrc721Listing(input.listing, {
    ...input.verifyDeps,
    excludedOutpoints: excluded,
  });
  if (verified.listing.buyerAddress !== botAddress) {
    throw new Error(
      `This listing pays the NFT to ${verified.listing.buyerAddress}, not this session bot (${botAddress}). `
      + 'A third party cannot take the purchase: output 0 is locked to the listed buyer. Ask the seller to create a new listing. Nothing was signed.',
    );
  }
  const result = await deps.completeBuy(input.store, {
    metabotId: input.metabotId,
    listing: verified.listing,
    feeRate: input.feeRate,
    excludeOutpoints: Array.from(excluded),
  });
  recordMvcSpentOutpoints(input.metabotId, result.spentOutpoints);
  return {
    ...result,
    itemPinId: verified.listing.itemPinId,
    priceSats: verified.listing.priceSats,
    sellerAddress: verified.listing.sellerAddress,
    buyerAddress: verified.listing.buyerAddress,
  };
}

export async function listMrc721MySellOrders(
  kv: SellOrderKv,
  metabotId: number,
  deps: Mrc721ListingVerifyDeps = {},
): Promise<Mrc721SellOrderView[]> {
  const now = deps.nowSeconds ?? Math.floor(Date.now() / 1000);
  const views: Mrc721SellOrderView[] = [];
  for (const record of readOrders(kv, metabotId)) {
    try {
      await verifyMrc721Listing(record.listing, deps);
      if (record.listing.expiresAt > 0 && record.listing.expiresAt < now) {
        views.push({
          id: record.id,
          listing: record.listing,
          status: 'expired',
          reason: `off-chain expiresAt ${record.listing.expiresAt} has passed. The partial transaction is not mined away by the clock; refresh with mrc721_item_info before treating it as live.`,
        });
      } else {
        views.push({ id: record.id, listing: record.listing, status: 'valid' });
      }
    } catch (error) {
      views.push({
        id: record.id,
        listing: record.listing,
        status: 'invalid',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return views;
}

export function mrc721SellOrdersFromSqlite(store: SqliteStore): SellOrderKv {
  return {
    get: <T>(key: string) => store.get<T>(key),
    set: <T>(key: string, value: T) => store.set(key, value),
  };
}
