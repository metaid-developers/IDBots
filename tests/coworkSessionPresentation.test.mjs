import test from 'node:test';
import assert from 'node:assert/strict';

const {
  shouldShowA2AServiceSessionId,
} = await import('../src/renderer/components/cowork/coworkSessionPresentation.js');

test('shouldShowA2AServiceSessionId only enables session id metadata for service A2A sessions', () => {
  assert.equal(shouldShowA2AServiceSessionId({
    sessionId: 'session-service-1',
    sessionType: 'a2a',
    serviceOrderSummary: { status: 'in_progress' },
  }), true);

  assert.equal(shouldShowA2AServiceSessionId({
    sessionId: 'session-private-1',
    sessionType: 'a2a',
    serviceOrderSummary: null,
  }), false);

  assert.equal(shouldShowA2AServiceSessionId({
    sessionId: 'session-standard-1',
    sessionType: 'standard',
    serviceOrderSummary: { status: 'in_progress' },
  }), false);
});
