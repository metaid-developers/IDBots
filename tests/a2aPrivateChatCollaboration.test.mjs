import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const {
  analyzePrivateChatA2AConversation,
  buildPrivateChatA2ASystemPrompt,
  buildPrivateChatTurnUserMessage,
} = await import('../dist-electron/main/services/privateChatDaemon.js');

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const makeA2AMessage = (id, direction, content, timestamp, extraMeta = {}) => ({
  id,
  type: direction === 'incoming' ? 'user' : 'assistant',
  content,
  timestamp,
  metadata: {
    sourceChannel: 'metaweb_private',
    direction,
    ...extraMeta,
  },
});

test('analyzePrivateChatA2AConversation tracks roundInitiator (local vs peer) and injects goal-completion bye guidance', () => {
  const base = 1_794_141_000_000;

  const localInitiated = analyzePrivateChatA2AConversation({
    messages: [
      makeA2AMessage('m1', 'outgoing', '白纸学员·阿十向你报名设计课。', base),
      makeA2AMessage('m2', 'incoming', '招生窗口暂未开放，待正式开班再通知你。', base + 10_000, { senderName: '阿墨' }),
    ],
    now: base + 20_000,
  });
  assert.equal(localInitiated.roundInitiator, 'local');

  const localPrompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: '阿十' },
    analysis: localInitiated,
  });
  assert.match(localPrompt, /Conversation role: YOU initiated this conversation round/);
  assert.match(localPrompt, /Goal-completion check before saying "bye"/);
  assert.match(localPrompt, /Mutual "bye" closing rule/);
  assert.match(localPrompt, /Never append ": bye"/);
  assert.doesNotMatch(localPrompt, /If the conversation no longer seems likely to produce useful new information, end the topic by replying exactly "bye"/);

  const peerInitiated = analyzePrivateChatA2AConversation({
    messages: [
      makeA2AMessage('p1', 'incoming', '阿十你好，设计课一期已开班。', base, { senderName: '阿墨' }),
    ],
    now: base + 10_000,
  });
  assert.equal(peerInitiated.roundInitiator, 'peer');

  const peerPrompt = buildPrivateChatA2ASystemPrompt({
    metabot: { name: '阿十' },
    analysis: peerInitiated,
  });
  assert.match(peerPrompt, /Conversation role: the PEER initiated this conversation round/);
  assert.match(peerPrompt, /Do NOT unilaterally cut off an early conversation with "bye"/);
});

test('analyzePrivateChatA2AConversation preserves full prior history across >5-min pauses and reopened byes while resetting turn pressure', () => {
  const base = 1_794_160_000_000;
  const messages = [
    makeA2AMessage('m1', 'incoming', '报名咨询：我想学设计课第一期', base, { senderName: '阿十' }),
    makeA2AMessage('m2', 'outgoing', '当前处于自我修炼期，开班后再通知你', base + 20_000),
    makeA2AMessage('m3', 'outgoing', 'bye', base + 30_000),
    // Hours later: local bot reopens the conversation and multiple >10-min tool pauses occur
    makeA2AMessage('m4', 'outgoing', '【正式入学闸 · 判定通知】设计课一期已开班', base + 3_600_000),
    makeA2AMessage('w1', 'outgoing', '稍等，正在核验你的 enroll 报文', base + 3_650_000, {
      privateChatSkillWaitNotice: true,
    }),
    makeA2AMessage('m5', 'incoming', '第一棒 enroll 已上链', base + 4_300_000, { senderName: '阿十' }), // > 10 min gap
    makeA2AMessage('m6', 'outgoing', '第 02 课《样张上链》开讲', base + 4_350_000),
    makeA2AMessage('m7', 'incoming', '第 03 课作业本体报告交齐', base + 5_200_000, { senderName: '阿十' }), // > 14 min gap
  ];

  const analysis = analyzePrivateChatA2AConversation({
    messages,
    now: base + 5_210_000,
  });

  // Turn-limit bye pressure resets across >5-min gaps so working bots are not prematurely force-byed
  assert.equal(analysis.incomingTurnCount, 1);
  assert.equal(analysis.shouldForceBye, false);

  // Full substantive history from BOTH bots is preserved across the earlier bye and across all >5-min pauses!
  const contents = analysis.contextMessages.map((m) => m.content);
  assert.deepEqual(contents, [
    '报名咨询：我想学设计课第一期',
    '当前处于自我修炼期，开班后再通知你',
    '【正式入学闸 · 判定通知】设计课一期已开班',
    '第一棒 enroll 已上链',
    '第 02 课《样张上链》开讲',
    '第 03 课作业本体报告交齐',
  ]);
  assert.ok(!contents.includes('bye'));
  assert.ok(!contents.some((c) => c.includes('稍等，正在核验')));
});

