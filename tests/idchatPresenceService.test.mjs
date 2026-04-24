import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadPresenceService() {
  return require('../dist-electron/services/idchatPresenceService.js');
}

test('idchat presence posts online-status to api.idchat.io and normalizes results', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const calls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 2,
            onlineCount: 1,
            list: [
              { globalMetaId: 'idq1alpha', isOnline: true, lastSeenAt: 171000, lastSeenAgoSeconds: 5, deviceCount: 2 },
              { globalMetaId: 'idq1beta', isOnline: false, lastSeenAt: 0, lastSeenAgoSeconds: 0, deviceCount: 0 },
            ],
          },
          message: 'success',
        }),
      };
    },
  });

  const result = await service.fetchOnlineStatus([' idq1alpha ', 'idq1beta', 'idq1alpha']);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.idchat.io/group-chat/socket/online-status');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { globalMetaIds: ['idq1alpha', 'idq1beta'] });
  assert.deepEqual(result.list.map((entry) => [entry.globalMetaId, entry.isOnline, entry.lastSeenAt, entry.deviceCount]), [
    ['idq1alpha', true, 171000, 2],
    ['idq1beta', false, 0, 0],
  ]);
});

test('idchat presence does not fallback to www.show.now when api.idchat.io fails', async () => {
  const { IdchatPresenceService } = loadPresenceService();
  const urls = [];
  const service = new IdchatPresenceService({
    fetchImpl: async (url) => {
      urls.push(url);
      throw new Error('network down');
    },
  });

  await assert.rejects(() => service.fetchOnlineStatus(['idq1alpha']), /network down/);
  assert.deepEqual(urls, ['https://api.idchat.io/group-chat/socket/online-status']);
});
