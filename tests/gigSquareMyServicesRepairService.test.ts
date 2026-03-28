import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveSellerOrderServiceMatch } from '../src/main/services/gigSquareMyServicesRepairService';

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
