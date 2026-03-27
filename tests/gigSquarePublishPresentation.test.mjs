import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  getGigSquarePublishCurrencyLabel,
  getGigSquarePublishPriceLimit,
  getGigSquarePublishPriceLimitText,
} from '../src/renderer/components/gigSquare/gigSquarePublishPresentation.js';

test('Gig Square publish currencies show SPACE instead of MVC in the publish form', () => {
  assert.deepEqual(
    GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
    [
      { label: 'BTC', value: 'BTC' },
      { label: 'SPACE', value: 'SPACE' },
      { label: 'DOGE', value: 'DOGE' },
    ],
  );
  assert.equal(getGigSquarePublishCurrencyLabel('SPACE'), 'SPACE');
});

test('Gig Square publish price limit text uses SPACE for the SPACE maximum amount', () => {
  assert.equal(getGigSquarePublishPriceLimit('SPACE'), 100000);
  assert.equal(getGigSquarePublishPriceLimitText('SPACE'), '100000 SPACE');
});
