import test from 'node:test';
import assert from 'node:assert/strict';

const { shouldForwardCoworkStreamEvent } = await import('../dist-electron/services/coworkStreamForwarding.js');

test('shouldForwardCoworkStreamEvent suppresses hidden internal sessions', () => {
  const store = {
    isSessionHiddenFromList(sessionId) {
      return sessionId === 'hidden-order-execution';
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'hidden-order-execution'), false);
  assert.equal(shouldForwardCoworkStreamEvent(store, 'visible-peer-session'), true);
});

test('shouldForwardCoworkStreamEvent falls back to session visibility when lightweight lookup is unavailable', () => {
  const store = {
    getSession(sessionId) {
      return {
        id: sessionId,
        hiddenFromSessionList: sessionId === 'hidden-session',
      };
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'hidden-session'), false);
  assert.equal(shouldForwardCoworkStreamEvent(store, 'visible-session'), true);
});

test('shouldForwardCoworkStreamEvent keeps forwarding when visibility cannot be read', () => {
  const store = {
    isSessionHiddenFromList() {
      throw new Error('database unavailable');
    },
  };

  assert.equal(shouldForwardCoworkStreamEvent(store, 'unknown-session'), true);
});
