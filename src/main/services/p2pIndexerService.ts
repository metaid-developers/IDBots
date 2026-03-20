/**
 * P2P Indexer Service: subprocess lifecycle manager for the man-p2p Go binary.
 * Handles binary path resolution, spawn, crash-restart with exponential backoff,
 * health checks, and status polling with IPC broadcast to all BrowserWindows.
 */

import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { app, BrowserWindow } from 'electron';

export const P2P_LOCAL_PORT = 7281;
export const P2P_LOCAL_BASE = 'http://localhost:7281';

export interface P2PStatus {
  running: boolean;
  peerCount?: number;
  storageLimitReached?: boolean;
  storageUsedBytes?: number;
  dataSource?: string;
  error?: string;
}

const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRIES = 5;
const HEALTH_TIMEOUT_MS = 2000;
const STATUS_POLL_INTERVAL_MS = 30_000;

let childProcess: ChildProcess | null = null;
let retryCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let quitListenerRegistered = false;
let lastStartArgs: { dataDir: string; configPath: string } | null = null;
let stopping = false;

let cachedStatus: P2PStatus = { running: false };

function resolveBinaryPath(): string {
  const names: Record<string, string> = {
    'darwin-arm64': 'man-p2p-darwin-arm64',
    'darwin-x64':   'man-p2p-darwin-x64',
    'win32-x64':    'man-p2p-win32-x64.exe',
    'linux-x64':    'man-p2p-linux-x64',
  };
  const key = `${process.platform}-${process.arch}`;
  const name = names[key] ?? `man-p2p-${key}`;
  return path.join(process.resourcesPath, name);
}

function emitStatusToAllWindows(status: P2PStatus): void {
  cachedStatus = status;
  BrowserWindow.getAllWindows().forEach(win => {
    win.webContents.send('p2p:statusUpdate', status);
  });
}

function clearStatusPoll(): void {
  if (statusPollTimer !== null) {
    clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
}

function startStatusPoll(): void {
  clearStatusPoll();
  statusPollTimer = setInterval(async () => {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
      const res = await fetch(`${P2P_LOCAL_BASE}/api/p2p/status`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (res.ok) {
        const data = await res.json() as Record<string, unknown>;
        emitStatusToAllWindows({
          running: true,
          peerCount: typeof data.peerCount === 'number' ? data.peerCount : undefined,
          storageLimitReached: typeof data.storageLimitReached === 'boolean' ? data.storageLimitReached : undefined,
          storageUsedBytes: typeof data.storageUsedBytes === 'number' ? data.storageUsedBytes : undefined,
          dataSource: typeof data.dataSource === 'string' ? data.dataSource : undefined,
        });
      }
    } catch {
      // Silently ignore poll errors; process exit event handles crash detection
    }
  }, STATUS_POLL_INTERVAL_MS);
}

function scheduleRestart(): void {
  if (stopping) return;

  if (retryCount >= MAX_RETRIES) {
    console.error('[p2p] Max retries exceeded, giving up');
    emitStatusToAllWindows({ running: false, error: 'max retries exceeded' });
    return;
  }

  const delay = RESTART_DELAYS_MS[retryCount] ?? RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1];
  console.log(`[p2p] Scheduling restart attempt ${retryCount + 1}/${MAX_RETRIES} in ${delay}ms`);
  retryCount += 1;

  restartTimer = setTimeout(async () => {
    restartTimer = null;
    if (stopping || !lastStartArgs) return;
    try {
      await spawnProcess(lastStartArgs.dataDir, lastStartArgs.configPath);
    } catch (err) {
      console.error('[p2p] Restart failed:', err);
      scheduleRestart();
    }
  }, delay);
}

function spawnProcess(dataDir: string, configPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binaryPath = resolveBinaryPath();
    const args = ['--data-dir', dataDir, '--p2p-config', configPath, '-server=1'];
    console.log(`[p2p] Spawning: ${binaryPath} ${args.join(' ')}`);

    const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    childProcess = proc;

    let started = false;

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => console.log(`[p2p] ${line}`));
      if (!started) {
        started = true;
        resolve();
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => console.error(`[p2p] ${line}`));
      if (!started) {
        started = true;
        resolve();
      }
    });

    proc.on('error', (err) => {
      console.error('[p2p] Process error:', err);
      childProcess = null;
      clearStatusPoll();
      if (!started) {
        started = true;
        reject(err);
      } else {
        scheduleRestart();
      }
    });

    proc.on('exit', (code, signal) => {
      console.log(`[p2p] Process exited (code=${code}, signal=${signal})`);
      childProcess = null;
      clearStatusPoll();
      if (!started) {
        started = true;
        resolve();
      }
      if (!stopping) {
        scheduleRestart();
      }
    });

    // Resolve after a short delay if neither stdout/stderr fires (process may not output on start)
    setTimeout(() => {
      if (!started) {
        started = true;
        resolve();
      }
    }, 500);
  });
}

export async function start(dataDir: string, configPath: string): Promise<void> {
  // Validate binary exists before doing anything else
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`man-p2p binary not found: ${binaryPath}`);
  }

  // Reset state for explicit start
  stopping = false;
  retryCount = 0;
  lastStartArgs = { dataDir, configPath };

  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  if (!quitListenerRegistered) {
    quitListenerRegistered = true;
    app?.on('before-quit', () => {
      void stop();
    });
  }

  await spawnProcess(dataDir, configPath);
  startStatusPoll();
}

export async function stop(): Promise<void> {
  stopping = true;

  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  clearStatusPoll();

  const proc = childProcess;
  if (!proc) return;

  return new Promise((resolve) => {
    const killTimeout = setTimeout(() => {
      console.log('[p2p] SIGTERM timed out, sending SIGKILL');
      try {
        proc.kill('SIGKILL');
      } catch {
        // Already gone
      }
      resolve();
    }, 5000);

    proc.on('exit', () => {
      clearTimeout(killTimeout);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(killTimeout);
      resolve();
    }
  });
}

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(`${P2P_LOCAL_BASE}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return res.status === 200;
  } catch {
    return false;
  }
}

export function getP2PStatus(): P2PStatus {
  return cachedStatus;
}
