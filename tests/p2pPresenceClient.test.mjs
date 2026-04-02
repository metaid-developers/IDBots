import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPresenceClient() {
  return require('../dist-electron/services/p2pPresenceClient.js');
}

async function withMockedFetch(mock, run) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('fetchLocalPresenceSnapshot keeps healthy empty onlineBots snapshot authoritative when peerCount is positive', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 1,
        message: 'ok',
        data: {
          healthy: true,
          peerCount: 2,
          onlineBots: {},
        },
      };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, true);
    assert.equal(snapshot.peerCount, 2);
    assert.deepEqual(snapshot.onlineBots, {});
    assert.equal(snapshot.unhealthyReason, null);
  });
});

test('fetchLocalPresenceSnapshot rejects healthy=true when peerCount is zero', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 1,
        message: 'ok',
        data: {
          healthy: true,
          peerCount: 0,
          onlineBots: {},
        },
      };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.peerCount, 0);
    assert.deepEqual(snapshot.onlineBots, {});
    assert.equal(snapshot.unhealthyReason, 'no_active_peers');
  });
});

test('fetchLocalPresenceSnapshot marks impossible peerCount values as malformed', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  for (const peerCount of [-1, 1.5]) {
    await withMockedFetch(async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          code: 1,
          message: 'ok',
          data: {
            healthy: true,
            peerCount,
            onlineBots: {},
          },
        };
      },
    }), async () => {
      const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
      assert.equal(snapshot.healthy, false);
      assert.equal(snapshot.unhealthyReason, 'malformed_peer_count');
    });
  }
});

test('fetchLocalPresenceSnapshot marks code != 1 envelope as unhealthy', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return { code: 0, message: 'bad', data: { healthy: true, peerCount: 1, onlineBots: {} } };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.unhealthyReason, 'envelope_code_not_success');
  });
});

test('fetchLocalPresenceSnapshot marks malformed onlineBots as unhealthy', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 1,
        message: 'ok',
        data: {
          healthy: true,
          peerCount: 1,
          onlineBots: [],
        },
      };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.unhealthyReason, 'malformed_online_bots');
  });
});

test('fetchLocalPresenceSnapshot normalizes onlineBots keys to lowercase raw id form', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 1,
        message: 'ok',
        data: {
          healthy: true,
          peerCount: 3,
          onlineBots: {
            ' IDQ1Alpha ': {
              lastSeenSec: 10,
              expiresAtSec: 60,
              peerIds: ['peer-a'],
            },
            idq1beta: {
              lastSeenSec: 15,
              expiresAtSec: 70,
              peerIds: ['peer-b', 'peer-c'],
            },
          },
        },
      };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, true);
    assert.deepEqual(Object.keys(snapshot.onlineBots).sort(), ['idq1alpha', 'idq1beta']);
    assert.deepEqual(snapshot.onlineBots.idq1alpha.peerIds, ['peer-a']);
  });
});

test('fetchLocalPresenceSnapshot preserves lastConfigReloadError from the presence contract', async () => {
  const { fetchLocalPresenceSnapshot } = loadPresenceClient();

  await withMockedFetch(async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        code: 1,
        message: 'ok',
        data: {
          healthy: false,
          peerCount: 0,
          onlineBots: {},
          unhealthyReason: 'presence_not_initialized',
          lastConfigReloadError: 'malformed runtime config',
          nowSec: 170,
        },
      };
    },
  }), async () => {
    const snapshot = await fetchLocalPresenceSnapshot('http://localhost:7281');
    assert.equal(snapshot.healthy, false);
    assert.equal(snapshot.lastConfigReloadError, 'malformed runtime config');
    assert.equal(snapshot.unhealthyReason, 'presence_not_initialized');
  });
});
