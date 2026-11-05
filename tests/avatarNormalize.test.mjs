import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const {
  AVATAR_MAX_BYTES,
  buildMetafileAvatarSourceUrls,
  describeAvatarFailure,
  extractAvatarPinId,
  isAvatarNormalizeFailure,
  isValidAvatarDataUrl,
  normalizeAvatarToDataUrl,
  sniffImageMimeFromBytes,
} = await import('../dist-electron/main/utils/avatarNormalize.js');

// The canonical validator the sync path uses; the normalizer must keep an
// already-valid data URL compatible with it.
const { parseDataUrlAvatar } = await import('../dist-electron/main/services/metaidCore.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_PNG_PATH = path.join(projectRoot, 'build', 'icons', 'png', '16x16.png');
const REAL_PNG = fs.readFileSync(REAL_PNG_PATH);
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG.toString('base64')}`;

/** Start a throwaway local http server; always torn down, incl. open sockets. */
async function withServer(handler, run) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// data: URLs — pass through / reject
// ---------------------------------------------------------------------------

test('data URL: a valid supported image data URL is returned unchanged', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_DATA_URL);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'data-url');
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.bytes, REAL_PNG.length);
});

test('data URL: trims surrounding whitespace before passing through', async () => {
  const result = await normalizeAvatarToDataUrl(`  ${REAL_PNG_DATA_URL}\n`);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
});

test('data URL: unsupported MIME is rejected as invalid-data-url', async () => {
  const result = await normalizeAvatarToDataUrl('data:text/plain;base64,aGVsbG8=');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'invalid-data-url');
});

test('data URL: malformed base64 is rejected as invalid-data-url', async () => {
  const result = await normalizeAvatarToDataUrl('data:image/png;base64,not valid base64');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'invalid-data-url');
});

test('empty / unknown source is rejected with a structured reason (never throws)', async () => {
  for (const value of ['', '   ', null, undefined, 'relative/path.png', 'metafile://abc']) {
    const result = await normalizeAvatarToDataUrl(value);
    assert.equal(isAvatarNormalizeFailure(result), true, `expected failure for ${JSON.stringify(value)}`);
    assert.ok(['empty', 'unsupported-scheme'].includes(result.reason));
  }
});

// ---------------------------------------------------------------------------
// http(s) — success + every failure mode
// ---------------------------------------------------------------------------

test('http(s): downloads a real PNG and returns the canonical data URL', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/avatar.png`);
      assert.equal(isAvatarNormalizeFailure(result), false);
      assert.equal(result.source, 'http-url');
      assert.equal(result.mime, 'image/png');
      assert.equal(result.bytes, REAL_PNG.length);
      assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
      // Must satisfy the pre-existing validator the sync path applies.
      assert.notEqual(parseDataUrlAvatar(result.dataUrl), null);
    },
  );
});

test('http(s): a lying Content-Type is ignored — magic bytes decide', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/avatar`);
      assert.equal(isAvatarNormalizeFailure(result), false);
      assert.equal(result.mime, 'image/png');
      assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
    },
  );
});

test('http(s): a non-image response degrades to non-image', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>not an image</body></html>');
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/page.html`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'non-image');
      assert.match(result.detail, /not a PNG\/JPEG\/WebP\/GIF image/);
    },
  );
});

test('http(s): a 404 degrades to fetch-failed', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/missing.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'fetch-failed');
      assert.match(result.detail, /HTTP 404/);
    },
  );
});

test('http(s): an oversized body degrades to too-large', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/big.png`, { maxBytes: 100 });
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'too-large');
    },
  );
});

test('http(s): an over-cap Content-Length is rejected before the body is read', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(AVATAR_MAX_BYTES + 1) });
      res.end(REAL_PNG);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/huge.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'too-large');
    },
  );
});

test('http(s): an empty body degrades to empty-body', async () => {
  await withServer(
    (req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/empty.png`);
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'empty-body');
    },
  );
});

