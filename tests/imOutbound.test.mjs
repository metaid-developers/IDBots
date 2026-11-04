/**
 * Desktop-initiated IM outbound (im_send_message) — the pure send path plus the
 * cowork_ui capability manifest.
 *
 * Run: npm run test:im-gateway (this file is compiled from src/main first).
 *
 * Rules pinned here (owner ruling 2026-11-04):
 *  1. capability follows CONNECTION, not an "owner id" binding;
 *  2. the destination is the most recent DIRECT conversation on that channel,
 *     resolved from the persisted mapping table (validated `im:<p>:direct`) or
 *     the gateway's last-inbound memory — group chats are never eligible;
 *  3. no direct conversation yet → "先给它发一条消息即可", never a silent drop;
 *  4. a disconnected channel reports 未连接;
 *  5. any other target id is refused before a byte goes out;
 *  6. the cowork_ui block lists connected channels with their type/size tables,
 *     names unconnected ones as 未连接, and says "use the tool, don't drive the
 *     client window".
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  sendImOutboundMessage,
  describeImOutboundChannel,
  normalizeImOutboundChannel,
  formatImOutboundSendResult,
  buildImOutboundConversationRecord,
  outboundSendResultFromError,
  IM_OUTBOUND_RECORD_PREVIEW_CHARS,
  NO_DIRECT_CONVERSATION_REASON,
} = await import('../dist-electron/main/im/imOutbound.js');
const { buildChannelCapabilitiesBlock } = await import('../dist-electron/main/libs/experiencePromptBlocks.js');

const MB = 1024 * 1024;

function makeCapabilities(overrides = {}) {
  return {
    extensionsByKind: {
      image: ['png', 'jpg', 'jpeg'],
      video: ['mp4'],
      audio: ['mp3'],
      file: ['pdf', 'zip'],
      ...(overrides.extensionsByKind ?? {}),
    },
    maxBytesByKind: {
      image: 100 * MB,
      video: 100 * MB,
      audio: 100 * MB,
      file: 100 * MB,
      ...(overrides.maxBytesByKind ?? {}),
    },
  };
}

function makeTransport(overrides = {}) {
  const calls = { texts: [], media: [] };
  const sender = {
    sendToConversation: async (conversationId, text) => {
      calls.texts.push({ conversationId, text });
    },
    sendMediaToConversation: async (conversationId, filePath) => {
      calls.media.push({ conversationId, filePath });
    },
  };
  const platform = overrides.platform ?? 'weixin';
  const transport = {
    platform,
    label: '微信',
    connected: true,
    conversationId: 'wx-direct-1',
    // Mirrors the gateways: only weixin/QQ bind the destination to a verified
    // owner identity. Everything else is the most recent direct chat.
    ownerIdentityBound: platform === 'weixin' || platform === 'qq',
    capabilities: makeCapabilities(),
    sender,
    ...overrides,
  };
  return { transport, calls };
}

function makeTempFile(name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-im-outbound-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

function makeChannelView(overrides = {}) {
  return {
    platform: 'weixin',
    label: '微信',
    connected: true,
    sendable: true,
    reason: null,
    conversationId: 'wx-direct-1',
    targetIdentityBasis: 'owner-binding',
    capabilities: makeCapabilities(),
    ...overrides,
  };
}

test('sends text and an attachment through the resolved direct conversation', async () => {
  const { transport, calls } = makeTransport();
  const image = makeTempFile('shot.png', 2048);
  const result = await sendImOutboundMessage(transport, {
    channel: 'weixin',
    text: '编排已回执',
    attachments: [image],
  });

  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.channel, 'weixin');
  assert.equal(result.target, 'wx-direct-1');
  assert.equal(result.targetIsOwnerDirect, true);
  assert.equal(result.targetIdentityBasis, 'owner-binding', 'weixin binds the destination to the QR owner');
  assert.equal(result.textChars, '编排已回执'.length);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].kind, 'image');
  assert.deepEqual(calls.texts, [{ conversationId: 'wx-direct-1', text: '编排已回执' }]);
  assert.deepEqual(calls.media, [{ conversationId: 'wx-direct-1', filePath: image }]);

  const rendered = formatImOutboundSendResult(result);
  assert.match(rendered, /im_send_message 成功/);
  assert.match(rendered, /微信/);
  assert.match(rendered, /附件：1 个/);
});

test('destination basis: owner-bound stays "owner 私聊", unbound says 未经身份校验', async () => {
  // Owner-bound channel (weixin): the destination is the QR-verified owner, so
  // every model-facing sentence may keep saying "owner 私聊".
  const bound = await sendImOutboundMessage(makeTransport().transport, {
    channel: 'weixin',
    text: '给主人的消息',
  });
  assert.equal(bound.targetIdentityBasis, 'owner-binding');
  assert.match(formatImOutboundSendResult(bound), /→ owner 私聊/);
  assert.doesNotMatch(formatImOutboundSendResult(bound), /未经身份校验/);

  // No owner binding (telegram): the id is merely the last direct chat, so the
  // result must NOT call it the owner — in the tool text, or in the failure
  // card filed into that conversation.
  const { transport } = makeTransport({
    platform: 'telegram',
    label: 'Telegram',
    conversationId: 'tg-direct-9',
    sender: {
      sendToConversation: async () => { throw new Error('bot was blocked by the user'); },
    },
  });
  const result = await sendImOutboundMessage(transport, { channel: 'telegram', text: '外部通道' });
  assert.equal(result.ok, false);
  assert.equal(result.targetIdentityBasis, 'last-direct');
  const rendered = formatImOutboundSendResult(result);
  assert.match(rendered, /未经身份校验/);
  assert.doesNotMatch(rendered, /owner 私聊/);

  const card = buildImOutboundConversationRecord({
    request: { channel: 'telegram', text: '外部通道' },
    result,
    timestamp: 1_800_000_000_000,
  });
  assert.match(card.content, /目标：最近一次私聊会话（未经身份校验，tg-direct-9）/);
  assert.doesNotMatch(card.content, /owner 私聊/);
});

test('cowork_ui capability block discloses unverified destinations per channel', () => {
  const block = buildChannelCapabilitiesBlock('cowork_ui', {
    connectedChannels: [
      makeChannelView(), // weixin — owner-bound
      makeChannelView({
        platform: 'telegram',
        label: 'Telegram',
        conversationId: 'tg-direct-9',
        targetIdentityBasis: 'last-direct',
      }),
    ],
  });
  assert.match(block, /微信（weixin）：已连接，可主动发送到 owner 私聊/);
  assert.match(block, /Telegram（telegram）：已连接，可主动发送到该通道最近一次私聊会话（未经身份校验/);
});

test('allows an attachment-only send (empty text)', async () => {
  const { transport, calls } = makeTransport();
  const file = makeTempFile('report.pdf', 16);
  const result = await sendImOutboundMessage(transport, {
    channel: 'weixin',
    text: '   ',
    attachments: [file],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(result.textChars, 0);
  assert.equal(calls.texts.length, 0);
  assert.equal(calls.media.length, 1);
  assert.equal(result.attachments[0].kind, 'file');
});

test('a disconnected channel fails explicitly and sends nothing', async () => {
  const { transport, calls } = makeTransport({ connected: false });
  const result = await sendImOutboundMessage(transport, { channel: 'weixin', text: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /未连接/);
  assert.equal(calls.texts.length, 0);
  assert.equal(calls.media.length, 0);
  const rendered = formatImOutboundSendResult(result);
  assert.match(rendered, /im_send_message 失败/);
  assert.doesNotMatch(rendered, /成功/);
});

test('a connected channel with no direct conversation says to send one first', async () => {
  const { transport, calls } = makeTransport({ conversationId: null });
  const result = await sendImOutboundMessage(transport, { channel: 'weixin', text: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /尚无与你的私聊会话/);
  assert.match(result.errors.join('\n'), /先给它发一条消息即可/);
  assert.equal(calls.texts.length, 0);
  assert.equal(calls.media.length, 0);
});

test('a non-matching target is refused before any outbound call', async () => {
  const { transport, calls } = makeTransport();
  const result = await sendImOutboundMessage(transport, {
    channel: 'weixin',
    target: 'some-other-conversation',
    text: 'should not go out',
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /只允许发往该通道上最近一次与你的私聊会话/);
  assert.match(result.errors.join('\n'), /some-other-conversation/);
  assert.equal(calls.texts.length, 0);
  assert.equal(calls.media.length, 0);
});

test('an explicit target equal to the resolved direct conversation is accepted', async () => {
  const { transport, calls } = makeTransport();
  const result = await sendImOutboundMessage(transport, {
    channel: 'weixin',
    target: 'wx-direct-1',
    text: 'hello',
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
  assert.equal(calls.texts.length, 1);
});

test('a gateway without conversation sending reports why instead of no-oping', async () => {
  const { transport } = makeTransport({
    platform: 'dingtalk',
    label: '钉钉',
    sender: null,
    unavailableReason: '平台出站绑定入站句柄',
  });
  const result = await sendImOutboundMessage(transport, { channel: 'dingtalk', text: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /无法按会话发送/);
  assert.match(result.errors.join('\n'), /平台出站绑定入站句柄/);
});

test('an unknown channel gets an explicit refusal, not a silent drop', async () => {
  const result = await sendImOutboundMessage(null, { channel: 'whatsapp', text: 'hi' });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /未知通道/);
});

test('over-limit and missing attachments are rejected with the exact reason', async () => {
  const { transport, calls } = makeTransport({
    capabilities: makeCapabilities({ maxBytesByKind: { image: 1024, video: 1024, audio: 1024, file: 1024 } }),
  });
  const big = makeTempFile('big.png', 4096);
  const result = await sendImOutboundMessage(transport, {
    channel: 'weixin',
    text: '',
    attachments: [big, '/definitely/not/here.png'],
  });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /超过微信 image 上限/);
  assert.match(result.errors.join('\n'), /附件不存在/);
  assert.equal(calls.media.length, 0);
});

test('channel aliases and IM markers normalize to the platform key', () => {
  assert.equal(normalizeImOutboundChannel('im:weixin:direct'), 'weixin');
  assert.equal(normalizeImOutboundChannel('WeChat'), 'weixin');
  assert.equal(normalizeImOutboundChannel('lark'), 'feishu');
  assert.equal(normalizeImOutboundChannel(' QQ '), 'qq');
  assert.equal(normalizeImOutboundChannel(''), '');
});

test('describeImOutboundChannel follows connection + direct-conversation facts', () => {
  const { transport } = makeTransport();
  assert.equal(describeImOutboundChannel(transport).sendable, true);

  const noConversation = describeImOutboundChannel(makeTransport({ conversationId: null }).transport);
  assert.equal(noConversation.sendable, false);
  assert.equal(noConversation.reason, NO_DIRECT_CONVERSATION_REASON);

  const offline = describeImOutboundChannel(makeTransport({ connected: false }).transport);
  assert.equal(offline.sendable, false);
  assert.equal(offline.reason, '未连接');

  // Feishu today: connected, has a gateway sender, no direct chat seen yet —
  // not sendable, but for the "send one first" reason, not a hard refusal.
  const feishu = describeImOutboundChannel(makeTransport({
    platform: 'feishu',
    label: '飞书',
    conversationId: null,
  }).transport);
  assert.equal(feishu.sendable, false);
  assert.match(feishu.reason, /先给它发一条消息/);
});

test('cowork_ui capability block lists connected channels with types and limits', () => {
  const block = buildChannelCapabilitiesBlock('cowork_ui', {
    connectedChannels: [
      makeChannelView(),
      makeChannelView({
        platform: 'feishu',
        label: '飞书',
        sendable: false,
        reason: NO_DIRECT_CONVERSATION_REASON,
        conversationId: null,
      }),
      makeChannelView({
        platform: 'qq',
        label: 'QQ',
        connected: false,
        sendable: false,
        reason: '未连接',
        conversationId: null,
      }),
    ],
  });
  assert.match(block, /<channel_capabilities channel="cowork_ui"/);
  assert.match(block, /微信（weixin）：已连接，可主动发送到 owner 私聊/);
  assert.match(block, /图片 \.png \.jpg \.jpeg/);
  assert.match(block, /单文件上限 100 MB/);
  assert.match(block, /im_send_message/);
  assert.match(block, /不要模拟操作微信\/QQ\/飞书客户端窗口/);
  assert.match(block, /只允许发往该通道上最近一次与你的私聊会话/);
  // Connected-but-not-yet-addressable says "send one first", not "unsupported".
  assert.match(block, /飞书（feishu）：已连接，但尚无与你的私聊会话，先给它发一条消息即可/);
  // Unconnected channels are NAMED as 未连接 (owner ruling), not omitted.
  assert.match(block, /未连接：QQ（qq）/);
  assert.doesNotMatch(block, /不支持主动发送/);
  assert.doesNotMatch(block, /当前没有可用通道/);
});

test('cowork_ui capability block says "当前没有可用通道" when none is connected', () => {
  const empty = buildChannelCapabilitiesBlock('cowork_ui', { connectedChannels: [] });
  assert.match(empty, /当前没有可用通道/);
  assert.match(empty, /不要假装已经发出任何内容/);

  const allOffline = buildChannelCapabilitiesBlock('cowork_ui', {
    connectedChannels: [
      makeChannelView({ platform: 'weixin', label: '微信', connected: false, sendable: false, reason: '未连接', conversationId: null }),
      makeChannelView({ platform: 'qq', label: 'QQ', connected: false, sendable: false, reason: '未连接', conversationId: null }),
    ],
  });
  assert.match(allOffline, /当前没有可用通道/);
  assert.match(allOffline, /未连接：微信（weixin）、QQ（qq）/);

  // The default (no inventory passed) must not silently return '' either.
  const defaulted = buildChannelCapabilitiesBlock('cowork_ui');
  assert.match(defaulted, /当前没有可用通道/);
});

test('im: sessions keep their own manifest and do not get the desktop inventory', () => {
  const block = buildChannelCapabilitiesBlock('im:weixin:direct', {
    connectedChannels: [makeChannelView()],
  });
  assert.match(block, /当前是微信私聊通道/);
  assert.doesNotMatch(block, /im_send_message/);
});

test('manager adapter resolves the last DIRECT mapping and skips group chats', async () => {
  const { IMGatewayManager } = await import('../dist-electron/main/im/imGatewayManager.js');
  const manager = Object.create(IMGatewayManager.prototype);
  const calls = [];
  const sender = {
    sendToConversation: async (conversationId, text) => { calls.push({ conversationId, text }); },
    sendMediaToConversation: async (conversationId, filePath) => { calls.push({ conversationId, filePath }); },
  };
  const offline = { getStatus: () => ({ connected: false }) };
  manager.dingtalkGateway = offline;
  manager.telegramGateway = offline;
  manager.discordGateway = offline;
  manager.qqGateway = offline;
  manager.weixinGateway = offline;
  manager.feishuGateway = {
    getStatus: () => ({ connected: true }),
    describeOutboundCapabilities: () => makeCapabilities(),
    ...sender,
  };
  // Newest first: a group chat, then the real direct chat.
  manager.imStore = {
    listSessionMappings: () => [
      { imConversationId: 'feishu-group-chat', coworkSessionId: 's-group' },
      { imConversationId: 'feishu-direct-chat', coworkSessionId: 's-direct' },
    ],
  };
  manager.coworkStore = {
    getConversationSourceContextBySession: (sessionId) => (
      sessionId === 's-group'
        ? { sourceChannel: 'im:feishu:group' }
        : { sourceChannel: 'im:feishu:direct' }
    ),
  };

  const rows = manager.listOutboundChannels();
  const feishu = rows.find((row) => row.platform === 'feishu');
  assert.equal(feishu.conversationId, 'feishu-direct-chat', 'group mapping must be skipped');
  assert.equal(feishu.sendable, true);

  const sent = await manager.sendImOutbound({ channel: 'feishu', text: 'hello' });
  assert.equal(sent.ok, true, JSON.stringify(sent.errors));
  assert.deepEqual(calls, [{ conversationId: 'feishu-direct-chat', text: 'hello' }]);

  const mismatched = await manager.sendImOutbound({
    channel: 'feishu',
    target: 'feishu-group-chat',
    text: 'nope',
  });
  assert.equal(mismatched.ok, false);
  assert.match(mismatched.errors.join('\n'), /只允许发往该通道上最近一次与你的私聊会话/);
  assert.equal(calls.length, 1, 'mismatched target must not reach any sender');
});

test('manager adapter: no direct history → "send one first"; gateway memory is the fallback', async () => {
  const { IMGatewayManager } = await import('../dist-electron/main/im/imGatewayManager.js');
  const manager = Object.create(IMGatewayManager.prototype);
  const calls = [];
  const sender = {
    sendToConversation: async (conversationId, text) => { calls.push({ conversationId, text }); },
    sendMediaToConversation: async () => {},
  };
  const offline = { getStatus: () => ({ connected: false }) };
  manager.dingtalkGateway = offline;
  manager.telegramGateway = offline;
  manager.discordGateway = offline;
  manager.qqGateway = offline;
  manager.feishuGateway = {
    getStatus: () => ({ connected: true }),
    describeOutboundCapabilities: () => makeCapabilities(),
    ...sender,
  };
  manager.weixinGateway = {
    getStatus: () => ({ connected: true }),
    describeOutboundCapabilities: () => makeCapabilities(),
    // In-memory fallback when no mapping row survives (e.g. mapping deleted).
    getLastDirectConversationId: () => 'wx-last-direct',
    ...sender,
  };
  manager.imStore = { listSessionMappings: () => [] };
  manager.coworkStore = { getConversationSourceContextBySession: () => null };

  const feishu = manager.listOutboundChannels().find((row) => row.platform === 'feishu');
  assert.equal(feishu.sendable, false);
  assert.equal(feishu.reason, NO_DIRECT_CONVERSATION_REASON);

  const refused = await manager.sendImOutbound({ channel: 'feishu', text: 'hello' });
  assert.equal(refused.ok, false);
  assert.match(refused.errors.join('\n'), /先给它发一条消息即可/);
  assert.equal(calls.length, 0);

  const weixin = await manager.sendImOutbound({ channel: 'wechat', text: 'hello' });
  assert.equal(weixin.ok, true);
  assert.deepEqual(calls, [{ conversationId: 'wx-last-direct', text: 'hello' }]);

  const unknown = await manager.sendImOutbound({ channel: 'signal', text: 'hello' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors.join('\n'), /未知通道/);
});
// ==================== Outbound record in the destination IM session ==========
//
// Owner-corrected requirement (2026-11-04): a proactive send must be visible in
// the chat it went to — the IM conversation's OWN cowork session — not in the
// desktop session that triggered it, and it must READ as a normal sent message.
// These tests pin: one record per attempt (failures included), the direction
// marked as outgoing, the bubble body byte-identical to what the channel
// received (no labels, no truncation, newlines intact), attachments carried as
// structured items (one bubble each), a session created when the chat has none,
// and the originating session left untouched.

const { IMGatewayManager } = await import('../dist-electron/main/im/imGatewayManager.js');
const { shouldIncludeCoworkContextMessage } = await import('../dist-electron/main/libs/coworkContextBudget.js');

/**
 * A manager whose send path is real (sendImOutboundMessage over a fake
 * transport) but whose stores/session plumbing are spies: the assertions are
 * about WHERE the record landed and what it says.
 *
 * `mapping` is the CANONICAL cowork_conversation_mappings row (channel
 * `im:<platform>:direct` + external conversation id + metabot id); the legacy
 * im_session_mappings row mirrors it, exactly as the real creation path writes
 * both. `persistedDirect` is the chat history used only when a refusal never
 * resolved a target (disconnected / no sender).
 */
