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
