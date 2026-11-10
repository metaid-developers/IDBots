import { randomBytes } from 'node:crypto';
import {
  broadcastMrc721Pin,
  fetchMetasoJson,
  fetchMrc721ItemInfo,
  type Mrc721CreatePinFn,
} from './mrc721Service';
import { isMrc721OutpointUnspent } from './mrc721AtomicSwapService';
import { getMvcSpendSessionSnapshot, recordMvcSpentOutpoints } from './mvcSpendSessionState';
import type { MetabotStore } from '../metabotStore';
import { MRC721_MIN_SELL_PRICE_SATS, verifySellerSignature, type Mrc721Outpoint } from '../libs/mrc721AtomicSwapTx';
import {
  MRC721_OPEN_OFFER_PATH,
  assertMrc721OpenOfferShape,
  buildMrc721OpenOfferPayload,
  decodeMrc721OpenOfferTx,
  type Mrc721OpenOfferTx,
} from '../libs/mrc721OpenOfferTx';
import { isMvcAddress, isMrc721PinId } from './mrc721Service';

/**
 * MRC-721 passive open-offer protocol ("NFT 硬挂单",
 * docs/nft-offer-protocol.md, APPROVED 2026-11-08): a signed
 * SIGHASH_SINGLE|FORKID|ANYONECANPAY offer tx (output0 = the price, the
 * seller's ONLY commitment) wrapped in a pin on the fixed path
 * /protocols/mrc721offer. Append-only, latest-pin-wins per itemPinId; the
 * seller may go offline — any buyer takes the offer without seller
 * cooperation.
 */

export { MRC721_OPEN_OFFER_PATH };

export interface Mrc721OpenOfferContent {
  active: boolean;
  itemPinId: string;
  priceSats: number;
  offerTx: string;
  /** Epoch SECONDS (protocol schema — same convention as the v2 sell intent). */
  createdAt: number;
}

export interface Mrc721OpenOfferRecord {
  id: string;
  metabotId: number;
  offer: Mrc721OpenOfferContent;
  offerPinId?: string;
  status: 'active' | 'cancelled';
  updatedAt: number;
}

/** Listed-view status: local record status joined with the live holder view. */
export type Mrc721OpenOfferStatus = 'active' | 'cancelled' | 'stale';

export interface Mrc721OpenOfferView {
  id: string;
  itemPinId: string;
  status: Mrc721OpenOfferStatus;
  reason?: string;
  offer: Mrc721OpenOfferContent;
  offerPinId?: string;
}

type OfferKv = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
};

function offersKey(metabotId: number): string {
  return `mrc721_offers:${metabotId}`;
}