function makeRecordManager({
  transport,
  mapping = null,
  persistedDirect = [],
  sessionExists = true,
  createdSessionId = 'im-session-created',
  throwOnRecord = false,
} = {}) {
  const manager = Object.create(IMGatewayManager.prototype);
  const hostMessages = [];
  const storeWrites = [];
  const createdFor = [];
  const mappingLookups = [];
  const seenIds = new Set();
  manager.imStore = {
    // The legacy per-platform table: `persistedDirect` rows are its real shape,
    // so the same list is visible to both the lookup and the history scan.
    getSessionMapping: (conversationId, platform) => {
      const legacy = persistedDirect.find(
        (row) => row.conversationId === conversationId && row.platform === platform
      );
      if (legacy) {
        return {
          imConversationId: conversationId,
          platform,
          coworkSessionId: legacy.coworkSessionId ?? `session-for-${conversationId}`,
          metabotId: legacy.metabotId ?? null,
        };
      }
      return mapping
        ? {
          imConversationId: conversationId,
          platform,
          coworkSessionId: mapping.coworkSessionId,
          metabotId: mapping.metabotId ?? null,
        }
        : null;
    },
    listSessionMappings: (platform) => persistedDirect
      .filter((row) => !platform || row.platform === platform)
      .map((row) => ({
        imConversationId: row.conversationId,
        platform: row.platform,
        coworkSessionId: row.coworkSessionId ?? `session-for-${row.conversationId}`,
        metabotId: row.metabotId ?? null,
      })),
    getConfig: () => ({ weixin: { metabotId: 7 } }),
  };
  manager.coworkStore = {
    getSession: (id) => (sessionExists ? { id } : null),
    getConversationMapping: (channel, conversationId, metabotId) => {
      mappingLookups.push({ channel, conversationId, metabotId });
      if (!mapping) return null;
      return {
        channel,
        externalConversationId: conversationId,
        metabotId: metabotId ?? null,
        coworkSessionId: mapping.coworkSessionId,
      };
    },
    getConversationSourceContextBySession: (sessionId) => {
      const hit = persistedDirect.find(
        (row) => (row.coworkSessionId ?? `session-for-${row.conversationId}`) === sessionId
      );
      return hit ? { sourceChannel: `im:${hit.platform}:direct` } : null;
    },
    addMessageWithId: (sessionId, id, message) => {
      storeWrites.push({ sessionId, id, message });
      return { id, ...message, timestamp: 1, sequence: storeWrites.length };
    },
  };
  manager.coworkRunner = {
    appendHostMessage: (sessionId, message) => {
      if (throwOnRecord) throw new Error('store exploded');
      // Mirror CoworkStore.addMessageWithId: a repeated id is the same row.
      if (seenIds.has(message.id)) return message;
      seenIds.add(message.id);
      hostMessages.push({ sessionId, message });
      return message;
    },
    // A record must never start or continue a turn; any call fails loudly.
    startSession: () => { throw new Error('the outbound record must not start a turn'); },
    continueSession: () => { throw new Error('the outbound record must not continue a turn'); },
  };
  manager.coworkHandler = {
    ensureDirectConversationSession: async (platform, conversationId, metabotId) => {
      createdFor.push({ platform, conversationId, metabotId });
      return createdSessionId;
    },
  };
  manager.buildOutboundTransport = () => transport;
  return { manager, hostMessages, storeWrites, createdFor, mappingLookups };
}

