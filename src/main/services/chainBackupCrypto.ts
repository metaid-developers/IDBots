/**
 * Chain-backup cryptography.
 *
 * The backup key is derived deterministically from the user's mnemonic alone
 * (no extra passphrase, per the 2026-10-10 owner decision): any device that
 * imports the mnemonic re-derives the same key.
 *
 *   seed = bip39.mnemonicToSeedSync(mnemonic)
 *   key  = HKDF-SHA256(ikm = seed,
 *                      salt = "idbots-backup-v1" + userGlobalMetaId,
 *                      info = "backup-key", len = 32)
 *
 * Objects are encrypted with AES-256-GCM; the wire format is
 * `nonce(12) || tag(16) || ciphertext`. Object ids are
 * `sha256(canonicalJSON(plaintext))` which gives content addressing, dedup
 * and incrementality for free.
 *
 * Pure module: no Electron imports, directly unit-testable.
 */

import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { mnemonicToSeedSync } from '@scure/bip39';

export const CHAIN_BACKUP_KDF_SALT_PREFIX = 'idbots-backup-v1';
export const CHAIN_BACKUP_KDF_INFO = 'backup-key';
export const CHAIN_BACKUP_KEY_BYTES = 32;
export const CHAIN_BACKUP_NONCE_BYTES = 12;
export const CHAIN_BACKUP_TAG_BYTES = 16;

/** Derive the 32-byte backup key from the user mnemonic. Deterministic. */
export function deriveBackupKey(mnemonic: string, userGlobalMetaId: string): Buffer {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  const seed = mnemonicToSeedSync(normalized);
  const salt = `${CHAIN_BACKUP_KDF_SALT_PREFIX}${userGlobalMetaId.trim()}`;
  const key = hkdfSync('sha256', Buffer.from(seed), Buffer.from(salt, 'utf8'), CHAIN_BACKUP_KDF_INFO, CHAIN_BACKUP_KEY_BYTES);
  return Buffer.from(key);
}

/** Canonical JSON: object keys sorted recursively so hashing is stable. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input).sort()) {
      const v = input[key];
      if (v === undefined) continue;
      out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/** Content-addressing id for a backup object (hex sha256 of canonical JSON). */
export function objectId(plaintext: unknown): string {
  return createHash('sha256').update(canonicalJson(plaintext), 'utf8').digest('hex');
}

const DEVICE_LOCAL_METABOT_REFERENCES = new Set([
  'metabot_id',
  'source_metabot_id',
  'boss_id',
  'twin_metabot_id',
  'assignee_metabot_id',
  'worker_metabot_id',
]);

function withoutDeviceLocalReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDeviceLocalReferences);
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      output[key] = DEVICE_LOCAL_METABOT_REFERENCES.has(key) ? null : withoutDeviceLocalReferences(nested);
    }
    return output;
  }
  return value;
}

/** Device-independent object identity; the encrypted payload still retains restorable local references. */
export function chainBackupObjectId(kind: string, data: Record<string, unknown>): string {
  return objectId({ kind, data: withoutDeviceLocalReferences(data) });
}

/** Encrypt raw bytes: returns nonce || tag || ciphertext. */
export function encryptBytes(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(CHAIN_BACKUP_NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, body]);
}

/** Encrypt a JSON-serializable value: returns nonce || tag || ciphertext. */
export function encryptJson(key: Buffer, plaintext: unknown): Buffer {
  return encryptBytes(key, Buffer.from(canonicalJson(plaintext), 'utf8'));
}

/** Decrypt a buffer produced by encryptBytes/encryptJson. Throws on tamper/wrong key. */
export function decryptBytes(key: Buffer, payload: Buffer): Buffer {
  if (payload.length < CHAIN_BACKUP_NONCE_BYTES + CHAIN_BACKUP_TAG_BYTES) {
    throw new Error('chain-backup payload too short');
  }
  const nonce = payload.subarray(0, CHAIN_BACKUP_NONCE_BYTES);
  const tag = payload.subarray(CHAIN_BACKUP_NONCE_BYTES, CHAIN_BACKUP_NONCE_BYTES + CHAIN_BACKUP_TAG_BYTES);
  const body = payload.subarray(CHAIN_BACKUP_NONCE_BYTES + CHAIN_BACKUP_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Decrypt a buffer produced by encryptJson. Throws on tamper/wrong key. */
export function decryptJson(key: Buffer, payload: Buffer): unknown {
  return JSON.parse(decryptBytes(key, payload).toString('utf8'));
}