test('http(s): an unresponsive server degrades to fetch-timeout', async () => {
  await withServer(
    (req, res) => {
      // Never respond; the client-side timeout must fire.
      setTimeout(() => res.end(REAL_PNG), 10_000);
    },
    async (base) => {
      const result = await normalizeAvatarToDataUrl(`${base}/slow.png`, { timeoutMs: 100 });
      assert.equal(isAvatarNormalizeFailure(result), true);
      assert.equal(result.reason, 'fetch-timeout');
      assert.match(result.detail, /Timed out after 100ms/);
    },
  );
});

test('http(s): an unreachable URL degrades to fetch-failed (no throw)', async () => {
  // Bind a port then close it so the connect is refused deterministically.
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));

  const result = await normalizeAvatarToDataUrl(`http://127.0.0.1:${port}/avatar.png`, { timeoutMs: 1000 });
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'fetch-failed');
});

// ---------------------------------------------------------------------------
// local files
// ---------------------------------------------------------------------------

test('local file: an absolute path to a real image is read and converted', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_PATH);
  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'local-file');
  assert.equal(result.mime, 'image/png');
  assert.equal(result.bytes, REAL_PNG.length);
  assert.equal(result.dataUrl, REAL_PNG_DATA_URL);
  assert.notEqual(parseDataUrlAvatar(result.dataUrl), null);
});

test('local file: a relative path is refused (unsupported-scheme)', async () => {
  const result = await normalizeAvatarToDataUrl('build/icons/png/16x16.png');
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'unsupported-scheme');
});

test('local file: a missing absolute path degrades to read-failed', async () => {
  const result = await normalizeAvatarToDataUrl(path.join(projectRoot, 'does-not-exist-avatar.png'));
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'read-failed');
});

test('local file: a non-image absolute path degrades to non-image', async () => {
  const result = await normalizeAvatarToDataUrl(path.join(projectRoot, 'package.json'));
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'non-image');
});

test('local file: an over-cap file degrades to too-large', async () => {
  const result = await normalizeAvatarToDataUrl(REAL_PNG_PATH, { maxBytes: 100 });
  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'too-large');
});

// ---------------------------------------------------------------------------
// metafile:// — NFT cover references (thumbnail-first)
// ---------------------------------------------------------------------------

// Live fixtures measured 2026-11-04: the Pixel Sun covers are ~0.9 MB as
// originals and ~13 KB through `?process=thumbnail`. Only the byte length and
// the JPEG magic bytes matter to the normalizer (it never decodes pixels).
const PIXEL_SUN_02_PIN = '14158a127fa1d7b66d821413abad64bc833cf145e7abd2b40838fde703609b45i0';
const PIXEL_SUN_03_PIN = '6c45ca74504db05b0a2cf0378f76126c8ce7819c4bec0f60c593f772d600b542i0';
const THUMB_BYTES_02 = 13_250;
const THUMB_BYTES_03 = 13_047;
const ORIGINAL_BYTES_02 = 877_125;
const ORIGINAL_BYTES_03 = 970_754;

/** A buffer of exactly `bytes` bytes that passes the JPEG magic-byte sniff. */
function jpegOfSize(bytes) {
  const buffer = Buffer.alloc(bytes);
  buffer[0] = 0xff;
  buffer[1] = 0xd8;
  buffer[2] = 0xff;
  return buffer;
}

const imageResponse = (buffer, mime = 'image/jpeg') =>
  new Response(buffer, { status: 200, headers: { 'content-type': mime } });

/**
 * Fetch mock with two behaviours, both keyed on the request URL:
 * - thumbnail URLs answer the small rendering, originals answer the big file
 *   (`oversizedOriginals: false`, the healthy gateway), or
 * - every URL answers the big original (`oversizedOriginals: true`), modelling
 *   a gateway that ignores `process=thumbnail`.
 */
function metafileFetchMock({ thumbBytes, originalBytes, oversizedOriginals = false }) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    const isThumbnail = String(url).includes('process=thumbnail');
    if (oversizedOriginals || !isThumbnail) {
      return imageResponse(jpegOfSize(originalBytes));
    }
    return imageResponse(jpegOfSize(thumbBytes));
  };
  return { impl, calls };
}

