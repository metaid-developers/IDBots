import type { SqliteDatabase as Database } from './sqliteTypes';
import type {
  UserIdentity,
  UserIdentityInsert,
  UserIdentityUpdate,
} from './types/userIdentity';

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";
/** The user_identity table is single-row by design; the row id is always 1. */
const USER_IDENTITY_ROW_ID = 1;

interface UserIdentityRow {
  id: number;
  mnemonic: string;
  path: string;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string | null;
  metaid: string;
  globalmetaid: string | null;
  name: string;
  avatar: string | null;
  avatar_fallback: string | null;
  nft_avatar_pin_id: string | null;
  nft_avatar_synced_reference: string | null;
  subsidy_state: string | null;
  subsidy_error: string | null;
  name_pin_id: string | null;
  avatar_pin_id: string | null;
  sync_state: string | null;
  sync_error: string | null;
  created_at: number;
  updated_at: number;
}

function rowToUserIdentity(row: UserIdentityRow): UserIdentity {
  return {
    id: row.id,
    mnemonic: row.mnemonic,
    path: row.path,
    mvc_address: row.mvc_address,
    btc_address: row.btc_address,
    doge_address: row.doge_address,
    public_key: row.public_key,
    chat_public_key: row.chat_public_key,
    chat_public_key_pin_id: row.chat_public_key_pin_id ?? null,
    metaid: row.metaid,
    globalmetaid: row.globalmetaid ?? null,
    name: row.name,
    avatar: row.avatar ?? null,
    avatar_fallback: row.avatar_fallback ?? null,
    nft_avatar_pin_id: row.nft_avatar_pin_id ?? null,
    nft_avatar_synced_reference: row.nft_avatar_synced_reference ?? null,
    subsidy_state: (row.subsidy_state as UserIdentity['subsidy_state']) ?? null,
    subsidy_error: row.subsidy_error ?? null,
    name_pin_id: row.name_pin_id ?? null,
    avatar_pin_id: row.avatar_pin_id ?? null,
    sync_state: (row.sync_state as UserIdentity['sync_state']) ?? null,
    sync_error: row.sync_error ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export class UserIdentityStore {
  private db: Database;
  private saveDb: () => void;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  private getOne<T>(sql: string, params: (string | number | null)[] = []): T | undefined {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values[0]) return undefined;
    const columns = result[0].columns;
    const values = result[0].values[0];
    const row: Record<string, unknown> = {};
    columns.forEach((col, i) => {
      row[col] = values[i];
    });
    return row as T;
  }

  /** Returns the local user identity, or null when none exists. */
  get(): UserIdentity | null {
    const row = this.getOne<UserIdentityRow>(
      'SELECT * FROM user_identity WHERE id = ? LIMIT 1',
      [USER_IDENTITY_ROW_ID],
    );
    return row ? rowToUserIdentity(row) : null;
  }

  /** Creates the local user identity. Throws when one already exists. */
  insert(data: UserIdentityInsert): UserIdentity {
    if (this.get()) {
      throw new Error('User identity already exists; log out before creating or importing another one.');
    }
    const now = Date.now();
    this.db.run(
      `INSERT INTO user_identity (
        id, mnemonic, path, mvc_address, btc_address, doge_address, public_key,
        chat_public_key, chat_public_key_pin_id, metaid, globalmetaid, name, avatar,
        avatar_fallback, nft_avatar_pin_id, nft_avatar_synced_reference,
        subsidy_state, subsidy_error, name_pin_id, avatar_pin_id, sync_state, sync_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        USER_IDENTITY_ROW_ID,
        data.mnemonic,
        data.path ?? DEFAULT_WALLET_PATH,
        data.mvc_address,
        data.btc_address,
        data.doge_address,
        data.public_key,
        data.chat_public_key,
        data.chat_public_key_pin_id ?? null,
        data.metaid,
        data.globalmetaid ?? null,
        data.name,
        data.avatar ?? null,
        data.avatar_fallback ?? null,
        data.nft_avatar_pin_id ?? null,
        data.nft_avatar_synced_reference ?? null,
        data.subsidy_state ?? null,
        data.subsidy_error ?? null,
        data.name_pin_id ?? null,
        data.avatar_pin_id ?? null,
        data.sync_state ?? null,
        data.sync_error ?? null,
        now,
        now,
      ],
    );
    this.saveDb();
    const created = this.get();
    if (!created) throw new Error('Failed to create user identity.');
    return created;
  }

  /** Updates profile/setup fields; returns the updated identity, or null when none exists. */
  update(patch: UserIdentityUpdate): UserIdentity | null {
    const existing = this.get();
    if (!existing) return null;
    const next = {
      name: patch.name ?? existing.name,
      avatar: patch.avatar === undefined ? existing.avatar : patch.avatar,
      avatar_fallback: patch.avatar_fallback === undefined ? existing.avatar_fallback ?? null : patch.avatar_fallback,
      nft_avatar_pin_id: patch.nft_avatar_pin_id === undefined ? existing.nft_avatar_pin_id ?? null : patch.nft_avatar_pin_id,
      nft_avatar_synced_reference:
        patch.nft_avatar_synced_reference === undefined
          ? existing.nft_avatar_synced_reference ?? null
          : patch.nft_avatar_synced_reference,
      chat_public_key_pin_id:
        patch.chat_public_key_pin_id === undefined
          ? existing.chat_public_key_pin_id
          : patch.chat_public_key_pin_id,
      globalmetaid:
        patch.globalmetaid === undefined ? existing.globalmetaid : patch.globalmetaid,
      subsidy_state:
        patch.subsidy_state === undefined ? existing.subsidy_state : patch.subsidy_state,
      subsidy_error:
        patch.subsidy_error === undefined ? existing.subsidy_error : patch.subsidy_error,
      name_pin_id:
        patch.name_pin_id === undefined ? existing.name_pin_id : patch.name_pin_id,
      avatar_pin_id:
        patch.avatar_pin_id === undefined ? existing.avatar_pin_id : patch.avatar_pin_id,
      sync_state:
        patch.sync_state === undefined ? existing.sync_state : patch.sync_state,
      sync_error:
        patch.sync_error === undefined ? existing.sync_error : patch.sync_error,
    };
    this.db.run(
      `UPDATE user_identity
       SET name = ?, avatar = ?, avatar_fallback = ?, nft_avatar_pin_id = ?, nft_avatar_synced_reference = ?,
           chat_public_key_pin_id = ?, globalmetaid = ?, subsidy_state = ?, subsidy_error = ?,
           name_pin_id = ?, avatar_pin_id = ?, sync_state = ?, sync_error = ?, updated_at = ?
       WHERE id = ?`,
      [
        next.name,
        next.avatar,
        next.avatar_fallback,
        next.nft_avatar_pin_id,
        next.nft_avatar_synced_reference,
        next.chat_public_key_pin_id,
        next.globalmetaid,
        next.subsidy_state,
        next.subsidy_error,
        next.name_pin_id,
        next.avatar_pin_id,
        next.sync_state,
        next.sync_error,
        Date.now(),
        USER_IDENTITY_ROW_ID,
      ],
    );
    this.saveDb();
    return this.get();
  }

  /** Deletes the local user identity (logout). Returns true when a row was removed. */
  remove(): boolean {
    const existing = this.get();
    if (!existing) return false;
    this.db.run('DELETE FROM user_identity WHERE id = ?', [USER_IDENTITY_ROW_ID]);
    this.saveDb();
    return true;
  }
}
