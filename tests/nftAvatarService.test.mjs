import test from 'node:test';
import assert from 'node:assert/strict';

// NFT avatar reference resolution (nft://mrc721/<itemPinId>): reference
// parsing, item-info → cover → pin-asset artwork chain, and fail-soft
// degradation when the item or its cover cannot be resolved — over a stubbed
// global fetch on the dist-electron build.

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;

const {
  buildNftAvatarReference,
  clearNftAvatarItemFactsCache,
  fetchLatestNftAvatarDeclaration,
  parseNftAvatarReference,
  prepareNftAvatarForIdentity,
  resolveLatestNftAvatarForIdentity,
  resolveNftAvatar,
} = await import('../dist-electron/main/services/nftAvatarService.js');
const { clearResolvedPinAssetCache } = await import('../dist-electron/main/services/pinAssetService.js');

const ITEM_PIN = `${'aa'.repeat(32)}i0`;
const COVER_PIN = `${'bb'.repeat(32)}i3`;
const COLLECTION_PIN = `${'cc'.repeat(32)}i0`;
const ITEM_INFO_URL = `https://so.metaid.io/api/mrc721/item/info?pinId=${ITEM_PIN}`;
const COVER_CONTENT_URL = `https://file.metaid.io/metafile-indexer/content/${COVER_PIN}`;
const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

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

function imageResponse() {
  return new Response(PNG_BYTES, {
    status: 200,
    headers: { 'content-type': 'image/png' },
  });
}

function resetCaches() {
  clearNftAvatarItemFactsCache();
  clearResolvedPinAssetCache();
}

// ---------------------------------------------------------------------------
// parseNftAvatarReference (pure)
// ---------------------------------------------------------------------------

test('parseNftAvatarReference accepts only nft://mrc721/<itemPinId> references', () => {
  assert.deepEqual(parseNftAvatarReference(`nft://mrc721/${ITEM_PIN}`), { itemPinId: ITEM_PIN });
  assert.deepEqual(parseNftAvatarReference(`  NFT://MRC721/${ITEM_PIN} `), { itemPinId: ITEM_PIN });
  assert.equal(parseNftAvatarReference('nft://metacontract/xyz'), null);
  assert.equal(parseNftAvatarReference('nft://mrc721/not-a-pin'), null);
  assert.equal(parseNftAvatarReference('nft://mrc721/'), null);
  assert.equal(parseNftAvatarReference('data:image/png;base64,AAAA'), null);
  assert.equal(parseNftAvatarReference('https://example.com/a.png'), null);
  assert.equal(parseNftAvatarReference(''), null);
  assert.equal(parseNftAvatarReference(null), null);
});

// ---------------------------------------------------------------------------
// Resolution chain + fail-soft degradation
// ---------------------------------------------------------------------------

test('resolveNftAvatar returns the cover artwork data URL plus collection facts', async () => {
  resetCaches();
  const result = await withFetchStub(async (url) => {
    const target = String(url);
    if (target === ITEM_INFO_URL) {
      return jsonResponse({
        code: 1,
        data: {
          itemPinId: ITEM_PIN,
          cover: `metafile://${COVER_PIN}`,
          collectionPinId: COLLECTION_PIN,
          collectionName: 'pixel-cats',
        },
      });
    }
    if (target.startsWith(COVER_CONTENT_URL)) return imageResponse();
    throw new Error(`unexpected fetch ${target}`);
  }, () => resolveNftAvatar({ itemPinId: ITEM_PIN }));

  assert.ok(result.avatarUrl, 'artwork should resolve');
  assert.ok(result.avatarUrl.startsWith('data:image/png;base64,'));
  assert.equal(result.nft.itemPinId, ITEM_PIN);
  assert.equal(result.nft.collectionPinId, COLLECTION_PIN);
  assert.equal(result.nft.collectionName, 'pixel-cats');
});

test('a missing item or missing cover degrades to null artwork with the reference facts', async () => {
  resetCaches();
  const miss = await withFetchStub(async () => jsonResponse({ code: 0, message: 'not found' }, 404), () =>
    resolveNftAvatar({ itemPinId: ITEM_PIN }));
  assert.equal(miss.avatarUrl, null);
  assert.equal(miss.nft.itemPinId, ITEM_PIN);
  assert.equal(miss.nft.collectionPinId, undefined);

  resetCaches();
  const noCover = await withFetchStub(async (url) => {
    const target = String(url);
    if (target === ITEM_INFO_URL) {
      return jsonResponse({ code: 1, data: { itemPinId: ITEM_PIN, collectionPinId: COLLECTION_PIN } });
    }
    throw new Error(`unexpected fetch ${target}`);
  }, () => resolveNftAvatar({ itemPinId: ITEM_PIN }));
  assert.equal(noCover.avatarUrl, null);
  assert.equal(noCover.nft.collectionPinId, COLLECTION_PIN, 'facts ride along without artwork');
});

