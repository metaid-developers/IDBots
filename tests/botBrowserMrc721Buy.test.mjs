import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBotBrowserBridgeService,
} from '../src/main/services/botBrowserBridgeService.ts';

/**
 * browser.mrc721.buy payment-gate suite.
 *
 * Same door as botBrowserNftBuy.test.mjs, for the MRC-721 (pin-based)
 * atomic-swap listing credential: the bridge buyMrc721 signer runs ONLY for a
 * valid, still-pending, exact-match user confirmation of the NORMALIZED
 * listing — never on a bare page intent, a tampered listing, or a consumed
 * confirmation. The worker chain re-verifies chain truth (signature, outputs,
 * unspent, buyer binding) before any signature; keys stay in the host.
 */

function createMetabot(overrides = {}) {
  return {
    id: 7,
    wallet_id: 3,
    mvc_address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx',
    btc_address: 'btc-address',
    doge_address: 'doge-address',
    public_key: 'public-key',
    chat_public_key: 'chat-public-key',
    chat_public_key_pin_id: null,
    name: 'Alpha Bot',
    avatar: 'https://cdn.example/avatar.png',
    enabled: true,
    metaid: 'metaid-local',
    globalmetaid: 'IDQ1ABC',
    metabot_info_pinid: null,
    metabot_type: 'twin',
    created_by: 'owner',
    role: 'assistant',
    soul: 'soul',
    goal: null,
    bio: null,
    background: null,
    boss_id: null,
    boss_global_metaid: null,
    llm_id: null,
    tools: [],
    skills: [],
    allow_chat_skills: [],
    homepage: null,
    created_at: 1,
    updated_at: 2,
    wallet: { mnemonic: 'never leak me' },
    localPath: '/Users/tusm/private/avatar.png',
    capabilities: ['wallet'],
    ...overrides,
  };
}

function createStore(metabots = [createMetabot(), createMetabot({ id: 8, name: 'Beta Bot', globalmetaid: 'IDQ1BETA' })]) {
  return {
    getMetabotById(id) {
      return metabots.find((bot) => bot.id === id) ?? null;
    },
  };
}

const ITEM_PIN_ID = 'f5255da1fe98dda3f28051ebe646dc9060a905c13f35676eeb0c6fd08a0f47a8i0';
const ITEM_TXID = 'f5255da1fe98dda3f28051ebe646dc9060a905c13f35676eeb0c6fd08a0f47a8';
const PARTIAL_TX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const SELLER = '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za';
const BUYER = '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx';

function listingCredential(overrides = {}) {
  return {
    version: 1,
    kind: 'mrc721-atomic-swap',
    itemPinId: ITEM_PIN_ID,
    collectionPinId: 'c04dc62b95ad51a58d1e85497bfbe0e38fb9e7e66d4c9dc69f5c6f32ce17b4d2i0',
    outpoint: { txid: ITEM_TXID, vout: 0, satoshis: 546 },
    sellerAddress: SELLER,
    buyerAddress: BUYER,
    priceSats: 22000,
    partialTx: PARTIAL_TX,
    sigtype: 193,
    feeRate: 10,
    createdAt: 0,
    expiresAt: 0,
    ...overrides,
  };
}

function createBuyDeps(overrides = {}) {
  const calls = [];
  const displayFetches = [];
  const deps = {
    metabotStore: createStore(),
    buyMrc721: async (params) => {
      calls.push(params);
      return {
        txId: 'd'.repeat(64),
        itemPinId: params.listing.itemPinId,
        priceSats: params.listing.priceSats,
        sellerAddress: params.listing.sellerAddress,
        buyerAddress: params.listing.buyerAddress,
      };
    },
    fetchMrc721ItemDisplay: async (pinId) => {
      displayFetches.push(pinId);
      return {
        itemPinId: pinId,
        name: 'Pixel Sun #6734',
        collectionName: 'Pixel Sun',
        cover: 'metafile://c04dc62b95ad51a58d1e85497bfbe0e38fb9e7e66d4c9dc69f5c6f32ce17b4d2i0',
        ownerAddress: SELLER,
      };
    },
    now: () => 1_000,
    confirmationTtlMs: 60_000,
    createConfirmationId: (() => {
      let seq = 0;
      return () => `mrc721buy-${++seq}`;
    })(),
    createConfirmationToken: (() => {
      let seq = 0;
      return () => `opaque-token-${++seq}`;
    })(),
    ...overrides,
  };
  return { deps, calls, displayFetches };
}

