import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let GigSquareRefundsService;

test.before(async () => {
  ({ GigSquareRefundsService } = require('../dist-electron/services/gigSquareRefundsService.js'));
});

function createOrder(overrides = {}) {
  return {
    id: 'order-1',
    role: 'seller',
    localMetabotId: 7,
    counterpartyGlobalMetaid: 'counterparty-global-1',
    servicePinId: 'svc-1',
    serviceName: 'Weather',
    paymentTxid: '1'.repeat(64),
    paymentAmount: '1.5',
    paymentCurrency: 'SPACE',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-1',
    refundTxid: null,
    refundRequestedAt: 1_770_100_000_000,
    refundCompletedAt: null,
    coworkSessionId: null,
    createdAt: 1_770_099_000_000,
    updatedAt: 1_770_100_000_000,
    ...overrides,
  };
}

function createService(overrides = {}) {
  return new GigSquareRefundsService({
    listSellerRefundOrders: () => [],
    listBuyerRefundOrders: () => [],
    resolveCounterpartyInfo: async () => null,
    resolveCoworkSessionIdForOrder: () => null,
    processSellerRefundForOrderId: async () => {
      throw new Error('not configured');
    },
    ...overrides,
  });
}

test('listRefunds groups seller and buyer refund rows and counts seller pending items', async () => {
  const service = createService({
    listSellerRefundOrders: () => [
      createOrder({
        id: 'seller-pending',
        counterpartyGlobalMetaid: 'buyer-global-1',
        servicePinId: 'svc-1',
        serviceName: 'Weather',
        paymentTxid: '1'.repeat(64),
        paymentAmount: '1.5',
        paymentCurrency: 'SPACE',
        status: 'refund_pending',
        failureReason: 'delivery_timeout',
        refundRequestPinId: 'refund-pin-1',
        refundRequestedAt: 1_770_100_000_000,
        coworkSessionId: null,
      }),
      createOrder({
        id: 'seller-refunded',
        counterpartyGlobalMetaid: 'buyer-global-2',
        servicePinId: 'svc-2',
        serviceName: 'Research',
        paymentTxid: '2'.repeat(64),
        paymentAmount: '2.0',
        paymentCurrency: 'SPACE',
        status: 'refunded',
        failureReason: 'first_response_timeout',
        refundRequestPinId: 'refund-pin-2',
        refundTxid: 'b'.repeat(64),
        refundRequestedAt: 1_770_090_000_000,
        refundCompletedAt: 1_770_091_000_000,
        coworkSessionId: 'session-known',
        createdAt: 1_770_089_000_000,
        updatedAt: 1_770_091_000_000,
      }),
      createOrder({
        id: 'seller-pending-missing-pin',
        counterpartyGlobalMetaid: 'buyer-global-3',
        refundRequestPinId: null,
        refundRequestedAt: 1_770_101_000_000,
        createdAt: 1_770_100_500_000,
        updatedAt: 1_770_101_000_000,
      }),
      createOrder({
        id: 'seller-completed',
        status: 'completed',
        refundRequestPinId: null,
        refundRequestedAt: null,
        failureReason: null,
        createdAt: 1_770_070_000_000,
        updatedAt: 1_770_070_000_000,
      }),
    ],
    listBuyerRefundOrders: () => [
      createOrder({
        id: 'buyer-pending',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-1',
        servicePinId: 'svc-3',
        serviceName: 'Translate',
        paymentTxid: '3'.repeat(64),
        paymentAmount: '0.4',
        paymentCurrency: 'DOGE',
        status: 'refund_pending',
        failureReason: 'delivery_timeout',
        refundRequestPinId: 'refund-pin-3',
        refundRequestedAt: 1_770_120_000_000,
        createdAt: 1_770_119_000_000,
        updatedAt: 1_770_120_000_000,
      }),
      createOrder({
        id: 'buyer-failed',
        role: 'buyer',
        localMetabotId: 5,
        status: 'failed',
        refundRequestPinId: null,
        refundRequestedAt: null,
        failureReason: 'delivery_timeout',
        createdAt: 1_770_110_000_000,
        updatedAt: 1_770_110_000_000,
      }),
    ],
    resolveCounterpartyInfo: async (globalMetaId) => ({
      name: globalMetaId === 'buyer-global-1' ? 'Buyer One' : null,
      avatarUrl: globalMetaId === 'buyer-global-1' ? 'https://example.com/buyer-1.png' : null,
    }),
    resolveCoworkSessionIdForOrder: (order) => (
      order.id === 'seller-pending' ? 'session-recovered' : order.coworkSessionId ?? null
    ),
  });

  const result = await service.listRefunds();

  assert.equal(result.pendingCount, 1);
  assert.deepEqual(
    result.pendingForMe.map((item) => [item.orderId, item.status, item.canProcessRefund]),
    [
      ['seller-pending', 'refund_pending', true],
      ['seller-refunded', 'refunded', false],
    ],
  );
  assert.equal(result.pendingForMe[0].counterpartyName, 'Buyer One');
  assert.equal(result.pendingForMe[0].counterpartyAvatar, 'https://example.com/buyer-1.png');
  assert.equal(result.pendingForMe[0].coworkSessionId, 'session-recovered');
  assert.equal(result.pendingForMe[0].paymentTxid, '1'.repeat(64));
  assert.equal(result.pendingForMe[1].coworkSessionId, 'session-known');
  assert.equal(result.initiatedByMe[0].counterpartyName, 'seller-global-1');
  assert.equal(result.initiatedByMe[0].canProcessRefund, false);
  assert.deepEqual(
    result.pendingForMe.map((item) => item.orderId),
    ['seller-pending', 'seller-refunded'],
  );
  assert.deepEqual(result.initiatedByMe.map((item) => item.orderId), ['buyer-pending']);
});

