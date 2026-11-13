/**
 * Sponsored (traffic-mode) MVC createPin orchestration.
 * Runs the generic sponsor v2 protocol (mvcSponsorClient) for any MetaID pin:
 * unsigned worker draft -> quota preflight -> challenge -> pre -> sign user
 * inputs -> commit, then maintains the MVC spend session state exactly like
 * the broadcast path. Fallback semantics for the createPin main path
 * (2026-09-08 owner rule: a sponsor outage or error must never block the
 * write — auto-switch to the bot's own wallet with an explicit trace):
 * ANY sponsor failure — service_unavailable / no_user_utxo /
 * insufficient_quota / insufficient_traffic / insufficient_me /
 * pre_rejected / commit_failed — falls back to the regular self-paid
 * broadcast (fallbackPolicy 'selfpay', tagged with feeAssist metadata) or
 * throws a TrafficInsufficientError ('strict'). Commit-stage failures
 * reconcile the sponsor order first: an
 * order that actually broadcast resolves as sponsored success, a
 * terminal-dead order falls back safely, and an order still reconciling past
 * the bounded wait budget falls back too (WARN log + feeAssist carry the
 * orderId and order outcome; the residual duplicate-ping risk of a late
 * sponsor recovery is accepted and traceable).
 *
 * Billing currency (2026-11-09 requirements v1.0): when address/info
 * advertises me.trafficBilling the traffic-account order is requested in ME
 * credits (insufficient_me when the credits cannot cover it); otherwise it
 * bills traffic bytes as before.
 */

import {
  createMvcSponsorV2Client,
  getErrorMessage,
  getMvcSponsorCommitMessage,
  isMvcInsufficientSelfPayError,
  isNoUserUtxoDraftError,
  meBillingOf,
  reconcileSponsorOrderAfterCommitFailure,
  signMvcAddressMessage,
  signMvcPreparedUserInputs,
  trafficBalanceBytesOf,
  type MvcSponsorAddressInfo,
  type MvcSponsorTrafficAccount,
  type MvcSponsorV2Client,
  type SponsorBilling,
} from './mvcSponsorClient';
import { appendMetaidLog } from './metaidLog';
import { noteMeTrafficBillingLive, recordLocalTrafficSpend, sponsorBilledBy } from './trafficAccountService';
import {
  isSponsorBroadcastFailureError,
  isSponsorCircuitOpen,
  recordSponsorBroadcastFailure,
  recordSponsorSuccess,
  sponsorCircuitRecentFailures,
  sponsorCircuitRetryAfterMs,
  SPONSOR_BREAKER_COOLDOWN_MS,
} from './mvcSponsorCircuitBreaker';
import type {
  MvcSponsorFeeAssistMetadata,
  MvcSponsorFeeAssistReason,
  MvcSponsorFeeAssistStage,
} from './mvcSponsorUpload';
import type { CreatePinWorkerSuccess } from './metaidCore';
import type { MvcCachedFundingUtxo } from './mvcSpendSessionState';
import type { TrafficFallbackPolicy } from './trafficSettings';

type SponsorChallenge = Awaited<ReturnType<MvcSponsorV2Client['getChallenge']>>;
type SponsorPreResult = Awaited<ReturnType<MvcSponsorV2Client['preSponsor']>>;
type SponsorCommitResult = Awaited<ReturnType<MvcSponsorV2Client['commitSponsor']>>;

/**
 * Reasons that route a sponsored createPin to the self-paid fallback. Every
 * sponsor failure qualifies (2026-09-08 owner rule: sponsor outage or error
 * auto-switches to the bot's own wallet); commit_failed additionally
 * reconciles the order first so an already-broadcast tx never double-writes.
 */
export type MvcSponsorCreatePinFallbackReason = MvcSponsorFeeAssistReason;

/** feeAssist metadata attached to sponsored/fallback createPin results. */
export interface CreatePinFeeAssistMetadata extends MvcSponsorFeeAssistMetadata {
  txSize?: number;
}

