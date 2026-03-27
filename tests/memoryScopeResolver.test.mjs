import test from 'node:test';
import assert from 'node:assert/strict';

const { resolveMemoryScopes } = await import('../dist-electron/memory/memoryScopeResolver.js');

test('metaweb private sessions read contact scope and safe owner operational preferences only', () => {
  const resolved = resolveMemoryScopes({
    metabotId: 7,
    sourceChannel: 'metaweb_private',
    externalConversationId: 'metaweb-private:peer-123',
    peerGlobalMetaId: 'peer-123',
    sessionType: 'a2a',
  });

  assert.equal(resolved.writeScope.kind, 'contact');
  assert.deepEqual(resolved.readScopes.map((scope) => scope.kind), ['contact', 'owner']);
  assert.equal(resolved.allowOwnerOperationalPreferences, true);
});
