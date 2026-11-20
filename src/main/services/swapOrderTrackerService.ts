import type { SqliteDatabase } from '../sqliteTypes';
import {
  fetchMrc721AddressItemsPage,
  fetchMrc721ItemVerify,
  type Mrc721ItemSummary,
  type Mrc721VerifyInfo,
} from './mrc721Service';
import {
  parseSwapWireMessage,
  type SwapClaimItemV1,
  type SwapCompletedResultItemV1,
} from './swapWireProtocol';

export const NFT_SWAP_POLL_INTERVAL_MS = 45_000;

export type NftSwapClientOrderStatus =
  | 'submitted'
  | 'partially_completed'
  | 'completed'
  | 'failed';

export interface NftSwapClientOrderRecord {
  requestId: string;
  metabotId: number;
  stationGlobalMetaId: string;
  collectionSlug: string;
  targetCollectionPinId: string | null;
  sessionId: string | null;
  recipientAddress: string;
  items: SwapClaimItemV1[];
  status: NftSwapClientOrderStatus;
  completedItems: SwapCompletedResultItemV1[];
  notifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterNftSwapOrderInput {
  requestId: string;
  metabotId: number;
  stationGlobalMetaId: string;
  collectionSlug: string;
  targetCollectionPinId?: string | null;
  sessionId?: string | null;
  recipientAddress: string;
  items: SwapClaimItemV1[];
}

export interface NftSwapOrderCompletedEvent {
  requestId: string;
  metabotId: number;
  stationGlobalMetaId: string;
  collectionSlug: string;
  targetCollectionPinId: string | null;
  sessionId: string | null;
  status: NftSwapClientOrderStatus;
  source: 'a2a_message' | 'metaso_poll';
  results: SwapCompletedResultItemV1[];
  completedAt: number;
}

export interface SwapOrderTrackerDeps {
  fetchAddressCollectionItems?: (
    recipientAddress: string,
    targetCollectionPinId: string,
  ) => Promise<Mrc721ItemSummary[]>;
  verifyItem?: (itemPinId: string) => Promise<Mrc721VerifyInfo | null>;
  emitToRenderer?: (channel: string, payload: unknown) => void;
  onOrderCompleted?: (event: NftSwapOrderCompletedEvent) => void | Promise<void>;
  now?: () => number;
}

export function ensureNftSwapClientOrderSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS nft_swap_client_orders (
      request_id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      station_global_metaid TEXT NOT NULL,
      collection_slug TEXT NOT NULL,
      target_collection_pinid TEXT,
      session_id TEXT,
      recipient_address TEXT NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted',
      completed_items_json TEXT NOT NULL DEFAULT '[]',
      notified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_nft_swap_client_orders_status
    ON nft_swap_client_orders(status, updated_at DESC);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_nft_swap_client_orders_metabot
    ON nft_swap_client_orders(metabot_id, created_at DESC);
  `);

  try {
    const cols =
      (db.exec('PRAGMA table_info(nft_swap_client_orders)')[0]?.values?.map((r) => String(r[1])) as string[]) || [];
    const addCol = (name: string, ddl: string) => {
      if (!cols.includes(name)) {
        db.run(`ALTER TABLE nft_swap_client_orders ADD COLUMN ${ddl}`);
      }
    };
    addCol('target_collection_pinid', 'target_collection_pinid TEXT');
    addCol('session_id', 'session_id TEXT');
    addCol('recipient_address', `recipient_address TEXT NOT NULL DEFAULT ''`);
    addCol('completed_items_json', `completed_items_json TEXT NOT NULL DEFAULT '[]'`);
    addCol('notified_at', 'notified_at INTEGER');
  } catch (error) {
    console.warn('[SwapOrderTracker] schema heal warning:', error);
  }
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function rowToRecord(columns: string[], values: unknown[]): NftSwapClientOrderRecord {
  const row: Record<string, unknown> = {};
  columns.forEach((col, i) => {
    row[col] = values[i];
  });
  return {
    requestId: String(row.request_id ?? ''),
    metabotId: Number(row.metabot_id ?? 0),
    stationGlobalMetaId: String(row.station_global_metaid ?? ''),
    collectionSlug: String(row.collection_slug ?? ''),
    targetCollectionPinId:
      typeof row.target_collection_pinid === 'string' && row.target_collection_pinid.trim()
        ? row.target_collection_pinid.trim()
        : null,
    sessionId: typeof row.session_id === 'string' && row.session_id.trim() ? row.session_id.trim() : null,
    recipientAddress: String(row.recipient_address ?? ''),
    items: parseJsonArray<SwapClaimItemV1>(row.items_json),
    status: (String(row.status ?? 'submitted') as NftSwapClientOrderStatus) || 'submitted',
    completedItems: parseJsonArray<SwapCompletedResultItemV1>(row.completed_items_json),
    notifiedAt: row.notified_at != null && Number.isFinite(Number(row.notified_at)) ? Number(row.notified_at) : null,
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function extractTokenIndexFromMrc721Item(item: Mrc721ItemSummary): string | null {
  const rec = item as unknown as Record<string, unknown>;
  if (rec.tokenIndex != null && String(rec.tokenIndex).trim()) {
    const parsed = Number(String(rec.tokenIndex).trim());
    if (Number.isInteger(parsed) && parsed >= 0) return String(parsed);
  }
  const pathCandidates = [rec.itemPath, rec.pinPath, rec.path];
  for (const raw of pathCandidates) {
    if (typeof raw !== 'string') continue;
    const m = /item-(\d+)$/i.exec(raw.trim());
    if (m) return String(Number(m[1]));
  }
  const nameCandidates = [rec.itemName, item.name];
  for (const raw of nameCandidates) {
    if (typeof raw !== 'string') continue;
    const m = /#(\d+)\b/.exec(raw.trim());
    if (m) return String(Number(m[1]));
  }
  return null;
}

function mergeResults(
  existing: SwapCompletedResultItemV1[],
  incoming: SwapCompletedResultItemV1[],
): SwapCompletedResultItemV1[] {
  const byToken = new Map<string, SwapCompletedResultItemV1>();
  for (const item of existing) {
    byToken.set(String(Number(item.tokenIndex) || item.tokenIndex), item);
  }
  for (const item of incoming) {
    const key = String(Number(item.tokenIndex) || item.tokenIndex);
    const prev = byToken.get(key);
    if (!prev || prev.status !== 'completed' || item.status === 'completed') {
      byToken.set(key, {
        ...prev,
        ...item,
      });
    }
  }
  return Array.from(byToken.values());
}

function deriveOrderStatus(
  requestedItems: SwapClaimItemV1[],
  mergedResults: SwapCompletedResultItemV1[],
): NftSwapClientOrderStatus {
  const byToken = new Map<string, SwapCompletedResultItemV1>();
  for (const item of mergedResults) {
    byToken.set(String(Number(item.tokenIndex) || item.tokenIndex), item);
  }
  let completedCount = 0;
  let failedCount = 0;
  for (const req of requestedItems) {
    const key = String(Number(req.tokenIndex) || req.tokenIndex);
    const hit = byToken.get(key);
    if (hit?.status === 'completed') completedCount += 1;
    else if (hit?.status === 'failed') failedCount += 1;
  }
  if (requestedItems.length > 0 && completedCount >= requestedItems.length) {
    return 'completed';
  }
  if (requestedItems.length > 0 && failedCount >= requestedItems.length) {
    return 'failed';
  }
  if (completedCount > 0) {
    return 'partially_completed';
  }
  return 'submitted';
}

export class SwapOrderTrackerService {
  private readonly db: SqliteDatabase;
  private readonly saveDb: () => void;
  private readonly deps: SwapOrderTrackerDeps;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollingInFlight = false;

  constructor(db: SqliteDatabase, saveDb: () => void, deps: SwapOrderTrackerDeps = {}) {
    this.db = db;
    this.saveDb = saveDb;
    this.deps = deps;
    ensureNftSwapClientOrderSchema(this.db);
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  registerOrder(input: RegisterNftSwapOrderInput): NftSwapClientOrderRecord {
    const existing = this.getOrder(input.requestId);
    if (existing) {
      return existing;
    }
    const ts = this.now();
    this.db.run(
      `INSERT INTO nft_swap_client_orders (
        request_id, metabot_id, station_global_metaid, collection_slug,
        target_collection_pinid, session_id, recipient_address,
        items_json, status, completed_items_json, notified_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', '[]', NULL, ?, ?)`,
      [
        input.requestId,
        input.metabotId,
        input.stationGlobalMetaId,
        input.collectionSlug,
        input.targetCollectionPinId ?? null,
        input.sessionId ?? null,
        input.recipientAddress,
        JSON.stringify(input.items),
        ts,
        ts,
      ],
    );
    this.saveDb();
    return this.getOrder(input.requestId)!;
  }

