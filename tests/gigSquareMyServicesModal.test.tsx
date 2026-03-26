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
          coworkSessionId: null,
          rating: null,
        }],
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
  assert.match(markup, /本机无对应会话记录/);
});
