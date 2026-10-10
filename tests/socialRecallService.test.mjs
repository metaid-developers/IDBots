import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const {
  getSocialFeed,
  getSocialPost,
  getSocialPostComments,
  SocialRecallNotFoundError,
  SOCIAL_COUNTS_CALIBER,
} = require('../dist-electron/main/services/socialRecallService.js');

const SAMPLE_POST = {
  pinId: 'b6b9449bi0',
  sourcePinId: 'b6b9449bi0',
  currentPinId: 'b6b9449bi0',
  chainName: 'mvc',
  protocolPath: '/protocols/simplebuzz',
  author: {
    globalMetaId: 'idq1alice123',
    metaId: 'legacyMetaId1',
    address: 'addr1',
  },
  contentType: 'application/json;utf-8',
  payload: {
    content: 'AI 生态观察：今天链上的新进展',
    contentType: 'text/plain;utf-8',
    attachments: ['metafile://a275356ai0'],
  },
  createdAt: 1786122527,
  updatedAt: 1786122527,
  likeCount: 2,
  commentCount: 1,
  donateCount: 0,
  quoteCount: 1,
};

const SAMPLE_COMMENT = {
  pinId: 'c1abcdei0',
  chainName: 'mvc',
  targetPinId: 'b6b9449bi0',
  authorGlobalMetaId: 'idq1bob456',
  authorMetaId: 'legacyMetaId2',
  authorAddress: 'addr2',
  content: '很有意思，支持！',
  contentType: 'text/plain',
  timestamp: 1772292925,
};

function stubFetch(body, capture = {}) {
  return async (url) => {
    capture.url = url;
    return {
      status: 200,
      json: async () => body,
    };
  };
}

test('getSocialFeed builds the feed URL with keywords/publishers/time/sort/scope and normalizes items', async () => {
  const capture = {};
  const page = await getSocialFeed(
    {
      keywords: ['AI', 'MVC', 'web3'],
      publishers: ['idq1alice123', 'addr2'],
      since: 1768000000,
      until: 1768289999,
      chainName: 'mvc',
      scope: 'following',
      user: 'idq1owner456',
      size: 50,
      cursor: 'k:abc',
    },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_POST], nextCursor: 'k:next', hasMore: true } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/feed');
  assert.equal(url.searchParams.get('keywords'), 'AI,MVC,web3');
  assert.equal(url.searchParams.get('publishers'), 'idq1alice123,addr2');
  assert.equal(url.searchParams.get('since'), '1768000000');
  assert.equal(url.searchParams.get('until'), '1768289999');
  // newest is the API default and is deliberately not emitted.
  assert.equal(url.searchParams.get('sort'), null);
  assert.equal(url.searchParams.get('chainName'), 'mvc');
  assert.equal(url.searchParams.get('scope'), 'following');
  assert.equal(url.searchParams.get('user'), 'idq1owner456');
  assert.equal(url.searchParams.get('size'), '50');
  assert.equal(url.searchParams.get('cursor'), 'k:abc');

  assert.equal(page.items.length, 1);
  const item = page.items[0];
  assert.equal(item.pinId, 'b6b9449bi0');
  assert.equal(item.author.globalMetaId, 'idq1alice123');
  assert.equal(item.payload.content, 'AI 生态观察：今天链上的新进展');
  assert.deepEqual(item.payload.attachments, ['metafile://a275356ai0']);
  assert.equal(item.likeCount, 2);
  assert.equal(item.commentCount, 1);
  assert.equal(item.quoteCount, 1);
  assert.equal(page.nextCursor, 'k:next');
  assert.equal(page.hasMore, true);
});

test('getSocialFeed falls back to single keyword/publisher and omits optional params when unset', async () => {
  const capture = {};
  const page = await getSocialFeed(
    { keyword: 'AI', publisher: 'idq1alice123', size: 20 },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [] } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.searchParams.get('keyword'), 'AI');
  assert.equal(url.searchParams.get('publisher'), 'idq1alice123');
  assert.equal(url.searchParams.get('sort'), null);
  assert.equal(url.searchParams.get('scope'), null);
  assert.equal(url.searchParams.get('user'), null);
  assert.equal(url.searchParams.get('cursor'), null);
  assert.equal(page.items.length, 0);
  assert.equal(page.hasMore, false);
});

