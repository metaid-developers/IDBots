/**
 * PayBuzz Deterministic Cryptography & VIP Challenge Verification (Contract C6)
 *
 * Implements:
 * - Deterministic author master seed derivation from BIP39 mnemonic (+ path)
 * - Key derivation: K = HMAC-SHA256(authorMasterSeedBytes, "idbots-paybuzz-key:v1:" + plainSha256Hex)
 * - AES-256-GCM encryption and authenticated decryption (96-bit IV, 128-bit authTag)
 * - ECDSA challenge signing and verification for Track A VIP MRC-721 unlocks
 */

import crypto from 'node:crypto';
import { mvc } from 'meta-contract';
import { getPrivateKeyBufferForEcdh } from './metabotWalletService';
import { signMvcAddressMessage } from './mvcSponsorClient';

export const PAYBUZZ_KEY_DERIVATION_PREFIX = 'idbots-paybuzz-key:v1:';
export const PAYBUZZ_MASTER_SEED_DOMAIN = 'idbots-paybuzz-master:v1';
export const PAYBUZZ_VIP_CHALLENGE_PREFIX = 'payread-vip:';
export const PAYBUZZ_VIP_WINDOW_SECONDS = 300;
const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";

export interface PaybuzzEncryptedPayload {
  plainSha256: string;
  keySaltHex: string;
  contentKeyHex: string;
  ivHex: string;
  authTagHex: string;
  cipherSha256: string;
  ciphertextBuffer: Buffer;
  ciphertextBase64: string;
}

export function computeSha256Hex(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return crypto.createHash('sha256').update(buf).digest('hex').toLowerCase();
}

export function normalizeHex(value: unknown, expectedBytes?: number, label = 'hex'): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(raw) || raw.length % 2 !== 0) {
    throw new Error(`Invalid ${label}: expected even-length hex string`);
  }
  if (expectedBytes !== undefined && raw.length !== expectedBytes * 2) {
    throw new Error(`Invalid ${label}: expected ${expectedBytes} bytes (${expectedBytes * 2} hex chars)`);
  }
  return raw;
}

/**
 * Derive a deterministic 32-byte author master seed from the MetaBot wallet mnemonic and path.
 * Restoring the same mnemonic + path on a fresh machine produces the exact same seed bytes.
 */
export async function derivePaybuzzAuthorMasterSeed(
  mnemonic: string,
  walletPath?: string | null,
): Promise<Buffer> {
  const normalizedMnemonic = String(mnemonic ?? '').trim();
  if (!normalizedMnemonic) {
    throw new Error('Wallet mnemonic is required to derive PayBuzz author master seed');
  }
  const privKeyBuf = await getPrivateKeyBufferForEcdh(
    normalizedMnemonic,
    (walletPath || DEFAULT_WALLET_PATH).trim(),
  );
  return crypto.createHmac('sha256', PAYBUZZ_MASTER_SEED_DOMAIN).update(privKeyBuf).digest();
}

/**
 * Derive the 32-byte AES-256 content key:
 *   K = HMAC-SHA256(authorMasterSeedBytes, "idbots-paybuzz-key:v1:" + plainSha256Hex)
 */
export function derivePaybuzzContentKey(
  authorMasterSeedBytes: Buffer,
  plainSha256Hex: string,
): Buffer {
  if (!Buffer.isBuffer(authorMasterSeedBytes) || authorMasterSeedBytes.length === 0) {
    throw new Error('authorMasterSeedBytes must be a non-empty Buffer');
  }
  const normalizedSalt = normalizeHex(plainSha256Hex, 32, 'plainSha256');
  return crypto
    .createHmac('sha256', authorMasterSeedBytes)
    .update(`${PAYBUZZ_KEY_DERIVATION_PREFIX}${normalizedSalt}`, 'utf8')
    .digest();
}

export function encryptPaybuzzContent(input: {
  plaintextMarkdown: string;
  authorMasterSeedBytes: Buffer;
  ivHex?: string;
}): PaybuzzEncryptedPayload {
  const plaintext = String(input.plaintextMarkdown ?? '');
  if (!plaintext) {
    throw new Error('Article markdown content cannot be empty');
  }
  const plainBytes = Buffer.from(plaintext, 'utf8');
  const plainSha256 = computeSha256Hex(plainBytes);
  const keyBuf = derivePaybuzzContentKey(input.authorMasterSeedBytes, plainSha256);
  const iv = input.ivHex
    ? Buffer.from(normalizeHex(input.ivHex, 12, 'ivHex'), 'hex')
    : crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuf, iv);
  const ciphertextBuffer = Buffer.concat([cipher.update(plainBytes), cipher.final()]);
  const authTagBuffer = cipher.getAuthTag();
  const cipherSha256 = computeSha256Hex(ciphertextBuffer);

  return {
    plainSha256,
    keySaltHex: plainSha256,
    contentKeyHex: keyBuf.toString('hex'),
    ivHex: iv.toString('hex'),
    authTagHex: authTagBuffer.toString('hex'),
    cipherSha256,
    ciphertextBuffer,
    ciphertextBase64: ciphertextBuffer.toString('base64'),
  };
}

