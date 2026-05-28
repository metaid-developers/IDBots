import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviderSkillList,
  getLegacyProviderSkillFallback,
  getPrimaryProviderSkill,
  normalizeProtocolSettlementKind,
  normalizeSkillServiceCurrency,
  resolveSkillServicePaymentTerms,
  buildSkillServiceOrderPayload,
} from '../src/main/shared/skillServiceProtocol.js';

test('normalizes legacy providerSkill string to a one-item allow-list', () => {
  assert.deepEqual(normalizeProviderSkillList('weather'), ['weather']);
});

test('normalizes v1.1 providerSkill arrays without order semantics', () => {
  assert.deepEqual(
    normalizeProviderSkillList(['weather', ' reporter ', '', 'weather', '  ']),
    ['weather', 'reporter'],
  );
});

test('returns a legacy single providerSkill fallback without adding execution order semantics', () => {
  assert.equal(getLegacyProviderSkillFallback(['', ' weather ', 'reporter']), 'weather');
  assert.equal(getLegacyProviderSkillFallback([]), '');
  assert.equal(getLegacyProviderSkillFallback(null), '');
  assert.equal(getPrimaryProviderSkill(['', ' weather ', 'reporter']), 'weather');
  assert.equal(getPrimaryProviderSkill([]), '');
  assert.equal(getPrimaryProviderSkill(null), '');
});

test('v1.0 positive price defaults to prepaid', () => {
  assert.deepEqual(resolveSkillServicePaymentTerms({ price: '0.1', currency: 'MVC' }), {
    paymentTiming: 'prepaid',
    effectivePrice: '0.1',
    currency: 'SPACE',
    protocolSettlementKind: 'native',
    isFree: false,
  });
});

test('v1.0 zero, missing, or invalid price defaults to free', () => {
  assert.equal(resolveSkillServicePaymentTerms({ price: '0' }).paymentTiming, 'free');
  assert.equal(resolveSkillServicePaymentTerms({}).paymentTiming, 'free');
  assert.equal(resolveSkillServicePaymentTerms({ price: 'not-a-number' }).paymentTiming, 'free');
});

test('rejects non-canonical numeric price forms as free compatibility semantics', () => {
  for (const price of ['0x10', '1e-8', '1e309', '+1', '-1', 'Infinity', 'NaN', '   ', {}]) {
    assert.deepEqual(resolveSkillServicePaymentTerms({ price }), {
      paymentTiming: 'free',
      effectivePrice: '0',
      currency: 'SPACE',
      protocolSettlementKind: 'native',
      isFree: true,
    });
  }
});

test('accepts trimmed plain positive decimal price strings without JS Number coercion', () => {
  assert.deepEqual(resolveSkillServicePaymentTerms({ price: ' 1.25 ' }), {
    paymentTiming: 'prepaid',
    effectivePrice: '1.25',
    currency: 'SPACE',
    protocolSettlementKind: 'native',
    isFree: false,
  });

  assert.deepEqual(resolveSkillServicePaymentTerms({
    price: '0.000000000000000001',
    currency: 'dogecoin',
  }), {
    paymentTiming: 'prepaid',
    effectivePrice: '0.000000000000000001',
    currency: 'DOGE',
    protocolSettlementKind: 'native',
    isFree: false,
  });
});

test('normalizes protocol currency aliases', () => {
  assert.equal(normalizeSkillServiceCurrency(), 'SPACE');
  assert.equal(normalizeSkillServiceCurrency('MVC'), 'SPACE');
  assert.equal(normalizeSkillServiceCurrency(' MICROVISIONCHAIN '), 'SPACE');
  assert.equal(normalizeSkillServiceCurrency('bitcoin'), 'BTC');
  assert.equal(normalizeSkillServiceCurrency(' dogecoin '), 'DOGE');
  assert.equal(normalizeSkillServiceCurrency('usdt'), 'USDT');
});

test('missing or unknown protocol settlement kind defaults to native', () => {
  assert.equal(normalizeProtocolSettlementKind(), 'native');
  assert.equal(normalizeProtocolSettlementKind(''), 'native');
  assert.equal(normalizeProtocolSettlementKind('mrc20'), 'native');
  assert.equal(normalizeProtocolSettlementKind(' FIAT '), 'fiat');
});

test('conflicting payment fields choose free and lowest amount semantics', () => {
  assert.deepEqual(resolveSkillServicePaymentTerms({
    paymentTiming: 'free',
    price: '99',
    currency: 'SPACE',
    settlementKind: 'fiat',
  }), {
    paymentTiming: 'free',
    effectivePrice: '0',
    currency: 'SPACE',
    protocolSettlementKind: 'fiat',
    isFree: true,
  });

  assert.deepEqual(resolveSkillServicePaymentTerms({
    paymentTiming: 'prepaid',
    price: '0',
    currency: 'SPACE',
  }), {
    paymentTiming: 'free',
    effectivePrice: '0',
    currency: 'SPACE',
    protocolSettlementKind: 'native',
    isFree: true,
  });

  assert.equal(resolveSkillServicePaymentTerms({
    paymentTiming: 'postpaid',
    price: '0',
  }).paymentTiming, 'free');
});

test('builds minimal skill-service-order payload without self-declared chain facts', () => {
  const payload = buildSkillServiceOrderPayload({
    servicePinId: 'service-pin-i0',
    paymentTxid: '',
    price: '0',
    currency: 'MVC',
    settlementKind: 'native',
    metadata: null,
    orderId: 'do-not-copy',
    createdAt: '2026-05-28T00:00:00.000Z',
    updatedAt: '2026-05-28T00:00:00.000Z',
    status: 'pending',
    buyer: { globalMetaId: 'buyer' },
    provider: { globalMetaId: 'provider' },
    skill: { providerSkill: 'weather' },
    version: '1.1.0',
  });

  assert.deepEqual(payload, {
    servicePinId: 'service-pin-i0',
    paymentTxid: '',
    price: '0',
    currency: 'SPACE',
    settlementKind: 'native',
    metadata: '',
  });
  assert.deepEqual(Object.keys(payload), [
    'servicePinId',
    'paymentTxid',
    'price',
    'currency',
    'settlementKind',
    'metadata',
  ]);
});
