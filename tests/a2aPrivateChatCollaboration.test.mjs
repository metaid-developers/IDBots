import test from 'node:test';
import assert from 'node:assert/strict';

const {
  analyzePrivateChatA2AConversation,
  buildPrivateChatA2ASystemPrompt,
} = await import('../dist-electron/main/services/privateChatDaemon.js');

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
