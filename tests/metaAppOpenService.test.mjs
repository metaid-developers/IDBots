import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let openMetaApp;
let resolveMetaAppUrl;
try {
  ({ openMetaApp, resolveMetaAppUrl } = require('../dist-electron/services/metaAppOpenService.js'));
} catch {
  openMetaApp = null;
  resolveMetaAppUrl = null;
}

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapps-open-service-'));

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

test('openMetaApp resolves a valid targetPath, ensures the server, and opens the final URL', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
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

test('resolveMetaAppUrl resolves a valid targetPath and returns the local URL without opening it', async () => {
  assert.equal(typeof resolveMetaAppUrl, 'function', 'resolveMetaAppUrl() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let ensuredRoot = null;

  const result = await resolveMetaAppUrl({
    appId: 'buzz',
    targetPath: '/buzz/app/index.html?view=hot#top',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async (root) => {
      ensuredRoot = root;
      return { baseUrl: 'http://127.0.0.1:43210' };
    },
  });

  assert.deepEqual(result, {
    success: true,
    appId: 'buzz',
    name: 'Buzz',
    url: 'http://127.0.0.1:43210/buzz/app/index.html?view=hot#top',
  });
  assert.equal(ensuredRoot, metaAppsRoot);
});

test('openMetaApp falls back to record.entry when targetPath is empty', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
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

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const result = await openMetaApp({
    appId: 'missing',
    targetPath: '/missing/app/index.html',
    manager: {
      listMetaApps: () => [
        {
          id: 'buzz',
          name: 'Buzz',
          entry: '/buzz/app/index.html',
          appRoot: path.join(metaAppsRoot, 'buzz'),
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

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
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

test('openMetaApp rejects dot-segment traversal in targetPath (decoded)', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
  writeFile(path.join(metaAppsRoot, 'chat', 'app', 'index.html'), '<html>chat</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '/buzz/../chat/app/index.html',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:12345' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects dot-segment traversal in targetPath (percent-encoded)', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
  writeFile(path.join(metaAppsRoot, 'chat', 'app', 'index.html'), '<html>chat</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '/buzz/%2e%2e/chat/app/index.html',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:12345' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects missing files', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'buzz',
    targetPath: '/buzz/app/missing.html',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:12345' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.error && /not found|missing|existing file/i.test(result.error), `unexpected error: ${result.error}`);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects non-local baseUrl from ensureServerReady()', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let openCalled = false;
  const result = await openMetaApp({
    appId: 'buzz',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => ({ baseUrl: 'http://localhost:12345' }),
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.error && /baseurl|localhost|127\.0\.0\.1/i.test(result.error), `unexpected error: ${result.error}`);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects malformed baseUrl from ensureServerReady()', async () => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: path.join(metaAppsRoot, 'buzz'),
  };

  let openCalled = false;
  const result = await openMetaApp({
    appId: 'buzz',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => ({ baseUrl: 'not-a-url' }),
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.ok(result.error && /baseurl|url/i.test(result.error), `unexpected error: ${result.error}`);
  assert.equal(openCalled, false);
});

test('openMetaApp rejects symlinked METAAPPs/<id> directory that escapes the served root', async (t) => {
  assert.equal(typeof openMetaApp, 'function', 'openMetaApp() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  const outsideRoot = path.join(tempDir, 'outside');

  writeFile(path.join(outsideRoot, 'buzz', 'app', 'index.html'), '<html>buzz</html>');
  fs.mkdirSync(metaAppsRoot, { recursive: true });

  const symlinkPath = path.join(metaAppsRoot, 'buzz');
  try {
    fs.symlinkSync(path.join(outsideRoot, 'buzz'), symlinkPath);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error) {
      const code = error.code;
      if (code === 'EPERM' || code === 'ENOSYS' || code === 'UNKNOWN') {
        t.skip(`symlink creation unsupported in this environment: ${code}`);
      }
    }
    throw error;
  }

  const record = {
    id: 'buzz',
    name: 'Buzz',
    entry: '/buzz/app/index.html',
    appRoot: symlinkPath,
  };

  let ensureCalled = false;
  let openCalled = false;

  const result = await openMetaApp({
    appId: 'buzz',
    manager: { listMetaApps: () => [record] },
    ensureServerReady: async () => {
      ensureCalled = true;
      return { baseUrl: 'http://127.0.0.1:12345' };
    },
    shellOpenExternal: async () => {
      openCalled = true;
    },
  });

  assert.equal(result.success, false);
  assert.equal(ensureCalled, false);
  assert.equal(openCalled, false);
});
