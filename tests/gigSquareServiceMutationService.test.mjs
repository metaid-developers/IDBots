import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  buildGigSquareLocalServiceRecordForModify,
  buildGigSquareLocalServiceRecordForRevoke,
  validateGigSquareServiceMutation,
  normalizeGigSquareModifyDraft,
  validateGigSquareModifyDraft,
  buildGigSquareServicePayload,
  buildGigSquareRevokeMetaidPayload,
  buildGigSquareModifyMetaidPayload,
} = require('../dist-electron/services/gigSquareServiceMutationService.js');

test('validateGigSquareServiceMutation rejects missing target service', () => {
  const result = validateGigSquareServiceMutation({
    action: 'revoke',
    service: null,
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'service_not_found');
});

test('validateGigSquareServiceMutation enforces creator metabot wallet ownership', () => {
  const result = validateGigSquareServiceMutation({
    action: 'modify',
    service: {
      currentPinId: 'svc-current',
      creatorMetabotId: null,
      canModify: true,
      canRevoke: true,
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'gigSquareMyServicesBlockedMissingCreatorMetabot');
});

test('validateGigSquareServiceMutation returns blocked reason code when action is disabled', () => {
  const result = validateGigSquareServiceMutation({
    action: 'revoke',
    service: {
      currentPinId: 'svc-current',
      creatorMetabotId: 7,
      canModify: true,
      canRevoke: false,
      blockedReason: 'gigSquareMyServicesBlockedActiveOrders',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'gigSquareMyServicesBlockedActiveOrders');
});

test('normalizeGigSquareModifyDraft normalizes currency and output type', () => {
  const normalized = normalizeGigSquareModifyDraft({
    serviceName: ' weather ',
    displayName: ' Weather ',
    description: ' desc ',
    providerSkill: ' sky ',
    price: '0.1',
    currency: 'space',
    outputType: 'TEXT',
  });

  assert.equal(normalized.currency, 'MVC');
  assert.equal(normalized.outputType, 'text');
  assert.equal(normalized.serviceName, 'weather');
});

test('validateGigSquareModifyDraft rejects price beyond currency limit', () => {
  const result = validateGigSquareModifyDraft({
    serviceName: 'svc',
    displayName: 'SVC',
    description: 'desc',
    providerSkill: 'skill',
    price: '2',
    currency: 'BTC',
    outputType: 'text',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'price_limit_exceeded');
});

test('buildGigSquareServicePayload and pin payload helpers produce metaid-compliant structures', () => {
  const payload = buildGigSquareServicePayload({
    draft: {
      serviceName: 'weather',
      displayName: 'Weather',
      description: 'desc',
      providerSkill: 'forecast',
      price: '0.0001',
      currency: 'SPACE',
      outputType: 'text',
      serviceIconUri: 'metafile://icon-pin',
    },
    providerGlobalMetaId: 'global-metaid-1',
    paymentAddress: '1abc',
  });

  assert.equal(payload.currency, 'MVC');
  assert.equal(payload.providerMetaBot, 'global-metaid-1');
  assert.equal(payload.paymentAddress, '1abc');

  const revokePayload = buildGigSquareRevokeMetaidPayload('pin-1');
  assert.equal(revokePayload.operation, 'revoke');
  assert.equal(revokePayload.path, '@pin-1');
  assert.equal(revokePayload.payload, '');

  const modifyPayload = buildGigSquareModifyMetaidPayload({
    targetPinId: 'pin-2',
    payloadJson: JSON.stringify(payload),
  });
  assert.equal(modifyPayload.operation, 'modify');
  assert.equal(modifyPayload.path, '@pin-2');
  assert.equal(typeof modifyPayload.payload, 'string');
});

test('buildGigSquareLocalServiceRecordForRevoke creates a local overlay row for a remotely discovered owned service', () => {
  const record = buildGigSquareLocalServiceRecordForRevoke({
    service: {
      id: 'svc-root',
      currentPinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      creatorMetabotId: 7,
      providerGlobalMetaId: 'owner-global',
      providerSkill: 'weather',
      serviceName: 'weather-service',
      displayName: 'Weather',
      description: 'desc',
      serviceIcon: 'metafile://icon-pin',
      price: '0.0001',
      currency: 'SPACE',
      outputType: 'text',
    },
    now: 1_777_000_000_000,
  });

  assert.equal(record.id, 'svc-root');
  assert.equal(record.pinId, 'svc-root');
  assert.equal(record.sourceServicePinId, 'svc-root');
  assert.equal(record.currentPinId, 'svc-root');
  assert.equal(record.metabotId, 7);
  assert.equal(record.revokedAt, 1_777_000_000_000);
});

test('buildGigSquareLocalServiceRecordForModify creates a local overlay row when the service has no existing local publish record', () => {
  const record = buildGigSquareLocalServiceRecordForModify({
    service: {
      id: 'svc-root',
      currentPinId: 'svc-root',
      sourceServicePinId: 'svc-root',
      creatorMetabotId: 7,
      providerGlobalMetaId: 'owner-global',
      providerSkill: 'weather',
      serviceName: 'weather-service',
      displayName: 'Weather',
      description: 'desc',
      price: '0.0001',
      currency: 'SPACE',
      outputType: 'text',
    },
    currentPinId: 'svc-modify-1',
    providerSkill: 'weather-pro',
    serviceName: 'weather-service-v2',
    displayName: 'Weather Pro',
    description: 'better desc',
    serviceIcon: 'metafile://icon-2',
    price: '0.0002',
    currency: 'SPACE',
    outputType: 'image',
    endpoint: 'simplemsg',
    payloadJson: '{"displayName":"Weather Pro"}',
    now: 1_777_000_000_001,
  });

  assert.equal(record.id, 'svc-root');
  assert.equal(record.pinId, 'svc-root');
  assert.equal(record.sourceServicePinId, 'svc-root');
  assert.equal(record.currentPinId, 'svc-modify-1');
  assert.equal(record.providerSkill, 'weather-pro');
  assert.equal(record.displayName, 'Weather Pro');
  assert.equal(record.outputType, 'image');
  assert.equal(record.revokedAt, null);
});
