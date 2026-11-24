/**
 * Local SQLite Store & Protocol Validator for Active FT Listings and ME Auto-Fulfillment.
 *
 * Implements:
 * - Contract C1 (`/protocols/ft-sell` v1.0 schema & UTXO mutual-exclusion guard C1.3)
 * - `ft_active_orders` table (tracks open/filled/canceled lots across `btc-psbt`,
 *   `mvc-tokensell`, and `me-escrow` + aggregates `filledLots / totalLots` per batch)
 * - `me_ft_seller_fulfillments` table (idempotency & crash-recovery ledger so
 *   SellerAutoFulfillDaemon never double-transfers FT or MRC-20 tokens).
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';
import { normalizeFtAssetKey, type FtMandateRail } from './ftMandateGateService';

export type FtActiveOrderStatus = 'active' | 'filled' | 'canceled' | 'expired';

export interface FtActiveOrderRecord {
  listingKey: string;
  batchGroupId: string;
  metabotId: number;
  assetKey: string;
  chain: 'mvc' | 'btc';
  symbol: string;
  decimals: number;
  codehash?: string;
  genesis?: string;
  mrc20Id?: string;
  rail: FtMandateRail;
  amountBase: string;
  amountDisplay: string;
  utxoOutpoint: string;
  priceSats?: number;
  priceMeMilli?: number;
  autoFulfillMe: boolean;
  sellPinId?: string;
  marketOrderId?: string;
  tokenSellJson?: string;
  sellerAddress?: string;
  sessionId?: string;
  status: FtActiveOrderStatus;
  filledTxId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface RegisterFtActiveOrderInput {
  listingKey: string;
  batchGroupId: string;
  metabotId: number;
  assetKey: string;
  chain: 'mvc' | 'btc';
  symbol: string;
  decimals?: number;
  codehash?: string;
  genesis?: string;
  mrc20Id?: string;
  rail: FtMandateRail;
  amountBase: string;
  amountDisplay: string;
  utxoOutpoint: string;
  priceSats?: number;
  priceMeMilli?: number;
  autoFulfillMe?: boolean;
  sellPinId?: string;
  marketOrderId?: string;
  tokenSellJson?: string;
  sellerAddress?: string;
  sessionId?: string;
  nowMs?: number;
}

export interface FtBatchOrderProgress {
  batchGroupId: string;
  assetKey: string;
  symbol: string;
  rail: FtMandateRail;
  totalLots: number;
  filledLots: number;
  activeLots: number;
  canceledLots: number;
  lots: FtActiveOrderRecord[];
}

export type MeFtSellerFulfillmentStatus =
  | 'transferring'
  | 'transferred'
  | 'delivered'
  | 'rejected'
  | 'failed';

export interface MeFtSellerFulfillmentRecord {
  orderId: string;
  sellerMetabotId: number;
  listingKey?: string;
  assetKey: string;
  chain: 'mvc' | 'btc';
  tokenAmountBase: string;
  buyerReceiveAddress: string;
  amountMilli: number;
  status: MeFtSellerFulfillmentStatus;
  deliveryTxId?: string;
  tradePinId?: string;
  errorMessage?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FtSellPinPayloadV1 {
  version: '1.0';
  active: boolean;
  listingKey: string;
  batchGroupId: string;
  asset: {
    chain: 'mvc' | 'btc';
    standard: 'mvc-ft' | 'mrc20';
    assetKey: string;
    symbol: string;
    decimals: number;
    codehash?: string;
    genesis?: string;
    mrc20Id?: string;
    caPinId?: string;
  };
  lot: {
    amountBase: string;
    amountDisplay: string;
    utxoOutpoint: string;
    lotIndex?: number;
    lotTotal?: number;
  };
  seller: {
    globalMetaId: string;
    botMvcAddress: string;
    botBtcAddress?: string;
  };
  rails: {
    mvcTokenSell?: {
      priceSats: number;
      contractAddress: string;
      txid: string;
      tokenSellJson: string;
    };
    btcPsbt?: {
      priceSats: number;
      marketOrderId?: string;
      marketSource?: 'metaid-market' | 'man-p2p';
    };
    me?: {
      priceMeMilli: number;
      sellerPayeeAddress?: string;
      autoFulfill: boolean;
    };
  };
  expiresAt?: number;
  memo?: string;
}

export function validateFtSellPinPayload(payload: FtSellPinPayloadV1): void {
  if (!payload || payload.version !== '1.0') {
    throw new Error('ft-sell payload version must be "1.0"');
  }
  normalizeFtAssetKey(payload.asset?.assetKey);
  if (!payload.listingKey?.trim()) {
    throw new Error('ft-sell listingKey is required');
  }
  if (payload.active) {
    const hasMvcTokenSell = Boolean(payload.rails?.mvcTokenSell);
    const hasBtcPsbt = Boolean(payload.rails?.btcPsbt);
    const hasMeAuto = Boolean(payload.rails?.me?.autoFulfill);
    // Contract C1.3: UTXO mutual exclusion between native contract/PSBT lock and ME auto-fulfill
    if ((hasMvcTokenSell || hasBtcPsbt) && hasMeAuto) {
      throw new Error(
        'UTXO_RAIL_CONFLICT: the same utxoOutpoint cannot simultaneously lock in mvcTokenSell/btcPsbt and enable me.autoFulfill',
      );
    }
    if (hasMvcTokenSell && hasBtcPsbt) {
      throw new Error('UTXO_RAIL_CONFLICT: mvcTokenSell and btcPsbt cannot both be set on one lot');
    }
  }
}

export function ensureFtOrderTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS ft_active_orders (
      listing_key TEXT PRIMARY KEY,
      batch_group_id TEXT NOT NULL,
      metabot_id INTEGER NOT NULL,
      asset_key TEXT NOT NULL,
      chain TEXT NOT NULL,
      symbol TEXT NOT NULL,
      decimals INTEGER NOT NULL DEFAULT 0,
      codehash TEXT,
      genesis TEXT,
      mrc20_id TEXT,
      rail TEXT NOT NULL,
      amount_base TEXT NOT NULL,
      amount_display TEXT NOT NULL,
      utxo_outpoint TEXT NOT NULL,
      price_sats INTEGER,
      price_me_milli INTEGER,
      auto_fulfill_me INTEGER NOT NULL DEFAULT 0,
      sell_pin_id TEXT,
      market_order_id TEXT,
      token_sell_json TEXT,
      seller_address TEXT,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      filled_tx_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_ft_active_orders_status_rail
      ON ft_active_orders(status, rail);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_ft_active_orders_batch
      ON ft_active_orders(batch_group_id);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_ft_active_orders_outpoint
      ON ft_active_orders(utxo_outpoint);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS me_ft_seller_fulfillments (
      order_id TEXT PRIMARY KEY,
      seller_metabot_id INTEGER NOT NULL,
      listing_key TEXT,
      asset_key TEXT NOT NULL,
      chain TEXT NOT NULL,
      token_amount_base TEXT NOT NULL,
      buyer_receive_address TEXT NOT NULL,
      amount_milli INTEGER NOT NULL,
      status TEXT NOT NULL,
      delivery_tx_id TEXT,
      trade_pin_id TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_me_ft_seller_fulfillments_status
      ON me_ft_seller_fulfillments(status);
  `);
}

function normalizeOutpoint(outpoint: unknown): string {
  return String(outpoint ?? '').trim().toLowerCase();
}

function rowToActiveOrder(row: unknown[]): FtActiveOrderRecord {
  return {
    listingKey: String(row[0] ?? ''),
    batchGroupId: String(row[1] ?? ''),
    metabotId: Number(row[2] ?? 0),
    assetKey: String(row[3] ?? ''),
    chain: String(row[4] ?? 'mvc') === 'btc' ? 'btc' : 'mvc',
    symbol: String(row[5] ?? ''),
    decimals: Number(row[6] ?? 0),
    ...(row[7] ? { codehash: String(row[7]) } : {}),
    ...(row[8] ? { genesis: String(row[8]) } : {}),
    ...(row[9] ? { mrc20Id: String(row[9]) } : {}),
    rail: String(row[10] ?? 'mvc-tokensell') as FtMandateRail,
    amountBase: String(row[11] ?? '0'),
    amountDisplay: String(row[12] ?? '0'),
    utxoOutpoint: String(row[13] ?? ''),
    ...(row[14] != null ? { priceSats: Number(row[14]) } : {}),
    ...(row[15] != null ? { priceMeMilli: Number(row[15]) } : {}),
    autoFulfillMe: Number(row[16] ?? 0) === 1,
    ...(row[17] ? { sellPinId: String(row[17]) } : {}),
    ...(row[18] ? { marketOrderId: String(row[18]) } : {}),
    ...(row[19] ? { tokenSellJson: String(row[19]) } : {}),
    ...(row[20] ? { sellerAddress: String(row[20]) } : {}),
    ...(row[21] ? { sessionId: String(row[21]) } : {}),
    status: String(row[22] ?? 'active') as FtActiveOrderStatus,
    ...(row[23] ? { filledTxId: String(row[23]) } : {}),
    createdAt: Number(row[24] ?? 0),
    updatedAt: Number(row[25] ?? 0),
  };
}

const SELECT_ACTIVE_ORDER_COLS = `
  listing_key, batch_group_id, metabot_id, asset_key, chain, symbol, decimals,
  codehash, genesis, mrc20_id, rail, amount_base, amount_display, utxo_outpoint,
  price_sats, price_me_milli, auto_fulfill_me, sell_pin_id, market_order_id,
  token_sell_json, seller_address, session_id, status, filled_tx_id, created_at, updated_at
`;

export function registerFtActiveOrder(
  db: Database,
  input: RegisterFtActiveOrderInput,
  saveFn?: () => void,
): FtActiveOrderRecord {
  ensureFtOrderTables(db);
  const listingKey = String(input.listingKey ?? '').trim();
  if (!listingKey) throw new Error('listingKey is required');
  const batchGroupId = String(input.batchGroupId ?? '').trim() || listingKey;
  const metabotId = Number(input.metabotId);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    throw new Error('metabotId must be a positive integer');
  }
  const assetKey = normalizeFtAssetKey(input.assetKey);
  const chain: 'mvc' | 'btc' = input.chain === 'btc' ? 'btc' : 'mvc';
  const utxoOutpoint = normalizeOutpoint(input.utxoOutpoint);
  if (!utxoOutpoint) {
    throw new Error('utxoOutpoint is required');
  }
  const amountBase = String(input.amountBase ?? '').trim();
  if (!/^[1-9]\d*$/.test(amountBase)) {
    throw new Error('amountBase must be a positive integer string');
  }
  // Explicit opt-in only: autoFulfillMe defaults to false even on me-escrow.
  // Passing autoFulfillMe: true on mvc-tokensell or btc-psbt still triggers the
  // C1.3 mutual-exclusion conflict check immediately below.
  const autoFulfillMe = input.autoFulfillMe === true;

  // Contract C1.3: UTXO mutual exclusion check across active listings
  if ((input.rail === 'mvc-tokensell' || input.rail === 'btc-psbt') && autoFulfillMe) {
    throw new Error(
      `UTXO_RAIL_CONFLICT: listing '${listingKey}' cannot combine ${input.rail} with autoFulfillMe`,
    );
  }
  const existingOnOutpoint = db.exec(
    `SELECT listing_key, rail, auto_fulfill_me FROM ft_active_orders
     WHERE utxo_outpoint = ? AND status = 'active' AND listing_key != ?`,
    [utxoOutpoint, listingKey],
  );
  for (const existing of existingOnOutpoint[0]?.values ?? []) {
    const existingKey = String(existing[0] ?? '');
    const existingRail = String(existing[1] ?? '');
    const existingAutoMe = Number(existing[2] ?? 0) === 1;
    const newLocksNative = input.rail === 'mvc-tokensell' || input.rail === 'btc-psbt';
    const existingLocksNative = existingRail === 'mvc-tokensell' || existingRail === 'btc-psbt';
    if (
      (newLocksNative && (existingRail === 'me-escrow' || existingAutoMe)) ||
      ((input.rail === 'me-escrow' || autoFulfillMe) && existingLocksNative) ||
      (newLocksNative && existingLocksNative)
    ) {
      throw new Error(
        `UTXO_RAIL_CONFLICT: outpoint '${utxoOutpoint}' is already active in listing '${existingKey}' on rail '${existingRail}'`,
      );
    }
  }

  const now = input.nowMs ?? Date.now();
  const prevRes = db.exec(
    `SELECT created_at FROM ft_active_orders WHERE listing_key = ? LIMIT 1`,
    [listingKey],
  );
  const createdAt = Number(prevRes[0]?.values?.[0]?.[0] ?? now);

  db.run(
    `INSERT OR REPLACE INTO ft_active_orders (
      listing_key, batch_group_id, metabot_id, asset_key, chain, symbol, decimals,
      codehash, genesis, mrc20_id, rail, amount_base, amount_display, utxo_outpoint,
      price_sats, price_me_milli, auto_fulfill_me, sell_pin_id, market_order_id,
      token_sell_json, seller_address, session_id, status, filled_tx_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [
      listingKey,
      batchGroupId,
      metabotId,
      assetKey,
      chain,
      String(input.symbol || 'TOKEN').trim(),
      Number(input.decimals ?? 0) || 0,
      input.codehash ?? null,
      input.genesis ?? null,
      input.mrc20Id ?? null,
      input.rail,
      amountBase,
      String(input.amountDisplay || amountBase).trim(),
      utxoOutpoint,
      input.priceSats ?? null,
      input.priceMeMilli ?? null,
      autoFulfillMe ? 1 : 0,
      input.sellPinId ?? null,
      input.marketOrderId ?? null,
      input.tokenSellJson ?? null,
      input.sellerAddress ?? null,
      input.sessionId ?? null,
      createdAt,
      now,
    ],
  );
  saveFn?.();
  return getFtActiveOrderByKey(db, listingKey)!;
}

export function getFtActiveOrderByKey(
  db: Database,
  listingKey: string,
): FtActiveOrderRecord | null {
  ensureFtOrderTables(db);
  const res = db.exec(
    `SELECT ${SELECT_ACTIVE_ORDER_COLS} FROM ft_active_orders WHERE listing_key = ? LIMIT 1`,
    [String(listingKey ?? '').trim()],
  );
  const row = res[0]?.values?.[0];
  return row ? rowToActiveOrder(row) : null;
}

export function findActiveMeFtOrderForEscrow(
  db: Database,
  params: {
    metabotId: number;
    assetKey: string;
    listingKey?: string;
    lockedUtxoOutpoint?: string;
  },
): FtActiveOrderRecord | null {
  ensureFtOrderTables(db);
  const normalizedAsset = normalizeFtAssetKey(params.assetKey);

  if (params.listingKey?.trim()) {
    const byKey = getFtActiveOrderByKey(db, params.listingKey.trim());
    if (
      byKey &&
      byKey.status === 'active' &&
      byKey.autoFulfillMe &&
      byKey.metabotId === params.metabotId &&
      byKey.assetKey === normalizedAsset
    ) {
      return byKey;
    }
    return null;
  }

  if (params.lockedUtxoOutpoint?.trim()) {
    const outpoint = normalizeOutpoint(params.lockedUtxoOutpoint);
    const res = db.exec(
      `SELECT ${SELECT_ACTIVE_ORDER_COLS} FROM ft_active_orders
       WHERE metabot_id = ? AND asset_key = ? AND utxo_outpoint = ?
         AND status = 'active' AND auto_fulfill_me = 1
       ORDER BY created_at ASC LIMIT 1`,
      [params.metabotId, normalizedAsset, outpoint],
    );
    const row = res[0]?.values?.[0];
    return row ? rowToActiveOrder(row) : null;
  }

  const res = db.exec(
    `SELECT ${SELECT_ACTIVE_ORDER_COLS} FROM ft_active_orders
     WHERE metabot_id = ? AND asset_key = ? AND status = 'active' AND auto_fulfill_me = 1
     ORDER BY created_at ASC LIMIT 1`,
    [params.metabotId, normalizedAsset],
  );
  const row = res[0]?.values?.[0];
  return row ? rowToActiveOrder(row) : null;
}

export function listFtActiveOrders(
  db: Database,
  filter?: {
    metabotId?: number;
    status?: FtActiveOrderStatus;
    rails?: FtMandateRail[];
    batchGroupId?: string;
  },
): FtActiveOrderRecord[] {
  ensureFtOrderTables(db);
  const clauses: string[] = [];
  const args: Array<string | number> = [];

  if (filter?.metabotId != null) {
    clauses.push('metabot_id = ?');
    args.push(filter.metabotId);
  }
  if (filter?.status) {
    clauses.push('status = ?');
    args.push(filter.status);
  }
  if (filter?.batchGroupId) {
    clauses.push('batch_group_id = ?');
    args.push(filter.batchGroupId);
  }
  if (filter?.rails && filter.rails.length > 0) {
    clauses.push(`rail IN (${filter.rails.map(() => '?').join(', ')})`);
    args.push(...filter.rails);
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const res = db.exec(
    `SELECT ${SELECT_ACTIVE_ORDER_COLS} FROM ft_active_orders ${whereSql} ORDER BY created_at ASC`,
    args,
  );
  return (res[0]?.values ?? []).map((row) => rowToActiveOrder(row));
}

export function updateFtOrderStatus(
  db: Database,
  listingKey: string,
  status: FtActiveOrderStatus,
  options?: { filledTxId?: string; nowMs?: number },
  saveFn?: () => void,
): FtActiveOrderRecord | null {
  ensureFtOrderTables(db);
  const now = options?.nowMs ?? Date.now();
  db.run(
    `UPDATE ft_active_orders
     SET status = ?,
         filled_tx_id = COALESCE(?, filled_tx_id),
         updated_at = ?
     WHERE listing_key = ?`,
    [status, options?.filledTxId ?? null, now, listingKey],
  );
  saveFn?.();
  return getFtActiveOrderByKey(db, listingKey);
}

export function markFtOrdersCanceledByOutpoint(
  db: Database,
  metabotId: number,
  utxoOutpoint: string,
  nowMs = Date.now(),
  saveFn?: () => void,
): number {
  ensureFtOrderTables(db);
  const outpoint = normalizeOutpoint(utxoOutpoint);
  const before = db.exec(
    `SELECT COUNT(*) FROM ft_active_orders WHERE metabot_id = ? AND utxo_outpoint = ? AND status = 'active'`,
    [metabotId, outpoint],
  );
  const count = Number(before[0]?.values?.[0]?.[0] ?? 0);
  if (count > 0) {
    db.run(
      `UPDATE ft_active_orders
       SET status = 'canceled', updated_at = ?
       WHERE metabot_id = ? AND utxo_outpoint = ? AND status = 'active'`,
      [nowMs, metabotId, outpoint],
    );
    saveFn?.();
  }
  return count;
}

export function getFtBatchOrderProgress(
  db: Database,
  batchGroupId: string,
): FtBatchOrderProgress | null {
  const lots = listFtActiveOrders(db, { batchGroupId: String(batchGroupId ?? '').trim() });
  if (lots.length === 0) return null;
  const first = lots[0];
  let filledLots = 0;
  let activeLots = 0;
  let canceledLots = 0;
  for (const lot of lots) {
    if (lot.status === 'filled') filledLots += 1;
    else if (lot.status === 'active') activeLots += 1;
    else canceledLots += 1;
  }
  return {
    batchGroupId: first.batchGroupId,
    assetKey: first.assetKey,
    symbol: first.symbol,
    rail: first.rail,
    totalLots: lots.length,
    filledLots,
    activeLots,
    canceledLots,
    lots,
  };
}

export function getMeFtFulfillmentRecord(
  db: Database,
  orderId: string,
): MeFtSellerFulfillmentRecord | null {
  ensureFtOrderTables(db);
  const res = db.exec(
    `SELECT order_id, seller_metabot_id, listing_key, asset_key, chain,
            token_amount_base, buyer_receive_address, amount_milli, status,
            delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
     FROM me_ft_seller_fulfillments
     WHERE order_id = ? LIMIT 1`,
    [orderId],
  );
  const row = res[0]?.values?.[0];
  if (!row) return null;
  return {
    orderId: String(row[0] ?? ''),
    sellerMetabotId: Number(row[1] ?? 0),
    ...(row[2] ? { listingKey: String(row[2]) } : {}),
    assetKey: String(row[3] ?? ''),
    chain: String(row[4] ?? 'mvc') === 'btc' ? 'btc' : 'mvc',
    tokenAmountBase: String(row[5] ?? '0'),
    buyerReceiveAddress: String(row[6] ?? ''),
    amountMilli: Number(row[7] ?? 0),
    status: String(row[8] ?? 'transferring') as MeFtSellerFulfillmentStatus,
    ...(row[9] ? { deliveryTxId: String(row[9]) } : {}),
    ...(row[10] ? { tradePinId: String(row[10]) } : {}),
    ...(row[11] ? { errorMessage: String(row[11]) } : {}),
    createdAt: Number(row[12] ?? 0),
    updatedAt: Number(row[13] ?? 0),
  };
}

export function upsertMeFtFulfillmentRecord(
  db: Database,
  record: MeFtSellerFulfillmentRecord,
  saveFn?: () => void,
): void {
  ensureFtOrderTables(db);
  db.run(
    `INSERT OR REPLACE INTO me_ft_seller_fulfillments (
      order_id, seller_metabot_id, listing_key, asset_key, chain,
      token_amount_base, buyer_receive_address, amount_milli, status,
      delivery_tx_id, trade_pin_id, error_message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      record.orderId,
      record.sellerMetabotId,
      record.listingKey ?? null,
      record.assetKey,
      record.chain,
      record.tokenAmountBase,
      record.buyerReceiveAddress,
      record.amountMilli,
      record.status,
      record.deliveryTxId ?? null,
      record.tradePinId ?? null,
      record.errorMessage ?? null,
      record.createdAt,
      record.updatedAt,
    ],
  );
  saveFn?.();
}
