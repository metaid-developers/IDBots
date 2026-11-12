import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let listCommunityMetaApps;
let findCommunityMetaAppRecordBySourcePinIdCached;
try {
  ({ listCommunityMetaApps, findCommunityMetaAppRecordBySourcePinIdCached } = require('../dist-electron/main/services/metaAppChainService.js'));
} catch {
  listCommunityMetaApps = null;
  findCommunityMetaAppRecordBySourcePinIdCached = null;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

// The community feed is sourced from the MetaSo aggregator
// (mapSearchItemToChainCandidate in metaAppChainService.ts): every item is one
// already-folded app record, not a raw MAN pin with a contentSummary payload.
function metaSoItem(index, overrides = {}) {
  const suffix = String(index).padStart(2, '0');
  return {
    pinId: `pin-${suffix}`,
    title: `Paged App ${suffix}`,
    appName: `paged-app-${suffix}`,
    intro: `Paged chain app ${suffix}`,
    runtime: 'browser',
    version: '1.0.0',
    content: `metafile://zip-paged-app-${suffix}`,
    indexFile: 'index.html',
    disabled: false,
    publisherGlobalMetaId: `idq1creator${suffix}`,
    publisherName: `Publisher ${suffix}`,
    updatedAt: 1_888_888_000 + index,
    ...overrides,
  };
}

test('listCommunityMetaApps maps MetaSo feed items and computes install status', async () => {
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
      pinId: 'pin-buzz-new',
      title: 'Buzz',
      appName: 'buzz',
      intro: 'Buzz chain app',
      runtime: 'browser/android',
      version: '1.2.0',
      icon: 'metafile://icon-buzz',
      coverImg: 'metafile://cover-buzz',
      content: 'metafile://zip-buzz',
      indexFile: 'index.html',
      disabled: false,
      publisherGlobalMetaId: 'idq1creator',
      updatedAt: nowTs,
    },
    {
      pinId: 'pin-chat-conflict',
      title: 'Chat',
      appName: 'chat',
      intro: 'Chat chain app',
      runtime: 'browser',
      version: '2.1.0',
      content: 'metafile://zip-chat',
      indexFile: 'index.html',
      disabled: false,
      publisherGlobalMetaId: 'idq1another',
      updatedAt: nowTs,
    },
    {
      pinId: 'pin-uninstallable',
      title: 'Native only',
      appName: 'native-only',
      intro: '',
      runtime: 'android/ios',
      version: '1.0.0',
      content: 'metafile://zip-native',
      disabled: false,
      publisherGlobalMetaId: 'idq1native',
      updatedAt: nowTs,
    },
    {
      // No title/appName: not a mappable MetaApp item.
      pinId: 'pin-invalid',
      updatedAt: nowTs,
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
  // MetaSo items carry no AI prompt; the list no longer surfaces one.
  assert.equal(buzz.aiPrompt, undefined);

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
        list: Array.from({ length: 30 }, (_, index) => metaSoItem(index + 1)),
        nextCursor: 'cursor-60',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.nextCursor, 'cursor-60');
  assert.deepEqual(calls, [{ cursor: 'cursor-30', size: 30 }]);
  assert.equal(result.apps.length, 30);
  assert.equal(result.apps[0]?.appId, 'paged-app-30');
});

test('listCommunityMetaApps passes the aggregator nextCursor through unchanged', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  // The MetaSo feed owns pagination; a short page still reports the cursor the
  // aggregator returned so the renderer can keep paging.
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    cursor: 'cursor-30',
    size: 30,
    fetchList: async () => ({
      list: Array.from({ length: 12 }, (_, index) => metaSoItem(index + 1)),
      nextCursor: 'cursor-after-short-page',
    }),
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 12);
  assert.equal(result.nextCursor, 'cursor-after-short-page');
});

