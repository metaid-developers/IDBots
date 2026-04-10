/**
 * Order Payment Verification Service.
 * Validates on-chain payments by fetching raw transactions from Metalet API
 * and verifying that the expected recipient receives the correct amount.
 */

import type { MetabotStore } from '../metabotStore';
import {
  verifyTransferToRecipient,
  type VerifyTransferResult,
  type TransferChain,
} from './txTransferVerification';
import { extractOrderRawRequest } from '../shared/orderMessage.js';
import { parseGigSquareSettlementAsset } from '../shared/gigSquareSettlementAsset.js';
import {
  verifyMrc20Payment,
  type VerifyMrc20PaymentInput,
  type VerifyMrc20PaymentResult,
} from './mrc20PaymentVerification';

export type OrderSource = 'metaweb_private' | 'metaweb_group';

export interface OrderPaymentCheckResult {
  paid: boolean;
  txid: string | null;
  reason: string;
  chain?: string;
  amountSats?: number;
  settlementKind?: 'native' | 'mrc20';
  mrc20Ticker?: string | null;
  mrc20Id?: string | null;
  paymentCommitTxid?: string | null;
  currency?: string;
  amountDisplay?: string;
  amountAtomic?: string;
}

const TXID_RE = /^\s*(?:txid|transaction\s+id)\s*[:：=]?\s*([0-9a-fA-F]{64})(?=[^0-9a-fA-F]|$).*$/im;
const ORDER_REFERENCE_RE = /order(?:\s+id|\s+ref(?:erence)?)\s*[:：=]?\s*([0-9a-fA-F]{64})/i;
const AMOUNT_RE = /支付金额\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z0-9-]+)/i;
const ORDER_PREFIX_RE = /^\s*\[ORDER\]\s*/i;
const STRUCTURED_ORDER_METADATA_LINE_RE = /^\s*(?:支付金额|payment(?: amount)?|txid|commit\s+txid|transaction id|order(?:\s+id|\s+ref(?:erence)?)?|payment\s+chain|settlement\s+kind|mrc20\s+ticker|mrc20\s+id|service(?:\s+pin)?\s+id|serviceid|服务(?:\s*pin)?\s*id|服务(?:编号|标识|ID)|订单(?:编号|标识|ID)|skill(?:\s+name)?|provider\s*skill|service\s+skill|技能(?:名称?)?|服务技能|服务名称)\s*[:：=]?/i;
const RAW_REQUEST_TAG_LINE_RE = /^\s*<\/?raw_request>\s*$/i;
const PAYMENT_CHAIN_RE = /^\s*payment\s+chain\s*[:：=]?\s*([A-Za-z0-9_-]+)\s*$/im;
const SETTLEMENT_KIND_RE = /^\s*settlement\s+kind\s*[:：=]?\s*([A-Za-z0-9_-]+)\s*$/im;
const MRC20_TICKER_RE = /^\s*mrc20\s+ticker\s*[:：=]?\s*([A-Za-z0-9_-]+)\s*$/im;
const MRC20_ID_RE = /^\s*mrc20\s+id\s*[:：=]?\s*([^\s]+)\s*$/im;
const COMMIT_TXID_RE = /^\s*commit\s+txid\s*[:：=]?\s*([0-9a-fA-F]{64})\s*$/im;
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

type VerifyNativeTransferFn = (input: {
  chain: TransferChain;
  txid: string;
  recipientAddress: string;
  expectedAmountSats: number;
  toleranceSats: number;
}) => Promise<VerifyTransferResult>;

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

export function extractOrderReferenceId(plaintext: string): string | null {
  const match = plaintext.match(ORDER_REFERENCE_RE);
  if (!match) return null;
  return match[1] || null;
}

