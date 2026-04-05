import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { resolveMetabotPaths } = require('../../dist/core/state/paths.js');

test('resolveMetabotPaths splits hot state and exports under .metabot', () => {
  assert.deepEqual(resolveMetabotPaths('/tmp/home'), {
    baseRoot: '/tmp/home/.metabot',
    hotRoot: '/tmp/home/.metabot/hot',
    exportRoot: '/tmp/home/.metabot/exports',
    runtimeDbPath: '/tmp/home/.metabot/hot/runtime.sqlite',
    secretsPath: '/tmp/home/.metabot/hot/secrets.json'
  });
});
