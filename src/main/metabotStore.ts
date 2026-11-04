import type { SqliteDatabase as Database } from './sqliteTypes';
import { normalizeA2AAutoReplyEnabled, normalizeA2AByeCooldownMs, normalizeA2AMaxIncomingTurns } from './services/a2aChatLimits';
import type {
  Metabot,
  MetabotInsert,
  MetabotUpdate,
  MetabotWallet,
  MetabotWalletInsert,
} from './types/metabot';

const DEFAULT_WALLET_PATH = "m/44'/10001'/0'/0/0";

// Defined locally rather than imported from services/surfSettings to keep the
// store free of service-layer imports; the strings are the stable kv contract
// shared with that module.
const SURF_BEFORE_DREAM_ENABLED_KEY = 'surf_before_dream_enabled';
const SURF_LEGACY_PIN_MARKER_KEY = '_migrated_surf_before_dream_legacy_pin';

/** sql.js rejects undefined in bind params; normalize to null. */
function sanitizeBindParams(params: unknown[]): (string | number | Buffer | Uint8Array | null)[] {
  return params.map((v) =>
    v === undefined || (typeof v === 'number' && Number.isNaN(v)) ? null : (v as string | number | Buffer | Uint8Array)
  );
}

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
  chat_public_key_pin_id: string | null;
  name: string;
  avatar: string | null;
  avatar_blob?: Uint8Array | null;
  enabled: number;
  metaid: string;
  globalmetaid: string | null;
  metabot_info_pinid: string | null;
  metabot_type: string;
  created_by: string;
  role: string;
  soul: string;
  goal: string | null;
  bio?: string | null;
  background: string | null;
  boss_id: number | null;
  boss_global_metaid: string | null;
  owner_binding_pinid?: string | null;
  llm_id: string | null;
  llm_provider?: string | null;
  llm_effort?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  fallback_llm_effort?: string | null;
  tools: string;
  skills: string;
  allow_chat_skills: string;
  a2a_max_incoming_turns?: number | null;
  a2a_bye_cooldown_ms?: number | null;
  a2a_auto_reply_enabled?: number | null;
  homepage?: string | null;
  created_at: number;
  updated_at: number;
}

interface MetabotWalletRow {
  id: number;
  mnemonic: string;
  path: string;
  created_at: number;
}

