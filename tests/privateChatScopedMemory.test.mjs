import test from 'node:test';
import assert from 'node:assert/strict';

let buildPrivateReplyMemoryPromptBlocks;
let buildOrderPrompts;
let sendSellerOrderAcknowledgement;
let CoworkRunner;
try {
  ({ buildPrivateReplyMemoryPromptBlocks, sendSellerOrderAcknowledgement } = await import('../dist-electron/main/services/privateChatDaemon.js'));
  ({ buildOrderPrompts } = await import('../dist-electron/main/services/orderPromptBuilder.js'));
  ({ CoworkRunner } = await import('../dist-electron/main/libs/coworkRunner.js'));
} catch {
  ({ buildPrivateReplyMemoryPromptBlocks, sendSellerOrderAcknowledgement } = await import('../dist-electron/services/privateChatDaemon.js'));
  ({ buildOrderPrompts } = await import('../dist-electron/services/orderPromptBuilder.js'));
  ({ CoworkRunner } = await import('../dist-electron/libs/coworkRunner.js'));
}

function createCoworkRunnerPromptHarness({
  sessionType = 'standard',
  sourceChannel = 'cowork_ui',
  memoryEnabled = true,
} = {}) {
  const session = {
    id: 'session-1',
    sessionType,
    metabotId: 7,
    peerGlobalMetaId: 'peer-global-metaid',
    messages: [],
  };
  const store = {
    getMemoryBackend() {
      return {
        getEffectiveMemoryPolicyForSession() {
          return {
            memoryEnabled,
            memoryImplicitUpdateEnabled: memoryEnabled,
            memoryLlmJudgeEnabled: memoryEnabled,
            memoryGuardLevel: 'strict',
            memoryUserMemoriesMaxItems: 12,
          };
        },
        resolveMetabotIdForMemory() {
          return 7;
        },
      };
    },
    getSession() {
      return session;
    },
    getConversationSourceContextBySession() {
      return {
        sourceChannel,
        externalConversationId: 'conversation-1',
      };
    },
  };
  const runner = new CoworkRunner(store, {
    getMetabotById() {
      return {
        name: 'SellerBot',
        role: 'Weather assistant',
        soul: 'Warm and practical',
        background: 'Built for paid weather tasks',
        goal: 'Deliver useful service results',
      };
    },
  });
  return { runner, session };
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

test('order prompt keeps the owner-vs-client memory boundary without generic userMemories wording', () => {
  const { systemPrompt } = buildOrderPrompts({
    plaintext: 'Please deliver the result',
    source: 'metaweb',
    metabotName: 'OrderBot',
    peerName: 'Client',
  });

  assert.match(systemPrompt, /owner-scoped memory block/i);
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

test('order prompt user message strips order transport metadata and keeps only the actual request', () => {
  const { userPrompt } = buildOrderPrompts({
    plaintext: [
      '[ORDER] 请帮我查询上海天气，并告诉我今天是否适合出门。',
      '支付金额 0.0001 SPACE',
      `txid: ${'a'.repeat(64)}`,
      'service id: service-pin-weather',
      'skill name: weather',
    ].join('\n'),
    source: 'metaweb_private',
    metabotName: 'OrderBot',
    peerName: 'Client',
    skillName: 'weather',
  });

  assert.match(userPrompt, /查询上海天气/);
  assert.doesNotMatch(userPrompt, /\[ORDER\]/);
  assert.doesNotMatch(userPrompt, /支付金额|txid|service id|skill name/i);
});

test('order prompt tells seller that acknowledgement is sent before execution and final result must arrive within fifteen minutes', () => {
  const { systemPrompt } = buildOrderPrompts({
    plaintext: 'Please deliver the result',
    source: 'metaweb_private',
    metabotName: 'OrderBot',
    peerName: 'Client',
    skillName: 'weather',
  });

  assert.match(systemPrompt, /acknowledgement/i);
  assert.match(systemPrompt, /15 minutes/i);
  assert.match(systemPrompt, /Do not repeat that acknowledgement/i);
});

test('sendSellerOrderAcknowledgement sends a private acknowledgement and marks the seller order first response', async () => {
  const sentMessages = [];
  const lifecycleCalls = [];

  const result = await sendSellerOrderAcknowledgement({
    metabot: {
      id: 7,
      name: 'SellerBot',
      role: 'Weather assistant',
      soul: 'Helpful and calm',
      llm_id: 'llm-1',
    },
    peerGlobalMetaId: 'buyer-global-metaid',
    peerName: 'Client',
    plaintext: '[ORDER] Please check the Shanghai weather',
    skillName: 'weather',
    paymentTxid: 'a'.repeat(64),
    now: () => 1_770_123_456_000,
    performChat: async (_systemPrompt, userPrompt, llmId) => {
      assert.match(userPrompt, /Shanghai weather/);
      assert.doesNotMatch(userPrompt, /\[ORDER\]|支付金额|txid|service id|skill name/i);
      assert.equal(llmId, 'llm-1');
      return '我已明确你的需求，正在处理中，请稍候。';
    },
    sendEncryptedMsg: async (text) => {
      sentMessages.push(text);
      return { pinId: 'ack-pin-id' };
    },
    serviceOrderLifecycle: {
      markSellerOrderFirstResponseSent(input) {
        lifecycleCalls.push(input);
        return { id: 'seller-order-id' };
      },
    },
    emitLog: () => {},
  });

  assert.equal(result?.text, '我已明确你的需求，正在处理中，请稍候。');
  assert.deepEqual(sentMessages, ['我已明确你的需求，正在处理中，请稍候。']);
  assert.deepEqual(lifecycleCalls, [{
    localMetabotId: 7,
    counterpartyGlobalMetaId: 'buyer-global-metaid',
    paymentTxid: 'a'.repeat(64),
    sentAt: 1_770_123_456_000,
  }]);
});

test('CoworkRunner uses a compact outer prompt profile for seller metaweb_order a2a sessions', () => {
  const { runner } = createCoworkRunnerPromptHarness({
    sessionType: 'a2a',
    sourceChannel: 'metaweb_order',
    memoryEnabled: true,
  });

  const profile = runner.getSystemPromptProfileForSession('session-1');
  const personaBlock = runner.buildMetabotPersonaBlock('session-1');
  const systemPrompt = runner.composeEffectiveSystemPrompt(
    'BASE ORDER PROMPT',
    '/tmp/idbots-order',
    '/tmp/idbots-order',
    'text',
    '<ownerMemories><memory>hidden</memory></ownerMemories>',
    true,
    true,
    personaBlock,
    profile
  );

  assert.equal(profile.id, 'service_order_a2a');
  assert.match(systemPrompt, /<metabot_identity>/);
  assert.match(systemPrompt, /## Workspace Safety Policy/);
  assert.match(systemPrompt, /## Local Time Context/);
  assert.match(systemPrompt, /BASE ORDER PROMPT/);
  assert.doesNotMatch(systemPrompt, /## Memory Strategy/);
  assert.doesNotMatch(systemPrompt, /<ownerMemories>/);
  assert.doesNotMatch(systemPrompt, /schedule\.type = "at"|one-time scheduled tasks/i);
  assert.doesNotMatch(systemPrompt, /AskUserQuestion/);
});

test('CoworkRunner keeps the full common outer prompt for standard cowork sessions', () => {
  const { runner } = createCoworkRunnerPromptHarness({
    sessionType: 'standard',
    sourceChannel: 'cowork_ui',
    memoryEnabled: true,
  });

  const profile = runner.getSystemPromptProfileForSession('session-1');
  const personaBlock = runner.buildMetabotPersonaBlock('session-1');
  const systemPrompt = runner.composeEffectiveSystemPrompt(
    'BASE STANDARD PROMPT',
    '/tmp/idbots-standard',
    '/tmp/idbots-standard',
    'text',
    '<ownerMemories><memory>visible</memory></ownerMemories>',
    true,
    true,
    personaBlock,
    profile
  );

  assert.equal(profile.id, 'default');
  assert.match(systemPrompt, /## Memory Strategy/);
  assert.match(systemPrompt, /<ownerMemories>/);
  assert.match(systemPrompt, /schedule\.type = "at"|one-time scheduled tasks/i);
  assert.match(systemPrompt, /Do not use AskUserQuestion in this session/);
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
