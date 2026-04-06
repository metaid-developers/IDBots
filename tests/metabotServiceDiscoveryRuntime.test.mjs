import test from 'node:test';
import assert from 'node:assert/strict';

test('listCallablePortableServices syncs MetaWeb records and filters them through provider discovery truth', async () => {
  const syncCalls = [];
  const { listCallablePortableServices } = await import('../dist-electron/metabotRuntime/serviceDiscoveryRuntime.js');

  const resolved = await listCallablePortableServices({
    syncRemoteServices: async ({ upsertService }) => {
      syncCalls.push('sync');
      upsertService({ pinId: 'pin-online', providerGlobalMetaId: 'idq1provider', providerAddress: '1abc', serviceName: 'Translator', available: 1, status: 1 });
      upsertService({ pinId: 'pin-offline', providerGlobalMetaId: 'idq1offline', providerAddress: '1def', serviceName: 'Writer', available: 1, status: 1 });
    },
    listSyncedServices: () => [
      { pinId: 'pin-online', providerGlobalMetaId: 'idq1provider', providerAddress: '1abc', serviceName: 'Translator', available: 1, status: 1 },
      { pinId: 'pin-offline', providerGlobalMetaId: 'idq1offline', providerAddress: '1def', serviceName: 'Writer', available: 1, status: 1 },
    ],
    getDiscoverySnapshot: () => ({
      availableServices: [
        { pinId: 'pin-online', providerGlobalMetaId: 'idq1provider', providerAddress: '1abc', serviceName: 'Translator' },
      ],
    }),
  });

  assert.deepEqual(syncCalls, ['sync']);
  assert.deepEqual(resolved.map((item) => item.pinId), ['pin-online']);
});