export function extractOrderRequestText(plaintext: string): string {
  const explicitRawRequest = extractOrderRawRequest(plaintext);
  if (explicitRawRequest) {
    return explicitRawRequest;
  }

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
    if (RAW_REQUEST_TAG_LINE_RE.test(trimmed)) {
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

function normalizePaymentChain(value: unknown): TransferChain | null {
  const chain = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (chain === 'btc' || chain === 'doge' || chain === 'mvc') {
    return chain;
  }
  return null;
}

function normalizeSettlementKind(value: unknown): 'native' | 'mrc20' | null {
  const kind = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (kind === 'native' || kind === 'mrc20') {
    return kind;
  }
  return null;
}

function normalizeMrc20Ticker(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function extractStructuredField(plaintext: string, pattern: RegExp): string {
  const match = String(plaintext || '').match(pattern);
  return typeof match?.[1] === 'string' ? match[1].trim() : '';
}

function resolveNativeCurrency(currency: string, chain: TransferChain): string {
  const normalized = String(currency || '').trim().toUpperCase();
  if (normalized === 'BTC') return 'BTC';
  if (normalized === 'DOGE') return 'DOGE';
  if (normalized === 'MVC' || normalized === 'SPACE') return 'SPACE';
  if (chain === 'btc') return 'BTC';
  if (chain === 'doge') return 'DOGE';
  return 'SPACE';
}

function parseOrderSettlement(plaintext: string): {
  amountDisplay: string;
  amount: number;
  chain: TransferChain;
  currency: string;
  settlementKind: 'native' | 'mrc20';
  mrc20Ticker: string | null;
  mrc20Id: string | null;
  paymentCommitTxid: string | null;
} | null {
  const match = String(plaintext || '').match(AMOUNT_RE);
  if (!match) return null;

  const amountDisplay = String(match[1] || '').trim();
  const amount = Number.parseFloat(amountDisplay);
  const declaredCurrency = String(match[2] || '').trim().toUpperCase();
  if (!amountDisplay || !Number.isFinite(amount) || amount < 0) {
    return null;
  }

  const paymentChain = normalizePaymentChain(extractStructuredField(plaintext, PAYMENT_CHAIN_RE));
  const settlementKind = normalizeSettlementKind(extractStructuredField(plaintext, SETTLEMENT_KIND_RE));
  const mrc20Ticker = extractStructuredField(plaintext, MRC20_TICKER_RE);
  const mrc20Id = extractStructuredField(plaintext, MRC20_ID_RE);
  const paymentCommitTxid = extractStructuredField(plaintext, COMMIT_TXID_RE) || null;

  let settlement;
  try {
    settlement = parseGigSquareSettlementAsset({
      paymentCurrency: declaredCurrency,
      settlementKind,
      mrc20Ticker,
      mrc20Id,
    });
  } catch {
    return null;
  }

  if (settlement.settlementKind === 'mrc20') {
    const resolvedTicker = normalizeMrc20Ticker(
      mrc20Ticker
      || settlement.mrc20Ticker
      || (declaredCurrency.endsWith('-MRC20') ? declaredCurrency.slice(0, -6) : '')
    );
    const resolvedMrc20Id = String(mrc20Id || settlement.mrc20Id || '').trim();
    if (!resolvedTicker || !resolvedMrc20Id) return null;
    return {
      amountDisplay,
      amount,
      chain: 'btc',
      currency: `${resolvedTicker}-MRC20`,
      settlementKind: 'mrc20',
      mrc20Ticker: resolvedTicker,
      mrc20Id: resolvedMrc20Id,
      paymentCommitTxid,
    };
  }

  const chain = paymentChain ?? normalizePaymentChain(settlement.paymentChain) ?? 'mvc';
  return {
    amountDisplay,
    amount,
    chain,
    currency: resolveNativeCurrency(declaredCurrency, chain),
    settlementKind: 'native',
    mrc20Ticker: null,
    mrc20Id: null,
    paymentCommitTxid,
  };
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
  verifyNativeTransferToRecipient?: VerifyNativeTransferFn;
  verifyMrc20Payment?: (input: VerifyMrc20PaymentInput) => Promise<VerifyMrc20PaymentResult>;
}): Promise<OrderPaymentCheckResult> {
  const {
    txid,
    plaintext,
    metabotId,
    metabotStore,
    verifyNativeTransferToRecipient = verifyTransferToRecipient,
    verifyMrc20Payment: verifyMrc20PaymentFn = verifyMrc20Payment,
  } = params;

  const parsed = parseOrderSettlement(plaintext);
  if (!parsed) {
    return { paid: false, txid, reason: 'cannot_parse_amount_or_currency' };
  }

  const { amount, currency, chain } = parsed;
  const baseResult = {
    chain,
    settlementKind: parsed.settlementKind,
    mrc20Ticker: parsed.mrc20Ticker,
    mrc20Id: parsed.mrc20Id,
    paymentCommitTxid: parsed.paymentCommitTxid,
    currency,
    amountDisplay: parsed.amountDisplay,
  } satisfies Partial<OrderPaymentCheckResult>;

  if (amount < 0) {
    return { paid: false, txid, reason: 'invalid_amount' };
  }
  if (parsed.settlementKind === 'mrc20' && amount === 0) {
    return {
      paid: true,
      txid: txid || null,
      reason: 'free_order_no_payment_required',
      ...baseResult,
      amountSats: 0,
      amountAtomic: '0',
    };
  }

  const expectedSats = parsed.settlementKind === 'native'
    ? Math.floor(amount * SATOSHI_PER_UNIT)
    : null;
  if (expectedSats != null && expectedSats < 0) {
    return { paid: false, txid: txid || null, reason: 'invalid_amount', ...baseResult };
  }
  if (expectedSats === 0) {
    return {
      paid: true,
      txid: txid || null,
      reason: 'free_order_no_payment_required',
      ...baseResult,
      amountSats: 0,
      amountAtomic: '0',
    };
  }

  if (!txid || !/^[0-9a-fA-F]{64}$/.test(txid)) {
    return {
      paid: false,
      txid: txid || null,
      reason: 'invalid_or_missing_txid',
      ...baseResult,
    };
  }

  const recipientAddress = getMetabotAddressForChain(metabotStore, metabotId, chain);
  if (!recipientAddress) {
    return {
      paid: false,
      txid,
      reason: `no_${chain}_address_for_metabot`,
      ...baseResult,
    };
  }

  if (parsed.settlementKind === 'mrc20') {
    const mrc20Verification = await verifyMrc20PaymentFn({
      txid,
      recipientAddress,
      mrc20Id: parsed.mrc20Id || '',
      mrc20Ticker: parsed.mrc20Ticker || '',
      expectedAmountDisplay: parsed.amountDisplay,
    });

    if (mrc20Verification.valid) {
      return {
        paid: true,
        txid,
        reason: mrc20Verification.reason || 'verified',
        ...baseResult,
        currency: mrc20Verification.currency || currency,
        amountDisplay: mrc20Verification.amountDisplay || parsed.amountDisplay,
        amountAtomic: mrc20Verification.matchedAmountAtomic || '0',
      };
    }

    if (
      mrc20Verification.reason.startsWith('fetch_token_info_failed:') ||
      mrc20Verification.reason.startsWith('fetch_token_utxos_failed:')
    ) {
      return {
        paid: false,
        txid,
        reason: `unverified_network_error: ${mrc20Verification.reason}`,
        ...baseResult,
        currency: mrc20Verification.currency || currency,
        amountDisplay: mrc20Verification.amountDisplay || parsed.amountDisplay,
        amountAtomic: mrc20Verification.matchedAmountAtomic || '0',
      };
    }

    if (
      mrc20Verification.reason === 'recipient_txid_not_observable'
      || mrc20Verification.reason === 'recipient_txid_not_found'
    ) {
      return {
        paid: false,
        txid,
        reason: `unverified_state_gap: ${mrc20Verification.reason}`,
        ...baseResult,
        currency: mrc20Verification.currency || currency,
        amountDisplay: mrc20Verification.amountDisplay || parsed.amountDisplay,
        amountAtomic: mrc20Verification.matchedAmountAtomic || '0',
      };
    }

    return {
      paid: false,
      txid,
      reason: mrc20Verification.reason,
      ...baseResult,
      currency: mrc20Verification.currency || currency,
      amountDisplay: mrc20Verification.amountDisplay || parsed.amountDisplay,
      amountAtomic: mrc20Verification.matchedAmountAtomic || '0',
    };
  }

  debugLog(
    `Verifying txid=${txid} chain=${chain} expected=${amount} ${currency} (${expectedSats} sats) recipient=${recipientAddress}`
  );

  const toleranceSats = Math.max(Math.floor(expectedSats * 0.01), 1);
  const verification = await verifyNativeTransferToRecipient({
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
      ...baseResult,
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
      ...baseResult,
    };
  }

  debugLog(`Payment verification failed: ${verification.reason}`);
  return {
    paid: false,
    txid,
    reason: verification.reason,
    ...baseResult,
    amountSats: verification.matchedAmountSats ?? 0,
  };
}
