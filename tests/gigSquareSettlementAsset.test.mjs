import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  normalizeGigSquareSettlementDraft,
  parseGigSquareSettlementAsset,
} = require('../dist-electron/shared/gigSquareSettlementAsset.js');

test('normalizeGigSquareSettlementDraft serializes MRC20 as <TICKER>-MRC20', () => {
  const asset = normalizeGigSquareSettlementDraft({
    currency: 'MRC20',
    mrc20Ticker: 'metaid',
    mrc20Id: 'tick-metaid',
  });

  assert.equal(asset.protocolCurrency, 'METAID-MRC20');
  assert.equal(asset.settlementKind, 'mrc20');
  assert.equal(asset.paymentChain, 'btc');
  assert.equal(asset.mrc20Ticker, 'METAID');
  assert.equal(asset.mrc20Id, 'tick-metaid');
});

test('parseGigSquareSettlementAsset parses protocol currency and structured MRC20 fields', () => {
  const asset = parseGigSquareSettlementAsset({
    currency: 'metaid-mrc20',
    settlementKind: 'mrc20',
    paymentChain: 'btc',
    mrc20Ticker: 'metaid',
    mrc20Id: 'tick-metaid',
  });

  assert.equal(asset.protocolCurrency, 'METAID-MRC20');
  assert.equal(asset.settlementKind, 'mrc20');
  assert.equal(asset.paymentChain, 'btc');
  assert.equal(asset.mrc20Ticker, 'METAID');
  assert.equal(asset.mrc20Id, 'tick-metaid');
});

test('parseGigSquareSettlementAsset preserves native SPACE as the protocol currency', () => {
  const asset = parseGigSquareSettlementAsset({
    currency: 'space',
  });

  assert.equal(asset.settlementKind, 'native');
  assert.equal(asset.selectorCurrency, 'SPACE');
  assert.equal(asset.protocolCurrency, 'SPACE');
  assert.equal(asset.paymentChain, 'mvc');
});

test('parseGigSquareSettlementAsset normalizes legacy MVC currency alias to SPACE', () => {
  const asset = parseGigSquareSettlementAsset({
    currency: 'MVC',
    paymentChain: 'btc',
  });

  assert.equal(asset.settlementKind, 'native');
  assert.equal(asset.selectorCurrency, 'SPACE');
  assert.equal(asset.protocolCurrency, 'SPACE');
  assert.equal(asset.paymentChain, 'mvc');
});

test('parseGigSquareSettlementAsset does not let mrc20 settlementKind override native currency', () => {
  const asset = parseGigSquareSettlementAsset({
    currency: 'MVC',
    settlementKind: 'mrc20',
    mrc20Ticker: 'METAID',
    mrc20Id: 'tick-metaid',
  });

  assert.equal(asset.settlementKind, 'native');
  assert.equal(asset.selectorCurrency, 'SPACE');
  assert.equal(asset.protocolCurrency, 'SPACE');
  assert.equal(asset.paymentChain, 'mvc');
  assert.equal(asset.mrc20Ticker, null);
  assert.equal(asset.mrc20Id, null);
});

test('parseGigSquareSettlementAsset forces MRC20 paymentChain to btc', () => {
  const asset = parseGigSquareSettlementAsset({
    currency: 'metaid-mrc20',
    settlementKind: 'mrc20',
    paymentChain: 'doge',
    mrc20Ticker: 'metaid',
    mrc20Id: 'tick-metaid',
  });

  assert.equal(asset.settlementKind, 'mrc20');
  assert.equal(asset.protocolCurrency, 'METAID-MRC20');
  assert.equal(asset.paymentChain, 'btc');
  assert.equal(asset.mrc20Ticker, 'METAID');
  assert.equal(asset.mrc20Id, 'tick-metaid');
});

test('normalizeGigSquareSettlementDraft rejects invalid MRC20 ticker formats', () => {
  assert.throws(
    () => normalizeGigSquareSettlementDraft({
      currency: 'MRC20',
      mrc20Ticker: 'meta-id',
      mrc20Id: 'tick-metaid',
    }),
    /MRC20 ticker is invalid/,
  );
});

test('normalizeGigSquareSettlementDraft keeps native SPACE as currency and mvc as payment chain', () => {
  const asset = normalizeGigSquareSettlementDraft({
    currency: 'space',
  });

  assert.equal(asset.selectorCurrency, 'SPACE');
  assert.equal(asset.protocolCurrency, 'SPACE');
  assert.equal(asset.settlementKind, 'native');
  assert.equal(asset.paymentChain, 'mvc');
  assert.equal(asset.mrc20Ticker, null);
  assert.equal(asset.mrc20Id, null);
});

test('normalizeGigSquareSettlementDraft normalizes Bitcoin network label to BTC currency', () => {
  const asset = normalizeGigSquareSettlementDraft({
    currency: 'Bitcoin',
  });

  assert.equal(asset.selectorCurrency, 'BTC');
  assert.equal(asset.protocolCurrency, 'BTC');
  assert.equal(asset.settlementKind, 'native');
  assert.equal(asset.paymentChain, 'btc');
});
