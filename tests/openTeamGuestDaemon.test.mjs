import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import Module from 'node:module';

const require = createRequire(import.meta.url);

// Some stores may transitively import electron; mock it like groupTaskDaemon tests do.
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
const { OpenTeamMembershipStore } = require('../dist-electron/main/openTeamMembershipStore.js');
const { CoworkStore } = require('../dist-electron/main/coworkStore.js');
const {
  decideOpenTeamGuestResponse,
  createOpenTeamGuestDaemonLoop,
} = require('../dist-electron/main/services/openTeamGuestDaemon.js');
// Inviter-side parser: proves the guest's delivery lines ingest cleanly.
const { parseDeliverableLines } = require('../dist-electron/main/services/groupTaskDeliverableParser.js');

Module._load = originalLoad;

const GROUP_ID = 'aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff00000000i0';
const GUEST_GMID = 'gmid-guest';
const OTHER_GMID = 'gmid-other';

const makeTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-openteam-guest-daemon-'));

// ---------------------------------------------------------------------------
// Pure gating
// ---------------------------------------------------------------------------

const gateBot = () => ({ name: 'Guest Bot', globalmetaid: GUEST_GMID, metaid: 'metaid-guest' });
const gateMessage = (overrides = {}) => ({
  id: 1,
  pinId: null,
  senderMetaId: 'metaid-other',
  senderGlobalMetaId: OTHER_GMID,
  senderName: 'Other Bot',
  content: 'hello group',
  mention: null,
  ...overrides,
});
const gateInput = (overrides = {}) => ({
  message: gateMessage(),
  bot: gateBot(),
  lastReplyAt: 0,
  now: 100_000,
  cooldownMs: 20_000,
  ...overrides,
});

test('gating: responds only when mentioned (mention array or @name)', () => {
  assert.deepEqual(decideOpenTeamGuestResponse(gateInput()), { respond: false, reason: 'not_mentioned' });
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ mention: JSON.stringify([GUEST_GMID]) }) })),
    { respond: true, reason: 'mentioned' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ mention: JSON.stringify(['metaid-guest']) }) })),
    { respond: true, reason: 'mentioned' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: '@Guest Bot please take this' }) })),
    { respond: true, reason: 'mentioned' },
  );
  // Bare name without @ must NOT count as a mention.
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: 'Guest Bot already checked' }) })),
    { respond: false, reason: 'not_mentioned' },
  );
});

test('gating: skips own messages, empty content, and honors the cooldown', () => {
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({
      message: gateMessage({ senderGlobalMetaId: GUEST_GMID, content: '@Guest Bot hi' }),
    })),
    { respond: false, reason: 'self_message' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({ message: gateMessage({ content: '   ' }) })),
    { respond: false, reason: 'empty_content' },
  );
  assert.deepEqual(
    decideOpenTeamGuestResponse(gateInput({
      message: gateMessage({ mention: JSON.stringify([GUEST_GMID]) }),
      lastReplyAt: 95_000,
      now: 100_000,
      cooldownMs: 20_000,
    })),
    { respond: false, reason: 'cooldown' },
  );
});

// ---------------------------------------------------------------------------
// Daemon loop harness (real sqlite stores, mocked LLM + send)
// ---------------------------------------------------------------------------

const insertWallet = (db, id) => {
  db.run(
    `INSERT INTO metabot_wallets (id, mnemonic, path, created_at) VALUES (?, ?, ?, ?)`,
    [id, `abandon ability able about above absent absorb abstract absurd abuse access accident ${id}`, "m/44'/10001'/0'/0/0", 1700000000000 + id]
  );
};

