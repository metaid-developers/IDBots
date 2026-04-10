import assert from 'node:assert/strict';
import test from 'node:test';

import { getMetaAppsHeaderModel } from '../src/renderer/components/metaapps/metaAppViewModel.js';
import { getSidebarPrimaryNavModel } from '../src/renderer/components/sidebar/sidebarNavigation.js';

test('getSidebarPrimaryNavModel places MetaApps before Skills', () => {
  const items = getSidebarPrimaryNavModel({
    t: (key) => ({
      scheduledTasks: '定时任务',
      gigSquare: '服务广场',
      metaApps: '元应用',
      skills: '技能',
      metabots: 'MetaBots',
    }[key] ?? key),
    hasRunningScheduledTask: false,
  });

  assert.deepEqual(items.map((item) => item.id), [
    'scheduledTasks',
    'gigSquare',
    'metaapps',
    'skills',
    'metabots',
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
