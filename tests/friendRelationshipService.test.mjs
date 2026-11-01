import test from 'node:test';
import assert from 'node:assert/strict';

let friendService;
let resolverModule;
try {
  friendService = await import('../dist-electron/main/services/friendRelationshipService.js');
  resolverModule = await import('../dist-electron/main/services/metaidRelationshipResolver.js');
} catch {
  friendService = await import('../dist-electron/main/services/friendRelationshipService.js');
  resolverModule = await import('../dist-electron/main/services/metaidRelationshipResolver.js');
}

const {
  fetchSocialRelationships,
  fetchFriendList,
  fetchBlockList,
  fetchSocialCounts,
  MetasoFriendRelationshipProvider,
  SocialSubjectNotFoundError,
} = friendService;
const { MetaIDRelationshipResolver } = resolverModule;

const SOURCE = 'idq1source';
const PEER = 'idq1peer';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function createFetchStub(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler({ url: String(url), init });
  };
  return { fetchImpl, calls };
}

test('fetchSocialRelationships normalizes the batch envelope and echoes the request shape', async () => {
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({
    code: 0,
    message: '',
    data: {
      list: [
        {
          globalMetaId: PEER,
          relation: 'friend',
          isFriend: true,
          followsMe: true,
          followedByMe: true,
          blocking: false,
          blockedBy: false,
        },
      ],
    },
  }));
  const list = await fetchSocialRelationships(
    { source: SOURCE, targets: [PEER] },
    { baseUrl: 'http://social.test', fetchImpl },
  );
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    globalMetaId: PEER,
    relation: 'friend',
    isFriend: true,
    followsMe: true,
    followedByMe: true,
    blocking: false,
    blockedBy: false,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://social.test/api/social/relationships/batch');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].init.body), { sourceGlobalMetaId: SOURCE, targets: [PEER] });
});

test('batch normalization folds unknown relation strings to stranger and keeps booleans strict', async () => {
  const { fetchImpl } = createFetchStub(() => jsonResponse({
    code: 0,
    data: { list: [{ globalMetaId: PEER, relation: 'weird', followsMe: 'yes' }] },
  }));
  const [entry] = await fetchSocialRelationships(
    { source: SOURCE, targets: [PEER] },
    { baseUrl: 'http://social.test', fetchImpl },
  );
  assert.equal(entry.relation, 'stranger');
  assert.equal(entry.isFriend, false);
  assert.equal(entry.followsMe, false);
});

test('error envelopes and invalid payloads throw typed or plain errors', async () => {
  const notFound = createFetchStub(() => jsonResponse({ code: 40400, message: 'subject not found' }));
  await assert.rejects(
    fetchSocialRelationships({ source: SOURCE, targets: [PEER] }, { baseUrl: 'http://social.test', fetchImpl: notFound.fetchImpl }),
    (error) => error instanceof SocialSubjectNotFoundError,
  );

  const badCode = createFetchStub(() => jsonResponse({ code: 50000, message: 'aggregation unavailable' }));
  await assert.rejects(
    fetchSocialRelationships({ source: SOURCE, targets: [PEER] }, { baseUrl: 'http://social.test', fetchImpl: badCode.fetchImpl }),
    /Social relationship API error 50000/,
  );

  const invalid = createFetchStub(() => new Response('<html>404</html>', { status: 404 }));
  await assert.rejects(
    fetchSocialRelationships({ source: SOURCE, targets: [PEER] }, { baseUrl: 'http://social.test', fetchImpl: invalid.fetchImpl }),
    /invalid response/,
  );

  await assert.rejects(
    fetchSocialRelationships({ source: '', targets: [PEER] }, { baseUrl: 'http://social.test', fetchImpl: invalid.fetchImpl }),
    /requires a source/,
  );
});

test('friends, blocks, and counts lists normalize to paged shapes', async () => {
  const friends = createFetchStub(() => jsonResponse({
    code: 0,
    data: { list: [{ globalMetaId: PEER, name: 'Peer', nameId: 'n:i0', avatarId: 'a:i0' }], nextCursor: 'c2', size: 20 },
  }));
  const friendPage = await fetchFriendList(SOURCE, { size: 20 }, { baseUrl: 'http://social.test', fetchImpl: friends.fetchImpl });
  assert.equal(friendPage.hasMore, true);
  assert.equal(friendPage.nextCursor, 'c2');
  assert.equal(friendPage.items[0].globalMetaId, PEER);
  assert.equal(friendPage.items[0].followedAt, 0);
  assert.ok(friends.calls[0].url.includes('/api/social/globalmetaid/idq1source/friends'));

  const blocks = createFetchStub(() => jsonResponse({
    code: 0,
    data: {
      list: [
        { globalMetaId: PEER, name: 'Peer', direction: 'blockedBy', blockedAt: 1793240000, blockPinId: 'bp:i0' },
        { globalMetaId: 'idq1other', name: 'Other', direction: 'strange', blockedAt: 'x' },
      ],
      nextCursor: '',
    },
  }));
  const blockPage = await fetchBlockList(SOURCE, { type: 'blockedBy' }, { baseUrl: 'http://social.test', fetchImpl: blocks.fetchImpl });
  assert.equal(blockPage.hasMore, false);
  assert.equal(blockPage.items[0].direction, 'blockedBy');
  assert.equal(blockPage.items[0].blockPinId, 'bp:i0');
  assert.equal(blockPage.items[1].direction, 'blocking');
  assert.equal(blockPage.items[1].blockedAt, 0);
  assert.ok(blocks.calls[0].url.includes('/blocks?type=blockedBy'));

  const counts = createFetchStub(() => jsonResponse({
    code: 0,
    data: { followers: 12, following: 8, friends: 5, blockedCount: 2, blockedByCount: 0 },
  }));
  assert.deepEqual(
    await fetchSocialCounts(SOURCE, { baseUrl: 'http://social.test', fetchImpl: counts.fetchImpl }),
    { followers: 12, following: 8, friends: 5, blockedCount: 2, blockedByCount: 0 },
  );
});

