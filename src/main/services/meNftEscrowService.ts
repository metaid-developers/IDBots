/**
 * ABS ME Points NFT Escrow Client Service (REQ-D-02)
 *
 * Talks to assist-base-service `/v1/me/nft-escrow/*` and `/v1/me/balance`
 * using bot-scoped BSMA signatures:
 *   - Signed message: "me:<action>:<tsSeconds>"
 *   - Headers: X-Bot-Address, X-Timestamp (ms), X-Signature
 *   - IMPORTANT: MUST omit X-Identity-Address so ABS resolves the bot escrow
 *     account unambiguously via X-Bot-Address.
 */

import { deriveMvcSponsorAddress } from './mvcSponsorClient';
import {
  DEFAULT_ME_API_BASE_URL,
  DEFAULT_ME_WALLET_PATH,
  signMeAction,
  type MeIdentity,
  type MeSignedIdentity,
} from './mePointsService';

export const ME_NFT_ESCROW_MIN_AMOUNT_MILLI = 1000; // 1 ME
const DEFAULT_ESCROW_TIMEOUT_MS = 10_000;
const ORDER_ID_PATTERN = /^[A-Za-z0-9_\-.:]{1,80}$/;
const MVC_ADDRESS_PATTERN = /^1[1-9A-HJ-NP-Za-km-z]{25,33}$/;

export type MeNftEscrowStage =
  | 'balance'
  | 'nft_escrow_create'
  | 'nft_escrow_get'
  | 'nft_escrow_list'
  | 'nft_escrow_deliver'
  | 'nft_escrow_reject';

export type MeNftEscrowStatus =
  | 'locked'
  | 'delivered'
  | 'settled'
  | 'rejected'
  | 'expired'
  | 'refunded'
  | string;

export interface MeNftEscrowSigner {
  mnemonic: string;
  path?: string;
}

export interface MeNftEscrowSignFn {
  (action: string, identity: MeIdentity): Promise<MeSignedIdentity>;
}

export interface MeNftEscrowTransportOpts {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  signAction?: MeNftEscrowSignFn;
  timeoutMs?: number;
}

export interface MeNftEscrowOrder {
  orderId: string;
  itemPinId: string;
  collectionPinId?: string;
  sellPinId?: string;
  buyerAddress: string;
  buyerMetaId?: string;
  sellerAddress: string;
  sellerMetaId?: string;
  amountMilli: number;
  feeMilli?: number;
  sellerNetMilli?: number;
  status: MeNftEscrowStatus;
  deliveryTxId?: string;
  rejectReason?: string;
  note?: string;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  deliveredAt?: number;
  settledAt?: number;
  raw: Record<string, unknown>;
}

export interface MeBotTradeBalance {
  botAddress: string;
  tradeSpendableMilli: number;
  spendableMilli?: number;
  frozenMilli: number;
  totalAvailableMilli: number;
  weeklyRemainingMilli: number;
  earnedMilli: number;
  topupMilli: number;
  bonusMilli: number;
  raw: Record<string, unknown>;
}

export class MeNftEscrowApiError extends Error {
  readonly stage: MeNftEscrowStage;
  readonly status?: number;
  readonly errorCode: string;
  readonly neededMilli?: number;
  readonly haveMilli?: number;

  constructor(input: {
    stage: MeNftEscrowStage;
    message: string;
    status?: number;
    errorCode?: string;
    neededMilli?: number;
    haveMilli?: number;
  }) {
    super(input.message);
    this.name = 'MeNftEscrowApiError';
    this.stage = input.stage;
    this.status = input.status;
    this.errorCode = input.errorCode ?? '';
    this.neededMilli = input.neededMilli;
    this.haveMilli = input.haveMilli;
  }
}

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const t = normalizeText(record[key]);
    if (t) return t;
  }
  return '';
}