test('record: a successful send writes ONE outgoing bubble into the destination IM session', async () => {
  const { transport, calls } = makeTransport();
  const report = makeTempFile('季度报表.pdf', 4096);
  const { manager, hostMessages, storeWrites } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
  });

  const result = await manager.sendImOutbound({
    channel: 'weixin',
    text: '今天的报表已生成，请查收。',
    attachments: [report],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));

  assert.equal(hostMessages.length, 1, 'one send = one record');
  assert.equal(storeWrites.length, 0, 'the runner path owns the write when it exists');
  const [entry] = hostMessages;
  assert.equal(entry.sessionId, 'im-session-1', 'the record lands in the chat it went to');
  assert.equal(entry.message.type, 'system', 'a system row: never a user bubble, never an assistant reply');
  assert.notEqual(entry.message.type, 'user');
  assert.notEqual(entry.message.type, 'assistant', 'an assistant echo could be forwarded as a reply');

  // Owner ruling (real device, 2026-11-04): the echo is a NORMAL chat bubble —
  // its content is the body that actually went out, and nothing else. Not one
  // label, not one count, not one timestamp.
  assert.equal(entry.message.content, '今天的报表已生成，请查收。');
  assert.equal(entry.message.content, calls.texts[0].text, 'the bubble text is byte-identical to what the channel received');
  for (const label of ['方向：', '目标：', '摘要：', '附件：', '结果：', '已发出']) {
    assert.ok(!entry.message.content.includes(label), `the bubble must not carry the ${label} field`);
  }

  const metadata = entry.message.metadata;
  assert.equal(metadata.imOutboundSend, true);
  assert.equal(metadata.imOutboundDirection, 'outgoing', 'direction is marked as sent-out');
  assert.equal(metadata.imOutboundOk, true);
  assert.equal(metadata.imOutboundChannel, 'weixin');
  assert.equal(metadata.imOutboundConversationId, 'wx-direct-1');
  assert.equal(metadata.imOutboundRecordVersion, 2, 'v2 = bubble record, not the legacy card');
  assert.deepEqual(metadata.imOutboundAttachments, ['季度报表.pdf']);
  assert.deepEqual(metadata.imOutboundAttachmentItems, [{
    name: '季度报表.pdf',
    path: report,
    kind: 'file',
    bytes: 4096,
  }], 'attachments travel structured so the transcript can draw one bubble each');
  assert.ok(Number.isFinite(metadata.imOutboundAt));

  // "Not in the model transcript": the very filter the turn-context builder
  // applies drops this row, while the chat still renders it as an info card.
  assert.equal(
    shouldIncludeCoworkContextMessage({
      type: entry.message.type,
      content: entry.message.content,
      metadata: entry.message.metadata,
    }),
    false,
    'the record must never become model context'
  );
});

