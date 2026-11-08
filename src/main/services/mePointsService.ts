/**
 * ME (MetaID Energy) points client service (S9 积分 UI 桌面切片).
 * Talks to the assist-base-service ME APIs (/v1/me/*) with identity-signed
 * requests — the same BSMA identity layer as trafficAccountService, but the
 * per-endpoint action contract comes from docs/me-points/客户端与宿主接入指南.md:
 *
 *   signed message: "me:<action>:<tsSeconds>"  (秒级时间戳 ±300s)
 *   X-Identity-Address / X-Timestamp (ms) / X-Signature (BSMA compact base64)
 *
 * Unit: the API speaks **milliME integers** (1 ME = 1000 milliME); display
 * layers divide by 1000. All price/amount values are server hot-config —
 * this client never hardcodes prices or quota amounts (PRD S9 §1 原则).
 *
 * Defensive by design: public endpoints (plans / rates / topup packages)
 * need no identity; a missing or incomplete local identity only fails the
 * signed endpoints, and every UI consumer treats { success:false } as
 * "ME 不可见 / 不可用" rather than throwing.
 */

import { signMvcAddressMessage } from './mvcSponsorClient';
import type { UserIdentityStore } from '../userIdentityStore';
import { getMePointSettings, mirrorMePointSettings } from './mePointSettings';
import type { MePointSettingsStore } from './mePointSettings';

export const DEFAULT_ME_API_BASE_URL = 'https://www.metaso.network/assist-open-api';
const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const BALANCE_CACHE_TTL_MS = 30_000;

/**
 * S9-A subscription order (S9-A-订阅订单端点规格.md §1). Path and signed
 * action are each pinned to ONE constant: when the backend lands the endpoint
 * under a different path or action, this pair is the only thing to change.
 */
export const ME_SUBSCRIPTION_ORDER_PATH = '/v1/me/subscription/order';
export const ME_SUBSCRIPTION_ORDER_ACTION = 'subscription_order';

/**
 * Per-identity ME settings (assist-base-service 727182a). The authoritative
 * autoDeductFromPersistent switch behind the 「积分增量包」 toggle: OFF gates
 * every ME consumption path to grant-only. Path and signed actions are each
 * pinned to ONE constant, same discipline as the subscription order pair.
 */
export const ME_SETTINGS_PATH = '/v1/me/settings';
export const ME_GET_SETTINGS_ACTION = 'get_me_settings';
export const ME_SET_SETTINGS_ACTION = 'set_me_settings';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MeApiStage =
  | 'plans'
  | 'rates'
  | 'packages'
  | 'balance'
  | 'subscription'
  | 'history'
  | 'topup_submit'
  | 'topup_orders'
  | 'subscription_order'
  | 'subscription_orders'
  | 'settings';

export class MePointsApiError extends Error {
  readonly stage: MeApiStage;
  readonly status?: number;
  /** errorCode from the unified response envelope data (e.g. SUBSCRIPTION_REQUIRED). */
  readonly errorCode: string;
  /** True when the backend returned 404 for /v1/me/* (ME disabled / not deployed). */
  readonly featureUnavailable: boolean;

  constructor(input: {
    stage: MeApiStage;
    message: string;
    status?: number;
    errorCode?: string;
    featureUnavailable?: boolean;
  }) {
    super(input.message);
    this.name = 'MePointsApiError';
    this.stage = input.stage;
    this.status = input.status;
    this.errorCode = input.errorCode ?? '';
    this.featureUnavailable = input.featureUnavailable ?? false;
  }
}

/** GET /v1/me/plans entry (sale page source of truth; fields per guide §5.1). */
export interface MePlan {
  planId: string;
  tier: string;
  name: string;
  nameEn?: string;
  priceCny?: number;
  periodDays?: number;
  weeklyAmountMilli?: number;
  desktopPriceCny?: number;
  annualPriceCny?: number;
  quarterlyDiscountPct?: number;
  residualFullWeek?: number;
  applicableEnd?: string;
  saleStatus?: number;
}

/** GET /v1/me/rates entry — display multiplier layer only (no baseRates). */
export interface MeRate {
  /** Resource key, e.g. a model id ("deepseek-chat") or "mvc"/"traffic". */
  key: string;
  /** Display multiplier; e.g. 1 for 1x, 3 for 3x. */
  multiplier: number;
}

/** GET /v1/me/topup/packages entry. */
export interface MeTopupPackage {
  packageId: string;
  /** Display name from the server (e.g. 充值包 A); clients fall back to packageId. */
  name?: string;
  meMilli?: number;
  priceCny?: number;
  saleStatus?: number;
}

/** GET /v1/me/balance response (double-pool ledger snapshot). */
export interface MeBalance {
  identityAddress: string;
  weeklyGrant: {
    amountMilli: number;
    remainingMilli: number;
    cycleStart: number;
    cycleEnd: number;
    isResidual: boolean;
    nextResetAt: number;
  };
  persistent: {
    topupMilli: number;
    earnedMilli: number;
    bonusMilli: number;
  };
  frozenMilli: number;
  totalAvailable: number;
  /**
   * Per-identity credit-pack switch as echoed by /v1/me/balance (absent on
   * older servers). False = spends may only draw the weekly grant.
   */
  autoDeductFromPersistent?: boolean;
  /**
   * What a new ME spend can draw now (requirements v1.0 R3): grant remaining
   * plus the persistent pools when auto-deduct is on, frozen excluded.
   * Absent on servers that predate it.
   */
  spendableMilli?: number;
}

