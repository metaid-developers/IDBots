import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createBotBrowserBridgeService,
} from '../src/main/services/botBrowserBridgeService.ts';

/**
 * browser.nft.buy payment-gate suite.
 *
 * The archived defect (pin://251cde23 line): wallet_nft_buy could run in a
 * worker session with the host executing it directly, bypassing the owner
 * confirmation card. The gate under test here is the host-side execution
 * door: the bridge buyNft signer runs ONLY for a valid, still-pending,
 * exact-match user confirmation — never on a bare page intent.
 */

function createMetabot(overrides = {}) {
  return {
    id: 7,
    wallet_id: 3,
    mvc_address: 'mvc-address',
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

const GENESIS = 'a'.repeat(64);
const CODEHASH = 'b'.repeat(40);
const SELL_TXID = 'c'.repeat(64);

function nftBuyPayload(overrides = {}) {
  return {
    genesis: GENESIS,
    codehash: CODEHASH,
    tokenIndex: '7898',
    priceSats: 100000,
    sellTxid: SELL_TXID,
    sellOutputIndex: 0,
    sellerAddress: '1SellerAddressFixture',
    collectionName: 'MetaBot Avatar',
    name: 'Avatar #7898',
    imgUrl: 'https://metaweb.example/avatar-7898.png',
    ...overrides,
  };
}

function createBuyDeps(overrides = {}) {
  const calls = [];
  const deps = {
    metabotStore: createStore(),
    buyNft: async (params) => {
      calls.push(params);
      return { txId: 'd'.repeat(64), fundingTxId: 'e'.repeat(64) };
    },
    now: () => 1_000,
    confirmationTtlMs: 60_000,
    createConfirmationId: (() => {
      let seq = 0;
      return () => `nftbuy-${++seq}`;
    })(),
    createConfirmationToken: (() => {
      let seq = 0;
      return () => `opaque-token-${++seq}`;
    })(),
    ...overrides,
  };
  return { deps, calls };
}

function readManual(result) {
  assert.equal(result.ok, false);
  assert.equal(result.state, 'manual_action_required');
  assert.equal(result.data.confirmRequest.kind, 'nft-buy');
  return result.data;
}

const BUY_INPUT = {
  actorId: 'idbots-metabot-7',
  resourceUri: 'metaapp://markete0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0',
};

test('nft buy: a bare page intent NEVER executes the signer — phase 1 only issues the confirmation card', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const result = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });

  const manual = readManual(result);
  assert.equal(calls.length, 0);
  // The card carries everything ABC renders: actor, four-tuple, display fields.
  assert.equal(manual.confirmation.actor.name, 'Alpha Bot');
  assert.equal(manual.confirmation.tokenIndex, '7898');
  assert.equal(manual.confirmation.priceSats, 100000);
  assert.equal(manual.confirmation.display.name, 'Avatar #7898');
  assert.equal(manual.confirmation.display.collectionName, 'MetaBot Avatar');
  assert.equal(manual.confirmation.display.imgUrl, 'https://metaweb.example/avatar-7898.png');
  assert.equal(manual.confirmation.sellUtxo.txId, SELL_TXID);
  assert.equal(manual.confirmation.sellUtxo.price, 100000);
  // The confirmRequest embeds the exact payload plus the host confirmation.
  assert.equal(manual.confirmRequest.payload.genesis, GENESIS);
  assert.equal(manual.confirmRequest.payload.hostConfirmation.id, 'nftbuy-1');
  assert.equal(manual.confirmRequest.payload.hostConfirmation.token, 'opaque-token-1');
});

test('nft buy: the exact confirmRequest executes buyNft once and returns both txids', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const phaseTwo = await service.buyNft({
    ...BUY_INPUT,
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });

  assert.equal(phaseTwo.ok, true);
  assert.equal(phaseTwo.data.txid, 'd'.repeat(64));
  assert.equal(phaseTwo.data.fundingTxid, 'e'.repeat(64));
  assert.equal(phaseTwo.data.tokenIndex, '7898');
  assert.equal(phaseTwo.data.genesis, GENESIS);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    metabotId: 7,
    genesis: GENESIS,
    codehash: CODEHASH,
    tokenIndex: '7898',
    sellUtxo: {
      txId: SELL_TXID,
      outputIndex: 0,
      sellerAddress: '1SellerAddressFixture',
      price: 100000,
    },
  });
});

