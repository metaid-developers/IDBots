import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let openMetaApp;
try {
  ({ openMetaApp } = require('../dist-electron/services/metaAppOpenService.js'));
} catch {
  openMetaApp = null;
}

test('openMetaApp resolves a valid targetPath, ensures the server, and opens the final URL', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const metaAppsRoot = path.join('/tmp', 'idbots-metaapps-open-service');
  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let ensuredRoot = null;
  let openedUrl = null;

  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '/buzz/app/index.html?view=hot#top',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async (root) => {
      ensuredRoot = root;
      return { baseUrl: 'http://127.0.0.1:43210' };
    },
    shellOpenExternal: async (url) => {
      openedUrl = url;
    },
  });

  assert.deepEqual(result, {
    success: true,
    appId: 'buzz',
    name: 'Buzz',
    url: 'http://127.0.0.1:43210/buzz/app/index.html?view=hot#top',
  });
  assert.equal(ensuredRoot, metaAppsRoot);
  assert.equal(openedUrl, 'http://127.0.0.1:43210/buzz/app/index.html?view=hot#top');
});

test('openMetaApp falls back to record.entry when targetPath is empty', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const metaAppsRoot = path.join('/tmp', 'idbots-metaapps-open-service');
  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html?from=entry#hash',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let openedUrl = null;
  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '   ',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => ({ baseUrl: 'http://127.0.0.1:12345' }),
    shellOpenExternal: async (url) => {
      openedUrl = url;
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.url, 'http://127.0.0.1:12345/buzz/app/index.html?from=entry#hash');
  assert.equal(openedUrl, 'http://127.0.0.1:12345/buzz/app/index.html?from=entry#hash');
});

test('openMetaApp rejects invalid app ids', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'missing',
    targetPath: '/missing/app/index.html',
    manager: {
      listMetaApps: () => [
        {
          id: 'buzz',
          name: 'Buzz',
          entry: '/buzz/app/index.html',
          appRoot: '/tmp/idbots-metaapps-open-service/buzz',
        },
      ],
    },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:1' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.error && /not found|unknown/i.test(result.error), `unexpected error: ${result.error}`);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects cross-app target paths', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: '/tmp/idbots-metaapps-open-service/buzz',
  };

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '/chat/app/index.html',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:1' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.error && /targetPath|path|app/i.test(result.error), `unexpected error: ${result.error}`);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});

