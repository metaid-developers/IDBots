import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(
  new URL('../src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx', import.meta.url),
  'utf8',
);

test('GigSquare modify service modal keeps header and actions fixed while the edit body scrolls', () => {
  assert.match(source, /data-slot="gig-square-modify-overlay"/);
  assert.match(source, /fixed inset-0 z-\[60\]/);
  assert.doesNotMatch(source, /data-slot="gig-square-modify-overlay"[\s\S]{0,160}absolute inset-0 z-20/);
  assert.match(source, /data-slot="gig-square-modify-panel"/);
  assert.match(source, /max-h-\[calc\(100svh-2rem\)\]/);
  assert.match(source, /flex-col/);
  assert.match(source, /overflow-hidden/);
  assert.match(source, /data-slot="gig-square-modify-header"/);
  assert.match(source, /data-slot="gig-square-modify-title-line"/);
  assert.match(source, /data-slot="gig-square-modify-scroll"/);
  assert.match(source, /min-h-0 flex-1 overflow-y-auto/);
  assert.match(source, /data-slot="gig-square-modify-actions"/);
  assert.match(source, /shrink-0/);
});
