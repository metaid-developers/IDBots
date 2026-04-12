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
import {
  DEFAULT_P2P_LOCAL_BASE,
  DEFAULT_P2P_LOCAL_PORT,
  applyP2PLocalListenAddressOverride,
  getConfiguredP2PLocalBase,
  getP2PLocalBase,
  resolveP2PLocalListenAddress,
} from './p2pLocalEndpoint';

export const P2P_LOCAL_PORT = DEFAULT_P2P_LOCAL_PORT;
export const P2P_LOCAL_BASE = DEFAULT_P2P_LOCAL_BASE;

export interface P2PStatus {
  running: boolean;
  peerCount?: number;
  storageLimitReached?: boolean;
  storageUsedBytes?: number;
  dataSource?: string;
  syncMode?: string;
  runtimeMode?: string;
  peerId?: string;
  listenAddrs?: string[];
  error?: string;
}

const RESTART_DELAYS_MS = [1000, 2000, 4000, 8000, 16000];
const MAX_RETRIES = 5;
const HEALTH_TIMEOUT_MS = 2000;
const STATUS_POLL_INTERVAL_MS = 30_000;
const STARTUP_HEALTH_ATTEMPTS = 20;
const STARTUP_HEALTH_DELAY_MS = 250;
const STARTUP_LOG_LINE_LIMIT = 200;
const PEBBLE_DATA_DIR_NAME = 'man_base_data_pebble';
const PEBBLE_RECOVERY_PREFIX = `${PEBBLE_DATA_DIR_NAME}.corrupt`;

let childProcess: ChildProcess | null = null;
let retryCount = 0;
let restartTimer: ReturnType<typeof setTimeout> | null = null;
let statusPollTimer: ReturnType<typeof setInterval> | null = null;
let quitListenerRegistered = false;
let lastStartArgs: { dataDir: string; configPath: string } | null = null;
let stopping = false;
let startupInProgressCount = 0;
let recentProcessLogLines: string[] = [];
let lastProcessFailure: StartupFailureSnapshot | null = null;

let cachedStatus: P2PStatus = { running: false };

export interface StartupFailureSnapshot {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  logLines: string[];
}

export interface StartupFailureAnalysis {
  likelyDataCorruption: boolean;
  likelyPortConflict: boolean;
  summary: string | null;
}

function getStatusUrl(): string {
  return `${getP2PLocalBase()}/api/p2p/status`;
}

function getHealthUrl(): string {
  return `${getP2PLocalBase()}/health`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pushStartupLogLine(line: string): void {
  recentProcessLogLines.push(line);
  if (recentProcessLogLines.length > STARTUP_LOG_LINE_LIMIT) {
    recentProcessLogLines = recentProcessLogLines.slice(recentProcessLogLines.length - STARTUP_LOG_LINE_LIMIT);
  }
}

function resetStartupDiagnostics(): void {
  recentProcessLogLines = [];
  lastProcessFailure = null;
}

function getStartupFailureSnapshot(): StartupFailureSnapshot {
  if (lastProcessFailure) {
    return {
      exitCode: lastProcessFailure.exitCode,
      signal: lastProcessFailure.signal,
      logLines: [...lastProcessFailure.logLines],
    };
  }
  return {
    exitCode: null,
    signal: null,
    logLines: [...recentProcessLogLines],
  };
}

function formatRecoveryTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getUTCFullYear(),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    '-',
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');
}

