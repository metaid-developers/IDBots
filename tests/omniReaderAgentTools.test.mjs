import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const { buildOmniReaderAgentTools } = require('../dist-electron/main/libs/omniReaderAgentTools.js');

function makeHarness(overrides = {}) {
  const calls = { fetchJson: [], fetchText: [] };
  const control = {
    fetchJson: async (url) => {
      calls.fetchJson.push(url);
      if (overrides.fetchJsonError) {
        // Allow per-URL failures (string matched against the url) or a global one.
        const err = overrides.fetchJsonError;
        if (err instanceof Error) throw err;
        if (typeof err === 'object') {
          for (const [needle, error] of Object.entries(err)) {
            if (url.includes(needle)) throw error;
          }
        }
      }
      return overrides.fetchJsonResult ?? { code: 0, data: { ok: true } };
    },
    fetchText: async (url) => {
      calls.fetchText.push(url);
      if (overrides.fetchTextError) throw overrides.fetchTextError;
      return overrides.fetchTextResult ?? 'raw body';
    },
  };
  const tools = buildOmniReaderAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    control,
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName };
}

test('builds a single omni_read tool', () => {
  const { byName } = makeHarness();
  assert.ok(byName.omni_read);
  assert.equal(Object.keys(byName).length, 1);
});

test('user_info by metaid hits the metafile-indexer info endpoint with encoded id', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'user_info', metaid: 'abc123' });
  assert.equal(result.isError, undefined);
  assert.equal(
    calls.fetchJson[0],
    'https://file.metaid.io/metafile-indexer/api/v1/info/metaid/abc123',
  );
});

test('user_info falls back to manapi when the indexer fails (metaid/address only)', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: { 'file.metaid.io': new Error('indexer down') },
  });
  const result = await byName.omni_read.handler({ action: 'user_info', address: '1Boat' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.fetchJson.length, 2);
  assert.equal(calls.fetchJson[1], 'https://manapi.metaid.io/api/info/address/1Boat');
});

test('user_info with globalmetaid does NOT fall back to manapi', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: new Error('indexer down'),
  });
  const result = await byName.omni_read.handler({ action: 'user_info', globalmetaid: 'idq1alice' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /indexer down/);
  assert.equal(calls.fetchJson.length, 1);
});

test('user_info reports both errors when the manapi fallback also fails', async () => {
  const { byName } = makeHarness({
    fetchJsonError: {
      'file.metaid.io': new Error('indexer down'),
      'manapi.metaid.io': new Error('manapi down'),
    },
  });
  const result = await byName.omni_read.handler({ action: 'user_info', metaid: 'abc123' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /metafile-indexer: indexer down/);
  assert.match(result.content[0].text, /manapi fallback: manapi down/);
});

test('user_info requires exactly one id param', async () => {
  const { calls, byName } = makeHarness();
  const none = await byName.omni_read.handler({ action: 'user_info' });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /exactly one of metaid, address, or globalmetaid/);
  const two = await byName.omni_read.handler({ action: 'user_info', metaid: 'a', address: 'b' });
  assert.equal(two.isError, true);
  assert.equal(calls.fetchJson.length, 0);
});

test('search_users builds the keyword query with default limit 10', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'search_users', keyword: 'alice', keytype: 'name' });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/info/search');
  assert.equal(url.searchParams.get('keyword'), 'alice');
  assert.equal(url.searchParams.get('keytype'), 'name');
  assert.equal(url.searchParams.get('limit'), '10');
});

test('search_users requires keyword', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'search_users' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires keyword/);
  assert.equal(calls.fetchJson.length, 0);
});

