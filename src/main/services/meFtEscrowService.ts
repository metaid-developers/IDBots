/**
 * ME Energy Points Escrow Client for Fungible Tokens (MVC FT & BTC MRC-20)
 *
 * Implements Contract C3 (`docs/ft-commerce-loop/01-protocols-and-contracts.md`):
 * - Uses Bot-Signed ME Auth via `signMeAction` (`X-Bot-Address`, `X-Timestamp`,
 *   `X-Signature`), intentionally omitting `X-Identity-Address` just like
 *   `/v1/me/nft-escrow/*`.
 * - Enforces exact BigInt base-unit strings (`tokenAmountBase`) so large
 *   18-decimal token quantities never suffer IEEE-754 precision loss.
 */

import { mvc } from 'meta-contract';
import type { MetabotStore } from '../metabotStore';
import {
  DEFAULT_ME_API_BASE_URL,
  signMeAction,
  type MeIdentity,
  type MeSignedIdentity,
} from './mePointsService';
import {
  getBotTradeSpendableBalance,
  normalizeEscrowStatus,
  resolveEscrowSigner,
  type MeBotTradeBalance,
  type MeNftEscrowSigner,
} from './meNftEscrowService';
import { normalizeFtAssetKey } from './ftMandateGateService';

export { getBotTradeSpendableBalance, resolveEscrowSigner };
export type { MeBotTradeBalance };
export type FtEscrowSigner = MeNftEscrowSigner;

export type FtEscrowChain = 'mvc' | 'btc';

export type FtEscrowOrderStatus =
  | 'FROZEN_AWAITING_DELIVERY'
  | 'DELIVERY_SUBMITTED'
  | 'SETTLED'
  | 'RELEASED_TO_SELLER'
  | 'CANCELED_REFUNDED'
  | 'REFUNDED_TO_BUYER'
  | 'EXPIRED_REFUNDED'
  | 'DISPUTED_HOLD';

export interface MeFtEscrowOrder {
  orderId: string;
  buyerBotAddress: string;
  sellerBotAddress: string;
  sellerPayeeAddress: string;
  chain: FtEscrowChain;
  assetKey: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAmountBase: string;
  amountMilli: number;
  buyerReceiveAddress: string;
  listingKey?: string;
  lockedUtxoOutpoint?: string;
  status: FtEscrowOrderStatus;
  deliveryTxId?: string;
  tradePinId?: string;
  rejectReason?: string;
  expiresAt: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateFtEscrowOrderParams {
  sellerBotAddress: string;
  sellerPayeeAddress?: string;
  chain: FtEscrowChain;
  assetKey: string;
  tokenSymbol: string;
  tokenDecimals: number;
  tokenAmountBase: string;
  amountMilli: number;
  buyerReceiveAddress: string;
  listingKey?: string;
  lockedUtxoOutpoint?: string;
  idempotencyKey: string;
  ttlSeconds?: number;
}

export interface DeliverFtEscrowOrderParams {
  deliveryTxId: string;
  tradePinId?: string;
}

export interface MeFtEscrowServiceDeps {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  signAction?: (action: string, identity: MeIdentity) => Promise<MeSignedIdentity>;
  timeoutMs?: number;
}

export class MeFtEscrowApiError extends Error {
  readonly statusCode: number;
  readonly errorCode?: string;

