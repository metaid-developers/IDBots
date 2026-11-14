/**
 * Shared metaid-rpc.log appender. Lives in its own module so sponsor
 * orchestration files (mvcSponsorCreatePin / mvcSponsorUpload) can log
 * without importing metaidCore (which imports them back).
 */

import fs from 'fs';
import path from 'path';

const METAID_RPC_LOG = 'metaid-rpc.log';
const MAX_METAID_RPC_LOG_BYTES = 5 * 1024 * 1024;
const ROTATE_CHECK_INTERVAL_WRITES = 64;
let writesSinceRotateCheck = ROTATE_CHECK_INTERVAL_WRITES;

export function rotateMetaidLogIfNeeded(logPath: string, maxBytes = MAX_METAID_RPC_LOG_BYTES): void {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size <= maxBytes) return;
    const backupPath = `${logPath}.old`;
    if (fs.existsSync(backupPath)) {
      fs.unlinkSync(backupPath);
    }
    fs.renameSync(logPath, backupPath);
  } catch {
    // Best-effort log rotation
  }
}

export function appendMetaidLogLine(logPath: string, line: string): void {
  try {
    writesSinceRotateCheck += 1;
    if (writesSinceRotateCheck >= ROTATE_CHECK_INTERVAL_WRITES) {
      writesSinceRotateCheck = 0;
      rotateMetaidLogIfNeeded(logPath);
    }
    fs.appendFileSync(logPath, line);
  } catch {
    // Ignore logging errors
  }
}

export function appendMetaidLog(level: string, message: string, details?: object): void {
  try {
    const { app } = require('electron');
    const logDir = app.getPath('userData');
    const logPath = path.join(logDir, METAID_RPC_LOG);
    const line = `[${new Date().toISOString()}] [${level}] ${message}${details ? '\n' + JSON.stringify(details, null, 2) : ''}\n`;
    appendMetaidLogLine(logPath, line);
  } catch {
    // Ignore if app not ready
  }
}
