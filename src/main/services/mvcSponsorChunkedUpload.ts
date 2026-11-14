/**
 * Sponsored (traffic/ME-points) MVC chunked file upload orchestration.
 *
 * Flow:
 * 1. Circuit breaker + address/info preflight (fail fast before uploading 50 MiB).
 * 2. Stream multipart parts to MetaFS storage -> storageKey.
 * 3. Fetch sponsor challenge -> sign with bot key -> resolve trafficAccount
 *    (ME credits when me.trafficBilling is advertised, bytes otherwise).
 * 4. Call ABS POST /v2/assist/gas/mvc/chunked-upload (ABS builds mergeTx/preTxs
 *    from its gas pool, freezes ME/traffic, and invokes MetaFS chunked-upload).
 *    If ABS returns SPONSOR_BROADCAST_PENDING, poll /v2/assist/gas/mvc/order/:id.
 * 5. Any sponsor failure (ME_INSUFFICIENT, ME_DAILY_LIMIT, TRAFFIC_INSUFFICIENT,
 *    service_unavailable, commit_failed) falls back to the bot's own wallet via
 *    selfPaidChunkedUpload (reusing storageKey so the 50 MiB file is not uploaded
 *    twice), unless fallbackPolicy === 'strict' (which throws TrafficInsufficientError).
 */

import {
  createMvcSponsorV2Client,
  getErrorMessage,
  isMvcInsufficientSelfPayError,
  meBillingOf,
  reconcileSponsorOrderAfterCommitFailure,
  signMvcAddressMessage,
  trafficBalanceBytesOf,
  type MvcSponsorAddressInfo,
  type MvcSponsorTrafficAccount,
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
import type {
  MvcSponsorFeeAssistMetadata,
  MvcSponsorFeeAssistReason,
  MvcSponsorFeeAssistStage,
} from './mvcSponsorUpload';
import { uploadFileToMetaFsMultipart } from './metaFsMultipartUpload';
import type { TrafficFallbackPolicy } from './trafficSettings';

const DEFAULT_CHUNKED_RECONCILE_POLL_INTERVAL_MS = 2_000;
const DEFAULT_CHUNKED_RECONCILE_MAX_WAIT_MS = 180_000;

export interface MvcSponsorChunkedUploadInput {
  filePath?: string;
  data?: Buffer;
  fileName: string;
  uploadPath: string;
  contentType: string;
  bytes: number;
  feeRate: number;
  maxSizeBytes?: number;
  uploaderBaseUrl?: string;
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  metaId: string;
  /** Performs the self-paid chunked fallback, reusing storageKey when already uploaded. */
  selfPaidChunkedUpload: (
    feeAssist: MvcSponsorFeeAssistMetadata,
    storageKey?: string,
  ) => Promise<Record<string, unknown>>;
  fallbackPolicy?: TrafficFallbackPolicy;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Optional override for tests. */
  trafficAccount?: MvcSponsorTrafficAccount;
  /** Optional override for tests. */
  resolveTrafficAccount?: (ctx: {
    challengeId: string;
    billing: 'me' | 'bytes';
  }) => Promise<MvcSponsorTrafficAccount | undefined>;
  /** Optional override for tests. */
  uploadMultipart?: typeof uploadFileToMetaFsMultipart;
  commitReconcilePollIntervalMs?: number;
  commitReconcileMaxWaitMs?: number;
}

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

function extractOrderIdFromError(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | undefined)?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const direct = typeof record.orderId === 'string' ? record.orderId.trim() : '';
  if (direct) return direct;
  if (record.order && typeof record.order === 'object' && !Array.isArray(record.order)) {
    const nested = (record.order as Record<string, unknown>).orderId;
    if (typeof nested === 'string' && nested.trim()) return nested.trim();
  }
  return undefined;
}

function isPendingBroadcastError(error: unknown): boolean {
  const errObj = error as { serviceErrorCode?: unknown; data?: { errorCode?: unknown } } | undefined;
  const code = String(errObj?.serviceErrorCode || errObj?.data?.errorCode || '').trim().toUpperCase();
  return code === 'SPONSOR_BROADCAST_PENDING';
}