function pickOptionalNumber(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const val = record[key];
    if (val === undefined || val === null || val === '') continue;
    const n = Number(val);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function resolveBaseUrl(override?: string): string {
  return (override?.trim() || process.env.ME_API_BASE_URL?.trim() || DEFAULT_ME_API_BASE_URL).replace(/\/+$/, '');
}

export function resolveEscrowSigner(signer: MeNftEscrowSigner): MeIdentity {
  const mnemonic = normalizeText(signer?.mnemonic);
  if (!mnemonic) {
    throw new Error('ME escrow signer mnemonic is required');
  }
  const path = normalizeText(signer?.path) || DEFAULT_ME_WALLET_PATH;
  const mvcAddress = deriveMvcSponsorAddress({ mnemonic, path });
  if (!mvcAddress) {
    throw new Error('Failed to derive MVC address for ME escrow signer');
  }
  return { mnemonic, path, mvcAddress };
}

export function normalizeEscrowOrderId(raw: string): string {
  const orderId = normalizeText(raw);
  if (!ORDER_ID_PATTERN.test(orderId)) {
    throw new Error(`Invalid escrow orderId "${raw}": must match [A-Za-z0-9_\\-.:]{1,80}`);
  }
  return orderId;
}

export function assertEscrowMvcAddress(raw: string, label = 'address'): string {
  const addr = normalizeText(raw);
  if (!MVC_ADDRESS_PATTERN.test(addr)) {
    throw new Error(`Invalid MVC ${label}: "${raw}"`);
  }
  return addr;
}

async function escrowRequestJson(input: {
  stage: MeNftEscrowStage;
  action: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  signer: MeNftEscrowSigner;
  opts?: MeNftEscrowTransportOpts;
}): Promise<Record<string, unknown> | unknown[]> {
  const identity = resolveEscrowSigner(input.signer);
  const signFn = input.opts?.signAction ?? signMeAction;
  const signed = await signFn(input.action, identity);
  const fetchImpl = input.opts?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(input.opts?.baseUrl);
  const url = new URL(`${baseUrl}${input.path}`);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v !== undefined && normalizeText(String(v)) !== '') {
      url.searchParams.set(k, String(v));
    }
  }

  // CRITICAL: Send X-Bot-Address + X-Timestamp + X-Signature and OMIT X-Identity-Address.
  const headers: Record<string, string> = {
    accept: 'application/json',
    'X-Bot-Address': signed.address,
    'X-Timestamp': String(signed.timestamp),
    'X-Signature': signed.signature,
  };
  if (input.body) {
    headers['content-type'] = 'application/json';
  }

  const timeoutMs = input.opts?.timeoutMs ?? DEFAULT_ESCROW_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url.toString(), {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new MeNftEscrowApiError({
        stage: input.stage,
        status: response.status,
        message: `ABS escrow endpoint returned invalid JSON (HTTP ${response.status}).`,
      });
    }

    const record = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;

    if (!response.ok) {
      const errData = (record?.data && typeof record.data === 'object' && !Array.isArray(record.data))
        ? (record.data as Record<string, unknown>)
        : (record ?? {});
      throw new MeNftEscrowApiError({
        stage: input.stage,
        status: response.status,
        errorCode: pickText(errData, 'errorCode', 'error_code'),
        message: pickText(record ?? {}, 'message', 'msg', 'error')
          || `ABS escrow request failed with HTTP ${response.status}.`,
        neededMilli: pickOptionalNumber(errData, 'neededMilli', 'needed_milli'),
        haveMilli: pickOptionalNumber(errData, 'haveMilli', 'have_milli'),
      });
    }

    if (!record) {
      throw new MeNftEscrowApiError({
        stage: input.stage,
        message: 'ABS escrow response was not a JSON object.',
      });
    }

    const code = Number(record.code);
    if (Number.isFinite(code) && code === 0) {
      const data = record.data;
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') return data as Record<string, unknown>;
      return {};
    }

    const errData = (record.data && typeof record.data === 'object' && !Array.isArray(record.data))
      ? (record.data as Record<string, unknown>)
      : {};
    throw new MeNftEscrowApiError({
      stage: input.stage,
      status: response.status,
      errorCode: pickText(errData, 'errorCode', 'error_code'),
      message: pickText(record, 'message', 'msg', 'error')
        || pickText(errData, 'detail')
        || `ABS escrow returned code ${normalizeText(record.code) || 'unknown'}.`,
      neededMilli: pickOptionalNumber(errData, 'neededMilli', 'needed_milli'),
      haveMilli: pickOptionalNumber(errData, 'haveMilli', 'have_milli'),
    });
  } catch (error) {
    if (error instanceof MeNftEscrowApiError) throw error;
    if (controller.signal.aborted) {
      throw new MeNftEscrowApiError({
        stage: input.stage,
        message: `ABS escrow request timed out after ${timeoutMs}ms.`,
      });
    }
    throw new MeNftEscrowApiError({
      stage: input.stage,
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timer);
  }
}

