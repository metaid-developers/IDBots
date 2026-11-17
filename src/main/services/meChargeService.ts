/**
 * ME (MetaID Energy) charge service — the buyer-side SPEND leg.
 *
 * Sibling of mePointsService (which owns balance/history/plans/topup reads).
 * This file owns the four signed spend endpoints and nothing else:
 *
 *   POST /v1/me/freeze   action freeze   {orderId, amountMilli, payee?, refType?, refId?}
 *   POST /v1/me/capture  action capture  {orderId}
 *   POST /v1/me/release  action release  {orderId}
 *   POST /v1/me/pay      action pay      {payee, amountMilli, idempotencyKey, refType?, refId?, reason?}
 *   GET  /v1/me/freezes  action freezes  (?limit)
 *
 * Why freeze→capture instead of pay for goods: freeze holds the amount across
 * delivery (balances are deducted immediately, the hold becomes ledger rows
 * only at capture, release restores them), so a buyer never pays before the
 * goods move. `payMe` is the atomic micro-charge leg (paid chat / skill call)
 * where there is no delivery gate worth modeling.
 *
 * Contract facts this module is built on (2026-11-17, measured live against
 * assist-open-api; source cross-checked in assist-base-service
 * controller/me_controller.go + service/me_service/consume_service.go):
 *  - orderId is the freeze idempotency key, charset [A-Za-z0-9_-.:]{1,80};
 *    a replay returns the stored row with applied=false.
 *  - freeze TTL is server hot-config, default 86400s; capture after expiry
 *    auto-releases the hold and fails STATE_CONFLICT.
 *  - release is idempotent (released/expired → applied=false).
 *  - capture is idempotent (a captured freeze replays the original entryId).
 *  - a missing freeze order surfaces as INTERNAL_ERROR on the deployed build
 *    (the handler reads the row before mapping "not found") — callers must
 *    treat INTERNAL_ERROR as "no such freeze / not yours" and never retry.
 *  - the server does NOT validate the payee address (measured: a garbage
 *    payee string froze 1 ME); payee format and ownership checks are the
 *    caller's job — `assertMvcPayee` implements the format half, and the
 *    me_charge tool adds the item-owner half for NFT purchases.
 *
 * Identity: every call signs with an EXPLICIT signer (mnemonic+path) and
 * DERIVES the identity address from that same key material, so the header can
 * never disagree with the signature. mePointsService signs the local user
 * identity; the me_charge tool passes the session MetaBot's own wallet. The
 * service never logs, prints or persists key material.
 *
 * Reuse (S8 paid chat / skill fees): call meFreeze then meCapture around the
 * delivery, or mePay for a one-shot charge — the guard helpers
 * (normalizeOrderId / assertMvcPayee / describeMeChargeError) are exported so
 * a second caller cannot invent a second convention.
 *
 * Owner confirmation: the spend functions below are the transport, not the
 * policy. The confirmation gate lives at the me_charge tool entrance
 * (meChargeAgentTools) so every agent surface — interactive, delegated or
 * unattended — passes through it; callers that bypass the tool are scripts,
 * not agent sessions. The gate reads ME_CHARGE_REQUIRE_CONFIRMATION_SETTING_KEY
 * through isMeChargeConfirmationRequired (default ON).
 */

import { deriveMvcSponsorAddress } from './mvcSponsorClient';
import {
  DEFAULT_ME_WALLET_PATH,
  MePointsApiError,
  meRequestJson,
  signMeAction,
} from './mePointsService';

/** Freeze row status codes (models/me_freeze_model.go). */
export const ME_FREEZE_STATUS = {
  frozen: 1,
  captured: 2,
  released: 3,
  expired: 4,
} as const;

/** Server-side orderId charset (service/me_service/consume_service.go freezeInTx). */
const ORDER_ID_PATTERN = /^[A-Za-z0-9_\-.:]{1,80}$/;
/** MVC addresses are base58 P2PKH: leading '1', 26-34 chars, no 0OIl. */
const MVC_ADDRESS_PATTERN = /^1[1-9A-HJ-NP-Za-km-z]{25,33}$/;

/**
 * Settings kv key for the per-charge owner confirmation gate (logical name
 * `meChargeRequireConfirmation`, persisted in the same snake_case kv store as
 * `wallet_transfer_external_confirm_enabled`). Absent/false-y reads keep the
 * gate ON — the switch only ever takes effect when explicitly set to false.
 */
export const ME_CHARGE_REQUIRE_CONFIRMATION_SETTING_KEY = 'me_charge_require_confirmation';

export interface MeChargeSettingsReader {
  get<T = unknown>(key: string): T | undefined;
}

