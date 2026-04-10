import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  resolveDelegationSettlement,
  buildDelegationOrderPayloadFromService,
} = require('../dist-electron/services/delegationSettlement.js');

test('resolveDelegationSettlement keeps BTC delegation payments on btc native transfer rails', () => {
  const settlement = resolveDelegationSettlement({
    rawPrice: '0.0001',
    rawCurrency: 'BTC',
    service: {
      currency: 'BTC',
      settlementKind: 'native',
      paymentChain: 'btc',
    },
  });

  assert.equal(settlement.price, '0.0001');
  assert.equal(settlement.paymentMode, 'native');
  assert.equal(settlement.paymentChain, 'btc');
  assert.equal(settlement.protocolCurrency, 'BTC');
  assert.equal(settlement.displayCurrency, 'BTC');
  assert.equal(settlement.settlementKind, 'native');
  assert.equal(settlement.mrc20Ticker, null);
  assert.equal(settlement.mrc20Id, null);
});

test('resolveDelegationSettlement maps MRC20 services to btc token transfer semantics', () => {
  const settlement = resolveDelegationSettlement({
    rawPrice: '12.5',
    rawCurrency: 'metaid-mrc20',
    service: {
      currency: 'METAID-MRC20',
      settlementKind: 'mrc20',
      paymentChain: 'btc',
      mrc20Ticker: 'metaid',
      mrc20Id: 'tick-metaid',
    },
  });

  assert.equal(settlement.price, '12.5');
  assert.equal(settlement.paymentMode, 'mrc20');
  assert.equal(settlement.paymentChain, 'btc');
  assert.equal(settlement.protocolCurrency, 'METAID-MRC20');
  assert.equal(settlement.displayCurrency, 'METAID-MRC20');
  assert.equal(settlement.settlementKind, 'mrc20');
  assert.equal(settlement.mrc20Ticker, 'METAID');
  assert.equal(settlement.mrc20Id, 'tick-metaid');
});

test('buildDelegationOrderPayloadFromService carries structured MRC20 settlement metadata into the remote order payload', () => {
  const { settlement, payload } = buildDelegationOrderPayloadFromService({
    rawRequest: '请帮我分析这条链上数据，并给出结论。',
    taskContext: '请帮我分析这条链上数据，并给出结论。',
    userTask: '请帮我分析这条链上数据，并给出结论。',
    serviceName: 'Indexer Credits',
    providerSkill: 'chain-analysis',
    servicePinId: 'service-mrc20',
    rawPrice: '12.5',
    rawCurrency: 'metaid-mrc20',
    paymentTxid: 'f'.repeat(64),
    paymentCommitTxid: 'c'.repeat(64),
    service: {
      currency: 'METAID-MRC20',
      settlementKind: 'mrc20',
      paymentChain: 'btc',
      mrc20Ticker: 'metaid',
      mrc20Id: 'tick-metaid',
    },
  });

  assert.equal(settlement.paymentMode, 'mrc20');
  assert.match(payload, /支付金额 12\.5 METAID-MRC20/);
  assert.match(payload, /payment chain:\s*btc/i);
  assert.match(payload, /settlement kind:\s*mrc20/i);
  assert.match(payload, /mrc20 ticker:\s*METAID/);
  assert.match(payload, /mrc20 id:\s*tick-metaid/i);
  assert.match(payload, new RegExp(`commit txid:\\s*${'c'.repeat(64)}`, 'i'));
});
