import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function resolveRepoRoot() {
  let current = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  while (true) {
    const candidateWasm = path.join(current, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm');
    if (fs.existsSync(candidateWasm)) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error('Failed to resolve repo root for sqliteStore wasm path tests');
    }
    current = parent;
  }
}

const repoRoot = resolveRepoRoot();

test('resolveSqlJsWasmPath walks upward from a nested worktree app path to the nearest installed sql-wasm.wasm', () => {
  const sqliteStore = require('../dist-electron/sqliteStore.js');
  assert.equal(typeof sqliteStore.resolveSqlJsWasmPath, 'function');

  const nestedWorktreeAppPath = path.join(repoRoot, '.worktrees', 'simulated-fresh-worktree');
  const resolved = sqliteStore.resolveSqlJsWasmPath({
    isPackaged: false,
    appPath: nestedWorktreeAppPath,
  });

  assert.equal(
    resolved,
    path.join(repoRoot, 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'),
  );
});
