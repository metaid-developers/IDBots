import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { GroupTaskStore } = require('../dist-electron/main/groupTaskStore.js');
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const {
  buildOpenTeamInviteMessage,
  parseOpenTeamEnvelope,
} = require('../dist-electron/main/services/openTeamProtocols.js');
const {
  decideOpenTeamGuestResponse,
  isOpenTeamProtocolOnlyContent,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');
const { buildOpenTeamGuestPrompt } = require('../dist-electron/main/services/openTeamGuestPrompt.js');

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-group-task-mode-'));

const openStores = async (tempDir) => {
  const store = await SqliteStore.create(tempDir);
  const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(
    store.getDatabase(),
    store.getSaveFunction(),
  );
  return { store, groupTaskStore, membershipStore, db: store.getDatabase() };
};

const baseTaskInput = (overrides = {}) => ({
  groupId: `group-${Math.random().toString(16).slice(2)}`,
  title: 'Mode test task',
  goal: 'verify the mode column',
  chairMetabotId: 1,
  createdBy: 'user',
  ...overrides,
});

// ---------------------------------------------------------------------------
// R1: group_tasks.mode — storage, defaults, chat-born-executing
// ---------------------------------------------------------------------------

test('group_tasks.mode column exists and defaults to task', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput());
    assert.equal(task.mode, 'task', 'absent mode normalizes to task');
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'task');
  } finally {
    store.close();
  }
});

test('chat-mode tasks persist mode=chat and are born executing', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput({ mode: 'chat' }));
    assert.equal(task.mode, 'chat');
    assert.equal(task.status, 'executing', 'a conversation has no planning phase');
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'chat');
    assert.equal(reread.status, 'executing');
  } finally {
    store.close();
  }
});

test('task-mode tasks keep the planning birth status (regression)', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput({ mode: 'task' }));
    assert.equal(task.status, 'planning');
    assert.equal(task.mode, 'task');
  } finally {
    store.close();
  }
});