const insertMetabot = (db, { id, walletId, name, globalmetaid = null, allowChatSkills = [] }) => {
  db.run(
    `INSERT INTO metabots (
      id, wallet_id, mvc_address, btc_address, doge_address, public_key, chat_public_key,
      name, enabled, metaid, globalmetaid, metabot_type, created_by, role, soul,
      boss_global_metaid, llm_id, allow_chat_skills, bio, goal, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, walletId, `mvc-${id}`, `btc-${id}`, `doge-${id}`, `public-${id}`, `chat-public-${id}`,
      name, 1, `metaid-${id}`, globalmetaid, 'worker', '0000', `${name} role`, `${name} soul`,
      null, null, JSON.stringify(allowChatSkills), null, null, 1700000000000 + id, 1700000000000 + id,
    ]
  );
};

const insertGroupMessage = (db, { pinId, groupId = GROUP_ID, senderMetaId, senderGlobalMetaId, senderName, content, mention = null }) => {
  db.run(
    `INSERT INTO group_chat_messages (
      pin_id, tx_id, group_id, channel_id, sender_metaid, sender_global_metaid, sender_address,
      sender_name, sender_avatar, sender_chat_pubkey, protocol, content, content_type, encryption,
      reply_pin, mention, chain_timestamp, chain, raw_data, is_processed, msg_index
    ) VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, '', '', '/protocols/simplegroupchat', ?, 'text/plain', NULL, '', ?, NULL, 'mvc', '{}', 0, NULL)`,
    [pinId, pinId.replace(/i0$/, ''), groupId, senderMetaId, senderGlobalMetaId, senderName, content,
      mention ? JSON.stringify(mention) : '[]'],
  );
};

const createHarness = async (overrides = {}) => {
  const tempDir = makeTempDir();
  const store = await SqliteStore.create(tempDir);
  const db = store.getDatabase();
  const metabotStore = new MetabotStore(db, store.getSaveFunction());
  const membershipStore = new OpenTeamMembershipStore(db, store.getSaveFunction());
  const coworkStore = new CoworkStore(db, () => {});

  insertWallet(db, 7);
  insertMetabot(db, {
    id: 7,
    walletId: 7,
    name: 'Guest Bot',
    globalmetaid: GUEST_GMID,
    allowChatSkills: overrides.allowChatSkills ?? [],
  });

  const calls = { chat: [], send: [] };
  const performChat = async (systemPrompt, userMessage, llmId, options) => {
    calls.chat.push({ systemPrompt, userMessage, llmId, options });
    return overrides.replyText ?? 'On it — results soon.';
  };
  const sendGroupMessage = async (metabotId, groupId, opts) => {
    calls.send.push([metabotId, groupId, opts]);
    return { pinId: 'sent-pin-1' };
  };

  // deps may be a function receiving the harness stores (skill seams need the
  // coworkStore created here).
  const extraDeps = typeof overrides.deps === 'function'
    ? overrides.deps({ coworkStore })
    : overrides.deps;
  const loop = createOpenTeamGuestDaemonLoop({
    getStore: () => store,
    getMetabotStore: () => metabotStore,
    getOpenTeamMembershipStore: () => membershipStore,
    performChat,
    sendGroupMessage,
    emitLog: () => {},
    now: () => 1_800_000_000_000,
    cooldownMs: 0,
    ...extraDeps,
  });
  return { store, db, metabotStore, membershipStore, coworkStore, loop, calls };
};

const messageIdOf = (db, pinId) => {
  const result = db.exec('SELECT id FROM group_chat_messages WHERE pin_id = ?', [pinId]);
  return Number(result[0]?.values?.[0]?.[0]);
};

test('loop: mentions trigger a reply; unrelated and own messages do not; cursor advances', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({
      groupId: GROUP_ID,
      metabotId: 7,
      globalmetaid: GUEST_GMID,
      inviterGlobalmetaid: 'gmid-inviter',
      taskTitle: 'External Task',
    });

    insertGroupMessage(db, {
      pinId: `${'1'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: 'unrelated chatter',
    });
    insertGroupMessage(db, {
      pinId: `${'2'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot can you take the summary?',
    });
    insertGroupMessage(db, {
      pinId: `${'3'.repeat(64)}i0`,
      senderMetaId: 'metaid-guest',
      senderGlobalMetaId: GUEST_GMID,
      senderName: 'Guest Bot',
      content: 'my own earlier message',
    });

    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.deepEqual(calls.send[0][0], 7);
    assert.deepEqual(calls.send[0][1], GROUP_ID);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
    assert.equal(calls.send[0][2].nickName, 'Guest Bot');
    // The guest prompt explains the external-collaborator role.
    assert.match(calls.chat[0].systemPrompt, /invited/i);
    assert.match(calls.chat[0].systemPrompt, /External Task/);
    assert.match(calls.chat[0].userMessage, />>> Other Bot: @Guest Bot can you take the summary\? <<</);

    // Cursor advanced past ALL messages of the tick (including skipped ones).
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'3'.repeat(64)}i0`));

    // Second tick: nothing new, no reprocessing.
    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
  } finally {
    store.close();
  }
});

test('#13 handshake: guest prompt carries the greet-first rule and WHY it was invited (goal + required skills)', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    // The guest-side invite history row records why the bot was invited; the
    // membership echoes the invite pin so the daemon can look it up.
    membershipStore.createGuestInvite({
      groupId: GROUP_ID,
      inviterGlobalmetaid: 'gmid-inviter',
      inviterName: 'Twin Bot',
      taskTitle: 'Remote divination collab',
      goalSummary: 'Run a remote fortune-telling collaboration',
      requiredSkills: ['占卜', '塔罗'],
      invitePinId: 'invite-xyz',
      targetGlobalmetaid: GUEST_GMID,
    });
    membershipStore.upsertActiveMembership({
      groupId: GROUP_ID,
      metabotId: 7,
      globalmetaid: GUEST_GMID,
      inviterGlobalmetaid: 'gmid-inviter',
      taskTitle: 'Remote divination collab',
      invitePinId: 'invite-xyz',
    });
    insertGroupMessage(db, {
      pinId: `${'2'.repeat(64)}i0`, senderMetaId: 'metaid-other', senderGlobalMetaId: 'gmid-other',
      senderName: 'Other Bot', content: 'Welcome @Guest Bot, please confirm you are online and start working.',
    });

    await loop.runTick();

    assert.equal(calls.chat.length, 1);
    const prompt = calls.chat[0].systemPrompt;
    // Greet-first handshake rule injected into the playbook.
    assert.match(prompt, /when you FIRST appear in this group/i);
    assert.match(prompt, /START with a short greeting confirming you are present/i);
    assert.match(prompt, /Never start working before that greeting/);
    // Why the bot was invited (goal summary + required skills).
    assert.match(prompt, /You were invited because: Run a remote fortune-telling collaboration/);
    assert.match(prompt, /required skills: 占卜, 塔罗/);
  } finally {
    store.close();
  }
});

