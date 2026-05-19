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

export class NativeSqliteDatabase implements SqliteDatabase {
  private readonly db: NativeDatabaseSync;
  private rowsModified = 0;
  private closed = false;

  constructor(filename: string, module: NativeSqliteModule) {
    this.db = new module.DatabaseSync(filename);
    this.db.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql: string, params: unknown[] = []): SqliteExecResult[] {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    if (params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      return [];
    }
    return rowsToExecResult(statement, statement.all(...params));
  }

  run(sql: string, params: unknown[] = []): unknown {
    this.assertOpen();
    const statement = this.db.prepare(sql);
    if (params.length === 0 && hasUnpreparedTrailingSql(sql, statement)) {
      this.db.exec(sql);
      this.rowsModified = 0;
      return undefined;
    }

    const result = statement.run(...params);
    this.rowsModified = toSafeNumber(result.changes);
    return result;
  }

  getRowsModified(): number {
    return this.rowsModified;
  }

  close(): void {
    if (this.closed) return;
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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
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
