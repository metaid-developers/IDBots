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
const ORDER_PREFIX_RE = /^\s*\[ORDER\]\s*/i;
const STRUCTURED_ORDER_METADATA_LINE_RE = /^\s*(?:支付金额|payment(?: amount)?|txid|transaction id|service(?:\s+pin)?\s+id|serviceid|服务(?:\s*pin)?\s*id|服务(?:编号|标识|ID)|skill(?:\s+name)?|provider\s*skill|service\s+skill|技能(?:名称?)?|服务技能|服务名称)\s*[:：=]?/i;
const SKILL_ID_PATTERNS = [
  /(?:skill(?:\s+service)?\s+id|service(?:\s+pin)?\s+id|serviceid|服务(?:\s*pin)?\s*id|服务(?:编号|标识|ID))\s*[:：=]?\s*([^\s,，。]+)/i,
];
const SKILL_NAME_PATTERNS = [
  /(?:skill(?:\s+name)?|provider\s*skill|service\s+skill|技能(?:名称?)?|服务技能|服务名称)\s*[:：=]?\s*([\w-]+)/i,
  /用\s*([\w-]+)\s*技能/i,
  /使用\s*([\w-]+)\s*技能/i,
  /(?:use|using)\s+([\w-]+)\s+skill/i,
];
const SATOSHI_PER_UNIT = 100_000_000;

function extractFirstMatch(plaintext: string, patterns: RegExp[]): string | null {
  const source = String(plaintext || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const value = typeof match?.[1] === 'string' ? match[1].trim() : '';
    if (value) {
      return value;
    }
  }
  return null;
}

export function extractOrderSkillId(plaintext: string): string | null {
  return extractFirstMatch(plaintext, SKILL_ID_PATTERNS);
}

export function extractOrderSkillName(plaintext: string): string | null {
  return extractFirstMatch(plaintext, SKILL_NAME_PATTERNS);
}

export function extractOrderTxid(plaintext: string): string | null {
  const match = plaintext.match(TXID_RE);
  if (!match) return null;
  return match[1] || null;
}

export function extractOrderRequestText(plaintext: string): string {
  const source = String(plaintext || '').replace(/\r\n?/g, '\n');
  if (!source.trim()) return '';

  const keptLines: string[] = [];
  source.split('\n').forEach((line, index) => {
    const withoutPrefix = index === 0 ? line.replace(ORDER_PREFIX_RE, '') : line;
    const trimmed = withoutPrefix.trim();
    if (!trimmed) {
      if (keptLines.length > 0 && keptLines[keptLines.length - 1] !== '') {
        keptLines.push('');
      }
      return;
    }
    if (STRUCTURED_ORDER_METADATA_LINE_RE.test(trimmed)) {
      return;
    }
    keptLines.push(withoutPrefix.trimEnd());
  });

  while (keptLines[0] === '') keptLines.shift();
  while (keptLines[keptLines.length - 1] === '') keptLines.pop();

  const cleaned = keptLines.join('\n').trim();
  if (cleaned) {
    return cleaned;
  }

  return source.replace(ORDER_PREFIX_RE, '').trim();
}

function extractOrderAmount(
  plaintext: string
): { amount: number; currency: string; chain: TransferChain } | null {
  const match = plaintext.match(AMOUNT_RE);
  if (!match) return null;
  const amount = parseFloat(match[1]);
  const currency = match[2].toUpperCase();
  if (!Number.isFinite(amount) || amount < 0) return null;
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

  const parsed = extractOrderAmount(plaintext);
  if (!parsed) {
    return { paid: false, txid, reason: 'cannot_parse_amount_or_currency' };
  }

  const { amount, currency, chain } = parsed;
  const expectedSats = Math.floor(amount * SATOSHI_PER_UNIT);
  if (expectedSats < 0) {
    return { paid: false, txid, reason: 'invalid_amount' };
  }
  if (expectedSats === 0) {
    return {
      paid: true,
      txid: txid || null,
      reason: 'free_order_no_payment_required',
      chain,
      amountSats: 0,
    };
  }

  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return { paid: false, txid: txid || null, reason: 'invalid_or_missing_txid' };
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
