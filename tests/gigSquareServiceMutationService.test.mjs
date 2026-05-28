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
  resolveGigSquareSettlementPaymentAddress,
  buildGigSquareRevokeMetaidPayload,
  buildGigSquareModifyMetaidPayload,
} = require('../dist-electron/services/gigSquareServiceMutationService.js');
const {
  normalizeGigSquareSettlementDraft,
} = require('../dist-electron/shared/gigSquareSettlementAsset.js');

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

test('normalizeGigSquareModifyDraft normalizes network aliases to currency units', () => {
  const normalized = normalizeGigSquareModifyDraft({
    serviceName: ' weather ',
    displayName: ' Weather ',
    description: ' desc ',
    providerSkills: [' sky ', '', 'report-writer', 'sky'],
    price: '0.1',
    currency: 'space',
    outputType: 'TEXT',
  });

  assert.equal(normalized.currency, 'SPACE');
  assert.equal(normalized.outputType, 'text');
  assert.equal(normalized.serviceName, 'weather');
  assert.deepEqual(normalized.providerSkills, ['sky', 'report-writer']);
  assert.equal(normalized.providerSkill, 'sky');

  assert.equal(
    normalizeGigSquareModifyDraft({
      serviceName: 'svc',
      displayName: 'SVC',
      description: 'desc',
      providerSkill: 'skill',
      price: '0.1',
      currency: 'mvc',
      outputType: 'text',
    }).currency,
    'SPACE',
  );

  assert.equal(
    normalizeGigSquareModifyDraft({
      serviceName: 'svc',
      displayName: 'SVC',
      description: 'desc',
      providerSkill: 'skill',
      price: '0.1',
      currency: 'Bitcoin',
      outputType: 'text',
    }).currency,
    'BTC',
  );
});

test('normalizeGigSquareModifyDraft keeps legacy providerSkill string compatibility', () => {
  const normalized = normalizeGigSquareModifyDraft({
    serviceName: 'svc',
    displayName: 'SVC',
    description: 'desc',
    providerSkill: ' legacy-weather ',
    price: '0',
    currency: 'MVC',
    outputType: 'text',
  });

  assert.deepEqual(normalized.providerSkills, ['legacy-weather']);
  assert.equal(normalized.providerSkill, 'legacy-weather');
});

