/**
 * Wallet Transfer Service (R2)
 *
 * Native-coin (SPACE/MVC, first phase) transfers from a MetaBot's own wallet,
 * with the two channels the requirement defines:
 *
 * - Channel A (local roster): `to` resolves to a local MetaBot address →
 *   transfer executes immediately, no confirmation, no per-transfer cap
 *   (owner decision 2026-09-03: internal fund scheduling between the
 *   machine's own bots needs no friction).
 * - Channel B (external): any other address → the owner confirms by default
 *   (from/to/amount/estimated fee dialog on the tool path, an explicit
 *   `external_confirmed` flag on the RPC path); the gate can be turned off
 *   in settings.
 *
 * Every attempt — broadcast, refused, failed — lands in the audit ledger
 * (botWalletTransferStore). Insufficient balance fails BEFORE any chain
 * action with a structured have/need error (AC4). Private keys never leave
 * the host: signing/broadcast delegate to the existing executeTransfer()
 * worker path, same boundary as wallet/btc/sign-psbt.
 */

import type { MetabotStore } from '../metabotStore';
import { getMetabotAccountSummary } from './metabotAccountService';
import { getWalletBalanceSnapshot, isBalanceRelatedError } from './walletQueryService';
import { BotWalletTransferStore } from './botWalletTransferStore';
import { executeTransfer, type TransferChain } from './transferService';

const SATOSHI_PER_UNIT = 100_000_000;
/** MVC P2PKH transfer vsize used for the fee estimate (same formula as buildTransferPreview). */
const MVC_TRANSFER_ESTIMATED_VSIZE = 200;
/** MVC dust limit for a transfer output. */
const MIN_MVC_TRANSFER_SATS = 600;
/** Settings kv key: external-transfer confirmation gate (default ON). */
export const WALLET_EXTERNAL_CONFIRM_SETTING_KEY = 'wallet_transfer_external_confirm_enabled';

export type WalletTransferChannel = 'local' | 'external';

export interface ExternalTransferInfo {
  metabotId: number;
  fromAddress: string;
  toAddress: string;
  amountSats: number;
  estimatedFeeSats: number;
  memo?: string | null;
  /**
   * Token-send context (wallet_token_send): when present the owner dialog
   * renders the token line (amount in display units + symbol + genesis)
   * instead of the SPACE sats line; `amountSats` then holds token base
   * units, not SPACE sats. Optional so native-coin callers stay unchanged.
   */
  token?: { symbol: string; amount: string; genesis: string } | null;
}

export type WalletTransferDeps = {
  metabotStore: MetabotStore;
  transferStore: Pick<BotWalletTransferStore, 'record'>;
  /** Host confirmation dialog for channel B (tool path). Absent on the RPC path. */
  confirmExternal?: (info: ExternalTransferInfo) => Promise<boolean>;
  /** kv settings reader (SqliteStore.get); default gate ON when absent. */
  settingsReader?: { get<T = unknown>(key: string): T | undefined } | null;
  /** Fee-rate resolver; defaults mirror the RPC endpoint's global rate. */
  getFeeRate?: () => number;
  /** Injectable for tests; production path is the shared executeTransfer worker. */
  executeTransferImpl?: typeof executeTransfer;
  /** Injectable balance snapshot for tests. */
  getBalanceSnapshotImpl?: typeof getWalletBalanceSnapshot;
};

export interface WalletMvcTransferParams {
  metabotId: number;
  to: string;
  amountSats: number;
  memo?: string;
  sessionId?: string | null;
  origin?: string | null;
  /** RPC path only: explicit owner acknowledgement for an external transfer. */
  externalConfirmed?: boolean;
  feeRate?: number;
}

export type WalletTransferResult =
  | {
      success: true;
      txid: string;
      fee_sats: number;
      channel: WalletTransferChannel;
      to_metabot_id: number | null;
      audit_id: number;
    }
  | {
      success: false;
      error: string;
      error_code:
        | 'insufficient_balance'
        | 'external_transfer_confirmation_required'
        | 'external_transfer_declined'
        | 'invalid_params'
        | 'transfer_failed';
      have_sats?: number;
      need_sats?: number;
      channel?: WalletTransferChannel;
      audit_id?: number;
    };

