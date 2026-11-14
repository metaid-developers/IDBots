import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { DailyReportFacts } from './services/dailyReportCollector';

const DEFAULT_IDLE_TTL_MS = 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 60_000;

const SQLITE_READ_WORKER_SCRIPT = `
'use strict';
const { parentPort, workerData } = require('node:worker_threads');

const emitWarning = process.emitWarning;
let sqlite;
try {
  process.emitWarning = function (warning, ...args) {
    if (args[0] === 'ExperimentalWarning' && String(warning).includes('SQLite')) {
      return;
    }
    return emitWarning.call(process, warning, ...args);
  };
  sqlite = require('node:sqlite');
} finally {
  process.emitWarning = emitWarning;
}

const db = new sqlite.DatabaseSync(workerData.dbPath, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000;');
try {
  db.exec('PRAGMA query_only = ON;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA cache_size = -16000;');
} catch {
  // Optional read-only tuning; ignore if unsupported.
}

const MAX_STATEMENTS = 128;
const stmtCache = new Map();
let closed = false;

function prepareCached(sql) {
  const existing = stmtCache.get(sql);
  if (existing) {
    stmtCache.delete(sql);
    stmtCache.set(sql, existing);
    return existing;
  }
  const stmt = db.prepare(sql);
  if (stmtCache.size >= MAX_STATEMENTS) {
    const oldest = stmtCache.keys().next().value;
    if (oldest !== undefined) stmtCache.delete(oldest);
  }
  stmtCache.set(sql, stmt);
  return stmt;
}

function queryAll(sql, params = []) {
  try {
    const stmt = prepareCached(sql);
    return stmt.all(...params);
  } catch (err) {
    stmtCache.delete(sql);
    throw err;
  }
}

function closeDb() {
  if (closed) return;
  closed = true;
  stmtCache.clear();
  try {
    db.close();
  } catch {
    // ignore close errors
  }
  if (workerData.closeAck) {
    Atomics.store(workerData.closeAck, 0, 1);
    Atomics.notify(workerData.closeAck, 0, 1);
  }
}

let cachedCollectorMod = null;
function loadCollectorModule(modulePath) {
  if (cachedCollectorMod) return cachedCollectorMod;
  cachedCollectorMod = require(modulePath);
  return cachedCollectorMod;
}

parentPort.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.kind === 'close') {
    closeDb();
    process.exit(0);
    return;
  }
  const { id, kind } = msg;
  try {
    if (kind === 'queryAll') {
      const rows = queryAll(msg.sql, Array.isArray(msg.params) ? msg.params : []);
      parentPort.postMessage({ id, ok: true, result: rows });
      return;
    }
    if (kind === 'batchQueryAll') {
      const queries = Array.isArray(msg.queries) ? msg.queries : [];
      const results = queries.map((q) => queryAll(q.sql, Array.isArray(q.params) ? q.params : []));
      parentPort.postMessage({ id, ok: true, result: results });
      return;
    }
    if (kind === 'collectDailyReportFacts') {
      const mod = loadCollectorModule(msg.collectorModulePath);
      const facts = mod.collectDailyReportFacts({
        db: { queryAll },
        windowStartMs: msg.windowStartMs,
        windowEndMs: msg.windowEndMs,
        twinId: msg.twinId,
      });
      parentPort.postMessage({ id, ok: true, result: facts });
      return;
    }
    throw new Error('Unknown SqliteReadWorker message kind: ' + String(kind));
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
`;

interface PendingCall {
  resolve: (value: any) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SqliteReadWorkerLike {
  queryAll<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  batchQueryAll(
    queries: ReadonlyArray<{ sql: string; params?: readonly unknown[] }>,
  ): Promise<Record<string, unknown>[][]>;
}

function resolveDailyReportCollectorModulePath(explicitPath?: string): string | null {
  const candidates = [
    explicitPath,
    path.join(__dirname, 'services', 'dailyReportCollector.js'),
    path.join(__dirname, 'main', 'services', 'dailyReportCollector.js'),
    path.resolve(process.cwd(), 'dist-electron', 'main', 'services', 'dailyReportCollector.js'),
  ].filter((item): item is string => typeof item === 'string' && item.length > 0);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return null;
}

export class SqliteReadWorker implements SqliteReadWorkerLike {
  private worker: Worker | null = null;
  private closeAck: Int32Array | null = null;
  private nextCallId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly idleTtlMs: number;
  private readonly callTimeoutMs: number;

