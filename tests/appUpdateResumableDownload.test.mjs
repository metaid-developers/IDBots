// Runtime tests for the resumable app-update downloader
// (src/main/libs/appUpdateInstaller.ts, compiled to dist-electron).
//
// Run via: npm run test:update  (compiles electron sources first, then runs this file).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import Module from 'node:module';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-update-test-'));
const require = createRequire(import.meta.url);

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// --- Electron stub: app.getPath('temp') -> tempDir, fetch -> swappable stub ---
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        getPath: () => tempDir,
        relaunch: () => {},
        quit: () => {},
      },
      session: {
        defaultSession: {
          fetch: async (url, init) => fetchImpl(url, init),
        },
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const installer = require('../dist-electron/main/libs/appUpdateInstaller.js');
Module._load = originalLoad;

// --- helpers ---
let fetchImpl = async () => {
  throw new Error('fetch not stubbed');
};

let urlCounter = 0;
const makeUrl = () => `https://example.test/dl/${++urlCounter}.dmg`;

const VERSION = '0.4.0';
const ETAG = '"test-etag-1"';

/** Deterministic pseudo-random payload. */
function payloadOf(size, { seed = 1 } = {}) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) {
    buf[i] = (seed + i) % 256;
  }
  return buf;
}

const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Build a web Response with a streamable body. */
function makeResponse(status, body, headers = {}) {
  const stream = Array.isArray(body) ? Readable.from(body) : body;
  return new Response(Readable.toWeb(stream), { status, headers });
}

/** Readable that pushes all chunks then errors after a short delay. */
function failingStream(chunks, err, delayMs = 100) {
  let i = 0;
  let destroyed = false;
  return new Readable({
    read() {
      if (i < chunks.length) {
        this.push(chunks[i]);
        i += 1;
      } else if (!destroyed) {
        destroyed = true;
        setTimeout(() => this.destroy(err), delayMs);
      }
    },
  });
}

function stableIdFor(url, version = VERSION) {
  return installer.computeStableDownloadId(url, version);
}

const downloadPathFor = (id, ext = '.dmg') => path.join(tempDir, `idbots-update-${id}${ext}.download`);
const finalPathFor = (id, ext = '.dmg') => path.join(tempDir, `idbots-update-${id}${ext}`);
const metaPathFor = (id) => path.join(tempDir, `idbots-update-${id}.meta.json`);

function writeMeta(id, overrides = {}) {
  const meta = {
    url: '',
    version: VERSION,
    platform: process.platform,
    arch: process.arch,
    etag: ETAG,
    totalSize: 0,
    downloadedSize: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
  fs.writeFileSync(metaPathFor(id), JSON.stringify(meta));
  return meta;
}

function collectProgress() {
  const events = [];
  return { events, cb: (p) => events.push(p) };
}

async function waitFor(fn, timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor timed out');
}

// --- tests ---

test('1. fresh download: HTTP 200 full success, no Range header, meta persisted', async () => {
  const url = makeUrl();
  const total = 5000;
  const body = payloadOf(total);
  fetchImpl = async (u, init) => {
    assert.equal(u, url);
    assert.equal(init.headers.Range, undefined, 'fresh download must not send Range');
    return makeResponse(200, [body], { 'content-length': String(total) });
  };

  const { events, cb } = collectProgress();
  const filePath = await installer.downloadUpdate(url, cb, { version: VERSION });

  const id = stableIdFor(url, VERSION);
  assert.equal(filePath, finalPathFor(id));
  assert.deepEqual(fs.readFileSync(filePath), body);
  assert.equal(fs.existsSync(downloadPathFor(id)), false, 'partial renamed away after success');

  const meta = JSON.parse(fs.readFileSync(metaPathFor(id), 'utf8'));
  assert.equal(meta.url, url);
  assert.equal(meta.version, VERSION);
  assert.equal(meta.totalSize, total);
  assert.equal(meta.downloadedSize, total);

  assert.ok(events.length >= 2, 'initial + final progress events');
  assert.equal(events[0].received, 0);
  assert.equal(events[events.length - 1].percent, 1);
});

test('2. partial file present: request sends Range and If-Range headers', async () => {
  const url = makeUrl();
  const total = 6000;
  const offset = 2000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const rest = payloadOf(total - offset, { seed: offset + 1 });
  fetchImpl = async (u, init) => {
    assert.equal(u, url);
    assert.equal(init.headers.Range, `bytes=${offset}-`);
    assert.equal(init.headers['If-Range'], ETAG);
    return makeResponse(206, [rest], {
      'content-range': `bytes ${offset}-${total - 1}/${total}`,
      'content-length': String(total - offset),
      etag: ETAG,
    });
  };

  const { events, cb } = collectProgress();
  const filePath = await installer.downloadUpdate(url, cb, { version: VERSION });

  assert.equal(filePath, finalPathFor(id));
  assert.equal(events[0].resumed, true, 'progress marks the resumed run');
  assert.equal(events[0].received, offset);
  assert.equal(events[events.length - 1].received, total);
});

test('3. resume with correct 206/Content-Range: appends from offset', async () => {
  const url = makeUrl();
  const total = 4000;
  const offset = 2500;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const rest = payloadOf(total - offset, { seed: offset + 1 });
  fetchImpl = async () =>
    makeResponse(206, [rest], {
      'content-range': `bytes ${offset}-${total - 1}/${total}`,
      'content-length': String(total - offset),
      etag: ETAG,
    });

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(filePath, finalPathFor(id));
  assert.deepEqual(fs.readFileSync(finalPathFor(id)), payloadOf(total), 'partial + rest == full payload');
});

test('4. server answers 200 to a Range request: partial cleared, full redownload', async () => {
  const url = makeUrl();
  const total = 4000;
  const offset = 1500;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init);
    return makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(calls.length, 2, 'resume attempt + fresh attempt');
  assert.equal(calls[0].headers.Range, `bytes=${offset}-`);
  assert.equal(calls[1].headers.Range, undefined);
  assert.deepEqual(fs.readFileSync(filePath), payloadOf(total));
  const meta = JSON.parse(fs.readFileSync(metaPathFor(id), 'utf8'));
  assert.equal(meta.downloadedSize, total);
});

