import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildGroupChatAgentTools } = require('../dist-electron/main/libs/groupChatAgentTools.js');

const SESSION_ID = 'sess-group-1';
const METABOT_ID = 7;
const NAMED_METABOT_ID = 9;
// On-chain group ids are pin ids (64 lowercase hex + 'i0') — the tool validates
// the shape, so every fixture uses a well-formed one.
const GROUP_ID = `${'ab'.repeat(32)}i0`;

function makeHarness(overrides = {}) {
  const calls = { resolveByName: [], displayName: [], assign: [], join: [], send: [], resolve: [] };
  const control = {
    resolveMetabotIdByName: (name) => {
      calls.resolveByName.push(name);
      if ('resolveByNameResult' in overrides) return overrides.resolveByNameResult;
      return name === 'helper' ? NAMED_METABOT_ID : null;
    },
    getMetabotDisplayName: (metabotId) => {
      calls.displayName.push(metabotId);
      if ('displayName' in overrides) return overrides.displayName;
      return metabotId === METABOT_ID ? 'Session Bot' : 'Helper Bot';
    },
    assignTask: (params) => {
      calls.assign.push(params);
      if (overrides.assignError) throw overrides.assignError;
      return overrides.assignResult ?? { success: true, message: 'Success! Task assigned.' };
    },
    joinGroup: async (input) => {
      calls.join.push(input);
      if (overrides.joinError) throw overrides.joinError;
      return overrides.joinResult ?? { txids: ['tx-j'], pinId: 'joinPin1i0' };
    },
    sendGroupMessage: async (input) => {
      calls.send.push(input);
      if (overrides.sendError) throw overrides.sendError;
      return overrides.sendResult ?? { txids: ['tx-s'], pinId: 'msgPin1i0' };
    },
    // Task #65: absent by default (a non-task session); tests pass
    // `taskGroupId` to simulate a group-task session binding.
    ...(overrides.taskGroupId !== undefined
      ? { resolveSessionTaskGroupId: () => overrides.taskGroupId }
      : {}),
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined); only fall
    // back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildGroupChatAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single group_chat tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.group_chat);
  assert.equal(Object.keys(byName).length, 1);
});

test('orchestrate maps params onto AssignGroupChatTaskParams with skill defaults', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'orchestrate',
    group_id: GROUP_ID,
    target_metabot_name: 'helper',
    discussion_background: '  roadmap talk  ',
    original_prompt: '派 helper 去群里聊天',
  });
  assert.deepEqual(calls.resolveByName, ['helper']);
  assert.equal(calls.assign.length, 1);
  assert.deepEqual(calls.assign[0], {
    target_metabot_name: 'helper',
    group_id: GROUP_ID,
    reply_on_mention: true,
    random_reply_probability: 0.1,
    cooldown_seconds: 15,
    context_message_count: 30,
    discussion_background: 'roadmap talk',
    participation_goal: undefined,
    supervisor_globalmetaid: undefined,
    original_prompt: '派 helper 去群里聊天',
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Success! Task assigned\./);
});

test('orchestrate honors explicit overrides', async () => {
  const { calls, byName } = makeHarness();
  await byName.group_chat.handler({
    action: 'orchestrate',
    group_id: GROUP_ID,
    reply_on_mention: false,
    random_reply_probability: 0.5,
    cooldown_seconds: 60,
    context_message_count: 100,
  });
  assert.equal(calls.assign[0].reply_on_mention, false);
  assert.equal(calls.assign[0].random_reply_probability, 0.5);
  assert.equal(calls.assign[0].cooldown_seconds, 60);
  assert.equal(calls.assign[0].context_message_count, 100);
});

test('orchestrate without target_metabot_name uses the session MetaBot display name', async () => {
  const { calls, byName } = makeHarness();
  await byName.group_chat.handler({ action: 'orchestrate', group_id: GROUP_ID });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.deepEqual(calls.resolveByName, []);
  assert.equal(calls.assign[0].target_metabot_name, 'Session Bot');
});

test('orchestrate surfaces an unsuccessful assignTask result as an error', async () => {
  const { byName } = makeHarness({
    assignResult: { success: false, message: '', error: 'MetaBot not found' },
  });
  const result = await byName.group_chat.handler({ action: 'orchestrate', group_id: GROUP_ID });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /MetaBot not found/);
});

test('orchestrate surfaces an assignTask throw as an error result', async () => {
  const { byName } = makeHarness({ assignError: new Error('db locked') });
  const result = await byName.group_chat.handler({ action: 'orchestrate', group_id: GROUP_ID });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /orchestrate failed: db locked/);
});

test('errors with `Unknown MetaBot name` when the name does not resolve', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'join_group',
    group_id: GROUP_ID,
    target_metabot_name: 'ghost',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Unknown MetaBot name: ghost/);
  assert.equal(calls.assign.length, 0);
  assert.equal(calls.join.length, 0);
  assert.equal(calls.send.length, 0);
});

test('errors when no MetaBot owns the session and no name is given', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.group_chat.handler({ action: 'join_group', group_id: GROUP_ID });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /could not determine which MetaBot owns this session/);
  assert.equal(calls.join.length, 0);
});