test('persona: guest prompt uses the shared persona block — no hand-rolled fields, no (empty) rendering', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'7'.repeat(64)}i0`, senderMetaId: 'metaid-other', senderGlobalMetaId: 'gmid-other',
      senderName: 'Other Bot', content: '@Guest Bot introduce yourself',
    });

    await loop.runTick();

    assert.equal(calls.chat.length, 1);
    const prompt = calls.chat[0].systemPrompt;
    // The harness metabot row has role/soul set but bio/goal NULL: the legacy
    // hand-rolled block rendered those as "Goal: (empty)" / "Bio: (empty)".
    assert.match(prompt, /<metabot_identity>/);
    assert.match(prompt, /<name>Guest Bot<\/name>/);
    assert.match(prompt, /<role>Guest Bot role<\/role>/);
    assert.match(prompt, /<soul>Guest Bot soul<\/soul>/);
    assert.ok(!prompt.includes('(empty)'), 'empty persona fields are skipped, not rendered as (empty)');
    assert.ok(!/^You are Guest Bot/m.test(prompt), 'no second identity line next to the persona block');
    // The external-collaborator framing stays in the guest block.
    assert.match(prompt, /## OpenTeam external collaboration/);
  } finally {
    store.close();
  }
});

test('self-cognition: plain path appends the minimal pack (self-identity + dream summaries); memoryEnabled=false gates it off', async () => {
  const memorySeams = (memoryEnabled) => ({
    listUserMemories: (metabotId, input) =>
      input.usageClass === 'self_identity' ? [{ text: '我是一个被邀请去做客也保持自我的 MetaBot' }] : [],
    listDailySummaries: () => [{ summaryDate: '2026-10-02', summaryText: '昨天梦见自己在外部群里帮忙做了海报' }],
    getEffectiveMemoryPolicy: () => ({ memoryEnabled }),
  });

  const { store, db, membershipStore, loop, calls } = await createHarness({ deps: memorySeams(true) });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'8'.repeat(64)}i0`, senderMetaId: 'metaid-other', senderGlobalMetaId: 'gmid-other',
      senderName: 'Other Bot', content: '@Guest Bot who are you?',
    });

    await loop.runTick();

    assert.equal(calls.chat.length, 1);
    const prompt = calls.chat[0].systemPrompt;
    assert.match(prompt, /<metabot_self_identity>/, 'self-identity block injected on the plain path');
    assert.ok(prompt.includes('我是一个被邀请去做客也保持自我的 MetaBot'));
    assert.match(prompt, /<recent_daily_summaries>/, 'dream summaries block injected');
    assert.ok(prompt.includes('2026-10-02'));
  } finally {
    store.close();
  }

  const gated = await createHarness({ deps: memorySeams(false) });
  try {
    gated.membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(gated.db, {
      pinId: `${'9'.repeat(64)}i0`, senderMetaId: 'metaid-other', senderGlobalMetaId: 'gmid-other',
      senderName: 'Other Bot', content: '@Guest Bot who are you?',
    });

    await gated.loop.runTick();

    assert.equal(gated.calls.chat.length, 1);
    const prompt = gated.calls.chat[0].systemPrompt;
    assert.doesNotMatch(prompt, /<metabot_self_identity>/, 'memory policy gates the pack off');
    assert.doesNotMatch(prompt, /<recent_daily_summaries>/);
    assert.match(prompt, /<metabot_identity>/, 'persona unaffected by the memory gate');
  } finally {
    gated.store.close();
  }
});

test('loop: [NO_REPLY] suppresses the on-chain send but still advances the cursor', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness({ replyText: '[NO_REPLY]' });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'4'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot thanks!',
    });
    await loop.runTick();
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 0);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'4'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});

test('loop: disabled bot and left membership stay silent', async () => {
  const { store, db, metabotStore, membershipStore, loop, calls } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'5'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot are you there?',
    });
    // Left memberships are excluded from listActiveMemberships.
    membershipStore.markLeft(GROUP_ID, 7);
    await loop.runTick();
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 0);
  } finally {
    store.close();
  }
});

test('store: catchUpCursorToLatest fast-forwards past existing history', async () => {
  const { store, db, membershipStore } = await createHarness();
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'6'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: 'old history before join',
    });
    membershipStore.catchUpCursorToLatest(GROUP_ID, 7);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'6'.repeat(64)}i0`));

    // Cursor moves only forward.
    membershipStore.updateLastProcessedMsgId(GROUP_ID, 7, 1);
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      messageIdOf(db, `${'6'.repeat(64)}i0`),
    );
  } finally {
    store.close();
  }
});

test('loop: a cooldown-blocked mention holds the cursor and is answered once the cooldown elapses', async () => {
  let currentNow = 1_800_000_000_000;
  const { store, db, membershipStore, loop, calls } = await createHarness({
    deps: { now: () => currentNow, cooldownMs: 20_000 },
  });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'1'.repeat(63)}ai0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot first question',
    });
    await loop.runTick();
    assert.equal(calls.send.length, 1, 'first mention answered');
    const firstId = messageIdOf(db, `${'1'.repeat(63)}ai0`);
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId, firstId);

    // 5s later a second mention lands inside the 20s cooldown window.
    currentNow += 5_000;
    insertGroupMessage(db, {
      pinId: `${'2'.repeat(63)}bi0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot second question',
    });
    await loop.runTick();
    assert.equal(calls.send.length, 1, 'cooldown suppresses the reply');
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      firstId,
      'cursor held BEFORE the cooldown-blocked message (not silently dropped)',
    );
    // Still held on the next tick while the cooldown keeps running.
    currentNow += 5_000;
    await loop.runTick();
    assert.equal(calls.send.length, 1);
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId, firstId);

    // Once the cooldown has elapsed the held mention is re-evaluated and answered.
    currentNow += 15_000;
    await loop.runTick();
    assert.equal(calls.send.length, 2, 'the held mention is answered after the cooldown');
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      messageIdOf(db, `${'2'.repeat(63)}bi0`),
    );
  } finally {
    store.close();
  }
});

test('loop: a failing reply holds the cursor, retries, and gives up after 3 consecutive failures', async () => {
  const logs = [];
  let chatCalls = 0;
  const { store, db, membershipStore, loop } = await createHarness({
    deps: {
      performChat: async () => {
        chatCalls += 1;
        throw new Error('LLM down');
      },
      emitLog: (line) => logs.push(String(line)),
    },
  });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    const pinId = `${'3'.repeat(63)}ci0`;
    insertGroupMessage(db, {
      pinId,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot are you there?',
    });

    await loop.runTick(); // failure 1
    assert.equal(chatCalls, 1);
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      0,
      'cursor held for a retry (failure is not silently dropped)',
    );
    await loop.runTick(); // failure 2
    assert.equal(chatCalls, 2);
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId, 0);

    await loop.runTick(); // failure 3 -> bounded retry gives up
    assert.equal(chatCalls, 3);
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      messageIdOf(db, pinId),
      'cursor advances once the bounded retries are exhausted',
    );
    assert.ok(
      logs.some((line) => line.includes('giving up')),
      `expected a give-up log, got: ${JSON.stringify(logs)}`,
    );

    await loop.runTick(); // the abandoned message is not retried anymore
    assert.equal(chatCalls, 3);
  } finally {
    store.close();
  }
});

