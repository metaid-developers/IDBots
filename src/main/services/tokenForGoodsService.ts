/**
 * Token-for-Goods Service (WS-4 / Contract C5.2)
 *
 * Dual-mode escrowless delivery engine for buying MRC-721 digital goods with
 * fungible tokens:
 * - Path A (MVC same-chain MetaContract FT <-> MRC-721): Buyer builds a
 *   half-signed atomic swap proposal (`FT_GOODS_ATOMIC_PROPOSAL_V1`); Seller
 *   performs offline byte-level verification (anti-drain, exact codehash+genesis
 *   anti-spoofing, lock checks), signs only `itemOutpoint`, and broadcasts.
 * - Path B (Cross-chain BTC MRC-20 -> MVC MRC-721): 5-minute exclusive SQLite
 *   reservation lock (mutually exclusive with ME escrow orders), authoritative
 *   man-p2p / Metalet MRC-20 verification (preventing S-01 ticker spoofing and
 *   S-02 `sendAllAmountToFirstOutput` fallback fraud), persistent `payment_tx_id`
 *   anti-replay table (S-06), and immediate `mrc721_transfer` delivery.
 */

import { randomBytes } from 'node:crypto';
import { mvc } from 'meta-contract';
import type { SqliteDatabase } from '../sqliteTypes';
import type { MetabotStore } from '../metabotStore';
import { getMvcWalletFromPath } from './metabotWalletService';
import { isMvcAddress, isMrc721PinId } from './mrc721Service';
import { getWalletTxStatus } from './walletTxStatusService';
import {
  baseUnitsToDecimalDisplay,
  decimalDisplayToBaseUnits,
  parseCanonicalFtAssetKey,
} from './mrc721SellIntentService';
import {
  attachMvcFundingSignatureContext,
  selectMvcFundingUtxos,
} from './tokenTransferAdapters';
import {
  BN_SHIM,
  buildOcsCheckPreimage,
  classifyVerify,
  getNewTokenScript,
  getOptimumCheckerType,
  getTokenCodeHashHex,
  getTokenIdHex,
  OP_TRANSFER,
  parseTokenDataPart,
  p2pkhScript,
  preimageToHex,
  runBareInterpreter,
  SIGHASH_ALL_FORKID,
} from '../libs/mvcTokenSellAssembly';

const scryptlib = require('meta-contract/dist/scryptlib');
const TokenUtil = require('meta-contract/dist/common/tokenUtil');
const { Prevouts } = require('meta-contract/dist/common/Prevouts');
const { TxComposer } = require('meta-contract/dist/tx-composer');
const { TokenFactory } = require('meta-contract/dist/mcp02/contract-factory/token');
const { TokenTransferCheckFactory } = require('meta-contract/dist/mcp02/contract-factory/tokenTransferCheck');
const { ContractUtil } = require('meta-contract/dist/mcp02/contractUtil');
const ftProto = require('meta-contract/dist/mcp02/contract-proto/token.proto.js');

const METALET_HOST = 'https://www.metalet.space';
const APIMVC_HOST = 'https://api.microvisionchain.com/open-api-mvc';
const NET = 'livenet';
const DEFAULT_PATH = "m/44'/10001'/0'/0/0";
const TXID_RE = /^[0-9a-fA-F]{64}$/;

export const TOKEN_GOODS_RESERVATION_TTL_MS = 5 * 60 * 1000;

export type TokenGoodsReservationStatus =
  | 'reserved'
  | 'transferring'
  | 'fulfilled'
  | 'released'
  | 'expired';

