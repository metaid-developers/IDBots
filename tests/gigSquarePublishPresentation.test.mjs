import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  getGigSquareMrc20SelectPlaceholder,
  getGigSquareSettlementGridClassName,
  getGigSquarePublishPriceLimit,
  getNextGigSquareSelectedMrc20Id,
  getSelectableGigSquareModifyMrc20Assets,
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

test('getNextGigSquareSelectedMrc20Id clears a stale MRC20 selection', () => {
  const assets = [
    { symbol: 'METAID', mrc20Id: 'metaid-id', balance: { display: '1.25000000' } },
  ];

  assert.equal(getNextGigSquareSelectedMrc20Id(assets, 'metaid-id'), 'metaid-id');
  assert.equal(getNextGigSquareSelectedMrc20Id(assets, 'stale-id'), '');
});

test('getSelectableGigSquareModifyMrc20Assets preserves the current service token when balance is no longer positive', () => {
  const list = getSelectableGigSquareModifyMrc20Assets([
    { symbol: 'ZERO', mrc20Id: 'zero-id', balance: { display: '0.00000000' } },
    { symbol: 'METAID', mrc20Id: 'metaid-id', balance: { display: '1.25000000' } },
  ], {
    mrc20Ticker: 'LEGACY',
    mrc20Id: 'legacy-id',
  });

  assert.deepEqual(
    list.map((item) => item.mrc20Id),
    ['legacy-id', 'metaid-id'],
  );
  assert.equal(list[0].balance.display, '0');
});

test('getGigSquareSettlementGridClassName expands to a third desktop column for MRC20 settlement', () => {
  assert.equal(
    getGigSquareSettlementGridClassName('BTC'),
    'grid grid-cols-1 gap-4 md:grid-cols-2',
  );
  assert.equal(
    getGigSquareSettlementGridClassName('MRC20'),
    'grid grid-cols-1 gap-4 md:grid-cols-3',
  );
});

test('getGigSquareMrc20SelectPlaceholder keeps the empty-state label compact', () => {
  assert.equal(getGigSquareMrc20SelectPlaceholder([]), 'No Token');
  assert.equal(
    getGigSquareMrc20SelectPlaceholder([{ symbol: 'METAID', mrc20Id: 'metaid-id', balance: { display: '1.25000000' } }]),
    'Select token',
  );
});