test('record: the originating desktop session gets nothing — only the destination chat is written', async () => {
  const { transport } = makeTransport();
  const { manager, hostMessages, storeWrites, mappingLookups } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
  });
  await manager.sendImOutbound({ channel: 'weixin', text: '只写目标会话' });

  const touched = new Set([
    ...hostMessages.map((entry) => entry.sessionId),
    ...storeWrites.map((entry) => entry.sessionId),
  ]);
  assert.deepEqual([...touched], ['im-session-1']);
  // The mapping lookup uses the canonical triple — not the caller's session id.
  assert.deepEqual(mappingLookups, [{
    channel: 'im:weixin:direct',
    conversationId: 'wx-direct-1',
    metabotId: 3,
  }]);
});

test('record: a failed send still writes the bubble, with the channel error', async () => {
  const { transport } = makeTransport({
    sender: {
      sendToConversation: async () => { throw new Error('socket hang up'); },
      sendMediaToConversation: async () => { throw new Error('upload rejected'); },
    },
  });
  const report = makeTempFile('报告.pdf', 1024);
  const { manager, hostMessages } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
  });

  const result = await manager.sendImOutbound({
    channel: 'weixin',
    text: '发给你的报告',
    attachments: [report],
  });
  assert.equal(result.ok, false);

  assert.equal(hostMessages.length, 1, 'a failure is exactly the case with no other trace');
  const content = hostMessages[0].message.content;
  assert.match(content, /⚠️ 方向：已发出/);
  assert.match(content, /目标：owner 私聊（wx-direct-1）/);
  assert.match(content, /结果：失败（未送达）/);
  assert.match(content, /附件：报告\.pdf（请求 1 个，成功 0 个）/);
  assert.match(content, /- 微信文本发送失败：socket hang up/);
  assert.match(content, /- 微信附件发送失败：upload rejected/);
  assert.equal(hostMessages[0].message.metadata.imOutboundOk, false);
});

