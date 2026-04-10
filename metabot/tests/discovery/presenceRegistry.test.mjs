import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PresenceRegistry } = require('../../dist/core/discovery/presenceRegistry.js');

test('PresenceRegistry marks a provider online when the latest heartbeat is fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const registry = new PresenceRegistry({
    fetchHeartbeat: async () => ({ timestamp: nowSec - 30 })
  });

  await registry.pollAll([
    {
      providerGlobalMetaId: ' IDQ1ProviderA ',
      providerAddress: 'mvc-provider-address',
      serviceName: 'svc-alpha'
    }
  ]);

  const snapshot = registry.getDiscoverySnapshot();
  assert.equal(snapshot.onlineBots.idq1providera, nowSec - 30);
  assert.equal(snapshot.availableServices.length, 1);
  assert.equal(snapshot.providers['idq1providera::mvc-provider-address']?.online, true);
});

test('PresenceRegistry keeps a provider online through a semantic miss while cached heartbeat is still fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let callCount = 0;
  const registry = new PresenceRegistry({
    fetchHeartbeat: async () => {
      callCount += 1;
      if (callCount === 1) {
        return { timestamp: nowSec - 20 };
      }
      return null;
    }
  });

  const services = [
    {
      providerGlobalMetaId: 'idq1cache',
      providerAddress: 'mvc-cache',
      serviceName: 'svc-cache'
    }
  ];

  await registry.pollAll(services);
  await registry.pollAll(services);

  assert.deepEqual(registry.getDiscoverySnapshot().onlineBots, { idq1cache: nowSec - 20 });
  assert.equal(registry.getDiscoverySnapshot().availableServices.length, 1);
});

test('PresenceRegistry forceOffline suppresses a provider even when local heartbeat remains fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const registry = new PresenceRegistry({
    now: () => nowSec * 1000,
    fetchHeartbeat: async () => null
  });

  registry.recordLocalHeartbeat({
    globalMetaId: 'idq1providera',
    address: 'mvc-a',
    timestampSec: nowSec
  });
  await registry.pollAll([
    {
      providerGlobalMetaId: 'idq1providera',
      providerAddress: 'mvc-a',
      serviceName: 'svc-alpha'
    }
  ]);

  registry.forceOffline('idq1providera');

  const snapshot = registry.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'], undefined);
});
