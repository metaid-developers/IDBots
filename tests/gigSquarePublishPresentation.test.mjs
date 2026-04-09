import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  getGigSquarePublishPriceLimit,
  getSelectableGigSquareMrc20Assets,
} from '../src/renderer/components/gigSquare/gigSquarePublishPresentation.js';

test('publish currency options include MRC20', () => {
  assert.deepEqual(
    GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.map((item) => item.value),
    ['BTC', 'SPACE', 'DOGE', 'MRC20'],
  );
});

test('getSelectableGigSquareMrc20Assets keeps only positive balances', () => {
  const list = getSelectableGigSquareMrc20Assets([
    { symbol: 'ZERO', mrc20Id: 'zero-id', balance: { display: '0.00000000' } },
    { symbol: 'METAID', mrc20Id: 'metaid-id', balance: { display: '1.25000000' } },
  ]);

  assert.deepEqual(list.map((item) => item.symbol), ['METAID']);
  assert.equal(getGigSquarePublishPriceLimit('MRC20'), null);
});