interface RecentMetaidPinTransactionRow {
  txid: string;
  timestamp: number;
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
  const bio = row.bio ?? row.background ?? null;
  return {
    id: row.id,
    wallet_id: row.wallet_id,
    mvc_address: row.mvc_address,
    btc_address: row.btc_address,
    doge_address: row.doge_address,
    public_key: row.public_key,
    chat_public_key: row.chat_public_key,
    chat_public_key_pin_id: row.chat_public_key_pin_id ?? null,
    name: row.name,
    avatar: avatarFromRow(row),
    enabled: (row.enabled ?? 1) === 1,
    metaid: row.metaid,
    globalmetaid: row.globalmetaid ?? null,
    metabot_info_pinid: row.metabot_info_pinid ?? null,
    metabot_type: row.metabot_type === 'twin' || row.metabot_type === 'welcome' ? row.metabot_type : 'worker',
    created_by: row.created_by,
    role: row.role,
    soul: row.soul,
    goal: row.goal ?? null,
    bio,
    background: row.background ?? null,
    boss_id: row.boss_id ?? null,
    boss_global_metaid: row.boss_global_metaid ?? null,
    owner_binding_pinid: row.owner_binding_pinid ?? null,
    llm_id: row.llm_id ?? null,
    llm_provider: row.llm_provider ?? null,
    llm_effort: row.llm_effort ?? null,
    fallback_llm_id: row.fallback_llm_id ?? null,
    fallback_llm_provider: row.fallback_llm_provider ?? null,
    fallback_llm_effort: row.fallback_llm_effort ?? null,
    tools: parseJsonArray(row.tools),
    skills: parseJsonArray(row.skills),
    allow_chat_skills: parseJsonArray(row.allow_chat_skills),
    a2a_max_incoming_turns: row.a2a_max_incoming_turns ?? null,
    a2a_bye_cooldown_ms: row.a2a_bye_cooldown_ms ?? null,
    a2a_auto_reply_enabled:
      row.a2a_auto_reply_enabled == null ? null : row.a2a_auto_reply_enabled !== 0,
    homepage: row.homepage ?? null,
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
    // One-time data migration (see ensureSurfBeforeDreamLegacyPin): pins the
    // pre-flip surf default onto bots that existed before it, so the
    // twin-only default only touches bots created afterwards. Never blocks
    // construction — a schema race just retries on the next launch.
    try {
      this.ensureSurfBeforeDreamLegacyPin();
    } catch (error) {
      console.warn(
        '[MetabotStore] surf_before_dream legacy pin migration deferred:',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Owner decision 2026-10-26 (nightly-token audit): the surf-before-dream
   * default flipped from "every bot ON" to "Twin only ON". To keep existing
   * users exactly where they were (announced release note asks them to opt
   * out manually), this one-time migration writes an explicit '1' for every
   * bot that has no value yet. Bots created after the flip carry no row and
   * therefore ride the new twin-only default. Idempotent via a marker row at
   * metabot_id = 0 (getMetabotSetting refuses non-positive ids, so the
   * marker is unreachable through the public readers).
   */
  private ensureSurfBeforeDreamLegacyPin(): void {
    this.ensureMetabotSettingsTable();
    const marker = this.getOne<{ value: string }>(
      'SELECT value FROM metabot_settings WHERE metabot_id = 0 AND key = ? LIMIT 1',
      [SURF_LEGACY_PIN_MARKER_KEY],
    );
    if (marker) return;
    this.db.run(
      `INSERT INTO metabot_settings (metabot_id, key, value, updated_at)
       SELECT id, ?, '1', ? FROM metabots
       WHERE id NOT IN (SELECT metabot_id FROM metabot_settings WHERE key = ?)`,
      [SURF_BEFORE_DREAM_ENABLED_KEY, Date.now(), SURF_BEFORE_DREAM_ENABLED_KEY],
    );
    this.db.run(
      'INSERT OR REPLACE INTO metabot_settings (metabot_id, key, value, updated_at) VALUES (0, ?, ?, ?)',
      [SURF_LEGACY_PIN_MARKER_KEY, new Date().toISOString(), Date.now()],
    );
    this.saveDb();
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

  private normalizeBossIdForWrite(value: number | null | undefined, selfId?: number): number | null {
    if (value == null) return null;
    const id = Math.trunc(Number(value));
    if (!Number.isFinite(id) || id <= 0 || (selfId != null && id === selfId)) return null;
    const row = this.getOne<{ id: number }>('SELECT id FROM metabots WHERE id = ? LIMIT 1', [id]);
    return row ? id : null;
  }

  /**
   * Demote every Twin except `exceptId` to Worker, preserving the machine-wide
   * "at most one Twin" invariant. The caller is responsible for saveDb().
   * Public so the cross-device chain restore can hand the Twin role to the
   * restored Bot (its Twin carries the user's real persona and memories; the
   * local placeholder Twin the welcome flow created loses the role).
   */
  demoteOtherTwins(exceptId: number): void {
    this.db.run(
      "UPDATE metabots SET metabot_type = 'worker', updated_at = ? WHERE metabot_type = 'twin' AND id != ?",
      [Date.now(), exceptId]
    );
  }

  /**
   * Twin identity is scarce and sticky:
   * - the Welcome Bot can never become Twin (its type is otherwise immutable)
   * - a Worker can become Twin only when no other Twin exists
   * - the current Twin may demote itself to Worker
   * Steal-by-promotion (auto-demoting the current Twin from another bot) is refused.
   */
  private resolveNextMetabotType(
    existingType: Metabot['metabot_type'],
    requested: Metabot['metabot_type'] | undefined,
    selfId: number,
  ): Metabot['metabot_type'] {
    if (requested === undefined) return existingType;
    if (existingType === 'welcome') {
      if (requested === 'twin') {
        throw new Error('WELCOME_CANNOT_BE_TWIN');
      }
      return 'welcome';
    }
    if (requested === 'welcome') {
      return existingType === 'twin' ? 'twin' : 'worker';
    }
    if (requested === 'twin') {
      if (existingType === 'twin') return 'twin';
      const otherTwin = this.getOne<{ id: number }>(
        "SELECT id FROM metabots WHERE metabot_type = 'twin' AND id != ? LIMIT 1",
        [selfId]
      );
      if (otherTwin) {
        throw new Error('TWIN_ALREADY_EXISTS');
      }
      return 'twin';
    }
    return 'worker';
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

  // --- MetaApp owner cache ---

  listMetaAppOwnerCache(mvcAddress: string): Array<{
    id: number; metabot_id: number; pin_id: string; first_pin_id: string | null;
    operation: string; mvc_address: string; payload: string | null;
    txids: string | null; created_at: number;
  }> {
    if (!mvcAddress) return [];
    return this.getAll(
      'SELECT * FROM metaapp_owner_cache WHERE mvc_address = ? ORDER BY created_at DESC',
      [mvcAddress],
    );
  }

  upsertMetaAppOwnerCache(record: {
    metabot_id: number; pin_id: string; first_pin_id?: string | null;
    operation: string; mvc_address: string; payload?: string | null;
    txids?: string | null;
  }): void {
    this.db.run(
      `INSERT INTO metaapp_owner_cache
        (metabot_id, pin_id, first_pin_id, operation, mvc_address, payload, txids, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pin_id) DO UPDATE SET
         metabot_id=excluded.metabot_id,
         first_pin_id=excluded.first_pin_id,
         operation=excluded.operation,
         mvc_address=excluded.mvc_address,
         payload=excluded.payload,
         txids=excluded.txids,
         created_at=excluded.created_at`,
      [
        record.metabot_id,
        record.pin_id,
        record.first_pin_id ?? null,
        record.operation,
        record.mvc_address,
        record.payload ?? null,
        record.txids ?? null,
        Date.now(),
      ],
    );
    this.saveDb();
  }

  // --- Metabots CRUD ---

  listMetabots(): Metabot[] {
    const rows = this.getAll<MetabotRow>(
      'SELECT * FROM metabots ORDER BY created_at DESC'
    );
    return rows.map(rowToMetabot);
  }

  /**
   * Returns enabled MetaBots with minimal fields for picker/selector UI.
   * Twin is ordered first for default selection. `created_at` drives the
   * by-Bot session view's group order (Twin first, then oldest bot first).
   */
  getAllMetaBots(): Array<{ id: number; name: string; avatar: string | null; metabot_type: string; created_at: number; role: string }> {
    const rows = this.getAll<MetabotRow>(
      "SELECT * FROM metabots WHERE enabled = 1 ORDER BY metabot_type = 'twin' DESC, id ASC"
    );
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      avatar: avatarFromRow(row),
      metabot_type: row.metabot_type,
      created_at: row.created_at,
      role: row.role,
    }));
  }

  getMetabotById(id: number): Metabot | null {
    const row = this.getOne<MetabotRow>('SELECT * FROM metabots WHERE id = ?', [id]);
    return row ? rowToMetabot(row) : null;
  }

  private ensureMetabotSettingsTable(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS metabot_settings (
        metabot_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (metabot_id, key)
      );
    `);
  }

  /** Read one per-metabot setting value (e.g. chain.defaultWriteNetwork). */
  getMetabotSetting(metabotId: number, key: string): string | null {
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      throw new Error('metabotId must be a positive integer');
    }
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      throw new Error('setting key is required');
    }
    this.ensureMetabotSettingsTable();
    const row = this.getOne<{ value: string }>(
      'SELECT value FROM metabot_settings WHERE metabot_id = ? AND key = ? LIMIT 1',
      [metabotId, normalizedKey],
    );
    return row ? String(row.value) : null;
  }

  /** Whether the bot is the machine's Twin (metabot_type = 'twin'). */
  isTwinMetabot(metabotId: number): boolean {
    if (!Number.isInteger(metabotId) || metabotId <= 0) return false;
    return this.getOne<{ one: number }>(
      "SELECT 1 AS one FROM metabots WHERE id = ? AND metabot_type = 'twin' LIMIT 1",
      [metabotId],
    ) != null;
  }

  /** Write one per-metabot setting value. Returns the stored value. */
  setMetabotSetting(metabotId: number, key: string, value: string): string {
    if (!Number.isInteger(metabotId) || metabotId <= 0) {
      throw new Error('metabotId must be a positive integer');
    }
    const normalizedKey = String(key || '').trim();
    if (!normalizedKey) {
      throw new Error('setting key is required');
    }
    const normalizedValue = String(value ?? '').trim();
    this.ensureMetabotSettingsTable();
    this.db.run(
      `INSERT INTO metabot_settings (metabot_id, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (metabot_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [metabotId, normalizedKey, normalizedValue, Date.now()],
    );
    this.saveDb();
    return normalizedValue;
  }

  /** MetaBot row linked to a wallet (at most one expected per wallet_id). */
  getMetabotByWalletId(walletId: number): Metabot | null {
    const row = this.getOne<MetabotRow>('SELECT * FROM metabots WHERE wallet_id = ? LIMIT 1', [walletId]);
    return row ? rowToMetabot(row) : null;
  }

  /**
   * Find an append-only wallet row by mnemonic phrase (case/outer whitespace insensitive).
   * Used when restoring after metabot delete: the wallet row may still exist.
   */
  getMetabotWalletByMnemonicNormalized(normalizedMnemonic: string): MetabotWallet | null {
    const phrase = normalizedMnemonic.trim().toLowerCase();
    if (!phrase) return null;
    const row = this.getOne<MetabotWalletRow>(
      'SELECT * FROM metabot_wallets WHERE lower(trim(mnemonic)) = ? LIMIT 1',
      [phrase]
    );
    return row ? rowToMetabotWallet(row) : null;
  }

  /** Get MetaBot by globalmetaid (e.g. for private chat daemon: message to_global_metaid). */
  getMetabotByGlobalMetaId(globalmetaid: string | null): Metabot | null {
    if (!globalmetaid || typeof globalmetaid !== 'string' || !globalmetaid.trim()) return null;
    const row = this.getOne<MetabotRow>('SELECT * FROM metabots WHERE globalmetaid = ? LIMIT 1', [globalmetaid.trim()]);
    return row ? rowToMetabot(row) : null;
  }

  createMetabot(input: MetabotInsert): Metabot {
    const now = Date.now();
    const toolsJson = JSON.stringify(input.tools ?? []);
    const skillsJson = JSON.stringify(input.skills ?? []);
    const allowChatSkillsJson = JSON.stringify(input.allow_chat_skills ?? []);
    const bio = input.bio !== undefined ? input.bio : (input.background ?? null);
    const deprecatedBackground = input.background ?? null;
    const enabled = input.enabled !== false ? 1 : 0;
    const avatarDb = avatarToDb(input.avatar ?? null);
    const useBlob = this.hasAvatarBlobColumn();
    const bossId = this.normalizeBossIdForWrite(input.boss_id ?? null);
    const homepage = input.homepage ?? null;

    const params = sanitizeBindParams([
      input.wallet_id,
      input.mvc_address,
      input.btc_address,
      input.doge_address,
      input.public_key,
      input.chat_public_key,
      input.chat_public_key_pin_id ?? null,
      input.name,
      useBlob ? (avatarDb instanceof Buffer ? avatarDb : null) : avatarDb,
      enabled,
      input.metaid,
      input.globalmetaid ?? null,
      input.metabot_info_pinid ?? null,
      input.metabot_type,
      input.created_by,
      input.role,
      input.soul,
      input.goal ?? null,
      bio,
      deprecatedBackground,
      bossId,
      input.boss_global_metaid ?? null,
      input.owner_binding_pinid ?? null,
      input.llm_id ?? null,
      input.fallback_llm_id ?? null,
      input.llm_provider ?? null,
      input.llm_effort ?? null,
      input.fallback_llm_provider ?? null,
      input.fallback_llm_effort ?? null,
      toolsJson,
      skillsJson,
      allowChatSkillsJson,
      homepage,
      now,
      now,
    ]);
    if (useBlob) {
      this.db.run(
        `INSERT INTO metabots (
          wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
          name, avatar_blob, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
          role, soul, goal, bio, background, boss_id, boss_global_metaid, owner_binding_pinid, llm_id, fallback_llm_id, llm_provider, llm_effort, fallback_llm_provider, fallback_llm_effort, tools, skills, allow_chat_skills, homepage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    } else {
      this.db.run(
        `INSERT INTO metabots (
          wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key, chat_public_key_pin_id,
          name, avatar, enabled, metaid, globalmetaid, metabot_info_pinid, metabot_type, created_by,
          role, soul, goal, bio, background, boss_id, boss_global_metaid, owner_binding_pinid, llm_id, fallback_llm_id, llm_provider, llm_effort, fallback_llm_provider, fallback_llm_effort, tools, skills, allow_chat_skills, homepage, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params
      );
    }
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const rawId = result[0]?.values?.[0]?.[0];
    const id = typeof rawId === 'number' ? rawId : Number(rawId) || 0;
    if (!id || id <= 0) {
      throw new Error(`createMetabot failed: last_insert_rowid returned invalid id (raw=${JSON.stringify(rawId)})`);
    }
    if (input.metabot_type === 'twin') {
      // Machine-wide unique Twin: creating a new twin demotes the previous one.
      this.demoteOtherTwins(id);
    }
    this.saveDb();

    // Build return object from input (avoid getMetabotById which may fail if db.exec does not bind params)
    const metabot: Metabot = {
      id,
      wallet_id: input.wallet_id,
      mvc_address: input.mvc_address,
      btc_address: input.btc_address,
      doge_address: input.doge_address,
      public_key: input.public_key,
      chat_public_key: input.chat_public_key,
      chat_public_key_pin_id: input.chat_public_key_pin_id ?? null,
      name: input.name,
      avatar: input.avatar ?? null,
      enabled: input.enabled !== false,
      metaid: input.metaid,
      globalmetaid: input.globalmetaid ?? null,
      metabot_info_pinid: input.metabot_info_pinid ?? null,
      metabot_type: input.metabot_type === 'twin' || input.metabot_type === 'welcome' ? input.metabot_type : 'worker',
      created_by: input.created_by,
      role: input.role,
      soul: input.soul,
      goal: input.goal ?? null,
      bio,
      background: deprecatedBackground,
      boss_id: bossId,
      boss_global_metaid: input.boss_global_metaid ?? null,
      owner_binding_pinid: input.owner_binding_pinid ?? null,
      llm_id: input.llm_id ?? null,
      llm_provider: input.llm_provider ?? null,
      llm_effort: input.llm_effort ?? null,
      fallback_llm_id: input.fallback_llm_id ?? null,
      fallback_llm_provider: input.fallback_llm_provider ?? null,
      fallback_llm_effort: input.fallback_llm_effort ?? null,
      tools: input.tools ?? [],
      skills: input.skills ?? [],
      allow_chat_skills: input.allow_chat_skills ?? [],
      homepage,
      created_at: now,
      updated_at: now,
    };
    return metabot;
  }

  updateMetabot(id: number, input: MetabotUpdate): Metabot | null {
    const existing = this.getMetabotById(id);
    if (!existing) return null;

    const now = Date.now();
    const toolsJson =
      input.tools !== undefined ? JSON.stringify(input.tools) : JSON.stringify(existing.tools);
    const skillsJson =
      input.skills !== undefined ? JSON.stringify(input.skills) : JSON.stringify(existing.skills);
    const allowChatSkillsJson =
      input.allow_chat_skills !== undefined
        ? JSON.stringify(input.allow_chat_skills)
        : JSON.stringify(existing.allow_chat_skills);
    const nextBio =
      input.bio !== undefined
        ? input.bio
        : input.background !== undefined
          ? input.background
          : existing.bio;
    const nextDeprecatedBackground =
      input.background !== undefined
        ? input.background
        : input.bio !== undefined
          ? null
          : existing.background;

    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : (existing.enabled ? 1 : 0);
    const avatarVal = input.avatar !== undefined ? input.avatar : existing.avatar;
    const avatarDb = avatarToDb(avatarVal ?? null);
    const useBlob = this.hasAvatarBlobColumn();
    const bossId =
      input.boss_id !== undefined
        ? this.normalizeBossIdForWrite(input.boss_id, id)
        : this.normalizeBossIdForWrite(existing.boss_id, id);
    const homepage = input.homepage !== undefined ? input.homepage : existing.homepage;
    const fallbackLlmId =
      input.fallback_llm_id !== undefined ? input.fallback_llm_id : (existing.fallback_llm_id ?? null);
    const llmProvider =
      input.llm_provider !== undefined ? input.llm_provider : (existing.llm_provider ?? null);
    const llmEffort =
      input.llm_effort !== undefined ? input.llm_effort : (existing.llm_effort ?? null);
    const fallbackLlmProvider =
      input.fallback_llm_provider !== undefined
        ? input.fallback_llm_provider
        : (existing.fallback_llm_provider ?? null);
    const fallbackLlmEffort =
      input.fallback_llm_effort !== undefined
        ? input.fallback_llm_effort
        : (existing.fallback_llm_effort ?? null);
    // Canonicalize selectable A2A chat limits on write; undefined keeps the stored value.
    const a2aMaxIncomingTurns =
      input.a2a_max_incoming_turns !== undefined
        ? normalizeA2AMaxIncomingTurns(input.a2a_max_incoming_turns)
        : (existing.a2a_max_incoming_turns ?? null);
    const a2aByeCooldownMs =
      input.a2a_bye_cooldown_ms !== undefined
        ? normalizeA2AByeCooldownMs(input.a2a_bye_cooldown_ms)
        : (existing.a2a_bye_cooldown_ms ?? null);
    const a2aAutoReplyEnabled =
      input.a2a_auto_reply_enabled !== undefined
        ? (normalizeA2AAutoReplyEnabled(input.a2a_auto_reply_enabled) ? 1 : 0)
        : (existing.a2a_auto_reply_enabled == null ? null : (existing.a2a_auto_reply_enabled ? 1 : 0));
    // Every effective toggle change lands in main.log — a silent flip (owner
    // edit, Twin metabot_update, restore) must stay explainable after the fact
    // (2026-10-29 twin auto-reply report).
    const previousA2aAutoReplyEnabled =
      existing.a2a_auto_reply_enabled == null ? null : (existing.a2a_auto_reply_enabled ? 1 : 0);
    if (previousA2aAutoReplyEnabled !== a2aAutoReplyEnabled) {
      const describeA2aAutoReply = (value: number | null): string =>
        value === null ? 'default(on)' : value === 1 ? 'on' : 'off';
      console.log(
        `[a2a-audit] metabot ${id} (${existing.name}): a2a_auto_reply_enabled`
        + ` ${describeA2aAutoReply(previousA2aAutoReplyEnabled)} -> ${describeA2aAutoReply(a2aAutoReplyEnabled)}`
      );
    }

    const nextMetabotType = this.resolveNextMetabotType(existing.metabot_type, input.metabot_type, id);
    if (nextMetabotType === 'twin' && existing.metabot_type !== 'twin') {
      this.demoteOtherTwins(id);
    }

    if (useBlob) {
      this.db.run(
        `UPDATE metabots SET
          wallet_id = ?, mvc_address = ?, btc_address = ?, doge_address = ?, public_key = ?, chat_public_key = ?, chat_public_key_pin_id = ?,
          name = ?, avatar_blob = ?, enabled = ?, metaid = ?, globalmetaid = ?, metabot_info_pinid = ?, metabot_type = ?, created_by = ?,
          role = ?, soul = ?, goal = ?, bio = ?, background = ?, boss_id = ?, boss_global_metaid = ?, owner_binding_pinid = ?, llm_id = ?, fallback_llm_id = ?, llm_provider = ?, llm_effort = ?, fallback_llm_provider = ?, fallback_llm_effort = ?, tools = ?, skills = ?, allow_chat_skills = ?, a2a_max_incoming_turns = ?, a2a_bye_cooldown_ms = ?, a2a_auto_reply_enabled = ?, homepage = ?, updated_at = ?
        WHERE id = ?`,
        [
          input.wallet_id ?? existing.wallet_id,
          input.mvc_address ?? existing.mvc_address,
          input.btc_address ?? existing.btc_address,
          input.doge_address ?? existing.doge_address,
          input.public_key ?? existing.public_key,
          input.chat_public_key ?? existing.chat_public_key,
          input.chat_public_key_pin_id !== undefined ? input.chat_public_key_pin_id : existing.chat_public_key_pin_id,
          input.name ?? existing.name,
          avatarDb instanceof Buffer ? avatarDb : null,
          enabled,
          input.metaid ?? existing.metaid,
          input.globalmetaid !== undefined ? input.globalmetaid : existing.globalmetaid,
          input.metabot_info_pinid !== undefined ? input.metabot_info_pinid : existing.metabot_info_pinid,
          nextMetabotType,
          input.created_by ?? existing.created_by,
          input.role ?? existing.role,
          input.soul ?? existing.soul,
          input.goal !== undefined ? input.goal : existing.goal,
          nextBio,
          nextDeprecatedBackground,
          bossId,
          input.boss_global_metaid !== undefined ? input.boss_global_metaid : existing.boss_global_metaid,
          input.owner_binding_pinid !== undefined ? input.owner_binding_pinid : existing.owner_binding_pinid,
          input.llm_id !== undefined ? input.llm_id : existing.llm_id,
          fallbackLlmId,
          llmProvider,
          llmEffort,
          fallbackLlmProvider,
          fallbackLlmEffort,
          toolsJson,
          skillsJson,
          allowChatSkillsJson,
          a2aMaxIncomingTurns,
          a2aByeCooldownMs,
          a2aAutoReplyEnabled,
          homepage,
          now,
          id,
        ]
      );
    } else {
      this.db.run(
        `UPDATE metabots SET
          wallet_id = ?, mvc_address = ?, btc_address = ?, doge_address = ?, public_key = ?, chat_public_key = ?, chat_public_key_pin_id = ?,
          name = ?, avatar = ?, enabled = ?, metaid = ?, globalmetaid = ?, metabot_info_pinid = ?, metabot_type = ?, created_by = ?,
          role = ?, soul = ?, goal = ?, bio = ?, background = ?, boss_id = ?, boss_global_metaid = ?, owner_binding_pinid = ?, llm_id = ?, fallback_llm_id = ?, llm_provider = ?, llm_effort = ?, fallback_llm_provider = ?, fallback_llm_effort = ?, tools = ?, skills = ?, allow_chat_skills = ?, a2a_max_incoming_turns = ?, a2a_bye_cooldown_ms = ?, a2a_auto_reply_enabled = ?, homepage = ?, updated_at = ?
        WHERE id = ?`,
        [
          input.wallet_id ?? existing.wallet_id,
          input.mvc_address ?? existing.mvc_address,
          input.btc_address ?? existing.btc_address,
          input.doge_address ?? existing.doge_address,
          input.public_key ?? existing.public_key,
          input.chat_public_key ?? existing.chat_public_key,
          input.chat_public_key_pin_id !== undefined ? input.chat_public_key_pin_id : existing.chat_public_key_pin_id,
          input.name ?? existing.name,
          avatarDb,
          enabled,
          input.metaid ?? existing.metaid,
          input.globalmetaid !== undefined ? input.globalmetaid : existing.globalmetaid,
          input.metabot_info_pinid !== undefined ? input.metabot_info_pinid : existing.metabot_info_pinid,
          nextMetabotType,
          input.created_by ?? existing.created_by,
          input.role ?? existing.role,
          input.soul ?? existing.soul,
          input.goal !== undefined ? input.goal : existing.goal,
          nextBio,
          nextDeprecatedBackground,
          bossId,
          input.boss_global_metaid !== undefined ? input.boss_global_metaid : existing.boss_global_metaid,
          input.owner_binding_pinid !== undefined ? input.owner_binding_pinid : existing.owner_binding_pinid,
          input.llm_id !== undefined ? input.llm_id : existing.llm_id,
          fallbackLlmId,
          llmProvider,
          llmEffort,
          fallbackLlmProvider,
          fallbackLlmEffort,
          toolsJson,
          skillsJson,
          allowChatSkillsJson,
          a2aMaxIncomingTurns,
          a2aByeCooldownMs,
          a2aAutoReplyEnabled,
          homepage,
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
    this.db.run('UPDATE metabots SET boss_id = NULL, updated_at = ? WHERE boss_id = ?', [Date.now(), id]);
    // cowork_sessions rows are deliberately left untouched: they keep the
    // deleted bot's metabot_id as the historical record of which bot produced
    // them (experience data survives the bot itself). But the native database
    // opens with foreign_keys = ON, and user_memories.metabot_id /
    // metaid_knowledge_entries.metabot_id / metaid_knowledge_procedures.metabot_id /
    // metabot_standing_pages.metabot_id / metabot_directives.metabot_id
    // reference metabots(id) with NO ACTION, so a bare DELETE fails with
    // FOREIGN KEY constraint failed whenever the bot has any memory / knowledge
    // / standing-page / directive rows (the UI then shows no reaction). Detach
    // those rows first — user_memories keeps its content with metabot_id
    // nulled, the other tables are deleted (their metabot_id is NOT NULL) — so
    // deletion always succeeds and leaves no orphaned references. Keep this
    // list in sync with every new metabot_id FK: the standing-pages omission
    // (tables added by the memory-evolution line without touching this method)
    // blocked deletion for any bot the hygiene pass had seeded pages for.
    this.db.run('UPDATE user_memories SET metabot_id = NULL WHERE metabot_id = ?', [id]);
    // The knowledge / standing-page / directives tables may not exist on every
    // install (SDK-managed, lazily created, or left over from a retired
    // feature); keep each cleanup best-effort so a missing table cannot break
    // bot deletion.
    try {
      this.db.run('DELETE FROM metaid_knowledge_entries WHERE metabot_id = ?', [id]);
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    }
    try {
      this.db.run('DELETE FROM metaid_knowledge_procedures WHERE metabot_id = ?', [id]);
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    }
    try {
      this.db.run('DELETE FROM metabot_standing_pages WHERE metabot_id = ?', [id]);
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    }
    try {
      this.db.run('DELETE FROM metabot_directives WHERE metabot_id = ?', [id]);
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/i.test(error.message)) throw error;
    }
    this.db.run('DELETE FROM metabots WHERE id = ?', [id]);
    this.saveDb();
    return true;
  }

  /**
   * Restore a Twin after events that can leave zero Twins (mnemonic restore
   * hardcodes 'worker'; deleting the Twin). No-op when a Twin already exists
   * or no eligible bots remain; otherwise promotes the earliest-created
   * non-welcome bot (lowest id on ties). The Welcome Bot is never promoted.
   */
  ensureTwinExists(): void {
    const twin = this.getOne<{ id: number }>(
      "SELECT id FROM metabots WHERE metabot_type = 'twin' LIMIT 1"
    );
    if (twin) return;
    this.db.run(
      `UPDATE metabots SET metabot_type = 'twin', updated_at = ?
       WHERE id = (
         SELECT id FROM metabots
         WHERE metabot_type != 'welcome'
         ORDER BY created_at ASC, id ASC
         LIMIT 1
       )`,
      [Date.now()]
    );
    this.saveDb();
  }

  // --- Metabot wallets (append-only: insert + query only) ---

  insertMetabotWallet(input: MetabotWalletInsert): MetabotWallet {
    const now = Date.now();
    const path = input.path ?? DEFAULT_WALLET_PATH;

    this.db.run(
      `INSERT INTO metabot_wallets (mnemonic, path, created_at) VALUES (?, ?, ?)`,
      sanitizeBindParams([input.mnemonic, path, now])
    );
    // Must read last_insert_rowid immediately, before any other DB operation (e.g. saveDb)
    const result = this.db.exec('SELECT last_insert_rowid() as id');
    const rawId = result[0]?.values?.[0]?.[0];
    const id = typeof rawId === 'number' ? rawId : Number(rawId) || 0;
    if (!id || id <= 0) {
      throw new Error(`insertMetabotWallet failed: last_insert_rowid returned invalid id (raw=${JSON.stringify(rawId)})`);
    }
    this.saveDb();
    return { id, mnemonic: input.mnemonic, path, created_at: now };
  }

  getMetabotWalletById(wallet_id: number): MetabotWallet | null {
    const row = this.getOne<MetabotWalletRow>(
      'SELECT * FROM metabot_wallets WHERE id = ?',
      [wallet_id]
    );
    return row ? rowToMetabotWallet(row) : null;
  }

  /**
   * Find wallet row by mnemonic. Append-only wallets survive MetaBot deletion, so restore must reuse the row
   * instead of INSERT (UNIQUE on mnemonic). Tries exact match first, then case-insensitive trimmed match.
   */
  getMetabotWalletByMnemonic(mnemonic: string): MetabotWallet | null {
    const trimmed = mnemonic.trim();
    if (!trimmed) return null;
    const exact = this.getOne<MetabotWalletRow>(
      'SELECT * FROM metabot_wallets WHERE mnemonic = ? LIMIT 1',
      [trimmed]
    );
    if (exact) return rowToMetabotWallet(exact);
    const norm = trimmed.toLowerCase();
    const row = this.getOne<MetabotWalletRow>(
      `SELECT * FROM metabot_wallets WHERE LOWER(TRIM(mnemonic)) = ? LIMIT 1`,
      [norm]
    );
    return row ? rowToMetabotWallet(row) : null;
  }

  /** Get wallet for a metabot by metabot id (looks up metabot.wallet_id). */
  getMetabotWalletByMetabotId(metabot_id: number): MetabotWallet | null {
    const metabot = this.getMetabotById(metabot_id);
    return metabot ? this.getMetabotWalletById(metabot.wallet_id) : null;
  }

  listRecentPinTransactionsByAddress(address: string, limit = 8): Array<{ txid: string; timestamp: number }> {
    const normalizedAddress = address.trim();
    if (!normalizedAddress) return [];
    const normalizedLimit = Number.isFinite(limit) && limit > 0 ? Math.max(1, Math.trunc(limit)) : 8;
    const rows = this.getAll<RecentMetaidPinTransactionRow>(
      `
        SELECT genesisTransaction AS txid, MAX(timestamp) AS timestamp
        FROM metaid_pins
        WHERE address = ?
          AND genesisTransaction IS NOT NULL
          AND TRIM(genesisTransaction) != ''
        GROUP BY genesisTransaction
        ORDER BY MAX(timestamp) DESC
        LIMIT ?
      `,
      [normalizedAddress, normalizedLimit]
    );

    return rows.flatMap((row) => {
      const txid = String(row.txid || '').trim().toLowerCase();
      const timestamp = Number(row.timestamp ?? 0);
      if (!/^[0-9a-f]{64}$/.test(txid)) return [];
      return [{
        txid,
        timestamp: Number.isFinite(timestamp) ? Math.trunc(timestamp) : 0,
      }];
    });
  }

  /**
   * Get the first Twin (metabot_type = 'twin') and its wallet for skill scripts (e.g. send_buzz).
   * Returns null if no twin exists.
   */
  getTwinWallet(): { id: number; name: string; mnemonic: string; path: string } | null {
    const twinRow = this.getOne<MetabotRow>(
      "SELECT * FROM metabots WHERE metabot_type = 'twin' ORDER BY id ASC LIMIT 1"
    );
    if (!twinRow) return null;
    const wallet = this.getMetabotWalletById(twinRow.wallet_id);
    if (!wallet) return null;
    return {
      id: twinRow.id,
      name: twinRow.name,
      mnemonic: wallet.mnemonic,
      path: wallet.path,
    };
  }
}