test('unknown mode values are rejected by the column CHECK and normalize to task', async () => {
  const tempDir = makeTempDir();
  const { store, groupTaskStore, db } = await openStores(tempDir);
  try {
    const task = groupTaskStore.createTask(baseTaskInput());
    // The column CHECK is the durable guard: garbage cannot land at all.
    assert.throws(
      () => db.run('UPDATE group_tasks SET mode = ? WHERE id = ?', ['bogus', task.id]),
      /constraint/i,
    );
    const reread = groupTaskStore.getTaskById(task.id);
    assert.equal(reread.mode, 'task');
    // The pure normalizer covers wire/legacy inputs (envelope fields, JS calls).
    const { normalizeGroupTaskMode } = require('../dist-electron/main/libs/groupTaskMode.js');
    assert.equal(normalizeGroupTaskMode('chat'), 'chat');
    assert.equal(normalizeGroupTaskMode('task'), 'task');
    assert.equal(normalizeGroupTaskMode('bogus'), 'task');
    assert.equal(normalizeGroupTaskMode(undefined), 'task');
    assert.equal(normalizeGroupTaskMode(null), 'task');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// R1: invite envelope carries the mode; absent field reads as task
// ---------------------------------------------------------------------------

const INVITE_BASE = {
  v: 1,
  inviteId: 'a'.repeat(64) + 'i0',
  groupId: 'b'.repeat(64) + 'i0',
  taskTitle: 'chat scene',
  goalSummary: 'free talk',
  requiredSkills: [],
  inviterGlobalMetaId: 'idqinviter',
  inviterName: 'Inviter',
  chairGlobalMetaId: 'idqinviter',
  targetGlobalMetaId: 'idqtarget',
  expiresAt: 4_102_444_800,
};

test('invite envelope round-trips mode=chat', () => {
  const envelope = parseOpenTeamEnvelope(buildOpenTeamInviteMessage({ ...INVITE_BASE, mode: 'chat' }));
  assert.equal(envelope?.kind, 'invite');
  assert.equal(envelope.invite.mode, 'chat');
});

test('invite envelope without mode omits the field (backward compatible)', () => {
  const legacy = parseOpenTeamEnvelope(buildOpenTeamInviteMessage({ ...INVITE_BASE }));
  assert.equal(legacy?.kind, 'invite');
  // The field is only carried when stated — a parsed legacy envelope stays
  // byte-identical to pre-mode parsers; consumers normalize undefined -> task.
  assert.equal(legacy.invite.mode, undefined);
  // Hand-written v1 envelope from an older inviter host (field entirely absent).
  const raw = parseOpenTeamEnvelope(
    `[OPENTEAM_INVITE] ${JSON.stringify({ ...INVITE_BASE, mode: undefined })}`,
  );
  assert.equal(raw?.kind, 'invite');
  assert.equal(raw.invite.mode, undefined);
});

test('invite envelope with a garbage mode omits the field', () => {
  const garbage = parseOpenTeamEnvelope(`[OPENTEAM_INVITE] ${JSON.stringify({ ...INVITE_BASE, mode: 'party' })}`);
  assert.equal(garbage?.kind, 'invite');
  assert.equal(garbage.invite.mode, undefined);
});

// ---------------------------------------------------------------------------
// R1: openteam_memberships.group_mode — persisted on accept, refreshed on revival
// ---------------------------------------------------------------------------

test('membership upsert persists groupMode and revivals keep it', async () => {
  const tempDir = makeTempDir();
  const { store, membershipStore } = await openStores(tempDir);
  try {
    const membership = membershipStore.upsertActiveMembership({
      groupId: 'g'.repeat(64) + 'i0',
      metabotId: 7,
      globalmetaid: 'idqguest',
      inviterGlobalmetaid: 'idqinviter',
      taskTitle: 'chat scene',
      groupMode: 'chat',
    });
    assert.equal(membership.groupMode, 'chat');

    // Left + re-invite (revival): an upsert without an explicit mode keeps the
    // stored chat mode (COALESCE), matching the task-title semantics.
    membershipStore.markLeft('g'.repeat(64) + 'i0', 7, { cause: 'kick' });
    const revived = membershipStore.upsertActiveMembership({
      groupId: 'g'.repeat(64) + 'i0',
      metabotId: 7,
    });
    assert.equal(revived.groupMode, 'chat');
    assert.equal(revived.status, 'active');
  } finally {
    store.close();
  }
});

test('membership without groupMode reads as task (legacy rows)', async () => {
  const tempDir = makeTempDir();
  const { store, membershipStore } = await openStores(tempDir);
  try {
    const membership = membershipStore.upsertActiveMembership({
      groupId: 'h'.repeat(64) + 'i0',
      metabotId: 8,
    });
    assert.equal(membership.groupMode, 'task');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// R2: chat-mode guest gating (decideOpenTeamGuestResponse)
// ---------------------------------------------------------------------------

const GUEST_GMID = 'idqguest';
const CHAIR_GMID = 'idqchair';
const OTHER_GMID = 'idqother';
const gateBot = () => ({ name: 'Guest Bot', globalmetaid: GUEST_GMID, metaid: 'metaid-guest' });
const gateMessage = (overrides = {}) => ({
  id: 1,
  pinId: null,
  senderMetaId: 'metaid-x',
  senderGlobalMetaId: CHAIR_GMID,
  senderName: 'Chair',
  content: 'hello there',
  mention: null,
  ...overrides,
});
const gateInput = (overrides = {}) => ({
  lastReplyAt: 0,
  now: 100_000,
  cooldownMs: 20_000,
  ...overrides,
});

test('task mode keeps the strict mention gate (regression)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'task',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'welcome to the group, make yourself at home', senderGlobalMetaId: CHAIR_GMID }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'not_mentioned');
});

test('chat mode answers a no-@ conversational message from the chair (P1 incident replay)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'welcome to the group, make yourself at home' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'chat_direct');
});

test('chat mode still answers @mentions with reason=mentioned', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'hey @Guest Bot, what do you think?' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'mentioned');
});

test('chat mode: non-@ messages from other members stay gated (storm insurance)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'anyone want coffee?', senderGlobalMetaId: OTHER_GMID, senderName: 'Other' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'not_mentioned');
});

test('chat mode: protocol-only lines never wake the guest, even with an @', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: '[STATUS:DONE]\n[DELIVERABLE] note: pin://' + 'a'.repeat(64) + 'i0' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'protocol_line');
});

