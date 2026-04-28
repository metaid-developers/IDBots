import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Electron CSP allows blob media previews', () => {
  const source = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('"media-src \'self\' blob:"'),
    'media-src must allow blob: so fetched metafile video/audio object URLs can play',
  );
});
