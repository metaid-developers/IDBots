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
