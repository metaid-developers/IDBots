import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let ensureMetaAppServerReady;
let getMetaAppBaseUrl;
let stopMetaAppServer;

try {
  ({ ensureMetaAppServerReady, getMetaAppBaseUrl, stopMetaAppServer } =
    require('../dist-electron/services/metaAppLocalServer.js'));
} catch {
  ensureMetaAppServerReady = null;
  getMetaAppBaseUrl = null;
  stopMetaAppServer = null;
}

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapps-local-server-'));

const writeFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

async function request({ url, method = 'GET' }) {
  const parsed = new URL(url);
  const pathStart = url.indexOf(parsed.host) + parsed.host.length;
  const rawPath = url.slice(pathStart) || '/';
  const req = http.request(
    {
      hostname: parsed.hostname,
      port: parsed.port,
      path: rawPath,
      method,
    },
    (res) => res,
  );

  req.end();
  const [res] = await once(req, 'response');
  const chunks = [];
  for await (const chunk of res) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return { statusCode: res.statusCode ?? 0, headers: res.headers, body };
}

test('ensureMetaAppServerReady() starts a localhost server with a health endpoint', async () => {
  assert.equal(typeof ensureMetaAppServerReady, 'function', 'ensureMetaAppServerReady() should be exported');
  assert.equal(typeof getMetaAppBaseUrl, 'function', 'getMetaAppBaseUrl() should be exported');
  assert.equal(typeof stopMetaAppServer, 'function', 'stopMetaAppServer() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  fs.mkdirSync(metaAppsRoot, { recursive: true });

  let baseUrl = null;
  try {
    const ready = await ensureMetaAppServerReady(metaAppsRoot);
    baseUrl = ready.baseUrl;
    assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(Number.isInteger(ready.port) && ready.port > 0, 'expected an ephemeral port');
    assert.equal(getMetaAppBaseUrl(), baseUrl);

    const health = await request({ url: `${baseUrl}/__idbots/metaapps/health` });
    assert.equal(health.statusCode, 200);
    assert.match(health.body, /ok/i);
  } finally {
    if (stopMetaAppServer) {
      await stopMetaAppServer();
    }
  }
});

test('server serves a valid app file from the active METAAPPs root', async () => {
  assert.equal(typeof ensureMetaAppServerReady, 'function', 'ensureMetaAppServerReady() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  const content = '<html><body>buzz</body></html>';
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), content);

  let baseUrl = null;
  try {
    ({ baseUrl } = await ensureMetaAppServerReady(metaAppsRoot));
    const res = await request({ url: `${baseUrl}/buzz/app/index.html` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, content);
  } finally {
    if (stopMetaAppServer) {
      await stopMetaAppServer();
    }
  }
});

test('server rejects traversal outside METAAPPs', async () => {
  assert.equal(typeof ensureMetaAppServerReady, 'function', 'ensureMetaAppServerReady() should be exported');

  const tempDir = createTempDir();
  const metaAppsRoot = path.join(tempDir, 'METAAPPs');
  writeFile(path.join(metaAppsRoot, 'buzz', 'app', 'index.html'), '<html>ok</html>');

  const secretPath = path.join(tempDir, 'secret.txt');
  writeFile(secretPath, 'secret');

  let baseUrl = null;
  try {
    ({ baseUrl } = await ensureMetaAppServerReady(metaAppsRoot));

    // Avoid URL normalization of ".." segments by percent-encoding them.
    const res = await request({ url: `${baseUrl}/buzz/%2e%2e/%2e%2e/secret.txt` });
    assert.equal(res.statusCode, 403);
    assert.notEqual(res.body, 'secret');
  } finally {
    if (stopMetaAppServer) {
      await stopMetaAppServer();
    }
  }
});
