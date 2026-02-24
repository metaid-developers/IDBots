import { Database } from 'sql.js';
import type {
  Metabot,
  MetabotInsert,
  MetabotUpdate,
  MetabotWallet,
  MetabotWalletInsert,
} from './types/metabot';

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";

function parseJsonArray(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

interface MetabotRow {
  id: number;
  wallet_id: number;
  mvc_address: string;
  btc_address: string;
  doge_address: string;
  public_key: string;
  chat_public_key: string;
  chat_public_key_pin_id: string;
  name: string;
  avatar: string | null;
  avatar_blob?: Uint8Array | null;
  enabled: number;
  metaid: string;
  globalmetaid: string | null;
  metabot_info_pinid: string;
  metabot_type: string;
  created_by: string;
  role: string;
  soul: string;
  goal: string | null;
  background: string | null;
  boss_id: number | null;
  llm_id: string | null;
  tools: string;
  skills: string;
  created_at: number;
  updated_at: number;
}

interface MetabotWalletRow {
  id: number;
  mnemonic: string;
  path: string;
  created_at: number;
}

/** Convert DB avatar (BLOB or TEXT) to display string (data URL or URL). */
function avatarFromRow(row: MetabotRow): string | null {
  const blob = row.avatar_blob ?? row.avatar;
  if (blob != null && typeof blob !== 'string' && (blob instanceof Uint8Array || Buffer.isBuffer(blob)) && blob.length > 0) {
    const b64 = Buffer.from(blob).toString('base64');
    return `data:image/png;base64,${b64}`;
  }
  if (typeof row.avatar === 'string' && row.avatar) return row.avatar;
  return null;
}

/** Convert display avatar string to DB value (Buffer for BLOB, or string for legacy TEXT). */
function avatarToDb(value: string | null | undefined): Buffer | string | null {
  if (value == null || value === '') return null;
  const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(value);
  if (dataUrlMatch) {
    const base64 = dataUrlMatch[2];
    return Buffer.from(base64, 'base64');
  }
  return value;
}

function rowToMetabot(row: MetabotRow): Metabot {
  return {
    id: row.id,
    wallet_id: row.wallet_id,
    mvc_address: row.mvc_address,
    btc_address: row.btc_address,
    doge_address: row.doge_address,
    public_key: row.public_key,
    chat_public_key: row.chat_public_key,
    chat_public_key_pin_id: row.chat_public_key_pin_id,
    name: row.name,
    avatar: avatarFromRow(row),
    enabled: (row.enabled ?? 1) === 1,
    metaid: row.metaid,
    globalmetaid: row.globalmetaid ?? null,
    metabot_info_pinid: row.metabot_info_pinid,
    metabot_type: row.metabot_type === 'twin' ? 'twin' : 'worker',
    created_by: row.created_by,
    role: row.role,
    soul: row.soul,
    goal: row.goal ?? null,
    background: row.background ?? null,
    boss_id: row.boss_id ?? null,
    llm_id: row.llm_id ?? null,
    tools: parseJsonArray(row.tools),
    skills: parseJsonArray(row.skills),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToMetabotWallet(row: MetabotWalletRow): MetabotWallet {
  return {
    id: row.id,
    mnemonic: row.mnemonic,
    path: row.path,
    created_at: row.created_at,
  };
}

export class MetabotStore {
  private db: Database;
  private saveDb: () => void;
  private _hasAvatarBlob: boolean | null = null;

  constructor(db: Database, saveDb: () => void) {
    this.db = db;
    this.saveDb = saveDb;
  }

  private hasAvatarBlobColumn(): boolean {
    if (this._hasAvatarBlob !== null) return this._hasAvatarBlob;
    try {
      const r = this.db.exec("PRAGMA table_info(metabots);");
      const cols = (r[0]?.values?.map((row) => row[1]) || []) as string[];
      this._hasAvatarBlob = cols.includes('avatar_blob');
      return this._hasAvatarBlob;
    } catch {
      this._hasAvatarBlob = false;
      return false;
    }
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

  private getAll<T>(sql: string, params: (string | number | null)[] = []): T[] {
    const result = this.db.exec(sql, params);
    if (!result[0]?.values) return [];
    const columns = result[0].columns;
    return result[0].values.map((values) => {
      const row: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        row[col] = values[i];
      });
      return row as T;
    });
  }

  // --- Metabots CRUD ---

  listMetabots(): Metabot[] {
    const rows = this.getAll<MetabotRow>(
      'SELECT * FROM metabots ORDER BY created_at DESC'
    );
    return rows.map(rowToMetabot);
  }

  getMetabotById(id: number): Metabot | null {
    const row = this.getOne<MetabotRow>('SELECT * FROM metabots WHERE id = ?', [id]);
    return row ? rowToMetabot(row) : null;
  }

  createMetabot(input: MetabotInsert): Metabot {
    const now = Date.now();
    const toolsJson = JSON.stringify(input.tools ?? []);
    const skillsJson = JSON.stringify(input.skills ?? []);
    const enabled = input.enabled !== false ? 1 : 0;
    const avatarDb = avatarToDb(input.avatar ?? null);
    const useBlob = this.hasAvatarBlobColumn();

    if (useBlob) {
      this.db.run(
        `INSERT INTO metabots (
          wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
          name, avatar_blob, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
          role, soul, goal, background, boss_id, llm_id, tools, skills, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.wallet_id,
          input.mvc_address,
          input.btc_address,
          input.doge_address,
          input.public_key,
          input.chat_public_key,
          input.chat_public_key_pin_id,
          input.name,
          avatarDb instanceof Buffer ? avatarDb : null,
          enabled,
          input.metaid,
          input.globalmetaid ?? null,
          input.metabot_info_pinid,
          input.metabot_type,
          input.created_by,
          input.role,
          input.soul,
          input.goal ?? null,
          input.background ?? null,
          input.boss_id ?? null,
          input.llm_id ?? null,
          toolsJson,
          skillsJson,
          now,
          now,
        ]
      );
    } else {
      this.db.run(
        `INSERT INTO metabots (
          wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
          name, avatar, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
          role, soul, goal, background, boss_id, llm_id, tools, skills, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          input.wallet_id,
          input.mvc_address,
          input.btc_address,
          input.doge_address,
          input.public_key,
          input.chat_public_key,
          input.chat_public_key_pin_id,
          input.name,
          avatarDb,
          enabled,
          input.metaid,
          input.globalmetaid ?? null,
          input.metabot_info_pinid,
          input.metabot_type,
          input.created_by,
          input.role,
          input.soul,
          input.goal ?? null,
          input.background ?? null,
          input.boss_id ?? null,
          input.llm_id ?? null,
          toolsJson,
          skillsJson,
          now,
          now,
        ]
      );
    }
    this.saveDb();

    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const id = (result[0]?.values[0]?.[0] as number) ?? 0;
    return this.getMetabotById(id)!;
  }

  updateMetabot(id: number, input: MetabotUpdate): Metabot | null {
    const existing = this.getMetabotById(id);
    if (!existing) return null;

    const now = Date.now();
    const toolsJson =
      input.tools !== undefined ? JSON.stringify(input.tools) : JSON.stringify(existing.tools);
    const skillsJson =
      input.skills !== undefined ? JSON.stringify(input.skills) : JSON.stringify(existing.skills);

    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
    const avatarVal = input.avatar !== undefined ? input.avatar : existing.avatar;
    const avatarDb = avatarToDb(avatarVal ?? null);
    const useBlob = this.hasAvatarBlobColumn();

    if (useBlob) {
      this.db.run(
        `UPDATE metabots SET
          wallet_id = ?, mvc_address = ?, btc_address = ?, doge_address = ?, public_key = ?, chat_public_key = ?, chat_public_key_pin_id = ?,
          name = ?, avatar_blob = ?, enabled = ?, metaid = ?, globalmetaid = ?, metabot_info_pinid = ?, metabot_type = ?, created_by = ?,
          role = ?, soul = ?, goal = ?, background = ?, boss_id = ?, llm_id = ?, tools = ?, skills = ?, updated_at = ?
        WHERE id = ?`,
        [
          input.wallet_id ?? existing.wallet_id,
          input.mvc_address ?? existing.mvc_address,
          input.btc_address ?? existing.btc_address,
          input.doge_address ?? existing.doge_address,
          input.public_key ?? existing.public_key,
          input.chat_public_key ?? existing.chat_public_key,
          input.chat_public_key_pin_id ?? existing.chat_public_key_pin_id,
          input.name ?? existing.name,
          avatarDb instanceof Buffer ? avatarDb : null,
          enabled,
          input.metaid ?? existing.metaid,
          input.globalmetaid !== undefined ? input.globalmetaid : existing.globalmetaid,
          input.metabot_info_pinid ?? existing.metabot_info_pinid,
          input.metabot_type ?? existing.metabot_type,
          input.created_by ?? existing.created_by,
          input.role ?? existing.role,
          input.soul ?? existing.soul,
          input.goal !== undefined ? input.goal : existing.goal,
          input.background !== undefined ? input.background : existing.background,
          input.boss_id !== undefined ? input.boss_id : existing.boss_id,
          input.llm_id !== undefined ? input.llm_id : existing.llm_id,
          toolsJson,
          skillsJson,
          now,
          id,
        ]
      );
    } else {
      this.db.run(
        `UPDATE metabots SET
          wallet_id = ?, mvc_address = ?, btc_address = ?, doge_address = ?, public_key = ?, chat_public_key = ?, chat_public_key_pin_id = ?,
          name = ?, avatar = ?, enabled = ?, metaid = ?, globalmetaid = ?, metabot_info_pinid = ?, metabot_type = ?, created_by = ?,
          role = ?, soul = ?, goal = ?, background = ?, boss_id = ?, llm_id = ?, tools = ?, skills = ?, updated_at = ?
        WHERE id = ?`,
        [
          input.wallet_id ?? existing.wallet_id,
          input.mvc_address ?? existing.mvc_address,
          input.btc_address ?? existing.btc_address,
          input.doge_address ?? existing.doge_address,
          input.public_key ?? existing.public_key,
          input.chat_public_key ?? existing.chat_public_key,
          input.chat_public_key_pin_id ?? existing.chat_public_key_pin_id,
          input.name ?? existing.name,
          avatarDb,
          enabled,
          input.metaid ?? existing.metaid,
          input.globalmetaid !== undefined ? input.globalmetaid : existing.globalmetaid,
          input.metabot_info_pinid ?? existing.metabot_info_pinid,
          input.metabot_type ?? existing.metabot_type,
          input.created_by ?? existing.created_by,
          input.role ?? existing.role,
          input.soul ?? existing.soul,
          input.goal !== undefined ? input.goal : existing.goal,
          input.background !== undefined ? input.background : existing.background,
          input.boss_id !== undefined ? input.boss_id : existing.boss_id,
          input.llm_id !== undefined ? input.llm_id : existing.llm_id,
          toolsJson,
          skillsJson,
          now,
          id,
        ]
      );
    }
    this.saveDb();
    return this.getMetabotById(id);
  }

  deleteMetabot(id: number): boolean {
    const existing = this.getMetabotById(id);
    if (!existing) return false;
    this.db.run('DELETE FROM metabots WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  // --- Metabot wallets (append-only: insert + query only) ---

  insertMetabotWallet(input: MetabotWalletInsert): MetabotWallet {
    const now = Date.now();
    const path = input.path ?? DEFAULT_WALLET_PATH;

    this.db.run(
      `INSERT INTO metabot_wallets (mnemonic, path, created_at) VALUES (?, ?, ?)`,
      [input.mnemonic, path, now]
    );
    this.saveDb();

    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const id = (result[0]?.values[0]?.[0] as number) ?? 0;
    const row = this.getOne<MetabotWalletRow>(
      'SELECT * FROM metabot_wallets WHERE id = ?',
      [id]
    );
    return row ? rowToMetabotWallet(row) : ({} as MetabotWallet);
  }

  getMetabotWalletById(wallet_id: number): MetabotWallet | null {
    const row = this.getOne<MetabotWalletRow>(
      'SELECT * FROM metabot_wallets WHERE id = ?',
      [wallet_id]
    );
    return row ? rowToMetabotWallet(row) : null;
  }

  /** Get wallet for a metabot by metabot id (looks up metabot.wallet_id). */
  getMetabotWalletByMetabotId(metabot_id: number): MetabotWallet | null {
    const metabot = this.getMetabotById(metabot_id);
    return metabot ? this.getMetabotWalletById(metabot.wallet_id) : null;
  }

  /**
   * Get the first Twin (metabot_type = 'twin') and its wallet for skill scripts (e.g. send_buzz).
   * Returns null if no twin exists.
   */
  getTwinWallet(): { name: string; mnemonic: string; path: string } | null {
    const twinRow = this.getOne<MetabotRow>(
      "SELECT * FROM metabots WHERE metabot_type = 'twin' ORDER BY id ASC LIMIT 1"
    );
    if (!twinRow) return null;
    const wallet = this.getMetabotWalletById(twinRow.wallet_id);
    if (!wallet) return null;
    return {
      name: twinRow.name,
      mnemonic: wallet.mnemonic,
      path: wallet.path,
    };
  }
}
