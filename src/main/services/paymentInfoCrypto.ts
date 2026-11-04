/**
 * Payment receiving-info cryptography (S3 fiat receiving, slice 1).
 *
 * The user's Alipay receiving info (QR content / PID / display name / QR
 * image) is money-adjacent private data: it is stored locally ONLY, always
 * encrypted at rest, and never written on-chain (a pin is public forever —
 * publishing receiving info there would permanently expose the user's
 * payment profile, see design doc 02 §3.2).
 *
 * Key derivation mirrors chainBackupCrypto on purpose (same wire format,
 * same HKDF skeleton) but with an isolated purpose so leaking one key never
 * leaks the other:
 *
 *   seed = bip39.mnemonicToSeedSync(mnemonic)
 *   key  = HKDF-SHA256(ikm = seed,
 *                      salt = "idbots-payment-v1" + userGlobalMetaId,
 *                      info = "payment-info-key", len = 32)
 *
 * Payloads reuse chainBackupCrypto's encryptJson/decryptJson verbatim:
 * AES-256-GCM over canonical JSON, wire format `nonce(12) || tag(16) || ct`.
 *
 * Pure module: no Electron imports, directly unit-testable.
 */

import { hkdfSync } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';
import { encryptJson, decryptJson } from './chainBackupCrypto';

export const PAYMENT_INFO_KDF_SALT_PREFIX = 'idbots-payment-v1';
export const PAYMENT_INFO_KDF_INFO = 'payment-info-key';
export const PAYMENT_INFO_KEY_BYTES = 32;

/** QR content must be an Alipay receiving-code URL (qr.alipay.com/<code>). */
const ALIPAY_QR_PREFIX = 'https://qr.alipay.com/';
/** Alipay user ids (PIDs) are 2088 + 12 digits, per community scheme docs. */
const ALIPAY_PID_RE = /^2088\d{12}$/;

/**
 * The receiving info a user configures in Settings. All fields optional at
 * the type level, but `validatePaymentReceivingInfo` requires at least one
 * usable receiving channel (qrContent or alipayPid) before anything is
 * saved — only a QR code is enough to receive (variant C + degrade path).
 */
export interface PaymentReceivingInfo {
  /** Display name shown on the payment card (masked on non-owner surfaces). */
  payeeDisplayName?: string;
  /** Alipay PID (2088…16 digits) — userId parameter for scheme variants A/B. */
  alipayPid?: string;
  /** Receiving-code content (https://qr.alipay.com/…) — variant C + degrade share it. */
  qrContent?: string;
  /** Original receiving-code image as a data URL, archived for manual cross-check. */
  qrImageDataUrl?: string;
}

/** True when the string is an Alipay receiving-code URL we may put in a scheme. */
export function isValidAlipayQrContent(value: string): boolean {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (trimmed.length > 512) return false;
  if (/\s/.test(trimmed)) return false;
  if (!trimmed.startsWith(ALIPAY_QR_PREFIX)) return false;
  const code = trimmed.slice(ALIPAY_QR_PREFIX.length);
  return /^[A-Za-z0-9_-]+$/.test(code) && code.length >= 6;
}

/** True when the string is a plausible Alipay PID (2088 + 12 digits). */
export function isValidAlipayPid(value: string): boolean {
  return typeof value === 'string' && ALIPAY_PID_RE.test(value.trim());
}

/**
 * Mask a real name for display on non-owner surfaces: 首字 + * + 末字.
 * Two-char names keep the last char hidden; single chars stay single.
 */
export function maskDisplayName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= 1) return trimmed;
  if (trimmed.length === 2) return `${trimmed[0]}*`;
  return `${trimmed[0]}*${trimmed[trimmed.length - 1]}`;
}

/** Derive the 32-byte payment-info key from the user mnemonic. Deterministic. */
export function derivePaymentInfoKey(mnemonic: string, userGlobalMetaId: string): Buffer {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seed = mnemonicToSeedSync(normalized);
  const salt = `${PAYMENT_INFO_KDF_SALT_PREFIX}${userGlobalMetaId.trim()}`;
  const key = hkdfSync('sha256', Buffer.from(seed), Buffer.from(salt, 'utf8'), PAYMENT_INFO_KDF_INFO, PAYMENT_INFO_KEY_BYTES);
  return Buffer.from(key);
}

/** Encrypt a PaymentReceivingInfo value: returns nonce || tag || ciphertext. */
export function encryptPaymentInfo(key: Buffer, info: PaymentReceivingInfo): Buffer {
  return encryptJson(key, info);
}

/** Decrypt a buffer produced by encryptPaymentInfo. Throws on tamper/wrong key. */
export function decryptPaymentInfo(key: Buffer, payload: Buffer): PaymentReceivingInfo {
  return decryptJson(key, payload) as PaymentReceivingInfo;
}

export interface ValidatedPaymentReceivingInfo {
  ok: boolean;
  value?: PaymentReceivingInfo;
  errors: string[];
}

/**
 * Validate + normalize a candidate receiving-info form value before it is
 * encrypted. Rejects: invalid qrContent prefix (a WeChat code or arbitrary
 * link must never be stored as an Alipay channel), invalid PID shape, and
 * forms with no usable receiving channel at all.
 */
export function validatePaymentReceivingInfo(input: unknown): ValidatedPaymentReceivingInfo {
  const errors: string[] = [];
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['INVALID_SHAPE'] };
  }
  const raw = input as Record<string, unknown>;

  let payeeDisplayName: string | undefined;
  if (typeof raw.payeeDisplayName === 'string' && raw.payeeDisplayName.trim()) {
    payeeDisplayName = raw.payeeDisplayName.trim().slice(0, 32);
  } else if (raw.payeeDisplayName != null) {
    errors.push('INVALID_DISPLAY_NAME');
  }

  let alipayPid: string | undefined;
  if (typeof raw.alipayPid === 'string' && raw.alipayPid.trim()) {
    alipayPid = raw.alipayPid.trim();
    if (!isValidAlipayPid(alipayPid)) errors.push('INVALID_ALIPAY_PID');
  } else if (raw.alipayPid != null) {
    errors.push('INVALID_ALIPAY_PID');
  }

  let qrContent: string | undefined;
  if (typeof raw.qrContent === 'string' && raw.qrContent.trim()) {
    qrContent = raw.qrContent.trim();
    if (!isValidAlipayQrContent(qrContent)) errors.push('INVALID_QR_CONTENT');
  } else if (raw.qrContent != null) {
    errors.push('INVALID_QR_CONTENT');
  }

  let qrImageDataUrl: string | undefined;
  if (typeof raw.qrImageDataUrl === 'string' && raw.qrImageDataUrl.startsWith('data:image/')) {
    qrImageDataUrl = raw.qrImageDataUrl.slice(0, 4 * 1024 * 1024);
  } else if (raw.qrImageDataUrl != null) {
    errors.push('INVALID_QR_IMAGE');
  }

  if (errors.length > 0) return { ok: false, errors };

  const hasChannel = Boolean(qrContent && isValidAlipayQrContent(qrContent))
    || Boolean(alipayPid && isValidAlipayPid(alipayPid));
  if (!hasChannel) return { ok: false, errors: ['NO_RECEIVING_CHANNEL'] };

  const value: PaymentReceivingInfo = {};
  if (payeeDisplayName) value.payeeDisplayName = payeeDisplayName;
  if (alipayPid) value.alipayPid = alipayPid;
  if (qrContent) value.qrContent = qrContent;
  if (qrImageDataUrl) value.qrImageDataUrl = qrImageDataUrl;
  return { ok: true, value, errors: [] };
}
