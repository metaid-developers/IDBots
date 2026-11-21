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

export type MeNftEscrowStatusCode = 1 | 2 | 3 | 4 | 5 | 6;

export type MeNftEscrowStatusName =
  | 'FROZEN_AWAITING_DELIVERY'
  | 'DELIVERY_SUBMITTED'
  | 'SETTLED'
  | 'EXPIRED_REFUNDED'
  | 'CANCELED_REFUNDED'
  | 'DISPUTED_HOLD';

export type MeNftEscrowStatus = MeNftEscrowStatusName | string;

const STATUS_CODE_TO_NAME: Record<MeNftEscrowStatusCode, MeNftEscrowStatusName> = {
  1: 'FROZEN_AWAITING_DELIVERY',
  2: 'DELIVERY_SUBMITTED',
  3: 'SETTLED',
  4: 'EXPIRED_REFUNDED',
  5: 'CANCELED_REFUNDED',
  6: 'DISPUTED_HOLD',
};

const STATUS_NAME_TO_CODE: Record<MeNftEscrowStatusName, MeNftEscrowStatusCode> = {
  FROZEN_AWAITING_DELIVERY: 1,
  DELIVERY_SUBMITTED: 2,
  SETTLED: 3,
  EXPIRED_REFUNDED: 4,
  CANCELED_REFUNDED: 5,
  DISPUTED_HOLD: 6,
};

const LEGACY_STATUS_TO_NAME: Record<string, MeNftEscrowStatusName> = {
  locked: 'FROZEN_AWAITING_DELIVERY',
  frozen_awaiting_delivery: 'FROZEN_AWAITING_DELIVERY',
  delivered: 'DELIVERY_SUBMITTED',
  delivery_submitted: 'DELIVERY_SUBMITTED',
  settled: 'SETTLED',
  expired: 'EXPIRED_REFUNDED',
  expired_refunded: 'EXPIRED_REFUNDED',
  rejected: 'CANCELED_REFUNDED',
  canceled: 'CANCELED_REFUNDED',
  cancelled: 'CANCELED_REFUNDED',
  refunded: 'CANCELED_REFUNDED',
  canceled_refunded: 'CANCELED_REFUNDED',
  disputed: 'DISPUTED_HOLD',
  disputed_hold: 'DISPUTED_HOLD',
};