test('loop: leaving the group drops the in-memory cooldown state (a re-join answers immediately)', async () => {
  let currentNow = 1_800_000_000_000;
  const { store, db, membershipStore, loop, calls } = await createHarness({
    deps: { now: () => currentNow, cooldownMs: 20_000 },
  });
  try {
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    insertGroupMessage(db, {
      pinId: `${'4'.repeat(63)}di0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot question one',
    });
    await loop.runTick();
    assert.equal(calls.send.length, 1);

    // The bot leaves (kick / owner opt-out); one tick observes the membership
    // as inactive and drops its loop-prevention state.
    membershipStore.markLeft(GROUP_ID, 7);
    await loop.runTick();

    // A re-invite reactivates the same membership row within the OLD cooldown
    // window: the reply must not be blocked by the stale lastReplyAt entry.
    membershipStore.upsertActiveMembership({ groupId: GROUP_ID, metabotId: 7, globalmetaid: GUEST_GMID });
    currentNow += 5_000;
    insertGroupMessage(db, {
      pinId: `${'5'.repeat(63)}ei0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot question two',
    });
    await loop.runTick();
    assert.equal(calls.send.length, 2, 're-join starts with a clean cooldown state');
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// M3: chat-skill turns + metafile file delivery
// ---------------------------------------------------------------------------

const SKILL_PINID = `${'ef'.repeat(32)}i0`;

/**
 * Skill-enabled harness: real CoworkStore, mocked routing/skill-turn/upload
 * seams. runSkillTurn reports artifactDir as its cwd so the delivery step
 * resolves/scans files there.
 */
const createSkillHarness = async (overrides = {}) => {
  const artifactDir = makeTempDir();
  const skillCalls = { routing: [], skillTurn: [], upload: [], publish: [] };
  const logs = [];
  const state = {
    routing: overrides.routing ?? { prompt: 'SKILL ROUTING PROMPT', activeSkillIds: ['skill-doc'] },
    routingError: overrides.routingError ?? null,
    skillReply: overrides.skillReply ?? 'Draft ready.',
    skillError: overrides.skillError ?? null,
    uploadError: overrides.uploadError ?? null,
    uploadPinId: overrides.uploadPinId ?? SKILL_PINID,
    publishError: overrides.publishError ?? null,
    publishPinId: overrides.publishPinId ?? SKILL_PINID,
  };
  const harness = await createHarness({
    replyText: overrides.replyText,
    allowChatSkills: overrides.allowChatSkills ?? ['skill-doc'],
    deps: ({ coworkStore }) => ({
      getCoworkStore: () => coworkStore,
      getChatSkillsRoutingPrompt: async (input) => {
        skillCalls.routing.push(input);
        if (state.routingError) throw new Error(state.routingError);
        return typeof state.routing === 'function' ? state.routing(input) : state.routing;
      },
      runSkillTurn: async (params) => {
        skillCalls.skillTurn.push(params);
        if (state.skillError) throw new Error(state.skillError);
        return {
          replyText: typeof state.skillReply === 'function' ? state.skillReply() : state.skillReply,
          assistantMessageId: 'asst-skill-1',
          cwd: artifactDir,
        };
      },
      uploadDeliverableFile: async (input) => {
        skillCalls.upload.push(input);
        if (state.uploadError) throw new Error(state.uploadError);
        return { pinId: state.uploadPinId };
      },
      publishTextDeliverable: async (input) => {
        skillCalls.publish.push(input);
        if (state.publishError) throw new Error(state.publishError);
        return { pinId: state.publishPinId };
      },
      emitLog: (line) => logs.push(String(line)),
      ...(overrides.realNow ? { now: () => Date.now() } : {}),
    }),
  });
  return { ...harness, artifactDir, skillCalls, logs };
};

const joinAndMention = (db, membershipStore, pinId) => {
  membershipStore.upsertActiveMembership({
    groupId: GROUP_ID,
    metabotId: 7,
    globalmetaid: GUEST_GMID,
    inviterGlobalmetaid: 'gmid-inviter',
    taskTitle: 'External Task',
  });
  insertGroupMessage(db, {
    pinId,
    senderMetaId: 'metaid-other',
    senderGlobalMetaId: OTHER_GMID,
    senderName: 'Other Bot',
    content: '@Guest Bot please produce the report',
  });
};

test('skill: routing hit runs the skill turn (scoped to own allow_chat_skills), not plain chat', async () => {
  const { store, db, membershipStore, coworkStore, loop, calls, skillCalls } = await createSkillHarness();
  try {
    joinAndMention(db, membershipStore, `${'a'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.routing.length, 1);
    // External group members are never the owner: only the bot's assigned
    // skills are routable — widened stays false.
    assert.deepEqual(skillCalls.routing[0], { metabotId: 7, widened: false });

    assert.equal(skillCalls.skillTurn.length, 1);
    assert.deepEqual(skillCalls.skillTurn[0].activeSkillIds, ['skill-doc']);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /SKILL ROUTING PROMPT/);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /invited/i);
    assert.match(skillCalls.skillTurn[0].systemPrompt, /absolute local path/);
    assert.match(skillCalls.skillTurn[0].userMessage, />>> Other Bot: @Guest Bot please produce the report <<</);

    // Plain completion path NOT used; the skill reply is what goes on-chain.
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'Draft ready.');

    // The skill turn ran inside a per-group guest cowork session bound to bot 7.
    const session = coworkStore.getSession(skillCalls.skillTurn[0].sessionId);
    assert.ok(session);
    assert.equal(session.metabotId, 7);
    assert.equal(session.sessionType, 'group_task');
    assert.ok(session.messages.some((m) => m.type === 'user' && m.content.includes('>>> Other Bot')));

    // No file artifacts in the reply -> no upload attempted.
    assert.equal(skillCalls.upload.length, 0);
  } finally {
    store.close();
  }
});

test('skill: a mentioned file artifact uploads and delivers one [DELIVERABLE] metafile line', async () => {
  let reportPath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    // Evaluated at turn time; the file is written below before runTick.
    skillReply: () => `Report is ready.\n${reportPath}`,
  });
  try {
    reportPath = path.join(artifactDir, 'report.pdf');
    fs.writeFileSync(reportPath, 'pdf-bytes');
    joinAndMention(db, membershipStore, `${'b'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(calls.chat.length, 0);
    assert.equal(skillCalls.upload.length, 1);
    assert.equal(skillCalls.upload[0].metabotId, 7);
    assert.equal(skillCalls.upload[0].filePath, reportPath);
    assert.equal(skillCalls.upload[0].contentType, 'application/pdf');

    assert.equal(calls.send.length, 1);
    const content = calls.send[0][2].content;
    assert.match(content, /Report is ready\./);
    const expectedLine = `[DELIVERABLE] metafile: metafile://${SKILL_PINID}.pdf`;
    assert.ok(
      content.split('\n').includes(expectedLine),
      `expected its own deliverable line, got:\n${content}`,
    );

    // The inviter-side parser must ingest the line as one valid metafile deliverable.
    const parsed = parseDeliverableLines(content);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      kind: 'metafile',
      uri: `metafile://${SKILL_PINID}.pdf`,
      valid: true,
      note: null,
    });
  } finally {
    store.close();
  }
});

test('skill: a mentioned Markdown artifact publishes as a simplenote note (pin://), never metafile', async () => {
  let notePath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    // Evaluated at turn time; the file is written below before runTick.
    skillReply: () => `Report is ready.\n${notePath}`,
  });
  try {
    notePath = path.join(artifactDir, 'report.md');
    fs.writeFileSync(notePath, '# Report\n\nAll done.');
    joinAndMention(db, membershipStore, `${'f'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(calls.chat.length, 0);
    assert.equal(skillCalls.publish.length, 1, 'text document goes through the simplenote seam');
    assert.equal(skillCalls.publish[0].metabotId, 7);
    assert.equal(skillCalls.publish[0].filePath, notePath);
    assert.equal(skillCalls.upload.length, 0, 'no /file metafile upload for a text document');

    assert.equal(calls.send.length, 1);
    const content = calls.send[0][2].content;
    const expectedLine = `[DELIVERABLE] note: pin://${SKILL_PINID}`;
    assert.ok(
      content.split('\n').includes(expectedLine),
      `expected its own note deliverable line, got:\n${content}`,
    );

    // The inviter-side parser ingests the line as one valid pinid deliverable.
    const parsed = parseDeliverableLines(content);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0], {
      kind: 'pinid',
      uri: `pin://${SKILL_PINID}`,
      valid: true,
      note: null,
    });
  } finally {
    store.close();
  }
});

