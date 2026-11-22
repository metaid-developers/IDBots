import fs from 'fs';
import path from 'path';

/**
 * Runtime diagnostics log (`logs/runtime-diag.log`).
 *
 * Purpose: the blank-then-reload-to-home incidents (dev renderer dies or vite
 * forces a page reload) previously only printed to the `electron:dev`
 * terminal, so every occurrence was lost unless someone happened to read the
 * scrollback. Every forced reload, renderer crash, child-process death and
 * main-frame navigation now lands in this file with a memory snapshot, which
 * is what discriminates the candidate root causes (renderer killed under
 * memory pressure vs vite dep re-optimization reload vs load failure).
 *
 * Writes are synchronous on purpose: the interesting events happen while the
 * renderer or the whole app is dying, so the entry must survive the crash.
 * Events are rare (crashes/reloads/navigations), so the 2MB rotate cap is
 * generous; every entry is a single JSON line for easy grep/jq.
 *
 * The module is dependency-free on purpose: the log directory is injected by
 * the host (`initRuntimeDiagLog`) instead of being resolved through electron,
 * so plain-Node contexts (tests, support scripts) can drive it directly.
 */

const MAX_LOG_SIZE = 2 * 1024 * 1024;
const LOG_FILENAME = 'runtime-diag.log';

let logDir: string | null = null;

/**
 * Point the logger at a directory (created best-effort). Must be called once
 * at host startup before the first event; re-init simply retargets.
 */
export function initRuntimeDiagLog(dir: string): void {
  logDir = dir;
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch {
    // A missing directory only means entries are dropped, never thrown.
  }
}

function getLogFilePath(): string | null {
  if (!logDir) return null;
  return path.join(logDir, LOG_FILENAME);
}

function rotateIfNeeded(filePath: string): void {
  try {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size < MAX_LOG_SIZE) return;
    const backupPath = `${filePath}.old`;
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    fs.renameSync(filePath, backupPath);
  } catch {
    // Rotation is best-effort; never let it mask the diagnostic entry.
  }
}

/**
 * Append one diagnostic event. `details` fields are merged into the JSON line
 * (memory snapshots, crash reasons, URLs). Never throws, and no-ops when the
 * host never initialized the logger: a logging failure must not interfere
 * with the reload/crash handling around it.
 */
export function runtimeDiagLog(event: string, details?: Record<string, unknown>): void {
  try {
    const filePath = getLogFilePath();
    if (!filePath) return;
    const entry = JSON.stringify({ ts: new Date().toISOString(), event, ...details });
    rotateIfNeeded(filePath);
    fs.appendFileSync(filePath, `${entry}\n`, 'utf-8');
  } catch {
    // Diagnostics must never throw.
  }
}
