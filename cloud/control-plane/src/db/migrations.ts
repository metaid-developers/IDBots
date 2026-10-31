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

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'initial-schema', up: migration1 },
  { version: 2, name: 'asr-usage', up: migration2 },
];