export function isExternalTransferConfirmEnabled(
  reader: WalletTransferDeps['settingsReader'],
): boolean {
  if (!reader) return true;
  try {
    const value = reader.get<boolean>(WALLET_EXTERNAL_CONFIRM_SETTING_KEY);
    return value === undefined ? true : value !== false;
  } catch {
    return true;
  }
}

/** Resolve a target address against the local MetaBot roster (mvc addresses). */
export function resolveLocalTransferTarget(
  metabotStore: MetabotStore,
  toAddress: string,
): { metabotId: number; address: string } | null {
  const normalized = String(toAddress || '').trim();
  if (!normalized) return null;
  for (const metabot of metabotStore.listMetabots()) {
    if (String(metabot.mvc_address || '').trim() === normalized) {
      return { metabotId: metabot.id, address: normalized };
    }
  }
  return null;
}

function estimateMvcTransferFeeSats(feeRate: number): number {
  return Math.ceil(MVC_TRANSFER_ESTIMATED_VSIZE * feeRate);
}

function formatInsufficientBalance(
  haveSats: number,
  needSats: number,
  fromAddress: string,
): string {
  return (
    `insufficient balance: have ${haveSats} sats (${(haveSats / SATOSHI_PER_UNIT).toFixed(8)} SPACE), ` +
    `need ${needSats} sats (${(needSats / SATOSHI_PER_UNIT).toFixed(8)} SPACE, amount + estimated fee) ` +
    `at ${fromAddress}`
  );
}

/**
 * Execute one MVC/SPACE transfer per the two-channel policy. Never leaves a
 * half-finished state: either a broadcast txid, or a structured failure with
 * zero chain side effects.
 */
