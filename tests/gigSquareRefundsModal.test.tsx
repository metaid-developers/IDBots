import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareRefundsModal, {
  dispatchGigSquareRefundSessionView,
} from '../src/renderer/components/gigSquare/GigSquareRefundsModal';
import type { GigSquareRefundCollections } from '../src/renderer/types/gigSquare';

function createRefunds(overrides?: Partial<GigSquareRefundCollections>): GigSquareRefundCollections {
  return {
    pendingForMe: [{
      orderId: 'seller-order-1',
      role: 'seller',
      servicePinId: 'service-pin-1',
      serviceName: 'Weather Analyst',
      paymentTxid: 'a'.repeat(64),
      paymentAmount: '1.5',
      paymentCurrency: 'SPACE',
      status: 'refund_pending',
      failureReason: 'delivery_timeout',
      refundRequestPinId: 'refund-pin-1',
      refundTxid: null,
      refundRequestedAt: 1_770_100_000_000,
      refundCompletedAt: null,
      counterpartyGlobalMetaid: 'buyer-global-1',
      counterpartyName: 'Alice Buyer',
      counterpartyAvatar: null,
      createdAt: 1_770_099_000_000,
      updatedAt: 1_770_100_000_000,
      coworkSessionId: 'session-1',
      canProcessRefund: true,
    }],
    initiatedByMe: [{
      orderId: 'buyer-order-1',
      role: 'buyer',
      servicePinId: 'service-pin-2',
      serviceName: 'Translate Desk',
      paymentTxid: 'b'.repeat(64),
      paymentAmount: '0.75',
      paymentCurrency: 'DOGE',
      status: 'refund_pending',
      failureReason: 'first_response_timeout',
      refundRequestPinId: 'refund-pin-2',
      refundTxid: null,
      refundRequestedAt: 1_770_200_000_000,
      refundCompletedAt: null,
      counterpartyGlobalMetaid: 'seller-global-9',
      counterpartyName: 'Seller Ops',
      counterpartyAvatar: null,
      createdAt: 1_770_199_000_000,
      updatedAt: 1_770_200_000_000,
      coworkSessionId: 'session-2',
      canProcessRefund: true,
    }],
    pendingCount: 1,
    ...overrides,
  };
}

test('seller tab renders refund workspace details, amount, process action, and session action', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds()}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  assert.match(markup, /服务退款/);
  assert.match(markup, /我需处理的退款/);
  assert.match(markup, /Alice Buyer/);
  assert.match(markup, /buyer-global-1/);
  assert.match(markup, /1\.5/);
  assert.match(markup, /SPACE/);
  assert.match(markup, /Weather Analyst/);
  assert.match(markup, /处理退款/);
  assert.match(markup, /查看会话/);
});

test('buyer tab hides the process action and shows buyer-side refund content', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds()}
      activeTab="initiatedByMe"
      onTabChange={() => {}}
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  assert.match(markup, /我发起的退款/);
  assert.match(markup, /Seller Ops/);
  assert.match(markup, /seller-global-9/);
  assert.match(markup, /Translate Desk/);
  assert.match(markup, /查看会话/);
  assert.doesNotMatch(markup, /处理退款/);
});

test('view session helper dispatches cowork:viewSession and closes the modal', () => {
  const events: Array<{ type: string; detail: unknown }> = [];
  const originalWindow = globalThis.window;
  const onCloseCalls: string[] = [];

  globalThis.window = {
    dispatchEvent(event: Event) {
      const customEvent = event as CustomEvent;
      events.push({
        type: event.type,
        detail: customEvent.detail,
      });
      return true;
    },
  } as Window & typeof globalThis;

  try {
    dispatchGigSquareRefundSessionView(' session-99 ', () => {
      onCloseCalls.push('closed');
    });
  } finally {
    globalThis.window = originalWindow;
  }

  assert.deepEqual(events, [{
    type: 'cowork:viewSession',
    detail: { sessionId: 'session-99' },
  }]);
  assert.deepEqual(onCloseCalls, ['closed']);
});

test('seller processing state disables every refund action while the active row shows processing copy', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds({
        pendingForMe: [
          ...createRefunds().pendingForMe,
          {
            ...createRefunds().pendingForMe[0],
            orderId: 'seller-order-2',
            counterpartyGlobalMetaid: 'buyer-global-2',
            counterpartyName: 'Buyer Two',
            coworkSessionId: null,
          },
        ],
        pendingCount: 2,
      })}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      processingOrderId="seller-order-1"
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  assert.match(markup, /处理中\.\.\./);
  assert.equal((markup.match(/disabled=""/g) || []).length, 2);
});

test('renders dates, failure reason labels, and tab-specific empty states', () => {
  const populatedMarkup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds({
        pendingForMe: [{
          orderId: 'seller-order-2',
          role: 'seller',
          servicePinId: 'service-pin-3',
          serviceName: 'Research Sprint',
          paymentTxid: 'c'.repeat(64),
          paymentAmount: '2.0',
          paymentCurrency: 'SPACE',
          status: 'refunded',
          failureReason: 'first_response_timeout',
          refundRequestPinId: 'refund-pin-3',
          refundTxid: 'd'.repeat(64),
          refundRequestedAt: 1_770_300_000_000,
          refundCompletedAt: 1_770_360_000_000,
          counterpartyGlobalMetaid: 'buyer-global-7',
          counterpartyName: 'Buyer Seven',
          counterpartyAvatar: null,
          createdAt: 1_770_299_000_000,
          updatedAt: 1_770_360_000_000,
          coworkSessionId: null,
          canProcessRefund: false,
        }],
      })}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  const emptySellerMarkup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds({ pendingForMe: [], pendingCount: 0 })}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  const emptyBuyerMarkup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={createRefunds({ initiatedByMe: [] })}
      activeTab="initiatedByMe"
      onTabChange={() => {}}
      onRetry={() => {}}
      onClose={() => {}}
      onProcessRefund={() => {}}
    />
  );

  assert.match(populatedMarkup, /失败原因/);
  assert.match(populatedMarkup, /5 分钟内未首次响应/);
  assert.match(populatedMarkup, /退款时间|完成时间/);
  assert.doesNotMatch(populatedMarkup, /1970/);
  assert.match(emptySellerMarkup, /暂无需要你处理的退款/);
  assert.match(emptyBuyerMarkup, /暂无你发起的退款/);
});