test('a failed cover fetch stays fail-soft and facts still ride along', async () => {
  resetCaches();
  const result = await withFetchStub(async (url) => {
    const target = String(url);
    if (target === ITEM_INFO_URL) {
      return jsonResponse({
        code: 1,
        data: { itemPinId: ITEM_PIN, cover: `metafile://${COVER_PIN}`, collectionName: 'pixel-cats' },
      });
    }
    if (target.startsWith(COVER_CONTENT_URL)) return new Response('nope', { status: 500 });
    throw new Error(`unexpected fetch ${target}`);
  }, () => resolveNftAvatar({ itemPinId: ITEM_PIN }));
  assert.equal(result.avatarUrl, null);
  assert.equal(result.nft.collectionName, 'pixel-cats');
});

test('an indexer outage on item info resolves to null artwork without throwing', async () => {
  resetCaches();
  const result = await withFetchStub(async () => {
    throw new Error('network down');
  }, () => resolveNftAvatar({ itemPinId: ITEM_PIN }));
  assert.equal(result.avatarUrl, null);
  assert.equal(result.nft.itemPinId, ITEM_PIN);
});

// ---------------------------------------------------------------------------
// Renderer badge decision (pure presentation module, imported from src)
// ---------------------------------------------------------------------------

const { isCollectionCertified: rendererCertified } = await import(
  '../src/renderer/components/metabots/nftAvatarPresentation.js'
);

test('isCollectionCertified requires a verified registry AND the listed collection', () => {
  const pin = COLLECTION_PIN;
  const verifiedRegistry = {
    verified: true,
    collections: [{ collectionPinId: pin, collectionName: 'pixel-cats' }],
  };
  assert.equal(rendererCertified(verifiedRegistry, pin), true);
  assert.equal(rendererCertified(verifiedRegistry, pin.toUpperCase()), true, 'pin ids compare case-insensitively');
  assert.equal(rendererCertified(verifiedRegistry, 'other-pin'), false);

  // Unverified registries never certify, even when the collection is listed
  // (the CA pin creator could not be verified — no badges).
  const unverifiedRegistry = { verified: false, collections: [{ collectionPinId: pin }] };
  assert.equal(rendererCertified(unverifiedRegistry, pin), false);
  assert.equal(rendererCertified(null, pin), false);
  assert.equal(rendererCertified(verifiedRegistry, ''), false);
});


const OWNER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
const OTHER_OWNER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyS';
const GLOBAL_META_ID = 'idq1nftavatar0owner0example0000000000000000';

test('identity-bound NFT references round-trip owner and MetaID facts', () => {
  const reference = buildNftAvatarReference({ itemPinId: ITEM_PIN, ownerAddress: OWNER, globalMetaId: GLOBAL_META_ID });
  assert.deepEqual(parseNftAvatarReference(reference), {
    itemPinId: ITEM_PIN,
    ownerAddress: OWNER,
    globalMetaId: GLOBAL_META_ID,
  });
  assert.deepEqual(parseNftAvatarReference(`nft://mrc721/${ITEM_PIN}`), { itemPinId: ITEM_PIN });
});

test('prepareNftAvatarForIdentity resolves the cover and declaration only for the current wallet item', async () => {
  const prepared = await prepareNftAvatarForIdentity(
    { reference: `nft://mrc721/${ITEM_PIN}`, ownerAddress: OWNER, globalMetaId: GLOBAL_META_ID },
    {
      fetchItemInfo: async () => ({
        itemPinId: ITEM_PIN,
        ownerAddress: OWNER,
        collectionPinId: COLLECTION_PIN,
        collectionName: 'pixel-cats',
        cover: `metafile://${COVER_PIN}`,
      }),
      resolveArtwork: async () => 'data:image/png;base64,AAAA',
    },
  );
  assert.equal(prepared.avatarUrl, 'data:image/png;base64,AAAA');
  assert.deepEqual(parseNftAvatarReference(prepared.reference), {
    itemPinId: ITEM_PIN,
    ownerAddress: OWNER,
    globalMetaId: GLOBAL_META_ID,
  });
  assert.deepEqual(JSON.parse(prepared.declarationPayload), {
    protocol: 'mrc721',
    itemPinId: ITEM_PIN,
    ownerAddress: OWNER,
  });

  await assert.rejects(
    prepareNftAvatarForIdentity(
      { reference: `nft://mrc721/${ITEM_PIN}`, ownerAddress: OWNER, globalMetaId: GLOBAL_META_ID },
      {
        fetchItemInfo: async () => ({ itemPinId: ITEM_PIN, ownerAddress: OTHER_OWNER, cover: `metafile://${COVER_PIN}` }),
        resolveArtwork: async () => 'data:image/png;base64,AAAA',
      },
    ),
    /NFT_AVATAR_NOT_OWNED/,
  );
});

