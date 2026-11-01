import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * Regression tests for the buzz-app social read paths after the 2026-11-01
 * retirement of the show.now / man.metaid.io service layer. The idframework
 * commands are plain ES modules with window guards, so a stub delegate is
 * enough to pin the wiring: every social read must target the aggregation
 * layer (social_agg / so.metaid.io) and never the dead bases, engagement
 * counts must stay tri-state (unknown ≠ 0), and the recommend feed must
 * declare its degradation to hot.
 */

const FetchBuzzCommand = (await import('../METAAPPs/buzz/idframework/commands/FetchBuzzCommand.js')).default;
const FetchBuzzCommentsCommand = (await import('../METAAPPs/buzz/idframework/commands/FetchBuzzCommentsCommand.js')).default;
const FetchUserListCommand = (await import('../METAAPPs/buzz/idframework/commands/FetchUserListCommand.js')).default;

function makeDelegate(responder) {
  const calls = [];
  const delegate = async (service, endpoint, options) => {
    calls.push({ service, endpoint, options });
    const respond = responder(service, endpoint);
    if (respond instanceof Error) throw respond;
    return respond;
  };
  return { calls, delegate };
}

const AGG_FEED_PAGE = {
  code: 0,
  data: {
    items: [
      {
        pinId: 'a'.repeat(64) + 'i0',
        sourcePinId: 'a'.repeat(64) + 'i0',
        currentPinId: 'a'.repeat(64) + 'i0',
        chainName: 'mvc',
        protocolPath: '/protocols/simplebuzz',
        author: { globalMetaId: 'idq1someone', metaId: 'f'.repeat(64), address: '1Author' },
        contentType: 'application/json',
        payload: { content: 'hello aggregation', contentType: 'text/plain;utf-8', attachments: [] },
        createdAt: 1793542099,
        updatedAt: 1793542099,
        likeCount: 3,
        commentCount: 0,
        donateCount: 0,
        quoteCount: 1,
      },
    ],
    hasMore: true,
    nextCursor: 'cur-1',
  },
};

test('timeline tabs hit the aggregation feed, never the dead show.now bases', async () => {
  const { calls, delegate } = makeDelegate(() => AGG_FEED_PAGE);
  const command = new FetchBuzzCommand();

  const cases = [
    { tab: 'new', expectQuery: { size: '10' } },
    { tab: 'hot', expectQuery: { sort: 'hot', size: '10' } },
    { tab: 'following', metaid: 'f'.repeat(64), expectQuery: { scope: 'following', user: 'f'.repeat(64), size: '10' } },
    { tab: 'profile', metaid: 'f'.repeat(64), expectQuery: { publisher: 'f'.repeat(64), size: '10' } },
  ];
  for (const item of cases) {
    await command.execute({ payload: { tab: item.tab, size: 10, metaid: item.metaid, lastId: 'c0' }, delegate });
  }
  // Per-item avatar/name enrichment also rides the delegate on 'metafs'
  // (file.metaid.io — alive); only the social_agg calls are the feed reads.
  const feedCalls = calls.filter((call) => call.service === 'social_agg');
  assert.equal(feedCalls.length, 4);
  for (let i = 0; i < feedCalls.length; i += 1) {
    assert.equal(feedCalls[i].service, 'social_agg', `call ${i} must use social_agg`);
    const url = new URL(`https://x.test${feedCalls[i].endpoint}`);
    assert.equal(url.pathname, '/api/social/feed', `call ${i} must hit the aggregation feed`);
    for (const [key, value] of Object.entries(cases[i].expectQuery)) {
      assert.equal(url.searchParams.get(key), value, `call ${i} param ${key}`);
    }
    if (cases[i].tab !== 'hot') {
      assert.equal(url.searchParams.get('cursor'), 'c0', `call ${i} cursor paging`);
    }
    assert.ok(!feedCalls[i].endpoint.includes('show.now'));
    assert.ok(!feedCalls[i].endpoint.includes('/social/buzz/'), 'retired show.now route must be gone');
  }
});

test('aggregation rows normalize: payload/author extraction, cursor/hasMore, tri-state counts', async () => {
  const { delegate } = makeDelegate(() => AGG_FEED_PAGE);
  const command = new FetchBuzzCommand();
  const result = await command.execute({ payload: { tab: 'new', size: 10 }, delegate });
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, 'cur-1');
  assert.equal(result.list.length, 1);
  const item = result.list[0];
  assert.equal(item.id, 'a'.repeat(64) + 'i0');
  assert.equal(item.content, 'hello aggregation');
  assert.equal(item.address, '1Author');
  assert.equal(item.metaid, 'f'.repeat(64));
  // Real zeros stay zeros; real counts stay counts.
  assert.equal(item.likeCount, 3);
  assert.equal(item.commentCount, 0);
  assert.equal(item.forwardCount, 1);
});