test('chat mode: mixed prose + status tag from the chair stays conversational', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    ...gateInput(),
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'Great talking with you all — closing the room now.\n[STATUS:DONE]' }),
    bot,
  });
  assert.equal(decision.respond, true);
  assert.equal(decision.reason, 'chat_direct');
});

test('self messages and empty content stay filtered in chat mode', () => {
  const bot = gateBot();
  assert.equal(
    decideOpenTeamGuestResponse({
      ...gateInput(),
      mode: 'chat',
      inviterGlobalMetaId: CHAIR_GMID,
      message: gateMessage({ content: 'my own echo', senderGlobalMetaId: GUEST_GMID }),
      bot,
    }).reason,
    'self_message',
  );
  assert.equal(
    decideOpenTeamGuestResponse({
      ...gateInput(),
      mode: 'chat',
      inviterGlobalMetaId: CHAIR_GMID,
      message: gateMessage({ content: '   ' }),
      bot,
    }).reason,
    'empty_content',
  );
});

test('chat mode cooldown still gates direct messages (loop insurance)', () => {
  const bot = gateBot();
  const decision = decideOpenTeamGuestResponse({
    lastReplyAt: 90_000,
    now: 100_000,
    cooldownMs: 20_000,
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'still there?' }),
    bot,
  });
  assert.equal(decision.respond, false);
  assert.equal(decision.reason, 'cooldown');
});

test('isOpenTeamProtocolOnlyContent: tag-structural only', () => {
  assert.equal(isOpenTeamProtocolOnlyContent('[STATUS:EXECUTING]'), true);
  assert.equal(isOpenTeamProtocolOnlyContent('[STATUS:DONE]\n[NO_REPLY]'), true);
  // A line LED BY a protocol tag is protocol traffic even with a prose tail —
  // host notices are never conversational, whatever rides after the tag.
  assert.equal(isOpenTeamProtocolOnlyContent('[GROUP_TASK_NOTICE:welcome] hi'), true, 'notice-led line');
  assert.equal(isOpenTeamProtocolOnlyContent('Great chat — closing.\n[STATUS:DONE]'), false, 'mixed prose');
  assert.equal(isOpenTeamProtocolOnlyContent(''), false);
  assert.equal(isOpenTeamProtocolOnlyContent('[OPENTEAM_KICK] {"v":1}'), true);
});

// ---------------------------------------------------------------------------
// R3: chat-mode guest prompt (task playbook byte-identical regression)
// ---------------------------------------------------------------------------

const promptMetabot = { name: 'Guest Bot', role: 'pal', soul: 'curious', goal: '', bio: '' };
const promptMembershipBase = {
  groupId: 'c'.repeat(64) + 'i0',
  taskTitle: 'zero-preset collision',
  inviterGlobalmetaid: CHAIR_GMID,
};

test('task-mode guest prompt is byte-identical to the legacy prompt', () => {
  const legacy = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase },
  });
  const taskMode = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'task' },
  });
  assert.equal(taskMode, legacy);
});

test('chat-mode guest prompt drops the task-discipline lines', () => {
  const chat = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'chat' },
  });
  assert.ok(!chat.includes('Respond ONLY when @-mentioned'), 'no silence gate line');
  assert.ok(!chat.includes('no small talk'), 'no small-talk ban');
  assert.ok(!chat.includes('#13 handshake'), 'no mandatory handshake');
  assert.ok(!chat.includes('[DELIVERABLE]'), 'no deliverable discipline');
  assert.ok(!chat.includes('stay on the task goal'), 'no task-goal tether');
  // Mode-neutral etiquette survives.
  assert.ok(chat.includes('NEVER disclose'), 'privacy rule kept');
  assert.ok(chat.includes('NEVER fabricate'), 'honesty rule kept');
  assert.ok(chat.includes('ONE VOICE PER TURN'), 'one-voice rule present');
  assert.ok(chat.includes('group CHAT'), 'chat framing present');
});

test('chat-mode prompt keeps the persona block intact', () => {
  const chat = buildOpenTeamGuestPrompt({
    metabot: promptMetabot,
    membership: { ...promptMembershipBase, groupMode: 'chat' },
  });
  // The persona block is the shared metabot_identity rendering (audit P1:
  // the hand-rolled "You are <name>" guest line with (empty) fields is gone).
  assert.ok(chat.includes('<metabot_identity>'), 'shared persona block present');
  assert.ok(chat.includes('<name>Guest Bot</name>'), 'persona name carried');
  assert.ok(!chat.includes('(empty)'), 'empty persona fields are skipped, not rendered as (empty)');
});