test('5. complete partial (416 equivalent): verified and finalized without network', async () => {
  const url = makeUrl();
  const total = 3000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(total));
  writeMeta(id, { url, totalSize: total, downloadedSize: total });

  let fetchCalled = false;
  fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('must not fetch');
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(fetchCalled, false);
  assert.equal(filePath, finalPathFor(id));
  assert.deepEqual(fs.readFileSync(finalPathFor(id)), payloadOf(total));
});

test('6. ETag changed (206 with different etag): old partial discarded, fresh download', async () => {
  const url = makeUrl();
  const total = 4000;
  const offset = 1000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset, etag: '"old-etag"' });

  const calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init);
    if (calls.length === 1) {
      return makeResponse(206, [payloadOf(total)], {
        'content-range': `bytes 0-${total - 1}/${total}`,
        'content-length': String(total),
        etag: '"new-etag"',
      });
    }
    return makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(calls.length, 2);
  assert.equal(fs.existsSync(downloadPathFor(id)), false, 'stale partial discarded');
  assert.deepEqual(fs.readFileSync(filePath), payloadOf(total));
});

test('7. Content-Range start mismatch: cannot append, restart fresh', async () => {
  const url = makeUrl();
  const total = 4000;
  const offset = 2000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init);
    if (calls.length === 1) {
      // Server claims a different start position than the local offset.
      return makeResponse(206, [payloadOf(total)], {
        'content-range': `bytes ${offset - 500}-${total - 1}/${total}`,
        'content-length': String(total),
        etag: ETAG,
      });
    }
    return makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readFileSync(filePath), payloadOf(total));
});

test('8. network failure mid-stream: partial file and metadata preserved', async () => {
  const url = makeUrl();
  const total = 5000;
  const chunk = payloadOf(1000);
  const id = stableIdFor(url, VERSION);

  fetchImpl = async () =>
    makeResponse(200, failingStream([chunk], new Error('socket hang up')), { 'content-length': String(total) });

  await assert.rejects(installer.downloadUpdate(url, () => {}, { version: VERSION }));

  const size = fs.statSync(downloadPathFor(id)).size;
  assert.equal(size, chunk.length, 'partial file retained');
  const meta = JSON.parse(fs.readFileSync(metaPathFor(id), 'utf8'));
  assert.equal(meta.downloadedSize, size, 'meta synced to actual bytes on disk');
  assert.equal(meta.totalSize, total);
});

