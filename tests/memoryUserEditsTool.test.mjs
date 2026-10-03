import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function loadRunnerModule() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: { isPackaged: false, getAppPath: () => process.cwd(), getPath: () => process.cwd() },
        BrowserWindow: { getAllWindows: () => [] },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return require('../dist-electron/main/libs/coworkRunner.js');
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();

const setup = async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const runner = new CoworkRunner(coworkStore, {});
  const session = coworkStore.createSession('本地记忆会话', '/tmp/a', '', 'local', [], 5);
  return { db, cleanup, coworkStore, runner, session };
};

test('memory_user_edits list hides archived rows by default and recovers them with include_archived', async () => {
  const { cleanup, coworkStore, runner, session } = await setup();
  try {
    const active = coworkStore.createUserMemory({
      metabotId: 5, text: '用户喜欢简洁回复', scopeKind: 'owner', scopeKey: 'owner:self',
    });
    const retired = coworkStore.createUserMemory({
      metabotId: 5, text: '用户曾用旧版工作流', scopeKind: 'owner', scopeKey: 'owner:self', origin: 'dream',
    });
    assert.equal(coworkStore.archiveUserMemories({ ids: [retired.id], archivedAt: Date.now() }), 1);

    const warm = runner.runMemoryUserEditsTool({ action: 'list' }, session.id);
    assert.equal(warm.isError, false);
    assert.ok(warm.text.includes('用户喜欢简洁回复'));
    assert.ok(!warm.text.includes('用户曾用旧版工作流'), 'archived row hidden by default');
    assert.ok(!warm.text.includes('(archived)'));

    const cold = runner.runMemoryUserEditsTool({ action: 'list', include_archived: true }, session.id);
    assert.equal(cold.isError, false);
    assert.ok(cold.text.includes('用户喜欢简洁回复'));
    assert.ok(cold.text.includes('用户曾用旧版工作流'), 'cold channel recovers the archived row');
    const archivedLine = cold.text.split('\n').find((line) => line.startsWith(retired.id));
    assert.ok(archivedLine.includes('(archived)'), 'archived row carries the marker');
    const activeLine = cold.text.split('\n').find((line) => line.startsWith(active.id));
    assert.ok(!activeLine.includes('(archived)'), 'active row has no marker');
  } finally {
    cleanup();
  }
});
