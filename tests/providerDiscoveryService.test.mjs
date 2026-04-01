import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadProviderDiscoveryService() {
  return require('../dist-electron/services/providerDiscoveryService.js');
}

function createHeartbeatStub(snapshotOverrides = {}) {
  const baseSnapshot = {
    onlineBots: {},
    availableServices: [],
    providers: {},
  };

  const snapshot = {
    ...baseSnapshot,
    ...snapshotOverrides,
  };

  let listener = null;

  return {
    refreshCount: 0,
    startPollingCount: 0,
    stopPollingCount: 0,
    recordLocalHeartbeatCalls: [],
    markOfflineCalls: [],
    forceOfflineCalls: [],
    clearForceOfflineCalls: [],
    startPolling(getServices) {
      this.startPollingCount += 1;
      this.getServices = getServices;
    },
    stopPolling() {
      this.stopPollingCount += 1;
    },
    async refreshNow() {
      this.refreshCount += 1;
      return undefined;
    },
    recordLocalHeartbeat(input) {
      this.recordLocalHeartbeatCalls.push(input);
    },
    markOffline(globalMetaId) {
      this.markOfflineCalls.push(globalMetaId);
    },
    forceOffline(globalMetaId) {
      this.forceOfflineCalls.push(globalMetaId);
    },
    clearForceOffline(globalMetaId) {
      this.clearForceOfflineCalls.push(globalMetaId);
    },
    getDiscoverySnapshot() {
      return structuredClone(snapshot);
    },
    subscribe(nextListener) {
      listener = nextListener;
      return () => {
        if (listener === nextListener) {
          listener = null;
        }
      };
    },
    emit(snapshotUpdate = snapshot) {
      if (listener) {
        listener(structuredClone(snapshotUpdate));
      }
    },
  };
}

test('provider discovery uses presence onlineBots when presence is healthy', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub({
    onlineBots: { idq1fallback: 10 },
    availableServices: [{ providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' }],
  });
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 2,
      onlineBots: {
        idq1providera: {
          lastSeenSec: 123,
          expiresAtSec: 178,
          peerIds: ['peer-a'],
        },
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 170,
    }),
    now: () => 170_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
    { globalMetaId: 'idq1providerb', providerAddress: 'mvc-b', serviceName: 'bravo' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 123 });
  assert.equal(snapshot.availableServices.length, 1);
  assert.equal(snapshot.availableServices[0].serviceName, 'alpha');
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, true);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'presence');
  assert.equal(snapshot.providers['idq1providerb::mvc-b'].online, false);
  assert.equal(heartbeat.refreshCount, 0);
});

test('provider discovery does not fall back when presence is healthy and empty', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub({
    onlineBots: { idq1fallback: 50 },
    availableServices: [{ providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' }],
  });
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 1,
      onlineBots: {},
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 90,
    }),
    now: () => 90_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(heartbeat.refreshCount, 0);
});

test('provider discovery falls back when presence is unhealthy', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeatSnapshot = {
    onlineBots: { idq1fallback: 55 },
    availableServices: [{ providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' }],
    providers: {
      'idq1fallback::mvc-fallback': {
        key: 'idq1fallback::mvc-fallback',
        globalMetaId: 'idq1fallback',
        address: 'mvc-fallback',
        lastSeenSec: 55,
        lastCheckAt: 60,
        lastSource: 'remote',
        lastError: null,
        online: true,
        optimisticLocal: false,
      },
    },
  };
  const heartbeat = createHeartbeatStub(heartbeatSnapshot);
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: false,
      peerCount: 0,
      onlineBots: {},
      unhealthyReason: 'no_active_peers',
      lastConfigReloadError: null,
      nowSec: 60,
    }),
    now: () => 60_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' },
  ]);
  await service.refreshNow();

  assert.equal(heartbeat.refreshCount, 2);
  assert.deepEqual(service.getDiscoverySnapshot(), heartbeatSnapshot);
});

test('provider discovery only emits on material changes unless rebroadcast is requested', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub();
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 2,
      onlineBots: {
        idq1providera: {
          lastSeenSec: 111,
          expiresAtSec: 166,
          peerIds: ['peer-a'],
        },
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 140,
    }),
    now: () => 140_000,
  });

  const snapshots = [];
  service.subscribe((snapshot) => {
    snapshots.push(snapshot);
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);

  await service.refreshNow();
  await service.refreshNow();
  await service.refreshNow({ rebroadcast: true });

  assert.equal(snapshots.length, 2);
  assert.deepEqual(snapshots[0], snapshots[1]);
});

test('provider discovery preserves the control surface main still uses', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub();
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 1,
      onlineBots: {},
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 1,
    }),
    now: () => 1_000,
  });

  service.recordLocalHeartbeat({ globalMetaId: 'idq1alpha', address: 'mvc-a', timestampSec: 1 });
  service.markOffline('idq1beta');
  service.forceOffline('idq1gamma');
  service.clearForceOffline('idq1gamma');

  assert.deepEqual(heartbeat.recordLocalHeartbeatCalls, [{ globalMetaId: 'idq1alpha', address: 'mvc-a', timestampSec: 1 }]);
  assert.deepEqual(heartbeat.markOfflineCalls, ['idq1beta']);
  assert.deepEqual(heartbeat.forceOfflineCalls, ['idq1gamma']);
  assert.deepEqual(heartbeat.clearForceOfflineCalls, ['idq1gamma']);
});

test('provider discovery markOffline removes a presence-backed provider from the active snapshot immediately', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub();
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 2,
      onlineBots: {
        idq1providera: {
          lastSeenSec: 123,
          expiresAtSec: 178,
          peerIds: ['peer-a'],
        },
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 170,
    }),
    now: () => 170_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();

  service.markOffline('idq1providera');

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);
});

test('provider discovery forceOffline survives stale local heartbeat records until explicitly cleared', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const heartbeat = createHeartbeatStub();
  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: true,
      peerCount: 2,
      onlineBots: {
        idq1providera: {
          lastSeenSec: 123,
          expiresAtSec: 178,
          peerIds: ['peer-a'],
        },
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 170,
    }),
    now: () => 170_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();

  service.forceOffline('idq1providera');
  await service.refreshNow();

  let snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);

  service.recordLocalHeartbeat({ globalMetaId: 'idq1providera', address: 'mvc-a', timestampSec: 171 });
  await service.refreshNow();

  snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);

  service.clearForceOffline('idq1providera');
  await service.refreshNow();

  snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 123 });
  assert.equal(snapshot.availableServices.length, 1);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, true);
});

test('provider discovery keeps a forced-offline provider suppressed while presence is unhealthy until explicitly cleared', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const { HeartbeatPollingService } = require('../dist-electron/services/heartbeatPollingService.js');

  const heartbeat = new HeartbeatPollingService({
    now: () => 170_000,
    fetchHeartbeat: async () => null,
  });

  const service = new ProviderDiscoveryService({
    heartbeat,
    fetchPresence: async () => ({
      healthy: false,
      peerCount: 0,
      onlineBots: {},
      unhealthyReason: 'no_active_peers',
      lastConfigReloadError: null,
      nowSec: 170,
    }),
    now: () => 170_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);

  service.recordLocalHeartbeat({ globalMetaId: 'idq1providera', address: 'mvc-a', timestampSec: 123 });
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, { idq1providera: 123 });

  service.forceOffline('idq1providera');
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, {});

  service.recordLocalHeartbeat({ globalMetaId: 'idq1providera', address: 'mvc-a', timestampSec: 171 });
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, {});

  service.clearForceOffline('idq1providera');
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, { idq1providera: 171 });
  service.dispose();
});
