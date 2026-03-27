import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildMyServiceSummaries,
  buildMyServiceOrderDetails,
  clampPageSize,
} = require('../dist-electron/services/gigSquareMyServicesService.js');

test('buildMyServiceSummaries filters services by owned globalmetaids and paginates 8 rows', () => {
  const services = Array.from({ length: 9 }, (_, index) => ({
    id: `svc-${index}`,
    providerGlobalMetaId: 'owned-global',
    updatedAt: 100 - index,
  }));
  const page = buildMyServiceSummaries({
    ownedGlobalMetaIds: new Set(['owned-global']),
    services,
    sellerOrders: [],
    page: 1,
    pageSize: 8,
  });

  assert.equal(page.items.length, 8);
  assert.equal(page.total, 9);
});

test('buildMyServiceOrderDetails only returns completed and refunded seller orders', () => {
  const result = buildMyServiceOrderDetails({
    serviceId: 'svc-1',
    sellerOrders: [
      { id: '1', servicePinId: 'svc-1', status: 'completed' },
      { id: '2', servicePinId: 'svc-1', status: 'refunded' },
      { id: '3', servicePinId: 'svc-1', status: 'in_progress' },
    ],
    ratingsByPaymentTxid: new Map(),
    page: 1,
    pageSize: 10,
  });

  assert.deepEqual(result.items.map((item) => item.id), ['2', '1']);
});

test('buildMyServiceSummaries aggregates seller counts and revenue totals per owned service price instead of raw order payment amounts', () => {
  const result = buildMyServiceSummaries({
    ownedGlobalMetaIds: new Set(['owned-global']),
    services: [{
      id: 'svc-1',
      displayName: 'Service 1',
      serviceName: 'service-1',
      description: 'desc',
      price: '10',
      currency: 'SPACE',
      providerMetaId: 'meta-1',
      providerGlobalMetaId: 'owned-global',
      providerAddress: 'addr-1',
      providerSkill: 'skill-1',
      ratingAvg: 4.5,
      ratingCount: 2,
      updatedAt: 123,
    }],
    sellerOrders: [
      { id: 'done-1', servicePinId: 'svc-1', status: 'completed', paymentAmount: '3.5' },
      { id: 'refund-1', servicePinId: 'svc-1', status: 'refunded', paymentAmount: '1.25' },
      { id: 'open-1', servicePinId: 'svc-1', status: 'in_progress', paymentAmount: '99' },
    ],
    page: 1,
    pageSize: 8,
  });

  assert.equal(result.items[0].successCount, 1);
  assert.equal(result.items[0].refundCount, 1);
  assert.equal(result.items[0].grossRevenue, '10');
  assert.equal(result.items[0].netIncome, '10');
  assert.equal(result.items[0].ratingAvg, 4.5);
  assert.equal(result.items[0].ratingCount, 2);
});

test('buildMyServiceSummaries ignores anomalous seller payment amounts when computing revenue', () => {
  const result = buildMyServiceSummaries({
    ownedGlobalMetaIds: new Set(['owned-global']),
    services: [{
      id: 'svc-weather',
      displayName: 'Weather',
      serviceName: 'weather-service',
      description: 'desc',
      price: '0.0001',
      currency: 'SPACE',
      providerMetaId: 'meta-1',
      providerGlobalMetaId: 'owned-global',
      providerAddress: 'addr-1',
      updatedAt: 123,
    }],
    sellerOrders: [
      { id: 'done-1', servicePinId: 'svc-weather', status: 'completed', paymentAmount: '3.8794796' },
    ],
    page: 1,
    pageSize: 8,
  });

  assert.equal(result.items[0].grossRevenue, '0.0001');
  assert.equal(result.items[0].netIncome, '0.0001');
});