export function decryptPaybuzzContent(input: {
  ciphertextBuffer: Buffer;
  contentKeyHex: string;
  ivHex: string;
  authTagHex: string;
  expectedCipherSha256?: string;
  expectedPlainSha256?: string;
}): { plaintextMarkdown: string; plainSha256: string; cipherSha256: string } {
  if (!Buffer.isBuffer(input.ciphertextBuffer) || input.ciphertextBuffer.length === 0) {
    throw new Error('PAYBUZZ_EMPTY_CIPHERTEXT: ciphertextBuffer must be non-empty');
  }
  const cipherSha256 = computeSha256Hex(input.ciphertextBuffer);
  if (input.expectedCipherSha256) {
    const expectedCipher = normalizeHex(input.expectedCipherSha256, 32, 'expectedCipherSha256');
    if (cipherSha256 !== expectedCipher) {
      throw new Error('PAYBUZZ_CIPHERTEXT_HASH_MISMATCH: ciphertext sha256 does not match pin metadata');
    }
  }

  const keyBuf = Buffer.from(normalizeHex(input.contentKeyHex, 32, 'contentKeyHex'), 'hex');
  const ivBuf = Buffer.from(normalizeHex(input.ivHex, 12, 'ivHex'), 'hex');
  const authTagBuf = Buffer.from(normalizeHex(input.authTagHex, 16, 'authTagHex'), 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuf, ivBuf);
  decipher.setAuthTag(authTagBuf);
  const plainBuf = Buffer.concat([decipher.update(input.ciphertextBuffer), decipher.final()]);
  const plainSha256 = computeSha256Hex(plainBuf);

  if (input.expectedPlainSha256) {
    const expectedPlain = normalizeHex(input.expectedPlainSha256, 32, 'expectedPlainSha256');
    if (plainSha256 !== expectedPlain) {
      throw new Error('PAYBUZZ_PLAINTEXT_HASH_MISMATCH: decrypted plaintext digest mismatch');
    }
  }

  return {
    plaintextMarkdown: plainBuf.toString('utf8'),
    plainSha256,
    cipherSha256,
  };
}

export function buildPaybuzzVipChallenge(input: {
  paybuzzPinId: string;
  readerGlobalMetaId: string;
  timestamp: number;
}): string {
  const pinId = String(input.paybuzzPinId ?? '').trim().toLowerCase();
  const readerId = String(input.readerGlobalMetaId ?? '').trim();
  const ts = Math.trunc(Number(input.timestamp));
  if (!pinId) throw new Error('paybuzzPinId is required');
  if (!readerId) throw new Error('readerGlobalMetaId is required');
  if (!Number.isFinite(ts) || ts <= 0) throw new Error('timestamp must be a positive unix epoch second');
  return `${PAYBUZZ_VIP_CHALLENGE_PREFIX}${pinId}:${readerId}:${ts}`;
}

export async function signPaybuzzVipChallenge(input: {
  mnemonic: string;
  path?: string | null;
  paybuzzPinId: string;
  readerGlobalMetaId: string;
  timestamp: number;
}): Promise<{ challenge: string; signatureHex: string; signatureBase64: string; publicKey: string }> {
  const challenge = buildPaybuzzVipChallenge({
    paybuzzPinId: input.paybuzzPinId,
    readerGlobalMetaId: input.readerGlobalMetaId,
    timestamp: input.timestamp,
  });
  const { signature, publicKey } = await signMvcAddressMessage({
    mnemonic: input.mnemonic,
    path: (input.path || DEFAULT_WALLET_PATH).trim(),
    message: challenge,
  });
  const sigBuf = Buffer.from(signature, 'base64');
  return {
    challenge,
    signatureHex: sigBuf.toString('hex'),
    signatureBase64: signature,
    publicKey,
  };
}

export function verifyPaybuzzVipChallengeSignature(input: {
  paybuzzPinId: string;
  readerGlobalMetaId: string;
  timestamp: number;
  holderAddress: string;
  signature: string;
  nowSec?: number;
  windowSeconds?: number;
}): { valid: boolean; reason?: string } {
  const nowSec = input.nowSec ?? Math.floor(Date.now() / 1000);
  const windowSec = input.windowSeconds ?? PAYBUZZ_VIP_WINDOW_SECONDS;
  const ts = Math.trunc(Number(input.timestamp));
  if (!Number.isFinite(ts) || ts <= 0) {
    return { valid: false, reason: 'INVALID_TIMESTAMP' };
  }
  if (Math.abs(nowSec - ts) > windowSec) {
    return { valid: false, reason: 'TIMESTAMP_EXPIRED' };
  }

  const holderAddress = String(input.holderAddress ?? '').trim();
  if (!holderAddress) {
    return { valid: false, reason: 'MISSING_HOLDER_ADDRESS' };
  }

  const rawSig = String(input.signature ?? '').trim();
  if (!rawSig) {
    return { valid: false, reason: 'MISSING_SIGNATURE' };
  }

  let sigBase64 = rawSig;
  if (/^[0-9a-fA-F]{130}$/.test(rawSig)) {
    sigBase64 = Buffer.from(rawSig, 'hex').toString('base64');
  } else {
    const decoded = Buffer.from(rawSig, 'base64');
    if (decoded.length !== 65) {
      return { valid: false, reason: 'INVALID_SIGNATURE_FORMAT' };
    }
  }

  try {
    const challenge = buildPaybuzzVipChallenge({
      paybuzzPinId: input.paybuzzPinId,
      readerGlobalMetaId: input.readerGlobalMetaId,
      timestamp: ts,
    });
    const message = new mvc.Message(challenge);
    const verified = message.verify(holderAddress, sigBase64);
    if (verified !== true) {
      return { valid: false, reason: 'SIGNATURE_MISMATCH' };
    }
    return { valid: true };
  } catch {
    return { valid: false, reason: 'SIGNATURE_VERIFICATION_ERROR' };
  }
}