export async function executeWalletMvcTransfer(
  deps: WalletTransferDeps,
  params: WalletMvcTransferParams,
): Promise<WalletTransferResult> {
  const metabotId = Number(params.metabotId);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    return { success: false, error: 'metabot_id is required', error_code: 'invalid_params' };
  }
  const toAddress = String(params.to || '').trim();
  if (!toAddress) {
    return { success: false, error: 'to is required', error_code: 'invalid_params' };
  }
  const amountSats = Number(params.amountSats);
  if (!Number.isInteger(amountSats) || amountSats < MIN_MVC_TRANSFER_SATS) {
    return {
      success: false,
      error: `amount_sats must be an integer >= ${MIN_MVC_TRANSFER_SATS} (MVC dust limit)`,
      error_code: 'invalid_params',
    };
  }

  let summary: ReturnType<typeof getMetabotAccountSummary>;
  try {
    summary = getMetabotAccountSummary(deps.metabotStore, metabotId);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      error_code: 'invalid_params',
    };
  }
  const fromAddress = String(summary.mvc_address || '').trim();

  const localTarget = resolveLocalTransferTarget(deps.metabotStore, toAddress);
  // Self-transfer is a local channel by definition (own address is in roster).
  const channel: WalletTransferChannel = localTarget ? 'local' : 'external';
  const feeRate = Number.isFinite(Number(params.feeRate)) && Number(params.feeRate) > 0
    ? Number(params.feeRate)
    : deps.getFeeRate
      ? deps.getFeeRate()
      : 1;
  const estimatedFeeSats = estimateMvcTransferFeeSats(feeRate);
  const needSats = amountSats + estimatedFeeSats;
  const occurredAtMs = Date.now();

  const audit = (status: 'refused' | 'failed', error: string, txid: string | null = null): number =>
    deps.transferStore.record({
      metabotId,
      fromAddress,
      toAddress,
      toMetabotId: localTarget?.metabotId ?? null,
      chain: 'mvc',
      amountSats,
      feeSats: null,
      txid,
      memo: params.memo ?? null,
      channel,
      status,
      error,
      sessionId: params.sessionId ?? null,
      origin: params.origin ?? null,
      occurredAtMs,
    }).id;

  // Channel B: owner gate (default ON, settings can disable).
  if (channel === 'external' && isExternalTransferConfirmEnabled(deps.settingsReader)) {
    if (deps.confirmExternal) {
      const approved = await deps.confirmExternal({
        metabotId,
        fromAddress,
        toAddress,
        amountSats,
        estimatedFeeSats: estimatedFeeSats,
        memo: params.memo ?? null,
      });
      if (!approved) {
        const error = `external transfer declined by owner (to ${toAddress}, ${amountSats} sats)`;
        return {
          success: false,
          error,
          error_code: 'external_transfer_declined',
          channel,
          audit_id: audit('refused', error),
        };
      }
    } else if (params.externalConfirmed !== true) {
      const error =
        `external transfer requires owner confirmation (to ${toAddress}, ${amountSats} sats); ` +
        `re-send with external_confirmed=true after the owner approves, or disable the gate in settings`;
      return {
        success: false,
        error,
        error_code: 'external_transfer_confirmation_required',
        channel,
        audit_id: audit('refused', error),
      };
    }
  }

  // Balance pre-check: fail BEFORE signing/broadcast (AC4 — no half-done state).
  const getSnapshot = deps.getBalanceSnapshotImpl ?? getWalletBalanceSnapshot;
  let haveSats: number | null = null;
  try {
    const snapshot = await getSnapshot('mvc', fromAddress);
    haveSats = snapshot.total_sats;
  } catch {
    haveSats = null; // provider hiccup should not block the transfer itself
  }
  if (haveSats != null && haveSats < needSats) {
    const error = formatInsufficientBalance(haveSats, needSats, fromAddress);
    return {
      success: false,
      error,
      error_code: 'insufficient_balance',
      have_sats: haveSats,
      need_sats: needSats,
      channel,
      audit_id: audit('refused', error),
    };
  }

  const runTransfer = deps.executeTransferImpl ?? executeTransfer;
  const amountSpace = (amountSats / SATOSHI_PER_UNIT).toFixed(8);
  let result: Awaited<ReturnType<typeof executeTransfer>>;
  try {
    result = await runTransfer(deps.metabotStore, {
      metabotId,
      chain: 'mvc' as TransferChain,
      toAddress,
      amountSpaceOrDoge: amountSpace,
      feeRate,
    });
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : String(error);
    const message = isBalanceRelatedError(rawMessage) && haveSats != null
      ? formatInsufficientBalance(haveSats, needSats, fromAddress)
      : rawMessage;
    const balanceRelated = isBalanceRelatedError(rawMessage) || isBalanceRelatedError(message);
    return {
      success: false,
      error: message,
      error_code: balanceRelated ? 'insufficient_balance' : 'transfer_failed',
      ...(haveSats != null ? { have_sats: haveSats } : {}),
      need_sats: needSats,
      channel,
      audit_id: audit('failed', message),
    };
  }

  if (!result.success || !result.txId) {
    const rawMessage = result.error || 'transfer failed';
    const message = isBalanceRelatedError(rawMessage) && haveSats != null
      ? formatInsufficientBalance(haveSats, needSats, fromAddress)
      : rawMessage;
    const balanceRelated = isBalanceRelatedError(rawMessage);
    return {
      success: false,
      error: message,
      error_code: balanceRelated ? 'insufficient_balance' : 'transfer_failed',
      ...(haveSats != null ? { have_sats: haveSats } : {}),
      need_sats: needSats,
      channel,
      audit_id: audit('failed', message),
    };
  }

  const record = deps.transferStore.record({
    metabotId,
    fromAddress,
    toAddress,
    toMetabotId: localTarget?.metabotId ?? null,
    chain: 'mvc',
    amountSats,
    feeSats: estimatedFeeSats,
    txid: result.txId,
    memo: params.memo ?? null,
    channel,
    status: 'broadcast',
    error: null,
    sessionId: params.sessionId ?? null,
    origin: params.origin ?? null,
    occurredAtMs,
  });

  return {
    success: true,
    txid: result.txId,
    fee_sats: estimatedFeeSats,
    channel,
    to_metabot_id: localTarget?.metabotId ?? null,
    audit_id: record.id,
  };
}
