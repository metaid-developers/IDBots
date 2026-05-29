import assert from 'node:assert/strict';
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
