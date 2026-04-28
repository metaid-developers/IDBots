import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  selectUploadMode,
  validateUploadSize,
  buildUploadSuccessPayload,
  normalizeRpcUploadResult,
} = require('../dist-electron/services/metaFileUploadShared.js');

const MIB = 1024 * 1024;

test('selectUploadMode keeps 2 MiB files on direct upload and switches larger files to chunked', () => {
  assert.equal(
    selectUploadMode({
      sizeBytes: 2 * MIB,
      chunkThresholdBytes: 2 * MIB,
    }),
    'direct',
  );

  assert.equal(
    selectUploadMode({
      sizeBytes: 2 * MIB + 1,
      chunkThresholdBytes: 2 * MIB,
    }),
    'chunked',
  );
});

test('validateUploadSize rejects files larger than the hard ceiling', () => {
  assert.throws(
    () =>
      validateUploadSize({
        sizeBytes: 20 * MIB + 1,
        maxSizeBytes: 20 * MIB,
      }),
    /20 MiB/,
  );
});

test('buildUploadSuccessPayload returns pinId and preview URL', () => {
  assert.deepEqual(
    buildUploadSuccessPayload({
      pinId: 'abc123i0',
      fileName: 'demo.png',
      size: 123,
      contentType: 'image/png',
      uploadMode: 'chunked',
    }),
    {
      success: true,
      pinId: 'abc123i0',
      previewUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/abc123i0',
      fallbackUrl: 'https://file.metaid.io/metafile-indexer/api/v1/files/content/abc123i0',
      fileName: 'demo.png',
      size: 123,
      contentType: 'image/png',
      uploadMode: 'chunked',
    },
  );
});

test('normalizeRpcUploadResult preserves the backend JSON contract for the skill script', () => {
  const payload = normalizeRpcUploadResult({
    pinId: 'pin123i0',
    fileName: 'clip.mp4',
    size: 1048577,
    contentType: 'video/mp4',
    uploadMode: 'chunked',
  });

  assert.equal(payload.success, true);
  assert.equal(payload.pinId, 'pin123i0');
  assert.equal(
    payload.previewUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/pin123i0',
  );
  assert.equal(
    payload.fallbackUrl,
    'https://file.metaid.io/metafile-indexer/api/v1/files/content/pin123i0',
  );
  assert.equal(payload.fileName, 'clip.mp4');
  assert.equal(payload.size, 1048577);
  assert.equal(payload.contentType, 'video/mp4');
  assert.equal(payload.uploadMode, 'chunked');
});
