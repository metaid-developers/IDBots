import test from 'node:test';
import assert from 'node:assert/strict';
import {
  shouldRegisterStreamSessionFromFetch,
} from '../src/renderer/services/coworkStreamPresentation.js';

test('shouldRegisterStreamSessionFromFetch rejects hidden sessions', () => {
  assert.equal(shouldRegisterStreamSessionFromFetch({
    id: 'hidden-session',
    hiddenFromSessionList: true,
  }), false);
});

test('shouldRegisterStreamSessionFromFetch accepts visible sessions', () => {
  assert.equal(shouldRegisterStreamSessionFromFetch({
    id: 'visible-session',
    hiddenFromSessionList: false,
  }), true);
});

test('shouldRegisterStreamSessionFromFetch keeps legacy visible sessions without hidden flag', () => {
  assert.equal(shouldRegisterStreamSessionFromFetch({
    id: 'legacy-session',
  }), true);
});