test('skill: a Markdown artifact whose note publish yields no pinId falls back to metafile', async () => {
  let notePath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    skillReply: () => `Report is ready.\n${notePath}`,
    publishPinId: '',
  });
  try {
    notePath = path.join(artifactDir, 'report.md');
    fs.writeFileSync(notePath, '# Report\n\nAll done.');
    joinAndMention(db, membershipStore, `${'9'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.publish.length, 1);
    assert.equal(skillCalls.upload.length, 1, 'empty note pinId falls back to the metafile upload');
    const content = calls.send[0][2].content;
    const expectedLine = `[DELIVERABLE] metafile: metafile://${SKILL_PINID}.md`;
    assert.ok(
      content.split('\n').includes(expectedLine),
      `expected the metafile fallback line, got:\n${content}`,
    );
  } finally {
    store.close();
  }
});

test('skill: an unmentioned file in the skill cwd is found by the turn-window scan', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    skillReply: 'Here is the image you asked for.',
    realNow: true,
  });
  try {
    const imagePath = path.join(artifactDir, 'chart.png');
    fs.writeFileSync(imagePath, 'png-bytes');
    joinAndMention(db, membershipStore, `${'c'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.upload.length, 1);
    assert.equal(skillCalls.upload[0].filePath, imagePath);
    assert.match(
      calls.send[0][2].content,
      new RegExp(`\\[DELIVERABLE\\] metafile: metafile://${SKILL_PINID}\\.png`),
    );
  } finally {
    store.close();
  }
});

test('skill: no routing hit falls back to the plain completion path', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    routing: { prompt: null, activeSkillIds: [] },
  });
  try {
    joinAndMention(db, membershipStore, `${'d'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.routing.length, 1);
    assert.equal(skillCalls.skillTurn.length, 0);
    assert.equal(skillCalls.upload.length, 0);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
  } finally {
    store.close();
  }
});

test('skill: a throwing skill turn degrades to a plain text reply', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    skillError: 'runner exploded',
  });
  try {
    joinAndMention(db, membershipStore, `${'e'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 1);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
    // Cursor advanced past the triggering message despite the skill failure.
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'e'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});

test('skill: a routing failure also degrades to the plain completion path', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    routingError: 'skill manager unavailable',
  });
  try {
    joinAndMention(db, membershipStore, `${'f'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 0);
    assert.equal(calls.chat.length, 1);
    assert.equal(calls.send.length, 1);
    assert.equal(calls.send[0][2].content, 'On it — results soon.');
  } finally {
    store.close();
  }
});

test('skill: an upload failure keeps the text reply and adds NO fake [DELIVERABLE] tag', async () => {
  let reportPath = '';
  const { store, db, membershipStore, loop, calls, skillCalls, artifactDir } = await createSkillHarness({
    skillReply: () => `Report is ready.\n${reportPath}`,
    uploadError: 'insufficient SPACE',
  });
  try {
    reportPath = path.join(artifactDir, 'report.pdf');
    fs.writeFileSync(reportPath, 'pdf-bytes');
    joinAndMention(db, membershipStore, `${'0'.repeat(64)}i0`);
    await loop.runTick();

    assert.equal(skillCalls.upload.length, 1);
    assert.equal(calls.send.length, 1);
    const content = calls.send[0][2].content;
    assert.match(content, /Report is ready\./);
    assert.match(content, /On-chain publish failed for: report\.pdf/);
    assert.ok(!content.includes('[DELIVERABLE]'), 'no deliverable tag may be emitted for a failed upload');
    assert.deepEqual(parseDeliverableLines(content), []);
  } finally {
    store.close();
  }
});

test('skill: [NO_REPLY] from a skill turn suppresses the send and never uploads', async () => {
  const { store, db, membershipStore, loop, calls, skillCalls } = await createSkillHarness({
    skillReply: '[NO_REPLY]',
  });
  try {
    joinAndMention(db, membershipStore, `${'9'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.skillTurn.length, 1);
    assert.equal(skillCalls.upload.length, 0);
    assert.equal(calls.chat.length, 0);
    assert.equal(calls.send.length, 0);
    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.lastProcessedMsgId, messageIdOf(db, `${'9'.repeat(64)}i0`));
  } finally {
    store.close();
  }
});