// ---------------------------------------------------------------------------
// R5: chat-mode reply cadence (cooldown tier)
// ---------------------------------------------------------------------------

test('R5: chat gating uses the shorter chat cooldown, task gating keeps 20s-class cooldown', () => {
  const bot = gateBot();
  // lastReply 10s ago: inside the task cooldown (20s) but outside chat (8s).
  const decisionChat = decideOpenTeamGuestResponse({
    lastReplyAt: 90_000,
    now: 100_000,
    cooldownMs: 8_000,
    mode: 'chat',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: 'still there?' }),
    bot,
  });
  assert.equal(decisionChat.respond, true, 'chat cadence allows a 10s-old last reply');
  const decisionTask = decideOpenTeamGuestResponse({
    lastReplyAt: 90_000,
    now: 100_000,
    cooldownMs: 20_000,
    mode: 'task',
    inviterGlobalMetaId: CHAIR_GMID,
    message: gateMessage({ content: '@Guest Bot still there?' }),
    bot,
  });
  assert.equal(decisionTask.respond, false);
  assert.equal(decisionTask.reason, 'cooldown');
});

// ---------------------------------------------------------------------------
// R4: single-send guarantee — outgoing group-send ledger + daemon suppression
// ---------------------------------------------------------------------------

const {
  createOpenTeamGuestDaemonLoop,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');
const {
  recordOutgoingGroupSend,
  hasOutgoingGroupSendSince,
  resetOutgoingGroupSendLedger,
} = require('../dist-electron/main/services/groupSendLedger.js');
const { MetabotStore } = require('../dist-electron/main/metabotStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');

const R4_GROUP = 'd'.repeat(64) + 'i0';

const insertWalletR4 = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at)
     VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id],
  );
};

const insertMetabotR4 = (db, { id, walletId, name, globalmetaid }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, 'worker', '0000', `${name} role`, `${name} soul`,
      null, null, JSON.stringify(['skill-doc']), null, null, 1700000000000 + id, 1700000000000 + id,
    ],
  );
};

const insertGroupMessageR4 = (db, { pinId, groupId = R4_GROUP, senderMetaId, senderGlobalMetaId, senderName, content }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', '[]', NULL, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content],
  );
};

test('outgoing group-send ledger: record + hasSince semantics', () => {
  resetOutgoingGroupSendLedger();
  recordOutgoingGroupSend({ metabotId: 7, groupId: R4_GROUP, pinId: 'pini0', at: 1_000 });
  recordOutgoingGroupSend({ metabotId: 8, groupId: R4_GROUP, pinId: 'pinj0', at: 1_500 });
  assert.equal(hasOutgoingGroupSendSince(7, R4_GROUP, 999), true, 'send after the anchor counts');
  assert.equal(hasOutgoingGroupSendSince(7, R4_GROUP, 1_000), false, 'anchor itself is exclusive');
  assert.equal(hasOutgoingGroupSendSince(7, R4_GROUP, 999, { excludePinId: 'pini0' }), false, 'excluded pin ignored');
  assert.equal(hasOutgoingGroupSendSince(7, 'e'.repeat(64) + 'i0', 0), false, 'other group');
  assert.equal(hasOutgoingGroupSendSince(9, R4_GROUP, 0), false, 'other bot');
  resetOutgoingGroupSendLedger();
});

/** R4 daemon-loop harness: one skill turn per mention; the ledger stub decides. */
const createR4Harness = async ({ midTurnSent }) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});
  insertWalletR4(db, 7);
  insertMetabotR4(db, { id: 7, walletId: 7, name: 'Guest Bot', globalmetaid: 'gmid-r4guest' });
  const calls = { send: [], skillTurn: [] };
  const loop = createOpenTeamGuestDaemonLoop({
    getStore: () => store,
    getMetabotStore: () => metabotStore,
    getOpenTeamMembershipStore: () => membershipStore,
    performChat: async () => 'plain reply',
    sendGroupMessage: async (metabotId, groupId, opts) => {
      calls.send.push([metabotId, groupId, opts]);
      return { pinId: 'daemon-send-pini0' };
    },
    hasSentToGroupSince: () => midTurnSent,
    getCoworkStore: () => coworkStore,
    getChatSkillsRoutingPrompt: async () => ({ prompt: 'ROUTING', activeSkillIds: ['skill-doc'] }),
    runSkillTurn: async (params) => {
      calls.skillTurn.push(params);
      return { replyText: 'Already sent mid-turn via group_chat. Report: joined and greeted.', assistantMessageId: 'a1', cwd: tempDir };
    },
    emitLog: () => {},
    now: () => 1_800_000_000_000,
    cooldownMs: 0,
  });
  return { store, db, membershipStore, coworkStore, loop, calls };
};