  constructor(message: string, statusCode = 500, errorCode?: string) {
    super(message);
    this.name = 'MeFtEscrowApiError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
  }
}

const TXID_HEX_RE = /^[0-9a-fA-F]{64}$/;
const BTC_BECH32_RE = /^(bc1|tb1|bcrt1)[a-zA-HJ-NP-Z0-9]{11,90}$/;
const BASE58_ADDR_RE = /^[13mn2][1-9A-HJ-NP-Za-km-z]{25,39}$/;

export function resolveMetabotFtEscrowSigner(
  store: MetabotStore,
  metabotId: number,
): FtEscrowSigner {
  const wallet = store.getMetabotWalletByMetabotId(metabotId);
  if (!wallet?.mnemonic?.trim()) {
    throw new Error(`MetaBot ${metabotId} wallet mnemonic not available`);
  }
  return {
    mnemonic: wallet.mnemonic,
    path: wallet.path || undefined,
  };
}

export function validatePositiveBaseUnits(value: unknown, fieldName = 'tokenAmountBase'): string {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${fieldName} must be a positive integer string in base units`);
  }
  const parsed = BigInt(raw);
  if (parsed <= 0n) {
    throw new Error(`${fieldName} must be greater than zero`);
  }
  return parsed.toString();
}

export function validateFtReceiveAddress(address: string, chain: FtEscrowChain): string {
  const trimmed = String(address ?? '').trim();
  if (!trimmed) {
    throw new Error(`buyerReceiveAddress is required for chain '${chain}'`);
  }
  if (chain === 'mvc') {
    try {
      const parsed = new mvc.Address(trimmed);
      if (parsed.type && parsed.type !== 'pubkeyhash') {
        throw new Error(`MVC FT receive address must be P2PKH, got ${parsed.type}`);
      }
      return trimmed;
    } catch (err) {
      throw new Error(
        `Invalid MVC P2PKH receive address '${trimmed}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (chain === 'btc') {
    if (!BTC_BECH32_RE.test(trimmed) && !BASE58_ADDR_RE.test(trimmed)) {
      throw new Error(`Invalid BTC receive address '${trimmed}'`);
    }
    return trimmed;
  }
  throw new Error(`Unsupported FT escrow chain: ${String(chain)}`);
}

function resolveBaseUrl(override?: string): string {
  return (
    override?.trim() ||
    process.env.ME_API_BASE_URL?.trim() ||
    DEFAULT_ME_API_BASE_URL
  ).replace(/\/+$/, '');
}

function normalizeFtEscrowOrder(raw: Record<string, unknown>): MeFtEscrowOrder {
  const chainRaw = String(raw.chain ?? raw.network ?? 'mvc').trim().toLowerCase();
  const chain: FtEscrowChain = chainRaw === 'btc' ? 'btc' : 'mvc';
  const rawStatusText = String(raw.status ?? raw.statusName ?? '').trim().toUpperCase();
  const status: FtEscrowOrderStatus =
    rawStatusText === 'RELEASED_TO_SELLER' || rawStatusText === 'REFUNDED_TO_BUYER'
      ? (rawStatusText as FtEscrowOrderStatus)
      : (normalizeEscrowStatus(raw.status, raw.statusName).statusName as FtEscrowOrderStatus);

  return {
    orderId: String(raw.orderId ?? raw.order_id ?? ''),
    buyerBotAddress: String(raw.buyerBotAddress ?? raw.buyer_bot_address ?? ''),
    sellerBotAddress: String(raw.sellerBotAddress ?? raw.seller_bot_address ?? ''),
    sellerPayeeAddress: String(
      raw.sellerPayeeAddress ??
        raw.seller_payee_address ??
        raw.sellerBotAddress ??
        raw.seller_bot_address ??
        '',
    ),
    chain,
    assetKey: String(raw.assetKey ?? raw.asset_key ?? '').trim().toLowerCase(),
    tokenSymbol: String(raw.tokenSymbol ?? raw.token_symbol ?? raw.symbol ?? 'TOKEN').trim(),
    tokenDecimals: Number(raw.tokenDecimals ?? raw.token_decimals ?? raw.decimals ?? 0) || 0,
    tokenAmountBase: String(raw.tokenAmountBase ?? raw.token_amount_base ?? '0').trim(),
    amountMilli: Number(raw.amountMilli ?? raw.amount_milli ?? 0),
    buyerReceiveAddress: String(raw.buyerReceiveAddress ?? raw.buyer_receive_address ?? ''),
    ...(raw.listingKey || raw.listing_key
      ? { listingKey: String(raw.listingKey ?? raw.listing_key) }
      : {}),
    ...(raw.lockedUtxoOutpoint || raw.locked_utxo_outpoint
      ? { lockedUtxoOutpoint: String(raw.lockedUtxoOutpoint ?? raw.locked_utxo_outpoint) }
      : {}),
    status,
    ...(raw.deliveryTxId || raw.delivery_tx_id
      ? { deliveryTxId: String(raw.deliveryTxId ?? raw.delivery_tx_id) }
      : {}),
    ...(raw.tradePinId || raw.trade_pin_id
      ? { tradePinId: String(raw.tradePinId ?? raw.trade_pin_id) }
      : {}),
    ...(raw.rejectReason || raw.reject_reason
      ? { rejectReason: String(raw.rejectReason ?? raw.reject_reason) }
      : {}),
    expiresAt: String(raw.expiresAt ?? raw.expires_at ?? ''),
    ...(raw.createdAt || raw.created_at
      ? { createdAt: String(raw.createdAt ?? raw.created_at) }
      : {}),
    ...(raw.updatedAt || raw.updated_at
      ? { updatedAt: String(raw.updatedAt ?? raw.updated_at) }
      : {}),
  };
}