export interface MvcSponsorCreatePinResult extends CreatePinWorkerSuccess {
  feeAssist: CreatePinFeeAssistMetadata;
}

export function formatTrafficStrictFailureMessage(input: {
  reason: MvcSponsorCreatePinFallbackReason;
  stage: MvcSponsorFeeAssistStage;
  orderId?: string;
  detail?: string;
}): string {
  const orderPart = input.orderId ? `, order=${input.orderId}` : '';
  const detailPart = input.detail ? `: ${input.detail}` : '';
  return `积分支付失败，请检查积分余额或稍后重试 (reason=${input.reason}, stage=${input.stage}${orderPart})${detailPart}`;
}

export class TrafficInsufficientError extends Error {
  readonly code = 'mvc_traffic_insufficient';
  readonly reason: MvcSponsorCreatePinFallbackReason;
  readonly stage: MvcSponsorFeeAssistStage;
  readonly orderId?: string;
  readonly feeAssist: CreatePinFeeAssistMetadata;
  readonly data: { feeAssist: CreatePinFeeAssistMetadata };

  constructor(input: {
    message?: string;
    reason: MvcSponsorCreatePinFallbackReason;
    stage: MvcSponsorFeeAssistStage;
    orderId?: string;
    feeAssist: CreatePinFeeAssistMetadata;
  }) {
    super(input.message || formatTrafficStrictFailureMessage(input));
    this.name = 'TrafficInsufficientError';
    this.reason = input.reason;
    this.stage = input.stage;
    if (input.orderId !== undefined) this.orderId = input.orderId;
    this.feeAssist = input.feeAssist;
    this.data = { feeAssist: input.feeAssist };
  }
}

export interface MvcSponsorCreatePinInput {
  metabotId: number;
  mnemonic: string;
  walletPath: string;
  mvcAddress: string;
  feeRate: number;
  fallbackPolicy: TrafficFallbackPolicy;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Explicit trafficAccount block (pre-resolved callers / tests); skips resolveTrafficAccount. */
  trafficAccount?: MvcSponsorTrafficAccount;
  /** MetaID pin path (e.g. /protocols/simplemsg), journaled as the spend kind. */
  journalKind?: string;
  /** Order-reconciliation timing after a failed commit (tests override; defaults 5s/30s). */
  commitReconcilePollIntervalMs?: number;
  commitReconcileMaxWaitMs?: number;
}

