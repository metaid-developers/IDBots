import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS,
  GIG_SQUARE_PAYMENT_TIMING_OPTIONS,
  buildGigSquarePaymentTermsSubmission,
  getDefaultGigSquarePaymentTiming,
  shouldShowGigSquarePaymentAmountControls,
  validateGigSquarePaymentTermsDraft,
} from '../src/renderer/components/gigSquare/gigSquarePublishPresentation.js';

test('new service payment timing defaults to free', () => {
  assert.equal(getDefaultGigSquarePaymentTiming(), 'free');
});

test('publish and modify forms only expose native prepaid currencies', () => {
  assert.deepEqual(
    GIG_SQUARE_PUBLISH_CURRENCY_OPTIONS.map((option) => option.value),
    ['BTC', 'SPACE', 'DOGE'],
  );
  assert.deepEqual(
    GIG_SQUARE_PAYMENT_TIMING_OPTIONS.map((option) => option.value),
    ['free', 'prepaid'],
  );
});

test('free mode hides amount controls and serializes zero native SPACE payment terms', () => {
  assert.equal(shouldShowGigSquarePaymentAmountControls('free'), false);
  assert.deepEqual(
    buildGigSquarePaymentTermsSubmission({
      paymentTiming: 'free',
      price: '123.45',
      currency: 'BTC',
    }),
    {
      paymentTiming: 'free',
      price: '0',
      currency: 'SPACE',
      protocolSettlementKind: 'native',
      metadata: '',
    },
  );
});

test('prepaid mode shows amount controls and serializes positive native amount', () => {
  assert.equal(shouldShowGigSquarePaymentAmountControls('prepaid'), true);
  assert.deepEqual(
    validateGigSquarePaymentTermsDraft({
      paymentTiming: 'prepaid',
      price: '0.01',
      currency: 'BTC',
    }),
    null,
  );
  assert.deepEqual(
    buildGigSquarePaymentTermsSubmission({
      paymentTiming: 'prepaid',
      price: '0.01',
      currency: 'BTC',
    }),
    {
      paymentTiming: 'prepaid',
      price: '0.01',
      currency: 'BTC',
      protocolSettlementKind: 'native',
      metadata: '',
    },
  );
});

test('prepaid validation requires a positive amount and native currency', () => {
  assert.equal(
    validateGigSquarePaymentTermsDraft({
      paymentTiming: 'prepaid',
      price: '0',
      currency: 'BTC',
    })?.code,
    'price_invalid',
  );
  assert.equal(
    validateGigSquarePaymentTermsDraft({
      paymentTiming: 'prepaid',
      price: '1',
      currency: 'MRC20',
    })?.code,
    'currency_invalid',
  );
});