test('metafile: metafile://<pinId>.jpg resolves through the thumbnail endpoint first', async () => {
  const mock = metafileFetchMock({ thumbBytes: THUMB_BYTES_02, originalBytes: ORIGINAL_BYTES_02 });
  const result = await normalizeAvatarToDataUrl(`metafile://${PIXEL_SUN_02_PIN}.jpg`, { fetchImpl: mock.impl });

  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'metafile');
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.bytes, THUMB_BYTES_02, 'must carry the thumbnail rendering, not the 877 KB original');
  assert.notEqual(parseDataUrlAvatar(result.dataUrl), null);

  assert.ok(mock.calls.length >= 1);
  assert.match(mock.calls[0], /process=thumbnail/, 'the FIRST request must ask for the thumbnail variant');
  assert.match(mock.calls[0], new RegExp(PIXEL_SUN_02_PIN), 'the pin id rides the request path');
  assert.doesNotMatch(mock.calls[0], /\.jpg/, 'the file extension is not part of the pin id');
});

test('metafile: a bare 66-character pinId resolves like a metafile:// reference', async () => {
  const mock = metafileFetchMock({ thumbBytes: THUMB_BYTES_03, originalBytes: ORIGINAL_BYTES_03 });
  const result = await normalizeAvatarToDataUrl(PIXEL_SUN_03_PIN, { fetchImpl: mock.impl });

  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.source, 'metafile');
  assert.equal(result.bytes, THUMB_BYTES_03);
  assert.match(mock.calls[0], /process=thumbnail/);
});

test('metafile: an oversized original (877125 / 970754 bytes) degrades to structured too-large', async () => {
  for (const [pinId, bytes] of [
    [PIXEL_SUN_02_PIN, ORIGINAL_BYTES_02],
    [PIXEL_SUN_03_PIN, ORIGINAL_BYTES_03],
  ]) {
    const mock = metafileFetchMock({ thumbBytes: bytes, originalBytes: bytes, oversizedOriginals: true });
    let result;
    await assert.doesNotReject(async () => {
      result = await normalizeAvatarToDataUrl(`metafile://${pinId}`, { fetchImpl: mock.impl });
    }, 'an oversized cover must never throw');
    assert.equal(isAvatarNormalizeFailure(result), true);
    assert.equal(result.reason, 'too-large');
    assert.match(result.detail, new RegExp(String(bytes)), 'the structured detail carries the measured size');
    assert.match(result.detail, new RegExp(String(AVATAR_MAX_BYTES)), 'and the cap it exceeded');
  }
});

test('metafile: a pin that serves non-image bytes at every route degrades to non-image', async () => {
  const calls = [];
  const htmlFetch = async (url) => {
    calls.push(String(url));
    return new Response('<html><body>gateway error</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
  };
  const result = await normalizeAvatarToDataUrl(`metafile://${PIXEL_SUN_02_PIN}.png`, { fetchImpl: htmlFetch });

  assert.equal(isAvatarNormalizeFailure(result), true);
  assert.equal(result.reason, 'non-image');
  assert.equal(calls.length, buildMetafileAvatarSourceUrls(PIXEL_SUN_02_PIN).length, 'every fallback route was tried');
});

test('metafile: missing thumbnail variants fall back to the original file endpoint', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('process=thumbnail')) {
      return new Response('missing', { status: 404 });
    }
    return imageResponse(jpegOfSize(THUMB_BYTES_02));
  };
  const result = await normalizeAvatarToDataUrl(`metafile://${PIXEL_SUN_02_PIN}.jpg`, { fetchImpl });

  assert.equal(isAvatarNormalizeFailure(result), false);
  assert.equal(result.bytes, THUMB_BYTES_02);
  assert.equal(calls.length, 3, 'two thumbnail routes then the original');
  assert.doesNotMatch(calls[2], /process=thumbnail/);
});

test('metafile: malformed references keep the unsupported-scheme reason', async () => {
  const fetchImpl = async () => {
    throw new Error('the resolver must not fetch a malformed reference');
  };
  const malformed = [
    'metafile://abc',
    'metafile://',
    `metafile://${PIXEL_SUN_02_PIN.slice(0, 63)}i0`, // 63 hex chars
    `metafile://${PIXEL_SUN_02_PIN}/extra`, // path separator
    `metafile://${PIXEL_SUN_02_PIN.slice(0, 64)}`, // 64 hex chars, no `i<n>` output index
    'metafile://0x1234',
  ];
  for (const value of malformed) {
    const result = await normalizeAvatarToDataUrl(value, { fetchImpl });
    assert.equal(isAvatarNormalizeFailure(result), true, `expected failure for ${value}`);
    assert.equal(result.reason, 'unsupported-scheme', `expected unsupported-scheme for ${value}`);
  }
});