export function normalizeEscrowOrder(raw: Record<string, unknown>): MeNftEscrowOrder {
  const orderObj = (raw.order && typeof raw.order === 'object' && !Array.isArray(raw.order))
    ? (raw.order as Record<string, unknown>)
    : raw;
  return {
    orderId: pickText(orderObj, 'orderId', 'order_id'),
    itemPinId: pickText(orderObj, 'itemPinId', 'item_pin_id').toLowerCase(),
    collectionPinId: pickText(orderObj, 'collectionPinId', 'collection_pin_id') || undefined,
    sellPinId: pickText(orderObj, 'sellPinId', 'sell_pin_id') || undefined,
    buyerAddress: pickText(orderObj, 'buyerAddress', 'buyer_address'),
    buyerMetaId: pickText(orderObj, 'buyerMetaId', 'buyer_metaid') || undefined,
    sellerAddress: pickText(orderObj, 'sellerAddress', 'seller_address'),
    sellerMetaId: pickText(orderObj, 'sellerMetaId', 'seller_metaid') || undefined,
    amountMilli: pickOptionalNumber(orderObj, 'amountMilli', 'amount_milli') ?? 0,
    feeMilli: pickOptionalNumber(orderObj, 'feeMilli', 'fee_milli'),
    sellerNetMilli: pickOptionalNumber(orderObj, 'sellerNetMilli', 'seller_net_milli'),
    status: pickText(orderObj, 'status').toLowerCase() || 'unknown',
    deliveryTxId: pickText(orderObj, 'deliveryTxId', 'delivery_tx_id') || undefined,
    rejectReason: pickText(orderObj, 'rejectReason', 'reject_reason') || undefined,
    note: pickText(orderObj, 'note') || undefined,
    createdAt: pickOptionalNumber(orderObj, 'createdAt', 'created_at'),
    updatedAt: pickOptionalNumber(orderObj, 'updatedAt', 'updated_at'),
    expiresAt: pickOptionalNumber(orderObj, 'expiresAt', 'expires_at'),
    deliveredAt: pickOptionalNumber(orderObj, 'deliveredAt', 'delivered_at'),
    settledAt: pickOptionalNumber(orderObj, 'settledAt', 'settled_at'),
    raw: orderObj,
  };
}

/**
 * GET /v1/me/balance (action: "balance") with X-Bot-Address auth.
 * Returns `tradeSpendableMilli` (persistent earned + topup + bonus - frozen,
 * excluding weeklyGrant & feeSubsidy).
 */