test('buzz_newest maps to the aggregation feed: cursor paging, publisher filter, followed scope', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({
    action: 'buzz_newest', cursor: 'c9', size: 10, metaid: 'm1', followed: 1,
  });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/feed');
  assert.equal(url.searchParams.get('cursor'), 'c9');
  assert.equal(url.searchParams.get('size'), '10');
  assert.equal(url.searchParams.get('scope'), 'following');
  assert.equal(url.searchParams.get('user'), 'm1');
  assert.equal(url.searchParams.get('publisher'), null);
  // Without followed=1 the metaid is a publisher filter instead.
  await byName.omni_read.handler({ action: 'buzz_newest', metaid: 'm1', lastId: 'legacy7' });
  const publisherUrl = new URL(calls.fetchJson[1]);
  assert.equal(publisherUrl.searchParams.get('publisher'), 'm1');
  assert.equal(publisherUrl.searchParams.get('scope'), null);
  // Legacy lastId is still forwarded as cursor.
  assert.equal(publisherUrl.searchParams.get('cursor'), 'legacy7');
  // followed=1 without a subject is an explicit error, not a silent blank.
  const missing = await byName.omni_read.handler({ action: 'buzz_newest', followed: 1 });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /followed=1 requires metaid/);
  assert.equal(calls.fetchJson.length, 2);
});

test('buzz_recommended degrades to sort=hot and marks the payload _degraded', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonResult: { code: 0, data: { items: [], hasMore: false } },
  });
  const result = await byName.omni_read.handler({ action: 'buzz_recommended', size: 5, userAddress: '1Boat' });
  assert.equal(result.isError, undefined);
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/feed');
  assert.equal(url.searchParams.get('sort'), 'hot');
  assert.equal(url.searchParams.get('size'), '5');
  // userAddress is no longer a ranking input; it must not reach the wire.
  assert.equal(url.searchParams.get('userAddress'), null);
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload._degraded, /sort=hot/);
  assert.match(payload._degraded, /userAddress is not used for ranking/);
});

test('buzz_hot rejects size > 50 without fetching and maps to sort=hot', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'buzz_hot', size: 51 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /size must be <= 50/);
  assert.equal(calls.fetchJson.length, 0);
  await byName.omni_read.handler({ action: 'buzz_hot', size: 20 });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/social/feed');
  assert.equal(url.searchParams.get('sort'), 'hot');
  assert.equal(url.searchParams.get('size'), '20');
});

test('buzz_search requires key; buzz_info requires pinId', async () => {
  const { calls, byName } = makeHarness();
  const search = await byName.omni_read.handler({ action: 'buzz_search' });
  assert.equal(search.isError, true);
  assert.match(search.content[0].text, /requires key/);
  const info = await byName.omni_read.handler({ action: 'buzz_info' });
  assert.equal(info.isError, true);
  assert.match(info.content[0].text, /requires pinId/);
  assert.equal(calls.fetchJson.length, 0);
});

test('buzz_search and buzz_info hit the aggregation layer endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'buzz_search', key: 'meta id' });
  const searchUrl = new URL(calls.fetchJson[0]);
  assert.equal(searchUrl.origin + searchUrl.pathname, 'https://so.metaid.io/api/social/feed');
  assert.equal(searchUrl.searchParams.get('keyword'), 'meta id');
  await byName.omni_read.handler({ action: 'buzz_info', pinId: 'txid1i0' });
  const infoUrl = new URL(calls.fetchJson[1]);
  assert.equal(infoUrl.origin + infoUrl.pathname, 'https://so.metaid.io/api/social/post/txid1i0');
});

test('notifications degrades to the interactions inbox and marks the payload _degraded', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonResult: { code: 0, data: { items: [], hasMore: false } },
  });
  const missing = await byName.omni_read.handler({ action: 'notifications' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires address/);
  const result = await byName.omni_read.handler({ action: 'notifications', address: '1Boat', size: 20, cursor: 'cx1' });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://so.metaid.io/api/metaweb/interactions');
  assert.equal(url.searchParams.get('owner'), '1Boat');
  assert.equal(url.searchParams.get('size'), '20');
  assert.equal(url.searchParams.get('cursor'), 'cx1');
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload._degraded, /interactions inbox/);
});