export function analyzeStartupFailure(snapshot: StartupFailureSnapshot): StartupFailureAnalysis {
  const joined = snapshot.logLines.join('\n').toLowerCase();
  const hasPebble = joined.includes('pebble');
  const hasWalReplayIssue = /wal file .*stopped reading at offset/.test(joined);
  const hasPanic = joined.includes('panic:');
  const hasNilPointer = joined.includes('invalid memory address or nil pointer dereference');
  const likelyDataCorruption = hasPebble && (hasWalReplayIssue || hasNilPointer) && hasPanic;
  const likelyPortConflict = joined.includes('address already in use')
    || joined.includes('only one usage of each socket address');

  if (likelyDataCorruption) {
    return {
      likelyDataCorruption: true,
      likelyPortConflict,
      summary: 'man-p2p crashed while replaying local Pebble WAL (likely corrupted local p2p data)',
    };
  }

  if (likelyPortConflict) {
    return {
      likelyDataCorruption: false,
      likelyPortConflict: true,
      summary: `man-p2p could not bind ${P2P_LOCAL_PORT} (address already in use)`,
    };
  }

  if (snapshot.exitCode !== null) {
    return {
      likelyDataCorruption: false,
      likelyPortConflict: false,
      summary: `man-p2p exited early with code ${snapshot.exitCode}`,
    };
  }

  if (snapshot.signal) {
    return {
      likelyDataCorruption: false,
      likelyPortConflict: false,
      summary: `man-p2p exited early with signal ${snapshot.signal}`,
    };
  }

  return {
    likelyDataCorruption: false,
    likelyPortConflict: false,
    summary: null,
  };
}

export function recoverCorruptedPebbleDataDir(
  dataDir: string,
  now: Date = new Date(),
): { recovered: boolean; backupPath?: string; reason?: string } {
  const source = path.join(dataDir, PEBBLE_DATA_DIR_NAME);
  if (!fs.existsSync(source)) {
    return { recovered: false, reason: `missing ${source}` };
  }

  const stat = fs.statSync(source);
  if (!stat.isDirectory()) {
    return { recovered: false, reason: `${source} is not a directory` };
  }

  const stamp = formatRecoveryTimestamp(now);
  let attempt = 0;
  let backupPath = '';
  while (true) {
    const suffix = attempt === 0 ? '' : `.${attempt}`;
    backupPath = path.join(dataDir, `${PEBBLE_RECOVERY_PREFIX}.${stamp}${suffix}`);
    if (!fs.existsSync(backupPath)) {
      break;
    }
    attempt += 1;
  }

  fs.renameSync(source, backupPath);
  return { recovered: true, backupPath };
}

function hasElectronAppRuntime(): boolean {
  return !!app && typeof app.isPackaged === 'boolean' && typeof app.getAppPath === 'function';
}

function hasBrowserWindowRuntime(): boolean {
  return typeof BrowserWindow?.getAllWindows === 'function';
}

function setOfflineStatus(error?: string): void {
  emitStatusToAllWindows({
    ...cachedStatus,
    running: false,
    error,
  });
}

export function unwrapApiData(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') return undefined;
  return (payload as { data?: unknown }).data;
}

export function normalizeStatusPayload(payload: unknown): P2PStatus {
  const data = unwrapApiData(payload);
  const status = (data && typeof data === 'object') ? data as Record<string, unknown> : {};
  return {
    running: true,
    peerCount: typeof status.peerCount === 'number' ? status.peerCount : undefined,
    storageLimitReached: typeof status.storageLimitReached === 'boolean' ? status.storageLimitReached : undefined,
    storageUsedBytes: typeof status.storageUsedBytes === 'number' ? status.storageUsedBytes : undefined,
    dataSource: typeof status.dataSource === 'string' ? status.dataSource : undefined,
    syncMode: typeof status.syncMode === 'string' ? status.syncMode : undefined,
    runtimeMode: typeof status.runtimeMode === 'string' ? status.runtimeMode : undefined,
    peerId: typeof status.peerId === 'string' ? status.peerId : undefined,
    listenAddrs: Array.isArray(status.listenAddrs)
      ? status.listenAddrs.filter((item): item is string => typeof item === 'string')
      : undefined,
  };
}

export function unwrapPeersPayload(payload: unknown): string[] {
  const data = unwrapApiData(payload);
  if (!Array.isArray(data)) return [];
  return data.filter((item): item is string => typeof item === 'string');
}

export async function waitForHealthyLocalApi(
  check: () => Promise<boolean> = healthCheck,
  options?: { attempts?: number; delayMs?: number },
): Promise<boolean> {
  const attempts = options?.attempts ?? STARTUP_HEALTH_ATTEMPTS;
  const delayMs = options?.delayMs ?? STARTUP_HEALTH_DELAY_MS;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await check()) {
      return true;
    }
    if (attempt < attempts - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  return false;
}

