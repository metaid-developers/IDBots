/**
 * HITL (human-in-the-loop) group task checkpoints:
 *  - schema + store CRUD (single-open enforcement, resolve/cancel)
 *  - responder gating while a checkpoint is open (review-phase-like silence)
 *  - daemon tag flow: [CHECKPOINT: topic] opens (pause line + private owner
 *    report), [CHECKPOINT_RESOLVED: decision] resolves and resumes work,
 *    review entry supersedes an open checkpoint
 *  - service flow: closeGroupTask cancels an open checkpoint
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
const {
  decideGroupTaskResponders,
  createGroupTaskDaemonLoop,
  extractCheckpointDecisionSummary,
  truncateCheckpointSummary,
} = require('../dist-electron/main/services/groupTaskDaemon.js');
const groupTaskService = require('../dist-electron/main/services/groupTaskService.js');

Module._load = originalLoad;

const {
  closeGroupTask,
  getGroupTask,
  setGroupTaskServiceMetabotStoreGetter,
  setGroupTaskServiceGroupTaskStoreGetter,
  setGroupTaskServiceOrchestrationBridgeGetter,
  setGroupTaskServiceKvStoreGetter,
  setGroupTaskServiceCoworkStoreGetter,
  setGroupTaskServiceTransport,
  resetGroupTaskServiceTransport,
} = groupTaskService;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-checkpoint-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, llmId = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, llmId, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content, chainTimestamp],
  );
};

const createHarness = async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID, llmId: 'llm-1' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', llmId: 'llm-2' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3', llmId: 'llm-3' });

  const chatCalls = [];
  const sends = [];
  const events = [];
  const ownerReportCalls = [];
  const state = { nowMs: 1_000_000_000_000 };
  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const deps = {
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    orchestrationBridge,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      return `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    getChatSkillsRoutingPrompt: async () => ({ prompt: null, activeSkillIds: [] }),
    runSkillTurn: async () => ({ replyText: 'skill-turn-reply', assistantMessageId: 'asst-fake-1' }),
    emitTaskEvent: (payload) => {
      events.push(payload);
    },
    sendOwnerPrivateReport: async (params) => {
      ownerReportCalls.push(params);
      return {
        pinId: `owner-report-pin-${ownerReportCalls.length}`,
        sessionId: `owner-report-session-${ownerReportCalls.length}`,
      };
    },
    readPinForVerification: async () => 'unavailable',
    probeUrl: async () => null,
    emitLog: () => {},
    now: () => state.nowMs,
    workerCooldownMs: 20_000,
    chairCooldownMs: 10_000,
    replyBudget: 40,
    maxRepliesPerTaskPerTick: 3,
    chairPlanRosterSettleMs: 0,
    chairPlanRosterCapMs: 0,
  };
  const loop = (() => {
    // fix/group-task-flow follow-up: responder turns run as detached async
    // jobs now. Preserve the historical test contract ("when runTick()
    // resolves, every triggered turn has completed") by draining pending
    // turn jobs after the tick — same wrapper as groupTaskDaemon.test.mjs.
    const rawLoop = createGroupTaskDaemonLoop(deps);
    return {
      ...rawLoop,
      runTick: async () => {
        await rawLoop.runTick();
        await rawLoop.whenIdle();
      },
    };
  })();

  const createTask = (workerIds = [2], opts = {}) => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    for (const workerId of workerIds) {
      groupTaskStore.addMember({ taskId: task.id, metabotId: workerId, role: 'worker' });
    }
    if (opts.activate !== false) {
      groupTaskStore.updateTaskStatus(task.id, 'executing');
    }
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, loop, deps,
    orchestrationBridge, chatCalls, sends, events, ownerReportCalls, state, createTask,
    cleanup: () => store.close(),
  };
};

// ---------------------------------------------------------------------------
// Schema + store CRUD
// ---------------------------------------------------------------------------

test('schema: group_task_checkpoints table and index are created on open', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  try {
    const cols = (db.exec('PRAGMA table_info(group_task_checkpoints)')[0]?.values || []).map((row) => String(row[1]));
    for (const col of ['id', 'task_id', 'topic', 'opened_msg_pin_id', 'status', 'resolution', 'resolved_msg_pin_id']) {
      assert.ok(cols.includes(col), `group_task_checkpoints.${col} should exist`);
    }
    const indexes = (db.exec('PRAGMA index_list(group_task_checkpoints)')[0]?.values || []).map((row) => String(row[1]));
    assert.ok(indexes.includes('idx_group_task_checkpoints_task'), 'idx_group_task_checkpoints_task should exist');
  } finally {
    store.close();
  }
});

test('store: open/get/resolve/list, single-open enforcement, closeOpenCheckpoints', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([], { activate: false });

    const opened = h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: '修改意见稿确认', msgPinId: 'cp-open-i0' });
    assert.equal(opened.status, 'open');
    assert.equal(opened.topic, '修改意见稿确认');
    assert.equal(opened.openedMsgPinId, 'cp-open-i0');
    assert.equal(h.groupTaskStore.getOpenCheckpoint(task.id)?.id, opened.id);

    // single-open enforcement
    assert.throws(
      () => h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: 'second' }),
      /already has an open checkpoint/,
    );

    const resolved = h.groupTaskStore.resolveCheckpoint(opened.id, { resolution: '主人已确认', msgPinId: 'cp-res-i0' });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolution, '主人已确认');
    assert.equal(resolved.resolvedMsgPinId, 'cp-res-i0');
    assert.ok(resolved.resolvedAt, 'resolved_at set');
    assert.equal(h.groupTaskStore.getOpenCheckpoint(task.id), null, 'no open checkpoint after resolve');

    // resolving a closed checkpoint is an idempotent no-op
    const again = h.groupTaskStore.resolveCheckpoint(opened.id, { resolution: 'other' });
    assert.equal(again.resolution, '主人已确认', 'closed checkpoint is returned unchanged');

    // a new checkpoint may open once the previous one is resolved
    const second = h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: '第二轮确认' });
    assert.equal(second.status, 'open');
    const closedCount = h.groupTaskStore.closeOpenCheckpoints(task.id, 'cancelled', 'task closed as cancelled');
    assert.equal(closedCount, 1);
    assert.equal(h.groupTaskStore.getCheckpointById(second.id).status, 'cancelled');

    const all = h.groupTaskStore.listCheckpoints(task.id);
    assert.deepEqual(all.map((c) => [c.id, c.status]), [
      [opened.id, 'resolved'],
      [second.id, 'cancelled'],
    ], 'checkpoints listed oldest first');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Pure gating
// ---------------------------------------------------------------------------

const GATE_BOTS = new Map([
  [1, { id: 1, name: 'Twin Bot', metaid: 'metaid-1', globalmetaid: 'gmid-twin', boss_global_metaid: BOSS_GMID }],
  [2, { id: 2, name: 'Coder Bot', metaid: 'metaid-2', globalmetaid: 'gmid-w2', boss_global_metaid: BOSS_GMID }],
  [3, { id: 3, name: 'Designer Bot', metaid: 'metaid-3', globalmetaid: 'gmid-w3', boss_global_metaid: BOSS_GMID }],
]);
const GATE_MEMBERS = [
  { metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', name: 'Twin Bot' },
  { metabotId: 2, globalmetaid: 'gmid-w2', role: 'worker', name: 'Coder Bot' },
  { metabotId: 3, globalmetaid: 'gmid-w3', role: 'worker', name: 'Designer Bot' },
];
const gateMessage = (overrides = {}) => ({
  id: 1,
  senderMetaId: 'metaid-human',
  senderGlobalMetaId: 'gmid-human',
  senderName: 'Human',
  content: 'hello group',
  mention: null,
  senderSuspect: false,
  ...overrides,
});

test('gating: an open HITL checkpoint mirrors review-phase silence', () => {
  const checkpointTask = { id: 1, status: 'executing', hasOpenCheckpoint: true };

  // worker @-mentioned during a checkpoint -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Coder Bot keep building' }),
      checkpointTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // chair @-mentioned by a non-owner -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Twin Bot what now?' }),
      checkpointTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // unaddressed (floor control) -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: 'just thinking out loud' }),
      checkpointTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // deliverable during a checkpoint -> chair stays silent (the group is paused)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] url: https://example.com' }),
      checkpointTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // owner message -> the chair (and only the chair) responds
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: BOSS_GMID, content: 'draft approved, carry on' }),
      checkpointTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_owner_message' }],
  );
  // without the flag the same executing task behaves normally (floor control)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: 'just thinking out loud' }),
      { id: 1, status: 'executing' }, GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
    'no checkpoint -> normal executing gating',
  );
});

// ---------------------------------------------------------------------------
// Daemon tag flow
// ---------------------------------------------------------------------------

test('loop: chair [CHECKPOINT] opens a checkpoint (pause line + event + private report); worker tag ignored', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);

    // A worker-issued checkpoint tag carries no authority.
    insertGroupMessage(h.db, {
      pinId: 'cp-w-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[CHECKPOINT: worker fake] trying to pause',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getOpenCheckpoint(task.id), null, 'worker checkpoint tag ignored');
    assert.equal(h.ownerReportCalls.length, 0, 'no private report for a worker tag');

    // The chair opens one with its draft message.
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，修改意见稿已整理好，先请主人过目。 [CHECKPOINT: 官网修改意见稿确认]',
    });
    await h.loop.runTick();

    const checkpoint = h.groupTaskStore.getOpenCheckpoint(task.id);
    assert.ok(checkpoint, 'checkpoint opened by the chair tag');
    assert.equal(checkpoint.topic, '官网修改意见稿确认');
    assert.equal(checkpoint.openedMsgPinId, 'cp-open-i0');

    // Single-commander: no pause ceremony line is posted under the chair's
    // name — the checkpoint reaches the owner through the private report
    // (whose text the chair composes itself after reading the host note).
    assert.equal(
      h.sends.filter((send) => send.content.includes('人工确认点')).length,
      0,
      'no pause ceremony line',
    );

    const changedEvents = h.events.filter((e) => e.type === 'groupTask:checkpointChanged');
    assert.equal(changedEvents.length, 1);
    assert.equal(changedEvents[0].status, 'open');
    assert.equal(changedEvents[0].checkpointId, checkpoint.id);

    assert.equal(h.ownerReportCalls.length, 1, 'private checkpoint request sent to the owner');
    assert.equal(h.ownerReportCalls[0].kind, 'checkpoint');
    assert.equal(h.ownerReportCalls[0].checkpointId, checkpoint.id);
    assert.ok(typeof h.ownerReportCalls[0].text === 'string' && h.ownerReportCalls[0].text.length > 0, 'the chair-composed report body ships to the owner');
  } finally {
    h.cleanup();
  }
});

test('loop: a topic-only [CHECKPOINT] still opens privately with no host post', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[CHECKPOINT: 意见稿确认]',
    });
    await h.loop.runTick();

    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id), 'checkpoint opened');
    // Single-commander: no pause line at all — topic-only or not, the host
    // stays silent and the owner learns of it through the private report.
    assert.equal(h.sends.length, 0, 'the host posts nothing');
    assert.equal(h.ownerReportCalls.length, 1, 'the private checkpoint report still goes out');
    assert.ok(typeof h.ownerReportCalls[0].text === 'string' && h.ownerReportCalls[0].text.length > 0);
  } finally {
    h.cleanup();
  }
});

test('loop: an open checkpoint gates worker replies; the owner still reaches the chair', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '先请主人确认意见稿。 [CHECKPOINT: 意见稿确认]',
    });
    await h.loop.runTick();
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id));

    h.chatCalls.length = 0;
    h.sends.length = 0;

    // Worker dispatch attempt during the checkpoint -> gated silent, no LLM call.
    insertGroupMessage(h.db, {
      pinId: 'cp-dispatch-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 先做第三部分',
    });
    // The owner's reply reaches the chair.
    insertGroupMessage(h.db, {
      pinId: 'cp-owner-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Owner', content: '第三部分再强调一下 gasfee，其他没问题',
    });
    await h.loop.runTick();

    assert.equal(
      h.chatCalls.filter((call) => call.llmId === 'llm-2').length, 0,
      'no LLM call for the gated worker dispatch',
    );
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2).length, 0,
      'worker never replied during the checkpoint',
    );
    const chairReply = h.sends.find((send) => send.metabotId === 1 && send.content === 'reply-for-llm-1');
    assert.ok(chairReply, 'chair answered the owner during the checkpoint');

    // checkpoint is still open (the owner asked for a change; the chair iterates)
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id));
  } finally {
    h.cleanup();
  }
});

test('loop: [CHECKPOINT_RESOLVED] closes the checkpoint and work resumes', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '先请主人确认意见稿。 [CHECKPOINT: 意见稿确认]',
    });
    await h.loop.runTick();
    const opened = h.groupTaskStore.getOpenCheckpoint(task.id);
    assert.ok(opened);

    h.chatCalls.length = 0;
    h.sends.length = 0;
    h.events.length = 0;

    insertGroupMessage(h.db, {
      pinId: 'cp-res-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 主人已确认意见稿，按稿开发新版官网。 [CHECKPOINT_RESOLVED: 主人确认了修改意见稿]',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getOpenCheckpoint(task.id), null, 'checkpoint resolved');
    const resolved = h.groupTaskStore.getCheckpointById(opened.id);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.resolution, '主人确认了修改意见稿');
    assert.equal(resolved.resolvedMsgPinId, 'cp-res-i0');

    // Single-commander: no resume ceremony line — resolution is recorded and
    // surfaces through events and the private channels only.
    assert.equal(
      h.sends.filter((send) => send.metabotId === 1 && send.content.includes('人工确认点已通过')).length,
      0,
      'the host posts no resume line',
    );

    const changedEvents = h.events.filter((e) => e.type === 'groupTask:checkpointChanged');
    assert.deepEqual(
      changedEvents.map((e) => [e.checkpointId, e.status]),
      [[opened.id, 'resolved']],
      'checkpointChanged event for the resolution',
    );

    // work resumes: the @-mentioned worker replied in the same tick
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && send.content === 'reply-for-llm-2'),
      'worker replied after the checkpoint resolved',
    );
  } finally {
    h.cleanup();
  }
});

test('loop: review entry supersedes an open checkpoint', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '先请主人确认意见稿。 [CHECKPOINT: 意见稿确认]',
    });
    await h.loop.runTick();
    const opened = h.groupTaskStore.getOpenCheckpoint(task.id);
    assert.ok(opened);

    insertGroupMessage(h.db, {
      pinId: 'cp-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal looks met\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const checkpoint = h.groupTaskStore.getCheckpointById(opened.id);
    assert.equal(checkpoint.status, 'resolved', 'review entry supersedes the open checkpoint');
    assert.equal(checkpoint.resolution, 'superseded by review entry');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Service flow
// ---------------------------------------------------------------------------

test('service: closeGroupTask cancels an open checkpoint', async () => {
  const h = await createHarness();
  setGroupTaskServiceMetabotStoreGetter(() => h.metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => h.groupTaskStore);
  setGroupTaskServiceOrchestrationBridgeGetter(() => h.orchestrationBridge);
  setGroupTaskServiceKvStoreGetter(() => h.store);
  setGroupTaskServiceCoworkStoreGetter(() => h.coworkStore);
  setGroupTaskServiceTransport({
    createGroupChat: async () => ({ groupId: GROUP_ID, pinId: GROUP_ID }),
    joinGroupChat: async (metabotId) => ({ pinId: `join-pin-${metabotId}` }),
    joinGroupChatAsIdentity: async () => ({ pinId: 'owner-join-pin' }),
    sendGroupChatMessage: async () => ({ pinId: 'msg-pin' }),
    sendGroupChatMessageAsIdentity: async () => ({ pinId: 'identity-send-pin' }),
    waitForGroupIndexed: async () => true,
  });
  try {
    const task = h.createTask([2]);
    const opened = h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: '意见稿确认' });

    await closeGroupTask(task.id, { status: 'cancelled', reason: 'owner called it off' });

    const checkpoint = h.groupTaskStore.getCheckpointById(opened.id);
    assert.equal(checkpoint.status, 'cancelled', 'open checkpoint cancelled with the task');
    assert.equal(h.groupTaskStore.getOpenCheckpoint(task.id), null);
  } finally {
    resetGroupTaskServiceTransport();
    h.cleanup();
  }
});

test('service: getGroupTask detail carries the open checkpoint decision summary', async () => {
  const h = await createHarness();
  setGroupTaskServiceMetabotStoreGetter(() => h.metabotStore);
  setGroupTaskServiceGroupTaskStoreGetter(() => h.groupTaskStore);
  setGroupTaskServiceOrchestrationBridgeGetter(() => h.orchestrationBridge);
  setGroupTaskServiceKvStoreGetter(() => h.store);
  setGroupTaskServiceCoworkStoreGetter(() => h.coworkStore);
  try {
    const task = h.createTask([2]);
    // The chair's opening message: body + [CHECKPOINT: topic] tag.
    insertGroupMessage(h.db, {
      pinId: 'cp-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，修改意见稿已整理好，先请主人过目。 [CHECKPOINT: 官网修改意见稿确认]',
    });
    const opened = h.groupTaskStore.openCheckpoint({
      taskId: task.id, topic: '官网修改意见稿确认', msgPinId: 'cp-open-i0',
    });

    // While open, the detail exposes the tag-free chair body as the decision
    // summary — the banner shows what the owner must decide.
    const detail = await getGroupTask(task.id);
    assert.equal(
      detail.openCheckpointSummary,
      '各位，修改意见稿已整理好，先请主人过目。',
      'openCheckpointSummary is the tag-free [CHECKPOINT] message body',
    );
    assert.equal(detail.checkpoints.find((c) => c.id === opened.id)?.status, 'open');

    // Opening message missing from the transcript -> summary falls back to null.
    h.groupTaskStore.resolveCheckpoint(opened.id, { resolution: '主人已确认', msgPinId: 'cp-res-i0' });
    const orphan = h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: '意见稿确认', msgPinId: 'no-such-pin-i0' });
    const detailOrphan = await getGroupTask(task.id);
    assert.equal(detailOrphan.openCheckpointSummary, null, 'no summary when the opening message is unavailable');

    // Resolved -> nothing left to decide -> summary is null.
    h.groupTaskStore.resolveCheckpoint(orphan.id, { resolution: '主人已确认' });
    const after = await getGroupTask(task.id);
    assert.equal(after.openCheckpointSummary, null, 'summary cleared once the checkpoint resolves');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Decision summary derivation (pause line / banner payload)
// ---------------------------------------------------------------------------

test('util: extractCheckpointDecisionSummary strips tags from the chair body', () => {
  // Body + tag -> tag-free body (this is what the owner must decide).
  assert.equal(
    extractCheckpointDecisionSummary('各位，修改意见稿已整理好，先请主人过目。 [CHECKPOINT: 官网修改意见稿确认]'),
    '各位，修改意见稿已整理好，先请主人过目。',
  );
  // Document links inside the body survive untouched.
  assert.equal(
    extractCheckpointDecisionSummary('修改意见稿见文档：https://manapi.metaid.io/x/abc [CHECKPOINT: 意见稿确认]'),
    '修改意见稿见文档：https://manapi.metaid.io/x/abc',
  );
  // Tag-only body -> null (callers fall back to the topic).
  assert.equal(extractCheckpointDecisionSummary('[CHECKPOINT: 意见稿确认]'), null);
  assert.equal(extractCheckpointDecisionSummary('  [CHECKPOINT_RESOLVED: 通过]  '), null);
  assert.equal(extractCheckpointDecisionSummary(null), null);
  assert.equal(extractCheckpointDecisionSummary(''), null);
  assert.equal(extractCheckpointDecisionSummary('   '), null);
});

test('util: truncateCheckpointSummary keeps short summaries and cuts long ones', () => {
  assert.equal(truncateCheckpointSummary('short summary'), 'short summary');
  const long = 'a'.repeat(300);
  const cut = truncateCheckpointSummary(long);
  assert.ok(cut.endsWith('…'), 'long summary ends with an ellipsis');
  assert.ok(cut.length <= 121, `cut length ${cut.length} <= 121`);
  assert.equal(truncateCheckpointSummary(long, 20).length, 21, 'custom maxLength respected');
  assert.equal(truncateCheckpointSummary('  padded  '), 'padded');
});