test('record: a half-delivered batch says 部分成功 instead of implying nothing went out', async () => {
  const { transport } = makeTransport({
    sender: {
      sendToConversation: async () => {},
      sendMediaToConversation: async () => { throw new Error('upload rejected'); },
    },
  });
  const report = makeTempFile('报告.pdf', 1024);
  const { manager, hostMessages } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
  });
  const result = await manager.sendImOutbound({
    channel: 'weixin',
    text: '文字已经发出去了',
    attachments: [report],
  });
  assert.equal(result.ok, false);
  assert.ok(result.textChars > 0, 'the text leg really did land');

  const content = hostMessages[0].message.content;
  assert.match(content, /结果：部分成功/);
  assert.match(content, /- 微信附件发送失败：upload rejected/);
});

test('record: no binding for the chat → a session is created for it and receives the record', async () => {
  const { transport } = makeTransport();
  const { manager, hostMessages, createdFor, mappingLookups } = makeRecordManager({
    transport,
    mapping: null,
    createdSessionId: 'im-session-new',
  });

  const result = await manager.sendImOutbound({ channel: 'weixin', text: '第一次主动发' });
  assert.equal(result.ok, true);
  assert.equal(createdFor.length, 1);
  assert.deepEqual(createdFor[0], {
    platform: 'weixin',
    conversationId: 'wx-direct-1',
    // Falls back to the channel's configured bot so the session the next inbound
    // message finds is not immediately re-created with a different binding.
    metabotId: 7,
  });
  assert.deepEqual(mappingLookups[0], {
    channel: 'im:weixin:direct',
    conversationId: 'wx-direct-1',
    metabotId: 7,
  });
  assert.equal(hostMessages.length, 1);
  assert.equal(hostMessages[0].sessionId, 'im-session-new');
  assert.equal(hostMessages[0].message.content, '第一次主动发', 'a delivered send echoes the body verbatim');
});

