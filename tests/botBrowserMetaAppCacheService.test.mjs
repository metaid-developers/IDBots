import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import AdmZip from 'adm-zip';

import { createBotBrowserMetaAppCacheService, metaAppPreviewHtmlPreparationAvailable } from '../src/main/services/botBrowserMetaAppCacheService.ts';
import { fetchContentWithFallback } from '../src/main/services/localIndexerProxy.ts';
import {
  assertMetaAppZipDownloadIntegrity,
  assertZipArchiveIntegrity,
  looksLikeZipArchive,
} from '../src/main/libs/metaAppZipDownload.ts';

function createMetaAppZip() {
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from('<!doctype html><html><body>MetaAPP OK</body></html>', 'utf8'));
  zip.addFile('assets/app.js', Buffer.from('window.__metaAppLoaded = true;', 'utf8'));
  return zip.toBuffer();
}

function startLocalServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

const serverAddress = (server) => `http://127.0.0.1:${server.address().port}`;

async function withP2PLocalBase(base, run) {
  const previous = process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
  process.env.IDBOTS_MAN_P2P_LOCAL_BASE = base;
  try {
    return await run();
  } finally {
    if (previous == null) {
      delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
    } else {
      process.env.IDBOTS_MAN_P2P_LOCAL_BASE = previous;
    }
  }
}

test('Bot Browser MetaApp cache resolver downloads, caches, and serves a MetaAPP preview', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const requestedUrls = [];
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Eric Homepage',
                appName: 'eric-homepage',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);

    assert.equal(resolved.ok, true);
    assert.equal(resolved.data.contentType, 'text/html');
    assert.match(resolved.data.runUrl, /^http:\/\/127\.0\.0\.1:\d+\/browser-cache\/metaapp-preview\//);
    assert.equal(resolved.data.localUiUrl, resolved.data.runUrl);

    const preview = await fetch(resolved.data.runUrl);
    assert.equal(preview.status, 200);
    assert.match(await preview.text(), /MetaAPP OK/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.cacheRoot, cacheRoot);
    assert.equal(stats.data.artifactCount, 1);
    assert.equal(stats.data.pinRecordCount, 1);
    assert.equal(stats.data.activePreviewSessionCount, 1);
    assert.equal(stats.data.artifacts[0].metaAppPinId, metaAppPinId);
    assert.ok(requestedUrls.some((url) => url.includes(`/pin/${metaAppPinId}`)));
    assert.ok(requestedUrls.some((url) => url.includes(codePinId)));

    const cleared = await service.clearCache({ all: true });
    assert.equal(cleared.ok, true);
    assert.deepEqual(cleared.data, { clearedArtifacts: 1, clearedPinRecords: 1 });

    const emptyStats = await service.getCache();
    assert.equal(emptyStats.ok, true);
    assert.equal(emptyStats.data.artifactCount, 0);
    assert.equal(emptyStats.data.pinRecordCount, 0);
    assert.equal(emptyStats.data.activePreviewSessionCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache serves prepared preview HTML with Agent Internet URI support', async (t) => {
  if (!metaAppPreviewHtmlPreparationAvailable()) t.skip('requires agent-browser-core >= 0.5.3');
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'd5'.repeat(32) + 'i0';
  const codePinId = 'a1'.repeat(32) + 'i0';
  const imagePinId = 'f4'.repeat(32) + 'i0';
  const zip = new AdmZip();
  zip.addFile('index.html', Buffer.from(
    `<!doctype html><html><head></head><body><a href="metaapp://${metaAppPinId}">self</a><img src="metafile://${imagePinId}"></body></html>`,
    'utf8',
  ));
  const zipBuffer = zip.toBuffer();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    resolveMetafileContentBaseUrl: () => 'https://content.example.test/files',
    fetch: async (url) => {
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'URI Homepage',
                appName: 'uri-homepage',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, true);

    const preview = await fetch(resolved.data.runUrl);
    assert.equal(preview.status, 200);
    const html = await preview.text();
    assert.ok(html.includes(`href="metaapp://${metaAppPinId}"`), 'internal href should stay an Agent Internet URI');
    assert.ok(html.includes(`src="https://content.example.test/files/${imagePinId}"`), 'metafile img src should be rewritten against the configured base');
    assert.match(html, /__agentBrowserPreviewBridge/);
    assert.match(html, /__agentBrowserPreviewStorageShim/);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache rejects a truncated download and writes nothing to cache', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Truncated App',
                appName: 'truncated-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer.subarray(0, 64), {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            'content-length': String(zipBuffer.length),
          },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'browser_resolve_failed');
    assert.match(resolved.message, /was truncated \(received 64 of \d+ bytes\)/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 0);
    assert.equal(stats.data.pinRecordCount, 0);
    assert.equal(stats.data.activePreviewSessionCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache follows 307 redirects when the fetch impl does not', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const ossUrl = `https://metafs.oss-cn-beijing.aliyuncs.com/indexer/mvc/${codePinId}.zip`;
  const requestedUrls = [];
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Redirect App',
                appName: 'redirect-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url) === ossUrl) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(null, {
          status: 307,
          headers: { location: ossUrl },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, true);
    assert.match(resolved.data.runUrl, /^http:\/\/127\.0\.0\.1:\d+\/browser-cache\/metaapp-preview\//);
    assert.ok(requestedUrls.includes(ossUrl), 'redirect Location should be followed');

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 1);
    assert.equal(stats.data.pinRecordCount, 1);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('Bot Browser MetaApp cache rejects a zip missing its EOCD and writes nothing to cache', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'No EOCD App',
                appName: 'no-eocd-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url).includes(codePinId)) {
        return new Response(zipBuffer.subarray(0, zipBuffer.length - 22), {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, false);
    assert.equal(resolved.code, 'browser_resolve_failed');
    assert.match(resolved.message, /missing end-of-central-directory record/);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 0);
    assert.equal(stats.data.pinRecordCount, 0);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('valid MetaApp zip passes integrity with a matching Content-Length', () => {
  const zipBuffer = createMetaAppZip();
  assert.doesNotThrow(() => {
    assertMetaAppZipDownloadIntegrity(zipBuffer, {
      headers: { get: (name) => (name === 'content-length' ? String(zipBuffer.length) : null) },
    });
  });
});

test('valid MetaApp zip passes integrity without Content-Length (magic + EOCD check)', () => {
  const zipBuffer = createMetaAppZip();
  assert.doesNotThrow(() => {
    assertMetaAppZipDownloadIntegrity(zipBuffer, {
      headers: { get: () => null },
    });
  });
});

test('Content-Length mismatch is reported as a truncated download', () => {
  const zipBuffer = createMetaAppZip();
  const truncated = zipBuffer.subarray(0, 64);
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(truncated, {
        headers: { get: (name) => (name === 'content-length' ? String(zipBuffer.length) : null) },
      });
    },
    /was truncated \(received 64 of \d+ bytes\)/,
  );
});

