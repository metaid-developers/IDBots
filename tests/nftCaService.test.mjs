import test from 'node:test';
import assert from 'node:assert/strict';

// NFT CA registry reader: empty-registry degradation (no pin configured,
// missing/unparseable pin), pin-content parsing, creator-verification flag
// logic, and the process-lifetime TTL cache — over a stubbed global fetch.

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;

const {
  OFFICIAL_IDBOTS_METAID,
  NFT_CA_CACHE_TTL_MS,
  buildEmptyNftCaRegistry,
  clearNftCaRegistryCache,
  getConfiguredNftCaPinId,
  getNftCaRegistry,
  isNftCaCacheFresh,
  parseNftCaPinContent,
  resolveNftCaPinCreator,
} = await import('../dist-electron/main/services/nftCaService.js');

const CA_PIN_ID = `${'ab'.repeat(32)}i0`;
const CONTENT_URL = `https://file.metaid.io/metafile-indexer/content/${CA_PIN_ID}`;
const PIN_RECORD_URL = `https://manapi.metaid.io/pin/${CA_PIN_ID}`;

async function withFetchStub(stub, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(text, status = 200) {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain' },
  });
}

function withCaPinEnv(pinId) {
  if (pinId) process.env.IDBOTS_NFT_CA_PINID = pinId;
  else delete process.env.IDBOTS_NFT_CA_PINID;
}

const VALID_PIN_CONTENT = JSON.stringify({
  protocol: 'idbots-nft-ca',
  version: 1,
  collections: [
    { collectionPinId: `${'cd'.repeat(32)}i0`, collectionName: 'pixel-cats', note: 'official', certifiedAt: 1793868000 },
    { collectionPinId: 'not-a-pin-id' }, // dropped by the parser
  ],
});

// ---------------------------------------------------------------------------
// parseNftCaPinContent (pure)
// ---------------------------------------------------------------------------

test('parseNftCaPinContent accepts a well-formed payload and normalizes entries', () => {
  const collections = parseNftCaPinContent(VALID_PIN_CONTENT);
  assert.ok(Array.isArray(collections));
  assert.equal(collections.length, 1);
  assert.equal(collections[0].collectionPinId, `${'cd'.repeat(32)}i0`);
  assert.equal(collections[0].collectionName, 'pixel-cats');
  assert.equal(collections[0].note, 'official');
  assert.equal(collections[0].certifiedAt, 1793868000);
});

test('parseNftCaPinContent rejects wrong protocol, version, shape, and garbage', () => {
  assert.equal(parseNftCaPinContent(JSON.stringify({ protocol: 'other', version: 1, collections: [] })), null);
  assert.equal(parseNftCaPinContent(JSON.stringify({ protocol: 'idbots-nft-ca', version: 2, collections: [] })), null);
  assert.equal(parseNftCaPinContent(JSON.stringify({ protocol: 'idbots-nft-ca', version: 1 })), null);
  assert.equal(parseNftCaPinContent('not json'), null);
  assert.equal(parseNftCaPinContent('[1,2,3]'), null);
  assert.equal(parseNftCaPinContent(''), null);
  assert.equal(parseNftCaPinContent(null), null);
});

// ---------------------------------------------------------------------------
// Empty-registry degradation
// ---------------------------------------------------------------------------

test('unset CA pin env degrades to an empty registry without any fetch', async () => {
  withCaPinEnv(null);
  clearNftCaRegistryCache();
  let fetchCalls = 0;
  const registry = await withFetchStub(async () => {
    fetchCalls += 1;
    throw new Error('must not fetch');
  }, () => getNftCaRegistry());
  assert.equal(registry.status, 'empty-no-pin-configured');
  assert.equal(registry.verified, false);
  assert.deepEqual(registry.collections, []);
  assert.equal(registry.pinId, null);
  assert.equal(fetchCalls, 0);
});

test('unreachable or unparseable CA pin degrades to an empty unavailable registry', async () => {
  withCaPinEnv(CA_PIN_ID);
  clearNftCaRegistryCache();
  const registry = await withFetchStub(async (url) => {
    if (String(url).startsWith(CONTENT_URL)) return textResponse('503 upstream', 503);
    throw new Error(`unexpected fetch ${url}`);
  }, () => getNftCaRegistry());
  assert.equal(registry.status, 'unavailable');
  assert.equal(registry.verified, false);
  assert.deepEqual(registry.collections, []);
  assert.equal(registry.pinId, CA_PIN_ID);

  clearNftCaRegistryCache();
  const garbage = await withFetchStub(async (url) => {
    if (String(url).startsWith(CONTENT_URL)) return textResponse('<html>not json</html>');
    throw new Error(`unexpected fetch ${url}`);
  }, () => getNftCaRegistry());
  assert.equal(garbage.status, 'unavailable');
  assert.equal(garbage.verified, false);
  assert.deepEqual(garbage.collections, []);
});

test('invalid env pin id is treated as no pin configured', () => {
  withCaPinEnv('deadbeef');
  assert.equal(getConfiguredNftCaPinId(), null);
  withCaPinEnv(CA_PIN_ID);
  assert.equal(getConfiguredNftCaPinId(), CA_PIN_ID);
  withCaPinEnv(null);
});

// ---------------------------------------------------------------------------
// Creator verification flag logic
// ---------------------------------------------------------------------------

