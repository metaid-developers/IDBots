/**
 * SQLite Persistence Store for PayBuzz (/protocols/paybuzz)
 *
 * Tables (all idempotently created on DB open & upgrade):
 * - `paybuzz_authored_items`: author-side encrypted article index & derived content keys
 * - `paybuzz_used_payments`: replay protection ledger (`payment_tx_id PRIMARY KEY`)
 * - `paybuzz_unlocked_cache`: reader-side decrypted article cache for instant offline re-reads
 * - `paybuzz_royalty_ledger`: author-side silent royalty receipts
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';

export interface PaybuzzAuthoredItemRecord {
  paybuzzPinId: string;
  metabotId: number;
  cipherSha256: string;
  keySaltHex: string;
  contentKeyHex: string;
  unlockRulesJson: string;
  title?: string;
  preview?: string;
  wordCount?: number;
  createdAt: number;
}

export interface PaybuzzUsedPaymentRecord {
  paymentTxId: string;
  paybuzzPinId: string;
  readerGlobalMetaId: string;
  assetKey: string;
  amountBase: string;
  createdAt: number;
}

export interface PaybuzzUnlockedCacheRecord {
  paybuzzPinId: string;
  contentKeyHex: string;
  decryptedMarkdown: string;
  grantedVia: 'vip-nft' | 'token' | 'author';
  title?: string;
  authorMetaId?: string;
  unlockedAt: number;
}

export interface PaybuzzRoyaltyRecord {
  id: number;
  metabotId: number;
  paybuzzPinId: string;
  readerGlobalMetaId: string;
  assetKey: string;
  symbol?: string;
  amountBase: string;
  amountDisplay?: string;
  paymentTxId: string;
  createdAt: number;
}

export function ensurePaybuzzTables(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS paybuzz_authored_items (
      paybuzz_pin_id TEXT PRIMARY KEY,
      metabot_id INTEGER NOT NULL,
      cipher_sha256 TEXT NOT NULL,
      key_salt_hex TEXT NOT NULL,
      content_key_hex TEXT NOT NULL,
      unlock_rules_json TEXT NOT NULL,
      title TEXT,
      preview TEXT,
      word_count INTEGER,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_paybuzz_authored_metabot
      ON paybuzz_authored_items(metabot_id, created_at);
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_paybuzz_authored_cipher
      ON paybuzz_authored_items(cipher_sha256);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS paybuzz_used_payments (
      payment_tx_id TEXT PRIMARY KEY,
      paybuzz_pin_id TEXT NOT NULL,
      reader_global_meta_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      amount_base TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_paybuzz_used_payments_article_reader
      ON paybuzz_used_payments(paybuzz_pin_id, reader_global_meta_id);
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS paybuzz_unlocked_cache (
      paybuzz_pin_id TEXT PRIMARY KEY,
      content_key_hex TEXT NOT NULL,
      decrypted_markdown TEXT NOT NULL,
      granted_via TEXT NOT NULL,
      title TEXT,
      author_meta_id TEXT,
      unlocked_at INTEGER NOT NULL
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS paybuzz_royalty_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metabot_id INTEGER NOT NULL,
      paybuzz_pin_id TEXT NOT NULL,
      reader_global_meta_id TEXT NOT NULL,
      asset_key TEXT NOT NULL,
      symbol TEXT,
      amount_base TEXT NOT NULL,
      amount_display TEXT,
      payment_tx_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_paybuzz_royalty_metabot
      ON paybuzz_royalty_ledger(metabot_id, created_at);
  `);
}

function normPinId(pinId: string): string {
  return String(pinId ?? '').trim().toLowerCase();
}

function normTxId(txId: string): string {
  return String(txId ?? '').trim().toLowerCase();
}

export function upsertPaybuzzAuthoredItem(
  db: Database,
  input: PaybuzzAuthoredItemRecord,
  saveFn?: () => void,
): void {
  ensurePaybuzzTables(db);
  const pinId = normPinId(input.paybuzzPinId);
  if (!pinId) throw new Error('paybuzzPinId is required');
  db.run(
    `INSERT OR REPLACE INTO paybuzz_authored_items (
      paybuzz_pin_id, metabot_id, cipher_sha256, key_salt_hex, content_key_hex,
      unlock_rules_json, title, preview, word_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      pinId,
      input.metabotId,
      input.cipherSha256.toLowerCase(),
      input.keySaltHex.toLowerCase(),
      input.contentKeyHex.toLowerCase(),
      input.unlockRulesJson,
      input.title ?? null,
      input.preview ?? null,
      input.wordCount ?? null,
      input.createdAt,
    ],
  );
  saveFn?.();
}

export function getPaybuzzAuthoredItem(
  db: Database,
  paybuzzPinId: string,
): PaybuzzAuthoredItemRecord | null {
  ensurePaybuzzTables(db);
  const pinId = normPinId(paybuzzPinId);
  if (!pinId) return null;
  const res = db.exec(
    `SELECT paybuzz_pin_id, metabot_id, cipher_sha256, key_salt_hex, content_key_hex,
            unlock_rules_json, title, preview, word_count, created_at
     FROM paybuzz_authored_items
     WHERE paybuzz_pin_id = ?
     LIMIT 1`,
    [pinId],
  );
  const row = res[0]?.values?.[0];
  if (!row) return null;
  return {
    paybuzzPinId: String(row[0] ?? ''),
    metabotId: Number(row[1] ?? 0),
    cipherSha256: String(row[2] ?? ''),
    keySaltHex: String(row[3] ?? ''),
    contentKeyHex: String(row[4] ?? ''),
    unlockRulesJson: String(row[5] ?? '{}'),
    ...(row[6] != null ? { title: String(row[6]) } : {}),
    ...(row[7] != null ? { preview: String(row[7]) } : {}),
    ...(row[8] != null ? { wordCount: Number(row[8]) } : {}),
    createdAt: Number(row[9] ?? 0),
  };
}

export function getPaybuzzUsedPayment(
  db: Database,
  paymentTxId: string,
): PaybuzzUsedPaymentRecord | null {
  ensurePaybuzzTables(db);
  const txId = normTxId(paymentTxId);
  if (!txId) return null;
  const res = db.exec(
    `SELECT payment_tx_id, paybuzz_pin_id, reader_global_meta_id, asset_key, amount_base, created_at
     FROM paybuzz_used_payments
     WHERE payment_tx_id = ?
     LIMIT 1`,
    [txId],
  );
  const row = res[0]?.values?.[0];
  if (!row) return null;
  return {
    paymentTxId: String(row[0] ?? ''),
    paybuzzPinId: String(row[1] ?? ''),
    readerGlobalMetaId: String(row[2] ?? ''),
    assetKey: String(row[3] ?? ''),
    amountBase: String(row[4] ?? '0'),
    createdAt: Number(row[5] ?? 0),
  };
}

/**
 * Atomically claim `payment_tx_id` for `(paybuzzPinId, readerGlobalMetaId)`.
 * Returns:
 * - `'claimed'` when newly inserted
 * - `'idempotent_hit'` when the exact same `(paybuzzPinId, readerGlobalMetaId)` already claimed it
 * - `'replay_conflict'` when a different article or reader tries to reuse the same txid (S-06)
 */
