/**
 * Order Payment Verification Service.
 * Validates on-chain payments by fetching raw transactions from Metalet API
 * and verifying that the expected recipient receives the correct amount.
 */

import type { MetabotStore } from '../metabotStore';
import {
  verifyTransferToRecipient,
  type TransferChain,
} from './txTransferVerification';

export type OrderSource = 'metaweb_private' | 'metaweb_group';

export interface OrderPaymentCheckResult {
  paid: boolean;
  txid: string | null;
  reason: string;
  chain?: string;
  amountSats?: number;
}

const TXID_RE = /txid\s*[:：=]?\s*([0-9a-fA-F]{64})/i;
const AMOUNT_RE = /支付金额\s*([0-9]+(?:\.[0-9]+)?)\s*(SPACE|BTC|DOGE)/i;
const SKILL_ID_RE = /skill(?:\s+service)?\s+id\s*[:：=]?\s*([^\s,，。]+)/i;
const SKILL_NAME_RE = /(?:skill(?:\s+name)?|技能(?:名称?)?)\s*[:：=]?\s*([\w-]+)/i;
const SATOSHI_PER_UNIT = 100_000_000;

export function extractOrderSkillId(plaintext: string): string | null {
  const match = plaintext.match(SKILL_ID_RE);
  return match ? (match[1] || null) : null;
}

export function extractOrderSkillName(plaintext: string): string | null {
  const match = plaintext.match(SKILL_NAME_RE);
  return match ? (match[1] || null) : null;
}

export function extractOrderTxid(plaintext: string): string | null {
  const match = plaintext.match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

function extractOrderAmount(
  plaintext: string
): { amount: number; currency: string; chain: TransferChain } | null {
  const match = plaintext.match(AMOUNT_RE);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const currency = match[2].toUpperCase();
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const chain: TransferChain =
    currency === 'BTC' ? 'btc' : currency === 'DOGE' ? 'doge' : 'mvc';
  return { amount, currency, chain };
}

function getMetabotAddressForChain(
  metabotStore: MetabotStore,
  metabotId: number,
  chain: TransferChain
): string | null {
  const metabot = metabotStore.getMetabotById(metabotId);
  if (!metabot) return null;
  switch (chain) {
    case 'mvc':
      return metabot.mvc_address || null;
    case 'btc':
      return metabot.btc_address || null;
    case 'doge':
      return metabot.doge_address || null;
    default:
      return null;
  }
}

function debugLog(msg: string): void {
  try {
    process.stderr.write(`[order-payment] ${msg}\n`);
  } catch {
    /* noop */
  }
}

export async function checkOrderPaymentStatus(params: {
  txid: string | null;
  plaintext: string;
  source: OrderSource;
  metabotId: number;
  metabotStore: MetabotStore;
}): Promise<OrderPaymentCheckResult> {
  const { txid, plaintext, metabotId, metabotStore } = params;

  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return { paid: false, txid: txid || null, reason: 'invalid_or_missing_txid' };
  }

  const parsed = extractOrderAmount(plaintext);
  if (!parsed) {
    return { paid: false, txid, reason: 'cannot_parse_amount_or_currency' };
  }

  const { amount, currency, chain } = parsed;
  const expectedSats = Math.floor(amount * SATOSHI_PER_UNIT);
  if (expectedSats <= 0) {
    return { paid: false, txid, reason: 'invalid_amount' };
  }

  const recipientAddress = getMetabotAddressForChain(metabotStore, metabotId, chain);
  if (!recipientAddress) {
    return { paid: false, txid, reason: `no_${chain}_address_for_metabot` };
  }

  debugLog(
    `Verifying txid=${txid} chain=${chain} expected=${amount} ${currency} (${expectedSats} sats) recipient=${recipientAddress}`
  );

  const toleranceSats = Math.max(Math.floor(expectedSats * 0.01), 1);
  const verification = await verifyTransferToRecipient({
    chain,
    txid,
    recipientAddress,
    expectedAmountSats: expectedSats,
    toleranceSats,
  });

  if (verification.valid) {
    debugLog(
      `Payment verified: ${verification.matchedAmountSats ?? 0} sats to ${recipientAddress} (expected >= ${expectedSats - toleranceSats})`
    );
    return {
      paid: true,
      txid,
      reason: 'verified',
      chain,
      amountSats: verification.matchedAmountSats,
    };
  }

  if (
    verification.reason.startsWith('fetch_raw_tx_failed:') ||
    verification.reason === 'raw_tx_not_found'
  ) {
    debugLog(`${verification.reason} — allowing order through as unverifiable`);
    return {
      paid: true,
      txid,
      reason: `unverified_network_error: ${verification.reason}`,
      chain,
    };
  }

  debugLog(`Payment verification failed: ${verification.reason}`);
  return {
    paid: false,
    txid,
    reason: verification.reason,
    chain,
    amountSats: verification.matchedAmountSats ?? 0,
  };
}