/**
 * True when every ME charge (freeze / capture / pay) must be preceded by an
 * explicit owner confirmation in the current conversation. Default ON: a
 * missing reader, a missing key or a throwing reader all keep the gate, so a
 * storage fault can never silently turn spending into an unconfirmed path.
 */
export function isMeChargeConfirmationRequired(
  reader: MeChargeSettingsReader | null | undefined,
): boolean {
  if (!reader) return true;
  try {
    const value = reader.get<boolean>(ME_CHARGE_REQUIRE_CONFIRMATION_SETTING_KEY);
    return value === undefined ? true : value !== false;
  } catch {
    return true;
  }
}

/** Raw signer material for one charge (kept in memory only). */
export interface MeChargeSigner {
  mnemonic: string;
  /** Derivation path; defaults to the identity path m/44'/10001'/0'/0/0. */
  path?: string;
}

/** A freeze row as the client reports it (camelCase, tolerant of snake_case). */
export interface MeFreezeView {
  orderId: string;
  amountMilli: number;
  payee: string;
  refType: string;
  refId: string;
  /** 1 frozen · 2 captured · 3 released · 4 expired. */
  status: number;
  /** false on an idempotent replay — the hold was NOT re-applied. */
  applied: boolean;
  expiresAt: number;
  splits: { grantMilli: number; bonusMilli: number; topupMilli: number; earnedMilli: number };
}

/** A capture/pay result as the client reports it. */
export interface MeSettlementView {
  entryId: string;
  payer: string;
  payee: string;
  amountMilli: number;
  /** The payee's earned-bucket balance AFTER this credit (server-computed). */
  payeeEarnedAfter?: number;
  /** false when an idempotent replay returned the original entry instead of charging again. */
  applied: boolean;
}

export interface MeChargeBalanceView {
  identityAddress: string;
  frozenMilli: number;
  totalAvailableMilli: number;
  spendableMilli?: number;
  weeklyRemainingMilli: number;
  earnedMilli: number;
  topupMilli: number;
  bonusMilli: number;
}

function resolveSigner(signer: MeChargeSigner): { mnemonic: string; path: string; mvcAddress: string } {
  const mnemonic = String(signer?.mnemonic ?? '').trim();
  if (!mnemonic) {
    throw new MePointsApiError({ stage: 'freeze', message: 'ME charge needs the signing wallet (mnemonic) of the paying bot' });
  }
  const path = String(signer.path ?? '').trim() || DEFAULT_ME_WALLET_PATH;
  // Address and signature come from ONE key derivation: a mismatched pair
  // would be rejected by the server as an invalid signature, and silently
  // signing as the wrong identity is worse than failing here.
  return { mnemonic, path, mvcAddress: deriveMvcSponsorAddress({ mnemonic, path }) };
}

function pickText(record: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
}

/**
 * Validate an order id BEFORE spending a request: the server rejects a bad
 * charset with a bare BAD_REQUEST, which reads as "the payment failed" to a
 * user. Order ids double as the idempotency key, so this is also the guard
 * that makes "same order → same hold" true.
 */
export function normalizeOrderId(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error('order_id is required (it doubles as the ME idempotency key)');
  if (!ORDER_ID_PATTERN.test(value)) {
    throw new Error(`order_id "${value}" is invalid: use 1-80 chars of A-Z a-z 0-9 _ - . : (the ME service idempotency key charset)`);
  }
  return value;
}

/** Format-only payee validation (the server does none — measured). */
export function assertMvcPayee(raw: unknown, payerAddress: string): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new Error('payee is required: the ME amount is only ever credited to one explicit MVC address');
  if (!MVC_ADDRESS_PATTERN.test(value)) {
    throw new Error(`payee "${value}" is not an MVC address; refusing to freeze ME against an address the ledger cannot pay`);
  }
  if (payerAddress && value === payerAddress) {
    throw new Error('payee equals the paying identity: ME cannot be paid to the payer (server rejects it as BAD_REQUEST)');
  }
  return value;
}

function toMilliMe(amountMilli: unknown): number {
  const value = Number(amountMilli);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error('amountMilli must be a positive integer of milliME (1 ME = 1000 milliME)');
  }
  return value;
}

