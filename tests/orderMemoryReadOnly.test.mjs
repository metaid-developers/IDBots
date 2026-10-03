/**
 * Memory/persona audit P1: paid order execution runs in READ-ONLY memory
 * mode (privateChatOrderCowork passes memoryReadOnly instead of the old
 * disableMemoryUpdates blackout).
 *
 * These tests drive the REAL compiled CoworkRunner against an in-memory
 * sql.js store with a session shaped like an order execution session
 * (sessionType a2a + hidden + the metaweb_order conversation mapping) and
 * cover the read/write split:
 *   1. volatile READ injection is restored — self-identity, dream summaries
 *      and the scoped memory blocks ride the turn — with the external-channel
 *      privacy filter intact (owner profile facts never render);
 *   2. the turn-end WRITE path never enqueues under memoryReadOnly (and
 *      still enqueues for a fully-enabled control session);
 *   3. the tool surface splits: recall tools mount (memory_user_edits list
 *      incl. include_archived, experience_recall, knowledge_recall,
 *      procedure_recall), mutating tools drop (memory_user_edits writes,
 *      knowledge_upsert, procedure_save, procedure_archive);
 *   4. memory_user_edits mutations are rejected at the handler too, so the
 *      host-tool dispatch path cannot bypass registration gating;
 *   5. disableMemoryUpdates sessions keep the legacy full blackout
 *      (group-task bridge behavior unchanged).
 *
 * Run: npm run compile:electron && node --test tests/orderMemoryReadOnly.test.mjs
 */

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
const { MetaIDKnowledgeStore } = await import('../dist-electron/main/metaidKnowledgeStore.js');
const { DreamStore } = await import('../dist-electron/main/dreamStore.js');

const ORDER_CONVERSATION_ID = 'metaweb_order:seller:5:peer:aaaaaaaaaaaaaaaa';
const CONVERSATION_SCOPE_KEY = `metaweb_order:conversation:${ORDER_CONVERSATION_ID}`;

const setup = async () => {
  const { db, cleanup } = await createSqliteStore();
  const coworkStore = createCoworkStore(db);
  const dreamStore = new DreamStore(db, () => {});
  const knowledgeStore = new MetaIDKnowledgeStore(db, () => {}, () => 1000);
  const runner = new CoworkRunner(coworkStore, { experienceStore: dreamStore, knowledgeStore });
  // Session shaped like a privateChatOrderCowork execution session.
  const session = coworkStore.createSession('订单执行会话', '/tmp/a', '', 'local', [], 5, 'a2a', 'gmid-customer', 'Customer', null);
  coworkStore.setSessionHiddenFromList(session.id, true);
  coworkStore.upsertConversationMapping({
    channel: 'metaweb_order',
    externalConversationId: ORDER_CONVERSATION_ID,
    metabotId: 5,
    coworkSessionId: session.id,
  });

  // The bot's dream-written self-cognition + an owner-scope fact that must
  // stay behind the external-channel privacy filter + one memory scoped to
  // THIS order conversation.
  coworkStore.createUserMemory({
    metabotId: 5,
    text: '我是一个对付费订单极其较真的 MetaBot',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
    usageClass: 'self_identity',
    origin: 'dream',
  });
  coworkStore.createUserMemory({
    metabotId: 5,
    text: '主人真名是不该泄露的隐私',
    scopeKind: 'owner',
    scopeKey: 'owner:self',
  });
  coworkStore.createUserMemory({
    metabotId: 5,
    text: '这位客户上次验收要求海报必须附源文件',
    scopeKind: 'conversation',
    scopeKey: CONVERSATION_SCOPE_KEY,
  });
  dreamStore.upsertDailySummary({
    metabotId: 5,
    summaryDate: '2026-10-02',
    summaryText: '昨天完成了一单海报设计并复盘了验收意见',
    sections: {},
    stats: {},
    llmId: null,
  });
  knowledgeStore.upsertKnowledge({
    metabotId: 5,
    topic: '订单交付必须附 txid',
    summary: '没有 txid 的交付会被客户打回。',
    kind: 'pitfall',
  });
  knowledgeStore.upsertProcedure({
    metabotId: 5,
    title: '海报订单交付流程',
    triggerText: '客户下单海报设计',
    steps: ['确认需求', '生成初稿', '交付并附 txid'],
  });
  return { db, cleanup, coworkStore, dreamStore, knowledgeStore, runner, session };
};

const passthrough = (name, description, parameters, execute) => ({ name, description, parameters, execute });

test('read-only order session: volatile injection carries self-identity, dream summaries and privacy-filtered scoped memories', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    assert.equal(runner.isSessionMemoryReadEnabled(session.id), true, 'reads open');
    assert.equal(runner.isSessionMemoryWriteEnabled(session.id), false, 'writes closed');

    const profile = runner.getSystemPromptProfileForSession(session.id);
    assert.equal(profile.id, 'service_order_a2a');
    assert.equal(profile.includeMemoryPromptBlocks, true, 'order profile re-enables memory read blocks');
    assert.equal(profile.includeMemoryStrategy, false, 'memory write-strategy section stays off');

    const volatilePrompt = await runner.buildVolatileContextPrompt(session.id, '请开始制作海报', true, profile, true);
    assert.ok(volatilePrompt.includes('<metabot_self_identity>'), 'self-identity injected');
    assert.ok(volatilePrompt.includes('对付费订单极其较真'));
    assert.ok(volatilePrompt.includes('<recent_daily_summaries>'), 'dream summaries injected');
    assert.ok(volatilePrompt.includes('2026-10-02'));
    assert.ok(volatilePrompt.includes('必须附源文件'), 'order-conversation memory injected');
    assert.ok(
      !volatilePrompt.includes('不该泄露的隐私'),
      'owner profile fact stays behind the external-channel privacy filter',
    );
  } finally {
    cleanup();
  }
});

