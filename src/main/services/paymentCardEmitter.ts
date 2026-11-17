/**
 * Payment-card emitter (G1) — the agent-tool path from the owner's encrypted
 * S3 receiving info to a REAL, payable `pay-card` fence.
 *
 * Before this module the only way to emit a card was a one-off script: the
 * receiving info lives encrypted in `payment_receiving_info` and no bot tool
 * could read it, so "any supply-side bot can issue a card" did not hold.
 *
 * Security contract (each item is enforced here, not by the caller):
 *
 *   - The payee block is derived ONLY from the decrypted receiving info. The
 *     tool accepts no payee / QR / account-id input at all, so a card can
 *     never name a different payee than the one the owner configured.
 *   - Only the receiving CODE (qrContent) and a masked display name enter the
 *     card. The saved QR image (qrImageDataUrl), the Alipay PID and the
 *     ciphertext never do: the renderer re-draws the QR from qrContent and
 *     must never re-transmit the owner's image (PaymentCard.tsx §re-render).
 *   - amountCents / orderId come only from the caller. When the caller also
 *     declares amountYuan or memo, they are cross-checked exactly (integer
 *     cents, memo == orderId — the card forces memo to the orderId) and any
 *     disagreement REFUSES the card.
 *   - The finished fence must parse back through the renderer's own gate
 *     (parsePayCardFence); a card that would not render is never returned.
 *
 * Zero funds flow: this module has no wallet, chain-write or network import —
 * a card only tells the payer where to send money point-to-point.
 */

import {
  decryptPaymentInfo,
  derivePaymentInfoKey,
  isValidAlipayQrContent,
  maskDisplayName,
  type PaymentReceivingInfo,
} from './paymentInfoCrypto';
import {
  parsePayCardFence,
  PAY_CARD_FENCE_TAG,
  type PaymentCardData,
} from '../../renderer/components/chat/paymentCardSyntax';

/** Same ceiling the renderer's parser enforces (¥1,000,000). */
export const PAYMENT_CARD_MAX_AMOUNT_CENTS = 100_000_000_00;

/** Same order-id shape the renderer's parser enforces. */
const ORDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type PaymentCardRefusalCode =
  /** No `payment_receiving_info` row — the owner never saved receiving info. */
  | 'NO_RECEIVING_INFO'
  /** Identity row missing, or the blob does not decrypt (wrong key / tamper). */
  | 'DECRYPT_FAILED'
  /** Decrypted, but no receiving CODE: the card only pays by receiving code. */
  | 'NO_QR_CHANNEL'
  | 'INVALID_ORDER_ID'
  | 'INVALID_AMOUNT'
  | 'AMOUNT_MISMATCH'
  | 'MEMO_MISMATCH'
  | 'CARD_INVALID';

/**
 * Discriminated on the string field `status` ON PURPOSE: this repo's electron
 * tsconfig runs without `strict` (strictNullChecks off), where narrowing by a
 * boolean-literal discriminant silently stops working — a string discriminant
 * narrows under both settings.
 */
export type PaymentCardReadResult =
  | { status: 'ok'; info: PaymentReceivingInfo; updatedAt: number }
  | { status: 'refused'; code: PaymentCardRefusalCode; message: string };

export interface PaymentCardEmitInput {
  /** Reconciliation anchor; also the memo the card forces. */
  orderId: string;
  amountCents: number;
  /** Optional declared decimal (e.g. "0.01") — must equal amountCents exactly. */
  amountYuan?: string;
  /** Optional declared memo — must equal orderId (a different memo breaks reconciliation). */
  memo?: string;
}

export type PaymentCardEmitResult =
  | {
    status: 'ok';
    card: PaymentCardData;
    fence: string;
    /** Variant-C launch URL the card's button will build; null when it would not validate. */
    launchUrl: string | null;
  }
  | { status: 'refused'; code: PaymentCardRefusalCode; message: string };

export interface PaymentCardSourceDeps {
  /** The local owner identity (mnemonic + globalMetaId) — never logged. */
  getIdentity: () => { mnemonic?: string | null; globalmetaid?: string | null } | null | undefined;
  readCipher: () => { cipher: Buffer; updatedAt: number } | null;
}

/**
 * Read + decrypt the owner's stored receiving info.
 *
 * Returns only the decrypted value: the ciphertext, the mnemonic and the key
 * stay inside this function. A missing identity is a DECRYPT_FAILED refusal
 * rather than a silent "no info", because the two need different fixes.
 */
