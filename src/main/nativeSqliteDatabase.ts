import type { SqliteDatabase, SqliteExecResult } from './sqliteTypes';

interface NativeSqliteModule {
  DatabaseSync: new (filename: string) => NativeDatabaseSync;
}

interface NativeDatabaseSync {
  exec(sql: string): void;
  prepare(sql: string): NativeStatementSync;
  close(): void;
}

interface NativeStatementSync {
  sourceSQL?: string;
  all(...params: unknown[]): Array<Record<string, unknown>>;
  run(...params: unknown[]): { changes?: number | bigint };
  columns(): Array<{ name?: string; column?: string }>;
}

const trimTrailingSemicolons = (sql: string): string =>
  sql.trim().replace(/;+\s*$/u, '').trim();

const hasUnpreparedTrailingSql = (sql: string, statement: NativeStatementSync): boolean => {
  const source = statement.sourceSQL;
  if (!source) return false;
  return trimTrailingSemicolons(source) !== trimTrailingSemicolons(sql);
};

const toSafeNumber = (value: number | bigint | undefined): number => {
  if (typeof value === 'bigint') {
    return Number(value);
  }
  return value ?? 0;
};

const rowsToExecResult = (
  statement: NativeStatementSync,
  rows: Array<Record<string, unknown>>,
): SqliteExecResult[] => {
  const columns = statement.columns().map((column) => column.name || column.column || '');
  if (columns.length === 0) {
    return [];
  }

  return [{
    columns,
    values: rows.map((row) => columns.map((column) => row[column])),
  }];
};

const MAX_CACHED_STATEMENTS = 128;
const CACHEABLE_SQL_RE = /^\s*(?:WITH|SELECT|INSERT|UPDATE|DELETE)\b/iu;
const SCHEMA_MUTATION_SQL_RE = /^\s*(?:CREATE|ALTER|DROP|VACUUM|ATTACH|DETACH)\b/iu;

export class NativeSqliteDatabase implements SqliteDatabase {
  private readonly db: NativeDatabaseSync;
  private readonly statementCache = new Map<string, NativeStatementSync>();
  private rowsModified = 0;
  private closed = false;

  constructor(filename: string, module: NativeSqliteModule) {
    this.db = new module.DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
    // 清单 #11: concurrent-write safety. The SQLite defaults (rollback journal,
    // busy_timeout = 0) make a write from ANY second connection fail instantly
    // with SQLITE_BUSY ("database is locked") — reproduced live when a Twin
    // session and a delegated worker session wrote the same database at the
    // same time and the worker session was killed mid-task. WAL lets readers
    // run alongside the single writer without blocking, and busy_timeout makes
    // a writer wait for the other connection's transaction to finish instead
    // of throwing. Both are idempotent per-connection/per-database settings;
    // journal_mode = WAL persists in the database header, so existing user
    // databases keep working and every later connection inherits WAL.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    try {
      this.db.exec('PRAGMA journal_mode = WAL;');
      this.db.exec('PRAGMA synchronous = NORMAL;');
    } catch {
      // WAL unavailable (read-only media, exotic filesystems): degrade to the
      // default rollback journal; busy_timeout above still serializes writers.
    }
    try {
      this.db.exec('PRAGMA temp_store = MEMORY;');
      this.db.exec('PRAGMA cache_size = -32000;');
    } catch {
      // Optional memory-backed temp B-trees and 32 MiB page cache; ignore if unsupported.
    }
  }

  private getPreparedStatement(sql: string): { statement: NativeStatementSync; cached: boolean } {
    if (SCHEMA_MUTATION_SQL_RE.test(sql)) {
      this.statementCache.clear();
    }
    if (!CACHEABLE_SQL_RE.test(sql)) {
      return { statement: this.db.prepare(sql), cached: false };
    }
    const existing = this.statementCache.get(sql);
    if (existing) {
      this.statementCache.delete(sql);
      this.statementCache.set(sql, existing);
      return { statement: existing, cached: true };
    }
    const statement = this.db.prepare(sql);
    if (hasUnpreparedTrailingSql(sql, statement)) {
      return { statement, cached: false };
    }
    if (this.statementCache.size >= MAX_CACHED_STATEMENTS) {
      const oldestKey = this.statementCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.statementCache.delete(oldestKey);
      }
    }
    this.statementCache.set(sql, statement);
    return { statement, cached: true };
  }

  exec(sql: string, params: unknown[] = []): SqliteExecResult[] {
    this.assertOpen();
    const { statement, cached } = this.getPreparedStatement(sql);
    if (!cached && params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      return [];
    }
    try {
      return rowsToExecResult(statement, statement.all(...params));
    } catch (error) {
      this.statementCache.delete(sql);
      throw error;
    }
  }

  run(sql: string, params: unknown[] = []): unknown {
    this.assertOpen();
    const { statement, cached } = this.getPreparedStatement(sql);
    if (!cached && params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      this.rowsModified = 0;
      return undefined;
    }

    try {
      const result = statement.run(...params);
      this.rowsModified = toSafeNumber(result.changes);
      return result;
    } catch (error) {
      this.statementCache.delete(sql);
      throw error;
    }
  }

  getRowsModified(): number {
    return this.rowsModified;
  }

  close(): void {
    if (this.closed) return;
    this.statementCache.clear();
    // Fold any WAL frames back into the main database file so a later
    // main-file-only reader (e.g. the sql.js fallback backend) sees the full
    // contents after a clean shutdown. Best-effort: a concurrent writer can
    // make the checkpoint busy, and the database stays valid either way.
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {
      // best-effort checkpoint; close proceeds regardless
    }
    this.db.close();
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error('Database closed');
    }
  }
}

export function loadNativeSqliteModule(): NativeSqliteModule | null {
  const emitWarning = process.emitWarning;
  try {
    process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
      if (args[0] === 'ExperimentalWarning' && String(warning).includes('SQLite')) {
        return;
      }
      return emitWarning.call(process, warning as string, ...(args as [string?, string?, string?]));
    }) as typeof process.emitWarning;
    return require('node:sqlite') as NativeSqliteModule;
  } catch {
    return null;
  } finally {
    process.emitWarning = emitWarning;
  }
}

export function createNativeSqliteDatabase(filename: string): NativeSqliteDatabase | null {
  const sqlite = loadNativeSqliteModule();
  if (!sqlite) return null;
  return new NativeSqliteDatabase(filename, sqlite);
}