test('validateGigSquareModifyDraft rejects empty or invalid provider skill allow-lists', () => {
  for (const providerSkills of [[], [' ', ''], [null, undefined]]) {
    const result = validateGigSquareModifyDraft({
      serviceName: 'svc',
      displayName: 'SVC',
      description: 'desc',
      providerSkills,
      price: '0',
      currency: 'SPACE',
      outputType: 'text',
    });

    assert.equal(result.ok, false);
    assert.equal(result.errorCode, 'provider_skill_required');
  }
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

test('validateGigSquareModifyDraft accepts zero price for free services', () => {
  const result = validateGigSquareModifyDraft({
    serviceName: 'svc',
    displayName: 'SVC',
    description: 'desc',
    providerSkill: 'skill',
    price: '0',
    currency: 'SPACE',
    outputType: 'text',
  });

  assert.equal(result.ok, true);
});

test('validateGigSquareModifyDraft rejects prepaid services without a positive price', () => {
  const result = validateGigSquareModifyDraft({
    serviceName: 'svc',
    displayName: 'SVC',
    description: 'desc',
    providerSkill: 'skill',
    paymentTiming: 'prepaid',
    price: '0',
    currency: 'SPACE',
    outputType: 'text',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'price_positive_required');
});

test('validateGigSquareModifyDraft rejects MRC20 v1.1 publish drafts', () => {
  const result = validateGigSquareModifyDraft({
    serviceName: 'svc',
    displayName: 'SVC',
    description: 'desc',
    providerSkill: 'skill',
    price: '1',
    currency: 'MRC20',
    mrc20Ticker: 'meta-id',
    mrc20Id: 'tick-metaid',
    outputType: 'text',
  });

  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'currency_invalid');
  assert.match(result.error || '', /currency is invalid/);
});

test('buildGigSquareServicePayload builds free skill-service v1.1 payloads without tuple or legacy payment fields', () => {
  const payload = buildGigSquareServicePayload({
    draft: {
      serviceName: 'weather',
      displayName: 'Weather',
      description: 'desc',
      providerSkills: ['weather', 'report-writer'],
      paymentTiming: 'free',
      price: '99',
      currency: 'MVC',
      outputType: 'text',
      serviceIconUri: 'metafile://icon-pin',
    },
    providerGlobalMetaId: 'global-metaid-1',
  });

  assert.deepEqual(payload.providerSkill, ['weather', 'report-writer']);
  assert.equal(payload.paymentTiming, 'free');
  assert.equal(payload.price, '0');
  assert.equal(payload.currency, 'SPACE');
  assert.equal(payload.settlementKind, 'native');
  assert.equal(payload.metadata, '');
  for (const omittedField of ['version', 'paymentAddress', 'paymentChain', 'orderId', 'mrc20Ticker', 'mrc20Id']) {
    assert.equal(Object.hasOwn(payload, omittedField), false);
  }

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
  assert.equal(modifyPayload.version, '1.1.0');
  assert.equal(typeof modifyPayload.payload, 'string');
});

test('buildGigSquareServicePayload builds prepaid skill-service v1.1 payment terms', () => {
  const payload = buildGigSquareServicePayload({
    draft: {
      serviceName: 'report',
      displayName: 'Report',
      description: 'desc',
      providerSkill: 'report-writer',
      paymentTiming: 'prepaid',
      price: ' 1.25 ',
      currency: 'mvc',
      protocolSettlementKind: 'fiat',
      metadata: 'free-form note',
      outputType: 'text',
    },
    providerGlobalMetaId: 'global-metaid-1',
  });

  assert.deepEqual(payload.providerSkill, ['report-writer']);
  assert.equal(payload.paymentTiming, 'prepaid');
  assert.equal(payload.price, '1.25');
  assert.equal(payload.currency, 'SPACE');
  assert.equal(payload.settlementKind, 'fiat');
  assert.equal(payload.metadata, 'free-form note');
  assert.equal(Object.hasOwn(payload, 'paymentAddress'), false);
  assert.equal(Object.hasOwn(payload, 'mrc20Ticker'), false);
  assert.equal(Object.hasOwn(payload, 'mrc20Id'), false);
});

test('buildGigSquareServicePayload serializes execution reminder before skill metadata', () => {
  const payload = buildGigSquareServicePayload({
    draft: {
      serviceName: 'weather',
      displayName: 'Weather',
      description: 'desc',
      executionReminder: ' 如果用户没指定城市就用北京。 ',
      providerSkill: 'forecast',
      price: '0',
      currency: 'SPACE',
      outputType: 'text',
    },
    providerGlobalMetaId: 'global-metaid-1',
  });

  assert.equal(payload.executionReminder, '如果用户没指定城市就用北京。');
  assert.ok(
    Object.keys(payload).indexOf('executionReminder') < Object.keys(payload).indexOf('skillDocument'),
    'executionReminder should be serialized before skillDocument',
  );
});

test('normalizeGigSquareModifyDraft allows empty execution reminder so modification can clear it', () => {
  const normalized = normalizeGigSquareModifyDraft({
    serviceName: 'weather',
    displayName: 'Weather',
    description: 'desc',
    executionReminder: '   ',
    providerSkill: 'forecast',
    price: '0',
    currency: 'SPACE',
    outputType: 'text',
  });

  assert.equal(normalized.executionReminder, '');
});

test('buildGigSquareServicePayload omits MRC20 protocol fields from v1.1 payloads', () => {
  const payload = buildGigSquareServicePayload({
    draft: {
      serviceName: 'weather',
      displayName: 'Weather',
      description: 'desc',
      providerSkill: 'forecast',
      price: '12',
      currency: 'SPACE',
      mrc20Ticker: 'ignored',
      mrc20Id: 'ignored',
      outputType: 'text',
    },
    providerGlobalMetaId: 'global-metaid-1',
  });

  assert.equal(payload.currency, 'SPACE');
  assert.equal(Object.hasOwn(payload, 'mrc20Ticker'), false);
  assert.equal(Object.hasOwn(payload, 'mrc20Id'), false);
  assert.equal(Object.hasOwn(payload, 'paymentChain'), false);
  assert.equal(Object.hasOwn(payload, 'paymentAddress'), false);
});

test('resolveGigSquareSettlementPaymentAddress keeps native address routing and maps MRC20 to btc', () => {
  const owner = {
    mvc_address: 'mvc-owner-address',
    btc_address: 'btc-owner-address',
    doge_address: 'doge-owner-address',
  };

  assert.equal(
    resolveGigSquareSettlementPaymentAddress({
      owner,
      settlement: normalizeGigSquareSettlementDraft({ currency: 'SPACE' }),
    }),
    'mvc-owner-address',
  );
  assert.equal(
    resolveGigSquareSettlementPaymentAddress({
      owner,
      settlement: normalizeGigSquareSettlementDraft({ currency: 'BTC' }),
    }),
    'btc-owner-address',
  );
  assert.equal(
    resolveGigSquareSettlementPaymentAddress({
      owner,
      settlement: normalizeGigSquareSettlementDraft({ currency: 'DOGE' }),
    }),
    'doge-owner-address',
  );
  assert.equal(
    resolveGigSquareSettlementPaymentAddress({
      owner,
      settlement: normalizeGigSquareSettlementDraft({
        currency: 'MRC20',
        mrc20Ticker: 'metaid',
        mrc20Id: 'tick-metaid',
      }),
    }),
    'btc-owner-address',
  );
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
