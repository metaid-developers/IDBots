// feat/legacy-data-recovery — data recovery & visibility service.
//
// Scenario: after a Windows reinstall or a data-directory drift (changed
// %APPDATA% resolution, lost user profile, moved machine), the app silently
// creates a fresh empty database and the user's bots "disappear". This
// module turns that silent state into an active recovery offer:
//
//   1. Startup guard (runStartupDataRecoveryGuard): when the freshly opened
//      store has an empty metabots table, scan known candidate locations
//      for an idbots.sqlite that still has bots, and offer Import data /
//      Switch data directory / Skip this time (skip is persisted per
//      candidate database).
//   2. Version-change backup (runVersionChangeBackup): when the app version
//      changes, snapshot the sqlite trio (idbots.sqlite / -wal / -shm) into
//      userData/backups/ rotating slot directories — wired BEFORE the store
//      opens so the snapshot captures the pre-migration database.
//
// HARD CONSTRAINT (delegation): copy & create only — this module must never
// delete files or directories. "Keep the latest 5" is therefore implemented
// as a fixed 5-slot rotation in which the OLDEST slot is overwritten with
// fresh copies (fs.rmSync / unlink never appear here). The kv-table
// rotation in sqliteStore.ts (DELETE-based, KV_ROTATING_BACKUP_SLOTS) is
// the precedent for the retention COUNT; the file layer uses overwrite
// rotation because of the no-delete constraint. The only two "replace"
// primitives used are renameSync over a same-directory temp copy (atomic
// file replace) and a zero-length overwrite of stale sqlite sidecars.
//
// This module must stay importable from plain Node (unit tests run under
// `node --test` without Electron): it imports no Electron module. All
// Electron surfaces (dialog, relaunch, exit, app paths, store access) are
// injected by the caller through dependency objects.

import fs from 'fs';
import path from 'path';
import { loadNativeSqliteModule } from '../nativeSqliteDatabase';
import { APP_NAME, DB_FILENAME } from '../appConstants';

/** Directory under userData that holds all recovery/backup artifacts. */
export const DATA_RECOVERY_BACKUPS_DIRNAME = 'backups';
/** Marker recording the app version that last ran (drives the upgrade backup). */
export const DATA_RECOVERY_VERSION_MARKER_FILENAME = 'version-marker.json';
/** Marker recording a persistent "switch data directory" choice. Lives in
 *  <appData>/<APP_NAME>/ so an early-boot path resolution can honor it. */
export const DATA_RECOVERY_DIRECTORY_MARKER_FILENAME = 'data-directory-override.json';
/** Append-only audit trail of every backup/import/switch action. */
export const DATA_RECOVERY_BACKUP_LOG_FILENAME = 'backup-log.txt';
/** Rotating slot count per backup family (spec: keep the latest 5). */
export const DATA_RECOVERY_MAX_BACKUP_SLOTS = 5;
/** kv key (SqliteStore kv table) holding { dbPath: skippedAt } entries. */
export const SKIPPED_CANDIDATES_KV_KEY = 'legacy_data_recovery.skipped_candidates';
/** Legacy pre-rename app directories treated as candidate roots. */
export const LEGACY_DATA_APP_NAMES = ['OctoBot', 'octobot'];

const SQLITE_TRIO_SUFFIXES = ['', '-wal', '-shm'] as const;
/** Safety cap: how many entries of one parent directory we inspect. */
const MAX_ENTRIES_PER_ROOT = 50;

// ---------------------------------------------------------------------------
// Read-only sqlite probing
// ---------------------------------------------------------------------------

export interface SqliteMetabotsSummary {
  metabotsCount: number;
  lastUpdatedAt: number | null;
}

/** Minimal shape of node:sqlite's DatabaseSync restricted to what the
 *  read-only probe needs (their full wrapper type lives in
 *  nativeSqliteDatabase.ts and does not expose a readOnly constructor). */
interface ProbeDatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): Array<Record<string, unknown>> };
  close(): void;
}

