import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterCommunityMetaApps,
  getCommunityMetaAppActionLabel,
  getCommunityMetaAppsEmptyState,
  getCommunityMetaAppStatusLabel,
  getMetaAppVisualModel,
} from '../src/renderer/components/metaapps/metaAppPresentation.js';

const sampleCommunityApps = [
  {
    appId: 'buzz',
    name: 'Buzz',
    description: 'Buzz chain app',
    creatorMetaId: 'idq1creatorbuzz',
    status: 'install',
  },
  {
    appId: 'chat',
    name: 'Chat',
    description: 'Chat chain app',
    creatorMetaId: 'idq1creatorchat',
    status: 'uninstallable',
  },
];

test('filterCommunityMetaApps matches by name, description, and creatorMetaId', () => {
  assert.deepEqual(filterCommunityMetaApps(sampleCommunityApps, '').map((app) => app.appId), ['buzz', 'chat']);
  assert.deepEqual(filterCommunityMetaApps(sampleCommunityApps, 'buzz').map((app) => app.appId), ['buzz']);
  assert.deepEqual(filterCommunityMetaApps(sampleCommunityApps, 'chain').map((app) => app.appId), ['buzz', 'chat']);
  assert.deepEqual(filterCommunityMetaApps(sampleCommunityApps, 'creatorchat').map((app) => app.appId), ['chat']);
  assert.deepEqual(filterCommunityMetaApps(sampleCommunityApps, 'missing'), []);
});

test('getCommunityMetaAppsEmptyState returns localized copy', () => {
  assert.deepEqual(getCommunityMetaAppsEmptyState('zh'), {
    title: '暂无链上第三方应用',
    description: '当前没有可展示的 /protocols/metaapp 记录。',
  });
  assert.deepEqual(getCommunityMetaAppsEmptyState('en'), {
    title: 'No Chain Community MetaApps',
    description: 'No /protocols/metaapp records are available right now.',
  });
});

test('getCommunityMetaAppStatusLabel and action label map statuses', () => {
  assert.equal(getCommunityMetaAppStatusLabel('install', 'zh'), '可安装');
  assert.equal(getCommunityMetaAppStatusLabel('update', 'zh'), '可更新');
  assert.equal(getCommunityMetaAppStatusLabel('installed', 'zh'), '已安装');
  assert.equal(getCommunityMetaAppStatusLabel('uninstallable', 'zh'), '不可安装');

  assert.equal(getCommunityMetaAppActionLabel('install', 'zh'), '安装');
  assert.equal(getCommunityMetaAppActionLabel('update', 'zh'), '更新');
  assert.equal(getCommunityMetaAppActionLabel('installed', 'zh'), '已安装');
  assert.equal(getCommunityMetaAppActionLabel('uninstallable', 'zh'), '不可安装');

  assert.equal(getCommunityMetaAppStatusLabel('install', 'en'), 'Install');
  assert.equal(getCommunityMetaAppActionLabel('update', 'en'), 'Update');
});

test('getMetaAppVisualModel works for chain community records too', () => {
  assert.deepEqual(
    getMetaAppVisualModel({ cover: 'data:image/png;base64,aaa', icon: 'data:image/png;base64,bbb' }),
    { src: 'data:image/png;base64,aaa', kind: 'cover' },
  );
});