test('matching creator marks the registry verified and keeps collections', async () => {
  withCaPinEnv(CA_PIN_ID);
  clearNftCaRegistryCache();
  const registry = await withFetchStub(async (url) => {
    const target = String(url);
    if (target.startsWith(CONTENT_URL)) return textResponse(VALID_PIN_CONTENT);
    if (target.startsWith(PIN_RECORD_URL)) {
      return jsonResponse({ code: 1, data: { id: CA_PIN_ID, globalMetaId: OFFICIAL_IDBOTS_METAID } });
    }
    throw new Error(`unexpected fetch ${target}`);
  }, () => getNftCaRegistry());
  assert.equal(registry.status, 'verified');
  assert.equal(registry.verified, true);
  assert.equal(registry.creatorMetaId, OFFICIAL_IDBOTS_METAID);
  assert.equal(registry.collections.length, 1);
});

test('mismatching or unresolvable creator keeps collections but verified stays false', async () => {
  withCaPinEnv(CA_PIN_ID);
  clearNftCaRegistryCache();
  const mismatched = await withFetchStub(async (url) => {
    const target = String(url);
    if (target.startsWith(CONTENT_URL)) return textResponse(VALID_PIN_CONTENT);
    if (target.startsWith(PIN_RECORD_URL)) {
      return jsonResponse({ code: 1, data: { id: CA_PIN_ID, globalMetaId: 'f'.repeat(64) } });
    }
    throw new Error(`unexpected fetch ${target}`);
  }, () => getNftCaRegistry());
  assert.equal(mismatched.status, 'unverified');
  assert.equal(mismatched.verified, false);
  assert.equal(mismatched.collections.length, 1);

  clearNftCaRegistryCache();
  const noRecord = await withFetchStub(async (url) => {
    const target = String(url);
    if (target.startsWith(CONTENT_URL)) return textResponse(VALID_PIN_CONTENT);
    if (target.startsWith(PIN_RECORD_URL)) return jsonResponse({ code: 0, message: 'not found' }, 404);
    throw new Error(`unexpected fetch ${target}`);
  }, () => getNftCaRegistry());
  assert.equal(noRecord.status, 'unverified');
  assert.equal(noRecord.verified, false);
  assert.equal(noRecord.creatorMetaId, null);
  assert.equal(noRecord.collections.length, 1);
});

test('resolveNftCaPinCreator returns the first 64-hex creator field and null on failure', async () => {
  const creator = await withFetchStub(async () => jsonResponse({
    code: 1,
    data: { id: CA_PIN_ID, address: '1MVCAddress', globalMetaId: 'e'.repeat(64) },
  }), () => resolveNftCaPinCreator(CA_PIN_ID));
  assert.equal(creator, 'e'.repeat(64));

  const none = await withFetchStub(async () => {
    throw new Error('network down');
  }, () => resolveNftCaPinCreator(CA_PIN_ID));
  assert.equal(none, null);
});

// ---------------------------------------------------------------------------
// TTL cache
// ---------------------------------------------------------------------------

test('isNftCaCacheFresh honors the TTL and refresh bypasses the cache', async () => {
  assert.equal(typeof NFT_CA_CACHE_TTL_MS, 'number');
  assert.ok(NFT_CA_CACHE_TTL_MS >= 60_000);
  assert.equal(isNftCaCacheFresh(1000, 1000 + NFT_CA_CACHE_TTL_MS - 1), true);
  assert.equal(isNftCaCacheFresh(1000, 1000 + NFT_CA_CACHE_TTL_MS), false);

  withCaPinEnv(CA_PIN_ID);
  clearNftCaRegistryCache();
  let fetchCalls = 0;
  const stub = async (url) => {
    const target = String(url);
    if (target.startsWith(CONTENT_URL)) return textResponse(VALID_PIN_CONTENT);
    if (target.startsWith(PIN_RECORD_URL)) {
      return jsonResponse({ code: 1, data: { id: CA_PIN_ID, globalMetaId: OFFICIAL_IDBOTS_METAID } });
    }
    throw new Error(`unexpected fetch ${target}`);
  };
  await withFetchStub(stub, async () => {
    fetchCalls = 0;
    globalThis.fetch = async (...args) => { fetchCalls += 1; return stub(...args); };
    const first = await getNftCaRegistry();
    const cached = await getNftCaRegistry();
    assert.equal(fetchCalls, 2, 'content + pin-record fetch exactly once while cached');
    assert.equal(cached.fetchedAt, first.fetchedAt);

    const refreshed = await getNftCaRegistry({ refresh: true });
    assert.ok(refreshed.fetchedAt >= first.fetchedAt);
    assert.equal(fetchCalls, 4, 'refresh bypasses the cache and refetches');
  });
  withCaPinEnv(null);
  clearNftCaRegistryCache();
});

test('buildEmptyNftCaRegistry carries the official root and no collections', () => {
  const registry = buildEmptyNftCaRegistry('empty-no-pin-configured', 'because');
  assert.equal(registry.verified, false);
  assert.deepEqual(registry.collections, []);
  assert.equal(registry.officialMetaId, OFFICIAL_IDBOTS_METAID);
  assert.equal(OFFICIAL_IDBOTS_METAID.length, 64);
});
