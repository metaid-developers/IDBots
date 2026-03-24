import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getDefaultMetabotAvatarUrl,
  getRendererBundledAssetUrl,
} from '../src/renderer/utils/rendererAssetPaths.js';

test('renderer bundled asset URLs resolve correctly in dev http mode', () => {
  assert.equal(
    getRendererBundledAssetUrl('default_metabot.png', 'http://localhost:5175/'),
    'http://localhost:5175/default_metabot.png',
  );
});

test('renderer bundled asset URLs resolve correctly in packaged file mode', () => {
  assert.equal(
    getRendererBundledAssetUrl('default_metabot.png', 'file:///Applications/IDBots.app/Contents/Resources/app.asar/dist/index.html'),
    'file:///Applications/IDBots.app/Contents/Resources/app.asar/dist/default_metabot.png',
  );
  assert.equal(
    getDefaultMetabotAvatarUrl('file:///Applications/IDBots.app/Contents/Resources/app.asar/dist/index.html'),
    'file:///Applications/IDBots.app/Contents/Resources/app.asar/dist/default_metabot.png',
  );
});
