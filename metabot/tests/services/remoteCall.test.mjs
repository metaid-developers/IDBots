import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { planRemoteCall } = require('../../dist/core/delegation/remoteCall.js');

function createAvailableService(overrides = {}) {
  return {
    servicePinId: 'service-weather',
    providerGlobalMetaId: 'seller-global-metaid',
    serviceName: 'Weather Oracle',
    displayName: 'Weather Oracle',
    description: 'Provides weather predictions.',
    price: '0.0001',
    currency: 'SPACE',
    ratingAvg: 4.8,
    ratingCount: 12,
    ...overrides,
  };
}

test('planRemoteCall allows payment when the service price is under the spend cap', () => {
  const result = planRemoteCall({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'seller-global-metaid',
      userTask: 'check tomorrow weather',
      taskContext: 'Shanghai tomorrow weather',
      rawRequest: '帮我看看明天上海天气',
      spendCap: {
        amount: '0.0002',
        currency: 'SPACE',
      },
    },
    availableServices: [createAvailableService()],
    sessionId: 'cowork-session-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.state, 'ready');
  assert.equal(result.service.servicePinId, 'service-weather');
  assert.equal(result.payment.amount, '0.0001');
  assert.equal(result.payment.currency, 'SPACE');
});

test('planRemoteCall blocks payment before broadcast when the service price exceeds the spend cap', () => {
  const result = planRemoteCall({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'seller-global-metaid',
      userTask: 'check tomorrow weather',
      taskContext: 'Shanghai tomorrow weather',
      spendCap: {
        amount: '0.00001',
        currency: 'SPACE',
      },
    },
    availableServices: [createAvailableService()],
    sessionId: 'cowork-session-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'blocked');
  assert.equal(result.code, 'spend_cap_exceeded');
  assert.match(result.message, /spend cap/i);
});

test('planRemoteCall returns offline when the requested remote service is not available', () => {
  const result = planRemoteCall({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'seller-global-metaid',
      userTask: 'check tomorrow weather',
      taskContext: 'Shanghai tomorrow weather',
    },
    availableServices: [
      createAvailableService({
        servicePinId: 'other-service',
      }),
    ],
    sessionId: 'cowork-session-1',
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'offline');
  assert.equal(result.code, 'service_offline');
});

test('planRemoteCall returns a trace id and linked session metadata for successful calls', () => {
  const result = planRemoteCall({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'seller-global-metaid',
      userTask: 'check tomorrow weather',
      taskContext: 'Shanghai tomorrow weather',
    },
    availableServices: [createAvailableService()],
    sessionId: 'cowork-session-1',
    traceId: 'trace-weather-order-1',
  });

  assert.equal(result.ok, true);
  assert.equal(result.traceId, 'trace-weather-order-1');
  assert.deepEqual(result.session, {
    coworkSessionId: 'cowork-session-1',
    externalConversationId: 'metaweb_order:buyer:seller-global-metaid:trace-weather-or',
  });
});

test('planRemoteCall surfaces manual_action_required when refund follow-up must be handled by a human', () => {
  const result = planRemoteCall({
    request: {
      servicePinId: 'service-weather',
      providerGlobalMetaId: 'seller-global-metaid',
      userTask: 'check tomorrow weather',
      taskContext: 'Shanghai tomorrow weather',
    },
    availableServices: [createAvailableService()],
    sessionId: 'cowork-session-1',
    traceId: 'trace-weather-order-1',
    manualRefundRequired: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.state, 'manual_action_required');
  assert.equal(result.code, 'manual_refund_required');
  assert.equal(result.traceId, 'trace-weather-order-1');
  assert.equal(result.session.coworkSessionId, 'cowork-session-1');
});