export interface TokenGoodsReservationRecord {
  reservationId: string;
  sellerMetabotId: number;
  itemPinId: string;
  assetKey: string;
  buyerNftAddress: string;
  buyerGlobalMetaId?: string;
  sellerReceiveAddress: string;
  amountBase: string;
  status: TokenGoodsReservationStatus;
  paymentTxId?: string;
  nftDeliveryTxId?: string;
  tradePinId?: string;
  errorMessage?: string;
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface TokenGoodsUsedPaymentRecord {
  paymentTxId: string;
  reservationId: string;
  itemPinId: string;
  assetKey: string;
  amountBase: string;
  sellerMetabotId: number;
  nftDeliveryTxId?: string;
  createdAt: number;
}

export function ensureTokenForGoodsSchema(db: SqliteDatabase): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS token_goods_reservations (
      reservation_id TEXT PRIMARY KEY,
      seller_metabot_id INTEGER NOT NULL,
      item_pin_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      buyer_nft_address TEXT NOT NULL,
      buyer_global_metaid TEXT,
      seller_receive_address TEXT NOT NULL,
      amount_base TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'reserved',
      payment_tx_id TEXT,
      nft_delivery_tx_id TEXT,
      trade_pin_id TEXT,
      error_message TEXT,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_token_goods_res_item
    ON token_goods_reservations(item_pin_id, status, expires_at);
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS token_goods_used_payments (
      payment_tx_id TEXT PRIMARY KEY,
      reservation_id TEXT NOT NULL,
      item_pin_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      amount_base TEXT NOT NULL,
      seller_metabot_id INTEGER NOT NULL,
      nft_delivery_tx_id TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_token_goods_used_item
    ON token_goods_used_payments(item_pin_id, reservation_id);
  `);
}

function rowToReservation(row: unknown[]): TokenGoodsReservationRecord {
  return {
    reservationId: String(row[0] ?? ''),
    sellerMetabotId: Number(row[1] ?? 0),
    itemPinId: String(row[2] ?? ''),
    assetKey: String(row[3] ?? ''),
    buyerNftAddress: String(row[4] ?? ''),
    ...(row[5] ? { buyerGlobalMetaId: String(row[5]) } : {}),
    sellerReceiveAddress: String(row[6] ?? ''),
    amountBase: String(row[7] ?? '0'),
    status: String(row[8] ?? 'reserved') as TokenGoodsReservationStatus,
    ...(row[9] ? { paymentTxId: String(row[9]) } : {}),
    ...(row[10] ? { nftDeliveryTxId: String(row[10]) } : {}),
    ...(row[11] ? { tradePinId: String(row[11]) } : {}),
    ...(row[12] ? { errorMessage: String(row[12]) } : {}),
    expiresAt: Number(row[13] ?? 0),
    createdAt: Number(row[14] ?? 0),
    updatedAt: Number(row[15] ?? 0),
  };
}

const SELECT_RES_COLS = `
  reservation_id, seller_metabot_id, item_pin_id, asset_key, buyer_nft_address,
  buyer_global_metaid, seller_receive_address, amount_base, status, payment_tx_id,
  nft_delivery_tx_id, trade_pin_id, error_message, expires_at, created_at, updated_at
`;

export function expireStaleTokenGoodsReservations(
  db: SqliteDatabase,
  nowMs: number = Date.now(),
  saveDb?: () => void,
): void {
  ensureTokenForGoodsSchema(db);
  db.run(
    `UPDATE token_goods_reservations
     SET status = 'expired', updated_at = ?
     WHERE status = 'reserved' AND expires_at <= ?`,
    [nowMs, nowMs],
  );
  saveDb?.();
}

export function getTokenGoodsReservation(
  db: SqliteDatabase,
  reservationId: string,
): TokenGoodsReservationRecord | null {
  ensureTokenForGoodsSchema(db);
  const res = db.exec(
    `SELECT ${SELECT_RES_COLS} FROM token_goods_reservations WHERE reservation_id = ? LIMIT 1`,
    [String(reservationId ?? '').trim()],
  );
  const row = res[0]?.values?.[0];
  return row ? rowToReservation(row) : null;
}

export function hasActiveItemLock(
  db: SqliteDatabase,
  itemPinId: string,
  nowMs: number = Date.now(),
): { locked: boolean; reason?: string } {
  ensureTokenForGoodsSchema(db);
  const normalizedPinId = String(itemPinId ?? '').trim().toLowerCase();
  if (!normalizedPinId) return { locked: true, reason: 'invalid_item_pin_id' };

  // Check active ME escrow fulfillments if table exists
  try {
    const meRes = db.exec(
      `SELECT order_id, status FROM me_nft_seller_fulfillments
       WHERE lower(item_pin_id) = ? AND status IN ('processing', 'transferred')
       LIMIT 1`,
      [normalizedPinId],
    );
    const meRow = meRes[0]?.values?.[0];
    if (meRow) {
      return {
        locked: true,
        reason: `item_locked_by_me_escrow:${String(meRow[0] ?? '')}`,
      };
    }
  } catch {
    // Table might not exist in an isolated unit test DB that did not run meNft schema
  }

  // Check active token reservation lock
  const res = db.exec(
    `SELECT reservation_id, status FROM token_goods_reservations
     WHERE lower(item_pin_id) = ?
       AND (status = 'transferring' OR (status = 'reserved' AND expires_at > ?))
     LIMIT 1`,
    [normalizedPinId, nowMs],
  );
  const lockRow = res[0]?.values?.[0];
  if (lockRow) {
    return {
      locked: true,
      reason: `item_reserved_by_active_token_order:${String(lockRow[0] ?? '')}`,
    };
  }
  return { locked: false };
}

export function createTokenGoodsReservation(
  db: SqliteDatabase,
  saveDb: (() => void) | undefined,
  params: {
    sellerMetabotId: number;
    itemPinId: string;
    assetKey: string;
    buyerNftAddress: string;
    buyerGlobalMetaId?: string;
    sellerReceiveAddress: string;
    amountBase: string;
    ttlMs?: number;
    nowMs?: number;
  },
): { ok: true; reservation: TokenGoodsReservationRecord } | { ok: false; reason: string } {
  const nowMs = params.nowMs ?? Date.now();
  const itemPinId = String(params.itemPinId ?? '').trim().toLowerCase();
  expireStaleTokenGoodsReservations(db, nowMs);

  const lockCheck = hasActiveItemLock(db, itemPinId, nowMs);
  if (lockCheck.locked) {
    return { ok: false, reason: lockCheck.reason || 'item_locked' };
  }

  const reservationId = `tgres_${randomBytes(10).toString('hex')}`;
  const ttlMs = params.ttlMs && params.ttlMs > 0 ? params.ttlMs : TOKEN_GOODS_RESERVATION_TTL_MS;
  const expiresAt = nowMs + ttlMs;

  db.run(
    `INSERT INTO token_goods_reservations (
      reservation_id, seller_metabot_id, item_pin_id, asset_key, buyer_nft_address,
      buyer_global_metaid, seller_receive_address, amount_base, status,
      expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`,
    [
      reservationId,
      params.sellerMetabotId,
      itemPinId,
      params.assetKey.trim().toLowerCase(),
      params.buyerNftAddress.trim(),
      params.buyerGlobalMetaId?.trim() || null,
      params.sellerReceiveAddress.trim(),
      params.amountBase.trim(),
      expiresAt,
      nowMs,
      nowMs,
    ],
  );
  saveDb?.();
  return { ok: true, reservation: getTokenGoodsReservation(db, reservationId)! };
}

export function updateTokenGoodsReservation(
  db: SqliteDatabase,
  saveDb: (() => void) | undefined,
  reservationId: string,
  updates: {
    status?: TokenGoodsReservationStatus;
    paymentTxId?: string | null;
    nftDeliveryTxId?: string | null;
    tradePinId?: string | null;
    errorMessage?: string | null;
    nowMs?: number;
  },
): TokenGoodsReservationRecord | null {
  ensureTokenForGoodsSchema(db);
  const nowMs = updates.nowMs ?? Date.now();
  const existing = getTokenGoodsReservation(db, reservationId);
  if (!existing) return null;
  db.run(
    `UPDATE token_goods_reservations
     SET status = COALESCE(?, status),
         payment_tx_id = COALESCE(?, payment_tx_id),
         nft_delivery_tx_id = COALESCE(?, nft_delivery_tx_id),
         trade_pin_id = COALESCE(?, trade_pin_id),
         error_message = ?,
         updated_at = ?
     WHERE reservation_id = ?`,
    [
      updates.status ?? null,
      updates.paymentTxId === undefined ? null : updates.paymentTxId,
      updates.nftDeliveryTxId === undefined ? null : updates.nftDeliveryTxId,
      updates.tradePinId === undefined ? null : updates.tradePinId,
      updates.errorMessage === undefined ? existing.errorMessage ?? null : updates.errorMessage,
      nowMs,
      reservationId,
    ],
  );
  saveDb?.();
  return getTokenGoodsReservation(db, reservationId);
}

export function findUsedPaymentRecord(
  db: SqliteDatabase,
  paymentTxId: string,
): TokenGoodsUsedPaymentRecord | null {
  ensureTokenForGoodsSchema(db);
  const normalizedTxId = String(paymentTxId ?? '').trim().toLowerCase();
  if (!normalizedTxId) return null;
  const res = db.exec(
    `SELECT payment_tx_id, reservation_id, item_pin_id, asset_key, amount_base,
            seller_metabot_id, nft_delivery_tx_id, created_at
     FROM token_goods_used_payments
     WHERE payment_tx_id = ? LIMIT 1`,
    [normalizedTxId],
  );
  const row = res[0]?.values?.[0];
  if (!row) return null;
  return {
    paymentTxId: String(row[0] ?? ''),
    reservationId: String(row[1] ?? ''),
    itemPinId: String(row[2] ?? ''),
    assetKey: String(row[3] ?? ''),
    amountBase: String(row[4] ?? '0'),
    sellerMetabotId: Number(row[5] ?? 0),
    ...(row[6] ? { nftDeliveryTxId: String(row[6]) } : {}),
    createdAt: Number(row[7] ?? 0),
  };
}

export function claimOrReplayUsedPayment(
  db: SqliteDatabase,
  saveDb: (() => void) | undefined,
  params: {
    paymentTxId: string;
    reservationId: string;
    itemPinId: string;
    assetKey: string;
    amountBase: string;
    sellerMetabotId: number;
    nowMs?: number;
  },
):
  | { outcome: 'claimed' }
  | { outcome: 'idempotent'; existing: TokenGoodsUsedPaymentRecord }
  | { outcome: 'replay_rejected'; existing: TokenGoodsUsedPaymentRecord } {
  ensureTokenForGoodsSchema(db);
  const normalizedTxId = String(params.paymentTxId ?? '').trim().toLowerCase();
  const existing = findUsedPaymentRecord(db, normalizedTxId);
  if (existing) {
    if (existing.reservationId === params.reservationId) {
      return { outcome: 'idempotent', existing };
    }
    return { outcome: 'replay_rejected', existing };
  }
  const nowMs = params.nowMs ?? Date.now();
  db.run(
    `INSERT INTO token_goods_used_payments (
      payment_tx_id, reservation_id, item_pin_id, asset_key, amount_base,
      seller_metabot_id, nft_delivery_tx_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      normalizedTxId,
      params.reservationId,
      params.itemPinId.toLowerCase(),
      params.assetKey.toLowerCase(),
      params.amountBase,
      params.sellerMetabotId,
      nowMs,
    ],
  );
  saveDb?.();
  return { outcome: 'claimed' };
}

export function updateUsedPaymentDeliveryTx(
  db: SqliteDatabase,
  saveDb: (() => void) | undefined,
  paymentTxId: string,
  nftDeliveryTxId: string,
): void {
  ensureTokenForGoodsSchema(db);
  db.run(
    `UPDATE token_goods_used_payments SET nft_delivery_tx_id = ? WHERE payment_tx_id = ?`,
    [nftDeliveryTxId, paymentTxId.trim().toLowerCase()],
  );
  saveDb?.();
}

// ---------------------------------------------------------------------------
// Path B: Authoritative BTC MRC-20 Payment Verifier (S-01 & S-02 Hardened)
// ---------------------------------------------------------------------------

export interface AuthoritativeMrc20Utxo {
  txId?: string;
  txid?: string;
  address?: string;
  toAddress?: string;
  status?: string;
  blockHeight?: number;
  confirmations?: number;
  mrc20Id?: string;
  tickId?: string;
  tick?: string;
  ticker?: string;
  decimals?: number | string;
  amount?: string;
  amtChange?: string;
  mrc20s?: Array<{
    amount?: string;
    tick?: string;
    ticker?: string;
    mrc20Id?: string;
    tickId?: string;
    decimals?: number | string;
    status?: string;
    address?: string;
  }>;
}

export interface VerifyMrc20GoodsPaymentInput {
  paymentTxId: string;
  sellerReceiveAddress: string;
  expectedMrc20Id: string;
  expectedDecimals: number;
  expectedAmountBase: string;
  /** Minimum BTC block confirmations required (default 1 — blocks 0-conf RBF double-spend). */
  minConfirmations?: number;
}

export interface VerifyMrc20GoodsPaymentResult {
  valid: boolean;
  reason: string;
  matchedAmountBase: string;
  expectedAmountBase: string;
  confirmations?: number;
}

const REJECTED_MRC20_UTXO_STATUSES = new Set([
  'invalid',
  'failed',
  'spent',
  'transferpendingout',
  'pendingout',
  'pending_out',
]);

const CONFIRMED_MRC20_UTXO_STATUSES = new Set([
  '',
  'available',
  'confirmed',
  '1',
]);

const UNCONFIRMED_MRC20_UTXO_STATUSES = new Set([
  'transferpendingin',
  'pendingin',
  'pending_in',
  'unconfirmed',
  '0',
]);

function isAllowedMrc20Status(rawStatus: unknown, requireConfirmed: boolean): boolean {
  const s = String(rawStatus ?? '').trim().toLowerCase();
  if (!s) return true;
  if (REJECTED_MRC20_UTXO_STATUSES.has(s)) return false;
  if (CONFIRMED_MRC20_UTXO_STATUSES.has(s)) return true;
  if (!requireConfirmed && UNCONFIRMED_MRC20_UTXO_STATUSES.has(s)) return true;
  return false;
}

function safeDisplayToBaseUnits(rawAmount: unknown, decimals: number): bigint {
  const text = String(rawAmount ?? '').trim();
  if (!text) return 0n;
  try {
    return BigInt(decimalDisplayToBaseUnits(text, decimals));
  } catch {
    return 0n;
  }
}

export async function fetchMrc20UtxosForAddressDefault(params: {
  address: string;
  mrc20Id: string;
}): Promise<AuthoritativeMrc20Utxo[]> {
  const url = `${METALET_HOST}/wallet-api/v3/mrc20/address/utxo?net=${NET}&address=${encodeURIComponent(params.address)}&tickId=${encodeURIComponent(params.mrc20Id)}&source=mrc20-v2`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const json = await res.json() as { code?: number; message?: string; data?: { list?: AuthoritativeMrc20Utxo[] } };
  if (!res.ok || (json.code !== 0 && json.code !== undefined)) {
    throw new Error(json?.message || `MRC-20 UTXO query failed (HTTP ${res.status})`);
  }
  return Array.isArray(json?.data?.list) ? json.data.list : [];
}

/**
 * Verify via authoritative man-p2p / Metalet MRC-20 asset state AND BTC
 * on-chain confirmation status that `paymentTxId` genuinely credited
 * `sellerReceiveAddress` with a confirmed `Available` balance of exact
 * `expectedMrc20Id` >= `expectedAmountBase`.
 *
 * Blocks:
 * - S-01 Ticker Spoofing: requires exact `mrc20Id` match (never symbol-only).
 * - S-02 `sendAllAmountToFirstOutput` fallback fraud: never trusts raw tx JSON;
 *   only counts indexed UTXO credits owned by `sellerReceiveAddress`.
 * - BTC 0-conf RBF double-spend: requires `>= minConfirmations` (default 1)
 *   BTC block confirmations and rejects pending/unconfirmed UTXO states.
 */
export async function verifyMrc20GoodsPayment(
  input: VerifyMrc20GoodsPaymentInput,
  deps?: {
    fetchUtxos?: (params: { address: string; mrc20Id: string }) => Promise<AuthoritativeMrc20Utxo[]>;
    fetchBtcTxStatus?: (txid: string) => Promise<{ found: boolean; confirmed?: boolean; confirmations?: number }>;
  },
): Promise<VerifyMrc20GoodsPaymentResult> {
  const paymentTxId = String(input.paymentTxId ?? '').trim().toLowerCase();
  if (!TXID_RE.test(paymentTxId)) {
    return {
      valid: false,
      reason: 'invalid_payment_tx_id',
      matchedAmountBase: '0',
      expectedAmountBase: input.expectedAmountBase,
    };
  }
  const sellerReceiveAddress = String(input.sellerReceiveAddress ?? '').trim();
  const expectedMrc20Id = String(input.expectedMrc20Id ?? '').trim().toLowerCase();
  const expectedBase = BigInt(input.expectedAmountBase);
  const minConfirmations = Number.isInteger(input.minConfirmations) && Number(input.minConfirmations) >= 0
    ? Number(input.minConfirmations)
    : 1;
  const requireConfirmed = minConfirmations >= 1;
  if (!sellerReceiveAddress || !expectedMrc20Id || expectedBase <= 0n) {
    return {
      valid: false,
      reason: 'invalid_verification_params',
      matchedAmountBase: '0',
      expectedAmountBase: input.expectedAmountBase,
    };
  }

  const fetchUtxos = deps?.fetchUtxos ?? fetchMrc20UtxosForAddressDefault;
  let utxos: AuthoritativeMrc20Utxo[];
  try {
    utxos = await fetchUtxos({ address: sellerReceiveAddress, mrc20Id: expectedMrc20Id });
  } catch (err) {
    return {
      valid: false,
      reason: `mrc20_utxo_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
      matchedAmountBase: '0',
      expectedAmountBase: expectedBase.toString(),
    };
  }

  let matchedBase = 0n;
  let sawUnconfirmedMatch = false;
  for (const utxo of utxos) {
    const utxoTxId = String(utxo.txId ?? utxo.txid ?? '').trim().toLowerCase();
    if (utxoTxId !== paymentTxId) continue;

    // Enforce recipient ownership when the indexer includes an address field
    const utxoOwner = String(utxo.toAddress ?? utxo.address ?? '').trim();
    if (utxoOwner && utxoOwner.toLowerCase() !== sellerReceiveAddress.toLowerCase()) {
      continue;
    }
    if (requireConfirmed) {
      const utxoConf = typeof utxo.confirmations === 'number' ? utxo.confirmations : null;
      const utxoHeight = typeof utxo.blockHeight === 'number' ? utxo.blockHeight : null;
      if ((utxoConf !== null && utxoConf < minConfirmations) || (utxoHeight !== null && utxoHeight <= 0)) {
        sawUnconfirmedMatch = true;
        continue;
      }
    }
    if (!isAllowedMrc20Status(utxo.status, requireConfirmed)) {
      if (requireConfirmed && UNCONFIRMED_MRC20_UTXO_STATUSES.has(String(utxo.status ?? '').trim().toLowerCase())) {
        sawUnconfirmedMatch = true;
      }
      continue;
    }

    const entries = Array.isArray(utxo.mrc20s) ? utxo.mrc20s : [];
    if (entries.length === 0) {
      const utxoTickId = String(utxo.mrc20Id ?? utxo.tickId ?? '').trim().toLowerCase();
      // S-01: Must carry exact expectedMrc20Id (if present; or endpoint filtered by tickId)
      if (utxoTickId && utxoTickId !== expectedMrc20Id) continue;
      const dec = Number.isInteger(Number(utxo.decimals)) ? Number(utxo.decimals) : input.expectedDecimals;
      matchedBase += safeDisplayToBaseUnits(utxo.amount ?? utxo.amtChange, dec);
      continue;
    }

    for (const entry of entries) {
      const entryId = String(entry.mrc20Id ?? entry.tickId ?? utxo.mrc20Id ?? utxo.tickId ?? '').trim().toLowerCase();
      // S-01 hard check: reject any entry lacking or mismatching exact mrc20Id
      if (!entryId || entryId !== expectedMrc20Id) continue;
      if (!isAllowedMrc20Status(entry.status, requireConfirmed)) {
        if (requireConfirmed && UNCONFIRMED_MRC20_UTXO_STATUSES.has(String(entry.status ?? '').trim().toLowerCase())) {
          sawUnconfirmedMatch = true;
        }
        continue;
      }
      const entryOwner = String(entry.address ?? '').trim();
      if (entryOwner && entryOwner.toLowerCase() !== sellerReceiveAddress.toLowerCase()) {
        continue;
      }
      const dec = Number.isInteger(Number(entry.decimals)) ? Number(entry.decimals) : input.expectedDecimals;
      matchedBase += safeDisplayToBaseUnits(entry.amount, dec);
    }
  }

  if (matchedBase <= 0n) {
    return {
      valid: false,
      reason: sawUnconfirmedMatch
        ? `btc_payment_unconfirmed:0:${minConfirmations}`
        : 'no_valid_mrc20_credit_for_seller',
      matchedAmountBase: '0',
      expectedAmountBase: expectedBase.toString(),
    };
  }
  if (matchedBase < expectedBase) {
    return {
      valid: false,
      reason: `insufficient_mrc20_amount:${matchedBase.toString()}:${expectedBase.toString()}`,
      matchedAmountBase: matchedBase.toString(),
      expectedAmountBase: expectedBase.toString(),
    };
  }

  if (requireConfirmed) {
    const fetchBtcTxStatus =
      deps?.fetchBtcTxStatus ??
      ((txid: string) => getWalletTxStatus({}, { chain: 'btc', txid }));
    let txStatus: { found: boolean; confirmed?: boolean; confirmations?: number };
    try {
      txStatus = await fetchBtcTxStatus(paymentTxId);
    } catch (err) {
      return {
        valid: false,
        reason: `btc_tx_status_fetch_failed:${err instanceof Error ? err.message : String(err)}`,
        matchedAmountBase: matchedBase.toString(),
        expectedAmountBase: expectedBase.toString(),
      };
    }
    if (!txStatus?.found) {
      return {
        valid: false,
        reason: 'btc_payment_tx_not_found',
        matchedAmountBase: matchedBase.toString(),
        expectedAmountBase: expectedBase.toString(),
      };
    }
    const confirmations =
      typeof txStatus.confirmations === 'number' && Number.isFinite(txStatus.confirmations)
        ? txStatus.confirmations
        : txStatus.confirmed === true
          ? 1
          : 0;
    if (txStatus.confirmed !== true || confirmations < minConfirmations) {
      return {
        valid: false,
        reason: `btc_payment_unconfirmed:${confirmations}:${minConfirmations}`,
        matchedAmountBase: matchedBase.toString(),
        expectedAmountBase: expectedBase.toString(),
        confirmations,
      };
    }
    return {
      valid: true,
      reason: 'verified',
      matchedAmountBase: matchedBase.toString(),
      expectedAmountBase: expectedBase.toString(),
      confirmations,
    };
  }

  return {
    valid: true,
    reason: 'verified',
    matchedAmountBase: matchedBase.toString(),
    expectedAmountBase: expectedBase.toString(),
  };
}

// ---------------------------------------------------------------------------
// Path A: MVC Same-Chain MetaContract FT <-> MRC-721 Atomic Swap
// ---------------------------------------------------------------------------

export interface MvcFtUtxoRow {
  txid: string;
  txIndex: number;
  valueString: string;
  codeHash?: string;
  genesis?: string;
}

export interface MvcFundingUtxo {
  txId: string;
  outputIndex: number;
  satoshis: number;
  address?: string;
  height?: number;
  [key: string]: unknown;
}

export interface BuildMvcFtGoodsAtomicProposalInput {
  metabotId: number;
  itemPinId: string;
  itemOutpoint: { txid: string; vout: number; satoshis: number };
  sellerMvcAddress: string;
  codehash: string;
  genesis: string;
  amountBase: string;
  buyerNftAddress: string;
  feeRate: number;
  excludeOutpoints?: string[];
}

export interface BuildMvcFtGoodsAtomicProposalResult {
  proposalId: string;
  amountCheckRawTx: string;
  partialTx: string;
  feeSats: number;
  spentOutpoints: string[];
}

export interface BuildMvcFtGoodsAtomicProposalDeps {
  fetchFtUtxos?: (address: string, codehash: string, genesis: string) => Promise<MvcFtUtxoRow[]>;
  fetchRawTx?: (txid: string) => Promise<string>;
  fetchFundingUtxos?: (address: string) => Promise<MvcFundingUtxo[]>;
}

async function fetchMvcRawTxDefault(txid: string): Promise<string> {
  const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/tx/raw?txId=${txid}&net=mainnet`, {
    signal: AbortSignal.timeout(10_000),
  });
  const json = await res.json() as { data?: { hex?: string } };
  const hex = json?.data?.hex;
  if (!hex) throw new Error(`no raw tx from metalet: ${txid}`);
  return hex.toLowerCase();
}

async function fetchMvcFtUtxosDefault(address: string, codehash: string, genesis: string): Promise<MvcFtUtxoRow[]> {
  const url = `${APIMVC_HOST}/contract/ft/address/${encodeURIComponent(address)}/utxo?codeHash=${codehash}&genesis=${genesis}`;
  const res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`GET ft utxos failed (HTTP ${res.status})`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function fetchMvcFundingUtxosDefault(address: string): Promise<MvcFundingUtxo[]> {
  const all: MvcFundingUtxo[] = [];
  let flag: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ address, net: NET, ...(flag ? { flag } : {}) });
    const res = await fetch(`${METALET_HOST}/wallet-api/v4/mvc/address/utxo-list?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json() as {
      data?: { list?: Array<{ txid?: string; outIndex?: number; value?: number; height?: number; flag?: string }> };
    };
    const list = json?.data?.list ?? [];
    if (!list.length) break;
    for (const u of list) {
      if (Number(u.value) >= 600) {
        all.push({
          txId: String(u.txid || '').trim(),
          outputIndex: Number(u.outIndex),
          satoshis: Number(u.value),
          address,
          height: Number(u.height ?? 0) || 0,
        });
      }
    }
    flag = list[list.length - 1]?.flag;
    if (!flag) break;
  }
  return all;
}

function rebuildProofClasses() {
  return scryptlib.buildTypeClasses(
    require('meta-contract/dist/mcp02/contract-desc/txUtil_desc.json'),
  );
}

function rebuildTxInputProof(ProofClasses: any, fields: any) {
  const fieldHex = (v: unknown): string => {
    if (typeof v === 'string') return v;
    const obj = v as { serialize?: () => string; toHex?: () => string };
    if (obj && typeof obj.serialize === 'function') return obj.serialize();
    if (obj && typeof obj.toHex === 'function') return obj.toHex();
    return String(v);
  };
  return new ProofClasses.TxInputProof({
    hashProof: new scryptlib.Bytes(fieldHex(fields.hashProof)),
    txHash: new scryptlib.Bytes(fieldHex(fields.txHash)),
    outputIndexBytes: new scryptlib.Bytes(fieldHex(fields.outputIndexBytes)),
    sequenceBytes: new scryptlib.Bytes(fieldHex(fields.sequenceBytes)),
  });
}

function findPrevTokenInputIndex(tokenTx: mvc.Transaction, targetGenesis: string): number {
  const outputsScript = tokenTx.outputs.find((out: any) => {
    try {
      return ftProto.getQueryGenesis(out.script.toBuffer()) === targetGenesis;
    } catch {
      return false;
    }
  });
  const curDp = outputsScript ? ftProto.parseDataPart(outputsScript.script.toBuffer()) : null;
  for (let idx = 0; idx < tokenTx.inputs.length; idx += 1) {
    const inp = tokenTx.inputs[idx];
    const chunks = new mvc.Script(inp.script).chunks;
    if (!chunks || chunks.length === 0 || !chunks[0]?.buf) continue;
    try {
      const lockingScriptBuf = TokenUtil.getLockingScriptFromPreimage(chunks[0].buf);
      if (!lockingScriptBuf) continue;
      if (ftProto.getQueryGenesis(lockingScriptBuf) === targetGenesis) return idx;
      if (curDp) {
        const dpObj = ftProto.parseDataPart(lockingScriptBuf);
        dpObj.sensibleID = curDp.sensibleID;
        const updated = ftProto.updateScript(lockingScriptBuf, dpObj);
        const gh = mvc.crypto.Hash.sha256ripemd160(updated).toString('hex');
        if (gh === curDp.genesisHash) return idx;
      }
    } catch {
      continue;
    }
  }
  return 0;
}

/**
 * Build Buyer's half-signed atomic swap proposal (Path A):
 *   inputs:  [buyerFtInput(s)..., buyerFeeInput, sellerItemOutpoint (UNSIGNED), transferCheckInput]
 *   outputs: [sellerFtOutput, (optional buyerFtChangeOutput), buyerNftAndChangeP2PKH]
 */
export async function buildMvcFtGoodsAtomicProposal(
  store: MetabotStore,
  input: BuildMvcFtGoodsAtomicProposalInput,
  deps: BuildMvcFtGoodsAtomicProposalDeps = {},
): Promise<BuildMvcFtGoodsAtomicProposalResult> {
  ContractUtil.init();
  const wallet = store.getMetabotWalletByMetabotId(input.metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${input.metabotId} wallet mnemonic not available`);
  }
  if (!isMrc721PinId(input.itemPinId)) {
    throw new Error(`Invalid itemPinId: ${input.itemPinId}`);
  }
  if (!isMvcAddress(input.sellerMvcAddress) || !isMvcAddress(input.buyerNftAddress)) {
    throw new Error('sellerMvcAddress and buyerNftAddress must be valid MVC addresses');
  }
  if (input.sellerMvcAddress.toLowerCase() === input.buyerNftAddress.toLowerCase()) {
    throw new Error('self_trade_prohibited: buyer and seller MVC addresses cannot match');
  }

  const mvcWallet = await getMvcWalletFromPath(wallet.mnemonic, wallet.path || DEFAULT_PATH);
  const buyerWif = mvcWallet.getPrivateKey();
  const buyerPrivKey = mvc.PrivateKey.fromWIF(buyerWif);
  const buyerPubHex = buyerPrivKey.toPublicKey().toString();
  const buyerAddress = mvcWallet.getAddress();
  const buyerH160Hex = mvc.crypto.Hash.sha256ripemd160(Buffer.from(buyerPubHex, 'hex')).toString('hex');
  const buyerNftAddr = new mvc.Address(input.buyerNftAddress, 'livenet');
  const buyerNftH160Buf = Buffer.from(buyerNftAddr.hashBuffer);
  const sellerAddr = new mvc.Address(input.sellerMvcAddress, 'livenet');
  const sellerH160Buf = Buffer.from(sellerAddr.hashBuffer);

  const codehash = input.codehash.trim().toLowerCase();
  const genesis = input.genesis.trim().toLowerCase();
  const requiredAmount = BigInt(input.amountBase);
  if (requiredAmount <= 0n) throw new Error('amountBase must be positive');

  const fetchFtUtxos = deps.fetchFtUtxos ?? fetchMvcFtUtxosDefault;
  const fetchRawTx = deps.fetchRawTx ?? fetchMvcRawTxDefault;
  const fetchFunding = deps.fetchFundingUtxos ?? fetchMvcFundingUtxosDefault;

  const excluded = new Set((input.excludeOutpoints ?? []).map((x) => x.trim().toLowerCase()));
  const ftRows = (await fetchFtUtxos(buyerAddress, codehash, genesis))
    .map((r) => ({
      txid: String(r.txid || '').trim().toLowerCase(),
      vout: Number(r.txIndex),
      amount: BigInt(String(r.valueString || '0')),
    }))
    .filter((r) => TXID_RE.test(r.txid) && Number.isInteger(r.vout) && r.vout >= 0 && r.amount > 0n && !excluded.has(`${r.txid}:${r.vout}`));

  if (ftRows.length === 0) {
    throw new Error(`Insufficient MVC FT balance: no spendable UTXOs for ${codehash}:${genesis}`);
  }

  // Pick minimum number of FT UTXOs (max 3 per TransferCheck IN_3_OUT_3)
  ftRows.sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : 0));
  const pickedFt: typeof ftRows = [];
  let ftSum = 0n;
  for (const r of ftRows) {
    pickedFt.push(r);
    ftSum += r.amount;
    if (ftSum >= requiredAmount || pickedFt.length >= 3) break;
  }
  if (ftSum < requiredAmount) {
    throw new Error(`Insufficient MVC FT balance: have ${ftSum.toString()}, need ${requiredAmount.toString()} (or merge fragmented FT UTXOs first)`);
  }

  const ftChange = ftSum - requiredAmount;
  const receivers = [
    { hashBuf: sellerH160Buf, amount: requiredAmount },
    ...(ftChange > 0n ? [{ hashBuf: Buffer.from(buyerH160Hex, 'hex'), amount: ftChange }] : []),
  ];

  // Hydrate each FT UTXO raw tx + direct parent prevTokenTx
  const rawTxCache = new Map<string, string>();
  const getRawCached = async (txid: string): Promise<string> => {
    const key = txid.toLowerCase();
    const cached = rawTxCache.get(key);
    if (cached) return cached;
    const hex = await fetchRawTx(key);
    rawTxCache.set(key, hex);
    return hex;
  };

  interface HydratedFtInput {
    txid: string;
    vout: number;
    satoshis: number;
    scriptBuf: Buffer;
    dp: ReturnType<typeof parseTokenDataPart>;
    tokenTx: mvc.Transaction;
    prevTokenInputIndex: number;
    prevTokenTx: mvc.Transaction;
    prevVout: number;
    prevTokenAddressHex: string;
    prevTokenAmount: bigint;
  }

  const ftInputs: HydratedFtInput[] = [];
  for (const picked of pickedFt) {
    const tokenTxHex = await getRawCached(picked.txid);
    const tokenTx = new mvc.Transaction(tokenTxHex);
    const out = tokenTx.outputs[picked.vout];
    if (!out) throw new Error(`FT output ${picked.txid}:${picked.vout} missing in raw tx`);
    const scriptBuf = out.script.toBuffer();
    const dp = parseTokenDataPart(scriptBuf);
    const prevTokenInputIndex = findPrevTokenInputIndex(tokenTx, genesis);
    const prevInp = tokenTx.inputs[prevTokenInputIndex];
    const prevTxId = prevInp.prevTxId.toString('hex');
    const prevVout = Number(prevInp.outputIndex);
    const prevRaw = await getRawCached(prevTxId);
    const prevTokenTx = new mvc.Transaction(prevRaw);
    const prevDp = parseTokenDataPart(prevTokenTx.outputs[prevVout].script.toBuffer());
    ftInputs.push({
      txid: picked.txid,
      vout: picked.vout,
      satoshis: Number(out.satoshis),
      scriptBuf,
      dp,
      tokenTx,
      prevTokenInputIndex,
      prevTokenTx,
      prevVout,
      prevTokenAddressHex: Buffer.from(String(prevDp.tokenAddress || ''), 'hex').toString('hex'),
      prevTokenAmount: BigInt(String(prevDp.tokenAmount)),
    });
  }

  const baseTokenScriptBuf = ftInputs[0].scriptBuf;
  const tokenOutputSatoshis = ftInputs[0].satoshis;
  const checkerType = getOptimumCheckerType(ftInputs.length, receivers.length);
  const checkInst0 = (TokenTransferCheckFactory as any).createContract(checkerType);
  const checkerDataPart = {
    nSenders: ftInputs.length,
    receiverTokenAmountArray: receivers.map((r) => BN_SHIM(r.amount)),
    receiverArray: receivers.map((r) => ({ hashBuffer: r.hashBuf })),
    nReceivers: receivers.length,
    tokenCodeHash: getTokenCodeHashHex(baseTokenScriptBuf),
    tokenID: getTokenIdHex(baseTokenScriptBuf),
  };
  checkInst0.setFormatedDataPart(checkerDataPart);
  const checkerLockBuf: Buffer = checkInst0.lockingScript.toBuffer();

  // Select buyer P2PKH funding UTXO(s)
  const rawFunding = (await fetchFunding(buyerAddress))
    .filter((u) => !excluded.has(`${u.txId.toLowerCase()}:${u.outputIndex}`));
  const preparedFunding = selectMvcFundingUtxos(
    attachMvcFundingSignatureContext(rawFunding, { senderWif: buyerWif, senderAddress: buyerAddress }),
  );
  if (preparedFunding.length === 0) {
    throw new Error(`No spendable MVC SPACE funding UTXOs at ${buyerAddress} to pay atomic swap fees`);
  }

  const feeRate = Number.isFinite(input.feeRate) && input.feeRate > 0 ? input.feeRate : 1;
  const checkerSats = 3000;
  // Build TransferCheck mint tx (funding -> out0=checker, out1=change used to fund atomic tx)
  const chkFunding = preparedFunding[0];
  const chkFeeEstimate = Math.ceil((148 + checkerLockBuf.length + 100) * feeRate);
  const chkChangeSats = chkFunding.satoshis - checkerSats - chkFeeEstimate;
  if (chkChangeSats < 5000) {
    throw new Error(`MVC funding UTXO ${chkFunding.txId}:${chkFunding.outputIndex} (${chkFunding.satoshis} sats) is too small to cover TransferCheck + atomic swap fees`);
  }

  const chkTc = new TxComposer(new mvc.Transaction());
  chkTc.appendP2PKHInput({
    txId: chkFunding.txId,
    outputIndex: chkFunding.outputIndex,
    satoshis: chkFunding.satoshis,
    address: new mvc.Address(buyerAddress, 'livenet'),
  });
  chkTc.appendOutput({
    lockingScript: mvc.Script.fromBuffer(checkerLockBuf),
    satoshis: checkerSats,
  });
  chkTc.appendOutput({
    lockingScript: mvc.Script.fromBuffer(p2pkhScript(Buffer.from(buyerH160Hex, 'hex'))),
    satoshis: chkChangeSats,
  });
  chkTc.unlockP2PKHInput(buyerPrivKey, 0, SIGHASH_ALL_FORKID);
  const chkTx = chkTc.getTx();
  const amountCheckRawTx = chkTc.getRawHex();

  // Assemble the atomic swap tx:
  // inputs: [ftInputs..., feeInput (chkTx:1), nftInput (seller's itemOutpoint), chkInput (chkTx:0)]
  // outputs: [ftOutputs..., buyerNftAndChangeP2PKH]
  const ProofClasses = rebuildProofClasses();
  const sellerP2pkhBuf = p2pkhScript(sellerH160Buf);
  const buyerNftP2pkhBuf = p2pkhScript(buyerNftH160Buf);
  const ftInSatSum = ftInputs.reduce((s, f) => s + f.satoshis, 0);
  const totalInSats = ftInSatSum + chkChangeSats + input.itemOutpoint.satoshis + checkerSats;
  const ftOutSatSum = receivers.length * tokenOutputSatoshis;

  // Converge fee so changeSatoshis is exact
  let changeSatoshis = totalInSats - ftOutSatSum - 4000;
  let finalTc: any = null;
  let finalFee = 0;

  for (let round = 0; round < 6; round += 1) {
    if (changeSatoshis < Math.max(600, input.itemOutpoint.satoshis)) {
      throw new Error('Insufficient MVC SPACE funding for atomic swap fee + dust floor');
    }
    const tc = new TxComposer(new mvc.Transaction());
    const ftInputIndices: number[] = [];
    for (const ftIn of ftInputs) {
      const idx = tc.appendInput({
        txId: ftIn.txid,
        outputIndex: ftIn.vout,
        satoshis: ftIn.satoshis,
        lockingScript: new mvc.Script(ftIn.scriptBuf),
      });
      ftInputIndices.push(idx);
    }
    const feeIdx = tc.appendInput({
      txId: chkTx.id,
      outputIndex: 1,
      satoshis: chkChangeSats,
      lockingScript: new mvc.Script(p2pkhScript(Buffer.from(buyerH160Hex, 'hex'))),
    });
    const nftIdx = tc.appendInput({
      txId: input.itemOutpoint.txid.toLowerCase(),
      outputIndex: input.itemOutpoint.vout,
      satoshis: input.itemOutpoint.satoshis,
      lockingScript: new mvc.Script(sellerP2pkhBuf),
    });
    const chkIdx = tc.appendInput({
      txId: chkTx.id,
      outputIndex: 0,
      satoshis: checkerSats,
      lockingScript: new mvc.Script(checkerLockBuf),
    });

    for (const r of receivers) {
      tc.appendOutput({
        lockingScript: new mvc.Script(getNewTokenScript(baseTokenScriptBuf, r.hashBuf, r.amount)),
        satoshis: tokenOutputSatoshis,
      });
    }
    tc.appendOutput({
      lockingScript: new mvc.Script(buyerNftP2pkhBuf),
      satoshis: changeSatoshis,
    });

    const prevouts = new Prevouts();
    for (const inp of tc.getTx().inputs) {
      prevouts.addVout(inp.prevTxId.toString('hex'), inp.outputIndex);
    }

    let tokenTxHeaderArray = Buffer.alloc(0);
    let tokenTxHashProofArray = Buffer.alloc(0);
    let tokenSatoshiBytesArray = Buffer.alloc(0);
    let inputTokenAddressArray = Buffer.alloc(0);
    let inputTokenAmountArray = Buffer.alloc(0);

    const chkProof = new ProofClasses.TxOutputProof(TokenUtil.getTxOutputProof(chkTx, 0));

    for (let k = 0; k < ftInputs.length; k += 1) {
      const ftIn = ftInputs[k];
      const inputIdx = ftInputIndices[k];
      const inputRes = TokenUtil.getTxInputProof(ftIn.tokenTx, ftIn.prevTokenInputIndex);
      const tokenTxInputProof = rebuildTxInputProof(ProofClasses, inputRes[0]);
      const tokenTxHeader = inputRes[1];
      const prevTokenTxOutputProof = new ProofClasses.TxOutputProof(
        TokenUtil.getTxOutputProof(ftIn.prevTokenTx, ftIn.prevVout),
      );
      const tokenInst = TokenFactory.createContract(
        ContractUtil.transferCheckCodeHashArray,
        ContractUtil.unlockContractCodeHashArray,
        2,
      );
      tokenInst.setFormatedDataPart(ftIn.dp as any);
      const preimageHex = preimageToHex(tc.getInputPreimage(inputIdx, SIGHASH_ALL_FORKID));
      const sigRaw = tc.getTxFormatSig(buyerPrivKey, inputIdx, SIGHASH_ALL_FORKID);
      const senderSig = typeof sigRaw === 'string' ? sigRaw : scryptlib.toHex(sigRaw);

      const tokenCall = tokenInst.unlock({
        txPreimage: new scryptlib.SigHashPreimage(preimageHex),
        prevouts: new scryptlib.Bytes(prevouts.toHex()),
        tokenInputIndex: inputIdx,
        amountCheckHashIndex: checkerType - 1,
        amountCheckInputIndex: chkIdx,
        amountCheckTxOutputProofInfo: chkProof,
        amountCheckScript: new scryptlib.Bytes(checkerLockBuf.toString('hex')),
        prevTokenInputIndex: ftIn.prevTokenInputIndex,
        prevTokenAddress: new scryptlib.Bytes(ftIn.prevTokenAddressHex),
        prevTokenAmount: ftIn.prevTokenAmount,
        tokenTxHeader,
        tokenTxInputProof,
        prevTokenTxOutputProof,
        senderPubKey: new scryptlib.PubKey(buyerPubHex),
        senderSig: new scryptlib.Sig(senderSig),
        contractInputIndex: 0,
        contractTxOutputProof: new ProofClasses.TxOutputProof(TokenUtil.getEmptyTxOutputProof()),
        operation: OP_TRANSFER,
      });
      tc.getInput(inputIdx).setScript(tokenCall.toScript());

      const tokProof = TokenUtil.getTxOutputProof(ftIn.tokenTx, ftIn.vout);
      const hpBuf = Buffer.from(tokProof.hashProof.serialize(), 'hex');
      tokenTxHeaderArray = Buffer.concat([tokenTxHeaderArray, Buffer.from(tokProof.txHeader.serialize(), 'hex')]);
      tokenTxHashProofArray = Buffer.concat([tokenTxHashProofArray, TokenUtil.getUInt32Buf(hpBuf.length), hpBuf]);
      tokenSatoshiBytesArray = Buffer.concat([tokenSatoshiBytesArray, Buffer.from(tokProof.satoshiBytes.serialize(), 'hex')]);
      inputTokenAddressArray = Buffer.concat([inputTokenAddressArray, Buffer.from(String(ftIn.dp.tokenAddress), 'hex')]);
      const amtBuf = Buffer.alloc(8);
      amtBuf.writeBigUInt64LE(BigInt(String(ftIn.dp.tokenAmount)));
      inputTokenAmountArray = Buffer.concat([inputTokenAmountArray, amtBuf]);
    }

    const checkInst = TokenTransferCheckFactory.createContract(checkerType);
    checkInst.setFormatedDataPart(checkerDataPart);
    const checkPreimage = buildOcsCheckPreimage(tc, chkIdx, checkerLockBuf, BigInt(checkerSats));
    const checkCall = checkInst.unlock({
      txPreimage: new scryptlib.SigHashPreimage(checkPreimage),
      prevouts: new scryptlib.Bytes(prevouts.toHex()),
      tokenScript: new scryptlib.Bytes(baseTokenScriptBuf.toString('hex')),
      tokenTxHeaderArray: new scryptlib.Bytes(tokenTxHeaderArray.toString('hex')),
      tokenTxHashProofArray: new scryptlib.Bytes(tokenTxHashProofArray.toString('hex')),
      tokenSatoshiBytesArray: new scryptlib.Bytes(tokenSatoshiBytesArray.toString('hex')),
      inputTokenAddressArray: new scryptlib.Bytes(inputTokenAddressArray.toString('hex')),
      inputTokenAmountArray: new scryptlib.Bytes(inputTokenAmountArray.toString('hex')),
      tokenOutputSatoshis,
      changeSatoshis,
      changeAddress: new scryptlib.Ripemd160(buyerNftH160Buf.toString('hex')),
      opReturnScript: new scryptlib.Bytes(''),
    });
    tc.getInput(chkIdx).setScript(checkCall.toScript());
    tc.unlockP2PKHInput(buyerPrivKey, feeIdx, SIGHASH_ALL_FORKID);
    // Keep seller's nftIdx scriptSig empty so Seller inspects & signs it after offline verification!
    tc.getInput(nftIdx).setScript(new mvc.Script());

    // Estimate final tx bytes (+115 bytes headroom for Seller's P2PKH signature on nftIdx)
    const rawLen = tc.getTx().toBuffer().length + 115;
    const neededFee = Math.ceil(rawLen * feeRate);
    const spentFee = totalInSats - ftOutSatSum - changeSatoshis;
    if (spentFee >= neededFee && spentFee - neededFee <= 8) {
      finalTc = tc;
      finalFee = spentFee;
      break;
    }
    changeSatoshis = totalInSats - ftOutSatSum - neededFee;
    finalTc = tc;
    finalFee = totalInSats - ftOutSatSum - changeSatoshis;
  }

  if (!finalTc) {
    throw new Error('Failed to build MVC FT atomic swap proposal');
  }

  return {
    proposalId: `ftprop_${randomBytes(10).toString('hex')}`,
    amountCheckRawTx,
    partialTx: finalTc.serialize(),
    feeSats: finalFee,
    spentOutpoints: [
      `${chkFunding.txId.toLowerCase()}:${chkFunding.outputIndex}`,
      ...ftInputs.map((f) => `${f.txid}:${f.vout}`),
    ],
  };
}

