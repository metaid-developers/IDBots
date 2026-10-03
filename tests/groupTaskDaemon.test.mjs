import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// groupTaskDaemon -> coworkStore imports electron; mock it.
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
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const { GroupTaskOrchestrationBridge } = require('../dist-electron/main/services/groupTaskOrchestrationBridge.js');
const {
  decideGroupTaskResponders,
  createGroupTaskDaemonLoop,
  resolveDerivedAssignmentUpstream,
  buildOpenTeamPlanningStatusBlock,
  buildMemberJoinWelcomeText,
  parseGroupTaskStuckReclaimMode,
  hasProseDependencyDeclaration,
  hasWorkerUpstreamWait,
  adjudicateStatusDirectives,
  buildGroupTaskExperienceBlock,
  buildGroupTaskConstraintsBlock,
  PROSE_DEPENDENCY_EXEMPTION_MAX_MS,
} = require('../dist-electron/main/services/groupTaskDaemon.js');
const { buildGroupTaskSystemPrompt } = require('../dist-electron/main/services/groupTaskPrompts.js');
const { SkillTurnTimeoutError } = require('../dist-electron/main/services/orchestratorCoworkBridge.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const BOSS_GMID = 'gmid-boss';

// Round-4: deliverable URIs must carry a full 64-hex + i0 pinid token.
const REAL_PINID_1 = `${'ab'.repeat(32)}i0`;
const REAL_PINID_2 = `${'cd'.repeat(32)}i0`;

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-daemon-'));

// ---------------------------------------------------------------------------
// Pure gating fixtures
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
  // Round-4: gating tests exercise decision logic, not attribution — the
  // speaker is a non-member non-owner human, so attribution would flag it
  // SUSPECT; these fixtures pin senderSuspect=false explicitly.
  senderSuspect: false,
  ...overrides,
});

const gateTask = (status = 'executing') => ({ id: 1, status });

// ---------------------------------------------------------------------------
// Daemon loop harness
// ---------------------------------------------------------------------------

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, type = 'worker', globalmetaid = null, bossGmid = null, llmId = null, allowChatSkills = [], bio = null, goal = null }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, type, '0000', `${name} role`, `${name} soul`,
      bossGmid, llmId, JSON.stringify(allowChatSkills), bio, goal, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, mention = null, replyPin = '', chainTimestamp = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, ?, ?, ?, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/-i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content,
      replyPin, mention ? JSON.stringify(mention) : '[]', chainTimestamp],
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
  insertMetabot(db, { id: 1, walletId: 1, name: 'Twin Bot', type: 'twin', globalmetaid: 'gmid-twin', bossGmid: BOSS_GMID, llmId: 'llm-1', bio: 'Coordinates the team', goal: 'Ship group tasks' });
  insertMetabot(db, { id: 2, walletId: 1, name: 'Coder Bot', globalmetaid: 'gmid-w2', llmId: 'llm-2', allowChatSkills: overrides.coderChatSkills ?? [], bio: 'Search and code specialist' });
  insertMetabot(db, { id: 3, walletId: 1, name: 'Designer Bot', globalmetaid: 'gmid-w3', llmId: 'llm-3', bio: 'Visual design' });
  insertMetabot(db, { id: 4, walletId: 1, name: 'Reviewer Bot', globalmetaid: 'gmid-w4', llmId: 'llm-4' });

  const chatCalls = [];
  const sends = [];
  const routingCalls = [];
  const skillTurnCalls = [];
  const events = [];
  const ownerReportCalls = [];
  const state = {
    nowMs: 1_000_000_000_000,
    chatError: overrides.chatError ?? null,
    chatErrorAlways: overrides.chatErrorAlways ?? null,
    routing: overrides.routing ?? null,
    chatReply: overrides.chatReply ?? null,
    skillReply: overrides.skillReply ?? null,
    ownerReportFails: overrides.ownerReportFails ?? false,
    ownerReportResult: overrides.ownerReportResult ?? null,
    pinOutcomes: overrides.pinOutcomes ?? {},
    sendFailures: overrides.sendFailures ?? null,
  };
  const seenChatErrors = new Set();
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
    buildTeamCultureBlock: overrides.buildTeamCultureBlock ?? null,
    orchestrationBridge,
    performChat: async (systemPrompt, userMessage, llmId) => {
      chatCalls.push({ systemPrompt, userMessage, llmId });
      if (state.chatErrorAlways) {
        throw new Error(state.chatErrorAlways);
      }
      if (state.chatError && !seenChatErrors.has(state.chatError)) {
        seenChatErrors.add(state.chatError);
        throw new Error(state.chatError);
      }
      return state.chatReply ?? `reply-for-${llmId}`;
    },
    postGroupTaskMessage: async (taskId, metabotId, content, opts) => {
      sends.push({ taskId, metabotId, content, replyPin: opts?.replyPin, mention: opts?.mention });
      if (state.sendFailures?.has(metabotId)) {
        throw new Error(`on-chain send failed for bot ${metabotId}`);
      }
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
    emitTaskEvent: (payload) => {
      events.push(payload);
    },
    sendOwnerPrivateReport: async (params) => {
      ownerReportCalls.push(params);
      if (state.ownerReportFails) {
        throw new Error('owner chat public key unavailable');
      }
      return state.ownerReportResult ?? {
        pinId: `owner-report-pin-${ownerReportCalls.length}`,
        sessionId: `owner-report-session-${ownerReportCalls.length}`,
      };
    },
    readPinForVerification: async (pinId) => state.pinOutcomes[pinId] ?? 'unavailable',
    ...(overrides.listUserMemories ? { listUserMemories: overrides.listUserMemories } : {}),
    ...(overrides.listDailySummaries ? { listDailySummaries: overrides.listDailySummaries } : {}),
    ...(overrides.getMetaIDGroupCognitionPromptBlock
      ? { getMetaIDGroupCognitionPromptBlock: overrides.getMetaIDGroupCognitionPromptBlock }
      : {}),
    ...(overrides.resolveGlobalMetaId
      ? { resolveGlobalMetaId: overrides.resolveGlobalMetaId }
      : {}),
    ...(overrides.probeUrl ? { probeUrl: overrides.probeUrl } : { probeUrl: async () => null }),
    ...(overrides.readPinSecondaryForVerification
      ? { readPinSecondaryForVerification: overrides.readPinSecondaryForVerification }
      : {}),
    ...(overrides.verificationRetryMs != null
      ? { verificationRetryMs: overrides.verificationRetryMs }
      : {}),
    emitLog: overrides.emitLog ?? (() => {}),
    now: () => state.nowMs,
    workerCooldownMs: overrides.workerCooldownMs ?? 20_000,
    chairCooldownMs: overrides.chairCooldownMs ?? 10_000,
    replyBudget: overrides.replyBudget ?? 40,
    maxRepliesPerTaskPerTick: overrides.maxRepliesPerTaskPerTick ?? 3,
    ...(overrides.chairTwinSuppressWindowMs != null
      ? { chairTwinSuppressWindowMs: overrides.chairTwinSuppressWindowMs }
      : {}),
    ...(overrides.disableChairPlanningTurn != null
      ? { disableChairPlanningTurn: overrides.disableChairPlanningTurn }
      : {}),
    // F1 (GT#11): legacy tests add all members before the first tick, so the
    // roster-settle gate is off by default here; dedicated F1 tests override
    // settle/cap explicitly to exercise the mid-create race protection.
    ...(overrides.chairPlanRosterSettleMs != null
      ? { chairPlanRosterSettleMs: overrides.chairPlanRosterSettleMs }
      : { chairPlanRosterSettleMs: 0 }),
    ...(overrides.chairPlanRosterCapMs != null
      ? { chairPlanRosterCapMs: overrides.chairPlanRosterCapMs }
      : { chairPlanRosterCapMs: 0 }),
    ...(overrides.memberUnreachableAfterMinutes != null
      ? { memberUnreachableAfterMinutes: overrides.memberUnreachableAfterMinutes }
      : {}),
    ...(overrides.ackTimeoutMs != null
      ? { ackTimeoutMs: overrides.ackTimeoutMs }
      : {}),
    // Generic dep override seam (e.g. getOpenTeamMembershipStore for the #13
    // join-welcome tests); spreads last so tests can override anything above.
    ...(overrides.deps ? overrides.deps : {}),
  };
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
  const loop = drainLoop(createGroupTaskDaemonLoop(deps));

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
      groupTaskStore.updateTaskStatus(task.id, 'executing');
    }
    return groupTaskStore.getTaskById(task.id);
  };

  return {
    store, db, metabotStore, groupTaskStore, orchestrationStore, coworkStore, loop, deps,
    chatCalls, sends, routingCalls, skillTurnCalls, events, ownerReportCalls, state, createTask,
    /** Rebuild a loop over the same stores with extra deps — drained like the harness loop. */
    makeLoop: (extraDeps = {}) => drainLoop(createGroupTaskDaemonLoop({ ...deps, ...extraDeps })),
    cleanup: () => store.close(),
  };
};

// ---------------------------------------------------------------------------
// Gating matrix (pure)
// ---------------------------------------------------------------------------

test('gating: worker responds only when mentioned (by name or mention array)', () => {
  const byName = decideGroupTaskResponders(
    gateMessage({ content: '@Coder Bot please handle this' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byName, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  const byMentionArray = decideGroupTaskResponders(
    gateMessage({ content: 'please handle this', mention: JSON.stringify(['gmid-w2']) }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byMentionArray, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  const byMetaIdInArray = decideGroupTaskResponders(
    gateMessage({ content: 'go', mention: JSON.stringify(['metaid-3']) }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byMetaIdInArray, [{ metabotId: 3, reason: 'worker_mentioned' }]);

  // name match is case-insensitive (word-boundary @ required)
  const byNameCase = decideGroupTaskResponders(
    gateMessage({ content: '@coder bot, take it' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(byNameCase, [{ metabotId: 2, reason: 'worker_mentioned' }]);

  // P0-3: a bare name WITHOUT the @ prefix is NOT a mention (kickoff roster
  // lines and recaps must not trigger replies). With nobody addressed it falls
  // to the chair's floor-control duty instead.
  const bareName = decideGroupTaskResponders(
    gateMessage({ content: 'coder bot, take it' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(bareName, [{ metabotId: 1, reason: 'chair_floor_control' }], 'bare name without @ must not trigger a worker');
});

test('gating: chair rules (a) mentioned, (b) owner message, (c) deliverable, (d) floor control', () => {
  // (a) chair mentioned (word-boundary @)
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Twin Bot, your call?' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_mentioned' }],
  );
  // bare chair name without @ is not a mention (still may be floor control)
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: 'Twin Bot, your call?' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );

  // (b) owner message: no mention needed for the chair; workers get NO privilege
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: BOSS_GMID, content: 'status update please' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_owner_message' }],
  );

  // (c) deliverable tag
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] metaapp: metaapp://pin1' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_deliverable' }],
  );

  // (d) not addressed to any specific member -> chair floor control
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: 'I have a general question about the goal' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );
});

test('gating: message addressed only to one worker keeps the chair silent', () => {
  const decisions = decideGroupTaskResponders(
    gateMessage({ content: '@Designer Bot draft the layout' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(decisions, [{ metabotId: 3, reason: 'worker_mentioned' }]);

  // two workers addressed: both reply, chair still silent
  const twoWorkers = decideGroupTaskResponders(
    gateMessage({ content: '@Coder Bot @Designer Bot sync up' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.deepEqual(twoWorkers, [
    { metabotId: 2, reason: 'worker_mentioned' },
    { metabotId: 3, reason: 'worker_mentioned' },
  ]);
});

test('gating: self-skip, unmentioned local author, empty content, terminal task', () => {
  // chair's own message never triggers the chair (even with a deliverable tag)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-twin', content: '[DELIVERABLE] my own note' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );

  // local worker authored, mentions nobody: self-skip for that worker, others silent,
  // chair takes floor control (message not addressed to a specific member)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: 'I finished my part' }),
      gateTask(), GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_floor_control' }],
  );

  // empty content -> nobody
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '   ' }), gateTask(), GATE_MEMBERS, GATE_BOTS),
    [],
  );

  // terminal task -> nobody
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Coder Bot go' }), gateTask('done'), GATE_MEMBERS, GATE_BOTS),
    [],
  );
  assert.deepEqual(
    decideGroupTaskResponders(gateMessage({ content: '@Coder Bot go' }), gateTask('cancelled'), GATE_MEMBERS, GATE_BOTS),
    [],
  );
});

// ---------------------------------------------------------------------------
// Daemon loop
// ---------------------------------------------------------------------------

test('happy path: kickoff mentioning two workers triggers both, chair stays silent, sessions recorded', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    insertGroupMessage(h.db, {
      pinId: 'kickoff-i0',
      senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin', senderName: 'Twin Bot',
      content: 'Team kickoff. @Coder Bot research options. @Designer Bot draft the layout.',
    });

    await h.loop.runTick();

    // both workers replied; chair (author) did not
    assert.deepEqual(h.sends.map((s) => s.metabotId).sort(), [2, 3]);
    assert.equal(h.chatCalls.length, 2);

    // prompts carry the task facts and the triggering-message marker
    const coderCall = h.chatCalls.find((c) => c.llmId === 'llm-2');
    assert.match(coderCall.systemPrompt, /Build MetaApp/);
    assert.match(coderCall.systemPrompt, /Preview URL works/);
    assert.match(coderCall.systemPrompt, /the worker of this task group/);
    assert.match(coderCall.userMessage, />>> Twin Bot: Team kickoff\..*<<< \(the message you are responding to\)/);
    assert.match(h.sends.find((s) => s.metabotId === 2).content, /reply-for-llm-2/);

    // R5: worker replies are threaded under the chair message that dispatched
    // them (replyPin injected by the host from the gating context).
    for (const workerId of [2, 3]) {
      assert.equal(
        h.sends.find((s) => s.metabotId === workerId).replyPin,
        'kickoff-i0',
        `worker ${workerId} reply carries the kickoff replyPin`,
      );
    }

    // sessions: one per (task, worker) on the metaweb_group_task channel
    for (const workerId of [2, 3]) {
      const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, workerId);
      assert.ok(mapping, `mapping for worker ${workerId}`);
      const session = h.coworkStore.getSession(mapping.coworkSessionId);
      assert.equal(session.sessionType, 'group_task');
      assert.equal(session.metabotId, workerId);
      const messages = h.coworkStore.getSessionMessages(session.id);
      // fix-v2 (B6): a daemon-created session gets the context snapshot
      // (with the task ledger) injected before the first turn's user message.
      assert.deepEqual(messages.map((m) => m.type), ['user', 'user', 'assistant']);
      assert.match(messages[0].content, /group context snapshot/);
      assert.match(messages[0].content, /Task ledger/);
      assert.match(messages[1].content, /recent group log/);
      assert.equal(messages[2].content, `reply-for-llm-${workerId}`);
    }

    // cursor advanced past the kickoff message
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['kickoff-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId);

    // The observable group execution is projected into canonical Worker steps.
    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    const canonical = h.orchestrationStore.getTask(canonicalId);
    assert.equal(canonical.status, 'running');
    const steps = h.orchestrationStore.listSteps(canonical.id);
    assert.deepEqual(steps.map((step) => step.assigneeMetabotId).sort(), [2, 3]);
    assert.ok(steps.every((step) => step.status === 'waiting_input'));
    assert.ok(steps.every((step) => h.orchestrationStore.listAttempts(step.id)[0].status === 'completed'));
  } finally {
    h.cleanup();
  }
});

test('R7: a failed on-chain send injects a delivery-failure notice into the sender bot session', async () => {
  // Coder Bot's sends fail; its reply was already added to its session before
  // the send, so without R7 it would wrongly think it had spoken.
  const h = await createHarness({ sendFailures: new Set([2]) });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'kickoff-i0',
      senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin', senderName: 'Twin Bot',
      content: 'Team kickoff. @Coder Bot research options.',
    });
    await h.loop.runTick();

    // The send was attempted (and threw).
    assert.ok(h.sends.some((s) => s.metabotId === 2), 'coder reply send attempted');

    // R7: the failure notice is in Coder Bot's task session as a user turn.
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping, 'coder session mapping exists');
    const session = h.coworkStore.getSession(mapping.coworkSessionId);
    const messages = h.coworkStore.getSessionMessages(session.id);
    const notice = messages.find((m) => /delivery-failure/i.test(m.content));
    assert.ok(notice, 'delivery-failure notice injected');
    assert.equal(notice.type, 'user');
    assert.match(notice.content, /NOT delivered to the group/);
    assert.match(notice.content, /on-chain send failed for bot 2/);
  } finally {
    h.cleanup();
  }
});

test('R6: stale [WORKING] local worker → timeout status + L3 owner brief (idempotent per streak)', async () => {
  const h = await createHarness({
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    // Fast windows so the test doesn't wait real minutes.
    deps: { memberTimeoutAfterMinutes: 1, memberEscalateAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    // Worker 2 self-reports [WORKING] with a chain timestamp 35 min in the past
    // (seconds), so the L2 timeout window, the L3 escalation window AND the
    // default 30-min unreachable window have all elapsed at the default nowMs
    // (1_000_000_000_000). The stamp must out-age the unreachable window: the
    // anti-flap gate double-checks the member's liveness against the recovery
    // predicate before writing, and a [WORKING] message also counts as the
    // member's last group speech (review follow-up, fix/group-member-status).
    insertGroupMessage(h.db, {
      pinId: 'working-stale-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: 999_997_900,
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    // Advance the daemon cursor past the [WORKING] message so the tick doesn't
    // re-process it via handleMemberProtocolMarkers (which would re-mark working).
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    await h.loop.runTick();

    // L2: authoritative status flipped to unreachable (timeout signal).
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'unreachable');

    // L3: the owner was briefed once about the silent LOCAL member.
    assert.equal(h.ownerReportCalls.length, 1, 'L3 owner brief fired');
    assert.match(h.ownerReportCalls[0].text, /has been silent/);
    assert.match(h.ownerReportCalls[0].text, /Coder Bot/);

    // Idempotent: a second tick does not re-brief (per-streak kv guard).
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'owner brief fires once per streak');
  } finally {
    h.cleanup();
  }
});

test('P1-2: fresh cowork-session activity exempts a silent long-task worker from unreachable/timeout', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Stale [WORKING] signal (2 min old, past the 1-min test windows)…
    insertGroupMessage(h.db, {
      pinId: 'working-stale-live-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-live-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    // …but the worker's cowork session shows FRESH tool activity (long task
    // running) — the member must not be flagged or reclaimed.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'active long-task member keeps its working status');
    assert.equal(stoppedSessions.length, 0, 'no reclaim while the session is active');
  } finally {
    h.cleanup();
  }
});

test('P2-2: a valid [WORKING long-task] heartbeat lease exempts a silent worker', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'working-stale-hb-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-hb-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    // Heartbeat lease valid for another 30 min (normally written by the
    // [WORKING long-task, ETA N min] protocol marker handler).
    h.store.set('group_task_working_heartbeat:1:2', String(startMs + 30 * 60_000));
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'heartbeat-leased member keeps its working status');
    assert.equal(stoppedSessions.length, 0);
  } finally {
    h.cleanup();
  }
});

test('P1-2/P1-3: a genuinely inert worker session is reclaimed once per streak (stop + chair directive)', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    // fix-v2 (B2): reclaim is opt-in now; the default mode is alert-only.
    h.store.set('groupTaskStuckReclaim', JSON.stringify({ mode: 'auto' }));
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'working-stale-dead-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-dead-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    // Session exists but its last activity is an hour old — the stuck case.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'unreachable', 'inert member is flagged');
    assert.deepEqual(stoppedSessions, [session.id], 'stuck session stopped (cwd/artifacts preserved by stopSession)');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), '1', 'reclaim recorded');

    // Idempotent: a second tick does not stop again.
    await h.loop.runTick();
    assert.equal(stoppedSessions.length, 1, 'reclaim fires once per streak');
  } finally {
    h.cleanup();
  }
});

test('fix-v2 B2: stuck reclaim mode parser defaults to alert-only', () => {
  assert.equal(parseGroupTaskStuckReclaimMode(null), 'alert_only');
  assert.equal(parseGroupTaskStuckReclaimMode(''), 'alert_only');
  assert.equal(parseGroupTaskStuckReclaimMode('garbage'), 'alert_only');
  assert.equal(parseGroupTaskStuckReclaimMode('{"mode":"weird"}'), 'alert_only');
  assert.equal(parseGroupTaskStuckReclaimMode('{"mode":"auto"}'), 'auto');
  assert.equal(parseGroupTaskStuckReclaimMode('auto'), 'auto');
});

test('fix-v2 B2: prose dependency declarations in a chair dispatch are recognized', () => {
  assert.equal(hasProseDependencyDeclaration('@小新 开始 S5，依赖 S4 的交付'), true);
  assert.equal(hasProseDependencyDeclaration('S4 待 S2、S3 交付后开始合成'), true);
  assert.equal(hasProseDependencyDeclaration('等 S2 交付完成后再做质检'), true);
  assert.equal(hasProseDependencyDeclaration('S5 depends on S4'), true);
  assert.equal(hasProseDependencyDeclaration('blocked by the upstream render'), true);
  assert.equal(hasProseDependencyDeclaration('waiting for the design deliverable'), true);
  assert.equal(hasProseDependencyDeclaration('@小新 请开始制作主视觉'), false);
  assert.equal(hasProseDependencyDeclaration(''), false);
});

test('release-review P1: negated prose statements do NOT read as dependency declarations', () => {
  assert.equal(hasProseDependencyDeclaration('不依赖任何人，独立完成 S5'), false);
  assert.equal(hasProseDependencyDeclaration('无依赖，可以直接开始'), false);
  assert.equal(hasProseDependencyDeclaration('S5 不依赖 S4 即可开始'), false);
  assert.equal(hasProseDependencyDeclaration('没有任何前置条件'), false);
  assert.equal(hasProseDependencyDeclaration('不在 S4 之后开始'), false);
  assert.equal(hasProseDependencyDeclaration('无需依赖任何人，立刻开工'), false);
  assert.equal(hasProseDependencyDeclaration('does not depend on S4'), false);
  assert.equal(hasProseDependencyDeclaration('no dependency on the render'), false);
  assert.equal(hasProseDependencyDeclaration('independent of S4'), false);
  assert.equal(hasProseDependencyDeclaration('never waiting for the design'), false);
});

test('Task #83 P2b: reverse-direction prose ("others depend on me") does NOT read as a wait declaration', () => {
  // The live task-83 miss: "缺一项下游就要返工" inside the upstream member's
  // own clause parked the blocker itself under a prose exemption.
  assert.equal(hasProseDependencyDeclaration('@loop 缺一项下游就要返工'), false);
  assert.equal(hasProseDependencyDeclaration('下游依赖这份契约，必须先定稿'), false);
  assert.equal(hasProseDependencyDeclaration('其他成员依赖我的规格'), false);
  assert.equal(hasProseDependencyDeclaration('后续步骤都依赖 S3 的产物'), false);
  // Forward-direction (this member waits) still reads true.
  assert.equal(hasProseDependencyDeclaration('依赖上游的交付'), true);
  assert.equal(hasProseDependencyDeclaration('等上游交付后开始'), true);
  assert.equal(hasProseDependencyDeclaration('@小新 开始 S5，依赖 S4 的交付'), true);
});

test('fix-v2 B2: default stuck verdict is alert-only — the session is never stopped', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    // No groupTaskStuckReclaim kv → alert_only default. Same inert setup as
    // the auto-mode reclaim test above.
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'working-stale-alert-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const staleId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['working-stale-alert-i0'])[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, staleId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    assert.equal(stoppedSessions.length, 0, 'alert-only mode never stops the session');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined, 'no reclaim recorded');
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1', 'alert recorded once per streak');

    // Idempotent: the alert fires once per streak, not every tick.
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1');
    assert.equal(stoppedSessions.length, 0);
  } finally {
    h.cleanup();
  }
});

test('fix-v2 B2: a prose-declared upstream dependency exempts the waiting worker (no flag, no alert)', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // The chair's dispatch declares the dependency IN PROSE (the #54/#55
    // pattern — no structured [DEPENDS_ON] tag): S5 waits on S4.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-prose-dep-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S5 质检，依赖 S4 的交付，等它上线后开始。',
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    // The worker ACKed and then correctly went quiet waiting for upstream.
    insertGroupMessage(h.db, {
      pinId: 'working-prose-dep-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S4', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'a prose-dependency waiter keeps its working status');
    assert.equal(stoppedSessions.length, 0);
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined);
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), undefined, 'no stuck alert for a declared dependency wait');
    const exemptRaw = h.store.get('group_task_dep_wait_exempt:1:2');
    assert.ok(exemptRaw, 'dependency-wait exemption recorded');
    assert.match(exemptRaw, /prose-declared upstream/);
  } finally {
    h.cleanup();
  }
});

test('release-review P1: a prose dependency-wait exemption expires — monitoring resumes after the cap', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Chair dispatches with a prose dependency; the worker ACKs then goes
    // completely silent. With the old never-expiring exemption this member
    // could die without a single alert forever.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-prose-expire-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S5 质检，依赖 S4 的交付，等它上线后开始。',
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-prose-expire-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S4', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    // Within the cap: still exempt, no alert.
    await h.loop.runTick();
    let member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'within the cap the prose waiter stays exempt');
    assert.ok(h.store.get('group_task_dep_wait_exempt:1:2'), 'exemption note present');

    // Past the cap with the SAME chair assignment: the exemption
    // lifts and the normal unreachable verdict stamps the silent member.
    h.state.nowMs = startMs + PROSE_DEPENDENCY_EXEMPTION_MAX_MS + 60_000;
    await h.loop.runTick();
    member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'unreachable', 'after the cap the silent member is flagged again');
    const expiredNote = JSON.parse(h.store.get('group_task_dep_wait_exempt:1:2'));
    assert.equal(expiredNote.proseExemptionExpired, true, 'the exhausted exemption is stamped, not silently re-armed');
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1', 'the stuck alert fires once monitoring resumes');
  } finally {
    h.cleanup();
  }
});

test('release-review P1: a NEW chair assignment re-arms the prose exemption window', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'dispatch-prose-rearm-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S5 质检，依赖 S4 的交付，等它上线后开始。',
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-prose-rearm-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S4', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();
    const dispatchMsgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['dispatch-prose-rearm-i0'],
    )[0].values[0][0];
    let note = JSON.parse(h.store.get('group_task_dep_wait_exempt:1:2'));
    assert.ok(note.grantedAt, 'first grant stamps grantedAt');
    assert.equal(note.assignmentMsgId, dispatchMsgId, 'the note tracks the chair dispatch message');

    // Half the cap later the chair re-dispatches (still prose): the window
    // restarts from the new assignment instead of expiring.
    h.state.nowMs = startMs + 90 * 60_000;
    insertGroupMessage(h.db, {
      pinId: 'dispatch-prose-rearm-i1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 继续 S5，仍依赖 S4 交付后再开始。',
      chainTimestamp: Math.floor((startMs + 90 * 60_000) / 1000),
    });
    const newDispatchMsgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['dispatch-prose-rearm-i1'],
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, newDispatchMsgId);
    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 're-armed by the new assignment, the waiter stays exempt');
    note = JSON.parse(h.store.get('group_task_dep_wait_exempt:1:2'));
    assert.equal(note.assignmentMsgId, newDispatchMsgId, 'the note tracks the new assignment message');
    assert.ok(note.grantedAt >= startMs + 90 * 60_000, 'grantedAt restarted with the new assignment');
  } finally {
    h.cleanup();
  }
});

test('release-review P2: the dep-wait exemption survives chair chatter pushing the assignment past the old 50-message window', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Structured dependency dispatch, then the worker ACKs and waits quietly.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-window-dep-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `@Coder Bot 你负责 S5 质检，[DEPENDS_ON: ${'f'.repeat(64)}i0] 等 S4 交付后开始。`,
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-window-dep-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S4', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    // 60 chair chatter messages AFTER the assignment (no @mention of the
    // worker) — the old scan (chair's latest 50 messages) lost sight of the
    // assignment; the widened keyset scan must still find it.
    for (let i = 0; i < 60; i += 1) {
      insertGroupMessage(h.db, {
        pinId: `chair-chatter-${i}-i0`, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
        senderName: 'Twin Bot', content: `例行同步 ${i}：其余成员进展正常。`,
        chainTimestamp: Math.floor((startMs - 110_000 + i) / 1000),
      });
    }
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    await h.loop.runTick();
    assert.equal(stoppedSessions.length, 0, 'the waiting worker is not reclaimed');
    assert.equal(
      h.store.get('group_task_stuck_alert:1:2'),
      undefined,
      'no stuck alert — the assignment is still found past the old 50-message window',
    );
    const exemptRaw = h.store.get('group_task_dep_wait_exempt:1:2');
    assert.ok(exemptRaw, 'dependency-wait exemption still recorded');
    assert.match(exemptRaw, /f{64}i0/);
  } finally {
    h.cleanup();
  }
});

test('review fix: a delivered-then-idle worker is never flagged or reclaimed by the local-worker timeout', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    // fix-v2 (B2): reclaim is opt-in now; the default mode is alert-only.
    h.store.set('groupTaskStuckReclaim', JSON.stringify({ mode: 'auto' }));
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Both workers: stale [WORKING] signal (2 min old, past the 1-min test
    // windows) and a cowork session inert for an hour — inert by every
    // liveness signal.
    insertGroupMessage(h.db, {
      pinId: 'working-stale-done2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-stale-done3-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    h.groupTaskStore.setMemberStatus(task.id, 3, 'working', 'gmid-w3');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session: session2 } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    const { session: session3 } = ensureGroupTaskSession(h.coworkStore, task, 3, 'Designer Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id IN (?, ?)', [startMs - 60 * 60_000, session2.id, session3.id]);
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    // Member 2 delivered (non-rejected) before going idle — done, not stuck.
    // Member 3's only deliverable was REJECTED — the guard must not cover it.
    h.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, created_at)
       VALUES (?, 'pin-done-delivery', 'gmid-w2', 'metaapp', ?, 'delivered', 'unconfirmed', ?)`,
      [task.id, `metaapp://${'cd'.repeat(32)}i0`, startMs - 3 * 60_000],
    );
    h.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, created_at)
       VALUES (?, 'pin-rejected-delivery', 'gmid-w3', 'metaapp', ?, 'rejected', 'unconfirmed', ?)`,
      [task.id, `metaapp://${'ef'.repeat(32)}i0`, startMs - 3 * 60_000],
    );

    await h.loop.runTick();
    const member2 = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    const member3 = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 3);
    assert.equal(member2.status, 'working', 'delivered member keeps its working status');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined, 'no reclaim recorded for the delivered member');
    assert.equal(member3.status, 'unreachable', 'rejected-only member is still flagged');
    assert.deepEqual(stoppedSessions, [session3.id], 'only the genuinely stuck session is stopped');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:3'), '1', 'reclaim recorded for the rejected-only member');
  } finally {
    h.cleanup();
  }
});

test('review fix: a late deliverable is never reclaimed by the delivery-timeout escalation', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    // Simulate the pre-fix residue state DIRECTLY so the escalation branch's
    // own deliverable re-check is what must save the worker: the deadline
    // blew, the reminder went out, the deliverable then arrived LATE (kv
    // never retired), and the member has been quietly waiting since.
    h.store.set('group_task_expected_delivery:1:2', JSON.stringify({ dueAt: startMs - 5 * 60_000 }));
    h.store.set('group_task_delivery_reminded:1:2', '1');
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    h.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, created_at)
       VALUES (?, 'pin-late-delivery', 'gmid-w2', 'metaapp', ?, 'delivered', 'unconfirmed', ?)`,
      [task.id, `metaapp://${'ab'.repeat(32)}i0`, startMs - 3 * 60_000],
    );
    // No cowork session activity for an hour — inert by every liveness signal.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();
    assert.deepEqual(stoppedSessions, [], 'delivered-late worker is not stopped');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined, 'no reclaim recorded');
    assert.ok(
      !h.sends.some((send) => /delivery-timeout recovery/.test(send.content)),
      'no recovery directive for an already-delivered member',
    );
    // The stale watch retired instead of lingering armed.
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined);
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined);
  } finally {
    h.cleanup();
  }
});

test('GT-09: the delivery-deadline escalation honors alert-only mode instead of reclaiming directly', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    // Escalation residue state: deadline blown, reminder sent, member inert.
    // Default reclaim mode is ALERT-ONLY — the escalation branch used to
    // reclaim anyway (bypassing the mode entirely).
    h.store.set('group_task_expected_delivery:1:2', JSON.stringify({ dueAt: startMs - 5 * 60_000 }));
    h.store.set('group_task_delivery_reminded:1:2', '1');
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();
    assert.deepEqual(stoppedSessions, [], 'alert-only mode: the escalation never stops the session');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined, 'no reclaim recorded');
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1', 'an alert is raised instead');
  } finally {
    h.cleanup();
  }
});

test('GT-09: the delivery-deadline escalation skips a member waiting on an undelivered upstream', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };

    // The chair's latest assignment for the worker is [DEPENDS_ON]-gated on an
    // upstream pinid that has NOT landed on the ledger.
    insertGroupMessage(h.db, {
      pinId: 'gt09-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `@Coder Bot 请基于上游结果做二次封装 [DEPENDS_ON: ${'ef'.repeat(32)}i0]`,
      chainTimestamp: Math.floor(startMs / 1000) - 400,
    });
    h.store.set('group_task_expected_delivery:1:2', JSON.stringify({ dueAt: startMs - 5 * 60_000 }));
    h.store.set('group_task_delivery_reminded:1:2', '1');
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();
    assert.deepEqual(stoppedSessions, [], 'a dependency-waiting member is never reclaimed');
    assert.equal(h.store.get('group_task_stuck_reclaim:1:2'), undefined, 'no reclaim recorded');
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), undefined, 'no stuck alert either — waiting is not stuck');
    const note = h.store.get(`group_task_dep_wait_exempt:${task.id}:2`);
    assert.ok(note, 'the dependency-wait exemption note stands');
    assert.equal(JSON.parse(note).upstreamDelivered, false);
  } finally {
    h.cleanup();
  }
});

test('GT-10: a chair obligation dropped after the re-drive alerts the origin session', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]); // executing
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-gt10a', task.id]);
    // The chair already got its ONE automatic re-drive and stayed silent.
    h.store.set(
      `group_task_chair_response_pending:${task.id}`,
      JSON.stringify({ messageId: 42, reason: 'chair_mentioned', atMs: h.state.nowMs - 60 * 60_000, redriven: true }),
    );
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      undefined,
      'the twice-missed obligation is dropped',
    );
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && m.subject === 'chair_response_dropped:42'),
      'the drop alerts the origin session instead of disappearing quietly',
    );
  } finally {
    h.cleanup();
  }
});

test('GT-10: a member turn that exhausts its retry budget drops with an anomaly (not silently)', async () => {
  const milestones = [];
  const h = await createHarness({
    chatErrorAlways: 'provider down',
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]); // executing
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-gt10b', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'gt10-mention-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please handle this',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Every turn fails; the durable defer queue re-drives until the budget
    // (5 failures) is exhausted.
    for (let i = 0; i < 6; i += 1) await h.loop.runTick();
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && /^turn_failed_drop:/.test(m.subject ?? '')),
      'exhausting the retry budget alerts the origin session',
    );
  } finally {
    h.cleanup();
  }
});

test('GT-10: a message dropped after 5 processing failures alerts the origin session', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      // A permanently failing attribution resolver — every processing attempt
      // throws (transient shape), burning the MSG_RETRY budget.
      resolveGlobalMetaId: async () => { throw new Error('indexer down'); },
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]); // executing
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-gt10c', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'gt10-poison-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '进展同步一下',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    for (let i = 0; i < 6; i += 1) await h.loop.runTick();
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && /^message_dropped:/.test(m.subject ?? '')),
      'dropping the poison message alerts the origin session',
    );
    const rowId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['gt10-poison-i0'])[0].values[0][0];
    assert.ok(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId >= rowId,
      'the cursor advanced past the dropped message',
    );
  } finally {
    h.cleanup();
  }
});

test('HOST-FIX-RFP D1/D4: a model-layer config failure parks the trigger uncharged, alerts on FIRST failure, probes, and heals', async () => {
  const milestones = [];
  const h = await createHarness({
    // The zhipu incident wording: the member's binding names a provider that
    // vanished from the catalog — every turn fails in milliseconds.
    chatErrorAlways: "Provider 'zhipu' does not offer enabled model 'glm-5.3'; provider selection is required.",
    deps: {
      modelStallProbeMs: 30_000,
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-rfp-d1', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'rfp-d1-mention-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot redo the demo video',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });

    await h.loop.runTick();
    // Host-note delivery runs CHAIR turns (bot 1, llm 'llm-1'); count only the
    // parked member's attempts (bot 2, llm 'llm-2').
    const workerCalls = () => h.chatCalls.filter((call) => call.llmId === 'llm-2');
    assert.equal(workerCalls().length, 1, 'fail-fast: exactly one attempt, no 5x retry ladder burn');
    const modelAlerts = () => milestones.filter((m) => m.kind === 'anomaly' && /^member_model_error:/.test(m.subject ?? ''));
    assert.equal(modelAlerts().length, 1, 'the FIRST failure already alerts the origin session (D4: immediate)');
    assert.match(modelAlerts()[0].message, /zhipu/, 'the alert carries the root cause');
    assert.match(modelAlerts()[0].message, /PARKED/, 'the alert says the dispatch is parked, not dropped');
    const hostNoteRows = h.db.exec(
      'SELECT kind, body FROM group_task_host_notes WHERE task_id = ?', [task.id],
    )[0]?.values ?? [];
    assert.ok(
      hostNoteRows.some((row) => row[0] === 'member_model_error' && /zhipu/.test(row[1])),
      'the chair host-note ledger records the member failure with its reason',
    );
    // The trigger is parked, NOT dropped: deferred, uncharged, stall armed.
    const parked = JSON.parse(h.store.get(`group_task_deferred:${task.id}`));
    assert.equal(parked.length, 1, 'the dispatch survives in the deferred queue');
    assert.equal(parked[0].failures ?? 0, 0, 'the park is UNCHARGED');
    assert.ok(h.store.get(`group_task_model_stall:${task.id}:2`) != null, 'the model stall is armed');

    // Within the probe window the drain holds the entry — no hot requeue loop.
    for (let i = 0; i < 3; i += 1) await h.loop.runTick();
    assert.equal(workerCalls().length, 1, 'the drain holds the parked entry inside the probe window');
    assert.equal(modelAlerts().length, 1, 'no duplicate alert while parked (D4: dedup by root cause)');

    // After the probe interval the drain releases ONE probe; it fails again —
    // still uncharged, still exactly ONE alert.
    h.state.nowMs += 31_000;
    await h.loop.runTick();
    assert.equal(workerCalls().length, 2, 'one probe per stall interval');
    assert.equal(modelAlerts().length, 1, 'a failed probe does not re-alert');
    assert.equal((JSON.parse(h.store.get(`group_task_deferred:${task.id}`)))[0].failures ?? 0, 0, 'probe failure stays uncharged');

    // Healing: the owner re-picks the model — the next probe turn succeeds and
    // lifts the stall, and the parked dispatch finally gets its answer.
    h.state.chatErrorAlways = null;
    h.state.nowMs += 31_000;
    await h.loop.runTick();
    assert.equal(workerCalls().length, 3, 'the healed member answers the parked trigger');
    assert.ok(h.sends.some((s) => s.metabotId === 2), 'the answer is posted to the group');
    assert.equal(h.store.get(`group_task_model_stall:${task.id}:2`), undefined, 'a successful turn lifts the stall');
  } finally {
    h.cleanup();
  }
});

test('HOST-FIX-RFP D1: the E1d protocol-incompatibility fingerprint also parks instead of dropping', async () => {
  const milestones = [];
  const h = await createHarness({
    chatErrorAlways: 'DSH turn failed: OpenAI API error (400): ModelProtocolUnsupported: Model does not support this protocol.',
    deps: {
      modelStallProbeMs: 30_000,
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-rfp-e1d', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'rfp-e1d-mention-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the lobby visuals',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const workerCalls = () => h.chatCalls.filter((call) => call.llmId === 'llm-2');
    assert.equal(workerCalls().length, 1, 'fail-fast on the protocol fingerprint too');
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && /^member_model_error:/.test(m.subject ?? '') && /ModelProtocolUnsupported/.test(m.message)),
      'first-failure alert carries the protocol root cause',
    );
    assert.ok(h.store.get(`group_task_model_stall:${task.id}:2`) != null, 'the trigger is parked, not dropped');
  } finally {
    h.cleanup();
  }
});

test('HOST-FIX-RFP D1: a model stall past the 24h cap resumes the charged ladder and terminates with a drop alert', async () => {
  const milestones = [];
  const h = await createHarness({
    chatErrorAlways: "Provider 'zhipu' does not offer enabled model 'glm-5.3'; provider selection is required.",
    deps: {
      modelStallProbeMs: 30_000,
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-rfp-cap', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'rfp-cap-mention-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot redo the demo video',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const workerCalls = () => h.chatCalls.filter((call) => call.llmId === 'llm-2');
    assert.equal(workerCalls().length, 1, 'initial failure parks the trigger');

    // The binding stays broken past the 24h park cap: the ordinary charged
    // ladder resumes so the episode still terminates.
    h.state.nowMs += 25 * 3_600_000;
    for (let tick = 0; tick < 5; tick += 1) await h.loop.runTick();
    assert.equal(workerCalls().length, 6, 'the charged ladder runs to exhaustion after the cap');
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && /^turn_failed_drop:/.test(m.subject ?? '') && /persisted past the 24h park window/.test(m.message)),
      'the terminal drop alerts with the model-stall context',
    );
    assert.equal(h.store.get(`group_task_deferred:${task.id}`), undefined, 'the trigger is gone after the drop');
    assert.equal(h.store.get(`group_task_model_stall:${task.id}:2`), undefined, 'the stall record is cleared on the terminal drop');
  } finally {
    h.cleanup();
  }
});

test('review fix (single-commander): a fresh chair-stated deadline resets the delivery-reminded flag before re-arming', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const stoppedSessions = [];
    h.deps.stopWorkerSession = (sessionId) => { stoppedSessions.push(sessionId); };
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);

    const ack = (pin) => insertGroupMessage(h.db, {
      pinId: pin, senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] doing X，预计2分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Single-track deadlines: the chair's [DEADLINE] tag is the only clock.
    insertGroupMessage(h.db, {
      pinId: 'assign-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do X [DEADLINE: 2m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    ack('ack-eta-1');
    await h.loop.runTick();
    h.state.nowMs += 3 * 60_000; // past the 2-min deadline
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1, 'first deadline bell recorded as an environment note');
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), '1');

    // New assignment with a fresh chair deadline: the flag must reset or this
    // cycle skips the bell and drops straight onto the reclaim ladder.
    insertGroupMessage(h.db, {
      pinId: 'assign-2', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do Y [DEADLINE: 1m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    ack('ack-eta-2');
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined, 'flag reset on re-arm');

    h.state.nowMs += 90_000; // past the new deadline, before the grace window ends
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 2, 'second deadline miss gets its own bell');
    assert.deepEqual(stoppedSessions, [], 'no reclaim during the fresh cycle');
  } finally {
    h.cleanup();
  }
});

test('classifyMemberLiveness: heartbeat lease, speech, and session activity each keep a member alive', () => {  const { classifyMemberLiveness } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const nowMs = 1_700_000_000_000;
  const thresholdMs = 20 * 60_000;
  // everything absent → stale
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: null, lastSessionActivityMs: null, heartbeatUntilMs: null, nowMs, thresholdMs,
  }), 'stale');
  // valid heartbeat lease → alive even with nothing else
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: null, lastSessionActivityMs: null, heartbeatUntilMs: nowMs + 10 * 60_000, nowMs, thresholdMs,
  }), 'alive');
  // expired lease → stale
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: null, lastSessionActivityMs: null, heartbeatUntilMs: nowMs - 1, nowMs, thresholdMs,
  }), 'stale');
  // fresh speech → alive
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: nowMs - 5 * 60_000, lastSessionActivityMs: null, heartbeatUntilMs: null, nowMs, thresholdMs,
  }), 'alive');
  // fresh session activity (the long-task case) → alive
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: nowMs - 60 * 60_000, lastSessionActivityMs: nowMs - 60_000, heartbeatUntilMs: null, nowMs, thresholdMs,
  }), 'alive');
  // old everything → stale
  assert.equal(classifyMemberLiveness({
    lastSpeakMs: nowMs - 60 * 60_000, lastSessionActivityMs: nowMs - 60 * 60_000, heartbeatUntilMs: null, nowMs, thresholdMs,
  }), 'stale');
});

test('parseChairDeadlineMinutes: tag/prose forms parse; ambiguity and junk fall back', () => {
  const { parseChairDeadlineMinutes } = require('../dist-electron/main/services/groupTaskDaemon.js');
  assert.equal(parseChairDeadlineMinutes('Do the thing. [DEADLINE: 30m]'), 30);
  assert.equal(parseChairDeadlineMinutes('[DEADLINE: 45 minutes]'), 45);
  assert.equal(parseChairDeadlineMinutes('deadline: 45 minutes for this step'), 45);
  assert.equal(parseChairDeadlineMinutes('deadline 15 min'), 15);
  assert.equal(parseChairDeadlineMinutes('deadline of 20分钟'), 20);
  // The same value stated twice is still one deadline.
  assert.equal(parseChairDeadlineMinutes('[DEADLINE: 30m] — deadline: 30 minutes'), 30);
  // Conservative fallbacks.
  assert.equal(parseChairDeadlineMinutes('no deadline stated here'), null);
  assert.equal(parseChairDeadlineMinutes('deadline: 30m and also deadline: 45m'), null);
  assert.equal(parseChairDeadlineMinutes('deadline: 99999 minutes'), null);
  assert.equal(parseChairDeadlineMinutes('deadline soon'), null);
  assert.equal(parseChairDeadlineMinutes(''), null);
  assert.equal(parseChairDeadlineMinutes(null), null);
});

test('extractMemberDispatchClause (GT#87 P2-4): later deadline-bearing @clause beats the greeting clause', () => {
  const { extractMemberDispatchClause, parseChairDeadlineMinutes } = require('../dist-electron/main/services/groupTaskDaemon.js');
  // The #5832 shape: 小明同学 greeted at the top, dispatched in paragraph ④.
  const content = '@小明同学 欢迎入列！你坐本卡的验收席——独立验收人，与设计实现零重叠。全场请先读需求稿。\n\n'
    + '分工与顺序如下：\n\n'
    + '④ 验收席 @小明同学：把需求稿 §4 五条口径逐条转成可执行验收清单，清单草稿上链交付 [DEADLINE: 45m]。保持独立。';
  const clause = extractMemberDispatchClause(content, '小明同学');
  assert.ok(clause, 'clause extracted');
  assert.ok(clause.startsWith('@小明同学：把需求稿'), 'the dispatch clause wins over the greeting');
  assert.equal(parseChairDeadlineMinutes(clause), 45, 'the 45m is reachable from the clause');
});

test('extractMemberDispatchClause (GT#87 P2-4): a floating trailing deadline paragraph attaches to the @clause', () => {
  const { extractMemberDispatchClause, parseChairDeadlineMinutes } = require('../dist-electron/main/services/groupTaskDaemon.js');
  // The #5861 shape: @loop confirmation paragraph, unrelated middle
  // paragraphs, deadline as a trailing standalone paragraph.
  const content = '@loop 冻结稿 v1.1 已逐节复核。确认 v1.1 为本卡冻结版（取代 v1.0）。\n\n'
    + '[DEPENDS_ON: pin://' + 'ab'.repeat(32) + 'i0]\n\n'
    + '[CORRECTION] 口径更正：五类事件应为七路径。\n\n'
    + '派工前还差一次收口（v1.1.1，一次补齐、不再链式），四项：\n① participants[]。\n② C6 判据数值。\n'
    + 'v1.1.1 作为新 pin 交付、上链后才打首个实现 commit（保 D1 审计干净）。[DEADLINE: 20m]';
  const clause = extractMemberDispatchClause(content, 'loop');
  assert.ok(clause, 'clause extracted');
  assert.equal(parseChairDeadlineMinutes(clause), 20, 'the trailing floating 20m attaches to the @clause');

  // The #5863 shape: single @mention, the dependency + deadline live in the
  // NEXT paragraph with no @-token.
  const content2 = '@Builder阿码 六点全部落账：1/2/3 已进 v1.1。\n\n'
    + '第一棒现在派工。\n范围：冻结稿 v1.2 全量。\n交付：可跑索引器骨架＋向量全绿＋对数演练就绪。[DEADLINE: 140m]（含等的约 20m）';
  const clause2 = extractMemberDispatchClause(content2, 'Builder阿码');
  assert.ok(clause2, 'clause extracted');
  assert.equal(parseChairDeadlineMinutes(clause2), 140, 'the biggest-baton 140m is reachable from the clause');
});

test('extractMemberDispatchClause (GT#87 P2-4): floating attachment never crosses into another member\'s @clause', () => {
  const { extractMemberDispatchClause, parseChairDeadlineMinutes } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const content = '@Coder Bot 前置调研，无硬期限。\n\n'
    + '@Designer Bot，下一棒：组稿预备，现在开工，[DEADLINE: 45m]。\n\n'
    + '其余事项随后再定。';
  const coder = extractMemberDispatchClause(content, 'Coder Bot');
  assert.equal(parseChairDeadlineMinutes(coder), null, "Coder's tagless clause never borrows Designer's 45m");
  const designer = extractMemberDispatchClause(content, 'Designer Bot');
  assert.equal(parseChairDeadlineMinutes(designer), 45, "Designer's own clause keeps its 45m");
});

test('extractMemberDispatchClause (GT#87 audit): a floating segment whose only [DEADLINE] is a quoted citation never attaches', () => {
  const { extractMemberDispatchClause, parseChairDeadlineMinutes } = require('../dist-electron/main/services/groupTaskDaemon.js');
  // The chair's own playbook discipline: quote a restated tag in backticks so
  // the host reads it as a citation. Pre-fix, the floating attach tested the
  // RAW segment, so a trailing "clock reference sample" paragraph armed the
  // tagless member's clock with the cited minutes.
  const content = '@Coder Bot 冻结稿 v1.1 已逐节复核，交付随你节奏。\n\n'
    + '参考（引用样例，非你的时钟）：阿码的 `[DEADLINE: 140m]` 时钟照旧（5863 起算）。';
  const clause = extractMemberDispatchClause(content, 'Coder Bot');
  assert.equal(parseChairDeadlineMinutes(clause), null,
    'a floating block whose only tag is a backtick citation never attaches to the member\'s clause');
  // Fence-quoted citations behave the same as inline backticks.
  const fenced = '@Coder Bot 冻结稿 v1.1 已逐节复核，交付随你节奏。\n\n'
    + '参考：\n```\n[DEADLINE: 90m] 他人时钟\n```';
  const fencedClause = extractMemberDispatchClause(fenced, 'Coder Bot');
  assert.equal(parseChairDeadlineMinutes(fencedClause), null,
    'a fenced citation paragraph never attaches either');
  // Control: an UNQUOTED floating trailing deadline still attaches (P2-4).
  const real = '@Coder Bot 冻结稿 v1.1 已逐节复核。\n\n[DEADLINE: 20m]';
  assert.equal(parseChairDeadlineMinutes(extractMemberDispatchClause(real, 'Coder Bot')), 20,
    'the unquoted floating tag keeps its P2-4 attachment');
});

test('cursor advances on no-reply messages; a failing turn\'s retry coalesces with newer queued triggers (task #64)', async () => {
  // Cooldowns off: this test isolates the retry/ordering semantics.
  const h = await createHarness({ workerCooldownMs: 0, chairCooldownMs: 0 });
  try {
    const task = h.createTask([2, 3]);

    // chair talking (self-skip) -> no replies at all
    insertGroupMessage(h.db, {
      pinId: 'self-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'note to self, nobody addressed',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
    const selfId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['self-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, selfId);

    // fix/group-task-flow semantics: turns are detached jobs. The first
    // message's turn fails (one-shot error) and re-enters the durable defer
    // queue; the second message's trigger queues behind the busy session. The
    // cursor advances once both triggers are dispatched/queued — reply-level
    // retries never regress the cursor.
    h.state.chatError = 'llm exploded';
    // Worker-originated mentions (Designer Bot → Coder Bot): not chair
    // assignments, so the drain's newest-trigger preference governs.
    insertGroupMessage(h.db, {
      pinId: 'boom-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot first attempt',
    });
    insertGroupMessage(h.db, {
      pinId: 'ok-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot second attempt',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'only the first message attempted; the second queues behind the busy session');
    assert.equal(h.sends.length, 0, 'nothing sent while the first turn fails');
    const okId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['ok-i0'])[0].values[0][0];
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, okId,
      'cursor advanced once both triggers were dispatched/queued (turn retry rides the durable queue)',
    );

    // Next tick: the failed retry and the queued trigger COALESCE into one
    // turn (task #64): neither is a chair assignment, so the drain answers the
    // NEWEST obligation — the bot is not made to re-live the stale first
    // message as its own multi-minute turn. The one-shot error is spent and
    // the single turn succeeds.
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'one coalesced turn drains the whole backlog');
    assert.match(h.chatCalls[1].userMessage, />>> Designer Bot: @Coder Bot second attempt <<</, 'newest trigger answered');
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].replyPin, 'ok-i0', 'reply threaded under the newest trigger');

    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'nothing left to drain — the superseded trigger is spent');
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, okId);
  } finally {
    h.cleanup();
  }
});

test('loop prevention: cooldown and per-tick cap', async () => {
  const h = await createHarness({ maxRepliesPerTaskPerTick: 2 });
  try {
    const task = h.createTask([2, 3, 4]);

    // one message mentions all three workers; per-tick cap = 2
    insertGroupMessage(h.db, {
      pinId: 'all-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot @Designer Bot @Reviewer Bot all hands',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'per-tick cap stops the third worker');

    // P0-3c: the capped worker is DEFERRED, not dropped — the next tick
    // compensates it (its message is already behind the cursor). Coder's fresh
    // mention is still inside its 20s cooldown, so it stays deferred.
    insertGroupMessage(h.db, {
      pinId: 'again-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot again',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 3, 'deferred third worker gets its turn on the next tick');
    assert.equal(h.sends.at(-1).metabotId, 4, 'compensation reply is from the capped Reviewer Bot');
    assert.equal(
      h.sends.filter((s) => s.metabotId === 2).length,
      1,
      'Coder Bot is still inside its cooldown; its mention is deferred, not dropped',
    );

    // past cooldown: the deferred 'again' mention finally flows, and the fresh
    // 'third' mention is deferred again (just replied).
    h.state.nowMs += 21_000;
    insertGroupMessage(h.db, {
      pinId: 'third-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot third',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 4, 'deferred Coder reply compensates after cooldown');
    assert.equal(h.sends.at(-1).metabotId, 2);
  } finally {
    h.cleanup();
  }
});

test('loop prevention: reply budget per (task, bot)', async () => {
  const h = await createHarness({ replyBudget: 1 });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'm1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    // budget exhausted (1): even after the cooldown, no more replies from this bot
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'm2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot two',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'budget exhausted: no second reply');
  } finally {
    h.cleanup();
  }
});

test('Task #83 F1: the budget is a rolling one-hour window — charges age out and the member answers again', async () => {
  const h = await createHarness({ replyBudget: 1 });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'f1-w1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    // Inside the window: still capped (storm insurance unchanged).
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'f1-w2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot two',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'a fresh charge inside the window stays capped');

    // Past the window: the old charge aged out — no restart needed.
    h.state.nowMs += 61 * 60_000;
    insertGroupMessage(h.db, {
      pinId: 'f1-w3-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot three',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'the budget refills as charges age out of the window');
  } finally {
    h.cleanup();
  }
});

test('Task #83 F1: an exhausted budget never blocks the owner\u2019s message to the chair', async () => {
  const h = await createHarness({ replyBudget: 1 });
  try {
    h.createTask([2]);
    // Charge the chair's budget once via an owner message...
    insertGroupMessage(h.db, {
      pinId: 'f1-boss-1-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'chair, status?',
    });
    await h.loop.runTick();
    assert.equal(h.sends.filter((s) => s.metabotId === 1).length, 1, 'the first owner message got its chair answer');

    // ...then exhaust it with a worker-triggered chair turn so the NEXT
    // budget check sees a spent budget.
    insertGroupMessage(h.db, {
      pinId: 'f1-w1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] pin://' + 'e'.repeat(64) + 'i0',
    });
    h.state.nowMs += 60_000;
    await h.loop.runTick();

    // The owner's follow-up must STILL wake the chair even at the cap.
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'f1-boss-2-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'chair, verdict?',
    });
    await h.loop.runTick();
    assert.ok(
      h.sends.filter((s) => s.metabotId === 1).length >= 2,
      'the owner message dispatches the chair even with the budget exhausted',
    );
  } finally {
    h.cleanup();
  }
});

test('GT#72: the reply budget counts LOGICAL replies — a failed turn retry is never blocked by the budget it already charged', async () => {
  // One-shot LLM failure: the first dispatch charges the message's logical
  // reply and fails; the durable-queue retry is the SAME reply, so it must
  // drain even at the cap. Pre-GT#72 the re-dispatch was itself charged
  // (and the drain gate dropped it at the cap), stranding the trigger.
  const h = await createHarness({ replyBudget: 1, chatError: 'llm hiccup' });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'retry-m1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one',
    });
    await h.loop.runTick(); // dispatch 1: charged, LLM throws once, re-queued
    assert.equal(h.sends.length, 0, 'nothing sent while the turn fails');

    await h.loop.runTick(); // retry: already charged — passes the budget gate
    assert.equal(h.sends.length, 1, 'the retry of a charged message is not budget-blocked');

    // A NEW message is a NEW logical reply — still capped.
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'retry-m2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot two',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'a new logical reply is still budget-capped');
  } finally {
    h.cleanup();
  }
});

test('GT#72: reply budget exhaustion raises one owner-visible anomaly (the chair is never silently muted)', async () => {
  // Pre-GT#72 the exhaustion left nothing but a daemon log line — GT#72's
  // chair sat muted for 12 minutes with a verified release candidate until a
  // supervisor nudge rescued it. The anomaly rides the origin-session rail
  // (the one that actually reacted) exactly once per (task, bot).
  const milestones = [];
  const h = await createHarness({
    replyBudget: 1,
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-budget', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'budget-m1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);

    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'budget-m2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot two',
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'still capped');

    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'budget-m3-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot three',
    });
    await h.loop.runTick();

    const budgetAnomalies = milestones.filter(
      (m) => m.kind === 'anomaly' && m.subject === 'reply_budget_exhausted:bot:2',
    );
    assert.equal(budgetAnomalies.length, 1, 'exactly one exhaustion anomaly per (task, bot)');
    assert.match(budgetAnomalies[0].message, /exhausted its per-task reply budget/);
    // F1 (task #83): the window refills — the notice no longer prescribes a restart.
    assert.match(budgetAnomalies[0].message, /rolling one-hour window/);
  } finally {
    h.cleanup();
  }
});

test('chair reply does not count against the per-tick worker cap', async () => {
  const h = await createHarness({ maxRepliesPerTaskPerTick: 1 });
  try {
    h.createTask([2, 3]);
    // owner message mentions both workers: chair replies (owner privilege) + 1 worker (cap)
    insertGroupMessage(h.db, {
      pinId: 'boss-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: '@Coder Bot @Designer Bot get started',
    });
    await h.loop.runTick();
    const workerSends = h.sends.filter((s) => s.metabotId !== 1);
    const chairSends = h.sends.filter((s) => s.metabotId === 1);
    assert.equal(chairSends.length, 1, 'chair replied to the owner message');
    assert.equal(workerSends.length, 1, 'worker cap = 1, chair reply not counted');
  } finally {
    h.cleanup();
  }
});

test('send failure is logged and swallowed; cursor still advances', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const originalSend = h.sends;
    let attempt = 0;
    // rebuild a loop whose send throws
    const failingLoop = createGroupTaskDaemonLoop({
      getStore: () => h.store,
      getGroupTaskStore: () => h.groupTaskStore,
      getMetabotStore: () => h.metabotStore,
      getCoworkStore: () => h.coworkStore,
      performChat: async () => 'reply-text',
      postGroupTaskMessage: async () => {
        attempt += 1;
        throw new Error('chain offline');
      },
      emitLog: () => {},
      now: () => h.state.nowMs,
    });
    insertGroupMessage(h.db, {
      pinId: 'fail-send-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot say hi',
    });
    await failingLoop.runTick();
    // fix/group-task-flow: the send runs inside the detached turn job — drain it.
    await failingLoop.whenIdle();
    assert.equal(attempt, 1, 'send was attempted');
    assert.equal(originalSend.length, 0, 'no successful sends recorded');
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['fail-send-i0'])[0].values[0][0];
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId, 'cursor advanced despite send failure');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Protocol tags ([DELIVERABLE] / [STATUS]) and skill turns
// ---------------------------------------------------------------------------

test('deliverable tags: kind inference, uri extraction, author recorded, dedupe by msg_pin_id', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const cases = [
      { pinId: 'd1-i0', content: '[DELIVERABLE] metafile: metafile://ababababababababababababababababababababababababababababababababi0.png see this', kind: 'metafile', uri: 'metafile://ababababababababababababababababababababababababababababababababi0.png' },
      { pinId: 'd2-i0', content: '[DELIVERABLE] metaapp: metaapp://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0 is live', kind: 'metaapp', uri: 'metaapp://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0' },
      { pinId: 'd3-i0', content: '[DELIVERABLE] url: https://example.com/preview', kind: 'url', uri: 'https://example.com/preview' },
      { pinId: 'd4-i0', content: '[deliverable] text summary: the work is done', kind: 'text', uri: null },
    ];
    for (const c of cases) {
      insertGroupMessage(h.db, {
        pinId: c.pinId, senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
        senderName: 'Coder Bot', content: c.content,
      });
    }
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 4);
    for (const c of cases) {
      const row = rows.find((r) => r.msgPinId === c.pinId);
      assert.ok(row, `deliverable for ${c.pinId}`);
      assert.equal(row.kind, c.kind, `${c.pinId} kind`);
      assert.equal(row.uri, c.uri, `${c.pinId} uri`);
      assert.equal(row.authorGlobalmetaid, 'gmid-w2');
      assert.equal(row.status, 'pending');
    }

    // reprocessing the same messages (cursor forced back) must not duplicate rows
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = 0 WHERE id = ?', [task.id]);
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 4, 'dedupe by task_id + msg_pin_id');
  } finally {
    h.cleanup();
  }
});

test('status tags: chair-only, transitions, same-status silent, review->executing rework hatch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    insertGroupMessage(h.db, {
      pinId: 's1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[STATUS:REVIEW] worker trying to move it',
    });
    insertGroupMessage(h.db, {
      pinId: 's2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'work is underway\n[STATUS:EXECUTING]',
    });
    insertGroupMessage(h.db, {
      pinId: 's3-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'still underway\n[STATUS:EXECUTING]',
    });
    insertGroupMessage(h.db, {
      pinId: 's4-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal looks met\n[STATUS:REVIEW]',
    });
    insertGroupMessage(h.db, {
      pinId: 's5-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'rework needed after all\n[STATUS:EXECUTING]',
    });
    await h.loop.runTick();

    // worker tag ignored; chair tags drive planning->executing->review->executing
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.deepEqual(
      h.events
        .filter((e) => e.type === 'groupTask:statusChanged')
        .map((e) => ({ type: e.type, taskId: e.taskId, status: e.status })),
      [
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'executing' },
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'review' },
        { type: 'groupTask:statusChanged', taskId: task.id, status: 'executing' },
      ],
      'every real transition fires the event (incl. the review->executing rework hatch); same-status does not',
    );
    assert.ok(h.events.every((e) => typeof e.at === 'number'));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#47: chair plan message with a DESCRIPTIVE [STATUS:REVIEW] quoted in the
// body + the real instruction tag at the end (the task #47 post-mortem repro)
// ---------------------------------------------------------------------------

test('GT#47 R1: descriptive [STATUS:REVIEW] in the plan body must not beat the trailing [STATUS:EXECUTING]', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    insertGroupMessage(h.db, {
      pinId: 'plan-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '目标: 完成 anydoc 技能。验收标准: 全部交付物上链, owner 核验通过后发 [STATUS:REVIEW]。\n'
        + '分工: @Coder Bot 负责封装与终检。\n[STATUS:EXECUTING]',
      chainTimestamp: 100,
    });
    await h.loop.runTick();

    // The task must leave planning via the trailing EXECUTING instruction —
    // the pre-fix parser grabbed the descriptive REVIEW, the illegal
    // planning->review directive was swallowed, and the task stayed pinned.
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.ok(
      logs.some((line) => line.includes('carries 2 [STATUS:*] tags')),
      'multi-tag message leaves an audit log line',
    );
    const transitions = h.groupTaskStore.listTaskTransitions(task.id);
    assert.ok(
      transitions.some((t) => t.toStatus === 'executing' && /\[STATUS:EXECUTING\] tag/.test(t.reason ?? '')),
      'transition audit row credits the EXECUTING tag',
    );
    assert.ok(
      !transitions.some((t) => (t.reason ?? '').startsWith('illegal_transition')),
      'no rejected-directive audit row for the plan message',
    );

    // Follow-through (the real msg 2113 shape): a final-check message whose
    // trailing tag is the real [STATUS:REVIEW] now lands review cleanly.
    insertGroupMessage(h.db, {
      pinId: 'final-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '终检: 选题/文案/配图/上链全部完成, 等待 owner 验收。\n[STATUS:REVIEW]',
      chainTimestamp: 101,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
  } finally {
    h.cleanup();
  }
});

test('GT#47 R2: an illegal chair [STATUS] directive leaves a rejected-transition audit row instead of silence', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    insertGroupMessage(h.db, {
      pinId: 'early-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '提前进入验收 [STATUS:REVIEW]', chainTimestamp: 100,
    });
    await h.loop.runTick();

    // planning -> review is illegal: the task stays put, but the rejection is
    // now observable (audit row + log), not swallowed whole.
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning');
    const rejected = h.groupTaskStore
      .listTaskTransitions(task.id)
      .find((t) => (t.reason ?? '').startsWith('illegal_transition'));
    assert.ok(rejected, 'rejected-directive audit row written');
    assert.equal(rejected.fromStatus, 'planning');
    assert.equal(rejected.toStatus, 'review');
    assert.ok(logs.some((line) => line.includes('directive rejected')), 'rejection logged');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #52: the chair's real verdict ended `[STATUS:REVIEW] — trailing prose`
// on its last line. The G-03 absolute-trailing parse read the instruction as a
// descriptive body tag, the task stayed pinned in executing (stall nudges,
// zombie worker re-dispatch), and the acceptance card never appeared. The
// instruction field is now the last non-empty LINE.
// ---------------------------------------------------------------------------

test('task #52: a verdict tag followed by explanation prose on the last line applies review', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing
    // The literal msg-2436 shape: verdict body, then the tag-led footer line
    // with an em-dash explanation the old parser choked on.
    insertGroupMessage(h.db, {
      pinId: 'verdict52-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '✅ 全部交付核验完成，任务目标达成。\n\n'
        + '[STATUS:REVIEW] — 本任务全部完成，现等待 Sunny 在 Tasks UI 验收。',
      chainTimestamp: 100,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.ok(
      h.groupTaskStore
        .listTaskTransitions(task.id)
        .some((t) => t.toStatus === 'review' && /\[STATUS:REVIEW\] tag/.test(t.reason ?? '')),
      'transition audit row credits the REVIEW tag',
    );
  } finally {
    h.cleanup();
  }
});

test('task #52: a tag at the END of the last line (prose before it) is the instruction too', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'verdict52b-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '终检完成，进入验收 [STATUS:REVIEW]', chainTimestamp: 101,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
  } finally {
    h.cleanup();
  }
});

test('task #52 parse keeps GT#47 protection: a descriptive tag on a NON-last line stays ignored', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    insertGroupMessage(h.db, {
      pinId: 'plan52-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '目标: 完成技能。验收标准: 全部交付物上链, owner 核验通过后发 [STATUS:REVIEW]。\n'
        + '分工: @Coder Bot 负责封装。\n以上，计划宣读完毕。',
      chainTimestamp: 102,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning');
    assert.ok(
      logs.some((line) => line.includes('descriptive tags ignored, no transition applied')),
      'the ignored descriptive tag is logged, not silent',
    );
  } finally {
    h.cleanup();
  }
});

test('task #52 self-heal: a REVIEW directive the cursor already passed reconciles on the next daemon run', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'stuck-verdict-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '✅ 全部交付核验完成。\n[STATUS:REVIEW] — 本任务全部完成，现等待验收。',
      chainTimestamp: Math.floor(Date.now() / 1000),
    });
    // Simulate the stuck state: the cursor already advanced past the verdict
    // (the pre-fix daemon processed and ignored it), and no transition newer
    // than the directive exists (the planning->executing move predates it).
    const stuckId = h.db
      .exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['stuck-verdict-i0'])[0].values[0][0];
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [stuckId, task.id]);
    h.db.run('DELETE FROM group_task_transitions WHERE task_id = ?', [task.id]);
    h.db.run('DELETE FROM group_task_status_events WHERE task_id = ?', [task.id]);

    // Fresh daemon run: makeLoop() builds a clean loop instance whose
    // once-per-run reconcile guard has not fired yet.
    const fresh = h.makeLoop();
    await fresh.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.ok(
      h.groupTaskStore
        .listTaskTransitions(task.id)
        .some((t) => t.toStatus === 'review' && /\[STATUS:REVIEW\] tag/.test(t.reason ?? '')),
      'reconciled transition is audited like a normal one',
    );
    assert.ok(logs.some((line) => line.includes('reconciling stuck status directive')), 'reconcile logged');
    // The settle must be idempotent across daemon runs: a second fresh run
    // finds directive === status and stays quiet.
    const again = h.makeLoop();
    await again.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
  } finally {
    h.cleanup();
  }
});

test('task #52 self-heal guard: a directive older than the last transition must not flip a reworked task back', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing (transition row created_at = now)
    // Verdict message timestamped in the past (epoch-sec test fixtures) — any
    // recorded transition is NEWER, so the old REVIEW must not win.
    insertGroupMessage(h.db, {
      pinId: 'old-verdict-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '✅ 全部完成。\n[STATUS:REVIEW] — 等待验收。',
      chainTimestamp: 100,
    });
    const oldId = h.db
      .exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['old-verdict-i0'])[0].values[0][0];
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [oldId, task.id]);

    const fresh = h.makeLoop();
    await fresh.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'an older REVIEW directive never reconciles over a newer transition',
    );
    assert.ok(!logs.some((line) => line.includes('reconciling stuck status directive')), 'no reconcile attempt');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT-04 (task #56): legality-aware status-directive adjudication. The old
// "last end-line tag wins" rule let task #56's descriptive end-line REVIEW
// sink the legitimate standalone [STATUS:EXECUTING] line mid-message — the
// whole message's intent was rejected and the task pinned in planning with
// zero group-visible feedback. Now the first candidate LEGAL from the live
// status is the instruction, illegal candidates are rejected with an audit
// row + origin anomaly + an in-group status-parser note, and backtick-quoted
// tags are citations, never instructions.
// ---------------------------------------------------------------------------

test('GT-04 adjudication: pure verdicts across the historical message shapes', () => {
  // Task #56 (msg 2815): standalone EXECUTING mid-body, REVIEW cited after
  // prose on the end line — the end-line tag no longer sinks the real
  // instruction. GT#72: the embedded citation is descriptive (it was never an
  // instruction), not a rejected candidate — citations earn no audit noise.
  const v56 = adjudicateStatusDirectives(
    '分工如上，请 @Coder Bot 开工。\n[STATUS:EXECUTING]\n交付齐了之后我再 [STATUS:REVIEW]。',
    'planning',
  );
  assert.equal(v56.instruction, 'executing');
  assert.deepEqual(v56.rejected, []);
  assert.deepEqual(v56.descriptive, ['review']);

  // Task #52: end-line tag with trailing prose stays the instruction.
  const v52 = adjudicateStatusDirectives(
    '✅ 全部交付核验完成。\n[STATUS:REVIEW] — 本任务全部完成，现等待验收。',
    'executing',
  );
  assert.equal(v52.instruction, 'review');
  assert.deepEqual(v52.rejected, []);

  // GT#47: a descriptive body tag + a real end-line instruction — the body
  // tag stays descriptive prose (protection unchanged).
  const v47 = adjudicateStatusDirectives(
    '目标: 完成技能。验收标准: owner 核验通过后发 [STATUS:REVIEW]。\n分工: @Coder Bot 负责封装。\n[STATUS:EXECUTING]',
    'planning',
  );
  assert.equal(v47.instruction, 'executing');
  assert.deepEqual(v47.rejected, []);
  assert.deepEqual(v47.descriptive, ['review']);

  // A standalone mid-body line with NO end-line tag is the instruction.
  const standalone = adjudicateStatusDirectives('计划如上\n[STATUS:EXECUTING]\n即刻开工', 'planning');
  assert.equal(standalone.instruction, 'executing');

  // All candidates illegal from the live status: nothing applies.
  const illegal = adjudicateStatusDirectives('结论如上\n[STATUS:REVIEW]', 'planning');
  assert.equal(illegal.instruction, null);
  assert.deepEqual(illegal.rejected, ['review']);

  // Backtick-wrapped and fenced tags are citations, never parsed.
  assert.equal(adjudicateStatusDirectives('发 `[STATUS:EXECUTING]` 即可推进。', 'planning').tagCount, 0);
  assert.equal(
    adjudicateStatusDirectives('示例:\n```\n[STATUS:EXECUTING]\n```\n如上。', 'planning').tagCount,
    0,
  );

  // Terminal states: no chair move exists, so even a clean tag is rejected.
  const terminal = adjudicateStatusDirectives('重启执行\n[STATUS:EXECUTING]', 'done');
  assert.equal(terminal.instruction, null);
  assert.deepEqual(terminal.rejected, ['executing']);

  // A chair tag re-asserting the LIVE status is a benign no-op — neither an
  // instruction nor an illegal sibling (the chair prompt explicitly tells a
  // partially confused chair to re-issue its verdict; the duplicate must not
  // mint an illegal-transition audit row).
  const reassert = adjudicateStatusDirectives('再次确认\n[STATUS:REVIEW]', 'review');
  assert.equal(reassert.instruction, null);
  assert.deepEqual(reassert.rejected, []);
  assert.deepEqual(reassert.noOp, ['review']);

  // Mixed: a legal instruction plus a same-status sibling — the sibling is a
  // no-op, not a "rejected" tag the group gets scolded about.
  const mixed = adjudicateStatusDirectives(
    '重派说明如上。\n[STATUS:EXECUTING]\n[STATUS:REVIEW]（前值，已作废）',
    'review',
  );
  assert.equal(mixed.instruction, 'executing');
  assert.deepEqual(mixed.rejected, []);
  assert.deepEqual(mixed.noOp, ['review']);

  // GT#72: the same sibling cited MID-LINE (words on both sides) is a
  // descriptive citation, not a no-op candidate.
  const mixedCited = adjudicateStatusDirectives(
    '重派说明如上。\n[STATUS:EXECUTING]\n此前误发的 [STATUS:REVIEW] 作废。',
    'review',
  );
  assert.equal(mixedCited.instruction, 'executing');
  assert.deepEqual(mixedCited.noOp, []);
  assert.deepEqual(mixedCited.descriptive, ['review']);
});

test('Task #63: markdown-emphasis-wrapped standalone tag lines are instructions; quotes and prose stay descriptive', () => {
  // The literal task #63 shape (msg 3664): a long wrap-up report with the
  // verdict BOLDED on its own line mid-message, prose and a table after it —
  // pre-fix this filed as descriptive and parked the task in executing.
  const v63 = adjudicateStatusDirectives(
    '**六项验收全过**：①MetaApp 上链五要素+0 Web2+0 残留。\n\n'
      + '**[STATUS:REVIEW]**\n\n'
      + '**第 29 期交付汇总**（全流程 07:08-09:48）：\n\n'
      + '| 交付物 | 链上 URI |\n|---|---|\n| MetaApp | metaapp://d6155cf6i0 |',
    'executing',
  );
  assert.equal(v63.instruction, 'review', 'bolded own-line verdict is an instruction');
  assert.deepEqual(v63.rejected, []);
  assert.deepEqual(v63.descriptive, []);

  // Underscore (italic/bold) wrapping counts too.
  const vUnder = adjudicateStatusDirectives('汇总如上。\n__[STATUS:EXECUTING]__\n开工。', 'planning');
  assert.equal(vUnder.instruction, 'executing');

  // A stray unbalanced emphasis marker around the tag is still standalone.
  const vUnbalanced = adjudicateStatusDirectives('汇总如上。\n* [STATUS:REVIEW] *\n见下表。', 'executing');
  assert.equal(vUnbalanced.instruction, 'review');

  // Strikethrough negates intent — stays descriptive.
  const vStrike = adjudicateStatusDirectives('汇总如上。\n~~[STATUS:REVIEW]~~\n见下。', 'executing');
  assert.equal(vStrike.instruction, null);
  assert.deepEqual(vStrike.descriptive, ['review']);

  // A blockquote line quotes another speaker — stays descriptive.
  const vQuote = adjudicateStatusDirectives('如前所述：\n> [STATUS:REVIEW]\n见上。', 'executing');
  assert.equal(vQuote.instruction, null);

  // Mid-sentence prose citations on non-final lines stay descriptive (the
  // corrective-note path, not a transition).
  const vProse = adjudicateStatusDirectives('交付齐后我会发 [STATUS:REVIEW]。\n各位抓紧， deadline 前。', 'executing');
  assert.equal(vProse.instruction, null);
  assert.deepEqual(vProse.descriptive, ['review']);
});

test('GT#72: a status tag EMBEDDED after prose on the end line is a citation, never the instruction', () => {
  // The literal #4399 shape: a clock/plan line whose last token is the tag
  // being cited as a FUTURE step ("release → [STATUS:REVIEW]。") — pre-GT#72
  // this flipped the task to review 45 minutes early (mid-assembly) and
  // suppressed three dispatches until dispatch_held notes reopened it.
  const vClock = adjudicateStatusDirectives(
    '两份关键交付同时核验完毕，全过。\n时钟：v1.0 ~02:30 → 小明复核 ~02:45 → 我实读放行 → [STATUS:REVIEW]。全组最后两棒。',
    'executing',
  );
  assert.equal(vClock.instruction, null, 'the embedded end-line citation must NOT instruct');
  assert.deepEqual(vClock.descriptive, ['review']);

  // Task #70 shape: a quoted promise ending the message.
  const v70 = adjudicateStatusDirectives(
    '等我核完这批交付，然后我发 [STATUS:REVIEW]。',
    'executing',
  );
  assert.equal(v70.instruction, null);
  assert.deepEqual(v70.descriptive, ['review']);

  // A tag that LEADS the final line (with explanation after it) stays the
  // task #52 verdict shape — the GT#72 fix must not regress it.
  const vLead = adjudicateStatusDirectives(
    '✅ 全部交付核验完成。\n[STATUS:REVIEW] — 本任务全部完成，现等待验收。',
    'executing',
  );
  assert.equal(vLead.instruction, 'review');

  // Arrows before a LEADING tag are prose too — lead is judged on prefix
  // emptiness, not punctuation flavor.
  const vArrowLead = adjudicateStatusDirectives('汇总如上。\n[STATUS:EXECUTING] → 复工，按新分工。', 'review');
  assert.equal(vArrowLead.instruction, 'executing');
});

test('GT#72 replay: the premature-flip clock line keeps the task in executing and records the citation note', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing, mid-assembly — the #72 state
    insertGroupMessage(h.db, {
      pinId: 'clock-line-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '两条裁决收到，chair 确认全部采纳。\n'
        + '@Coder Bot v1.0 组装全部解锁，开工，[DEADLINE: 20m]。\n'
        + '时钟：v1.0 ~02:30 → 复核 ~02:45 → 我实读放行 → [STATUS:REVIEW]。全组最后两棒。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'a cited future step must not flip the task — #72 never re-runs the premature flip',
    );
    // The chair learns immediately: the descriptive-citation note (task #63
    // heritage) rides the parse channel so a REAL verdict mis-formatted this
    // way re-sends a bare tag on its next turn instead of stalling.
    const citeNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.target === 'status citation');
    assert.equal(citeNotes.length, 1, 'the demoted end-line citation is reported to the chair');
    assert.match(citeNotes[0].body, /not applied; task stays executing/);
  } finally {
    h.cleanup();
  }
});

test('GT-04 (task #56 replay): a standalone EXECUTING line beats an illegal end-line REVIEW, and the group hears why', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // planning, the #56 stuck state
    // The literal 2815 shape: dispatch body, the real instruction on its own
    // line, and a closing line that merely MENTIONS [STATUS:REVIEW] in prose.
    insertGroupMessage(h.db, {
      pinId: 'msg56-pin-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '定稿派工：@Coder Bot 负责封装，@Tester Bot 负责核验。\n'
        + '[STATUS:EXECUTING]\n'
        + '两位开工。交付齐后我再 [STATUS:REVIEW]。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'the legitimate standalone instruction applies — #56 never leaves planning again',
    );
    const transitions = h.groupTaskStore.listTaskTransitions(task.id);
    assert.ok(
      transitions.some((t) => t.toStatus === 'executing' && /\[STATUS:EXECUTING\] tag/.test(t.reason ?? '')),
      'applied transition is audited',
    );
    // Single-commander: the parse verdict is a host environment note for the
    // chair (never an in-group post wearing the chair identity). GT#72: the
    // end-line REVIEW sits after prose (a future promise), so it is
    // descriptive — not a rejected sibling — and an applied instruction plus
    // a descriptive citation records no correction note.
    const parseNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.body.includes('message #'));
    assert.equal(parseNotes.length, 0, 'an applied instruction plus a descriptive citation records no note');
  } finally {
    h.cleanup();
  }
});

test('Task #63 replay: a bolded own-line [STATUS:REVIEW] wrap-up enters review on the FIRST pass', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing — the #63 stuck state
    // The literal msg-3664 shape: long wrap-up, the verdict bolded on its own
    // line mid-message, prose and a table AFTER it (so it is not the end line).
    insertGroupMessage(h.db, {
      pinId: 'msg63-wrapup-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '**六项验收全过**：①MetaApp 上链五要素+0 Web2+0 残留。\n\n'
        + '**[STATUS:REVIEW]**\n\n'
        + '**第 29 期交付汇总**（全流程 07:08-09:48）：\n\n'
        + '| 交付物 | 链上 URI |\n|---|---|\n| MetaApp | metaapp://d6155cf6i0 |',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'review',
      'the bolded own-line verdict applies immediately — #63 never parks in executing',
    );
    assert.ok(
      h.groupTaskStore.listTaskTransitions(task.id)
        .some((t) => t.toStatus === 'review' && /\[STATUS:REVIEW\] tag/.test(t.reason ?? '')),
      'applied transition is audited',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #63: a prose-embedded [STATUS:*] citation with no instruction posts the corrective note, rate-limited', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'prose-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '交付齐后我会发 [STATUS:REVIEW]。\n各位抓紧， deadline 前。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing', 'prose citation moves nothing');
    const notes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.body.includes('descriptive only'));
    assert.equal(notes.length, 1, 'the descriptive citation was recorded as an environment note');
    assert.ok(notes[0].body.includes('REVIEW'), 'the note names the cited tag');
    assert.ok(notes[0].body.includes('executing'), 'the note states the live status');

    // Rate limit: a second prose citation inside the window stays log-only.
    insertGroupMessage(h.db, {
      pinId: 'prose-review-2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '再次提醒：完成后发 [STATUS:REVIEW] 才算数。\n别忘。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const descriptiveRows = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'parse' AND body LIKE '%descriptive only%'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(descriptiveRows, 1, 'descriptive notes are rate-limited per task');
  } finally {
    h.cleanup();
  }
});

test('Task #63: a descriptive-only citation with no legal move stays silent (plan prose protection)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // planning
    // GT#47's documented plan-prose shape: cites REVIEW (illegal from
    // planning) with no instruction — no note, no transition.
    insertGroupMessage(h.db, {
      pinId: 'plan-prose-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '验收标准: owner 核验通过后发 [STATUS:REVIEW]。\n分工见上。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning', 'plan prose moves nothing');
    assert.equal(
      h.sends.filter((send) => send.content.startsWith('[GROUP_TASK_NOTICE:status_parser]')).length,
      0,
      'no corrective note for non-actionable citations',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #63: the no-progress nudge NAMES the unapplied [STATUS:*] citation when one exists', async () => {
  const h = await createHarness({
    deps: { noProgressNudgeMs: 60_000, noProgressStallMs: 300_000 },
  });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'stuck-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '交付齐后我会发 [STATUS:REVIEW]。\n各位抓紧， deadline 前。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 400, // idle past the nudge window
    });
    await h.loop.runTick();

    const pending = h.groupTaskStore.listPendingSupervisorSignals(task.id);
    assert.equal(pending.length, 1, 'the idle-stuck task nudged the chair');
    assert.ok(
      pending[0].note.includes('Diagnosis') && pending[0].note.includes('[STATUS:REVIEW]'),
      'the nudge names the unapplied citation instead of a generic status-update ask',
    );
    assert.ok(
      pending[0].note.includes('still "executing"'),
      'the nudge states the authoritative host status',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #63 deliverables: another member tagging an already-recorded URI folds — one row, one author', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]); // executing
    const pin = 'd6155cf69f078c826e0db128d874673325bb5c6ae07348f75899a3621cdac497i0';
    // Worker 2 (gmid-w2) publishes the artifact (task #63 msg 3656 shape:
    // tag-led description line, URI on the next line).
    insertGroupMessage(h.db, {
      pinId: 'gt63-deliver-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] 第29期 MetaApp 已上链\n\nmetaapp://${pin}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    // Worker 3's promo message tags the SAME metaapp in its own [DELIVERABLE]
    // line (task #63 msg 3663 shape — the promo-cites-product case that minted
    // the duplicate row attributed to the wrong member).
    insertGroupMessage(h.db, {
      pinId: 'gt63-promo-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot',
      content: `[DELIVERABLE] 群聊推广位：直开 metaapp://${pin} 看完整第 29 期`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id)
      .filter((deliverable) => (deliverable.uri ?? '').includes(pin.slice(0, 32)));
    assert.equal(rows.length, 1, 'one artifact = one ledger row');
    assert.equal(
      (rows[0].authorGlobalmetaid ?? '').toLowerCase(),
      'gmid-w2',
      'the author stays the original publisher, not the citer',
    );
    assert.ok(
      logs.some((line) => line.includes('cites') && line.includes('folded')),
      'the cross-member citation fold is logged',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #63: reconcile re-arms on cursor advance — a mid-run parser miss heals on the next tick', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing
    await h.loop.runTick(); // tick 1: nothing to reconcile, stamp set

    // Simulate the pre-fix stuck state MID-RUN: a verdict message the parser
    // of an older build ate (cursor already past it, no transition recorded).
    // Real-clock chain timestamp (+slack): the reconcile freshness guard
    // compares it against status_events' sqlite datetime('now'), which the
    // harness's fake nowMs clock does not track.
    insertGroupMessage(h.db, {
      pinId: 'midrun-miss-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '全部交付核验完成。\n**[STATUS:REVIEW]**\n汇总如上。',
      chainTimestamp: Math.floor(Date.now() / 1000) + 5,
    });
    const missId = h.db
      .exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['midrun-miss-i0'])[0].values[0][0];
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [missId, task.id]);

    await h.loop.runTick(); // tick 2: cursor advanced → reconcile re-armed

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'review',
      'the mid-run miss reconciles without an app restart (the once-per-run guard is gone)',
    );
    assert.ok(
      logs.some((line) => line.includes('reconciling stuck status directive')),
      'the reconcile pass is logged',
    );
  } finally {
    h.cleanup();
  }
});

test('GT-04: an all-illegal chair directive stays put but is NEVER silent (audit + anomaly + in-group note)', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-gt04', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'all-illegal-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '验收结论如上。\n[STATUS:REVIEW]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning', 'no illegal transition applied');
    assert.ok(
      h.groupTaskStore.listTaskTransitions(task.id)
        .some((t) => t.toStatus === 'review' && /illegal_transition/.test(t.reason ?? '')),
      'the rejected directive leaves an audit row',
    );
    assert.ok(
      milestones.some((m) => m.kind === 'anomaly' && m.subject === 'illegal_transition:review'),
      'the origin session hears the anomaly',
    );
    const parseNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.body.includes('rejected as illegal'));
    assert.ok(parseNotes.length >= 1, 'the rejection is recorded for the chair to correct');
  } finally {
    h.cleanup();
  }
});

test('GT-04: a backtick-quoted [STATUS:*] citation is never an instruction (escape hatch)', async () => {
  const logs = [];
  // The planning-turn LLM sees the group log where the chair already
  // dispatched (task #66 shape) and correctly answers [NO_REPLY].
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: { performChat: async () => '[NO_REPLY]' },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    insertGroupMessage(h.db, {
      pinId: 'citation-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '协议提醒：定稿后用 `[STATUS:EXECUTING]` 推进执行，验收用 `[STATUS:REVIEW]`。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning', 'citations move nothing');
    assert.equal(
      h.sends.filter((send) => send.content.startsWith('[GROUP_TASK_NOTICE:status_parser]')).length,
      0,
      'no parser note for pure citations',
    );
  } finally {
    h.cleanup();
  }
});

test('GT-04 self-heal: the cursor-passed #56-shape message reconciles planning -> executing on a fresh daemon run', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    insertGroupMessage(h.db, {
      pinId: 'stuck-56-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '定稿派工：@Coder Bot 负责封装。\n[STATUS:EXECUTING]\n交付齐后我再 [STATUS:REVIEW]。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Simulate the stuck state: the cursor already ate the message (the
    // pre-fix daemon rejected the whole intent), and no transition/status
    // event exists to satisfy the freshness guard.
    const stuckId = h.db
      .exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['stuck-56-i0'])[0].values[0][0];
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [stuckId, task.id]);
    h.db.run('DELETE FROM group_task_transitions WHERE task_id = ?', [task.id]);
    h.db.run('DELETE FROM group_task_status_events WHERE task_id = ?', [task.id]);

    const fresh = h.makeLoop();
    await fresh.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'adjudicated reconcile repairs the #56 stuck state',
    );
    assert.ok(logs.some((line) => line.includes('reconciling stuck status directive')), 'reconcile logged');
  } finally {
    h.cleanup();
  }
});

test('GT#47 R3: during review, chair mentions arm no ACK watch and worker [WORKING] arms no delivery deadline', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'rev-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal met\n[STATUS:REVIEW]', chainTimestamp: 100,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');

    // Chair final-check message @mentions the worker during review (the msg
    // that mis-armed the no-ACK alarm for eleven in task #47)...
    insertGroupMessage(h.db, {
      pinId: 'final-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '终检通过: @Coder Bot 的交付已核验, 等待 owner 验收。', chainTimestamp: 101,
    });
    // ...and the worker ACKs that review-phase message (the msg that mis-armed
    // the expected_delivery deadline for Builder in task #47).
    insertGroupMessage(h.db, {
      pinId: 'ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到, 静默待命', chainTimestamp: 102,
    });
    await h.loop.runTick();

    assert.equal(
      h.store.get(`group_task_ack_pending:${task.id}:2`),
      undefined,
      'review-phase mention arms no ACK watch',
    );
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'review-phase [WORKING] arms no delivery deadline',
    );
    assert.ok(
      logs.some((line) => line.includes('no delivery deadline armed')),
      'the gated ACK is logged as liveness-only',
    );

    // Control: back in executing (rework hatch) an ETA-bearing [WORKING] arms
    // the deadline again — the gate is phase-scoped, not a blanket disarm.
    // Speedup R-02: the arming now also requires an assignment on record, so
    // the chair re-dispatches before the worker's ACK.
    insertGroupMessage(h.db, {
      pinId: 'rework-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'rework needed after all\n[STATUS:EXECUTING]', chainTimestamp: 103,
    });
    insertGroupMessage(h.db, {
      pinId: 'reassign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 重做这一步 [DEADLINE: 10m]', chainTimestamp: 104,
    });
    insertGroupMessage(h.db, {
      pinId: 'ack2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 重新开工，预计 10 分钟', chainTimestamp: 105,
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_expected_delivery:${task.id}:2`) != null,
      'executing-phase [WORKING] still arms the delivery deadline',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// #13 join-welcome handshake + #14 closing ceremony
// ---------------------------------------------------------------------------

test('#13 welcome (single-commander): a mid-task join records ONE environment note and the chair greets in its own voice', async () => {
  const h = await createHarness();
  const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
  h.deps.getOpenTeamMembershipStore = () => membershipStore;
  try {
    const task = h.createTask([2, 3]);
    // First tick snapshots the create-time roster (chair has a join pin here;
    // local workers carry none in this harness) — no note for it.
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'create-time roster produces no join note');

    // The invite row records WHY the remote member was invited; then the join
    // lands (member row with joined_pin_id appears — P1-2 watcher behavior).
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-fortune',
      inviteeName: 'Fortune Teller Master',
      invitePinId: 'invite-fortune',
      requiredSkills: ['占卜', '塔罗'],
    });
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Teller Master',
      role: 'worker',
      joinedPinId: 'pin-join-fortune',
    });

    // Join tick: the join FACT is recorded for the chair (no host broadcast).
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'the host posts no welcome broadcast');
    const joinNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'join');
    assert.equal(joinNotes.length, 1, 'exactly one join note recorded');
    assert.match(joinNotes[0].body, /Fortune Teller Master just joined/);
    assert.match(joinNotes[0].body, /Invited for: 占卜, 塔罗/, 'invite required-skills explain why');
    assert.match(joinNotes[0].body, /Greet them/);

    // Next tick delivers the note: the chair greets in its OWN voice (a real
    // chair turn, not a host line wearing the chair identity).
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listPendingHostNotes(task.id).length, 0, 'note consumed');
    const chairGreets = h.sends.filter((s) => s.metabotId === 1);
    assert.equal(chairGreets.length, 1, 'the chair greeted once, itself');

    // A later tick fires nothing more (kv-guarded).
    const sendCount = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, sendCount, 'join handled exactly once');
  } finally {
    h.cleanup();
  }
});

test('#13 welcome (single-commander): members reply once to the CHAIR-written greeting and nothing replies back', async () => {
  const h = await createHarness({ workerCooldownMs: 0, chairCooldownMs: 0 });
  const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
  h.deps.getOpenTeamMembershipStore = () => membershipStore;
  try {
    const task = h.createTask([2, 3]);
    await h.loop.runTick(); // snapshot tick
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-fortune',
      displayName: 'Fortune Teller Master',
      role: 'worker',
      joinedPinId: 'pin-join-fortune',
    });
    await h.loop.runTick(); // join note recorded
    await h.loop.runTick(); // note turn: the chair greets in its own voice

    const greeting = h.sends.find((s) => s.metabotId === 1);
    assert.ok(greeting, 'the chair greeted');
    assert.equal(h.groupTaskStore.listPendingHostNotes(task.id).length, 0, 'note consumed');

    // Simulate the on-chain round-trip: the chair's greeting enters the log
    // and @s the seated members (a real roll-call written by the chair).
    insertGroupMessage(h.db, {
      pinId: 'welcome-pin-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '欢迎 @Fortune Teller Master 加入! @Coder Bot @Designer Bot 请确认在线。',
    });
    await h.loop.runTick();

    const replies = h.sends.filter((s) => s.metabotId !== 1);
    assert.deepEqual(
      replies.map((s) => s.metabotId).sort(),
      [2, 3],
      'existing members confirmed once (mention-gated reply to the greeting)',
    );

    // Their confirmations carry no mentions: no further replies, no loop.
    const count = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, count, 'handshake stops after one round');
  } finally {
    h.cleanup();
  }
});

test('#14 closing (single-commander): review entry records the acceptance summary — the host posts NOTHING in the group', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing (planning->review is illegal by the state machine)
    // A worker's [WORKING] sits last in the log; the chair posts the bare tag.
    insertGroupMessage(h.db, {
      pinId: 'working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在收尾',
      chainTimestamp: 100,
    });
    insertGroupMessage(h.db, {
      pinId: 'review-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal looks met\n[STATUS:REVIEW]',
      chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    // The chair's own [STATUS:REVIEW] message is the group-facing wrap-up; the
    // host never posts a closing line or summary wearing the chair identity.
    assert.equal(
      h.sends.filter((s) => /进入验收阶段|进入验收/.test(s.content)).length,
      0,
      'no host closing line in the group',
    );
    // R1: the summary is still persisted as the single source of truth for
    // the Tasks acceptance card (version 1), it just never posts to the group.
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'acceptance summary persisted on review entry');
    assert.equal(summary.version, 1);
    assert.equal(summary.goal, 'Build and publish the intro MetaApp');
  } finally {
    h.cleanup();
  }
});

test('Improvement #1: review entry captures the chair 【结论】 into the record and the group message', async () => {
  const h = await createHarness({ chatReply: '【结论】验收通过并结项\n\n叙述正文……' });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal met\n[STATUS:REVIEW]', chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    // The verdict is persisted on the summary record — the single authoritative
    // copy the card headline renders from.
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'summary persisted on review entry');
    assert.equal(summary.conclusion, '验收通过并结项');
    // Single-commander: the record is the single authoritative copy (the
    // acceptance card renders it); the host posts no ceremony message.
    assert.equal(
      h.sends.filter((s) => /进入验收阶段|进入验收/.test(s.content)).length,
      0,
      'no host ceremony message in the group',
    );
  } finally {
    h.cleanup();
  }
});

test('Improvement #1: a failed owner report degrades to a conclusion-less ceremony (never blocks review)', async () => {
  const h = await createHarness({ ownerReportFails: true });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal met\n[STATUS:REVIEW]', chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary);
    assert.equal(summary.conclusion, null, 'no fabricated conclusion without the report');
    assert.equal(
      h.sends.filter((s) => /进入验收阶段|进入验收/.test(s.content)).length,
      0,
      'no host ceremony message; the record is conclusion-less but review still landed',
    );
  } finally {
    h.cleanup();
  }
});

test('#14 closing re-assert (single-commander): a straggler after review entry triggers NO host re-assert', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing (planning->review is illegal)
    insertGroupMessage(h.db, {
      pinId: 'working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] finishing up', chainTimestamp: 100,
    });
    insertGroupMessage(h.db, {
      pinId: 'review-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal met\n[STATUS:REVIEW]', chainTimestamp: 101,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.equal(h.sends.length, 0, 'review entry itself posts nothing');

    // A worker turn that was in flight when review began finishes AFTER the
    // verdict — the transcript simply ends on the straggler now; the Tasks
    // acceptance card is the authoritative closing view.
    insertGroupMessage(h.db, {
      pinId: 'straggler-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'final build passed, uploading', chainTimestamp: 103,
    });
    await h.loop.runTick();
    // EP33 P1②: monitor-derived supervisor hints recorded before review may
    // now be ANSWERED by the chair in review (the chair speaks there) — that
    // is bot speech, not a host re-assert. The STRAGGLER itself must trigger
    // no closing line and no re-assert of any kind.
    assert.ok(
      !h.sends.some((s) => /进入验收|进入验收阶段|closing/i.test(String(s.content))),
      'no closing/re-assert line — the host is never a speaker',
    );
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
  } finally {
    h.cleanup();
  }
});

test('skill path: routing hit runs the skill turn in the existing session, plain path untouched', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2, 3]);
    // Round-4: a member WORKER (Designer Bot) mentions a colleague — the
    // sender is neither boss nor chair, so the widened flag stays false.
    insertGroupMessage(h.db, {
      pinId: 'skill-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot search for MetaID docs',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 1, 'skill turn used');
    // P14 (v1.1): the sender is a fellow WORKER (Designer Bot), not the chair —
    // a worker mention is not an assignment, so no auto-ACK chat call runs and
    // no "[WORKING] 已接单" template may quote it as work (task #22 logged ~20
    // such mismatches). The plain completion itself is not called either.
    assert.equal(h.chatCalls.length, 0, 'no ACK chat call for a worker-originated mention');
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no template ACK posted',
    );
    assert.equal(h.routingCalls[0].metabotId, 2, 'routing scoped to the responding bot');
    assert.equal(h.routingCalls[0].widened, false, 'human sender: no owner privilege');

    // ran inside the existing metaweb_group_task session for (task, worker)
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping);
    assert.equal(h.skillTurnCalls[0].sessionId, mapping.coworkSessionId);
    assert.deepEqual(h.skillTurnCalls[0].activeSkillIds, ['web-search']);
    assert.match(h.skillTurnCalls[0].systemPrompt, /available_skills/);
    assert.match(h.skillTurnCalls[0].userMessage, />>> Designer Bot: @Coder Bot/);

    // P14 (v1.1): no [WORKING] ACK precedes the turn — the trigger came from
    // a fellow worker, not the chair, so no assignment context exists. Only
    // the skill-turn reply goes on-chain, posted as the worker bot.
    assert.equal(h.sends.length, 1, 'turn reply only (no auto-ACK for worker-originated trigger)');
    assert.equal(h.sends[0].metabotId, 2, 'reply posted as the worker bot');
    assert.equal(h.sends[0].content, 'skill-turn-reply');
    const messages = h.coworkStore.getSessionMessages(mapping.coworkSessionId);
    // fix-v2 (B6): injected context snapshot precedes the turn's user message.
    assert.deepEqual(messages.map((m) => m.type), ['user', 'user']);
    assert.match(messages[0].content, /group context snapshot/);
  } finally {
    h.cleanup();
  }
});

test('skill path: no routing hit falls back to the plain completion', async () => {
  const h = await createHarness({ coderChatSkills: ['web-search'] }); // routing returns null prompt
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'plain-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot quick question',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 0, 'skill turn not used');
    assert.equal(h.chatCalls.length, 1, 'plain completion used');
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].content, /reply-for-llm-2/);
  } finally {
    h.cleanup();
  }
});

test('task #64: a join-welcome trigger runs the plain path even when skill routing hits', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    h.createTask([2]);
    // The host welcome broadcast shape (posted as the chair, @mentions the
    // new member, asks for a presence greeting) — task #64: routing it into a
    // skill turn let the worker burn its whole 30-min budget doing the task
    // inside the greeting turn while the group saw only silence.
    insertGroupMessage(h.db, {
      pinId: 'welcome-coder-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '[GROUP_TASK_NOTICE:welcome]\n🎉 欢迎 @Coder Bot 加入任务「Build MetaApp」!\n'
        + 'Coder Bot 受邀参与本任务协作。\n'
        + '@Coder Bot:请先向群内打个招呼确认就位,再开始工作。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 0, 'welcome greeting must not become a skill/work turn');
    assert.equal(h.chatCalls.length, 1, 'greeting answered via the fast plain completion');
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].metabotId, 2);
    assert.equal(h.sends[0].replyPin, 'welcome-coder-i0', 'greeting threaded under the welcome');
  } finally {
    h.cleanup();
  }
});

test('task #64: a host long-turn notice under the member\'s name does NOT count as an implicit ACK', async () => {
  const h = await createHarness({ ackTimeoutMs: 60_000 });
  try {
    const task = h.createTask([2]);
    const startMs = h.state.nowMs;
    // Chair assignment in plain prose arms the 3-min (here 60s) no-ACK watch.
    insertGroupMessage(h.db, {
      pinId: 'assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the icon set and report back',
      chainTimestamp: Math.floor(startMs / 1000) - 600,
    });
    await h.loop.runTick(); // assignment processed; worker turn runs the plain path

    // The host posts its long-turn liveness notice AS Coder Bot (the task #64
    // incident shape: posted via postGroupMessage under the member identity).
    insertGroupMessage(h.db, {
      pinId: 'longturn-notice-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[GROUP_TASK_NOTICE:long_turn]\n@chair ℹ️ Coder Bot 的回合已执行超过 18 分钟,期间无新群消息。'
        + '执行看似正常,成员交付前无需回应——仅当明显超出预期时长时再介入。',
      chainTimestamp: Math.floor(startMs / 1000) - 300,
    });
    h.state.nowMs = startMs + 120_000; // past the 60s ACK window
    await h.loop.runTick();

    // Single-commander: the no-ACK fact reaches the chair as an environment
    // NOTE (delivered by the next host-note turn), never as a host ⚠ post.
    const noAckNotes = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'no_ack'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(noAckNotes, 1, 'a host notice under the member name is not member speech — the no-ACK note still fires');
    await h.loop.runTick(); // delivery tick
    const chairReply = h.sends.find((s) => s.metabotId === 1);
    assert.ok(chairReply, 'the chair itself speaks after reading the note');
  } finally {
    h.cleanup();
  }
});

test('task #64: the deferred drain coalesces a worker backlog into one turn (oldest open assignment wins)', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]);
    const msgId = (pinId) =>
      h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', [pinId])[0].values[0][0];

    insertGroupMessage(h.db, {
      pinId: 'assign-2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the icon set by 18:00',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 900,
    });
    insertGroupMessage(h.db, {
      pinId: 'nudge-2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot any progress on the icon set?',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 600,
    });
    insertGroupMessage(h.db, {
      pinId: 'chatter-2-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot fyi the spec changed, see my notes',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 300,
    });
    // Production shape: the whole backlog queued behind a long in-flight turn —
    // the cursor already advanced past every message.
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [msgId('chatter-2-i0'), task.id]);
    const entries = ['assign-2-i0', 'nudge-2-i0', 'chatter-2-i0']
      .map((pinId) => ({
        taskId: task.id,
        metabotId: 2,
        messageId: msgId(pinId),
        reason: 'worker_mentioned',
        verificationNotes: [],
      }))
      .sort((a, b) => a.messageId - b.messageId);
    h.store.set(`group_task_deferred:${task.id}`, JSON.stringify(entries));

    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'one turn answers the whole backlog');
    assert.equal(h.sends.length, 1);
    assert.equal(
      h.sends[0].replyPin,
      'assign-2-i0',
      'the turn is threaded under the oldest still-open chair assignment',
    );
    assert.equal(
      h.store.get(`group_task_deferred:${task.id}`),
      undefined,
      'nothing re-defers — the coalesced backlog is spent',
    );
    assert.ok(
      logs.some((line) => line.includes("coalesced bot 2's queued backlog into message #")),
      'the coalescing decision is logged',
    );
  } finally {
    h.cleanup();
  }
});

test('skill routing: owner message widens to the responding bot\'s full set', async () => {
  const h = await createHarness({
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'boss-skill-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'chair, give me a status summary',
    });
    await h.loop.runTick();

    assert.equal(h.routingCalls.length, 1, 'only the chair responds to the owner message');
    assert.equal(h.routingCalls[0].widened, true, 'owner privilege widens to the bot\'s full set');
    assert.equal(h.skillTurnCalls.length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Review-phase silence, mid-batch flip, and the [NO_REPLY] escape hatch
// ---------------------------------------------------------------------------

test('gating: review phase — workers never respond, chair only answers the owner', () => {
  const reviewTask = gateTask('review');

  // worker @-mentioned in review -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Coder Bot are you sure?' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // chair mentioned -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: '@Twin Bot thanks!' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // floor control (unaddressed) -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ content: 'a general afterthought' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // deliverable -> silent
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: 'gmid-w2', content: '[DELIVERABLE] metaapp: metaapp://pin9' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [],
  );
  // owner message -> chair responds (acceptance dialogue)
  assert.deepEqual(
    decideGroupTaskResponders(
      gateMessage({ senderGlobalMetaId: BOSS_GMID, content: 'not quite — rework this part' }),
      reviewTask, GATE_MEMBERS, GATE_BOTS,
    ),
    [{ metabotId: 1, reason: 'chair_owner_message' }],
  );
});

test('mid-batch [STATUS:REVIEW] flip gates subsequent messages with the new status', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'pre-flip-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot wrap up your part',
    });
    insertGroupMessage(h.db, {
      pinId: 'flip-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'everything is in\n[STATUS:REVIEW]',
    });
    insertGroupMessage(h.db, {
      pinId: 'post-flip-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot one more thing',
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const sends = h.sends.map((s) => [s.metabotId, s.content]);
    assert.deepEqual(
      sends.slice(0, 1),
      [[2, 'reply-for-llm-2']],
      'worker answered the pre-flip mention only; the post-flip mention is gated silent',
    );
    // Single-commander: no closing line and no dispatch-held notice in the
    // group — the held-dispatch fact lands as a host environment note instead.
    assert.equal(sends.length, 1, 'only the pre-flip worker reply hits the group');
    const heldNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'dispatch_held');
    assert.equal(heldNotes.length, 1, 'dispatch-held fact recorded for the chair');
    assert.equal(
      h.chatCalls.filter((c) => c.llmId === 'llm-2').length, 1,
      'no LLM call for the post-flip message (the other call is the owner-report turn)',
    );
    assert.equal(h.ownerReportCalls.length, 1, 'review transition fired the owner report');
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] plain path: suppressed on-chain, session kept, cooldown recorded', async () => {
  const h = await createHarness({ chatReply: '[NO_REPLY]' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nr1-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot thanks!',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'LLM was consulted');
    assert.equal(h.sends.length, 0, 'nothing went on-chain');
    // session continuity: snapshot + user + assistant ([NO_REPLY]) all appended
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping);
    const sessionMessages = h.coworkStore.getSessionMessages(mapping.coworkSessionId);
    assert.deepEqual(sessionMessages.map((m) => m.type), ['user', 'user', 'assistant']);
    assert.equal(sessionMessages[2].content, '[NO_REPLY]');

    // cooldown recorded: an immediate second mention never reaches the LLM
    insertGroupMessage(h.db, {
      pinId: 'nr2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot and this one too',
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'cooldown blocks the immediate follow-up');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] settles the canonical attempt as a no-reply completion, not a failure', async () => {
  const h = await createHarness({ chatReply: '[NO_REPLY]' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nr-attempt-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot thanks!',
    });
    await h.loop.runTick();

    assert.equal(h.sends.length, 0, 'still suppressed on-chain');
    // fix/group-member-status: deliberate silence must NOT leave a failed
    // attempt residual — that failure used to paint the member-rail "出错"
    // badge for the whole error window on a healthy bot.
    const attemptView = h.deps.orchestrationBridge.getWorkerAttemptStatus(task.id, 2);
    assert.equal(attemptView.status, null, 'no failed/running attempt residual after [NO_REPLY]');
    const orchestrationTaskId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    const attempts = h.orchestrationStore.listSteps(orchestrationTaskId)
      .flatMap((step) => h.orchestrationStore.listAttempts(step.id));
    assert.ok(attempts.length > 0, 'a canonical attempt was recorded for the turn');
    assert.ok(
      attempts.every((attempt) => attempt.status === 'completed'),
      'no-reply attempts complete instead of failing',
    );
    assert.ok(
      attempts.every((attempt) => attempt.result?.noReply === true),
      'the completion is marked as a deliberate no-reply',
    );
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] matching: trailing text and case variants suppressed; normal replies unaffected', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    const mentionAndTick = async (pinId) => {
      // Round-4: assignments come from the chair (twin) — the chair self-skips
      // and only the mentioned worker replies.
      insertGroupMessage(h.db, {
        pinId, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
        senderName: 'Twin Bot', content: '@Coder Bot ping',
      });
      await h.loop.runTick();
      h.state.nowMs += 21_000; // step past the worker cooldown for the next case
    };

    h.state.chatReply = '[NO_REPLY] Thanks!';
    await mentionAndTick('v1-i0');
    assert.equal(h.sends.length, 0, 'tag with trailing text is suppressed');

    h.state.chatReply = '[no_reply]';
    await mentionAndTick('v2-i0');
    assert.equal(h.sends.length, 0, 'case-insensitive match');

    h.state.chatReply = 'Here is the actual result.';
    await mentionAndTick('v3-i0');
    assert.equal(h.sends.length, 1, 'normal reply goes on-chain');
    assert.equal(h.sends[0].content, 'Here is the actual result.');

    h.state.chatReply = 'I noted [NO_REPLY] in the log output';
    await mentionAndTick('v4-i0');
    assert.equal(h.sends.length, 2, 'mid-sentence [NO_REPLY] is not treated as a tag');
  } finally {
    h.cleanup();
  }
});

test('[NO_REPLY] also applies on the skill-turn path', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
    skillReply: '[NO_REPLY]',
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nr-skill-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot run a search',
    });
    await h.loop.runTick();

    assert.equal(h.skillTurnCalls.length, 1, 'skill turn ran');
    // Single-commander: no host auto-ACK exists anymore — a [NO_REPLY] turn
    // means the worker chose silence, and nothing posts on its behalf.
    assert.equal(h.chatCalls.length, 0, 'no chat call');
    assert.equal(h.sends.length, 0, 'nothing posted — no auto-ACK, reply suppressed on-chain');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Chair planning turn, chair trust, and roster profiles
// ---------------------------------------------------------------------------

test('chair planning turn: fires once for a new planning task (kv, directive, roster profiles)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();

    assert.deepEqual(h.sends.map((s) => s.metabotId), [1], 'chair posted exactly one plan');
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');

    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'planning fires exactly once');

    const planningCall = h.chatCalls[0];
    assert.equal(planningCall.llmId, 'llm-1');
    assert.match(planningCall.userMessage, /SYSTEM planning directive/);
    assert.match(planningCall.userMessage, /recent group log/);
    assert.match(planningCall.userMessage, /\[STATUS:EXECUTING\]/);
    assert.match(planningCall.systemPrompt, /Roster profiles/);
    assert.match(planningCall.systemPrompt, /Search and code specialist/);

    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 1);
    assert.ok(mapping, 'chair session on the metaweb_group_task channel');
    // fix-v2 (B6): snapshot + directive + chair reply.
    assert.deepEqual(
      h.coworkStore.getSessionMessages(mapping.coworkSessionId).map((m) => m.type),
      ['user', 'user', 'assistant'],
    );
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: dispatch post carries a mention array for the assigned workers (P1-1)', async () => {
  const h = await createHarness({
    // Bare name, no '@' token — the wake-up must come from the mention array.
    chatReply: 'Plan: Coder Bot researches first, then hands off. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.deepEqual(
      h.sends[0].mention,
      ['gmid-w2'],
      'assigned worker globalMetaId rides the mention array even without an @ token',
    );
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: plan addressing nobody carries no mention array', async () => {
  const h = await createHarness({
    chatReply: 'Plan: I draft the outline myself first. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0].mention, undefined);
  } finally {
    h.cleanup();
  }
});

test('resolveMentionIdsForWorkers: maps mentioned worker names to globalMetaIds', () => {
  const { resolveMentionIdsForWorkers } = require('../dist-electron/main/services/groupTaskDaemon.js');
  assert.deepEqual(
    resolveMentionIdsForWorkers(GATE_MEMBERS, ['Coder Bot', 'Designer Bot']),
    ['gmid-w2', 'gmid-w3'],
  );
  // chair names never resolve, unknown names are skipped, case-insensitive
  assert.deepEqual(
    resolveMentionIdsForWorkers(GATE_MEMBERS, ['Twin Bot', 'coder bot', 'Nobody']),
    ['gmid-w2'],
  );
  // members without a globalMetaId cannot be mentioned
  assert.deepEqual(
    resolveMentionIdsForWorkers(
      [{ metabotId: 9, globalmetaid: null, role: 'worker', name: 'Ghost Bot' }],
      ['Ghost Bot'],
    ),
    [],
  );
  assert.deepEqual(resolveMentionIdsForWorkers(GATE_MEMBERS, []), []);
});

test('chair planning turn: not attempted for executing tasks', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
    assert.equal(h.chatCalls.length, 0);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: failures retry up to 3 attempts then give up', async () => {
  const h = await createHarness({ chatErrorAlways: 'llm offline' });
  try {
    const task = h.createTask([2], { activate: false });
    for (let i = 0; i < 5; i++) {
      await h.loop.runTick();
    }
    assert.equal(h.chatCalls.length, 3, 'three attempts, then silent');
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), 3);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: [NO_REPLY] plan counts as a failed attempt', async () => {
  const h = await createHarness({ chatReply: '[NO_REPLY]' });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), 1);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined);
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('chair planning turn: posted plan flips status via [STATUS:EXECUTING] on round-trip', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research first, then hand off. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.match(h.sends[0].content, /\[STATUS:EXECUTING\]/);
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status, 'planning',
      'status flips only when the plan round-trips through the listener',
    );

    insertGroupMessage(h.db, {
      pinId: 'plan-roundtrip-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: h.sends[0].content,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    assert.ok(h.events.some((e) => e.status === 'executing'), 'transition event fired');
  } finally {
    h.cleanup();
  }
});

test('chair trust: worker responding to a chair-sender message gets widened routing', async () => {
  const h = await createHarness({
    routing: () => ({ prompt: '<available_skills>x</available_skills>', activeSkillIds: ['x'] }),
  });
  try {
    h.createTask([2]); // executing; chair is gmid-twin
    insertGroupMessage(h.db, {
      pinId: 'chair-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot research the topic now',
    });
    await h.loop.runTick();

    assert.equal(h.routingCalls.length, 1);
    assert.equal(h.routingCalls[0].widened, true, 'chair assignments unlock the full skill set');
    assert.equal(h.skillTurnCalls.length, 1);
  } finally {
    h.cleanup();
  }
});

test('remote OpenTeam member joins the prompt roster; never produces a local reply', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-remote-alicia',
      displayName: 'Alicia Remote',
      role: 'worker',
      joinedPinId: 'pin-join-alicia',
    });

    // Local worker mentioned by the chair: its prompt roster must
    // include the remote teammate (annotated, exact name), and only the local
    // bot replies (the chair stays silent — it is the sender itself).
    // (Round-4 attribution: a non-member chain identity would be SUSPECT and
    // never trigger replies, so the sender is a task member.)
    insertGroupMessage(h.db, {
      pinId: 'mention-coder-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please start the research',
    });
    await h.loop.runTick();

    const coderCall = h.chatCalls.find((call) => call.llmId === 'llm-2');
    assert.ok(coderCall, 'local worker replied to the mention');
    assert.match(coderCall.systemPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
    assert.match(coderCall.systemPrompt, /profile not available locally/);
    assert.ok(
      h.sends.every((send) => send.metabotId === 2),
      'remote member never generates a local send',
    );

    // A deliverable posted by the remote teammate (from its own machine)
    // still triggers the chair through the normal deliverable path.
    insertGroupMessage(h.db, {
      pinId: 'remote-deliverable-i0', senderMetaId: 'metaid-remote', senderGlobalMetaId: 'gmid-remote-alicia',
      senderName: 'Alicia Remote', content: '[DELIVERABLE] doc: metaapp://abc123',
    });
    await h.loop.runTick();

    const chairCall = h.chatCalls.find((call) => call.llmId === 'llm-1');
    assert.ok(chairCall, 'chair responds to a remote teammate deliverable');
    assert.match(chairCall.systemPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
    assert.match(chairCall.systemPrompt, /OpenTeam remote teammates/);
  } finally {
    h.cleanup();
  }
});

test('prompts: roster profiles include bio/role/goal with the length cap', () => {
  const longBio = `bio-start ${'x'.repeat(500)} bio-end`;
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair', bio: 'Chief of staff', roleProfile: 'Coordinator', goal: 'Ship tasks' },
      { name: 'Coder Bot', role: 'worker', bio: longBio, roleProfile: null, goal: null },
      { name: 'Ghost Bot', role: 'worker' },
    ],
    botRole: 'chair',
  });

  assert.match(prompt, /## Roster profiles/);
  assert.match(prompt, /- Twin Bot \(chair\) — Role: Coordinator; Bio: Chief of staff; Goal: Ship tasks/);
  assert.match(prompt, /- Coder Bot \(worker\) — Bio: bio-start/);
  assert.ok(!prompt.includes('bio-end'), 'bio is capped before its tail');
  assert.ok(!/Ghost Bot \(worker\) —/.test(prompt), 'profile-less member gets no profile line');

  const bioLine = prompt.split('\n').find((line) => line.startsWith('- Coder Bot (worker) — Bio:'));
  const renderedBio = bioLine.replace('- Coder Bot (worker) — Bio: ', '');
  assert.ok(renderedBio.length <= 200, `bio capped at 200 chars (got ${renderedBio.length})`);
});

test('prompts: remote OpenTeam teammate annotated in roster, profiles, and playbooks', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker', bio: 'Search and code specialist' },
    { name: 'Alicia Remote', role: 'worker', remote: true },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });

  // Roster annotation keeps the exact name intact for @-mention matching.
  assert.match(chairPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
  assert.match(chairPrompt, /- Alicia Remote \(worker\) — external teammate via OpenTeam; profile not available locally/);
  assert.match(chairPrompt, /OpenTeam remote teammates \(marked "remote teammate via OpenTeam" in the roster\) are external collaborators/);
  assert.match(chairPrompt, /Welcome them as you would a new colleague/);
  assert.match(chairPrompt, /Their replies come from their own machine and may arrive late or not at all/);
  assert.match(chairPrompt, /re-assign the work and explain the change to the owner/);
  // M2: capability-gap assessment and remote-search discipline rules.
  assert.match(chairPrompt, /Capability check is match-first: pick the seated specialist whose profile and impressions fit the step/);
  assert.match(chairPrompt, /recommend a remote OpenTeam recruit to the owner/);
  assert.match(chairPrompt, /One candidate at a time, best bio\/chatSkills\/on-chain fit first/);
  assert.match(chairPrompt, /has not joined after ~10 minutes, treat it as no deal/);
  assert.match(chairPrompt, /Never @-assign work to an invitee before it appears in the roster/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.match(workerPrompt, /^- Alicia Remote \(worker, remote teammate via OpenTeam\)$/m);
  assert.match(workerPrompt, /treat them as equal teammates and be polite/);
  assert.ok(!workerPrompt.includes('OpenTeam remote teammates (marked'), 'chair-only etiquette stays out of the worker playbook');
  assert.ok(!workerPrompt.includes('Capability check before recruiting'), 'chair-only recruiting rules stay out of the worker playbook');
});

test('prompts: chair playbook gates member kicks behind explicit owner confirmation', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });
  // R3: a chat-initiated kick must be restated and explicitly confirmed by the
  // owner first; the Tasks-UI modal already counts as that confirmation.
  assert.match(chairPrompt, /Removing a member \(kick\) is owner-confirmed, never casual/);
  assert.match(chairPrompt, /explicit confirmation in the same conversation/);
  assert.match(chairPrompt, /Tasks-UI modal already IS the owner's confirmation/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.ok(!workerPrompt.includes('Removing a member (kick)'), 'kick governance stays out of the worker playbook');
});

test('prompts: chair playbook carries lifecycle-autonomy and user-language rules (R5)', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'chair',
  });
  // R5: the chair drives the lifecycle itself and speaks user language.
  assert.match(chairPrompt, /Lifecycle autonomy: you drive the task through its states/);
  assert.match(chairPrompt, /awaits their acceptance in the Tasks UI/);
  assert.match(chairPrompt, /NEVER sit in executing asking the owner "what next\?"/);
  assert.match(chairPrompt, /User language: refer to the task by its title, never by `#id`/);
  assert.match(chairPrompt, /Lead every report with the conclusion/);
  assert.match(chairPrompt, /OWNER LANGUAGE is Chinese \(Simplified\)/);

  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
  });
  assert.ok(!workerPrompt.includes('Lifecycle autonomy'), 'lifecycle ownership stays out of the worker playbook');
  assert.ok(!workerPrompt.includes('User language: refer to the task by its title'), 'user-language rule stays out of the worker playbook');
});

test('prompts: English owner language uses English WORKING/STANDBY examples and no CJK', () => {
  const members = [
    { name: 'Twin Bot', role: 'chair' },
    { name: 'Coder Bot', role: 'worker' },
  ];
  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G' },
    members,
    botRole: 'worker',
    language: 'en',
  });
  assert.match(workerPrompt, /OWNER LANGUAGE is English/);
  assert.match(workerPrompt, /\[WORKING\] On it: X, ETA N min/);
  assert.match(workerPrompt, /\[STANDBY\] observing \/ on standby \/ can exit/);
  assert.equal(/[\u4e00-\u9fff]/.test(workerPrompt), false);
});

// ---------------------------------------------------------------------------
// Worldview/time/experience prompts, deliverable verification, owner report
// ---------------------------------------------------------------------------

test('prompts: task #65 — the current group id is listed and mid-turn speech is taught', () => {
  const groupId = `${'4f'.repeat(32)}i0`;
  const workerPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G', groupId },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'worker',
  });
  assert.match(workerPrompt, new RegExp(`- Current group id: \`${groupId}\``));
  assert.match(workerPrompt, /pass EXACTLY this value as `group_id`/);
  assert.match(workerPrompt, /a bare number like 65 is the task number, never a group id/);
  assert.match(workerPrompt, /MID-TURN GROUP MESSAGES/);
  assert.match(workerPrompt, /mid-turn `\[DELIVERABLE\]` lines are recorded on the task ledger exactly like turn replies/);

  const chairPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G', groupId },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'chair',
  });
  assert.match(chairPrompt, /ONE VOICE PER TURN/);
  assert.match(chairPrompt, /never repeat the same content as the turn's final reply/);
  // Task #83 audit (P5): the chair playbook carries the verdict-snapshot
  // discipline (rule on a freshly measured HEAD, no same-evidence reversals).
  assert.match(chairPrompt, /VERDICT SNAPSHOT DISCIPLINE/);
  assert.match(chairPrompt, /never rule from a stale snapshot or from memory/);

  // No group id on the task row → the line is omitted, nothing misleading.
  const noIdPrompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Coder Bot' },
    task: { title: 'T', goal: 'G', groupId: null },
    members: [{ name: 'Twin Bot', role: 'chair' }, { name: 'Coder Bot', role: 'worker' }],
    botRole: 'worker',
  });
  assert.doesNotMatch(noIdPrompt, /Current group id:/);
});

test('prompts: worldview block, time line, honesty and chair boundary', () => {
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'chair',
    ownerGlobalMetaId: 'gmid-boss',
    currentTimeText: 'Current time: 2026-08-04 23:52 (UTC+8, Asia/Shanghai); today is Tuesday, August 4, 2026.',
    experienceBlock: '<self_identity>I am the twin.</self_identity>',
  });

  assert.match(prompt, /## Group task environment/);
  assert.match(prompt, /OWNER \(a human, globalMetaId `gmid-boss`\)/);
  assert.match(prompt, /Twin Bot \(the owner's digital twin\) chairs the group/);
  assert.match(prompt, /a pinid is exactly 64 lowercase hex chars \+ `i0`/);
  assert.match(prompt, /\/protocols\/simplebuzz/);
  assert.match(prompt, /Current time: 2026-08-04 23:52 \(UTC\+8, Asia\/Shanghai\); today is Tuesday, August 4, 2026\./);
  assert.match(prompt, /NEVER fabricate results, pinids, txids/);
  assert.match(prompt, /honest failure is acceptable, a fabricated success is a critical fault/);
  assert.match(prompt, /you NEVER execute task work yourself/);
  assert.match(prompt, /VERIFY it \(format, plausibility, any daemon verification notes/);
  assert.match(prompt, /<self_identity>I am the twin\.<\/self_identity>/);
});

test('turn prompts keep the system prompt stable and put the fresh current-time line in the user message', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'time-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot hi',
    });
    await h.loop.runTick();

    const date = new Date(h.state.nowMs);
    const pad = (v) => String(v).padStart(2, '0');
    const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    // Cache-prefix discipline: the minute-precision time line must NEVER sit in
    // the system prompt (it would change every turn and reset the SDK session);
    // it rides the user message instead.
    assert.ok(
      !h.chatCalls[0].systemPrompt.includes('Current time:'),
      'system prompt must not carry the per-turn time line',
    );
    assert.ok(
      h.chatCalls[0].userMessage.includes(`Current time: ${local} (`),
      `user message carries the injected-now local time (expected prefix "Current time: ${local} (")`,
    );
    assert.match(h.chatCalls[0].userMessage, /today is \w+day, /);
    assert.match(h.chatCalls[0].systemPrompt, /## Group task environment/);
  } finally {
    h.cleanup();
  }
});

test('experience block: memory/dream deps feed the A2A builder; absent deps omit it', async () => {
  const withMemory = await createHarness({
    listUserMemories: (metabotId, input) =>
      input.usageClass === 'self_identity' ? [{ text: 'I am the search specialist.' }] : [],
    listDailySummaries: () => [{ summaryDate: '2026-08-03', summaryText: 'Searched the web for the owner.' }],
  });
  try {
    withMemory.createTask([2]);
    insertGroupMessage(withMemory.db, {
      pinId: 'mem-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await withMemory.loop.runTick();
    assert.match(withMemory.chatCalls[0].userMessage, /I am the search specialist\./);
    assert.match(withMemory.chatCalls[0].userMessage, /Searched the web for the owner\./);
    assert.ok(!withMemory.chatCalls[0].systemPrompt.includes('I am the search specialist.'),
      'experience block must not sit in the system prompt (volatile, cache-prefix breaker)');
  } finally {
    withMemory.cleanup();
  }

  const withoutMemory = await createHarness();
  try {
    withoutMemory.createTask([2]);
    insertGroupMessage(withoutMemory.db, {
      pinId: 'nomem-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await withoutMemory.loop.runTick();
    assert.ok(!withoutMemory.chatCalls[0].systemPrompt.includes('self_identity'));
  } finally {
    withoutMemory.cleanup();
  }
});

test('group experience block: section trimming replaces the 1500 tail cut, self-identity always whole', () => {
  const identityText = `IDENTITY-${'x'.repeat(100)}`;
  const summaries = Array.from({ length: 3 }, (_, index) => ({
    summaryDate: `2026-08-0${index + 1}`,
    summaryText: `day-${index} ${'s'.repeat(300)} tail-marker-${index}`,
  }));
  const valueBoundaries = Array.from({ length: 5 }, (_, index) => ({ text: `boundary-${index}` }));
  const workReviews = Array.from({ length: 5 }, (_, index) => ({ text: `review-${index}` }));

  // ~3150 chars of content: the old 1500 tail cut would amputate everything
  // after the identity block; the ladder keeps every section under the 4000 cap.
  const full = buildGroupTaskExperienceBlock({ identityText, valueBoundaries, workReviews, summaries });
  assert.ok(full.length > 1500, 'no longer hard-capped at 1500');
  assert.ok(full.length <= 4000, 'bounded by the raised cap');
  assert.ok(full.includes(identityText), 'identity survives whole');
  assert.ok(full.includes('tail-marker-2'), 'the last diary day is not tail-amputated');
  assert.ok(full.includes('boundary-0'), 'boundaries survive');

  // Over the cap: daily summaries shrink first, boundaries last.
  const over = buildGroupTaskExperienceBlock({
    identityText,
    valueBoundaries,
    workReviews,
    // One oversized day always renders whole in the summaries block (builder
    // contract), so the only way under the cap is dropping the section.
    summaries: [{ summaryDate: '2026-08-01', summaryText: 's'.repeat(6000) }],
    maxChars: 2500,
  });
  assert.ok(over.length <= 2500, 'over-cap input comes back under the cap');
  assert.ok(over.includes(identityText), 'identity still whole over budget');
  assert.ok(!over.includes('<recent_daily_summaries>'), 'summaries are the first section dropped');
  assert.ok(over.includes('boundary-0'), 'boundaries are the last section standing');
});

test('authoritative constraints block renders the [POSITION] ledger, newest lines survive the budget', () => {
  assert.equal(buildGroupTaskConstraintsBlock([]), '');

  const block = buildGroupTaskConstraintsBlock([
    { statement: 'UI 必须先过设计评审' },
    { statement: '周五才允许发布' },
  ]);
  assert.match(block, /\[Authoritative constraints \(host ledger\)/);
  assert.match(block, /UI 必须先过设计评审/);
  assert.match(block, /周五才允许发布/);

  const over = buildGroupTaskConstraintsBlock(
    Array.from({ length: 10 }, (_, index) => ({ statement: `constraint-${index} ${'x'.repeat(400)}` })),
    1200,
  );
  assert.ok(over.length <= 1200, 'bounded by the block cap');
  assert.ok(over.includes('constraint-9'), 'newest line survives');
  assert.ok(!over.includes('constraint-0 '), 'oldest lines drop first');
  assert.match(over, /oldest line\(s\) omitted/);
});

test('scoped owner memories inject into plain-path group turns, skip the skill path, and respect memoryEnabled (G8)', async () => {
  const memoryEntries = [
    { text: 'The owner prefers weekly Friday releases', usageClass: 'preference', visibility: 'local_only', updatedAt: 100, lastUsedAt: null, importance: 0.9 },
    { text: 'I am the twin.', usageClass: 'self_identity', visibility: 'local_only', updatedAt: 90, lastUsedAt: null, importance: 1.0 },
  ];
  const memoryDep = (metabotId, input) => {
    if (input.usageClass === 'self_identity') return memoryEntries.filter((entry) => entry.usageClass === 'self_identity');
    if (input.usageClass) return [];
    return memoryEntries;
  };

  // Plain path (no routing hit): the scoped block rides the user turn.
  const plain = await createHarness({ listUserMemories: memoryDep });
  try {
    plain.createTask([2]);
    insertGroupMessage(plain.db, {
      pinId: 'scope-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await plain.loop.runTick();
    const userMessage = plain.chatCalls[0].userMessage;
    assert.match(userMessage, /<ownerMemories>/);
    assert.match(userMessage, /weekly Friday releases/);
    const memoryBlock = userMessage.slice(userMessage.indexOf('<ownerMemories>'), userMessage.indexOf('</ownerMemories>'));
    assert.ok(!memoryBlock.includes('I am the twin.'), 'experience-owned classes never double into the scoped block');
  } finally {
    plain.cleanup();
  }

  // Skill path: coworkRunner injects its own scoped memory blocks, so the
  // daemon-side block must NOT duplicate into the skill turn's user message.
  const skill = await createHarness({
    listUserMemories: memoryDep,
    routing: { prompt: 'skill routing prompt', activeSkillIds: ['skill-x'] },
  });
  try {
    skill.createTask([2]);
    insertGroupMessage(skill.db, {
      pinId: 'scope-skill-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await skill.loop.runTick();
    assert.ok(skill.skillTurnCalls.length >= 1, 'routing hit runs the skill turn');
    for (const call of skill.skillTurnCalls) {
      assert.ok(!call.userMessage.includes('<ownerMemories>'), 'no double injection on the skill path');
    }
    assert.equal(skill.chatCalls.length, 0, 'plain completion never ran');
  } finally {
    skill.cleanup();
  }

  // G8: memoryEnabled=false gates the block out (parity with private chat).
  const gated = await createHarness({
    listUserMemories: memoryDep,
    deps: { getEffectiveMemoryPolicy: () => ({ memoryEnabled: false, memoryUserMemoriesMaxItems: 30 }) },
  });
  try {
    gated.createTask([2]);
    insertGroupMessage(gated.db, {
      pinId: 'scope-off-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await gated.loop.runTick();
    assert.ok(!gated.chatCalls[0].userMessage.includes('<ownerMemories>'), 'memoryEnabled=false omits the scoped block');
    assert.ok(!gated.chatCalls[0].userMessage.includes('weekly Friday releases'));
  } finally {
    gated.cleanup();
  }
});

test('chair [POSITION] constraints reach every turn via the authoritative block, long after leaving the message window', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // A ruling recorded on the ledger rounds ago — never a recent group message.
    h.groupTaskStore.addPosition({
      taskId: task.id,
      msgPinId: 'pos-pin-1',
      authorGlobalmetaid: 'gmid-twin',
      statement: '永远先出设计稿再写代码',
      lineNo: 1,
    });
    insertGroupMessage(h.db, {
      pinId: 'late-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();
    const userMessage = h.chatCalls[0].userMessage;
    assert.match(userMessage, /\[Authoritative constraints \(host ledger\)/);
    assert.match(userMessage, /永远先出设计稿再写代码/);
    const logSection = userMessage.slice(userMessage.indexOf('recent group log'));
    assert.ok(
      !logSection.includes('永远先出设计稿再写代码'),
      'the ruling is NOT in the recent-log window — only the authoritative block carries it',
    );
  } finally {
    h.cleanup();
  }
});

test('validated drafts rendered into the group experience block bump their injection counters', async () => {
  const marked = [];
  const h = await createHarness({
    listUserMemories: () => [],
    listDailySummaries: () => [{ summaryDate: '2026-08-03', summaryText: 'Worked on the MetaApp.' }],
    deps: {
      listValidatedCapabilityDrafts: () => [{ id: 42, title: '先验证再交付', description: '交付前自检' }],
      markCapabilityDraftsInjected: (ids) => marked.push(...ids),
    },
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'draft-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();
    assert.match(h.chatCalls[0].userMessage, /<proven_techniques>/, 'the draft rendered into the prompt');
    // Each responding turn (chair floor-control + mentioned worker) reports
    // the ids of the drafts its own prompt actually rendered.
    assert.ok(marked.length >= 1, 'at least one turn reported rendered drafts');
    assert.ok(marked.every((id) => id === 42), 'only the actually rendered draft id is reported');
  } finally {
    h.cleanup();
  }
});

test('group cognition projection is observer-relative and wired into per-bot prompts', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return [
        '<metaid_group_cognition>',
        `Observer: ${input.observerGlobalMetaID}`,
        ...input.roster.map((member) => `- ${member.name} ${member.globalMetaID} (${member.role})`),
        '</metaid_group_cognition>',
      ].join('\n');
    },
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'cog-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await h.loop.runTick();

    const workerCall = h.chatCalls.find((call) => call.llmId === 'llm-2');
    assert.ok(workerCall, 'worker replied');
    assert.match(workerCall.userMessage, /<metaid_group_cognition>/);
    assert.match(workerCall.userMessage, /Observer: gmid-w2/);
    assert.match(workerCall.userMessage, /- Twin Bot gmid-twin \(chair\)/);
    assert.doesNotMatch(workerCall.userMessage, /- Coder Bot gmid-w2 \(worker\)/,
      'entropy P1: worker cognition is chair-only');
    assert.ok(!workerCall.systemPrompt.includes('<metaid_group_cognition>'),
      'cognition block must not sit in the system prompt (volatile, cache-prefix breaker)');

    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput, 'cognition dep called for the responding worker');
    // Entropy P1: workers get a chair-only cognition roster (narrow specific
    // heat); the full roster stays reserved for the chair's arbitration view.
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID),
      ['gmid-twin'],
    );
  } finally {
    h.cleanup();
  }
});

test('group cognition projection failure or absence omits the block without blocking the turn', async () => {
  const logMessages = [];
  const failing = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async () => {
      throw new Error('cognition service down');
    },
    emitLog: (message) => {
      logMessages.push(message);
    },
  });
  try {
    failing.createTask([2]);
    insertGroupMessage(failing.db, {
      pinId: 'cogfail-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await failing.loop.runTick();
    assert.equal(failing.sends.length, 1, 'reply still delivered');
    assert.ok(!failing.chatCalls[0].systemPrompt.includes('metaid_group_cognition'));
    assert.ok(
      logMessages.some((message) => message.includes('MetaID group cognition projection unavailable for bot 2')),
      'failure emits a bounded diagnostic without private content',
    );
  } finally {
    failing.cleanup();
  }

  const absent = await createHarness();
  try {
    absent.createTask([2]);
    insertGroupMessage(absent.db, {
      pinId: 'cogabsent-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot go',
    });
    await absent.loop.runTick();
    assert.equal(absent.sends.length, 1, 'reply still delivered');
    assert.ok(!absent.chatCalls[0].systemPrompt.includes('metaid_group_cognition'));
  } finally {
    absent.cleanup();
  }
});

test('deliverable verification: fabricated pinid warns the chair in context', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'fake-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] buzz posted: 0x8f3a2b1c done!',
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'chair triggered by the deliverable');
    assert.equal(h.chatCalls[0].llmId, 'llm-1');
    assert.match(
      h.chatCalls[0].userMessage,
      /⚠ Host verification: reported pinid "0x8f3a2b1c" FAILS format validation/,
    );
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'row still recorded');
  } finally {
    h.cleanup();
  }
});

test('deliverable verification: uppercase hex candidate fails format', async () => {
  const UPPER = 'ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789';
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'up-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metafile://${UPPER}i0`,
    });
    await h.loop.runTick();
    assert.match(h.chatCalls[0].userMessage, /FAILS format validation/);
  } finally {
    h.cleanup();
  }
});

test('deliverable verification: valid pinid reports found / not-found / unavailable', async () => {
  const VALID = `${'a'.repeat(64)}i0`;
  const runCase = async (pinOutcomes) => {
    const h = await createHarness({ pinOutcomes });
    try {
      h.createTask([2]);
      insertGroupMessage(h.db, {
        pinId: 'v-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
        senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${VALID}`,
      });
      await h.loop.runTick();
      return h.chatCalls[0].userMessage;
    } finally {
      h.cleanup();
    }
  };

  assert.match(await runCase({ [VALID]: 'found' }), /✓ Host verification: pinid format valid; pin found on-chain/);
  assert.match(await runCase({ [VALID]: 'not_found' }), /⚠ Host verification: pinid format valid but pin NOT found on-chain/);
  assert.match(await runCase({}), /… Host verification: pinid format valid; on-chain check unavailable/);
});

test('owner report: review transition sends exactly one private report to the boss', async () => {
  const h = await createHarness({ chatReply: 'Report: goal met, deliverables verified.' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'd-rep-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${'b'.repeat(64)}i0`,
    });
    insertGroupMessage(h.db, {
      pinId: 'rev-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'all done\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'exactly one private report');
    assert.equal(h.ownerReportCalls[0].metabotId, 1, 'from the chair bot');
    assert.equal(h.ownerReportCalls[0].taskId, task.id, 'delivery is tied to the task');
    assert.equal(h.ownerReportCalls[0].ownerGlobalMetaId, BOSS_GMID, 'to the owner');
    assert.match(h.ownerReportCalls[0].text, /Report: goal met, deliverables verified\./);

    const reportCall = h.chatCalls.find((c) => /owner-report directive/.test(c.userMessage));
    assert.ok(reportCall, 'report turn used the owner-report directive');
    assert.match(reportCall.userMessage, /Goal: Build and publish the intro MetaApp/);
    assert.match(reportCall.userMessage, /metaapp:\/\//);

    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1', 'guard set');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: 'owner-report-pin-1',
        sessionId: 'owner-report-session-1',
        displayError: null,
        at: h.state.nowMs,
      },
      'renderer receives the successful delivery and A2A session result',
    );
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'no duplicate on the next tick');

    // the report never goes through the group send fn; single-commander: the
    // only chair-identity send is the chair's own deliverable-ack turn — the
    // host posts no review-entry closing line anymore
    assert.deepEqual(
      h.sends.map((s) => s.metabotId),
      [1],
      'only the chair deliverable ack hits the group; no host closing line',
    );
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 1);
    const sessionText = h.coworkStore.getSessionMessages(mapping.coworkSessionId).map((m) => m.content).join('\n');
    assert.match(sessionText, /\[Private report sent to the owner/);
  } finally {
    h.cleanup();
  }
});

test('owner report: rework hatch clears the guard and the next review reports again', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const chairMsg = (pinId, content) => insertGroupMessage(h.db, {
      pinId, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content,
    });

    chairMsg('rw1-i0', 'done\n[STATUS:REVIEW]');
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1);

    // Improvement #2 (v1.3): the re-review must land past the review re-entry
    // debounce window — a [STATUS:REVIEW] within 30s of the rework hatch is a
    // stale in-flight verdict and is deliberately skipped.
    chairMsg('rw2-i0', 'rework needed\n[STATUS:EXECUTING]');
    await h.loop.runTick();
    h.state.nowMs += 31_000;
    chairMsg('rw3-i0', 'done for real\n[STATUS:REVIEW]');
    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 2, 're-review after rework reports again');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

test('owner report: A2A display failure is reported without retrying the on-chain send', async () => {
  const h = await createHarness({
    ownerReportResult: {
      pinId: 'owner-report-pin-display-failed',
      sessionId: null,
      displayError: 'cowork session unavailable',
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rdf1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'done\n[STATUS:REVIEW]',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'the report was sent once');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), '1', 'send guard is set');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'sent',
        pinId: 'owner-report-pin-display-failed',
        sessionId: null,
        displayError: 'cowork session unavailable',
        at: h.state.nowMs,
      },
    );

    await h.loop.runTick();
    assert.equal(h.ownerReportCalls.length, 1, 'display failure does not resend the on-chain report');
  } finally {
    h.cleanup();
  }
});

test('owner report: send failure is logged and does not block the tick', async () => {
  const h = await createHarness({ ownerReportFails: true });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'rf1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'done\n[STATUS:REVIEW]',
    });
    insertGroupMessage(h.db, {
      pinId: 'rf2-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-boss',
      senderName: 'Human', content: 'unrelated chatter',
    });
    await h.loop.runTick();

    assert.equal(h.ownerReportCalls.length, 1, 'send was attempted');
    assert.equal(h.store.get(`group_task_owner_reported:${task.id}`), undefined, 'guard not set on failure');
    assert.deepEqual(
      h.events.find((event) => event.type === 'groupTask:ownerReportDelivery'),
      {
        type: 'groupTask:ownerReportDelivery',
        taskId: task.id,
        outcome: 'failed',
        error: 'owner chat public key unavailable',
        at: h.state.nowMs,
      },
      'renderer receives the real delivery failure reason',
    );
    const afterId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['rf2-i0'])[0].values[0][0];
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, afterId,
      'tick processed the rest of the batch despite the send failure',
    );
  } finally {
    h.cleanup();
  }
});

test('P1-4: chair messages and placeholder URIs never become deliverables', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);

    // chair message quoting the planning example -> NOT collected
    insertGroupMessage(h.db, {
      pinId: 'chair-example-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '[DELIVERABLE] example format: metaapp://<pinId> or metaapp://[PINID]',
    });
    // worker message with a placeholder URI -> NOT collected
    insertGroupMessage(h.db, {
      pinId: 'worker-placeholder-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp://<pinId>',
    });
    // worker message with a real URI -> collected
    insertGroupMessage(h.db, {
      pinId: 'worker-real-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'only the real worker deliverable is recorded');
    assert.equal(rows[0].msgPinId, 'worker-real-i0');
    assert.equal(rows[0].uri, 'metaapp://ababababababababababababababababababababababababababababababababi0');
  } finally {
    h.cleanup();
  }
});

test('P2-7: chair auto response is suppressed when the Twin already replied to that message', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // Lucy delivers; the Twin (chair) ALREADY replied on-chain to that pin
    insertGroupMessage(h.db, {
      pinId: 'deliver-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });
    insertGroupMessage(h.db, {
      pinId: 'chair-reply-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'thanks, verifying now', replyPin: 'deliver-i0',
    });
    await h.loop.runTick();

    // The chair must NOT auto-respond to the deliverable (Twin already spoke).
    // The worker mention is absent, so no worker replies either.
    assert.equal(h.sends.length, 0, 'no duplicate chair auto response');
    // but the deliverable is still recorded from the worker message
    const taskId = h.groupTaskStore.listTasks()[0].id;
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P1-4 line-scoped [DELIVERABLE] parsing (new obs. 3)
// ---------------------------------------------------------------------------

test('P1-4 r2: [DELIVERABLE] parsing is line-scoped — body dir paths and truncated URIs never pollute', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const summary = (row) => ({ kind: row.kind, uri: row.uri });

    // Case ① (doc msg83): the tag line carries no URI; the BODY mentions a
    // `metaapp/` directory path. Must be a text deliverable (uri null),
    // never kind=metaapp.
    insertGroupMessage(h.db, {
      pinId: 'r2-msg83-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '门户 MetaApp 页面已完成，本地目录 metaapp/agent-daily-portal 验收通过。\n[DELIVERABLE] ② 门户 MetaApp 页面（已开发+本地验收通过）',
    });

    // Case ② (doc msg85): a truncated `metafile://…zip（50KB，5 文件）` in the
    // body must NOT win; the real metaapp:// URI on the tag line is collected
    // and the kind follows that line's scheme.
    insertGroupMessage(h.db, {
      pinId: 'r2-msg85-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '完成：源码已打包，content=metafile://…zip（50KB，5 文件）请查收。\n[DELIVERABLE] ④ metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
    });

    // Full-width paren annotation AFTER the URI on the tag line: the URI is
    // trimmed at the paren; the deliverable is recorded with the clean URI.
    insertGroupMessage(h.db, {
      pinId: 'r2-paren-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] ⑤ 海报 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0（1.2MB，5 文件）',
    });

    // Tag line whose ONLY URI is truncated garbage: rejected as a placeholder
    // (planning-style example, not a deliverable).
    insertGroupMessage(h.db, {
      pinId: 'r2-trunc-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] 示例：metafile://…zip（50KB，5 文件）',
    });
    await h.loop.runTick();

    const rows = h.groupTaskStore.listDeliverables(task.id);
    const byPin = (pinId) => rows.find((r) => r.msgPinId === pinId);
    assert.equal(rows.length, 3, 'only the three real deliverables are recorded');

    assert.deepEqual(
      summary(byPin('r2-msg83-i0')),
      { kind: 'text', uri: null },
      'body `metaapp/` dir path must not misjudge the kind (was kind=metaapp, uri=null)',
    );
    assert.deepEqual(
      summary(byPin('r2-msg85-i0')),
      { kind: 'metaapp', uri: 'metaapp://ababababababababababababababababababababababababababababababababi0' },
      'body ellipsis URI ignored; the tag-line metaapp:// URI is collected (was lost entirely)',
    );
    assert.deepEqual(
      summary(byPin('r2-paren-i0')),
      { kind: 'metafile', uri: 'metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0' },
      'full-width paren annotation trimmed from the URI',
    );
    assert.equal(byPin('r2-trunc-i0'), undefined, 'truncated-only tag line is rejected as a placeholder');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Local-file deliverable upgrade: text documents publish as simplenote notes
// (pin://), binaries stay metafile (MetaWeb URI convention)
// ---------------------------------------------------------------------------

test('local deliverable upgrade: .md publishes as a simplenote note (pin://), .png stays metafile', async () => {
  const NOTE_PINID = `${'ab'.repeat(32)}i0`;
  const FILE_PINID = `${'cd'.repeat(32)}i0`;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deliverable-'));
  const publishCalls = [];
  const uploadCalls = [];
  const h = await createHarness({
    deps: {
      publishTextDeliverable: async (input) => {
        publishCalls.push(input);
        return { pinId: NOTE_PINID };
      },
      uploadDeliverableFile: async (input) => {
        uploadCalls.push(input);
        return { pinId: FILE_PINID };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    const mdPath = path.join(artifactDir, 'report.md');
    const pngPath = path.join(artifactDir, 'chart.png');
    fs.writeFileSync(mdPath, '# Report\n\nDone.');
    fs.writeFileSync(pngPath, 'png-bytes');

    insertGroupMessage(h.db, {
      pinId: 'note-dlv-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] 报告：${mdPath}`,
    });
    insertGroupMessage(h.db, {
      pinId: 'file-dlv-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] 图表：${pngPath}`,
    });
    await h.loop.runTick();

    assert.equal(publishCalls.length, 1, 'text document goes through the simplenote seam');
    assert.equal(publishCalls[0].filePath, mdPath);
    assert.equal(uploadCalls.length, 1, 'binary file stays on the metafile seam');
    assert.equal(uploadCalls[0].filePath, pngPath);

    const rows = h.groupTaskStore.listDeliverables(task.id);
    const byPin = (pinId) => rows.find((r) => r.msgPinId === pinId);
    assert.deepEqual(
      { kind: byPin('note-dlv-i0').kind, uri: byPin('note-dlv-i0').uri },
      { kind: 'pinid', uri: `pin://${NOTE_PINID}` },
      'Markdown deliverable is recorded as pin://, never metafile://',
    );
    assert.deepEqual(
      { kind: byPin('file-dlv-i0').kind, uri: byPin('file-dlv-i0').uri },
      { kind: 'metafile', uri: `metafile://${FILE_PINID}.png` },
      'binary deliverable keeps the metafile:// URI',
    );
  } finally {
    h.cleanup();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('local deliverable upgrade: without the note seam a .md still falls back to metafile', async () => {
  const FILE_PINID = `${'cd'.repeat(32)}i0`;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deliverable-'));
  const uploadCalls = [];
  const h = await createHarness({
    deps: {
      uploadDeliverableFile: async (input) => {
        uploadCalls.push(input);
        return { pinId: FILE_PINID };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    const mdPath = path.join(artifactDir, 'report.md');
    fs.writeFileSync(mdPath, '# Report\n\nDone.');
    insertGroupMessage(h.db, {
      pinId: 'note-fallback-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] 报告：${mdPath}`,
    });
    await h.loop.runTick();

    assert.equal(uploadCalls.length, 1);
    const row = h.groupTaskStore.listDeliverables(task.id).find((r) => r.msgPinId === 'note-fallback-i0');
    assert.deepEqual(
      { kind: row.kind, uri: row.uri },
      { kind: 'metafile', uri: `metafile://${FILE_PINID}.md` },
      'unwired publishTextDeliverable keeps the legacy metafile behavior',
    );
  } finally {
    h.cleanup();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

test('local deliverable upgrade: a note publish without pinId falls back to metafile', async () => {
  const FILE_PINID = `${'cd'.repeat(32)}i0`;
  const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-deliverable-'));
  const publishCalls = [];
  const uploadCalls = [];
  const h = await createHarness({
    deps: {
      publishTextDeliverable: async (input) => {
        publishCalls.push(input);
        return null; // oversized/unreadable document — no note pin
      },
      uploadDeliverableFile: async (input) => {
        uploadCalls.push(input);
        return { pinId: FILE_PINID };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    const mdPath = path.join(artifactDir, 'big-report.md');
    fs.writeFileSync(mdPath, '# Big report');
    insertGroupMessage(h.db, {
      pinId: 'note-null-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] 报告：${mdPath}`,
    });
    await h.loop.runTick();

    assert.equal(publishCalls.length, 1);
    assert.equal(uploadCalls.length, 1, 'null note result falls back to the metafile upload');
    const row = h.groupTaskStore.listDeliverables(task.id).find((r) => r.msgPinId === 'note-null-i0');
    assert.deepEqual(
      { kind: row.kind, uri: row.uri },
      { kind: 'metafile', uri: `metafile://${FILE_PINID}.md` },
    );
  } finally {
    h.cleanup();
    fs.rmSync(artifactDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P1-5 planning-directive distribution + opt-out (obs. 1/5)
// ---------------------------------------------------------------------------

test('P1-5 r2: planning directive assigns each seated specialist their own coarse seat', async () => {
  const h = await createHarness();
  try {
    h.createTask([2, 3], { activate: false }); // planning; two workers on the roster
    await h.loop.runTick();
    const planningCall = h.chatCalls[0];
    assert.match(
      planningCall.userMessage,
      /Assign each seated specialist their own coarse seat/,
      'directive plans against the hired seats instead of spreading work to fill the roster',
    );
    assert.match(planningCall.userMessage, /do not invent extra work to occupy unused names/);
    assert.match(planningCall.userMessage, /Research is a basic capability of every seat/);
  } finally {
    h.cleanup();
  }
});

test('P1-5 r2: planning directive with a single worker assigns that seat to that member', async () => {
  const h = await createHarness();
  try {
    h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.match(
      h.chatCalls[0].userMessage,
      /single worker on the roster — assign that seat's work to that one member/,
    );
  } finally {
    h.cleanup();
  }
});

test('P1-5 r2: disableChairPlanningTurn opts out of the auto planning turn (Twin leads the kickoff)', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no auto plan posted');
    assert.equal(h.chatCalls.length, 0, 'no LLM planning call');
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'task marked as host-planned');

    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'guard stays quiet on later ticks');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-2 iteration: P2-7 windowed Twin-activity suppression (new obs. 4)
// ---------------------------------------------------------------------------

test('P2-7 r2: Twin speech in the window suppresses chair auto replies (incl. replies without reply_pin)', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // The Twin speaks proactively (no reply_pin) at chain second 1_000_000_000.
    insertGroupMessage(h.db, {
      pinId: 'twin-active-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，这个任务我来主导，按计划推进。', chainTimestamp: 1_000_000_000,
    });
    // A worker deliverable arrives 5s later — the daemon auto verify must be
    // suppressed while the Twin is actively speaking.
    insertGroupMessage(h.db, {
      pinId: 'dlv-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0', chainTimestamp: 1_000_000_005,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no daemon chair auto reply while the Twin is speaking');
    let taskId = h.groupTaskStore.listTasks()[0].id;
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 1, 'deliverable row still recorded');

    // The Twin replies to the NEXT deliverable WITHOUT a reply_pin — the exact
    // pin match cannot see this; the window check must.
    h.state.nowMs += 10_000;
    insertGroupMessage(h.db, {
      pinId: 'twin-reply-nopin-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '已核实，收下。', chainTimestamp: 1_000_000_015,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] ② 文章 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0', chainTimestamp: 1_000_000_020,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'Twin reply without reply_pin also suppresses the auto verify');
    assert.equal(h.groupTaskStore.listDeliverables(taskId).length, 2, 'deliverable rows still recorded');
  } finally {
    h.cleanup();
  }
});

test('P2-7 r2: daemon auto replies resume when the Twin is quiet, and its own replies do not self-suppress', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);

    // Twin spoke LONG ago (outside the 60s window) — the daemon auto verify runs.
    insertGroupMessage(h.db, {
      pinId: 'twin-old-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '旧消息：不在窗口内。', chainTimestamp: 999_000_000,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0', chainTimestamp: 1_000_000_000,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'Twin quiet: the chair auto-verifies the deliverable');
    assert.equal(h.sends[0].metabotId, 1);

    // The daemon's own reply round-trips on-chain (pin send-pin-1). Another
    // deliverable arrives inside the window — the daemon must NOT treat its
    // own reply as Twin activity and must verify again.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'send-pin-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: h.sends[0].content, chainTimestamp: 1_000_000_030,
    });
    insertGroupMessage(h.db, {
      pinId: 'dlv-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[DELIVERABLE] ② 文章 metafile://cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdi0', chainTimestamp: 1_000_000_035,
    });
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, "the daemon's own reply does not suppress the next auto verify");
    assert.equal(h.sends[1].metabotId, 1);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Round-4: chain-GlobalMetaID attribution (SUSPECT) + correction-first
// ---------------------------------------------------------------------------

test('round-4 attribution: non-member sender is SUSPECT — no deliverables, no replies, row flagged', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'intruder-i0', senderMetaId: 'metaid-x', senderGlobalMetaId: 'gmid-stranger',
      senderName: 'Some Bot',
      content: `@Coder Bot do this\n**[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}**`,
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['intruder-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'row flagged SUSPECT');
    assert.equal(h.sends.length, 0, 'no replies triggered for a non-member speaker');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 0, 'no deliverables from non-members');
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: owner (boss gmid) is never SUSPECT and still reaches the chair', async () => {
  const h = await createHarness();
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'owner-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Human', content: 'status update please',
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['owner-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 0, 'owner exempt from SUSPECT');
    assert.equal(h.sends.length, 1, 'chair answers the owner');
    assert.equal(h.sends[0].metabotId, 1);
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: legacy metaid resolved via injected resolver, persisted, member not SUSPECT', async () => {
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => (legacy === 'metaid-2' ? 'gmid-w2' : null),
  });
  try {
    const task = h.createTask([2, 3]);
    // Indexer push carried only the legacy chain signature, no GlobalMetaID.
    insertGroupMessage(h.db, {
      pinId: 'legacy-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot hi',
    });
    await h.loop.runTick();
    const row = h.db.exec(
      'SELECT sender_global_metaid, sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['legacy-i0'],
    )[0].values[0];
    assert.equal(row[0], 'gmid-w2', 'resolved GlobalMetaID persisted onto the row');
    assert.equal(row[1], 0, 'member sender is not SUSPECT');
    assert.equal(h.sends.length, 1, 'mentioned member replies');
    assert.equal(h.sends[0].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('round-4 attribution: unresolvable legacy metaid → SUSPECT, silent', async () => {
  const h = await createHarness({ resolveGlobalMetaId: async () => null });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'ghost-i0', senderMetaId: 'metaid-ghost', senderGlobalMetaId: null,
      senderName: 'Ghost', content: '@Coder Bot hi',
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['ghost-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'unresolvable signature flagged SUSPECT');
    assert.equal(h.sends.length, 0, 'no replies for an unresolvable sender');
  } finally {
    h.cleanup();
  }
});

test('M3 kick: messages from a removed member turn SUSPECT — no replies, no deliverables', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);

    // Pre-kick: a member deliverable is ingested and the chair verifies it.
    insertGroupMessage(h.db, {
      pinId: 'pre-kick-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}`,
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'pre-kick deliverable recorded');
    assert.equal(h.sends.length, 1, 'pre-kick deliverable triggers the chair');

    // M3: the owner kicks the member (removeuser pin landed; row marked).
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2' });

    // The kicked member's daemon (or an indexer that has not enforced the
    // removal yet) keeps posting — the host must stay silent and ingest nothing.
    insertGroupMessage(h.db, {
      pinId: 'post-kick-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `@Twin Bot still here\n[DELIVERABLE] metaapp: metaapp://${REAL_PINID_2}`,
    });
    await h.loop.runTick();
    const suspect = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['post-kick-i0'],
    )[0].values[0][0];
    assert.equal(suspect, 1, 'post-kick message flagged SUSPECT (sender no longer a member)');
    assert.equal(h.sends.length, 1, 'no replies after the kick');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'no deliverables after the kick');
  } finally {
    h.cleanup();
  }
});

test('round-4 correction-first: a 更正 message supersedes the matched deliverable in place', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'd1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[DELIVERABLE] buzz: https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`,
    });
    await h.loop.runTick();
    let rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].uri, `https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`);

    // Same author corrects the link; the buzz pinid token ties them together.
    insertGroupMessage(h.db, {
      pinId: 'd2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: `[CORRECTION] 链接更正：此前的 buzz 交付链接为无效路由。\n[DELIVERABLE] buzz 正确预览链接: https://openagentinternet.org/browser/pin/${REAL_PINID_2}（实测 HTTP 200）`,
    });
    await h.loop.runTick();
    rows = h.groupTaskStore.listDeliverables(task.id);
    assert.equal(rows.length, 1, 'correction updates in place — no duplicate row');
    assert.equal(rows[0].uri, `https://openagentinternet.org/browser/pin/${REAL_PINID_2}`);
    assert.equal(rows[0].msgPinId, 'd1-i0', 'original row retained, uri superseded');
    assert.equal(rows[0].status, 'pending');
  } finally {
    h.cleanup();
  }
});

test('round-4 (task #63 revision): two tag lines, two artifacts → two rows; a viewer URL for the SAME artifact folds', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'multi-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: [
        `**[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}**`,
        `**[DELIVERABLE] 分享链接: https://openagentinternet.org/browser/metaapp/${REAL_PINID_1}**`,
        `**[DELIVERABLE] 技能包: metafile://${REAL_PINID_2}.zip**`,
      ].join('\n'),
    });
    await h.loop.runTick();
    const rows = h.groupTaskStore.listDeliverables(task.id);
    // Task #63: one artifact = one row. The share link embeds the SAME pinid
    // in its path (a web viewer for the same on-chain object) and folds into
    // the metaapp row; the separate skill zip keeps its own row.
    assert.equal(rows.length, 2, 'two distinct artifacts, one row each');
    assert.ok(rows.some((r) => r.uri === `metaapp://${REAL_PINID_1}`), 'metaapp row kept');
    assert.ok(rows.some((r) => r.uri === `metafile://${REAL_PINID_2}.zip`), 'distinct zip row kept');
    assert.ok(!rows.some((r) => r.uri?.endsWith('**')), 'no trailing markdown in recorded URIs');
  } finally {
    h.cleanup();
  }
});

test('round-4: HTTP probe notes on https deliverable links ride the chair verification context', async () => {
  const probeResults = {
    [`https://openagentinternet.org/browser/pin/${REAL_PINID_2}`]: 200,
    [`https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`]: 404,
  };
  const h = await createHarness({
    probeUrl: async (url) => probeResults[url] ?? null,
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'probe-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: [
        `[DELIVERABLE] buzz 正确预览链接: https://openagentinternet.org/browser/pin/${REAL_PINID_2}`,
        `[DELIVERABLE] 旧链接: https://openagentinternet.org/browser/buzz/${REAL_PINID_2}`,
      ].join('\n'),
    });
    await h.loop.runTick();

    // The chair was triggered by the deliverable tag; its context carries the
    // probe notes: 200 marked reachable, 404 flagged for clarification.
    const chairCall = h.chatCalls.find((call) => call.userMessage.includes('Host verification'));
    assert.ok(chairCall, 'chair received verification notes');
    assert.match(chairCall.userMessage, /HTTP probe .*\/browser\/pin\/.* → 200 \(link reachable\)/);
    assert.match(chairCall.userMessage, /HTTP probe .*\/browser\/buzz\/.* → 404 — link may be invalid; verify before accepting/);
  } finally {
    h.cleanup();
  }
});

test('round-4 cursor semantics: a failed reply turn retries via the durable queue; the cursor never regresses', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // one-shot LLM failure: tick 1's turn fails, tick 2's durable-queue retry succeeds
    h.state.chatError = 'transient boom';
    insertGroupMessage(h.db, {
      pinId: 'retry-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot go',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['retry-i0'])[0].values[0][0];

    await h.loop.runTick();
    // fix/group-task-flow: the cursor advances once the trigger is DISPATCHED;
    // the failed reply turn retries via the durable defer queue instead of
    // holding the cursor (and the whole batch behind it) hostage.
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advanced at dispatch (reply retry rides the durable queue)');
    assert.equal(h.chatCalls.length, 1, 'first attempt failed');
    assert.equal(h.sends.length, 0);

    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'message retried from the durable queue on the next tick');
    assert.equal(h.sends.length, 1, 'retry posted the reply');
  } finally {
    h.cleanup();
  }
});

test('round-4 cursor semantics: a permanently failing turn is dropped after the bounded retries', async () => {
  const h = await createHarness({ chatErrorAlways: 'always boom' });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'stuck-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do the impossible',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['stuck-i0'])[0].values[0][0];

    // fix/group-task-flow: one attempt per tick — tick 1 dispatches from the
    // message loop, ticks 2-5 drain the durable-queue requeue. The 5th failure
    // spends the budget and the entry is dropped.
    for (let tick = 1; tick <= 5; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.sends.length, 0, `tick ${tick}: nothing ever posts`);
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
        `tick ${tick}: cursor stayed advanced (dispatch-time semantics)`);
    }
    assert.equal(h.chatCalls.length, 5, 'exactly MSG_RETRY_MAX_FAILURES attempts');

    // the 6th tick has nothing left to process
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 5, 'no further attempts after the drop');
  } finally {
    h.cleanup();
  }
});

test('GT#26 regression: control tags on a dropped message still land via the tag-only reprocess', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2], { activate: false }); // stays 'planning'
    // Stall-storm shape: the durable status write keeps failing (e.g. a busy
    // DB while the DSH watchdog crisis unfolds) for EVERY retry attempt, then
    // recovers in time for the drop-time tag-only reprocess.
    const originalUpdate = h.groupTaskStore.updateTaskStatus.bind(h.groupTaskStore);
    let executingUpdateCalls = 0;
    h.groupTaskStore.updateTaskStatus = (id, next, opts) => {
      if (id === task.id && next === 'executing') {
        executingUpdateCalls += 1;
        if (executingUpdateCalls <= 5) throw new Error('simulated SQLITE_BUSY during the stall storm');
      }
      return originalUpdate(id, next, opts);
    };

    insertGroupMessage(h.db, {
      pinId: 'gt26-plan-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '[GROUP TASK #26 计划] Remotion vs HyperFrames 双视频对比……分工如下。\n\n[STATUS:EXECUTING]',
    });
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['gt26-plan-i0'])[0].values[0][0];
    // Baseline: the task-creation announcement (a lower id) may process
    // normally on tick 1 — the cursor must then HOLD there across the retries.
    const baselineCursor = msgId - 1;

    for (let tick = 1; tick <= 4; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning',
        `tick ${tick}: every attempt failed before the transition could land`);
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, baselineCursor,
        `tick ${tick}: cursor held while the retry budget was being spent`);
    }

    // The 5th failure spends the budget: the message is dropped, and the
    // tag-only reprocess lands the [STATUS:EXECUTING] transition the retries
    // never could — the exact loss that pinned task #26 in 'planning'.
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing',
      'chair [STATUS:EXECUTING] on the dropped message still transitioned the task');
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advanced past the dropped message');
    const transitions = h.db.exec(
      'SELECT from_status, to_status FROM group_task_status_events WHERE task_id = ?',
      [task.id],
    );
    assert.deepEqual(
      (transitions[0]?.values ?? []).map((row) => [row[0], row[1]]),
      [['planning', 'executing']],
      'the transition is durably recorded',
    );
    assert.equal(h.chatCalls.length, 0, 'no reply generation ever ran for the dropped message');
  } finally {
    h.cleanup();
  }
});

test('GT-01: lastDrivenAt tracks real drive work — idle ticks never fake-heartbeat it', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    await h.loop.runTick();
    const first = h.db.exec('SELECT last_driven_at FROM group_tasks WHERE id = ?', [task.id])[0].values[0][0];

    // An idle tick one hour later must NOT move the timestamp (the #56 fake
    // heartbeat kept it fresh through hours of zero dispatch → stall stayed
    // False for the whole outage).
    h.state.nowMs += 60 * 60_000;
    await h.loop.runTick();
    const second = h.db.exec('SELECT last_driven_at FROM group_tasks WHERE id = ?', [task.id])[0].values[0][0];
    assert.equal(second, first, 'an idle tick must not refresh lastDrivenAt');

    // Processing a new message IS real drive work.
    insertGroupMessage(h.db, {
      pinId: 'pin-drive-activity-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 处理中',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const third = h.db.exec('SELECT last_driven_at FROM group_tasks WHERE id = ?', [task.id])[0].values[0][0];
    assert.equal(third, Math.floor(h.state.nowMs / 1000), 'a processed message refreshes lastDrivenAt');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R2P1-4: a resolver THROW is transient (retry path), only a definitive null
// resolution marks SUSPECT.
// ---------------------------------------------------------------------------

test('R2P1-4: resolver throw rides the bounded retry path — no SUSPECT, cursor held, recovered on retry', async () => {
  let resolverCalls = 0;
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => {
      resolverCalls += 1;
      if (resolverCalls === 1) throw new Error('manapi temporarily unreachable');
      return legacy === 'metaid-2' ? 'gmid-w2' : null;
    },
  });
  try {
    const task = h.createTask([2, 3]);
    insertGroupMessage(h.db, {
      pinId: 'transient-resolve-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot hi',
    });
    const msgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['transient-resolve-i0'],
    )[0].values[0][0];

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
      'cursor held while the resolver is failing');
    assert.equal(h.sends.length, 0, 'no reply from an unattributed message');
    const afterThrow = h.db.exec(
      'SELECT sender_suspect, sender_global_metaid FROM group_chat_messages WHERE pin_id = ?',
      ['transient-resolve-i0'],
    )[0].values[0];
    assert.equal(Number(afterThrow[0] ?? 0), 0, 'a resolver throw must NOT mark SUSPECT');
    assert.equal(afterThrow[1], null, 'nothing persisted while unresolved');

    await h.loop.runTick();
    assert.equal(resolverCalls, 2, 'message retried on the next tick');
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advances once the resolution succeeds');
    const resolved = h.db.exec(
      'SELECT sender_global_metaid, sender_suspect FROM group_chat_messages WHERE pin_id = ?',
      ['transient-resolve-i0'],
    )[0].values[0];
    assert.equal(resolved[0], 'gmid-w2');
    assert.equal(Number(resolved[1]), 0, 'member sender is not SUSPECT');
    assert.equal(h.sends.length, 1, 'the legitimate member message is answered after recovery');
    assert.equal(h.sends[0].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('R2P1-4: permanently throwing resolver drops the message after the bounded retries, never SUSPECT', async () => {
  const h = await createHarness({
    resolveGlobalMetaId: async () => { throw new Error('manapi down for good'); },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'down-resolve-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Coder Bot hi',
    });
    const msgId = h.db.exec(
      'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['down-resolve-i0'],
    )[0].values[0][0];

    for (let tick = 1; tick <= 4; tick += 1) {
      await h.loop.runTick();
      assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
        `tick ${tick}: cursor held while the resolver keeps failing`);
    }
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'bounded retries spent: cursor advances past the unresolvable message');
    const row = h.db.exec(
      'SELECT sender_suspect FROM group_chat_messages WHERE pin_id = ?', ['down-resolve-i0'],
    )[0].values[0];
    assert.equal(Number(row[0] ?? 0), 0, 'never stamped SUSPECT on transient-resolution failures');
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// M3 deferred-reply re-check: a reply deferred by the cooldown is dropped when
// the sender was kicked (or flagged SUSPECT) before the deferred turn runs.
// ---------------------------------------------------------------------------

const setupDeferredReply = async (h) => {
  const task = h.createTask([2, 3]);
  // First mention: Designer Bot answers (cooldown starts).
  insertGroupMessage(h.db, {
    pinId: 'defer-first-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
    senderName: 'Coder Bot', content: '@Designer Bot first task',
  });
  await h.loop.runTick();
  assert.equal(h.sends.length, 1, 'first mention answered');
  assert.equal(h.sends[0].metabotId, 3);

  // Second mention inside the cooldown window: deferred to a later tick.
  insertGroupMessage(h.db, {
    pinId: 'defer-second-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
    senderName: 'Coder Bot', content: '@Designer Bot second task',
  });
  await h.loop.runTick();
  assert.equal(h.sends.length, 1, 'cooldown mention deferred, not answered yet');
  const secondMsgId = h.db.exec(
    'SELECT id FROM group_chat_messages WHERE pin_id = ?', ['defer-second-i0'],
  )[0].values[0][0];
  return { task, secondMsgId };
};

test('M3 deferred re-check: sender kicked before the deferred turn — reply dropped', async () => {
  const h = await createHarness();
  try {
    const { task } = await setupDeferredReply(h);

    // The owner kicks the SENDER of the deferred message; the replier stays.
    h.groupTaskStore.markMemberRemoved({ taskId: task.id, metabotId: 2, removePinId: 'pin-remove-2' });

    h.state.nowMs += 30_000; // past the worker cooldown
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'no reply on a kicked sender\'s message');
  } finally {
    h.cleanup();
  }
});

test('M3 deferred re-check: sender flagged SUSPECT before the deferred turn — reply dropped', async () => {
  const h = await createHarness();
  try {
    const { secondMsgId } = await setupDeferredReply(h);

    // Late attribution flip (e.g. a manual/host re-evaluation) marks the row suspect.
    h.groupTaskStore.setMessageSenderSuspect(secondMsgId, true);

    h.state.nowMs += 30_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'no reply on a suspect message');
  } finally {
    h.cleanup();
  }
});

test('M3 deferred re-check: sender still an active member — deferred reply fires normally', async () => {
  const h = await createHarness();
  try {
    await setupDeferredReply(h);
    h.state.nowMs += 30_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'deferred reply fires once the cooldown elapsed');
    assert.equal(h.sends[1].metabotId, 3);
  } finally {
    h.cleanup();
  }
});

test('R2P1-4: a resolver failure holds the whole batch — a later clean message cannot leapfrog the cursor', async () => {
  let resolverCalls = 0;
  const h = await createHarness({
    resolveGlobalMetaId: async (legacy) => {
      resolverCalls += 1;
      if (resolverCalls === 1) throw new Error('manapi unreachable');
      return legacy === 'metaid-2' ? 'gmid-w2' : null;
    },
  });
  try {
    const task = h.createTask([2, 3]);
    // N: needs resolution (throws transiently on the first tick).
    insertGroupMessage(h.db, {
      pinId: 'unresolved-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: null,
      senderName: 'Coder Bot', content: '@Designer Bot from an unresolved sender',
    });
    // N+1: fully attributable owner message — would succeed if it were reached.
    insertGroupMessage(h.db, {
      pinId: 'clean-owner-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Human', content: 'status update please',
    });

    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, 0,
      'cursor held at the failing message');
    assert.equal(h.chatCalls.length, 0,
      'the later clean message was NOT processed behind the failed one (no leapfrog)');

    await h.loop.runTick();
    assert.equal(h.sends.length, 2, 'both messages processed after recovery');
    assert.equal(h.sends[0].metabotId, 3, 'the previously failing message answered first (in order)');
    assert.equal(h.sends[1].metabotId, 1, 'the owner message answered after it');
  } finally {
    h.cleanup();
  }
});

test('P0-2: silent assigned/working members are auto-marked unreachable after the threshold', async () => {
  const h = await createHarness({ memberUnreachableAfterMinutes: 5 });
  try {
    const task = h.createTask([2, 3]);
    // Anchor the daemon clock to wall time so sqlite created_at baselines
    // (real datetime('now')) compare sensibly.
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Worker 2 claimed work with a [WORKING] 1 minute ago (within threshold);
    // worker 3 got a chair assignment (a pending ACK watch) and never spoke.
    // Both carry an outstanding obligation, so silence past the threshold is
    // flag-worthy — a member with NO obligation is legitimately idle and is
    // never stamped (see the obligation-gate test).
    insertGroupMessage(h.db, {
      pinId: 'pin-old-1',
      senderMetaId: 'metaid-2',
      senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[WORKING] hello',
      chainTimestamp: Math.floor((startMs - 60_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-old-3',
      senderMetaId: 'metaid-1',
      senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Designer Bot please handle the icon set',
      chainTimestamp: Math.floor((startMs - 60_000) / 1000),
    });

    // Fresh task: worker 2 spoke (implicit ACK → working); worker 3 is still
    // within threshold → assigned (not yet unreachable).
    await h.loop.runTick();
    let members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).status, 'working');
    assert.equal(members.find((m) => m.metabotId === 3).status, 'assigned');

    // Advance past the threshold: both become unreachable.
    h.state.nowMs = startMs + 6 * 60_000;
    await h.loop.runTick();
    members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 2).status, 'unreachable');
    assert.equal(members.find((m) => m.metabotId === 3).status, 'unreachable');

    // Chair member is never auto-marked.
    assert.equal(members.find((m) => m.metabotId === 1).status, 'working');
  } finally {
    h.cleanup();
  }
});

test('P0-2 recovery: an unreachable member with fresh liveness signals is restored to working', async () => {
  const h = await createHarness({ memberUnreachableAfterMinutes: 5 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Both workers carry a stale unreachable stamp from a prior silence spell.
    h.groupTaskStore.setMemberStatus(task.id, 2, 'unreachable', 'gmid-w2');
    h.groupTaskStore.setMemberStatus(task.id, 3, 'unreachable', 'gmid-w3');
    // Worker 3's stamp is backed by an outstanding obligation (an assignment
    // whose ACK watch is still pending) — without one the stamp is bogus and
    // the obligation gate lifts it immediately instead of keeping it.
    h.store.set(
      `group_task_ack_pending:${task.id}:3`,
      JSON.stringify({ assignedAt: startMs, messageId: 1, assignedChainSec: Math.floor(startMs / 1000) }),
    );

    // Worker 2 spoke 30s ago — but the message is ALREADY past the cursor
    // (e.g. it arrived while a hung tick froze message processing), so only
    // the bidirectional monitor can recover the member.
    insertGroupMessage(h.db, {
      pinId: 'pin-rec-fresh-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '我还在，刚发完交付',
      chainTimestamp: Math.floor((startMs + 5 * 60_000 - 30_000) / 1000),
    });
    const cursorId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, cursorId);

    // Advance past the unreachable threshold: worker 3 (never spoke, no
    // session) is now genuinely stale; worker 2's speech is still fresh.
    h.state.nowMs = startMs + 5 * 60_000;
    await h.loop.runTick();
    let members = h.groupTaskStore.listMembers(task.id);
    assert.equal(
      members.find((m) => m.metabotId === 2).status, 'working',
      'fresh speech behind the cursor still recovers the stale unreachable stamp',
    );
    assert.equal(
      members.find((m) => m.metabotId === 3).status, 'unreachable',
      'a member with no liveness signal keeps the stamp',
    );

    // Worker 3's cowork session shows fresh tool activity (long task in
    // flight, no group speech) — session liveness recovers it too.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    ensureGroupTaskSession(h.coworkStore, task, 3, 'Designer Bot');
    await h.loop.runTick();
    members = h.groupTaskStore.listMembers(task.id);
    assert.equal(
      members.find((m) => m.metabotId === 3).status, 'working',
      'fresh cowork-session activity recovers the unreachable stamp',
    );
  } finally {
    h.cleanup();
  }
});

test('unreachable recovery: plain (non-[WORKING]) worker speech lifts the stamp via implicit ACK', async () => {
  const h = await createHarness({ memberUnreachableAfterMinutes: 5 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    h.groupTaskStore.setMemberStatus(task.id, 2, 'unreachable', 'gmid-w2');

    // A 10-minute-old plain message that the cursor never processed (the loop
    // was hung when it arrived). Too stale for the monitor's liveness window,
    // so only the message handler's implicit ACK can lift the stamp.
    insertGroupMessage(h.db, {
      pinId: 'pin-rec-plain-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '进度同步：素材都齐了',
      chainTimestamp: Math.floor((startMs - 10 * 60_000) / 1000),
    });

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'any processed worker speech lifts a stale unreachable stamp');
  } finally {
    h.cleanup();
  }
});

test('R6 L2 anti-flap: stale [WORKING] with fresh plain speech does not stamp unreachable', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 60 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // [WORKING] 2 min stale (past the 1-min timeout window), but the member
    // spoke in the group 20s ago. Both messages already processed.
    insertGroupMessage(h.db, {
      pinId: 'pin-flap-working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单',
      chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-flap-speech-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '补充：配图 prompt 也发了',
      chainTimestamp: Math.floor((startMs - 20_000) / 1000),
    });
    const cursorId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, cursorId);
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');

    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'fresh speech contradicts the timeout stamp — no flap');
    assert.equal(
      h.store.get('group_task_timeout_hint:1:2'), '1',
      'the chair re-assign hint still fires (status write alone is skipped)',
    );
  } finally {
    h.cleanup();
  }
});

test('review follow-up: liveness in the timeout/unreachable gap never flaps the member status', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    deps: { memberTimeoutAfterMinutes: 20, memberUnreachableAfterMinutes: 30 },
  });
  try {
    const task = h.createTask([2, 3, 4]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // All three workers' [WORKING] signals are past the 20-min timeout window,
    // so monitorLocalWorkerTimeout evaluates a status write for each of them.
    // (A [WORKING] message also counts as the member's last group speech.)
    insertGroupMessage(h.db, {
      pinId: 'gap-w2-working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单',
      chainTimestamp: Math.floor((startMs - 25 * 60_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'gap-w3-working-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单',
      chainTimestamp: Math.floor((startMs - 40 * 60_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'gap-w4-working-i0', senderMetaId: 'metaid-4', senderGlobalMetaId: 'gmid-w4',
      senderName: 'Reviewer Bot', content: '[WORKING] 已接单',
      chainTimestamp: Math.floor((startMs - 40 * 60_000) / 1000),
    });
    const cursorId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, cursorId);
    for (const metabotId of [2, 3, 4]) {
      h.groupTaskStore.setMemberStatus(task.id, metabotId, 'working', `gmid-w${metabotId}`);
    }

    // Worker 3 additionally has cowork-session activity 25 min old — inside the
    // 20–30 min gap between the timeout window and the unreachable window.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 3, 'Designer Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 25 * 60_000, session.id]);

    // w2: last speech 25 min old (in the gap) — the stamp must be skipped.
    // w3: speech 40 min old but session activity 25 min old (in the gap) — the
    //     stamp must be skipped too (monitorMemberUnreachable would recover it
    //     right back, which used to flap the badge every tick).
    // w4: every signal 40 min stale — legitimately unreachable, and STAYS so.
    for (let tick = 1; tick <= 3; tick += 1) {
      await h.loop.runTick();
      const members = h.groupTaskStore.listMembers(task.id);
      assert.equal(
        members.find((m) => m.metabotId === 2).status, 'working',
        `tick ${tick}: speech inside the unreachable window blocks the timeout stamp`,
      );
      assert.equal(
        members.find((m) => m.metabotId === 3).status, 'working',
        `tick ${tick}: session activity inside the unreachable window blocks the timeout stamp`,
      );
      assert.equal(
        members.find((m) => m.metabotId === 4).status, 'unreachable',
        `tick ${tick}: a genuinely inert member is (and stays) stamped`,
      );
    }
    assert.equal(
      logs.filter((line) => line.includes('unreachable -> working')).length,
      0,
      'no unreachable↔working flap churn across ticks',
    );
  } finally {
    h.cleanup();
  }
});

test('tick watchdog: a hung TURN no longer hangs the daemon loop', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: { tickWatchdogMs: 500, intervalMs: 20 },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // The first group send never settles — simulating the hung await that
    // silently killed the loop in production (task #45, 2026-08-28).
    // fix/group-task-flow: sends run inside detached turn jobs now, so the hung
    // send hangs ONE job while the tick loop keeps driving every other task.
    const realPost = h.deps.postGroupTaskMessage;
    let postCalls = 0;
    h.deps.postGroupTaskMessage = async (...args) => {
      postCalls += 1;
      if (postCalls === 1) return new Promise(() => {});
      return realPost(...args);
    };
    insertGroupMessage(h.db, {
      pinId: 'wd-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the thing',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });

    const drivenAtStart = h.groupTaskStore.getTaskById(task.id).lastDrivenAt ?? 0;
    h.loop.start();
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    await sleep(100); // tick 1 dispatches the turn whose send hangs forever
    h.state.nowMs += 10_000; // jump past the watchdog window
    // intervalMs is clamped to >= 1000ms inside the loop — wait out a full
    // interval so later ticks land.
    await sleep(1_500);
    h.loop.stop();

    assert.equal(
      logs.filter((line) => line.includes('Tick watchdog')).length,
      0,
      'no watchdog fire: the tick itself never hung (the hung send lives in a detached job)',
    );
    const drivenAtEnd = h.groupTaskStore.getTaskById(task.id).lastDrivenAt ?? 0;
    assert.ok(
      drivenAtEnd > drivenAtStart,
      'the loop keeps driving while a turn job is hung (lastDrivenAt heartbeat moved)',
    );
  } finally {
    h.cleanup();
  }
});

test('tick watchdog: a long but healthy tick is never reset — no double dispatch', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    deps: { tickWatchdogMs: 1_500, intervalMs: 20 },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // Every group send takes ~0.9s of real time and advances the daemon clock
    // by 1.2s — so a multi-message tick outlasts the 1.5s watchdog window in
    // TOTAL duration while never going 1.5s without observable progress. A
    // duration-based watchdog (the reviewed defect) would reset the loop
    // mid-tick and re-dispatch the still-pending messages.
    const realPost = h.deps.postGroupTaskMessage;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    h.deps.postGroupTaskMessage = async (...args) => {
      await sleep(900);
      h.state.nowMs += 1_200;
      return realPost(...args);
    };
    for (let i = 1; i <= 3; i += 1) {
      insertGroupMessage(h.db, {
        pinId: `wd-long-assign-${i}-i0`, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
        senderName: 'Twin Bot', content: `@Coder Bot work package ${i}`,
        chainTimestamp: Math.floor(h.state.nowMs / 1000),
      });
    }

    h.loop.start();
    // intervalMs is clamped to >= 1000ms inside the loop, so interval ticks
    // fire DURING the slow first tick — exactly the overlap the review flagged.
    // Wait out the whole multi-send tick plus one more interval.
    await sleep(9_000);
    h.loop.stop();

    assert.equal(
      logs.filter((line) => line.includes('Tick watchdog')).length,
      0,
      'a tick with steady progress is never reset, however long it runs',
    );
    const workerSends = h.sends.filter((send) => send.metabotId === 2);
    // Task #64 drain coalescing: package 1 got its own turn (dispatched before
    // the backlog existed), then the queued packages 2+3 coalesce into ONE
    // turn answering the oldest open assignment (#2). Three sequential
    // re-lived turns would be the old FIFO-replay behavior.
    assert.equal(
      workerSends.length,
      2,
      'no watchdog-induced double dispatch; the backlog coalesces into one turn',
    );
    assert.equal(
      workerSends[1].replyPin,
      'wd-long-assign-2-i0',
      'the coalesced turn answers the oldest open assignment',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-3: [WORKING] ACK + chair reminders
// ---------------------------------------------------------------------------

test('P0-3: chair assignment records pending ACK; worker [WORKING] ACK clears it and marks working', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();

    // Chair assigns worker 2 — single-track deadlines: only a chair-stated
    // [DEADLINE] arms the clock, so this assignment carries one.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp [DEADLINE: 5m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_ack_pending:1:2') != null, true);

    // Worker 2 ACKs with [WORKING] and an estimate.
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：build metaapp，预计 5 分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_ack_pending:1:2'), undefined);
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working');
    assert.ok(h.store.get('group_task_expected_delivery:1:2'), 'chair-stated deadline armed on the ACK');
  } finally {
    h.cleanup();
  }
});

test('P2-2: a [WORKING long-task] heartbeat arms the liveness lease and counts as working', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-heartbeat-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING long-task, ETA 45 min] VoxCPM synthesis in background',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working');
    const lease = Number(h.store.get('group_task_working_heartbeat:1:2'));
    assert.ok(Number.isFinite(lease), 'heartbeat lease recorded');
    assert.equal(lease, startMs + 45 * 60_000 + 5 * 60_000, 'ETA + 5-min grace');
    // Speedup R-02: an ETA-bearing heartbeat with NO assignment on record is
    // liveness only — it must NOT arm a delivery deadline (the EP28 false
    // "no [DELIVERABLE] arrived" alert came from exactly this arm).
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined);

    // Control: once the chair has actually dispatched work with a stated
    // [DEADLINE] (single-track clocks), the same heartbeat DOES arm it.
    insertGroupMessage(h.db, {
      pinId: 'pin-hb-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot synthesize the demo track [DEADLINE: 45m]',
      chainTimestamp: Math.floor(startMs / 1000) + 1,
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-heartbeat-2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING long-task, ETA 45 min] VoxCPM synthesis in background',
      chainTimestamp: Math.floor(startMs / 1000) + 2,
    });
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_expected_delivery:1:2'), 'chair-stated deadline armed on the assigned heartbeat');
  } finally {
    h.cleanup();
  }
});

test('P0-3 (single-commander): missing ACK past the timeout records ONE host environment note for the chair, never auto-fails', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-2', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.sends.length = 0;

    // Before timeout: nothing recorded, nothing posted.
    h.state.nowMs = startMs + 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'the host never posts the reminder itself');
    assert.equal(h.groupTaskStore.listPendingHostNotes(task.id).length, 0);
    assert.equal(h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2).status, 'assigned');

    // Past timeout: ONE environment note recorded for the chair (not a group
    // post). The note-turn trigger already passed within this tick, so the
    // delivery happens on the NEXT tick.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    const noteCount = (kind) => Number(h.db.exec(
      'SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = ?',
      [task.id, kind],
    )[0].values[0][0]);
    assert.equal(noteCount('no_ack'), 1, 'exactly one no_ack environment note recorded');
    assert.equal(h.sends.length, 0, 'the host itself posts nothing');

    // Next tick delivers the note to the chair — the chair speaks in its own
    // voice, not a host ⚠ @chair line.
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.listPendingHostNotes(task.id).length,
      0,
      'the note was consumed by the chair turn (harness drains detached jobs)',
    );
    assert.equal(h.sends.filter((s) => s.metabotId === 1).length, 1, 'the chair itself spoke once');
    assert.ok(
      !h.sends.some((s) => /@chair/.test(s.content) && /has not sent a \[WORKING\] ACK/.test(s.content)),
      'no host-authored @chair self-talk post',
    );

    // A later tick does not re-remind (kv-guarded streak).
    const sendCount = h.sends.length;
    h.state.nowMs = startMs + 400_000;
    await h.loop.runTick();
    assert.equal(noteCount('no_ack'), 1, 'no second no_ack note');
    assert.equal(h.sends.length, sendCount);
  } finally {
    h.cleanup();
  }
});

test('Task #83 F2a: the on-chain rework hatch supersedes the delivered acceptance summary and retracts it', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: (m) => { milestones.push(m); return true; },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-f2a', task.id]);
    // Chair drives the task into review — the entry ceremony builds summary v1.
    insertGroupMessage(h.db, {
      pinId: 'f2a-rev-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '验收 [STATUS:REVIEW]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    assert.ok(h.groupTaskStore.getLatestAcceptanceSummary(task.id), 'review entry generated summary v1');

    // The chair self-reopens (the legal rework hatch) — the delivered summary
    // must be voided and the owner told.
    insertGroupMessage(h.db, {
      pinId: 'f2a-rework-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '交付物未入账，打回返工 [STATUS:EXECUTING]',
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary.supersededAt, 'the review-entry summary is stamped superseded');
    const retraction = milestones.find(
      (m) => m.kind === 'anomaly' && typeof m.subject === 'string' && m.subject.startsWith('review_retracted:'),
    );
    assert.ok(retraction, 'the origin session received the retraction');
    assert.match(retraction.message, /作废|no longer authoritative/);
  } finally {
    h.cleanup();
  }
});

test('Task #83 P1: a worker whose turn is still in flight defers the no-ACK note; it fires once the turn settles silent', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Coder Bot's chat turn hangs until the test releases it, keeping the
    // daemon-side turn in flight across ticks (the live task-83 false positive:
    // the 3-min ACK soak lapsed mid-turn and the chair got a bogus no-ack note).
    let turnStarted;
    let resolveTurn;
    const turnPromise = new Promise((resolve) => { resolveTurn = resolve; });
    const turnStartedPromise = new Promise((resolve) => { turnStarted = resolve; });
    const basePerformChat = h.deps.performChat;
    h.deps.performChat = async (systemPrompt, userMessage, llmId) => {
      if (llmId === 'llm-2') {
        turnStarted();
        return turnPromise;
      }
      return basePerformChat(systemPrompt, userMessage, llmId);
    };
    const noteCount = (kind) => Number(h.db.exec(
      'SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = ?',
      [task.id, kind],
    )[0].values[0][0]);
    // Raw loop (no drain): the hanging turn must stay in flight after the tick.
    const rawLoop = createGroupTaskDaemonLoop(h.deps);
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-inflight', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the board',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await rawLoop.runTick();
    await turnStartedPromise;

    // Past the ACK timeout with the turn STILL running: deferred, watch kept.
    h.state.nowMs = startMs + 200_000;
    await rawLoop.runTick();
    assert.equal(noteCount('no_ack'), 0, 'a turn in flight defers the no-ACK note');
    assert.ok(h.store.get('group_task_ack_pending:1:2'), 'the watch survives the defer');

    // The turn settles without the worker ever speaking: NOW the note fires.
    resolveTurn('[NO_REPLY]');
    await rawLoop.whenIdle();
    await rawLoop.runTick();
    assert.equal(noteCount('no_ack'), 1, 'the no-ACK note fires after the silent turn settles');

    await rawLoop.runTick();
    assert.equal(noteCount('no_ack'), 1, 'still exactly one note (kv-guarded)');
  } finally {
    h.cleanup();
  }
});

test('Task #83 P4: a chair answer posted mid-turn via group_chat links the host note to the real pin', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const midPin = `${'a'.repeat(64)}i0`;
    h.state.routing = { prompt: 'ACTIVE SKILLS: metabot-group-task', activeSkillIds: ['metabot-group-task'] };
    h.state.skillReply = '[NO_REPLY]';
    const baseRunSkillTurn = h.deps.runSkillTurn;
    h.deps.runSkillTurn = async (params) => {
      // The model speaks through the group_chat tool, then closes [NO_REPLY].
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_use', content: '',
        metadata: { toolName: 'group_chat', toolInput: { action: 'send_group_message' } },
      });
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_result',
        content: `Group message sent (SimpleGroupChat).\n- pinId: ${midPin}\n- txids: ${'b'.repeat(64)}`,
      });
      return baseRunSkillTurn(params);
    };
    insertGroupMessage(h.db, {
      pinId: 'pin-p4-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.sends.length = 0;
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick(); // records the no_ack note
    await h.loop.runTick(); // the chair answers it — mid-turn, closing [NO_REPLY]
    const row = h.db.exec(
      'SELECT chair_response_pin_id, consumed_at FROM group_task_host_notes WHERE task_id = ?',
      [task.id],
    )[0].values[0];
    assert.equal(row[0], midPin, 'the note links the pin the chair actually posted mid-turn');
    assert.ok(row[1] != null, 'the note is consumed');
    assert.equal(
      h.sends.filter((send) => send.metabotId === 1).length,
      0,
      'no duplicate trailing post — the [NO_REPLY] tail stayed suppressed',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #83 P4: a supervisor signal answered mid-turn via group_chat is marked processed, not retried', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const midPin = `${'c'.repeat(64)}i0`;
    h.state.routing = { prompt: 'ACTIVE SKILLS: metabot-group-task', activeSkillIds: ['metabot-group-task'] };
    h.state.skillReply = '[NO_REPLY]';
    const baseRunSkillTurn = h.deps.runSkillTurn;
    h.deps.runSkillTurn = async (params) => {
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_use', content: '',
        metadata: { toolName: 'group_chat', toolInput: { action: 'send_group_message' } },
      });
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_result',
        content: `Group message sent (SimpleGroupChat).\n- pinId: ${midPin}`,
      });
      return baseRunSkillTurn(params);
    };
    h.groupTaskStore.addSupervisorSignal({ taskId: task.id, kind: 'nudge', note: 'check the ledger' });
    await h.loop.runTick();
    const row = h.db.exec(
      'SELECT processed_at, chair_response_pin_id FROM group_task_supervisor_signals WHERE task_id = ?',
      [task.id],
    )[0].values[0];
    assert.ok(row[0] != null, 'the signal is processed');
    assert.equal(row[1], midPin, 'processed with the mid-turn pin');
    const sendsAfter = h.sends.length;
    await h.loop.runTick();
    assert.equal(h.sends.length, sendsAfter, 'no retry of an already-answered signal');
  } finally {
    h.cleanup();
  }
});

test('P0-3: [STANDBY] marker sets standby; ordinary worker speech is an implicit ACK', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();

    // Chair assigns worker 2 and worker 3.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-3', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot and @Designer Bot please work',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_ack_pending:1:2'));
    assert.ok(h.store.get('group_task_ack_pending:1:3'));

    // Worker 3 posts [STANDBY] → standby; worker 2 posts ordinary speech → working (implicit ACK).
    insertGroupMessage(h.db, {
      pinId: 'pin-standby-1', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[STANDBY] 静默观察 / 待命接手 / 可退出',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-implicit-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'on it, will deliver soon',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const members = h.groupTaskStore.listMembers(task.id);
    assert.equal(members.find((m) => m.metabotId === 3).status, 'standby');
    assert.equal(members.find((m) => m.metabotId === 2).status, 'working');
    assert.equal(h.store.get('group_task_ack_pending:1:2'), undefined);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P0-4: deliverable verification + deadline reminders
// ---------------------------------------------------------------------------

test('P0-4: pinid deliverable gets multi-source verification persisted (found+found → verified)', async () => {
  const h = await createHarness({
    readPinSecondaryForVerification: async () => 'found',
    verificationRetryMs: 60_000,
  });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.state.pinOutcomes[REAL_PINID_1] = 'found';
    insertGroupMessage(h.db, {
      pinId: 'pin-deliv-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_1}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    assert.ok(deliverable, 'deliverable recorded');
    const report = JSON.parse(deliverable.verification);
    assert.equal(report.verified, true);
    assert.equal(report.sources.length, 2);
    assert.deepEqual(report.sources.map((s) => s.outcome).sort(), ['found', 'found']);
  } finally {
    h.cleanup();
  }
});

test('P0-4: indexer lag (man not_found, secondary found) persists pending-sync, not a hard failure', async () => {
  const h = await createHarness({
    readPinSecondaryForVerification: async () => 'found',
    verificationRetryMs: 60_000,
  });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.state.pinOutcomes[REAL_PINID_2] = 'not_found';
    insertGroupMessage(h.db, {
      pinId: 'pin-deliv-2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${REAL_PINID_2}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const deliverable = h.groupTaskStore.listDeliverables(task.id)[0];
    const report = JSON.parse(deliverable.verification);
    assert.equal(report.verified, false);
    assert.equal(report.sources.some((s) => s.outcome === 'not_found'), true);
    assert.equal(report.sources.some((s) => s.outcome === 'found'), true);
  } finally {
    h.cleanup();
  }
});

test('P0-4: missed delivery deadline posts ONE reminder; delivered members are skipped', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Chair assigns worker 2 with a 5-minute deadline; worker ACKs.
    insertGroupMessage(h.db, {
      pinId: 'pin-a4-1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver [DEADLINE: 5m]',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-a4-2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：deliver，预计 5 分钟',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_expected_delivery:1:2'));
    h.sends.length = 0;

    // Before deadline: no reminder.
    h.state.nowMs = startMs + 3 * 60_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);

    // Past deadline: ONE environment note for the chair (single-commander —
    // the host never posts the ⚠ itself).
    h.state.nowMs = startMs + 6 * 60_000;
    await h.loop.runTick();
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(deadlineNotes(), 1, 'missed deadline rang one bell');
    assert.equal(
      h.sends.filter((s) => /no \[DELIVERABLE\] arrived/.test(s.content)).length,
      0,
      'no host-authored deadline post',
    );

    // No repeat.
    h.state.nowMs = startMs + 12 * 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1);
  } finally {
    h.cleanup();
  }
});

test('P0-8: member correction message records an integrity event (deduped by pin)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-correction-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[CORRECTION] 更正：我此前的链接无效，正确预览如下',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const events = h.groupTaskStore.listIntegrityEvents(task.id);
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'correction');
    assert.equal(events[0].msgPinId, 'pin-correction-1');

    // GT#72: prose keywords (the old detector) never land on the ledger.
    insertGroupMessage(h.db, {
      pinId: 'pin-prose-noise', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '设计中"纠正权民主化"是原则之一，第八节为诚实声明。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listIntegrityEvents(task.id).length, 1, 'prose keyword noise never records');

    // [HONEST_REPORT] is the second declared kind.
    insertGroupMessage(h.db, {
      pinId: 'pin-honest-1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[HONEST_REPORT] 该 pinid 未发布成功，如实报告',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const allEvents = h.groupTaskStore.listIntegrityEvents(task.id);
    assert.equal(allEvents.length, 2);
    assert.equal(allEvents[1].eventType, 'honest_report');

    // same pin re-processed (retry) → no duplicate
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.listIntegrityEvents(task.id).length, 2, 'still correction + honest_report, no duplicates');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// C-1: chair auto-planning must cover >= 2 members (defensive check)
// ---------------------------------------------------------------------------

test('C-1: checkPlanningCoverage is advisory — a one-seat plan is legal', () => {
  const { checkPlanningCoverage } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const tenWorkers = ['AI_小新', 'Builder', 'Lucy', 'eleven', 'loop AI', '小明同学', '10th bot', '77', 'Stephen', 'claude-bot2'];

  const single = checkPlanningCoverage(
    'Plan: @AI_小新 you are the only worker, do everything. [STATUS:EXECUTING]',
    tenWorkers,
  );
  assert.equal(single.ok, true);
  assert.deepEqual(single.mentionedWorkers, ['AI_小新']);
  assert.ok(single.unmentionedWorkers.includes('Lucy'));

  const spread = checkPlanningCoverage(
    'Plan: @AI_小新 research, @Lucy copy, @Builder assemble; others standby. [STATUS:EXECUTING]',
    tenWorkers,
  );
  assert.equal(spread.ok, true);
  assert.ok(spread.mentionedWorkers.length >= 2);

  const singleWorkerRoster = checkPlanningCoverage('Plan: @Coder Bot do it', ['Coder Bot']);
  assert.equal(singleWorkerRoster.ok, true);
});

test('C-1: a one-seat plan posts immediately without a host coverage warning', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot, you are the only worker — do everything. [STATUS:EXECUTING]',
    disableChairPlanningTurn: false,
  });
  try {
    // Seated roster may be larger than the plan; extra names stay idle on purpose.
    const task = h.createTask([2, 3, 4], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'posted on the first planning turn');
    assert.doesNotMatch(h.sends[0].content, /Host warning/);
    assert.equal(h.store.get(`group_task_chair_plan_attempts:${task.id}`), undefined);
  } finally {
    h.cleanup();
  }
});

test('C-1: multi-worker plan posts immediately without warning', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design, @Reviewer Bot review. [STATUS:EXECUTING]',
  });
  try {
    const task = h.createTask([2, 3, 4], { activate: false });
    await h.loop.runTick();
    assert.equal(h.sends.length, 1);
    assert.doesNotMatch(h.sends[0].content, /Host warning/);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F1 (GT#11): the planning turn must not fire against a half-formed roster
// ---------------------------------------------------------------------------

test('F1: buildRosterSignature — stable roster => stable signature; any member change => new signature', () => {
  const { buildRosterSignature } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const rosterA = [
    { role: 'chair', name: 'Twin Bot', globalmetaid: 'gmid-twin', metabotId: 1 },
    { role: 'worker', name: 'Coder Bot', globalmetaid: 'gmid-w2', metabotId: 2 },
    { role: 'worker', name: 'Designer Bot', globalmetaid: 'gmid-w3', metabotId: 3 },
  ];
  const rosterAShuffled = [rosterA[2], rosterA[0], rosterA[1]];
  assert.equal(buildRosterSignature(rosterA), buildRosterSignature(rosterAShuffled), 'order-independent');
  const rosterMinusDesigner = rosterA.filter((m) => m.metabotId !== 3);
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterMinusDesigner), 'member removal changes the sig');
  const rosterWithReviewer = [...rosterA, { role: 'worker', name: 'Reviewer Bot', globalmetaid: 'gmid-w4', metabotId: 4 }];
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterWithReviewer), 'member add changes the sig');
  const rosterRoleChanged = rosterA.map((m) => (m.metabotId === 3 ? { ...m, role: 'chair' } : m));
  assert.notEqual(buildRosterSignature(rosterA), buildRosterSignature(rosterRoleChanged), 'role change changes the sig');
  const rosterRemote = [
    { role: 'worker', name: null, displayName: 'Alicia Remote', globalmetaid: 'gmid-remote', metabotId: null },
  ];
  assert.notEqual(buildRosterSignature([]), buildRosterSignature(rosterRemote), 'remote member shows up in the sig');
});

test('F1: chair planning waits for the roster to settle — mid-create ticks never misplan', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design, @Reviewer Bot review. [STATUS:EXECUTING]',
    chairPlanRosterSettleMs: 20_000,
    chairPlanRosterCapMs: 600_000,
  });
  try {
    // Simulate createGroupTask mid-flight: task row + chair + ONE worker.
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 1: roster still forming — no planning');
    assert.equal(h.sends.length, 0);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), undefined, 'planned flag not set while waiting');

    // More workers join as creation proceeds.
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 4, role: 'worker' });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 2: roster changed again — still deferred');

    // Roster now stable, but inside the settle window.
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'tick 3: roster stable but not yet settled');

    // Time passes the settle window: planning fires with the FULL roster.
    h.state.nowMs += 25_000;
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'tick 4: planning fires once the roster settled');
    assert.match(h.chatCalls[0].userMessage, /Assign each seated specialist their own coarse seat/, 'directive sees the settled roster');
    assert.match(h.chatCalls[0].userMessage, /Coder Bot \[worker\]/, 'full roster embedded in the directive');
    assert.match(h.chatCalls[0].userMessage, /Designer Bot \[worker\]/, 'full roster embedded in the directive');
    assert.equal(h.sends.length, 1);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

test('F1: planning proceeds after the absolute cap even if the roster never settles', async () => {
  const h = await createHarness({
    chatReply: 'Plan: @Coder Bot research, @Designer Bot design. [STATUS:EXECUTING]',
    chairPlanRosterSettleMs: 60_000,
    chairPlanRosterCapMs: 90_000,
  });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick(); // roster sig recorded (chair + Coder)
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    await h.loop.runTick(); // sig changed; re-recorded, still deferred
    // Pin the task creation to (harness now - 2h): the cap must override the
    // settle gate once the task is old enough.
    h.db.run(
      `UPDATE group_tasks SET created_at = strftime('%Y-%m-%d %H:%M:%S', 1000000000 - 7200, 'unixepoch') WHERE id = ?`,
      [task.id],
    );
    h.state.nowMs += 95_000; // past the 90s cap from creation
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'cap overrides the settle gate');
    assert.equal(h.sends.length, 1, 'plan posted despite an unsettled roster');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// F2 (GT#11): session-level driving mutex (pure helpers)
// ---------------------------------------------------------------------------

test('F2: tryAcquireGroupTaskDriver — acquire / own-refresh / foreign-reject / stale-takeover', () => {
  const { tryAcquireGroupTaskDriver } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const kv = new Map();
  const store = {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };

  const acquired = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 1_000);
  assert.equal(acquired.ok, true, 'no claim -> acquire');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|1000');

  const ownNoRefresh = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 2_000, false);
  assert.equal(ownNoRefresh.ok, true, 'own claim with refreshOwn=false still passes');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|1000', 'refreshOwn=false keeps the claim age-based');

  const ownRefresh = tryAcquireGroupTaskDriver(store, 7, 'rpc:1', 20_000, 3_000, true);
  assert.equal(ownRefresh.ok, true, 'own claim with refreshOwn=true passes');
  assert.equal(store.get('group_task_driver:7'), 'rpc:1|3000', 'refreshOwn=true extends the lease');

  const foreign = tryAcquireGroupTaskDriver(store, 7, 'daemon-uuid', 20_000, 4_000);
  assert.equal(foreign.ok, false, 'foreign fresh claim -> rejected');
  assert.equal(foreign.driverId, 'rpc:1');
  assert.equal(foreign.claimAgeMs, 1_000);
  assert.equal(foreign.retryAfterMs, 19_000);

  const stale = tryAcquireGroupTaskDriver(store, 7, 'daemon-uuid', 20_000, 30_000);
  assert.equal(stale.ok, true, 'stale claim -> takeover');
  assert.equal(store.get('group_task_driver:7'), 'daemon-uuid|30000');
});

test('F2: gateChairDrivingSend — worker sends pass; chair sends are mutually exclusive per session', () => {
  const { gateChairDrivingSend } = require('../dist-electron/main/services/groupTaskDaemon.js');
  const kv = new Map();
  const store = {
    get: (key) => kv.get(key),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
  };

  // Worker sends are never driving.
  assert.deepEqual(
    gateChairDrivingSend({ kv: store, taskId: 7, senderMetabotId: 2, chairMetabotId: 1, graceMs: 20_000, nowMs: 1_000 }),
    { ok: true },
  );

  // First chair send acquires the claim under its session id.
  const first = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-a', graceMs: 20_000, nowMs: 1_000,
  });
  assert.equal(first.ok, true);
  assert.equal(store.get('group_task_driver:7'), 'session-a|1000');

  // A DIFFERENT session is rejected with a readable error + retry hint.
  const second = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-b', graceMs: 20_000, nowMs: 2_000,
  });
  assert.equal(second.ok, false, 'second session rejected while the first drives');
  assert.match(second.error, /being driven by another session/);
  assert.match(second.error, /retry in 19s/);
  assert.equal(second.retryAfterMs, 19_000);
  assert.equal(second.driverId, 'session-a');

  // The SAME session id keeps driving (refreshes instead of rejection).
  const same = gateChairDrivingSend({
    kv: store, taskId: 7, senderMetabotId: 1, chairMetabotId: 1,
    driverId: 'session-a', graceMs: 20_000, nowMs: 5_000,
  });
  assert.equal(same.ok, true, 'same driver_id refreshes instead of being rejected');
  assert.equal(store.get('group_task_driver:7'), 'session-a|5000');

  // Omitted driver_id defaults to rpc:<chairMetabotId>.
  const byDefault = gateChairDrivingSend({
    kv: store, taskId: 8, senderMetabotId: 1, chairMetabotId: 1, graceMs: 20_000, nowMs: 9_000,
  });
  assert.equal(byDefault.ok, true);
  assert.equal(store.get('group_task_driver:8'), 'rpc:1|9000');
});

// ---------------------------------------------------------------------------
// F6 (GT#11): [STATUS:REVIEW] parsing chain — the P2-7 Twin-activity
// suppression window must never swallow the chair's status switch
// ---------------------------------------------------------------------------

test('F6: chair [STATUS:REVIEW] during the Twin-activity suppression window is still parsed', async () => {
  const h = await createHarness({ disableChairPlanningTurn: true });
  try {
    const task = h.createTask([2]); // executing

    // The Twin speaks proactively inside the 60s suppression window — any
    // daemon chair AUTO reply is suppressed from this point on.
    insertGroupMessage(h.db, {
      pinId: 'f6-twin-active-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '各位，这个任务我来主导。', chainTimestamp: 1_000_000_000,
    });
    // A worker deliverable arrives — the auto-verify reply would be suppressed.
    insertGroupMessage(h.db, {
      pinId: 'f6-dlv-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[DELIVERABLE] metaapp: metaapp://ababababababababababababababababababababababababababababababababi0',
      chainTimestamp: 1_000_000_005,
    });
    // The chair flips the task to REVIEW while the window is still active.
    insertGroupMessage(h.db, {
      pinId: 'f6-review-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '全部交付已核验\n[STATUS:REVIEW]', chainTimestamp: 1_000_000_010,
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'review',
      'chair status switch is parsed and applied despite the suppression window',
    );
    // Single-commander: no closing line and no auto replies at all — the
    // deliverable row still records, the status still flips.
    assert.equal(h.sends.length, 0, 'no chair auto replies and no host closing line');
    assert.equal(h.groupTaskStore.listDeliverables(task.id).length, 1, 'deliverable row still recorded');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// P1-4: [DEPENDS_ON] derived assignments inherit the upstream ACK (ack-seen)
// ---------------------------------------------------------------------------

/** Minimal sqlite-like mock: kv for ack-seen + a message-pin table. */
const makeDerivedSqlite = ({ upstreamMessageId = null, ackSeen = false } = {}) => {
  const kv = new Map();
  if (ackSeen) kv.set('group_task_ack_seen:7:101', '1');
  return {
    get: (key) => (kv.has(key) ? kv.get(key) : null),
    set: (key, value) => kv.set(key, value),
    delete: (key) => kv.delete(key),
    getDatabase: () => ({
      exec: (sql, params) => {
        if (upstreamMessageId != null && String(params?.[1]) === REAL_PINID_1) {
          return [{ values: [[upstreamMessageId]] }];
        }
        return [];
      },
    }),
  };
};

test('P1-4: resolveDerivedAssignmentUpstream returns null for non-derived messages', () => {
  const task = { id: 7, groupId: GROUP_ID };
  const sqlite = makeDerivedSqlite();
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: 'please do step 1' }, sqlite), null);
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: '[DEPENDS_ON: ' }, sqlite), null);
  assert.equal(resolveDerivedAssignmentUpstream(task, { content: '' }, sqlite), null);
});

test('P1-4: a descriptive [DEPENDS_ON] (no resolvable pinid) gets a normal watch (falsy)', () => {
  const task = { id: 7, groupId: GROUP_ID };
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: '[DEPENDS_ON: the upstream design]' }, makeDerivedSqlite()),
    '',
    'descriptive reference -> normal watch',
  );
  assert.equal(
    resolveDerivedAssignmentUpstream(
      task,
      { content: `[DEPENDS_ON: ${REAL_PINID_1}]` },
      makeDerivedSqlite({ upstreamMessageId: null }),
    ),
    '',
    'pinid not found in this group -> normal watch',
  );
});

test('P1-4: derived assignment inherits the upstream ACK only when ack-seen', () => {
  const task = { id: 7, groupId: GROUP_ID };
  const upstreamAcked = makeDerivedSqlite({ upstreamMessageId: 101, ackSeen: true });
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: `[DEPENDS_ON: ${REAL_PINID_1}]` }, upstreamAcked),
    REAL_PINID_1,
    'upstream ACKed -> inherits, no new watch',
  );
  const upstreamNotAcked = makeDerivedSqlite({ upstreamMessageId: 101, ackSeen: false });
  assert.equal(
    resolveDerivedAssignmentUpstream(task, { content: `[DEPENDS_ON: ${REAL_PINID_1}]` }, upstreamNotAcked),
    '',
    'upstream message exists but not ACKed -> normal watch',
  );
});

// ---------------------------------------------------------------------------
// P1-3: the chair planning directive carries pending invites / placeholders
// ---------------------------------------------------------------------------

test('P1-3: buildOpenTeamPlanningStatusBlock reports pending invites and placeholders', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2], { activate: false });
    const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
    const groupTaskStore = h.groupTaskStore;

    // Nothing to report -> empty block.
    assert.equal(buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore), '');
    assert.equal(buildOpenTeamPlanningStatusBlock(undefined, task, groupTaskStore), '', 'unwired store');

    // A live pending invite must appear with the "do not re-decompose" hint.
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-invitee',
      inviteeName: 'Fortune Bot',
      invitePinId: 'pending-pin-1',
    });
    const block = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.match(block, /Fortune Bot/);
    assert.match(block, /Do NOT plan a "search for a remote bot/);
    assert.match(block, /already invited/);

    // A placeholder member (no join pin, no pending invite) must appear too.
    groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-stale-placeholder',
      displayName: 'Stale Placeholder',
      role: 'worker',
      joinedPinId: null,
    });
    const block2 = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.match(block2, /Stale Placeholder/);
    assert.match(block2, /join never confirmed/);

    // A confirmed remote member (joined pin) is NOT a placeholder.
    groupTaskStore.addMember({
      taskId: task.id,
      metabotId: null,
      globalmetaid: 'gmid-confirmed-remote',
      displayName: 'Confirmed Remote',
      role: 'worker',
      joinedPinId: 'joined-pin-x',
    });
    const block3 = buildOpenTeamPlanningStatusBlock(membershipStore, task, groupTaskStore);
    assert.doesNotMatch(block3, /Confirmed Remote/);
  } finally {
    h.cleanup();
  }
});

test('P1-3: the planning directive embeds the OpenTeam block when invites are pending', async () => {
  const h = await createHarness();
  try {
    const membershipStore = new OpenTeamMembershipStore(h.db, h.store.getSaveFunction());
    // Wire the optional store getter (same shape main.ts passes).
    h.loop = h.makeLoop({
      getOpenTeamMembershipStore: () => membershipStore,
    });
    const task = h.createTask([2], { activate: false }); // planning
    membershipStore.createInvite({
      taskId: task.id,
      groupId: GROUP_ID,
      inviteeGlobalmetaid: 'gmid-remote-invitee',
      inviteeName: 'Fortune Bot',
      invitePinId: 'pending-pin-2',
    });
    await h.loop.runTick();

    assert.equal(h.sends.length, 1, 'chair posted exactly one plan');
    const planningCall = h.chatCalls[0];
    assert.match(planningCall.userMessage, /OpenTeam invites already sent/);
    assert.match(planningCall.userMessage, /Fortune Bot/);
    assert.match(planningCall.userMessage, /Do NOT plan a "search for a remote bot/);
  } finally {
    h.cleanup();
  }
});

test('P1-4: worker who spoke before the watch armed is not flagged at ACK timeout (implicit ACK)', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Cursor edge: the worker's speech message has a LOWER id than the
    // assignment, so it is processed first (no watch exists yet — clearPendingAck
    // is a no-op), and the assignment re-arms the watch afterwards. The worker
    // demonstrably spoke at the same chain second as the assignment, so the
    // watchdog must treat it as engaged instead of flagging it as not ACKed.
    insertGroupMessage(h.db, {
      pinId: 'pin-impack-s1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'on it, checking the sources',
      chainTimestamp: Math.ceil(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-impack-a1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const assignId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-impack-a1'])[0].values[0][0];
    const watch = JSON.parse(h.store.get(`group_task_ack_pending:${task.id}:2`));
    assert.equal(watch.messageId, assignId, 'watch armed by the assignment, not the speech');
    h.sends.length = 0;

    // Past the ACK timeout: the worker spoke at the assignment's chain second
    // (implicit ACK) → ack-seen recorded, watch cleared, NO chair reminder.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0, 'no no-ACK reminder for an engaged worker');
    assert.equal(h.store.get(`group_task_ack_seen:${task.id}:${assignId}`), '1', 'ack-seen recorded for the assignment');
    assert.equal(h.store.get(`group_task_ack_pending:${task.id}:2`), undefined, 'pending watch cleared (kv delete)');

    // Later ticks stay quiet — the reminder never fires.
    h.state.nowMs = startMs + 400_000;
    await h.loop.runTick();
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 清单 #10 P-A (groupTaskDaemon canonical path): a worker whose session did
// real work but ended with an EMPTY reply must fail the canonical attempt with
// WORKER_EMPTY_HANDOFF_WITH_ACTIVITY + summary, not an opaque bare code.
// ---------------------------------------------------------------------------
test('canonical: empty worker reply + substantive session activity → attempt fails with WORKER_EMPTY_HANDOFF_WITH_ACTIVITY', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    skillReply: '',
  });
  try {
    // The fake skill turn now also persists real-looking activity into the
    // task session (mimicking the real runner appending tool messages while
    // the worker worked) and ends with an empty final reply.
    const baseRunSkillTurn = h.deps.runSkillTurn;
    h.deps.runSkillTurn = async (params) => {
      const result = await baseRunSkillTurn(params);
      h.coworkStore.addMessage(params.sessionId, { type: 'assistant', content: 'Plan: implement the fix.' });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_use', content: 'Using tool: Edit', metadata: { toolName: 'Edit', toolInput: { file_path: 'src/a.ts' }, toolUseId: 'tu-1' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_result', content: 'Edited src/a.ts', metadata: { toolUseId: 'tu-1', isError: false, toolResult: 'Edited src/a.ts' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_use', content: 'Using tool: Bash', metadata: { toolName: 'Bash', toolInput: { command: 'npm test' }, toolUseId: 'tu-2' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'tool_result', content: '315/315 tests passed', metadata: { toolUseId: 'tu-2', isError: false, toolResult: '315/315 tests passed' } });
      h.coworkStore.addMessage(params.sessionId, { type: 'assistant', content: 'Progress: core fix done.' });
      return result; // replyText: ''
    };

    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'empty-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot implement the fix and report back',
    });
    await h.loop.runTick();

    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    assert.ok(canonicalId, 'canonical orchestration task linked');
    const canonical = h.orchestrationStore.getTask(canonicalId);
    const step = h.orchestrationStore.listSteps(canonical.id)[0];
    const attempt = h.orchestrationStore.listAttempts(step.id)[0];
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.error, /^WORKER_EMPTY_HANDOFF_WITH_ACTIVITY:/);
    assert.match(attempt.error, /files=\[src\/a\.ts\]/);
    assert.match(attempt.error, /tests=\[.*315\/315/);
    assert.match(attempt.error, /toolCalls=2/);
    // the activity the summary describes matches what the session recorded
    const sessionMessages = h.coworkStore.getSessionMessages(attempt.workerSessionId);
    assert.equal(sessionMessages.filter((m) => m.type === 'tool_use').length, 2);
  } finally {
    h.cleanup();
  }
});

test('canonical: empty worker reply + bare session keeps the plain WORKER_EMPTY_HANDOFF', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    skillReply: '',
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'bare-empty-i0', senderMetaId: 'metaid-h', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Human', content: '@Coder Bot quick question',
    });
    await h.loop.runTick();

    const canonicalId = h.groupTaskStore.getTaskById(task.id).orchestrationTaskId;
    const canonical = h.orchestrationStore.getTask(canonicalId);
    const step = h.orchestrationStore.listSteps(canonical.id)[0];
    const attempt = h.orchestrationStore.listAttempts(step.id)[0];
    assert.equal(attempt.status, 'failed');
    assert.equal(attempt.error, 'WORKER_EMPTY_HANDOFF');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Team culture injection (P3: shared coordination base)
// ---------------------------------------------------------------------------

test('planning directive and turn tail carry the team culture block', async () => {
  const h = await createHarness({
    buildTeamCultureBlock: () => '<team_culture>\nShared glossary (use these exact terms):\n- deliverable: An on-chain metafile with verification JSON.\n</team_culture>',
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();

    const planningCall = h.chatCalls[0];
    assert.match(planningCall.userMessage, /<team_culture>/);
    assert.match(planningCall.userMessage, /Shared glossary \(use these exact terms\):/,
      'the planning turn carries the culture block via the volatile tail');
    assert.equal(
      (planningCall.userMessage.match(/<team_culture>/g) ?? []).length,
      1,
      'exactly one culture block per turn — never duplicated by the directive',
    );
  } finally {
    h.cleanup();
  }
});

test('team culture block is omitted when the store is empty', async () => {
  const h = await createHarness({ buildTeamCultureBlock: () => null });
  try {
    const task = h.createTask([2], { activate: false });
    await h.loop.runTick();
    assert.doesNotMatch(h.chatCalls[0].userMessage, /<team_culture>/);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Entropy P1: cognition block TTL cache
// ---------------------------------------------------------------------------

const p1CognitionHarness = async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push({ observerGlobalMetaID: input.observerGlobalMetaID, roster: input.roster });
      return `<metaid_group_cognition>Observer: ${input.observerGlobalMetaID}</metaid_group_cognition>`;
    },
  });
  return { h, cognitionCalls };
};

const p1WorkerPing = (h, pinId, content) => insertGroupMessage(h.db, {
  pinId,
  senderMetaId: 'metaid-h',
  senderGlobalMetaId: 'gmid-boss',
  senderName: 'Human',
  content,
});

test('entropy P1: cognition block cached per (task, bot) within the TTL, rebuilt after expiry', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    h.createTask([2]);
    p1WorkerPing(h, 'p1-a-i0', '@Coder Bot go');
    await h.loop.runTick();
    h.state.nowMs += 21_000; // past the worker cooldown
    p1WorkerPing(h, 'p1-b-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      1,
      'second turn within the TTL reuses the cached block',
    );

    h.state.nowMs += 5 * 60_000 + 1_000; // past the cache TTL
    p1WorkerPing(h, 'p1-c-i0', '@Coder Bot third pass');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      2,
      'block rebuilt after the TTL expires',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: cognitionCache knob off restores per-turn rebuilds', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    h.store.set('groupTaskEntropyP1', JSON.stringify({ cognitionCache: false }));
    h.createTask([2]);
    p1WorkerPing(h, 'p1-d-i0', '@Coder Bot go');
    await h.loop.runTick();
    h.state.nowMs += 21_000;
    p1WorkerPing(h, 'p1-e-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      2,
      'knob off: every turn rebuilds',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: workerChairOnly knob off restores the full-roster worker cognition', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    h.store.set('groupTaskEntropyP1', JSON.stringify({ workerChairOnly: false }));
    h.createTask([2]);
    p1WorkerPing(h, 'p1-f-i0', '@Coder Bot go');
    await h.loop.runTick();
    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput);
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID).sort(),
      ['gmid-twin', 'gmid-w2'],
      'knob off: worker sees the full roster again',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1: the chair keeps the full-roster cognition for arbitration', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    h.createTask([2, 3]);
    // Unaddressed floor-control message from a non-owner triggers a chair turn.
    insertGroupMessage(h.db, {
      pinId: 'p1-g-i0',
      senderMetaId: 'metaid-w2',
      senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '环境已就绪，随时可以开工',
    });
    await h.loop.runTick();
    const chairInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-twin');
    assert.ok(chairInput, 'chair turn ran');
    assert.deepEqual(
      chairInput.roster.map((member) => member.globalMetaID).sort(),
      ['gmid-twin', 'gmid-w2', 'gmid-w3'],
      'chair cognition covers the whole roster',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: mid-TTL member join rebuilds the chair block; the worker chair-only view stays cached', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    const task = h.createTask([2]);
    p1WorkerPing(h, 'p1-r1-i0', '@Coder Bot go');
    await h.loop.runTick();
    assert.equal(cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-twin').length, 1);
    assert.equal(cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length, 1);

    h.state.nowMs += 21_000; // inside the TTL, past cooldowns
    h.groupTaskStore.addMember({ taskId: task.id, metabotId: 3, role: 'worker' });
    p1WorkerPing(h, 'p1-r2-i0', '@Coder Bot go again');
    await h.loop.runTick();
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-twin').length,
      2,
      'chair roster changed (join) -> fingerprint miss -> rebuild',
    );
    assert.equal(
      cognitionCalls.filter((call) => call.observerGlobalMetaID === 'gmid-w2').length,
      1,
      'worker chair-only view unaffected by a peer join -> stays cached',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: chair replaced mid-TTL rebuilds the worker block with the new chair entry', async () => {
  const { h, cognitionCalls } = await p1CognitionHarness();
  try {
    const task = h.createTask([2]);
    p1WorkerPing(h, 'p1-r3-i0', '@Coder Bot go');
    await h.loop.runTick();

    h.state.nowMs += 21_000; // inside the TTL
    h.db.run(
      'UPDATE group_task_members SET globalmetaid = ? WHERE task_id = ? AND role = ?',
      ['gmid-twin-2', task.id, 'chair'],
    );
    h.db.run('UPDATE metabots SET globalmetaid = ? WHERE id = 1', ['gmid-twin-2']);
    p1WorkerPing(h, 'p1-r4-i0', '@Coder Bot go again');
    await h.loop.runTick();

    const workerInputs = cognitionCalls.filter((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.equal(workerInputs.length, 2, 'chair change invalidates the cached worker block');
    assert.deepEqual(
      workerInputs[1].roster.map((member) => member.globalMetaID),
      ['gmid-twin-2'],
      'rebuilt with the NEW chair entry',
    );
  } finally {
    h.cleanup();
  }
});

test('entropy P1 review: chair without a globalMetaID falls back to the full-roster worker cognition', async () => {
  const cognitionCalls = [];
  const h = await createHarness({
    getMetaIDGroupCognitionPromptBlock: async (input) => {
      cognitionCalls.push(input);
      return '<metaid_group_cognition>ok</metaid_group_cognition>';
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_task_members SET globalmetaid = NULL WHERE task_id = ? AND role = ?', [task.id, 'chair']);
    h.db.run('UPDATE metabots SET globalmetaid = NULL WHERE id = 1');
    p1WorkerPing(h, 'p1-r5-i0', '@Coder Bot go');
    await h.loop.runTick();
    const workerInput = cognitionCalls.find((input) => input.observerGlobalMetaID === 'gmid-w2');
    assert.ok(workerInput, 'worker turn ran');
    assert.deepEqual(
      workerInput.roster.map((member) => member.globalMetaID),
      ['gmid-w2'],
      'chair-only filter would be empty -> full roster fallback keeps a non-empty view',
    );
  } finally {
    h.cleanup();
  }
});

test('task #60 (single-commander): a numberless ACK arms nothing without a chair-stated deadline; a stated one arms from the tag', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const startMs = h.state.nowMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-t1', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // Numberless ACK — exactly what the entropy-P0 template posts.
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-t1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在处理「build the metaapp」，预计需要一些时间。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // Single-track deadlines: the assignment states no [DEADLINE], so the
    // host invents no clock — the missing deadline is the chair's sequencing
    // gap (its playbook requires one on every assignment).
    assert.equal(
      h.store.get('group_task_expected_delivery:1:2'),
      undefined,
      'no default deadline invented for a deadline-less assignment',
    );

    // Control: with a chair-stated deadline the numberless ACK still arms it.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-t2', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot extend it with charts [DEADLINE: 30m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 1,
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-t2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，继续处理。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    await h.loop.runTick();
    const entry = JSON.parse(h.store.get('group_task_expected_delivery:1:2'));
    assert.equal(entry.dueAt, h.state.nowMs + 30 * 60_000, 'chair-stated 30-minute deadline armed');

    // Past the stated deadline with no deliverable: ONE environment note
    // (the bell), never a host group post.
    h.state.nowMs += 31 * 60_000;
    await h.loop.runTick();
    const deadlineNotes = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(deadlineNotes, 1, 'missed chair-stated deadline rang one bell');
    assert.equal(
      h.sends.filter((send) => /estimated delivery/.test(send.content)).length,
      0,
      'the host posts no ⚠ line — the chair speaks for itself',
    );
  } finally {
    h.cleanup();
  }
});

test('task #51: implicit ACK by message-id order — a watch armed after the reply synced never alarms', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // The worker's reply synced BEFORE the chair's assignment row (chain
    // relay/indexer skew), so the cursor processed it with no watch to clear;
    // the assignment then armed a watch whose daemon-local assignedAt
    // postdates the reply — the pre-fix false alarm. On-chain the reply
    // genuinely ANSWERS the assignment (its chain second is strictly later);
    // only the sync order was inverted.
    insertGroupMessage(h.db, {
      pinId: 'pin-skew-reply', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '收到，我来看一下',
      chainTimestamp: Math.floor(startMs / 1000) + 1,
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-skew-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const assignId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-skew-assign'])[0].values[0][0];
    const replyId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-skew-reply'])[0].values[0][0];
    assert.ok(replyId < assignId, 'reply synced first (lower id)');
    assert.ok(h.store.get(`group_task_ack_pending:${task.id}:2`), 'watch armed by the late-synced assignment');
    h.sends.length = 0;

    // Past the ACK timeout: the reply's chain second is strictly later than
    // the assignment's, so chain order proves engagement — daemon-local
    // processing time is irrelevant.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => /has not sent a \[WORKING\] ACK/.test(s.content)).length,
      0,
      'no no-ACK reminder for a worker who already replied',
    );
    assert.equal(h.store.get(`group_task_ack_seen:${task.id}:${assignId}`), '1', 'ack-seen recorded');
    assert.equal(h.store.get(`group_task_ack_pending:${task.id}:2`), undefined, 'watch cleared');
  } finally {
    h.cleanup();
  }
});

test('task #51: implicit ACK by message-id — a higher-id reply behind a manually stale watch clears it', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    insertGroupMessage(h.db, {
      pinId: 'pin-idc-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const assignId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-idc-assign'])[0].values[0][0];

    // The reply carries an EARLIER chain second (clock skew between relays)
    // but a HIGHER row id; simulate the watch surviving its processing (e.g.
    // the reply arrived flagged suspect, or the handler missed the member
    // match) by re-arming the watch manually afterwards.
    insertGroupMessage(h.db, {
      pinId: 'pin-idc-reply', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'on it',
      chainTimestamp: Math.floor(startMs / 1000) - 5,
    });
    const replyId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-idc-reply'])[0].values[0][0];
    assert.ok(replyId > assignId, 'reply has the higher row id');
    const cursorId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, cursorId);
    h.store.set(
      `group_task_ack_pending:${task.id}:2`,
      JSON.stringify({ assignedAt: startMs, messageId: assignId, assignedChainSec: Math.floor(startMs / 1000) }),
    );
    h.sends.length = 0;

    // Chain-second comparison says "earlier" (skewed), but the message-id
    // comparison proves the reply postdates the assignment — implicit ACK.
    h.state.nowMs = startMs + 200_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => /has not sent a \[WORKING\] ACK/.test(s.content)).length,
      0,
      'message-id order rescues a chain-clock-skewed reply',
    );
    assert.equal(h.store.get(`group_task_ack_seen:${task.id}:${assignId}`), '1');
    assert.equal(h.store.get(`group_task_ack_pending:${task.id}:2`), undefined);
  } finally {
    h.cleanup();
  }
});

test('task #51 obligation gate: idle members are never stamped unreachable; a bogus stamp is lifted', async () => {
  const h = await createHarness({ memberUnreachableAfterMinutes: 5 });
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;

    // Worker 2 carries a bogus legacy stamp (older builds stamped
    // delivered-then-idle members — cf. Lucy in task #51) and has NO
    // outstanding obligation: the monitor lifts it immediately, without
    // waiting for fresh liveness.
    h.groupTaskStore.setMemberStatus(task.id, 2, 'unreachable', 'gmid-w2');
    // Worker 3 is plainly idle: assigned to the task but never given work,
    // never spoke — silence is the normal state, not a failure.

    h.state.nowMs = startMs + 30 * 60_000;
    await h.loop.runTick();
    const members = h.groupTaskStore.listMembers(task.id);
    assert.equal(
      members.find((m) => m.metabotId === 2).status,
      'working',
      'bogus stamp lifted immediately (no obligation, no liveness needed)',
    );
    assert.equal(
      members.find((m) => m.metabotId === 3).status,
      'assigned',
      'an idle member with no obligation is never stamped unreachable',
    );
  } finally {
    h.cleanup();
  }
});

test('P1-2: a dispatch swallowed by an open checkpoint posts a dispatch_held notice, workers stay silent', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id,
      topic: 'owner 需在火山方舟开通 doubao-seedance-2-0',
      msgPinId: 'pin-checkpoint',
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-held-dispatch', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '账号已开通，@Coder Bot 继续 7 镜动画，@Designer Bot 对齐素材。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    // Workers are gated silent by the open checkpoint: no worker replies.
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2 || send.metabotId === 3).length,
      0,
      'workers stay silent while the checkpoint is open',
    );
    // Single-commander: the held-dispatch FACT reaches the chair as an
    // environment note (once per held message); nothing posts in the group.
    const heldNotes = () => h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'dispatch_held');
    assert.equal(heldNotes().length, 1, 'exactly one dispatch-held note recorded');
    assert.match(heldNotes()[0].body, /Coder Bot/);
    assert.match(heldNotes()[0].body, /CHECKPOINT_RESOLVED/);
    assert.match(heldNotes()[0].body, /doubao-seedance-2-0/, 'note carries the checkpoint topic');
    // A second idempotent tick must not re-record the note for the same message.
    await h.loop.runTick();
    const allHeld = Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'dispatch_held'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(allHeld, 1, 'note recorded once per held message');
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id), 'checkpoint still open');
  } finally {
    h.cleanup();
  }
});

test('Task #83 F3: an open checkpoint gone stale after the owner\'s reply reminds the chair (once)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id, topic: 'UI 范围与删除授权', msgPinId: 'pin-f3-open',
    });
    // The owner replies in the group with a ruling, but nobody posts
    // [CHECKPOINT_RESOLVED:] — the gate stays closed (task #84's 24-min idle).
    insertGroupMessage(h.db, {
      pinId: 'pin-f3-ruling', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: '范围按 A 方案，删除授权批准。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const stallNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'checkpoint_stall'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(stallNotes(), 0, 'inside the grace window the pause is legitimate');

    h.state.nowMs += 11 * 60_000;
    await h.loop.runTick();
    assert.equal(stallNotes(), 1, 'a stale unresolved checkpoint after the owner reply reaches the chair');
    const note = h.db.exec(
      "SELECT body FROM group_task_host_notes WHERE task_id = ? AND kind = 'checkpoint_stall'",
      [task.id],
    )[0].values[0][0];
    assert.match(note, /CHECKPOINT_RESOLVED/);
    assert.match(note, /UI 范围与删除授权/, 'the note names the checkpoint topic');

    // kv-guarded: the same checkpoint never re-notes.
    h.state.nowMs += 60_000;
    await h.loop.runTick();
    assert.equal(stallNotes(), 1, 'one stall note per checkpoint');
  } finally {
    h.cleanup();
  }
});

test('Task #83 F3: an open checkpoint with NO owner reply re-reminds the owner on a bounded ladder', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: (m) => { milestones.push(m); return true; },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-f3', task.id]);
    h.state.nowMs = Date.now();
    const checkpoint = h.groupTaskStore.openCheckpoint({
      taskId: task.id, topic: 'draft approval', msgPinId: 'pin-f3b-open',
    });
    await h.loop.runTick();
    assert.equal(milestones.filter((m) => m.subject?.startsWith('checkpoint_stall:')).length, 0);

    // 46 min of total silence: the opening notice may have been missed.
    h.state.nowMs += 46 * 60_000;
    await h.loop.runTick();
    const stallReminders = () => milestones.filter(
      (m) => m.kind === 'checkpoint' && typeof m.subject === 'string' && m.subject.startsWith('checkpoint_stall:'),
    );
    assert.equal(stallReminders().length, 1, 'first owner re-reminder at 45 min');
    assert.match(stallReminders()[0].message, /draft approval/);
    assert.match(stallReminders()[0].message, /reminder #1|第 1 次提醒/, 'the rung is named in the notice');
    // The same rung also re-sends on the chair→owner private channel (the
    // origin-session note alone never reached the owner in task #94).
    const privateReminders = () => h.ownerReportCalls.filter((c) => c.kind === 'checkpoint');
    assert.equal(privateReminders().length, 1, 'rung #1 re-sends the private A2A reminder');
    assert.match(privateReminders()[0].text, /draft approval/);

    // Inside the window: no early repeat.
    h.state.nowMs += 60_000;
    await h.loop.runTick();
    assert.equal(stallReminders().length, 1, 'no repeat inside the 45-min window');

    // Rungs #2…#4 land every 45 min while the owner stays silent.
    h.state.nowMs += 45 * 60_000;
    await h.loop.runTick();
    assert.equal(stallReminders().length, 2, 'rung #2 after another 45 min');
    h.state.nowMs += 45 * 60_000;
    await h.loop.runTick();
    h.state.nowMs += 45 * 60_000;
    await h.loop.runTick();
    assert.equal(stallReminders().length, 4, 'the ladder climbs while the owner is silent');
    assert.equal(privateReminders().length, 4, 'every rung re-sends the private reminder');

    // Bounded: past the cap the ladder stops (the task view carries the wait).
    h.state.nowMs += 45 * 60_000;
    await h.loop.runTick();
    assert.equal(stallReminders().length, 4, 'the ladder is capped — no rung #5');
    assert.equal(privateReminders().length, 4, 'private reminders stop at the cap too');
  } finally {
    h.cleanup();
  }
});

test('task #94: an owner reply to an open checkpoint preempts the chair\'s lingering session', async () => {
  const stoppedSessions = [];
  const h = await createHarness({
    deps: {
      stopWorkerSession: (sessionId) => stoppedSessions.push(sessionId),
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const checkpoint = h.groupTaskStore.openCheckpoint({
      taskId: task.id, topic: '像素实读门的关闭方式', msgPinId: 'pin-t94-open',
    });
    // The chair's group-task session is still monopolized by the pre-checkpoint
    // turn (task #94: the chair opened the checkpoint mid-turn, then kept
    // running 10-min download probes — the owner's ruling sat behind the
    // 45-min session-busy hold).
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 1, 'Twin Bot');
    h.coworkStore.updateSession(session.id, { status: 'running' });
    insertGroupMessage(h.db, {
      pinId: 'pin-t94-ruling', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'B',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    await h.loop.runTick();
    assert.deepEqual(stoppedSessions, [session.id], 'the owner reply aborts the lingering chair turn');
    assert.equal(
      h.store.get(`group_task_checkpoint_owner_preempted:${task.id}:${checkpoint.id}`),
      '1',
      'the preemption is kv-stamped',
    );

    // Once per checkpoint: later ticks never re-stop the session.
    await h.loop.runTick();
    assert.equal(stoppedSessions.length, 1, 'preemption fires once per checkpoint');
  } finally {
    h.cleanup();
  }
});

test('task #94: owner silence with an IDLE chair session never preempts', async () => {
  const stoppedSessions = [];
  const h = await createHarness({
    deps: {
      stopWorkerSession: (sessionId) => stoppedSessions.push(sessionId),
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id, topic: 'gate', msgPinId: 'pin-t94c-open',
    });
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 1, 'Twin Bot');
    // Session idle (default status) — nothing to preempt even though the owner replies.
    insertGroupMessage(h.db, {
      pinId: 'pin-t94c-ruling', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Boss', content: 'A',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    await h.loop.runTick();
    assert.equal(stoppedSessions.length, 0, 'no preemption when the chair session is idle');
  } finally {
    h.cleanup();
  }
});

test('task #94: a signal turn deferred by an open checkpoint is not drive activity (no phantom heartbeat)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const oldSec = Math.floor(h.state.nowMs / 1000) - 3600;
    h.groupTaskStore.updateLastDrivenAt(task.id, oldSec);
    h.groupTaskStore.addSupervisorSignal({ taskId: task.id, kind: 'nudge', note: 'status please' });
    h.groupTaskStore.openCheckpoint({ taskId: task.id, topic: 'gate', msgPinId: 'pin-t94b-open' });
    await h.loop.runTick();
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastDrivenAt,
      oldSec,
      'a signal turn that only defers to the human gate must not refresh lastDrivenAt',
    );
    assert.equal(h.chatCalls.length + h.skillTurnCalls.length, 0, 'no chair LLM work was dispatched');
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      1,
      'the signal stays pending for the first post-checkpoint tick',
    );
  } finally {
    h.cleanup();
  }
});

test('task #94: a busy-but-silent chair session only delays the no-progress nudge up to the stall window', async () => {
  const h = await createHarness({
    deps: { noProgressNudgeMs: 60_000, noProgressStallMs: 300_000 },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 1, 'Twin Bot');
    const refreshSession = () => h.db.run(
      'UPDATE cowork_sessions SET updated_at = ? WHERE id = ?',
      [h.state.nowMs - 5_000, session.id],
    );
    refreshSession();
    insertGroupMessage(h.db, {
      pinId: 'pin-t94d-last', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'working on it',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 200, // 200s idle: past the nudge window, inside the stall window
    });
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'inside the stall window a recently-active chair session still suppresses the nudge',
    );

    // Past the stall window with zero group output, the chair owes a status
    // report no matter how busy its session looks (task #94's 51-min silence).
    h.state.nowMs += 200_000; // idle is now 400s > 300s stall window
    refreshSession(); // the session still looks busy
    await h.loop.runTick();
    const pending = h.groupTaskStore.listPendingSupervisorSignals(task.id);
    assert.equal(pending.length, 1, 'the nudge fires once the stall window is exceeded');
    assert.equal(pending[0].kind, 'nudge');
  } finally {
    h.cleanup();
  }
});

test('P1-2: a review-phase dispatch posts a dispatch_held notice with the reopen instruction', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    insertGroupMessage(h.db, {
      pinId: 'pin-review-dispatch', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot one more fix before we close.',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2).length,
      0,
      'workers stay silent in review',
    );
    const heldNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'dispatch_held');
    assert.equal(heldNotes.length, 1);
    assert.match(heldNotes[0].body, /STATUS:EXECUTING/, 'review variant explains the reopen path');
    assert.equal(h.sends.length, 0, 'nothing posted in the group');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review', 'task stays in review');
  } finally {
    h.cleanup();
  }
});

test('P1-2: host notices citing protocol tags are never re-interpreted as those tags', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    h.groupTaskStore.openCheckpoint({
      taskId: task.id,
      topic: 'waiting for owner decision',
      msgPinId: 'pin-checkpoint-2',
    });
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    // The dispatch-held notice body itself, arriving on-chain from the chair:
    // it cites [CHECKPOINT_RESOLVED: …] and [STATUS:EXECUTING] as INSTRUCTIONS.
    insertGroupMessage(h.db, {
      pinId: 'pin-notice-roundtrip', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: [
        '[GROUP_TASK_NOTICE:dispatch_held]',
        '⏸️ A dispatch was HELD: a human checkpoint is open (waiting for owner decision).',
        'Once the owner has weighed in, post `[CHECKPOINT_RESOLVED: <decision>]` in the group.',
        'Reopen execution with `[STATUS:EXECUTING]` (or the Tasks panel Back-to-work action).',
      ].join('\n'),
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.groupTaskStore.getOpenCheckpoint(task.id), 'cited CHECKPOINT_RESOLVED did not resolve the checkpoint');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review', 'cited STATUS:EXECUTING did not reopen the task');
  } finally {
    h.cleanup();
  }
});

test('review fix (single-commander): a fresh chair deadline re-arms a fresh bell cycle', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    const ack = (pin) => insertGroupMessage(h.db, {
      pinId: pin, senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] doing X，预计10分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Single-track deadlines: the chair states the clock.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-ack', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do X [DEADLINE: 10m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    ack('pin-ack-1');
    await h.loop.runTick();
    // Past the first deadline with no deliverable -> one bell.
    h.state.nowMs += 11 * 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1);
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), '1');

    // The chair re-dispatches with a fresh deadline: the reminded flag from
    // the previous miss must reset, or the next cycle's bell is suppressed.
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-ack-2', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do X again [DEADLINE: 5m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    ack('pin-ack-2');
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined, 'reminded flag reset on re-arm');

    h.state.nowMs += 6 * 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 2, 'second deadline miss fires its own bell');
  } finally {
    h.cleanup();
  }
});

test('review fix (single-commander): a delivered (even late) deliverable retires the deadline watch', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-late', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do X [DEADLINE: 10m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-late', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] doing X，预计10分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 11 * 60_000;
    await h.loop.runTick(); // bell rang
    assert.equal(deadlineNotes(), 1);

    // LATE deliverable lands: both kv keys retire — later ticks see no
    // outstanding deadline at all.
    insertGroupMessage(h.db, {
      pinId: 'pin-deliver-late', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] metaapp: metaapp://${'ab'.repeat(32)}i0`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined, 'deadline entry retired on delivery');
    assert.equal(h.store.get('group_task_delivery_reminded:1:2'), undefined, 'reminded flag retired on delivery');

    h.state.nowMs += 30 * 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1, 'no further bells after the deliverable arrived');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #41: a welcome/roll-call notice @mentions every member but is not a
// work assignment — it must not trigger the worker auto-ACK (whose invented
// ETA then armed fake delivery deadlines).
// ---------------------------------------------------------------------------

test('task #41: a chair welcome notice triggers no auto-ACK and arms no delivery deadline', async () => {
  // The auto-ACK only fires on the skill-turn path (P0-2: it exists because a
  // skill turn can run for many minutes), so Coder Bot needs a routing hit to
  // reach maybeSendWorkerAck at all.
  const h = await createHarness({
    ackTimeoutMs: 180_000,
    coderChatSkills: ['web-search'],
    routing: (input) => input.metabotId === 2
      ? { prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }
      : { prompt: null, activeSkillIds: [] },
  });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    // The host posts the join welcome as the chair; it @mentions every member
    // but is a [GROUP_TASK_NOTICE:welcome] roll call, not a work assignment.
    insertGroupMessage(h.db, {
      pinId: 'pin-welcome-41', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: buildMemberJoinWelcomeText({
        taskTitle: 'Build MetaApp',
        joinerName: 'Coder Bot',
        existingMemberNames: ['Twin Bot', 'Designer Bot'],
      }, 'zh'),
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    // Both workers still answer the roll call with a normal reply…
    assert.equal(h.sends.length, 2, 'workers still answer the roll call normally');
    // …but neither may post the bogus "[WORKING] 已接单" auto-ACK whose invented
    // ETA armed the fake delivery deadlines seen in task #41.
    assert.equal(
      h.sends.filter((s) => s.content.startsWith('[WORKING]')).length,
      0,
      'no auto-ACK posted for a host welcome notice',
    );
    assert.equal(h.store.get(`group_task_expected_delivery:${task.id}:2`), undefined);
    assert.equal(h.store.get(`group_task_expected_delivery:${task.id}:3`), undefined);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #41: a skill-turn watchdog timeout is not a transient failure — the
// turn keeps running in the worker session, so advance the cursor instead of
// piling up retries that re-ran the turn five times and dropped the trigger.
// ---------------------------------------------------------------------------

test('task #41: a skill-turn watchdog timeout advances the cursor without burning message retries', async () => {
  const skillTurnAttempts = [];
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      // The watchdog fires while the real turn keeps running in the session.
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        throw new SkillTurnTimeoutError('session-timeout-41', 300_000);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-skill-timeout-41', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot search for MetaID docs',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(skillTurnAttempts.length, 1, 'skill turn attempted once');
    // Single-commander: no host auto-ACK exists — nothing posts on the
    // worker's behalf before the turn runs.
    assert.equal(h.sends.filter((s) => s.content.startsWith('[WORKING]')).length, 0, 'no auto-ACK');
    const msgId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-skill-timeout-41'])[0].values[0][0];
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).lastProcessedMsgId, msgId,
      'cursor advanced past the timed-out message',
    );
    assert.equal(
      h.store.get(`group_task_msg_retry:${task.id}:${msgId}`),
      undefined,
      'watchdog fire is not a transient failure — no retry counter burned',
    );
    // GT-01: the unanswered trigger is re-queued DURABLY at latch time (the
    // pre-fix latch dropped it silently, so a provider outage never recovered).
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'watchdog-timed-out trigger re-queued in the durable defer queue');
    assert.equal(queued[0].messageId, msgId);
    assert.equal(queued[0].metabotId, 2);
    assert.equal(queued[0].failures, 1);

    // While the latch is up the in-flight guard still blocks the drain: the
    // same turn must not re-run (the pre-fix pile-up re-ran it five times and
    // then dropped the trigger message unanswered).
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'latched turn is not re-dispatched while latched');
    const queuedAgain = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queuedAgain.length, 1, 'the trigger stays queued behind the latch');
  } finally {
    h.cleanup();
  }
});

test('task #60: a transient error session status never re-dispatches while the runner turn is still active', async () => {
  const skillTurnAttempts = [];
  const logs = [];
  let runnerActive = true;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      // The runner still holds the live turn handle for the session.
      isCoworkSessionActive: () => runnerActive,
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        return { replyText: 'done', assistantMessageId: null };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // The worker's task session transiently reads 'error' — the skill-turn
    // bridge stamps 'error' at the watchdog fire while the runner keeps
    // executing the original turn (the task #60 re-dispatch incident).
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.coworkStore.updateSession(session.id, { status: 'error' });
    insertGroupMessage(h.db, {
      pinId: 'pin-t60-redrive-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot search for MetaID docs',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 0, 'no second turn while the runner reports the session active');
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'the trigger is held in the durable queue, not dispatched');
    assert.ok(
      logs.some((line) => line.includes('still running a prior turn')),
      'the session-busy hold is logged',
    );

    // Once the runner turn actually terminates, the next tick re-drives the
    // held trigger normally.
    runnerActive = false;
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'trigger re-dispatched after the original turn terminated');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P1): a watchdog-detached turn keeps running inside the session and
// appends its final assistant reply on settle — but the dispatching job had
// already returned, so nobody posted it. GT#87 lost a whole first-bat
// delivery announcement ([WORKING→完成] + [DELIVERABLE]) this way; only the
// model's own [CORRECTION] on the deferred re-drive rescued it. On latch
// release the daemon must harvest the settled reply, deliver it to the
// group, and retire the durable re-drive entry for the answered trigger.
// ---------------------------------------------------------------------------

test('GT#87: a settled watchdog-detached turn has its final reply harvested and delivered — no re-drive', async () => {
  const logs = [];
  const skillTurnAttempts = [];
  let runnerActive = false;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      isCoworkSessionActive: () => runnerActive,
      latchWatchIntervalMs: 15,
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        runnerActive = true; // the detached runner keeps the turn alive past the watchdog
        throw new SkillTurnTimeoutError('session-timeout-gt87', 300_000);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    const triggerPin = 'pin-gt87-harvest-i0';
    insertGroupMessage(h.db, {
      pinId: triggerPin, senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot implement the first baton',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'the detached turn ran once');
    let queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'trigger durably re-queued behind the latch');

    // The runner finishes the detached turn: it appends the final assistant
    // reply to the session, then the session leaves 'running'.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    const finalReply = '[WORKING→完成] first baton landed.\n\n[DELIVERABLE] pin://' + 'ab'.repeat(32) + 'i0';
    h.coworkStore.addMessage(session.id, { type: 'assistant', content: finalReply });
    h.coworkStore.updateSession(session.id, { status: 'completed' });
    runnerActive = false;

    // Wait for the latch watcher (15ms interval) to release + harvest, and
    // for the detached on-chain send to land.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !h.sends.some((s) => s.content === finalReply)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const harvested = h.sends.find((s) => s.content === finalReply);
    assert.ok(harvested, 'the detached turn\'s final reply was harvested and delivered to the group');
    assert.equal(harvested.metabotId, 2, 'delivered as the worker');
    assert.equal(harvested.replyPin, triggerPin, 'threaded under the trigger');
    queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 0, 'the answered trigger\'s re-drive entry retired');
    assert.ok(
      logs.some((line) => line.includes("harvested and delivered bot 2's detached-turn final reply")),
      'harvest is logged',
    );
    // And the drain must NOT re-run the turn afterwards.
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'no re-drive after the harvest retired the entry');
  } finally {
    h.cleanup();
  }
});

test('GT#87: a detached turn that settles silent retires the re-drive without posting', async () => {
  const logs = [];
  const skillTurnAttempts = [];
  let runnerActive = false;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      isCoworkSessionActive: () => runnerActive,
      latchWatchIntervalMs: 15,
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        runnerActive = true; // the detached runner keeps the turn alive past the watchdog
        throw new SkillTurnTimeoutError('session-timeout-gt87b', 300_000);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-gt87-silent-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot standby check',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1);
    // The turn settles with an explicit [NO_REPLY] final.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.coworkStore.addMessage(session.id, { type: 'assistant', content: '[NO_REPLY]' });
    h.coworkStore.updateSession(session.id, { status: 'completed' });
    runnerActive = false;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !logs.some((line) => line.includes('re-drive retired'))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      logs.some((line) => line.includes('settled silent') && line.includes('re-drive retired')),
      'the silent settle retires the re-drive and says so',
    );
    assert.equal(h.sends.length, 0, 'nothing is posted for a silent settle');
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 0, 're-drive entry retired');
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'no re-drive after the silent settle');
  } finally {
    h.cleanup();
  }
});

test('GT#87 audit: a cap-forced latch release while the turn still runs skips the harvest — an interim message is not the final reply', async () => {
  const logs = [];
  const skillTurnAttempts = [];
  let runnerActive = false;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      isCoworkSessionActive: () => runnerActive,
      latchWatchIntervalMs: 15,
      turnHardCapMs: 120, // force the cap while the detached runner is still going
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        runnerActive = true; // and it NEVER settles inside this test
        throw new SkillTurnTimeoutError('session-timeout-gt87cap', 300_000);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-gt87-cap-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot deliver the second baton',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'the detached turn ran once');

    // The runner streams an INTERIM narration mid-turn (every text event is
    // appended as an assistant message while the turn keeps executing).
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    const interim = '进度：正在核对断言清单……';
    h.coworkStore.addMessage(session.id, { type: 'assistant', content: interim });
    // Session stays active; only the latch cap releases the guard. The daemon
    // clock is the harness's frozen state clock, so advance it past the cap.
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !logs.some((line) => line.includes('harvest skipped'))) {
      h.state.nowMs += 50;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      logs.some((line) => line.includes('harvest skipped') && line.includes('not a final reply')),
      'the skip is on the record',
    );
    assert.ok(
      !h.sends.some((s) => s.content === interim),
      'the interim narration must never be posted as the member\'s answer',
    );
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'the durable re-drive stands so the real final reply still gets delivered');

    // When the re-drive later runs, the trigger is not lost.
    runnerActive = false;
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 2, 'the deferred re-drive picks the trigger back up');
  } finally {
    h.cleanup();
  }
});

test('GT#87: a detached turn with NO settled reply keeps the re-drive (pre-fix recovery intact)', async () => {
  const logs = [];
  const skillTurnAttempts = [];
  let runnerActive = false;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      isCoworkSessionActive: () => runnerActive,
      latchWatchIntervalMs: 15,
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        runnerActive = true; // the detached runner keeps the turn alive past the watchdog
        throw new SkillTurnTimeoutError('session-timeout-gt87c', 300_000);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-gt87-noreply-yet-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot another check',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // The runner dies without settling any final assistant message.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.coworkStore.updateSession(session.id, { status: 'error' });
    runnerActive = false;

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !logs.some((line) => line.includes('left no settled reply'))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(
      logs.some((line) => line.includes('left no settled reply')),
      'the empty settle leaves the re-drive standing',
    );
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 're-drive entry survives for the drain to recover');
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 2, 'the trigger is re-driven as before');
  } finally {
    h.cleanup();
  }
});

test('GT-01: a wedged turn (await never settles) is force-settled at the hard cap and the trigger recovers', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
    deps: { turnHardCapMs: 500, intervalMs: 20 },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // The first group send (the worker auto-ACK) never settles — the wedged
    // await that used to leak the in-flight guard forever.
    const realPost = h.deps.postGroupTaskMessage;
    let postCalls = 0;
    h.deps.postGroupTaskMessage = async (...args) => {
      postCalls += 1;
      if (postCalls === 1) return new Promise(() => {});
      return realPost(...args);
    };
    insertGroupMessage(h.db, {
      pinId: 'pin-wedged-turn-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot build the thing',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    h.loop.start();
    await sleep(3200); // tick 1 dispatches the wedged turn; the 500ms hard cap
    // force-settles the guard and re-queues the trigger; a later tick
    // re-dispatches it and the (now healthy) send path lands the reply.
    h.loop.stop();

    assert.ok(
      logs.some((line) => line.includes('exceeded the hard in-flight cap')),
      'the wedged turn is force-settled at the hard cap',
    );
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && !send.content.startsWith('[WORKING]')),
      'the re-queued trigger is re-driven and the worker answer lands',
    );
  } finally {
    h.cleanup();
  }
});

test('release-review P2: a re-driven trigger waits for the session to go idle (bounded), then dispatches', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    workerCooldownMs: 0,
    chairCooldownMs: 0,
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // First exchange creates the (task, bot) session and completes normally.
    insertGroupMessage(h.db, {
      pinId: 'pin-busy-hold-m1-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot first thing',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && !send.content.startsWith('[WORKING]')),
      'the first exchange lands before the hold is armed',
    );

    // Simulate the post-hard-cap window: the guard is gone but the dangling
    // job's runner turn still reports the session as running.
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.ok(mapping, 'the worker session mapping exists');
    h.coworkStore.updateSession(mapping.coworkSessionId, { status: 'running' });

    h.sends.length = 0;
    logs.length = 0;
    insertGroupMessage(h.db, {
      pinId: 'pin-busy-hold-m2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot second thing',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.ok(
      logs.some((line) => line.includes('holding the trigger for message #')),
      'the busy session holds the trigger instead of dispatching a concurrent turn',
    );
    assert.ok(
      !h.sends.some((send) => send.metabotId === 2 && !send.content.startsWith('[WORKING]')),
      'no worker answer is dispatched while the session still runs the prior turn',
    );
    assert.ok(h.store.get(`group_task_deferred:${task.id}`), 'the held trigger sits in the durable queue');

    // The session goes idle — the held trigger drains and the reply lands.
    h.coworkStore.updateSession(mapping.coworkSessionId, { status: 'completed' });
    await h.loop.runTick();
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && !send.content.startsWith('[WORKING]')),
      'the held trigger is dispatched once the session idles',
    );

    // Expiry branch: a session that never idles stops holding after one
    // hard-cap window and dispatches anyway (retry budget governs).
    h.coworkStore.updateSession(mapping.coworkSessionId, { status: 'running' });
    h.sends.length = 0;
    logs.length = 0;
    insertGroupMessage(h.db, {
      pinId: 'pin-busy-hold-m3-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot third thing',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      logs.some((line) => line.includes('holding the trigger for message #')),
      'the busy hold arms again for the third trigger',
    );
    h.state.nowMs += 46 * 60_000; // past the 45-min hard-cap window
    await h.loop.runTick();
    assert.ok(
      logs.some((line) => line.includes('session-busy hold for message #') && line.includes('expired')),
      'the hold expires after one hard-cap window',
    );
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && !send.content.startsWith('[WORKING]')),
      'the expired hold dispatches anyway',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #41 residue: an ETA-bearing [WORKING] threaded under a host notice or
// roll call (replyPin → [GROUP_TASK_NOTICE:*] / 请确认在线) is a presence
// confirmation, not a delivery commitment — it must not arm a delivery
// deadline. An ETA [WORKING] threaded under a real assignment (or not
// threaded at all, P2-2 long-task heartbeat) still arms one.
// ---------------------------------------------------------------------------

test('task #41 residue: an ETA [WORKING] replying to a welcome notice arms no delivery deadline', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-welcome-r3', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: buildMemberJoinWelcomeText({
        taskTitle: 'Build MetaApp', joinerName: 'Coder Bot',
        existingMemberNames: ['Twin Bot'],
      }, 'zh'),
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.sends.length = 0;

    // The worker's presence reply threads under the welcome pin (the daemon
    // threads every reply under its trigger) and happens to carry the
    // [WORKING] tag plus an ETA — an organic echo of the roll call.
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-notice-r3', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已就位，预计 2 分钟后开始',
      replyPin: 'pin-welcome-r3',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    const member = h.groupTaskStore.listMembers(task.id).find((m) => m.metabotId === 2);
    assert.equal(member.status, 'working', 'ACK still marks the worker engaged');
    assert.ok(
      h.store.get(`group_task_working_heartbeat:${task.id}:2`),
      'liveness lease still extended (the worker is alive)',
    );
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'no delivery deadline armed off a notice-threaded ACK',
    );

    // Past the invented ETA: no fake "estimated delivery …" reminder fires.
    h.state.nowMs += 5 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((s) => /estimated delivery/.test(s.content)).length,
      0,
      'no fake delivery reminder after the roll-call ETA',
    );
  } finally {
    h.cleanup();
  }
});

test('task #41 residue: an ETA [WORKING] replying to a real chair assignment arms its stated deadline', async () => {
  const h = await createHarness({ ackTimeoutMs: 180_000 });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-assign-r3', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp [DEADLINE: 5m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get(`group_task_ack_pending:${task.id}:2`), 'assignment watch armed');

    // Same ETA ACK shape as the notice case, but threaded under the real
    // dispatch: the deadline must arm (P2-2 semantics untouched).
    insertGroupMessage(h.db, {
      pinId: 'pin-ack-assign-r3', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：build metaapp，预计 5 分钟',
      replyPin: 'pin-assign-r3',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      'chair-stated deadline armed for an assignment-threaded ACK',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// G-01..G-04 enhancement suite (2026-08-30 requirements doc)
// ---------------------------------------------------------------------------

test('G-03: a chair body tag with no message-end instruction never transitions and is observable', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (line) => logs.push(line) });
  try {
    const task = h.createTask([2]);
    // The GT#47 plan shape: the criteria quote carries a descriptive tag on a
    // NON-last line; the last line is prose with no tag. (A tag on the LAST
    // line is the instruction field — see the task #52 tests above.)
    insertGroupMessage(h.db, {
      pinId: 'g3-body-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '计划如上。验收标准提到 owner 核验通过后发 [STATUS:REVIEW]。\n分工宣读完毕，即刻开工。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'a descriptive body tag must not move the state machine',
    );
    assert.ok(
      logs.some((line) => line.includes('descriptive tags ignored, no transition applied')),
      'the ignored parse leaves an observable log line',
    );
  } finally {
    h.cleanup();
  }
});

test('GT#72: a tag mid-line with words on BOTH sides is a citation — the note asks for a bare re-send', async () => {
  // The old task #52 ruling accepted the whole last line as the instruction
  // field ("终检完成 [STATUS:REVIEW] 请 owner 验收" applied). GT#72 withdrew
  // that for tags EMBEDDED mid-line: the shape is indistinguishable from the
  // #4399 clock-line citation that flipped a task to review 45 minutes early.
  // Chairs still have two end shapes (leading the line, capping the line);
  // an intended verdict written mid-line self-heals through the citation
  // note on the next chair turn.
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'g3-mid-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '终检完成 [STATUS:REVIEW] 请 owner 验收',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.getTaskById(task.id).status,
      'executing',
      'an embedded mid-line tag never flips the task (GT#72 premature-flip lesson)',
    );
    const citeNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.target === 'status citation');
    assert.equal(citeNotes.length, 1, 'the citation note tells the chair to re-send a bare tag');
  } finally {
    h.cleanup();
  }
});

test('G-03: the planning dispatch self-heals a missing trailing tag with the deterministic footer', async () => {
  const h = await createHarness({ chatReply: '分工:Coder Bot 负责实现。' });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.sends.length, 1, 'the planning dispatch was posted');
    assert.match(h.sends[0].content, /\[STATUS:EXECUTING\]$/);
    assert.match(h.sends[0].content, /分工:Coder Bot 负责实现。/);
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1');
  } finally {
    h.cleanup();
  }
});

test('G-02: a valid deliverable retires the pending ACK watch silently (no alarm, no standby note)', async () => {
  const h = await createHarness({ ackTimeoutMs: 1 });
  try {
    const task = h.createTask([2]);
    const assignedAt = h.state.nowMs - 120_000;
    // Chair @-dispatch arms the ACK watch.
    insertGroupMessage(h.db, {
      pinId: 'g2-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请实现 X 并交付',
      chainTimestamp: Math.floor(assignedAt / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_ack_pending:${task.id}:2`),
      'ACK watch armed by the chair dispatch',
    );
    // The worker delivered long ago (outside every recency window) — valid,
    // non-rejected: state-driven liveness says done, not missing.
    h.db.run(
      `INSERT INTO group_task_deliverables (task_id, msg_pin_id, author_globalmetaid, kind, uri, status, confirmation, created_at)
       VALUES (?, 'g2-dlv-pin', 'gmid-w2', 'metaapp', ?, 'delivered', 'unconfirmed', datetime('now', '-1 hour'))`,
      [task.id, `metaapp://${'ab'.repeat(32)}i0`],
    );
    h.state.nowMs += 60_000; // push past the (1 ms) ACK timeout
    const sendsBefore = h.sends.length;
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_ack_pending:${task.id}:2`),
      undefined,
      'the watch is retired for a delivered member',
    );
    const newSends = h.sends.slice(sendsBefore);
    assert.ok(
      newSends.every((send) => !/has not sent a \[WORKING\] ACK/i.test(send.content)),
      'no missing-ACK alarm for the delivered member',
    );
    assert.ok(
      newSends.every((send) => !/long-running turn/i.test(send.content)),
      'no long-turn standby note either — delivered is done waiting',
    );
  } finally {
    h.cleanup();
  }
});

test('G-01: created and first-dispatch milestones report to the origin session exactly once', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message }) => {
        milestones.push({ taskId, kind, message });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false });
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-g01', task.id]);
    const fresh = h.groupTaskStore.getTaskById(task.id);
    // Chair plan with the trailing instruction tag: transition + dispatch report.
    insertGroupMessage(h.db, {
      pinId: 'g1-plan-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '分工如下。\n[STATUS:EXECUTING]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    await h.loop.runTick();
    const kinds = milestones.map((entry) => entry.kind);
    assert.equal(kinds.filter((kind) => kind === 'created').length, 1, 'created reports once');
    assert.equal(kinds.filter((kind) => kind === 'dispatch').length, 1, 'first dispatch reports once');
    const dispatch = milestones.find((entry) => entry.kind === 'dispatch');
    assert.match(dispatch.message, /\[GROUP_TASK_DISPATCH\]/);
    assert.ok(dispatch.message.includes('executing'), 'dispatch notice carries the status');
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'executing');
  } finally {
    h.cleanup();
  }
});

test('G-01: an illegal transition reports an anomaly to the origin session (never silent)', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning: -> review is illegal
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-g01b', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'g1-illegal-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '提前收工。\n[STATUS:REVIEW]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'planning', 'illegal move rejected');
    const anomaly = milestones.find((entry) => entry.kind === 'anomaly');
    assert.ok(anomaly, 'anomaly milestone fired');
    assert.match(anomaly.message, /\[GROUP_TASK_ALERT\]/);
    assert.equal(anomaly.subject, 'illegal_transition:review');
    const audit = h.groupTaskStore.listTaskTransitions(task.id)
      .find((row) => (row.reason ?? '').startsWith('illegal_transition:'));
    assert.ok(audit, 'durable audit row records the rejection');
  } finally {
    h.cleanup();
  }
});

test('G-01: the no-progress stall anomaly fires once per episode', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      noProgressStallMs: 300_000,
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-g01c', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'g1-stale-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 400, // > 5 min stale
    });
    await h.loop.runTick();
    const stalls = milestones.filter((entry) => entry.subject === 'stall');
    assert.equal(stalls.length, 1, 'stall anomaly reported once');
    assert.match(stalls[0].message, /\[GROUP_TASK_ALERT\]/);
    await h.loop.runTick();
    assert.equal(
      milestones.filter((entry) => entry.subject === 'stall').length,
      1,
      'no repeat spam while the episode persists',
    );
  } finally {
    h.cleanup();
  }
});

test('GT-03: a stalled PLANNING task re-arms one exhausted plan attempt per episode and still reports the stall anomaly', async () => {
  const logs = [];
  const milestones = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: {
      noProgressNudgeMs: 60_000,
      noProgressStallMs: 300_000,
      sendMilestoneToSourceSession: ({ taskId, kind, message, subject }) => {
        milestones.push({ taskId, kind, message, subject });
        return true;
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning — the #56 blind spot
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-gt03', task.id]);
    // The wedged state: all 3 plan attempts burned during the outage, plan
    // never posted, cursor long past the last observable message.
    h.store.set(`group_task_chair_plan_attempts:${task.id}`, 3);
    insertGroupMessage(h.db, {
      pinId: 'gt03-old-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '收到任务，准备规划。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 400, // 400s old: past both windows
    });
    await h.loop.runTick();

    assert.equal(
      Number(h.store.get(`group_task_chair_plan_attempts:${task.id}`)),
      2,
      'one planning attempt re-armed for the stalled planning task',
    );
    assert.ok(logs.some((line) => line.includes('re-armed one planning attempt')), 're-arm logged');
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'planning tasks never get the executing-task status-report nudge',
    );
    assert.ok(
      milestones.some((entry) => entry.kind === 'anomaly' && entry.subject === 'stall'),
      'the stall anomaly now covers planning (GT-03 visibility)',
    );

    // The re-armed attempt lets the next tick actually run the planning turn.
    await h.loop.runTick();
    assert.ok(
      h.sends.some((send) => send.metabotId === 1 && send.content.includes('[STATUS:EXECUTING]')),
      'chair planning turn posted the plan after the re-arm',
    );
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'plan marked posted');
  } finally {
    h.cleanup();
  }
});

test('GT-05: a daemon restart immediately re-arms a planning task whose attempts died pre-restart', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    // The pre-restart wedged state (task #56 after the outage): attempts
    // exhausted, plan never posted — and the no-progress windows NOT yet
    // elapsed (a restart must not have to wait out the 20-minute episode).
    h.store.set(`group_task_chair_plan_attempts:${task.id}`, 3);

    // A fresh loop instance = the app restarted (once-per-run guards reset).
    const fresh = h.makeLoop();
    await fresh.runTick();
    assert.equal(
      Number(h.store.get(`group_task_chair_plan_attempts:${task.id}`)),
      2,
      'restart reconciliation re-arms one planning attempt immediately',
    );
    assert.ok(logs.some((line) => line.includes('restart reconciliation')), 're-arm logged');
    await fresh.runTick();
    assert.ok(
      h.sends.some((send) => send.metabotId === 1 && send.content.includes('[STATUS:EXECUTING]')),
      'the chair planning turn runs right after the restart, not 20 minutes later',
    );

    // Once per run: a THIRD tick must not re-arm again after the attempt
    // burned (simulate the re-armed attempt failing back to the cap).
    h.store.set(`group_task_chair_plan_attempts:${task.id}`, 3);
    h.store.delete(`group_task_chair_planned:${task.id}`);
    await fresh.runTick();
    assert.equal(
      Number(h.store.get(`group_task_chair_plan_attempts:${task.id}`)),
      3,
      'no second re-arm within the same daemon run',
    );
  } finally {
    h.cleanup();
  }
});

test('gating (G-04): while dispatch is paused the chair answers only the owner; workers unchanged', () => {
  const pausedTask = { id: 1, status: 'executing', dispatchPaused: true };
  const ownerMessage = gateMessage({ senderGlobalMetaId: BOSS_GMID, senderMetaId: 'metaid-human', senderName: 'Owner', content: 'what is the status?' });
  const workerMention = gateMessage({ content: '@Coder Bot please continue your step' });
  const chairMention = gateMessage({ content: '@Twin Bot question for you' });

  const toOwner = decideGroupTaskResponders(ownerMessage, pausedTask, GATE_MEMBERS, GATE_BOTS);
  assert.deepEqual(toOwner, [{ metabotId: 1, reason: 'chair_owner_message' }]);

  const toWorkerMention = decideGroupTaskResponders(workerMention, pausedTask, GATE_MEMBERS, GATE_BOTS);
  assert.deepEqual(toWorkerMention, [{ metabotId: 2, reason: 'worker_mentioned' }], 'in-flight worker mentions still answer');

  const toChairMention = decideGroupTaskResponders(chairMention, pausedTask, GATE_MEMBERS, GATE_BOTS);
  assert.deepEqual(toChairMention, [], 'no chair dispatch replies while paused');
});

test('G-04: a supervisor pause holds the planning turn; nudge drives a chair response turn after resume', async () => {
  const h = await createHarness({ chatReply: '已复查:交付物完整,见核验记录。' });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    h.groupTaskStore.setTaskDispatchPausedAt(task.id, h.state.nowMs);
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'planning turn held while paused');
    assert.equal(h.sends.length, 0, 'no group posts while paused');

    // Resume + a pending nudge: the chair must answer in-group.
    h.groupTaskStore.setTaskDispatchPausedAt(task.id, null);
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id,
      kind: 'nudge',
      note: 'double-check the archive step dedupe',
      target: 'Coder Bot',
    });
    await h.loop.runTick();
    const supervisorTurn = h.chatCalls.find((call) => call.userMessage.includes('[NUDGE → Coder Bot]'));
    assert.ok(supervisorTurn, 'the chair turn received the supervisor directive');
    assert.ok(
      h.sends.some((send) => send.content.includes('已复查')),
      'the chair response was posted to the group',
    );
    const pending = h.groupTaskStore.listPendingSupervisorSignals(task.id);
    assert.equal(pending.length, 0, 'the nudge is marked processed with the response pin');
  } finally {
    h.cleanup();
  }
});

test('GT-06: a supervisor nudge runs a TOOL-EQUIPPED skill turn when routing hits', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id,
      kind: 'nudge',
      note: 'check whether the worker actually delivered',
    });
    // Routing hit: the chair's supervision answer must be able to LOOK at the
    // group/ledger/chain (task #56: the tool-less plain path answered nudges
    // blindly while every tool-driven turn was stalled).
    h.state.routing = { prompt: 'ACTIVE SKILLS: metabot-group-task', activeSkillIds: ['metabot-group-task'] };
    h.state.skillReply = '核验过了：交付物已齐，链上可查。';
    await h.loop.runTick();

    const skillTurn = h.skillTurnCalls.find((call) => call.userMessage.includes('[NUDGE]'));
    assert.ok(skillTurn, 'the supervisor answer went through the skill-turn path');
    assert.deepEqual(skillTurn.activeSkillIds, ['metabot-group-task'], 'the routed skills ride the turn');
    assert.ok(
      skillTurn.systemPrompt.includes('ACTIVE SKILLS: metabot-group-task'),
      'the routing prompt rides the system prompt',
    );
    assert.equal(
      h.chatCalls.filter((call) => call.userMessage.includes('[NUDGE]')).length,
      0,
      'the tool-less plain path did NOT also run',
    );
    assert.ok(
      h.sends.some((send) => send.metabotId === 1 && send.content.includes('核验过了')),
      'the chair answer was posted to the group',
    );
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'the nudge is marked processed with the response pin',
    );
    assert.ok(
      h.routingCalls.some((call) => call.metabotId === 1 && call.widened === true),
      'supervisor turns route with owner-level widening',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-flow Phase 3: long-turn liveness — a still-running turn
// posts a host placeholder + bounded heartbeats instead of sitting silent,
// and renews the worker's [WORKING long-task] lease while it runs.
// ---------------------------------------------------------------------------

test('long-turn liveness (single-commander): a still-running turn posts NOTHING; the lease renews internally; timers clear at settle', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let releaseTurn;
  const gate = new Promise((resolve) => { releaseTurn = resolve; });
  const h = await createHarness({
    deps: {
      longTurnLeaseArmMs: 60,
      longTurnHeartbeatMs: 100,
      performChat: async () => {
        await gate;
        return '[WORKING] done';
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-lt-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Raw loop: the drained wrapper would hang on the gated turn forever.
    const rawLoop = createGroupTaskDaemonLoop(h.deps);
    await rawLoop.runTick();

    await sleep(320);
    // The legacy opt-in placeholder/heartbeat posts are gone with the
    // single-commander architecture: the host never speaks as the worker.
    assert.equal(
      h.sends.filter((send) => send.metabotId === 2).length,
      0,
      'no placeholder or heartbeat lines while the turn runs',
    );
    const lease = Number(h.store.get(`group_task_working_heartbeat:${task.id}:2`));
    assert.ok(lease > h.state.nowMs, 'the internal renewal keeps the [WORKING long-task] lease fresh');

    releaseTurn();
    await rawLoop.whenIdle();
    await sleep(300);
    const workerSends = h.sends.filter((send) => send.metabotId === 2);
    assert.equal(workerSends.length, 1, 'after settle the ONLY worker speech is the turn reply itself');
    assert.equal(workerSends[0].content, '[WORKING] done');
  } finally {
    releaseTurn();
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Sidebar background-task badge: dispatching a turn broadcasts a
// groupTask:turnActivityChanged snapshot (and settle broadcasts the removal),
// so the renderer can show how many MetaBot background turns are running.
// ---------------------------------------------------------------------------

test('turn activity: dispatch/settle broadcasts groupTask:turnActivityChanged snapshots', async () => {
  let releaseTurn;
  const gate = new Promise((resolve) => { releaseTurn = resolve; });
  const h = await createHarness({
    deps: {
      performChat: async () => {
        await gate;
        return '[WORKING] done';
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-ta-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    // Raw loop: the drained wrapper would hang on the gated turn forever.
    const rawLoop = createGroupTaskDaemonLoop(h.deps);
    await rawLoop.runTick();

    const activityEvents = () => h.events.filter((event) => event.type === 'groupTask:turnActivityChanged');
    assert.ok(
      activityEvents().some((event) =>
        event.turns.some((turn) => turn.taskId === task.id && turn.metabotId === 2)),
      'dispatch broadcasts the in-flight turn',
    );
    assert.deepEqual(
      rawLoop.getTurnActivity().map((turn) => [turn.taskId, turn.metabotId]),
      [[task.id, 2]],
      'the loop exposes the in-flight turn snapshot for the IPC pull',
    );

    releaseTurn();
    await rawLoop.whenIdle();
    const lastEvent = activityEvents().at(-1);
    assert.deepEqual(lastEvent.turns, [], 'settle broadcasts an empty snapshot');
    assert.deepEqual(rawLoop.getTurnActivity(), [], 'the snapshot is empty once the turn settles');
  } finally {
    releaseTurn();
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-flow Phase 5: chair-drive guarantees — a chair trigger that
// produced a decision but no answer (per-tick cap, suppression, budget) is
// re-driven once; an idle task with nothing running nudges the chair.
// ---------------------------------------------------------------------------

test('task #51 chair-drive safety net: a chair trigger dropped by the per-tick cap is re-driven once', async () => {
  const h = await createHarness({ deps: { chairResponseRedriveMs: 60_000 } });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Two chair-triggering worker questions in one tick: the first dispatches,
    // the per-tick chair auto-reply cap silently drops the second.
    insertGroupMessage(h.db, {
      pinId: 'pin-net-q1', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '素材库的地址是哪一个？',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-net-q2', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '图标风格定哪一种？',
      chainTimestamp: Math.floor(startMs / 1000) + 1,
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'per-tick chair cap: only the first trigger dispatched');
    const q2Id = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['pin-net-q2'])[0].values[0][0];
    const pending = JSON.parse(h.store.get(`group_task_chair_response_pending:${task.id}`) ?? 'null');
    assert.equal(pending?.messageId, q2Id, 'the capped trigger stays pending (the answered one does not clear it)');

    // Past the redrive window with the chair still silent: the net re-drives
    // the dropped trigger through the durable defer queue (same-tick drain).
    h.state.nowMs = startMs + 120_000;
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'the dropped trigger is re-driven once');
    assert.equal(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      undefined,
      'obligation cleared after the answer',
    );

    // No third drive — the net fires once per trigger.
    h.state.nowMs = startMs + 240_000;
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'no further re-drive');
  } finally {
    h.cleanup();
  }
});

test('task #51 no-progress nudge: idle minutes with nothing running drives the chair to report status', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-nudge-hello', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] hello',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.sends.length = 0;
    h.chatCalls.length = 0;

    // 21 idle minutes, no turn in flight → one supervisor nudge is recorded
    // this tick and drives the chair status turn on the next.
    h.state.nowMs = startMs + 21 * 60_000;
    await h.loop.runTick();
    const signals = h.groupTaskStore.listPendingSupervisorSignals(task.id);
    assert.equal(signals.length, 1, 'one nudge recorded for the idle episode');
    assert.equal(signals[0].kind, 'nudge');

    await h.loop.runTick();
    assert.ok(
      h.chatCalls.some((call) => call.userMessage.includes('NUDGE')),
      'the nudge drives a chair turn',
    );
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'the nudge is marked processed',
    );

    // Same idle episode: no second nudge (the guard holds until progress).
    h.state.nowMs = startMs + 30 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'no second nudge within the same idle episode',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-duration: dependency-wait prefix tolerance (task #58)
// ---------------------------------------------------------------------------

const {
  hexTokensSharePrefix,
} = require('../dist-electron/main/services/groupTaskDaemon.js');

test('hexTokensSharePrefix: truncated pins match their full form, unrelated hashes do not', () => {
  const full = `${'ab'.repeat(32)}i0`;
  const truncated = 'ab'.repeat(30); // 60-hex prefix of the 64-hex core
  assert.equal(hexTokensSharePrefix(`metafile://${truncated}`, full), true);
  assert.equal(hexTokensSharePrefix(full, `pin://${truncated}`), true);
  // Message-prose form: the tag line quotes the truncated pin among other text.
  assert.equal(
    hexTokensSharePrefix('[deliverable] package on chain metafile://'.concat(truncated), full),
    true,
  );
  // Unrelated hashes never share a 32-hex prefix.
  assert.equal(hexTokensSharePrefix(`${'cd'.repeat(32)}i0`, full), false);
  // Short hex runs (<32) never match — ambiguity is refused.
  assert.equal(hexTokensSharePrefix('abcd'.repeat(8), 'abcd'.repeat(4)), false);
  assert.equal(hexTokensSharePrefix('', full), false);
});

test('dependency-wait: a truncated deliverable pin in a worker [DELIVERABLE] line satisfies the gate (no 15-min false hold)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const fullPin = `${'ab'.repeat(32)}i0`;
    const truncated = 'ab'.repeat(30);
    // Upstream worker delivered with a TRUNCATED metafile pin (task #58
    // regression): the ledger row stays kind=text/uri=NULL because the parser
    // only records full 64-hex+i0 tokens.
    insertGroupMessage(h.db, {
      pinId: 'deliverable-truncated-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: `[DELIVERABLE] 第2步包已上链 metafile://${truncated}`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 300,
    });
    // Chair dispatches downstream with the FULL pin it verified via the indexer.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-dep-full-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot 第3步正式派单\n[DEPENDS_ON: ${fullPin}]`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    // Cursor sits just BEFORE the dispatch so the tick ingests both messages.
    const dispatchId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'dispatch-dep-full-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, dispatchId - 1);

    await h.loop.runTick();

    const depWaitKeys = h.db.exec(
      "SELECT key FROM kv WHERE key LIKE 'group_task_dep_wait:%'",
    )[0]?.values ?? [];
    assert.equal(depWaitKeys.length, 0, 'the dispatch is not held on a truncated-pin upstream');
    assert.ok(
      h.sends.some((send) => send.metabotId === 2),
      'the worker turn dispatched and its reply posted in the same tick',
    );
  } finally {
    h.cleanup();
  }
});

test('dependency-wait (single-commander): the host no longer gates dispatches — the worker turn runs and answers', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const missingPin = `${'ef'.repeat(32)}i0`;
    insertGroupMessage(h.db, {
      pinId: 'dispatch-dep-missing-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: `@Coder Bot 第3步正式派单\n[DEPENDS_ON: ${missingPin}]`,
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const dispatchId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'dispatch-dep-missing-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, dispatchId - 1);

    await h.loop.runTick();

    // The [DEPENDS_ON] DISPATCH GATE is gone: sequencing is the chair's
    // judgment, so the worker's turn proceeds and replies normally (it sees
    // the dependency tag in the trigger and can act on it itself). No
    // dep-wait hold state is armed.
    const depWaitKeys = h.db.exec(
      "SELECT key FROM kv WHERE key LIKE 'group_task_dep_wait:%'",
    )[0]?.values ?? [];
    assert.equal(depWaitKeys.length, 0, 'no dispatch-hold state armed');
    assert.ok(
      h.sends.some((send) => send.metabotId === 2),
      'the worker turn ran — the host did not sequence it away',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-duration: sponsor-broadcast-pending send queue (tasks
// #58/#59 — a reconciliation outage must queue, not burn turns)
// ---------------------------------------------------------------------------

test('sponsor-pending: a worker reply send is queued, the turn completes, and the drainer delivers later', async () => {
  // postGroupTaskMessage fails with SPONSOR_BROADCAST_PENDING until flipped.
  const sendState = { sponsorPending: true, calls: [] };
  const h = await createHarness({
    deps: {
      postGroupTaskMessage: async (taskId, metabotId, content, opts) => {
        sendState.calls.push({ taskId, metabotId, content, replyPin: opts?.replyPin });
        if (sendState.sponsorPending && metabotId === 2) {
          throw new Error('SPONSOR_BROADCAST_PENDING: orderId=deadbeef: broadcast reconciliation in progress');
        }
        return { pinId: `drain-pin-${sendState.calls.length}` };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'trigger-mention-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver step 3',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const triggerId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'trigger-mention-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, triggerId - 1);

    await h.loop.runTick();

    // The worker turn RAN and completed — its reply send was queued, not failed.
    const workerSends = sendState.calls.filter((call) => call.metabotId === 2);
    assert.ok(workerSends.length >= 1, 'the reply send was attempted');
    // A queued-notice (not a failure notice) landed in the worker session.
    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    const messages = h.coworkStore.getSession(mapping.coworkSessionId).messages;
    assert.ok(
      messages.some((message) => /delivery-queued notice/.test(message.content ?? '')),
      'the worker was told the message is queued, not failed',
    );
    assert.ok(
      !messages.some((message) => /delivery-failure notice/.test(message.content ?? '')),
      'no failure notice for a sponsor-pending rejection',
    );

    // Reconciliation clears; advance past the retry window and drain.
    sendState.sponsorPending = false;
    h.state.nowMs += 3 * 60_000;
    const before = sendState.calls.filter((call) => call.metabotId === 2).length;
    await h.loop.runTick();
    const after = sendState.calls.filter((call) => call.metabotId === 2).length;
    assert.equal(after, before + 1, 'the drainer re-posted the queued message exactly once');
    const bot2Calls = sendState.calls.filter((call) => call.metabotId === 2);
    assert.match(
      bot2Calls[bot2Calls.length - 1].content,
      /^(skill-turn-reply|reply-for-llm-2)/,
      'the drained message is the original composed reply',
    );

    // Fully drained: another tick after the retry window posts nothing more.
    h.state.nowMs += 3 * 60_000;
    await h.loop.runTick();
    assert.equal(
      sendState.calls.filter((call) => call.metabotId === 2).length,
      after,
      'no duplicate delivery once the queue is empty',
    );
  } finally {
    h.cleanup();
  }
});

test('sponsor-pending: a different error while draining converts to the failure notice and drops the entry', async () => {
  const sendState = { error: 'SPONSOR_BROADCAST_PENDING: orderId=aa: broadcast reconciliation in progress' };
  const h = await createHarness({
    deps: {
      postGroupTaskMessage: async (taskId, metabotId) => {
        if (metabotId !== 2) return { pinId: `pin-${metabotId}` };
        throw new Error(sendState.error);
      },
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'trigger-mention2-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver step 4',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const triggerId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'trigger-mention2-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, triggerId - 1);
    await h.loop.runTick();

    h.state.nowMs += 3 * 60_000;
    sendState.error = 'wallet mnemonic is empty';
    await h.loop.runTick();

    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    const messages = h.coworkStore.getSession(mapping.coworkSessionId).messages;
    assert.ok(
      messages.some((message) => /delivery-failure notice/.test(message.content ?? '')),
      'a changed error surfaces as the ordinary failure notice',
    );

    // Entry dropped: later ticks never retry it again.
    const failNoticeCount = messages.filter((message) => /delivery-failure notice/.test(message.content ?? '')).length;
    h.state.nowMs += 3 * 60_000;
    await h.loop.runTick();
    const messagesAfter = h.coworkStore.getSession(mapping.coworkSessionId).messages;
    const failNoticeCountAfter = messagesAfter.filter((message) => /delivery-failure notice/.test(message.content ?? '')).length;
    assert.equal(failNoticeCountAfter, failNoticeCount, 'the dropped entry is not retried');
  } finally {
    h.cleanup();
  }
});

test('sponsor-pending: a queued supervisor answer marks signals processed with a null pin, not an empty one', async () => {
  const h = await createHarness({
    chatReply: '已复查:交付物完整,见核验记录。',
    deps: {
      postGroupTaskMessage: async (taskId, metabotId) => {
        if (metabotId === 1) {
          throw new Error('SPONSOR_BROADCAST_PENDING: orderId=cc: broadcast reconciliation in progress');
        }
        return { pinId: `pin-${metabotId}` };
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    h.groupTaskStore.setTaskDispatchPausedAt(task.id, h.state.nowMs);
    await h.loop.runTick();

    h.groupTaskStore.setTaskDispatchPausedAt(task.id, null);
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id,
      kind: 'nudge',
      note: 'double-check the archive step dedupe',
      target: 'Coder Bot',
    });
    await h.loop.runTick();

    assert.equal(
      h.groupTaskStore.listPendingSupervisorSignals(task.id).length,
      0,
      'the queued chair answer still resolves the signal',
    );
    const signals = h.groupTaskStore.listSupervisorSignals(task.id);
    assert.equal(signals.length, 1);
    assert.equal(
      signals[0].chairResponsePinId,
      null,
      'a queued chair answer is recorded with a null pin, never an empty string',
    );
  } finally {
    h.cleanup();
  }
});

test('sponsor-pending: a queued acceptance summary post leaves the published pin unset', async () => {
  const h = await createHarness({
    deps: {
      postGroupTaskMessage: async (taskId, metabotId) => {
        if (metabotId === 1) {
          throw new Error('SPONSOR_BROADCAST_PENDING: orderId=dd: broadcast reconciliation in progress');
        }
        return { pinId: `pin-${metabotId}` };
      },
    },
  });
  try {
    const task = h.createTask([2]); // executing
    insertGroupMessage(h.db, {
      pinId: 'review-tag-queued-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal looks met\n[STATUS:REVIEW]',
      chainTimestamp: 101,
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'acceptance summary persisted on review entry');
    assert.equal(
      summary.publishedGroupPinId,
      null,
      'a queued summary post is not recorded with an empty published pin',
    );
  } finally {
    h.cleanup();
  }
});

test('sponsor-pending: a queued send for a finished task is dropped silently', async () => {
  const sendState = { sponsorPending: true, calls: 0 };
  const h = await createHarness({
    deps: {
      postGroupTaskMessage: async (taskId, metabotId) => {
        if (metabotId === 2) {
          sendState.calls += 1;
          if (sendState.sponsorPending) {
            throw new Error('SPONSOR_BROADCAST_PENDING: orderId=bb: broadcast reconciliation in progress');
          }
        }
        return { pinId: 'pin-x' };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'trigger-mention3-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver step 5',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const triggerId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'trigger-mention3-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, triggerId - 1);
    await h.loop.runTick();
    assert.ok(sendState.calls >= 1, 'send attempted and queued');

    h.groupTaskStore.updateTaskStatus(task.id, 'done');
    sendState.sponsorPending = false;
    h.state.nowMs += 3 * 60_000;
    const callsBefore = sendState.calls;
    await h.loop.runTick();
    assert.equal(sendState.calls, callsBefore, 'a terminal task never receives the queued message');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-duration: corrupt session log auto-rebuild (task #57 zombie)
// ---------------------------------------------------------------------------

test('corrupt session log: the member task session is rebuilt from the ledger and the trigger re-dispatches', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      runSkillTurn: null,
    },
  });
  const corruptSessionIds = new Set();
  h.deps.runSkillTurn = async (params) => {
    if (corruptSessionIds.has(params.sessionId)) {
      throw new Error('corrupt session log: seq gap in committed region at line 9853 (expected 116028, got 116026)');
    }
    return { replyText: 'reply-after-rebuild', assistantMessageId: 'asst-2' };
  };
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'trigger-corrupt-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver step 6',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const triggerId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'trigger-corrupt-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, triggerId - 1);

    // Prime the original mapping so the first turn lands on the corrupt one.
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const original = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    corruptSessionIds.add(original.session.id);

    await h.loop.runTick();
    // First tick: turn failed on the corrupt log; rebuild happened (or will on
    // the requeue). Give the deferred retry a tick.
    await h.loop.runTick();

    const after = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    assert.notEqual(after.coworkSessionId, original.session.id, 'the mapping was repointed to a fresh session');
    assert.ok(
      h.sends.some((send) => send.metabotId === 2 && send.content === 'reply-after-rebuild'),
      'the re-dispatched turn answered on the rebuilt session',
    );
    // The rebuilt session is seeded with the group context snapshot.
    const rebuiltMessages = h.coworkStore.getSession(after.coworkSessionId).messages;
    assert.ok(
      rebuiltMessages.some((message) => /SYSTEM group context snapshot/.test(message.content ?? '')),
      'the rebuilt session is seeded with the ledger context',
    );
    // Rebuild stamp recorded — a second corrupt failure within the interval
    // falls back to the ordinary retry ladder instead of looping rebuilds.
    assert.ok(h.store.get('group_task_corrupt_session_rebuild:1:2'), 'rebuild stamp recorded');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix/group-task-duration: stale-working direct worker wake (task #59)
// ---------------------------------------------------------------------------

test('stale-working: the stuck worker is woken directly — wake notice + its latest chair mention re-driven', async () => {
  const h = await createHarness({
    deps: { memberTimeoutAfterMinutes: 1, memberUnreachableAfterMinutes: 1 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // The chair assigned the worker (with an explicit @), the worker ACKed
    // [WORKING], then everything went silent well past the timeout window.
    insertGroupMessage(h.db, {
      pinId: 'wake-assignment-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please render the final video',
      chainTimestamp: Math.floor((startMs - 300_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'wake-working-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，正在渲染',
      chainTimestamp: Math.floor((startMs - 240_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();

    const mapping = h.coworkStore.getConversationMapping('metaweb_group_task', `group-task:${task.id}`, 2);
    const messages = h.coworkStore.getSession(mapping.coworkSessionId).messages;
    assert.ok(
      messages.some((message) => /SYSTEM stale-working wake/.test(message.content ?? '')),
      'a host wake notice was injected into the stuck worker session',
    );
    assert.ok(
      messages.some((message) => message.type === 'user' && /please render the final video/.test(message.content ?? '')),
      'the re-driven chair assignment reached the worker session as a turn trigger',
    );
    // The worker answered the wake: its reply was posted (skill/plain turn).
    assert.ok(
      h.sends.some((send) => send.metabotId === 2),
      'the woken worker produced a group reply on the same tick',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// group-task speedup REQ v1.1:
// R-01 execution-phase throttling — an executing member posts NO check-in
// messages; the liveness lease renews internally; exactly ONE @chair reminder
// fires when a turn exceeds the long-turn reminder threshold.
// R-02 deadline semantics — a delivery deadline is armed only for a member
// with a real, dependency-ready assignment on record.
// ---------------------------------------------------------------------------

test('speedup R-01: a long turn posts no heartbeat lines; lease renews internally; one @chair reminder', async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let releaseTurn;
  const gate = new Promise((resolve) => { releaseTurn = resolve; });
  const h = await createHarness({
    deps: {
      longTurnLeaseArmMs: 60,
      longTurnHeartbeatMs: 100,
      longTurnChairReminderMs: 180,
      performChat: async () => {
        await gate;
        return '[WORKING] done';
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'pin-r01-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please build the metaapp',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    const rawLoop = createGroupTaskDaemonLoop(h.deps);
    await rawLoop.runTick();

    await sleep(340);
    const heartbeatPosts = () => h.sends.filter((send) =>
      send.metabotId === 2 && /仍在执行中|长步骤仍在后台执行|Still on it|still running in the background/.test(send.content));
    assert.equal(heartbeatPosts().length, 0, 'no placeholder/heartbeat posts while the turn runs (R-01)');
    const lease = Number(h.store.get(`group_task_working_heartbeat:${task.id}:2`));
    assert.ok(Number.isFinite(lease) && lease > 0, 'the liveness lease was renewed internally');
    // Single-commander: the long-turn fact is an environment NOTE for the
    // chair — the host posts nothing as the worker.
    assert.equal(h.sends.filter((send) => send.metabotId === 2).length, 0, 'the host never speaks as the worker');
    const longTurnNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'long_turn');
    assert.equal(longTurnNotes.length, 1, 'exactly one long-turn note recorded');
    // Task #64: this scenario holds an ARMED no-ACK watch (the assignment never
    // got a [WORKING] ACK), so the note body flags the missing ACK instead of
    // claiming everything looks normal.
    assert.match(
      longTurnNotes[0].body,
      /no \[WORKING\] ACK from Coder Bot is on record/,
      'the missing ACK is called out in the fact, not papered over',
    );

    releaseTurn();
    await rawLoop.whenIdle();
    await sleep(300);
    assert.equal(heartbeatPosts().length, 0, 'still no heartbeat posts after settle');
    assert.equal(
      h.groupTaskStore.listPendingHostNotes(task.id).filter((note) => note.kind === 'long_turn').length,
      1,
      'the note fires at most once per turn',
    );
  } finally {
    releaseTurn();
    h.cleanup();
  }
});

test('speedup R-02: an unprompted [WORKING] arms no delivery deadline; fenced tokens are citations', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // No assignment exists: a spontaneous progress line is liveness only.
    insertGroupMessage(h.db, {
      pinId: 'pin-r02-free', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 正在做X，预计5分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'no assignment on record → no deadline armed',
    );
    // A [WORKING] quoted inside a fenced code block is a citation, not an ACK.
    insertGroupMessage(h.db, {
      pinId: 'pin-r02-fenced', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '示例写法如下：\n```\n[WORKING] 已接单，预计3分钟\n```\n请勿直接照抄。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 1,
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'a fenced [WORKING] citation arms nothing',
    );
    // Control: a real dispatch with a chair-stated deadline (ACK watch armed)
    // followed by the ACK arms that stated clock.
    insertGroupMessage(h.db, {
      pinId: 'pin-r02-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot do X [DEADLINE: 5m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-r02-ack', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，预计5分钟',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 3,
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      'an ACK to a real assignment arms the chair-stated deadline',
    );
  } finally {
    h.cleanup();
  }
});

test('speedup R-02: the delivery reminder stays suspended while the assignment is upstream-blocked', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Derived, [DEPENDS_ON]-gated assignment whose upstream is NOT delivered.
    insertGroupMessage(h.db, {
      pinId: 'pin-r02-dep-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `@Coder Bot 你负责 S4 推广，[DEPENDS_ON: ${'f'.repeat(64)}i0] 等 S3 交付后开始。`,
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    // A deadline kv that predates the fix (or was armed by a stale build) is
    // past due — the reminder must stay suspended while the upstream is missing.
    h.store.set(
      `group_task_expected_delivery:${task.id}:2`,
      JSON.stringify({ dueAt: startMs - 60_000, ackedAt: startMs - 120_000, taskDescription: 'S4' }),
    );
    await h.loop.runTick();
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    assert.equal(deadlineNotes(), 0, 'upstream not delivered → no deadline bell for the downstream member');
    assert.equal(
      h.store.get(`group_task_delivery_reminded:${task.id}:2`),
      undefined,
      'the reminded flag stays unset — the clock does not advance while blocked',
    );
    // Upstream lands: the very next tick reminds as usual (real overdue work
    // still alerts).
    h.groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: 'pin-r02-upstream',
      authorGlobalmetaid: 'gmid-w3',
      kind: 'pinid',
      uri: `pin://${'f'.repeat(64)}i0`,
    });
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1, 'once the upstream is delivered a genuine overdue still rings the bell');
  } finally {
    h.cleanup();
  }
});

test('Task #83 P2: a foreign clause\'s [DEPENDS_ON] never masks this member\'s upstream-free assignment', async () => {
  const h = await createHarness();
  try {
    h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Coder Bot's clause carries the [DEPENDS_ON] tag; Designer Bot's clause
    // has none. Task 83's live miss: the whole-message read found the foreign
    // tag and silently dependency-parked the upstream-free member (no watch).
    insertGroupMessage(h.db, {
      pinId: 'pin-p2-mixed-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `@Coder Bot 你负责 S4 推广，[DEPENDS_ON: ${'f'.repeat(64)}i0] 等 S3 交付后开始。\n\n@Designer Bot 你负责 S5 视觉，直接开工。`,
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get('group_task_ack_pending:1:2'), undefined,
      'the [DEPENDS_ON]-gated member waits on its upstream — no ACK watch',
    );
    assert.ok(
      h.store.get('group_task_ack_pending:1:3'),
      'the upstream-free member gets a normal ACK watch — the foreign tag does not mask it',
    );
  } finally {
    h.cleanup();
  }
});

test('Task #83 P3: a chair-stated deadline on an upstream-blocked assignment is suspended, then activated when the upstream lands', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    const upstreamPin = `${'f'.repeat(64)}i0`;
    insertGroupMessage(h.db, {
      pinId: 'pin-p3-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: `@Coder Bot 你负责 S4 推广，[DEPENDS_ON: ${upstreamPin}] 等 S3 交付后开始。[DEADLINE: 45m]`,
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined, 'a blocked assignment arms no clock');
    assert.ok(h.store.get('group_task_expected_delivery_suspended:1:2'), 'the chair-stated deadline is suspended, not dropped');

    // The worker ACKs while blocked: the clock stays suspended, never ticking.
    insertGroupMessage(h.db, {
      pinId: 'pin-p3-ack', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S3', replyPin: 'pin-p3-assign',
      chainTimestamp: Math.floor(startMs / 1000) + 30,
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_expected_delivery:1:2'), undefined, 'a blocked ACK does not start the clock');
    assert.ok(h.store.get('group_task_expected_delivery_suspended:1:2'), 'the suspended clock survives the blocked ACK');

    // Way past the nominal 45m with the upstream still missing: nothing fires.
    const deadlineNotes = () => Number(h.db.exec(
      "SELECT COUNT(*) FROM group_task_host_notes WHERE task_id = ? AND kind = 'deadline'",
      [task.id],
    )[0].values[0][0]);
    h.state.nowMs = startMs + 60 * 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 0, 'a suspended clock never rings while blocked');

    // The upstream lands: the sweep activates the chair-stated clock.
    h.groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'pin-p3-upstream', authorGlobalmetaid: 'gmid-w3',
      kind: 'pinid', uri: `pin://${upstreamPin}`,
    });
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_expected_delivery_suspended:1:2'), undefined, 'the suspended record is retired');
    const armed = JSON.parse(h.store.get('group_task_expected_delivery:1:2'));
    assert.equal(armed.dueAt, startMs + 60 * 60_000 + 45 * 60_000, 'the clock starts when the wait lifts');

    // Past the activated dueAt with no delivery: the deadline bell rings.
    h.state.nowMs = armed.dueAt + 60_000;
    await h.loop.runTick();
    assert.equal(deadlineNotes(), 1, 'the activated deadline is monitored like any other');
  } finally {
    h.cleanup();
  }
});

test('speedup R-06: review entry stamps the time breakdown onto the record and the closing message renders it', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    const t0 = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责封装与终检。',
      chainTimestamp: Math.floor(t0 / 1000) - 900,
    });
    // A host-style liveness line sits in the log before the chair's verdict.
    insertGroupMessage(h.db, {
      pinId: 'hb-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[WORKING] 仍在执行中——本步骤耗时较长，进展正常，完成后会立即汇报。',
      chainTimestamp: Math.floor(t0 / 1000) - 600,
    });
    insertGroupMessage(h.db, {
      pinId: 'review-tag-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: 'goal looks met\n[STATUS:REVIEW]',
      chainTimestamp: Math.floor(t0 / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.groupTaskStore.getTaskById(task.id).status, 'review');
    const summary = h.groupTaskStore.getLatestAcceptanceSummary(task.id);
    assert.ok(summary, 'summary persisted on review entry');
    assert.ok(summary.timeBreakdown, 'R-06: time breakdown stamped onto the record');
    assert.ok(summary.timeBreakdown.messageTotal >= 3, 'counts the group messages');
    assert.equal(
      summary.timeBreakdown.heartbeatMessages,
      1,
      'the [WORKING] liveness line is classified as heartbeat noise',
    );
    assert.equal(
      summary.timeBreakdown.heartbeatPaddedGapMinutes,
      15,
      'the heartbeat-padded gap between the assignment and the verdict is measured',
    );
    assert.ok(
      summary.timeBreakdown.phases.some((phase) => phase.key === 'executing'),
      'the executing window is derived from the status-event ledger',
    );
    // Single-commander: the breakdown lives on the record; the host posts
    // no ceremony message carrying it.
    assert.equal(
      h.sends.filter((s) => /进入验收阶段|耗时分解：/.test(s.content)).length,
      0,
      'no host ceremony message; the time breakdown stays on the acceptance record',
    );
    assert.ok(summary.timeBreakdown != null, 'time breakdown stamped onto the record');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// fix-v2 P0-1: deadline false-alarm recurrence — conditional worker ETAs and
// mixed (tag + prose) dispatches must never arm a delivery deadline while the
// upstream is undelivered (task #62 post-mortem).
// ---------------------------------------------------------------------------

test('fix-v2 P0-1: hasWorkerUpstreamWait matches explicit wait markers only', () => {
  // The exact task-#62 sentence that armed the false 2-minute deadline.
  assert.ok(hasWorkerUpstreamWait('[WORKING] 待 Builder 上链交付后接单，回填→发布预计 2 分钟。执行期静默。'));
  assert.ok(hasWorkerUpstreamWait('[WORKING] 等 S3 交付后开始。'));
  assert.ok(hasWorkerUpstreamWait('[WORKING] waiting on the S3 delivery to land before publishing.'));
  assert.ok(hasWorkerUpstreamWait('[WORKING] after Builder delivers the metaapp I will publish (est. 2 min).'));
  // Bare dependency words without a wait marker are NOT a conditional wait.
  assert.ok(!hasWorkerUpstreamWait('[WORKING] 依赖已就绪，开工，预计 30 分钟。'));
  assert.ok(!hasWorkerUpstreamWait('[WORKING] 已接单，预计 5 分钟。'));
  assert.ok(!hasWorkerUpstreamWait('[WORKING] 无需等待，直接开工。'));
  assert.ok(!hasWorkerUpstreamWait(''));
  assert.ok(!hasWorkerUpstreamWait(null));
});

test('fix-v2 P0-1: a conditional-ETA [WORKING] arms no deadline and never alerts; the real start ACK arms', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S4 推广。[DEADLINE: 10m]',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    // The member's readiness note carries a CONDITIONAL ETA — "after Builder's
    // delivery lands, backfill+publish takes ~2 minutes" (task #62 msg #3548).
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-cond', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '草案已备好落盘。[WORKING] 待 Builder 上链交付后接单，回填→发布预计 2 分钟。执行期静默。',
      chainTimestamp: Math.floor(startMs / 1000) + 30,
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'a conditional ETA arms no delivery deadline',
    );
    // Well past the spurious 2 minutes: no alert, no reminded flag.
    h.state.nowMs = startMs + 10 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => /estimated delivery/.test(send.content)).length,
      0,
      'no deadline alert while the member waits on the upstream',
    );
    assert.equal(h.store.get(`group_task_delivery_reminded:${task.id}:2`), undefined);
    // Upstream lands; the chair re-dispatches and the member's unconditional
    // start ACK arms the deadline normally (计时在上游落地后启动).
    h.groupTaskStore.addDeliverable({
      taskId: task.id, msgPinId: 'pin-v2p0-up', authorGlobalmetaid: 'gmid-w3',
      kind: 'pinid', uri: `pin://${'f'.repeat(64)}i0`,
    });
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-go', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot S4 开工。[DEADLINE: 10m]',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 1,
    });
    await h.loop.runTick();
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-start', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，回填→发布预计 2 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      'the unconditional start ACK after the upstream lands arms the deadline',
    );
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P0-1: a mixed dispatch (foreign [DEPENDS_ON] tag + prose wait for this member) arms no deadline', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Task #62 message #3546 shape: Builder's S3 clause carries the structured
    // tag (free-text, advisory); Coder Bot's clause declares a prose wait.
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-mixed', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '【S2 核验通过】@Designer Bot 【S3 · 工程上链】[DEPENDS_ON: eleven 媒体包 + Lucy 素材包（均已核验定版）] [DEADLINE: 15m] 直接开工。\n'
        + '@Coder Bot 你的发布等 Builder 的 metaapp:// 落地后我立即派单，草案先备好。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    // Even an UNCONDITIONAL ETA ACK must not arm while the member's dispatch
    // clause declares a prose wait (the advisory foreign tag must not mask it).
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0-ack', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，预计 5 分钟。',
      chainTimestamp: Math.floor(startMs / 1000) + 30,
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`),
      undefined,
      'prose wait in the member\'s own clause suspends the deadline even beside a foreign tag',
    );
    h.state.nowMs = startMs + 20 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.sends.filter((send) => /estimated delivery/.test(send.content)).length,
      0,
      'no deadline alert for the prose-waiting member',
    );
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P0-1: a retained deadline alert carries the member\'s dependency state; standby members never alert', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Member 2: real assignment + unconditional ETA — the alert fires and must
    // carry the dependency-state suffix (REQ: 告警文案必须带依赖状态).
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0d-assign', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S1。[DEADLINE: 1m]',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p0d-ack', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单，预计 1 分钟。',
      chainTimestamp: Math.floor(startMs / 1000) + 10,
    });
    await h.loop.runTick();
    assert.ok(h.store.get(`group_task_expected_delivery:${task.id}:2`), 'deadline armed');
    // Member 3: a legacy/stale armed kv while parked — standby members cannot
    // be late (task #62's false alert hit a chair-parked observer).
    h.store.set(
      `group_task_expected_delivery:${task.id}:3`,
      JSON.stringify({ dueAt: startMs - 60_000, ackedAt: startMs - 120_000, taskDescription: 'S9' }),
    );
    h.groupTaskStore.setMemberStatus(task.id, 3, 'standby', 'gmid-w3');
    h.state.nowMs = startMs + 5 * 60_000;
    await h.loop.runTick();
    // Single-commander: the overdue alert is an environment note for the chair.
    const deadlineNotes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'deadline');
    assert.equal(deadlineNotes.length, 1, 'only the genuinely-overdue member rings the bell');
    assert.match(deadlineNotes[0].body, /Coder Bot/);
    assert.match(deadlineNotes[0].body, /dependency state: no upstream dependency declared/);
    assert.equal(
      h.store.get(`group_task_delivery_reminded:${task.id}:3`),
      undefined,
      'the standby member\'s clock does not advance',
    );
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P0-2: the chair-response watchdog defers while a chair turn is in flight (no redrive, no drop)', async () => {
  let releaseTurn;
  const gate = new Promise((resolve) => { releaseTurn = resolve; });
  const h = await createHarness({
    deps: {
      chairResponseRedriveMs: 60_000,
      performChat: async () => {
        await gate;
        return '收到，质量门核验中。';
      },
    },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // A worker question the chair owes an answer to; the chair turn dispatches
    // and stays in flight (gated) — standing in for a 7-minute quality gate.
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p02-q', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '@Twin Bot S3 产物齐了，请核验。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    const rawLoop = createGroupTaskDaemonLoop(h.deps);
    await rawLoop.runTick();
    assert.ok(
      rawLoop.getTurnActivity().some((turn) => turn.taskId === task.id && turn.metabotId === 1),
      'the chair turn is in flight',
    );
    assert.ok(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      'the obligation is armed',
    );
    // Well past the redrive window with the chair turn STILL running: the
    // watchdog must slide the countdown — never redrive, never drop, never
    // alert (task #62 fired twice inside exactly this window).
    h.state.nowMs = startMs + 30 * 60_000;
    await rawLoop.runTick();
    const pending = JSON.parse(h.store.get(`group_task_chair_response_pending:${task.id}`));
    assert.equal(pending.redriven ?? false, false, 'no re-drive while the chair turn runs');
    assert.ok(pending.atMs > startMs, 'the silence countdown slid forward');
    // The turn completes — its reply answers the trigger and clears the
    // obligation; no watchdog noise afterwards either.
    releaseTurn();
    await rawLoop.whenIdle();
    h.state.nowMs = startMs + 60 * 60_000;
    await rawLoop.runTick();
    assert.equal(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      undefined,
      'the completed chair turn clears the obligation',
    );
    assert.equal(
      h.sends.filter((send) => /never answered/.test(send.content)).length,
      0,
      'no "chair never answered" alert at any point',
    );
  } finally {
    releaseTurn();
    h.cleanup();
  }
});

test('fix-v2 P0-2: a genuinely silent chair still gets one re-drive after a full window', async () => {
  // chatErrorAlways: every chair turn fails — no speech, no session writes, so
  // the responsiveness gate must NOT hold the watchdog back.
  const h = await createHarness({
    deps: { chairResponseRedriveMs: 60_000 },
    chatErrorAlways: 'chair LLM unreachable',
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'pin-v2p02b-q', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '@Twin Bot 这个问题需要 chair 确认。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      'obligation armed (a failed chair turn answers nothing)',
    );
    // A full window of continuous silence → exactly one re-drive; the
    // obligation stays armed for the final-drop escalation.
    h.state.nowMs = startMs + 30 * 60_000;
    await h.loop.runTick();
    const pending = JSON.parse(h.store.get(`group_task_chair_response_pending:${task.id}`));
    assert.equal(pending.redriven, true, 'a continuously silent chair is re-driven once');
    // Another full window of silence after the re-drive → the obligation is
    // dropped (the anomaly escalation covers it from there).
    h.state.nowMs = startMs + 60 * 60_000;
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_chair_response_pending:${task.id}`),
      undefined,
      'still silent after the re-drive: the obligation is dropped, not re-driven again',
    );
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P1-3: the stuck alert cites verifiable evidence and never mislabels an expired prose wait', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      memberTimeoutAfterMinutes: 1,
      memberUnreachableAfterMinutes: 1,
      sendMilestoneToSourceSession: (payload) => { milestones.push(payload); return true; },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-v2p13a', task.id]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // Same shape as the exemption-expiry test: a prose dependency dispatch,
    // the worker ACKs, then goes completely silent.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-prose-evidence-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 你负责 S5 质检，依赖 S4 的交付，等它上线后开始。',
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-prose-evidence-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到，等 S4', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    // Within the cap: exempt, no alert.
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), undefined, 'no alert inside the prose window');

    // Past the cap: the alert fires — and it must NOT read "no upstream
    // dependency declared" (task #57's mislabel): a prose wait WAS declared.
    h.state.nowMs = startMs + PROSE_DEPENDENCY_EXEMPTION_MAX_MS + 60_000;
    await h.loop.runTick();
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1', 'the stuck alert fires after the cap');
    const anomaly = milestones.find((entry) => entry.kind === 'anomaly' && /looks stuck/.test(entry.message));
    assert.ok(anomaly, 'the stuck alert reached the origin session');
    assert.match(
      anomaly.message,
      /prose-declared upstream wait in the latest dispatch \(time-capped exemption expired\)/,
      'the dependency state names the expired prose exemption',
    );
    assert.doesNotMatch(anomaly.message, /no upstream dependency declared/, 'never the #57 mislabel');
    // Evidence pointers: ledger state, last speech, session last write, and
    // the last [WORKING] signal — each with a minutes-ago figure.
    assert.match(anomaly.message, /evidence: no deliverable on the ledger/);
    assert.match(anomaly.message, /last group speech at \d{2}:\d{2} \(UTC[+-]\d{2}\), \d+ min ago/);
    assert.match(anomaly.message, /session log last write at \d{2}:\d{2} \(UTC[+-]\d{2}\), \d+ min ago/);
    assert.match(anomaly.message, /last \[WORKING\] signal at \d{2}:\d{2} \(UTC[+-]\d{2}\), \d+ min ago/);
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P1-3: a rejected deliverable still surfaces in the stuck evidence with its pin', async () => {
  const milestones = [];
  const h = await createHarness({
    deps: {
      memberTimeoutAfterMinutes: 1,
      memberUnreachableAfterMinutes: 1,
      sendMilestoneToSourceSession: (payload) => { milestones.push(payload); return true; },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-v2p13b', task.id]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // A plain dispatch (no dependency language), the worker ACKs and goes
    // silent; its only ledger entry is a REJECTED deliverable — the
    // delivered-then-idle guard must not apply, but the alert must cite it.
    insertGroupMessage(h.db, {
      pinId: 'dispatch-plain-evidence-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 请处理 S7 图标导出。',
      chainTimestamp: Math.floor((startMs - 150_000) / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'working-plain-evidence-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到', chainTimestamp: Math.floor((startMs - 120_000) / 1000),
    });
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const lastMsgId = h.db.exec('SELECT MAX(id) FROM group_chat_messages')[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, lastMsgId);
    const rejectedPin = 'a'.repeat(64);
    const deliverable = h.groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: `${rejectedPin}i0`,
      authorGlobalmetaid: 'gmid-w2',
      kind: 'pinid',
      uri: `pin://${rejectedPin}i0`,
    });
    h.db.run(
      "UPDATE group_task_deliverables SET status = 'rejected', created_at = ? WHERE id = ?",
      [new Date(startMs - 30 * 60_000).toISOString().slice(0, 19).replace('T', ' '), deliverable.id],
    );
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);

    await h.loop.runTick();
    assert.equal(h.store.get('group_task_stuck_alert:1:2'), '1', 'a rejected deliverable does not shield the member');
    const anomaly = milestones.find((entry) => entry.kind === 'anomaly' && /looks stuck/.test(entry.message));
    assert.ok(anomaly, 'the stuck alert reached the origin session');
    assert.match(
      anomaly.message,
      new RegExp(`latest ledger deliverable pin://${rejectedPin}i0 \\(rejected\\) at \\d{2}:\\d{2} \\(UTC[+-]\\d{2}\\), \\d+ min ago`),
      'the evidence cites the rejected deliverable pin and its time',
    );
    assert.match(anomaly.message, /no upstream dependency declared in the dispatch/, 'plain dispatch: the honest label');
  } finally {
    h.cleanup();
  }
});

test('fix-v2 P1-5: a corrupt-log recurrence within the rebuild cooldown escalates immediately with guidance', async () => {
  const milestones = [];
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      runSkillTurn: null,
      sendMilestoneToSourceSession: (payload) => { milestones.push(payload); return true; },
    },
  });
  // Every turn fails corrupt — even on the rebuilt session (the dual writer
  // is still live, so the fresh log keeps getting clobbered).
  h.deps.runSkillTurn = async () => {
    throw new Error('corrupt session log: seq gap in committed region at line 7 (expected 10, got 8)');
  };
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-v2p15', task.id]);
    insertGroupMessage(h.db, {
      pinId: 'trigger-corrupt-capped-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot please deliver step 6',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) - 60,
    });
    const triggerId = h.db.exec(
      "SELECT id FROM group_chat_messages WHERE pin_id = 'trigger-corrupt-capped-i0'",
    )[0].values[0][0];
    h.groupTaskStore.updateLastProcessedMsgId(task.id, triggerId - 1);

    // Tick 1: first corrupt failure → rebuild + requeue (unchanged behavior).
    await h.loop.runTick();
    assert.ok(h.store.get('group_task_corrupt_session_rebuild:1:2'), 'rebuild stamp recorded');
    const rebuilt = milestones.find((m) => /^corrupt_session_rebuild:/.test(m.subject ?? ''));
    assert.ok(rebuilt, 'the rebuild itself is reported immediately');
    // fix-v2 follow-up (P1-5 layer 3): the alert quotes the corruption
    // signature so the gap position and expected/got seq values are visible
    // without opening the session log.
    assert.match(rebuilt.message, /expected 10, got 8/);

    // Tick 2: the requeued turn hits corruption AGAIN within the cooldown —
    // instead of silently burning the 5-turn retry ladder, the origin session
    // gets an immediate escalation with self-heal guidance.
    await h.loop.runTick();
    const capped = milestones.find((m) => /^corrupt_session_rebuild_capped:/.test(m.subject ?? ''));
    assert.ok(capped, 'recurrence within the cooldown escalates immediately');
    assert.match(capped.message, /AGAIN within an hour/);
    assert.match(capped.message, /restart the app/);
    assert.match(capped.message, /expected 10, got 8/);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #66 fixes A/B: mid-turn speech vs turn contracts
// ---------------------------------------------------------------------------

test('task #66 A: an empty final reply after mid-turn group_chat sends is a DELIVERED turn, not a failure', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    deps: {
      // The skill turn sends ONE group message mid-turn via the group_chat
      // tool and then ends with an empty final reply (ONE VOICE closer).
      runSkillTurn: async (params) => {
        h.coworkStore.addMessage(params.sessionId, {
          type: 'tool_use',
          content: 'Using tool: group_chat',
          metadata: { toolName: 'group_chat', toolInput: { action: 'send_group_message', group_id: GROUP_ID } },
        });
        return { replyText: '', assistantMessageId: null };
      },
    },
  });
  try {
    h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'midturn-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot deliver the report',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.ok(
      logs.some((line) => line.includes('delivered 1 group message(s) mid-turn via group_chat')),
      'the turn is recognized as delivered mid-turn',
    );
    assert.ok(
      !logs.some((line) => line.includes('turn failed') || line.includes('retry')),
      'no failure path burned, no duplicate re-run queued',
    );
    // The daemon posts nothing on top of the tool-sent message.
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

test('task #66 A: the bootstrap planning turn yields to a chair that already dispatched in its own voice', async () => {
  const logs = [];
  // The minimal directive asks only for what is missing; the LLM correctly
  // answers [NO_REPLY] (task #66 shape: everything was already delivered).
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: { performChat: async () => '[NO_REPLY]' },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    // The chair (its own session) already greeted + dispatched a worker.
    insertGroupMessage(h.db, {
      pinId: 'chair-self-dispatch-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot you take S1, deliver in 20 minutes.',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'planning marked complete');
    assert.ok(
      logs.some((line) => line.includes('planning bootstrap completed minimally')),
      'the minimal path ran without burning attempts',
    );
    assert.ok(
      !logs.some((line) => line.includes('planning turn failed')),
      'no attempt budget consumed',
    );
    // Nothing was missing — no duplicate content posted.
    assert.equal(h.sends.length, 0);
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Task #66 optimizations: ① chain-health facts, ② verification economy
// ---------------------------------------------------------------------------

test('task #66 ①: two consecutive send failures record ONE chain_health note; first success records recovery', async () => {
  const h = await createHarness({ workerCooldownMs: 0 });
  const chainNotes = (taskId) => h.groupTaskStore.listPendingHostNotes(taskId)
    .filter((note) => note.kind === 'chain_health');
  const allChainNotes = () => Number(h.db.exec(
    "SELECT COUNT(*) FROM group_task_host_notes WHERE kind = 'chain_health'",
  )[0].values[0][0]);
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();

    // First failing send: below the threshold, no note yet.
    h.state.sendFailures = new Set([2]);
    insertGroupMessage(h.db, {
      pinId: 'health-fail-1-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot ping',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(allChainNotes(), 0, 'one failure does not alarm');
    h.state.nowMs += 30_000;

    // Second failing send: the backend-unreachable fact lands for the chair.
    insertGroupMessage(h.db, {
      pinId: 'health-fail-2-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot ping again',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 1,
    });
    await h.loop.runTick();
    const downNotes = chainNotes(task.id).filter((note) => note.body.includes('failed 2 consecutive times'));
    assert.equal(downNotes.length, 1, 'two consecutive failures ring the bell once');
    assert.match(downNotes[0].body, /usually the chain backend being unreachable/);

    // Recovery: the first successful send records the recovery fact.
    h.state.sendFailures = null;
    insertGroupMessage(h.db, {
      pinId: 'health-ok-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '@Coder Bot third ping',
      chainTimestamp: Math.floor(h.state.nowMs / 1000) + 2,
    });
    await h.loop.runTick();
    const recovered = chainNotes(task.id).filter((note) => note.body.includes('RECOVERED'));
    assert.equal(recovered.length, 1, 'recovery note recorded on the first success');
  } finally {
    h.cleanup();
  }
});

test('task #66 ②: the chair playbook carries the verification-economy rule', () => {
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'chair',
  });
  assert.match(prompt, /VERIFICATION ECONOMY/);
  assert.match(prompt, /Do NOT re-download and re-hash what a host verification fact or a worker-supplied checksum already confirms/);
  assert.match(prompt, /SEMANTIC layer/);
});

// ---------------------------------------------------------------------------
// EP33 fixes: P1② review-phase supervision, P2 planning dedupe
// ---------------------------------------------------------------------------

test('EP33 P1②: a review-phase supervisor nudge wakes the chair (reopen hatch); checkpoint still defers', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    h.groupTaskStore.updateTaskStatus(task.id, 'review');
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id, kind: 'nudge', note: 'defect found in acceptance: zip URI missing i0 suffix', target: 'Coder Bot',
    });

    await h.loop.runTick();

    const signals = h.groupTaskStore.listSupervisorSignals(task.id);
    assert.equal(signals[0].processedAt != null, true, 'review nudge is ANSWERED, not deferred forever');
    assert.ok(h.sends.some((send) => send.metabotId === 1), 'the chair spoke in its own voice');
    assert.ok(
      !h.sends.some((send) => /GROUP_TASK_NOTICE/.test(send.content)),
      'still no host-authored group notice (single-commander)',
    );

    // An open checkpoint still defers (the owner is mid-decision).
    const h2 = await createHarness();
    const task2 = h2.createTask([2]);
    h2.groupTaskStore.updateTaskStatus(task2.id, 'review');
    h2.groupTaskStore.openCheckpoint({ taskId: task2.id, topic: 'draft approval', msgPinId: 'pin-cp' });
    h2.groupTaskStore.addSupervisorSignal({
      taskId: task2.id, kind: 'nudge', note: 'check while checkpoint open',
    });
    await h2.loop.runTick();
    assert.equal(h2.groupTaskStore.listSupervisorSignals(task2.id)[0].processedAt, null, 'checkpoint defers the supervisor turn');
    h2.cleanup();
  } finally {
    h.cleanup();
  }
});

test('EP33 P2: planning bootstrap yields to a chair that already opened the task (minimal turn, no duplicate opening)', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3], { activate: false }); // planning
    // The owner's Twin opened the task manually: voting kickoff mentioning the
    // workers, members voted — exactly EP33's shape.
    insertGroupMessage(h.db, {
      pinId: 'twin-open-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '【第33期选题投票】候选池发布，请全员投票：A xxx / B yyy',
      mention: ['gmid-w2', 'gmid-w3'],
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'bootstrap completed');
    assert.ok(
      logs.some((line) => line.includes('planning bootstrap completed minimally')),
      'the minimal path ran',
    );
    assert.ok(
      !h.sends.some((send) => send.metabotId === 1 && /欢迎|welcome|候选/i.test(send.content)),
      'no duplicate opening content',
    );
    assert.ok(h.sends.filter((send) => send.metabotId === 1).length <= 1, 'at most one minimal chair post');
  } finally {
    h.cleanup();
  }
});


// ---------------------------------------------------------------------------
// GT#70 ①③: status-tag citation rule + planning race re-check
// ---------------------------------------------------------------------------

test('GT#70 ①: the chair playbook mandates backtick-wrapped status-tag citations', () => {
  const prompt = buildGroupTaskSystemPrompt({
    metabot: { name: 'Twin Bot' },
    task: { title: 'T', goal: 'G' },
    members: [
      { name: 'Twin Bot', role: 'chair' },
      { name: 'Coder Bot', role: 'worker' },
    ],
    botRole: 'chair',
  });
  assert.match(prompt, /CITATIONS of status tags must be backtick-wrapped/);
  assert.match(prompt, /A bare end-positioned tag is parsed as an instruction and flips the task IMMEDIATELY/);
  // GT#72: the tag-lead rule is taught in the same breath as the citation rule.
  assert.match(prompt, /the tag must sit at an END of its line/);
});

test('GT#70 ③: a chair dispatch landing WHILE the planning LLM runs is success, not a burned attempt', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: {
      // Simulate the GT#70 race: at gate-check time nothing exists; the chair's
      // mid-turn kickoff lands as a side effect DURING the LLM call.
      performChat: async () => {
        insertGroupMessage(h.db, {
          pinId: 'race-kickoff-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
          senderName: 'Twin Bot',
          content: '【开工对齐】@Coder Bot 你负责 S1，20 分钟内交付。',
          mention: ['gmid-w2'],
          chainTimestamp: Math.floor(h.state.nowMs / 1000),
        });
        return '[NO_REPLY]';
      },
    },
  });
  try {
    const task = h.createTask([2], { activate: false }); // planning
    await h.loop.runTick();
    assert.equal(h.store.get(`group_task_chair_planned:${task.id}`), '1', 'planning marked complete');
    assert.ok(
      logs.some((line) => line.includes('the chair dispatched while the planning LLM ran')),
      'the race is recognized as success',
    );
    assert.ok(
      !logs.some((line) => line.includes('planning turn failed')),
      'no attempt budget burned',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// RFP-2026-09-08 R3.2/R3.3: supervisor-exhaustion alert classification
// ---------------------------------------------------------------------------

test('R3.2/R3.3: exhausted supervisor signals alert as RECOVERED when the task has fresh activity', async () => {
  const milestones = [];
  const h = await createHarness({
    ackTimeoutMs: 180_000,
    deps: {
      sendMilestoneToSourceSession: (input) => { milestones.push(input); return true; },
      performChat: async () => { throw new Error('LLM unreachable'); },
    },
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    // Milestone delivery requires a source session; wire one.
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['sess-r32-origin', task.id]);
    // A pending nudge whose chair turn fails every attempt.
    h.groupTaskStore.addSupervisorSignal({ taskId: task.id, kind: 'nudge', note: 'check the zip uri' });
    // Fresh deliverable activity INSIDE the 5-min window → recovered verdict.
    h.groupTaskStore.addDeliverable({
      taskId: task.id,
      msgPinId: 'pin-fresh-i0',
      authorGlobalmetaid: 'gmid-w2',
      kind: 'pinid',
      uri: `pin://${'ab'.repeat(32)}i0`,
    });
    for (let i = 0; i < 4; i += 1) await h.loop.runTick();

    const exhaustedAlerts = milestones.filter((m) => /supervisor_signals_(recovered|unanswered)/.test(m.subject ?? ''));
    assert.ok(exhaustedAlerts.length >= 1, `an exhaustion alert fired (got ${JSON.stringify(milestones.map((m) => m.subject))})`);
    assert.match(
      exhaustedAlerts[exhaustedAlerts.length - 1].subject,
      /supervisor_signals_recovered/,
      'the RECOVERED variant fires for a task with fresh activity',
    );
    assert.match(
      String(exhaustedAlerts[exhaustedAlerts.length - 1].message),
      /has since recovered/,
    );
    assert.ok(
      !milestones.some((m) => /supervisor_signals_unanswered/.test(m.subject ?? '')),
      'no stale unanswered alert for a recovered task',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// R6/R7/R8 (OpenTeam chat scenario 2026-09): chair-side daemon adaptations
// ---------------------------------------------------------------------------

test('R6 gating: chat-mode workers wake on conversational messages without an @', () => {
  // Task-mode regression: a bare conversational line wakes no worker.
  const taskMode = decideGroupTaskResponders(
    gateMessage({ content: 'anyone have thoughts on the plan?' }),
    gateTask(), GATE_MEMBERS, GATE_BOTS,
  );
  assert.ok(
    !taskMode.some((decision) => decision.reason === 'worker_mentioned'),
    'task mode keeps workers mention-gated',
  );

  // Chat mode: the same line wakes every worker (protocol-only lines do not).
  const chatTask = { ...gateTask(), mode: 'chat' };
  const chatDecisions = decideGroupTaskResponders(
    gateMessage({ content: 'anyone have thoughts on the plan?' }),
    chatTask, GATE_MEMBERS, GATE_BOTS,
  );
  const chatWorkers = chatDecisions.filter((decision) => decision.reason === 'worker_mentioned');
  assert.equal(chatWorkers.length, GATE_MEMBERS.filter((member) => member.role === 'worker').length);
  const protocolOnly = decideGroupTaskResponders(
    gateMessage({ content: '[STATUS:DONE]' }),
    chatTask, GATE_MEMBERS, GATE_BOTS,
  );
  assert.ok(
    !protocolOnly.some((decision) => decision.reason === 'worker_mentioned'),
    'protocol-only lines never wake chat workers',
  );
});

test('R7: an out-of-band chair response closes pending supervisor signals with its pin', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]); // executing
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id,
      kind: 'nudge',
      note: 'post a status update',
    });
    const pendingBefore = h.groupTaskStore.listPendingSupervisorSignals(task.id);
    assert.equal(pendingBefore.length, 1);

    // The chair answers OUT-OF-BAND (Twin direct / status tag / plain reply):
    // a genuine chair message landing AFTER the signal was created, never
    // posted by the daemon (fresh pin, no host notice).
    const responsePin = `${'9'.repeat(64)}i0`;
    // Signal created_at is REAL sqlite now; anchor the response to the same
    // clock (the fake daemon clock is unrelated to chain timestamps).
    insertGroupMessage(h.db, {
      pinId: responsePin,
      senderMetaId: 'metaid-twin',
      senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'False alarm — I already covered this with the owner directly.',
      chainTimestamp: Math.floor(Date.now() / 1000) + 5,
    });

    const chatCallsBefore = h.chatCalls.length;
    await h.loop.runTick();

    // Closed with the chair's own pin — and NO redundant chair answer turn.
    const signals = h.groupTaskStore.listSupervisorSignals(task.id);
    assert.equal(signals.length, 1);
    assert.ok(signals[0].processedAt != null, 'signal processed');
    assert.equal(signals[0].chairResponsePinId, responsePin, 'closed with the out-of-band pin');
    assert.equal(h.chatCalls.length, chatCallsBefore, 'no daemon chair turn was dispatched');
  } finally {
    h.cleanup();
  }
});

test('R7: a response created BEFORE a newer signal does not close it', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    // Chair response lands first (old news)…
    insertGroupMessage(h.db, {
      pinId: `${'8'.repeat(64)}i0`,
      senderMetaId: 'metaid-twin',
      senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'Earlier remark, unrelated to the later nudge.',
      chainTimestamp: Math.floor(Date.now() / 1000) - 600,
    });
    // …then the supervisor records a FRESH nudge — the old message must not
    // close it; the daemon drives the normal chair answer turn instead.
    h.groupTaskStore.addSupervisorSignal({
      taskId: task.id,
      kind: 'nudge',
      note: 'fresh question for the chair',
    });
    await h.loop.runTick();
    const signals = h.groupTaskStore.listSupervisorSignals(task.id);
    assert.ok(signals[0].processedAt != null, 'answered by the daemon chair turn');
    assert.notEqual(
      signals[0].chairResponsePinId,
      `${'8'.repeat(64)}i0`,
      'the pre-signal message is not the closure pin',
    );
    assert.ok(h.chatCalls.some((call) => call.userMessage.includes('fresh question')), 'chair turn ran');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#72 (observation round 1): chair bare-name assignment wakes + deadline
// clause scoping + retroactive ACK satisfaction.
// ---------------------------------------------------------------------------

test('GT#72: contentAddressesRosterName — full names and unique short forms match; ambiguity and prose do not', () => {
  const { contentAddressesRosterName } = require('../dist-electron/main/services/groupChatMentionUtils.js');
  const roster = ['Twin Bot', 'Coder Bot', 'Builder阿码', '小明同学'];
  assert.equal(contentAddressesRosterName('Builder阿码，第二棒正式开工 [DEADLINE: 60m]', 'Builder阿码', roster), true);
  assert.equal(contentAddressesRosterName('builder阿码 交一下', 'Builder阿码', roster), true, 'case-insensitive');
  // Unique trimmed forms — the task #72 short-name habits: drop the latin
  // prefix ("阿码" for Builder阿码) or the trailing part ("小明" for 小明同学).
  assert.equal(contentAddressesRosterName('阿码，预备作业即刻开工', 'Builder阿码', roster), true, 'unique suffix form addresses the member');
  assert.equal(contentAddressesRosterName('小明，接评审棒', '小明同学', roster), true, 'unique prefix form addresses the member');
  // A form that also addresses ANOTHER member is ambiguous — never a wake.
  const ambiguousRoster = ['小明同学', '同学王'];
  assert.equal(contentAddressesRosterName('同学们，开工', '小明同学', ambiguousRoster), false);
  assert.equal(contentAddressesRosterName('同学们，开工', '同学王', ambiguousRoster), false);
  // Latin forms need word boundaries — "co" of "Coder Bot" must not fire on
  // ordinary prose words.
  assert.equal(contentAddressesRosterName('please confirm the spec', 'Coder Bot', roster), false);
  assert.equal(contentAddressesRosterName('Coder，接第二棒', 'Coder Bot', roster), true, 'whole-word prefix matches');
  assert.equal(contentAddressesRosterName('无关正文', 'Builder阿码', roster), false);
  assert.equal(contentAddressesRosterName('', 'Builder阿码', roster), false);
});

test('GT#72: a chair assignment by BARE full roster name wakes the assignee and arms the ACK watch', async () => {
  // The #4344 replay: the chair assigned the second baton with a bare name
  // (no @, empty mention array) and the assignee was never woken — rescued
  // 7.5 minutes later only because a teammate happened to @ him.
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]); // executing; roster: Twin Bot (chair), Coder Bot (worker)
    insertGroupMessage(h.db, {
      pinId: 'bare-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '两条核验做完了。\nCoder Bot，第二棒正式开工 [DEADLINE: 60m]：字段级协议规范，以事实卡为硬约束。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 1, 'the bare-named assignee got a turn');
    assert.equal(h.sends.length, 1, 'the assignee answered in the group');
    assert.ok(
      logs.some((line) => line.includes('assignment to Coder Bot (message #') && line.includes('waiting for [WORKING] ACK')),
      'the ACK watch armed for the bare-named assignee',
    );
    // A worker sending the same bare name does NOT wake anyone (loose
    // matching is chair-only — worker chatter stays @-gated).
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'worker-bare-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: 'Twin Bot 我交付完了',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'a worker\'s bare name never wakes the chair');

    // The bare-name wake is gated to ASSIGNMENT-SHAPED chair messages: a
    // name cited in a deadline-less round-up (task #51's liveness-notice
    // shape) wakes nobody.
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'notice-bare-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'ℹ️ Coder Bot is in a long-running turn; no action needed.',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 1, 'a bare name in a deadline-less chair notice never wakes the cited worker');

    // The #4344 shape proper: SHORT-FORM assignment ("Coder" for "Coder Bot")
    // on a deadline-bearing chair message wakes the assignee.
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'shortname-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'Coder，第一落 [DEADLINE: 60m]：字段级协议规范，即刻开工。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 2, 'the short-form assignment reached its assignee');
  } finally {
    h.cleanup();
  }
});

test('GT#72: a deadline-bearing chair message that wakes NO worker records the assignment-wake note', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'nowake-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      // Short form "Coder" is neither the roster name "Coder Bot" nor an @-token.
      content: '阿码，预备作业即刻开工，[DEADLINE: 30m]，交付形式 simplenote 落链。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.equal(h.chatCalls.length, 0, 'nobody wakes for a short-form assignment');
    const notes = h.groupTaskStore.listPendingHostNotes(task.id)
      .filter((note) => note.kind === 'parse' && note.target === 'assignment wake');
    assert.equal(notes.length, 1, 'the stalled assignment is reported to the chair');
    assert.match(notes[0].body, /wakes no member/);
    assert.match(notes[0].body, /exact roster name/);
  } finally {
    h.cleanup();
  }
});

test('GT#72: deadline arming is scoped to the member\'s own dispatch clause (no cross-member bleed)', async () => {
  // The #4347 replay: one chair message carried 啊明's [DEADLINE: 45m] AND a
  // deadline-less clause for another worker — whole-message parsing armed the
  // WRONG member's clock with 45m. Clause scoping must read only the ACKing
  // member's own clause.
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]); // Coder Bot + Designer Bot
    insertGroupMessage(h.db, {
      pinId: 'multi-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '调研核验完成。\n'
        + '@Designer Bot，下一棒：PRD v0.8 组稿预备，现在开工，[DEADLINE: 45m]。\n'
        + '@Coder Bot 这三点随你第一落一起落进 schema。\n'
        + '当前时钟：组稿 02:12。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick(); // both workers dispatched

    // Coder Bot ACKs — its own clause carries NO deadline: nothing armed.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'coder-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：schema 增补，预计 20 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`) ?? null,
      null,
      'Coder Bot ACKs a deadline-less clause — no clock armed (no 45m bleed)',
    );

    // Designer Bot ACKs — its own clause carries the 45m: armed.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'designer-ack-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单：组稿预备，预计 40 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:3`);
    assert.ok(armed, 'Designer Bot ACKs its own [DEADLINE: 45m] clause — clock armed');
    assert.match(JSON.parse(armed).taskDescription ?? '', /组稿预备/);
    assert.ok(logs.some((line) => line.includes('armed the chair-stated deadline: 45m')));
  } finally {
    h.cleanup();
  }
});

test('GT#72: an ACK that lands just BEFORE the assignment\'s watch arming satisfies it retroactively', async () => {
  // The #4352/#4353 replay: the worker ACKed the merge assignment, and 47
  // seconds later a chair re-mention armed a fresh ACK watch that no ACK
  // would ever satisfy — the deadline never ticked.
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]);
    // 1. Initial assignment — arms a watch, gets ACKed normally.
    insertGroupMessage(h.db, {
      pinId: 'merge-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 组稿预备，现在开工。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'merge-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：组稿预备，预计 30 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    // 2. Chair RE-mentions the same assignment with a deadline — the watch
    // would arm here, but the member already ACKed seconds ago.
    h.state.nowMs += 20_000;
    insertGroupMessage(h.db, {
      pinId: 'merge-reassign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot，下一棒：PRD v0.8 组稿预备 [DEADLINE: 45m]，单一 Markdown 文件十章节。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();

    assert.ok(
      logs.some((line) => line.includes('ACKed [WORKING] just before assignment') && line.includes('retroactively satisfied')),
      'the watch recognized the just-prior ACK',
    );
    assert.ok(
      logs.some((line) => line.includes('retroactively satisfied, armed the chair-stated deadline: 45m')),
      'the deadline armed from the re-mention assignment',
    );
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:2`);
    assert.ok(armed, 'expected_delivery armed despite the ACK-before-watch race');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P1-2): a chair-stated [DEADLINE] arms a member's clock ONLY when
// the chair @-addressed that member (or listed them in the mention array).
// GT#87's #5880 replay: the chair locked another worker's baton and RESTATED
// that worker's `[DEADLINE: 140m]`, while the message's only reference to
// 阿力 was a bare-name praise paragraph explicitly marked "无需回执" — the
// bare-name clause reached across into the restated tag and retro-armed
// 阿力's clock; the false bell fired 2h20m later and the chair burned a
// public turn trying (and failing) to reconcile it against every deadline it
// had ever stated. Bare-name prose keeps wake/ACK-watch eligibility but is
// never a clock source.
// ---------------------------------------------------------------------------

test('GT#87: a deadline restated for another worker never arms the bare-named member\'s clock', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]); // Coder Bot + Designer Bot
    // The #5880 shape: @-addressed lock + restated deadline for Coder Bot
    // (unquoted — a quoted restatement is a citation that no longer
    // bare-name-wakes; that behavior is covered by the P2-5 test), bare-name
    // praise paragraph for Designer Bot ("无需回执").
    insertGroupMessage(h.db, {
      pinId: 'gt87-cross-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 状态锁定：实现口径已定，部署断言清单同步抄送 Designer Bot 增补段一份。'
        + '[DEADLINE: 140m] 时钟照旧（5863 起算）。\n\n'
        + 'Designer Bot（无需回执）：复核干净利落——29 vs 30 两边都对，对表以全绿为准。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // Both are woken (Coder via @, Designer via the GT#72 bare-name rule on a
    // deadline-bearing chair message) — wake semantics unchanged.
    assert.equal(h.chatCalls.length, 2, 'both the @-addressed and bare-named workers got turns');

    // Designer Bot ACKs [WORKING] — pre-fix this armed the 140m restated for
    // Coder Bot onto Designer's clock via the whole-message clause fallback.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-cross-ack-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单：SOP 增补段 v0.3，预计 20 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:3`) ?? null,
      null,
      'the bare-named member never inherits another worker\'s restated deadline',
    );
    assert.ok(
      logs.some((line) =>
        line.includes('[DEADLINE:140m] found for Designer Bot')
        && line.includes('without an @-address or mention-array hit — not arming their clock')),
      'the skipped arming is on the record for future debriefs',
    );

    // Coder Bot ACKs the SAME message — @-addressed, its own 140m arms.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-cross-ack2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：实现开工，预计 120 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:2`);
    assert.ok(armed, 'the @-addressed worker\'s own deadline still arms');
    assert.equal(JSON.parse(armed).dueAt - JSON.parse(armed).ackedAt, 140 * 60_000);
  } finally {
    h.cleanup();
  }
});

test('GT#87 audit: a backtick-quoted [DEADLINE] citation never arms the @-addressed member\'s own clock', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]);
    // @-addressed dispatch for Designer Bot, but the ONLY [DEADLINE] in the
    // message is a backticked citation of Coder Bot's clock — the chair
    // playbook's own "quote restatements in backticks" discipline. Pre-fix,
    // the ACK-arming parse read the RAW clause, so Designer's [WORKING] ACK
    // armed Coder's 140m onto Designer's clock (the GT#87 phantom-clock shape
    // the branch claimed to close; the wake and ACK-watch gates got the
    // quote-strip, the arming parse did not).
    insertGroupMessage(h.db, {
      pinId: 'gt87-quoted-cite-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Designer Bot 状态锁定：部署断言清单由你复核，现在开工。'
        + '注意阿码的 `[DEADLINE: 140m]` 时钟照旧（5863 起算），那是他的实现时钟，与你的复核无关。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-quoted-cite-ack-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单：复核开工，预计 30 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:3`) ?? null,
      null,
      'a quoted [DEADLINE] citation of another worker\'s clock never arms the @-addressed member',
    );
  } finally {
    h.cleanup();
  }
});

test('GT#87: a mention-array hit still arms the clock when the text carries no @-token', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]);
    // Mention-array-only dispatch (daemon-generated assignment shape): the
    // text addresses by bare roster name, the mention array carries the ids.
    insertGroupMessage(h.db, {
      pinId: 'gt87-mentionarr-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'Designer Bot，下一棒：PRD v0.8 组稿预备，现在开工，[DEADLINE: 45m]。',
      mention: ['metaid-3'],
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-mentionarr-ack-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单：组稿预备，预计 40 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:3`);
    assert.ok(armed, 'mention-array dispatch arms the addressed member\'s clock');
    assert.equal(JSON.parse(armed).dueAt - JSON.parse(armed).ackedAt, 45 * 60_000);
    assert.ok(logs.some((line) => line.includes('armed the chair-stated deadline: 45m')));
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P1-3): the delivery clock must die when the step is publicly done.
// GT#87 replays: (a) the worker's 18:00 prep report ([WORKING→完成], no
// [DELIVERABLE] tag) never cleared the armed 30m clock — the first false
// missed-deadline rang at 18:26 anyway; (b) round-2's "already ACKed; no new
// ACK watch" left round-1's armed clock ticking through the new phase. Plus:
// a bell that cannot be traced to its arming dispatch cost the chair a public
// reconciliation turn — the note now carries the clock's source.
// ---------------------------------------------------------------------------

test('GT#87: a completion-shaped ACK ([WORKING→…]) retires the armed delivery clock', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'gt87-comp-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 准备工作：精读协议，回报 worktree+分支名 [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-comp-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：精读协议，预计 25 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get(`group_task_expected_delivery:${task.id}:2`), '30m clock armed on ACK');

    // The plain-speech completion report — no [DELIVERABLE] tag. Pre-fix this
    // left the 30m clock armed (only deliverable-tagged messages cleared it).
    h.state.nowMs += 5 * 60_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-comp-done-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot',
      content: '[WORKING→完成] 准备工作全部落地，回报：worktree .worktrees/x @ branch y，测试 ok。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`) ?? null,
      null,
      'the completion report retired the armed clock',
    );
    assert.ok(
      logs.some((line) => line.includes('declared a phase transition') && line.includes('clock retired')),
      'the retirement is on the record',
    );

    // Jump past the original dueAt: no missed-deadline note fires.
    h.state.nowMs += 30 * 60_000;
    await h.loop.runTick();
    const notes = h.groupTaskStore.listPendingHostNotes(task.id).filter((note) => note.kind === 'deadline');
    assert.equal(notes.length, 0, 'no false missed-deadline after the completion report');
  } finally {
    h.cleanup();
  }
});

test('GT#87: a fresh chair assignment supersedes the previous phase\'s armed clock', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'gt87-phase1-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 第一阶段：准备工作 [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-phase1-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：第一阶段，预计 25 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(h.store.get(`group_task_expected_delivery:${task.id}:2`), 'phase-1 clock armed');

    // Round 2: a fresh assignment for the next phase lands BEFORE the old
    // clock's dueAt. Pre-fix the armed 30m survived into the new phase.
    h.state.nowMs += 5 * 60_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-phase2-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 第二阶段：实现重放索引器 [DEADLINE: 140m]。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(
      h.store.get(`group_task_expected_delivery:${task.id}:2`) ?? null,
      null,
      'the fresh assignment superseded the previous phase\'s armed clock (no ACK yet → nothing armed)',
    );

    // ACKing the new assignment arms the NEW clock from the NEW clause.
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-phase2-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：第二阶段，预计 120 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:2`);
    assert.ok(armed, 'the new phase ACK arms the new clock');
    assert.equal(JSON.parse(armed).dueAt - JSON.parse(armed).ackedAt, 140 * 60_000);
  } finally {
    h.cleanup();
  }
});

test('GT#87: a missed-deadline note carries the clock\'s arming source for chair reconciliation', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'gt87-src-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Coder Bot 冒烟验证 [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    const assignmentId = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', ['gt87-src-assign-i0'])[0].values[0][0];
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-src-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 已接单：冒烟验证，预计 25 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:2`);
    assert.ok(armed, 'clock armed');
    assert.equal(JSON.parse(armed).assignmentMessageId, assignmentId, 'the KV records the arming source message');
    assert.equal(JSON.parse(armed).chairStatedMinutes, 30, 'the KV records the chair-stated minutes');

    // Let the clock ring with the member inert (no session activity).
    h.state.nowMs += 40 * 60_000;
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    await h.loop.runTick();
    const notes = h.groupTaskStore.listPendingHostNotes(task.id).filter((note) => note.kind === 'deadline');
    assert.equal(notes.length, 1, 'the missed-deadline note fired');
    assert.match(notes[0].body, new RegExp(`clock armed from message #${assignmentId} \\(chair-stated 30m\\)`));
  } finally {
    h.cleanup();
  }
});

test('GT#87: a member greeted at the top and dispatched later still gets their clock armed (e2e)', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2, 3]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    // The #5832 shape verbatim structure: greeting @mention at the top,
    // numbered dispatch paragraph with the deadline further down.
    insertGroupMessage(h.db, {
      pinId: 'gt87-greet-dispatch-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '@Designer Bot 欢迎入列！你坐本卡的验收席——独立验收人。全场请先读需求稿。\\n\\n'
        + '分工与顺序如下：\\n\\n'
        + '① 架构席 @Coder Bot：冻结稿 [DEADLINE: 60m]。\\n\\n'
        + '④ 验收席 @Designer Bot：验收清单草稿上链交付 [DEADLINE: 45m]。保持独立。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-greet-dispatch-ack-i0', senderMetaId: 'metaid-3', senderGlobalMetaId: 'gmid-w3',
      senderName: 'Designer Bot', content: '[WORKING] 已接单（验收席）：正在读需求稿，预计 40 分钟。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const armed = h.store.get(`group_task_expected_delivery:${task.id}:3`);
    assert.ok(armed, 'the greeting-first member still arms a clock from the later dispatch clause');
    assert.equal(JSON.parse(armed).dueAt - JSON.parse(armed).ackedAt, 45 * 60_000, 'the ④ paragraph 45m is the clock');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (quota stall): fleet-wide token-plan exhaustion ("429 ... quota has
// been exceeded") parked the whole task — every member turn failed, each
// attempt burned ~10min of provider retry ladders, and MSG_RETRY_MAX_FAILURES
// was on track to DROP the three closing-gate triggers. Quota failures now
// requeue UNCHARGED, arm a per-task stall (the drain holds entries, one probe
// per interval), notify the owner once per episode, and lift automatically on
// the first successful turn.
// ---------------------------------------------------------------------------

test('GT#87: quota exhaustion stalls the task without burning the retry budget', async () => {
  const logs = [];
  const milestones = [];
  const skillTurnAttempts = [];
  let quotaDead = true;
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: (input) => (input.metabotId === 2
      ? { prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }
      : { prompt: null, activeSkillIds: [] }),
    deps: {
      sendMilestoneToSourceSession: (input) => { milestones.push(input); },
      runSkillTurn: async (params) => {
        skillTurnAttempts.push(params);
        if (quotaDead) {
          throw new Error('DSH turn failed: 429: {"message":"Token Plan quota has been exceeded (request_id: req-1)"}');
        }
        return { replyText: '[WORKING] 已接单', assistantMessageId: null };
      },
    },
  });
  try {
    const task = h.createTask([2]);
    h.db.run('UPDATE group_tasks SET source_session_id = ? WHERE id = ?', ['origin-session-1', task.id]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'gt87-quota-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot 冒烟验证 [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'the turn ran once and failed on quota');
    let queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'trigger requeued');
    assert.equal(queued[0].failures ?? 0, 0, 'requeued UNCHARGED — quota exhaustion is environmental');
    assert.ok(h.store.get(`group_task_quota_stall:${task.id}`), 'the task is quota-stalled');
    const quotaNotices = milestones.filter((m) => m.kind === 'anomaly' && m.message.includes('Token-plan quota exhausted'));
    assert.equal(quotaNotices.length, 1, 'the owner heard about the stall exactly once');

    // Immediate next tick: the stall holds — no new dispatch.
    h.state.nowMs += 5_000;
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 1, 'stalled: no dispatch before the probe interval');

    // After the probe interval: exactly one probe dispatch.
    h.state.nowMs += 16 * 60_000;
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 2, 'one probe per interval while stalled');
    queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued[0].failures ?? 0, 0, 'the probe failure stayed uncharged');
    assert.equal(
      milestones.filter((m) => m.kind === 'anomaly' && m.message.includes('Token-plan quota exhausted')).length,
      1,
      'still one owner notice per episode (probe failure does not re-notify)',
    );

    // Quota returns: the next probe succeeds and lifts the stall.
    quotaDead = false;
    h.state.nowMs += 16 * 60_000;
    await h.loop.runTick();
    assert.equal(skillTurnAttempts.length, 3, 'the probe re-ran');
    assert.ok(h.sends.some((s) => s.content === '[WORKING] 已接单'), 'the probe delivered the reply');
    assert.equal(h.store.get(`group_task_quota_stall:${task.id}`) ?? null, null, 'the stall lifted on first success');
    assert.ok(logs.some((line) => line.includes('quota stall lifted')), 'the lift is logged');
    assert.equal(JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]').length, 0, 'queue drained');
  } finally {
    h.cleanup();
  }
});

test('GT#87: a non-quota failure still burns the ordinary retry ladder', async () => {
  const h = await createHarness({
    deps: {
      runSkillTurn: async () => { throw new Error('DSH turn failed: 500: internal'); },
    },
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'gt87-nonquota-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot check [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1);
    assert.equal(queued[0].failures, 1, 'a plain 500 failure charges the retry counter');
    assert.equal(h.store.get(`group_task_quota_stall:${task.id}`) ?? null, null, 'no stall for non-quota failures');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P2-5): quoted code is citation, not dispatch. The chair's 18:29
// rebuttal restated another worker's deadline inside backticks while naming
// 阿码 in the third person — the raw-content [DEADLINE] test read the quoted
// citation as an assignment marker and armed a phantom ACK watch that
// misfired a no-ACK note 31 minutes later.
// ---------------------------------------------------------------------------

test('GT#87: a backtick-quoted [DEADLINE] restatement never wakes or arms a phantom assignment', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2, 3]);
    h.state.nowMs = Date.now();
    insertGroupMessage(h.db, {
      pinId: 'gt87-quoted-deadline-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: '主持人核对：Coder Bot 提出的截止日期提醒与其估算值对不上。但这不是我的安排时间：'
        + '我分配给他的实际任务是 `[DEADLINE: 140m]`，从派发起算。目前没有任何超时事项，保持静默。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.chatCalls.length, 0, 'a quoted tag never wakes the bare-named worker');
    assert.ok(
      !logs.some((line) => line.includes('assignment to Coder Bot (message #')),
      'no phantom ACK watch armed from the quoted restatement',
    );
    assert.ok(
      !logs.some((line) => line.includes('assignment to Designer Bot (message #')),
      'no phantom watch for any other bare-named member either',
    );

    // Control: the same message with the tag UNQUOTED keeps the GT#72
    // bare-name dispatch semantics intact.
    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'gt87-unquoted-deadline-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot',
      content: 'Coder Bot，第二棒正式开工 [DEADLINE: 60m]：字段级协议规范，即刻交付。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.ok(
      logs.some((line) => line.includes('assignment to Coder Bot (message #') && line.includes('waiting for [WORKING] ACK')),
      'an unquoted tag on a bare-name dispatch still arms the watch (GT#72 semantics intact)',
    );
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P2-7): prompt-facing absolute times must render in the host's LOCAL
// zone with an explicit offset, matching the per-turn "Current time:" line.
// GT#87's chair mis-subtracted a UTC stamp against the local clock ("stuck in
// planning ~8 hours", actual 7 minutes) and published the false statement to
// the on-chain record; its deadline-reconciliation turn then failed to match
// a UTC-rendered bell against locally-stated deadlines.
// ---------------------------------------------------------------------------

test('GT#87: the missed-deadline note renders the due time in the local zone with an offset', async () => {
  const h = await createHarness();
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    h.groupTaskStore.setMemberStatus(task.id, 2, 'working', 'gmid-w2');
    h.store.set(`group_task_expected_delivery:${task.id}:2`, JSON.stringify({ dueAt: startMs - 5 * 60_000 }));
    const { ensureGroupTaskSession } = require('../dist-electron/main/services/groupTaskSession.js');
    const { session } = ensureGroupTaskSession(h.coworkStore, task, 2, 'Coder Bot');
    h.db.run('UPDATE cowork_sessions SET updated_at = ? WHERE id = ?', [startMs - 60 * 60_000, session.id]);
    await h.loop.runTick();
    const notes = h.groupTaskStore.listPendingHostNotes(task.id).filter((note) => note.kind === 'deadline');
    assert.equal(notes.length, 1, 'the note fired');
    const timeMatch = /(\d{4}-\d{2}-\d{2} \d{2}:\d{2}) \(UTC([+-]\d{2})\)/.exec(notes[0].body);
    assert.ok(timeMatch, `the due time carries a local stamp with an explicit offset: ${notes[0].body}`);
    assert.ok(!/T\d{2}:\d{2}:\d{2}(\.\d+)?Z/.test(notes[0].body), 'no bare ISO/UTC rendering remains');
    // The rendered clock equals the due time converted into the host zone.
    const dueLocal = new Date(startMs - 5 * 60_000);
    const pad = (v) => String(v).padStart(2, '0');
    const expected = `${dueLocal.getFullYear()}-${pad(dueLocal.getMonth() + 1)}-${pad(dueLocal.getDate())} ${pad(dueLocal.getHours())}:${pad(dueLocal.getMinutes())}`;
    assert.equal(timeMatch[1], expected, 'the clock is local, not UTC-shifted');
    const offsetMinutes = -dueLocal.getTimezoneOffset();
    const expectedOffset = `${offsetMinutes >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, '0')}`;
    assert.equal(timeMatch[2], expectedOffset, 'the offset matches the host zone');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#87 (P3): the chair's deferred backlog coalesces to the newest non-owner
// trigger. GT#87's convergence tail drained 31-77min-old chair triggers one
// 5-10min turn each, mostly answered [NO_REPLY] — a chair turn reads the full
// group-log window and the Task #51 safety net settles every pending trigger
// up to its message, so the serial replay bought nothing but tail latency.
// Owner messages keep their own dispatch (they always reach the chair).
// ---------------------------------------------------------------------------

test('GT#87: stale chair triggers coalesce into the newest; owner messages keep their own dispatch', async () => {
  const logs = [];
  const h = await createHarness({ emitLog: (message) => logs.push(message) });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'gt87-chair-stale-1-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '@Twin Bot 第一轮对齐说明（旧）', chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'gt87-chair-stale-2-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '@Twin Bot 第二轮对齐说明（较新）', chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'gt87-chair-stale-3-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '@Twin Bot 第三轮对齐说明（最新）', chainTimestamp: Math.floor(startMs / 1000),
    });
    insertGroupMessage(h.db, {
      pinId: 'gt87-chair-owner-i0', senderMetaId: 'metaid-boss', senderGlobalMetaId: BOSS_GMID,
      senderName: 'Owner', content: 'owner has a question for the chair', chainTimestamp: Math.floor(startMs / 1000),
    });
    const ids = {};
    for (const pin of ['gt87-chair-stale-1-i0', 'gt87-chair-stale-2-i0', 'gt87-chair-stale-3-i0', 'gt87-chair-owner-i0']) {
      ids[pin] = h.db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', [pin])[0].values[0][0];
    }
    // Advance the cursor past all four and seed the chair's deferred backlog
    // directly (the stale-trigger replay state GT#87 ended its ticks in).
    h.groupTaskStore.getStore?.();
    h.db.run('UPDATE group_tasks SET last_processed_msg_id = ? WHERE id = ?', [ids['gt87-chair-owner-i0'], task.id]);
    h.store.set(`group_task_deferred:${task.id}`, JSON.stringify([
      { taskId: task.id, metabotId: 1, messageId: ids['gt87-chair-stale-1-i0'], reason: 'chair_mentioned', verificationNotes: [], failures: 1 },
      { taskId: task.id, metabotId: 1, messageId: ids['gt87-chair-stale-2-i0'], reason: 'chair_mentioned', verificationNotes: [], failures: 1 },
      { taskId: task.id, metabotId: 1, messageId: ids['gt87-chair-stale-3-i0'], reason: 'chair_mentioned', verificationNotes: [], failures: 1 },
      { taskId: task.id, metabotId: 1, messageId: ids['gt87-chair-owner-i0'], reason: 'chair_owner_message', verificationNotes: [], failures: 1 },
    ]));
    await h.loop.runTick();
    assert.ok(
      logs.some((line) =>
        line.includes("coalesced bot 1's queued backlog into") &&
        line.includes(`#${ids['gt87-chair-stale-3-i0']} (newest chair trigger`) &&
        line.includes(`superseded: #${ids['gt87-chair-stale-1-i0']}, #${ids['gt87-chair-stale-2-i0']}`)),
      'the three stale chair triggers coalesced into the newest',
    );
    // The owner entry dispatched first (never coalesced); the two stale
    // triggers were superseded (no dispatch for #1/#2); the coalesced newest
    // trigger re-queued behind the in-flight guard and runs next tick.
    assert.ok(
      logs.some((line) => line.includes(`dispatched async chair turn for bot 1 (message #${ids['gt87-chair-owner-i0']}, reason chair_owner_message`)),
      'the owner message keeps its own dispatch',
    );
    for (const stale of ['gt87-chair-stale-1-i0', 'gt87-chair-stale-2-i0']) {
      assert.ok(
        !logs.some((line) => line.includes(`message #${ids[stale]}`) && line.includes('dispatched async chair turn')),
        `superseded stale trigger #${ids[stale]} never dispatched`,
      );
    }
    assert.equal(h.chatCalls.length, 1, 'exactly one chair turn ran this tick');
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'only the coalesced newest trigger remains queued');
    assert.equal(queued[0].messageId, ids['gt87-chair-stale-3-i0'], 'it is the newest chair trigger');
    // Next tick: the coalesced newest trigger gets its turn and the queue drains.
    h.state.nowMs += 60_000;
    await h.loop.runTick();
    assert.ok(
      logs.some((line) => line.includes(`dispatched async chair turn for bot 1 (message #${ids['gt87-chair-stale-3-i0']}, reason chair_mentioned`)),
      'the coalesced newest trigger ran',
    );
    assert.equal(JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]').length, 0, 'queue drained');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#90 (P1-1): a turn that produced NOTHING group-visible (empty reply, no
// mid-turn sends, no [NO_REPLY]) must NOT settle as answered. GT#90's plan-B
// pre-check turn stalled on its first tool call; the empty branch returned,
// the cursor advanced, and the assignment evaporated (rescued only by the
// supervisor's own initiative 30 minutes later). The empty handoff now enters
// the ordinary bounded retry ladder: requeue charged, drop + anomaly on
// exhaustion. Deliberate silence ([NO_REPLY]) and delivered turns
// (mid-turn sends) keep their existing settle paths.
// ---------------------------------------------------------------------------

test('GT#90: an empty-handoff turn requeues instead of evaporating the trigger', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
    skillReply: '',
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'gt90-empty-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot plan-B precheck: headless render + route rewrite',
    });
    await h.loop.runTick();
    const queued = JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]');
    assert.equal(queued.length, 1, 'the empty-handoff trigger was requeued, not settled');
    assert.equal(queued[0].failures, 1, 'the requeue is charged like an ordinary failure');
    assert.ok(
      logs.some((line) => line.includes('failed (attempt 1/5); requeued')),
      'the failure is on the record',
    );

    // The requeue re-drives on a later tick and, once the model recovers, the
    // same trigger delivers.
    h.deps.runSkillTurn = async () => ({ replyText: '[WORKING] 已接单：plan-B 预检开工', assistantMessageId: null });
    h.state.nowMs += 60_000;
    await h.loop.runTick();
    assert.ok(
      h.sends.some((send) => send.content === '[WORKING] 已接单：plan-B 预检开工'),
      'the re-driven trigger delivered once the turn produced output',
    );
    assert.equal(JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]').length, 0, 'queue drained');
  } finally {
    h.cleanup();
  }
});

test('GT#90: deliberate [NO_REPLY] and mid-turn-delivered turns never requeue', async () => {
  const h = await createHarness({
    coderChatSkills: ['web-search'],
    routing: () => ({ prompt: '<available_skills>web-search</available_skills>', activeSkillIds: ['web-search'] }),
  });
  try {
    const task = h.createTask([2]);
    insertGroupMessage(h.db, {
      pinId: 'gt90-noreply-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot FYI only',
    });
    h.deps.runSkillTurn = async () => ({ replyText: '[NO_REPLY]', assistantMessageId: null });
    await h.loop.runTick();
    assert.equal(JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]').length, 0, '[NO_REPLY] settles silently — no retry');

    h.state.nowMs += 60_000;
    insertGroupMessage(h.db, {
      pinId: 'gt90-midturn-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot second check',
    });
    h.deps.runSkillTurn = async (params) => {
      // Record the send as the real runner would (the daemon counts session
      // group_chat tool_use rows, not dep calls).
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_use', content: 'Using tool: group_chat',
        metadata: { toolName: 'group_chat', toolInput: { action: 'send_group_message' }, toolUseId: 'tu-gc-1' },
      });
      h.deps.postGroupTaskMessage(task.id, 2, 'mid-turn delivery', {});
      h.coworkStore.addMessage(params.sessionId, {
        type: 'tool_result', content: '- pinId: mid-turn-pin', metadata: { toolUseId: 'tu-gc-1', toolResult: '- pinId: mid-turn-pin' },
      });
      return { replyText: '', assistantMessageId: null };
    };
    await h.loop.runTick();
    assert.ok(h.sends.some((send) => send.content === 'mid-turn delivery'), 'mid-turn send delivered');
    assert.equal(JSON.parse(h.store.get(`group_task_deferred:${task.id}`) ?? '[]').length, 0, 'ONE VOICE closer settles as delivered — no retry');
  } finally {
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// GT#90 (P1-2): an armed-wait worker must use [STANDBY], and the host must
// honor it. GT#90's buzz seat declared [WORKING] + a prose trigger condition
// and went quiet for 45 min while correctly waiting on the chair's final
// gate — the liveness monitors escalated false unreachable + stale-[WORKING]
// stuck alerts twice, briefed the OWNER (L3), and burned a re-drive turn that
// answered [NO_REPLY]. A standby-status member is exempt from both monitors;
// a stale [WORKING] without standby still escalates (control case).
// ---------------------------------------------------------------------------

test('GT#90: a standby member in armed wait never draws unreachable/stuck alarms', async () => {
  const logs = [];
  const h = await createHarness({
    emitLog: (message) => logs.push(message),
    deps: { memberTimeoutAfterMinutes: 20, memberUnreachableAfterMinutes: 30 },
  });
  try {
    const task = h.createTask([2]);
    const startMs = Date.now();
    h.state.nowMs = startMs;
    insertGroupMessage(h.db, {
      pinId: 'gt90-armed-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
      senderName: 'Twin Bot', content: '@Coder Bot buzz 等我终门令再发 [DEADLINE: 30m]。',
      chainTimestamp: Math.floor(startMs / 1000),
    });
    await h.loop.runTick();
    h.state.nowMs += 30_000;
    insertGroupMessage(h.db, {
      pinId: 'gt90-armed-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[WORKING] 收到：buzz 准备开工。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    // Prep done → declare the armed wait with [STANDBY], then go quiet.
    h.state.nowMs += 5 * 60_000;
    insertGroupMessage(h.db, {
      pinId: 'gt90-armed-standby-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
      senderName: 'Coder Bot', content: '[STANDBY] armed: buzz 等 chair 终门令触发，二缺一不发。',
      chainTimestamp: Math.floor(h.state.nowMs / 1000),
    });
    await h.loop.runTick();
    assert.equal(h.db.exec(
      "SELECT status FROM group_task_members WHERE task_id = ? AND metabot_id = 2", [task.id],
    )[0].values[0][0], 'standby', 'the [STANDBY] marker parked the member');

    // 60 quiet minutes: both liveness monitors would fire on a stale [WORKING].
    h.state.nowMs += 60 * 60_000;
    await h.loop.runTick();
    const statusNow = h.db.exec(
      "SELECT status FROM group_task_members WHERE task_id = ? AND metabot_id = 2", [task.id],
    )[0].values[0][0];
    assert.equal(statusNow, 'standby', 'a standby member is never marked unreachable');
    assert.ok(
      !logs.some((line) => line.includes('Coder Bot') && line.includes('marked unreachable')),
      'no unreachable stamp',
    );
    assert.ok(
      !logs.some((line) => line.includes("Coder Bot [WORKING] signal stale")),
      'no stale-working stuck alert',
    );
    assert.equal(h.chatCalls.length, 1, 'no wasted re-drive turn (only the original assignment turn ran)');

    // Control: the SAME silence with a stale [WORKING] (no standby) escalates.
    const h2 = await createHarness({
      emitLog: (message) => logs.push(message),
      deps: { memberTimeoutAfterMinutes: 20, memberUnreachableAfterMinutes: 30 },
    });
    try {
      const task2 = h2.createTask([2]);
      const start2 = Date.now();
      h2.state.nowMs = start2;
      insertGroupMessage(h2.db, {
        pinId: 'gt90-stale-assign-i0', senderMetaId: 'metaid-1', senderGlobalMetaId: 'gmid-twin',
        senderName: 'Twin Bot', content: '@Coder Bot buzz 等我终门令再发 [DEADLINE: 30m]。',
        chainTimestamp: Math.floor(start2 / 1000),
      });
      await h2.loop.runTick();
      h2.state.nowMs += 30_000;
      insertGroupMessage(h2.db, {
        pinId: 'gt90-stale-ack-i0', senderMetaId: 'metaid-2', senderGlobalMetaId: 'gmid-w2',
        senderName: 'Coder Bot', content: '[WORKING] 收到：buzz 准备开工，等触发。',
        chainTimestamp: Math.floor(h2.state.nowMs / 1000),
      });
      await h2.loop.runTick();
      h2.state.nowMs += 60 * 60_000;
      await h2.loop.runTick();
      assert.ok(
        logs.some((line) => line.includes('Coder Bot') && line.includes('marked unreachable')),
        'control: the stale-[WORKING] path still escalates without standby',
      );
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});