async function fallbackSelfPaidChunked(input: {
  error: unknown;
  selfPaidChunkedUpload: MvcSponsorChunkedUploadInput['selfPaidChunkedUpload'];
  storageKey?: string;
  fallbackPolicy?: TrafficFallbackPolicy;
  fallbackReason: MvcSponsorFeeAssistReason;
  stage: MvcSponsorFeeAssistStage;
  orderId?: string;
  quotaBefore?: MvcSponsorAddressInfo;
  billedBy?: TrafficSpendBilledBy;
  txSize?: number;
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
      ...diagnosticFields,
    };
    appendMetaidLog('WARN', 'Sponsored MVC chunked upload failed under strict policy — self-paid fallback blocked', {
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

  appendMetaidLog('WARN', 'Sponsored MVC chunked upload falling back to self-paid', {
    reason,
    stage: input.stage,
    orderId: input.orderId,
    commitOrderOutcome: input.commitOrderOutcome,
    reusingStorageKey: Boolean(input.storageKey),
  });

  const feeAssist: MvcSponsorFeeAssistMetadata = {
    attempted: true,
    used: false,
    mode: 'self_paid',
    sponsor: 'mvc_sponsor_v2',
    reason,
    stage: input.stage,
    orderId: input.orderId,
    commitOrderOutcome: input.commitOrderOutcome,
    quotaBefore: input.quotaBefore,
    ...diagnosticFields,
  };

  try {
    return await input.selfPaidChunkedUpload(feeAssist, input.storageKey);
  } catch (error) {
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
    failedError.message = `Sponsored MVC chunked upload fell back to self-paid (sponsor ${reason} at ${input.stage}) but the self-paid upload failed: ${rawMessage}`;
    const existingData = failedError.data && typeof failedError.data === 'object' ? failedError.data : {};
    failedError.data = {
      ...existingData,
      feeAssist: {
        ...feeAssist,
        selfPaidError: rawMessage,
      } satisfies MvcSponsorFeeAssistMetadata,
    };
    throw failedError;
  }
}

export async function uploadMvcSponsorChunkedFile(
  input: MvcSponsorChunkedUploadInput,
): Promise<Record<string, unknown>> {
  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  if (isSponsorCircuitOpen(input.mvcAddress)) {
    appendMetaidLog('WARN', 'Sponsored MVC chunked upload skipped — sponsor circuit breaker open, going self-paid', {
      mvcAddress: input.mvcAddress,
      recentFailures: sponsorCircuitRecentFailures(input.mvcAddress),
      retryAfterMs: sponsorCircuitRetryAfterMs(input.mvcAddress),
    });
    return fallbackSelfPaidChunked({
      error: { reason: 'circuit_open' },
      selfPaidChunkedUpload: input.selfPaidChunkedUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'circuit_open',
      stage: 'address_info',
      txSize: input.bytes,
    });
  }

  let quotaBefore: MvcSponsorAddressInfo;
  try {
    quotaBefore = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch (error) {
    return fallbackSelfPaidChunked({
      error,
      selfPaidChunkedUpload: input.selfPaidChunkedUpload,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'service_unavailable',
      stage: 'address_info',
      txSize: input.bytes,
    });
  }

  // Preflight balance BEFORE uploading 5-50 MiB to MetaFS multipart storage.
  const meCapability = meBillingOf(quotaBefore);
  if (meCapability?.trafficBilling) {
    if (meCapability.spendableMilli !== undefined && meCapability.spendableMilli <= 0) {
      return fallbackSelfPaidChunked({
        error: { reason: 'insufficient_me', serviceMessage: 'ME spendable balance is 0' },
        selfPaidChunkedUpload: input.selfPaidChunkedUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: 'insufficient_me',
        stage: 'address_info',
        quotaBefore,
        billedBy: 'me',
        txSize: input.bytes,
      });
    }
  } else {
    const trafficBalanceBytes = trafficBalanceBytesOf(quotaBefore);
    if (trafficBalanceBytes !== undefined && trafficBalanceBytes < input.bytes) {
      return fallbackSelfPaidChunked({
        error: { reason: 'insufficient_traffic', serviceMessage: 'Traffic byte balance insufficient for chunked upload' },
        selfPaidChunkedUpload: input.selfPaidChunkedUpload,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: 'insufficient_traffic',
        stage: 'address_info',
        quotaBefore,
        billedBy: 'traffic',
        txSize: input.bytes,
      });
    }
  }

  const uploadMultipart = input.uploadMultipart ?? uploadFileToMetaFsMultipart;
  const multipartResult = await uploadMultipart({
    filePath: input.filePath,
    data: input.data,
    fileName: input.fileName,
    size: input.bytes,
    metaId: input.metaId,
    address: input.mvcAddress,
    maxSizeBytes: input.maxSizeBytes,
    uploaderBaseUrl: input.uploaderBaseUrl,
    fetchImpl: input.fetchImpl,
  });
  const storageKey = multipartResult.storageKey;

  let challenge: { challengeId: string; message: string; expiresAt?: string; raw: Record<string, unknown> };
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    return fallbackSelfPaidChunked({
      error,
      selfPaidChunkedUpload: input.selfPaidChunkedUpload,
      storageKey,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable'),
      stage: 'challenge',
      quotaBefore,
      txSize: input.bytes,
    });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  const requestedBilling = meCapability?.trafficBilling ? 'me' : 'bytes';
  const trafficAccount = input.trafficAccount
    ?? (input.resolveTrafficAccount
      ? await input.resolveTrafficAccount({ challengeId: challenge.challengeId, billing: requestedBilling })
      : await resolveSponsorTrafficAccount({
        botAddress: input.mvcAddress,
        challengeId: challenge.challengeId,
        botMnemonic: input.mnemonic,
        botWalletPath: input.walletPath,
        billing: requestedBilling,
      }));

  if (!trafficAccount && quotaBefore.availableAmount <= 0) {
    return fallbackSelfPaidChunked({
      error: { reason: 'insufficient_quota', serviceMessage: 'Sponsor quota insufficient for chunked upload' },
      selfPaidChunkedUpload: input.selfPaidChunkedUpload,
      storageKey,
      fallbackPolicy: input.fallbackPolicy,
      fallbackReason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      billedBy: 'quota',
      txSize: input.bytes,
    });
  }

  const billedByHint: TrafficSpendBilledBy = trafficAccount?.billing === 'me'
    ? 'me'
    : trafficAccount
      ? 'traffic'
      : 'quota';

  let commitOrderId = '';
  let commitTxId = '';
  let commitTxSize: number | undefined;
  let commitMinerFee: number | undefined;
  let commitPaySource: SponsorPaySource | undefined;
  let commitMeAmountMilli: number | undefined;
  let commitChunkTxIds: string[] = [];
  let commitRecovered = false;

  try {
    const res = await sponsorClient.chunkedUploadSponsor({
      address: input.mvcAddress,
      metaId: input.metaId,
      fileName: input.fileName,
      path: input.uploadPath,
      contentType: input.contentType,
      operation: 'create',
      storageKey,
      fileSize: input.bytes,
      feeRate: input.feeRate,
      challengeId: challenge.challengeId,
      publicKey: challengeSignature.publicKey,
      signature: challengeSignature.signature,
      trafficAccount,
    });
    commitOrderId = res.orderId;
    commitTxId = res.txId;
    commitTxSize = res.txSize;
    commitMinerFee = res.minerFee;
    commitPaySource = res.paySource;
    commitMeAmountMilli = res.meAmountMilli;
    commitChunkTxIds = res.chunkTxIds ?? [];
  } catch (error) {
    const orderId = extractOrderIdFromError(error);
    if (orderId && (isPendingBroadcastError(error) || (error as { retryable?: unknown })?.retryable === true)) {
      const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
        orderId,
        client: sponsorClient,
        pollIntervalMs: input.commitReconcilePollIntervalMs ?? DEFAULT_CHUNKED_RECONCILE_POLL_INTERVAL_MS,
        maxWaitMs: input.commitReconcileMaxWaitMs ?? DEFAULT_CHUNKED_RECONCILE_MAX_WAIT_MS,
      });
      if (reconciliation.outcome === 'broadcasted' && reconciliation.txId) {
        commitOrderId = orderId;
        commitTxId = reconciliation.txId;
        commitTxSize = reconciliation.txSize;
        commitMinerFee = reconciliation.minerFee;
        commitPaySource = reconciliation.paySource;
        commitMeAmountMilli = reconciliation.meAmountMilli;
        commitRecovered = true;
      } else {
        if (isSponsorBroadcastFailureError(error)) {
          const { failures, tripped } = recordSponsorBroadcastFailure(input.mvcAddress);
          if (tripped) {
            appendMetaidLog('WARN', 'Sponsor broadcast-failure circuit breaker tripped (chunked) — going self-paid for the cooldown', {
              mvcAddress: input.mvcAddress,
              context: 'commit',
              failures,
              cooldownMs: SPONSOR_BREAKER_COOLDOWN_MS,
            });
          }
        }
        return fallbackSelfPaidChunked({
          error: reconciliation.failureReason ? new Error(reconciliation.failureReason) : error,
          selfPaidChunkedUpload: input.selfPaidChunkedUpload,
          storageKey,
          fallbackPolicy: input.fallbackPolicy,
          fallbackReason: 'commit_failed',
          stage: 'commit',
          orderId,
          quotaBefore,
          billedBy: billedByHint,
          txSize: input.bytes,
          commitOrderOutcome: reconciliation.outcome === 'failed' || reconciliation.outcome === 'pending' || reconciliation.outcome === 'unknown'
            ? reconciliation.outcome
            : undefined,
        });
      }
    } else {
      if (isSponsorBroadcastFailureError(error)) {
        const { failures, tripped } = recordSponsorBroadcastFailure(input.mvcAddress);
        if (tripped) {
          appendMetaidLog('WARN', 'Sponsor broadcast-failure circuit breaker tripped (chunked) — going self-paid for the cooldown', {
            mvcAddress: input.mvcAddress,
            context: 'commit',
            failures,
            cooldownMs: SPONSOR_BREAKER_COOLDOWN_MS,
          });
        }
      }
      return fallbackSelfPaidChunked({
        error,
        selfPaidChunkedUpload: input.selfPaidChunkedUpload,
        storageKey,
        fallbackPolicy: input.fallbackPolicy,
        fallbackReason: normalizeSponsorReason((error as { reason?: unknown })?.reason, 'commit_failed'),
        stage: 'commit',
        orderId,
        quotaBefore,
        billedBy: billedByHint,
        txSize: input.bytes,
      });
    }
  }

  const sponsoredMinerFee = commitMinerFee ?? 0;
  const billedBy = sponsorBilledBy(trafficAccount, commitPaySource);
  const meAmountMilli = billedBy === 'me' ? commitMeAmountMilli : undefined;
  if (billedBy === 'me') noteMeTrafficBillingLive();
  recordSponsorSuccess(input.mvcAddress);

  recordLocalTrafficSpend({
    txId: commitTxId,
    botAddress: input.mvcAddress,
    orderId: commitOrderId,
    txSize: commitTxSize ?? input.bytes,
    sponsoredMinerFee,
    savedFee: sponsoredMinerFee,
    billedBy,
    meAmountMilli,
    kind: '/file/index',
  });

  let quotaAfter: MvcSponsorAddressInfo | undefined;
  try {
    quotaAfter = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    quotaAfter = undefined;
  }

  const pinId = `${commitTxId}i0`;
  return {
    pinId,
    txId: commitTxId,
    txids: [commitTxId],
    chunkTxIds: commitChunkTxIds,
    totalCost: sponsoredMinerFee,
    network: 'mvc',
    fileName: input.fileName,
    size: input.bytes,
    bytes: input.bytes,
    contentType: input.contentType,
    uploadMode: 'chunked',
    globalMetaId: input.metaId,
    feeAssist: {
      attempted: true,
      used: true,
      mode: 'mvc_sponsor_v2',
      sponsor: 'mvc_sponsor_v2',
      stage: 'done',
      orderId: commitOrderId,
      commitRecovered: commitRecovered || undefined,
      quotaBefore,
      quotaAfter,
      sponsoredMinerFee,
      savedFee: sponsoredMinerFee,
      billedBy,
      meAmountMilli,
      txSize: commitTxSize ?? input.bytes,
    } satisfies MvcSponsorFeeAssistMetadata,
  };
}
