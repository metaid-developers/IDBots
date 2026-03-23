import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let singleInstanceLock;
try {
  singleInstanceLock = require('../dist-electron/libs/singleInstanceLock.js');
} catch {
  singleInstanceLock = null;
}

test('shouldAcquireSingleInstanceLock() defaults to enabled', () => {
  assert.equal(
    typeof singleInstanceLock?.shouldAcquireSingleInstanceLock,
    'function',
    'shouldAcquireSingleInstanceLock() should be exported',
  );

  assert.equal(
    singleInstanceLock.shouldAcquireSingleInstanceLock({}),
    true,
    'single-instance lock should stay enabled by default',
  );
});

test('shouldAcquireSingleInstanceLock() allows explicit disable override for acceptance runtimes', () => {
  assert.equal(
    typeof singleInstanceLock?.shouldAcquireSingleInstanceLock,
    'function',
    'shouldAcquireSingleInstanceLock() should be exported',
  );

  assert.equal(
    singleInstanceLock.shouldAcquireSingleInstanceLock({
      IDBOTS_DISABLE_SINGLE_INSTANCE_LOCK: '1',
    }),
    false,
    'single-instance lock should be disabled when the acceptance override is set',
  );
});