// ---------------------------------------------------------------------------
// Path A: Seller Offline Byte-Level Proposal Verifier & Signer
// ---------------------------------------------------------------------------

export interface VerifyMvcFtGoodsAtomicProposalInput {
  partialTx: string;
  amountCheckRawTx?: string;
  expectedItemOutpoint: { txid: string; vout: number; satoshis: number };
  sellerMvcAddress: string;
  expectedCodehash: string;
  expectedGenesis: string;
  expectedMinAmountBase: string;
  sellerWif?: string;
}

export type VerifyMvcFtGoodsAtomicProposalResult =
  | {
      valid: true;
      nftInputIndex: number;
      sellerTokenAmountBase: string;
      buyerNftAddress: string;
      finalRawTx?: string;
      txId?: string;
    }
  | {
      valid: false;
      reason: string;
    };

function tryExtractP2pkhAddress(script: mvc.Script): string | null {
  try {
    return script.toAddress('livenet').toString();
  } catch {
    return null;
  }
}

function tryExtractTokenOwnerHex(scriptBuf: Buffer): string | null {
  try {
    const dp = ftProto.parseDataPart(scriptBuf);
    const addr = String(dp?.tokenAddress ?? '').trim().toLowerCase();
    return /^[0-9a-f]{40}$/.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

function tryExtractP2pkhSignerAddressFromInput(input: mvc.Transaction.Input): string | null {
  try {
    const chunks = input.script?.chunks;
    if (!chunks || chunks.length !== 2) return null;
    const pubBuf = chunks[1]?.buf as Buffer | undefined;
    if (!pubBuf || (pubBuf.length !== 33 && pubBuf.length !== 65)) return null;
    const h160 = mvc.crypto.Hash.sha256ripemd160(pubBuf);
    return mvc.Address.fromPublicKeyHash(h160, 'livenet').toString();
  } catch {
    return null;
  }
}

/**
 * Offline byte-level verifier & signer for SellerAutoFulfillDaemon Path A:
 * 1. Confirms ONLY `expectedItemOutpoint` belongs to Seller across `partialTx`
 *    and `amountCheckRawTx` (no other Seller SPACE or FT UTXO spent).
 * 2. Confirms `outputs[0]` is a genuine MetaContract FT output matching exact
 *    `expectedCodehash` + `expectedGenesis` (S-01!), paying Seller's MVC
 *    address >= `expectedMinAmountBase`, with spendable sats >= 600.
 * 3. Verifies every Buyer-signed input script (`Token` + `TokenTransferCheck`
 *    + fee P2PKH) via `runBareInterpreter`.
 * 4. If `sellerWif` is provided, signs `nftInputIndex`, re-verifies ALL inputs
 *    of the completed transaction, and returns `finalRawTx` + `txId`.
 */
export function verifyAndSignMvcFtGoodsAtomicProposal(
  input: VerifyMvcFtGoodsAtomicProposalInput,
): VerifyMvcFtGoodsAtomicProposalResult {
  let composer: any;
  let parsedEnvelope: { txPrevOutputs?: Array<Record<string, unknown> | null> };
  try {
    composer = TxComposer.deserialize(input.partialTx);
    parsedEnvelope = JSON.parse(input.partialTx) as { txPrevOutputs?: Array<Record<string, unknown> | null> };
  } catch (err) {
    return { valid: false, reason: `invalid_partial_tx:${err instanceof Error ? err.message : String(err)}` };
  }

  const tx: mvc.Transaction = composer.tx;
  if (!tx || !Array.isArray(tx.inputs) || tx.inputs.length < 3 || !Array.isArray(tx.outputs) || tx.outputs.length < 2) {
    return { valid: false, reason: 'invalid_proposal_tx_shape' };
  }
  tx.inputs.forEach((inp: any, index: number) => {
    if (!inp.output && parsedEnvelope.txPrevOutputs?.[index]) {
      inp.output = new mvc.Transaction.Output(parsedEnvelope.txPrevOutputs[index] as never);
    }
  });

  const sellerAddr = input.sellerMvcAddress.trim();
  let sellerH160Hex: string;
  try {
    sellerH160Hex = Buffer.from(new mvc.Address(sellerAddr, 'livenet').hashBuffer).toString('hex').toLowerCase();
  } catch {
    return { valid: false, reason: 'invalid_seller_address' };
  }

  const expectedOutpointKey = `${input.expectedItemOutpoint.txid.trim().toLowerCase()}:${input.expectedItemOutpoint.vout}`;
  const expectedCodehash = input.expectedCodehash.trim().toLowerCase();
  const expectedGenesis = input.expectedGenesis.trim().toLowerCase();
  const expectedMinAmount = BigInt(input.expectedMinAmountBase);

  // Check 1: Locate Seller's item input and verify NO other input belongs to Seller
  let nftInputIndex = -1;
  for (let i = 0; i < tx.inputs.length; i += 1) {
    const inp = tx.inputs[i];
    if (!inp.output) {
      return { valid: false, reason: `missing_prev_output_for_input_${i}` };
    }
    const key = `${inp.prevTxId.toString('hex').toLowerCase()}:${Number(inp.outputIndex)}`;
    const prevAddr = tryExtractP2pkhAddress(inp.output.script);
    const prevTokenOwner = tryExtractTokenOwnerHex(inp.output.script.toBuffer());

    if (key === expectedOutpointKey) {
      if (nftInputIndex !== -1) {
        return { valid: false, reason: 'duplicate_item_outpoint_in_inputs' };
      }
      if (prevAddr !== sellerAddr) {
        return { valid: false, reason: `item_prevout_not_owned_by_seller:${prevAddr || 'non_p2pkh'}` };
      }
      if (Number(inp.output.satoshis) !== Number(input.expectedItemOutpoint.satoshis)) {
        return {
          valid: false,
          reason: `item_prevout_satoshis_mismatch:${inp.output.satoshis}:${input.expectedItemOutpoint.satoshis}`,
        };
      }
      if (inp.script.toBuffer().length !== 0) {
        return { valid: false, reason: 'item_input_must_be_unsigned' };
      }
      nftInputIndex = i;
      continue;
    }

    if (prevAddr && prevAddr.toLowerCase() === sellerAddr.toLowerCase()) {
      return { valid: false, reason: `unauthorized_seller_utxo_spend_at_input_${i}` };
    }
    if (prevTokenOwner && prevTokenOwner === sellerH160Hex) {
      return { valid: false, reason: `unauthorized_seller_ft_utxo_spend_at_input_${i}` };
    }
  }
  if (nftInputIndex < 0) {
    return { valid: false, reason: 'missing_expected_item_outpoint' };
  }

  // Optional check against companion amountCheckRawTx
  if (input.amountCheckRawTx) {
    let chkTx: mvc.Transaction;
    try {
      chkTx = new mvc.Transaction(input.amountCheckRawTx);
    } catch {
      return { valid: false, reason: 'invalid_amount_check_raw_tx' };
    }
    const chkTxId = chkTx.id.toLowerCase();
    for (let i = 0; i < chkTx.inputs.length; i += 1) {
      const inp = chkTx.inputs[i];
      const inpKey = `${inp.prevTxId.toString('hex').toLowerCase()}:${Number(inp.outputIndex)}`;
      if (inpKey === expectedOutpointKey) {
        return { valid: false, reason: 'amount_check_tx_spends_item_outpoint' };
      }
      const signerAddr = tryExtractP2pkhSignerAddressFromInput(inp);
      if (signerAddr && signerAddr.toLowerCase() === sellerAddr.toLowerCase()) {
        return { valid: false, reason: `unauthorized_seller_utxo_in_amount_check_tx_${i}` };
      }
    }
    const matchingInput = tx.inputs.find(
      (inp: any) => inp.prevTxId.toString('hex').toLowerCase() === chkTxId,
    );
    if (!matchingInput) {
      return { valid: false, reason: 'amount_check_raw_tx_not_referenced_by_proposal' };
    }
  }

  // Check 2: Verify outputs[0] is a genuine MetaContract FT output to Seller >= expectedMinAmount
  const ftOut = tx.outputs[0];
  const ftOutBuf = ftOut.script.toBuffer();
  let actualCodehash = '';
  let actualGenesis = '';
  let actualOwnerHex = '';
  let actualAmount = 0n;
  try {
    actualCodehash = Buffer.from(ftProto.getContractCodeHash(ftOutBuf)).toString('hex').toLowerCase();
    actualGenesis = Buffer.from(ftProto.getTokenID(ftOutBuf)).toString('hex').toLowerCase();
    const outDp = ftProto.parseDataPart(ftOutBuf);
    actualOwnerHex = Buffer.from(String(outDp.tokenAddress || ''), 'hex').toString('hex').toLowerCase();
    actualAmount = BigInt(String(outDp.tokenAmount));
  } catch {
    return { valid: false, reason: 'output_0_not_valid_metacontract_ft' };
  }

  if (actualCodehash !== expectedCodehash || actualGenesis !== expectedGenesis) {
    return {
      valid: false,
      reason: `ft_asset_mismatch:got_${actualCodehash}:${actualGenesis}_expected_${expectedCodehash}:${expectedGenesis}`,
    };
  }
  if (actualOwnerHex !== sellerH160Hex) {
    return { valid: false, reason: `ft_recipient_mismatch:got_${actualOwnerHex}_expected_${sellerH160Hex}` };
  }
  if (actualAmount < expectedMinAmount) {
    return {
      valid: false,
      reason: `ft_amount_below_listing:got_${actualAmount.toString()}_expected_${expectedMinAmount.toString()}`,
    };
  }
  if (Number(ftOut.satoshis) < 600) {
    return { valid: false, reason: `ft_output_below_dust_floor:${ftOut.satoshis}` };
  }

  // Check buyer delivery P2PKH output (last output)
  const buyerOut = tx.outputs[tx.outputs.length - 1];
  const buyerNftAddress = tryExtractP2pkhAddress(buyerOut.script);
  if (!buyerNftAddress) {
    return { valid: false, reason: 'buyer_delivery_output_not_p2pkh' };
  }
  if (buyerNftAddress.toLowerCase() === sellerAddr.toLowerCase()) {
    return { valid: false, reason: 'self_trade_prohibited' };
  }
  if (Number(buyerOut.satoshis) < Number(input.expectedItemOutpoint.satoshis)) {
    return { valid: false, reason: 'buyer_delivery_output_below_item_satoshis' };
  }

  // Check 3: Verify every Buyer-signed input script offline via mvc.Script.Interpreter
  for (let i = 0; i < tx.inputs.length; i += 1) {
    if (i === nftInputIndex) continue;
    const inp = tx.inputs[i];
    const verdict = runBareInterpreter(
      inp.script.toBuffer(),
      inp.output.script.toBuffer(),
      tx,
      i,
      BigInt(Number(inp.output.satoshis)),
    );
    if (verdict.cls !== 'PASS') {
      return { valid: false, reason: `buyer_input_${i}_script_failed:${verdict.detail}` };
    }
  }

  // Optional Check 4: Sign Seller's nftInputIndex and verify complete transaction
  if (input.sellerWif) {
    const sellerKey = mvc.PrivateKey.fromWIF(input.sellerWif);
    if (sellerKey.toAddress('livenet').toString() !== sellerAddr) {
      return { valid: false, reason: 'seller_wif_address_mismatch' };
    }
    composer.unlockP2PKHInput(sellerKey, nftInputIndex, SIGHASH_ALL_FORKID);
    const signedTx: mvc.Transaction = composer.getTx();
    for (let i = 0; i < signedTx.inputs.length; i += 1) {
      const inp = signedTx.inputs[i];
      const verdict = runBareInterpreter(
        inp.script.toBuffer(),
        inp.output.script.toBuffer(),
        signedTx,
        i,
        BigInt(Number(inp.output.satoshis)),
      );
      if (verdict.cls !== 'PASS') {
        return { valid: false, reason: `final_tx_input_${i}_verify_failed:${verdict.detail}` };
      }
    }
    return {
      valid: true,
      nftInputIndex,
      sellerTokenAmountBase: actualAmount.toString(),
      buyerNftAddress,
      finalRawTx: composer.getRawHex(),
      txId: composer.getTxId(),
    };
  }

  return {
    valid: true,
    nftInputIndex,
    sellerTokenAmountBase: actualAmount.toString(),
    buyerNftAddress,
  };
}

export {
  baseUnitsToDecimalDisplay,
  classifyVerify,
  decimalDisplayToBaseUnits,
  parseCanonicalFtAssetKey,
};

// ---------------------------------------------------------------------------
// In-process Buyer A2A Waiter Registry (for Path A & Path B interactive calls)
// ---------------------------------------------------------------------------

export type TokenGoodsWireWaiterEvent =
  | { kind: 'reserved'; reservationId: string; sellerReceiveAddress: string; amountBase: string; expiresAt: number }
  | { kind: 'reserve_rejected'; reason: string }
  | { kind: 'delivered'; reservationId: string; nftDeliveryTxId: string }
  | { kind: 'delivery_rejected'; reservationId: string; reason: string }
  | { kind: 'atomic_settled'; proposalId?: string; itemPinId: string; txId: string }
  | { kind: 'atomic_rejected'; proposalId?: string; itemPinId: string; reason: string };

interface PendingWaiter {
  resolve: (ev: TokenGoodsWireWaiterEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class TokenGoodsWaiterRegistry {
  private readonly waiters = new Map<string, PendingWaiter>();

  waitFor(key: string, timeoutMs: number): Promise<TokenGoodsWireWaiterEvent | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(key);
        resolve(null);
      }, timeoutMs);
      this.waiters.set(key, {
        resolve: (ev) => {
          clearTimeout(timer);
          this.waiters.delete(key);
          resolve(ev);
        },
        timer,
      });
    });
  }

  notify(key: string, ev: TokenGoodsWireWaiterEvent): boolean {
    const waiter = this.waiters.get(key);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(key);
    waiter.resolve(ev);
    return true;
  }

  clear(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timer);
    }
    this.waiters.clear();
  }
}

export const defaultTokenGoodsWaiters = new TokenGoodsWaiterRegistry();
