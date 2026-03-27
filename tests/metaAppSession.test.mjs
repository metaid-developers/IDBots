import assert from 'node:assert/strict';
import test from 'node:test';

import { openSelectedMetaApp } from '../src/renderer/components/metaapps/metaAppLaunch.js';

test('openSelectedMetaApp opens the selected MetaApp directly', async () => {
  const calls = [];
  const result = await openSelectedMetaApp({
    app: {
      id: 'buzz',
      entry: '/buzz/app/index.html',
    },
    metaAppService: {
      openMetaApp: async (appId, targetPath) => {
        calls.push({ appId, targetPath });
        return { success: true, appId, url: 'http://127.0.0.1:43210/buzz/app/index.html' };
      },
    },
  });

  assert.deepEqual(calls, [
    {
      appId: 'buzz',
      targetPath: '/buzz/app/index.html',
    },
  ]);
  assert.deepEqual(result, {
    success: true,
    appId: 'buzz',
    url: 'http://127.0.0.1:43210/buzz/app/index.html',
  });
});

test('openSelectedMetaApp throws the open error when direct launch fails', async () => {
  await assert.rejects(
    () => openSelectedMetaApp({
      app: {
        id: 'buzz',
        entry: '/buzz/app/index.html',
      },
      metaAppService: {
        openMetaApp: async () => ({ success: false, error: 'launch failed' }),
      },
    }),
    /launch failed/,
  );
});
