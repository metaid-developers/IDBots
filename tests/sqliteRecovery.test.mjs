import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('detects sql.js WebAssembly out-of-bounds errors including nested causes', () => {
  const { isSqliteWasmBoundsError } = require('../dist-electron/sqliteRecovery.js');

  assert.equal(
    isSqliteWasmBoundsError(new WebAssembly.RuntimeError('memory access out of bounds')),
    true,
  );
  assert.equal(
    isSqliteWasmBoundsError(new Error('SQL query failed', {
      cause: new Error('RuntimeError: memory access out of bounds'),
    })),
    true,
  );
  assert.equal(
    isSqliteWasmBoundsError(new Error('SQLITE_CONSTRAINT: duplicate key')),
    false,
  );
});

test('retries an operation once after sqlite wasm recovery', async () => {
  const { runWithSqliteWasmRecovery } = require('../dist-electron/sqliteRecovery.js');

  let attempts = 0;
  let recoveries = 0;

  const result = await runWithSqliteWasmRecovery(
    'metabot:list',
    async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new WebAssembly.RuntimeError('memory access out of bounds');
      }
      return 'ok';
    },
    async () => {
      recoveries += 1;
    },
  );

  assert.equal(result, 'ok');
  assert.equal(attempts, 2);
  assert.equal(recoveries, 1);
});

test('does not recover for non-wasm sqlite errors', async () => {
  const { runWithSqliteWasmRecovery } = require('../dist-electron/sqliteRecovery.js');

  let recoveries = 0;
  await assert.rejects(
    () => runWithSqliteWasmRecovery(
      'metabot:list',
      async () => {
        throw new Error('SQLITE_CONSTRAINT: duplicate key');
      },
      async () => {
        recoveries += 1;
      },
    ),
    /SQLITE_CONSTRAINT/,
  );
  assert.equal(recoveries, 0);
});

test('SqliteStore exposes a runtime reset hook for rebuilding damaged sql.js wasm state', () => {
  const { SqliteStore } = require('../dist-electron/sqliteStore.js');

  assert.equal(typeof SqliteStore.resetSqlJsRuntimeForRecovery, 'function');
});