/**
 * Open a candidate idbots.sqlite READ-ONLY and read the metabots row count
 * plus the newest updated_at. The count EXCLUDES the seeded 'welcome'
 * system bot: a library holding only the welcome bot is still an empty
 * library for recovery purposes (the 2026-11-01 Windows incident left
 * users with exactly that state — a fresh DB plus a welcome bot — and
 * they must still be offered recovery). Schemas without a metabot_type
 * column fall back to the unfiltered count.
 *
 * The database is opened through SQLite's
 * `immutable=1` URI mode: a plain { readOnly: true } open of a WAL-mode
 * database CREATES -shm/-wal sidecars next to the candidate (verified
 * empirically on node:sqlite), which would violate the read-only contract
 * with the user's old data directory — immutable mode takes no locks and
 * writes nothing.
 *
 * Trade-off (documented): immutable mode ignores a live un-checkpointed
 * -wal tail, so the count may understate a database that was killed
 * mid-write. Candidates are normally quiescent (the old install closed
 * cleanly), and the IMPORT action copies the full trio anyway, so any WAL
 * content still comes across. Returns null for every failure mode (missing
 * file, no node:sqlite, unreadable database, missing metabots table) —
 * failures degrade to "not a usable candidate", never throw.
 */
export function readSqliteMetabotsSummary(dbPath: string): SqliteMetabotsSummary | null {
  try {
    const stats = fs.statSync(dbPath);
    if (!stats.isFile() || stats.size <= 0) {
      return null;
    }
  } catch {
    return null;
  }

  const native = loadNativeSqliteModule();
  if (!native) {
    return null;
  }

  let db: ProbeDatabaseSync;
  try {
    const DatabaseSync = (native as unknown as {
      DatabaseSync: new (filename: string, options?: { readOnly?: boolean }) => ProbeDatabaseSync;
    }).DatabaseSync;
    // Percent-encode each path segment so spaces / '?' / CJK in real-world
    // data directories cannot corrupt the file: URI. A Windows drive-letter
    // segment ("C:") stays literal — that is SQLite's canonical Windows URI
    // form (file:C:/Users/...).
    const encoded = path
      .resolve(dbPath)
      .split(path.sep)
      .map((segment, index) => (/^[A-Za-z]:$/.test(segment) && index === 0 ? segment : encodeURIComponent(segment)))
      .join('/');
    db = new DatabaseSync(`file:${encoded}?immutable=1`, { readOnly: true });
  } catch {
    return null;
  }

  try {
    let rows: Array<Record<string, unknown>>;
    try {
      // Count REAL bots: the seeded 'welcome' system bot does not make a
      // library non-empty (a fresh install carries one). A NULL type counts
      // as a real bot — very old schemas predate the metabot_type backfill.
      rows = db
        .prepare(
          "SELECT COUNT(*) AS metabots_count, MAX(updated_at) AS last_updated_at FROM metabots WHERE metabot_type IS NULL OR metabot_type != 'welcome'",
        )
        .all();
    } catch {
      // Legacy schema without a metabot_type column: fall back to the
      // unfiltered count rather than losing the candidate.
      rows = db
        .prepare('SELECT COUNT(*) AS metabots_count, MAX(updated_at) AS last_updated_at FROM metabots')
        .all();
    }
    const row = rows[0];
    if (!row) {
      return null;
    }
    const count = Number(row.metabots_count);
    if (!Number.isFinite(count)) {
      return null;
    }
    const rawUpdated = row.last_updated_at;
    const lastUpdated = rawUpdated === null || rawUpdated === undefined ? null : Number(rawUpdated);
    return {
      metabotsCount: count,
      lastUpdatedAt: lastUpdated !== null && Number.isFinite(lastUpdated) ? lastUpdated : null,
    };
  } catch {
    // Missing metabots table or unreadable database: not an IDBots library
    // with bots in it.
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close of a read-only handle
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate discovery
// ---------------------------------------------------------------------------

export interface LegacyDataDiscoveryInput {
  /** Resolved %APPDATA%-equivalent root (e.g. app.getPath('appData')). */
  appDataPath: string;
  /** Current userData directory — always excluded from candidates. */
  currentUserDataPath: string;
  /** %LOCALAPPDATA%-equivalent root when known (Windows). Optional. */
  localAppDataPath?: string | null;
  /** `<SystemDrive>:\Windows.old\Users` when present (reinstall scenario). Optional. */
  windowsOldUsersPath?: string | null;
  /** Legacy pre-rename app directory names. Defaults to LEGACY_DATA_APP_NAMES. */
  legacyAppNames?: string[];
}

export interface LegacyDbCandidate {
  /** Candidate data directory (contains idbots.sqlite). */
  rootDir: string;
  dbPath: string;
  metabotsCount: number;
  lastUpdatedAt: number | null;
  dbBytes: number;
}

function isCaseInsensitivePathCompare(): boolean {
  return process.platform === 'win32';
}

/** Normalize a path for use as a dedup/skip key. */
export function normalizeDataPathKey(target: string): string {
  const resolved = path.resolve(target);
  return isCaseInsensitivePathCompare() ? resolved.toLowerCase() : resolved;
}

function sameDataPath(a: string, b: string): boolean {
  return normalizeDataPathKey(a) === normalizeDataPathKey(b);
}

/**
 * Resolve the %LOCALAPPDATA%-equivalent root: env var when set (Windows
 * always sets LOCALAPPDATA), else the sibling "Local" directory next to the
 * Roaming appData path. Returns null when neither exists — non-Windows
 * platforms without that layout simply skip this root.
 */
export function resolveLocalAppDataRoot(appDataPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.trim()
    ? path.resolve(env.LOCALAPPDATA.trim())
    : null;
  if (fromEnv && fs.existsSync(fromEnv)) {
    return fromEnv;
  }
  const derived = path.join(path.dirname(path.resolve(appDataPath)), 'Local');
  return fs.existsSync(derived) ? derived : null;
}

/**
 * Resolve the Windows.old users directory (reinstall scenario). Uses
 * %SystemDrive% when available (defaults to C:), and returns null when the
 * directory does not exist — macOS/Linux dev machines never see it.
 */
export function resolveWindowsOldUsersRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const drive = typeof env.SystemDrive === 'string' && env.SystemDrive.trim() ? env.SystemDrive.trim() : 'C:';
  const root = `${drive}\\Windows.old\\Users`;
  return fs.existsSync(root) ? root : null;
}

/** Collect candidate data directories directly under one parent root. */
function collectEntryDirs(rootDir: string, appName: string, legacyNames: string[], out: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return; // root missing or unreadable — silently skip
  }
  const loweredApp = appName.toLowerCase();
  const loweredLegacy = legacyNames.map((name) => name.toLowerCase());
  let taken = 0;
  for (const entry of entries) {
    if (taken >= MAX_ENTRIES_PER_ROOT) {
      break;
    }
    if (!entry.isDirectory()) {
      continue;
    }
    const lowered = entry.name.toLowerCase();
    // "IDBots*" prefix (e.g. IDBots, IDBots-old, a backup copy) plus the
    // exact legacy pre-rename directories.
    if (!lowered.startsWith(loweredApp) && !loweredLegacy.includes(lowered)) {
      continue;
    }
    out.push(path.join(rootDir, entry.name));
    taken += 1;
  }
}

