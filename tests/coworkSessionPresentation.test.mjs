import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getCoworkSessionTitleClassName,
  shouldShowCoworkA2ADot,
} from '../src/renderer/components/cowork/coworkSessionPresentation.js';

test('Cowork session list no longer shows a blue dot for A2A sessions', () => {
  assert.equal(shouldShowCoworkA2ADot({ sessionType: 'a2a', showStatusIndicator: false }), false);
  assert.equal(shouldShowCoworkA2ADot({ sessionType: 'a2a', showStatusIndicator: true }), false);
});

test('Cowork session title keeps A2A accent color without requiring the blue dot', () => {
  assert.match(getCoworkSessionTitleClassName('a2a'), /text-blue-500/);
  assert.doesNotMatch(getCoworkSessionTitleClassName('standard'), /text-blue-500/);
});