export function claimPaybuzzUsedPayment(
  db: Database,
  input: PaybuzzUsedPaymentRecord,
  saveFn?: () => void,
): { status: 'claimed' | 'idempotent_hit' | 'replay_conflict'; existing?: PaybuzzUsedPaymentRecord } {
  ensurePaybuzzTables(db);
  const paymentTxId = normTxId(input.paymentTxId);
  const paybuzzPinId = normPinId(input.paybuzzPinId);
  const readerGlobalMetaId = String(input.readerGlobalMetaId ?? '').trim();
  if (!paymentTxId || !paybuzzPinId || !readerGlobalMetaId) {
    throw new Error('paymentTxId, paybuzzPinId, and readerGlobalMetaId are required');
  }

  const existing = getPaybuzzUsedPayment(db, paymentTxId);
  if (existing) {
    if (
      existing.paybuzzPinId === paybuzzPinId &&
      existing.readerGlobalMetaId === readerGlobalMetaId
    ) {
      return { status: 'idempotent_hit', existing };
    }
    return { status: 'replay_conflict', existing };
  }

  try {
    db.run(
      `INSERT INTO paybuzz_used_payments (
        payment_tx_id, paybuzz_pin_id, reader_global_meta_id, asset_key, amount_base, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        paymentTxId,
        paybuzzPinId,
        readerGlobalMetaId,
        input.assetKey.toLowerCase(),
        input.amountBase,
        input.createdAt,
      ],
    );
    saveFn?.();
    return { status: 'claimed' };
  } catch (err) {
    const after = getPaybuzzUsedPayment(db, paymentTxId);
    if (after) {
      if (
        after.paybuzzPinId === paybuzzPinId &&
        after.readerGlobalMetaId === readerGlobalMetaId
      ) {
        return { status: 'idempotent_hit', existing: after };
      }
      return { status: 'replay_conflict', existing: after };
    }
    throw err;
  }
}

export function upsertPaybuzzUnlockedCache(
  db: Database,
  input: PaybuzzUnlockedCacheRecord,
  saveFn?: () => void,
): void {
  ensurePaybuzzTables(db);
  const pinId = normPinId(input.paybuzzPinId);
  if (!pinId) throw new Error('paybuzzPinId is required');
  db.run(
    `INSERT OR REPLACE INTO paybuzz_unlocked_cache (
      paybuzz_pin_id, content_key_hex, decrypted_markdown, granted_via, title, author_meta_id, unlocked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      pinId,
      input.contentKeyHex.toLowerCase(),
      input.decryptedMarkdown,
      input.grantedVia,
      input.title ?? null,
      input.authorMetaId ?? null,
      input.unlockedAt,
    ],
  );
  saveFn?.();
}

export function getPaybuzzUnlockedCache(
  db: Database,
  paybuzzPinId: string,
): PaybuzzUnlockedCacheRecord | null {
  ensurePaybuzzTables(db);
  const pinId = normPinId(paybuzzPinId);
  if (!pinId) return null;
  const res = db.exec(
    `SELECT paybuzz_pin_id, content_key_hex, decrypted_markdown, granted_via, title, author_meta_id, unlocked_at
     FROM paybuzz_unlocked_cache
     WHERE paybuzz_pin_id = ?
     LIMIT 1`,
    [pinId],
  );
  const row = res[0]?.values?.[0];
  if (!row) return null;
  return {
    paybuzzPinId: String(row[0] ?? ''),
    contentKeyHex: String(row[1] ?? ''),
    decryptedMarkdown: String(row[2] ?? ''),
    grantedVia: String(row[3] ?? 'token') as PaybuzzUnlockedCacheRecord['grantedVia'],
    ...(row[4] != null ? { title: String(row[4]) } : {}),
    ...(row[5] != null ? { authorMetaId: String(row[5]) } : {}),
    unlockedAt: Number(row[6] ?? 0),
  };
}

export function recordPaybuzzRoyalty(
  db: Database,
  input: Omit<PaybuzzRoyaltyRecord, 'id'>,
  saveFn?: () => void,
): void {
  ensurePaybuzzTables(db);
  db.run(
    `INSERT INTO paybuzz_royalty_ledger (
      metabot_id, paybuzz_pin_id, reader_global_meta_id, asset_key, symbol, amount_base, amount_display, payment_tx_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.metabotId,
      normPinId(input.paybuzzPinId),
      input.readerGlobalMetaId,
      input.assetKey.toLowerCase(),
      input.symbol ?? null,
      input.amountBase,
      input.amountDisplay ?? null,
      normTxId(input.paymentTxId),
      input.createdAt,
    ],
  );
  saveFn?.();
}

export function getPaybuzzRoyaltySummary(
  db: Database,
  metabotId: number,
  sinceMs?: number,
): { count: number; items: PaybuzzRoyaltyRecord[] } {
  ensurePaybuzzTables(db);
  const cutoff = sinceMs ?? 0;
  const res = db.exec(
    `SELECT id, metabot_id, paybuzz_pin_id, reader_global_meta_id, asset_key, symbol, amount_base, amount_display, payment_tx_id, created_at
     FROM paybuzz_royalty_ledger
     WHERE metabot_id = ? AND created_at >= ?
     ORDER BY created_at DESC
     LIMIT 50`,
    [metabotId, cutoff],
  );
  const rows = res[0]?.values ?? [];
  const items: PaybuzzRoyaltyRecord[] = rows.map((row) => ({
    id: Number(row[0] ?? 0),
    metabotId: Number(row[1] ?? 0),
    paybuzzPinId: String(row[2] ?? ''),
    readerGlobalMetaId: String(row[3] ?? ''),
    assetKey: String(row[4] ?? ''),
    ...(row[5] != null ? { symbol: String(row[5]) } : {}),
    amountBase: String(row[6] ?? '0'),
    ...(row[7] != null ? { amountDisplay: String(row[7]) } : {}),
    paymentTxId: String(row[8] ?? ''),
    createdAt: Number(row[9] ?? 0),
  }));
  return { count: items.length, items };
}
