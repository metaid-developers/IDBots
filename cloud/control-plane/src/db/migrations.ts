import type Database from 'better-sqlite3';

/**
 * Versioned, idempotent schema migrations (REQ-B-5). Each migration runs
 * exactly once, inside a transaction, recorded in `schema_migrations`.
 * Migrations must never drop or rewrite user rows.
 */

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

function migration1(db: Database.Database): void {
  db.exec(`
    CREATE TABLE users (
      id            TEXT PRIMARY KEY,
      phone_e164    TEXT NOT NULL UNIQUE,
      display_name  TEXT NOT NULL,
      locale        TEXT NOT NULL DEFAULT 'zh',
      status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
      invite_code   TEXT,
      created_at    INTEGER NOT NULL,
      last_login_at INTEGER
    );

    CREATE TABLE invites (
      code       TEXT PRIMARY KEY,
      max_uses   INTEGER NOT NULL,
      used_count INTEGER NOT NULL DEFAULT 0,
      with_redeem INTEGER NOT NULL DEFAULT 0 CHECK (with_redeem IN (0, 1)),
      note       TEXT,
      expires_at INTEGER,
      disabled   INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE redeem_codes (
      code_enc          TEXT NOT NULL,
      code_hash         TEXT NOT NULL UNIQUE,
      batch_note        TEXT,
      imported_at       INTEGER NOT NULL,
      assigned_user_id  TEXT UNIQUE,
      assigned_at       INTEGER
    );

    CREATE TABLE sessions (
      token_hash   TEXT PRIMARY KEY,
      user_id      TEXT NOT NULL REFERENCES users(id),
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at   INTEGER NOT NULL,
      user_agent   TEXT,
      ip           TEXT
    );
    CREATE INDEX idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE sms_codes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      phone_e164  TEXT NOT NULL,
      purpose     TEXT NOT NULL CHECK (purpose IN ('login', 'reverify')),
      code_hash   TEXT NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER,
      ip          TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_sms_codes_phone_created ON sms_codes(phone_e164, created_at);
    CREATE INDEX idx_sms_codes_ip_created ON sms_codes(ip, created_at);

    CREATE TABLE tenants (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL UNIQUE REFERENCES users(id),
      host_id             TEXT NOT NULL,
      container_name      TEXT NOT NULL UNIQUE,
      volume_name         TEXT NOT NULL UNIQUE,
      image               TEXT NOT NULL,
      previous_image      TEXT,
      gateway_secret_enc  TEXT NOT NULL,
      status              TEXT NOT NULL,
      phase               TEXT,
      app_version         TEXT,
      contract_version    TEXT,
      last_error          TEXT,
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX idx_tenants_status ON tenants(status);

    CREATE TABLE hosts (
      id        TEXT PRIMARY KEY,
      docker_url TEXT NOT NULL,
      capacity  INTEGER NOT NULL,
      status    TEXT NOT NULL
    );

    CREATE TABLE reverify (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL REFERENCES users(id),
      purpose     TEXT NOT NULL,
      expires_at  INTEGER NOT NULL,
      consumed_at INTEGER
    );
    CREATE INDEX idx_reverify_user_id ON reverify(user_id);

    CREATE TABLE deletion_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    TEXT NOT NULL REFERENCES users(id),
      reason     TEXT,
      status     TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'exported', 'deleted', 'rejected')),
      created_at INTEGER NOT NULL,
      closed_at  INTEGER
    );
    CREATE INDEX idx_deletion_requests_user_id ON deletion_requests(user_id);

    CREATE TABLE audit_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      at         INTEGER NOT NULL,
      actor      TEXT NOT NULL,
      action     TEXT NOT NULL,
      target     TEXT,
      detail_json TEXT
    );
    CREATE INDEX idx_audit_log_at ON audit_log(at);
  `);
}

/**
 * Migration 2 (voice channel, NEW capability — no C2/C3 contract change):
 * per-session ASR usage rows. One row per gateway connection, inserted at
 * open (ended_at NULL, seconds 0) and finalized at close. The daily quota is
 * a SUM over these rows; rows are never dropped. Crash leftovers (ended_at
 * NULL) are capped at maxSessionSeconds by the quota query, so they
 * self-heal instead of permanently eating the user's budget.
 */
