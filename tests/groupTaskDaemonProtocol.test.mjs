/**
 * Round-5 daemon protocol tests: P0-2 worker ACK (post + kv dedupe),
 * P0-1 review-phase dispatch silence hint, P2-6 [DEPENDS_ON] gate, and
 * P2-8 multi-driver kv mutex.
 *
 * Harness mirrors groupTaskDaemon.test.mjs (same electron mock + stores) and
 * additionally keeps the loop deps so a SECOND daemon loop can be created over
 * the SAME kv/store to exercise the driver mutex.
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
const { createGroupTaskDaemonLoop, gateChairDrivingSend, clearGroupTaskReviewDeliveryGuards } = require('../dist-electron/main/services/groupTaskDaemon.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';
const UPSTREAM_PINID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaai0';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-daemon-protocol-'));

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, allowChatSkills = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, allow_chat_skills, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, allowChatSkills ? JSON.stringify(allowChatSkills) : null,
      1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessage = (db, { pinId, senderMetaId, senderGlobalMetaId, senderName, content, mention = null, chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', ?, ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content,
      mention ? JSON.stringify(mention) : '[]', chainTimestamp],
  );
};

const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const groupTaskStore = new GroupTaskStore(db, store.getSaveFunction());
  const orchestrationStore = new OrchestrationStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 1);
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', allowChatSkills: overrides.coderChatSkills ?? [] });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3' });

  const chatCalls = [];
  const sends = [];
  const routingCalls = [];
  const skillTurnCalls = [];
  const logs = [];
  const ownerReports = [];
  const sourceReviewReports = [];
  const state = {
    nowMs: 1_000_000_000_000,
    chatErrorAlways: overrides.chatErrorAlways ?? null,
    routing: overrides.routing ?? null,
    chatReply: overrides.chatReply ?? null,
    skillReply: overrides.skillReply ?? null,
  };

  const orchestrationBridge = new GroupTaskOrchestrationBridge({
    groupTaskStore,
    orchestrationStore,
    getMetabotById: (id) => metabotStore.getMetabotById(id),
  });

  const loopDeps = {
    getStore: () => store,
    getGroupTaskStore: () => groupTaskStore,
    getMetabotStore: () => metabotStore,
    getCoworkStore: () => coworkStore,
    orchestrationBridge,
    performChat: overrides.performChat ?? (async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      if (state.chatErrorAlways) throw new Error(state.chatErrorAlways);
      return state.chatReply ?? `reply-for-${llmId}`;
    }),
    postGroupTaskMessage: async (taskId, metabotId, content) => {
      sends.push({ taskId, metabotId, content });
      return { pinId: `send-pin-${sends.length}` };
    },
    getChatSkillsRoutingPrompt: async (input) => {
      routingCalls.push(input);
      return typeof state.routing === 'function'
        ? state.routing(input)
        : (state.routing ?? { prompt: null, activeSkillIds: [] });
    },
    runSkillTurn: async (params) => {
      skillTurnCalls.push(params);
      return { replyText: state.skillReply ?? 'skill-turn-reply', assistantMessageId: 'asst-fake-1' };
    },
    emitTaskEvent: () => {},
    emitLog: (msg) => logs.push(msg),
    now: () => state.nowMs,
    workerCooldownMs: overrides.workerCooldownMs ?? 20_000,
    chairCooldownMs: overrides.chairCooldownMs ?? 10_000,
    replyBudget: overrides.replyBudget ?? 40,
    maxRepliesPerTaskPerTick: overrides.maxRepliesPerTaskPerTick ?? 3,
    ...(overrides.disableChairPlanningTurn != null ? { disableChairPlanningTurn: overrides.disableChairPlanningTurn } : {}),
    ...(overrides.autoAckWorkerDispatch != null ? { autoAckWorkerDispatch: overrides.autoAckWorkerDispatch } : {}),
    ...(overrides.sendOwnerPrivateReport != null ? { sendOwnerPrivateReport: overrides.sendOwnerPrivateReport } : {}),
    ...(overrides.sendReviewReportToSourceSession != null ? { sendReviewReportToSourceSession: overrides.sendReviewReportToSourceSession } : {}),
    ...(overrides.dependencyWaitMaxMs != null ? { dependencyWaitMaxMs: overrides.dependencyWaitMaxMs } : {}),
    ...(overrides.driverGraceMs != null ? { driverGraceMs: overrides.driverGraceMs } : {}),
    ...(overrides.readPinForVerification != null ? { readPinForVerification: overrides.readPinForVerification } : {}),
    ...(overrides.readPinSecondaryForVerification != null ? { readPinSecondaryForVerification: overrides.readPinSecondaryForVerification } : {}),
    ...(overrides.uploadDeliverableFile != null ? { uploadDeliverableFile: overrides.uploadDeliverableFile } : {}),
  };

  const rawLoop = createGroupTaskDaemonLoop(loopDeps);
  // fix/group-task-flow: responder turns run as detached async jobs now.
  // Preserve the historical test contract ("when runTick() resolves, every
  // triggered turn has completed") by draining pending turn jobs after the tick.
  const drainLoop = (target) => ({
    ...target,
    runTick: async () => {
      await target.runTick();
      await target.whenIdle();
    },
  });
  const loop = drainLoop(rawLoop);

  const createTask = (workerIds = [2, 3], opts = {}) => {
    const task = groupTaskStore.createTask({
      groupId: GROUP_ID, title: 'Build MetaApp', goal: 'Build and publish the intro MetaApp',
      acceptanceCriteria: 'Preview URL works', chairMetabotId: 1, createdBy: 'user', createPinId: 'pin-create',
    });
    groupTaskStore.addMember({ taskId: task.id, metabotId: 1, globalmetaid: 'gmid-twin', role: 'chair', joinedPinId: 'pin-create' });
    for (const workerId of workerIds) {
      groupTaskStore.addMember({ taskId: task.id, metabotId: workerId, role: 'worker' });
    }
    if (opts.activate !== false) {
      groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
    }
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore,
    loop, chatCalls, sends, routingCalls, skillTurnCalls, logs, ownerReports, sourceReviewReports, state, createTask,
    /** A SECOND daemon loop over the SAME stores/kv (multi-instance mutex). */
    makeSecondLoop: () => drainLoop(createGroupTaskDaemonLoop(loopDeps)),
    cleanup: () => store.close(),
  };
};

