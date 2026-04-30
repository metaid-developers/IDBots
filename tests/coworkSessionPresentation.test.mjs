import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildPrivateA2ASessionDisplayId,
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

test('buildPrivateA2ASessionDisplayId uses local and peer globalMetaId prefixes', () => {
  assert.equal(
    buildPrivateA2ASessionDisplayId(
      'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
      'idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm',
    ),
    'idq14hmv-idq1g35d',
  );

  assert.equal(buildPrivateA2ASessionDisplayId(' idq18x8zm89 ', ' idq1w3q3hgm '), 'idq18x8z-idq1w3q3');
  assert.equal(buildPrivateA2ASessionDisplayId('', 'idq1w3q3hgm'), '');
  assert.equal(buildPrivateA2ASessionDisplayId('idq18x8zm89', null), '');
});
