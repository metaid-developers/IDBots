import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  REQUIRED_WEB_SEARCH_PACKAGES,
  resolveMissingWebSearchPackages,
  ensureWebSearchDependencies,
} = require('../scripts/build-web-search-skill.js');

test('resolveMissingWebSearchPackages reports fresh-worktree runtime packages that are absent', () => {
  const missing = resolveMissingWebSearchPackages('/tmp/web-search', () => false);
  assert.deepEqual(
    missing,
    REQUIRED_WEB_SEARCH_PACKAGES.map((pkg) => pkg.name),
  );
});

test('ensureWebSearchDependencies runs npm ci when required runtime packages are missing', () => {
  const calls = [];
  const installed = ensureWebSearchDependencies({
    skillDir: '/tmp/web-search',
    existsSyncImpl: () => false,
    execFileSyncImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
    },
    log: () => {},
  });

  assert.equal(installed, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /^npm(\.cmd)?$/);
  assert.deepEqual(calls[0].args, ['ci']);
  assert.equal(calls[0].options.cwd, '/tmp/web-search');
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('ensureWebSearchDependencies skips npm ci when required runtime packages already exist', () => {
  const expectedMarkers = new Set(
    REQUIRED_WEB_SEARCH_PACKAGES.map((pkg) => path.join('/tmp/web-search', pkg.marker)),
  );
  const calls = [];

  const installed = ensureWebSearchDependencies({
    skillDir: '/tmp/web-search',
    existsSyncImpl: (filePath) => expectedMarkers.has(filePath),
    execFileSyncImpl: (...args) => {
      calls.push(args);
    },
    log: () => {},
  });

  assert.equal(installed, false);
  assert.deepEqual(calls, []);
});