test('missing EOCD is reported as a truncated download when no Content-Length is declared', () => {
  const zipBuffer = createMetaAppZip();
  const truncated = zipBuffer.subarray(0, zipBuffer.length - 22);
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(truncated, {
        headers: { get: () => null },
      });
    },
    /missing end-of-central-directory record/,
  );
});

test('non-zip response body is rejected by the PK magic check', () => {
  const html = Buffer.from('<!doctype html><html><body>error</body></html>', 'utf8');
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(html, {
        headers: { get: (name) => (name === 'content-length' ? String(html.length) : null) },
      });
    },
    /not a valid ZIP archive \(missing PK\\x03\\x04 header\)/,
  );
});

test('fake EOCD bytes inside payload data do not pass the bounds check', () => {
  const zipBuffer = createMetaAppZip();
  const fakeEocd = Buffer.alloc(22);
  fakeEocd.writeUInt32LE(0x06054b50, 0); // PK\x05\x06
  fakeEocd.writeUInt32LE(0xffffffff, 12); // central directory size
  fakeEocd.writeUInt32LE(0xffffffff, 16); // central directory offset
  const forged = Buffer.concat([zipBuffer.subarray(0, zipBuffer.length - 22), fakeEocd]);
  assert.throws(
    () => assertZipArchiveIntegrity(forged),
    /missing end-of-central-directory record/,
  );
});

