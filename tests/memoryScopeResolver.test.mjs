import test from 'node:test';
import assert from 'node:assert/strict';

let resolveMemoryScopes;
let normalizeMemoryScopeSelector;
let normalizeScopeIdentity;
try {
  ({ resolveMemoryScopes } = await import('../dist-electron/main/memory/memoryScopeResolver.js'));
  ({
    normalizeMemoryScopeSelector,
    normalizeScopeIdentity,
  } = await import('../dist-electron/main/memory/memoryScope.js'));
} catch {
  ({ resolveMemoryScopes } = await import('../dist-electron/memory/memoryScopeResolver.js'));
  ({
    normalizeMemoryScopeSelector,
    normalizeScopeIdentity,
  } = await import('../dist-electron/memory/memoryScope.js'));
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

test('cowork ui sessions stay in owner scope', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'cowork_ui',
    externalConversationId: 'session-123',
    sessionType: 'standard',
  });

  assert.equal(resolved.writeScope.kind, 'owner');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['owner']);
  assert.equal(resolved.ownerReadPolicy, 'all');
});

test('non-allowlisted a2a channels fall back to conversation scope', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'nim_private',
    externalConversationId: 'nim:conversation-123',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'conversation');
  assert.equal(resolved.writeScope.key, 'nim_private:conversation:nim:conversation-123');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['conversation']);
  assert.equal(resolved.ownerReadPolicy, 'operational_preference_only');
});

test('direct external sessions without peerGlobalMetaId fall back to conversation scope', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: null,
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'conversation');
  assert.equal(resolved.writeScope.key, 'metaweb_private:conversation:metaweb-private:peer-123');
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

test('normalizeScopeIdentity preserves opaque ids apart from trimming', () => {
  assert.equal(normalizeScopeIdentity('  peer id 123  '), 'peer id 123');
});
