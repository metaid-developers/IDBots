import test from 'node:test';
import assert from 'node:assert/strict';

test('fetchLocalPresenceSnapshot keeps a peerless local presence healthy when onlineBots are present', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    async json() {
      return {
        code: 1,
        data: {
          healthy: true,
          peerCount: 0,
          onlineBots: {
            idq1localprovider: {
              lastSeenSec: 1712400000,
              expiresAtSec: 1712400030,
              peerIds: [],
            },
          },
          unhealthyReason: null,
          lastConfigReloadError: null,
          nowSec: 1712400001,
        },
      };
    },
  });

  try {
    const { fetchLocalPresenceSnapshot } = await import('../dist-electron/services/p2pPresenceClient.js');
    const snapshot = await fetchLocalPresenceSnapshot('http://127.0.0.1:9527');

    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.peerCount, 0);
    assert.deepEqual(Object.keys(snapshot.onlineBots), ['idq1localprovider']);
  } finally {
    global.fetch = originalFetch;
  }
});