test('R4 replay (P2 incident): mid-turn group_chat send suppresses the final-text auto-send', async () => {
  const { store, db, membershipStore, coworkStore, loop, calls } = await createR4Harness({ midTurnSent: true });
  try {
    membershipStore.upsertActiveMembership({
      groupId: R4_GROUP,
      metabotId: 7,
      globalmetaid: 'gmid-r4guest',
      inviterGlobalmetaid: 'gmid-r4chair',
      taskTitle: 'zero-preset collision',
    });
    insertGroupMessageR4(db, {
      pinId: 'f'.repeat(64) + 'i0',
      senderMetaId: 'metaid-chair',
      senderGlobalMetaId: 'gmid-r4chair',
      senderName: 'Chair',
      content: '@Guest Bot welcome to the group',
    });
    await loop.runTick();

    assert.equal(calls.skillTurn.length, 1, 'the skill turn ran');
    // Single-send guarantee: the duplicate report must stay OFF-chain.
    assert.equal(calls.send.length, 0, 'final-text auto-send suppressed');
    // The suppressed text still lands in the mirror session (session log only).
    const mapping = coworkStore.getConversationMapping('metaweb_group_task', `openteam:${R4_GROUP}`, 7);
    assert.ok(mapping, 'mirror session mapping exists');
    const session = coworkStore.getSession(mapping.coworkSessionId);
    assert.ok(
      session.messages.some((message) => message.type === 'assistant' && message.content.includes('Already sent mid-turn')),
      'suppressed final text preserved in the session log',
    );
  } finally {
    store.close();
  }
});