test('buildMyServiceSummaries uses current pin for metrics and preserves creator/action metadata', () => {
  const result = buildMyServiceSummaries({
    ownedGlobalMetaIds: new Set(['owned-global']),
    services: [{
      id: 'svc-m2',
      currentPinId: 'svc-m2',
      sourceServicePinId: 'svc-root',
      displayName: 'Weather V2',
      serviceName: 'weather-service',
      description: 'desc',
      price: '2',
      currency: 'SPACE',
      providerMetaId: 'meta-1',
      providerGlobalMetaId: 'owned-global',
      providerAddress: 'addr-1',
      creatorMetabotId: 7,
      creatorMetabotName: 'Caster Bot',
      creatorMetabotAvatar: 'avatar://caster',
      canModify: true,
      canRevoke: true,
      blockedReason: null,
      updatedAt: 123,
    }],
    sellerOrders: [
      { id: 'old-order', servicePinId: 'svc-root', status: 'completed', paymentAmount: '99' },
      { id: 'current-order', servicePinId: 'svc-m2', status: 'completed', paymentAmount: '1' },
    ],
    page: 1,
    pageSize: 8,
  });

  assert.equal(result.items[0].id, 'svc-m2');
  assert.equal(result.items[0].currentPinId, 'svc-m2');
  assert.equal(result.items[0].sourceServicePinId, 'svc-root');
  assert.equal(result.items[0].successCount, 1);
  assert.equal(result.items[0].grossRevenue, '2');
  assert.equal(result.items[0].creatorMetabotId, 7);
  assert.equal(result.items[0].creatorMetabotName, 'Caster Bot');
  assert.equal(result.items[0].creatorMetabotAvatar, 'avatar://caster');
  assert.equal(result.items[0].canModify, true);
  assert.equal(result.items[0].canRevoke, true);
  assert.equal(result.items[0].blockedReason, null);
});

test('buildMyServiceOrderDetails joins rating detail by payment txid', () => {
  const result = buildMyServiceOrderDetails({
    serviceId: 'svc-1',
    sellerOrders: [
      {
        id: 'order-1',
        servicePinId: 'svc-1',
        status: 'completed',
        paymentTxid: 'paid-1',
        paymentAmount: '2.5',
        paymentCurrency: 'SPACE',
        counterpartyGlobalMetaid: 'buyer-1',
      },
    ],
    ratingsByPaymentTxid: new Map([
      ['paid-1', {
        pinId: `${'b'.repeat(64)}i0`,
        servicePaidTx: 'paid-1',
        rate: 5,
        comment: 'Excellent',
        raterGlobalMetaId: 'buyer-1',
        raterMetaId: 'meta-buyer-1',
        createdAt: 999,
      }],
    ]),
    page: 1,
    pageSize: 10,
  });

  assert.equal(result.items[0].rating?.rate, 5);
  assert.equal(result.items[0].rating?.comment, 'Excellent');
  assert.equal(result.items[0].rating?.pinId, `${'b'.repeat(64)}i0`);
  assert.equal(result.items[0].rating?.raterGlobalMetaId, 'buyer-1');
});

test('buildMyServiceOrderDetails prefers rating with matching buyer identity over newer mismatched tx match', () => {
  const result = buildMyServiceOrderDetails({
    serviceId: 'svc-1',
    sellerOrders: [
      {
        id: 'order-1',
        servicePinId: 'svc-1',
        status: 'completed',
        paymentTxid: 'paid-1',
        paymentAmount: '2.5',
        paymentCurrency: 'SPACE',
        counterpartyGlobalMetaid: 'buyer-1',
      },
    ],
    ratingsByPaymentTxid: new Map([
      ['paid-1', [
        {
          servicePaidTx: 'paid-1',
          rate: 1,
          comment: 'Wrong buyer but newer',
          raterGlobalMetaId: 'buyer-other',
          raterMetaId: 'meta-other',
          createdAt: 2_000,
        },
        {
          servicePaidTx: 'paid-1',
          rate: 5,
          comment: 'Correct buyer',
          raterGlobalMetaId: 'buyer-1',
          raterMetaId: 'meta-buyer-1',
          createdAt: 1_000,
        },
      ]],
    ]),
    page: 1,
    pageSize: 10,
  });

  assert.equal(result.items[0].rating?.rate, 5);
  assert.equal(result.items[0].rating?.comment, 'Correct buyer');
  assert.equal(result.items[0].rating?.raterGlobalMetaId, 'buyer-1');
});

test('clampPageSize caps requested page size at product maximum', () => {
  assert.equal(clampPageSize(99, 8), 8);
  assert.equal(clampPageSize(99, 10), 10);
  assert.equal(clampPageSize(0, 8), 8);
});
