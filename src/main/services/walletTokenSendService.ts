/**
 * Wallet Token Send Service (Phase 1 / T1)
 *
 * Partial-amount MVC20 (MVC-FT) transfers from a MetaBot's own wallet — the
 * agent-side counterpart of the wallet UI's token transfer. The UI path
 * (metabotTokenTransferService.executeTokenTransfer → mvcFtService
 * .executeMvcFtTransfer → meta-contract FtManager.transfer) already supports
 * arbitrary amounts with token change; this service exposes that path to the
 * agent tools WITH the same two-channel gate parity as wallet_transfer:
 *
 * - Channel A (local roster): the target resolves to a local MetaBot address
 *   → executes immediately, no confirmation.
 * - Channel B (external address): the owner confirms by default; the dialog
 *   info carries the token context (symbol/amount/genesis) via
 *   `ExternalTransferInfo.token`; the gate can be disabled in settings, and
 *   headless surfaces pass `external_confirmed`.
 *
 * Every attempt — broadcast, refused, failed — lands in the same audit
 * ledger (botWalletTransferStore). The ledger has no token column; the memo
 * carries a `mvc20 <SYMBOL> <amount>` descriptor so token rows are
 * distinguishable from SPACE rows (amount_sats holds TOKEN BASE UNITS for
 * token rows, not SPACE sats).
 *
 * Token identity and balance come from the shared balance-list source
 * (listMvcFtAssets — the same source wallet_token_balance and the wallet UI
 * report), so the tool cannot send a token the wallet does not hold.
 */

import Decimal from 'decimal.js';
import type { MetabotStore } from '../metabotStore';
import { getMetabotAccountSummary } from './metabotAccountService';
import { BotWalletTransferStore } from './botWalletTransferStore';
import { listMvcFtAssets, type MvcFtAsset } from './mvcFtService';
import { executeTokenTransfer } from './metabotTokenTransferService';
import {
  isExternalTransferConfirmEnabled,
  resolveLocalTransferTarget,
  type ExternalTransferInfo,
  type WalletTransferChannel,
} from './walletTransferService';

/** MVC-FT transfer vsize used for the SPACE fee estimate (matches buildTokenTransferPreview). */
const MVC_FT_ESTIMATED_VBYTES = 250;

/** Token genesis: 40-hex contract genesis or the 64-hex genesis txid. */
const TOKEN_GENESIS_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface WalletTokenSendParams {
  metabotId: number;
  genesis: string;
  codehash?: string;
  to: string;
  /** Amount in token DISPLAY units (decimal-aware), e.g. "0.1". */
  amount: string;
  memo?: string;
  sessionId?: string | null;
  origin?: string | null;
  /** RPC path only: explicit owner acknowledgement for an external transfer. */
  externalConfirmed?: boolean;
  feeRate?: number;
}

export interface WalletTokenSendDeps {
  metabotStore: MetabotStore;
  transferStore: Pick<BotWalletTransferStore, 'record'>;
  /** Host confirmation dialog for channel B (tool path). Absent on the RPC path. */
  confirmExternal?: (info: ExternalTransferInfo) => Promise<boolean>;
  /** kv settings reader (SqliteStore.get); default gate ON when absent. */
  settingsReader?: { get<T = unknown>(key: string): T | undefined } | null;
  /** Fee-rate resolver; defaults mirror the RPC endpoint's global rate. */
  getFeeRate?: () => number;
  /** Injectable asset-list source for tests; production reads the balance list. */
  listAssetsImpl?: typeof listMvcFtAssets;
  /** Injectable for tests; production path is metabotTokenTransferService. */
  executeTokenTransferImpl?: typeof executeTokenTransfer;
}

export type WalletTokenSendResult =
  | {
      success: true;
      txid: string;
      token_symbol: string;
      token_genesis: string;
      /** Amount echoed in display units (normalized to the token decimal). */
      amount: string;
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
        | 'token_not_found'
        | 'transfer_failed';
      have?: string;
      need?: string;
      token_symbol?: string;
      channel?: WalletTransferChannel;
      audit_id?: number;
    };

const invalid = (error: string): WalletTokenSendResult => ({
  success: false,
  error,
  error_code: 'invalid_params',
});

interface LedgerOutcome {
  status: 'refused' | 'failed' | 'broadcast';
  error: string | null;
  txid?: string | null;
}

/**
 * Execute one MVC20 token transfer with gate parity to wallet_transfer.
 * Never leaves a half-finished state: either a broadcast txid, or a
 * structured failure with zero chain side effects.
 */