test('followers/following hit the aggregation follow lists (no dead man.metaid.io)', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'followers', metaid: 'm1' });
  const followersUrl = new URL(calls.fetchJson[0]);
  assert.equal(followersUrl.origin + followersUrl.pathname, 'https://so.metaid.io/api/social/globalmetaid/m1/followers');
  await byName.omni_read.handler({ action: 'following', metaid: 'm1', cursor: '5', size: 10 });
  const followingUrl = new URL(calls.fetchJson[1]);
  assert.equal(followingUrl.origin + followingUrl.pathname, 'https://so.metaid.io/api/social/globalmetaid/m1/following');
  assert.equal(followingUrl.searchParams.get('cursor'), '5');
  assert.equal(followingUrl.searchParams.get('size'), '10');
  const missing = await byName.omni_read.handler({ action: 'followers' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires metaid/);
});

test('tool contract states the tri-state engagement semantics and the backend switch', () => {
  const { byName } = makeHarness();
  const description = String(byName.omni_read.description);
  // unknown ≠ 0 must be part of the LLM-visible contract, not just a comment.
  assert.match(description, /NEVER 0/);
  assert.match(description, /so\.metaid\.io/);
  assert.match(description, /_degraded/);
});

test('a social read against a dead aggregation layer fails explicitly, never as a blank page', async () => {
  const { byName } = makeHarness({ fetchJsonError: new Error('HTTP 504 from indexer') });
  const result = await byName.omni_read.handler({ action: 'buzz_newest', size: 5 });
  assert.equal(result.isError, true);
  // Level 1 (aggregation) AND level 2 (chain fallback) failures are both named.
  assert.match(result.content[0].text, /aggregation layer .*unreachable/);
  assert.match(result.content[0].text, /chain fallback manapi pins_by_path also failed/);
});

test('buzz_newest falls back to the chain-sourced pin list when only the aggregation layer is down', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: { 'so.metaid.io': new Error('HTTP 504 from indexer') },
    fetchJsonResult: { code: 0, data: { list: [{ id: 'pini0' }], nextCursor: 'c1' } },
  });
  const result = await byName.omni_read.handler({ action: 'buzz_newest', size: 5 });
  assert.equal(result.isError, undefined);
  // b) fallback lands on the next level: manapi chain-direct read.
  const fallbackUrl = new URL(calls.fetchJson[1]);
  assert.equal(fallbackUrl.origin + fallbackUrl.pathname, 'https://manapi.metaid.io/api/pin/path/list');
  assert.equal(fallbackUrl.searchParams.get('path'), '/protocols/simplebuzz');
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload._degraded, /pins_by_path/);
  // Machine-checkable tri-state: counts on a chain-direct payload are the
  // string "unavailable" — not null, not 0.
  assert.equal(payload.data.likeCount, 'unavailable');
  assert.equal(payload.data.commentCount, 'unavailable');
});

test('buzz_info falls back to the raw chain pin with "unavailable" counts when the aggregation layer is down', async () => {
  const { calls, byName } = makeHarness({
    fetchJsonError: { 'so.metaid.io': new Error('HTTP 504 from indexer') },
    fetchJsonResult: { code: 0, data: { id: 'pini0', content: '{}' } },
  });
  const result = await byName.omni_read.handler({ action: 'buzz_info', pinId: 'pini0' });
  assert.equal(result.isError, undefined);
  assert.equal(calls.fetchJson[1], 'https://manapi.metaid.io/api/pin/pini0');
  const payload = JSON.parse(result.content[0].text);
  assert.match(payload._degraded, /raw chain pin/);
  assert.equal(payload.data.likeCount, 'unavailable');
  assert.equal(payload.data.quoteCount, 'unavailable');
});

