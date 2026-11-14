import { app } from 'electron';
import fs from 'fs';
import path from 'path';

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const ASYNC_FLUSH_INTERVAL_MS = 200;
const ASYNC_FLUSH_MAX_BYTES = 64 * 1024;

let logFilePath: string | null = null;
let knownFileSize: number | null = null;
let pendingChunks: string[] = [];
let pendingBytes = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let exitHookRegistered = false;

function shouldUseAsyncLogBuffer(): boolean {
  return Boolean(process.versions?.electron) && process.env.IDBOTS_SYNC_COWORK_LOG !== '1';
}

function getLogFilePath(): string {
  if (!logFilePath) {
    const logDir = path.join(app.getPath('userData'), 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    logFilePath = path.join(logDir, 'cowork.log');
  }
  return logFilePath;
}

function ensureKnownFileSize(filePath: string): number {
  if (knownFileSize !== null) return knownFileSize;
  try {
    knownFileSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  } catch {
    knownFileSize = 0;
  }
  return knownFileSize;
}

function rotateSyncIfNeeded(filePath: string, incomingBytes: number): void {
  try {
    const currentSize = ensureKnownFileSize(filePath);
    if (currentSize + incomingBytes <= MAX_LOG_SIZE) return;
    if (fs.existsSync(filePath)) {
      const backupPath = `${filePath}.old`;
      if (fs.existsSync(backupPath)) {
        fs.unlinkSync(backupPath);
      }
      fs.renameSync(filePath, backupPath);
    }
    knownFileSize = 0;
  } catch {
    // ignore rotation errors
  }
}

async function rotateAsyncIfNeeded(filePath: string, incomingBytes: number): Promise<void> {
  try {
    if (knownFileSize === null) {
      try {
        const stat = await fs.promises.stat(filePath);
        knownFileSize = stat.size;
      } catch {
        knownFileSize = 0;
      }
    }
    if (knownFileSize + incomingBytes <= MAX_LOG_SIZE) return;
    const backupPath = `${filePath}.old`;
    await fs.promises.unlink(backupPath).catch(() => {});
    await fs.promises.rename(filePath, backupPath).catch(() => {});
    knownFileSize = 0;
  } catch {
    // ignore rotation errors
  }
}

async function drainAsyncBuffer(): Promise<void> {
  if (flushInFlight || pendingChunks.length === 0) return;
  flushInFlight = true;
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  const payload = pendingChunks.join('');
  const byteLen = pendingBytes;
  pendingChunks = [];
  pendingBytes = 0;
  try {
    const filePath = getLogFilePath();
    await rotateAsyncIfNeeded(filePath, byteLen);
    await fs.promises.appendFile(filePath, payload, 'utf-8');
    knownFileSize = (knownFileSize ?? 0) + byteLen;
  } catch {
    // Logging should never throw
  } finally {
    flushInFlight = false;
    if (pendingChunks.length > 0) {
      scheduleAsyncFlush();
    }
  }
}

function scheduleAsyncFlush(): void {
  if (flushTimer || flushInFlight) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void drainAsyncBuffer();
  }, ASYNC_FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

export function flushCoworkLogSync(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (pendingChunks.length === 0) return;
  const payload = pendingChunks.join('');
  const byteLen = pendingBytes;
  pendingChunks = [];
  pendingBytes = 0;
  try {
    const filePath = getLogFilePath();
    rotateSyncIfNeeded(filePath, byteLen);
    fs.appendFileSync(filePath, payload, 'utf-8');
    knownFileSize = (knownFileSize ?? 0) + byteLen;
  } catch {
    // ignore flush errors
  }
}

function ensureExitFlushHook(): void {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  process.once('exit', () => {
    flushCoworkLogSync();
  });
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

export function formatCoworkLogEntry(
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR',
  tag: string,
  message: string,
  extra?: Record<string, unknown>,
): string {
  const parts = [`[${formatTimestamp()}] [${level}] [${tag}] ${message}`];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      const serialized = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      parts.push(`  ${key}: ${serialized}`);
    }
  }
  parts.push('');
  return parts.join('\n');
}

export function coworkLog(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', tag: string, message: string, extra?: Record<string, unknown>): void {
  try {
    const entry = formatCoworkLogEntry(level, tag, message, extra);
    const byteLen = Buffer.byteLength(entry, 'utf-8');
    if (!shouldUseAsyncLogBuffer()) {
      const filePath = getLogFilePath();
      rotateSyncIfNeeded(filePath, byteLen);
      fs.appendFileSync(filePath, entry, 'utf-8');
      knownFileSize = (knownFileSize ?? 0) + byteLen;
      return;
    }
    ensureExitFlushHook();
    pendingChunks.push(entry);
    pendingBytes += byteLen;
    if (pendingBytes >= ASYNC_FLUSH_MAX_BYTES) {
      void drainAsyncBuffer();
    } else {
      scheduleAsyncFlush();
    }
  } catch {
    // Logging should never throw
  }
}

export function getCoworkLogPath(): string {
  return getLogFilePath();
}