export async function getBotTradeSpendableBalance(
  signer: MeNftEscrowSigner,
  opts?: MeNftEscrowTransportOpts,
): Promise<MeBotTradeBalance> {
  const data = (await escrowRequestJson({
    stage: 'balance',
    action: 'balance',
    method: 'GET',
    path: '/v1/me/balance',
    signer,
    opts,
  })) as Record<string, unknown>;
  const grant = (data.weeklyGrant ?? data.weekly_grant ?? {}) as Record<string, unknown>;
  const persistent = (data.persistent ?? {}) as Record<string, unknown>;
  const frozenMilli = pickOptionalNumber(data, 'frozenMilli', 'frozen_milli') ?? 0;
  const earnedMilli = pickOptionalNumber(persistent, 'earnedMilli', 'earned_milli') ?? 0;
  const topupMilli = pickOptionalNumber(persistent, 'topupMilli', 'topup_milli') ?? 0;
  const bonusMilli = pickOptionalNumber(persistent, 'bonusMilli', 'bonus_milli') ?? 0;
  const tradeSpendableRaw = pickOptionalNumber(data, 'tradeSpendableMilli', 'trade_spendable_milli');
  const derivedPersistent = Math.max(0, earnedMilli + topupMilli + bonusMilli - frozenMilli);
  const tradeSpendableMilli = tradeSpendableRaw !== undefined ? Math.max(0, tradeSpendableRaw) : derivedPersistent;
  const identity = resolveEscrowSigner(signer);

  return {
    botAddress: pickText(data, 'identityAddress', 'identity_address', 'botAddress', 'bot_address') || identity.mvcAddress,
    tradeSpendableMilli,
    spendableMilli: pickOptionalNumber(data, 'spendableMilli', 'spendable_milli'),
    frozenMilli,
    totalAvailableMilli: pickOptionalNumber(data, 'totalAvailable', 'total_available') ?? 0,
    weeklyRemainingMilli: pickOptionalNumber(grant, 'remainingMilli', 'remaining_milli') ?? 0,
    earnedMilli,
    topupMilli,
    bonusMilli,
    raw: data,
  };
}

/**
 * POST /v1/me/nft-escrow/orders (action: "nft_escrow_create")
 */
export async function createNftEscrowOrder(
  signer: MeNftEscrowSigner,
  input: {
    orderId: string;
    itemPinId: string;
    sellerAddress: string;
    amountMilli: number;
    collectionPinId?: string;
    sellPinId?: string;
    buyerMetaId?: string;
    sellerMetaId?: string;
    note?: string;
    ttlSeconds?: number;
  },
  opts?: MeNftEscrowTransportOpts,
): Promise<MeNftEscrowOrder> {
  const identity = resolveEscrowSigner(signer);
  const orderId = normalizeEscrowOrderId(input.orderId);
  const itemPinId = normalizeText(input.itemPinId).toLowerCase();
  if (!/^[0-9a-f]{64}i\d+$/i.test(itemPinId)) {
    throw new Error(`Invalid itemPinId: "${input.itemPinId}"`);
  }
  const sellerAddress = assertEscrowMvcAddress(input.sellerAddress, 'sellerAddress');
  if (sellerAddress === identity.mvcAddress) {
    throw new Error('Buyer and seller addresses must differ');
  }
  const amountMilli = Math.round(Number(input.amountMilli));
  if (!Number.isInteger(amountMilli) || amountMilli < ME_NFT_ESCROW_MIN_AMOUNT_MILLI) {
    throw new Error(`amountMilli must be an integer >= ${ME_NFT_ESCROW_MIN_AMOUNT_MILLI} (1 ME)`);
  }

  const body: Record<string, unknown> = {
    orderId,
    itemPinId,
    sellerAddress,
    amountMilli,
  };
  if (input.collectionPinId) body.collectionPinId = normalizeText(input.collectionPinId);
  if (input.sellPinId) body.sellPinId = normalizeText(input.sellPinId);
  if (input.buyerMetaId) body.buyerMetaId = normalizeText(input.buyerMetaId);
  if (input.sellerMetaId) body.sellerMetaId = normalizeText(input.sellerMetaId);
  if (input.note) body.note = normalizeText(input.note);
  if (input.ttlSeconds && input.ttlSeconds > 0) body.ttlSeconds = Math.round(input.ttlSeconds);

  const data = (await escrowRequestJson({
    stage: 'nft_escrow_create',
    action: 'nft_escrow_create',
    method: 'POST',
    path: '/v1/me/nft-escrow/orders',
    body,
    signer,
    opts,
  })) as Record<string, unknown>;
  return normalizeEscrowOrder(data);
}

/**
 * GET /v1/me/nft-escrow/orders/:orderId (action: "nft_escrow_get")
 */
export async function getNftEscrowOrder(
  signer: MeNftEscrowSigner,
  orderId: string,
  opts?: MeNftEscrowTransportOpts,
): Promise<MeNftEscrowOrder> {
  const normalizedId = normalizeEscrowOrderId(orderId);
  const data = (await escrowRequestJson({
    stage: 'nft_escrow_get',
    action: 'nft_escrow_get',
    method: 'GET',
    path: `/v1/me/nft-escrow/orders/${encodeURIComponent(normalizedId)}`,
    signer,
    opts,
  })) as Record<string, unknown>;
  return normalizeEscrowOrder(data);
}