test('buzz_hot has no chain fallback: a dead aggregation layer is an explicit error', async () => {
  const { calls, byName } = makeHarness({ fetchJsonError: new Error('HTTP 504 from indexer') });
  const result = await byName.omni_read.handler({ action: 'buzz_hot', size: 5 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /aggregation layer .*unreachable/);
  assert.equal(calls.fetchJson.length, 1, 'no second-level fetch for a ranking-shaped read');
});

test('pin and pin_version build manapi URLs', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'pin', pinId: 'txid1i0' });
  assert.equal(calls.fetchJson[0], 'https://manapi.metaid.io/api/pin/txid1i0');
  await byName.omni_read.handler({ action: 'pin_version', pinId: 'txid1i0', ver: 2 });
  assert.equal(calls.fetchJson[1], 'https://manapi.metaid.io/api/pin/ver/txid1i0/2');
  const missingVer = await byName.omni_read.handler({ action: 'pin_version', pinId: 'txid1i0' });
  assert.equal(missingVer.isError, true);
  assert.match(missingVer.content[0].text, /requires ver/);
});

test('paged lists (pin_list, metaid_list, block_list, mempool_list) forward page/size', async () => {
  const { calls, byName } = makeHarness();
  for (const [action, segment] of [
    ['pin_list', 'pin'],
    ['metaid_list', 'metaid'],
    ['block_list', 'block'],
    ['mempool_list', 'mempool'],
  ]) {
    await byName.omni_read.handler({ action, page: 2, size: 5 });
  }
  assert.deepEqual(
    calls.fetchJson,
    [
      'https://manapi.metaid.io/api/pin/list?page=2&size=5',
      'https://manapi.metaid.io/api/metaid/list?page=2&size=5',
      'https://manapi.metaid.io/api/block/list?page=2&size=5',
      'https://manapi.metaid.io/api/mempool/list?page=2&size=5',
    ],
  );
});

test('pins_by_path requires path and encodes it as a query param', async () => {
  const { calls, byName } = makeHarness();
  const missing = await byName.omni_read.handler({ action: 'pins_by_path' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires path/);
  await byName.omni_read.handler({ action: 'pins_by_path', path: '/protocols/simplebuzz', size: 20 });
  const url = new URL(calls.fetchJson[0]);
  assert.equal(url.origin + url.pathname, 'https://manapi.metaid.io/api/pin/path/list');
  assert.equal(url.searchParams.get('path'), '/protocols/simplebuzz');
  assert.equal(url.searchParams.get('size'), '20');
});

test('pins_by_path rejects size outside 1-100', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.omni_read.handler({ action: 'pins_by_path', path: '/p', size: 101 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /between 1 and 100/);
  assert.equal(calls.fetchJson.length, 0);
});

test('pins_by_metaid / pins_by_address build path-segment URLs with optional filters', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({
    action: 'pins_by_metaid', metaid: 'm1', path: '/protocols/simplebuzz', size: 10, cursor: 'c1',
  });
  const byMetaid = new URL(calls.fetchJson[0]);
  assert.equal(byMetaid.origin + byMetaid.pathname, 'https://manapi.metaid.io/api/metaid/pin/list/m1');
  assert.equal(byMetaid.searchParams.get('path'), '/protocols/simplebuzz');
  assert.equal(byMetaid.searchParams.get('cursor'), 'c1');

  const missingPath = await byName.omni_read.handler({ action: 'pins_by_address', address: '1Boat' });
  assert.equal(missingPath.isError, true);
  assert.match(missingPath.content[0].text, /requires path/);

  await byName.omni_read.handler({ action: 'pins_by_address', address: '1Boat', path: '/protocols/simplebuzz' });
  const byAddress = new URL(calls.fetchJson[1]);
  assert.equal(byAddress.origin + byAddress.pathname, 'https://manapi.metaid.io/api/address/pin/list/1Boat');
  assert.equal(byAddress.searchParams.get('path'), '/protocols/simplebuzz');
});

test('pin_content returns the raw body via fetchText, not JSON', async () => {
  const { calls, byName } = makeHarness({ fetchTextResult: '{"hello":"world"}' });
  const result = await byName.omni_read.handler({ action: 'pin_content', pinId: 'txid1i0' });
  assert.equal(calls.fetchText[0], 'https://manapi.metaid.io/content/txid1i0');
  assert.equal(calls.fetchJson.length, 0);
  assert.equal(result.content[0].text, '{"hello":"world"}');
});