  getOrder(requestId: string): NftSwapClientOrderRecord | null {
    const result = this.db.exec(
      'SELECT * FROM nft_swap_client_orders WHERE request_id = ? LIMIT 1',
      [requestId],
    );
    if (!result.length || !result[0].values.length) return null;
    return rowToRecord(result[0].columns, result[0].values[0]);
  }

  listOrders(metabotId?: number): NftSwapClientOrderRecord[] {
    const result =
      typeof metabotId === 'number'
        ? this.db.exec(
            'SELECT * FROM nft_swap_client_orders WHERE metabot_id = ? ORDER BY created_at DESC',
            [metabotId],
          )
        : this.db.exec('SELECT * FROM nft_swap_client_orders ORDER BY created_at DESC');
    if (!result.length) return [];
    return result[0].values.map((vals) => rowToRecord(result[0].columns, vals));
  }

  listPendingOrders(): NftSwapClientOrderRecord[] {
    const result = this.db.exec(
      `SELECT * FROM nft_swap_client_orders
       WHERE status IN ('submitted', 'partially_completed')
       ORDER BY created_at ASC`,
    );
    if (!result.length) return [];
    return result[0].values.map((vals) => rowToRecord(result[0].columns, vals));
  }

  async handleIncomingSwapMessage(input: {
    metabotId: number;
    fromGlobalMetaId: string;
    plaintext: string;
  }): Promise<{
    handled: boolean;
    type?: string;
    requestId?: string;
    matched?: boolean;
    notified?: boolean;
  }> {
    const parsed = parseSwapWireMessage(input.plaintext);
    if (!parsed) {
      return { handled: false };
    }

    // Incoming SWAP_CLAIM_V1 belongs to the swap-station bot skill turn, not the client tracker.
    if (parsed.type === 'SWAP_CLAIM_V1') {
      return { handled: false };
    }

    const order = this.getOrder(parsed.requestId);
    if (!order || order.metabotId !== input.metabotId) {
      return { handled: true, type: parsed.type, requestId: parsed.requestId, matched: false };
    }

    if (
      order.stationGlobalMetaId &&
      input.fromGlobalMetaId &&
      order.stationGlobalMetaId.trim() !== input.fromGlobalMetaId.trim()
    ) {
      console.warn(
        `[SwapOrderTracker] Ignoring ${parsed.type} for ${parsed.requestId}: sender ${input.fromGlobalMetaId} != expected station ${order.stationGlobalMetaId}`,
      );
      return { handled: true, type: parsed.type, requestId: parsed.requestId, matched: false };
    }

    if (parsed.type === 'SWAP_STATUS_V1') {
      this.db.run(
        'UPDATE nft_swap_client_orders SET updated_at = ? WHERE request_id = ?',
        [this.now(), order.requestId],
      );
      this.saveDb();
      return { handled: true, type: parsed.type, requestId: parsed.requestId, matched: true, notified: false };
    }

    // SWAP_COMPLETED_V1
    const notified = await this.applyCompletionResults(order, parsed.results, 'a2a_message');
    return {
      handled: true,
      type: parsed.type,
      requestId: parsed.requestId,
      matched: true,
      notified,
    };
  }