test('listCommunityMetaApps falls back to the MetaSo aggregator when no fetchList is injected', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const previousFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url) => {
    const href = String(url);
    calls.push(href);

    if (href.startsWith('https://so.metaid.io/api/metaapp/list')) {
      return jsonResponse({
        code: 0,
        data: {
          items: Array.from({ length: 30 }, (_, index) => metaSoItem(index + 1, {
            title: `Remote Current App ${index + 1}`,
            appName: `remote-current-app-${index + 1}`,
          })),
          nextCursor: 'remote-next',
        },
      });
    }

    throw new Error(`Unexpected fetch: ${href}`);
  };

  try {
    const result = await listCommunityMetaApps({
      manager: { listMetaApps: () => [] },
      cursor: '0',
      size: 30,
    });

    assert.equal(result.success, true);
    assert.equal(result.nextCursor, 'remote-next');
    assert.deepEqual(result.apps.map((app) => app.sourcePinId).slice(0, 2), ['pin-30', 'pin-29']);
    assert.equal(
      calls.some((href) => href.startsWith('https://so.metaid.io/api/metaapp/list')),
      true,
      'the MetaSo aggregator should be queried when no fetchList override is provided',
    );
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('listCommunityMetaApps accepts content metafile when code is empty', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    fetchList: async () => [
      {
        pinId: 'pin-iddisk',
        title: 'IDDisk',
        appName: 'IDDisk',
        intro: 'Chain file manager',
        runtime: 'browser/ios/android',
        version: 'v1.1.0',
        content: 'metafile://zip-iddisk',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1creator',
        publisherName: 'Creator Bot',
        updatedAt: 1_765_221_178,
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

test('listCommunityMetaApps keeps the single folded record the aggregator returns per app', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  // MetaSo already folds edit versions to one latest record per app, so the
  // client maps one item to one record and must not re-deduplicate anything.
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    fetchList: async () => [
      {
        pinId: 'pin-edit-modify',
        title: 'Edit App 1.1.0',
        appName: 'edit-app',
        intro: 'Edit app v1.1.0',
        runtime: 'browser',
        version: '1.1.0',
        content: 'metafile://zip-edit-app-modified',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1creator',
        publisherName: 'Creator Bot',
        updatedAt: 1_777_777_800,
      },
    ],
    fetchAuthorInfo: async () => {
      throw new Error('fetchAuthorInfo should not run when the item already carries the author');
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  const app = result.apps[0];
  assert.equal(app.appId, 'edit-app');
  assert.equal(app.version, '1.1.0');
  assert.equal(app.sourcePinId, 'pin-edit-modify');
  assert.equal(app.codePinId, 'zip-edit-app-modified');
  assert.equal(app.authorName, 'Creator Bot');
  assert.deepEqual(result.seen, ['idq1creator::edit-app']);
});

test('listCommunityMetaApps fills a logical page from a single aggregator page without extra fetches', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const fetchCalls = [];
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async ({ cursor = '0' } = {}) => {
      fetchCalls.push(cursor);
      // One aggregator page already holds 30 distinct apps.
      return {
        list: Array.from({ length: 30 }, (_, index) => metaSoItem(index + 1)),
        nextCursor: 'cursor-b',
      };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 30);
  assert.equal(result.nextCursor, 'cursor-b');
  assert.deepEqual(fetchCalls, ['0'], 'one aggregator page is one logical page');
  const ids = new Set(result.apps.map((app) => app.sourcePinId));
  assert.equal(ids.size, 30, 'no duplicated app in a full page');
});

test('listCommunityMetaApps honors the seen-set so stale versions never reappear across pages', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const first = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 5,
    fetchList: async () => [
      {
        pinId: 'pin-a-head',
        title: 'app-a 2.0.0',
        appName: 'app-a',
        intro: 'app-a v2.0.0',
        runtime: 'browser',
        version: '2.0.0',
        content: 'metafile://zip-a-head',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1a',
        updatedAt: 2_000_000_000,
      },
      {
        pinId: 'pin-b-head',
        title: 'app-b 1.0.0',
        appName: 'app-b',
        intro: 'app-b v1.0.0',
        runtime: 'browser',
        version: '1.0.0',
        content: 'metafile://zip-b-head',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1b',
        updatedAt: 1_999_999_999,
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(first.success, true);
  assert.equal(first.apps.length, 2);
  assert.equal(first.nextCursor, null);
  assert.deepEqual(first.seen, ['idq1a::app-a', 'idq1b::app-b']);

  const second = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 5,
    seen: first.seen,
    fetchList: async () => [
      // Stale re-listing of app-a plus one brand-new app.
      {
        pinId: 'pin-a-stale',
        title: 'app-a 1.0.0',
        appName: 'app-a',
        intro: 'app-a v1.0.0',
        runtime: 'browser',
        version: '1.0.0',
        content: 'metafile://zip-a-stale',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1a',
        updatedAt: 1_000_000_000,
      },
      {
        pinId: 'pin-c-new',
        title: 'app-c 1.0.0',
        appName: 'app-c',
        intro: 'app-c v1.0.0',
        runtime: 'browser',
        version: '1.0.0',
        content: 'metafile://zip-c-new',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1c',
        updatedAt: 1_000_000_001,
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(second.success, true);
  assert.deepEqual(second.apps.map((app) => app.sourcePinId), ['pin-c-new']);
  assert.deepEqual(second.seen, ['idq1a::app-a', 'idq1b::app-b', 'idq1c::app-c']);
});

test('listCommunityMetaApps marks publisher-disabled MetaApps as uninstallable', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async () => [
      {
        pinId: 'pin-live',
        title: 'live-app 1.0.0',
        appName: 'live-app',
        intro: 'live-app v1.0.0',
        runtime: 'browser',
        version: '1.0.0',
        content: 'metafile://zip-live',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1b',
        updatedAt: 2_000_000_000,
      },
      {
        pinId: 'pin-disabled',
        title: 'disabled-app 1.0.0',
        appName: 'disabled-app',
        intro: 'disabled-app v1.0.0',
        runtime: 'browser',
        version: '1.0.0',
        content: 'metafile://zip-disabled',
        indexFile: 'index.html',
        disabled: true,
        publisherGlobalMetaId: 'idq1a',
        updatedAt: 1_999_999_999,
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  const live = result.apps.find((app) => app.appId === 'live-app');
  assert.ok(live);
  assert.equal(live.status, 'install');
  const disabled = result.apps.find((app) => app.appId === 'disabled-app');
  assert.ok(disabled);
  assert.equal(disabled.status, 'uninstallable');
  assert.equal(disabled.installable, false);
  assert.match(disabled.reason || '', /禁用|disabled/i);
  assert.deepEqual(result.seen, ['idq1b::live-app', 'idq1a::disabled-app']);
});

test('listCommunityMetaApps maps the newest folded version returned by the aggregator', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  // MetaSo excludes revoked/superseded rows upstream, so the feed only ever
  // contains the newest visible version of each app.
  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async () => [
      {
        pinId: 'pin-current',
        title: 'mixed-app 2.0.0',
        appName: 'mixed-app',
        intro: 'mixed-app v2.0.0',
        runtime: 'browser',
        version: '2.0.0',
        content: 'metafile://zip-current',
        indexFile: 'index.html',
        disabled: false,
        publisherGlobalMetaId: 'idq1x',
        updatedAt: 1_000_000_200,
      },
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].sourcePinId, 'pin-current');
  assert.equal(result.apps[0].version, '2.0.0');
  assert.deepEqual(result.seen, ['idq1x::mixed-app']);
});

test('listCommunityMetaApps maps the MetaSo prompt field to the record aiPrompt', async () => {
  assert.equal(typeof listCommunityMetaApps, 'function', 'listCommunityMetaApps() should be exported');

  const result = await listCommunityMetaApps({
    manager: { listMetaApps: () => [] },
    size: 30,
    fetchList: async () => [
      metaSoItem(90, { prompt: 'Summarize this for me' }),
    ],
    fetchAuthorInfo: async () => null,
  });

  assert.equal(result.success, true);
  assert.equal(result.apps.length, 1);
  assert.equal(result.apps[0].aiPrompt, 'Summarize this for me');
});

test('findCommunityMetaAppRecordBySourcePinIdCached caches hits, misses, and skips errors', async () => {
  assert.equal(
    typeof findCommunityMetaAppRecordBySourcePinIdCached,
    'function',
    'findCommunityMetaAppRecordBySourcePinIdCached() should be exported',
  );

  const manager = { listMetaApps: () => [] };

  // Hit: two lookups for the same sourcePinId only fetch once.
  let hitCalls = 0;
  const hitItem = metaSoItem(91, { pinId: 'pin-cached-hit', publisherGlobalMetaId: 'idq1hit' });
  const hitInput = {
    sourcePinId: 'pin-cached-hit',
    manager,
    fetchList: async () => { hitCalls += 1; return [hitItem]; },
    fetchAuthorInfo: async () => null,
  };
  const firstHit = await findCommunityMetaAppRecordBySourcePinIdCached(hitInput);
  const secondHit = await findCommunityMetaAppRecordBySourcePinIdCached(hitInput);
  assert.equal(firstHit.record?.sourcePinId, 'pin-cached-hit');
  assert.equal(secondHit.record?.sourcePinId, 'pin-cached-hit');
  assert.equal(hitCalls, 1);

  // Miss: an empty result is cached too, so the second lookup does not fetch.
  let missCalls = 0;
  const missInput = {
    sourcePinId: 'pin-cached-miss',
    manager,
    fetchList: async () => { missCalls += 1; return [metaSoItem(92)]; },
    fetchAuthorInfo: async () => null,
  };
  const firstMiss = await findCommunityMetaAppRecordBySourcePinIdCached(missInput);
  const secondMiss = await findCommunityMetaAppRecordBySourcePinIdCached(missInput);
  assert.equal(firstMiss.record, undefined);
  assert.equal(secondMiss.record, undefined);
  assert.equal(missCalls, 1);

  // Error: results carrying an error are not cached, so the next lookup retries.
  let errorCalls = 0;
  const errorInput = {
    sourcePinId: 'pin-cached-error',
    manager,
    fetchList: async () => { errorCalls += 1; throw new Error('aggregator down'); },
    fetchAuthorInfo: async () => null,
  };
  const firstError = await findCommunityMetaAppRecordBySourcePinIdCached(errorInput);
  const secondError = await findCommunityMetaAppRecordBySourcePinIdCached(errorInput);
  assert.match(firstError.error || '', /aggregator down/);
  assert.match(secondError.error || '', /aggregator down/);
  assert.equal(errorCalls, 2);
});
