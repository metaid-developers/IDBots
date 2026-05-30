import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let resolveMetaAppVisualFields;
try {
  ({ resolveMetaAppVisualFields } = require('../dist-electron/services/metaAppVisualService.js'));
} catch {
  resolveMetaAppVisualFields = null;
}

test('resolveMetaAppVisualFields maps chain metafile visuals to browser URLs without fetching', async () => {
  assert.equal(typeof resolveMetaAppVisualFields, 'function', 'resolveMetaAppVisualFields() should be exported');

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('chain visual preview URL mapping should not fetch image bytes');
  };

  try {
    const result = await resolveMetaAppVisualFields(
      {
        name: 'Chain App',
        icon: 'metafile://icon-pin-i0',
        cover: 'metafile://cover-pin-i0',
        authorAvatar: '/content/avatar-pin-i0',
      },
      { preferRemoteAssetUrls: true },
    );

    assert.equal(
      result.icon,
      'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/icon-pin-i0',
    );
    assert.equal(
      result.cover,
      'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/cover-pin-i0',
    );
    assert.equal(
      result.authorAvatar,
      'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/avatar-pin-i0',
    );
    assert.equal(result.name, 'Chain App');
  } finally {
    global.fetch = originalFetch;
  }
});

test('resolveMetaAppVisualFields resolves local MetaApp cover files to data URLs', async () => {
  assert.equal(typeof resolveMetaAppVisualFields, 'function', 'resolveMetaAppVisualFields() should be exported');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-metaapp-visual-'));
  const appRoot = path.join(tempDir, 'buzz');
  fs.mkdirSync(path.join(appRoot, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(appRoot, 'assets', 'cover.webp'), Buffer.from([0x52, 0x49, 0x46, 0x46]));

  const result = await resolveMetaAppVisualFields({
    id: 'buzz',
    name: 'buzz-app',
    appRoot,
    cover: '/buzz/assets/cover.webp',
  });

  assert.equal(result.cover, 'data:image/webp;base64,UklGRg==');
});
