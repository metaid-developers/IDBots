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
    try {
      return require('../dist-electron/main/libs/coworkRunner.js');
    } catch {
      return require('../dist-electron/main/libs/coworkRunner.js');
    }
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadRunnerModule();
const { MetaIDKnowledgeStore } = await import('../dist-electron/main/metaidKnowledgeStore.js')
  .catch(() => import('../dist-electron/main/metaidKnowledgeStore.js'));

const setup = async (withKnowledgeStore = true) => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const knowledgeStore = withKnowledgeStore ? new MetaIDKnowledgeStore(db, () => {}, () => 1000) : null;
  const runner = new CoworkRunner(coworkStore, knowledgeStore ? { knowledgeStore } : {});
  const session = coworkStore.createSession('和用户聊技术选型', '/tmp/a', '', 'local', [], 5);
  return { db, cleanup, coworkStore, knowledgeStore, runner, session };
};

test('knowledge_recall fails clearly without bot attribution or knowledge store', async () => {
  const { cleanup, coworkStore, runner, session } = await setup(false);
  try {
    const unattributed = coworkStore.createSession('无归属会话', '/tmp/b');
    const noBot = runner.runKnowledgeRecallTool({}, unattributed.id);
    assert.equal(noBot.isError, true);
    assert.ok(noBot.text.includes('could not resolve MetaBot'));

    const noStore = runner.runKnowledgeRecallTool({}, session.id);
    assert.equal(noStore.isError, true);
    assert.ok(noStore.text.includes('not configured'));
  } finally {
    cleanup();
  }
});

test('knowledge_recall returns seeded know-how and pitfalls with kind labels', async () => {
  const { cleanup, knowledgeStore, runner, session } = await setup();
  try {
    knowledgeStore.upsertKnowledge({
      metabotId: 5,
      topic: '快速开发 3D 网页游戏',
      summary: 'React Three Fiber + Vite 起步最快。',
      kind: 'know_how',
      category: '技术栈',
    });
    knowledgeStore.upsertKnowledge({
      metabotId: 5,
      topic: 'SSR 产物直接访问 window',
      summary: '会崩，必须 typeof window 守卫。',
      kind: 'pitfall',
    });

    const result = runner.runKnowledgeRecallTool({ query: '3D' }, session.id);
    assert.equal(result.isError, false);
    assert.ok(result.text.includes('快速开发 3D 网页游戏'));
    assert.ok(result.text.includes('【做法】'));

    const pitfalls = runner.runKnowledgeRecallTool({ kind: 'pitfall' }, session.id);
    assert.ok(pitfalls.text.includes('【坑】'));
    assert.ok(pitfalls.text.includes('SSR'));
    assert.ok(!pitfalls.text.includes('React Three Fiber'));
  } finally {
    cleanup();
  }
});

test('knowledge_recall include_archived recovers archived entries with a marker, superseded never returns', async () => {
  const { db, cleanup, knowledgeStore, runner, session } = await setup();
  try {
    knowledgeStore.upsertKnowledge({
      metabotId: 5,
      topic: '活跃的做法',
      summary: '还在用的做法。',
      kind: 'know_how',
    });
    const retired = knowledgeStore.upsertKnowledge({
      metabotId: 5,
      topic: '过时的坑',
      summary: '已经归档的坑。',
      kind: 'pitfall',
    });
    knowledgeStore.archiveKnowledge({ id: retired.entry.id, metabotId: 5 });
    const superseded = knowledgeStore.upsertKnowledge({
      metabotId: 5,
      topic: '被替代的结论',
      summary: '历史版本。',
      kind: 'principle',
    });
    db.run(`UPDATE metaid_knowledge_entries SET status = 'superseded' WHERE id = ?`, [superseded.entry.id]);

    const warm = runner.runKnowledgeRecallTool({}, session.id);
    assert.equal(warm.isError, false);
    assert.ok(warm.text.includes('活跃的做法'));
    assert.ok(!warm.text.includes('过时的坑'), 'archived entries hidden by default');
    assert.ok(!warm.text.includes('(archived)'));

    const cold = runner.runKnowledgeRecallTool({ include_archived: true }, session.id);
    assert.equal(cold.isError, false);
    assert.ok(cold.text.includes('活跃的做法'));
    assert.ok(cold.text.includes('过时的坑'), 'cold channel recovers the archived entry');
    const archivedLine = cold.text.split('\n').find((line) => line.includes('过时的坑'));
    assert.ok(archivedLine.includes('(archived)'), 'archived entry carries the marker');
    const activeLine = cold.text.split('\n').find((line) => line.includes('活跃的做法'));
    assert.ok(!activeLine.includes('(archived)'), 'active entry has no marker');
    assert.ok(!cold.text.includes('被替代的结论'), 'superseded versions are never returned');
  } finally {
    cleanup();
  }
});

test('knowledge_upsert creates a new entry, then rewrites it on the same topic', async () => {
  const { cleanup, knowledgeStore, runner, session } = await setup();
  try {
    const created = runner.runKnowledgeUpsertTool({
      topic: '用户喜欢的设计风格',
      summary: '偏好简约风。',
      kind: 'know_how',
    }, session.id);
    assert.equal(created.isError, false);
    assert.ok(created.text.includes('Saved new'));
    assert.ok(created.text.includes('version=1'));

    const revised = runner.runKnowledgeUpsertTool({
      topic: '用户喜欢的设计风格',
      summary: '偏好简约风：大量留白、最多两种主色、圆角卡片。',
      kind: 'principle',
      category: '设计',
    }, session.id);
    assert.equal(revised.isError, false);
    assert.ok(revised.text.includes('Updated'));
    assert.ok(revised.text.includes('version=2'));

    const entries = knowledgeStore.listKnowledge({ metabotId: 5, status: 'all' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].version, 2);
    assert.equal(entries[0].kind, 'principle');
    assert.equal(entries[0].origin, 'agent');
  } finally {
    cleanup();
  }
});

test('knowledge_upsert rejects empty topic or summary', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    const noTopic = runner.runKnowledgeUpsertTool({ topic: '', summary: 's' }, session.id);
    assert.equal(noTopic.isError, true);
    assert.ok(noTopic.text.includes('topic and summary are required'));

    const noSummary = runner.runKnowledgeUpsertTool({ topic: 't', summary: '' }, session.id);
    assert.equal(noSummary.isError, true);
  } finally {
    cleanup();
  }
});

test('knowledge_upsert records the originating session as a source pointer', async () => {
  const { cleanup, knowledgeStore, runner, session } = await setup();
  try {
    runner.runKnowledgeUpsertTool({
      topic: '某条经验',
      summary: '从这次对话里总结的。',
      kind: 'know_how',
    }, session.id);
    const entry = knowledgeStore.listKnowledge({ metabotId: 5 })[0];
    const sources = knowledgeStore.listKnowledgeSources(entry.id);
    assert.equal(sources.length, 1);
    assert.equal(sources[0].sessionId, session.id);
    assert.equal(sources[0].sourceChannel, 'cowork');
  } finally {
    cleanup();
  }
});