export function readPaymentReceivingInfo(deps: PaymentCardSourceDeps): PaymentCardReadResult {
  let row: { cipher: Buffer; updatedAt: number } | null;
  try {
    row = deps.readCipher();
  } catch (error) {
    return { status: 'refused', code: 'DECRYPT_FAILED', message: `could not read the stored receiving info (${errorMessage(error)})` };
  }
  if (!row) {
    return {
      status: 'refused',
      code: 'NO_RECEIVING_INFO',
      message: 'the owner has not saved payment receiving info on this machine (设置 → 收款信息); nothing to put on a card.',
    };
  }

  try {
    const identity = deps.getIdentity();
    const mnemonic = identity?.mnemonic?.trim();
    const globalMetaId = identity?.globalmetaid?.trim();
    if (!mnemonic || !globalMetaId) {
      return {
        status: 'refused',
        code: 'DECRYPT_FAILED',
        message: 'the local identity (mnemonic / globalMetaId) is unavailable, so the receiving info cannot be decrypted.',
      };
    }
    const key = derivePaymentInfoKey(mnemonic, globalMetaId);
    const info = decryptPaymentInfo(key, row.cipher);
    return { status: 'ok', info: validateDecryptedInfo(info), updatedAt: row.updatedAt };
  } catch (error) {
    return {
      status: 'refused',
      code: 'DECRYPT_FAILED',
      message: `the stored receiving info could not be decrypted (${errorMessage(error)}); re-save it in 设置 → 收款信息.`,
    };
  }
}

/**
 * Defensive shape check on a decrypted blob: a valid cipher can still carry an
 * older/foreign JSON shape, and a non-string qrContent must never reach the
 * card builder (it would throw inside the QR gate).
 */
function validateDecryptedInfo(info: unknown): PaymentReceivingInfo {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return {};
  const raw = info as Record<string, unknown>;
  const out: PaymentReceivingInfo = {};
  if (typeof raw.payeeDisplayName === 'string' && raw.payeeDisplayName.trim()) {
    out.payeeDisplayName = raw.payeeDisplayName.trim();
  }
  if (typeof raw.alipayPid === 'string' && raw.alipayPid.trim()) {
    out.alipayPid = raw.alipayPid.trim();
  }
  if (typeof raw.qrContent === 'string' && raw.qrContent.trim()) {
    out.qrContent = raw.qrContent.trim();
  }
  if (typeof raw.qrImageDataUrl === 'string' && raw.qrImageDataUrl.startsWith('data:image/')) {
    out.qrImageDataUrl = raw.qrImageDataUrl;
  }
  return out;
}

/** Decimal yuan → integer cents with exact integer math (no float drift). */
function yuanStringToCents(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, fraction = ''] = trimmed.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Serialize the fence body in the exact field order the card contract documents. */
export function buildPaymentCardFence(card: PaymentCardData): string {
  const body: Record<string, unknown> = {
    orderId: card.orderId,
    amountCents: card.amountCents,
    currency: card.currency,
    payee: {
      ...(card.payee.displayName ? { displayName: card.payee.displayName } : {}),
      ...(card.payee.qrContent ? { qrContent: card.payee.qrContent } : {}),
      ...(card.payee.alipayPid ? { alipayPid: card.payee.alipayPid } : {}),
    },
  };
  if (card.deadline != null) body.deadline = card.deadline;
  return `\`\`\`${PAY_CARD_FENCE_TAG}\n${JSON.stringify(body)}\n\`\`\``;
}

/**
 * Build a real payment card from the decrypted receiving info.
 *
 * Refuses (returns {ok:false}) instead of emitting a card that is unpayable,
 * mislabelled, or would not render.
 */
