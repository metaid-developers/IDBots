import assert from 'node:assert/strict';
import test from 'node:test';

import { getMetaAppsHeaderModel } from '../src/renderer/components/metaapps/metaAppViewModel.js';
import {
  getRailHomeNavModel,
  getRailInternetNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

const t = (key) => ({
  newChat: '新建任务',
  railLongTermTasks: '长期任务',
  railTaskRecords: '任务记录',
  scheduledTasks: '定时任务',
  groupTasks: '群组任务',
  gigSquare: '服务广场',
  metaApps: '元应用',
  skills: '技能',
  metabots: 'MetaBots',
  botBrowser: 'Bot 浏览器',
  botBrowserCoworkTitle: 'Co-Work',
  gigSquareAlphaBadge: 'Alpha',
}[key] ?? key);

test('the Bot Home rail keeps the four destinations in order', () => {
  const items = getRailHomeNavModel({
    t,
    hasRunningScheduledTask: false,
  });

  assert.deepEqual(items.map((item) => item.id), [
    'newTask',
    'longTerm',
    'groupTasks',
    'records',
  ]);
  assert.deepEqual(items.map((item) => item.label), [
    '新建任务',
    '长期任务',
    '群组任务',
    '任务记录',
  ]);
});

test('the Bot Internet rail places Gig Square before MetaApps, My Bots, and Co-Work last', () => {
  const items = getRailInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), [
    'browser',
    'gigSquare',
    'metaapps',
    'myBots',
    'cowork',
  ]);
  assert.deepEqual(
    items.filter((item) => !item.hidden).map((item) => item.label),
    ['Bot 浏览器', '元应用', 'MetaBots', 'Co-Work'],
  );
});

test('getMetaAppsHeaderModel returns the localized MetaApps heading copy', () => {
  const header = getMetaAppsHeaderModel((key) => ({
    metaApps: '元应用',
    metaAppsDescription: '可即插即用、可在本地运行的前端 MetaApp',
  }[key] ?? key));

  assert.deepEqual(header, {
    title: '元应用',
    description: '可即插即用、可在本地运行的前端 MetaApp',
  });
});