// ---------------------------------------------------------------------------
// P0-2: worker ACK
// ---------------------------------------------------------------------------

test('single-commander: worker skill-turn dispatch posts no ACK — only the turn reply; reprocessing never resurrects one', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'ack-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 配图任务，请开始',
    });
    await h.loop.runTick();

    // Single-commander: the host is the environment, never a speaker —
    // the worker's own turn reply is the only message (no [WORKING] ACK post).
    assert.deepEqual(h.sends.map((s) => s.content), ['skill-turn-reply'], 'turn reply only — no ACK post');

    // Rewind the cursor so the SAME message reprocesses (simulating a retry):
    // a deleted ACK cannot resurrect, and the ACK kv guard is gone with it.
    h.state.nowMs += 25_000; // escape the worker cooldown
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = 0 WHERE id = ?', [task.id]);
    await h.loop.runTick();

    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no ACK post on reprocessing either',
    );
  } finally {
    h.cleanup();
  }
});

test('auto-ACK: disabled via deps flag — no ACK posted', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
    autoAckWorkerDispatch: false,
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'noack-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do the work',
    });
    await h.loop.runTick();
    assert.deepEqual(h.sends.map((s) => s.content), ['skill-turn-reply'], 'no ACK when disabled');
  } finally {
    h.cleanup();
  }
});

test('P14: chair protocol messages (carrying [DELIVERABLE]/[STATUS:] tags) never auto-ACK', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]);
    // A chair note that both mentions the worker and carries a protocol tag is
    // coordination, not an assignment (task #22: template ACKs quoting status
    // notes as "assignments").
    insertGroupMessage(h.db, {
      pinId: 'chair-status-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot [DELIVERABLE] 已收到上游成果，稍后派工',
    });
    await h.loop.runTick();
    // Single-commander: the ACK machinery is gone. A chair note mentioning the
    // worker still dispatches the worker's turn normally (the chair decides
    // what is coordination via its own context) — but no template ACK post
    // can ever appear.
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no ACK machinery left to misfire',
    );
  } finally {
    h.cleanup();
  }
});

test('P14: no stale 已接单 ACK after the worker already delivered past the assignment', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    const task = h.createTask([2]);
    // Worker delivers first (deliverable row created now); the chair
    // coordination note that arrives afterwards must not produce an ACK
    // claiming the worker just accepted work (eleven's empty-assignment
    // ACK case in task #22).
    const deliveredPin = 'e'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'done-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metafile: metafile://${deliveredPin}`,
      chainTimestamp: 100,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'deliverable recorded');

    insertGroupMessage(h.db, {
      pinId: 'late-chair-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 整合进 MetaApp', chainTimestamp: 101,
    });
    h.state.nowMs += 25_000; // escape the worker cooldown
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no ACK claiming un-started work after delivery',
    );
  } finally {
    h.cleanup();
  }
});

test('P5: roll-call (请确认在线) mentions arm no ACK watch — no false no-ACK warning', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rollcall-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot:请确认在线(每人一次即可,无需客套)。',
    });
    await h.loop.runTick();
    assert.ok(h.logs.some((line) => line.includes('roll-call mention') && line.includes('no ACK watch armed')));
    // Long past the 3-minute ACK timeout: no chair warning may fire (task #21
    // falsely warned about members who were merely waiting/observing).
    h.state.nowMs += 10 * 60 * 1000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK')).length,
      0,
      'no false no-ACK reminder for a roll-call mention',
    );
  } finally {
    h.cleanup();
  }
});

