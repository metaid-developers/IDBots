import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findGigSquareMrc20PaymentAsset,
  formatGigSquareMrc20PaymentBalance,
  getGigSquareMrc20PaymentReadiness,
} from '../src/renderer/components/gigSquare/gigSquareOrderPresentation.js';

const METAID_ASSET = {
  kind: 'mrc20',
  chain: 'btc',
  symbol: 'METAID',
  tokenName: 'MetaID Token',
  mrc20Id: 'metaid-token-id',
  address: 'bc1qbuyer',
  decimal: 8,
  balance: {
    confirmed: '2.50000000',
    unconfirmed: '0',
    pendingIn: '0',
    pendingOut: '0',
    display: '2.50000000',
  },
};

test('findGigSquareMrc20PaymentAsset matches by mrc20 id without relying on balance text', () => {
  assert.equal(
    findGigSquareMrc20PaymentAsset([METAID_ASSET], ' metaid-token-id '),
    METAID_ASSET,
  );
  assert.equal(findGigSquareMrc20PaymentAsset([METAID_ASSET], 'missing-token-id'), null);
});

test('formatGigSquareMrc20PaymentBalance shows token balance and symbol for confirmation UI', () => {
  assert.equal(
    formatGigSquareMrc20PaymentBalance(METAID_ASSET, false),
    '2.50000000 METAID',
  );
  assert.equal(formatGigSquareMrc20PaymentBalance(null, true), '...');
  assert.equal(formatGigSquareMrc20PaymentBalance(null, false), '—');
});

test('getGigSquareMrc20PaymentReadiness blocks missing token before payment execution', () => {
  const result = getGigSquareMrc20PaymentReadiness({
    asset: null,
    amount: '1.00000000',
    mrc20Id: 'metaid-token-id',
    paymentAddress: 'bc1qseller',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'missing_token',
  });
});

test('getGigSquareMrc20PaymentReadiness blocks insufficient token balance before payment execution', () => {
  const result = getGigSquareMrc20PaymentReadiness({
    asset: METAID_ASSET,
    amount: '3.00000000',
    mrc20Id: 'metaid-token-id',
    paymentAddress: 'bc1qseller',
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'insufficient_token_balance',
  });
});

test('getGigSquareMrc20PaymentReadiness allows covered MRC20 payments', () => {
  const result = getGigSquareMrc20PaymentReadiness({
    asset: METAID_ASSET,
    amount: '2.50000000',
    mrc20Id: 'metaid-token-id',
    paymentAddress: 'bc1qseller',
  });

  assert.deepEqual(result, {
    ok: true,
    reason: null,
  });
});