function migration2(db: Database.Database): void {
  db.exec(`
    CREATE TABLE asr_usage (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     TEXT NOT NULL REFERENCES users(id),
      upstream    TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      seconds     REAL NOT NULL DEFAULT 0,
      audio_bytes INTEGER NOT NULL DEFAULT 0,
      finished    INTEGER NOT NULL DEFAULT 0 CHECK (finished IN (0, 1)),
      close_code  INTEGER
    );
    CREATE INDEX idx_asr_usage_user_started ON asr_usage(user_id, started_at);
  `);
}

/**
 * Migration 3 (payment credit channel, NEW capability — no C2/C3 contract
 * change): operator credit ledger. One row per granted credit: who granted
 * (actor), when (created_at), to whom (user_id), how much (bytes_total,
 * integer bytes — never floats), and on what grounds (reason). A grant that
 * belongs to an order carries the C4 orderId in reference_key; the UNIQUE
 * index makes re-submission of the same reference return the existing row
 * instead of a second grant. Records only — the byte-level application to a
 * tenant traffic account happens through the upstream traffic admin channel,
 * which the operator references in `reason`.
 */
function migration3(db: Database.Database): void {
  db.exec(`
    CREATE TABLE credit_ledger (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT NOT NULL REFERENCES users(id),
      bytes_total   INTEGER NOT NULL CHECK (bytes_total > 0),
      source        TEXT NOT NULL CHECK (source IN ('manual', 'bundle-order')),
      reason        TEXT NOT NULL,
      actor         TEXT NOT NULL,
      reference_key TEXT UNIQUE,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX idx_credit_ledger_user ON credit_ledger(user_id, created_at);
  `);
}

/**
 * Migration 4 (credit application, NEW capability — no C2/C3 contract change):
 * track whether a ledger grant actually reached the user's upstream traffic
 * account, and carry the single-use upstream redeem code that delivers it.
 *
 * Why a code and not a key: the owner's decision (plan B) is that the control
 * plane must never hold a credential that can mint credit on ANY account. The
 * tenant applies the bytes itself through the identity-signed redeem-code
 * channel it already owns; the operator only supplies the one code that this
 * grant is worth. `apply_code_enc` is AES-256-GCM ciphertext under
 * CP_MASTER_KEY, exactly like gateway secrets, and is never returned by the
 * admin list routes.
 *
 * `apply_state`:
 *   pending      — recorded, not yet in the user's upstream account.
 *   applied      — the tenant reported a successful redemption; applied_*
 *                  columns carry the evidence (codeId / trafficBytes /
 *                  balanceAfter) the tenant observed upstream.
 *   not-required — the upstream already credited the bytes through another
 *                  channel (bundle-order rows: the payment webhook credits
 *                  traffic before this row is written). Applying those again
 *                  would double-credit, so they never enter the pending set.
 *
 * Existing rows: bundle-order rows are backfilled to not-required for exactly
 * that reason; manual rows stay pending (production row #1 included) so the
 * new pull path can pick them up.
 */
function migration4(db: Database.Database): void {
  db.exec(`
    ALTER TABLE credit_ledger ADD COLUMN apply_state TEXT NOT NULL DEFAULT 'pending';
    ALTER TABLE credit_ledger ADD COLUMN apply_code_enc TEXT;
    ALTER TABLE credit_ledger ADD COLUMN applied_at INTEGER;
    ALTER TABLE credit_ledger ADD COLUMN applied_by TEXT;
    ALTER TABLE credit_ledger ADD COLUMN applied_bytes INTEGER;
    ALTER TABLE credit_ledger ADD COLUMN applied_evidence TEXT;
    ALTER TABLE credit_ledger ADD COLUMN apply_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE credit_ledger ADD COLUMN last_apply_error TEXT;
    ALTER TABLE credit_ledger ADD COLUMN last_apply_at INTEGER;
    UPDATE credit_ledger SET apply_state = 'not-required' WHERE source = 'bundle-order';
  `);
  db.exec(`
    CREATE INDEX idx_credit_ledger_pending ON credit_ledger(user_id, apply_state);
  `);
}

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-schema', up: migration1 },
  { version: 2, name: 'asr-usage', up: migration2 },
  { version: 3, name: 'credit-ledger', up: migration3 },
  { version: 4, name: 'credit-apply', up: migration4 },
];