test('metafile: pin extraction and the thumbnail-first candidate order are pure/testable', () => {
  assert.equal(extractAvatarPinId(`metafile://${PIXEL_SUN_02_PIN}.jpg`), PIXEL_SUN_02_PIN);
  assert.equal(extractAvatarPinId(PIXEL_SUN_02_PIN), PIXEL_SUN_02_PIN);
  assert.equal(extractAvatarPinId(`  metafile://${PIXEL_SUN_02_PIN}.PNG  `), PIXEL_SUN_02_PIN);
  assert.equal(extractAvatarPinId('metafile://abc'), null);
  assert.equal(extractAvatarPinId('build/icons/png/16x16.png'), null);

  const urls = buildMetafileAvatarSourceUrls(PIXEL_SUN_02_PIN);
  assert.equal(urls.length, 3);
  assert.match(urls[0], /api\/v1\/files\/accelerate\/content\/.+process=thumbnail$/);
  assert.match(urls[1], /users\/avatar\/accelerate\/.+process=thumbnail$/);
  assert.doesNotMatch(urls[2], /process=thumbnail/);
  for (const url of urls) {
    assert.ok(url.includes(PIXEL_SUN_02_PIN), 'every candidate carries the bare pin id');
  }
});

// ---------------------------------------------------------------------------
// magic-byte sniffer
// ---------------------------------------------------------------------------

test('sniffImageMimeFromBytes identifies the four supported formats and rejects others', () => {
  const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const webp = Buffer.concat([
    Buffer.from('RIFF', 'ascii'),
    Buffer.from([0x10, 0x00, 0x00, 0x00]),
    Buffer.from('WEBP', 'ascii'),
    Buffer.from('VP8 ', 'ascii'),
  ]);
  assert.equal(sniffImageMimeFromBytes(REAL_PNG), 'image/png');
  assert.equal(sniffImageMimeFromBytes(jpeg), 'image/jpeg');
  assert.equal(sniffImageMimeFromBytes(gif), 'image/gif');
  assert.equal(sniffImageMimeFromBytes(webp), 'image/webp');
  assert.equal(sniffImageMimeFromBytes(Buffer.from('RIFFxxxxNOPE', 'ascii')), null);
  assert.equal(sniffImageMimeFromBytes(Buffer.from('<!doctype html>', 'ascii')), null);
  assert.equal(sniffImageMimeFromBytes(Buffer.alloc(0)), null);
});

// ---------------------------------------------------------------------------
// cross-check: the local validator must agree with the canonical one
// ---------------------------------------------------------------------------

test('isValidAvatarDataUrl agrees with parseDataUrlAvatar on a corpus', () => {
  const canonicalJpeg = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]).toString('base64')}`;
  const corpus = [
    REAL_PNG_DATA_URL,
    canonicalJpeg,
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'data:text/plain;base64,aGVsbG8=',
    'data:image/png;base64,not valid base64',
    'data:image/png;base64,',
    'data:image/png;base64,iVBOR',
    'data:image/svg+xml;base64,PHN2Zy8+',
    'data:image/png;base64,AAAA===',
    'not-a-data-url',
    '',
  ];
  for (const value of corpus) {
    assert.equal(
      isValidAvatarDataUrl(value),
      parseDataUrlAvatar(value) !== null,
      `validator mismatch for ${JSON.stringify(value)}`,
    );
  }
});

test('describeAvatarFailure renders both outcomes without throwing', async () => {
  const ok = await normalizeAvatarToDataUrl(REAL_PNG_DATA_URL);
  assert.match(describeAvatarFailure(ok), /normalized to a image\/png data URL/);
  const bad = await normalizeAvatarToDataUrl('data:text/plain;base64,aGVsbG8=');
  assert.match(describeAvatarFailure(bad), /invalid-data-url/);
});