test('listRefunds follows the spec sorting rules for seller and buyer tabs', async () => {
  const service = createService({
    listSellerRefundOrders: () => [
      createOrder({
        id: 'seller-pending-fallback',
        counterpartyGlobalMetaid: 'buyer-global-1',
        refundRequestedAt: null,
        createdAt: 1_770_094_000_000,
        updatedAt: 1_770_095_000_000,
      }),
      createOrder({
        id: 'seller-pending-early',
        counterpartyGlobalMetaid: 'buyer-global-2',
        refundRequestedAt: 1_770_090_000_000,
        createdAt: 1_770_089_000_000,
        updatedAt: 1_770_090_000_000,
      }),
      createOrder({
        id: 'seller-refunded',
        counterpartyGlobalMetaid: 'buyer-global-3',
        status: 'refunded',
        refundTxid: '7'.repeat(64),
        refundRequestedAt: 1_770_080_000_000,
        refundCompletedAt: 1_770_081_000_000,
        createdAt: 1_770_079_000_000,
        updatedAt: 1_770_081_000_000,
      }),
    ],
    listBuyerRefundOrders: () => [
      createOrder({
        id: 'buyer-pending-latest',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-1',
        refundRequestedAt: 1_770_120_000_000,
        createdAt: 1_770_119_000_000,
        updatedAt: 1_770_120_000_000,
      }),
      createOrder({
        id: 'buyer-pending-fallback',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-2',
        refundRequestedAt: null,
        createdAt: 1_770_109_000_000,
        updatedAt: 1_770_110_000_000,
      }),
      createOrder({
        id: 'buyer-refunded-new',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-3',
        status: 'refunded',
        refundTxid: '9'.repeat(64),
        refundRequestedAt: 1_770_100_000_000,
        refundCompletedAt: 1_770_111_000_000,
        createdAt: 1_770_099_000_000,
        updatedAt: 1_770_111_000_000,
      }),
      createOrder({
        id: 'buyer-refunded-old',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-4',
        status: 'refunded',
        refundTxid: 'a'.repeat(64),
        refundRequestedAt: 1_770_090_000_000,
        refundCompletedAt: 1_770_091_000_000,
        createdAt: 1_770_089_000_000,
        updatedAt: 1_770_091_000_000,
      }),
    ],
  });

  const result = await service.listRefunds();

  assert.deepEqual(
    result.pendingForMe.map((item) => item.orderId),
    ['seller-pending-early', 'seller-pending-fallback', 'seller-refunded'],
  );
  assert.deepEqual(
    result.initiatedByMe.map((item) => item.orderId),
    ['buyer-pending-latest', 'buyer-pending-fallback', 'buyer-refunded-new', 'buyer-refunded-old'],
  );
});

