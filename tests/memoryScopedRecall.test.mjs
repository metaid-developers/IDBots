import test from 'node:test';
import assert from 'node:assert/strict';

let rankScopedMemoryEntries;
try {
  ({ rankScopedMemoryEntries } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ rankScopedMemoryEntries } = await import('../dist-electron/memory/memoryPromptBlocks.js'));
}

test('scoped recall excludes owner profile facts from external memory sets', () => {
  const entries = rankScopedMemoryEntries({
    requestChannel: 'metaweb_private',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
      { text: 'Reply in concise bullet points', usageClass: 'operational_preference', visibility: 'external_safe' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
    currentUserText: 'remember the client prefers English',
  });

  assert.equal(entries.some((entry) => entry.text.includes('Alice')), false);
  assert.equal(entries.some((entry) => entry.text.includes('prefers English')), true);
  assert.equal(entries.some((entry) => entry.text.includes('concise bullet points')), true);
});

test('local recall keeps owner facts and excludes external scoped entries by default', () => {
  const entries = rankScopedMemoryEntries({
    requestChannel: 'cowork_ui',
    ownerEntries: [
      { text: 'My name is Alice', usageClass: 'profile_fact', visibility: 'local_only' },
    ],
    contactEntries: [
      { text: 'The client prefers English', usageClass: 'preference', visibility: 'local_only' },
    ],
    currentUserText: 'what is my name',
  });

  assert.equal(entries.some((entry) => entry.text.includes('Alice')), true);
  assert.equal(entries.some((entry) => entry.text.includes('prefers English')), false);
});
