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