export interface MvcSponsorCreatePinDeps {
  /** Draft-mode worker run; the caller wraps it with the standard stale-funding session recovery. */
  runDraftWorker: () => Promise<CreatePinWorkerSuccess>;
  /** Regular self-paid broadcast path, used by the 'selfpay' fallback policy. */
  runBroadcastWorker: () => Promise<CreatePinWorkerSuccess>;
  recordSpentOutpoints: (outpoints: string[]) => void;
  replacePendingFundingUtxos: (utxo: MvcCachedFundingUtxo | null) => void;
  /**
   * Optional trafficAccount resolver invoked between challenge and pre
   * (wired to trafficAccountService in production). When it returns
   * undefined — or is not provided — the pre goes out without a
   * trafficAccount and stays on the legacy quota path. billing is the
   * currency the sponsor offers for this address ('me' when address/info
   * advertises me.trafficBilling); the resolver may downgrade it to bytes.
   */
  resolveTrafficAccount?: (ctx: {
    challengeId: string;
    billing: SponsorBilling;
  }) => Promise<MvcSponsorTrafficAccount | undefined>;
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

function isNoUserUtxoDraftFailure(error: unknown): boolean {
  return isMvcInsufficientSelfPayError(error);
}

/** Count one sponsor broadcast failure toward the per-address circuit breaker. */
function noteSponsorBroadcastFailure(metabotId: number, mvcAddress: string, context: string): void {
  if (!mvcAddress) return;
  const { failures, tripped } = recordSponsorBroadcastFailure(mvcAddress);
  if (tripped) {
    appendMetaidLog('WARN', 'Sponsor broadcast-failure circuit breaker tripped — going self-paid for the cooldown', {
      metabotId,
      mvcAddress,
      context,
      failures,
      cooldownMs: SPONSOR_BREAKER_COOLDOWN_MS,
    });
  }
}

export async function runMvcSponsorCreatePin(
  input: MvcSponsorCreatePinInput,
  deps: MvcSponsorCreatePinDeps,
): Promise<MvcSponsorCreatePinResult> {
  const sponsorClient = createMvcSponsorV2Client({ baseUrl: input.baseUrl, fetchImpl: input.fetchImpl });

  const fallbackToSelfPaid = async (params: {
    reason: MvcSponsorCreatePinFallbackReason;
    stage: MvcSponsorFeeAssistStage;
    orderId?: string;
    quotaBefore?: MvcSponsorAddressInfo;
    advisoryFeeEstimate?: number;
    /** Sponsor-order outcome observed while reconciling a failed commit. */
    commitOrderOutcome?: 'failed' | 'pending' | 'unknown';
  }): Promise<MvcSponsorCreatePinResult> => {
    const feeAssist: CreatePinFeeAssistMetadata = {
      attempted: true,
      used: false,
      mode: input.fallbackPolicy === 'strict' ? 'mvc_sponsor_v2' : 'self_paid',
      sponsor: 'mvc_sponsor_v2',
      reason: params.reason,
      stage: params.stage,
      orderId: params.orderId,
      commitOrderOutcome: params.commitOrderOutcome,
      quotaBefore: params.quotaBefore,
      advisoryFeeEstimate: params.advisoryFeeEstimate,
    };
    if (input.fallbackPolicy === 'strict') {
      appendMetaidLog('WARN', 'Sponsored MVC createPin failed under strict policy — self-paid fallback blocked', {
        metabotId: input.metabotId,
        mvcAddress: input.mvcAddress,
        reason: params.reason,
        stage: params.stage,
        orderId: params.orderId,
        commitOrderOutcome: params.commitOrderOutcome,
        fallbackPolicy: input.fallbackPolicy,
      });
      throw new TrafficInsufficientError({
        reason: params.reason,
        stage: params.stage,
        orderId: params.orderId,
        feeAssist,
      });
    }
    // Self-pay spends the bot's own wallet — never let that happen silently
    // (the 2026-09-07 outage: exhausted legacy quota forced every traffic-mode
    // pin to self-pay with no trace of why). The WARN log + feeAssist trace
    // keep every fallback visible; the 2026-09-08 hard-fail regression
    // (SPONSOR_BROADCAST_PENDING blocking all writes) is why commit-stage
    // failures now land here too.
    appendMetaidLog('WARN', 'Sponsored MVC createPin falling back to self-paid', {
      metabotId: input.metabotId,
      mvcAddress: input.mvcAddress,
      reason: params.reason,
      stage: params.stage,
      orderId: params.orderId,
      commitOrderOutcome: params.commitOrderOutcome,
      fallbackPolicy: input.fallbackPolicy,
    });
    try {
      const broadcastResult = await deps.runBroadcastWorker();
      return { ...broadcastResult, feeAssist };
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
      failedError.message = `Sponsored MVC createPin fell back to self-paid (sponsor ${params.reason} at ${params.stage}) but the self-paid broadcast failed: ${rawMessage}`;
      const existingData = failedError.data && typeof failedError.data === 'object' ? failedError.data : {};
      failedError.data = { ...existingData, feeAssist: { ...feeAssist, selfPaidError: rawMessage } };
      throw failedError;
    }
  };

  if (!input.mvcAddress) {
    return fallbackToSelfPaid({ reason: 'service_unavailable', stage: 'address_info' });
  }

  // R3.2 circuit breaker: after repeated sponsor broadcast failures for this
  // address, skip the sponsor entirely for the cooldown and go self-paid —
  // no doomed orders, no reconcile wait. Sponsored successes reset it.
  if (isSponsorCircuitOpen(input.mvcAddress)) {
    appendMetaidLog('WARN', 'Sponsored MVC createPin skipped — sponsor circuit breaker open, going self-paid', {
      metabotId: input.metabotId,
      mvcAddress: input.mvcAddress,
      recentFailures: sponsorCircuitRecentFailures(input.mvcAddress),
      retryAfterMs: sponsorCircuitRetryAfterMs(input.mvcAddress),
    });
    return fallbackToSelfPaid({ reason: 'circuit_open', stage: 'address_info' });
  }

  let quotaBefore: MvcSponsorAddressInfo;
  try {
    quotaBefore = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    return fallbackToSelfPaid({ reason: 'service_unavailable', stage: 'address_info' });
  }

  let draft: NonNullable<CreatePinWorkerSuccess['draft']>;
  let draftSpentOutpoints: string[];
  try {
    const draftResult = await deps.runDraftWorker();
    if (!draftResult.draft || !draftResult.draft.unsignedTxHex) {
      throw new Error('createPin worker did not return an unsigned draft transaction.');
    }
    draft = draftResult.draft;
    draftSpentOutpoints = Array.isArray(draftResult.spentOutpoints)
      ? draftResult.spentOutpoints
      : draft.userInputs.map((utxo) => `${utxo.txId}:${utxo.outputIndex}`);
  } catch (error) {
    return fallbackToSelfPaid({
      reason: isNoUserUtxoDraftFailure(error) ? 'no_user_utxo' : 'service_unavailable',
      stage: 'address_info',
      quotaBefore,
    });
  }

  const advisoryFeeEstimate = Math.ceil(draft.estimatedTxSize * input.feeRate);

  let challenge: SponsorChallenge;
  try {
    challenge = await sponsorClient.getChallenge();
  } catch (error) {
    // Every sponsor failure falls back under the 'selfpay' policy (nothing
    // has been broadcast at this stage, so the fallback is always safe).
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'service_unavailable');
    return fallbackToSelfPaid({ reason, stage: 'challenge', quotaBefore, advisoryFeeEstimate });
  }