test('missing engagement counts stay null (unknown), never coerced to 0', async () => {
  const page = JSON.parse(JSON.stringify(AGG_FEED_PAGE));
  const row = page.data.items[0];
  delete row.likeCount;
  row.commentCount = null;
  row.quoteCount = 'unavailable';
  const { delegate } = makeDelegate(() => page);
  const command = new FetchBuzzCommand();
  const result = await command.execute({ payload: { tab: 'new', size: 10 }, delegate });
  const item = result.list[0];
  assert.equal(item.likeCount, null, 'absent count must stay null');
  assert.equal(item.commentCount, null, 'null count must stay null');
  assert.equal(item.forwardCount, null, '"unavailable" count must stay null');
});

test('recommend degrades to hot and flags the store so the UI can declare it', async () => {
  const stores = { buzz: { tabs: { recommend: {} }, total: 0 } };
  const { calls, delegate } = makeDelegate(() => AGG_FEED_PAGE);
  const command = new FetchBuzzCommand();
  const result = await command.execute({ payload: { tab: 'recommend', size: 10, userAddress: '1Boat' }, stores, delegate });
  assert.equal(result.degraded, true);
  assert.equal(stores.buzz.tabs.recommend.degraded, true);
  const url = new URL(`https://x.test${calls[0].endpoint}`);
  assert.equal(url.searchParams.get('sort'), 'hot');
  assert.equal(url.searchParams.get('userAddress'), null, 'no personalization params on the wire');
});

test('legacy path mode hits the alive manapi control plane with the /api prefix', async () => {
  const { calls, delegate } = makeDelegate(() => ({ code: 1, data: { list: [] } }));
  const command = new FetchBuzzCommand();
  await command.execute({ payload: { size: 5 }, delegate });
  assert.equal(calls[0].service, 'metaid_man');
  const url = new URL(`https://x.test${calls[0].endpoint}`);
  assert.equal(url.pathname, '/api/pin/path/list');
});

test('comments hit the aggregation post comments endpoint', async () => {
  const { calls, delegate } = makeDelegate(() => ({
    code: 0,
    data: {
      items: [
        {
          pinId: 'b'.repeat(64) + 'i0',
          chainName: 'mvc',
          targetPinId: 'a'.repeat(64) + 'i0',
          authorGlobalMetaId: 'idq1responder',
          authorMetaId: 'e'.repeat(64),
          authorAddress: '1Responder',
          content: 'a comment',
          contentType: 'text/plain;utf-8',
          timestamp: 1793542100,
        },
      ],
      hasMore: false,
      nextCursor: null,
    },
  }));
  const command = new FetchBuzzCommentsCommand();
  const result = await command.execute({ payload: { pinId: 'a'.repeat(64) + 'i0' }, delegate });
  assert.equal(calls[0].service, 'social_agg');
  const url = new URL(`https://x.test${calls[0].endpoint}`);
  assert.equal(url.pathname, `/api/social/post/${'a'.repeat(64)}i0/comments`);
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].content, 'a comment');
  assert.equal(result.list[0].createAddress, '1Responder');
  assert.equal(result.list[0].createMetaid, 'e'.repeat(64));
});

test('user lists hit the aggregation follow lists and pass opaque cursors through', async () => {
  const { calls, delegate } = makeDelegate(() => ({
    code: 0,
    data: {
      list: [
        { globalMetaId: 'idq1friend', name: 'Friend', nameId: 'c'.repeat(64) + 'i0', avatarId: '', followedAt: 1793540000, followPinId: 'd'.repeat(64) + 'i0' },
      ],
      nextCursor: 'opaque-cursor-token',
      size: 10,
    },
  }));
  const command = new FetchUserListCommand();
  const result = await command.execute({ payload: { metaid: 'f'.repeat(64), type: 'followers', size: 10 }, delegate });
  assert.equal(calls[0].service, 'social_agg');
  const url = new URL(`https://x.test${calls[0].endpoint}`);
  assert.equal(url.pathname, `/api/social/globalmetaid/${'f'.repeat(64)}/followers`);
  assert.ok(!calls[0].endpoint.includes('man.metaid.io'));
  assert.equal(result.list.length, 1);
  assert.equal(result.list[0].metaid, 'idq1friend');
  assert.equal(result.hasMore, true);
  assert.equal(result.nextCursor, 'opaque-cursor-token');
});