test('read-only order session: the turn-end memory write never enqueues (control session still enqueues)', async () => {
  const { cleanup, coworkStore, runner, session } = await setup();
  try {
    coworkStore.addMessage(session.id, { type: 'user', content: '帮我做一张海报' });
    coworkStore.addMessage(session.id, { type: 'assistant', content: '好的，初稿已完成。' });

    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    runner.applyTurnMemoryUpdatesForSession(session.id);
    assert.equal(runner.turnMemoryQueue.length, 0, 'no write job enqueued under read-only');
    assert.equal(runner.turnMemoryQueueKeys.size, 0);

    runner.activeSessions.set(session.id, {});
    runner.applyTurnMemoryUpdatesForSession(session.id);
    assert.equal(runner.turnMemoryQueueKeys.size, 1, 'fully-enabled session enqueues the write as before');
  } finally {
    cleanup();
  }
});

test('tool surface split: read-only mounts recall tools only; disableMemoryUpdates mounts neither (legacy blackout)', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    runner.activeSessions.set(session.id, {});
    const full = runner.buildSessionInlineTools(session.id, passthrough, undefined).map((t) => t.name);
    for (const name of ['memory_user_edits', 'experience_recall', 'knowledge_recall', 'procedure_recall', 'knowledge_upsert', 'procedure_save', 'procedure_archive']) {
      assert.ok(full.includes(name), `fully-enabled session mounts ${name}`);
    }

    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    const readOnlyTools = runner.buildSessionInlineTools(session.id, passthrough, undefined);
    const readOnlyNames = readOnlyTools.map((t) => t.name);
    for (const name of ['memory_user_edits', 'experience_recall', 'knowledge_recall', 'procedure_recall']) {
      assert.ok(readOnlyNames.includes(name), `read-only mounts recall tool ${name}`);
    }
    for (const name of ['knowledge_upsert', 'procedure_save', 'procedure_archive']) {
      assert.ok(!readOnlyNames.includes(name), `read-only drops mutating tool ${name}`);
    }
    const edits = readOnlyTools.find((t) => t.name === 'memory_user_edits');
    assert.ok(edits.description.includes('READ-ONLY'), 'memory_user_edits description says list-only');
    assert.deepEqual(edits.parameters.action.options, ['list'], 'memory_user_edits action enum narrowed to list');

    runner.activeSessions.set(session.id, { disableMemoryUpdates: true });
    const disabled = runner.buildSessionInlineTools(session.id, passthrough, undefined).map((t) => t.name);
    for (const name of ['memory_user_edits', 'experience_recall', 'knowledge_recall', 'procedure_recall', 'knowledge_upsert', 'procedure_save', 'procedure_archive']) {
      assert.ok(!disabled.includes(name), `blackout mounts no ${name} (group-task bridge behavior unchanged)`);
    }
  } finally {
    cleanup();
  }
});

test('memory_user_edits under read-only: list (incl. archived cold channel) works, mutations are rejected', async () => {
  const { cleanup, coworkStore, runner, session } = await setup();
  try {
    const retired = coworkStore.createUserMemory({
      metabotId: 5,
      text: '这位客户曾用旧版下单流程',
      scopeKind: 'conversation',
      scopeKey: CONVERSATION_SCOPE_KEY,
      origin: 'dream',
    });
    coworkStore.archiveUserMemories({ ids: [retired.id], archivedAt: Date.now() });

    runner.activeSessions.set(session.id, { memoryReadOnly: true });
    const add = runner.runMemoryUserEditsTool({ action: 'add', text: '客户偏好蓝色' }, session.id);
    assert.equal(add.isError, true);
    assert.match(add.text, /read-only/i);
    assert.equal(runner.runMemoryUserEditsTool({ action: 'update', id: retired.id, text: 'x' }, session.id).isError, true);
    assert.equal(runner.runMemoryUserEditsTool({ action: 'delete', id: retired.id }, session.id).isError, true);

    const list = runner.runMemoryUserEditsTool({ action: 'list' }, session.id);
    assert.equal(list.isError, false);
    assert.ok(list.text.includes('必须附源文件'), 'list still reads the order-conversation rows');
    const cold = runner.runMemoryUserEditsTool({ action: 'list', include_archived: true }, session.id);
    assert.equal(cold.isError, false);
    assert.ok(cold.text.includes('旧版下单流程'), 'include_archived cold channel stays readable');

    runner.activeSessions.set(session.id, {});
    const controlAdd = runner.runMemoryUserEditsTool({ action: 'add', text: '客户偏好蓝色' }, session.id);
    assert.equal(controlAdd.isError, false, 'fully-enabled session writes as before');
  } finally {
    cleanup();
  }
});

test('disableMemoryUpdates sessions keep the full blackout on volatile injection too', async () => {
  const { cleanup, runner, session } = await setup();
  try {
    runner.activeSessions.set(session.id, { disableMemoryUpdates: true });
    assert.equal(runner.isSessionMemoryReadEnabled(session.id), false);
    assert.equal(runner.isSessionMemoryWriteEnabled(session.id), false);
    const profile = runner.getSystemPromptProfileForSession(session.id);
    const volatilePrompt = await runner.buildVolatileContextPrompt(session.id, '请开始制作海报', false, profile, true);
    assert.ok(!volatilePrompt.includes('<metabot_self_identity>'));
    assert.ok(!volatilePrompt.includes('<recent_daily_summaries>'));
    assert.ok(!volatilePrompt.includes('<conversationMemories>'));
  } finally {
    cleanup();
  }
});
