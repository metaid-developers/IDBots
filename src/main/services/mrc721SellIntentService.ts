import { randomBytes } from 'node:crypto';
import {
  broadcastMrc721Pin,
  fetchMetasoJson,
  fetchMrc721ItemInfo,
  isMvcAddress,
  isMrc721PinId,
  type Mrc721CreatePinFn,
} from './mrc721Service';
import type { MetabotStore } from '../metabotStore';

/**
 * MRC-721 sell-intent protocol ("NFT 售", docs/nft-sell-protocol-draft.md):
 * an on-chain declaration pin at the FIXED path /protocols/mrc721sell that
 * says the holder wants to sell an item, on discoverable, currency-agnostic
 * terms. It moves no funds and transfers nothing — settlement runs over the
 * locked atomic-swap rail (native SPACE) or the escrow/guarantor rail (any
 * currency).
 *
 * Protocol shape (owner decisions 2026-11-04):
 *  - Path /protocols/mrc721sell, NOT /nft/*: /nft/ is the OFFICIAL protocol
 *    namespace indexers must index; this protocol stays unofficial for now.
 *    The fixed path also keeps it away from the /nft/mrc721/ item-mint rule
 *    (a sell pin under that root would mint a phantom item).
 *  - No per-item path suffix: itemPinId lives in the content; the protocol
 *    carries no ambiguous duplicates.
 *  - No protocol/version fields in the payload: the MetaID pin 7-tuple
 *    already carries the protocol identity (path) and version (pin version).
 *  - Append-only declaration log (buzz pattern): every declaration is a
 *    CREATE pin on the fixed path; per itemPinId the LATEST pin wins
 *    (cancel = a new declaration with active:false).
 *  - contact.metabotId never goes on-chain: local ids are per-machine and
 *    mutable; sellerMetaId is the only identity.
 */

export const MRC721_SELL_INTENT_PATH = '/protocols/mrc721sell';

export interface Mrc721SellIntentContent {
  active: boolean;
  itemPinId: string;
  collectionName?: string;
  collectionPinId?: string;
  itemOutpoint?: { txid: string; vout: number; satoshis: number };
  sellerAddress: string;
  sellerMetaId?: string;
  priceHintSats?: number;
  acceptedCurrencies: string[];
  settlement: string[];
  note?: string;
  /** Epoch SECONDS (doc schema §2.2 — the indexer keys on this unit). */
  createdAt: number;
  /** Epoch SECONDS; display-only expiry window. */
  expiresAt?: number;
}

export interface Mrc721SellIntentRecord {
  id: string;
  metabotId: number;
  intent: Mrc721SellIntentContent;
  sellPinId?: string;
  status: 'active' | 'cancelled';
  updatedAt: number;
}

/** Listed-view status: local record status joined with the live holder view. */
export type Mrc721SellIntentStatus = 'active' | 'cancelled' | 'stale';

export interface Mrc721SellIntentView {
  id: string;
  itemPinId: string;
  status: Mrc721SellIntentStatus;
  reason?: string;
  intent: Mrc721SellIntentContent;
  sellPinId?: string;
}

type SellIntentKv = {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
};

function intentsKey(metabotId: number): string {
  return `mrc721_sell_intents:${metabotId}`;
}