export async function executeWalletTokenSend(
  deps: WalletTokenSendDeps,
  params: WalletTokenSendParams,
): Promise<WalletTokenSendResult> {
  const metabotId = Number(params.metabotId);
  if (!Number.isInteger(metabotId) || metabotId <= 0) {
    return invalid('metabot_id is required');
  }
  const genesis = String(params.genesis || '').trim().toLowerCase();
  if (!TOKEN_GENESIS_RE.test(genesis)) {
    return invalid('genesis must be the token genesis: 40-hex contract genesis or 64-hex genesis txid');
  }
  const codehash = String(params.codehash || '').trim().toLowerCase() || undefined;
  const toAddress = String(params.to || '').trim();
  if (!toAddress) {
    return invalid('to is required (MVC address; resolve a local bot via wallet_metabots/wallet_balance)');
  }
  const rawAmount = String(params.amount ?? '').trim();
  if (!rawAmount) {
    return invalid('amount is required (token display units, e.g. "0.1")');
  }
  const parsedAmount = new Decimal(rawAmount);
  if (!parsedAmount.isFinite() || parsedAmount.lte(0)) {
    return invalid('amount must be a positive number in token display units');
  }

  let summary: ReturnType<typeof getMetabotAccountSummary>;
  try {
    summary = getMetabotAccountSummary(deps.metabotStore, metabotId);
  } catch (error) {
    return invalid(error instanceof Error ? error.message : String(error));
  }
  const fromAddress = String(summary.mvc_address || '').trim();

  // Token identity + balance from the shared balance-list source. Decimal
  // metadata is REQUIRED to normalize the amount, so a lookup failure aborts
  // before any chain action (unlike the native-coin pre-check, which is only
  // advisory).
  const listAssets = deps.listAssetsImpl ?? listMvcFtAssets;
  let assets: MvcFtAsset[];
  try {
    assets = await listAssets(fromAddress);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `token asset lookup failed for ${fromAddress}: ${message}`,
      error_code: 'transfer_failed',
    };
  }
  const candidates = assets.filter(
    (asset) =>
      String(asset.genesis || '').toLowerCase() === genesis &&
      (!codehash || String(asset.codeHash || '').toLowerCase() === codehash),
  );
  if (candidates.length === 0) {
    return {
      success: false,
      error:
        `token genesis ${genesis} not found in ${fromAddress}'s wallet ` +
        `(check wallet_token_balance; forked tokens sharing a genesis need an explicit codehash)`,
      error_code: 'token_not_found',
    };
  }
  if (candidates.length > 1) {
    const list = candidates.map((asset) => asset.codeHash).join(', ');
    return invalid(`multiple tokens share genesis ${genesis} (${list}); pass codehash to disambiguate`);
  }
  const asset = candidates[0];

  // Channel/fee context up front so EVERY audited outcome (refusal included)
  // carries the same attribution as wallet_transfer rows.
  const localTarget = resolveLocalTransferTarget(deps.metabotStore, toAddress);
  const channel: WalletTransferChannel = localTarget ? 'local' : 'external';
  const feeRate = Number.isFinite(Number(params.feeRate)) && Number(params.feeRate) > 0
    ? Number(params.feeRate)
    : deps.getFeeRate
      ? deps.getFeeRate()
      : 1;
  const estimatedFeeSats = Math.ceil(MVC_FT_ESTIMATED_VBYTES * feeRate);
  const occurredAtMs = Date.now();

  const amount = parsedAmount.toFixed(asset.decimal);
  const baseUnits = parsedAmount.mul(new Decimal(10).pow(asset.decimal)).toDecimalPlaces(0).toString();
  const baseUnitsNumber = Number(baseUnits);

  const audit = (outcome: LedgerOutcome): number =>
    deps.transferStore.record({
      metabotId,
      fromAddress,
      toAddress,
      toMetabotId: localTarget?.metabotId ?? null,
      chain: 'mvc',
      amountSats: Math.max(0, Math.floor(baseUnitsNumber)),
      feeSats: null,
      txid: outcome.txid ?? null,
      memo: params.memo
        ? `mvc20 ${asset.symbol || 'TOKEN'} ${amount} | ${params.memo}`
        : `mvc20 ${asset.symbol || 'TOKEN'} ${amount}`,
      channel,
      status: outcome.status,
      error: outcome.error,
      sessionId: params.sessionId ?? null,
      origin: params.origin ?? null,
      occurredAtMs,
    }).id;

  const have = asset.balance.display;
  if (parsedAmount.gt(new Decimal(have))) {
    const error =
      `insufficient ${asset.symbol || 'token'} balance: have ${have}, need ${amount} ` +
      `(token display units, at ${fromAddress})`;
    return {
      success: false,
      error,
      error_code: 'insufficient_balance',
      have,
      need: amount,
      token_symbol: asset.symbol,
      channel,
      audit_id: audit({ status: 'refused', error }),
    };
  }

  // Channel B: owner gate (default ON, settings can disable). Same policy as
  // wallet_transfer — dialog precedence over the explicit flag.
  if (channel === 'external' && isExternalTransferConfirmEnabled(deps.settingsReader)) {
    if (deps.confirmExternal) {
      const approved = await deps.confirmExternal({
        metabotId,
        fromAddress,
        toAddress,
        amountSats: baseUnitsNumber,
        estimatedFeeSats,
        memo: params.memo ?? null,
        token: { symbol: asset.symbol, amount, genesis: asset.genesis },
      });
      if (!approved) {
        const error = `external token transfer declined by owner (to ${toAddress}, ${amount} ${asset.symbol})`;
        return {
          success: false,
          error,
          error_code: 'external_transfer_declined',
          channel,
          audit_id: audit({ status: 'refused', error }),
        };
      }
    } else if (params.externalConfirmed !== true) {
      const error =
        `external token transfer requires owner confirmation (to ${toAddress}, ${amount} ${asset.symbol}); ` +
        `re-send with external_confirmed=true after the owner approves, or disable the gate in settings`;
      return {
        success: false,
        error,
        error_code: 'external_transfer_confirmation_required',
        channel,
        audit_id: audit({ status: 'refused', error }),
      };
    }
  }

  const runSend = deps.executeTokenTransferImpl ?? executeTokenTransfer;
  let result: Awaited<ReturnType<typeof executeTokenTransfer>>;
  try {
    result = await runSend(deps.metabotStore, {
      kind: 'mvc-ft',
      metabotId,
      asset,
      toAddress,
      amount,
      feeRate,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: message,
      error_code: 'transfer_failed',
      channel,
      audit_id: audit({ status: 'failed', error: message }),
    };
  }

  return {
    success: true,
    txid: result.txId,
    token_symbol: asset.symbol,
    token_genesis: asset.genesis,
    amount,
    channel,
    to_metabot_id: localTarget?.metabotId ?? null,
    audit_id: audit({ status: 'broadcast', error: null, txid: result.txId }),
  };
}