export function normalizeEscrowStatus(
  rawStatus: unknown,
  rawStatusName?: unknown,
): { status: MeNftEscrowStatus; statusCode?: MeNftEscrowStatusCode; statusName: string } {
  const nameText = normalizeText(rawStatusName).toUpperCase();
  if (nameText && nameText in STATUS_NAME_TO_CODE) {
    const canonical = nameText as MeNftEscrowStatusName;
    return { status: canonical, statusName: canonical, statusCode: STATUS_NAME_TO_CODE[canonical] };
  }

  if (typeof rawStatus === 'number' && Number.isInteger(rawStatus) && rawStatus >= 1 && rawStatus <= 6) {
    const code = rawStatus as MeNftEscrowStatusCode;
    const canonical = STATUS_CODE_TO_NAME[code];
    return { status: canonical, statusName: canonical, statusCode: code };
  }

  const statusText = normalizeText(rawStatus);
  if (/^[1-6]$/.test(statusText)) {
    const code = Number(statusText) as MeNftEscrowStatusCode;
    const canonical = STATUS_CODE_TO_NAME[code];
    return { status: canonical, statusName: canonical, statusCode: code };
  }

  const lower = statusText.toLowerCase();
  if (lower && lower in LEGACY_STATUS_TO_NAME) {
    const canonical = LEGACY_STATUS_TO_NAME[lower];
    return { status: canonical, statusName: canonical, statusCode: STATUS_NAME_TO_CODE[canonical] };
  }

  const fallback = nameText || statusText || 'unknown';
  return { status: fallback, statusName: fallback };
}

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
  listingPinId?: string;
  sellPinId?: string;
  buyerNftAddress: string;
  buyerBotAddress?: string;
  buyerIdentityAddress?: string;
  buyerAddress: string;
  buyerMetaId?: string;
  sellerBotAddress: string;
  sellerPayeeAddress?: string;
  sellerIdentityAddress?: string;
  sellerAddress: string;
  sellerMetaId?: string;
  amountMilli: number;
  feeMilli?: number;
  sellerNetMilli?: number;
  status: MeNftEscrowStatus;
  statusCode?: MeNftEscrowStatusCode;
  statusName: string;
  deliveryTxId?: string;
  verifyDetail?: string;
  settlementEntryId?: string;
  rejectReason?: string;
  note?: string;
  deliveryDeadline?: number;
  createdAt?: number;
  updatedAt?: number;
  expiresAt?: number;
  deliveredAt?: number;
  settledAt?: number;
  applied?: boolean;
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
  const listingPinId = pickText(orderObj, 'listingPinId', 'listing_pin_id', 'sellPinId', 'sell_pin_id') || undefined;
  const buyerNftAddress = pickText(
    orderObj,
    'buyerNftAddress',
    'buyer_nft_address',
    'buyerAddress',
    'buyer_address',
    'buyerBotAddress',
    'buyer_bot_address',
    'buyerIdentityAddress',
    'buyer_identity_address',
  );
  const buyerBotAddress = pickText(orderObj, 'buyerBotAddress', 'buyer_bot_address') || undefined;
  const buyerIdentityAddress = pickText(orderObj, 'buyerIdentityAddress', 'buyer_identity_address') || undefined;
  const sellerBotAddress = pickText(
    orderObj,
    'sellerBotAddress',
    'seller_bot_address',
    'sellerAddress',
    'seller_address',
    'sellerPayeeAddress',
    'seller_payee_address',
    'sellerIdentityAddress',
    'seller_identity_address',
  );
  const sellerPayeeAddress = pickText(orderObj, 'sellerPayeeAddress', 'seller_payee_address') || undefined;
  const sellerIdentityAddress = pickText(orderObj, 'sellerIdentityAddress', 'seller_identity_address') || undefined;
  const statusInfo = normalizeEscrowStatus(orderObj.status, orderObj.statusName ?? orderObj.status_name);
  const deliveryDeadline = pickOptionalNumber(
    orderObj,
    'deliveryDeadline',
    'delivery_deadline',
    'expiresAt',
    'expires_at',
  );
  const verifyDetail = pickText(orderObj, 'verifyDetail', 'verify_detail') || undefined;
  const settlementEntryId = pickText(orderObj, 'settlementEntryId', 'settlement_entry_id') || undefined;

  return {
    orderId: pickText(orderObj, 'orderId', 'order_id'),
    itemPinId: pickText(orderObj, 'itemPinId', 'item_pin_id').toLowerCase(),
    collectionPinId: pickText(orderObj, 'collectionPinId', 'collection_pin_id') || undefined,
    listingPinId,
    sellPinId: listingPinId,
    buyerNftAddress,
    buyerBotAddress,
    buyerIdentityAddress,
    buyerAddress: buyerNftAddress,
    buyerMetaId: pickText(orderObj, 'buyerMetaId', 'buyer_metaid', 'buyerGlobalMetaId', 'buyer_global_metaid') || undefined,
    sellerBotAddress,
    sellerPayeeAddress,
    sellerIdentityAddress,
    sellerAddress: sellerBotAddress,
    sellerMetaId: pickText(orderObj, 'sellerMetaId', 'seller_metaid', 'sellerGlobalMetaId', 'seller_global_metaid') || undefined,
    amountMilli: pickOptionalNumber(orderObj, 'amountMilli', 'amount_milli') ?? 0,
    feeMilli: pickOptionalNumber(orderObj, 'feeMilli', 'fee_milli'),
    sellerNetMilli: pickOptionalNumber(orderObj, 'sellerNetMilli', 'seller_net_milli'),
    status: statusInfo.status,
    ...(statusInfo.statusCode !== undefined ? { statusCode: statusInfo.statusCode } : {}),
    statusName: statusInfo.statusName,
    deliveryTxId: pickText(orderObj, 'deliveryTxId', 'delivery_tx_id') || undefined,
    verifyDetail,
    settlementEntryId,
    rejectReason: pickText(orderObj, 'rejectReason', 'reject_reason', 'cancelReason', 'cancel_reason') || verifyDetail,
    note: pickText(orderObj, 'note') || undefined,
    deliveryDeadline,
    createdAt: pickOptionalNumber(orderObj, 'createdAt', 'created_at'),
    updatedAt: pickOptionalNumber(orderObj, 'updatedAt', 'updated_at'),
    expiresAt: deliveryDeadline,
    deliveredAt: pickOptionalNumber(orderObj, 'deliveredAt', 'delivered_at'),
    settledAt: pickOptionalNumber(orderObj, 'settledAt', 'settled_at'),
    ...(typeof orderObj.applied === 'boolean' ? { applied: orderObj.applied } : {}),
    raw: orderObj,
  };
}

/**
 * GET /v1/me/balance (action: "balance") with X-Bot-Address auth.
 * Returns `tradeSpendableMilli` (persistent earned + topup - frozen,
 * excluding weeklyGrant, feeSubsidy, and bonus).
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
  const derivedPersistent = Math.max(0, earnedMilli + topupMilli - frozenMilli);
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
 *
 * ABS Go struct tags (`assist-base-service@b83c76f`):
 *   required: orderId, itemPinId, collectionPinId, buyerNftAddress, sellerBotAddress, amountMilli
 *   optional: sellerPayeeAddress, listingPinId, deliveryTimeoutSec (300-7200, default 900), idempotencyKey
 */