test('skill: a mentioned file outside the session workspace is dropped, never uploaded', async () => {
  const outsideDir = makeTempDir();
  const outsidePath = path.join(outsideDir, 'secret.pdf');
  fs.writeFileSync(outsidePath, 'secret-bytes');
  const { store, db, membershipStore, loop, calls, skillCalls, logs } = await createSkillHarness({
    skillReply: `Done.\n${outsidePath}`,
  });
  try {
    joinAndMention(db, membershipStore, `${'8'.repeat(64)}i0`);
    await loop.runTick();
    assert.equal(skillCalls.upload.length, 0, 'outside-workspace files are never uploaded');
    assert.equal(calls.send.length, 1, 'the text reply itself is still delivered');
    const content = calls.send[0][2].content;
    assert.ok(!content.includes('[DELIVERABLE]'), 'no deliverable tag for a dropped file');
    assert.ok(
      logs.some((line) => line.includes('outside the allowed workspace') && line.includes(outsidePath)),
      `expected a drop log, got: ${JSON.stringify(logs)}`,
    );
  } finally {
    store.close();
  }
});

// ---------------------------------------------------------------------------
// P1-2 membership self-check fallback: every membershipCheckIntervalMs the
// daemon re-verifies on-chain that the bot is still a group member. Two guards
// keep indexer lag from killing a healthy membership: a fresh (re-)activation
// is not probed for membershipSelfCheckGraceMs, and only 2 consecutive absence
// reads mark the membership left.
// ---------------------------------------------------------------------------

const membershipCheckHarness = async (overrides = {}) => {
  const state = {
    nowMs: 1_800_000_000_000,
    // null = indexer failure; array = member identity strings
    members: overrides.members === undefined ? [GUEST_GMID] : overrides.members,
  };
  const fetchMembersCalls = [];
  const harness = await createHarness({
    deps: {
      now: () => state.nowMs,
      membershipCheckIntervalMs: overrides.intervalMs ?? 5 * 60_000,
      membershipSelfCheckGraceMs: overrides.graceMs ?? 15 * 60_000,
      fetchGroupMembers: async (groupId) => {
        fetchMembersCalls.push(groupId);
        if (overrides.fetchThrows) throw new Error('indexer down');
        return state.members;
      },
    },
  });
  return { ...harness, state, fetchMembersCalls };
};

const joinAsGuest = (membershipStore) => {
  membershipStore.upsertActiveMembership({
    groupId: GROUP_ID,
    metabotId: 7,
    globalmetaid: GUEST_GMID,
    inviterGlobalmetaid: 'gmid-inviter',
    taskTitle: 'External Task',
  });
};

const formatSqliteUtc = (ms) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// The upsert stamps activated_at with the real wall clock; the self-check grace
// is judged against the daemon's (fake) clock, so tests place the activation
// explicitly on that timeline.
const placeActivationAt = (db, ms) => {
  db.run(
    'UPDATE openteam_memberships SET activated_at = ? WHERE group_id = ? AND metabot_id = 7',
    [formatSqliteUtc(ms), GROUP_ID],
  );
};

const insertMention = (db, pinChar) => {
  insertGroupMessage(db, {
    pinId: `${pinChar.repeat(64)}i0`,
    senderMetaId: 'metaid-other',
    senderGlobalMetaId: OTHER_GMID,
    senderName: 'Other Bot',
    content: '@Guest Bot can you take this?',
  });
};

test('self-check: bot still on the member list — membership stays active, mentions answered', async () => {
  const h = await membershipCheckHarness({ members: ['gmid-someone-else', GUEST_GMID] });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs - 20 * 60_000); // past the 15-min grace
    insertMention(h.db, 'a');
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1, 'grace elapsed: self-check runs on the first tick');
    assert.equal(h.calls.send.length, 1, 'mention answered');
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active');
  } finally {
    h.store.close();
  }
});

test('self-check: the legacy metaid form also counts as still-a-member', async () => {
  const h = await membershipCheckHarness({ members: ['metaid-7'] });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs - 20 * 60_000);
    await h.loop.runTick();
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active');
  } finally {
    h.store.close();
  }
});

test('self-check: activation grace — a fresh membership is not probed at all', async () => {
  const h = await membershipCheckHarness({ members: ['gmid-someone-else'], intervalMs: 60_000 });
  try {
    joinAsGuest(h.membershipStore);
    // Activated 5 min ago on the daemon's clock — inside the 15-min grace. The
    // indexer may not list the join pin yet; probing now could mark left.
    placeActivationAt(h.db, h.state.nowMs - 5 * 60_000);
    insertMention(h.db, 'e');
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 0, 'no probe during the activation grace');
    assert.equal(h.calls.send.length, 1, 'mentions are still answered during the grace');
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active');

    // Once the grace has elapsed the probe runs normally.
    h.state.nowMs += 11 * 60_000; // now 16 min past activation
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1, 'probe runs once the grace has elapsed');
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active', 'first absence only recorded');
  } finally {
    h.store.close();
  }
});

test('self-check: grace window is injectable (0 disables it)', async () => {
  const h = await membershipCheckHarness({ members: [GUEST_GMID], graceMs: 0 });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs); // just activated on the daemon's clock
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1, 'grace 0: the probe runs immediately');
  } finally {
    h.store.close();
  }
});