test('record: a stale mapping (session deleted) falls back to creating one', async () => {
  const { transport } = makeTransport();
  const { manager, hostMessages, createdFor } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-gone', metabotId: 3 },
    sessionExists: false,
    createdSessionId: 'im-session-recreated',
  });
  await manager.sendImOutbound({ channel: 'weixin', text: '会话被删了' });
  assert.equal(createdFor.length, 1);
  assert.equal(hostMessages[0].sessionId, 'im-session-recreated');
});

test('record: a refusal before a target is resolved still files the failure in the channel chat', async () => {
  const { transport } = makeTransport({ connected: false });
  const { manager, hostMessages } = makeRecordManager({
    transport,
    mapping: null,
    // The chat exists in history even though the channel is offline right now.
    persistedDirect: [{ conversationId: 'wx-direct-1', platform: 'weixin', coworkSessionId: 'im-history-1' }],
    createdSessionId: 'im-session-created',
  });
  const result = await manager.sendImOutbound({ channel: 'weixin', text: '没连上' });
  assert.equal(result.ok, false);
  assert.equal(result.target, null, 'the send itself never had a destination');

  assert.equal(hostMessages.length, 1, 'a pre-send refusal must still leave a trace in the chat');
  assert.equal(hostMessages[0].sessionId, 'im-history-1', 'it reuses the chat session that already exists');
  const content = hostMessages[0].message.content;
  assert.match(content, /结果：失败（未送达）/);
  assert.match(content, /目标：未解析（本次没有发出）/, 'the bubble must not claim the chat was the target');
  assert.match(content, /未连接/);
});