/** GET /v1/me/subscription response (tolerant: guide pins statusText only). */
export interface MeSubscription {
  statusText: string;
  raw: Record<string, unknown>;
}

/** GET /v1/me/history entry (tolerant of snake/camel variants). */
export interface MeHistoryEntry {
  id: string;
  type: string;
  amountMilli: number;
  balanceAfterMilli?: number;
  refType?: string;
  refId?: string;
  reason?: string;
  createdAt?: number;
  raw: Record<string, unknown>;
}

export interface MeHistoryPage {
  entries: MeHistoryEntry[];
  nextCursor: string;
}

/** GET /v1/me/topup/orders entry (statusText: submitted → confirmed/rejected). */
export interface MeTopupOrder {
  orderId: string;
  packageId: string;
  status: string;
  createdAt?: number;
  confirmedAt?: number;
  meMilli?: number;
  priceCny?: number;
  payAmount?: number;
  payCurrency?: string;
  gatewayParams?: unknown;
  rejectReason?: string;
  raw: Record<string, unknown>;
}

/** Subscription billing period (S9-A §1: month | quarter | year). */
export type MeSubscriptionPeriod = 'month' | 'quarter' | 'year';

/** Sales channel the order is priced for (S9-A §1: desktop | cloud | mobile). */
export type MeSubscriptionChannel = 'desktop' | 'cloud' | 'mobile';
export type MePaymentGateway = 'alipay' | 'paypal';

/** POST /v1/me/subscription/order order view (S9-A §1.6). */
export interface MeSubscriptionOrder {
  orderId: string;
  planId: string;
  period: string;
  channel: string;
  status: string;
  amountCny?: number;
  payAmount?: number;
  payCurrency?: string;
  gatewayParams?: unknown;
  createdAt?: number;
  rejectReason?: string;
  raw: Record<string, unknown>;
}

export interface MeRevenuePackage {
  plans: MePlan[];
  topupPackages: MeTopupPackage[];
  rates: MeRate[];
}

// ---------------------------------------------------------------------------
// Deps (injected from main.ts; optional-chained so node-only tests resolve to
// undefined instead of hard-crashing — same pattern as trafficAccountService).
// ---------------------------------------------------------------------------

export interface MeDeps {
  getUserIdentityStore?: () => UserIdentityStore | undefined;
  fetchImpl?: typeof fetch;
}

interface MePointsServiceState {
  deps: MeDeps;
  balanceCache: { balance: MeBalance; fetchedAt: number } | null;
}

const state: MePointsServiceState = { deps: {}, balanceCache: null };

export function initMePointsService(deps: MeDeps): void {
  state.deps = { ...state.deps, ...deps };
  state.balanceCache = null;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

function toNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const text = normalizeText(record[key]);
    if (text) return text;
  }
  return '';
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) {
      const n = toNumber(value);
      if (n !== 0) return n;
      return n;
    }
  }
  return 0;
}

function pickErrorCode(payload: unknown): string {
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return pickText(payload as Record<string, unknown>, 'errorCode', 'error_code');
  }
  return '';
}

