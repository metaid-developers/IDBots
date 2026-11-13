/**
 * MVC sponsor v2 direct file upload (fee assistance).
 * Ported from open-agent-connect:
 * - src/core/subsidy/mvcSponsorV2Client.ts (API client)
 * - src/core/files/mvcSponsorDirectUpload.ts (direct-upload orchestration)
 * - src/core/chain/mvcFileInscriptionDraft.ts (unsigned draft + user-input signing)
 *
 * Flow: address info -> unsigned /file inscription draft -> quota check ->
 * challenge -> pre (sponsor prepares tx) -> sign user-owned inputs ->
 * commit (sponsor broadcasts). Self-paid fallback semantics aligned with
 * mvcSponsorCreatePin (2026-09-08 owner rule: a sponsor outage or error must
 * never block the write — auto-switch to the bot's own wallet with an
 * explicit trace): ANY sponsor failure — service_unavailable / no_user_utxo /
 * insufficient_quota / insufficient_traffic / insufficient_me / pre_rejected /
 * commit_failed — falls back to a regular self-paid direct upload.
 * Commit-stage failures reconcile the sponsor order first so an
 * already-broadcast tx resolves as sponsored success instead of
 * double-writing. Billing currency follows mvcSponsorCreatePin: ME credits
 * when address/info advertises me.trafficBilling, traffic bytes otherwise.
 *
 * The sponsor protocol itself (API client, message signing, UTXO fetch,
 * size/fee estimation, user-input signing) lives in mvcSponsorClient.ts;
 * this file keeps the /file inscription draft and the upload orchestration.
 *
 * Deviation note: open-agent-connect also tracks pending UTXOs after a
 * sponsor commit; IDBots instead relies on its existing MVC spend
 * coordinator and stale-input retry machinery.
 */

import fs from 'fs';
import { TxComposer, mvc } from 'meta-contract';
import {
  createMvcSponsorV2Client,
  estimateDraftMinerFee,
  fetchMvcAddressUtxos,
  getErrorMessage,
  getEstimatedBaseTxSize,
  getOpReturnScriptSize,
  isMvcInsufficientSelfPayError,
  isNoUserUtxoDraftError,
  pickUtxos,
  reconcileSponsorOrderAfterCommitFailure,
  meBillingOf,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
  trafficBalanceBytesOf,
  type MvcSponsorAddressInfo,
  type MvcSponsorDraft,
  type SponsorMvcUtxo,
  type SponsorPaySource,
} from './mvcSponsorClient';
import { appendMetaidLog } from './metaidLog';
import {
  noteMeTrafficBillingLive,
  recordLocalTrafficSpend,
  resolveSponsorTrafficAccount,
  sponsorBilledBy,
  type TrafficSpendBilledBy,
} from './trafficAccountService';
import {
  isSponsorBroadcastFailureError,
  isSponsorCircuitOpen,
  recordSponsorBroadcastFailure,
  recordSponsorSuccess,
  sponsorCircuitRecentFailures,
  sponsorCircuitRetryAfterMs,
  SPONSOR_BREAKER_COOLDOWN_MS,
} from './mvcSponsorCircuitBreaker';
import { TrafficInsufficientError } from './mvcSponsorCreatePin';
import type { TrafficFallbackPolicy } from './trafficSettings';

export {
  createMvcSponsorV2Client,
  fetchMvcAddressUtxos,
  signMvcPreparedUserInputs,
} from './mvcSponsorClient';
export { TrafficInsufficientError } from './mvcSponsorCreatePin';
export type {
  MvcSponsorAddressInfo,
  MvcSponsorDraft,
  MvcSponsorV2Client,
  SponsorMvcUtxo,
} from './mvcSponsorClient';

export type MvcSponsorFeeAssistMode = 'mvc_sponsor_v2' | 'self_paid';
export type MvcSponsorFeeAssistReason =
  | 'service_unavailable'
  | 'no_user_utxo'
  | 'insufficient_quota'
  | 'insufficient_traffic'
  | 'insufficient_me'
  | 'pre_rejected'
  | 'commit_failed'
  | 'circuit_open';