function normalizeFreeze(data: Record<string, unknown>): MeFreezeView {
  return {
    orderId: pickText(data, 'orderId', 'order_id'),
    amountMilli: pickNumber(data, 'amountMilli', 'amount_milli'),
    payee: pickText(data, 'payeeAddress', 'payee_address', 'payee'),
    refType: pickText(data, 'refType', 'ref_type'),
    refId: pickText(data, 'refId', 'ref_id'),
    status: pickNumber(data, 'status'),
    applied: data.applied !== false,
    expiresAt: pickNumber(data, 'expiresAt', 'expires_at'),
    splits: {
      grantMilli: pickNumber(data, 'grantMilli', 'grant_milli', 'splitGrantMilli', 'split_grant_milli'),
      bonusMilli: pickNumber(data, 'bonusMilli', 'bonus_milli', 'splitBonusMilli', 'split_bonus_milli'),
      topupMilli: pickNumber(data, 'topupMilli', 'topup_milli', 'splitTopupMilli', 'split_topup_milli'),
      earnedMilli: pickNumber(data, 'earnedMilli', 'earned_milli', 'splitEarnedMilli', 'split_earned_milli'),
    },
  };
}

function normalizeSettlement(data: Record<string, unknown>, fallback: { payer: string; payee: string }): MeSettlementView {
  const payeeEarned = pickNumber(data, 'payeeEarnedAfter', 'payee_earned_after');
  return {
    entryId: pickText(data, 'entryId', 'entry_id'),
    payer: pickText(data, 'payer', 'payerAddress', 'payer_address') || fallback.payer,
    payee: pickText(data, 'payee', 'payeeAddress', 'payee_address') || fallback.payee,
    amountMilli: pickNumber(data, 'amountMilli', 'amount_milli'),
    ...(payeeEarned > 0 ? { payeeEarnedAfter: payeeEarned } : {}),
    applied: data.applied !== false,
  };
}

async function signedPost(
  stage: 'freeze' | 'capture' | 'release' | 'pay',
  action: string,
  path: string,
  body: Record<string, unknown>,
  signer: { mnemonic: string; path: string; mvcAddress: string },
): Promise<Record<string, unknown>> {
  const identity = await signMeAction(action, signer);
  return (await meRequestJson({ stage, method: 'POST', path, body, identity })) as Record<string, unknown>;
}

/**
 * POST /v1/me/freeze — hold `amountMilli` from the payer's pools and name the
 * payee the hold may later be captured to. Idempotent on orderId.
 */
export async function meFreeze(input: {
  signer: MeChargeSigner;
  orderId: string;
  amountMilli: number;
  payee: string;
  refType?: string;
  refId?: string;
}): Promise<MeFreezeView> {
  const signer = resolveSigner(input.signer);
  const orderId = normalizeOrderId(input.orderId);
  const amountMilli = toMilliMe(input.amountMilli);
  const payee = assertMvcPayee(input.payee, signer.mvcAddress);
  const data = await signedPost('freeze', 'freeze', '/v1/me/freeze', {
    orderId,
    amountMilli,
    payee,
    refType: String(input.refType ?? '').trim() || undefined,
    refId: String(input.refId ?? '').trim() || undefined,
  }, signer);
  return normalizeFreeze(data);
}

/** POST /v1/me/capture — turn a frozen hold into payer-debit / payee-earned ledger rows. */
export async function meCapture(input: {
  signer: MeChargeSigner;
  orderId: string;
}): Promise<MeSettlementView> {
  const signer = resolveSigner(input.signer);
  const orderId = normalizeOrderId(input.orderId);
  const data = await signedPost('capture', 'capture', '/v1/me/capture', { orderId }, signer);
  return normalizeSettlement(data, { payer: signer.mvcAddress, payee: '' });
}

/** POST /v1/me/release — return a frozen hold to the pools. Idempotent. */
export async function meRelease(input: {
  signer: MeChargeSigner;
  orderId: string;
}): Promise<MeFreezeView> {
  const signer = resolveSigner(input.signer);
  const orderId = normalizeOrderId(input.orderId);
  const data = await signedPost('release', 'release', '/v1/me/release', { orderId }, signer);
  return normalizeFreeze(data);
}

/**
 * POST /v1/me/pay — atomic payer→payee transfer (no delivery gate).
 * `idempotencyKey` is required by the server and is the only replay guard.
 */
export async function mePay(input: {
  signer: MeChargeSigner;
  payee: string;
  amountMilli: number;
  idempotencyKey: string;
  refType?: string;
  refId?: string;
  reason?: string;
}): Promise<MeSettlementView> {
  const signer = resolveSigner(input.signer);
  const payee = assertMvcPayee(input.payee, signer.mvcAddress);
  const amountMilli = toMilliMe(input.amountMilli);
  const idempotencyKey = String(input.idempotencyKey ?? '').trim();
  if (!idempotencyKey) throw new Error('idempotencyKey is required for mePay (the server charges once per key)');
  const data = await signedPost('pay', 'pay', '/v1/me/pay', {
    payee,
    amountMilli,
    idempotencyKey,
    refType: String(input.refType ?? '').trim() || undefined,
    refId: String(input.refId ?? '').trim() || undefined,
    reason: String(input.reason ?? '').trim() || undefined,
  }, signer);
  return normalizeSettlement(data, { payer: signer.mvcAddress, payee });
}