  constructor(
    private readonly dbPath: string,
    options?: { idleTtlMs?: number; callTimeoutMs?: number },
  ) {
    this.idleTtlMs = Math.max(1_000, options?.idleTtlMs ?? DEFAULT_IDLE_TTL_MS);
    this.callTimeoutMs = Math.max(1_000, options?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.worker || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) {
        this.shutdownActiveWorkerSync();
      }
    }, this.idleTtlMs);
    this.idleTimer.unref?.();
  }

  private ensureWorker(): Worker {
    if (this.disposed) {
      throw new Error('SqliteReadWorker is closed');
    }
    if (this.worker) {
      return this.worker;
    }
    const closeAck = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(SQLITE_READ_WORKER_SCRIPT, {
      eval: true,
      workerData: {
        dbPath: this.dbPath,
        closeAck,
      },
    });
    worker.unref();
    this.closeAck = closeAck;
    this.worker = worker;

    worker.on('message', (msg: { id?: number; ok?: boolean; result?: unknown; error?: string }) => {
      if (typeof msg?.id !== 'number') return;
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.ok) {
        entry.resolve(msg.result);
      } else {
        entry.reject(new Error(msg.error || 'SqliteReadWorker query failed'));
      }
      this.armIdleTimer();
    });

    const rejectAll = (reason: Error) => {
      if (this.worker === worker) {
        this.worker = null;
        this.closeAck = null;
      }
      this.clearIdleTimer();
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(reason);
      }
      this.pending.clear();
    };

    worker.on('error', (err) => {
      rejectAll(err instanceof Error ? err : new Error(String(err)));
    });
    worker.on('exit', (code) => {
      if (this.pending.size > 0) {
        rejectAll(new Error(`SqliteReadWorker exited unexpectedly with code ${code}`));
      } else if (this.worker === worker) {
        this.worker = null;
        this.closeAck = null;
      }
    });

    return worker;
  }

  private dispatch<R>(payload: Record<string, unknown>): Promise<R> {
    this.clearIdleTimer();
    const worker = this.ensureWorker();
    const id = this.nextCallId++;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`SqliteReadWorker call timed out after ${this.callTimeoutMs}ms`));
        this.shutdownActiveWorkerSync();
      }, this.callTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...payload, id });
    });
  }

  queryAll<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return this.dispatch<T[]>({
      kind: 'queryAll',
      sql,
      params: [...params],
    });
  }

  batchQueryAll(
    queries: ReadonlyArray<{ sql: string; params?: readonly unknown[] }>,
  ): Promise<Record<string, unknown>[][]> {
    if (queries.length === 0) return Promise.resolve([]);
    return this.dispatch<Record<string, unknown>[][]>({
      kind: 'batchQueryAll',
      queries: queries.map((q) => ({ sql: q.sql, params: q.params ? [...q.params] : [] })),
    });
  }

  async collectDailyReportFacts(input: {
    collectorModulePath?: string;
    windowStartMs: number;
    windowEndMs: number;
    twinId: number;
  }): Promise<DailyReportFacts | null> {
    const collectorModulePath = resolveDailyReportCollectorModulePath(input.collectorModulePath);
    if (!collectorModulePath) return null;
    return this.dispatch<DailyReportFacts>({
      kind: 'collectDailyReportFacts',
      collectorModulePath,
      windowStartMs: input.windowStartMs,
      windowEndMs: input.windowEndMs,
      twinId: input.twinId,
    });
  }

  private shutdownActiveWorkerSync(): void {
    this.clearIdleTimer();
    const worker = this.worker;
    const closeAck = this.closeAck;
    this.worker = null;
    this.closeAck = null;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('SqliteReadWorker closed'));
    }
    this.pending.clear();
    if (!worker) return;
    try {
      worker.postMessage({ kind: 'close' });
      if (closeAck) {
        Atomics.wait(closeAck, 0, 0, 2_000);
      }
    } catch {
      // ignore if worker already exited
    }
    void worker.terminate().catch(() => {});
  }

  closeSync(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.shutdownActiveWorkerSync();
  }
}