function resolveBinaryPath(): string {
  const names: Record<string, string> = {
    'darwin-arm64': 'man-p2p-darwin-arm64',
    'darwin-x64':   'man-p2p-darwin-x64',
    'win32-x64':    'man-p2p-win32-x64.exe',
    'linux-x64':    'man-p2p-linux-x64',
  };
  const key = `${process.platform}-${process.arch}`;
  const name = names[key] ?? `man-p2p-${key}`;

  if (hasElectronAppRuntime() && app.isPackaged) {
    // Production: electron-builder extraResources puts binaries directly in Resources/
    return path.join(process.resourcesPath, name);
  }
  if (hasElectronAppRuntime()) {
    // Dev mode: use project's resources/man-p2p/ directory
    return path.join(app.getAppPath(), 'resources', 'man-p2p', name);
  }
  return path.join(process.resourcesPath || process.cwd(), name);
}

function emitStatusToAllWindows(status: P2PStatus): void {
  cachedStatus = status;
  if (!hasBrowserWindowRuntime()) {
    return;
  }
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

export async function refreshStatusFromLocalApi(): Promise<P2PStatus | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(getStatusUrl(), {
      signal: controller.signal,
    });
    if (!res.ok) {
      return null;
    }
    const payload = await res.json() as Record<string, unknown>;
    const normalized = normalizeStatusPayload(payload);
    emitStatusToAllWindows(normalized);
    return normalized;
  } finally {
    clearTimeout(timeout);
  }
}

function startStatusPoll(): void {
  clearStatusPoll();
  statusPollTimer = setInterval(async () => {
    try {
      await refreshStatusFromLocalApi();
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
      await start(lastStartArgs.dataDir, lastStartArgs.configPath, {
        allowCorruptionRecovery: true,
        resetRetryCount: false,
      });
    } catch (err) {
      console.error('[p2p] Restart failed:', err);
      scheduleRestart();
    }
  }, delay);
}

export function resolveMainConfigPath(): string {
  if (hasElectronAppRuntime() && app.isPackaged) {
    return path.join(process.resourcesPath, 'man-p2p-config.toml');
  }
  if (hasElectronAppRuntime()) {
    return path.join(app.getAppPath(), 'resources', 'man-p2p', 'config.toml');
  }
  const base = process.resourcesPath || process.cwd();
  const preferred = path.join(base, 'man-p2p-config.toml');
  if (fs.existsSync(preferred)) {
    return preferred;
  }
  const fallback = path.join(base, 'config.toml');
  if (fs.existsSync(fallback)) {
    return fallback;
  }
  return preferred;
}

export function resolveRuntimeConfigPath(
  mainConfigPath: string,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const configuredLocalBase = getConfiguredP2PLocalBase(env);
  const listenAddress = resolveP2PLocalListenAddress(configuredLocalBase);
  const runtimeConfigPath = path.join(dataDir, 'man-p2p-runtime-config.toml');
  const baseConfig = fs.readFileSync(mainConfigPath, 'utf8');
  const pebbleDir = path.join(dataDir, 'man_base_data_pebble');
  let runtimeConfig = baseConfig;
  if (listenAddress) {
    runtimeConfig = applyP2PLocalListenAddressOverride(runtimeConfig, listenAddress);
  }
  runtimeConfig = runtimeConfig.replace(
    /^dir\s*=\s*"[^"]*"\s*$/m,
    `dir = "${escapeTomlBasicString(pebbleDir)}"`,
  );

  if (runtimeConfig === baseConfig) {
    return mainConfigPath;
  }

  fs.mkdirSync(path.dirname(runtimeConfigPath), { recursive: true });
  fs.writeFileSync(runtimeConfigPath, runtimeConfig, 'utf8');
  return runtimeConfigPath;
}

