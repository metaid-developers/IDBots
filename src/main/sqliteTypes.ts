export interface SqliteExecResult {
  columns: string[];
  values: unknown[][];
}

export interface SqliteDatabase {
  exec(sql: string, params?: unknown[]): SqliteExecResult[];
  run(sql: string, params?: unknown[]): unknown;
  getRowsModified?: () => number;
  export?: () => Uint8Array;
  close: () => void;
}