test('self-check: a single absence never marks left; two consecutive absences do', async () => {
  const h = await membershipCheckHarness({ members: ['gmid-someone-else'], intervalMs: 60_000 });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs - 20 * 60_000);
    insertMention(h.db, 'b');
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1);
    assert.equal(
      h.membershipStore.getMembership(GROUP_ID, 7).status, 'active',
      'one absence read can be indexer lag — membership untouched',
    );
    assert.equal(h.calls.send.length, 1, 'consumption continues until the absence is confirmed');

    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 2);
    assert.equal(
      h.membershipStore.getMembership(GROUP_ID, 7).status, 'left',
      'the second consecutive absence confirms the kick',
    );

    // Later mentions are not consumed at all (active-membership list no longer includes it).
    insertMention(h.db, 'c');
    await h.loop.runTick();
    assert.equal(h.calls.send.length, 1);
    assert.equal(h.calls.chat.length, 1);
  } finally {
    h.store.close();
  }
});

test('self-check: the absence streak resets when the bot reappears on the member list', async () => {
  const h = await membershipCheckHarness({ members: ['gmid-someone-else'], intervalMs: 60_000 });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs - 20 * 60_000);
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1, 'absence 1 recorded');

    // The next probe sees the bot again (the earlier miss was indexer lag).
    h.state.members = [GUEST_GMID];
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 2);
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active');

    // A later absence starts the streak from zero — it must NOT mark left on
    // the first miss (which it would if the earlier absence had stuck).
    h.state.members = ['gmid-someone-else'];
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 3);
    assert.equal(
      h.membershipStore.getMembership(GROUP_ID, 7).status, 'active',
      'streak reset: a fresh single absence does not mark left',
    );
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'left', 'confirmed streak marks left');
  } finally {
    h.store.close();
  }
});

test('self-check: indexer failure silently skips the round (membership untouched)', async () => {
  for (const failure of [{ members: null }, { fetchThrows: true }]) {
    const h = await membershipCheckHarness(failure);
    try {
      joinAsGuest(h.membershipStore);
      placeActivationAt(h.db, h.state.nowMs - 20 * 60_000);
      insertMention(h.db, 'd');
      await h.loop.runTick();
      assert.equal(h.membershipStore.getMembership(GROUP_ID, 7).status, 'active', 'failed check never marks left');
      assert.equal(h.calls.send.length, 1, 'messages still consumed');
    } finally {
      h.store.close();
    }
  }
});

test('self-check: throttled per membership interval', async () => {
  const h = await membershipCheckHarness({ members: [GUEST_GMID], intervalMs: 60_000 });
  try {
    joinAsGuest(h.membershipStore);
    placeActivationAt(h.db, h.state.nowMs - 20 * 60_000);
    await h.loop.runTick();
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 1, 'second tick inside the interval skips the probe');
    h.state.nowMs += 61_000;
    await h.loop.runTick();
    assert.equal(h.fetchMembersCalls.length, 2, 'probe re-runs once the interval elapsed');
  } finally {
    h.store.close();
  }
});

// ---------------------------------------------------------------------------
// Host-task status sync (chair [STATUS:...] transcript tags)
// ---------------------------------------------------------------------------

const CHAIR_GMID = 'gmid-inviter';

const insertChairStatusMessage = (db, pinChar, content) => {
  insertGroupMessage(db, {
    pinId: `${pinChar.repeat(64)}i0`,
    senderMetaId: 'metaid-chair',
    senderGlobalMetaId: CHAIR_GMID,
    senderName: 'Chair Bot',
    content,
  });
};