/**
 * GET /v1/me/nft-escrow/orders (action: "nft_escrow_list")
 */
export async function listNftEscrowOrders(
  signer: MeNftEscrowSigner,
  query?: {
    role?: 'buyer' | 'seller' | 'all';
    status?: string;
    limit?: number;
    cursor?: string;
  },
  opts?: MeNftEscrowTransportOpts,
): Promise<{ orders: MeNftEscrowOrder[]; nextCursor?: string }> {
  const data = await escrowRequestJson({
    stage: 'nft_escrow_list',
    action: 'nft_escrow_list',
    method: 'GET',
    path: '/v1/me/nft-escrow/orders',
    query: {
      role: query?.role,
      status: query?.status,
      limit: query?.limit,
      cursor: query?.cursor,
    },
    signer,
    opts,
  });
  const rows = Array.isArray(data)
    ? data
    : (Array.isArray((data as Record<string, unknown>).orders)
      ? (data as Record<string, unknown>).orders as unknown[]
      : Array.isArray((data as Record<string, unknown>).rows)
        ? (data as Record<string, unknown>).rows as unknown[]
        : []);
  const orders = rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
    .map(normalizeEscrowOrder);
  const nextCursor = !Array.isArray(data)
    ? (pickText(data as Record<string, unknown>, 'nextCursor', 'next_cursor') || undefined)
    : undefined;
  return { orders, nextCursor };
}

/**
 * POST /v1/me/nft-escrow/orders/:orderId/deliver (action: "nft_escrow_deliver")
 */
export async function deliverNftEscrowOrder(
  signer: MeNftEscrowSigner,
  orderId: string,
  input: { deliveryTxId: string },
  opts?: MeNftEscrowTransportOpts,
): Promise<MeNftEscrowOrder> {
  const normalizedId = normalizeEscrowOrderId(orderId);
  const deliveryTxId = normalizeText(input.deliveryTxId).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(deliveryTxId)) {
    throw new Error(`Invalid deliveryTxId "${input.deliveryTxId}": must be a 64-hex txid`);
  }
  const data = (await escrowRequestJson({
    stage: 'nft_escrow_deliver',
    action: 'nft_escrow_deliver',
    method: 'POST',
    path: `/v1/me/nft-escrow/orders/${encodeURIComponent(normalizedId)}/deliver`,
    body: { deliveryTxId },
    signer,
    opts,
  })) as Record<string, unknown>;
  return normalizeEscrowOrder(data);
}

/**
 * POST /v1/me/nft-escrow/orders/:orderId/reject (action: "nft_escrow_reject")
 */
export async function rejectNftEscrowOrder(
  signer: MeNftEscrowSigner,
  orderId: string,
  input: { reason: string },
  opts?: MeNftEscrowTransportOpts,
): Promise<MeNftEscrowOrder> {
  const normalizedId = normalizeEscrowOrderId(orderId);
  const reason = normalizeText(input.reason) || 'rejected_by_seller';
  const data = (await escrowRequestJson({
    stage: 'nft_escrow_reject',
    action: 'nft_escrow_reject',
    method: 'POST',
    path: `/v1/me/nft-escrow/orders/${encodeURIComponent(normalizedId)}/reject`,
    body: { reason },
    signer,
    opts,
  })) as Record<string, unknown>;
  return normalizeEscrowOrder(data);
}

export function describeMeNftEscrowError(error: unknown): string {
  if (error instanceof MeNftEscrowApiError) {
    const parts = [error.message];
    if (error.errorCode) parts.push(`[${error.errorCode}]`);
    if (error.neededMilli != null && error.haveMilli != null) {
      parts.push(`(needed ${(error.neededMilli / 1000).toFixed(3)} ME, have ${(error.haveMilli / 1000).toFixed(3)} ME)`);
    }
    return parts.join(' ');
  }
  return error instanceof Error ? error.message : String(error);
}