export type MvcSponsorFeeAssistStage =
  | 'address_info'
  | 'challenge'
  | 'pre'
  | 'commit'
  | 'done';

export interface MvcSponsorFeeAssistMetadata {
  attempted: boolean;
  used: boolean;
  mode: MvcSponsorFeeAssistMode;
  sponsor: 'mvc_sponsor_v2';
  reason?: MvcSponsorFeeAssistReason;
  stage?: MvcSponsorFeeAssistStage;
  orderId?: string;
  /** True when a failed commit was reconciled to an order that had broadcast. */
  commitRecovered?: boolean;
  /** Sponsor-order outcome observed while reconciling a failed commit. */
  commitOrderOutcome?: 'failed' | 'pending' | 'unknown';
  /** Raw error of the self-paid fallback when that fallback also failed. */
  selfPaidError?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  quotaAfter?: MvcSponsorAddressInfo;
  advisoryFeeEstimate?: number;
  sponsoredMinerFee?: number;
  savedFee?: number;
  /** What a sponsored write was billed in ('me' credits / 'traffic' bytes / legacy 'quota'). */
  billedBy?: TrafficSpendBilledBy;
  /** ME charged in milliME when billedBy is 'me' and the sponsor echoed it. */
  meAmountMilli?: number;
  /** Underlying sponsor/worker failure detail for diagnostics. */
  detail?: string;
  /** Backend data.errorCode / code when present (e.g. ME_DAILY_LIMIT, ME_INSUFFICIENT). */
  serviceErrorCode?: string;
  /** Required ME in milliME reported by backend on ME_INSUFFICIENT. */
  requiredMilli?: number;
  /** Latest known spendable ME in milliME from address/info or backend rejection. */
  spendableMilli?: number;
  /** Daily traffic ME limit in milliME reported by backend on ME_DAILY_LIMIT. */
  limitMilli?: number;
  /** Estimated or observed transaction byte size. */
  txSize?: number;
}

export interface MvcSponsorDirectUploadInput {
  filePath: string;
  fileName: string;
  contentType: string;
  bytes: number;
  extension: string;
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  globalMetaId?: string;
  /** Performs the regular direct upload used by the self-paid fallback paths. */
  selfPaidUpload: (
    feeAssist: MvcSponsorFeeAssistMetadata,
  ) => Promise<Record<string, unknown>>;
  /**
   * 'strict' forbids self-paid fallback and throws TrafficInsufficientError;
   * 'selfpay' (or omitted) keeps the self-paid fallback.
   */
  fallbackPolicy?: TrafficFallbackPolicy;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  fetchUtxos?: (address: string) => Promise<SponsorMvcUtxo[]>;
  /** Order-reconciliation timing after a failed commit (tests override; defaults 5s/30s). */
  commitReconcilePollIntervalMs?: number;
  commitReconcileMaxWaitMs?: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getStableErrorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' && code.trim() ? code.trim() : fallback;
}

// ---------------------------------------------------------------------------
// Unsigned /file inscription draft
// ---------------------------------------------------------------------------

function buildOpReturnParts(input: {
  operation: string;
  path: string;
  encryption: string;
  version: string;
  contentType: string;
  payload: Buffer;
}): Array<string | Buffer> {
  const parts: Array<string | Buffer> = ['metaid', input.operation];
  if (input.operation !== 'init') {
    parts.push(input.path.toLowerCase());
    parts.push(input.encryption);
    parts.push(input.version);
    parts.push(input.contentType);
    parts.push(input.payload);
  }
  return parts;
}

