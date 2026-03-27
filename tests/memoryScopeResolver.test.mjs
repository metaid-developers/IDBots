import test from 'node:test';
import assert from 'node:assert/strict';

let resolveMemoryScopes;
let normalizeMemoryScopeSelector;
try {
  ({ resolveMemoryScopes } = await import('../dist-electron/main/memory/memoryScopeResolver.js'));
  ({ normalizeMemoryScopeSelector } = await import('../dist-electron/main/memory/memoryScope.js'));
} catch {
  ({ resolveMemoryScopes } = await import('../dist-electron/memory/memoryScopeResolver.js'));
  ({ normalizeMemoryScopeSelector } = await import('../dist-electron/memory/memoryScope.js'));
}

test('metaweb private sessions read contact scope and safe owner operational preferences only', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'contact');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['contact']);
  assert.equal(resolved.ownerReadPolicy, 'operational_preference_only');
});

test('external context without a valid metabot id falls back to owner scope', () => {
  const resolved = resolveMemoryScopes({
    metabotId: null,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'owner');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['owner']);
  assert.equal(resolved.ownerReadPolicy, 'all');
});

test('group or order channels fall back to conversation scope', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'metaweb_order',
    externalConversationId: 'metaweb-order:conversation-1',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'conversation');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['conversation']);
  assert.equal(resolved.ownerReadPolicy, 'operational_preference_only');
});

test('normalizeMemoryScopeSelector rejects conflicting selector inputs', () => {
  assert.throws(() => normalizeMemoryScopeSelector({
    scope: { kind: 'owner', key: 'owner:self' },
    scopeKind: 'contact',
    scopeKey: 'metaweb_private:peer:peer-123',
  }), /Conflicting memory scope selector kind/);
});
