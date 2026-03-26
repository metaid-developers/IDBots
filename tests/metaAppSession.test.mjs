import assert from 'node:assert/strict';
import test from 'node:test';

import { startMetaAppSession } from '../src/renderer/components/metaapps/metaAppSession.js';

test('startMetaAppSession starts a cowork session with the selected MetaApp prompt', async () => {
  let startOptions = null;
  const session = { id: 'session-metaapp-1' };

  const result = await startMetaAppSession({
    app: { name: 'Buzz' },
    coworkService: {
      startSession: async (options) => {
        startOptions = options;
        return session;
      },
    },
  });

  assert.equal(result, session);
  assert.ok(startOptions);
  assert.match(startOptions.prompt, /使用本地元应用 Buzz/);
  assert.match(startOptions.prompt, /如果需要，请直接打开它/);
});