/** GET /v1/me/freezes — this identity's freeze rows, newest first. */
export async function listMeFreezes(input: {
  signer: MeChargeSigner;
  limit?: number;
}): Promise<MeFreezeView[]> {
  const signer = resolveSigner(input.signer);
  const identity = await signMeAction('freezes', signer);
  const data = await meRequestJson({
    stage: 'freezes',
    method: 'GET',
    path: '/v1/me/freezes',
    query: { limit: input.limit && input.limit > 0 ? Math.min(input.limit, 50) : 20 },
    identity,
  });
  const rows = Array.isArray(data)
    ? data
    : (Array.isArray((data as Record<string, unknown>).rows) ? (data as Record<string, unknown>).rows as unknown[] : []);
  return rows
    .filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object' && !Array.isArray(row)))
    .map(normalizeFreeze);
}

/** GET /v1/me/balance — the spend snapshot a buyer needs before freezing. */
export async function getMeChargeBalance(input: { signer: MeChargeSigner }): Promise<MeChargeBalanceView> {
  const signer = resolveSigner(input.signer);
  const identity = await signMeAction('balance', signer);
  const data = (await meRequestJson({ stage: 'balance', method: 'GET', path: '/v1/me/balance', identity })) as Record<string, unknown>;
  const grant = (data.weeklyGrant ?? data.weekly_grant ?? {}) as Record<string, unknown>;
  const persistent = (data.persistent ?? {}) as Record<string, unknown>;
  const spendableRaw = data.spendableMilli ?? data.spendable_milli;
  const spendable = Number(spendableRaw);
  return {
    identityAddress: pickText(data, 'identityAddress', 'identity_address') || signer.mvcAddress,
    frozenMilli: pickNumber(data, 'frozenMilli', 'frozen_milli'),
    totalAvailableMilli: pickNumber(data, 'totalAvailable', 'total_available'),
    ...(Number.isFinite(spendable) && spendable >= 0 ? { spendableMilli: spendable } : {}),
    weeklyRemainingMilli: pickNumber(grant, 'remainingMilli', 'remaining_milli'),
    earnedMilli: pickNumber(persistent, 'earnedMilli', 'earned_milli'),
    topupMilli: pickNumber(persistent, 'topupMilli', 'topup_milli'),
    bonusMilli: pickNumber(persistent, 'bonusMilli', 'bonus_milli'),
  };
}

/**
 * One-line, actionable rendering of a charge failure. Stable error codes come
 * from assist-base-service service/me_service/errors.go MapErrorToCode; the
 * mappings below were all reproduced live on 2026-11-17.
 */
export function describeMeChargeError(error: unknown): string {
  if (error instanceof MePointsApiError) {
    switch (error.errorCode) {
      case 'INSUFFICIENT_ME': {
        const need = error.neededMilli;
        const have = error.haveMilli;
        const detail = need != null && have != null
          ? `need ${need} milliME (${need / 1000} ME), available ${have} milliME (${have / 1000} ME)`
          : 'the balance cannot cover this amount';
        const gate = error.autoDeductDisabled
          ? '; the identity has autoDeductFromPersistent=OFF, so only the weekly grant could be drawn'
          : '';
        return `INSUFFICIENT_ME: ${detail}${gate}. Nothing was frozen.`;
      }
      case 'NOT_FOUND':
        return 'NOT_FOUND: no such freeze order for this identity. Nothing changed.';
      case 'INTERNAL_ERROR':
        // Deployed build answers a missing freeze row with INTERNAL_ERROR
        // before it can map "not found" (measured 2026-11-17).
        return 'INTERNAL_ERROR: the ME service did not recognise this freeze order (missing, already settled, or not owned by this identity). Do not retry — check me_charge status first.';
      case 'STATE_CONFLICT':
        return 'STATE_CONFLICT: the freeze is no longer frozen (captured, released, or expired). Nothing was charged; release is idempotent, so this means the hold is already back in the balance or already settled.';
      case 'BAD_REQUEST':
        return `BAD_REQUEST: ${error.message || 'the ME service rejected the request parameters'}`;
      case 'LIMIT_EXCEEDED':
        return `LIMIT_EXCEEDED: ${error.message || 'the autonomous daily pay limit was hit'}. Nothing was frozen.`;
      case 'ME_DISABLED':
        return 'ME_DISABLED: the ME ledger is switched off on this server.';
      default:
        return `${error.errorCode || 'ME_ERROR'}: ${error.message}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}
