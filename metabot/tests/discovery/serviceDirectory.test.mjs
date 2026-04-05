import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildPresenceSnapshot
} = require('../../dist/core/discovery/serviceDirectory.js');
const {
  resolveDelegationOrderability
} = require('../../dist/core/discovery/orderability.js');
const {
  rankServicesForDirectory
} = require('../../dist/core/discovery/serviceRanking.js');

test('buildPresenceSnapshot treats healthy-empty presence as authoritative', () => {
  const snapshot = buildPresenceSnapshot(
    [
      { providerGlobalMetaId: 'idq1fallback', providerAddress: 'mvc-fallback', serviceName: 'fallback' }
    ],
    {
      healthy: true,
      peerCount: 1,
      onlineBots: {},
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 90
    },
    90,
    new Set()
  );

  assert.deepEqual(snapshot.onlineBots, {});
  assert.deepEqual(snapshot.availableServices, []);
  assert.equal(snapshot.providers['idq1fallback::mvc-fallback']?.online, false);
  assert.equal(snapshot.providers['idq1fallback::mvc-fallback']?.lastSource, 'presence');
});

test('buildPresenceSnapshot matches services case-insensitively against normalized presence onlineBots', () => {
  const snapshot = buildPresenceSnapshot(
    [
      { providerGlobalMetaId: ' IDQ1ProviderA ', providerAddress: 'mvc-a', serviceName: 'alpha' }
    ],
    {
      healthy: true,
      peerCount: 2,
      onlineBots: {
        idq1providera: {
          lastSeenSec: 123,
          expiresAtSec: 178,
          peerIds: ['peer-a']
        }
      },
      unhealthyReason: null,
      lastConfigReloadError: null,
      nowSec: 170
    },
    170,
    new Set()
  );

  assert.deepEqual(snapshot.onlineBots, { idq1providera: 123 });
  assert.equal(snapshot.availableServices.length, 1);
  assert.equal(snapshot.providers['idq1providera::mvc-a']?.online, true);
});

test('resolveDelegationOrderability returns offline when a service is absent from availableServices but still exists in allServices', () => {
  const result = resolveDelegationOrderability({
    availableServices: [{ pinId: 'other-pin', providerGlobalMetaId: 'idq1other' }],
    allServices: [{ pinId: 'pin123', providerGlobalMetaId: ' IDQ1Provider ', serviceName: 'Test Service' }],
    servicePinId: 'pin123',
    providerGlobalMetaId: 'idq1provider'
  });

  assert.deepEqual(result, {
    status: 'offline',
    service: null
  });
});

test('rankServicesForDirectory sorts online providers ahead of offline ones, then by signal', () => {
  const sorted = rankServicesForDirectory(
    [
      { serviceName: 'older online', providerGlobalMetaId: 'idq1online', updatedAt: 10, ratingCount: 1 },
      { serviceName: 'newer offline', providerGlobalMetaId: 'idq1offline', updatedAt: 100, ratingCount: 5 },
      { serviceName: 'newer online', providerGlobalMetaId: 'idq1online', updatedAt: 50, ratingCount: 2 }
    ],
    { idq1online: 123 }
  );

  assert.deepEqual(sorted.map((entry) => entry.serviceName), [
    'newer online',
    'older online',
    'newer offline'
  ]);
});