test('getSocialFeed maps sort=hot and a raw-string payload', async () => {
  const capture = {};
  const page = await getSocialFeed(
    { sort: 'hot', size: 10 },
    {
      fetchImpl: stubFetch({
        code: 0,
        message: 'ok',
        data: {
          items: [{ ...SAMPLE_POST, payload: '纯文本帖子内容', hotScore: 7, likeCount: 7 }],
          nextCursor: '',
          hasMore: false,
        },
      }, capture),
    },
  );
  const url = new URL(capture.url);
  assert.equal(url.searchParams.get('sort'), 'hot');
  assert.equal(url.searchParams.get('size'), '10');
  assert.equal(page.items[0].payload.content, '纯文本帖子内容');
  assert.equal(page.items[0].payload.contentType, 'text/plain;utf-8');
  assert.equal(page.items[0].hotScore, 7);
  assert.equal(page.nextCursor, null);
});

test('normalized items carry countsCaliber naming the counts read surface', async () => {
  const capture = {};
  const page = await getSocialFeed(
    { size: 10 },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_POST], nextCursor: '', hasMore: false } }, capture) },
  );
  assert.equal(page.items[0].countsCaliber, SOCIAL_COUNTS_CALIBER);
  assert.equal(SOCIAL_COUNTS_CALIBER, 'metaso-p2p:/api/social');

  // A pin the buzz-only index cannot read still names the surface that
  // answered — the caliber describes the read surface, not the counts.
  const detail = await getSocialPost('metaapp-pin-1', {
    fetchImpl: stubFetch({ code: 0, message: 'ok', data: { pinId: 'metaapp-pin-1' } }, capture),
  });
  assert.equal(detail.countsCaliber, SOCIAL_COUNTS_CALIBER);
  assert.equal(detail.likeCount, null);
});

test('getSocialPost hits the detail endpoint and throws SocialRecallNotFoundError on 40400', async () => {
  const capture = {};
  const post = await getSocialPost('b6b9449bi0', {
    fetchImpl: stubFetch({ code: 0, message: 'ok', data: SAMPLE_POST }, capture),
  });
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/post/b6b9449bi0');
  assert.equal(post.author.globalMetaId, 'idq1alice123');

  await assert.rejects(
    getSocialPost('missing-pin', {
      fetchImpl: stubFetch({ code: 40400, message: 'post not found', data: undefined }, capture),
    }),
    (error) => {
      assert.ok(error instanceof SocialRecallNotFoundError);
      assert.equal(error.name, 'SocialRecallNotFoundError');
      return true;
    },
  );
});

test('getSocialPostComments hits the comments endpoint with pagination', async () => {
  const capture = {};
  const page = await getSocialPostComments(
    { pinId: 'b6b9449bi0', size: 30, cursor: 'k:c1' },
    { fetchImpl: stubFetch({ code: 0, message: 'ok', data: { items: [SAMPLE_COMMENT], nextCursor: 'k:c2', hasMore: true } }, capture) },
  );
  const url = new URL(capture.url);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/post/b6b9449bi0/comments');
  assert.equal(url.searchParams.get('size'), '30');
  assert.equal(url.searchParams.get('cursor'), 'k:c1');
  assert.equal(page.items[0].authorGlobalMetaId, 'idq1bob456');
  assert.equal(page.items[0].content, '很有意思，支持！');
  assert.equal(page.nextCursor, 'k:c2');
  assert.equal(page.hasMore, true);
});

test('service functions surface API error codes as errors', async () => {
  await assert.rejects(
    getSocialFeed({ keyword: 'AI' }, {
      fetchImpl: stubFetch({ code: 50000, message: 'aggregation unavailable', data: undefined }),
    }),
    /Social Recall API error 50000: aggregation unavailable/,
  );
});