test('rejects an empty group_id before any resolution', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({ action: 'orchestrate', group_id: '  ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `group_id`/);
  assert.equal(calls.resolve.length, 0);
  assert.equal(calls.resolveByName.length, 0);
  assert.equal(calls.assign.length, 0);
});

test('join_group forwards referrer/k/network and returns pinId/txids', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'join_group',
    group_id: GROUP_ID,
    target_metabot_name: 'helper',
    referrer: 'inviterMetaId',
    k: 'private-key-field',
    network: 'doge',
  });
  assert.equal(calls.join.length, 1);
  assert.deepEqual(calls.join[0], {
    metabotId: NAMED_METABOT_ID,
    groupId: GROUP_ID,
    referrer: 'inviterMetaId',
    k: 'private-key-field',
    network: 'doge',
  });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /SimpleGroupJoin/);
  assert.match(text, /pinId: joinPin1i0/);
  assert.match(text, /txids: tx-j/);
  assert.match(text, /pin link: \[pin:\/\/joinPin1i0\]\(pin:\/\/joinPin1i0\)/);
  assert.doesNotMatch(text, /openagentinternet|metaid\.io/);
});

test('join_group defaults network to mvc and omits empty referrer/k', async () => {
  const { calls, byName } = makeHarness();
  await byName.group_chat.handler({ action: 'join_group', group_id: GROUP_ID });
  assert.equal(calls.join[0].metabotId, METABOT_ID);
  assert.equal(calls.join[0].network, 'mvc');
  assert.equal(calls.join[0].referrer, undefined);
  assert.equal(calls.join[0].k, undefined);
});

test('join_group surfaces control failures as an error result without throwing', async () => {
  const { byName } = makeHarness({ joinError: new Error('insufficient balance') });
  const result = await byName.group_chat.handler({ action: 'join_group', group_id: GROUP_ID });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Join group failed: insufficient balance/);
});

test('send_group_message uses the MetaBot display name as nickName and forwards extras', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: GROUP_ID,
    content: '  hello group  ',
    reply_pin: 'prevPin1i0',
    channel_id: 'chan-1',
    mention: ['idq1a', ' ', 'idq1b'],
  });
  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.send[0], {
    metabotId: METABOT_ID,
    groupId: GROUP_ID,
    content: 'hello group',
    nickName: 'Session Bot',
    replyPin: 'prevPin1i0',
    channelId: 'chan-1',
    mention: ['idq1a', 'idq1b'],
    network: 'mvc',
  });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /SimpleGroupChat/);
  assert.match(text, /pinId: msgPin1i0/);
  assert.match(text, /txids: tx-s/);
});

test('send_group_message ignores a model-supplied nick_name (regression: sender_name "claude bot")', async () => {
  const { calls, byName } = makeHarness();
  await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: GROUP_ID,
    target_metabot_name: 'helper',
    content: 'hi',
    // The nick_name param no longer exists in the tool schema; even if a raw
    // caller still passes it, the registered MetaBot name must win.
    nick_name: 'claude bot',
  });
  assert.equal(calls.send[0].metabotId, NAMED_METABOT_ID);
  assert.equal(calls.send[0].nickName, 'Helper Bot');
});

test('send_group_message rejects an empty content', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: GROUP_ID,
    content: '   ',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `content`/);
  assert.equal(calls.send.length, 0);
});

test('send_group_message surfaces control failures as an error result without throwing', async () => {
  const { byName } = makeHarness({ sendError: new Error('create-pin failed: HTTP 500') });
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: GROUP_ID,
    content: 'hi',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Send group message failed: create-pin failed: HTTP 500/);
});

// ---------------------------------------------------------------------------
// Task #65: group_id shape validation + group-task session routing
// ---------------------------------------------------------------------------

test('rejects a non-pinid group_id (the task number is not a group id) before any send', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: '65',
    content: 'delivery receipt',
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Invalid group_id "65"/);
  assert.match(result.content[0].text, /64 lowercase hex chars/);
  assert.equal(calls.send.length, 0, 'nothing is delivered to a phantom group');
});

test('group-task sessions route sends to the bound task group regardless of the passed id', async () => {
  const taskGroup = `${'cd'.repeat(32)}i0`;
  const { calls, byName } = makeHarness({ taskGroupId: taskGroup });
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: '65',
    content: '[DELIVERABLE] metafile://aa',
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.send.length, 1);
  assert.equal(calls.send[0].groupId, taskGroup, 'delivered to the real task group');
  assert.match(result.content[0].text, /routed to this session's task group/);
  assert.match(result.content[0].text, /"65"/);
});

test('group-task sessions send straight through when the correct group id is passed', async () => {
  const taskGroup = `${'ef'.repeat(32)}i0`;
  const { calls, byName } = makeHarness({ taskGroupId: taskGroup });
  const result = await byName.group_chat.handler({
    action: 'send_group_message',
    group_id: taskGroup,
    content: 'progress line',
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.send[0].groupId, taskGroup);
  assert.doesNotMatch(result.content[0].text, /routed to this session's task group/);
});
