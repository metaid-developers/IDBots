import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  HeartbeatPollingService,
  fetchHeartbeatFromChain,
} = require('../dist-electron/services/heartbeatPollingService.js');

const ONLINE_WINDOW_SEC = 10 * 60; // 10 minutes

// ---------------------------------------------------------------------------
// checkOnlineStatus
// ---------------------------------------------------------------------------

test('checkOnlineStatus returns true when timestamp is within 10 minutes', () => {
  const svc = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
  const nowSec = Date.now() / 1000;
  assert.equal(svc.checkOnlineStatus(nowSec - 60), true);   // 1 minute ago
  assert.equal(svc.checkOnlineStatus(nowSec - 300), true);  // 5 minutes ago
  assert.equal(svc.checkOnlineStatus(nowSec), true);        // right now
});

test('checkOnlineStatus returns true for timestamp exactly at 10-minute boundary', () => {
  const svc = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
  const nowSec = Date.now() / 1000;
  assert.equal(svc.checkOnlineStatus(nowSec - ONLINE_WINDOW_SEC), true);
});

test('checkOnlineStatus returns false when timestamp is older than 10 minutes', () => {
  const svc = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
  const nowSec = Date.now() / 1000;
  assert.equal(svc.checkOnlineStatus(nowSec - ONLINE_WINDOW_SEC - 1), false); // 1 second past
  assert.equal(svc.checkOnlineStatus(nowSec - 3600), false);                 // 1 hour ago
});

test('checkOnlineStatus returns false for null timestamp', () => {
  const svc = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
  assert.equal(svc.checkOnlineStatus(null), false);
});

// ---------------------------------------------------------------------------
// pollAll
// ---------------------------------------------------------------------------

test('pollAll marks a bot online and adds it to availableServices when heartbeat is fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => ({ timestamp: nowSec - 30 }),
  });

  const services = [
    {
      providerGlobalMetaId: 'global-1',
      providerAddress: '1abc',
      serviceName: 'weather',
    },
  ];

  await svc.pollAll(services);

  assert.equal(svc.onlineBots.size, 1);
  assert.ok(svc.onlineBots.has('global-1'));
  assert.equal(svc.availableServices.length, 1);
  assert.equal(svc.availableServices[0].serviceName, 'weather');
});

test('pollAll marks a bot offline and excludes it from availableServices when heartbeat is stale', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => ({ timestamp: nowSec - 3600 }), // 1 hour ago
  });

  const services = [
    {
      providerGlobalMetaId: 'global-2',
      providerAddress: '1def',
      serviceName: 'translate',
    },
  ];

  await svc.pollAll(services);

  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll marks a bot offline when fetchHeartbeat returns null', async () => {
  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => null,
  });

  const services = [
    {
      providerGlobalMetaId: 'global-3',
      providerAddress: '1ghi',
      serviceName: 'image',
    },
  ];

  await svc.pollAll(services);

  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll handles mixed online and offline services', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const fetchHeartbeat = async (address) => {
    if (address === 'addr-online') return { timestamp: nowSec - 60 };
    if (address === 'addr-offline') return { timestamp: nowSec - 3600 };
    return null;
  };

  const svc = new HeartbeatPollingService({ fetchHeartbeat });

  const services = [
    { providerGlobalMetaId: 'bot-online', providerAddress: 'addr-online', serviceName: 'svc-a' },
    { providerGlobalMetaId: 'bot-offline', providerAddress: 'addr-offline', serviceName: 'svc-b' },
    { providerGlobalMetaId: 'bot-null', providerAddress: 'addr-null', serviceName: 'svc-c' },
  ];

  await svc.pollAll(services);

  assert.equal(svc.onlineBots.size, 1);
  assert.ok(svc.onlineBots.has('bot-online'));
  assert.ok(!svc.onlineBots.has('bot-offline'));
  assert.ok(!svc.onlineBots.has('bot-null'));

  assert.equal(svc.availableServices.length, 1);
  assert.equal(svc.availableServices[0].serviceName, 'svc-a');
});