test('invalid Content-Length header is rejected', () => {
  const zipBuffer = createMetaAppZip();
  assert.throws(
    () => {
      assertMetaAppZipDownloadIntegrity(zipBuffer, {
        headers: { get: () => 'not-a-number' },
      });
    },
    /content-length is invalid/,
  );
});

test('Bot Browser MetaApp cache falls back to the direct content API URL when accelerate fails', async () => {
  const cacheRoot = await mkdtemp(path.join(os.tmpdir(), 'idbots-bot-browser-cache-'));
  const metaAppPinId = 'c06b7a2db6efa241560a2356e9966cf9758dae3ec9c795f614a652b113e30329i0';
  const codePinId = '7086cf5272192d32e888a7675ceaada6a86cbcf5cf936355c36c2f0fed538352i0';
  const zipBuffer = createMetaAppZip();
  const accelerateUrl = `https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/${codePinId}`;
  const contentApiUrl = `https://file.metaid.io/metafile-indexer/api/v1/files/content/${codePinId}`;
  const requestedUrls = [];
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot,
    fetch: async (url) => {
      requestedUrls.push(String(url));
      if (String(url).endsWith(`/pin/${metaAppPinId}`)) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            pin: {
              path: '/protocols/metaapp',
              ownerGlobalMetaId: 'idq1publisher',
              timestamp: 1_700_000_000,
              contentSummary: JSON.stringify({
                title: 'Fallback App',
                appName: 'fallback-app',
                runtime: 'browser',
                version: '1.0.0',
                indexFile: 'index.html',
                contentType: 'application/zip',
                codeType: 'application/zip',
                content: `metafile://${codePinId}.zip`,
              }),
            },
          },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(url) === accelerateUrl) {
        return new Response('accelerate unavailable', { status: 500 });
      }
      if (String(url) === contentApiUrl) {
        return new Response(zipBuffer, {
          status: 200,
          headers: { 'content-type': 'application/zip' },
        });
      }
      return new Response('not found', { status: 404 });
    },
  });

  try {
    const resolved = await service.resolveMetaAppPin(metaAppPinId);
    assert.equal(resolved.ok, true);
    assert.match(resolved.data.runUrl, /^http:\/\/127\.0\.0\.1:\d+\/browser-cache\/metaapp-preview\//);
    assert.ok(requestedUrls.includes(contentApiUrl), 'direct content API URL should be used as fallback');
    assert.equal(requestedUrls.some((url) => url.includes('man.metaid.io/content/')), false);
    assert.equal(requestedUrls.some((url) => url.includes('/metafile-indexer/content/')), false);

    const stats = await service.getCache();
    assert.equal(stats.ok, true);
    assert.equal(stats.data.artifactCount, 1);
  } finally {
    await service.stop();
    await rm(cacheRoot, { recursive: true, force: true });
  }
});

test('fetchContentWithFallback skips a JSON local body when the zip validator is set', async () => {
  const zipBuffer = createMetaAppZip();
  let remoteHit = false;
  const localServer = await startLocalServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '38',
    });
    res.end('{"code":100,"message":"no pin found."}');
  });
  const remoteServer = await startLocalServer((req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(zipBuffer);
  });

  try {
    const response = await withP2PLocalBase(serverAddress(localServer), () => (
      fetchContentWithFallback(
        'pin123i0',
        `${serverAddress(remoteServer)}/content/pin123i0`,
        { redirect: 'follow' },
        looksLikeZipArchive,
      )
    ));
    assert.equal(response.ok, true);
    const body = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(body, zipBuffer);
    assert.equal(remoteHit, true, 'invalid local body should fall back to the remote URL');
  } finally {
    localServer.close();
    remoteServer.close();
  }
});

test('fetchContentWithFallback keeps accepting a local JSON body without a validator', async () => {
  let remoteHit = false;
  const localServer = await startLocalServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': '38',
    });
    res.end('{"code":100,"message":"no pin found."}');
  });
  const remoteServer = await startLocalServer((req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end('remote');
  });

  try {
    const response = await withP2PLocalBase(serverAddress(localServer), () => (
      fetchContentWithFallback('pin123i0', `${serverAddress(remoteServer)}/content/pin123i0`)
    ));
    assert.equal(response.ok, true);
    assert.equal(await response.text(), '{"code":100,"message":"no pin found."}');
    assert.equal(remoteHit, false);
  } finally {
    localServer.close();
    remoteServer.close();
  }
});

