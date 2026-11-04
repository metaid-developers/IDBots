/**
 * Local store for the encrypted payment receiving-info blob (S3 slice 1).
 *
 * Single-row table holding ONLY the ciphertext (base64 of
 * nonce||tag||ciphertext, see paymentInfoCrypto) plus a plaintext updatedAt
 * timestamp for change audit — no plaintext receiving field ever touches
 * disk, and nothing from this table ever goes on-chain. The image archive
 * rides inside the encrypted JSON blob (data URL), so one cipher covers the
 * whole PaymentReceivingInfo.
 */

import type { SqliteDatabase as Database } from '../sqliteTypes';

const PAYMENT_INFO_ROW_ID = 1;

interface PaymentInfoRow {
  id: number;
  cipher_base64: string;
  updated_at: number;
}

export class PaymentInfoStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS payment_receiving_info (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        cipher_base64 TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  private getOne(sql: string, params: (string | number)[] = []): PaymentInfoRow | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as unknown as PaymentInfoRow;
  }

  /** The stored ciphertext + plaintext audit timestamp, or null when never saved. */
  get(): { cipher: Buffer; updatedAt: number } | null {
    const row = this.getOne(
      'SELECT id, cipher_base64, updated_at FROM payment_receiving_info WHERE id = ? LIMIT 1',
      [PAYMENT_INFO_ROW_ID],
    );
    if (!row) return null;
    return { cipher: Buffer.from(row.cipher_base64, 'base64'), updatedAt: row.updated_at };
  }

  /** Overwrite the single row with a fresh ciphertext (updates are full re-encrypts). */
  save(cipher: Buffer): number {
    const updatedAt = Date.now();
    this.db.run(
      `INSERT INTO payment_receiving_info (id, cipher_base64, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET cipher_base64 = excluded.cipher_base64, updated_at = excluded.updated_at`,
      [PAYMENT_INFO_ROW_ID, cipher.toString('base64'), updatedAt],
    );
    this.saveDb();
    return updatedAt;
  }

  /** Remove the row entirely (设置页「清空」). In-flight orders keep their own snapshots. */
  clear(): void {
    this.db.run('DELETE FROM payment_receiving_info WHERE id = ?', [PAYMENT_INFO_ROW_ID]);
    this.saveDb();
  }
}