test('file_info and file_latest hit the metafile-indexer files endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'file_info', pinId: 'txid1i0' });
  assert.equal(calls.fetchJson[0], 'https://file.metaid.io/metafile-indexer/api/v1/files/txid1i0');
  await byName.omni_read.handler({ action: 'file_latest', firstPinId: 'txid0i0' });
  assert.equal(calls.fetchJson[1], 'https://file.metaid.io/metafile-indexer/api/v1/files/latest/txid0i0');
  const missing = await byName.omni_read.handler({ action: 'file_latest' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires firstPinId/);
});

test('files_by_creator and files_by_metaid forward cursor/size', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'files_by_creator', address: '1Boat', size: 20 });
  const creator = new URL(calls.fetchJson[0]);
  assert.equal(creator.origin + creator.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/creator/1Boat');
  assert.equal(creator.searchParams.get('size'), '20');
  await byName.omni_read.handler({ action: 'files_by_metaid', metaid: 'm1', cursor: 'c9' });
  const byMetaid = new URL(calls.fetchJson[1]);
  assert.equal(byMetaid.origin + byMetaid.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/metaid/m1');
  assert.equal(byMetaid.searchParams.get('cursor'), 'c9');
});

test('files_by_extension uses the metaid variant when metaid is given', async () => {
  const { calls, byName } = makeHarness();
  const missing = await byName.omni_read.handler({ action: 'files_by_extension' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /requires extension/);

  await byName.omni_read.handler({ action: 'files_by_extension', extension: '.jpg', size: 20 });
  const plain = new URL(calls.fetchJson[0]);
  assert.equal(plain.origin + plain.pathname, 'https://file.metaid.io/metafile-indexer/api/v1/files/extension');
  assert.equal(plain.searchParams.get('extension'), '.jpg');

  await byName.omni_read.handler({ action: 'files_by_extension', extension: '.png', metaid: 'm1' });
  const withMetaid = new URL(calls.fetchJson[1]);
  assert.equal(
    withMetaid.origin + withMetaid.pathname,
    'https://file.metaid.io/metafile-indexer/api/v1/files/metaid/m1/extension',
  );
  assert.equal(withMetaid.searchParams.get('extension'), '.png');
});

test('indexer_status, indexer_stats, and global_counts hit their endpoints', async () => {
  const { calls, byName } = makeHarness();
  await byName.omni_read.handler({ action: 'indexer_status' });
  await byName.omni_read.handler({ action: 'indexer_stats' });
  await byName.omni_read.handler({ action: 'global_counts' });
  assert.deepEqual(calls.fetchJson, [
    'https://file.metaid.io/metafile-indexer/api/v1/status',
    'https://file.metaid.io/metafile-indexer/api/v1/stats',
    'https://manapi.metaid.io/debug/count',
  ]);
});

test('results are pretty-printed JSON', async () => {
  const { byName } = makeHarness({ fetchJsonResult: { code: 0, data: { name: 'alice' } } });
  const result = await byName.omni_read.handler({ action: 'indexer_status' });
  assert.equal(result.content[0].text, JSON.stringify({ code: 0, data: { name: 'alice' } }, null, 2));
});

test('oversized results carry an honest first-N-of-M note and stay under the 20k shaping cap', async () => {
  const big = { data: 'x'.repeat(30000) };
  const { byName } = makeHarness({ fetchJsonResult: big });
  const result = await byName.omni_read.handler({ action: 'indexer_stats' });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  const total = JSON.stringify(big, null, 2).length;
  // H-71: the runtime shaper (dsh-runtime/plugins/idbots-tool-result-shaping.mjs)
  // head+tail-cuts anything over 20000 chars, so a bigger omni_read result used
  // to spill as a mid-JSON-cut file under a "Full formatted result" banner.
  // omni_read output must stay at or under that cap; the spill file then holds
  // the complete declared output.
  assert.ok(text.length <= 20000, `output stays under the shaping cap (got ${text.length})`);
  assert.match(text, new RegExp(`\\[omni_read: first \\d+ of ${total} chars — `));
  assert.ok(text.includes('no pagination cursor in the response'), 'honestly reports the missing cursor');
  assert.ok(!text.includes('(truncated, narrow the query with cursor/size)'), 'the old misleading note is gone');
});

test('truncation note surfaces the response pagination token so the page is recoverable', async () => {
  // manapi shape: the cursor sits under data — exactly the field the old
  // 20000-char head cut removed, leaving the note pointing at nothing.
  const cursor = '4f3c9d1e77a2b608c5e4f19d2a8b7306c95e14f8d27a60b3c8e91f45d2076ab' + 'i0';
  const big = {
    code: 0,
    data: { list: [{ pin: { id: 'p1' }, summary: 'y'.repeat(30000) }], total: 53825, cursor },
  };
  const { byName } = makeHarness({ fetchJsonResult: big });
  const result = await byName.omni_read.handler({ action: 'pins_by_path', path: '/p', size: 100 });
  const text = result.content[0].text;
  assert.ok(text.length <= 20000, `output stays under the shaping cap (got ${text.length})`);
  assert.ok(
    text.includes(`cursor "${cursor}" present; re-run with cursor="${cursor}" for the next page`),
    'note echoes the usable cursor value',
  );
});

test('truncation note also recognizes top-level nextCursor and nested lastId', async () => {
  const topCursor = { code: 0, nextCursor: 'nc1', data: 'z'.repeat(30000) };
  const { byName } = makeHarness({ fetchJsonResult: topCursor });
  const top = await byName.omni_read.handler({ action: 'indexer_stats' });
  assert.ok(top.content[0].text.includes('nextCursor "nc1" present'));

  const lastId = { code: 0, data: { list: ['a'.repeat(30000)], lastId: 'L9' } };
  const { byName: byName2 } = makeHarness({ fetchJsonResult: lastId });
  const nested = await byName2.omni_read.handler({ action: 'buzz_hot', size: 10 });
  assert.ok(nested.content[0].text.includes('lastId "L9" present'));
});

test('pin_content truncation declares first-N-of-M on the raw body', async () => {
  const { byName } = makeHarness({ fetchTextResult: 'b'.repeat(30000) });
  const result = await byName.omni_read.handler({ action: 'pin_content', pinId: 'txid1i0' });
  const text = result.content[0].text;
  assert.ok(text.length <= 20000, `output stays under the shaping cap (got ${text.length})`);
  assert.match(text, /\[omni_read: first \d+ of 30000 chars — raw content body; no pagination cursor\]/);
});

test('fetch failures surface as an error result without throwing', async () => {
  const { byName } = makeHarness({ fetchJsonError: new Error('HTTP 502') });
  const result = await byName.omni_read.handler({ action: 'indexer_status' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /omni_read indexer_status failed: HTTP 502/);
});

test('pin_content fetchText failures surface as an error result', async () => {
  const { byName } = makeHarness({ fetchTextError: new Error('HTTP 404') });
  const result = await byName.omni_read.handler({ action: 'pin_content', pinId: 'missingi0' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /omni_read pin_content failed: HTTP 404/);
});

test('complete under-cap results carry no truncation note (three states stay mutually exclusive)', async () => {
  // H-71 探针（对侧验收亦用此形态）：
  // 完整页（无 cursor、未截断）⇒ 不得出现 first-N-of-M
  // 若该状态实现上不可能出现，则「断言其不可能」本身就是护栏。
  const small = { code: 0, data: { list: [{ id: 'p1' }], total: 1 } };
  const { byName } = makeHarness({ fetchJsonResult: small });
  const text = (await byName.omni_read.handler({ action: 'indexer_status' })).content[0].text;
  assert.ok(text.length <= 20000);
  assert.ok(!/first \d+ of \d+ chars/.test(text), 'complete page must not declare a truncation');
  assert.ok(
    !text.includes('no pagination cursor in the response'),
    'complete page must not declare a missing cursor',
  );
  assert.equal(text, JSON.stringify(small, null, 2), 'complete page is the exact pretty-printed body');
});