test('fetchContentWithFallback accepts a valid zip from the local node', async () => {
  const zipBuffer = createMetaAppZip();
  let remoteHit = false;
  const localServer = await startLocalServer((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/zip',
      'content-length': String(zipBuffer.length),
    });
    res.end(zipBuffer);
  });
  const remoteServer = await startLocalServer((req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(zipBuffer);
  });

  try {
    const response = await withP2PLocalBase(serverAddress(localServer), () => (
      fetchContentWithFallback(
        'pin123i0',
        `${serverAddress(remoteServer)}/content/pin123i0`,
        { redirect: 'follow' },
        looksLikeZipArchive,
      )
    ));
    assert.equal(response.ok, true);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), zipBuffer);
    assert.equal(remoteHit, false);
  } finally {
    localServer.close();
    remoteServer.close();
  }
});

test('fetchContentWithFallback falls back to remote when the local node misses', async () => {
  const zipBuffer = createMetaAppZip();
  const localServer = await startLocalServer((req, res) => {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end('{"code":100,"message":"no pin found."}');
  });
  const remoteServer = await startLocalServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/zip' });
    res.end(zipBuffer);
  });

  try {
    const response = await withP2PLocalBase(serverAddress(localServer), () => (
      fetchContentWithFallback(
        'pin123i0',
        `${serverAddress(remoteServer)}/content/pin123i0`,
        { redirect: 'follow' },
        looksLikeZipArchive,
      )
    ));
    assert.equal(response.ok, true);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), zipBuffer);
  } finally {
    localServer.close();
    remoteServer.close();
  }
});

// --- MetaApp preview origin port stability --------------------------------
// Browsers key localStorage by scheme+host+port, so the preview origin must
// bind a stable port across app launches or every restart orphans all
// MetaApp localStorage.

function listenOnPort(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(() => {});
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function createPortTestDir() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'metaapp-preview-port-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><html><body>Port probe</body></html>', 'utf8');
  return dir;
}

test('MetaApp preview origin binds the first free fixed port candidate', async () => {
  const dir = await createPortTestDir();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot: path.join(dir, 'cache'),
    previewPortCandidates: [47701, 47702],
  });
  try {
    const session = await service.createLocalPreviewSession({ artifactDir: dir, indexFile: 'index.html' });
    assert.match(session.localPreviewUrl, /^http:\/\/127\.0\.0\.1:47701\/browser-cache\/metaapp-preview\//);
    const response = await fetch(session.localPreviewUrl);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Port probe/);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('MetaApp preview origin falls back to the next fixed port when the first is busy', async () => {
  const blocker = await listenOnPort(47704);
  const dir = await createPortTestDir();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot: path.join(dir, 'cache'),
    previewPortCandidates: [47704, 47705],
  });
  try {
    const session = await service.createLocalPreviewSession({ artifactDir: dir, indexFile: 'index.html' });
    assert.match(session.localPreviewUrl, /^http:\/\/127\.0\.0\.1:47705\/browser-cache\/metaapp-preview\//);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    blocker.close();
  }
});

test('MetaApp preview origin falls back to an ephemeral port when all fixed candidates are busy', async () => {
  const blockerA = await listenOnPort(47706);
  const blockerB = await listenOnPort(47707);
  const dir = await createPortTestDir();
  const service = createBotBrowserMetaAppCacheService({
    cacheRoot: path.join(dir, 'cache'),
    previewPortCandidates: [47706, 47707],
  });
  try {
    const session = await service.createLocalPreviewSession({ artifactDir: dir, indexFile: 'index.html' });
    const parsed = new URL(session.localPreviewUrl);
    assert.equal(parsed.hostname, '127.0.0.1');
    assert.ok(!['47706', '47707'].includes(parsed.port), `expected an ephemeral port, got ${parsed.port}`);
    assert.match(session.localPreviewUrl, /\/browser-cache\/metaapp-preview\//);
  } finally {
    await service.stop();
    await rm(dir, { recursive: true, force: true });
    blockerA.close();
    blockerB.close();
  }
});