test('record: an offline channel with no chat history files nothing but says so in the tool result', async () => {
  const { transport } = makeTransport({ connected: false });
  const { manager, hostMessages, createdFor } = makeRecordManager({
    transport,
    mapping: null,
    persistedDirect: [],
  });
  const result = await manager.sendImOutbound({ channel: 'weixin', text: '没连上也没历史' });
  assert.equal(result.ok, false);
  assert.equal(hostMessages.length, 0, 'no chat exists to show the failure in');
  assert.equal(createdFor.length, 0, 'an offline channel must not create a session');
  assert.match(result.warnings.join('\n'), /会话记录未写入/);
});

test('record: an unknown channel has no conversation to file in and writes nothing', async () => {
  const { transport } = makeTransport();
  const { manager, hostMessages } = makeRecordManager({ transport });
  const result = await manager.sendImOutbound({ channel: 'signal', text: 'x' });
  assert.equal(result.ok, false);
  assert.equal(result.target, null);
  assert.equal(hostMessages.length, 0);
});

test('record: filing the same attempt twice keeps exactly one row (idempotent)', async () => {
  const { transport } = makeTransport();
  const { manager, hostMessages } = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
  });
  const request = { channel: 'weixin', text: '同一次发送只写一条' };
  const result = await manager.sendImOutbound(request);
  assert.equal(hostMessages.length, 1);

  // Re-file the SAME attempt (same send timestamp): the deterministic id makes
  // the second write the same row, not a second bubble.
  const sentAt = hostMessages[0].message.metadata.imOutboundAt;
  await manager.recordOutboundConversationMessage(request, result, sentAt);
  assert.equal(hostMessages.length, 1, 'a retried record write must not duplicate the bubble');
});