export function emitPaymentCard(
  info: PaymentReceivingInfo,
  input: PaymentCardEmitInput,
): PaymentCardEmitResult {
  const orderId = typeof input.orderId === 'string' ? input.orderId.trim() : '';
  if (!ORDER_ID_RE.test(orderId)) {
    return {
      status: 'refused',
      code: 'INVALID_ORDER_ID',
      message: `order_id "${truncateForMessage(input.orderId)}" is not a card order id (1-64 chars: letters, digits, dot, dash, underscore; must start with a letter or digit).`,
    };
  }

  const amountCents = input.amountCents;
  if (typeof amountCents !== 'number' || !Number.isInteger(amountCents) || amountCents <= 0 || amountCents > PAYMENT_CARD_MAX_AMOUNT_CENTS) {
    return {
      status: 'refused',
      code: 'INVALID_AMOUNT',
      message: `amount_cents must be a positive integer number of cents (¥0.01 → 1), at most ${PAYMENT_CARD_MAX_AMOUNT_CENTS}; got ${String(input.amountCents)}.`,
    };
  }

  if (input.amountYuan != null) {
    const declared = typeof input.amountYuan === 'string' ? yuanStringToCents(input.amountYuan) : null;
    if (declared == null) {
      return {
        status: 'refused',
        code: 'INVALID_AMOUNT',
        message: `amount_yuan "${truncateForMessage(input.amountYuan)}" is not a decimal yuan amount with at most two decimals.`,
      };
    }
    if (declared !== amountCents) {
      return {
        status: 'refused',
        code: 'AMOUNT_MISMATCH',
        message: `amount_yuan "${truncateForMessage(input.amountYuan)}" is ${declared} cents but amount_cents is ${amountCents} — the card face and the charged amount must agree exactly, so nothing was emitted.`,
      };
    }
  }

  if (input.memo != null && String(input.memo).trim() !== orderId) {
    return {
      status: 'refused',
      code: 'MEMO_MISMATCH',
      message: `memo "${truncateForMessage(input.memo)}" differs from order_id "${orderId}" — the card forces its memo to the order id (the 我已支付 / 待核验 reconciliation anchor), so nothing was emitted.`,
    };
  }

  const qrContent = typeof info.qrContent === 'string' ? info.qrContent.trim() : '';
  const hasQr = qrContent.length > 0 && isValidAlipayQrContent(qrContent);
  const hasPid = Boolean(info.alipayPid);
  if (!hasQr && !hasPid) {
    return {
      status: 'refused',
      code: 'NO_QR_CHANNEL',
      message: 'the saved receiving info carries no usable Alipay receiving code or PID; re-save it in 设置 → 收款信息.',
    };
  }
  if (!hasQr) {
    return {
      status: 'refused',
      code: 'NO_QR_CHANNEL',
      message: 'the saved receiving info has only an Alipay PID — this card contract pays by receiving code (variant C launch + QR degrade), so a PID-only card would be unpayable. Save the receiving code in 设置 → 收款信息.',
    };
  }

  const displayName = typeof info.payeeDisplayName === 'string' && info.payeeDisplayName.trim()
    ? maskDisplayName(info.payeeDisplayName)
    : undefined;

  // Only these two fields enter the card. qrImageDataUrl / alipayPid stay out:
  // the image is deliberately never re-transmitted, and variant C needs no PID.
  const card: PaymentCardData = {
    orderId,
    amountCents,
    currency: 'CNY',
    payee: {
      ...(displayName ? { displayName } : {}),
      qrContent,
    },
  };

  const fence = buildPaymentCardFence(card);
  const body = fence.split('\n').slice(1, -1).join('\n');
  const parsed = parsePayCardFence(body);
  if (!parsed || !sameCard(parsed, card)) {
    return {
      status: 'refused',
      code: 'CARD_INVALID',
      message: 'the emitted card did not pass the renderer\'s own pay-card parser, so it was withheld (this is an emitter bug, not a caller error).',
    };
  }

  return { status: 'ok', card: parsed, fence, launchUrl: launchUrlOf(qrContent) };
}

/**
 * The variant-C launch URL, built with the renderer's own rule so the tool can
 * report what the button will open without importing Electron. Kept local (not
 * exported) because the renderer module stays the single source of truth for
 * the exact string; this copy is only used for the tool's summary line.
 */
function launchUrlOf(qrContent: string): string | null {
  if (!isValidAlipayQrContent(qrContent)) return null;
  return `alipays://platformapi/startapp?saId=10000007&clientVersion=3.7.0.0718&qrcode=${encodeURIComponent(qrContent)}`;
}

function sameCard(a: PaymentCardData, b: PaymentCardData): boolean {
  return a.orderId === b.orderId
    && a.amountCents === b.amountCents
    && a.currency === b.currency
    && (a.payee.displayName ?? '') === (b.payee.displayName ?? '')
    && (a.payee.qrContent ?? '') === (b.payee.qrContent ?? '')
    && (a.payee.alipayPid ?? '') === (b.payee.alipayPid ?? '')
    && (a.deadline ?? null) === (b.deadline ?? null);
}

function truncateForMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value);
  return text.length > 128 ? `${text.slice(0, 128)}…` : text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
