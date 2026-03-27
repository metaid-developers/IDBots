import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareMyServicesModal from '../src/renderer/components/gigSquare/GigSquareMyServicesModal';

test('empty-state modal renders go-publish CTA', () => {
  const markup = renderToStaticMarkup(
    <GigSquareMyServicesModal
      isOpen
      servicesPage={{ items: [], total: 0, page: 1, pageSize: 8, totalPages: 0 }}
      view="list"
      onClose={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.match(markup, /去发布服务/);
});

test('list view shows plain rating score and renders second-based updatedAt as a real date', () => {
  const markup = renderToStaticMarkup(
    <GigSquareMyServicesModal
      isOpen
      view="list"
      servicesPage={{
        items: [{
          id: 'svc-1',
          currentPinId: 'svc-1',
          sourceServicePinId: 'svc-root',
          displayName: 'Weather',
          serviceName: 'weather-service',
          description: 'desc',
          price: '0.1',
          currency: 'SPACE',
          providerMetaId: 'meta-1',
          providerGlobalMetaId: 'global-1',
          providerAddress: 'addr-1',
          creatorMetabotId: 7,
          creatorMetabotName: 'CreatorBot',
          canModify: true,
          canRevoke: true,
          blockedReason: null,
          successCount: 3,
          refundCount: 1,
          grossRevenue: '0.3',
          netIncome: '0.2',
          ratingAvg: 5,
          ratingCount: 6,
          updatedAt: 1_773_514_659,
        }],
        total: 1,
        page: 1,
        pageSize: 8,
        totalPages: 1,
      }}
      onClose={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.doesNotMatch(markup, /1970/);
  assert.doesNotMatch(markup, /· 6/);
  assert.match(markup, /平均评分[^<]*5\.0/);
  assert.match(markup, /创建 MetaBot[^<]*CreatorBot/);
});

test('detail view renders completed\\/refunded order rows and a disabled session action when sessionId is missing', () => {
  const markup = renderToStaticMarkup(
    <GigSquareMyServicesModal
      isOpen
      view="detail"
      selectedService={{
        id: 'svc-1',
        displayName: 'Weather',
        serviceName: 'weather-service',
      }}
      ordersPage={{
        items: [{
          id: 'order-1',
          status: 'refunded',
          paymentTxid: 'a'.repeat(64),
          paymentAmount: '1.5',
          paymentCurrency: 'SPACE',
          servicePinId: 'svc-1',
          createdAt: 1_770_000_000_000,
          deliveredAt: 1_770_000_060_000,
          refundCompletedAt: 1_770_000_120_000,
          counterpartyGlobalMetaid: 'buyer-1',
          counterpartyName: 'Alice',
          counterpartyAvatar: 'https://example.com/avatar.png',
          coworkSessionId: null,
          rating: {
            rate: 4,
            comment: 'Very solid',
            createdAt: 1_770_000_180_000,
            raterGlobalMetaId: 'buyer-1',
            raterMetaId: 'meta-buyer-1',
            pinId: `${'b'.repeat(64)}i0`,
          },
        } as any],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      }}
      onClose={() => {}}
      onBackToList={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.match(markup, /退款/);
  assert.match(markup, /Alice/);
  assert.match(markup, /buyer-1/);
  assert.match(markup, /example\.com\/avatar\.png/);
  assert.match(markup, /评价 Txid|Rating Txid/);
  assert.match(markup, /复制到剪贴板/);
  assert.match(markup, /本机无对应会话记录/);
});