test('R4 control: without a mid-turn send the final text goes on-chain exactly once', async () => {
  const { store, db, membershipStore, loop, calls } = await createR4Harness({ midTurnSent: false });
  try {
    membershipStore.upsertActiveMembership({
      groupId: R4_GROUP,
      metabotId: 7,
      globalmetaid: 'gmid-r4guest',
      inviterGlobalmetaid: 'gmid-r4chair',
      taskTitle: 'zero-preset collision',
    });
    insertGroupMessageR4(db, {
      pinId: '1'.repeat(64) + 'i0',
      senderMetaId: 'metaid-chair',
      senderGlobalMetaId: 'gmid-r4chair',
      senderName: 'Chair',
      content: '@Guest Bot say something',
    });
    await loop.runTick();
    assert.equal(calls.skillTurn.length, 1);
    assert.equal(calls.send.length, 1, 'exactly one on-chain send');
    assert.match(calls.send[0][2].content, /Already sent mid-turn/);
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// R6/R8 chair-side pure helpers (stall exemption, discussion tag, local prompt)
// ---------------------------------------------------------------------------

const { isGroupTaskDiscussionDeclaration } = require('../dist-electron/main/services/groupTaskDaemon.js');
const { computeGroupTaskStall } = require('../dist-electron/main/services/groupTaskService.js');
const {
  buildGroupTaskSystemPrompt,
  buildGroupTaskBlock,
} = require('../dist-electron/main/services/groupTaskPrompts.js');

test('R8: isGroupTaskDiscussionDeclaration accepts only the bare tag on its own line', () => {
  assert.equal(isGroupTaskDiscussionDeclaration('[DISCUSSION]'), true);
  assert.equal(isGroupTaskDiscussionDeclaration('Debating the approach now.\n[DISCUSSION]'), true);
  assert.equal(isGroupTaskDiscussionDeclaration('[DISCUSSION] extra words on the line'), false);
  assert.equal(isGroupTaskDiscussionDeclaration('we are in a [DISCUSSION] phase'), false);
  assert.equal(isGroupTaskDiscussionDeclaration('`[DISCUSSION]`'), false, 'backticked citation');
  assert.equal(isGroupTaskDiscussionDeclaration(''), false);
});

test('R6: chat tasks never read as stalled (waiting is legal)', () => {
  const nowMs = Date.now();
  const idleTask = {
    id: 1,
    status: 'executing',
    mode: 'task',
    lastDrivenAt: Math.floor((nowMs - 3 * 60 * 60_000) / 1000),
    updatedAt: null,
  };
  assert.equal(computeGroupTaskStall(idleTask, nowMs).stall, true, 'task mode control');
  const idleChat = { ...idleTask, mode: 'chat' };
  assert.equal(computeGroupTaskStall(idleChat, nowMs).stall, false, 'chat exempt');
});

const promptTask = { title: 'build it', goal: 'ship it', acceptanceCriteria: 'works', groupId: null };
const promptMembersList = [
  { name: 'Twin Bot', role: 'chair' },
  { name: 'Coder Bot', role: 'worker' },
];

test('R6: local chat-mode prompt swaps the task playbook for the chat playbook', () => {
  const chatPrompt = buildGroupTaskBlock({
    task: { ...promptTask, mode: 'chat' },
    members: promptMembersList,
    botName: 'Coder Bot',
    botRole: 'worker',
  });
  assert.ok(chatPrompt.includes('Group Chat'), 'chat framing');
  assert.ok(chatPrompt.includes('free-form CHAT group'), 'chat playbook present');
  assert.ok(!chatPrompt.includes('[WORKING]'), 'no ACK ceremony');
  assert.ok(!chatPrompt.includes('[DELIVERABLE]` lines'), 'no deliverable discipline');
  assert.ok(!chatPrompt.includes('Assign different subtasks'), 'no dispatch discipline');
  assert.ok(!chatPrompt.includes('STEP DEADLINES'), 'no deadline discipline');

  const taskPrompt = buildGroupTaskBlock({
    task: { ...promptTask, mode: 'task' },
    members: promptMembersList,
    botName: 'Coder Bot',
    botRole: 'worker',
  });
  assert.ok(taskPrompt.includes('Group Task'), 'task framing');
  assert.ok(taskPrompt.includes('[WORKING]'), 'ACK ceremony intact in task mode');
});

test('R6: chat-mode chair prompt carries no chair dispatch/lifecycle rules', () => {
  const chatChair = buildGroupTaskBlock({
    task: { ...promptTask, mode: 'chat' },
    members: promptMembersList,
    botName: 'Twin Bot',
    botRole: 'chair',
  });
  assert.ok(!chatChair.includes('[STATUS:REVIEW]'), 'no lifecycle tag rules');
  assert.ok(!chatChair.includes('STEP DEADLINES'), 'no deadline discipline');
  assert.ok(!chatChair.includes('decompose it into concrete subtasks'), 'no decomposition duty');
  assert.ok(chatChair.includes('ONE VOICE PER TURN'), 'one-voice rule present');
});

// ---------------------------------------------------------------------------
// R9/R10/R11 (P2 batch): positions ledger, cognition store, mirror labeling
// ---------------------------------------------------------------------------

const { parsePositionLines } = require('../dist-electron/main/libs/groupTaskPositions.js');
const { DialogueCognitionStore } = require('../dist-electron/main/dialogueCognitionStore.js');
const { ensureOpenTeamGuestSession } = require('../dist-electron/main/services/groupTaskSession.js');

// --- R9: [POSITION] line parser -------------------------------------------

test('R9: parsePositionLines extracts leading-tag lines only', () => {
  const parsed = parsePositionLines(
    [
      'Let me put this on the record.',
      '[POSITION: I object to plan B — the data pipeline cannot rerun mid-day.]',
      'Also note `[POSITION: backticked citation]` is not a position.',
      '[POSITION: boundary — no production writes without owner review.]',
      '[POSITION:]',
    ].join('\n'),
  );
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].line, 2);
  assert.match(parsed[0].text, /I object to plan B/);
  assert.match(parsed[1].text, /boundary — no production writes/);
  assert.equal(parsePositionLines('[POSITION: inline] more text after the bracket').length, 0);
  assert.equal(parsePositionLines('').length, 0);
});

// --- R9: positions ledger store --------------------------------------------

test('R9: addPosition records and dedupes by (task, pin, line); listPositions cites source', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  try {
    const groupTaskStore = new GroupTaskStore(store.getDatabase(), store.getSaveFunction());
    const task = groupTaskStore.createTask(baseTaskInput());
    const pin = `${'3'.repeat(64)}i0`;
    const first = groupTaskStore.addPosition({
      taskId: task.id,
      msgPinId: pin,
      authorGlobalmetaid: 'idqmember',
      statement: 'I object to the second proposal.',
      lineNo: 2,
    });
    assert.ok(first);
    // Re-ingest the same message: no duplicate row.
    groupTaskStore.addPosition({
      taskId: task.id,
      msgPinId: pin,
      authorGlobalmetaid: 'idqmember',
      statement: 'I object to the second proposal.',
      lineNo: 2,
    });
    const positions = groupTaskStore.listPositions(task.id);
    assert.equal(positions.length, 1);
    assert.equal(positions[0].msgPinId, pin, 'source pin cited');
    assert.equal(positions[0].authorGlobalmetaid, 'idqmember');
    // Pin-less or empty statements never record (cannot dedupe / nothing to say).
    assert.equal(groupTaskStore.addPosition({ taskId: task.id, msgPinId: null, statement: 'x', lineNo: 1 }), null);
    assert.equal(groupTaskStore.addPosition({ taskId: task.id, msgPinId: pin, statement: '   ', lineNo: 3 }), null);
  } finally {
    store.close();
  }
});