/**
 * List candidate data directories (not yet probed): every `<root>/IDBots*`
 * and legacy `OctoBot`/`octobot` directory under the resolved appData root,
 * the local-app-data root, and each Windows.old user's Roaming directory.
 * De-duplicated and with the current userData directory excluded. Missing
 * Windows-specific roots are skipped silently, so macOS dev environments
 * simply get an empty list.
 */
export function listLegacyDataDirCandidates(input: LegacyDataDiscoveryInput): string[] {
  const legacyNames = input.legacyAppNames ?? LEGACY_DATA_APP_NAMES;
  const scanRoots: string[] = [input.appDataPath];
  if (input.localAppDataPath) {
    scanRoots.push(input.localAppDataPath);
  }

  const dirs: string[] = [];
  for (const root of scanRoots) {
    collectEntryDirs(root, APP_NAME, legacyNames, dirs);
  }

  if (input.windowsOldUsersPath) {
    let users: fs.Dirent[] = [];
    try {
      users = fs.readdirSync(input.windowsOldUsersPath, { withFileTypes: true });
    } catch {
      users = [];
    }
    let taken = 0;
    for (const user of users) {
      if (taken >= MAX_ENTRIES_PER_ROOT) {
        break;
      }
      if (!user.isDirectory()) {
        continue;
      }
      collectEntryDirs(
        path.join(input.windowsOldUsersPath, user.name, 'AppData', 'Roaming'),
        APP_NAME,
        legacyNames,
        dirs,
      );
      taken += 1;
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of dirs) {
    const key = normalizeDataPathKey(dir);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (sameDataPath(dir, input.currentUserDataPath)) {
      continue;
    }
    result.push(path.resolve(dir));
  }
  return result;
}

/**
 * Discover usable candidates: probe each candidate directory's
 * idbots.sqlite read-only and keep those with at least one metabot row.
 */
export function discoverLegacyDbCandidates(input: LegacyDataDiscoveryInput): LegacyDbCandidate[] {
  const candidates: LegacyDbCandidate[] = [];
  for (const dir of listLegacyDataDirCandidates(input)) {
    const dbPath = path.join(dir, DB_FILENAME);
    const summary = readSqliteMetabotsSummary(dbPath);
    if (!summary || summary.metabotsCount <= 0) {
      continue;
    }
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(dbPath).size;
    } catch {
      dbBytes = 0;
    }
    candidates.push({
      rootDir: dir,
      dbPath,
      metabotsCount: summary.metabotsCount,
      lastUpdatedAt: summary.lastUpdatedAt,
      dbBytes,
    });
  }
  return candidates;
}

