import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getCardVisual,
  resolveImageUrl,
  stripImageProcessParam,
} from '../src/renderer/components/metaapps/myApps/myAppsPresentation.js';

const PIN = `${'a'.repeat(64)}i0`;
const ACCEL = 'https://file.metaid.io/metafile-indexer/api/v1/files/accelerate/content/';

test('resolveImageUrl appends the requested process variant to pin URLs', () => {
  assert.equal(resolveImageUrl(PIN, 'preview'), `${ACCEL}${PIN}?process=preview`);
  assert.equal(resolveImageUrl(`metafile://${PIN}.png`, 'thumbnail'), `${ACCEL}${PIN}?process=thumbnail`);
});

test('resolveImageUrl without a process arg keeps the unprocessed URL', () => {
  assert.equal(resolveImageUrl(PIN), `${ACCEL}${PIN}`);
  assert.equal(resolveImageUrl(`metafile://${PIN}`), `${ACCEL}${PIN}`);
});

test('resolveImageUrl never appends a process variant for svg references', () => {
  assert.equal(resolveImageUrl(`metafile://${PIN}.svg`, 'thumbnail'), `${ACCEL}${PIN}`);
  assert.equal(resolveImageUrl(`metafile://${PIN}.SVG`, 'preview'), `${ACCEL}${PIN}`);
});

test('resolveImageUrl passes http(s) and data references through unchanged', () => {
  assert.equal(resolveImageUrl('https://example.com/a.png', 'preview'), 'https://example.com/a.png');
  assert.equal(resolveImageUrl('data:image/png;base64,AA==', 'thumbnail'), 'data:image/png;base64,AA==');
  assert.equal(resolveImageUrl('', 'preview'), null);
  assert.equal(resolveImageUrl('not-a-pin', 'preview'), null);
});

test('getCardVisual uses preview for covers and thumbnail for icons', () => {
  const visual = getCardVisual({ coverImg: `metafile://${PIN}.webp`, icon: `metafile://${PIN}.png` });
  assert.equal(visual.cover, `${ACCEL}${PIN}?process=preview`);
  assert.equal(visual.icon, `${ACCEL}${PIN}?process=thumbnail`);
});

test('stripImageProcessParam removes the process query param', () => {
  const url = `${ACCEL}${PIN}?process=preview`;
  assert.equal(stripImageProcessParam(url), `${ACCEL}${PIN}`);
  assert.equal(stripImageProcessParam(`${url}&x=1`), `${ACCEL}${PIN}?x=1`);
  assert.equal(stripImageProcessParam(`${ACCEL}${PIN}?x=1&process=thumbnail`), `${ACCEL}${PIN}?x=1`);
  assert.equal(stripImageProcessParam(`${url}#frag`), `${ACCEL}${PIN}#frag`);
});

test('stripImageProcessParam returns null when there is no process param', () => {
  assert.equal(stripImageProcessParam(`${ACCEL}${PIN}`), null);
  assert.equal(stripImageProcessParam(`${ACCEL}${PIN}?x=1`), null);
  assert.equal(stripImageProcessParam(''), null);
});
