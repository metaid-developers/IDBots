import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareHeaderActions from '../src/renderer/components/gigSquare/GigSquareHeaderActions';

test('header actions render my services, refunds badge, and publish action', () => {
  const markup = renderToStaticMarkup(
    <GigSquareHeaderActions
      pendingRefundCount={3}
      onOpenMyServices={() => {}}
      onOpenRefunds={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.match(markup, /我的服务/);
  assert.match(markup, /服务退款/);
  assert.match(markup, />3<\/span>/);
  assert.match(markup, /发布技能服务/);
});

test('header actions hide the refunds badge when there is no pending refund', () => {
  const markup = renderToStaticMarkup(
    <GigSquareHeaderActions
      pendingRefundCount={0}
      onOpenMyServices={() => {}}
      onOpenRefunds={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.match(markup, /服务退款/);
  assert.doesNotMatch(markup, />0<\/span>/);
});
