import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  applyLocalServiceState,
  isServiceRowVisible,
  resolveCurrentMarketplaceServices,
  resolveCurrentServiceChains,
  resolveServiceActionAvailability,
} = require('../dist-electron/services/gigSquareServiceStateService.js');

test('resolveCurrentServiceChains keeps create row when no modify exists', () => {
  const view = resolveCurrentServiceChains([
    {
      id: 'svc-root',
      pinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      operation: 'create',
      status: 0,
      updatedAt: 1_000,
    },
  ]);

  assert.deepEqual(view.map((item) => item.currentPinId), ['svc-root']);
  assert.deepEqual(view[0].chainPinIds, ['svc-root']);
});

test('resolveCurrentServiceChains keeps only the newest visible modify pin', () => {
  const view = resolveCurrentServiceChains([
    { id: 'svc-root', pinId: 'svc-root', sourceServicePinId: 'svc-root', operation: 'create', status: 1, updatedAt: 1_000 },
    { id: 'svc-m1', pinId: 'svc-m1', sourceServicePinId: 'svc-root', operation: 'modify', status: 1, updatedAt: 2_000 },
    { id: 'svc-m2', pinId: 'svc-m2', sourceServicePinId: 'svc-root', operation: 'modify', status: 0, updatedAt: 3_000 },
  ]);

  assert.deepEqual(view.map((item) => item.currentPinId), ['svc-m2']);
  assert.equal(view[0].sourceServicePinId, 'svc-root');
});

test('resolveCurrentServiceChains hides revoked chains', () => {
  const view = resolveCurrentServiceChains([
    { id: 'svc-root', pinId: 'svc-root', sourceServicePinId: 'svc-root', operation: 'create', status: 1, updatedAt: 1_000 },
    { id: 'svc-m1', pinId: 'svc-m1', sourceServicePinId: 'svc-root', operation: 'modify', status: 1, updatedAt: 2_000 },
    { id: 'svc-r1', pinId: 'svc-r1', sourceServicePinId: 'svc-root', operation: 'revoke', status: 0, updatedAt: 3_000 },
  ]);

  assert.deepEqual(view, []);
});

test('isServiceRowVisible rejects status 1, revoked, and invalid negative rows', () => {
  assert.equal(isServiceRowVisible({ status: 1, operation: 'create' }), false);
  assert.equal(isServiceRowVisible({ status: -1, operation: 'create' }), false);
  assert.equal(isServiceRowVisible({ status: -2, operation: 'modify' }), false);
  assert.equal(isServiceRowVisible({ status: 0, operation: 'revoke' }), false);
  assert.equal(isServiceRowVisible({ status: 0, operation: 'modify' }), true);
});

test('resolveServiceActionAvailability blocks services with active seller orders', () => {
  const availability = resolveServiceActionAvailability({
    currentService: {
      currentPinId: 'svc-m2',
      sourceServicePinId: 'svc-root',
      chainPinIds: ['svc-root', 'svc-m1', 'svc-m2'],
    },
    sellerOrders: [
      { id: 'order-open', servicePinId: 'svc-m1', status: 'in_progress' },
    ],
    creatorMetabotExists: true,
  });

  assert.equal(availability.canModify, false);
  assert.equal(availability.canRevoke, false);
  assert.equal(availability.blockedReason, 'gigSquareMyServicesBlockedActiveOrders');
});

test('applyLocalServiceState hides a current service when the matching local service record is revoked', () => {
  const remoteView = resolveCurrentServiceChains([
    { id: 'svc-root', pinId: 'svc-root', sourceServicePinId: 'svc-root', operation: 'create', status: 0, updatedAt: 1_000, displayName: 'Weather' },
  ]);

  const visible = applyLocalServiceState(remoteView, [
    {
      id: 'svc-root',
      pinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      currentPinId: 'svc-root',
      displayName: 'Weather',
      revokedAt: 2_000,
      updatedAt: 2_000,
    },
  ]);

  assert.deepEqual(visible, []);
});

test('applyLocalServiceState exposes locally modified current pin and content for marketplace rendering', () => {
  const remoteView = resolveCurrentServiceChains([
    {
      id: 'svc-root',
      pinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      operation: 'create',
      status: 0,
      updatedAt: 1_000,
      displayName: 'Weather V1',
      description: 'old',
      price: '1',
      currency: 'SPACE',
      providerSkill: 'weather',
    },
  ]);

  const visible = applyLocalServiceState(remoteView, [
    {
      id: 'svc-root',
      pinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      currentPinId: 'svc-modify-local',
      displayName: 'Weather V2',
      description: 'new',
      price: '2',
      currency: 'SPACE',
      providerSkill: 'weather-pro',
      updatedAt: 2_000,
    },
  ]);

  assert.equal(visible.length, 1);
  assert.equal(visible[0].currentPinId, 'svc-modify-local');
  assert.equal(visible[0].sourceServicePinId, 'svc-root');
  assert.equal(visible[0].displayName, 'Weather V2');
  assert.equal(visible[0].description, 'new');
  assert.equal(visible[0].price, '2');
  assert.equal(visible[0].providerSkill, 'weather-pro');
  assert.deepEqual(visible[0].chainPinIds, ['svc-root', 'svc-modify-local']);
});

test('resolveCurrentMarketplaceServices keeps only the latest visible modified row for discovery and prompt data', () => {
  assert.equal(typeof resolveCurrentMarketplaceServices, 'function');

  const visible = resolveCurrentMarketplaceServices(
    [
      {
        id: 'svc-root',
        pinId: 'svc-root',
        sourceServicePinId: 'svc-root',
        operation: 'create',
        status: 1,
        updatedAt: 1_000,
        displayName: 'Weather V1',
        description: 'old',
        price: '1',
        currency: 'SPACE',
        providerGlobalMetaId: 'provider-1',
        providerAddress: 'addr-1',
      },
      {
        id: 'svc-modify',
        pinId: 'svc-modify',
        sourceServicePinId: 'svc-root',
        operation: 'modify',
        status: 0,
        updatedAt: 2_000,
        displayName: 'Weather V2',
        description: 'new',
        price: '2',
        currency: 'SPACE',
        providerGlobalMetaId: 'provider-1',
        providerAddress: 'addr-1',
      },
    ],
    []
  );

  assert.equal(visible.length, 1);
  assert.equal(visible[0].currentPinId, 'svc-modify');
  assert.equal(visible[0].sourceServicePinId, 'svc-root');
  assert.equal(visible[0].displayName, 'Weather V2');
  assert.equal(visible[0].description, 'new');
  assert.equal(visible[0].price, '2');
});