export function buildMvcFileInscriptionDraft(input: {
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  request: {
    operation: string;
    path: string;
    encryption: string;
    version: string;
    contentType: string;
    payload: Buffer;
  };
  utxos: SponsorMvcUtxo[];
  feeRate?: number;
  deductMinerFeeFromChange?: boolean;
}): Promise<MvcSponsorDraft> {
  const feeRate = Number.isFinite(input.feeRate) && Number(input.feeRate) > 0 ? Number(input.feeRate) : 1;
  const deductMinerFeeFromChange = input.deductMinerFeeFromChange !== false;
  const addressObject = new mvc.Address(input.mvcAddress, mvc.Networks.livenet as never);

  const txComposer = new TxComposer();
  txComposer.appendP2PKHOutput({ address: addressObject, satoshis: 1 });
  txComposer.appendOpReturnOutput(buildOpReturnParts(input.request));

  const totalOutput = txComposer.tx.outputs.reduce((sum, output) => sum + Number(output.satoshis || 0), 0);
  const opReturnParts = buildOpReturnParts(input.request);
  const picked = pickUtxos(
    input.utxos,
    totalOutput,
    deductMinerFeeFromChange ? feeRate : 0,
    getEstimatedBaseTxSize(getOpReturnScriptSize(opReturnParts)),
  );
  for (const utxo of picked) {
    txComposer.appendP2PKHInput({
      address: addressObject,
      txId: utxo.txId,
      outputIndex: utxo.outputIndex,
      satoshis: utxo.satoshis,
    });
  }
  if (deductMinerFeeFromChange) {
    txComposer.appendChangeOutput(addressObject, feeRate);
  } else {
    const changeAmount = picked.reduce((sum, utxo) => sum + utxo.satoshis, 0) - totalOutput;
    if (changeAmount > 0) {
      txComposer.appendP2PKHOutput({ address: addressObject, satoshis: changeAmount });
    }
  }

  return Promise.resolve({
    address: input.mvcAddress,
    privateKey: null,
    userInputs: picked,
    unsignedTxHex: txComposer.getRawHex(),
  });
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

function normalizeSponsorReason(value: unknown, fallback: MvcSponsorFeeAssistReason): MvcSponsorFeeAssistReason {
  return value === 'insufficient_quota'
    || value === 'insufficient_traffic'
    || value === 'insufficient_me'
    || value === 'service_unavailable'
    || value === 'commit_failed'
    || value === 'pre_rejected'
    || value === 'no_user_utxo'
    || value === 'circuit_open'
    ? value
    : fallback;
}

function attachFeeAssistError(input: {
  error: unknown;
  fallbackCode: string;
  fallbackReason: MvcSponsorFeeAssistReason;
  stage: MvcSponsorFeeAssistStage;
  orderId?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  advisoryFeeEstimate?: number;
  sponsoredMinerFee?: number;
}): never {
  const error = input.error instanceof Error
    ? input.error as Error & { code?: string; data?: Record<string, unknown>; reason?: MvcSponsorFeeAssistReason }
    : new Error(getErrorMessage(input.error, `MVC sponsor ${input.stage} failed.`)) as Error & { code?: string; data?: Record<string, unknown> };
  error.code = getStableErrorCode(error, input.fallbackCode);
  const existingData = error.data && typeof error.data === 'object' ? error.data : {};
  error.data = {
    ...existingData,
    feeAssist: {
      attempted: true,
      used: false,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      reason: normalizeSponsorReason((error as { reason?: unknown }).reason, input.fallbackReason),
      stage: input.stage,
      orderId: input.orderId,
      quotaBefore: input.quotaBefore,
      advisoryFeeEstimate: input.advisoryFeeEstimate,
      sponsoredMinerFee: input.sponsoredMinerFee,
      savedFee: input.sponsoredMinerFee,
    } satisfies MvcSponsorFeeAssistMetadata,
  };
  throw error;
}

async function fallbackSelfPaidForSponsorError(input: {
  error: unknown;
  selfPaidUpload: MvcSponsorDirectUploadInput['selfPaidUpload'];
  fallbackPolicy?: TrafficFallbackPolicy;
  fallbackReason: MvcSponsorFeeAssistReason;
  stage: MvcSponsorFeeAssistStage;
  orderId?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  billedBy?: TrafficSpendBilledBy;
  txSize?: number;
  advisoryFeeEstimate?: number;
  /** Sponsor-order outcome observed while reconciling a failed commit. */
  commitOrderOutcome?: 'failed' | 'pending' | 'unknown';
}): Promise<Record<string, unknown>> {
  const reason = normalizeSponsorReason((input.error as { reason?: unknown })?.reason, input.fallbackReason);
  const errObj = input.error as {
    message?: unknown;
    serviceMessage?: unknown;
    serviceErrorCode?: unknown;
    neededMilli?: unknown;
    availableMilli?: unknown;
    limitMilli?: unknown;
  } | undefined;
  const rawDetail = typeof errObj?.serviceMessage === 'string' && errObj.serviceMessage.trim()
    ? errObj.serviceMessage.trim()
    : input.error instanceof Error && input.error.message
      ? input.error.message.trim()
      : '';
  const serviceErrorCode = typeof errObj?.serviceErrorCode === 'string' && errObj.serviceErrorCode.trim()
    ? errObj.serviceErrorCode.trim()
    : undefined;
  const requiredMilli = typeof errObj?.neededMilli === 'number' && Number.isFinite(errObj.neededMilli)
    ? errObj.neededMilli
    : undefined;
  const availableFromErr = typeof errObj?.availableMilli === 'number' && Number.isFinite(errObj.availableMilli)
    ? errObj.availableMilli
    : undefined;
  const spendableMilli = availableFromErr ?? meBillingOf(input.quotaBefore)?.spendableMilli;
  const limitMilli = typeof errObj?.limitMilli === 'number' && Number.isFinite(errObj.limitMilli)
    ? errObj.limitMilli
    : undefined;
  const billedBy = input.billedBy
    ?? (meBillingOf(input.quotaBefore)?.trafficBilling ? 'me' : input.quotaBefore ? 'quota' : undefined);
  const diagnosticFields: Partial<MvcSponsorFeeAssistMetadata> = {
    ...(rawDetail ? { detail: rawDetail } : {}),
    ...(serviceErrorCode ? { serviceErrorCode } : {}),
    ...(billedBy ? { billedBy } : {}),
    ...(requiredMilli !== undefined ? { requiredMilli } : {}),
    ...(spendableMilli !== undefined ? { spendableMilli } : {}),
    ...(limitMilli !== undefined ? { limitMilli } : {}),
    ...(typeof input.txSize === 'number' && Number.isFinite(input.txSize) && input.txSize > 0
      ? { txSize: input.txSize }
      : {}),
  };
  if (input.fallbackPolicy === 'strict') {
    const feeAssist: MvcSponsorFeeAssistMetadata = {
      attempted: true,
      used: false,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      reason,
      stage: input.stage,
      orderId: input.orderId,
      commitOrderOutcome: input.commitOrderOutcome,
      quotaBefore: input.quotaBefore,
      advisoryFeeEstimate: input.advisoryFeeEstimate,
      ...diagnosticFields,
    };
    appendMetaidLog('WARN', 'Sponsored MVC file upload failed under strict policy — self-paid fallback blocked', {
      reason,
      stage: input.stage,
      orderId: input.orderId,
      commitOrderOutcome: input.commitOrderOutcome,
      fallbackPolicy: input.fallbackPolicy,
      ...diagnosticFields,
    });
    throw new TrafficInsufficientError({
      reason,
      stage: input.stage,
      orderId: input.orderId,
      detail: rawDetail || undefined,
      feeAssist,
    });
  }
  // Self-pay spends the bot's own wallet — never let that happen silently
  // (the 2026-09-07 outage: exhausted legacy quota forced every traffic-mode
  // write to self-pay with no trace of why). The WARN log + feeAssist trace
  // keep every fallback visible; the 2026-09-08 hard-fail regression
  // (SPONSOR_BROADCAST_PENDING blocking all writes) is why commit-stage
  // failures now land here too.
  appendMetaidLog('WARN', 'Sponsored MVC file upload falling back to self-paid', {
    reason,
    stage: input.stage,
    orderId: input.orderId,
    commitOrderOutcome: input.commitOrderOutcome,
  });
  try {
    return await input.selfPaidUpload({
      attempted: true,
      used: false,
      mode: 'self_paid',
      sponsor: 'mvc_sponsor_v2',
      reason,
      stage: input.stage,
      orderId: input.orderId,
      commitOrderOutcome: input.commitOrderOutcome,
      quotaBefore: input.quotaBefore,
      advisoryFeeEstimate: input.advisoryFeeEstimate,
    });
  } catch (error) {
    // Both channels failed (R1.3/D3): keep the raw self-paid error as the
    // message tail and attach the structured feeAssist so tool receipts can
    // show the sponsor reason AND the self-paid failure side by side. A
    // broke wallet gets the stable INSUFFICIENT_SELFPAY_FUNDS code (D4).
    const rawMessage = getErrorMessage(error, 'unknown error');
    const failedError = error instanceof Error
      ? error as Error & { code?: string; data?: Record<string, unknown> }
      : new Error(rawMessage) as Error & { code?: string; data?: Record<string, unknown> };
    const code = isMvcInsufficientSelfPayError(error)
      ? 'INSUFFICIENT_SELFPAY_FUNDS'
      : typeof failedError.code === 'string' && failedError.code.trim()
        ? failedError.code
        : 'mvc_selfpaid_fallback_failed';
    failedError.code = code;
    failedError.message = `Sponsored MVC file upload fell back to self-paid (sponsor ${reason} at ${input.stage}) but the self-paid upload failed: ${rawMessage}`;
    const existingData = failedError.data && typeof failedError.data === 'object' ? failedError.data : {};
    failedError.data = {
      ...existingData,
      feeAssist: {
        attempted: true,
        used: false,
        mode: 'self_paid',
        sponsor: 'mvc_sponsor_v2',
        reason,
        stage: input.stage,
        orderId: input.orderId,
        commitOrderOutcome: input.commitOrderOutcome,
        quotaBefore: input.quotaBefore,
        advisoryFeeEstimate: input.advisoryFeeEstimate,
        selfPaidError: rawMessage,
      } satisfies MvcSponsorFeeAssistMetadata,
    };
    throw failedError;
  }
}

export async function uploadMvcSponsorDirectFile(
  input: MvcSponsorDirectUploadInput,
): Promise<Record<string, unknown>> {
  const data = await fs.promises.readFile(input.filePath);
  const request = {
    operation: 'create',
    path: '/file',
    encryption: '0',
    version: '1.0',
    contentType: input.contentType,
    payload: data,
  };

  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  // R3.2 circuit breaker: after repeated sponsor broadcast failures for this
  // address, skip the sponsor entirely for the cooldown and go self-paid —
  // no doomed orders, no reconcile wait. Sponsored successes reset it.
  if (isSponsorCircuitOpen(input.mvcAddress)) {
    appendMetaidLog('WARN', 'Sponsored MVC file upload skipped — sponsor circuit breaker open, going self-paid', {
      mvcAddress: input.mvcAddress,
      recentFailures: sponsorCircuitRecentFailures(input.mvcAddress),
      retryAfterMs: sponsorCircuitRetryAfterMs(input.mvcAddress),
    });
    return fallbackSelfPaidForSponsorError({
      error: { reason: 'circuit_open' },
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'circuit_open',
      stage: 'address_info',
    });
  }

  let quotaBefore: MvcSponsorAddressInfo;
  try {
    quotaBefore = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch (error) {
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'service_unavailable',
      stage: 'address_info',
    });
  }

  let draft: MvcSponsorDraft;
  let estimatedMinerFee = 0;
  try {
    const utxos = input.fetchUtxos
      ? await input.fetchUtxos(input.mvcAddress)
      : await fetchMvcAddressUtxos(input.mvcAddress);
    draft = await buildMvcFileInscriptionDraft({
      mnemonic: input.mnemonic,
      walletPath: input.walletPath,
      mvcAddress: input.mvcAddress,
      request,
      utxos,
      feeRate: 1,
      deductMinerFeeFromChange: false,
    });
    estimatedMinerFee = estimateDraftMinerFee({
      unsignedTxHex: draft.unsignedTxHex,
      userInputTotal: draft.userInputs.reduce((sum, utxo) => sum + utxo.satoshis, 0),
    });
  } catch (error) {
    if (input.fallbackPolicy === 'strict') {
      return fallbackSelfPaidForSponsorError({
        error,
        selfPaidUpload: input.selfPaidUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: isNoUserUtxoDraftError(error) ? 'no_user_utxo' : 'service_unavailable',
        stage: 'address_info',
        quotaBefore,
      });
    }
    if (!isNoUserUtxoDraftError(error)) {
      attachFeeAssistError({
        error,
        fallbackCode: 'mvc_fee_assist_address_info_failed',
        fallbackReason: 'service_unavailable',
        stage: 'address_info',
        quotaBefore,
      });
    }
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'no_user_utxo',
      stage: 'address_info',
      quotaBefore,
    });
  }

  let challenge: { challengeId: string; message: string; expiresAt?: string; raw: Record<string, unknown> };
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    // Every sponsor failure falls back under the current policy (nothing has
    // been broadcast at this stage, so the fallback is always safe).
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable'),
      stage: 'challenge',
      quotaBefore,
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  // Traffic-account billing (Phase D): undefined keeps the legacy quota path
  // (feature off, no account, unbound bot, or backend 404). ME credits are
  // requested when address/info advertises me.trafficBilling.
  const trafficAccount = await resolveSponsorTrafficAccount({
    botAddress: input.mvcAddress,
    challengeId: challenge.challengeId,
    botMnemonic: input.mnemonic,
    botWalletPath: input.walletPath,
    billing: meBillingOf(quotaBefore)?.trafficBilling ? 'me' : 'bytes',
  });

  // Balance preflight, gated on the billing account the pre will actually use.
  // With a traffic account the upload bills account bytes (or ME credits), so
  // the legacy sponsor quota (availableAmount) is irrelevant — gating on it
  // silently self-paid every traffic-mode upload once a bot's legacy quota ran
  // out (2026-09-07). estimatedMinerFee is computed at feeRate 1, so it doubles
  // as the tx byte-size estimate for the traffic-bytes comparison. The ME cost
  // is priced server-side, so the ME preflight only short-circuits an empty
  // balance and leaves the exact check to pre.
  const draftByteSize = Math.floor(draft.unsignedTxHex.length / 2);
  if (trafficAccount?.billing === 'me') {
    const spendableMilli = meBillingOf(quotaBefore)?.spendableMilli;
    if (spendableMilli !== undefined && spendableMilli <= 0) {
      return fallbackSelfPaidForSponsorError({
        error: { reason: 'insufficient_me' },
        selfPaidUpload: input.selfPaidUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: 'insufficient_me',
        stage: 'address_info',
        quotaBefore,
        billedBy: 'me',
        txSize: draftByteSize,
        advisoryFeeEstimate: estimatedMinerFee,
      });
    }
  } else if (trafficAccount) {
    const trafficBalanceBytes = trafficBalanceBytesOf(quotaBefore);
    if (trafficBalanceBytes !== undefined && estimatedMinerFee > 0 && trafficBalanceBytes < estimatedMinerFee) {
      return fallbackSelfPaidForSponsorError({
        error: { reason: 'insufficient_traffic' },
        selfPaidUpload: input.selfPaidUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: 'insufficient_traffic',
        stage: 'address_info',
        quotaBefore,
        billedBy: 'traffic',
        txSize: draftByteSize,
        advisoryFeeEstimate: estimatedMinerFee,
      });
    }
  } else if (estimatedMinerFee > 0 && quotaBefore.availableAmount < estimatedMinerFee) {
    return fallbackSelfPaidForSponsorError({
      error: { reason: 'insufficient_quota' },
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      billedBy: 'quota',
      txSize: draftByteSize,
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }

  let pre: {
    preparedTxHex: string;
    orderId: string;
    minerFee: number;
    userInputIndexes: number[];
    expiresAt?: string;
    paySource?: SponsorPaySource;
    meAmountMilli?: number;
    raw: Record<string, unknown>;
  };
  try {
    pre = await sponsorClient.preSponsor({
      address: input.mvcAddress,
      txHex: draft.unsignedTxHex,
      challengeId: challenge.challengeId,
      publicKey: challengeSignature.publicKey,
      signature: challengeSignature.signature,
      trafficAccount,
    });
  } catch (error) {
    // pre_rejected now falls back too: the sponsor refused the draft but
    // nothing was broadcast, so the bot's own wallet can still deliver.
    // Broadcast-reconciliation rejections here count toward the breaker.
    if (isSponsorBroadcastFailureError(error)) {
      const { failures, tripped } = recordSponsorBroadcastFailure(input.mvcAddress);
      if (tripped) {
        appendMetaidLog('WARN', 'Sponsor broadcast-failure circuit breaker tripped — going self-paid for the cooldown', {
          mvcAddress: input.mvcAddress,
          context: 'pre',
          failures,
          cooldownMs: SPONSOR_BREAKER_COOLDOWN_MS,
        });
      }
    }
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: normalizeSponsorReason((error as { reason?: unknown })?.reason, 'pre_rejected'),
      stage: 'pre',
      quotaBefore,
      billedBy: trafficAccount?.billing === 'me' ? 'me' : trafficAccount ? 'traffic' : 'quota',
      txSize: Math.floor(draft.unsignedTxHex.length / 2),
      advisoryFeeEstimate: estimatedMinerFee,
    });
  }
  const advisoryFeeEstimate = estimatedMinerFee > 0 ? estimatedMinerFee : pre.minerFee;

  let signedTxHex: string;
  try {
    signedTxHex = (await signMvcPreparedUserInputs({
      mnemonic: input.mnemonic,
      walletPath: input.walletPath,
      mvcAddress: input.mvcAddress,
      preparedTxHex: pre.preparedTxHex,
      userInputs: draft.userInputs,
      userInputIndexes: pre.userInputIndexes,
    })).txHex;
  } catch (error) {
    // Local signing failure: the sponsor never received a signed tx, so the
    // order can never be committed — falling back is double-write-safe.
    appendMetaidLog('WARN', 'Sponsored MVC file upload user-input signing failed — falling back to self-paid', {
      orderId: pre.orderId,
      error: getErrorMessage(error, 'user-input signing failed'),
    });
    return fallbackSelfPaidForSponsorError({
      error,
      selfPaidUpload: input.selfPaidUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'pre_rejected',
      stage: 'commit',
      orderId: pre.orderId,
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  const signedTxHash = new mvc.Transaction(signedTxHex).id;
  const commitMessage = `assist-sponsor-commit:${pre.orderId}:${signedTxHash}`;
  const commitSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: commitMessage,
  });

  let commitRecovered = false;
  let commit: {
    txId: string;
    txSize?: number;
    minerFee?: number;
    paySource?: SponsorPaySource;
    meAmountMilli?: number;
    raw: Record<string, unknown>;
  };
  try {
    commit = await sponsorClient.commitSponsor({
      orderId: pre.orderId,
      signedTxHex,
      publicKey: commitSignature.publicKey,
      signature: commitSignature.signature,
    });
  } catch (error) {
    // The sponsor already holds our signed tx — reconcile the order before
    // any fallback so a broadcast that merely lost its response resolves as
    // success instead of double-writing. Mirrors mvcSponsorCreatePin (the
    // 2026-09-08 outage fix: sponsor-side broadcast failures used to
    // hard-fail every sponsored upload).
    const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
      orderId: pre.orderId,
      client: sponsorClient,
      pollIntervalMs: input.commitReconcilePollIntervalMs,
      maxWaitMs: input.commitReconcileMaxWaitMs,
    });
    if (reconciliation.outcome === 'broadcasted' && reconciliation.txId) {
      appendMetaidLog('WARN', 'Sponsored MVC file upload commit failed its response but the order broadcast — resolving as sponsored success', {
        orderId: pre.orderId,
        txId: reconciliation.txId,
        commitError: getErrorMessage(error, 'commit failed'),
      });
      // The sponsor did deliver — proof-of-recovery closes the breaker.
      recordSponsorSuccess(input.mvcAddress);
      commit = {
        txId: reconciliation.txId,
        txSize: reconciliation.txSize,
        minerFee: reconciliation.minerFee,
        paySource: reconciliation.paySource,
        meAmountMilli: reconciliation.meAmountMilli,
        raw: { commitRecovered: true },
      };
      commitRecovered = true;
    } else {
      if (isSponsorBroadcastFailureError(error)) {
        const { failures, tripped } = recordSponsorBroadcastFailure(input.mvcAddress);
        if (tripped) {
          appendMetaidLog('WARN', 'Sponsor broadcast-failure circuit breaker tripped — going self-paid for the cooldown', {
            mvcAddress: input.mvcAddress,
            context: 'commit',
            failures,
            cooldownMs: SPONSOR_BREAKER_COOLDOWN_MS,
          });
        }
      }
      appendMetaidLog('WARN', 'Sponsored MVC file upload commit failed — falling back to self-paid', {
        mvcAddress: input.mvcAddress,
        orderId: pre.orderId,
        commitOrderOutcome: reconciliation.outcome,
        orderStatus: reconciliation.status,
        orderFailureReason: reconciliation.failureReason,
        commitError: getErrorMessage(error, 'commit failed'),
      });
      return fallbackSelfPaidForSponsorError({
        error,
        selfPaidUpload: input.selfPaidUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: 'commit_failed',
        stage: 'commit',
        orderId: pre.orderId,
        quotaBefore,
        billedBy: trafficAccount?.billing === 'me' ? 'me' : trafficAccount ? 'traffic' : 'quota',
        txSize: Math.floor(draft.unsignedTxHex.length / 2),
        advisoryFeeEstimate,
        commitOrderOutcome: reconciliation.outcome === 'failed' || reconciliation.outcome === 'pending' || reconciliation.outcome === 'unknown'
          ? reconciliation.outcome
          : undefined,
      });
    }
  }

  const sponsoredMinerFee = commit.minerFee ?? pre.minerFee;
  const billedBy = sponsorBilledBy(trafficAccount, commit.paySource ?? pre.paySource);
  const meAmountMilli = billedBy === 'me' ? commit.meAmountMilli ?? pre.meAmountMilli : undefined;
  if (billedBy === 'me') noteMeTrafficBillingLive();
  recordSponsorSuccess(input.mvcAddress);
  // Local spend journal + balance-cache deduction (best-effort, never throws).
  recordLocalTrafficSpend({
    txId: commit.txId,
    botAddress: input.mvcAddress,
    orderId: pre.orderId,
    txSize: commit.txSize,
    sponsoredMinerFee,
    savedFee: sponsoredMinerFee,
    billedBy,
    meAmountMilli,
    kind: request.path,
  });
  let quotaAfter: MvcSponsorAddressInfo | undefined;
  try {
    quotaAfter = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    quotaAfter = undefined;
  }
  const pinId = `${commit.txId}i0`;
  return {
    pinId,
    txids: [commit.txId],
    totalCost: sponsoredMinerFee,
    network: 'mvc',
    fileName: input.fileName,
    bytes: input.bytes,
    contentType: input.contentType,
    globalMetaId: input.globalMetaId,
    feeAssist: {
      attempted: true,
      used: true,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      stage: 'done',
      orderId: pre.orderId,
      commitRecovered: commitRecovered || undefined,
      quotaBefore,
      quotaAfter,
      advisoryFeeEstimate,
      sponsoredMinerFee,
      savedFee: sponsoredMinerFee,
      billedBy,
      meAmountMilli,
    } satisfies MvcSponsorFeeAssistMetadata,
  };
}
