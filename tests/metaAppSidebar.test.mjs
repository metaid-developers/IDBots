import assert from 'node:assert/strict';
import test from 'node:test';

import { getMetaAppsHeaderModel } from '../src/renderer/components/metaapps/metaAppViewModel.js';
import {
  getSidebarInternetNavModel,
  getSidebarPrimaryNavModel,
} from '../src/renderer/components/sidebar/sidebarNavigation.js';

const t = (key) => ({
  scheduledTasks: '定时任务',
  groupTasks: '群组任务',
  gigSquare: '服务广场',
  metaApps: '元应用',
  skills: '技能',
  metabots: 'MetaBots',
  botBrowser: 'Bot 浏览器',
  gigSquareAlphaBadge: 'Alpha',
}[key] ?? key);

test('getSidebarPrimaryNavModel keeps the Bot home entries in order (My Bots moved to the internet side)', () => {
  const items = getSidebarPrimaryNavModel({
    t,
    hasRunningScheduledTask: false,
  });

  assert.deepEqual(items.map((item) => item.id), [
    'scheduledTasks',
    'groupTasks',
  ]);
});

test('getSidebarInternetNavModel places Gig Square before MetaApps and My Bots last', () => {
  const items = getSidebarInternetNavModel({ t });

  assert.deepEqual(items.map((item) => item.id), [
    'browser',
    'gigSquare',
    'metaapps',
    'myBots',
  ]);
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
