import test from 'node:test';
import assert from 'node:assert/strict';

let buildScopedMemoryPromptBlocks;
try {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
} catch {
  ({ buildScopedMemoryPromptBlocks } = await import('../dist-electron/main/memory/memoryPromptBlocks.js'));
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

test('over-budget memory blocks evict the oldest entries first but never the top-ranked one', () => {
  const entry = (text, updatedAt, lastUsedAt = null) => ({
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt,
    lastUsedAt,
  });
  // All score 1 (no query tokens match), so rank order = text asc: a-newest,
  // b-mid, c-oldest. ~900 chars each (2712 total) vs the 2000 clamp floor:
  // evicting c-oldest (904) lands at 1808 ≤ 2000.
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      entry(pad('c-oldest:'), 1000),
      entry(pad('a-newest:'), 3000),
      entry(pad('b-mid:'), 2000),
    ],
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000
  });

  assert.match(xml, /a-newest:/);
  assert.match(xml, /b-mid:/);
  assert.doesNotMatch(xml, /c-oldest:/);
});

test('a single oversized top-ranked entry survives even a tiny budget', () => {
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      {
        text: 'solo:'.padEnd(2500, 'x'), // 2500 chars alone > the 2000 floor
        usageClass: 'profile_fact',
        visibility: 'local_only',
        updatedAt: 1000,
        lastUsedAt: null,
      },
    ],
    maxTotalChars: 2000,
  });

  assert.match(xml, /<ownerMemories>/);
});

test('a high-importance old memory is guaranteed injection over newer low-importance fillers', () => {
  const filler = Array.from({ length: 35 }, (_, index) => ({
    text: `aaa-filler-${String(index).padStart(2, '0')}`,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt: 5000 + index,
    lastUsedAt: null,
    importance: 0.5,
  }));
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      ...filler,
      // Ranks dead last by relevance (text tie-break) and by recency — only
      // the guaranteed importance tier can surface it.
      {
        text: 'zzz-old-explicit-instruction',
        usageClass: 'profile_fact',
        visibility: 'local_only',
        updatedAt: 100,
        lastUsedAt: null,
        importance: 0.95,
      },
    ],
    maxOwnerEntries: 12,
  });

  const lines = xml.split('\n').filter((line) => line.startsWith('- '));
  assert.equal(lines.length, 12, 'policy maxItems still caps the final injection count');
  assert.equal(lines[0], '- zzz-old-explicit-instruction', 'guaranteed tier renders first');
});

test('over-budget eviction drops the lowest importance first, not the oldest', () => {
  const entry = (text, updatedAt, importance) => ({
    text,
    usageClass: 'profile_fact',
    visibility: 'local_only',
    updatedAt,
    lastUsedAt: null,
    importance,
  });
  // ~900 chars each (2712 total) vs the 2000 clamp floor: exactly one eviction.
  const pad = (label) => label + 'x'.repeat(900 - label.length);
  const xml = buildScopedMemoryPromptBlocks({
    channel: 'cowork_ui',
    ownerEntries: [
      entry(pad('mid-low:'), 2000, 0.5),
      entry(pad('new-low:'), 3000, 0.5),
      entry(pad('old-high:'), 1000, 0.95),
    ],
    maxTotalChars: 50, // below the 2000 clamp floor → budget is 2000
  });

  assert.match(xml, /old-high:/, 'high-importance entry survives despite being the oldest');
  assert.match(xml, /new-low:/);
  assert.doesNotMatch(xml, /mid-low:/, 'lowest importance evicts first, oldest-among-low goes first');
});
