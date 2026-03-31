import test from 'node:test';
import assert from 'node:assert/strict';

let buildPrivateReplyMemoryPromptBlocks;
let buildOrderPrompts;
try {
  ({ buildPrivateReplyMemoryPromptBlocks } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ buildOrderPrompts } = await import('../dist-electron/main/services/orderPromptBuilder.js'));
} catch {
  ({ buildPrivateReplyMemoryPromptBlocks } = await import('../dist-electron/services/privateChatDaemon.js'));
  ({ buildOrderPrompts } = await import('../dist-electron/services/orderPromptBuilder.js'));
}

test('private chat prompt does not inject owner profile facts', () => {
  const xml = buildPrivateReplyMemoryPromptBlocks({
    metabotId: 1,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: 'peer-123',
    limit: 12,
    currentUserText: 'The client prefers English',
    memoryBackend: {
      listUserMemories(input) {
        const scopeKind = input.scope?.kind ?? input.scopeKind;
        if (scopeKind === 'owner') {
          return [
            { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
            { text: 'Reply in concise bullet points', usageClass: 'operational_preference', visibility: 'external_safe' },
          ];
        }
        if (scopeKind === 'contact') {
          return [
            { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
          ];
        }
        return [];
      },
    },
  });

  assert.match(xml, /<contactMemories>/);
  assert.match(xml, /<ownerOperationalPreferences>/);
  assert.doesNotMatch(xml, /Alice/);
});

test('order prompt instructions reference scoped memory blocks instead of generic owner userMemories', () => {
  const { systemPrompt } = buildOrderPrompts({
    plaintext: 'Please deliver the result',
    source: 'metaweb',
    metabotName: 'OrderBot',
    peerName: 'Client',
  });

  assert.match(systemPrompt, /ownerMemories|contactMemories|conversationMemories|ownerOperationalPreferences/);
  assert.doesNotMatch(systemPrompt, /<userMemories>/);
});

test('order prompt strips remote delegation instructions from injected skills prompt', () => {
  const { systemPrompt } = buildOrderPrompts({
    plaintext: 'Please deliver the result',
    source: 'metaweb_private',
    metabotName: 'OrderBot',
    peerName: 'Client',
    skillsPrompt: [
      '## Skill Routing',
      '- Use the local weather skill when relevant.',
      '<available_remote_services>',
      '  <notice>',
      '    After the user confirms, output [DELEGATE_REMOTE_SERVICE] followed by JSON.',
      '  </notice>',
      '</available_remote_services>',
    ].join('\n'),
  });

  assert.match(systemPrompt, /Use the local weather skill/);
  assert.doesNotMatch(systemPrompt, /<available_remote_services>/);
  assert.doesNotMatch(systemPrompt, /\[DELEGATE_REMOTE_SERVICE\]/);
});

test('order prompt requires pure deliverable output without order chatter', () => {
  const { systemPrompt } = buildOrderPrompts({
    plaintext: 'Please deliver the result',
    source: 'metaweb_private',
    metabotName: 'OrderBot',
    peerName: 'Client',
  });

  assert.match(systemPrompt, /Return only the substantive deliverable/i);
  assert.match(systemPrompt, /Do not repeat greetings, self-introduction, payment amount, txid, service id, skill name, order confirmation/i);
});

test('cleanServiceResultText strips bot-to-bot wrapper and order metadata from mixed replies', async () => {
  const protocols = await import('../dist-electron/services/serviceOrderProtocols.js');

  const mixedReply = `77，你好！我是你的数字主分身 AI_Sunny。我已经成功处理了你的服务订单，并使用 weather 技能查询了上海的天气信息。

## 📋 服务订单确认
- **支付金额**: 0.0001 SPACE
- **交易ID**: 3fd46535479f0f1d46ffa1b934f7edc4bec33eb5d664462acf5020a9c2c305d4
- **服务ID**: e5121555fd87634383bf9b90c87c7fbe44d207f57a6ef0acbdbd9b14eb8ab5edi0
- **技能名称**: weather

## 🌤️ 上海当前天气
**⛅ 多云**
今天上海有小雨，建议外出携带雨具。

## 💡 温馨提示
未来两天天气逐渐好转，周四将转为晴朗天气。

**服务已完成！** 感谢你使用链上远端服务。如有其他需求，请随时联系。`;

  const cleaned = protocols.cleanServiceResultText(mixedReply);

  assert.match(cleaned, /## 🌤️ 上海当前天气/);
  assert.match(cleaned, /未来两天天气逐渐好转/);
  assert.doesNotMatch(cleaned, /77，你好/);
  assert.doesNotMatch(cleaned, /服务订单确认/);
  assert.doesNotMatch(cleaned, /支付金额/);
  assert.doesNotMatch(cleaned, /交易ID/);
  assert.doesNotMatch(cleaned, /服务已完成/);
});

test('cleanServiceResultText leaves plain service output intact', async () => {
  const protocols = await import('../dist-electron/services/serviceOrderProtocols.js');
  const plainResult = '## 查询结果\n上海当前温度 18°C，阴天转多云。';
  assert.equal(protocols.cleanServiceResultText(plainResult), plainResult);
});

test('buildCoworkDeliveryResultMessage presents only the seller result to the human-facing cowork session', async () => {
  const protocols = await import('../dist-electron/services/serviceOrderProtocols.js');

  assert.equal(
    protocols.buildCoworkDeliveryResultMessage('## 查询结果\n上海当前温度 18°C'),
    '以下为链上服务方返回结果：\n\n## 查询结果\n上海当前温度 18°C'
  );
});