test('display verification follows the declaration and current holder, including transfer revocation', async () => {
  const reference = buildNftAvatarReference({ itemPinId: ITEM_PIN, ownerAddress: OWNER, globalMetaId: GLOBAL_META_ID });
  const parsed = parseNftAvatarReference(reference);
  const declaration = { itemPinId: ITEM_PIN, ownerAddress: OWNER, declarationPinId: `${'dd'.repeat(32)}i0` };
  let currentOwner = OWNER;
  const deps = {
    fetchItemInfo: async () => ({
      itemPinId: ITEM_PIN,
      ownerAddress: currentOwner,
      collectionPinId: COLLECTION_PIN,
      cover: `metafile://${COVER_PIN}`,
    }),
    fetchDeclaration: async () => declaration,
    resolveArtwork: async () => 'data:image/png;base64,AAAA',
  };
  const owned = await resolveNftAvatar(parsed, deps);
  assert.equal(owned.nft.ownershipVerified, true);
  assert.equal(owned.nft.declarationPinId, declaration.declarationPinId);

  currentOwner = OTHER_OWNER;
  const transferred = await resolveNftAvatar(parsed, deps);
  assert.equal(transferred.nft.ownershipVerified, false);
  assert.equal(transferred.avatarUrl, 'data:image/png;base64,AAAA', 'cover still renders as a plain image');

  const forged = await resolveNftAvatar(parsed, { ...deps, fetchDeclaration: async () => null });
  assert.equal(forged.nft.ownershipVerified, false);
});

test('declaration reads use the identity path and restore only a currently owned NFT profile', async () => {
  const declarationPinId = `${'dd'.repeat(32)}i0`;
  const declarationBody = { protocol: 'mrc721', itemPinId: ITEM_PIN, ownerAddress: OWNER };
  const declaration = await withFetchStub(async (url) => {
    const target = new URL(String(url));
    assert.equal(target.pathname, `/api/metaid/pin/list/${GLOBAL_META_ID}`);
    assert.equal(target.searchParams.get('path'), '/info/nftAvatar');
    assert.equal(target.searchParams.get('size'), '1');
    return jsonResponse({
      code: 0,
      data: {
        list: [{
          id: declarationPinId,
          address: OWNER,
          contentSummary: JSON.stringify(declarationBody),
        }],
      },
    });
  }, () => fetchLatestNftAvatarDeclaration({ globalMetaId: GLOBAL_META_ID, ownerAddress: OWNER }));
  assert.deepEqual(declaration, {
    itemPinId: declarationBody.itemPinId,
    ownerAddress: declarationBody.ownerAddress,
    declarationPinId,
  });

  const restored = await resolveLatestNftAvatarForIdentity(
    { globalMetaId: GLOBAL_META_ID, ownerAddress: OWNER },
    {
      fetchDeclaration: async () => declaration,
      fetchItemInfo: async () => ({ itemPinId: ITEM_PIN, ownerAddress: OWNER, cover: `metafile://${COVER_PIN}` }),
      resolveArtwork: async () => 'data:image/png;base64,AAAA',
    },
  );
  assert.equal(restored.nft.ownershipVerified, true);
  assert.equal(parseNftAvatarReference(restored.reference).globalMetaId, GLOBAL_META_ID);

  const notOwned = await resolveLatestNftAvatarForIdentity(
    { globalMetaId: GLOBAL_META_ID, ownerAddress: OWNER },
    {
      fetchDeclaration: async () => declaration,
      fetchItemInfo: async () => ({ itemPinId: ITEM_PIN, ownerAddress: OTHER_OWNER, cover: `metafile://${COVER_PIN}` }),
      resolveArtwork: async () => 'data:image/png;base64,AAAA',
    },
  );
  assert.equal(notOwned, null);
});