function readManual(result) {
  assert.equal(result.ok, false);
  assert.equal(result.state, 'manual_action_required');
  assert.equal(result.data.confirmRequest.kind, 'mrc721-buy');
  return result.data;
}

const BUY_INPUT = {
  actorId: 'idbots-metabot-7',
  resourceUri: 'metaapp://markete0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
};

test('mrc721 buy: a bare page intent NEVER executes the signer — phase 1 only issues the confirmation card', async () => {
  const { deps, calls, displayFetches } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const result = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });

  const manual = readManual(result);
  assert.equal(calls.length, 0);
  assert.equal(calls[0], undefined);
  // The card carries the normalized listing and the jig display enrichment.
  assert.equal(manual.confirmation.listing.itemPinId, ITEM_PIN_ID);
  assert.equal(manual.confirmation.listing.priceSats, 22000);
  assert.equal(manual.confirmation.listing.sigtype, 193);
  assert.equal(manual.confirmation.display.name, 'Pixel Sun #6734');
  assert.equal(manual.confirmation.display.collectionName, 'Pixel Sun');
  assert.equal(manual.confirmation.display.imgUrl, 'metafile://c04dc62b95ad51a58d1e85497bfbe0e38fb9e7e66d4c9dc69f5c6f32ce17b4d2i0');
  assert.equal(manual.confirmation.display.sellerAddress, SELLER);
  assert.equal(manual.confirmation.display.buyerAddress, BUYER);
  assert.deepEqual(displayFetches, [ITEM_PIN_ID]);
  // The confirmRequest embeds the normalized listing plus the host confirmation.
  assert.equal(manual.confirmRequest.payload.itemPinId, ITEM_PIN_ID);
  assert.equal(manual.confirmRequest.payload.confirmed, true);
  assert.equal(manual.confirmRequest.payload.hostConfirmation.id, 'mrc721buy-1');
  assert.equal(manual.confirmRequest.payload.hostConfirmation.token, 'opaque-token-1');
});

test('mrc721 buy: the exact confirmRequest executes buyMrc721 once and returns the buy result', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const phaseTwo = await service.buyMrc721({
    ...BUY_INPUT,
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });

  assert.equal(phaseTwo.ok, true);
  assert.equal(phaseTwo.data.txid, 'd'.repeat(64));
  assert.equal(phaseTwo.data.itemPinId, ITEM_PIN_ID);
  assert.equal(phaseTwo.data.priceSats, 22000);
  assert.equal(phaseTwo.data.sellerAddress, SELLER);
  assert.equal(phaseTwo.data.buyerAddress, BUYER);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    metabotId: 7,
    listing: listingCredential(),
  });
});

test('mrc721 buy: a string credential (JSON) is accepted like the object form', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const result = await service.buyMrc721({ ...BUY_INPUT, payload: JSON.stringify(listingCredential()) });
  const confirmRequest = readManual(result).confirmRequest;
  assert.equal(confirmRequest.payload.itemPinId, ITEM_PIN_ID);
  assert.equal(calls.length, 0);
});

test('mrc721 buy: a jig display lookup failure degrades the card instead of blocking the intent', async () => {
  const { deps, calls } = createBuyDeps({
    fetchMrc721ItemDisplay: async () => {
      throw new Error('indexer timeout');
    },
  });
  const service = createBotBrowserBridgeService(deps);

  const result = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const manual = readManual(result);
  assert.equal(manual.confirmRequest.payload.itemPinId, ITEM_PIN_ID);
  assert.equal(manual.confirmation.display.name, undefined);
  assert.equal(manual.confirmation.display.sellerAddress, SELLER);
  assert.equal(manual.confirmation.display.buyerAddress, BUYER);
  assert.equal(calls.length, 0);
});

test('mrc721 buy: tampered confirm payloads (token, price, expiry, pin) are refused without executing', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const tamperedCases = [
    { ...confirmRequest.payload, hostConfirmation: { id: 'mrc721buy-1', token: 'wrong-token' } },
    { ...confirmRequest.payload, priceSats: 100 },
    { ...confirmRequest.payload, itemPinId: 'c'.repeat(64) + 'i0' },
    { ...confirmRequest.payload, partialTx: 'feefee' },
    { ...confirmRequest.payload, buyerAddress: '1' + '2'.repeat(30) },
    { ...confirmRequest.payload, confirmed: false },
  ];
  for (const payload of tamperedCases) {
    const result = await service.buyMrc721({ ...BUY_INPUT, payload });
    assert.equal(result.ok, false);
    // A tampered field that still parses (pin, partialTx, buyer) fails the
    // requestHash match; a price below the published floor is caught by the
    // credential parser itself. Both roads refuse before any execution.
    assert.ok(
      result.code === 'invalid_request' || result.code === 'invalid_params',
      `expected a refusal, got ${result.code}`,
    );
  }
  assert.equal(calls.length, 0);
});

