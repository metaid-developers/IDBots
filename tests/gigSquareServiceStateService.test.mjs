import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  resolveServiceActionAvailability,
  applyLocalServiceState,
} = require('../dist-electron/services/gigSquareServiceStateService.js');

const BASE_CURRENT_SERVICE = {
  currentPinId: 'svc-pin-1',
  sourceServicePinId: 'svc-pin-1',
  chainPinIds: ['svc-pin-1'],
  status: 0,
  operation: 'create',
  available: 1,
};

test('resolveServiceActionAvailability allows local service mutation even when paid seller orders are active', () => {
  const result = resolveServiceActionAvailability({
    currentService: BASE_CURRENT_SERVICE,
    creatorMetabotExists: true,
    sellerOrders: [{
      servicePinId: 'svc-pin-1',
      status: 'in_progress',
      paymentAmount: '0.01',
    }],
  });

  assert.equal(result.canModify, true);
  assert.equal(result.canRevoke, true);
  assert.equal(result.blockedReason, null);
});

test('resolveServiceActionAvailability allows mutation when only free seller orders are active', () => {
  const result = resolveServiceActionAvailability({
    currentService: BASE_CURRENT_SERVICE,
    creatorMetabotExists: true,
    sellerOrders: [{
      servicePinId: 'svc-pin-1',
      status: 'in_progress',
      paymentAmount: '0',
    }],
  });

  assert.equal(result.canModify, true);
  assert.equal(result.canRevoke, true);
  assert.equal(result.blockedReason, null);
});

test('resolveServiceActionAvailability still blocks non-current services', () => {
  const result = resolveServiceActionAvailability({
    currentService: BASE_CURRENT_SERVICE,
    creatorMetabotExists: true,
    isCurrent: false,
  });

  assert.equal(result.canModify, false);
  assert.equal(result.canRevoke, false);
  assert.equal(result.blockedReason, 'gigSquareMyServicesBlockedNotCurrent');
});

test('resolveServiceActionAvailability still blocks revoked services', () => {
  const result = resolveServiceActionAvailability({
    currentService: BASE_CURRENT_SERVICE,
    creatorMetabotExists: true,
    isRevoked: true,
  });

  assert.equal(result.canModify, false);
  assert.equal(result.canRevoke, false);
  assert.equal(result.blockedReason, 'gigSquareMyServicesBlockedRevoked');
});

test('resolveServiceActionAvailability still blocks services without a creator metabot wallet', () => {
  const result = resolveServiceActionAvailability({
    currentService: BASE_CURRENT_SERVICE,
    creatorMetabotExists: false,
  });

  assert.equal(result.canModify, false);
  assert.equal(result.canRevoke, false);
  assert.equal(result.blockedReason, 'gigSquareMyServicesBlockedMissingCreatorMetabot');
});

test('applyLocalServiceState treats an empty execution reminder as an explicit local clear', () => {
  const services = [{
    id: 'svc-root',
    pinId: 'svc-current',
    currentPinId: 'svc-current',
    sourceServicePinId: 'svc-root',
    chainPinIds: ['svc-root', 'svc-current'],
    serviceName: 'weather-service',
    displayName: 'Weather Service',
    description: 'Weather lookup',
    executionReminder: '旧的远端执行提醒',
    price: '0',
    currency: 'SPACE',
    updatedAt: 100,
  }];
  const localRecords = [{
    id: 'svc-root',
    pinId: 'svc-root',
    currentPinId: 'svc-current',
    sourceServicePinId: 'svc-root',
    executionReminder: '',
    updatedAt: 200,
  }];

  const [resolved] = applyLocalServiceState(services, localRecords);

  assert.equal(resolved.executionReminder, '');
});