function resolveApiBaseUrl(): string {
  return process.env.ME_API_BASE_URL?.trim() || DEFAULT_ME_API_BASE_URL;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// HTTP layer (unified {code, message, data} envelope; guide §4)
// ---------------------------------------------------------------------------

async function meRequestJson(input: {
  stage: MeApiStage;
  method: 'GET' | 'POST';
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: Record<string, unknown>;
  identity?: { address: string; timestamp: number; signature: string };
}): Promise<Record<string, unknown> | unknown[]> {
  const deps = state.deps;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(`${resolveApiBaseUrl()}${input.path}`);
  for (const [key, value] of Object.entries(input.query ?? {})) {
    if (value !== undefined && normalizeText(String(value)) !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.body) {
    headers['content-type'] = 'application/json';
  }
  if (input.identity) {
    headers['X-Identity-Address'] = input.identity.address;
    headers['X-Timestamp'] = String(input.identity.timestamp);
    headers['X-Signature'] = input.identity.signature;
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url.toString(), {
      method: input.method,
      headers,
      body: input.body ? JSON.stringify(input.body) : undefined,
      signal: controller.signal,
    });
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MePointsApiError({
        stage: input.stage,
        message: `ME service returned invalid JSON (HTTP ${response.status}).`,
        status: response.status,
      });
    }
    if (!response.ok) {
      const bodyRecord = (body && typeof body === 'object' && !Array.isArray(body))
        ? (body as Record<string, unknown>)
        : {};
      throw new MePointsApiError({
        stage: input.stage,
        message: pickText(bodyRecord, 'message', 'msg', 'error')
          || `ME service request failed with HTTP ${response.status}.`,
        status: response.status,
        featureUnavailable: response.status === 404,
        errorCode: pickErrorCode((bodyRecord.data ?? bodyRecord)),
      });
    }
    const record = (body && typeof body === 'object' && !Array.isArray(body))
      ? (body as Record<string, unknown>)
      : null;
    if (!record) {
      throw new MePointsApiError({ stage: input.stage, message: 'ME service returned a non-object response.' });
    }
    const code = Number(record.code);
    if (Number.isFinite(code) && code === 0) {
      const data = record.data;
      if (Array.isArray(data)) return data;
      if (data && typeof data === 'object') return data as Record<string, unknown>;
      return {};
    }
    throw new MePointsApiError({
      stage: input.stage,
      message: pickText(record, 'message', 'msg', 'error')
        || `ME service returned code ${normalizeText(record.code) || 'unknown'}.`,
      errorCode: pickErrorCode(record.data),
    });
  } catch (error) {
    if (error instanceof MePointsApiError) throw error;
    if (controller.signal.aborted) {
      throw new MePointsApiError({
        stage: input.stage,
        message: `ME service request timed out after ${DEFAULT_REQUEST_TIMEOUT_MS}ms.`,
      });
    }
    throw new MePointsApiError({
      stage: input.stage,
      message: getErrorMessage(error),
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ---------------------------------------------------------------------------
// Identity signing
// ---------------------------------------------------------------------------

interface MeIdentity {
  mnemonic: string;
  path: string;
  mvcAddress: string;
}

function requireIdentity(): MeIdentity {
  const identity = state.deps.getUserIdentityStore?.()?.get();
  const mnemonic = normalizeText(identity?.mnemonic);
  const mvcAddress = normalizeText((identity as { mvc_address?: string } | undefined)?.mvc_address);
  if (!identity || !mnemonic || !mvcAddress) {
    throw new MePointsApiError({ stage: 'balance', message: 'local user identity is missing or incomplete' });
  }
  return { mnemonic, path: identity.path || DEFAULT_WALLET_PATH, mvcAddress };
}

async function signedAuth(stage: MeApiStage, action: string): Promise<{
  identity: { address: string; timestamp: number; signature: string };
}> {
  const identity = requireIdentity();
  // Guide §3.2: the signed message binds the action with the SECONDS
  // timestamp; X-Timestamp carries milliseconds. Both MUST derive from the
  // same clock read — a second boundary between two reads makes the server's
  // recomputed message differ and the signature fail.
  const seconds = nowSeconds();
  const timestamp = seconds * 1000;
  const message = `me:${action}:${seconds}`;
  const { signature } = await signMvcAddressMessage({
    mnemonic: identity.mnemonic,
    path: identity.path,
    message,
  });
  return { identity: { address: identity.mvcAddress, timestamp, signature } };
}

// ---------------------------------------------------------------------------
// Public (unsigned) endpoints
// ---------------------------------------------------------------------------

export async function getMePlans(): Promise<MePlan[]> {
  const data = await meRequestJson({ stage: 'plans', method: 'GET', path: '/v1/me/plans' });
  const rows = Array.isArray(data) ? data : [];
  const plans: MePlan[] = [];
  for (const row of rows) {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const planId = pickText(record, 'planId', 'plan_id');
    if (!planId) continue;
    plans.push({
      planId,
      tier: pickText(record, 'tier') || planId,
      name: pickText(record, 'name') || planId,
      nameEn: pickText(record, 'nameEn', 'name_en') || undefined,
      priceCny: pickNumber(record, 'priceCny', 'price_cny') || undefined,
      periodDays: pickNumber(record, 'periodDays', 'period_days') || undefined,
      weeklyAmountMilli: pickNumber(record, 'weeklyAmountMilli', 'weekly_amount_milli') || undefined,
      desktopPriceCny: pickNumber(record, 'desktopPriceCny', 'desktop_price_cny') || undefined,
      annualPriceCny: pickNumber(record, 'annualPriceCny', 'annual_price_cny') || undefined,
      quarterlyDiscountPct: pickNumber(record, 'quarterlyDiscountPct', 'quarterly_discount_pct') || undefined,
      residualFullWeek: pickNumber(record, 'residualFullWeek', 'residual_full_week') || undefined,
      applicableEnd: pickText(record, 'applicableEnd', 'applicable_end') || undefined,
      saleStatus: pickNumber(record, 'saleStatus', 'sale_status') || undefined,
    });
  }
  return plans.filter((plan) => (plan.saleStatus ?? 1) === 1);
}

export async function getMeRates(): Promise<MeRate[]> {
  const data = await meRequestJson({ stage: 'rates', method: 'GET', path: '/v1/me/rates' });
  const rates: MeRate[] = [];
  const collect = (source: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(source)) {
      const n = toNumber(value);
      if (Number.isFinite(n) && n > 0) {
        rates.push({ key, multiplier: n });
      }
    }
  };
  if (Array.isArray(data)) {
    for (const row of data) {
      const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
      const key = pickText(record, 'key', 'modelId', 'model_id', 'resource', 'resourceKey', 'resource_key');
      const value = toNumber(record.multiplier ?? record.value ?? record.rate);
      if (key && Number.isFinite(value) && value > 0) rates.push({ key, multiplier: value });
    }
    return rates;
  }
  const record = data as Record<string, unknown>;
  const models = record.models;
  if (models && typeof models === 'object' && !Array.isArray(models)) {
    collect(models as Record<string, unknown>);
  } else {
    collect(record);
  }
  return rates;
}

export async function getMeTopupPackages(): Promise<MeTopupPackage[]> {
  const data = await meRequestJson({ stage: 'packages', method: 'GET', path: '/v1/me/topup/packages' });
  const rows = Array.isArray(data) ? data : [];
  const packages: MeTopupPackage[] = [];
  for (const row of rows) {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const packageId = pickText(record, 'packageId', 'package_id');
    if (!packageId) continue;
    packages.push({
      packageId,
      name: pickText(record, 'name') || undefined,
      meMilli: pickNumber(record, 'meMilli', 'me_milli') || undefined,
      priceCny: pickNumber(record, 'priceCny', 'price_cny') || undefined,
      saleStatus: pickNumber(record, 'saleStatus', 'sale_status') || undefined,
    });
  }
  return packages.filter((pkg) => (pkg.saleStatus ?? 1) === 1);
}

// ---------------------------------------------------------------------------
// Signed endpoints
// ---------------------------------------------------------------------------

export async function getMeBalance(input: { forceRefresh?: boolean } = {}): Promise<MeBalance> {
  if (!input.forceRefresh && state.balanceCache && Date.now() - state.balanceCache.fetchedAt < BALANCE_CACHE_TTL_MS) {
    return state.balanceCache.balance;
  }
  const { identity } = await signedAuth('balance', 'balance');
  const data = (await meRequestJson({
    stage: 'balance',
    method: 'GET',
    path: '/v1/me/balance',
    identity,
  })) as Record<string, unknown>;
  const balance = normalizeMeBalance(data);
  state.balanceCache = { balance, fetchedAt: Date.now() };
  return balance;
}

function normalizeMeBalance(data: Record<string, unknown>): MeBalance {
  const grant = (data.weeklyGrant && typeof data.weeklyGrant === 'object'
    ? (data.weeklyGrant as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const persistent = (data.persistent && typeof data.persistent === 'object'
    ? (data.persistent as Record<string, unknown>)
    : {}) as Record<string, unknown>;
  const balance: MeBalance = {
    identityAddress: pickText(data, 'identityAddress', 'identity_address'),
    weeklyGrant: {
      amountMilli: pickNumber(grant, 'amountMilli', 'amount_milli'),
      remainingMilli: pickNumber(grant, 'remainingMilli', 'remaining_milli'),
      cycleStart: pickNumber(grant, 'cycleStart', 'cycle_start'),
      cycleEnd: pickNumber(grant, 'cycleEnd', 'cycle_end'),
      isResidual: grant.isResidual === true || grant.is_residual === true,
      nextResetAt: pickNumber(grant, 'nextResetAt', 'next_reset_at'),
    },
    persistent: {
      topupMilli: pickNumber(persistent, 'topupMilli', 'topup_milli'),
      earnedMilli: pickNumber(persistent, 'earnedMilli', 'earned_milli'),
      bonusMilli: pickNumber(persistent, 'bonusMilli', 'bonus_milli'),
    },
    frozenMilli: pickNumber(data, 'frozenMilli', 'frozen_milli'),
    totalAvailable: pickNumber(data, 'totalAvailable', 'total_available'),
  };
  // Optional fields stay absent when the server omits them, so callers can
  // tell "not reported" from a real false / 0.
  const autoDeduct = data.autoDeductFromPersistent ?? data.auto_deduct_from_persistent;
  if (typeof autoDeduct === 'boolean') balance.autoDeductFromPersistent = autoDeduct;
  const spendableRaw = data.spendableMilli ?? data.spendable_milli;
  const spendable = typeof spendableRaw === 'number' || typeof spendableRaw === 'string'
    ? Number(spendableRaw)
    : Number.NaN;
  // Unparseable values stay absent: reading them as 0 would claim "no ME left".
  if (Number.isFinite(spendable) && spendable >= 0 && String(spendableRaw).trim() !== '') {
    balance.spendableMilli = spendable;
  }
  return balance;
}

export async function getMeSubscription(): Promise<MeSubscription> {
  const { identity } = await signedAuth('subscription', 'subscription');
  const data = (await meRequestJson({
    stage: 'subscription',
    method: 'GET',
    path: '/v1/me/subscription',
    identity,
  })) as Record<string, unknown>;
  return {
    statusText: pickText(data, 'statusText', 'status_text', 'status', 'stage'),
    raw: data,
  };
}

// ---------------------------------------------------------------------------
// Per-identity settings (积分增量包 toggle 的权威开关)
// ---------------------------------------------------------------------------

export interface MeSettingsFlag {
  identityAddress: string;
  autoDeductFromPersistent: boolean;
}

/**
 * The server view is strict (POST binds a *bool — absent/non-boolean is a
 * param error), but a missing field on READ (e.g. an older server build)
 * reads as ON, the default — never as OFF, which would silently gate
 * persistent spending the user did not ask to gate.
 */
function normalizeMeSettings(data: Record<string, unknown>): MeSettingsFlag {
  return {
    identityAddress: pickText(data, 'identityAddress', 'identity_address'),
    autoDeductFromPersistent: data.autoDeductFromPersistent !== false,
  };
}

/** GET /v1/me/settings — authoritative per-identity auto-deduct flag. */
export async function getMeSettings(): Promise<MeSettingsFlag> {
  const { identity } = await signedAuth('settings', ME_GET_SETTINGS_ACTION);
  const data = (await meRequestJson({
    stage: 'settings',
    method: 'GET',
    path: ME_SETTINGS_PATH,
    identity,
  })) as Record<string, unknown>;
  return normalizeMeSettings(data);
}

/** POST /v1/me/settings — strict boolean body, returns the confirmed view. */
export async function setMeSettings(autoDeductFromPersistent: boolean): Promise<MeSettingsFlag> {
  if (typeof autoDeductFromPersistent !== 'boolean') {
    throw new MePointsApiError({
      stage: 'settings',
      message: 'autoDeductFromPersistent must be a boolean',
    });
  }
  const { identity } = await signedAuth('settings', ME_SET_SETTINGS_ACTION);
  const data = (await meRequestJson({
    stage: 'settings',
    method: 'POST',
    path: ME_SETTINGS_PATH,
    body: { autoDeductFromPersistent },
    identity,
  })) as Record<string, unknown>;
  return normalizeMeSettings(data);
}

function listRows(data: Record<string, unknown> | unknown[], keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  return [];
}

export async function getMeHistory(input: { type?: string; beforeId?: string; limit?: number } = {}): Promise<MeHistoryPage> {
  const { identity } = await signedAuth('history', 'history');
  const data = (await meRequestJson({
    stage: 'history',
    method: 'GET',
    path: '/v1/me/history',
    query: {
      type: input.type || undefined,
      beforeId: input.beforeId || undefined,
      limit: input.limit || undefined,
    },
    identity,
  })) as Record<string, unknown>;
  const rows = listRows(data, ['entries', 'history', 'items', 'list', 'records', 'rows']);
  const entries: MeHistoryEntry[] = [];
  for (const row of rows) {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const id = pickText(record, 'id', 'entryId', 'entry_id');
    if (!id) continue;
    entries.push({
      id,
      type: pickText(record, 'type', 'entryType', 'entry_type'),
      amountMilli: pickNumber(record, 'amountMilli', 'amount_milli', 'amount'),
      balanceAfterMilli: pickNumber(record, 'balanceAfterMilli', 'balance_after_milli') || undefined,
      refType: pickText(record, 'refType', 'ref_type') || undefined,
      refId: pickText(record, 'refId', 'ref_id') || undefined,
      reason: pickText(record, 'reason', 'remark') || undefined,
      createdAt: pickNumber(record, 'createdAt', 'created_at', 'createTime', 'create_time', 'timestamp', 'ts') || undefined,
      raw: record,
    });
  }
  const nextCursor = pickText(data, 'nextCursor', 'next_cursor');
  return { entries, nextCursor };
}

export interface MeSubmitTopupResult {
  order: MeTopupOrder | null;
  applied: boolean;
}

export async function submitMeTopupOrder(input: {
  packageId: string;
  periodDays?: number;
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey?: string;
  gateway?: MePaymentGateway;
}): Promise<MeSubmitTopupResult> {
  const { identity } = await signedAuth('topup_submit', 'topup_submit');
  // Retry ladder: a transient network failure must not double-submit. Same as
  // the traffic client: the POST itself is the retry point with the SAME key.
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = (await meRequestJson({
        stage: 'topup_submit',
        method: 'POST',
        path: '/v1/me/topup/orders',
        body: {
          packageId: input.packageId,
          ...(input.periodDays ? { periodDays: input.periodDays } : {}),
          ...(input.voucherUrl ? { voucherUrl: input.voucherUrl } : {}),
          ...(input.voucherRemark ? { voucherRemark: input.voucherRemark } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.gateway ? { gateway: input.gateway } : {}),
        },
        identity,
      })) as Record<string, unknown>;
      state.balanceCache = null;
      return {
        order: normalizeMeTopupOrder(data),
        applied: data.applied === true,
      };
    } catch (error) {
      if (error instanceof MePointsApiError && (error.featureUnavailable || error.errorCode || error.status === 400)) {
        throw error;
      }
      lastError = error;
      await delayMs(400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Submit a subscription order (S9-A §1). Unlike topup_submit this endpoint is
 * NOT gated by SUBSCRIPTION_REQUIRED — it is the only path by which a free
 * user can open a subscription at all. The server prices the order from
 * plan + period + channel (spec §1.3), so the client never sends an amount.
 *
 * Same retry ladder as the topup submit: the POST is retried once with the
 * SAME idempotency key, so a transient network failure cannot double-submit.
 */
export async function submitMeSubscriptionOrder(input: {
  planId: string;
  period: MeSubscriptionPeriod;
  channel: MeSubscriptionChannel;
  voucherUrl?: string;
  voucherRemark?: string;
  idempotencyKey?: string;
  gateway?: MePaymentGateway;
}): Promise<MeSubscriptionOrder> {
  const { identity } = await signedAuth('subscription_order', ME_SUBSCRIPTION_ORDER_ACTION);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const data = (await meRequestJson({
        stage: 'subscription_order',
        method: 'POST',
        path: ME_SUBSCRIPTION_ORDER_PATH,
        body: {
          planId: input.planId,
          period: input.period,
          channel: input.channel,
          ...(input.voucherUrl ? { voucherUrl: input.voucherUrl } : {}),
          ...(input.voucherRemark ? { voucherRemark: input.voucherRemark } : {}),
          ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
          ...(input.gateway ? { gateway: input.gateway } : {}),
        },
        identity,
      })) as Record<string, unknown>;
      // A submitted order moves no ledger balance — only the admin confirm
      // opens the subscription (spec §2) — so the cached balance stays valid.
      return normalizeMeSubscriptionOrder(data);
    } catch (error) {
      if (error instanceof MePointsApiError && (error.featureUnavailable || error.errorCode || error.status === 400)) {
        throw error;
      }
      lastError = error;
      await delayMs(400);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function getMeSubscriptionOrder(orderId: string): Promise<MeSubscriptionOrder> {
  const normalizedOrderId = normalizeText(orderId);
  if (!normalizedOrderId) {
    throw new MePointsApiError({ stage: 'subscription_order', message: 'orderId is required' });
  }
  const { identity } = await signedAuth('subscription_order', ME_SUBSCRIPTION_ORDER_ACTION);
  const data = await meRequestJson({
    stage: 'subscription_order',
    method: 'GET',
    path: `${ME_SUBSCRIPTION_ORDER_PATH}/${encodeURIComponent(normalizedOrderId)}`,
    identity,
  });
  return normalizeMeSubscriptionOrder(data as Record<string, unknown>);
}

export async function getMeTopupOrders(): Promise<MeTopupOrder[]> {
  const { identity } = await signedAuth('topup_orders', 'topup_orders');
  const data = await meRequestJson({
    stage: 'topup_orders',
    method: 'GET',
    path: '/v1/me/topup/orders',
    identity,
  });
  const rows = listRows(data, ['orders', 'entries', 'items', 'list', 'records', 'rows']);
  const orders: MeTopupOrder[] = [];
  for (const row of rows) {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    const orderId = pickText(record, 'orderId', 'order_id', 'id');
    if (!orderId) continue;
    orders.push(normalizeMeTopupOrder(record, orderId));
  }
  return orders;
}

// GET /v1/me/subscription/orders — the owner-scoped subscription order list
// (Amendment v0.3). The server ships this after v0.2; until then the 404
// surfaces as featureUnavailable and the usage page degrades to topup-only.
export const ME_SUBSCRIPTION_ORDERS_PATH = '/v1/me/subscription/orders';

export async function getMeSubscriptionOrders(): Promise<MeSubscriptionOrder[]> {
  const { identity } = await signedAuth('subscription_orders', ME_SUBSCRIPTION_ORDER_ACTION);
  const data = await meRequestJson({
    stage: 'subscription_orders',
    method: 'GET',
    path: ME_SUBSCRIPTION_ORDERS_PATH,
    identity,
  });
  const rows = listRows(data, ['orders', 'entries', 'items', 'list', 'records', 'rows']);
  const orders: MeSubscriptionOrder[] = [];
  for (const row of rows) {
    const record = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
    if (!pickText(record, 'orderId', 'order_id')) continue;
    orders.push(normalizeMeSubscriptionOrder(record));
  }
  return orders;
}

function normalizeMeTopupOrder(record: Record<string, unknown>, orderIdFallback?: string): MeTopupOrder {
  return {
    orderId: pickText(record, 'orderId', 'order_id') || orderIdFallback || '',
    packageId: pickText(record, 'packageId', 'package_id'),
    status: pickText(record, 'statusText', 'status_text', 'status'),
    createdAt: pickNumber(record, 'createdAt', 'created_at') || undefined,
    confirmedAt: pickNumber(record, 'confirmedAt', 'confirmed_at') || undefined,
    meMilli: pickNumber(record, 'meMilli', 'me_milli') || undefined,
    priceCny: pickNumber(record, 'priceCny', 'price_cny') || undefined,
    payAmount: pickNumber(record, 'payAmount', 'pay_amount', 'amountCny', 'amount_cny', 'priceCny', 'price_cny') || undefined,
    payCurrency: pickText(record, 'payCurrency', 'pay_currency') || undefined,
    gatewayParams: record.gatewayParams ?? record.gateway_params,
    rejectReason: pickText(record, 'rejectReason', 'reject_reason') || undefined,
    raw: record,
  };
}

function normalizeMeSubscriptionOrder(record: Record<string, unknown>): MeSubscriptionOrder {
  return {
    orderId: pickText(record, 'orderId', 'order_id'),
    planId: pickText(record, 'planId', 'plan_id'),
    period: pickText(record, 'period'),
    channel: pickText(record, 'channel'),
    status: pickText(record, 'statusText', 'status_text', 'status'),
    amountCny: pickNumber(record, 'amountCny', 'amount_cny', 'priceCny', 'price_cny') || undefined,
    payAmount: pickNumber(record, 'payAmount', 'pay_amount', 'amountCny', 'amount_cny', 'priceCny', 'price_cny') || undefined,
    payCurrency: pickText(record, 'payCurrency', 'pay_currency') || undefined,
    gatewayParams: record.gatewayParams ?? record.gateway_params,
    createdAt: pickNumber(record, 'createdAt', 'created_at') || undefined,
    rejectReason: pickText(record, 'rejectReason', 'reject_reason') || undefined,
    raw: record,
  };
}

/**
 * Platform payment info for the manual voucher channel (S9 §5 展示收款码).
 * The ME client contract (guide §5.3) does NOT define a payee-QR field, so
 * this is an operational seam: ops can bake ME_PAY_QR_CONTENT (an Alipay
 * QR payload such as https://qr.alipay.com/...) into the host environment.
 * When unset the UI shows an honest "not issued yet" placeholder and keeps
 * the remark+voucher path — it never fabricates a scannable QR.
 *
 * S9 v1.2 (owner ruling 2026-11-05): ship a sensible default instead of an
 * empty hint. The payee is described as the platform collection account and is
 * never named outright — only an ops-supplied hint may name a real account.
 */
const DEFAULT_ME_PAYEE_HINT = '平台收款账户（收款人信息以平台发布的收款码为准）';

export function getMePaymentInfo(): { qrContent: string; payeeHint: string } {
  return {
    qrContent: normalizeText(process.env.ME_PAY_QR_CONTENT),
    payeeHint: normalizeText(process.env.ME_PAY_PAYEE_HINT) || DEFAULT_ME_PAYEE_HINT,
  };
}

export function invalidateMeBalanceCache(): void {
  state.balanceCache = null;
}

export function isMeErrorCode(error: unknown, code: string): boolean {
  return error instanceof MePointsApiError && error.errorCode === code;
}

// IPC arguments are untyped: reject a malformed period/channel instead of
// silently repricing the order as a monthly desktop one.
function requireSubscriptionPeriod(value: unknown): MeSubscriptionPeriod {
  const text = normalizeText(value);
  if (text === 'month' || text === 'quarter' || text === 'year') return text;
  throw new MePointsApiError({
    stage: 'subscription_order',
    message: `invalid subscription period: ${text || '(empty)'}`,
  });
}

function requireSubscriptionChannel(value: unknown): MeSubscriptionChannel {
  const text = normalizeText(value);
  if (text === 'desktop' || text === 'cloud' || text === 'mobile') return text;
  throw new MePointsApiError({
    stage: 'subscription_order',
    message: `invalid subscription channel: ${text || '(empty)'}`,
  });
}

function optionalPaymentGateway(value: unknown, stage: 'topup_submit' | 'subscription_order'): MePaymentGateway | undefined {
  const text = normalizeText(value);
  if (!text) return undefined;
  if (text === 'alipay' || text === 'paypal') return text;
  throw new MePointsApiError({ stage, message: `invalid payment gateway: ${text}` });
}

// ---------------------------------------------------------------------------
// IPC surface
// ---------------------------------------------------------------------------

type RegisterIpcHandlerFn = (channel: string, handler: (...args: unknown[]) => unknown) => void;

export function registerMePointsIpcHandlers(deps: {
  registerIpcHandler: RegisterIpcHandlerFn;
  /** S9 v1.2: owner-editable payee QR from the 「收款设置」 page (decrypted on demand). */
  getSavedPaymentInfo?: () => { qrContent?: string; qrImageDataUrl?: string };
  /** kvStore access for the local ME point settings (credit-pack auto-deduct toggle); null until the store is ready. */
  getSettingsStore?: () => MePointSettingsStore | null;
}): void {
  const { registerIpcHandler } = deps;
  const wrap = (
    channel: string,
    run: (input: Record<string, unknown>) => Promise<Record<string, unknown> | unknown[]>,
  ) => {
    registerIpcHandler(channel, async (_event, rawInput?: unknown) => {
      const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
      try {
        void _event;
        return { success: true, ...(await run(input)) };
      } catch (error) {
        const meError = error instanceof MePointsApiError ? error : null;
        return {
          success: false,
          error: getErrorMessage(error),
          errorCode: meError?.errorCode ?? '',
          featureUnavailable: meError?.featureUnavailable ?? false,
        };
      }
    });
  };

  wrap('me:getPlans', async () => ({ plans: await getMePlans() }));
  wrap('me:getRates', async () => ({ rates: await getMeRates() }));
  wrap('me:getTopupPackages', async () => ({ topupPackages: await getMeTopupPackages() }));
  wrap('me:getBalance', async (input) => ({
    balance: await getMeBalance({ forceRefresh: input.forceRefresh === true }),
  }));
  wrap('me:getSubscription', async () => ({ subscription: await getMeSubscription() }));
  wrap('me:getHistory', async (input) => ({
    history: await getMeHistory({
      type: normalizeText(input.type) || undefined,
      beforeId: normalizeText(input.beforeId) || undefined,
      limit: toNumber(input.limit) || undefined,
    }),
  }));
  wrap('me:submitTopupOrder', async (input) => ({
    submission: await submitMeTopupOrder({
      packageId: normalizeText(input.packageId),
      periodDays: toNumber(input.periodDays) || undefined,
      voucherUrl: normalizeText(input.voucherUrl) || undefined,
      voucherRemark: normalizeText(input.voucherRemark) || undefined,
      idempotencyKey: normalizeText(input.idempotencyKey) || undefined,
      gateway: optionalPaymentGateway(input.gateway, 'topup_submit'),
    }),
  }));
  wrap('me:subscriptionOrder', async (input) => {
    const orderId = normalizeText(input.orderId);
    if (orderId && !normalizeText(input.planId)) {
      return { subscriptionOrder: await getMeSubscriptionOrder(orderId) };
    }
    return {
      subscriptionOrder: await submitMeSubscriptionOrder({
        planId: normalizeText(input.planId),
        period: requireSubscriptionPeriod(input.period),
        channel: requireSubscriptionChannel(input.channel),
        voucherUrl: normalizeText(input.voucherUrl) || undefined,
        voucherRemark: normalizeText(input.voucherRemark) || undefined,
        idempotencyKey: normalizeText(input.idempotencyKey) || undefined,
        gateway: optionalPaymentGateway(input.gateway, 'subscription_order'),
      }),
    };
  });
  wrap('me:getTopupOrders', async () => ({ orders: await getMeTopupOrders() }));
  wrap('me:getSubscriptionOrders', async () => ({ orders: await getMeSubscriptionOrders() }));
  // 积分增量包 toggle: the server flag (/v1/me/settings) is authoritative;
  // the kvStore keeps a mirror for degraded reads (server unreachable / no
  // identity). Writes only mirror AFTER a server confirmation — see
  // mePointSettings.ts. A failed set propagates: wrap() answers success:false
  // and the renderer reverts the toggle.
  wrap('me:getPointsSettings', async () => {
    try {
      const remote = await getMeSettings();
      mirrorMePointSettings(deps.getSettingsStore?.() ?? null, remote.autoDeductFromPersistent);
      return {
        settings: { autoDeductFromPersistent: remote.autoDeductFromPersistent },
        source: 'server',
      };
    } catch {
      return {
        settings: getMePointSettings(deps.getSettingsStore?.() ?? null),
        source: 'local',
      };
    }
  });
  wrap('me:setPointsSettings', async (input) => {
    const requested = typeof input.autoDeductFromPersistent === 'boolean'
      ? input.autoDeductFromPersistent
      : getMePointSettings(deps.getSettingsStore?.() ?? null).autoDeductFromPersistent;
    const remote = await setMeSettings(requested);
    mirrorMePointSettings(deps.getSettingsStore?.() ?? null, remote.autoDeductFromPersistent);
    return {
      settings: { autoDeductFromPersistent: remote.autoDeductFromPersistent },
      source: 'server',
    };
  });
  // S9 v1.2: the S3 「收款设置」 page lets ops paste a QR image/link on-device.
  // Prefer that (owner-editable, no rebuild) and fall back to the env seam.
  wrap('me:getPaymentInfo', async () => {
    const fromEnv = getMePaymentInfo();
    const saved = deps.getSavedPaymentInfo?.() ?? {};
    return {
      payment: {
        qrContent: saved.qrContent || fromEnv.qrContent,
        payeeHint: fromEnv.payeeHint,
        qrImageDataUrl: saved.qrImageDataUrl,
      },
    };
  });
  registerIpcHandler('me:pickVoucher', async (_event, rawInput?: unknown) => {
    void rawInput;
    try {
      return await pickMeVoucher();
    } catch (error) {
      return { success: false, error: getErrorMessage(error) };
    }
  });
}

/**
 * Voucher staging for the first-slice manual channel (S9 §5).
 *
 * Native file dialog → copy the picked screenshot into userData/me-vouchers/
 * → mint a signed gateway download URL for it when the gateway is running.
 * The remark textarea is always available as the minimum-viable credential
 * (guide §5.3: voucherUrl and voucherRemark 二选一至少填一项) — the UI
 * surfaces signedError honestly instead of pretending an upload happened.
 */
async function pickMeVoucher(): Promise<{
  success: boolean;
  fileLabel?: string;
  voucherUrl?: string;
  signedUrlError?: string;
}> {
  // Loaded lazily so plain-node test runs (require('electron') → path string)
  // never crash at import time.
  const electron = require('electron') as {
    dialog?: { showOpenDialog: (options: unknown) => Promise<{ canceled: boolean; filePaths?: string[] }> };
    app?: { getPath: (name: string) => string };
  };
  const dialog = electron.dialog;
  const app = electron.app;
  if (!dialog?.showOpenDialog || !app?.getPath) {
    return { success: false };
  }
  const picked = await dialog.showOpenDialog({
    title: '选择支付凭证截图',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  });
  if (picked.canceled || !picked.filePaths?.length) {
    return { success: false };
  }
  const fs = await import('node:fs');
  const nodePath = await import('node:path');
  const sourcePath = picked.filePaths[0];
  const voucherDir = nodePath.join(app.getPath('userData'), 'me-vouchers');
  await fs.promises.mkdir(voucherDir, { recursive: true });
  const stagedPath = nodePath.join(voucherDir, `${Date.now()}-${sanitizeFileName(nodePath.basename(sourcePath))}`);
  await fs.promises.copyFile(sourcePath, stagedPath);

  let voucherUrl: string | undefined;
  let signedUrlError: string | undefined;
  try {
    const { getActiveGatewayContext } = await import('../gateway/wiring');
    const { signFileDownload } = await import('../gateway/fileSign');
    const context = getActiveGatewayContext();
    if (context) {
      const signed = signFileDownload(
        { secret: context.secret, tenantId: context.tenantId, paths: context.paths, realpathSync: fs.realpathSync },
        { path: stagedPath, disposition: 'inline' },
      );
      if ('url' in signed && typeof (signed as { url?: unknown }).url === 'string') {
        voucherUrl = (signed as { url: string }).url;
      } else {
        signedUrlError = String((signed as { message?: string }).message ?? 'gateway signing failed');
      }
    } else {
      signedUrlError = '凭证已保存本地，但网关未运行，暂生成下载链接';
    }
  } catch (error) {
    signedUrlError = getErrorMessage(error);
  }
  return {
    success: true,
    fileLabel: nodePath.basename(sourcePath),
    ...(voucherUrl ? { voucherUrl } : {}),
    ...(signedUrlError ? { signedUrlError } : {}),
  };
}

function sanitizeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-96) || 'voucher.png';
}