test('mrc721 buy: a consumed confirmation cannot replay into a second purchase', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const first = await service.buyMrc721({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(first.ok, true);

  const replay = await service.buyMrc721({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_request');
  assert.equal(calls.length, 1);
});

test('mrc721 buy: an expired confirmation re-issues a fresh card instead of executing', async () => {
  let clock = 1_000;
  const { deps, calls } = createBuyDeps({ now: () => clock });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  clock += 60_001; // TTL is 60s in these deps.
  const result = await service.buyMrc721({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });

  const renewed = readManual(result);
  assert.notEqual(renewed.confirmRequest.payload.hostConfirmation.id, confirmRequest.payload.hostConfirmation.id);
  assert.equal(calls.length, 0);
});

test('mrc721 buy: a confirmation issued to one Bot cannot be spent by another Actor', async () => {
  const { deps, calls } = createBuyDeps({
    getHumanActor: () => ({ label: 'Owner', globalMetaId: 'idq1owner', signingAvailable: true }),
  });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const otherBot = await service.buyMrc721({
    actorId: 'idbots-metabot-8',
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });
  assert.equal(otherBot.ok, false);
  assert.equal(otherBot.code, 'invalid_request');

  const humanActor = await service.buyMrc721({
    actorId: 'idbots-account-1',
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });
  assert.equal(humanActor.ok, false);
  assert.equal(humanActor.code, 'unsupported_actor');
  assert.equal(calls.length, 0);
});

test('mrc721 buy: invalid listing credentials are refused before any confirmation or signer run', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const cases = [
    null,
    42,
    'not json at all',
    { foo: 1 },
    listingCredential({ kind: 'mrc721-atomic-swap-v2' }),
    listingCredential({ version: 2 }),
    listingCredential({ itemPinId: 'f5255da1i0' }),
    listingCredential({ sellerAddress: 'short' }),
    listingCredential({ buyerAddress: 'short' }),
    listingCredential({ priceSats: 0 }),
    listingCredential({ priceSats: 21999 }),
    listingCredential({ sigtype: 65 }),
    listingCredential({ partialTx: '' }),
    listingCredential({ partialTx: 'a'.repeat(100_001) }),
    listingCredential({ outpoint: { txid: 'f5255da1', vout: 0, satoshis: 546 } }),
    listingCredential({ outpoint: { txid: ITEM_TXID, vout: -1, satoshis: 546 } }),
    listingCredential({ outpoint: { txid: ITEM_TXID, vout: 0, satoshis: 0 } }),
  ];
  for (const payload of cases) {
    const result = await service.buyMrc721({ ...BUY_INPUT, payload });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_params');
  }
  assert.equal(calls.length, 0);
});

test('mrc721 buy: builds wire without deps.buyMrc721 as unsupported_method', async () => {
  const { deps, calls } = createBuyDeps();
  delete deps.buyMrc721;
  const service = createBotBrowserBridgeService(deps);
  const result = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_method');
  assert.equal(calls.length, 0);
});

test('mrc721 buy: worker failures (e.g. another buyer bound) surface as mrc721_buy_failed and consume the confirmation', async () => {
  const { deps, calls } = createBuyDeps({
    buyMrc721: async () => {
      calls.push('boom');
      throw new Error(
        'This listing pays the NFT to anotherAddress, not this session bot (1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx). '
        + 'A third party cannot take the purchase: output 0 is locked to the listed buyer. '
        + 'Nothing was signed.',
      );
    },
  });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyMrc721({ ...BUY_INPUT, payload: listingCredential() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const failed = await service.buyMrc721({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'mrc721_buy_failed');
  assert.match(failed.message, /locked to the listed buyer/);
  assert.equal(calls.length, 1);

  // The confirmation was consumed by the failed attempt — no silent retry.
  const replay = await service.buyMrc721({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_request');
});
