import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGigSquareOrderErrorMessageKey,
  getGigSquarePayActionBlockedMessageKey,
  getGigSquarePayActionClassName,
  isGigSquarePayActionEnabled,
} from '../src/renderer/components/gigSquare/gigSquareOrderPresentation.js';

test('Gig Square pay action is enabled only when handshake is online and order status is idle', () => {
  assert.equal(isGigSquarePayActionEnabled('idle', 'online'), true);
  assert.equal(isGigSquarePayActionEnabled('idle', 'checking'), false);
  assert.equal(isGigSquarePayActionEnabled('idle', 'offline'), false);
  assert.equal(isGigSquarePayActionEnabled('sending', 'online'), false);
});

test('Gig Square pay action uses disabled styling while provider availability is unresolved or offline', () => {
  assert.match(getGigSquarePayActionClassName('idle', 'checking'), /opacity-50/);
  assert.match(getGigSquarePayActionClassName('idle', 'checking'), /cursor-not-allowed/);
  assert.match(getGigSquarePayActionClassName('idle', 'offline'), /opacity-50/);
  assert.doesNotMatch(getGigSquarePayActionClassName('idle', 'online'), /cursor-not-allowed/);
});

test('Gig Square pay action blocked message follows handshake status', () => {
  assert.equal(getGigSquarePayActionBlockedMessageKey('checking'), 'gigSquareHandshaking');
  assert.equal(getGigSquarePayActionBlockedMessageKey('idle'), 'gigSquareHandshaking');
  assert.equal(getGigSquarePayActionBlockedMessageKey('offline'), 'gigSquareHandshakeOffline');
  assert.equal(getGigSquarePayActionBlockedMessageKey('online'), null);
});

test('Gig Square order error message maps duplicate-order preflight failures to a stable i18n key', () => {
  assert.equal(getGigSquareOrderErrorMessageKey('open_order_exists'), 'gigSquareOpenOrderExists');
  assert.equal(getGigSquareOrderErrorMessageKey('network_error'), null);
  assert.equal(getGigSquareOrderErrorMessageKey(undefined), null);
});