test('status sync: a chair [STATUS:REVIEW] tag updates the membership; non-chair tags are ignored', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    joinAsGuest(membershipStore);

    // A worker-quoted tag must NOT set the host-task status.
    insertGroupMessage(db, {
      pinId: `${'a'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: 'sure, posting [STATUS:REVIEW] now',
    });
    await loop.runTick();
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).taskStatus, null, 'non-chair tag ignored');

    insertChairStatusMessage(db, 'b', 'All delivered. [STATUS:REVIEW]');
    await loop.runTick();
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).taskStatus, 'review', 'chair tag persisted');
    assert.equal(calls.chat.length, 0, 'status tags never trigger a reply');
    assert.equal(calls.send.length, 0);
  } finally {
    store.close();
  }
});

test('status sync: a terminal chair tag silences the guest while the cursor keeps advancing', async () => {
  const { store, db, membershipStore, loop, calls } = await createHarness();
  try {
    joinAsGuest(membershipStore);

    // The task closes, then someone still @-mentions the guest afterwards.
    insertChairStatusMessage(db, 'a', '[STATUS:DONE] Task closed: accepted by the owner.');
    insertMention(db, 'b');
    await loop.runTick();

    const membership = membershipStore.getMembership(GROUP_ID, 7);
    assert.equal(membership.taskStatus, 'done');
    assert.equal(calls.chat.length, 0, 'no reply generation after the terminal tag');
    assert.equal(calls.send.length, 0);
    assert.equal(
      membership.lastProcessedMsgId,
      messageIdOf(db, `${'b'.repeat(64)}i0`),
      'the cursor still consumes the transcript',
    );

    // Mentions keep being ignored on later ticks too.
    insertMention(db, 'c');
    await loop.runTick();
    assert.equal(calls.chat.length, 0);
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).lastProcessedMsgId,
      messageIdOf(db, `${'c'.repeat(64)}i0`),
    );
  } finally {
    store.close();
  }
});

test('status sync: daemon start backfills legacy memberships from the transcript', async () => {
  const { store, db, membershipStore, loop } = await createHarness();
  try {
    // Legacy join: the chair's review tag predates the guest cursor (as after
    // catchUpCursorToLatest), so the live parse path never sees it.
    insertChairStatusMessage(db, 'a', 'All delivered. [STATUS:REVIEW]');
    joinAsGuest(membershipStore);
    membershipStore.catchUpCursorToLatest(GROUP_ID, 7);

    await loop.runTick();
    assert.equal(membershipStore.getMembership(GROUP_ID, 7).taskStatus, null, 'pre-cursor tag is not live-parsed');

    loop.start();
    loop.stop();
    assert.equal(
      membershipStore.getMembership(GROUP_ID, 7).taskStatus,
      'review',
      'start() re-derives the status from the already-indexed transcript',
    );
    // Let the tick that start() fired settle before the store closes.
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    store.close();
  }
});

test('fix-v2 P1-5: a corrupt guest session log rebuilds the session; the next mention runs on the fresh one', async () => {
  const logs = [];
  const skillTurnSessionIds = [];
  let firstCall = true;
  const harness = await createHarness({
    allowChatSkills: ['skill-doc'],
    deps: ({ coworkStore }) => ({
      getCoworkStore: () => coworkStore,
      getChatSkillsRoutingPrompt: async () => ({ prompt: 'SKILL ROUTING PROMPT', activeSkillIds: ['skill-doc'] }),
      runSkillTurn: async (params) => {
        skillTurnSessionIds.push(params.sessionId);
        if (firstCall) {
          firstCall = false;
          throw new Error('corrupt session log: seq gap in committed region at line 42 (expected 100, got 98)');
        }
        return { replyText: 'recovered skill reply', assistantMessageId: 'asst-recovered', cwd: makeTempDir() };
      },
      emitLog: (line) => logs.push(String(line)),
    }),
  });
  const { store, db, membershipStore, coworkStore, loop, calls } = harness;
  try {
    joinAndMention(db, membershipStore, `${'b'.repeat(64)}i0`);

    // Tick 1: the skill turn dies on the corrupt log. The mention is still
    // answered (plain-completion fallback — the guest is never silenced), and
    // the host rebuilds the guest session so the NEXT skill turn works.
    await loop.runTick();
    assert.equal(skillTurnSessionIds.length, 1, 'one skill turn attempted');
    assert.equal(calls.send.length, 1, 'the mention is answered via the fallback, not dropped');
    assert.equal(calls.send[0][2].content, 'On it — results soon.', 'fallback reply went on-chain');
    const mapping = coworkStore.getConversationMapping('openteam_guest', `openteam-guest:${GROUP_ID}`, 7);
    assert.ok(mapping, 'mapping exists');
    assert.notEqual(mapping.coworkSessionId, skillTurnSessionIds[0], 'mapping repointed to a fresh session');
    const rebuilt = coworkStore.getSession(mapping.coworkSessionId);
    assert.match(rebuilt.title, /\[rebuilt\]/, 'the rebuilt session is marked');
    assert.ok(
      logs.some((line) => /corrupt session log/.test(line) && /guest session rebuilt/.test(line)),
      'the rebuild is announced immediately in the log',
    );
    assert.ok(
      logs.some(
        (line) => /guest session rebuilt/.test(line) && /expected 100, got 98/.test(line),
      ),
      'the rebuild alert quotes the corruption signature (gap position + expected/got)',
    );

    // Tick 2: a new mention runs its skill turn on the rebuilt session.
    insertGroupMessage(db, {
      pinId: `${'d'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot one more thing',
    });
    await loop.runTick();
    assert.equal(skillTurnSessionIds.length, 2, 'the next mention runs a skill turn again');
    assert.equal(skillTurnSessionIds[1], mapping.coworkSessionId, 'the skill turn ran on the rebuilt session');
    assert.equal(calls.send.length, 2);
    assert.equal(calls.send[1][2].content, 'recovered skill reply', 'skill-path delivery works post-rebuild');
  } finally {
    store.close();
  }
});

test('fix-v2 P1-5: a corrupt-log recurrence within the rebuild cooldown logs self-heal guidance once', async () => {
  const logs = [];
  const harness = await createHarness({
    allowChatSkills: ['skill-doc'],
    deps: ({ coworkStore }) => ({
      getCoworkStore: () => coworkStore,
      getChatSkillsRoutingPrompt: async () => ({ prompt: 'SKILL ROUTING PROMPT', activeSkillIds: ['skill-doc'] }),
      // Every skill turn fails corrupt — even on the rebuilt session (the
      // dual writer is still live). The append-side signature (not the
      // 'corrupt session log' prefix) exercises the broadened detector.
      runSkillTurn: async () => {
        throw new Error('append seq mismatch for "cw-x": expected 5 at index 0, got 3');
      },
      emitLog: (line) => logs.push(String(line)),
    }),
  });
  const { store, db, membershipStore, loop, calls } = harness;
  try {
    joinAndMention(db, membershipStore, `${'c'.repeat(64)}i0`);
    // Tick 1: the append-side mismatch signature triggers the rebuild too.
    await loop.runTick();
    assert.ok(
      logs.some((line) => /guest session rebuilt/.test(line)),
      'the append-side mismatch signature also triggers the rebuild',
    );
    assert.ok(
      logs.some((line) => /guest session rebuilt/.test(line) && /expected 5 at index 0, got 3/.test(line)),
      'the rebuild alert quotes the append-side expected/got signature',
    );
    // Tick 2: a new mention hits corruption on the rebuilt session — the
    // recurrence is rate-capped, so it logs self-heal guidance (once) and
    // still answers via the fallback.
    insertGroupMessage(db, {
      pinId: `${'e'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot second mention',
    });
    await loop.runTick();
    const guidance = logs.filter((line) => /Self-heal guidance: restart the app/.test(line));
    assert.equal(guidance.length, 1, 'self-heal guidance logged exactly once (hourly throttle)');
    assert.match(guidance[0], /expected 5 at index 0, got 3/, 'the escalation alert quotes the corruption signature');
    assert.equal(calls.send.length, 2, 'both mentions answered via the fallback — never silenced');
    assert.ok(
      !logs.some((line) => /giving up on it/.test(line)),
      'the mention-dropping ladder never engages for corrupt-log failures',
    );
    // Tick 3: guidance stays throttled within the hour.
    insertGroupMessage(db, {
      pinId: `${'f'.repeat(64)}i0`,
      senderMetaId: 'metaid-other',
      senderGlobalMetaId: OTHER_GMID,
      senderName: 'Other Bot',
      content: '@Guest Bot third mention',
    });
    await loop.runTick();
    assert.equal(
      logs.filter((line) => /Self-heal guidance: restart the app/.test(line)).length,
      1,
      'guidance does not repeat within the cooldown',
    );
  } finally {
    store.close();
  }
});
