import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let listCommunityMetaApps;
try {
  ({ listCommunityMetaApps } = require('../dist-electron/services/metaAppChainService.js'));
} catch {
  listCommunityMetaApps = null;
}

test('listCommunityMetaApps parses chain protocol items and computes install status', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const nowTs = 1_777_777_777;
  const manager = {
    listMetaApps: () => [
      {
        id: 'buzz',
        version: '1.0.0',
        creatorMetaId: 'idq1creator',
        sourceType: 'chain-community',
      },
      {
        id: 'chat',
        version: '2.0.0',
        creatorMetaId: 'idq1local',
        sourceType: 'manual',
      },
    ],
  };

  const fetched = [
    {
      id: 'pin-buzz-new',
      globalMetaId: 'idq1creator',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Buzz',
        appName: 'buzz',
        intro: 'Buzz chain app',
        runtime: 'browser/android',
        version: '1.2.0',
        icon: 'metafile://icon-buzz',
        coverImg: 'metafile://cover-buzz',
        code: 'metafile://zip-buzz',
        codeType: 'application/zip',
        indexFile: 'index.html',
        disabled: false,
      }),
    },
    {
      id: 'pin-chat-conflict',
      globalMetaId: 'idq1another',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Chat',
        appName: 'chat',
        intro: 'Chat chain app',
        runtime: 'browser',
        version: '2.1.0',
        code: 'metafile://zip-chat',
        codeType: 'application/zip',
        indexFile: 'index.html',
        disabled: false,
      }),
    },
    {
      id: 'pin-uninstallable',
      globalMetaId: 'idq1creator',
      timestamp: nowTs,
      contentSummary: JSON.stringify({
        title: 'Native only',
        appName: 'native-only',
        runtime: 'android/ios',
        version: '1.0.0',
        code: 'metafile://zip-native',
        codeType: 'application/zip',
        disabled: false,
      }),
    },
    {
      id: 'pin-invalid',
      globalMetaId: 'idq1creator',
      timestamp: nowTs,
      contentSummary: '{',
    },
  ];

  const result = await listCommunityMetaApps({
    manager,
    fetchList: async () => fetched,
  });

  assert.equal(result.success, true);
  assert.equal(Array.isArray(result.apps), true);
  assert.equal(result.apps.length, 3);

  const buzz = result.apps.find((app) => app.appId === 'buzz');
  assert.ok(buzz);
  assert.equal(buzz.status, 'update');
  assert.equal(buzz.installable, true);
  assert.equal(buzz.codePinId, 'zip-buzz');
  assert.equal(buzz.icon, 'metafile://icon-buzz');
  assert.equal(buzz.cover, 'metafile://cover-buzz');

  const chat = result.apps.find((app) => app.appId === 'chat');
  assert.ok(chat);
  assert.equal(chat.status, 'uninstallable');
  assert.match(chat.reason || '', /冲突|conflict|阻止覆盖安装/i);

  const nativeOnly = result.apps.find((app) => app.appId === 'native-only');
  assert.ok(nativeOnly);
  assert.equal(nativeOnly.status, 'uninstallable');
  assert.match(nativeOnly.reason || '', /browser/i);
});