export function escapeTomlBasicString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function spawnProcess(dataDir: string, configPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const binaryPath = resolveBinaryPath();
    const mainConfig = resolveRuntimeConfigPath(resolveMainConfigPath(), dataDir);
    const args = [
      '-config', mainConfig,
      '--data-dir', dataDir,
      '--p2p-config', configPath,
      '-server=1',
      `-btc_height=900000`,
    ];
    console.log(`[p2p] Spawning: ${binaryPath} ${args.join(' ')}`);

    const proc = spawn(binaryPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    childProcess = proc;

    let started = false;

    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        pushStartupLogLine(`[stdout] ${line}`);
        console.log(`[p2p] ${line}`);
      });
      if (!started) {
        started = true;
        resolve();
      }
    });

    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      lines.forEach(line => {
        pushStartupLogLine(`[stderr] ${line}`);
        console.error(`[p2p] ${line}`);
      });
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
      lastProcessFailure = {
        exitCode: code,
        signal,
        logLines: [...recentProcessLogLines],
      };
      childProcess = null;
      clearStatusPoll();
      if (!started) {
        started = true;
        resolve();
      }
      if (!stopping && startupInProgressCount === 0) {
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

export async function start(
  dataDir: string,
  configPath: string,
  options?: { allowCorruptionRecovery?: boolean; resetRetryCount?: boolean },
): Promise<void> {
  const allowCorruptionRecovery = options?.allowCorruptionRecovery ?? true;
  const resetRetryCount = options?.resetRetryCount ?? true;
  // Validate binary exists before doing anything else
  const binaryPath = resolveBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    const error = `man-p2p binary not found: ${binaryPath}`;
    setOfflineStatus(error);
    throw new Error(error);
  }

  // Reset state for explicit start
  stopping = false;
  if (resetRetryCount) {
    retryCount = 0;
  }
  lastStartArgs = { dataDir, configPath };

  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  resetStartupDiagnostics();

  if (!quitListenerRegistered) {
    quitListenerRegistered = true;
    app?.on('before-quit', () => {
      void stop();
    });
  }

  startupInProgressCount += 1;
  try {
    await spawnProcess(dataDir, configPath);
    emitStatusToAllWindows({ ...cachedStatus, running: true, error: undefined });
    const healthy = await waitForHealthyLocalApi();
    if (!healthy) {
      const startupFailure = analyzeStartupFailure(getStartupFailureSnapshot());
      await stop();

      if (allowCorruptionRecovery && startupFailure.likelyDataCorruption) {
        const recovered = recoverCorruptedPebbleDataDir(dataDir);
        if (recovered.recovered) {
          console.warn(`[p2p] Recovered corrupted Pebble data directory -> ${recovered.backupPath}`);
          await start(dataDir, configPath, { allowCorruptionRecovery: false });
          return;
        }
        console.warn(`[p2p] Startup recovery skipped: ${recovered.reason ?? 'unknown reason'}`);
      }

      const detail = startupFailure.summary ? ` (${startupFailure.summary})` : '';
      const error = `man-p2p health check did not become ready after startup${detail}`;
      setOfflineStatus(error);
      throw new Error(error);
    }
    try {
      await refreshStatusFromLocalApi();
    } catch {
      emitStatusToAllWindows({ ...cachedStatus, running: true, error: undefined });
    }
    // A healthy runtime gets a fresh crash budget, even if it came from a restart.
    retryCount = 0;
    startStatusPoll();
  } finally {
    startupInProgressCount = Math.max(0, startupInProgressCount - 1);
  }
}

export async function stop(): Promise<void> {
  stopping = true;

  if (restartTimer !== null) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }

  clearStatusPoll();

  const proc = childProcess;
  if (!proc) {
    setOfflineStatus(undefined);
    return;
  }

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
      setOfflineStatus(undefined);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(killTimeout);
      setOfflineStatus(undefined);
      resolve();
    }
  });
}

export async function healthCheck(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
    const res = await fetch(getHealthUrl(), {
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

export const __p2pIndexerServiceTestUtils = {
  analyzeStartupFailure,
  recoverCorruptedPebbleDataDir,
};
