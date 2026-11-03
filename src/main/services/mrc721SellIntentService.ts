import { randomBytes } from 'node:crypto';
import {
  broadcastMrc721Pin,
  fetchMrc721ItemInfo,
  isMvcAddress,
  isMrc721PinId,
  type Mrc721CreatePinFn,
} from './mrc721Service';
import type { MetabotStore } from '../metabotStore';

/**
 * MRC-721 sell-intent protocol ("NFT 售", docs/nft-sell-protocol-draft.md):
 * an on-chain declaration pin under /nft/mrc721sell/{itemPinId} that says the
 * holder wants to sell an item, on discoverable, currency-agnostic terms. It
 * moves no funds and transfers nothing — settlement runs over the locked
 * atomic-swap rail (native SPACE) or the escrow/guarantor rail (any currency).
 *
 * The path root is deliberately OUTSIDE /nft/mrc721/: every create pin under
 * that root mints an item, so a sell pin living there would mint a phantom
 * item. Until the indexer ships sell-intent queries (R-C), discovery rides on
 * the local KV book here plus chat announcements.
 */

export const MRC721_SELL_INTENT_PATH_ROOT = '/nft/mrc721sell';
export const MRC721_SELL_INTENT_PROTOCOL = 'mrc721-sell-intent';
export const MRC721_SELL_INTENT_VERSION = 1;

export interface Mrc721SellIntentContent {
  protocol: typeof MRC721_SELL_INTENT_PROTOCOL;
  version: number;
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
  contact?: { metaId?: string; metabotId?: number };
  createdAt: number;
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
  if (record.protocol !== MRC721_SELL_INTENT_PROTOCOL || Number(record.version) !== MRC721_SELL_INTENT_VERSION) {
    throw new Error(`expected protocol "${MRC721_SELL_INTENT_PROTOCOL}" version ${MRC721_SELL_INTENT_VERSION}`);
  }
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
    protocol: MRC721_SELL_INTENT_PROTOCOL,
    version: MRC721_SELL_INTENT_VERSION,
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
    contact: asRecord(record.contact).metaId || asRecord(record.contact).metabotId != null
      ? {
        metaId: typeof (record.contact as Record<string, unknown>).metaId === 'string'
          ? (record.contact as Record<string, unknown>).metaId as string
          : undefined,
        metabotId: Number.isInteger((record.contact as Record<string, unknown>)?.metabotId)
          ? (record.contact as Record<string, unknown>).metabotId as number
          : undefined,
      }
      : undefined,
    createdAt: Number(record.createdAt) || Date.now(),
    expiresAt: Number(record.expiresAt) || undefined,
  };
}

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

  const now = Date.now();
  const intent: Mrc721SellIntentContent = {
    protocol: MRC721_SELL_INTENT_PROTOCOL,
    version: MRC721_SELL_INTENT_VERSION,
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
    contact: { metaId: metabot.globalmetaid ?? undefined, metabotId: input.metabotId },
    createdAt: now,
    expiresAt: input.expiresInHours && input.expiresInHours > 0 ? now + input.expiresInHours * 3_600_000 : undefined,
  };

  const broadcast = await broadcastMrc721Pin(deps.createPin, input.metabotId, {
    operation: 'create',
    path: `${MRC721_SELL_INTENT_PATH_ROOT}/${itemPinId}`,
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(intent),
  }, { network: input.network ?? 'mvc', origin: input.origin ?? 'tool:mrc721_sell_intent' });

  const records = readIntents(input.intents, input.metabotId);
  const existing = records.findIndex((record) => record.intent.itemPinId === itemPinId);
  const record: Mrc721SellIntentRecord = {
    id: existing >= 0 ? records[existing].id : randomBytes(8).toString('hex'),
    metabotId: input.metabotId,
    intent,
    sellPinId: broadcast.pinId,
    status: 'active',
    updatedAt: now,
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
 * Cancel a sell intent: modify the declaration pin with active=false and flip
 * the local record. The pin path stays reserved for the item (re-declaring
 * modifies the same pin), matching the protocol draft's one-pin-per-item rule.
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
    operation: 'modify',
    path: `${MRC721_SELL_INTENT_PATH_ROOT}/${itemPinId}`,
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