test('provider maps the relation fold to the friend tri-state with block flags', async () => {
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({
    code: 0,
    data: {
      list: [
        { globalMetaId: PEER, relation: 'blocked', isFriend: false, followsMe: true, followedByMe: false, blocking: true, blockedBy: false },
      ],
    },
  }));
  const provider = new MetasoFriendRelationshipProvider({ baseUrl: 'http://social.test', fetchImpl });
  const pair = await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  assert.deepEqual(pair, { status: 'not_confirmed', blocking: true, blockedBy: false, followsMe: true, followedByMe: false });
  assert.equal(await provider.resolveFriendStatus({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER }), 'not_confirmed');
  assert.equal(calls.length, 1, 'TTL cache serves the second lookup without a refetch');
});

test('provider TTL cache expires and re-fetches after the window', async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = createFetchStub(() => jsonResponse({
    code: 0,
    data: { list: [{ globalMetaId: PEER, relation: 'friend', isFriend: true }] },
  }));
  const provider = new MetasoFriendRelationshipProvider({
    baseUrl: 'http://social.test',
    fetchImpl,
    cacheTtlMs: 100,
    now: () => clock,
  });
  await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  assert.equal(calls.length, 1);
  clock += 101;
  await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  assert.equal(calls.length, 2);
});

test('provider failures open the breaker and short-circuit to unknown without network', async () => {
  let clock = 1_000;
  const { fetchImpl, calls } = createFetchStub(() => new Response('gone', { status: 503 }));
  const provider = new MetasoFriendRelationshipProvider({
    baseUrl: 'http://social.test',
    fetchImpl,
    failureThreshold: 2,
    breakerCooldownMs: 60_000,
    now: () => clock,
  });
  await assert.rejects(provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER }));
  await assert.rejects(provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER }));
  assert.equal(calls.length, 2, 'breaker opens at the failure threshold');
  // While open: immediate unknown, no fetch, no throw.
  const shortCircuit = await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  assert.deepEqual(shortCircuit, { status: 'unknown', blocking: null, blockedBy: null, followsMe: null, followedByMe: null });
  assert.equal(calls.length, 2);
  // After the cooldown the breaker half-opens: a success closes it again.
  clock += 61_000;
  const recovering = createFetchStub(() => jsonResponse({
    code: 0,
    data: { list: [{ globalMetaId: PEER, relation: 'friend', isFriend: true }] },
  }));
  const healed = new MetasoFriendRelationshipProvider({
    baseUrl: 'http://social.test',
    fetchImpl: recovering.fetchImpl,
    failureThreshold: 2,
    breakerCooldownMs: 60_000,
    now: () => clock,
  });
  const healedPair = await healed.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: PEER });
  assert.deepEqual(healedPair, { status: 'confirmed', blocking: false, blockedBy: false, followsMe: false, followedByMe: false });
});

test('malformed pair input resolves to unknown without touching the network', async () => {
  const { fetchImpl, calls } = createFetchStub(() => {
    throw new Error('network must not be called');
  });
  const provider = new MetasoFriendRelationshipProvider({ baseUrl: 'http://social.test', fetchImpl });
  assert.deepEqual(
    await provider.resolvePairState({ firstGlobalMetaID: 'not-a-gmid', secondGlobalMetaID: PEER }),
    { status: 'unknown', blocking: null, blockedBy: null, followsMe: null, followedByMe: null },
  );
  assert.deepEqual(
    await provider.resolvePairState({ firstGlobalMetaID: SOURCE, secondGlobalMetaID: SOURCE }),
    { status: 'unknown', blocking: null, blockedBy: null, followsMe: null, followedByMe: null },
  );
  assert.equal(calls.length, 0);
});

test('resolver integration: provider API failure folds to unknown, never not_confirmed', async () => {
  const { fetchImpl } = createFetchStub(() => jsonResponse({ code: 50000, message: 'aggregation unavailable' }));
  const resolver = new MetaIDRelationshipResolver({
    listMetabots: () => [],
    friendProvider: new MetasoFriendRelationshipProvider({ baseUrl: 'http://social.test', fetchImpl }),
    now: () => 777,
  });
  const fact = await resolver.resolveFriend(SOURCE, PEER);
  assert.equal(fact.status, 'unknown');
  assert.equal(fact.source, 'unavailable');
  assert.equal(fact.blocking, null);
  assert.equal(fact.blockedBy, null);
});
