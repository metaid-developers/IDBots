import test from 'node:test';
import assert from 'node:assert/strict';

test('listCallablePortableServices syncs MetaWeb records and filters them through provider discovery truth', async () => {
  const fetchCalls = [];
  const mirrored = [];
  const { listCallablePortableServices } = await import('../dist-electron/metabotRuntime/serviceDiscoveryRuntime.js');

  const resolved = await listCallablePortableServices({
    pageSize: 20,
    fetchPage: async () => {
      fetchCalls.push('fetch');
      return {
        list: [
          {
            id: 'pin-online',
            status: 1,
            operation: 'create',
            metaid: 'metaid-online',
            globalMetaId: 'idq1provider',
            address: '1abc',
            contentSummary: {
              serviceName: 'Translator',
              displayName: 'Translator',
              description: 'One-shot translation',
              price: '5',
              currency: 'SPACE',
              providerMetaBot: 'idq1provider',
              providerSkill: 'translate-text',
              inputType: 'text',
              outputType: 'text',
              endpoint: 'simplemsg',
              paymentAddress: '1abc',
            },
          },
          {
            id: 'pin-offline',
            status: 1,
            operation: 'create',
            metaid: 'metaid-offline',
            globalMetaId: 'idq1offline',
            address: '1def',
            contentSummary: {
              serviceName: 'Writer',
              displayName: 'Writer',
              description: 'One-shot writing',
              price: '7',
              currency: 'SPACE',
              providerMetaBot: 'idq1offline',
              providerSkill: 'write-text',
              inputType: 'text',
              outputType: 'text',
              endpoint: 'simplemsg',
              paymentAddress: '1def',
            },
          },
        ],
        nextCursor: null,
      };
    },
    upsertMirroredService: (row) => {
      mirrored.push(row);
    },
    listMirroredServices: () => mirrored,
    providerDiscovery: {
      getDiscoverySnapshot: () => ({
        availableServices: [
          { pinId: 'pin-online', providerGlobalMetaId: 'idq1provider', providerAddress: '1abc', serviceName: 'Translator' },
        ],
      }),
    },
  });

  assert.deepEqual(fetchCalls, ['fetch']);
  assert.deepEqual(resolved.map((item) => item.pinId), ['pin-online']);
});

test('syncPortableServiceCatalog follows nextCursor pages and upserts each parsed service', async () => {
  const fetchCalls = [];
  const mirrored = [];
  const { syncPortableServiceCatalog } = await import('../dist-electron/metabotRuntime/serviceDiscoveryRuntime.js');

  await syncPortableServiceCatalog({
    pageSize: 20,
    fetchPage: async (cursor) => {
      fetchCalls.push(cursor ?? null);
      if (!cursor) {
        return {
          list: [
            {
              id: 'pin-page-1',
              status: 1,
              operation: 'create',
              metaid: 'metaid-page-1',
              globalMetaId: 'idq1page1',
              address: '1aaa',
              contentSummary: {
                serviceName: 'Page One',
                displayName: 'Page One',
                description: 'First page service',
                price: '1',
                currency: 'SPACE',
                providerMetaBot: 'idq1page1',
                providerSkill: 'skill-page-1',
                inputType: 'text',
                outputType: 'text',
                endpoint: 'simplemsg',
                paymentAddress: '1aaa',
              },
            },
          ],
          nextCursor: 'cursor-2',
        };
      }
      return {
        list: [
          {
            id: 'pin-page-2',
            status: 1,
            operation: 'create',
            metaid: 'metaid-page-2',
            globalMetaId: 'idq1page2',
            address: '1bbb',
            contentSummary: {
              serviceName: 'Page Two',
              displayName: 'Page Two',
              description: 'Second page service',
              price: '2',
              currency: 'SPACE',
              providerMetaBot: 'idq1page2',
              providerSkill: 'skill-page-2',
              inputType: 'text',
              outputType: 'text',
              endpoint: 'simplemsg',
              paymentAddress: '1bbb',
            },
          },
        ],
        nextCursor: null,
      };
    },
    upsertMirroredService: (row) => {
      mirrored.push(row);
    },
  });

  assert.deepEqual(fetchCalls, [null, 'cursor-2']);
  assert.deepEqual(mirrored.map((row) => row.pinId), ['pin-page-1', 'pin-page-2']);
});
