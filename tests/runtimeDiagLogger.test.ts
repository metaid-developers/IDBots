import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The logger is dependency-free: the host injects the log directory, so the
// tests drive it directly without touching electron.
import { initRuntimeDiagLog, runtimeDiagLog } from '../src/main/libs/runtimeDiagLogger.ts';

const disposeDir = (dir: string): void => {
  // House pattern (tests/metabotAutoReplyDefault.test.mjs disposeStore):
  // release-then-rm best effort; a lingering handle must never fail the test.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Leftover temp dirs are harmless and OS-swept.
  }
};

const readEntries = (dir: string): Array<Record<string, unknown>> => {
  const raw = fs.readFileSync(path.join(dir, 'runtime-diag.log'), 'utf-8');
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

test('runtimeDiagLog appends one JSON line per event with ts and details', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diag-'));
  try {
    initRuntimeDiagLog(dir);
    runtimeDiagLog('window-reload', { reason: 'load-timeout', freeMB: 42 });
    runtimeDiagLog('render-process-gone', { details: { reason: 'oom', exitCode: -1 } });

    const entries = readEntries(dir);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].event, 'window-reload');
    assert.equal(entries[0].reason, 'load-timeout');
    assert.equal(entries[0].freeMB, 42);
    assert.equal(entries[1].event, 'render-process-gone');
    assert.deepEqual(entries[1].details, { reason: 'oom', exitCode: -1 });
    assert.equal(typeof entries[0].ts, 'string');
    assert.ok(!Number.isNaN(Date.parse(String(entries[0].ts))));
  } finally {
    initRuntimeDiagLog(os.tmpdir());
    disposeDir(dir);
  }
});

test('runtimeDiagLog never throws when the log file path is unusable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-diag-'));
  try {
    initRuntimeDiagLog(dir);
    // Occupy the exact file path with a directory: appendFileSync must fail
    // with EISDIR, and the logger must swallow it instead of throwing into
    // the crash/reload handling around it.
    fs.mkdirSync(path.join(dir, 'runtime-diag.log'));
    runtimeDiagLog('should-not-throw', {});
  } finally {
    initRuntimeDiagLog(os.tmpdir());
    disposeDir(dir);
  }
});
