/**
 * Improvement #4 (v1.3): plan-change disclosure in the acceptance surfaces.
 *
 * Covers the pure [PLAN_CHANGE] tag extractor, the deterministic "方案变更"
 * block in the acceptance summary text (present / omitted / capped), the
 * group_task_plan_changes store record + dedupe, the acceptance-summary
 * plan_changes_json snapshot roundtrip, and the daemon end-to-end path:
 * chair-only recording, review-entry group message, owner-report directive,
 * and the no-change task staying silent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

const originalLoad = Module._load;
Module._load = function patchedLoad(request, ...rest) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.call(this, request, ...rest);
};

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const { createGroupTaskDaemonLoop, extractPlanChangeLines } = require('../dist-electron/main/services/groupTaskDaemon.js');
const {
  buildAcceptanceSummary,
  buildAcceptanceSummaryMessageText,
  PLAN_CHANGE_MAX_RENDER_LINES,
} = require('../dist-electron/main/services/groupTaskAcceptanceSummary.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';
const CHANGE_LINE = 'seedream 生图 → 网络/无 ARK_API_KEY 受阻 → 改用本机 Pillow 生成 PNG（满足 PNG/≤200K/非SVG）';

// ---------------------------------------------------------------------------
// Pure: tag extractor + summary rendering
// ---------------------------------------------------------------------------

test('extractPlanChangeLines: all [PLAN_CHANGE] occurrences, order preserved; none -> []', () => {
  assert.deepEqual(extractPlanChangeLines(null), []);
  assert.deepEqual(extractPlanChangeLines('普通进度汇报，无标签'), []);
  assert.deepEqual(
    extractPlanChangeLines(`决议：[PLAN_CHANGE: ${CHANGE_LINE}]
重排后端子任务。`),
    [CHANGE_LINE],
  );
  assert.deepEqual(
    extractPlanChangeLines('[PLAN_CHANGE: a -> b -> c] 然后 [PLAN_CHANGE:  x -> y -> z ]'),
    ['a -> b -> c', 'x -> y -> z'],
  );
});

test('plan-change block: rendered when present, omitted when empty, capped at a few lines', () => {
  const base = {
    goal: 'Ship the intro MetaApp',
    acceptanceCriteria: 'Preview URL works',
    deliverables: [],
    members: [{ name: 'Twin', role: 'chair', workStatus: 'done' }],
    guidance: 'guidance-text',
  };
  const withChange = buildAcceptanceSummaryMessageText({ ...base, planChanges: [CHANGE_LINE] }, 'T');
  assert.ok(withChange.includes('方案变更：'), 'block header present');
  assert.ok(withChange.includes(`- ${CHANGE_LINE}`), 'the chair\'s own line renders verbatim');
  assert.ok(!withChange.includes('另有'), 'no overflow note for a single change');

  const withoutChange = buildAcceptanceSummaryMessageText({ ...base }, 'T');
  assert.ok(!withoutChange.includes('方案变更'), 'no block when nothing changed');

  const overflow = buildAcceptanceSummaryMessageText({
    ...base,
    planChanges: ['one', 'two', 'three', 'four', 'five'].map((n) => `${n} -> blocked -> ${n}-fallback`),
  }, 'T');
  assert.equal(
    (overflow.match(/^- /gm) ?? []).length,
    PLAN_CHANGE_MAX_RENDER_LINES,
    'deliverable-free summary renders exactly the capped plan-change lines',
  );
  assert.ok(overflow.includes('另有 2 项变更'), 'overflow collapses into one pointer line');
});

test('buildAcceptanceSummary threads planChanges into the snapshot + message text', () => {
  const built = buildAcceptanceSummary({
    task: { title: 'T', goal: 'G', acceptanceCriteria: 'C' },
    deliverables: [],
    members: [],
    planChanges: ['  ', CHANGE_LINE],
  });
  assert.deepEqual(built.planChanges, [CHANGE_LINE], 'blank lines dropped');
  assert.ok(built.messageText.includes(CHANGE_LINE));
});

// ---------------------------------------------------------------------------
// Store: plan-change record + acceptance-summary snapshot
// ---------------------------------------------------------------------------

const makeStore = async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-plan-change-'));
  const sqlite = await SqliteStore.create(tempDir);
  const db = sqlite.getDatabase();
  const store = new GroupTaskStore(db, sqlite.getSaveFunction());
  const task = store.createTask({
    groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
    acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
  });
  return { sqlite, store, task, cleanup: () => sqlite.close() };
};

test('store: addPlanChange / listPlanChanges / hasPlanChange dedupe', async () => {
  const h = await makeStore();
  try {
    assert.equal(h.store.listPlanChanges(h.task.id).length, 0);
    assert.equal(h.store.hasPlanChange(h.task.id, 'pin-1', CHANGE_LINE), false);

    const saved = h.store.addPlanChange({
      taskId: h.task.id, msgPinId: 'pin-1', authorGlobalmetaid: 'gmid-twin', summary: CHANGE_LINE,
    });
    assert.equal(saved.summary, CHANGE_LINE);
    assert.deepEqual(
      h.store.listPlanChanges(h.task.id).map((change) => change.summary),
      [CHANGE_LINE],
    );
    assert.equal(h.store.hasPlanChange(h.task.id, 'pin-1', CHANGE_LINE), true, 'exact duplicate detected');
    assert.equal(h.store.hasPlanChange(h.task.id, 'pin-2', CHANGE_LINE), false, 'different pin is a new fact');
  } finally {
    h.cleanup();
  }
});

test('store: acceptance summary snapshots planChanges; NULL column degrades to []', async () => {
  const h = await makeStore();
  try {
    h.store.saveAcceptanceSummary({
      taskId: h.task.id, goal: 'G', acceptanceCriteria: 'C',
      deliverables: [], members: [], guidance: 'gd', planChanges: [CHANGE_LINE],
    });
    assert.deepEqual(h.store.getLatestAcceptanceSummary(h.task.id).planChanges, [CHANGE_LINE]);

    // Legacy row (column NULL) degrades to "no plan change disclosed".
    h.store.saveAcceptanceSummary({
      taskId: h.task.id, goal: 'G', acceptanceCriteria: 'C',
      deliverables: [], members: [], guidance: 'gd',
    });
    assert.deepEqual(h.store.getLatestAcceptanceSummary(h.task.id).planChanges, []);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Daemon end-to-end: chair-only recording + review surfaces
// ---------------------------------------------------------------------------

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-plan-change-daemon-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp],
  );
};

const createDaemonHarness = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2' });

  const chatCalls = [];
  const sends = [];
  const logs = [];
  const state = { nowMs: 1_000_000_000_000 };

  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const loop = createGroupTaskDaemonLoop({
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    orchestrationBridge,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      return state.chatReply ?? `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    getChatSkillsRoutingPrompt: async () => ({ prompt: null, activeSkillIds: [] }),
    runSkillTurn: async () => ({ replyText: 'skill-turn-reply', assistantMessageId: 'asst-fake-1' }),
    sendOwnerPrivateReport: async () => ({ pinId: 'owner-report-pin' }),
    emitTaskEvent: () => {},
    emitLog: (msg) => logs.push(msg),
    now: () => state.nowMs,
  });

  const createTask = () => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 2, role: 'worker' });
    groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, groupTaskStore, loop, chatCalls, sends, logs, state, createTask,
    cleanup: () => store.close(),
  };
};

test('daemon: chair [PLAN_CHANGE] recorded (deduped on reprocess); worker tags ignored', async () => {
  const h = await createDaemonHarness();
  try {
    const task = h.createTask();
    insertGroupMessage(h.db, {
      pinId: 'plan1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `决议：处理 S1 生图受阻 + 重排后端子任务 [PLAN_CHANGE: ${CHANGE_LINE}]`,
    });
    insertGroupMessage(h.db, {
      pinId: 'plan2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[PLAN_CHANGE: worker 建议改用 xxx]`,
    });
    await h.loop.runTick();

    assert.deepEqual(
      h.groupTaskStore.listPlanChanges(task.id).map((change) => change.summary),
      [CHANGE_LINE],
      'only the chair resolution is recorded',
    );
    assert.equal(h.groupTaskStore.listPlanChanges(task.id)[0].msgPinId, 'plan1-i0');
    assert.ok(h.logs.some((line) => line.includes('plan change recorded')));

    // Reprocess the same chair message (cursor rewind): the pin+line dedupe
    // keeps the record at one row.
    const rows = h.groupTaskStore.listGroupChatMessages(GROUP_ID, { limit: 10 });
    const chairRow = rows.find((row) => row.pinId === 'plan1-i0');
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [chairRow.id - 1, task.id]);
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listPlanChanges(task.id).length, 1, 'no duplicate on reprocess');
  } finally {
    h.cleanup();
  }
});

test('daemon: review entry surfaces the 方案变更 block in the snapshot record and the owner-report directive', async () => {
  const h = await createDaemonHarness();
  try {
    const task = h.createTask();
    insertGroupMessage(h.db, {
      pinId: 'plan1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `决议：处理 S1 生图受阻 [PLAN_CHANGE: ${CHANGE_LINE}]`,
    });
    await h.loop.runTick();
    insertGroupMessage(h.db, {
      pinId: 'rv-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    // Single-commander: no group acceptance summary is posted — the snapshot
    // record (Tasks UI) and the owner-report directive carry the disclosure.
    assert.equal(
      h.sends.filter((s) => s.content.includes('已进入验收阶段')).length, 0,
      'no host acceptance summary in the group',
    );
    // Snapshot record (Tasks UI renders from it).
    assert.deepEqual(h.groupTaskStore.getLatestAcceptanceSummary(task.id).planChanges, [CHANGE_LINE]);
    // Owner-report directive (narrated into the A2A + source-session reports).
    const directiveCall = h.chatCalls.find((call) => call.userMessage.includes('owner-report directive'));
    assert.ok(directiveCall, 'owner report turn ran');
    assert.ok(directiveCall.userMessage.includes('Plan changes (the plan-change decisions'), 'directive has the plan-change block');
    assert.ok(directiveCall.userMessage.includes(CHANGE_LINE), 'directive carries the chair line');
  } finally {
    h.cleanup();
  }
});

test('daemon: a task with no plan change shows no block in any surface', async () => {
  const h = await createDaemonHarness();
  try {
    const task = h.createTask();
    insertGroupMessage(h.db, {
      pinId: 'rv-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    // Single-commander: no group summary exists at all — verify via the
    // snapshot and the owner-report directive instead.
    assert.equal(
      h.sends.filter((s) => s.content.includes('已进入验收阶段')).length, 0,
      'no host acceptance summary in the group',
    );
    assert.ok(!h.sends.some((s) => s.content.includes('方案变更')), 'no plan-change block anywhere');
    const directiveCall = h.chatCalls.find((call) => call.userMessage.includes('owner-report directive'));
    assert.ok(directiveCall, 'owner report turn ran');
    assert.ok(!directiveCall.userMessage.includes('Plan changes'), 'directive omits the block entirely');
    assert.deepEqual(h.groupTaskStore.getLatestAcceptanceSummary(task.id).planChanges, []);
    assert.equal(PLAN_CHANGE_MAX_RENDER_LINES, 3, 'render budget stays a few lines');
  } finally {
    h.cleanup();
  }
});