export function mrc721OpenOffersFromSqlite(store: { get(key: string): unknown; set(key: string, value: unknown): void }): OfferKv {
  return {
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      store.set(key, value);
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

/** Validate + normalize one offer payload (the protocol schema, doc §3). */
export function parseMrc721OpenOffer(input: unknown): Mrc721OpenOfferContent {
  const record = asRecord(input);
  const itemPinId = String(record.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  const priceSats = Number(record.priceSats);
  if (!Number.isInteger(priceSats) || priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw new Error(`priceSats must be an integer >= ${MRC721_MIN_SELL_PRICE_SATS} (the floor is enforced at offer build time)`);
  }
  const offerTx = String(record.offerTx ?? '').trim();
  if (!offerTx) {
    throw new Error('offerTx (base64 signed offer) is required');
  }
  return {
    active: record.active !== false,
    itemPinId,
    priceSats,
    offerTx,
    createdAt: Number(record.createdAt) || Math.floor(Date.now() / 1000),
  };
}

/**
 * Race-safety: the KV offer book relies on read→write sections staying
 * SYNCHRONOUS (no await between read and write — Node's single thread makes
 * that atomic), same note as the sell-intent book.
 */
function readOffers(kv: OfferKv, metabotId: number): Mrc721OpenOfferRecord[] {
  const stored = kv.get<Mrc721OpenOfferRecord[]>(offersKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

function writeOffers(kv: OfferKv, metabotId: number, records: Mrc721OpenOfferRecord[]): void {
  kv.set(offersKey(metabotId), records);
}

/** The item's current outpoint from the holder view ("txid:vout" + value). */
function outpointOfItem(item: { output?: string; outputValue?: number }): Mrc721Outpoint | null {
  const output = String(item.output ?? '').trim();
  if (!output.includes(':')) return null;
  const [txid, voutRaw] = output.split(':');
  const satoshis = Number(item.outputValue ?? 0);
  if (!/^[0-9a-fA-F]{64}$/.test(txid) || !Number.isInteger(Number(voutRaw)) || !Number.isInteger(satoshis) || satoshis <= 0) {
    return null;
  }
  return { txid: txid.toLowerCase(), vout: Number(voutRaw), satoshis };
}

export interface Mrc721OpenOfferWriteResult {
  offerPinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  offer: Mrc721OpenOfferContent;
  outpoint: Mrc721Outpoint;
}

export interface Mrc721OpenOfferPublishInput {
  metabotId: number;
  itemPinId: string;
  priceSats: number;
  network?: 'mvc' | 'btc';
  origin?: string;
}

/**
 * Publish the passive open offer: holder gate → sign the SINGLE offer tx
 * (injected builder; the wallet never leaves the worker) → broadcast the
 * /protocols/mrc721offer pin → record locally.
 */
export async function publishMrc721OpenOffer(
  deps: {
    createPin: Mrc721CreatePinFn;
    buildOfferTx: (store: MetabotStore, params: { metabotId: number; priceSats: number; outpoint: Mrc721Outpoint }) => Promise<Mrc721OpenOfferTx>;
  },
  input: Mrc721OpenOfferPublishInput & { store: MetabotStore; offers: OfferKv },
): Promise<Mrc721OpenOfferWriteResult> {
  if (input.network === 'btc') {
    throw new Error('BTC-side writes are not supported in this version — use network mvc');
  }
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  if (!Number.isInteger(input.priceSats) || input.priceSats < MRC721_MIN_SELL_PRICE_SATS) {
    throw new Error(`priceSats must be an integer >= ${MRC721_MIN_SELL_PRICE_SATS}`);
  }
  const metabot = input.store.getMetabotById(input.metabotId);
  if (!metabot?.mvc_address) {
    throw new Error('publishing bot has no MVC address');
  }
  const item = await fetchMrc721ItemInfo({ pinId: itemPinId });
  if (!item) {
    throw new Error(`item ${itemPinId} is not indexed (yet) — the holder view is the only sell-authority source, so an unindexed item cannot be offered`);
  }
  if (item.burned) {
    throw new Error(`item ${itemPinId} is burned and cannot be sold`);
  }
  if ((item.ownerAddress ?? '').toLowerCase() !== metabot.mvc_address.toLowerCase()) {
    throw new Error(`item ${itemPinId} is held by ${item.ownerAddress ?? 'someone else'}, not by the publishing bot`);
  }
  const outpoint = outpointOfItem(item);
  if (!outpoint) {
    throw new Error(`item ${itemPinId} has no usable current outpoint in the holder view`);
  }

  const built = await deps.buildOfferTx(input.store, { metabotId: input.metabotId, priceSats: input.priceSats, outpoint });

  const nowMs = Date.now();
  // Pin content timestamps are epoch SECONDS (protocol schema §3).
  const content: Mrc721OpenOfferContent = {
    ...buildMrc721OpenOfferPayload({
      itemPinId,
      priceSats: input.priceSats,
      offerTx: built.offerTx,
      active: true,
    }),
    createdAt: Math.floor(nowMs / 1000),
  };

  // Only the id-reuse lookup happens before the await; the write-back below
  // RE-READS the book (a read→write section must not span an await, see the
  // race-safety note above readOffers).
  const existingId = readOffers(input.offers, input.metabotId)
    .find((record) => record.offer.itemPinId === itemPinId)?.id;

  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_OPEN_OFFER_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(content),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_offer' });

  const record: Mrc721OpenOfferRecord = {
    id: existingId ?? randomBytes(8).toString('hex'),
    metabotId: input.metabotId,
    offer: content,
    offerPinId: broadcast.pinId,
    status: 'active',
    updatedAt: nowMs,
  };
  // Re-read AFTER the await: a concurrent tool call may have written the book
  // while the pin was broadcasting. Merge into the freshest array — replace a
  // same-item record that appeared meanwhile, else append — and write back
  // immediately (synchronous read→modify→write).
  const records = readOffers(input.offers, input.metabotId);
  const existing = records.findIndex((record) => record.offer.itemPinId === itemPinId);
  if (existing >= 0) records[existing] = record;
  else records.push(record);
  writeOffers(input.offers, input.metabotId, records);
  return {
    offerPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    offer: content,
    outpoint,
  };
}

/** The item outpoint the signed offer spends (input0 of offerTx), or null when undecodable. */
function offerInputOutpoint(offerTx: string): { txid: string; vout: number } | null {
  try {
    const input = decodeMrc721OpenOfferTx(offerTx).tx.inputs[0];
    if (!input) return null;
    return { txid: input.prevTxId.toString('hex').toLowerCase(), vout: Number(input.outputIndex) };
  } catch {
    return null;
  }
}

export interface Mrc721OpenOfferCancelResult extends Mrc721OpenOfferWriteResult {
  /** 'revoked' = this call moved the item so the signed offer can never complete;
   *  'already-dead' = the item had already left the offered outpoint. */
  revocation: 'revoked' | 'already-dead';
  revokeTxId?: string;
}

/**
 * HARD cancel an open offer. The signed offer tx is public on-chain inside the
 * offer pin, so a closing declaration alone only stops ADVERTISING — anyone
 * holding the original payload could still complete it while the item sits
 * at the offered outpoint. The real revocation is a chain move: this bot
 * self-transfers the item to a fresh outpoint (the old SINGLE signature can
 * never be completed again), THEN broadcasts the active=false declaration so
 * the indexer stops listing it. When the item already left the offered
 * outpoint (sold, transferred, previously revoked) the offer is dead and the
 * self-transfer is skipped. Idempotent: if the declaration fails after a
 * successful revoke, re-running skips the revoke and retries the pin.
 */
export async function cancelMrc721OpenOffer(
  deps: {
    createPin: Mrc721CreatePinFn;
    /** Self-transfer of the item to this bot's own address (the on-chain revocation). */
    revokeItem: (store: MetabotStore, params: { metabotId: number; itemPinId: string }) => Promise<{ txId: string }>;
    fetchItemInfo?: typeof fetchMrc721ItemInfo;
    settleDelayMs?: number;
  },
  input: { metabotId: number; itemPinId: string; network?: 'mvc' | 'btc'; origin?: string; store: MetabotStore; offers: OfferKv },
): Promise<Mrc721OpenOfferCancelResult> {
  if (input.network === 'btc') {
    throw new Error('BTC-side writes are not supported in this version — use network mvc');
  }
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  const records = readOffers(input.offers, input.metabotId);
  const record = records.find((entry) => entry.offer.itemPinId === itemPinId);
  if (!record) {
    throw new Error(`no open offer recorded for item ${itemPinId}`);
  }
  if (record.status === 'cancelled' && record.offer.active === false) {
    throw new Error(`open offer for item ${itemPinId} is already cancelled`);
  }
  const metabot = input.store.getMetabotById(input.metabotId);
  const ownAddress = String(metabot?.mvc_address ?? '').toLowerCase();
  const fetchItemInfo = deps.fetchItemInfo ?? fetchMrc721ItemInfo;

  // 1. On-chain revocation (only while the signed offer could still complete).
  const item = await fetchItemInfo({ pinId: itemPinId });
  const offered = offerInputOutpoint(record.offer.offerTx);
  const current = item ? outpointOfItem(item) : null;
  const stillTakeable = Boolean(
    item && !item.burned && offered && current
    && current.txid === offered.txid && current.vout === offered.vout,
  );
  let revocation: Mrc721OpenOfferCancelResult['revocation'] = 'already-dead';
  let revokeTxId: string | undefined;
  if (stillTakeable) {
    if (String(item?.ownerAddress ?? '').toLowerCase() !== ownAddress) {
      throw new Error(`item ${itemPinId} is held by ${item?.ownerAddress ?? 'someone else'}, not by this bot — it cannot revoke the offer`);
    }
    const revoked = await deps.revokeItem(input.store, { metabotId: input.metabotId, itemPinId });
    revokeTxId = revoked.txId;
    revocation = 'revoked';
    // Let the wallet UTXO view settle before the declaration pin picks fee
    // inputs (same race guard as mint → item_desc).
    const settleMs = deps.settleDelayMs ?? 3000;
    if (settleMs > 0) await new Promise((resolve) => setTimeout(resolve, settleMs));
  }

  // 2. Closing declaration — stops the indexer from advertising the offer.
  const content: Mrc721OpenOfferContent = { ...record.offer, active: false };
  let broadcast: Awaited<ReturnType<typeof broadcastMrc721Pin>>;
  try {
    broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
      operation: 'create',
      path: MRC721_OPEN_OFFER_PATH,
      encryption: '0',
      version: '1.0.0',
      contentType: 'application/json',
      payload: JSON.stringify(content),
    }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_offer_cancel' });
  } catch (error) {
    if (revocation === 'revoked') {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `the offer IS revoked on-chain (self-transfer ${revokeTxId}: the signed offer can no longer complete), `
        + `but the closing declaration pin failed (${message}). Re-run the cancel to publish the declaration — it will skip the revoke.`,
      );
    }
    throw error;
  }
  record.offer = content;
  record.status = 'cancelled';
  record.updatedAt = Date.now();
  writeOffers(input.offers, input.metabotId, records);
  return {
    offerPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    offer: content,
    outpoint: current ?? { txid: '0'.repeat(64), vout: 0, satoshis: 0 },
    revocation,
    ...(revokeTxId ? { revokeTxId } : {}),
  };
}

export function listMrc721OpenOfferRecords(kv: OfferKv, metabotId: number): Mrc721OpenOfferRecord[] {
  return readOffers(kv, metabotId);
}

/**
 * Listed view: local records joined with the live holder view. `stale` = the
 * item is no longer held by the seller address — displayed honestly.
 */
export async function listMrc721MyOpenOffers(
  kv: OfferKv,
  metabotId: number,
): Promise<Mrc721OpenOfferView[]> {
  const records = readOffers(kv, metabotId);
  const views: Mrc721OpenOfferView[] = [];
  for (const record of records) {
    if (record.status === 'cancelled') {
      views.push({ id: record.id, itemPinId: record.offer.itemPinId, status: 'cancelled', offer: record.offer, offerPinId: record.offerPinId });
      continue;
    }
    let status: Mrc721OpenOfferStatus = 'active';
    let reason: string | undefined;
    try {
      const item = await fetchMrc721ItemInfo({ pinId: record.offer.itemPinId });
      const held = item && !item.burned && Boolean(item.ownerAddress);
      if (!held) {
        status = 'stale';
        reason = 'the item is no longer held (transferred away, burned, or unindexed)';
      }
    } catch (error) {
      status = 'stale';
      reason = `holder re-check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    views.push({
      id: record.id,
      itemPinId: record.offer.itemPinId,
      status,
      reason,
      offer: record.offer,
      offerPinId: record.offerPinId,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Take-side verification gates (offline-verifiable before anything is signed)
// ---------------------------------------------------------------------------

export interface Mrc721OpenOfferVerifyResult {
  offer: Mrc721OpenOfferContent;
  sellerAddress: string;
  outpoint: Mrc721Outpoint;
}

/**
 * The five take gates over one offer payload: schema, live holder view
 * (exists / unburned / owner), input0 = the item's CURRENT outpoint, output0
 * = the advertised price to the owner, sigtype SINGLE|FORKID|ACP + seller
 * signature verifies, outpoint unspent. Everything except the unspent check
 * is pure offline verification.
 */
export async function verifyMrc721OpenOffer(
  offer: { itemPinId?: string; priceSats?: number; offerTx?: string; active?: boolean },
  deps?: {
    fetchItemInfo?: typeof fetchMrc721ItemInfo;
    isOutpointUnspent?: typeof isMrc721OutpointUnspent;
    /** Accepted for call-shape parity with the directed-swap verify; the item
     *  outpoint check itself needs no exclusions. */
    excludedOutpoints?: ReadonlySet<string>;
  },
): Promise<Mrc721OpenOfferVerifyResult> {
  const parsed = parseMrc721OpenOffer(offer);
  if (parsed.active === false) {
    throw new Error('this offer payload is a CANCELLATION declaration (active:false) — nothing to take');
  }
  const fetchItemInfo = deps?.fetchItemInfo ?? fetchMrc721ItemInfo;
  const item = await fetchItemInfo({ pinId: parsed.itemPinId });
  if (!item) {
    throw new Error(`item ${parsed.itemPinId} is not indexed — refusing to take an offer whose holder view cannot be checked`);
  }
  if (item.burned) {
    throw new Error(`item ${parsed.itemPinId} is burned`);
  }
  const sellerAddress = String(item.ownerAddress ?? '').trim();
  if (!isMvcAddress(sellerAddress)) {
    throw new Error(`item ${parsed.itemPinId} has no usable owner address in the holder view`);
  }
  const outpoint = outpointOfItem(item);
  if (!outpoint) {
    throw new Error(`item ${parsed.itemPinId} has no usable current outpoint in the holder view`);
  }
  const composer = decodeMrc721OpenOfferTx(parsed.offerTx);
  assertMrc721OpenOfferShape({ composer, outpoint, sellerAddress, priceSats: parsed.priceSats });
  // The seller signature binds {item outpoint, output0 price}: a lying
  // advertisement (payload priceSats ≠ signed output0) fails right here.
  verifySellerSignature(composer.tx, sellerAddress, outpoint.satoshis);
  const isOutpointUnspent = deps?.isOutpointUnspent ?? ((probe: { address: string; outpoint: Mrc721Outpoint }) => isMrc721OutpointUnspent(probe));
  const unspent = await isOutpointUnspent({ address: sellerAddress, outpoint });
  if (!unspent) {
    throw new Error(`the item outpoint ${outpoint.txid}:${outpoint.vout} is already spent — the offer is dead (the item moved elsewhere)`);
  }
  return { offer: parsed, sellerAddress, outpoint };
}

export interface Mrc721OpenOfferTakeResult {
  txId: string;
  spentOutpoints: string[];
  feeSats: number;
  feeRateEffective: number;
  offer: Mrc721OpenOfferContent;
  sellerAddress: string;
}

/**
 * Take the offer: run the gates, then the injected buyer-side worker
 * (wallet + UTXO fetch + completion + broadcast happen there, mnemonic never
 * leaves it), then return the receipt.
 */
export async function takeMrc721OpenOffer(
  deps: {
    completeOfferTx: (store: MetabotStore, params: {
      metabotId: number;
      offer: { itemPinId: string; priceSats: number; offerTx: string };
      feeRate: number;
      excludeOutpoints: string[];
    }) => Promise<{ txId: string; spentOutpoints: string[]; feeSats: number; feeRateEffective: number }>;
    fetchItemInfo?: typeof fetchMrc721ItemInfo;
    isOutpointUnspent?: typeof isMrc721OutpointUnspent;
  },
  input: {
    metabotId: number;
    offer: { itemPinId: string; priceSats: number; offerTx: string };
    feeRate: number;
    excludeOutpoints?: string[];
    store: MetabotStore;
  },
): Promise<Mrc721OpenOfferTakeResult> {
  // Seed the fee-input exclusions from this session's spend snapshot (same
  // double-spend guard as buyMrc721Listing): the wallet UTXO list lags behind
  // a just-broadcast tx, so back-to-back takes would otherwise re-pick the
  // same funding UTXO and the second take would fail at broadcast.
  const excluded = new Set(getMvcSpendSessionSnapshot(input.metabotId).excludeOutpoints);
  for (const extra of input.excludeOutpoints ?? []) excluded.add(extra);
  const verified = await verifyMrc721OpenOffer(input.offer, {
    fetchItemInfo: deps.fetchItemInfo,
    isOutpointUnspent: deps.isOutpointUnspent,
    excludedOutpoints: excluded,
  });
  const result = await deps.completeOfferTx(input.store, {
    metabotId: input.metabotId,
    offer: {
      itemPinId: verified.offer.itemPinId,
      priceSats: verified.offer.priceSats,
      offerTx: verified.offer.offerTx,
    },
    feeRate: input.feeRate,
    excludeOutpoints: Array.from(excluded),
  });
  // Record what the settlement tx spent so the next coin selection in this
  // session excludes it until the wallet UTXO list catches up.
  recordMvcSpentOutpoints(input.metabotId, result.spentOutpoints);
  return {
    txId: result.txId,
    spentOutpoints: result.spentOutpoints ?? [],
    feeSats: result.feeSats,
    feeRateEffective: result.feeRateEffective,
    offer: verified.offer,
    sellerAddress: verified.sellerAddress,
  };
}

// ---------------------------------------------------------------------------
// Market reads via the R-E indexer endpoints (docs/nft-offer-indexer-requirements.md)
// ---------------------------------------------------------------------------

export interface Mrc721OpenOfferRow {
  itemPinId: string;
  offerPinId?: string;
  active?: boolean;
  priceSats?: number;
  offerTx?: string;
  /** The offer pin creator's 64-hex MetaID (R-E-2 sellerMetaId). */
  sellerMetaId?: string;
  createdAt?: number;
  chainName?: string;
  height?: number;
  txId?: string;
}

/**
 * Liveness of one advertised offer, judged against chain state (the index
 * is an advertisement, not the truth): LIVE only while the item still sits
 * at the outpoint offerTx spends and its owner is the address output0 pays.
 */
export interface Mrc721OpenOfferLiveness {
  status: 'live' | 'dead' | 'unverified';
  reason?: string;
  /** The seller address the signed offer pays (output0). */
  sellerAddress?: string;
}

/** Rows beyond this many are labelled 'unverified' (one item read per row). */
export const MRC721_OFFER_LIVENESS_CHECK_CAP = 20;

export async function labelMrc721OpenOfferLiveness(
  rows: Mrc721OpenOfferRow[],
  deps?: { fetchItemInfo?: typeof fetchMrc721ItemInfo },
): Promise<Mrc721OpenOfferLiveness[]> {
  const fetchItemInfo = deps?.fetchItemInfo ?? fetchMrc721ItemInfo;
  return Promise.all(rows.map(async (row, index): Promise<Mrc721OpenOfferLiveness> => {
    if (index >= MRC721_OFFER_LIVENESS_CHECK_CAP) {
      return { status: 'unverified', reason: `only the first ${MRC721_OFFER_LIVENESS_CHECK_CAP} rows are chain-checked` };
    }
    if (row.active === false) return { status: 'dead', reason: 'cancelled by the seller (active=false)' };
    if (!row.offerTx) return { status: 'unverified', reason: 'the row carries no offerTx' };
    let offeredTxid: string;
    let offeredVout: number;
    let sellerAddress: string;
    try {
      const tx = decodeMrc721OpenOfferTx(row.offerTx).tx;
      offeredTxid = tx.inputs[0].prevTxId.toString('hex').toLowerCase();
      offeredVout = Number(tx.inputs[0].outputIndex);
      sellerAddress = tx.outputs[0].script.toAddress('livenet').toString();
    } catch {
      return { status: 'dead', reason: 'offerTx does not decode as an open offer' };
    }
    try {
      const item = await fetchItemInfo({ pinId: row.itemPinId });
      if (!item) return { status: 'unverified', reason: 'the item is not indexed (yet)', sellerAddress };
      if (item.burned) return { status: 'dead', reason: 'the item is burned', sellerAddress };
      const current = outpointOfItem(item);
      if (!current || current.txid !== offeredTxid || current.vout !== offeredVout) {
        return { status: 'dead', reason: 'sold, transferred, or revoked — the item left the offered outpoint', sellerAddress };
      }
      if (String(item.ownerAddress ?? '') !== sellerAddress) {
        return { status: 'dead', reason: 'the item owner is not the address the offer pays', sellerAddress };
      }
      return { status: 'live', sellerAddress };
    } catch (error) {
      return { status: 'unverified', reason: `item read failed: ${error instanceof Error ? error.message : String(error)}`, sellerAddress };
    }
  }));
}

function openOfferRowFrom(raw: unknown): Mrc721OpenOfferRow {
  const record = asRecord(raw);
  const row: Mrc721OpenOfferRow = {
    itemPinId: String(record.itemPinId ?? record.itempinid ?? ''),
    active: record.active === undefined ? undefined : record.active !== false,
  };
  const pickString = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return undefined;
  };
  row.offerPinId = pickString('offerPinId', 'offerpinid');
  row.offerTx = pickString('offerTx', 'offertx');
  row.sellerMetaId = pickString('sellerMetaId', 'sellermetaid');
  row.chainName = pickString('chainName', 'chainname');
  row.txId = pickString('txId', 'txid');
  if (Number.isFinite(Number(record.priceSats ?? record.pricesats))) {
    row.priceSats = Number(record.priceSats ?? record.pricesats) || undefined;
  }
  if (Number.isFinite(Number(record.createdAt ?? record.createdat))) {
    row.createdAt = Number(record.createdAt ?? record.createdat) || undefined;
  }
  if (Number.isFinite(Number(record.height))) row.height = Number(record.height);
  return row;
}

/** Query the indexer for open offers (R-E-2). Degrades honestly when the endpoint is absent. */
export async function fetchMrc721OpenOffers(params: {
  itemPinId?: string;
  collectionPinId?: string;
  sellerMetaId?: string;
  cursor?: string | number;
  size?: number;
}): Promise<{ items: Mrc721OpenOfferRow[]; total?: number; cursor?: string }> {
  const query = {
    itemPinId: params.itemPinId,
    collectionPinId: params.collectionPinId,
    sellerMetaId: params.sellerMetaId,
    active: 'true',
    cursor: params.cursor,
    size: params.size,
  };
  const data = await fetchMetasoJson('/api/mrc721/offers', query) as { list?: unknown; total?: unknown; cursor?: unknown } | null;
  const items = Array.isArray(data?.list) ? data.list.map(openOfferRowFrom) : [];
  return {
    items,
    total: Number.isFinite(Number(data?.total)) ? Number(data?.total) : undefined,
    cursor: typeof data?.cursor === 'string' && data.cursor ? data.cursor : undefined,
  };
}

/** Single offer lookup by item; a server-answered miss returns null. */
export async function fetchMrc721OpenOfferInfo(params: {
  itemPinId: string;
}): Promise<Mrc721OpenOfferRow | null> {
  try {
    const data = await fetchMetasoJson('/api/mrc721/offer/info', { itemPinId: params.itemPinId });
    return data ? openOfferRowFrom(data) : null;
  } catch (error) {
    const status = (error as { mrc721Status?: number }).mrc721Status;
    const code = (error as { mrc721Code?: unknown }).mrc721Code;
    if (status === 404 || code !== undefined) return null;
    throw error;
  }
}
