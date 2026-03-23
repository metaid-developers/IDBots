import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeReleaseAssetLabel } from '../scripts/release-asset-label.cjs';

test('computeReleaseAssetLabel strips leading v from tag names', () => {
  assert.equal(computeReleaseAssetLabel({ refName: 'v0.1.98' }), '0.1.98');
});

test('computeReleaseAssetLabel sanitizes slash-containing branch names for file outputs', () => {
  assert.equal(
    computeReleaseAssetLabel({ refName: 'codex/idbots-alpha-local-first' }),
    'codex-idbots-alpha-local-first',
  );
});

test('computeReleaseAssetLabel preserves safe dots and dashes while removing unsafe characters', () => {
  assert.equal(
    computeReleaseAssetLabel({ refName: 'release candidate/v0.1.98+build' }),
    'release-candidate-v0.1.98-build',
  );
});
