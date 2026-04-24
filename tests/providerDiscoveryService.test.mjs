import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadProviderDiscoveryService() {
  return require('../dist-electron/services/providerDiscoveryService.js');
}

function createPresenceStub(statuses = {}, options = {}) {
  return {
    statusCalls: [],
    async fetchOnlineStatus(globalMetaIds) {
      this.statusCalls.push([...globalMetaIds]);
      if (options.fail) {
        throw new Error(options.fail);
      }
      return {
        total: globalMetaIds.length,
        onlineCount: globalMetaIds.filter((id) => statuses[id]?.isOnline).length,
        list: globalMetaIds.map((id) => ({
          globalMetaId: id,
          isOnline: Boolean(statuses[id]?.isOnline),
          lastSeenAt: statuses[id]?.lastSeenAt ?? 0,
          lastSeenAgoSeconds: statuses[id]?.lastSeenAgoSeconds ?? 0,
          deviceCount: statuses[id]?.deviceCount ?? 0,
        })),
      };
    },
  };
}

function healthyP2PPresence(onlineBots = {}) {
  return {
    healthy: true,
    peerCount: Object.keys(onlineBots).length > 0 ? 1 : 0,
    onlineBots,
    unhealthyReason: null,
    lastConfigReloadError: null,
    nowSec: 200,
  };
}

test('provider discovery queries idchat online-status for unique service provider globalMetaIds', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 2 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence({ idq1providerb: { lastSeenSec: 190, expiresAtSec: 260, peerIds: ['peer-b'] } }),
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: ' IDQ1ProviderA ', providerAddress: 'mvc-a', serviceName: 'alpha' },
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a2', serviceName: 'alpha copy' },
    { providerGlobalMetaId: 'idq1providerb', providerAddress: 'mvc-b', serviceName: 'bravo' },
  ]);
  presence.statusCalls.length = 0;
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(presence.statusCalls, [['idq1providera', 'idq1providerb']]);
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 171 });
  assert.deepEqual(snapshot.availableServices.map((entry) => entry.serviceName), ['alpha', 'alpha copy']);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, true);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'idchat');
  assert.equal(snapshot.providers['idq1providerb::mvc-b'].online, false);
});

test('provider discovery falls back to P2P presence only when idchat online-status fails', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({}, { fail: 'idchat unavailable' });
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence({
      idq1providera: { lastSeenSec: 190, expiresAtSec: 260, peerIds: ['peer-a'] },
    }),
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
    { providerGlobalMetaId: 'idq1providerb', providerAddress: 'mvc-b', serviceName: 'bravo' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 190 });
  assert.deepEqual(snapshot.availableServices.map((entry) => entry.serviceName), ['alpha']);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'p2p_presence');
  assert.equal(snapshot.providers['idq1providerb::mvc-b'].online, false);
});

test('provider discovery does not use P2P presence when idchat says provider is offline', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: false, lastSeenAt: 199000, deviceCount: 0 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence({
      idq1providera: { lastSeenSec: 199, expiresAtSec: 260, peerIds: ['peer-a'] },
    }),
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastSource, 'idchat');
  assert.equal(snapshot.providers['idq1providera::mvc-a'].online, false);
});

test('provider discovery treats provider without globalMetaId as offline without idchat lookup', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub();
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence(),
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerAddress: 'mvc-missing', serviceName: 'missing id' },
  ]);
  await service.refreshNow();

  const snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(presence.statusCalls, []);
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['::mvc-missing'].online, false);
  assert.equal(snapshot.providers['::mvc-missing'].lastError, 'missing_global_metaid');
});

test('provider discovery keeps ping-failed provider offline until explicitly cleared', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 171000, deviceCount: 1 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence(),
    now: () => 200_000,
  });

  service.startPolling(() => [
    { providerGlobalMetaId: 'idq1providera', providerAddress: 'mvc-a', serviceName: 'alpha' },
  ]);
  await service.refreshNow();
  assert.deepEqual(service.getDiscoverySnapshot().onlineBots, { idq1providera: 171 });

  service.markOffline('idq1providera');
  await service.refreshNow();
  let snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1providera::mvc-a'].lastError, 'locally_disabled');

  service.clearForceOffline('idq1providera');
  await service.refreshNow();
  snapshot = service.getDiscoverySnapshot();
  assert.deepEqual(snapshot.onlineBots, { idq1providera: 171 });
  assert.equal(snapshot.availableServices.length, 1);
});

test('provider discovery only emits on material changes unless rebroadcast is requested', async () => {
  const { ProviderDiscoveryService } = loadProviderDiscoveryService();
  const presence = createPresenceStub({
    idq1providera: { isOnline: true, lastSeenAt: 111000, deviceCount: 1 },
  });
  const service = new ProviderDiscoveryService({
    presence,
    fetchP2PPresence: async () => healthyP2PPresence(),
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