  private async applyCompletionResults(
    order: NftSwapClientOrderRecord,
    incomingResults: SwapCompletedResultItemV1[],
    source: 'a2a_message' | 'metaso_poll',
  ): Promise<boolean> {
    const prevCompletedKeys = new Set(
      order.completedItems
        .filter((item) => item.status === 'completed')
        .map((item) => String(Number(item.tokenIndex) || item.tokenIndex)),
    );
    const merged = mergeResults(order.completedItems, incomingResults);
    const nextStatus = deriveOrderStatus(order.items, merged);
    const nextCompletedKeys = new Set(
      merged
        .filter((item) => item.status === 'completed')
        .map((item) => String(Number(item.tokenIndex) || item.tokenIndex)),
    );

    const hasNewlyCompletedItem = Array.from(nextCompletedKeys).some((key) => !prevCompletedKeys.has(key));
    const alreadyFullyNotified = order.status === 'completed' && order.notifiedAt !== null;
    const shouldNotify = !alreadyFullyNotified && (hasNewlyCompletedItem || (nextStatus === 'completed' && order.notifiedAt === null));

    const ts = this.now();
    const notifiedAt = shouldNotify && nextStatus === 'completed' ? ts : order.notifiedAt;

    this.db.run(
      `UPDATE nft_swap_client_orders
       SET status = ?, completed_items_json = ?, notified_at = ?, updated_at = ?
       WHERE request_id = ?`,
      [nextStatus, JSON.stringify(merged), notifiedAt, ts, order.requestId],
    );
    this.saveDb();

    if (shouldNotify) {
      const event: NftSwapOrderCompletedEvent = {
        requestId: order.requestId,
        metabotId: order.metabotId,
        stationGlobalMetaId: order.stationGlobalMetaId,
        collectionSlug: order.collectionSlug,
        targetCollectionPinId: order.targetCollectionPinId,
        sessionId: order.sessionId,
        status: nextStatus,
        source,
        results: merged,
        completedAt: ts,
      };
      try {
        this.deps.emitToRenderer?.('nftSwap:orderCompleted', event);
      } catch (err) {
        console.warn('[SwapOrderTracker] emitToRenderer failed:', err);
      }
      try {
        await this.deps.onOrderCompleted?.(event);
      } catch (err) {
        console.warn('[SwapOrderTracker] onOrderCompleted failed:', err);
      }
      return true;
    }

    return false;
  }