test('nft buy: tampered confirm payloads (token, price, token index, genesis) are refused without executing', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const tamperedCases = [
    { ...confirmRequest.payload, hostConfirmation: { id: 'nftbuy-1', token: 'wrong-token' } },
    { ...confirmRequest.payload, priceSats: 1 },
    { ...confirmRequest.payload, tokenIndex: '9999' },
    { ...confirmRequest.payload, genesis: 'f'.repeat(64) },
  ];
  for (const payload of tamperedCases) {
    const result = await service.buyNft({ ...BUY_INPUT, payload });
    assert.equal(result.ok, false);
    // House invalidConfirmation() code (shared with pin write).
    assert.equal(result.code, 'invalid_request');
  }
  assert.equal(calls.length, 0);
});

test('nft buy: a consumed confirmation cannot replay into a second purchase', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const first = await service.buyNft({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(first.ok, true);

  const replay = await service.buyNft({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_request');
  assert.equal(calls.length, 1);
});

test('nft buy: an expired confirmation re-issues a fresh card instead of executing', async () => {
  let clock = 1_000;
  const { deps, calls } = createBuyDeps({
    now: () => clock,
  });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  clock += 60_001; // TTL is 60s in these deps.
  const result = await service.buyNft({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });

  const renewed = readManual(result);
  assert.notEqual(renewed.confirmRequest.payload.hostConfirmation.id, confirmRequest.payload.hostConfirmation.id);
  assert.equal(calls.length, 0);
});

test('nft buy: a confirmation issued to one Bot cannot be spent by another Actor', async () => {
  const { deps, calls } = createBuyDeps({
    getHumanActor: () => ({ label: 'Owner', globalMetaId: 'idq1owner', signingAvailable: true }),
  });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const otherBot = await service.buyNft({
    actorId: 'idbots-metabot-8',
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });
  assert.equal(otherBot.ok, false);
  assert.equal(otherBot.code, 'invalid_request');

  const humanActor = await service.buyNft({
    actorId: 'idbots-account-1',
    resourceUri: confirmRequest.resourceUri,
    payload: confirmRequest.payload,
  });
  assert.equal(humanActor.ok, false);
  assert.equal(humanActor.code, 'unsupported_actor');
  assert.equal(calls.length, 0);
});

test('nft buy: invalid four-tuples are refused before any confirmation or signer run', async () => {
  const { deps, calls } = createBuyDeps();
  const service = createBotBrowserBridgeService(deps);

  const cases = [
    nftBuyPayload({ genesis: 'not-hex' }),
    nftBuyPayload({ codehash: 'zz' }),
    nftBuyPayload({ tokenIndex: 'abc' }),
    nftBuyPayload({ priceSats: 0 }),
    nftBuyPayload({ priceSats: 1.5 }),
    nftBuyPayload({ imgUrl: 'javascript:alert(1)' }),
    nftBuyPayload({ sellTxid: 'short', sellOutputIndex: 0 }),
  ];
  for (const payload of cases) {
    const result = await service.buyNft({ ...BUY_INPUT, payload });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'invalid_params');
  }
  assert.equal(calls.length, 0);
});

test('nft buy: signer failures surface as nft_buy_failed and consume the confirmation', async () => {
  const { deps, calls } = createBuyDeps({
    buyNft: async () => {
      calls.push('boom');
      throw new Error('insufficient balance');
    },
  });
  const service = createBotBrowserBridgeService(deps);

  const phaseOne = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  const confirmRequest = readManual(phaseOne).confirmRequest;

  const failed = await service.buyNft({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'nft_buy_failed');
  assert.match(failed.message, /insufficient balance/);
  assert.equal(calls.length, 1);

  // The confirmation was consumed by the failed attempt — no silent retry.
  const replay = await service.buyNft({ ...BUY_INPUT, resourceUri: confirmRequest.resourceUri, payload: confirmRequest.payload });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'invalid_request');
});

test('nft buy: builds wire without deps.buyNft as unsupported_method', async () => {
  const service = createBotBrowserBridgeService({ metabotStore: createStore() });
  const result = await service.buyNft({ ...BUY_INPUT, payload: nftBuyPayload() });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unsupported_method');
});
