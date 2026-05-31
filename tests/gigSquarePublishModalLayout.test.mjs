import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/renderer/components/gigSquare/GigSquarePublishModal.tsx', import.meta.url),
  'utf8',
);

test('GigSquarePublishModal constrains the panel to the app viewport and scrolls the form body', () => {
  assert.match(source, /data-slot="gig-square-publish-panel"/);
  assert.match(source, /max-h-\[calc\(100svh-2rem\)\]/);
  assert.match(source, /flex-col/);
  assert.match(source, /overflow-hidden/);
  assert.match(source, /data-slot="gig-square-publish-scroll"/);
  assert.match(source, /overflow-y-auto/);
  assert.match(source, /data-slot="gig-square-publish-actions"/);
  assert.match(source, /shrink-0/);
});