test('record: a thrown send is normalized, and a broken record write never downgrades a delivered send', async () => {
  const { transport } = makeTransport();
  const broken = makeRecordManager({
    transport,
    mapping: { coworkSessionId: 'im-session-1', metabotId: 3 },
    throwOnRecord: true,
  });
  const result = await broken.manager.sendImOutbound({ channel: 'weixin', text: '发出去就算数' });
  assert.equal(result.ok, true, 'the record is an audit trail, not a delivery precondition');
  assert.equal(broken.hostMessages.length, 0);

  const throwingManager = Object.create(IMGatewayManager.prototype);
  throwingManager.imStore = { getSessionMapping: () => null, getConfig: () => ({}) };
  throwingManager.coworkStore = { getSession: () => null };
  throwingManager.coworkRunner = { appendHostMessage: () => { throw new Error('unreachable'); } };
  throwingManager.coworkHandler = null;
  throwingManager.buildOutboundTransport = () => { throw new Error('gateway exploded'); };
  const thrown = await throwingManager.sendImOutbound({ channel: 'weixin', text: 'x' });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.channel, 'weixin');
  assert.match(thrown.errors.join('\n'), /发送时发生未预期错误：gateway exploded/);
});

test('record: a long body is echoed in full — no 200-char cut, no 共 N 字 tail', async () => {
  const longText = '甲'.repeat(400);
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text: longText },
    result: {
      ok: true,
      channel: 'weixin',
      label: '微信',
      target: 'wx-direct-1',
      targetIsOwnerDirect: true,
      textChars: longText.length,
      attachments: [],
      warnings: [],
      errors: [],
    },
    timestamp: 1_800_000_000_000,
  });

  assert.equal(record.content, longText, 'the bubble shows every character that was sent');
  assert.equal(Array.from(record.content).length, 400);
  assert.ok(!record.content.includes('…'), 'no ellipsis marker');
  assert.ok(!record.content.includes('共 400 字'));
  // The legacy preview budget still exists — for the failure card only.
  assert.equal(IM_OUTBOUND_RECORD_PREVIEW_CHARS, 200);
});

test('record: newlines survive verbatim (a multi-line send stays multi-line)', () => {
  const text = '下午好～\n\n这是第二段。\n第三行。';
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', text },
    result: {
      ok: true,
      channel: 'weixin',
      label: '微信',
      target: 'wx-direct-1',
      targetIsOwnerDirect: true,
      textChars: text.length,
      attachments: [],
      warnings: [],
      errors: [],
    },
    timestamp: 1_800_000_000_000,
  });
  assert.equal(record.content, text);
  assert.equal(record.content.split('\n').length, 4);
});

test('record: an attachment-only send keeps an empty body and lists the file as an attachment item', async () => {
  const image = makeTempFile('photo.png', 512);
  const record = buildImOutboundConversationRecord({
    request: { channel: 'weixin', attachments: [image] },
    result: {
      ok: true,
      channel: 'weixin',
      label: '微信',
      target: 'wx-direct-1',
      targetIsOwnerDirect: true,
      textChars: 0,
      attachments: [{ path: image, bytes: 512, kind: 'image' }],
      warnings: [],
      errors: [],
    },
    timestamp: 1_800_000_000_000,
  });
  // No body was sent, so no body bubble is invented; the file IS the message.
  assert.equal(record.content, '');
  assert.deepEqual(record.metadata.imOutboundAttachmentItems, [{
    name: 'photo.png',
    path: image,
    kind: 'image',
    bytes: 512,
  }]);
});

test('record: the id is deterministic — a retried write is the same row, not a second bubble', async () => {
  const base = {
    request: { channel: 'weixin', text: '同一次发送' },
    result: {
      ok: true,
      channel: 'weixin',
      label: '微信',
      target: 'wx-direct-1',
      targetIsOwnerDirect: true,
      textChars: 6,
      attachments: [],
      warnings: [],
      errors: [],
    },
    timestamp: 1_800_000_000_000,
  };
  const first = buildImOutboundConversationRecord(base);
  const retried = buildImOutboundConversationRecord(base);
  assert.equal(first.id, retried.id);
  assert.match(first.id, /^imout-[0-9a-f]{24}$/);

  // A different attempt (different instant) is a different record on purpose:
  // two sends really did happen.
  const later = buildImOutboundConversationRecord({ ...base, timestamp: 1_800_000_001_000 });
  assert.notEqual(later.id, first.id);
});
