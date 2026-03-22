import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getP2PStatusBadgeView } from '../src/renderer/components/p2p/p2pStatusBadgeState.js';

test('getP2PStatusBadgeView() treats healthy peerless nodes as online, not connecting', () => {
  const view = getP2PStatusBadgeView({
    running: true,
    peerCount: 0,
    runtimeMode: 'p2p-only',
    dataSource: 'p2p',
  });

  assert.equal(view.label, '0 peers');
  assert.equal(view.dotColorClass, 'bg-blue-400');
  assert.equal(view.animate, false);
});

test('getP2PStatusBadgeView() keeps connected nodes green', () => {
  const view = getP2PStatusBadgeView({
    running: true,
    peerCount: 2,
  });

  assert.equal(view.label, '2 peers');
  assert.equal(view.dotColorClass, 'bg-green-400');
  assert.equal(view.animate, false);
});