  const challengeSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: challenge.message,
  });

  const trafficAccount = input.trafficAccount
    ?? await deps.resolveTrafficAccount?.({
      challengeId: challenge.challengeId,
      billing: meBillingOf(quotaBefore)?.trafficBilling ? 'me' : 'bytes',
    });

  // Balance preflight, gated on the billing account the pre will actually use.
  // With a traffic account the pin bills account bytes (or ME credits), so the
  // legacy sponsor quota (availableAmount) is irrelevant — gating on it
  // silently self-paid every traffic-mode pin once a bot's legacy quota ran
  // out (2026-09-07). ME cost stays server-side (secret rate), so the ME
  // preflight only short-circuits an empty balance; pre is authoritative.
  if (trafficAccount?.billing === 'me') {
    const spendableMilli = meBillingOf(quotaBefore)?.spendableMilli;
    if (spendableMilli !== undefined && spendableMilli <= 0) {
      return fallbackToSelfPaid({
        reason: 'insufficient_me',
        stage: 'address_info',
        quotaBefore,
        advisoryFeeEstimate,
      });
    }
  } else if (trafficAccount) {
    const trafficBalanceBytes = trafficBalanceBytesOf(quotaBefore);
    if (trafficBalanceBytes !== undefined && draft.estimatedTxSize > 0 && trafficBalanceBytes < draft.estimatedTxSize) {
      return fallbackToSelfPaid({
        reason: 'insufficient_traffic',
        stage: 'address_info',
        quotaBefore,
        advisoryFeeEstimate,
      });
    }
  } else if (advisoryFeeEstimate > 0 && quotaBefore.availableAmount < advisoryFeeEstimate) {
    return fallbackToSelfPaid({
      reason: 'insufficient_quota',
      stage: 'address_info',
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  let pre: SponsorPreResult;
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
      noteSponsorBroadcastFailure(input.metabotId, input.mvcAddress, 'pre');
    }
    const reason = normalizeSponsorReason((error as { reason?: unknown })?.reason, 'pre_rejected');
    return fallbackToSelfPaid({ reason, stage: 'pre', quotaBefore, advisoryFeeEstimate });
  }

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
    appendMetaidLog('WARN', 'Sponsored MVC createPin user-input signing failed — falling back to self-paid', {
      metabotId: input.metabotId,
      orderId: pre.orderId,
      error: getErrorMessage(error, 'user-input signing failed'),
    });
    return fallbackToSelfPaid({
      reason: 'pre_rejected',
      stage: 'commit',
      orderId: pre.orderId,
      quotaBefore,
      advisoryFeeEstimate,
    });
  }

  const commitMessage = getMvcSponsorCommitMessage({ orderId: pre.orderId, signedTxHex });
  const commitSignature = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: input.walletPath,
    message: commitMessage,
  });

  let commitRecovered = false;
  let commit: SponsorCommitResult;
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
    // success instead of double-writing. This is the 2026-09-08 outage fix:
    // sponsor-side broadcast failures ([-25]Missing inputs /
    // SPONSOR_BROADCAST_PENDING) used to hard-fail every traffic-mode write.
    const reconciliation = await reconcileSponsorOrderAfterCommitFailure({
      orderId: pre.orderId,
      client: sponsorClient,
      pollIntervalMs: input.commitReconcilePollIntervalMs,
      maxWaitMs: input.commitReconcileMaxWaitMs,
    });
    if (reconciliation.outcome === 'broadcasted' && reconciliation.txId) {
      appendMetaidLog('WARN', 'Sponsored MVC createPin commit failed its response but the order broadcast — resolving as sponsored success', {
        metabotId: input.metabotId,
        orderId: pre.orderId,
        txId: reconciliation.txId,
        commitError: getErrorMessage(error, 'commit failed'),
      });
      // The sponsor did deliver — prove-of-recovery closes the breaker.
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
      // A still-pending order is abandoned deliberately: the self-paid tx
      // draws from the same address, so the two transactions usually conflict
      // and at most one lands; a duplicate is possible only if the sponsor
      // recovers inside the race window, and the trace below pinpoints it.
      if (isSponsorBroadcastFailureError(error)) {
        noteSponsorBroadcastFailure(input.metabotId, input.mvcAddress, 'commit');
      }
      appendMetaidLog('WARN', 'Sponsored MVC createPin commit failed — falling back to self-paid', {
        metabotId: input.metabotId,
        mvcAddress: input.mvcAddress,
        orderId: pre.orderId,
        commitOrderOutcome: reconciliation.outcome,
        orderStatus: reconciliation.status,
        orderFailureReason: reconciliation.failureReason,
        commitError: getErrorMessage(error, 'commit failed'),
        fallbackPolicy: input.fallbackPolicy,
      });
      return fallbackToSelfPaid({
        reason: 'commit_failed',
        stage: 'commit',
        orderId: pre.orderId,
        quotaBefore,
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
  deps.recordSpentOutpoints(draftSpentOutpoints);
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
    kind: input.journalKind,
  });
  const changeUtxo: MvcCachedFundingUtxo | null = draft.changeOutput
    ? {
      txId: commit.txId,
      outputIndex: draft.changeOutput.outputIndex,
      satoshis: draft.changeOutput.satoshis,
      address: input.mvcAddress,
      height: -1,
    }
    : null;
  deps.replacePendingFundingUtxos(changeUtxo);

  let quotaAfter: MvcSponsorAddressInfo | undefined;
  try {
    quotaAfter = await sponsorClient.getAddressInfo({ address: input.mvcAddress });
  } catch {
    quotaAfter = undefined;
  }

  return {
    txids: [commit.txId],
    pinId: `${commit.txId}i0`,
    totalCost: sponsoredMinerFee,
    spentOutpoints: draftSpentOutpoints,
    changeUtxo,
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
      txSize: commit.txSize,
      billedBy,
      meAmountMilli,
    },
  };
}
