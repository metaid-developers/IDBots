import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildMyServiceSummaries,
  buildMyServiceOrderDetails,
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

test('buildMyServiceSummaries aggregates seller counts and revenue totals per owned service', () => {
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
  assert.equal(result.items[0].grossRevenue, '4.75');
  assert.equal(result.items[0].netIncome, '3.5');
  assert.equal(result.items[0].ratingAvg, 4.5);
  assert.equal(result.items[0].ratingCount, 2);
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
  assert.equal(result.items[0].rating?.raterGlobalMetaId, 'buyer-1');
});
