import test from 'node:test';
import assert from 'node:assert/strict';

let buildScopedMemoryPromptBlocks;
try {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/memory/memoryPromptBlocks.js'));
}

test('external sessions do not include owner profile facts', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'metaweb_private',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
      { text: 'Reply in concise bullet points', usageClass: 'operational_preference', visibility: 'external_safe' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
  });

  assert.match(xml, /<contactMemories>/);
  assert.match(xml, /<ownerOperationalPreferences>/);
  assert.doesNotMatch(xml, /Alice/);
});

test('local sessions render owner memories only', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
    conversationEntries: [
      { text: 'The order is delayed', usageClass: 'profile_fact', visibility: 'local_only' },
    ],
  });

  assert.match(xml, /<ownerMemories>/);
  assert.doesNotMatch(xml, /<contactMemories>/);
  assert.doesNotMatch(xml, /<conversationMemories>/);
  assert.doesNotMatch(xml, /<ownerOperationalPreferences>/);
});