/** Rank candidates: most bots first, then most recently updated. */
export function rankLegacyDbCandidates(candidates: LegacyDbCandidate[]): LegacyDbCandidate[] {
  return [...candidates].sort((a, b) => {
    if (b.metabotsCount !== a.metabotsCount) {
      return b.metabotsCount - a.metabotsCount;
    }
    const aUpdated = a.lastUpdatedAt ?? 0;
    const bUpdated = b.lastUpdatedAt ?? 0;
    if (bUpdated !== aUpdated) {
      return bUpdated - aUpdated;
    }
    return a.dbPath < b.dbPath ? -1 : a.dbPath > b.dbPath ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Backup slots (copy & create only — see module header)
// ---------------------------------------------------------------------------

export interface BackupSlotMeta {
  createdAt: number;
  label: string;
  fromVersion?: string;
  toVersion?: string;
  files: string[];
}

export function backupsDirFor(userDataPath: string): string {
  return path.join(userDataPath, DATA_RECOVERY_BACKUPS_DIRNAME);
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Copy one file via a same-directory temp copy + rename so a partial write
 *  never lands on the final name. Rename is an overwrite, not a delete. */
function copyFileAtomic(source: string, dest: string): void {
  ensureDir(path.dirname(dest));
  const tmp = `${dest}.recovery-tmp`;
  fs.copyFileSync(source, tmp);
  fs.renameSync(tmp, dest);
}

/**
 * Copy the sqlite trio (idbots.sqlite, -wal, -shm — whichever exist in the
 * source directory) into destDir. Per-file failures are logged and skipped;
 * the returned list names the files actually copied.
 */
export function copySqliteTrio(sourceDir: string, destDir: string, log: (line: string) => void = () => {}): string[] {
  const copied: string[] = [];
  for (const suffix of SQLITE_TRIO_SUFFIXES) {
    const source = path.join(sourceDir, DB_FILENAME + suffix);
    if (!fs.existsSync(source)) {
      continue;
    }
    try {
      copyFileAtomic(source, path.join(destDir, DB_FILENAME + suffix));
      copied.push(DB_FILENAME + suffix);
    } catch (error) {
      log(`[data-recovery] WARN failed to copy ${source}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return copied;
}

/**
 * After an import replaced the main database file, a stale non-empty -wal
 * /-shm left over from the previous (empty) database must never outlive the
 * swap: SQLite would try to replay the old WAL onto the new database. No
 * deletion allowed, so stale sidecars are OVERWRITTEN with zero bytes — a
 * zero-length WAL/SHM is a well-defined "no frames" state for SQLite.
 */
export function overwriteStaleSqliteSidecars(destDir: string, replacedSuffixes: ReadonlySet<string>): void {
  for (const suffix of ['-wal', '-shm'] as const) {
    if (replacedSuffixes.has(suffix)) {
      continue;
    }
    const dest = path.join(destDir, DB_FILENAME + suffix);
    try {
      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        fs.writeFileSync(dest, '');
      }
    } catch {
      // best-effort: a failed overwrite is logged by the caller's copy step
    }
  }
}

function slotDirFor(backupsDir: string, prefix: string, index: number): string {
  return path.join(backupsDir, `${prefix}-slot-${index}`);
}

function readSlotMeta(dir: string): BackupSlotMeta | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'slot-meta.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && typeof (parsed as BackupSlotMeta).createdAt === 'number') {
      return parsed as BackupSlotMeta;
    }
  } catch {
    // unreadable/missing meta → slot treated as empty
  }
  return null;
}

/**
 * Pick the slot directory to write into: the first empty/invalid slot, else
 * the slot with the oldest createdAt (which the new backup overwrites).
 * This is the entire retention mechanism — no directory is ever removed.
 */
export function pickBackupSlotDir(
  backupsDir: string,
  prefix: string,
  maxSlots: number = DATA_RECOVERY_MAX_BACKUP_SLOTS,
): { slotDir: string; index: number } {
  let chosen: { slotDir: string; index: number; createdAt: number } | null = null;
  for (let index = 1; index <= maxSlots; index += 1) {
    const dir = slotDirFor(backupsDir, prefix, index);
    const meta = fs.existsSync(dir) ? readSlotMeta(dir) : null;
    if (!meta) {
      return { slotDir: dir, index };
    }
    if (!chosen || meta.createdAt < chosen.createdAt) {
      chosen = { slotDir: dir, index, createdAt: meta.createdAt };
    }
  }
  return chosen ?? { slotDir: slotDirFor(backupsDir, prefix, 1), index: 1 };
}

/** Append one line to the append-only backup audit log. Best-effort. */
export function appendBackupLog(backupsDir: string, line: string, now: number = Date.now()): void {
  try {
    ensureDir(backupsDir);
    fs.appendFileSync(
      path.join(backupsDir, DATA_RECOVERY_BACKUP_LOG_FILENAME),
      `${new Date(now).toISOString()} ${line}\n`,
      'utf8',
    );
  } catch {
    // best-effort audit trail
  }
}

/**
 * Snapshot the sqlite trio from sourceDir into a rotating backup slot under
 * userData/backups/. Returns the slot directory and the copied file names.
 */
export function backupDbTrioIntoRotatingSlot(options: {
  userDataPath: string;
  sourceDir: string;
  prefix: 'version' | 'action';
  label: string;
  fromVersion?: string;
  toVersion?: string;
  now?: number;
  log?: (line: string) => void;
}): { slotDir: string; copied: string[] } {
  const backupsDir = backupsDirFor(options.userDataPath);
  ensureDir(backupsDir);
  const { slotDir } = pickBackupSlotDir(backupsDir, options.prefix);
  ensureDir(slotDir);
  const copied = copySqliteTrio(options.sourceDir, slotDir, options.log ?? (() => {}));
  const meta: BackupSlotMeta = {
    createdAt: options.now ?? Date.now(),
    label: options.label,
    ...(options.fromVersion !== undefined ? { fromVersion: options.fromVersion } : {}),
    ...(options.toVersion !== undefined ? { toVersion: options.toVersion } : {}),
    files: copied,
  };
  fs.writeFileSync(path.join(slotDir, 'slot-meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  appendBackupLog(
    backupsDir,
    `backup prefix=${options.prefix} slot=${path.basename(slotDir)} label=${options.label} files=[${copied.join(', ')}]`,
    options.now,
  );
  return { slotDir, copied };
}

// ---------------------------------------------------------------------------
// Version-change backup (feature ③)
// ---------------------------------------------------------------------------

export type VersionBackupOutcome = 'backup-created' | 'marker-initialized' | 'no-version-change';

export function readVersionMarker(userDataPath: string): { version: string; at: number } | null {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(path.join(backupsDirFor(userDataPath), DATA_RECOVERY_VERSION_MARKER_FILENAME), 'utf8'),
    );
    if (parsed && typeof parsed === 'object' && typeof (parsed as { version?: unknown }).version === 'string') {
      const at = Number((parsed as { at?: unknown }).at);
      return { version: (parsed as { version: string }).version, at: Number.isFinite(at) ? at : 0 };
    }
  } catch {
    // missing/corrupt marker → treated as absent
  }
  return null;
}

export function writeVersionMarker(userDataPath: string, version: string, now: number = Date.now()): void {
  const backupsDir = backupsDirFor(userDataPath);
  ensureDir(backupsDir);
  fs.writeFileSync(
    path.join(backupsDir, DATA_RECOVERY_VERSION_MARKER_FILENAME),
    JSON.stringify({ version, at: now }, null, 2),
    'utf8',
  );
}

/**
 * Whether <userDataPath> already carries a non-empty idbots.sqlite — the
 * "is this an upgrade" signal for the version-change backup. Called BEFORE
 * the store opens, so there is no store to query: file presence + size is
 * the whole answer (a fresh install has no database file yet; an upgrade
 * boot has the previous build's file, pre-migration bytes).
 */
export function hasExistingSqliteDataFile(userDataPath: string): boolean {
  try {
    return fs.statSync(path.join(userDataPath, DB_FILENAME)).size > 0;
  } catch {
    return false;
  }
}

/**
 * Pre-upgrade sqlite snapshot: run once per boot BEFORE the store opens.
 * SqliteStore.create runs schema migrations at open, so a snapshot taken
 * after `store ready` would capture post-migration bytes and could never
 * rescue a bad migration — the pre-open on-disk trio is the state that
 * must be preserved.
 * - same version as the marker → nothing to do;
 * - version changed (or marker exists with another version) → snapshot the
 *   trio into a rotating version slot, then update the marker;
 * - no marker yet (first boot after this feature ships): a database that
 *   already carries data is an upgrade from an older build → snapshot it;
 *   an empty database is a fresh install → only initialize the marker.
 */
export function runVersionChangeBackup(options: {
  currentVersion: string;
  userDataPath: string;
  /** Whether userData already carries a non-empty idbots.sqlite (pre-open there is no store to query). */
  hasExistingData: boolean;
  now?: number;
  log?: (line: string) => void;
}): VersionBackupOutcome {
  const marker = readVersionMarker(options.userDataPath);
  if (marker && marker.version === options.currentVersion) {
    return 'no-version-change';
  }
  const isUpgrade = marker !== null || options.hasExistingData;
  if (isUpgrade) {
    const previousVersion = marker?.version;
    backupDbTrioIntoRotatingSlot({
      userDataPath: options.userDataPath,
      sourceDir: options.userDataPath,
      prefix: 'version',
      label: marker
        ? `upgrade ${previousVersion} -> ${options.currentVersion}`
        : `pre-first-marker (existing data) -> ${options.currentVersion}`,
      ...(previousVersion !== undefined ? { fromVersion: previousVersion } : {}),
      toVersion: options.currentVersion,
      now: options.now,
      log: options.log,
    });
    writeVersionMarker(options.userDataPath, options.currentVersion, options.now);
    return 'backup-created';
  }
  writeVersionMarker(options.userDataPath, options.currentVersion, options.now);
  return 'marker-initialized';
}

// ---------------------------------------------------------------------------
// Persistent "switch data directory" marker (consumed at early boot)
// ---------------------------------------------------------------------------

/**
 * Read the persisted data-directory override from <appData>/<APP_NAME>/.
 * Returns the target directory only when it still exists and still contains
 * an idbots.sqlite; every other state (missing marker, corrupt JSON, target
 * gone) reads as "no override". The marker file is never deleted — an
 * invalid one is simply ignored until it becomes valid again.
 */
export function readDataDirectoryOverrideMarker(appDataPath: string): string | null {
  const markerPath = path.join(appDataPath, APP_NAME, DATA_RECOVERY_DIRECTORY_MARKER_FILENAME);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    const rawTarget = parsed && typeof parsed === 'object'
      ? (parsed as { targetDir?: unknown }).targetDir
      : undefined;
    if (typeof rawTarget !== 'string' || !rawTarget.trim()) {
      return null;
    }
    const target = path.resolve(rawTarget.trim());
    if (!path.isAbsolute(target)) {
      return null;
    }
    if (!fs.existsSync(target) || !fs.existsSync(path.join(target, DB_FILENAME))) {
      return null;
    }
    return target;
  } catch {
    return null;
  }
}

export function writeDataDirectoryOverrideMarker(appDataPath: string, targetDir: string, now: number = Date.now()): void {
  const markerDir = path.join(appDataPath, APP_NAME);
  ensureDir(markerDir);
  fs.writeFileSync(
    path.join(markerDir, DATA_RECOVERY_DIRECTORY_MARKER_FILENAME),
    JSON.stringify({ targetDir: path.resolve(targetDir), createdAt: now }, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Startup guard (feature ①)
// ---------------------------------------------------------------------------

/** The subset of Electron's MessageBoxOptions the guard needs (keeps the
 *  module Electron-free; the caller forwards to dialog.showMessageBox). */
export interface DataRecoveryMessageBoxOptions {
  type: 'question' | 'info';
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId?: number;
  cancelId?: number;
  noLink?: boolean;
}

export interface DataRecoveryGuardDeps {
  discovery: LegacyDataDiscoveryInput;
  /** metabots row count of the freshly opened current store. */
  getCurrentMetabotsCount: () => number;
  /** Skipped candidate db paths persisted in the current store's kv. */
  getSkippedCandidateDbPaths: () => string[];
  persistSkippedCandidate: (dbPath: string) => void;
  showMessageBox: (options: DataRecoveryMessageBoxOptions) => Promise<{ response: number }>;
  /** Close the current SqliteStore so its file handle releases before an
   *  import overwrites the database (required on Windows). */
  closeCurrentStore: () => void;
  relaunchApp: () => void;
  exitApp: (code: number) => void;
  log: (line: string) => void;
  now?: () => number;
}

export type DataRecoveryGuardAction =
  | 'library-not-empty'
  | 'no-candidates'
  | 'all-skipped'
  | 'skipped-persisted'
  | 'import-executed'
  | 'import-failed'
  | 'switch-executed'
  | 'switch-marker-failed'
  | 'backup-failed'
  | 'dialog-error';

function formatTimestamp(ms: number): string {
  const date = new Date(ms);
  return Number.isFinite(ms) && ms > 0
    ? `${date.toISOString().replace('T', ' ').slice(0, 19)} UTC`
    : 'unknown';
}

/**
 * Startup data-recovery guard. Call once per boot right after the store is
 * ready, before any other service starts using it. When the guard performs
 * an import or a switch it relaunches the app and exits the process — the
 * caller must stop booting when the returned action is `import-executed` /
 * `switch-executed`.
 */
export async function runStartupDataRecoveryGuard(deps: DataRecoveryGuardDeps): Promise<DataRecoveryGuardAction> {
  const currentCount = deps.getCurrentMetabotsCount();
  if (currentCount > 0) {
    return 'library-not-empty';
  }

  const candidates = rankLegacyDbCandidates(discoverLegacyDbCandidates(deps.discovery));
  if (candidates.length === 0) {
    deps.log('[data-recovery] empty library but no candidate databases found');
    return 'no-candidates';
  }

  const skippedKeys = new Set(deps.getSkippedCandidateDbPaths().map((dbPath) => normalizeDataPathKey(dbPath)));
  const freshCandidates = candidates.filter((candidate) => !skippedKeys.has(normalizeDataPathKey(candidate.dbPath)));
  if (freshCandidates.length === 0) {
    deps.log('[data-recovery] all candidates previously skipped by the user');
    return 'all-skipped';
  }

  const best = freshCandidates[0];
  const lastUpdatedText = formatTimestamp(best.lastUpdatedAt ?? 0);
  let response: number;
  try {
    const result = await deps.showMessageBox({
      type: 'question',
      title: 'IDBots — previous data found',
      message: `Found previous IDBots data: ${best.metabotsCount} bot(s), last updated ${lastUpdatedText}.`,
      detail: [
        `Database: ${best.dbPath}`,
        '',
        'Import data — copy this database into the current data directory (a backup of the current one is taken first).',
        'Switch data directory — use that directory as the IDBots data directory from now on (a backup of the current one is taken first).',
        'Skip this time — keep the empty library; you will not be asked again about this database.',
      ].join('\n'),
      buttons: ['Import data', 'Switch data directory', 'Skip this time'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    response = result.response;
  } catch (error) {
    deps.log(`[data-recovery] WARN recovery dialog failed: ${error instanceof Error ? error.message : String(error)}`);
    return 'dialog-error';
  }

  if (response === 2) {
    deps.persistSkippedCandidate(best.dbPath);
    deps.log(`[data-recovery] user skipped candidate ${best.dbPath} (persisted)`);
    return 'skipped-persisted';
  }

  // Acceptance: before ANY import/switch action, snapshot the current
  // sqlite trio into userData/backups/ and write the log line.
  const currentUserDataPath = deps.discovery.currentUserDataPath;
  const actionLabel = response === 0
    ? `pre-import (source: ${best.dbPath})`
    : `pre-switch (target: ${best.rootDir})`;
  let backupCopied: string[] = [];
  try {
    const backup = backupDbTrioIntoRotatingSlot({
      userDataPath: currentUserDataPath,
      sourceDir: currentUserDataPath,
      prefix: 'action',
      label: actionLabel,
      now: deps.now?.(),
      log: deps.log,
    });
    backupCopied = backup.copied;
  } catch (error) {
    deps.log(`[data-recovery] ERROR pre-action backup threw: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!backupCopied.includes(DB_FILENAME)) {
    // The database we are about to replace could not be backed up — abort
    // the destructive action and boot normally; the guard will re-offer on
    // the next start.
    deps.log('[data-recovery] ERROR pre-action backup did not capture the main database; aborting action');
    return 'backup-failed';
  }

  if (response === 0) {
    // IMPORT: close the current store (releases the Windows file handle),
    // copy the candidate trio over the current files, neutralize any stale
    // sidecars, log, and relaunch.
    try {
      deps.closeCurrentStore();
    } catch (error) {
      deps.log(`[data-recovery] WARN closing current store before import: ${error instanceof Error ? error.message : String(error)}`);
    }
    const copied = copySqliteTrio(best.rootDir, currentUserDataPath, deps.log);
    const replacedSuffixes = new Set(copied.map((name) => name.slice(DB_FILENAME.length)));
    overwriteStaleSqliteSidecars(currentUserDataPath, replacedSuffixes);
    if (!copied.includes(DB_FILENAME)) {
      deps.log('[data-recovery] ERROR import failed to copy the main database file');
      appendBackupLog(backupsDirFor(currentUserDataPath), `import-failed source=${best.dbPath}`, deps.now?.());
      return 'import-failed';
    }
    appendBackupLog(
      backupsDirFor(currentUserDataPath),
      `import source=${best.dbPath} files=[${copied.join(', ')}]`,
      deps.now?.(),
    );
    try {
      await deps.showMessageBox({
        type: 'info',
        title: 'IDBots — data imported',
        message: 'Your previous data has been imported into this data directory. IDBots will restart now.',
        buttons: ['OK'],
      });
    } catch {
      // informational only; proceed to relaunch regardless
    }
    deps.log(`[data-recovery] import from ${best.dbPath} complete; relaunching`);
    deps.relaunchApp();
    deps.exitApp(0);
    return 'import-executed';
  }

  // SWITCH: persist the data-directory override marker (honored on next
  // boot unless an env override is present), log, and relaunch.
  try {
    writeDataDirectoryOverrideMarker(deps.discovery.appDataPath, best.rootDir, deps.now?.());
  } catch (error) {
    deps.log(`[data-recovery] ERROR writing data-directory override marker: ${error instanceof Error ? error.message : String(error)}`);
    return 'switch-marker-failed';
  }
  appendBackupLog(
    backupsDirFor(currentUserDataPath),
    `switch target=${best.rootDir} bots=${best.metabotsCount}`,
    deps.now?.(),
  );
  try {
    await deps.showMessageBox({
      type: 'info',
      title: 'IDBots — data directory switched',
      message: 'IDBots will use your previous data directory from the next start. IDBots will restart now.',
      buttons: ['OK'],
    });
  } catch {
    // informational only; proceed to relaunch regardless
  }
  deps.log(`[data-recovery] data directory switched to ${best.rootDir}; relaunching`);
  deps.relaunchApp();
  deps.exitApp(0);
  return 'switch-executed';
}
