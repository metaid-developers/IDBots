/**
 * pay-card fence syntax — the chat payment-card contract (S3 fiat slice).
 *
 * Mirrors the nft-card contract: a bot (or order service) embeds the card as
 * a fenced code block whose fence tag is `pay-card` and whose body is one
 * JSON object; every markdown surface that routes through MarkdownContent
 * renders it as a PaymentCard. An unparsable payload keeps the plain
 * code-block rendering, so a hostile or truncated fence degrades exactly
 * like any unknown fence tag.
 *
 * ```pay-card
 * {"orderId":"S3-20261103-0001","amountCents":100,"currency":"CNY",
 *  "payee":{"displayName":"*明","qrContent":"https://qr.alipay.com/…"},
 *  "deadline":1793641471526}
 * ```
 *
 * Security notes (design doc 01 §5): amount is integer cents — the card
 * never re-reads the amount from a URL; memo is forced to the orderId; the
 * qrContent must pass the qr.alipay.com prefix gate before it may enter a
 * scheme URL; everything user-supplied is encodeURIComponent'd.
 *
 * This module is DOM-free so renderer tests drive it directly.
 */

export const PAY_CARD_FENCE_TAG = 'pay-card';
const PAY_CARD_FENCE_TAGS = new Set(['pay-card', 'paycard']);

/** True when a code-fence language should render as a payment card. */
export function isPayCardFenceLanguage(language: string | null | undefined): boolean {
  if (!language) return false;
  return PAY_CARD_FENCE_TAGS.has(language.trim().toLowerCase());
}

/** Alipay receiving-code URL gate (mirrors paymentInfoCrypto's rule). */
const ALIPAY_QR_PREFIX = 'https://qr.alipay.com/';

export function isValidAlipayQrContent(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length > 512 || /\s/.test(trimmed)) return false;
  if (!trimmed.startsWith(ALIPAY_QR_PREFIX)) return false;
  const code = trimmed.slice(ALIPAY_QR_PREFIX.length);
  return /^[A-Za-z0-9_-]+$/.test(code) && code.length >= 6;
}

export interface PaymentCardPayee {
  /** Seller display name (already masked by the emitter on non-owner surfaces). */
  displayName?: string;
  /** Alipay PID — scheme variants A/B; this slice renders C, so it is optional. */
  alipayPid?: string;
  /** Receiving-code content — variant C launch and the degrade card share it. */
  qrContent?: string;
}

export interface PaymentCardData {
  /** Order id == payment memo, the reconciliation anchor. */
  orderId: string;
  /** Amount in integer cents (¥0.01 → 1); display and scheme agree on this. */
  amountCents: number;
  currency: 'CNY';
  payee: PaymentCardPayee;
  /** Optional payment deadline (unix ms) driving reminders/timeout (doc 04). */
  deadline?: number;
}

const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_AMOUNT_CENTS = 100_000_000_00; // ¥1,000,000 — sanity ceiling.

/** Parse the body of a pay-card fence. Returns null when not a valid payload. */
export function parsePayCardFence(body: string): PaymentCardData | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  const orderId = raw.orderId;
  if (typeof orderId !== 'string' || !ORDER_ID_RE.test(orderId)) return null;

  const amountCents = raw.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) return null;

  if (raw.currency !== 'CNY') return null;

  const payeeRaw = raw.payee;
  if (!payeeRaw || typeof payeeRaw !== 'object' || Array.isArray(payeeRaw)) return null;
  const payeeObj = payeeRaw as Record<string, unknown>;
  const payee: PaymentCardPayee = {};
  if (payeeObj.displayName != null) {
    if (typeof payeeObj.displayName !== 'string' || payeeObj.displayName.length > 32) return null;
    payee.displayName = payeeObj.displayName;
  }
  if (payeeObj.alipayPid != null) {
    if (typeof payeeObj.alipayPid !== 'string' || !/^2088\d{12}$/.test(payeeObj.alipayPid)) return null;
    payee.alipayPid = payeeObj.alipayPid;
  }
  if (payeeObj.qrContent != null) {
    if (typeof payeeObj.qrContent !== 'string' || !isValidAlipayQrContent(payeeObj.qrContent)) return null;
    payee.qrContent = payeeObj.qrContent;
  }
  // A card with no receiving channel at all cannot be paid; the fence is
  // malformed rather than rendered as a dead card.
  if (!payee.qrContent && !payee.alipayPid) return null;

  let deadline: number | undefined;
  if (raw.deadline != null) {
    if (typeof raw.deadline !== 'number' || !Number.isFinite(raw.deadline)) return null;
    deadline = raw.deadline;
  }

  return {
    orderId,
    amountCents,
    currency: 'CNY',
    payee,
    ...(deadline !== undefined ? { deadline } : {}),
  };
}

/**
 * Build the variant-C Alipay launch URL (the real-device-tested form,
 * scheme-test EVIDENCE T3): the qrcode parameter proxies any qr.alipay.com
 * receiving code into the Alipay app's scan-result flow. Returns null when
 * the qrContent fails the prefix gate — an invalid code never enters a
 * scheme.
 */
export function buildAlipayVariantCUrl(qrContent: string): string | null {
  if (!isValidAlipayQrContent(qrContent)) return null;
  return `alipays://platformapi/startapp?saId=10000007&clientVersion=3.7.0.0718&qrcode=${encodeURIComponent(qrContent.trim())}`;
}

/** Format integer cents as a two-decimal yuan string (no float drift). */
export function formatCentsToYuan(amountCents: number): string {
  const sign = amountCents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(amountCents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