export function mrc721SellIntentsFromSqlite(store: { get(key: string): unknown; set(key: string, value: unknown): void }): SellIntentKv {
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

/** Validate + normalize a sell-intent content object (tolerant on optional fields). */
export function parseMrc721SellIntent(input: unknown): Mrc721SellIntentContent {
  const record = asRecord(input);
  const itemPinId = String(record.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  const sellerAddress = String(record.sellerAddress ?? '').trim();
  if (!isMvcAddress(sellerAddress)) {
    throw new Error('sellerAddress must be an MVC address');
  }
  const priceHintSats = record.priceHintSats == null ? undefined : Number(record.priceHintSats);
  if (priceHintSats != null && (!Number.isInteger(priceHintSats) || priceHintSats <= 0)) {
    throw new Error('priceHintSats must be a positive integer (it is a display hint, not an on-chain ask)');
  }
  const asStringArray = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((entry) => String(entry).trim()).filter(Boolean) : [];
  const acceptedCurrencies = asStringArray(record.acceptedCurrencies);
  const settlement = asStringArray(record.settlement);
  return {
    active: record.active !== false,
    itemPinId,
    collectionName: typeof record.collectionName === 'string' && record.collectionName.trim() ? record.collectionName.trim() : undefined,
    collectionPinId: typeof record.collectionPinId === 'string' && record.collectionPinId.trim() ? record.collectionPinId.trim() : undefined,
    itemOutpoint: asRecord(record.itemOutpoint).txid
      ? {
        txid: String(record.itemOutpoint && (record.itemOutpoint as Record<string, unknown>).txid),
        vout: Number((record.itemOutpoint as Record<string, unknown>).vout ?? 0),
        satoshis: Number((record.itemOutpoint as Record<string, unknown>).satoshis ?? 0),
      }
      : undefined,
    sellerAddress,
    sellerMetaId: typeof record.sellerMetaId === 'string' && record.sellerMetaId.trim() ? record.sellerMetaId.trim() : undefined,
    priceHintSats,
    acceptedCurrencies: acceptedCurrencies.length ? acceptedCurrencies : ['space'],
    settlement: settlement.length ? settlement : ['atomic-swap', 'escrow'],
    note: typeof record.note === 'string' && record.note.trim() ? record.note.trim() : undefined,
    createdAt: Number(record.createdAt) || Math.floor(Date.now() / 1000),
    expiresAt: Number(record.expiresAt) || undefined,
  };
}

/**
 * Race-safety note: the KV intent book relies on read→write sections staying
 * SYNCHRONOUS (no await between readIntents and the following writeIntents —
 * Node's single thread makes that atomic). Inserting an await in between
 * would reintroduce lost updates across concurrent tool calls.
 */
function readIntents(kv: SellIntentKv, metabotId: number): Mrc721SellIntentRecord[] {
  const stored = kv.get<Mrc721SellIntentRecord[]>(intentsKey(metabotId));
  return Array.isArray(stored) ? stored : [];
}

function writeIntents(kv: SellIntentKv, metabotId: number, records: Mrc721SellIntentRecord[]): void {
  kv.set(intentsKey(metabotId), records);
}

export interface Mrc721SellIntentDeclareInput {
  metabotId: number;
  itemPinId: string;
  priceHintSats?: number;
  acceptedCurrencies?: string[];
  settlement?: string[];
  note?: string;
  expiresInHours?: number;
  network?: 'mvc' | 'btc';
  origin?: string;
}

export interface Mrc721SellIntentWriteResult {
  sellPinId: string;
  txids: string[];
  totalCost: number;
  feeAssist?: unknown;
  intent: Mrc721SellIntentContent;
}

/**
 * Broadcast the sell-intent declaration pin and record it locally. The item
 * must currently be held by the declaring bot (live holder view) — a sell
 * declaration for an item you do not hold is refused at the source.
 */
export async function declareMrc721SellIntent(
  deps: { createPin: Mrc721CreatePinFn },
  input: Mrc721SellIntentDeclareInput & { store: MetabotStore; intents: SellIntentKv },
): Promise<Mrc721SellIntentWriteResult> {
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  if (!isMrc721PinId(itemPinId)) {
    throw new Error('itemPinId must be a 64-hex txid plus "i" and an output index');
  }
  if (input.priceHintSats != null && (!Number.isInteger(input.priceHintSats) || input.priceHintSats <= 0)) {
    throw new Error('priceHintSats must be a positive integer');
  }
  const metabot = input.store.getMetabotById(input.metabotId);
  if (!metabot?.mvc_address) {
    throw new Error('declaring bot has no MVC address');
  }
  const item = await fetchMrc721ItemInfo({ pinId: itemPinId });
  if (!item) {
    throw new Error(`item ${itemPinId} is not indexed (yet) — the holder view is the only sell-authority source, so an unindexed item cannot be declared for sale`);
  }
  if (item.burned) {
    throw new Error(`item ${itemPinId} is burned and cannot be sold`);
  }
  if ((item.ownerAddress ?? '').toLowerCase() !== metabot.mvc_address.toLowerCase()) {
    throw new Error(`item ${itemPinId} is held by ${item.ownerAddress ?? 'someone else'}, not by the declaring bot`);
  }

  const nowMs = Date.now();
  // Pin content timestamps are epoch SECONDS (doc schema §2.2, manapi
  // convention); the local book's updatedAt stays ms (local bookkeeping only).
  const nowSeconds = Math.floor(nowMs / 1000);
  const intent: Mrc721SellIntentContent = {
    active: true,
    itemPinId,
    collectionName: item.collectionName,
    collectionPinId: item.collectionPinId,
    itemOutpoint: item.output
      ? {
        txid: item.output.split(':')[0] ?? item.output,
        vout: Number(item.output.split(':')[1] ?? 0),
        satoshis: Number(item.outputValue ?? 0),
      }
      : undefined,
    sellerAddress: metabot.mvc_address,
    sellerMetaId: metabot.globalmetaid ?? undefined,
    priceHintSats: input.priceHintSats,
    acceptedCurrencies: input.acceptedCurrencies?.map((entry) => String(entry).trim()).filter(Boolean).length
      ? input.acceptedCurrencies.map((entry) => String(entry).trim()).filter(Boolean)
      : ['space'],
    settlement: input.settlement?.map((entry) => String(entry).trim()).filter(Boolean).length
      ? input.settlement.map((entry) => String(entry).trim()).filter(Boolean)
      : ['atomic-swap', 'escrow'],
    note: input.note?.trim() || undefined,
    createdAt: nowSeconds,
    expiresAt: input.expiresInHours && input.expiresInHours > 0 ? nowSeconds + input.expiresInHours * 3_600 : undefined,
  };

  // Append-only declaration log (buzz pattern, doc §2.1): every declaration —
  // first, re-declare, or post-cancel re-list — is a CREATE pin on the fixed
  // /protocols/mrc721sell path; per itemPinId the LATEST pin wins.
  const records = readIntents(input.intents, input.metabotId);
  const existing = records.findIndex((record) => record.intent.itemPinId === itemPinId);

  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_SELL_INTENT_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(intent),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_sell_intent' });

  const record: Mrc721SellIntentRecord = {
    id: existing >= 0 ? records[existing].id : randomBytes(8).toString('hex'),
    metabotId: input.metabotId,
    intent,
    sellPinId: broadcast.pinId,
    status: 'active',
    updatedAt: nowMs,
  };
  if (existing >= 0) records[existing] = record;
  else records.push(record);
  writeIntents(input.intents, input.metabotId, records);
  return {
    sellPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    intent,
  };
}

/**
 * Cancel a sell intent: broadcast a closing declaration (active=false) on the
 * fixed path — per the append-only log, that new pin becomes the item's
 * latest declaration — and flip the local record. The item itself is
 * untouched.
 */
export async function cancelMrc721SellIntent(
  deps: { createPin: Mrc721CreatePinFn },
  input: { metabotId: number; itemPinId: string; network?: 'mvc' | 'btc'; origin?: string; store: MetabotStore; intents: SellIntentKv },
): Promise<Mrc721SellIntentWriteResult> {
  const itemPinId = String(input.itemPinId ?? '').trim().toLowerCase();
  const records = readIntents(input.intents, input.metabotId);
  const record = records.find((entry) => entry.intent.itemPinId === itemPinId);
  if (!record) {
    throw new Error(`no sell intent recorded for item ${itemPinId}`);
  }
  if (record.status === 'cancelled' && record.intent.active === false) {
    throw new Error(`sell intent for item ${itemPinId} is already cancelled`);
  }
  const content: Mrc721SellIntentContent = { ...record.intent, active: false };
  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: MRC721_SELL_INTENT_PATH,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(content),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_sell_intent_cancel' });
  record.intent = content;
  record.status = 'cancelled';
  record.updatedAt = Date.now();
  writeIntents(input.intents, input.metabotId, records);
  return {
    sellPinId: broadcast.pinId,
    txids: broadcast.txids,
    totalCost: broadcast.totalCost,
    feeAssist: broadcast.feeAssist,
    intent: content,
  };
}

export function listMrc721SellIntentRecords(kv: SellIntentKv, metabotId: number): Mrc721SellIntentRecord[] {
  return readIntents(kv, metabotId);
}

/**
 * Listed view: local records joined with the live holder view. `stale` = the
 * item is no longer held by the seller (transferred away, or the holder view
 * cannot confirm it) — displayed honestly instead of silently dropped.
 */
export async function listMrc721MySellIntents(
  kv: SellIntentKv,
  metabotId: number,
  filter?: { collectionName?: string; collectionPinId?: string },
): Promise<Mrc721SellIntentView[]> {
  const records = readIntents(kv, metabotId);
  const views: Mrc721SellIntentView[] = [];
  for (const record of records) {
    if (filter?.collectionName && record.intent.collectionName !== filter.collectionName) continue;
    if (filter?.collectionPinId && record.intent.collectionPinId !== filter.collectionPinId) continue;
    if (record.status === 'cancelled') {
      views.push({ id: record.id, itemPinId: record.intent.itemPinId, status: 'cancelled', intent: record.intent, sellPinId: record.sellPinId });
      continue;
    }
    let status: Mrc721SellIntentStatus = 'active';
    let reason: string | undefined;
    try {
      const item = await fetchMrc721ItemInfo({ pinId: record.intent.itemPinId });
      if (!item || (item.ownerAddress ?? '').toLowerCase() !== record.intent.sellerAddress.toLowerCase()) {
        status = 'stale';
        reason = 'the item is no longer held by the seller address';
      }
    } catch (error) {
      status = 'stale';
      reason = `holder re-check failed: ${error instanceof Error ? error.message : String(error)}`;
    }
    views.push({
      id: record.id,
      itemPinId: record.intent.itemPinId,
      status,
      reason,
      intent: record.intent,
      sellPinId: record.sellPinId,
    });
  }
  return views;
}

// ---------------------------------------------------------------------------
// Market reads (S2): other bots' declared sell intents via the indexer
// ---------------------------------------------------------------------------

/**
 * One sell-intent row as served by the indexer (man-p2p ships camelCase plus
 * lowercase duplicates; we read the camelCase shape). Chain facts ride along.
 */
export interface Mrc721SellIntentRow {
  itemPinId: string;
  sellPinId?: string;
  active?: boolean;
  collectionName?: string;
  collectionPinId?: string;
  sellerAddress?: string;
  sellerMetaId?: string;
  priceHintSats?: number;
  acceptedCurrencies?: string[];
  settlement?: string[];
  note?: string;
  contact?: { metaId?: string; metabotId?: number };
  createdAt?: number;
  expiresAt?: number;
  chainName?: string;
  height?: number;
  txId?: string;
  updatedAt?: number;
}

function sellIntentRowFrom(raw: unknown): Mrc721SellIntentRow {
  const record = asRecord(raw);
  const row: Mrc721SellIntentRow = {
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
  row.sellPinId = pickString('sellPinId', 'sellpinid');
  row.collectionName = pickString('collectionName', 'collectionname');
  row.collectionPinId = pickString('collectionPinId', 'collectionpinid');
  row.sellerAddress = pickString('sellerAddress', 'selleraddress');
  row.sellerMetaId = pickString('sellerMetaId', 'sellermetaid');
  row.note = pickString('note');
  row.chainName = pickString('chainName', 'chainname');
  row.txId = pickString('txId', 'txid');
  if (Number.isFinite(Number(record.priceHintSats ?? record.pricehintsats))) {
    row.priceHintSats = Number(record.priceHintSats ?? record.pricehintsats) || undefined;
  }
  const currencies = record.acceptedCurrencies ?? record.acceptedcurrencies;
  if (Array.isArray(currencies)) {
    row.acceptedCurrencies = currencies.map((entry) => String(entry)).filter(Boolean);
  }
  if (Array.isArray(record.settlement)) {
    row.settlement = record.settlement.map((entry) => String(entry)).filter(Boolean);
  }
  if (Number.isFinite(Number(record.createdAt ?? record.createdat))) {
    row.createdAt = Number(record.createdAt ?? record.createdat) || undefined;
  }
  if (Number.isFinite(Number(record.expiresAt ?? record.expiresat))) {
    row.expiresAt = Number(record.expiresAt ?? record.expiresat) || undefined;
  }
  if (Number.isFinite(Number(record.updatedAt ?? record.updatedat))) {
    row.updatedAt = Number(record.updatedAt ?? record.updatedat) || undefined;
  }
  if (Number.isFinite(Number(record.height))) row.height = Number(record.height);
  return row;
}

export interface Mrc721SellIntentPage {
  items: Mrc721SellIntentRow[];
  total?: number;
  cursor?: string;
}

/**
 * Query the indexer for declared sell intents (docs/nft-sell-protocol-draft.md
 * §2.3, indexer requirement R-C). Served by man-p2p; indexers without the
 * endpoint surface a structured 404 that callers must degrade on honestly.
 */
export async function fetchMrc721SellIntents(params: {
  collectionPinId?: string;
  collectionName?: string;
  itemPinId?: string;
  sellerAddress?: string;
  active?: boolean;
  cursor?: string | number;
  size?: number;
}): Promise<Mrc721SellIntentPage> {
  // MetaSo-P2P owns the sell-intent index (indexing architecture 2026-11-05);
  // the production base is built into getMetasoApiBase (env override for
  // staging only). Transport/envelope errors propagate with the structured
  // markers so the tool degrades honestly.
  const query = {
    collectionPinId: params.collectionPinId,
    collectionName: params.collectionName,
    itemPinId: params.itemPinId,
    sellerAddress: params.sellerAddress,
    active: params.active == null ? undefined : (params.active ? 'true' : 'false'),
    cursor: params.cursor,
    size: params.size,
  };
  const data = await fetchMetasoJson('/api/mrc721/sell/intents', query) as { list?: unknown; total?: unknown; cursor?: unknown } | null;
  const items = Array.isArray(data?.list) ? data.list.map(sellIntentRowFrom) : [];
  return {
    items,
    total: Number.isFinite(Number(data?.total)) ? Number(data?.total) : undefined,
    cursor: typeof data?.cursor === 'string' && data.cursor ? data.cursor : undefined,
  };
}

/** Single sell-intent lookup by item; a server-answered miss returns null. */
export async function fetchMrc721SellIntentInfo(params: {
  itemPinId: string;
}): Promise<Mrc721SellIntentRow | null> {
  try {
    const data = await fetchMetasoJson('/api/mrc721/sell/intent/info', { itemPinId: params.itemPinId });
    return data ? sellIntentRowFrom(data) : null;
  } catch (error) {
    const status = (error as { mrc721Status?: number }).mrc721Status;
    const code = (error as { mrc721Code?: unknown }).mrc721Code;
    if (status === 404 || code !== undefined) return null;
    throw error;
  }
}