test('9. app restart: second run resumes from the exact byte offset', async () => {
  const url = makeUrl();
  const total = 5000;
  const half = 3000;
  const id = stableIdFor(url, VERSION);

  // First session: interrupted at 3000/5000 bytes.
  fetchImpl = async () =>
    makeResponse(200, failingStream([payloadOf(half)], new Error('connection reset')), {
      'content-length': String(total),
    });
  await assert.rejects(installer.downloadUpdate(url, () => {}, { version: VERSION }));
  assert.equal(fs.statSync(downloadPathFor(id)).size, half);

  // Second session (fresh process): must continue from 3000, not byte 0.
  const rest = payloadOf(total - half, { seed: half + 1 });
  let seenRange;
  fetchImpl = async (_u, init) => {
    seenRange = init.headers.Range;
    return makeResponse(206, [rest], {
      'content-range': `bytes ${half}-${total - 1}/${total}`,
      'content-length': String(total - half),
      etag: ETAG,
    });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(seenRange, `bytes=${half}-`);
  assert.equal(fs.statSync(finalPathFor(id)).size, total);
  assert.deepEqual(fs.readFileSync(finalPathFor(id)), payloadOf(total));
});

test('10a. completion size mismatch: rejected, no installable final file', async () => {
  const url = makeUrl();
  const total = 5000;
  const id = stableIdFor(url, VERSION);

  fetchImpl = async () => makeResponse(200, [payloadOf(4000)], { 'content-length': String(total) });

  await assert.rejects(installer.downloadUpdate(url, () => {}, { version: VERSION }), /Download incomplete/);
  assert.equal(fs.existsSync(finalPathFor(id)), false);
  assert.equal(fs.existsSync(downloadPathFor(id)), true, 'partial kept for a future attempt');
});

test('10b. checksum mismatch: rejected, corrupt partial discarded', async () => {
  const url = makeUrl();
  const total = 2000;
  const id = stableIdFor(url, VERSION);

  fetchImpl = async () => makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });

  await assert.rejects(
    installer.downloadUpdate(url, () => {}, { version: VERSION, expectedSha256: '0'.repeat(64) }),
    /checksum mismatch/i,
  );
  assert.equal(fs.existsSync(finalPathFor(id)), false);
  assert.equal(fs.existsSync(downloadPathFor(id)), false, 'corrupt bytes are not resumed forever');
});

test('10c. correct checksum: verified and accepted', async () => {
  const url = makeUrl();
  const total = 2000;
  const body = payloadOf(total);

  fetchImpl = async () => makeResponse(200, [body], { 'content-length': String(total) });

  const filePath = await installer.downloadUpdate(url, () => {}, {
    version: VERSION,
    expectedSha256: sha256Hex(body),
  });
  assert.deepEqual(fs.readFileSync(filePath), body);
});

test('11. completed download reused on next launch: zero network transfer', async () => {
  const url = makeUrl();
  const total = 2500;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(finalPathFor(id), payloadOf(total));
  writeMeta(id, { url, totalSize: total, downloadedSize: total });

  let fetchCalled = false;
  fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('must not fetch');
  };

  const { events, cb } = collectProgress();
  const filePath = await installer.downloadUpdate(url, cb, { version: VERSION });
  assert.equal(fetchCalled, false);
  assert.equal(filePath, finalPathFor(id));
  assert.equal(events[0].percent, 1);
});

test('11b. reuse re-verifies the manifest checksum before trusting a completed file', async () => {
  const url = makeUrl();
  const total = 2200;
  const id = stableIdFor(url, VERSION);
  const body = payloadOf(total);
  fs.writeFileSync(finalPathFor(id), body);
  writeMeta(id, { url, totalSize: total, downloadedSize: total });

  let fetchCalled = false;
  fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('must not fetch');
  };

  const { events, cb } = collectProgress();
  const filePath = await installer.downloadUpdate(url, cb, {
    version: VERSION,
    expectedSha256: sha256Hex(body),
  });
  assert.equal(fetchCalled, false, 'a matching completed download still needs no network');
  assert.equal(filePath, finalPathFor(id));
  assert.equal(events[0].percent, 1);
});