export async function createNftEscrowOrder(
  signer: MeNftEscrowSigner,
  input: {
    orderId: string;
    itemPinId: string;
    collectionPinId?: string;
    buyerNftAddress?: string;
    sellerBotAddress?: string;
    sellerAddress?: string;
    sellerPayeeAddress?: string;
    amountMilli: number;
    listingPinId?: string;
    sellPinId?: string;
    deliveryTimeoutSec?: number;
    ttlSeconds?: number;
    idempotencyKey?: string;
    buyerMetaId?: string;
    sellerMetaId?: string;
    note?: string;
  },
  opts?: MeNftEscrowTransportOpts,
): Promise<MeNftEscrowOrder> {
  const identity = resolveEscrowSigner(signer);
  const orderId = normalizeEscrowOrderId(input.orderId);
  const itemPinId = normalizeText(input.itemPinId).toLowerCase();
  if (!/^[0-9a-f]{64}i\d+$/i.test(itemPinId)) {
    throw new Error(`Invalid itemPinId: "${input.itemPinId}"`);
  }
  const collectionPinId = normalizeText(input.collectionPinId).toLowerCase();
  if (collectionPinId && !/^[0-9a-f]{64}i\d+$/i.test(collectionPinId)) {
    throw new Error(`Invalid collectionPinId: "${input.collectionPinId}"`);
  }
  const buyerNftAddress = assertEscrowMvcAddress(
    input.buyerNftAddress || identity.mvcAddress,
    'buyerNftAddress',
  );
  const sellerBotAddress = assertEscrowMvcAddress(
    input.sellerBotAddress || input.sellerAddress || '',
    'sellerBotAddress',
  );
  if (sellerBotAddress === buyerNftAddress) {
    throw new Error('Buyer and seller addresses must differ');
  }
  const sellerPayeeAddressRaw = normalizeText(input.sellerPayeeAddress);
  const sellerPayeeAddress = sellerPayeeAddressRaw
    ? assertEscrowMvcAddress(sellerPayeeAddressRaw, 'sellerPayeeAddress')
    : undefined;
  const amountMilli = Math.round(Number(input.amountMilli));
  if (!Number.isInteger(amountMilli) || amountMilli < ME_NFT_ESCROW_MIN_AMOUNT_MILLI) {
    throw new Error(`amountMilli must be an integer >= ${ME_NFT_ESCROW_MIN_AMOUNT_MILLI} (1 ME)`);
  }
  const rawTimeout = input.deliveryTimeoutSec ?? input.ttlSeconds;
  const deliveryTimeoutSec = rawTimeout != null && Number.isFinite(Number(rawTimeout)) && Number(rawTimeout) > 0
    ? Math.min(7200, Math.max(300, Math.round(Number(rawTimeout))))
    : 900;
  const listingPinId = normalizeText(input.listingPinId ?? input.sellPinId).toLowerCase();
  const idempotencyKey = normalizeText(input.idempotencyKey);

  const body: Record<string, unknown> = {
    orderId,
    itemPinId,
    ...(collectionPinId ? { collectionPinId } : {}),
    buyerNftAddress,
    sellerBotAddress,
    amountMilli,
    deliveryTimeoutSec,
  };
  if (sellerPayeeAddress) body.sellerPayeeAddress = sellerPayeeAddress;
  if (listingPinId) body.listingPinId = listingPinId;
  if (idempotencyKey) body.idempotencyKey = idempotencyKey;

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
    status?: string | number;
    beforeId?: string;
    limit?: number;
    cursor?: string;
  },
  opts?: MeNftEscrowTransportOpts,
): Promise<{ orders: MeNftEscrowOrder[]; nextCursor?: string }> {
  let normalizedQueryStatus = query?.status !== undefined ? normalizeText(query.status) : undefined;
  if (normalizedQueryStatus && normalizedQueryStatus.toLowerCase() === 'locked') {
    normalizedQueryStatus = 'FROZEN_AWAITING_DELIVERY';
  }
  const beforeId = normalizeText(query?.beforeId ?? query?.cursor) || undefined;
  const data = await escrowRequestJson({
    stage: 'nft_escrow_list',
    action: 'nft_escrow_list',
    method: 'GET',
    path: '/v1/me/nft-escrow/orders',
    query: {
      role: query?.role,
      status: normalizedQueryStatus,
      beforeId,
      limit: query?.limit,
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
    ? (pickText(data as Record<string, unknown>, 'nextBeforeId', 'next_before_id', 'nextCursor', 'next_cursor') || undefined)
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