async function ftEscrowRequest<T>(input: {
  action: string;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  signer: FtEscrowSigner;
  deps?: MeFtEscrowServiceDeps;
}): Promise<T> {
  const identity = resolveEscrowSigner(input.signer);
  const signFn = input.deps?.signAction ?? signMeAction;
  const signed = await signFn(input.action, identity);
  const fetchFn = input.deps?.fetchImpl ?? fetch;
  const baseUrl = resolveBaseUrl(input.deps?.baseUrl);
  const url = new URL(`${baseUrl}${input.path}`);
  for (const [k, v] of Object.entries(input.query ?? {})) {
    if (v !== undefined && String(v).trim() !== '') {
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

  const res = await fetchFn(url.toString(), {
    method: input.method,
    headers,
    body: input.body ? JSON.stringify(input.body) : undefined,
  });

  const text = await res.text();
  let json: { code?: number; message?: string; errorCode?: string; data?: unknown } | null = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new MeFtEscrowApiError(
        `Non-JSON response from FT escrow API (HTTP ${res.status}): ${text.slice(0, 180)}`,
        res.status,
      );
    }
  }

  if (!res.ok || (json && typeof json.code === 'number' && json.code !== 0)) {
    const dataObj =
      json?.data && typeof json.data === 'object' && !Array.isArray(json.data)
        ? (json.data as Record<string, unknown>)
        : {};
    const errorCode =
      (typeof json?.errorCode === 'string' && json.errorCode) ||
      (typeof dataObj.errorCode === 'string' && dataObj.errorCode) ||
      (typeof dataObj.error_code === 'string' && dataObj.error_code) ||
      undefined;
    const msg = json?.message || `FT escrow API error (HTTP ${res.status})`;
    throw new MeFtEscrowApiError(msg, res.status, errorCode);
  }

  return ((json?.data !== undefined ? json.data : json) ?? {}) as T;
}

export async function createFtEscrowOrder(
  signer: FtEscrowSigner,
  params: CreateFtEscrowOrderParams,
  deps: MeFtEscrowServiceDeps = {},
): Promise<MeFtEscrowOrder> {
  const identity = resolveEscrowSigner(signer);
  const sellerBotAddress = validateFtReceiveAddress(params.sellerBotAddress, 'mvc');
  const sellerPayeeAddress = params.sellerPayeeAddress
    ? validateFtReceiveAddress(params.sellerPayeeAddress, 'mvc')
    : sellerBotAddress;
  if (sellerBotAddress === identity.mvcAddress) {
    throw new MeFtEscrowApiError('Self-trade is prohibited', 400, 'SELF_TRADE_FORBIDDEN');
  }
  const chain: FtEscrowChain = params.chain === 'btc' ? 'btc' : 'mvc';
  const assetKey = normalizeFtAssetKey(params.assetKey);
  if (chain === 'mvc' && !assetKey.startsWith('mvc-ft:')) {
    throw new Error(`MVC FT escrow requires mvc-ft: assetKey, got '${assetKey}'`);
  }
  if (chain === 'btc' && !assetKey.startsWith('mrc20:')) {
    throw new Error(`BTC FT escrow requires mrc20: assetKey, got '${assetKey}'`);
  }

  const buyerReceiveAddress = validateFtReceiveAddress(params.buyerReceiveAddress, chain);
  const tokenAmountBase = validatePositiveBaseUnits(params.tokenAmountBase, 'tokenAmountBase');
  const tokenSymbol = String(params.tokenSymbol ?? '').trim();
  if (!tokenSymbol) throw new Error('tokenSymbol is required');
  const tokenDecimals = Number(params.tokenDecimals ?? 0);
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error('tokenDecimals must be an integer between 0 and 36');
  }
  if (!Number.isInteger(params.amountMilli) || params.amountMilli <= 0) {
    throw new Error('amountMilli must be a positive integer');
  }
  const idempotencyKey = String(params.idempotencyKey || '').trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required');

  const data = await ftEscrowRequest<Record<string, unknown>>({
    action: 'ft_escrow_create',
    method: 'POST',
    path: '/v1/me/ft-escrow/orders',
    signer,
    deps,
    body: {
      sellerBotAddress,
      sellerPayeeAddress,
      chain,
      assetKey,
      tokenSymbol,
      tokenDecimals,
      tokenAmountBase,
      amountMilli: params.amountMilli,
      buyerReceiveAddress,
      ...(params.listingKey ? { listingKey: params.listingKey } : {}),
      ...(params.lockedUtxoOutpoint ? { lockedUtxoOutpoint: params.lockedUtxoOutpoint } : {}),
      idempotencyKey,
      ttlSeconds: params.ttlSeconds ?? 1800,
    },
  });
  return normalizeFtEscrowOrder(data);
}

