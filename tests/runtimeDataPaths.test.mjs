import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let runtimeDataPaths;
try {
  runtimeDataPaths = require('../dist-electron/libs/runtimeDataPaths.js');
} catch {
  runtimeDataPaths = null;
}

test('resolveRuntimeDataPaths() prefers explicit appData and userData overrides', () => {
  assert.equal(
    typeof runtimeDataPaths?.resolveRuntimeDataPaths,
    'function',
    'resolveRuntimeDataPaths() should be exported',
  );

  const result = runtimeDataPaths.resolveRuntimeDataPaths({
    appDataPath: '/Users/live/Library/Application Support',
    currentUserDataPath: '/Users/live/Library/Application Support/IDBots',
    appName: 'IDBots',
    env: {
      IDBOTS_APP_DATA_PATH: '/tmp/idbots-alpha/appData',
      IDBOTS_USER_DATA_PATH: '/tmp/idbots-alpha/userData',
    },
  });

  assert.deepEqual(result, {
    appDataPath: '/tmp/idbots-alpha/appData',
    userDataPath: '/tmp/idbots-alpha/userData',
  });
});

test('resolveRuntimeDataPaths() derives userData from appData override when explicit userData override is absent', () => {
  assert.equal(
    typeof runtimeDataPaths?.resolveRuntimeDataPaths,
    'function',
    'resolveRuntimeDataPaths() should be exported',
  );

  const result = runtimeDataPaths.resolveRuntimeDataPaths({
    appDataPath: '/Users/live/Library/Application Support',
    currentUserDataPath: '/Users/live/Library/Application Support/IDBots',
    appName: 'IDBots',
    env: {
      IDBOTS_APP_DATA_PATH: '/tmp/idbots-alpha/appData',
    },
  });

  assert.deepEqual(result, {
    appDataPath: '/tmp/idbots-alpha/appData',
    userDataPath: '/tmp/idbots-alpha/appData/IDBots',
  });
});
