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
        prompt: 'Create a social feed MetaApp with a compact composer.',
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
      globalMetaId: 'idq1native',
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
    fetchAuthorInfo: async (creatorMetaId) => {
      if (creatorMetaId === 'idq1creator') {
        return { name: 'Creator Bot', avatar: '/content/avatar-creator' };
      }
      if (creatorMetaId === 'idq1another') {
        return { name: 'Another Bot', avatar: 'metafile://avatar-another' };
      }
      if (creatorMetaId === 'idq1native') {
        return { name: 'Native Bot', avatarId: '/content/avatar-native' };
      }
      return null;
    },
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
  assert.equal(buzz.authorName, 'Creator Bot');
  assert.equal(buzz.authorAvatar, '/content/avatar-creator');
  assert.equal(buzz.aiPrompt, 'Create a social feed MetaApp with a compact composer.');

  const chat = result.apps.find((app) => app.appId === 'chat');
  assert.ok(chat);
  assert.equal(chat.status, 'uninstallable');
  assert.equal(chat.authorName, 'Another Bot');
  assert.equal(chat.authorAvatar, 'metafile://avatar-another');
  assert.match(chat.reason || '', /冲突|conflict|阻止覆盖安装/i);

  const nativeOnly = result.apps.find((app) => app.appId === 'native-only');
  assert.ok(nativeOnly);
  assert.equal(nativeOnly.status, 'uninstallable');
  assert.equal(nativeOnly.authorName, 'Native Bot');
  assert.equal(nativeOnly.authorAvatar, '/content/avatar-native');
  assert.match(nativeOnly.reason || '', /browser/i);
});

test('listCommunityMetaApps forwards cursor and size, and returns nextCursor', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const calls = [];
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    cursor: 'cursor-30',
    size: 30,
    fetchList: async (params = {}) => {
      calls.push(params);
      return {
        list: [
          {
            id: 'pin-page-2',
            globalMetaId: 'idq1creator',
            timestamp: 1_888_888_888,
            contentSummary: JSON.stringify({
              title: 'Paged App',
              appName: 'paged-app',
              intro: 'Paged chain app',
              runtime: 'browser',
              version: '1.0.0',
              code: 'metafile://zip-paged-app',
              codeType: 'application/zip',
              indexFile: 'index.html',
              disabled: false,
            }),
          },
        ],
        nextCursor: 'cursor-60',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.nextCursor, 'cursor-60');
  assert.deepEqual(calls, [{ cursor: 'cursor-30', size: 30 }]);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0]?.appId, 'paged-app');
});

test('listCommunityMetaApps accepts content metafile when code is empty', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    fetchList: async () => [
      {
        id: 'pin-iddisk',
        createMetaId: 'idq1creator',
        timestamp: 1_765_221_178,
        contentSummary: JSON.stringify({
          title: 'IDDisk',
          appName: 'IDDisk',
          intro: 'Chain file manager',
          runtime: 'browser/ios/android',
          version: 'v1.1.0',
          indexFile: 'index.html',
          code: '',
          content: 'metafile://zip-iddisk',
          contentType: 'application/zip',
          codeType: 'application/zip',
          disabled: false,
        }),
      },
    ],
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0]?.appId, 'IDDisk');
  assert.equal(result.apps[0]?.status, 'install');
  assert.equal(result.apps[0]?.installable, true);
  assert.equal(result.apps[0]?.codeUri, 'metafile://zip-iddisk');
  assert.equal(result.apps[0]?.codePinId, 'zip-iddisk');
});