test('pollAll queries heartbeat once per provider and keeps all active services for that provider', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const addresses = [];

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async (address) => {
      addresses.push(address);
      return { timestamp: nowSec - 15 };
    },
  });

  await svc.pollAll([
    {
      providerGlobalMetaId: 'bot-shared',
      providerAddress: 'mvc-provider-address',
      paymentAddress: 'btc-payment-address',
      serviceName: 'svc-a',
    },
    {
      providerGlobalMetaId: 'bot-shared',
      providerAddress: 'mvc-provider-address',
      paymentAddress: 'doge-payment-address',
      serviceName: 'svc-b',
    },
  ]);

  assert.deepEqual(addresses, ['mvc-provider-address']);
  assert.equal(svc.onlineBots.size, 1);
  assert.equal(svc.availableServices.length, 2);
});

test('pollAll keeps provider online through a transient semantic miss while cached heartbeat is still fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let callCount = 0;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => {
      callCount += 1;
      if (callCount === 1) {
        return { timestamp: nowSec - 20 };
      }
      return null;
    },
  });

  const services = [
    { providerGlobalMetaId: 'bot-cache', providerAddress: 'mvc-provider-address', serviceName: 'svc-cache' },
  ];

  await svc.pollAll(services);
  assert.equal(svc.onlineBots.size, 1);

  await svc.pollAll(services);
  assert.equal(svc.onlineBots.size, 1);
  assert.equal(svc.availableServices.length, 1);
});

test('pollAll stores the lastSeen timestamp in onlineBots', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const expectedTs = nowSec - 45;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => ({ timestamp: expectedTs }),
  });

  await svc.pollAll([
    { providerGlobalMetaId: 'bot-ts', providerAddress: '1addr', serviceName: 'test' },
  ]);

  assert.equal(svc.onlineBots.get('bot-ts'), expectedTs);
});

test('pollAll skips services with no address', async () => {
  let called = false;
  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => { called = true; return null; },
  });

  await svc.pollAll([
    { providerGlobalMetaId: 'bot-no-addr', serviceName: 'mystery' },
  ]);

  assert.equal(called, false);
  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll keeps the freshest seen heartbeat until the cached timestamp ages past the online window', async () => {
  let nowSec = Math.floor(Date.now() / 1000);

  let callCount = 0;
  const svc = new HeartbeatPollingService({
    now: () => nowSec * 1000,
    fetchHeartbeat: async () => {
      callCount += 1;
      // First call: fresh heartbeat; second call: stale chain data
      return callCount === 1
        ? { timestamp: nowSec - 10 }
        : { timestamp: nowSec - 3600 };
    },
  });

  const services = [
    { providerGlobalMetaId: 'bot-flip', providerAddress: '1flip', serviceName: 'flip' },
  ];

  await svc.pollAll(services);
  assert.equal(svc.onlineBots.size, 1);

  await svc.pollAll(services);
  assert.equal(svc.onlineBots.size, 1);

  nowSec += ONLINE_WINDOW_SEC + 5;
  await svc.pollAll(services);
  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll gracefully handles fetchHeartbeat throwing', async () => {
  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => { throw new Error('network failure'); },
  });

  await svc.pollAll([
    { providerGlobalMetaId: 'bot-err', providerAddress: '1err', serviceName: 'err-svc' },
  ]);

  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll ignores revoked services with status -1 even if heartbeat is fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let fetchCount = 0;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => {
      fetchCount += 1;
      return { timestamp: nowSec - 10 };
    },
  });

  await svc.pollAll([
    {
      providerGlobalMetaId: 'bot-revoked',
      providerAddress: '1revoked',
      serviceName: 'revoked-svc',
      status: -1,
    },
  ]);

  assert.equal(fetchCount, 0);
  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

test('pollAll ignores services explicitly marked unavailable even if heartbeat is fresh', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let fetchCount = 0;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => {
      fetchCount += 1;
      return { timestamp: nowSec - 10 };
    },
  });

  await svc.pollAll([
    {
      providerGlobalMetaId: 'bot-hidden',
      providerAddress: '1hidden',
      serviceName: 'hidden-svc',
      available: 0,
    },
  ]);

  assert.equal(fetchCount, 0);
  assert.equal(svc.onlineBots.size, 0);
  assert.equal(svc.availableServices.length, 0);
});

// ---------------------------------------------------------------------------
// markOffline
// ---------------------------------------------------------------------------

