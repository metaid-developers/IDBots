import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUseMetaAppPrompt,
  filterMetaApps,
  getRecommendedMetaAppsEmptyState,
} from '../src/renderer/components/metaapps/metaAppPresentation.js';

const sampleApps = [
  {
    id: 'buzz',
    name: 'Buzz',
    description: '查看最新 buzz、热门 buzz 和关注动态',
  },
  {
    id: 'chat',
    name: 'Chat',
    description: '群聊与私聊入口',
  },
];

test('filterMetaApps matches by name and description', () => {
  assert.deepEqual(filterMetaApps(sampleApps, '').map((app) => app.id), ['buzz', 'chat']);
  assert.deepEqual(filterMetaApps(sampleApps, 'buzz').map((app) => app.id), ['buzz']);
  assert.deepEqual(filterMetaApps(sampleApps, '群聊').map((app) => app.id), ['chat']);
  assert.deepEqual(filterMetaApps(sampleApps, 'missing'), []);
});

test('buildUseMetaAppPrompt builds a cowork prompt around the selected MetaApp', () => {
  const prompt = buildUseMetaAppPrompt({ name: 'Buzz' });
  assert.match(prompt, /使用本地元应用 Buzz/);
  assert.match(prompt, /如果需要，请直接打开它/);
});

test('getRecommendedMetaAppsEmptyState returns localized placeholder copy', () => {
  assert.deepEqual(getRecommendedMetaAppsEmptyState('zh'), {
    title: '推荐元应用即将开放',
    description: '这里将展示推荐安装的 MetaApp。当前版本先支持本地已安装元应用。',
  });
  assert.deepEqual(getRecommendedMetaAppsEmptyState('en'), {
    title: 'Recommended MetaApps Coming Soon',
    description: 'Recommended MetaApps will appear here. The current version focuses on locally installed MetaApps first.',
  });
});