test('P4 (v1.2): review entry delivers the owner report body to the origin session; rework hatch re-arms it', async () => {
  const h = await createHarness({
    sendOwnerPrivateReport: async (params) => ({ pinId: 'owner-report-pin' }),
    sendReviewReportToSourceSession: ({ taskId, report }) => {
      h.sourceReviewReports.push({ taskId, report });
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'r1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.equal(h.sourceReviewReports.length, 1, 'review entry -> one source-session report');
    assert.match(h.sourceReviewReports[0].report, /reply-for-/);
    assert.equal(h.sourceReviewReports[0].taskId, task.id);
    // A2A guard set; source-review guard set by the service in production —
    // here the dep is a stub, so assert the A2A guard holds the pair.
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1');

    // Rework hatch: review -> executing clears the guards...
    insertGroupMessage(h.db, {
      pinId: 'rework-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '返工：PNG 基线重建\n[STATUS:EXECUTING]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.ok(h.store.get(`group_task_owner_reported:${task.id}`) == null, 'A2A guard cleared by rework hatch');
    assert.ok(h.store.get(`group_task_review_notified:${task.id}`) == null, 'source-review guard cleared by rework hatch');

    // ...so the NEXT review re-reports to both channels. The clock must first
    // move past the Improvement #2 review re-entry debounce (the rework hatch
    // stamped group_task_rework_at; a REVIEW tag within 30s of it would be
    // treated as a stale in-flight verdict and skipped).
    h.state.nowMs += 31_000;
    insertGroupMessage(h.db, {
      pinId: 'r2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '返工完成，再次验收\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(h.sourceReviewReports.length, 2, 'second review re-reports to the source session');
  } finally {
    h.cleanup();
  }
});

test('Improvement #2: a chair [STATUS:REVIEW] verdict landing within the rework debounce window is skipped (task #24 race)', async () => {
  const h = await createHarness({
    sendOwnerPrivateReport: async () => ({ pinId: 'owner-report-pin' }),
    sendReviewReportToSourceSession: ({ taskId, report }) => {
      h.sourceReviewReports.push({ taskId, report });
    },
  });
  try {
    const task = h.createTask([2]);

    insertGroupMessage(h.db, {
      pinId: 'rv1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.equal(h.sourceReviewReports.length, 1);
    // Single-commander: the host no longer posts an acceptance summary —
    // review entry is reported through the owner/source-session channels only.
    assert.equal(
      h.sends.filter((s) => s.content.includes('已进入验收阶段')).length, 0,
      'no host acceptance summary in the group',
    );

    // The boss sends the just-reviewed task back to work 27s in.
    h.state.nowMs += 27_000;
    insertGroupMessage(h.db, {
      pinId: 'rework2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '返工：重启 Builder 的子任务\n[STATUS:EXECUTING]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.ok(h.store.get(`group_task_rework_at:${task.id}`) != null, 'rework hatch stamps the rework instant');

    // 3s later the chair's ALREADY-IN-FLIGHT verification turn lands its
    // verdict — the exact task #24 pattern. It must NOT flip the task back to
    // review nor re-report through any channel.
    h.state.nowMs += 3_000;
    insertGroupMessage(h.db, {
      pinId: 'stale-rv-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'S4 核验通过\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'stale in-flight verdict debounced; task stays executing',
    );
    assert.equal(h.sourceReviewReports.length, 1, 'no re-report for the debounced verdict');
    assert.equal(
      h.sends.filter((s) => s.content.includes('已进入验收阶段')).length, 0,
      'still no acceptance summary for the debounced verdict',
    );
    assert.ok(h.logs.some((line) => line.includes('stale in-flight verdict ignored')));

    // Past the debounce window, the chair's post-rework verdict enters review
    // cleanly and the channels re-report.
    h.state.nowMs += 31_000;
    insertGroupMessage(h.db, {
      pinId: 'rv2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '返工完成，再次验收\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.equal(h.sourceReviewReports.length, 2, 'post-rework review re-reports');
    assert.ok(h.store.get(`group_task_rework_at:${task.id}`) == null, 'stamp cleared on the accepted review entry');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Improvement #5 (task #25): the owner-report directive must not force an AI
// accept/rework verdict from an incomplete ledger. A recommendation is only
// requested when EVERY deliverable is on-chain confirmed; otherwise the
// directive demands facts only + an explicit deferral to the chair's in-group
// first-hand verification and the owner's Tasks-UI decision.
// ---------------------------------------------------------------------------

test('Improvement #5: pending-only deliverables yield a facts-only directive that defers the verdict', async () => {
  const h = await createHarness({
    sendOwnerPrivateReport: async () => ({ pinId: 'owner-report-pin' }),
  });
  try {
    const task = h.createTask([2]);
    // Local-path delivery (task #25 shape): recorded on the ledger, never
    // uploaded as an on-chain metafile — renders "(no uri) (pending, unconfirmed)".
    h.groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'd-local-1', authorGlobalmetaid: 'gmid-w2', kind: 'text', uri: null,
    });
    insertGroupMessage(h.db, {
      pinId: 'i5-rv-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    const directive = h.chatCalls.find((call) => call.userMessage.includes('owner-report directive'))?.userMessage;
    assert.ok(directive, 'owner-report directive captured');
    assert.match(directive, /\(no uri\) \(pending, unconfirmed\)/, 'ledger renders the pending shape');
    assert.match(directive, /Report FACTS ONLY/, 'facts-only mode');
    assert.match(directive, /Explicitly defer the decision/, 'verdict deferred to chair + owner');
    assert.match(directive, /Never treat "pending", "unconfirmed", or "\(no uri\)" as grounds for requesting rework/);
    assert.ok(!directive.includes('Recommend an action'), 'no accept/rework recommendation on an incomplete ledger');
  } finally {
    h.cleanup();
  }
});

test('Improvement #2: a rework landing while the owner report is composed aborts the delivery — no stale [GROUP_TASK_REVIEW]', async () => {
  const ownerReports = [];
  let reworkMidReport = null;
  const h = await createHarness({
    sendOwnerPrivateReport: async (params) => {
      ownerReports.push(params);
      return { pinId: 'owner-report-pin' };
    },
    sendReviewReportToSourceSession: ({ taskId, report }) => {
      h.sourceReviewReports.push({ taskId, report });
    },
    performChat: async (systemPrompt, userMessage) => {
      // The report turn is slow; mid-call the boss's rework hatch fires (the
      // service path: status flip + guard reset + rework stamp, no group msg).
      if (reworkMidReport != null && userMessage.includes('owner-report directive')) {
        reworkMidReport();
        reworkMidReport = null;
      }
      return '验收报告正文';
    },
  });
  try {
    const task = h.createTask([2]);
    reworkMidReport = () => {
      h.groupTaskStore.updateTaskStatus(task.id, 'executing', { actor: { kind: 'chair' } });
      h.store.set(`group_task_rework_at:${task.id}`, h.state.nowMs);
    };
    insertGroupMessage(h.db, {
      pinId: 'rv-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '目标达成\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    // Improvement #1 reorder: the owner report composes BEFORE the group
    // summary would be posted. The rework landed mid-report, so a stale
    // "已进入验收" summary is never posted (and the ceremony itself is gone
    // under single-commander) — the next review entry re-runs the reports
    // cleanly (the rework hatch already cleared the delivery guards).
    assert.equal(
      h.sends.filter((s) => s.content.includes('已进入验收阶段')).length, 0,
      'no review summary posted over the fresh rework',
    );
    assert.equal(h.sourceReviewReports.length, 0, 'no stale [GROUP_TASK_REVIEW] into the source session');
    assert.equal(ownerReports.length, 0, 'no stale A2A owner report');
    assert.ok(h.store.get(`group_task_owner_reported:${task.id}`) == null, 'delivery guard not set — the next review re-reports');
    assert.ok(h.logs.some((line) => line.includes('owner report aborted')));
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
  } finally {
    h.cleanup();
  }
});

test('Improvement #5: all deliverables on-chain confirmed keep the accept/rework recommendation', async () => {
  const h = await createHarness({
    sendOwnerPrivateReport: async () => ({ pinId: 'owner-report-pin' }),
  });
  try {
    const task = h.createTask([2]);
    const delivered = h.groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'd-chain-1', authorGlobalmetaid: 'gmid-w2', kind: 'metafile',
      uri: `metafile://${'f'.repeat(64)}i0`,
    });
    h.groupTaskStore.updateDeliverableConfirmation(delivered.id, 'confirmed');
    // A verified report makes the periodic re-verification pass skip the row,
    // keeping the seeded 'confirmed' state deterministic in this tick.
    h.groupTaskStore.updateDeliverableVerification(
      delivered.id, JSON.stringify({ verified: true, checkedAt: h.state.nowMs, sources: [] }),
    );
    insertGroupMessage(h.db, {
      pinId: 'i5-rv2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '全部上链，请验收\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();
    const directive = h.chatCalls.find((call) => call.userMessage.includes('owner-report directive'))?.userMessage;
    assert.ok(directive, 'owner-report directive captured');
    assert.match(directive, /\(delivered, confirmed\)/, 'ledger renders the confirmed shape');
    assert.match(directive, /Recommend an action/, 'a fully confirmed ledger may carry a recommendation');
    assert.ok(!directive.includes('Report FACTS ONLY'), 'facts-only mode not used for a fully confirmed ledger');
  } finally {
    h.cleanup();
  }
});

test('Improvement #2: clearGroupTaskReviewDeliveryGuards resets every review-delivery guard for the one task', () => {
  const kv = new Map();
  kv.set('group_task_owner_reported:7', '1');
  kv.set('group_task_review_notified:7', '1');
  kv.set('group_task_review_reassert:7', '99');
  kv.set('group_task_owner_reported:8', '1');
  clearGroupTaskReviewDeliveryGuards(kv, 7);
  assert.ok(!kv.has('group_task_owner_reported:7'));
  assert.ok(!kv.has('group_task_review_notified:7'));
  assert.ok(!kv.has('group_task_review_reassert:7'));
  assert.ok(kv.has('group_task_owner_reported:8'), 'other tasks untouched');
});

test('P5 (v1.2): a worker recently active BEFORE the assignment gets a single long-turn fact, not a missed-ACK fact', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // Worker spoke 2 minutes ago (mid long skill turn) — BEFORE the chair's
    // new assignment lands. Task #23: this exact shape produced the false
    // "@chair ⚠ ... has not sent a [WORKING] ACK" warnings.
    const spokeAtSec = Math.floor(h.state.nowMs / 1000) - 120;
    insertGroupMessage(h.db, {
      pinId: 'recent-work-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 长回合中：正在生成配图批次 3/5', chainTimestamp: spokeAtSec,
    });
    await h.loop.runTick(); // consumes the message, records last-speak
    insertGroupMessage(h.db, {
      pinId: 'assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 下一批配图请改用 PNG 基线',
    });
    await h.loop.runTick(); // arms the ACK watch on the fresh assignment
    h.state.nowMs += 4 * 60 * 1000; // past the 3-minute ACK timeout
    await h.loop.runTick();

    // Single-commander: for an ENGAGED worker the watch retires silently —
    // no missed-ACK fact, no long-turn fact, and the host posts nothing.
    const noteCount = (kind) => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = ?",
      [task.id, kind],
    )[0].values[0][0]);
    assert.equal(noteCount('no_ack'), 0, 'no missed-ACK fact for an engaged worker');
    assert.equal(noteCount('long_turn'), 0, 'no long-turn fact either — the watch retires silently');
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK') || s.content.includes('长回合执行中')).length,
      0,
      'the host posts neither the warning nor the long-turn note',
    );

    // Watch consumed: a later tick with no new activity does not start one.
    h.state.nowMs += 60 * 1000;
    await h.loop.runTick();
    assert.equal(noteCount('no_ack'), 0);
    assert.equal(noteCount('long_turn'), 0);
  } finally {
    h.cleanup();
  }
});

test('P5 (v1.2): a worker silent past the engaged window still gets the real missed-ACK fact', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // Last speech 30 minutes ago — outside the 10-minute engaged window.
    const spokeAtSec = Math.floor(h.state.nowMs / 1000) - 1800;
    insertGroupMessage(h.db, {
      pinId: 'stale-work-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 早期进度', chainTimestamp: spokeAtSec,
    });
    await h.loop.runTick();
    insertGroupMessage(h.db, {
      pinId: 'assign2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请接手 S5 组装',
    });
    await h.loop.runTick();
    h.state.nowMs += 4 * 60 * 1000;
    await h.loop.runTick();
    // Single-commander: the missed-ACK fact is an environment note the chair
    // reads on the next delivery tick — never a host ⚠ post.
    const noAckNotes = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'no_ack'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(noAckNotes, 1, 'genuinely missed assignment still recorded for the chair');
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK')).length,
      0,
      'the host itself posts nothing',
    );
  } finally {
    h.cleanup();
  }
});

test('P5: a standby (observer) member mentioned by the chair arms no ACK watch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.setMemberStatus(task.id, 2, 'standby', 'gmid-w2');
    insertGroupMessage(h.db, {
      pinId: 'standby-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请旁观本次验收整理',
    });
    await h.loop.runTick();
    assert.ok(h.logs.some((line) => line.includes('standing by') && line.includes('no ACK watch')));
    h.state.nowMs += 10 * 60 * 1000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => s.content.includes('has not sent a [WORKING] ACK')).length,
      0,
      'no false no-ACK reminder for an observer',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-1: review-phase silence hint
// ---------------------------------------------------------------------------

test('review-phase dispatch to workers logs the silence hint and never replies', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.updateTaskStatus(task.id, 'review', { actor: { kind: 'chair' } });
    insertGroupMessage(h.db, {
      pinId: 'review-dispatch-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please do the extra task',
    });
    await h.loop.runTick();

    // Single-commander: workers stay silent, and the swallowed dispatch
    // reaches the chair as a dispatch_held environment note — never as a
    // host post under the chair's name.
    assert.equal(h.sends.filter((send) => send.metabotId === 2).length, 0, 'review phase: no worker reply');
    assert.equal(h.sends.length, 0, 'the host itself posts nothing');
    const heldNotes = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'dispatch_held'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(heldNotes, 1, 'dispatch-held fact recorded as a host note');
    assert.ok(
      h.logs.some((line) => line.includes('review-phase silence') && line.includes('Coder Bot')),
      'daemon logs the silenced dispatch so the chair knows why',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-6: [DEPENDS_ON] gate
// ---------------------------------------------------------------------------

test('[DEPENDS_ON] is declarative under single-commander — dispatch is never gated', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'dep-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot 写文案 [DEPENDS_ON: ${UPSTREAM_PINID}] 等上游交付后再动笔`,
    });
    await h.loop.runTick();

    // Single-commander: the [DEPENDS_ON] dispatch gate is gone — sequencing
    // is solely the chair's judgment. The worker turn dispatches immediately
    // and no dispatch-held fact is recorded.
    const workerSends = h.sends.filter((s) => s.metabotId === 2);
    assert.equal(workerSends.length, 1, 'dispatch proceeds immediately');
    assert.match(workerSends[0].content, /^reply-for-/);
    const heldNotes = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'dispatch_held'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(heldNotes, 0, 'no dispatch-held fact for a declarative DEPENDS_ON');
  } finally {
    h.cleanup();
  }
});

test('[DEPENDS_ON] bounded wait override no longer holds anything either', async () => {
  const h = await createHarness({ dependencyWaitMaxMs: 1_000 });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'dep-timeout-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot step B [DEPENDS_ON: ${UPSTREAM_PINID}]`,
    });
    await h.loop.runTick();

    assert.equal(h.sends.filter((s) => s.metabotId === 2).length, 1, 'dispatch proceeds immediately — no wait bound applies');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P2-8: multi-driver mutex
// ---------------------------------------------------------------------------

test('driver mutex: only the claiming instance drives a task; stale claims are taken over', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'mutex-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });

    const loopA = h.loop;
    const loopB = h.makeSecondLoop();

    // Tick A: claims the driver and replies; tick B (same instant): yields.
    await loopA.runTick();
    await loopB.runTick();
    assert.equal(h.sends.length, 1, 'exactly ONE reply — the second instance yielded');
    assert.ok(
      h.logs.some((line) => line.includes('yields this tick')),
      'yielding instance logs the mutex wait',
    );

    // Stale claim takeover: advance past the grace window, tick B drives.
    h.state.nowMs += 25_000;
    await loopB.runTick();
    assert.equal(h.sends.length, 1, 'no new messages -> no new replies');

    // Fresh dispatch while B holds a fresh claim: A yields, B replies.
    insertGroupMessage(h.db, {
      pinId: 'mutex2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot follow-up question',
    });
    await loopA.runTick(); // A yields (B's claim is fresh)
    await loopB.runTick(); // B drives
    assert.equal(h.sends.length, 2, 'only the current driver replied to the follow-up');
  } finally {
    h.cleanup();
  }
});

test('driver mutex: same instance refreshes its own lease instead of yielding', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'lease-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot one more task',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    h.state.nowMs += 10_000; // still inside the grace window
    await h.loop.runTick(); // same instance: refreshes lease, drives normally
    assert.equal(h.sends.length, 1, 'no duplicate reply on the same message');
    assert.ok(
      !h.logs.some((line) => line.includes('yields this tick')),
      'own lease never logs a yield',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2 (GT#11): manual chair sends participate in the driver claim
// ---------------------------------------------------------------------------

test('F2: manual chair driving send is rejected while the daemon claim is fresh, then takes the floor', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'f2-drive-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });
    await h.loop.runTick(); // daemon drives -> its claim is fresh
    assert.equal(h.sends.length, 1);
    const rawClaim = h.store.get(`group_task_driver:${task.id}`);
    assert.ok(rawClaim, 'daemon holds a driver claim after driving');
    const [daemonDriverId] = rawClaim.split('|');

    // A manual chair session attempts a driving send while the claim is fresh.
    const rejected = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 1, chairMetabotId: 1,
      driverId: 'manual-session-1', graceMs: 20_000, nowMs: h.state.nowMs + 5_000,
    });
    assert.equal(rejected.ok, false, 'manual driving send rejected while the daemon drives');
    assert.match(rejected.error, /being driven by another session/);
    assert.match(rejected.error, /retry in \d+s/);
    assert.equal(rejected.driverId, daemonDriverId);
    assert.ok(rejected.retryAfterMs > 0);

    // Grace expired -> the manual session takes the floor.
    const acquired = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 1, chairMetabotId: 1,
      driverId: 'manual-session-1', graceMs: 20_000, nowMs: h.state.nowMs + 25_000,
    });
    assert.equal(acquired.ok, true, 'stale daemon claim -> manual session takes over');
    assert.equal(
      h.store.get(`group_task_driver:${task.id}`),
      `manual-session-1|${h.state.nowMs + 25_000}`,
    );

    // The daemon yields its tick while the manual claim stays fresh.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'f2-yield-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot follow-up research',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'daemon does not double-drive while the manual session drives');
    assert.ok(h.logs.some((line) => line.includes('yields this tick')), 'daemon logs the mutex yield');

    // Manual claim stale -> the daemon resumes driving.
    h.state.nowMs += 40_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'daemon resumes driving after the manual claim expires');
  } finally {
    h.cleanup();
  }
});

test('F2: worker sends always pass the driving gate (no mutex for non-chair)', async () => {
  const h = await createHarness({ driverGraceMs: 20_000, disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'f2-worker-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'daemon drives');

    // A worker ACK must never be blocked by the driver claim.
    const workerGate = gateChairDrivingSend({
      kv: h.store, taskId: task.id, senderMetabotId: 2, chairMetabotId: 1,
      driverId: 'worker-session', graceMs: 20_000, nowMs: h.state.nowMs + 3_000,
    });
    assert.deepEqual(workerGate, { ok: true }, 'worker send passes the gate');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Issue #8: deliverable ledger on-chain confirmation, driven by multi-source
// verification — the record-time path and the monitor re-verification path.
// ---------------------------------------------------------------------------

test('Issue #8: [DELIVERABLE] with an on-chain-found pin records confirmation=confirmed (pending acceptance)', async () => {
  const foundPin = 'b'.repeat(64) + 'i0';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? 'found' : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'deli-confirmed-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${foundPin}`,
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'one deliverable row recorded');
    // The pin is verifiably on-chain, so the ledger says confirmed — and P3
    // (v1.1): a verified deliverable leaves 'pending' (status 'delivered'),
    // while the owner's acceptance verdict is still unwritten.
    assert.equal(deliverables[0].confirmation, 'confirmed');
    assert.equal(deliverables[0].status, 'delivered');
  } finally {
    h.cleanup();
  }
});

test('Issue #8: monitor re-verification drives unconfirmed -> confirmed once the pin lands on-chain', async () => {
  const foundPin = 'c'.repeat(64) + 'i0';
  let outcome = 'not_found';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? outcome : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'deli-lagging-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${foundPin}`,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id)[0].confirmation, 'unconfirmed',
      'pin not found on-chain yet => unconfirmed');

    // The pin lands on-chain; the next monitor pass (retry window elapsed)
    // re-verifies and drives the ledger to confirmed.
    outcome = 'found';
    h.state.nowMs += 11 * 60 * 1000; // past the 10-minute verification retry window
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(deliverable.confirmation, 'confirmed', 'monitor pass flips the ledger');
    assert.equal(deliverable.status, 'delivered', 'P3: verified via monitor leaves pending too');
  } finally {
    h.cleanup();
  }
});

test('P3: verified-but-pending legacy rows are backfilled to delivered by the monitor', async () => {
  const foundPin = 'd'.repeat(64) + 'i0';
  const h = await createHarness({
    readPinForVerification: async (pinId) => (pinId === foundPin ? 'found' : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    // Task #22 shape: a row recorded before the 'delivered' status existed —
    // verification report says verified, confirmation confirmed, but the enum
    // is stuck at 'pending'. Insert directly to simulate the legacy ledger.
    h.db.run(
      `INSERT INTO group_task_deliverables
         (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, verification)
       VALUES (?, 'legacy-i0', 'gmid-w2', 'metaapp', ?, 'pending', 'confirmed', ?)`,
      [task.id, `metaapp://${foundPin}`, JSON.stringify({ verified: true, checkedAt: Date.now() })],
    );
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.equal(deliverable.status, 'delivered', 'backfill flips the legacy verified row');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Ledger fix (#14→#16): local-file deliverables are uploaded on-chain as
// metafiles; reject/rework backfills deliverable status; transcript reads
// stay id-ordered (show/dump consistency).
// ---------------------------------------------------------------------------

test('ledger fix: [DELIVERABLE] naming a LOCAL file is uploaded as metafile (uri + confirmed)', async () => {
  const tempDir = makeTempDir();
  const localFile = path.join(tempDir, 'visual-spec.md');
  fs.writeFileSync(localFile, '# Visual spec\n');
  const uploadedPin = 'd'.repeat(64) + 'i0';
  const uploads = [];
  const h = await createHarness({
    uploadDeliverableFile: async (input) => {
      uploads.push(input);
      return { pinId: uploadedPin };
    },
    readPinForVerification: async (pinId) => (pinId === uploadedPin ? 'found' : 'not_found'),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'local-file-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 视觉规范文档：\`${localFile}\`（含参数速查表）`,
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'one deliverable row recorded');
    assert.equal(deliverables[0].kind, 'metafile', 'text row upgraded to metafile');
    assert.equal(deliverables[0].uri, `metafile://${uploadedPin}.md`, 'uri carries the uploaded pinid + extension');
    assert.equal(deliverables[0].confirmation, 'confirmed', 'on-chain confirmation follows the uploaded pin');
    assert.equal(uploads.length, 1, 'exactly one upload');
    assert.equal(uploads[0].filePath, localFile);
    assert.equal(uploads[0].metabotId, 2, 'upload paid by the author bot wallet');
    const parsed = JSON.parse(deliverables[0].verification ?? '{}');
    assert.equal(parsed.verified, true, 'on-chain verification report persisted');
  } finally {
    h.cleanup();
  }
});

test('ledger fix: upload failure degrades to the plain text record (row kept, no fake uri)', async () => {
  const tempDir = makeTempDir();
  const localFile = path.join(tempDir, 'report.md');
  fs.writeFileSync(localFile, 'x');
  const h = await createHarness({
    uploadDeliverableFile: async () => { throw new Error('wallet insufficient'); },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'upload-fail-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 报告：\`${localFile}\``,
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'row still recorded');
    assert.equal(deliverables[0].kind, 'text', 'no fake metafile kind');
    assert.equal(deliverables[0].uri, null, 'no fake uri');
    assert.equal(deliverables[0].confirmation, 'unconfirmed');
    assert.ok(
      h.logs.some((line) => line.includes('local deliverable upload failed')),
      'failure is logged',
    );
  } finally {
    h.cleanup();
  }
});

test('ledger fix: missing/non-file paths never trigger an upload', async () => {
  const h = await createHarness({
    uploadDeliverableFile: async () => {
      throw new Error('upload must not be called for a missing file');
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'no-file-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] 结论：路径 `/tmp/idbots-no-such-dir-xyz/ghost.md` 不存在，仅作引用',
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'row recorded as plain text');
    assert.equal(deliverables[0].kind, 'text');
    assert.equal(deliverables[0].uri, null);
  } finally {
    h.cleanup();
  }
});

test('ledger fix: a correction to a REJECTED deliverable re-opens it to pending (new version, same row)', async () => {
  const pinA = 'e'.repeat(64) + 'i0';
  const h = await createHarness({
    readPinForVerification: async () => 'found',
  });
  try {
    const task = h.createTask([2]);
    // A deliverable row that was REJECTED by the chair's rework.
    const row = h.groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: 'rejected-msg-i0',
      authorGlobalmetaid: 'gmid-w2',
      kind: 'metaapp',
      uri: `metaapp://${pinA}`,
    });
    h.groupTaskStore.updateDeliverableStatus(row.id, 'rejected');
    assert.equal(h.groupTaskStore.listDeliverables(task.id)[0].status, 'rejected');

    // The worker re-delivers the SAME object with a correction tag.
    insertGroupMessage(h.db, {
      pinId: 'correction-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 更正：修正版已重新发布，以 metaapp://${pinA} 为准`,
    });
    await h.loop.runTick();

    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'corrected in place, no duplicate row');
    assert.equal(deliverables[0].status, 'pending', 'rejected verdict re-opened to pending');
    assert.equal(deliverables[0].uri, `metaapp://${pinA}`);
  } finally {
    h.cleanup();
  }
});

test('ledger fix: reject backfill marks pending deliverables rejected (store-level)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'm1-i0', authorGlobalmetaid: 'gmid-w2', kind: 'text' });
    const pin = 'f'.repeat(64) + 'i0';
    h.groupTaskStore.addDeliverable({ taskId: task.id, msgPinId: 'm2-i0', authorGlobalmetaid: 'gmid-w3', kind: 'metaapp', uri: `metaapp://${pin}` });
    const changed = h.groupTaskStore.updateDeliverablesStatusByTask(task.id, 'pending', 'rejected');
    assert.equal(changed, 2, 'both pending rows rejected');
    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.ok(rows.every((row) => row.status === 'rejected'), 'all pending rows rejected');
    assert.equal(h.groupTaskStore.updateDeliverablesStatusByTask(task.id, 'pending', 'rejected'), 0, 'idempotent');
  } finally {
    h.cleanup();
  }
});

test('show/dump consistency: transcript reads stay id-ordered even when chain timestamps are out of order', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // Deliberately insert with chain timestamps OUT of id order (backfill lag
    // scenario): id order must still drive the transcript, never timestamps.
    insertGroupMessage(h.db, {
      pinId: 'm-a-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'first message', chainTimestamp: 300,
    });
    insertGroupMessage(h.db, {
      pinId: 'm-b-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'second message', chainTimestamp: 100,
    });
    insertGroupMessage(h.db, {
      pinId: 'm-c-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'third message', chainTimestamp: 200,
    });
    const transcript = h.groupTaskStore.listGroupChatMessages(GROUP_ID, { limit: 50 });
    assert.deepEqual(transcript.map((m) => m.id), [1, 2, 3], 'UI/show transcript is id-ordered');
    assert.deepEqual(transcript.map((m) => m.content), ['first message', 'second message', 'third message']);

    // The daemon's worker-context dump rides the SAME id-ordered query path
    // (queryRecentMessages: ORDER BY id DESC LIMIT then reverse), so a reply
    // turn produces a dump whose message order matches the UI transcript.
    insertGroupMessage(h.db, {
      pinId: 'm-d-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请按上述顺序复核', chainTimestamp: 400,
    });
    await h.loop.runTick();
    assert.ok(h.chatCalls.length > 0, 'a reply turn ran for the trigger');
    const dumpUser = h.chatCalls[0].userMessage;
    const firstPos = dumpUser.indexOf('first message');
    const secondPos = dumpUser.indexOf('second message');
    const thirdPos = dumpUser.indexOf('third message');
    const triggerPos = dumpUser.indexOf('请按上述顺序复核');
    assert.ok(firstPos !== -1 && secondPos !== -1 && thirdPos !== -1 && triggerPos !== -1,
      'dump carries every message');
    assert.ok(firstPos < secondPos && secondPos < thirdPos && thirdPos < triggerPos,
      'dump order equals the id-ordered UI transcript');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// group-task speedup REQ v1.1, R-03: cross-message deliverable idempotency.
// The same author re-delivering the same uri under a NEW message pin folds
// into the earliest ledger row (append-only duplicates[] annotation, no new
// row, no chair wake); different uri / different author stay distinct; a
// fenced [DELIVERABLE] citation records nothing.
// ---------------------------------------------------------------------------

test('speedup R-03: same author + same uri re-delivery folds into the first ledger row and skips the chair wake', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const pinid = 'c'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'dup-deliver-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] S2 视频：\`metafile://${pinid}.mp4\``,
    });
    await h.loop.runTick();
    let deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'first delivery recorded');
    const chairCallsAfterFirst = h.chatCalls.length;
    assert.ok(chairCallsAfterFirst > 0, 'the first delivery woke the chair');

    // Same author, same uri, NEW message pin 3 minutes later.
    insertGroupMessage(h.db, {
      pinId: 'dup-deliver-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] S2 视频（重发）：\`metafile://${pinid}.mp4\``,
    });
    await h.loop.runTick();
    deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 1, 'duplicate folded — still one ledger row');
    const report = JSON.parse(deliverables[0].verification ?? '{}');
    assert.ok(Array.isArray(report.duplicates), 'fold mark recorded on the survivor');
    assert.equal(report.duplicates.length, 1);
    assert.equal(report.duplicates[0].msgPinId, 'dup-deliver-2-i0');
    assert.equal(h.chatCalls.length, chairCallsAfterFirst, 'folded duplicate does not wake the chair');
  } finally {
    h.cleanup();
  }
});

