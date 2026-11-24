/**
 * At-rest encryption for wallet mnemonics stored in SQLite (`metabot_wallets`
 * and `user_identity`) backed by Electron's OS-level `safeStorage`
 * (macOS Keychain, Windows DPAPI, Linux Secret Service / KWallet).
 *
 * Design invariants:
 * - Ciphertext is tagged with `enc:v1:<base64>` so encrypted and legacy
 *   plaintext rows are unambiguously distinguishable and migration is 100%
 *   idempotent.
 * - Headless / non-Electron / test environments where `safeStorage` is
 *   unavailable fall back gracefully to plaintext storage rather than breaking
 *   startup or CI.
 * - Existing plaintext rows remain readable even before migration runs.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';

export const MNEMONIC_ENC_PREFIX = 'enc:v1:';

export interface MnemonicVaultBackend {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

let customBackendForTests: MnemonicVaultBackend | null = null;
let cachedElectronSafeStorage: MnemonicVaultBackend | null | undefined = undefined;

function getElectronSafeStorage(): MnemonicVaultBackend | null {
  if (customBackendForTests) {
    return customBackendForTests;
  }
  if (cachedElectronSafeStorage !== undefined) {
    return cachedElectronSafeStorage;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electron = require('electron') as { safeStorage?: MnemonicVaultBackend };
    const ss = electron?.safeStorage;
    if (
      ss
      && typeof ss.isEncryptionAvailable === 'function'
      && typeof ss.encryptString === 'function'
      && typeof ss.decryptString === 'function'
    ) {
      cachedElectronSafeStorage = ss;
      return ss;
    }
  } catch {
    // Running outside Electron (e.g. plain Node tests or headless CLI).
  }
  cachedElectronSafeStorage = null;
  return null;
}

/** Override safeStorage backend in unit tests; pass `null` to restore default. */
export function setMnemonicVaultBackendForTests(backend: MnemonicVaultBackend | null): void {
  customBackendForTests = backend;
}

export function isEncryptedMnemonic(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(MNEMONIC_ENC_PREFIX);
}

export function isMnemonicEncryptionAvailable(): boolean {
  const ss = getElectronSafeStorage();
  if (!ss) return false;
  try {
    return ss.isEncryptionAvailable() === true;
  } catch {
    return false;
  }
}

/**
 * Encrypt a plaintext mnemonic for SQLite persistence when OS encryption is
 * available. Already-encrypted strings pass through unchanged (idempotent).
 */
export function encryptMnemonicAtRest(mnemonic: string): string {
  const value = String(mnemonic ?? '');
  if (!value || isEncryptedMnemonic(value)) {
    return value;
  }
  const ss = getElectronSafeStorage();
  if (!ss) return value;
  try {
    if (!ss.isEncryptionAvailable()) {
      return value;
    }
    const encrypted = ss.encryptString(value);
    return `${MNEMONIC_ENC_PREFIX}${encrypted.toString('base64')}`;
  } catch {
    return value;
  }
}

/**
 * Decrypt a stored mnemonic value. Legacy plaintext values pass through
 * unchanged so existing databases remain seamlessly readable.
 */
export function decryptMnemonicAtRest(stored: string): string {
  const value = String(stored ?? '');
  if (!isEncryptedMnemonic(value)) {
    return value;
  }
  const ss = getElectronSafeStorage();
  if (!ss) {
    throw new Error('Cannot decrypt at-rest mnemonic: OS safeStorage backend is unavailable');
  }
  const payload = value.slice(MNEMONIC_ENC_PREFIX.length);
  const buffer = Buffer.from(payload, 'base64');
  return ss.decryptString(buffer);
}

/**
 * Best-effort variant for non-fatal background scanning (e.g. secret egress
 * fingerprint registration). Returns null if a row cannot be decrypted.
 */
export function tryDecryptMnemonicAtRest(stored: string | null | undefined): string | null {
  const value = String(stored ?? '').trim();
  if (!value) return null;
  try {
    const plain = decryptMnemonicAtRest(value).trim();
    return plain || null;
  } catch {
    return null;
  }
}

export interface MnemonicMigrationResult {
  encryptedWallets: number;
  encryptedUserIdentity: number;
  skipped: boolean;
}

/**
 * Safe, idempotent first-run migration: encrypts any legacy plaintext rows in
 * `metabot_wallets` and `user_identity` in-place once OS encryption is ready.
 */
export function migratePlaintextMnemonicsAtRest(
  db: Database,
  saveDb: () => void,
): MnemonicMigrationResult {
  if (!isMnemonicEncryptionAvailable()) {
    return { encryptedWallets: 0, encryptedUserIdentity: 0, skipped: true };
  }

  let encryptedWallets = 0;
  let encryptedUserIdentity = 0;

  try {
    const walletRows = db.exec('SELECT id, mnemonic FROM metabot_wallets');
    const pendingWalletUpdates: Array<{ id: number; encrypted: string }> = [];
    for (const row of walletRows[0]?.values ?? []) {
      const id = Number(row[0]);
      const raw = typeof row[1] === 'string' ? row[1] : '';
      if (!raw.trim() || isEncryptedMnemonic(raw)) continue;
      const encrypted = encryptMnemonicAtRest(raw);
      if (isEncryptedMnemonic(encrypted)) {
        pendingWalletUpdates.push({ id, encrypted });
      }
    }
    if (pendingWalletUpdates.length > 0) {
      // metabot_wallets carries an append-only BEFORE UPDATE trigger; drop it
      // only for this one-shot plaintext->ciphertext migration and restore it
      // unconditionally in finally so the append-only invariant remains intact.
      const triggerExists =
        (db.exec(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'prevent_metabot_wallets_update'"
        )[0]?.values?.length ?? 0) > 0;
      if (triggerExists) {
        db.run('DROP TRIGGER IF EXISTS prevent_metabot_wallets_update');
      }
      try {
        for (const item of pendingWalletUpdates) {
          db.run('UPDATE metabot_wallets SET mnemonic = ? WHERE id = ?', [item.encrypted, item.id]);
          encryptedWallets += 1;
        }
      } finally {
        if (triggerExists) {
          db.run(`
            CREATE TRIGGER IF NOT EXISTS prevent_metabot_wallets_update
            BEFORE UPDATE ON metabot_wallets
            BEGIN
              SELECT RAISE(ABORT, 'Security Error: metabot_wallets table is append-only. Updates are strictly prohibited.');
            END;
          `);
        }
      }
    }
  } catch {
    // Table may not exist yet in partial test DBs.
  }

  try {
    const identityRows = db.exec('SELECT id, mnemonic FROM user_identity');
    for (const row of identityRows[0]?.values ?? []) {
      const id = Number(row[0]);
      const raw = typeof row[1] === 'string' ? row[1] : '';
      if (!raw.trim() || isEncryptedMnemonic(raw)) continue;
      const encrypted = encryptMnemonicAtRest(raw);
      if (isEncryptedMnemonic(encrypted)) {
        db.run('UPDATE user_identity SET mnemonic = ? WHERE id = ?', [encrypted, id]);
        encryptedUserIdentity += 1;
      }
    }
  } catch {
    // Table may not exist yet in partial test DBs.
  }

  if (encryptedWallets > 0 || encryptedUserIdentity > 0) {
    saveDb();
  }

  return { encryptedWallets, encryptedUserIdentity, skipped: false };
}