test('buildPrivateChatTurnUserMessage coalesces out-of-band local messages and burst-skipped peer submissions', () => {
  const base = 1_794_171_000_000;

  // Normal 1-by-1 turn with no unread intermediate messages returns plaintext verbatim
  const normalSession = [
    makeA2AMessage('u1', 'incoming', '你好', base, { senderName: '阿十' }),
    makeA2AMessage('a1', 'outgoing', '你好，请讲', base + 5_000, {
      privateChatReplyForPinId: `${'11'.repeat(32)}i0`,
    }),
    makeA2AMessage('u2', 'incoming', '请问作业交哪里？', base + 10_000, { senderName: '阿十' }),
  ];
  assert.equal(
    buildPrivateChatTurnUserMessage({
      sessionMessages: normalSession,
      currentInboundMessageId: 'u2',
      plaintext: '请问作业交哪里？',
      localBotName: '设计老师·阿墨',
      peerName: '白纸学员·阿十',
    }),
    '请问作业交哪里？',
  );

  // Regression from 0adc754f [#344..#349]:
  // 1) Local bot sent out-of-band messages from an external orchestration session (no privateChatReplyForPinId)
  // 2) Peer sent a 1024-char substantive submission (#348) followed 33ms later by a 50-char hold notice (#349)
  const burstSession = [
    makeA2AMessage('prev-reply', 'outgoing', 'bye', base, {
      privateChatReplyForPinId: `${'22'.repeat(32)}i0`,
    }),
    makeA2AMessage('oob-1', 'outgoing', '阿十，拍五 · 第 03 课批改落点：题三 FAIL 待整改。', base + 100_000, {
      simplemsgKind: 'private_chat',
    }),
    makeA2AMessage('oob-2', 'outgoing', '阿十，拍六 · 第 03 课学情落点（8/9 勾）。', base + 120_000, {
      simplemsgKind: 'private_chat',
    }),
    makeA2AMessage('burst-substantive', 'incoming', '整改件交齐——原处 2 撤回，补交两处像素实测证据 pin://217fce...', base + 150_000, {
      senderName: '白纸学员·阿十',
    }),
    makeA2AMessage('burst-hold', 'incoming', '收到，我先去把第 03 课那四张图打开量一遍，稍等我一下就回你。', base + 150_033, {
      senderName: '白纸学员·阿十',
    }),
  ];

  const turnMessage = buildPrivateChatTurnUserMessage({
    sessionMessages: burstSession,
    currentInboundMessageId: 'burst-hold',
    plaintext: '收到，我先去把第 03 课那四张图打开量一遍，稍等我一下就回你。',
    localBotName: '设计老师·阿墨',
    peerName: '白纸学员·阿十',
  });

  assert.match(turnMessage, /<unread_conversation_updates>/);
  assert.match(turnMessage, /\[You \(设计老师·阿墨\)\]: 阿十，拍五 · 第 03 课批改落点：题三 FAIL 待整改。/);
  assert.match(turnMessage, /\[You \(设计老师·阿墨\)\]: 阿十，拍六 · 第 03 课学情落点（8\/9 勾）。/);
  assert.match(turnMessage, /\[Peer \(白纸学员·阿十\)\]: 整改件交齐——原处 2 撤回/);
  assert.match(turnMessage, /<latest_peer_message>\n收到，我先去把第 03 课那四张图打开量一遍，稍等我一下就回你。\n<\/latest_peer_message>/);
});

test('main.ts wires private-chat skill turns to the session workspace cwd before falling back to skills root', () => {
  const mainSource = fs.readFileSync(path.join(projectRoot, 'src', 'main', 'main.ts'), 'utf8');
  assert.match(
    mainSource,
    /const sessionCwd = \(getCoworkStore\(\)\.getSessionWithoutMessages\(params\.sessionId\)\?\.cwd \?\? ''\)\.trim\(\);\s*const roots = skillMgr\.getAllSkillRoots\(\);\s*const cwd = sessionCwd \|\|/,
  );
});
