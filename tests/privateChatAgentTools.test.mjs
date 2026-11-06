import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildPrivateChatAgentTools } = require('../dist-electron/main/libs/privateChatAgentTools.js');

const SESSION_ID = 'sess-private-1';
const METABOT_ID = 7;

const SAMPLE_RESULT = {
  txids: ['tx-1', 'tx-2'],
  pinId: 'abc123i0',
};

function makeHarness(overrides = {}) {
  const calls = { send: [], resolve: [] };
  const control = {
    send: async (input) => {
      calls.send.push(input);
      if (overrides.sendError) throw overrides.sendError;
      return overrides.sendResult ?? SAMPLE_RESULT;
    },
  };
  const resolveMetabotId = (sessionId) => {
    calls.resolve.push(sessionId);
    // Honor an explicit `metabotId` override (including undefined); only fall
    // back to the default when the harness did not specify one.
    return 'metabotId' in overrides ? overrides.metabotId : METABOT_ID;
  };
  const tools = buildPrivateChatAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
    sessionId: SESSION_ID,
    resolveMetabotId,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single send_private_chat tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.send_private_chat);
  assert.equal(Object.keys(byName).length, 1);
});

test('resolves the session metabotId and forwards to/content/replyPin to control.send', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({
    to: '  idq1target  ',
    content: '  hello there  ',
    reply_pin: '  prevPin1i0  ',
  });
  assert.deepEqual(calls.resolve, [SESSION_ID]);
  assert.equal(calls.send.length, 1);
  assert.deepEqual(calls.send[0], {
    metabotId: METABOT_ID,
    toGlobalMetaId: 'idq1target',
    content: 'hello there',
    replyPin: 'prevPin1i0',
  });
  const text = result.content[0].text;
  assert.equal(result.isError, undefined);
  assert.match(text, /Private message sent\./);
  assert.match(text, /pinId: abc123i0/);
  assert.match(text, /txids: tx-1, tx-2/);
  assert.match(text, /pin link: \[pin:\/\/abc123i0\]\(pin:\/\/abc123i0\)/);
  assert.doesNotMatch(text, /openagentinternet|metaid\.io/);
});

test('omits replyPin when reply_pin is not provided', async () => {
  const { calls, byName } = makeHarness();
  await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(calls.send[0].replyPin, undefined);
});

test('rejects an empty `to` before resolving the metabotId', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({ to: '   ', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `to`/);
  assert.equal(calls.send.length, 0);
  assert.equal(calls.resolve.length, 0);
});

test('rejects an empty `content` without reaching control.send', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: '  ' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires `content`/);
  assert.equal(calls.send.length, 0);
});

test('errors gracefully when no MetaBot owns the session', async () => {
  const { calls, byName } = makeHarness({ metabotId: undefined });
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /which MetaBot owns this session/);
  assert.equal(calls.send.length, 0);
});

test('surfaces control.send failures as an error result without throwing', async () => {
  const { byName } = makeHarness({
    sendError: new Error('target has no chatPublicKey on chain (/info/chatpubkey missing)'),
  });
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Private message send failed: target has no chatPublicKey on chain/);
});

test('private chat success receipt surfaces the fee channel when the write ran sponsored', async () => {
  const { byName } = makeHarness({
    sendResult: {
      txids: ['tx-p'], pinId: 'privPin1i0', totalCost: 300,
      feeAssist: { attempted: true, used: false, mode: 'self_paid', reason: 'circuit_open', stage: 'address_info' },
    },
  });
  const result = await byName.send_private_chat.handler({ to: 'idq1target', content: 'hi' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Private message sent\./);
  assert.match(result.content[0].text, /sponsor: skipped — circuit breaker open after repeated broadcast failures, paid by the bot's own wallet/);
  assert.match(result.content[0].text, /WARN sponsor_fallback: true \(reason=circuit_open stage=address_info\)/);
});


const {
  buildPrivateChatApprovalAgentTools,
  isOrdinaryPrivateChatApprovalSession,
} = require('../dist-electron/main/libs/privateChatAgentTools.js');

function makeApprovalHarness(outcome = 'approved', allowed = true) {
  const calls = [];
  const tools = buildPrivateChatApprovalAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control: {
      isAllowed: () => allowed,
      request: async (input) => {
        calls.push(input);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  });
  return { calls, tool: tools[0] };
}

test('owner approval tool mounts only in ordinary private chats, never order execution', () => {
  const ordinary = {
    sessionType: 'a2a',
    sourceChannel: 'metaweb_private',
    hiddenFromSessionList: false,
    memoryReadOnly: false,
  };
  assert.equal(isOrdinaryPrivateChatApprovalSession(ordinary), true);
  assert.equal(isOrdinaryPrivateChatApprovalSession({ ...ordinary, sessionType: 'standard' }), false);
  assert.equal(isOrdinaryPrivateChatApprovalSession({ ...ordinary, sourceChannel: 'metaweb_order' }), false);
  assert.equal(isOrdinaryPrivateChatApprovalSession({ ...ordinary, hiddenFromSessionList: true }), false);
  assert.equal(isOrdinaryPrivateChatApprovalSession({ ...ordinary, memoryReadOnly: true }), false);
});

test('request_user_permission forwards the concrete request and returns an explicit one-shot approval', async () => {
  const { calls, tool } = makeApprovalHarness('approved');
  assert.equal(tool.name, 'request_user_permission');
  const result = await tool.handler({
    title: '  Transfer 10 SPACE to Peer Bot  ',
    description: '  Send exactly 10 SPACE to idq1peer; the transaction is public and irreversible.  ',
    category: 'payment',
  });
  assert.deepEqual(calls, [{
    title: 'Transfer 10 SPACE to Peer Bot',
    description: 'Send exactly 10 SPACE to idq1peer; the transaction is public and irreversible.',
    category: 'payment',
  }]);
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /OWNER_APPROVED/);
  assert.match(result.content[0].text, /exactly the described action/);
  assert.match(result.content[0].text, /once/);
});

test('request_user_permission returns denial as a clear tool result, not as approval or a transport error', async () => {
  const { tool } = makeApprovalHarness('denied');
  const result = await tool.handler({
    title: 'Publish a 200 MB file',
    description: 'Upload the agreed archive publicly on-chain and pay the fee.',
    category: 'file_upload',
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /OWNER_DENIED/);
  assert.match(result.content[0].text, /Do NOT perform/);
  assert.doesNotMatch(result.content[0].text, /OWNER_APPROVED/);
});

test('request_user_permission is fail-closed in skill-service execution and on bridge errors', async () => {
  const unavailable = makeApprovalHarness('approved', false);
  const blocked = await unavailable.tool.handler({ title: 'Transfer', description: 'Send funds.' });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /OWNER_APPROVAL_UNAVAILABLE/);
  assert.equal(unavailable.calls.length, 0);

  const failing = makeApprovalHarness(new Error('renderer disconnected'));
  const failed = await failing.tool.handler({ title: 'Transfer', description: 'Send funds.' });
  assert.equal(failed.isError, true);
  assert.match(failed.content[0].text, /OWNER_APPROVAL_ERROR/);
  assert.match(failed.content[0].text, /No action was authorized/);
});

test('request_user_permission rejects incomplete requests before opening an owner card', async () => {
  const { calls, tool } = makeApprovalHarness();
  const missingTitle = await tool.handler({ title: ' ', description: 'Send funds.' });
  const missingDescription = await tool.handler({ title: 'Transfer', description: ' ' });
  assert.equal(missingTitle.isError, true);
  assert.equal(missingDescription.isError, true);
  assert.equal(calls.length, 0);
});