export async function getFtEscrowOrder(
  signer: FtEscrowSigner,
  orderId: string,
  deps: MeFtEscrowServiceDeps = {},
): Promise<MeFtEscrowOrder> {
  const trimmedOrderId = String(orderId || '').trim();
  if (!trimmedOrderId) throw new Error('orderId is required');
  const data = await ftEscrowRequest<Record<string, unknown>>({
    action: 'ft_escrow_get',
    method: 'GET',
    path: `/v1/me/ft-escrow/orders/${encodeURIComponent(trimmedOrderId)}`,
    signer,
    deps,
  });
  return normalizeFtEscrowOrder(data);
}

export async function listFtEscrowOrders(
  signer: FtEscrowSigner,
  query: {
    role: 'buyer' | 'seller';
    status?: FtEscrowOrderStatus;
    limit?: number;
  },
  deps: MeFtEscrowServiceDeps = {},
): Promise<MeFtEscrowOrder[]> {
  const data = await ftEscrowRequest<
    { list?: Record<string, unknown>[]; orders?: Record<string, unknown>[] } | Record<string, unknown>[]
  >({
    action: 'ft_escrow_list',
    method: 'GET',
    path: '/v1/me/ft-escrow/orders',
    query: {
      role: query.role,
      status: query.status,
      limit: query.limit,
    },
    signer,
    deps,
  });
  const rawList = Array.isArray(data)
    ? data
    : Array.isArray(data.orders)
      ? data.orders
      : Array.isArray(data.list)
        ? data.list
        : [];
  return rawList.map((item) => normalizeFtEscrowOrder(item));
}

export async function deliverFtEscrowOrder(
  signer: FtEscrowSigner,
  orderId: string,
  params: DeliverFtEscrowOrderParams,
  deps: MeFtEscrowServiceDeps = {},
): Promise<MeFtEscrowOrder> {
  const trimmedOrderId = String(orderId || '').trim();
  if (!trimmedOrderId) throw new Error('orderId is required');
  const deliveryTxId = String(params.deliveryTxId || '').trim();
  if (!TXID_HEX_RE.test(deliveryTxId)) {
    throw new Error('deliveryTxId must be a 64-character hex string');
  }

  const data = await ftEscrowRequest<Record<string, unknown>>({
    action: 'ft_escrow_deliver',
    method: 'POST',
    path: `/v1/me/ft-escrow/orders/${encodeURIComponent(trimmedOrderId)}/deliver`,
    signer,
    deps,
    body: {
      deliveryTxId,
      ...(params.tradePinId ? { tradePinId: params.tradePinId } : {}),
    },
  });
  return normalizeFtEscrowOrder(data);
}

export async function rejectFtEscrowOrder(
  signer: FtEscrowSigner,
  orderId: string,
  reason: string,
  deps: MeFtEscrowServiceDeps = {},
): Promise<MeFtEscrowOrder> {
  const trimmedOrderId = String(orderId || '').trim();
  if (!trimmedOrderId) throw new Error('orderId is required');

  const data = await ftEscrowRequest<Record<string, unknown>>({
    action: 'ft_escrow_reject',
    method: 'POST',
    path: `/v1/me/ft-escrow/orders/${encodeURIComponent(trimmedOrderId)}/reject`,
    signer,
    deps,
    body: { reason: reason || 'rejected_by_seller' },
  });
  return normalizeFtEscrowOrder(data);
}
