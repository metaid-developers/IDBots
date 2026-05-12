import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveSellerOrderPaymentAmountRepair,
  resolveSellerOrderServiceMatch,
} from '../src/main/services/gigSquareMyServicesRepairService';

test('resolveSellerOrderServiceMatch prefers rating tx matches over heuristic candidates', () => {
  const match = resolveSellerOrderServiceMatch({
    order: {
      id: 'order-1',
      providerGlobalMetaId: 'seller-global',
      paymentTxid: 'paid-1',
      paymentAmount: '0.001',
      paymentCurrency: 'SPACE',
      createdAt: 1_770_000_000_000,
      serviceName: 'Service Order',
    },
    services: [
      {
        id: 'svc-post-buzz',
        providerGlobalMetaId: 'seller-global',
        providerSkill: 'metabot-post-buzz',
        serviceName: 'post-buzz-service',
        price: '0.001',
        currency: 'SPACE',
        updatedAt: 1_769_000_000_000,
      },
      {
        id: 'svc-weather',
        providerGlobalMetaId: 'seller-global',
        providerSkill: 'weather',
        serviceName: 'weather-service',
        price: '0.001',
        currency: 'SPACE',
        updatedAt: 1_769_500_000_000,
      },
    ],
    ratingServiceIdByTxid: new Map([['paid-1', 'svc-weather']]),
    orderText: '[ORDER] 用metabot-post-buzz技能处理',
  });

  assert.deepEqual(match, {
    serviceId: 'svc-weather',
    serviceName: 'weather-service',
    matchedBy: 'rating_txid',
  });
});

test('resolveSellerOrderServiceMatch falls back to skill plus price and prefers the nearest earlier service version', () => {
  const match = resolveSellerOrderServiceMatch({
    order: {
      id: 'order-2',
      providerGlobalMetaId: 'seller-global',
      paymentTxid: 'paid-2',
      paymentAmount: '0.0001',
      paymentCurrency: 'SPACE',
      createdAt: 1_770_000_000_000,
      serviceName: 'Service Order',
    },
    services: [
      {
        id: 'svc-weather-v1',
        providerGlobalMetaId: 'seller-global',
        providerSkill: 'weather',
        serviceName: 'weather-service',
        price: '0.0001',
        currency: 'SPACE',
        updatedAt: 1_768_000_000_000,
      },
      {
        id: 'svc-weather-v2',
        providerGlobalMetaId: 'seller-global',
        providerSkill: 'weather',
        serviceName: 'weather-service',
        price: '0.0001',
        currency: 'SPACE',
        updatedAt: 1_769_999_999_000,
      },
      {
        id: 'svc-weather-btc',
        providerGlobalMetaId: 'seller-global',
        providerSkill: 'weather',
        serviceName: 'weather-service',
        price: '0.0001',
        currency: 'BTC',
        updatedAt: 1_769_999_999_500,
      },
    ],
    ratingServiceIdByTxid: new Map(),
    orderText: '[ORDER] 帮我查一下香港天气，用weather技能处理。',
  });

  assert.deepEqual(match, {
    serviceId: 'svc-weather-v2',
    serviceName: 'weather-service',
    matchedBy: 'skill_price_time',
  });
});

test('resolveSellerOrderPaymentAmountRepair restores seller amount from order message metadata', () => {
  const paymentTxid = '0db14a224bb14ac0687c0f96dc4b24e045d675750ab145d77e2a729c11157730';
  const repair = resolveSellerOrderPaymentAmountRepair({
    order: {
      id: 'seller-weather-order',
      paymentTxid,
      paymentAmount: '3.8789796',
      paymentCurrency: 'SPACE',
    },
    orderText: `[ORDER] 帮我用 weather 技能查一下天气，已经转了你 0.0001 SPACE，交易 ID 是 ${paymentTxid}。具体想查的是 “北京天气如何”。

支付金额 0.0001 SPACE
txid: ${paymentTxid}
service id: e5121555fd87634383bf9b90c87c7fbe44d207f57a6ef0acbdbd9b14eb8ab5edi0
skill name: weather`,
  });

  assert.deepEqual(repair, {
    paymentAmount: '0.0001',
    paymentCurrency: 'SPACE',
  });
});

test('resolveSellerOrderPaymentAmountRepair ignores order text for a different payment txid', () => {
  const repair = resolveSellerOrderPaymentAmountRepair({
    order: {
      id: 'seller-weather-order',
      paymentTxid: '0'.repeat(64),
      paymentAmount: '3.8789796',
      paymentCurrency: 'SPACE',
    },
    orderText: `[ORDER] 支付金额 0.0001 SPACE
txid: ${'1'.repeat(64)}
service id: e5121555fd87634383bf9b90c87c7fbe44d207f57a6ef0acbdbd9b14eb8ab5edi0`,
  });

  assert.equal(repair, null);
});
