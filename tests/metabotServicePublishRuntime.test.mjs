import test from 'node:test';
import assert from 'node:assert/strict';

test('publishPortableService writes /protocols/skill-service and mirrors the local row', async () => {
  const calls = [];
  const { publishPortableService } = await import('../dist-electron/metabotRuntime/servicePublishRuntime.js');

  const result = await publishPortableService({
    metabotId: 7,
    serviceDraft: {
      serviceName: ' translator-basic ',
      displayName: 'Translator',
      description: 'One-shot translation',
      providerSkill: ' translate-text ',
      price: '5',
      currency: 'space',
      outputType: 'TEXT',
    },
    deps: {
      buildGigSquareServicePayload(input) {
        calls.push(['buildPayload', input]);
        return {
          ...input,
          serviceName: 'translator-basic',
          providerSkill: 'translate-text',
          currency: 'SPACE',
          outputType: 'text',
          endpoint: 'simplemsg',
          inputType: 'text',
          paymentAddress: '1abc',
        };
      },
      async createPin(_store, _metabotId, pinInput) {
        calls.push(['createPin', pinInput]);
        return { pinId: 'service-pin-1', txids: ['service-tx-1'] };
      },
      insertLocalServiceRow(row) {
        calls.push(['insertLocalRow', row]);
      },
      scheduleRemoteSync() {
        calls.push(['scheduleRemoteSync']);
      },
    },
  });

  assert.equal(result.pinId, 'service-pin-1');
  assert.equal(calls[1][1].path, '/protocols/skill-service');
  assert.equal(calls[2][1].pinId, 'service-pin-1');
});

test('buildPortableServicePublishRecord falls back to payload provider meta bot and rejects blank pin ids', async () => {
  const { buildPortableServicePublishRecord } = await import('../dist-electron/metabotRuntime/servicePublishRuntime.js');

  const record = buildPortableServicePublishRecord({
    pinId: 'service-pin-2',
    metabotId: 9,
    providerGlobalMetaId: '',
    payloadJson: '{"serviceName":"translator-pro"}',
    payload: {
      serviceName: 'translator-pro',
      displayName: 'Translator Pro',
      description: 'One-shot translation',
      serviceIcon: '',
      providerMetaBot: 'idq1provider',
      providerSkill: 'translate-pro',
      price: '9',
      currency: 'SPACE',
      skillDocument: '',
      inputType: 'text',
      outputType: 'text',
      endpoint: 'simplemsg',
      paymentAddress: '1abc',
    },
  });

  assert.equal(record.providerGlobalMetaId, 'idq1provider');
  assert.throws(() => buildPortableServicePublishRecord({
    pinId: '   ',
    metabotId: 9,
    providerGlobalMetaId: 'idq1provider',
    payloadJson: '{}',
    payload: {
      serviceName: 'translator-pro',
      displayName: 'Translator Pro',
      description: 'One-shot translation',
      serviceIcon: '',
      providerMetaBot: 'idq1provider',
      providerSkill: 'translate-pro',
      price: '9',
      currency: 'SPACE',
      skillDocument: '',
      inputType: 'text',
      outputType: 'text',
      endpoint: 'simplemsg',
      paymentAddress: '1abc',
    },
  }), /pin id is required/i);
});