test('11c. reuse with a stale checksum is rejected and the republished bad bytes discarded', async () => {
  const url = makeUrl();
  const total = 2200;
  const id = stableIdFor(url, VERSION);
  // Broken bytes under the same URL+version (the republished-artifact class):
  // without the re-hash this file would be reused forever, checksum bypassed.
  fs.writeFileSync(finalPathFor(id), payloadOf(total, { seed: 9 }));
  writeMeta(id, { url, totalSize: total, downloadedSize: total });

  let fetchCalled = false;
  fetchImpl = async () => {
    fetchCalled = true;
    throw new Error('must not fetch');
  };

  await assert.rejects(
    installer.downloadUpdate(url, () => {}, {
      version: VERSION,
      expectedSha256: sha256Hex(payloadOf(total)),
    }),
    /Reused download checksum mismatch/,
  );
  assert.equal(fs.existsSync(finalPathFor(id)), false, 'bad bytes are not kept forever');
  assert.equal(fs.existsSync(metaPathFor(id)), false, 'sidecar discarded so the next attempt starts fresh');
  assert.equal(fetchCalled, false);
});

test('12. stale artifacts cleaned, recent and in-flight files kept', async () => {
  const old = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days
  const artifacts = [
    [`idbots-update-${'a'.repeat(16)}.download`, old, false],
    [`idbots-update-${'b'.repeat(16)}.meta.json`, old, false],
    [`idbots-update-${'c'.repeat(16)}.dmg`, old, false],
    [`idbots-update-${'d'.repeat(16)}.exe`, Date.now(), true],
    ['idbots-update-1234567890123.dmg', old, false], // legacy timestamp name
    ['idbots-update-1234567890123.ps1', old, true], // installer script, not our artifact
    ['other-file.txt', old, true],
  ];
  for (const [name, mtime, kept] of artifacts) {
    fs.writeFileSync(path.join(tempDir, name), 'x');
    fs.utimesSync(path.join(tempDir, name), mtime / 1000, mtime / 1000);
  }

  const removed = await installer.cleanupStaleDownloads();
  assert.equal(removed, 4);
  for (const [name, , kept] of artifacts) {
    assert.equal(fs.existsSync(path.join(tempDir, name)), kept, name);
  }

  // In-flight download must never be touched by the sweep.
  const url = makeUrl();
  const id = stableIdFor(url, VERSION);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  fetchImpl = async () => {
    await gate;
    return makeResponse(200, [payloadOf(100)], { 'content-length': '100' });
  };
  const pending = installer.downloadUpdate(url, () => {}, { version: VERSION });
  await waitFor(() => fs.existsSync(metaPathFor(id)));
  fs.utimesSync(metaPathFor(id), old / 1000, old / 1000);
  await installer.cleanupStaleDownloads();
  assert.equal(fs.existsSync(metaPathFor(id)), true, 'in-flight metadata must survive the sweep');
  release();
  await pending;
});

test('13. 416 with incomplete partial: discarded and re-downloaded', async () => {
  const url = makeUrl();
  const total = 3000;
  const offset = 1000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init);
    if (calls.length === 1) {
      return new Response(null, { status: 416 });
    }
    return makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.Range, `bytes=${offset}-`);
  assert.deepEqual(fs.readFileSync(filePath), payloadOf(total));
});

test('14. concurrent download for the same target is rejected (single-flight lock)', async () => {
  const url = makeUrl();
  const id = stableIdFor(url, VERSION);
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  fetchImpl = async () => {
    await gate;
    return makeResponse(200, [payloadOf(100)], { 'content-length': '100' });
  };

  const p1 = installer.downloadUpdate(url, () => {}, { version: VERSION });
  await waitFor(() => fs.existsSync(metaPathFor(id)));
  await assert.rejects(installer.downloadUpdate(url, () => {}, { version: VERSION }), /already in progress/);
  release();
  await p1;
});

test('15. total size change between sessions: cannot append, restart fresh', async () => {
  const url = makeUrl();
  const total = 4000;
  const offset = 1000;
  const id = stableIdFor(url, VERSION);
  fs.writeFileSync(downloadPathFor(id), payloadOf(offset));
  writeMeta(id, { url, totalSize: total, downloadedSize: offset });

  const calls = [];
  fetchImpl = async (_u, init) => {
    calls.push(init);
    if (calls.length === 1) {
      // Server payload is now 5000 bytes while the local metadata said 4000.
      return makeResponse(206, [payloadOf(3000)], {
        'content-range': `bytes ${offset}-3999/5000`,
        'content-length': '3000',
        etag: ETAG,
      });
    }
    return makeResponse(200, [payloadOf(total)], { 'content-length': String(total) });
  };

  const filePath = await installer.downloadUpdate(url, () => {}, { version: VERSION });
  assert.equal(calls.length, 2);
  assert.deepEqual(fs.readFileSync(filePath), payloadOf(total));
});
