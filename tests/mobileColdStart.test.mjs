import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('mobile shell renders without awaiting the remote settings read', () => {
  const source = fs.readFileSync(new URL('../src/mobile/app/bootstrap.tsx', import.meta.url), 'utf8');
  assert.match(source, /void loadSettings\(\)/);
  assert.doesNotMatch(source, /await loadSettings\(\)/);
  assert.ok(source.indexOf('ReactDOM.createRoot') < source.indexOf("document.getElementById('idbots-launch-splash')"));
});

test('app entry applies the mirrored theme before the first paint', () => {
  const source = fs.readFileSync(new URL('../src/mobile/app/index.html', import.meta.url), 'utf8');
  assert.match(source, /idbots\.mobile\.app_config\.theme\.v1/);
  assert.match(source, /classList\.toggle\('dark', dark\)/);
});