test('markOffline removes the bot from onlineBots and availableServices', async () => {
  const nowSec = Math.floor(Date.now() / 1000);

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => ({ timestamp: nowSec - 10 }),
  });

  await svc.pollAll([
    { providerGlobalMetaId: 'bot-remove', providerAddress: '1rm', serviceName: 'rm-svc' },
    { providerGlobalMetaId: 'bot-keep', providerAddress: '1keep', serviceName: 'keep-svc' },
  ]);

  assert.equal(svc.onlineBots.size, 2);
  assert.equal(svc.availableServices.length, 2);

  svc.markOffline('bot-remove');

  assert.equal(svc.onlineBots.size, 1);
  assert.ok(!svc.onlineBots.has('bot-remove'));
  assert.ok(svc.onlineBots.has('bot-keep'));

  assert.equal(svc.availableServices.length, 1);
  assert.equal(svc.availableServices[0].serviceName, 'keep-svc');
});

test('markOffline is a no-op for a bot that is not online', () => {
  const svc = new HeartbeatPollingService({ fetchHeartbeat: async () => null });
  // Should not throw
  svc.markOffline('nonexistent-bot');
  assert.equal(svc.onlineBots.size, 0);
});

test('forceOffline survives local heartbeat updates until clearForceOffline is called', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const svc = new HeartbeatPollingService({
    now: () => nowSec * 1000,
    fetchHeartbeat: async () => null,
  });

  const services = [
    { providerGlobalMetaId: 'bot-force', providerAddress: '1force', serviceName: 'force-svc' },
  ];

  svc.recordLocalHeartbeat({ globalMetaId: 'bot-force', address: '1force', timestampSec: nowSec - 5 });
  await svc.pollAll(services);
  assert.ok(svc.onlineBots.has('bot-force'));

  svc.forceOffline('bot-force');
  await svc.pollAll(services);
  assert.ok(!svc.onlineBots.has('bot-force'));

  svc.recordLocalHeartbeat({ globalMetaId: 'bot-force', address: '1force', timestampSec: nowSec });
  await svc.pollAll(services);
  assert.ok(!svc.onlineBots.has('bot-force'));

  svc.clearForceOffline('bot-force');
  await svc.pollAll(services);
  assert.ok(svc.onlineBots.has('bot-force'));
});

// ---------------------------------------------------------------------------
// startPolling / stopPolling
// ---------------------------------------------------------------------------

test('startPolling fires pollAll immediately on start', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let fetchCount = 0;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => {
      fetchCount += 1;
      return { timestamp: nowSec - 10 };
    },
  });

  const services = [
    { providerGlobalMetaId: 'bot-start', providerAddress: '1start', serviceName: 'start-svc' },
  ];

  svc.startPolling(() => services);

  // Give the immediate async call a tick to complete
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(fetchCount >= 1, 'fetchHeartbeat should have been called at least once immediately');

  svc.stopPolling();
});

test('stopPolling prevents further polling ticks', async () => {
  let fetchCount = 0;

  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => {
      fetchCount += 1;
      return null;
    },
  });

  svc.startPolling(() => []);
  svc.stopPolling();

  // Wait a bit to ensure no extra calls happen
  await new Promise((resolve) => setTimeout(resolve, 50));
  const countAfterStop = fetchCount;

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fetchCount, countAfterStop, 'No additional fetches should occur after stopPolling');
});

// ---------------------------------------------------------------------------
// fetchHeartbeatFromChain export check
// ---------------------------------------------------------------------------

test('fetchHeartbeatFromChain is exported as a function', () => {
  assert.equal(typeof fetchHeartbeatFromChain, 'function');
});

test('getDiscoverySnapshot exposes bots, services, and provider debug state consistently', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const svc = new HeartbeatPollingService({
    fetchHeartbeat: async () => ({ timestamp: nowSec - 10, source: 'local' }),
  });

  await svc.pollAll([
    { providerGlobalMetaId: 'bot-snapshot', providerAddress: 'mvc-provider-address', serviceName: 'svc-snapshot' },
  ]);

  const snapshot = svc.getDiscoverySnapshot();
  assert.equal(snapshot.onlineBots['bot-snapshot'], nowSec - 10);
  assert.equal(snapshot.availableServices.length, 1);
  assert.equal(snapshot.providers['bot-snapshot::mvc-provider-address']?.online, true);
});