test('speedup R-03 (task #63 revision): distinct artifacts keep their rows; the SAME artifact never gets two authors', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    const pinA = 'd'.repeat(64) + 'i0';
    const pinB = 'e'.repeat(64) + 'i0';
    insertGroupMessage(h.db, {
      pinId: 'distinct-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] A：\`metafile://${pinA}\``,
    });
    await h.loop.runTick();
    // Same author, different pinid → a distinct deliverable.
    insertGroupMessage(h.db, {
      pinId: 'distinct-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] B：\`metafile://${pinB}\``,
    });
    // Same pinid, DIFFERENT author → task #63: a deliverable URI names ONE
    // on-chain artifact with ONE author (the publisher); the second member's
    // tag is a citation and folds — the old R-03 "shared assets keep credit"
    // behavior is exactly what minted task #63's duplicate rows.
    insertGroupMessage(h.db, {
      pinId: 'distinct-3-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: `[DELIVERABLE] A-reuse：\`metafile://${pinA}\``,
    });
    await h.loop.runTick();
    const deliverables = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(deliverables.length, 2, 'distinct pinids keep their rows; the same pinid folds');
    const rowA = deliverables.find((deliverable) => (deliverable.uri ?? '').includes(pinA));
    assert.equal(
      (rowA?.authorGlobalmetaid ?? '').toLowerCase(),
      'gmid-w2',
      'the surviving row keeps the original publisher as its author',
    );
  } finally {
    h.cleanup();
  }
});

test('speedup R-03: a fenced [DELIVERABLE] citation records nothing', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'fenced-deliverable-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `交付格式示例：\n\`\`\`\n[DELIVERABLE] metaapp: metaapp://${'ab'.repeat(32)}i0\n\`\`\`\n按上面格式发即可。`,
    });
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.listDeliverables(task.id).length,
      0,
      'a [DELIVERABLE] inside a fenced code block is a citation, not a delivery',
    );
    // Inline-backtick URIs still parse (real deliveries wrap uris in backticks).
    insertGroupMessage(h.db, {
      pinId: 'inline-deliverable-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 真交付：\`metafile://${'f'.repeat(64)}i0.mp4\``,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'inline-backtick uri still records');
  } finally {
    h.cleanup();
  }
});
