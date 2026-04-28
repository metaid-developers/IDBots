import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('Electron CSP allows accelerated and fallback media previews', () => {
  const source = fs.readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8');
  assert.ok(
    source.includes('"media-src \'self\' blob: https://file.metaid.io https://metafs.oss-cn-beijing.aliyuncs.com"'),
    'media-src must allow accelerated metafile URLs, OSS redirects, and blob fallbacks',
  );
});