  async pollPendingOrdersOnce(): Promise<{ checked: number; notified: number }> {
    if (this.pollingInFlight) {
      return { checked: 0, notified: 0 };
    }
    this.pollingInFlight = true;
    let checked = 0;
    let notified = 0;

    try {
      const pending = this.listPendingOrders();
      const fetchItems =
        this.deps.fetchAddressCollectionItems ??
        (async (recipientAddress: string, targetCollectionPinId: string) => {
          const page = await fetchMrc721AddressItemsPage({
            address: recipientAddress,
            pinId: targetCollectionPinId,
            size: 100,
          });
          return page.items;
        });
      const verifyItem =
        this.deps.verifyItem ??
        (async (itemPinId: string) => fetchMrc721ItemVerify({ pinId: itemPinId }));

      for (const order of pending) {
        if (!order.targetCollectionPinId || !order.recipientAddress) {
          continue;
        }
        checked += 1;
        let items: Mrc721ItemSummary[];
        try {
          items = await fetchItems(order.recipientAddress, order.targetCollectionPinId);
        } catch (err) {
          console.warn(`[SwapOrderTracker] poll fetch failed for ${order.requestId}:`, err);
          continue;
        }
        if (!items.length) continue;

        const completedKeys = new Set(
          order.completedItems
            .filter((r) => r.status === 'completed')
            .map((r) => String(Number(r.tokenIndex) || r.tokenIndex)),
        );
        const wantedByToken = new Map<string, SwapClaimItemV1>();
        for (const req of order.items) {
          const key = String(Number(req.tokenIndex) || req.tokenIndex);
          if (!completedKeys.has(key)) {
            wantedByToken.set(key, req);
          }
        }
        if (wantedByToken.size === 0) continue;

        const detected: SwapCompletedResultItemV1[] = [];
        for (const candidate of items) {
          const candidateRec = candidate as unknown as Record<string, unknown>;
          const collectionId = String(candidateRec.collectionid ?? candidate.collectionPinId ?? '')
            .trim()
            .toLowerCase();
          if (collectionId && collectionId !== order.targetCollectionPinId.toLowerCase()) {
            continue;
          }
          const tokenKey = extractTokenIndexFromMrc721Item(candidate);
          if (!tokenKey || !wantedByToken.has(tokenKey)) {
            continue;
          }
          const itemPinId = String(candidate.itemPinId ?? candidateRec.pinId ?? '').trim().toLowerCase();
          if (!itemPinId) continue;

          let creatorMinted = candidate.creatorMinted === true;
          if (candidate.creatorMinted !== true) {
            try {
              const verified = await verifyItem(itemPinId);
              creatorMinted = verified?.creatorMinted === true;
            } catch {
              creatorMinted = false;
            }
          }
          if (!creatorMinted) {
            continue;
          }

          const rawDeliveryTxId = candidateRec.txId ?? candidateRec.genesisTransaction ?? candidate.genesisTx;
          const rawItemName = candidateRec.itemName ?? candidate.name;
          const rawCover = candidate.cover ?? candidateRec.content;
          detected.push({
            tokenIndex: wantedByToken.get(tokenKey)!.tokenIndex,
            status: 'completed',
            itemPinId,
            deliveryTxId: typeof rawDeliveryTxId === 'string' ? rawDeliveryTxId : undefined,
            itemName: typeof rawItemName === 'string' ? rawItemName : undefined,
            cover: typeof rawCover === 'string' ? rawCover : undefined,
          });
        }

        if (detected.length > 0) {
          const fresh = this.getOrder(order.requestId);
          if (!fresh || fresh.status === 'completed') continue;
          const didNotify = await this.applyCompletionResults(fresh, detected, 'metaso_poll');
          if (didNotify) notified += 1;
        }
      }
    } finally {
      this.pollingInFlight = false;
    }

    return { checked, notified };
  }

  startPolling(intervalMs = NFT_SWAP_POLL_INTERVAL_MS): void {
    this.stopPolling();
    const timer = setInterval(() => {
      void this.pollPendingOrdersOnce();
    }, intervalMs);
    if (typeof timer.unref === 'function') {
      timer.unref();
    }
    this.pollTimer = timer;
  }

  stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