// --- R10: dialogue cognition store -----------------------------------------

test('R10: a cognition record can be written and read back with source pin + fields', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  try {
    const cognitionStore = new DialogueCognitionStore(store.getDatabase(), store.getSaveFunction());
    const groupId = '6'.repeat(64) + 'i0';
    const pin = `${'4'.repeat(64)}i0`;
    const written = cognitionStore.recordDialogueCognition({
      groupId,
      kind: 'boundary',
      statement: 'I do not want my name on the partnership plaque without review.',
      authorGlobalMetaId: 'idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz',
      participants: ['idq14hmv23j5fnlx4ccnmvlyldjd38xjsechzwg9xz', 'idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm'],
      sourcePinId: pin,
    });
    assert.ok(written, 'record written');
    assert.equal(written.kind, 'boundary');
    assert.equal(written.sourcePinId, pin);
    const readBack = cognitionStore.listDialogueCognitions(groupId);
    assert.equal(readBack.length, 1);
    assert.equal(readBack[0].statement, written.statement);
    assert.equal(readBack[0].taskId, null, 'group-scoped, no local task row required');
    assert.match(readBack[0].participantsJson, /idq1g35d5yftpq3jv0ukejte7z76qdqp7sve8l2etm/);
    // Idempotent per source pin: re-recording returns the same row.
    const again = cognitionStore.recordDialogueCognition({
      groupId,
      kind: 'boundary',
      statement: 'I do not want my name on the partnership plaque without review.',
      sourcePinId: pin,
    });
    assert.equal(again.id, written.id);
    assert.equal(cognitionStore.listDialogueCognitions(groupId).length, 1);
    // Unknown kinds normalize to note; junk input is rejected.
    assert.equal(cognitionStore.recordDialogueCognition({ groupId, statement: 'x', kind: 'bogus' }).kind, 'note');
    assert.equal(cognitionStore.recordDialogueCognition({ groupId: '  ', statement: 'x' }), null);
  } finally {
    store.close();
  }
});

// --- R11: mirror session labeling ------------------------------------------

test('R11: the eager guest session is created as an explicit log mirror', async () => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  try {
    const coworkStore = new CoworkStore(store.getDatabase(), () => {});
    const groupId = '7'.repeat(64) + 'i0';
    const { session, created } = ensureOpenTeamGuestSession(coworkStore, 42, 'Guest Bot', {
      groupId,
      taskTitle: 'zero-preset collision',
    });
    assert.ok(created);
    assert.match(session.title, /\[log mirror\]/, 'title carries the mirror role');
    // Second call resolves the SAME session (single mirror per membership).
    const again = ensureOpenTeamGuestSession(coworkStore, 42, 'Guest Bot', { groupId, taskTitle: 't' });
    assert.equal(again.created, false);
    assert.equal(again.session.id, session.id);
  } finally {
    store.close();
  }
});