test('listRefunds keeps seller refunded history while excluding non-actionable pending rows', async () => {
  const service = createService({
    listSellerRefundOrders: () => [
      createOrder({
        id: 'seller-refunded',
        status: 'refunded',
        refundTxid: '7'.repeat(64),
        refundCompletedAt: 1_770_101_000_000,
      }),
      createOrder({
        id: 'seller-pending-missing-pin',
        status: 'refund_pending',
        refundRequestPinId: null,
      }),
      createOrder({
        id: 'seller-actionable',
        status: 'refund_pending',
        refundRequestPinId: 'refund-request-pin-actionable',
      }),
    ],
  });

  const result = await service.listRefunds();

  assert.deepEqual(
    result.pendingForMe.map((item) => [item.orderId, item.status, item.canProcessRefund]),
    [
      ['seller-actionable', 'refund_pending', true],
      ['seller-refunded', 'refunded', false],
    ],
  );
  assert.equal(result.pendingCount, 1);
});

test('listRefunds tolerates missing counterparty info and falls back to globalmetaid', async () => {
  const service = createService({
    listSellerRefundOrders: () => [
      createOrder({
        id: 'seller-pending',
        counterpartyGlobalMetaid: 'buyer-global-unknown',
      }),
    ],
    resolveCounterpartyInfo: async () => {
      throw new Error('profile offline');
    },
  });

  const result = await service.listRefunds();

  assert.equal(result.pendingForMe[0].counterpartyName, 'buyer-global-unknown');
  assert.equal(result.pendingForMe[0].counterpartyAvatar, null);
});

test('processRefundOrder only allows seller refund_pending rows and returns a narrowed result', async () => {
  const calls = [];
  const service = createService({
    getOrderById: (orderId) => {
      if (orderId === 'seller-pending') {
        return createOrder({
          id: 'seller-pending',
          role: 'seller',
          status: 'refund_pending',
        });
      }
      if (orderId === 'buyer-pending') {
        return createOrder({
          id: 'buyer-pending',
          role: 'buyer',
          localMetabotId: 5,
          status: 'refund_pending',
        });
      }
      if (orderId === 'seller-refunded') {
        return createOrder({
          id: 'seller-refunded',
          role: 'seller',
          status: 'refunded',
          refundTxid: 'c'.repeat(64),
          refundCompletedAt: 1_770_101_000_000,
        });
      }
      if (orderId === 'seller-missing-pin') {
        return createOrder({
          id: 'seller-missing-pin',
          role: 'seller',
          status: 'refund_pending',
          refundRequestPinId: null,
        });
      }
      return null;
    },
    processSellerRefundForOrderId: async (orderId) => {
      calls.push(orderId);
      return {
        order: createOrder({
          id: orderId,
          role: 'seller',
          status: 'refunded',
          refundTxid: 'd'.repeat(64),
          refundCompletedAt: 1_770_102_000_000,
        }),
        refundTxid: 'd'.repeat(64),
        refundFinalizePinId: 'refund-finalize-pin-1',
      };
    },
  });

  const success = await service.processRefundOrder({ orderId: 'seller-pending' });
  assert.deepEqual(success, {
    orderId: 'seller-pending',
    refundTxid: 'd'.repeat(64),
    refundFinalizePinId: 'refund-finalize-pin-1',
  });
  assert.deepEqual(calls, ['seller-pending']);

  await assert.rejects(
    () => service.processRefundOrder({ orderId: 'buyer-pending' }),
    /seller/i,
  );
  await assert.rejects(
    () => service.processRefundOrder({ orderId: 'seller-refunded' }),
    /pending/i,
  );
  await assert.rejects(
    () => service.processRefundOrder({ orderId: 'seller-missing-pin' }),
    /pending refund request/i,
  );
});
