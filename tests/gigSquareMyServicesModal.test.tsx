import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareMyServicesModal, {
  buildModifyDraftFromService,
  dispatchGigSquareMyServiceOrderSessionView,
} from '../src/renderer/components/gigSquare/GigSquareMyServicesModal';

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
  assert.match(markup, /平均评分/);
  assert.match(markup, />5\.0</);
  assert.match(markup, /创建 MetaBot[^<]*CreatorBot/);
});

test('detail view renders completed\\/refunded order rows and a disabled session action when sessionId is missing', () => {
  const buyerGlobalMetaid = 'idq14h123456789abcdef9xz';
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
          counterpartyGlobalMetaid: buyerGlobalMetaid,
          counterpartyName: 'Alice',
          counterpartyAvatar: 'https://example.com/avatar.png',
          coworkSessionId: null,
          rating: {
            rate: 4,
            comment: 'Very solid',
            createdAt: 1_770_000_180_000,
            raterGlobalMetaId: buyerGlobalMetaid,
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
  assert.match(markup, /idq14h\.\.\.9xz/);
  assert.doesNotMatch(markup, /idq14h123456789abcdef9xz/);
  assert.match(markup, /example\.com\/avatar\.png/);
  assert.match(markup, /评价 Txid|Rating Txid/);
  assert.match(markup, /复制到剪贴板/);
  assert.match(markup, /本机无对应会话记录/);
});

test('my-service order session helper dispatches focused order view and closes the modal', () => {
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
    dispatchGigSquareMyServiceOrderSessionView(' session-42 ', ` ${'c'.repeat(64)} `, () => {
      onCloseCalls.push('closed');
    });
  } finally {
    globalThis.window = originalWindow;
  }

  assert.deepEqual(events, [{
    type: 'cowork:viewSession',
    detail: {
      sessionId: 'session-42',
      focusedOrderTxid: 'c'.repeat(64),
    },
  }]);
  assert.deepEqual(onCloseCalls, ['closed']);
});

test('modify draft preserves v1.1 protocol settlement kind and metadata', () => {
  const draft = buildModifyDraftFromService({
    id: 'svc-1',
    currentPinId: 'svc-1',
    sourceServicePinId: 'svc-root',
    serviceName: 'weather-service',
    displayName: 'Weather',
    description: 'desc',
    executionReminder: '',
    providerSkill: 'weather',
    providerSkills: ['weather'],
    paymentTiming: 'prepaid',
    price: '1.25',
    currency: 'SPACE',
    protocolSettlementKind: 'fiat',
    metadata: '{"invoice":"manual"}',
    outputType: 'text',
  } as any);

  assert.equal(draft.protocolSettlementKind, 'fiat');
  assert.equal(draft.metadata, '{"invoice":"manual"}');
});

test('modify draft preserves existing fiat quote currency', () => {
  for (const currency of [' CNY ', 'usd']) {
    const draft = buildModifyDraftFromService({
      id: 'svc-1',
      currentPinId: 'svc-1',
      sourceServicePinId: 'svc-root',
      serviceName: 'weather-service',
      displayName: 'Weather',
      description: 'desc',
      executionReminder: '',
      providerSkill: 'weather',
      providerSkills: ['weather'],
      paymentTiming: 'prepaid',
      price: '12.50',
      currency,
      settlementKind: 'fiat',
      metadata: '{"invoice":"manual","quote":"fiat"}',
      outputType: 'text',
    } as any);

    assert.equal(draft.currency, currency.trim().toUpperCase());
    assert.equal(draft.protocolSettlementKind, 'fiat');
    assert.equal(draft.metadata, '{"invoice":"manual","quote":"fiat"}');
  }
});
