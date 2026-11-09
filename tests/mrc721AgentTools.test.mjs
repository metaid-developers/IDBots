import test from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// mrc721_* agent tools: registration, control wiring, precheck gating, and
// receipt formatting. Reads hit the indexer via global fetch (stubbed); writes
// go through the fake control.

const require = Module.createRequire(import.meta.url);
const {
  buildMrc721AgentTools,
  formatMrc721CollectionCreateResult,
  formatMrc721MintResult,
  formatMrc721PendingPinSheet,
  formatMrc721TransferResult,
  formatMrc721ItemDetail,
  formatMrc721Items,
  formatMrc721Transfers,
} = require('../dist-electron/main/libs/mrc721AgentTools.js');

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;
process.env.IDBOTS_METASO_API_BASE && delete process.env.IDBOTS_METASO_API_BASE;

const PINID = `${'ab'.repeat(32)}i0`;
const DESC_PINID = `${'cd'.repeat(32)}i0`;
const OTHER_DESC_PINID = `${'ef'.repeat(32)}i0`;
const BOT_ADDRESS = '1SessionBotAddress1234';
const OTHER_ADDRESS = '1OtherBotAddress5678';

const TOOL_NAMES = [
  'mrc721_collection_create',
  'mrc721_collection_update',
  'mrc721_mint',
  'mrc721_item_desc_batch',
  'mrc721_issue_estimate',
  'mrc721_transfer',
  'mrc721_sell',
  'mrc721_buy',
  'mrc721_sell_orders',
  'mrc721_balance',
  'mrc721_collections',
  'mrc721_item_info',
  'mrc721_collection_info',
  'mrc721_verify_holding',
  'mrc721_search_collections',
  'mrc721_sell_intent',
  'mrc721_sell_intent_cancel',
  'mrc721_sell_intents',
  'mrc721_market_intents',
];

function makeHarness(overrides = {}) {
  const calls = { collectionCreate: [], collectionUpdate: [], mint: [], itemDescBatch: [], transfer: [], sell: [], buy: [], sellIntentDeclare: [], sellIntentCancel: [], listSellIntents: [] };
  const control = {
    getMetabotMvcAddress: (id) => (id === 1 ? BOT_ADDRESS : id === 15 ? OTHER_ADDRESS : null),
    resolveMetabotIdByName: (name) => (name === 'AI_Sunny' ? 1 : null),
    itemDescBatch: async (input) => {
      calls.itemDescBatch.push(input);
      if (overrides.itemDescBatchError) throw overrides.itemDescBatchError;
      return {
        collectionName: input.collectionName,
        pinId: DESC_PINID,
        txids: ['tx1'],
        totalCost: 700,
        feeAssist: undefined,
        referencedPinIds: input.items.map((item) => item.pinId),
      };
    },
    collectionCreate: async (input) => {
      calls.collectionCreate.push(input);
      if (overrides.collectionCreateError) throw overrides.collectionCreateError;
      return {
        collectionName: input.collectionName,
        pinId: DESC_PINID,
        txids: ['tx1'],
        totalCost: 500,
      };
    },
    collectionUpdate: async (input) => {
      calls.collectionUpdate.push(input);
      if (overrides.collectionUpdateError) throw overrides.collectionUpdateError;
      return {
        collectionName: input.collectionName,
        pinId: DESC_PINID,
        txids: ['tx1'],
        totalCost: 400,
        updatedFields: input.cover ? ['cover'] : ['name'],
      };
    },
    mint: async (input) => {
      calls.mint.push(input);
      if (overrides.mintError) throw overrides.mintError;
      return {
        collectionName: input.collectionName,
        itemPath: input.itemPath ?? 'nft-auto01',
        pinId: PINID,
        itemDescPinId: input.name ? DESC_PINID : undefined,
        txids: ['tx1', 'tx2'],
        totalCost: 900,
      };
    },
    transfer: async (input) => {
      calls.transfer.push(input);
      if (overrides.transferError) throw overrides.transferError;
      return {
        txId: 'broadcast-txid',
        pinId: input.pinId,
        toAddress: input.toAddress,
        spentOutpoint: `${'ab'.repeat(32)}:0`,
        outputValue: 1,
      };
    },
    sell: async (input) => {
      calls.sell.push(input);
      if (overrides.sellError) throw overrides.sellError;
      return {
        listingJson: '{"kind":"mrc721-atomic-swap"}',
        itemPinId: input.itemPinId,
        buyerAddress: input.buyerAddress,
        priceSats: input.priceSats,
        outpoint: `${'ab'.repeat(32)}:0`,
      };
    },
    buy: async (input) => {
      calls.buy.push(input);
      if (overrides.buyError) throw overrides.buyError;
      return {
        txId: 'buy-txid',
        itemPinId: PINID,
        priceSats: 22000,
        sellerAddress: OTHER_ADDRESS,
        feeSats: 400,
        feeRateEffective: 1.2,
      };
    },
    listSellOrders: async () => overrides.sellOrders ?? [],
    sellIntentDeclare: async (input) => {
      calls.sellIntentDeclare.push(input);
      if (overrides.sellIntentError) throw overrides.sellIntentError;
      return {
        sellPinId: `${'se'.repeat(32)}i0`,
        txids: ['tx1'],
        totalCost: 500,
        intent: {
          protocol: 'mrc721-sell-intent',
          version: 1,
          active: true,
          itemPinId: input.itemPinId,
          collectionName: 'pixel-cats',
          sellerAddress: BOT_ADDRESS,
          priceHintSats: input.priceHintSats,
          acceptedCurrencies: input.acceptedCurrencies?.length ? input.acceptedCurrencies : ['space'],
          settlement: input.settlement?.length ? input.settlement : ['atomic-swap', 'escrow'],
          createdAt: Date.now(),
        },
      };
    },
    sellIntentCancel: async (input) => {
      calls.sellIntentCancel.push(input);
      if (overrides.sellIntentCancelError) throw overrides.sellIntentCancelError;
      return {
        sellPinId: `${'se'.repeat(32)}i0`,
        txids: ['tx1'],
        totalCost: 300,
        intent: { protocol: 'mrc721-sell-intent', version: 1, active: false, itemPinId: input.itemPinId, sellerAddress: BOT_ADDRESS, acceptedCurrencies: ['space'], settlement: ['atomic-swap', 'escrow'], createdAt: Date.now() },
      };
    },
    listSellIntents: async (input) => {
      calls.listSellIntents.push(input);
      return overrides.sellIntents ?? [];
    },
  };
  const tools = buildMrc721AgentTools({
    tool: (name, description, schema, handler) => ({ name, description, schema, handler }),
    control,
    sessionId: 'sess_test',
    resolveMetabotId: overrides.resolveMetabotId ?? (() => 1),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  return { calls, byName, control };
}

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

test('registers the R6 mrc721_* tools, including atomic-swap trade', () => {
  const { byName } = makeHarness();
  for (const name of TOOL_NAMES) {
    assert.ok(byName[name], `${name} should be registered`);
    assert.ok(String(byName[name].description).includes('MRC-721'), `${name} description names the lineage`);
  }
});

test('mrc721_collection_create refuses the session bot\'s own duplicate registration before any write', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [collectionRow()], total: 1 } })],
    ]),
    () => byName.mrc721_collection_create.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already issued by this MetaBot/);
  assert.match(result.content[0].text, /registers once/);
  assert.match(result.content[0].text, /mrc721_mint|mrc721_collection_update/);
  assert.equal(calls.collectionCreate.length, 0);
});

test('mrc721_collection_create proceeds against a foreign same-name album with a shared-name note', async () => {
  const { calls, byName } = makeHarness();
  const foreignRow = collectionRow({ pinid: OTHER_DESC_PINID, createAddress: OTHER_ADDRESS, createMetaId: 'idforeignbot' });
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', (raw) => {
        if (String(raw).includes('issuer=')) return jsonResponse({ code: 1, data: { list: [], total: 0 } });
        return jsonResponse({ code: 1, data: { list: [foreignRow], total: 1 } });
      }],
    ]),
    () => byName.mrc721_collection_create.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /shared with an independent album/);
  assert.match(result.content[0].text, /distinguished by collectionid/);
  assert.match(result.content[0].text, new RegExp(OTHER_DESC_PINID));
  assert.equal(calls.collectionCreate.length, 1);
});

test('mrc721_collection_create broadcasts on a free name and renders the receipt', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [], total: 0 } })],
    ]),
    () => byName.mrc721_collection_create.handler({
      collection_name: 'pixel-cats',
      total_supply: 100,
      royalty_rate: 5,
      wait_ms: 0,
    }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /collection_desc pin broadcast/);
  assert.match(result.content[0].text, new RegExp(DESC_PINID));
  assert.doesNotMatch(result.content[0].text, /shared with an independent album/);
  assert.equal(calls.collectionCreate.length, 1);
  assert.deepEqual(
    { ...calls.collectionCreate[0], metadata: undefined },
    {
      metabotId: 1,
      collectionName: 'pixel-cats',
      name: undefined,
      totalSupply: 100,
      royaltyRate: 5,
      desc: undefined,
      website: undefined,
      cover: undefined,
      metadata: undefined,
      network: 'mvc',
    },
  );
});

test('mrc721_collection_create proceeds with a warning when the precheck search is unavailable', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    async () => { throw new Error('connection refused'); },
    () => byName.mrc721_collection_create.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /precheck unavailable/);
  assert.equal(calls.collectionCreate.length, 1);
});

test('mrc721_collection_create validates collection_name locally', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_collection_create.handler({ collection_name: 'Bad Name!', wait_ms: 0 });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /lowercase/);
  assert.equal(calls.collectionCreate.length, 0);
});

test('mrc721_collection_update forwards overrides and renders the modify receipt', async () => {
  const { calls, byName } = makeHarness();
  const coverPinId = `${'ef'.repeat(32)}i1`;
  const result = await byName.mrc721_collection_update.handler({
    collection_name: 'pixel-cats',
    cover: coverPinId,
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /operation=modify pin at the collection_desc path/);
  assert.match(result.content[0].text, /updated fields: cover/);
  assert.match(result.content[0].text, /mrc721_collection_info/);
  assert.deepEqual(calls.collectionUpdate[0], {
    metabotId: 1,
    collectionName: 'pixel-cats',
    name: undefined,
    desc: undefined,
    website: undefined,
    cover: coverPinId,
    metadata: undefined,
    network: 'mvc',
  });
});

test('mrc721_collection_update surfaces issuer and index errors from the control', async () => {
  const { byName } = makeHarness({ collectionUpdateError: new Error('only the issuing MetaBot can update a collection') });
  const result = await byName.mrc721_collection_update.handler({ collection_name: 'pixel-cats', name: 'New' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /only the issuing MetaBot/);
});

test('mrc721_collection_update refuses no-op calls before touching the control', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_collection_update.handler({ collection_name: 'pixel-cats' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /nothing to update/);
  assert.equal(calls.collectionUpdate.length, 0);
});

test('mrc721_collection_info shows the modify history when the indexer provides it', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(async (url) => {
    if (String(url).includes('/api/mrc721/collection/info')) {
      return jsonResponse({
        code: 1,
        data: {
          collectionName: 'pixel-cats',
          name: 'Pixel Cats',
          cover: 'metafile://cover1',
          totalnum: 0,
          pinid: DESC_PINID,
          modifyHistory: ['modifypin1i0', 'modifypin2i0'],
        },
      });
    }
    return jsonResponse({ code: 1, data: { list: [] } });
  }, () => byName.mrc721_collection_info.handler({ name: 'pixel-cats' }));
  const text = result.content[0].text;
  assert.match(text, /- cover: metafile:\/\/cover1/);
  assert.match(text, /modify history \(2\): modifypin1i0, modifypin2i0/);
});

test('mrc721_mint refuses a foreign-issued collection before spending fees', async () => {
  const { calls, byName } = makeHarness();
  const foreignRow = collectionRow({ pinid: OTHER_DESC_PINID, createAddress: OTHER_ADDRESS, createMetaId: 'idforeignbot' });
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', (raw) => {
        if (String(raw).includes('issuer=')) return jsonResponse({ code: 1, data: { list: [], total: 0 } });
        return jsonResponse({ code: 1, data: { list: [foreignRow], total: 1 } });
      }],
    ]),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /issued by another issuer/);
  assert.match(result.content[0].text, /never collected/);
  assert.match(result.content[0].text, /mrc721_transfer/);
  assert.equal(calls.mint.length, 0);
});

test('mrc721_mint reads the supply precheck from the session bot\'s own album row', async () => {
  const { calls, byName } = makeHarness();
  const exhausted = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({
        code: 1,
        data: { list: [collectionRow({ totalnum: 10, mintedCount: 10, totalSupply: 10 })], total: 1 },
      })],
    ]),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(exhausted.isError, true);
  assert.match(exhausted.content[0].text, /exhausted \(10\/10 minted\)/);
  assert.equal(calls.mint.length, 0);

  const slotsLeft = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({
        code: 1,
        data: { list: [collectionRow({ totalnum: 3, mintedCount: 3, totalSupply: 10 })], total: 1 },
      })],
    ]),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(slotsLeft.isError, undefined);
  assert.equal(calls.mint.length, 1);
});

test('mrc721_mint warns with issuer-only wording when the name is not registered yet', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [], total: 0 } })],
    ]),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /not indexed yet/);
  assert.match(result.content[0].text, /once this MetaBot's collection under this name registers/);
  assert.match(result.content[0].text, /never indexes/);
  assert.equal(calls.mint.length, 1);
});

test('mrc721_mint renders the item receipt with the item_desc pin', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({
        code: 1,
        data: { list: [collectionRow({ totalnum: 0, mintedCount: 0, totalSupply: -1 })], total: 1 },
      })],
    ]),
    () => byName.mrc721_mint.handler({
      collection_name: 'pixel-cats',
      item_path: 'nft-01',
      name: 'Cat #1',
      wait_ms: 0,
    }),
  );
  assert.match(result.content[0].text, /NFT minted into "pixel-cats"/);
  assert.match(result.content[0].text, new RegExp(PINID));
  assert.match(result.content[0].text, /item_desc pinId/);
});

test('mrc721_transfer resolves local bot ids and forwards to the control', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_transfer.handler({ pin_id: PINID, to: '15' });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /broadcast on-chain/);
  assert.match(result.content[0].text, /broadcast-txid/);
  assert.deepEqual(calls.transfer[0], { metabotId: 1, pinId: PINID, toAddress: OTHER_ADDRESS });
});

test('mrc721_transfer requires a session bot and a resolvable recipient', async () => {
  const { calls, byName } = makeHarness({ resolveMetabotId: () => undefined });
  const noSession = await byName.mrc721_transfer.handler({ pin_id: PINID, to: '15' });
  assert.equal(noSession.isError, true);
  assert.match(noSession.content[0].text, /could not determine which MetaBot/);
  assert.equal(calls.transfer.length, 0);

  const { byName: byName2 } = makeHarness();
  const badTarget = await byName2.mrc721_transfer.handler({ pin_id: PINID, to: 'nobody-here' });
  assert.equal(badTarget.isError, true);
  assert.match(badTarget.content[0].text, /neither a local MetaBot id\/name nor an MVC address/);
});

test('mrc721_balance batches metabot ids and renders grouped holdings', async () => {
  const { byName } = makeHarness();
  const items = [
    { itemPinId: PINID, collectionName: 'pixel-cats', name: 'Cat #1', creatorMinted: true, genesisChainName: 'mvc' },
    { itemPinId: DESC_PINID, collectionName: 'pixel-cats', genesisChainName: 'mvc' },
  ];
  const urls = [];
  const result = await withFetchStub(async (url) => {
    urls.push(String(url));
    return jsonResponse({ code: 1, data: { list: items } });
  }, () => byName.mrc721_balance.handler({ metabot_ids: [1, 15] }));
  const text = result.content[0].text;
  assert.match(text, /metabot_id 1/);
  assert.match(text, /metabot_id 15/);
  assert.match(text, /2 MRC-721 item\(s\)/);
  assert.match(text, /\[creator-minted\]/);
  assert.match(text, /\(unnamed — item_desc not indexed\)/);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /\/api\/mrc721\/address\/item\?address=/);
});

test('mrc721_balance resolves a collection_name filter through the indexer', async () => {
  const { byName } = makeHarness();
  const urls = [];
  await withFetchStub(async (url) => {
    urls.push(String(url));
    if (String(url).includes('/api/mrc721/collection/info')) {
      return jsonResponse({ code: 1, data: { collectionName: 'pixel-cats', pinid: DESC_PINID } });
    }
    return jsonResponse({ code: 1, data: { list: [] } });
  }, () => byName.mrc721_balance.handler({ address: BOT_ADDRESS, collection_name: 'pixel-cats' }));
  assert.ok(urls.some((url) => url.includes(`pinId=${DESC_PINID}`)), 'holder query carries the collectionid filter');
});

test('mrc721_collections renders mine and market scopes', async () => {
  const { byName } = makeHarness();
  const mine = await withFetchStub(
    async () => jsonResponse({ code: 1, data: { list: [{ collectionName: 'pixel-cats', name: 'Pixel Cats', totalnum: 3, totalSupply: 100, royaltyRate: 5, createMetaId: 'meta1', pinid: DESC_PINID, genesisChainName: 'mvc' }] } }),
    () => byName.mrc721_collections.handler({ scope: 'mine', address: BOT_ADDRESS }),
  );
  assert.match(mine.content[0].text, /Pixel Cats \| 3\/100 minted \| royalty 5%/);
  assert.match(mine.content[0].text, /issuer meta1/);

  const market = await withFetchStub(
    async () => jsonResponse({ code: 1, data: { list: [{ collectionName: 'dog-pics', name: 'Dog Pics', totalnum: 1 }], cursor: 'next-1' } }),
    () => byName.mrc721_collections.handler({ scope: 'market' }),
  );
  assert.match(market.content[0].text, /market page/);
  assert.match(market.content[0].text, /next cursor: next-1/);
});

test('mrc721_item_info renders the full sheet with verify + transfers', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(async (url) => {
    const path = String(url);
    if (path.includes('/api/mrc721/item/info')) {
      return jsonResponse({
        code: 1,
        data: {
          itemPinId: PINID,
          collectionName: 'pixel-cats',
          number: 3,
          name: 'Cat #1',
          ownerAddress: BOT_ADDRESS,
          output: `${'ab'.repeat(32)}:0`,
          outputValue: 1,
          genesisChainName: 'mvc',
          genesisHeight: 123,
          transferCount: 1,
        },
      });
    }
    if (path.includes('/api/mrc721/item/verify')) {
      return jsonResponse({ code: 1, data: { collected: true, creatorMinted: true, collectionid: DESC_PINID } });
    }
    return jsonResponse({ code: 1, data: { list: [{ fromAddress: BOT_ADDRESS, toAddress: OTHER_ADDRESS, txId: 't1', time: 0 }] } });
  }, () => byName.mrc721_item_info.handler({ pin_id: PINID }));
  const text = result.content[0].text;
  assert.match(text, /MRC-721 item/);
  assert.match(text, /current owner/);
  assert.match(text, /OFFICIAL mint \(creator-minted\)/);
  assert.match(text, /1 transfer\(s\)/);
  assert.match(text, /view link/);
});

test('mrc721_item_info errors clearly on unindexed items', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    async () => jsonResponse({ code: 0, message: 'not found' }),
    () => byName.mrc721_item_info.handler({ pin_id: PINID }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not in the index/);
});

test('mrc721_collection_info renders registration facts and items', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(async (url) => {
    const path = String(url);
    if (path.includes('/api/mrc721/collection/info')) {
      return jsonResponse({
        code: 1,
        data: { collectionName: 'pixel-cats', name: 'Pixel Cats', totalnum: 2, totalSupply: 100, royaltyRate: 5, pinid: DESC_PINID, genesisChainName: 'mvc' },
      });
    }
    return jsonResponse({ code: 1, data: { list: [{ itemPinId: PINID, number: 1, name: 'Cat #1', ownerAddress: BOT_ADDRESS, creatorMinted: true }] } });
  }, () => byName.mrc721_collection_info.handler({ name: 'pixel-cats' }));
  const text = result.content[0].text;
  assert.match(text, /Pixel Cats \| 2\/100 minted/);
  assert.match(text, /items \(1 shown\)/);
  assert.match(text, /#1 Cat #1/);
});

// ---------------------------------------------------------------------------
// Formatting helpers (pure)
// ---------------------------------------------------------------------------

test('formatMrc721* helpers render receipts and sheets', () => {
  const createReceipt = formatMrc721CollectionCreateResult({
    collectionName: 'pixel-cats',
    pinId: DESC_PINID,
    txids: ['tx1'],
    totalCost: 500,
    confirmation: { hit: null },
    waitMs: 30000,
  });
  assert.match(createReceipt, /mrc721_collection_info/);
  // Zero-conf receipt: an unindexed registration is expected, never a wait.
  assert.match(createReceipt, /EXPECTED/);
  assert.match(createReceipt, /Do NOT wait, poll, or sleep/);
  assert.doesNotMatch(createReceipt, /before minting/, 'no desc-first "verify before minting" wording');
  assert.doesNotMatch(createReceipt, /first-registration-wins/i);

  const sharedReceipt = formatMrc721CollectionCreateResult({
    collectionName: 'pixel-cats',
    pinId: DESC_PINID,
    txids: ['tx1'],
    totalCost: 500,
    confirmation: { hit: null },
    waitMs: 30000,
    sharedNameNote: 'the name "pixel-cats" is shared with an independent album (collectionid abc…i0, issuer 1Other)',
  });
  assert.match(sharedReceipt, /- note: the name "pixel-cats" is shared with an independent album/);

  const mintReceipt = formatMrc721MintResult({
    collectionName: 'pixel-cats',
    itemPath: 'nft-01',
    pinId: PINID,
    txids: ['tx1'],
    totalCost: 900,
    confirmation: { hit: { number: 4, collectionName: 'pixel-cats' } },
    waitMs: 30000,
  });
  assert.match(mintReceipt, /COLLECTED as #4/);

  const transferReceipt = formatMrc721TransferResult({
    txId: 'broadcast-txid',
    pinId: PINID,
    toAddress: OTHER_ADDRESS,
    spentOutpoint: `${'ab'.repeat(32)}:0`,
    outputValue: 1,
  });
  assert.match(transferReceipt, /no protocol message/);

  const detail = formatMrc721ItemDetail({
    item: { itemPinId: PINID, collectionName: 'pixel-cats', ownerMetaId: 'meta1', output: `${'ab'.repeat(32)}:0`, outputValue: 1 },
    verify: { collected: true, creatorMinted: false },
    transfers: [],
  });
  assert.match(detail, /not indexed under issuer-only rules/);
  assert.match(detail, /no transfers recorded yet/);

  const items = formatMrc721Items([
    { itemPinId: PINID, collectionName: 'pixel-cats', name: 'A' },
    { itemPinId: DESC_PINID, collectionName: 'dog-pics' },
  ]);
  assert.match(items, /pixel-cats: 1 item\(s\)/);
  assert.match(items, /dog-pics: 1 item\(s\)/);

  const transfers = formatMrc721Transfers([{ fromAddress: BOT_ADDRESS, toAddress: OTHER_ADDRESS, txId: 't1' }]);
  assert.match(transfers, /1 transfer\(s\)/);
});

test('mrc721 transfer history renders manapi epoch-seconds times as real dates', () => {
  // 1794190970 is the exact value MetaSo cited in the 1970-date bug report:
  // epoch seconds = 2026-11-09T02:22:50Z (10:22:50 Beijing, UTC+8); treating
  // it as ms used to render 1970-01-21.
  const rendered = formatMrc721Transfers([
    { fromAddress: BOT_ADDRESS, toAddress: OTHER_ADDRESS, txId: 't1', time: 1794190970 },
  ]);
  assert.match(rendered, /2026-11-09T02:22:50\.000Z/);
  assert.doesNotMatch(rendered, /1970-01-21/);
});

test('mrc721_sell refuses a price under the 22000 sat floor before any wallet work', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_sell.handler({
    item_pin_id: PINID,
    buyer_address: OTHER_ADDRESS,
    price_sats: 21999,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /22000/);
  assert.equal(calls.sell.length, 0);
});

test('mrc721_sell returns the listing JSON and tells the caller to hand it to the buyer', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_sell.handler({
    item_pin_id: PINID,
    buyer_address: OTHER_ADDRESS,
    price_sats: 22000,
  });
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Give the listing JSON/);
  assert.match(result.content[0].text, /mrc721-atomic-swap/);
  assert.equal(calls.sell.length, 1);
  assert.equal(calls.sell[0].priceSats, 22000);
});

test('mrc721_buy surfaces a teaching error and does not hide the failed check', async () => {
  const { calls, byName } = makeHarness({
    buyError: new Error('MRC-721 listing failed check 4 (unspent): outpoint is already spent.'),
  });
  const result = await byName.mrc721_buy.handler({ listing: { kind: 'mrc721-atomic-swap' } });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already spent/);
  assert.equal(calls.buy.length, 1);
});

test('mrc721_sell_orders lists a local listing with its invalid reason', async () => {
  const { byName } = makeHarness({
    sellOrders: [{
      id: 'order1',
      status: 'invalid',
      reason: 'MRC-721 listing failed check 3 (ownership): the NFT is no longer in the seller\'s hand.',
      itemPinId: PINID,
      buyerAddress: OTHER_ADDRESS,
      priceSats: 22000,
      outpoint: `${'ab'.repeat(32)}:0`,
    }],
  });
  const result = await byName.mrc721_sell_orders.handler({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /invalid order1/);
  assert.match(result.content[0].text, /no longer in the seller's hand/);
});

// ---------------------------------------------------------------------------
// P0: mrc721_verify_holding (S4 hard holder gate) + mrc721_search_collections
// (S1 keyword/issuer search) + MetaID read targets (S8)
// ---------------------------------------------------------------------------

const METAID = '2eb21238314aca030b67ed7b7c4c613f2e8cb7e42ee9140589a4df9da3854aa2';

function holderItem(overrides = {}) {
  return {
    itemPinId: PINID,
    collectionName: 'pixel-cats',
    number: 5,
    burned: false,
    ...overrides,
  };
}

function collectionRow(overrides = {}) {
  return {
    collectionName: 'pixel-cats',
    name: 'Pixel Cats',
    totalSupply: 10,
    totalnum: 3,
    royaltyRate: 5,
    desc: 'A pixel cat album for tests',
    pinid: DESC_PINID,
    createAddress: BOT_ADDRESS,
    createMetaId: METAID,
    createTime: 1793537073,
    genesisChainName: 'mvc',
    ...overrides,
  };
}

function manapiDispatch(routes) {
  return async (url) => {
    const raw = String(url);
    for (const [pattern, responder] of routes) {
      if (raw.includes(pattern)) return responder(raw);
    }
    throw new Error(`unexpected fetch: ${raw}`);
  };
}

test('mrc721_verify_holding returns HOLDS with the item list for a live holding', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [collectionRow()], total: 1 } })],
      ['/api/mrc721/address/item', () => jsonResponse({ code: 1, data: { list: [holderItem()] } })],
    ]),
    () => byName.mrc721_verify_holding.handler({ names: ['AI_Sunny'], collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /# metabot_id 1/);
  assert.match(result.content[0].text, /verdict: HOLDS \(1 item\(s\)\)/);
  assert.match(result.content[0].text, new RegExp(PINID));
  assert.match(result.content[0].text, /\(#5\)/);
});

test('mrc721_verify_holding returns NOT_HOLDING for an empty live holder view', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [collectionRow()], total: 1 } })],
      ['/api/mrc721/address/item', () => jsonResponse({ code: 1, data: { list: [holderItem({ burned: true })] } })],
    ]),
    () => byName.mrc721_verify_holding.handler({ address: OTHER_ADDRESS, collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /verdict: NOT_HOLDING/);
});

test('mrc721_verify_holding refuses an ambiguous name and lists the candidate collectionids', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({
        code: 1,
        data: {
          list: [collectionRow(), collectionRow({ pinid: OTHER_DESC_PINID, createAddress: OTHER_ADDRESS })],
          total: 2,
        },
      })],
    ]),
    () => byName.mrc721_verify_holding.handler({ names: ['AI_Sunny'], collection_name: 'pixel-cats' }),
  );
  // Distinguishable from NOT_HOLDING on purpose: the gate must not read an
  // ambiguous name as "no badge".
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /lookup failed/);
  assert.match(result.content[0].text, /ambiguous/);
  assert.match(result.content[0].text, new RegExp(DESC_PINID));
  assert.match(result.content[0].text, new RegExp(OTHER_DESC_PINID));
  assert.match(result.content[0].text, /collectionPinId/);
  assert.doesNotMatch(result.content[0].text, /NOT_HOLDING/);
});

test('mrc721_verify_holding reports an unindexed collection as a lookup failure, never as NOT_HOLDING', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [], total: 0 } })],
      ['/api/mrc721/collection/info', () => jsonResponse({ code: 0, message: 'not found' })],
    ]),
    () => byName.mrc721_verify_holding.handler({ names: ['AI_Sunny'], collection_name: 'ghost-cats' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /lookup failed/);
  assert.match(result.content[0].text, /not indexed/);
  assert.doesNotMatch(result.content[0].text, /NOT_HOLDING/);
});

test('mrc721_verify_holding resolves an external MetaID to its holder address', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['metafile-indexer/api/v1/info/metaid', () => jsonResponse({ code: 1, data: { address: OTHER_ADDRESS } })],
      ['/api/mrc721/address/item', () => jsonResponse({ code: 1, data: { list: [holderItem()] } })],
    ]),
    () => byName.mrc721_verify_holding.handler({ metaid: METAID, collection_pinid: DESC_PINID }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(OTHER_ADDRESS));
  assert.match(result.content[0].text, /verdict: HOLDS/);
});

test('mrc721_verify_holding requires a collection to check against', async () => {
  const { byName } = makeHarness();
  const result = await byName.mrc721_verify_holding.handler({ names: ['AI_Sunny'] });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires collection_name or collection_pinid/);
});

test('mrc721_search_collections matches a keyword against name and returns the description', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/pageList', () => jsonResponse({
        code: 1,
        data: { list: [collectionRow(), collectionRow({ collectionName: 'dog-pics', name: 'Dog Pics', desc: 'dogs only' })], },
      })],
    ]),
    () => byName.mrc721_search_collections.handler({ keyword: 'pixel' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /scanned 2 registered collection\(s\), matched: 1/);
  assert.match(result.content[0].text, /Pixel Cats/);
  assert.match(result.content[0].text, /A pixel cat album for tests/);
});

test('mrc721_search_collections filters by issuer via the local bot name', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/pageList', () => jsonResponse({
        code: 1,
        data: { list: [collectionRow(), collectionRow({ collectionName: 'other-cats', createAddress: OTHER_ADDRESS })] },
      })],
    ]),
    () => byName.mrc721_search_collections.handler({ issuer: 'AI_Sunny' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(`issuer: ${BOT_ADDRESS}`.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&')));
  assert.match(result.content[0].text, /matched: 1/);
});

test('mrc721_search_collections computes minted counts when supply_state is requested', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/pageList', () => jsonResponse({ code: 1, data: { list: [collectionRow()] } })],
      ['/api/mrc721/collection/items/pageList', () => jsonResponse({
        code: 1,
        data: { list: [holderItem(), holderItem(), holderItem()] },
      })],
    ]),
    () => byName.mrc721_search_collections.handler({ issuer: 'AI_Sunny', supply_state: true }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /minted: 3\/10 \(slots remaining\)/);
});

test('mrc721_search_collections requires a keyword or an issuer', async () => {
  const { byName } = makeHarness();
  const result = await byName.mrc721_search_collections.handler({});
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /requires a keyword or an issuer/);
});

test('mrc721_balance resolves a MetaID read target and renders its holdings', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['metafile-indexer/api/v1/info/metaid', () => jsonResponse({ code: 1, data: { address: OTHER_ADDRESS } })],
      ['/api/mrc721/address/item', () => jsonResponse({ code: 1, data: { list: [holderItem()] } })],
    ]),
    () => byName.mrc721_balance.handler({ metaid: METAID }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, new RegExp(OTHER_ADDRESS));
  assert.match(result.content[0].text, /pixel-cats: 1 item\(s\)/);
});

test('mrc721_balance reports an unresolvable MetaID instead of silently dropping it', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    async () => jsonResponse({ code: 1, data: {} }),
    () => byName.mrc721_balance.handler({ metaid: METAID }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /could not resolve MetaID/);
});

test('mrc721_search_collections scans multiple pages and reports truncation honestly', async () => {
  const { byName } = makeHarness();
  let page = 0;
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/pageList', () => {
        page += 1;
        return jsonResponse({
          code: 1,
          data: page === 1
            ? { list: [collectionRow()], cursor: 'next-page-token' }
            : { list: [collectionRow({ collectionName: 'late-cats', name: 'Late Cats' })], cursor: 'still-more' },
        });
      }],
    ]),
    () => byName.mrc721_search_collections.handler({ keyword: 'cats', max_pages: 2 }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /scanned 2 registered collection\(s\) \(page cap hit/);
  assert.match(result.content[0].text, /matched: 2/);
  assert.match(result.content[0].text, /Late Cats/);
});

// ---------------------------------------------------------------------------
// Sell-intent protocol tools (NFT 售): declare / cancel / list + sell_orders
// collection filter
// ---------------------------------------------------------------------------

const SELL_PIN_ID = `${'se'.repeat(32)}i0`;

test('mrc721_sell_intent declares via control and appends a selling card', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/item/info', () => jsonResponse({ code: 1, data: { itemPinId: PINID, collectionName: 'pixel-cats', ownerAddress: BOT_ADDRESS } })],
      ['/api/mrc721/collection/info', () => jsonResponse({ code: 1, data: collectionRow() })],
    ]),
    () => byName.mrc721_sell_intent.handler({
      item_pin_id: PINID,
      price_hint_sats: 30000,
      accepted_currencies: ['space', 'fiat:CNY'],
      note: 'first come first served',
    }),
  );
  assert.equal(result.isError, undefined);
  assert.equal(calls.sellIntentDeclare.length, 1);
  assert.equal(calls.sellIntentDeclare[0].itemPinId, PINID);
  assert.equal(calls.sellIntentDeclare[0].priceHintSats, 30000);
  assert.match(result.content[0].text, /sell intent declared on-chain/);
  assert.match(result.content[0].text, new RegExp(SELL_PIN_ID));
  assert.match(result.content[0].text, /space, fiat:CNY/);
  assert.match(result.content[0].text, /"action":"selling"/);
  assert.match(result.content[0].text, /"hostStamp":"v1\./);
});

test('mrc721_sell_intent refuses BTC-side writes before any control call', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_sell_intent.handler({ item_pin_id: PINID, network: 'btc' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /BTC-side writes are not supported/);
  assert.equal(calls.sellIntentDeclare.length, 0);
});

test('mrc721_sell_intent surfaces the holder-view refusal from the service', async () => {
  const { calls, byName } = makeHarness({ sellIntentError: new Error('item abcd…i0 is held by 1SomeoneElse, not by the declaring bot') });
  const result = await byName.mrc721_sell_intent.handler({ item_pin_id: PINID });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not by the declaring bot/);
  assert.equal(calls.sellIntentDeclare.length, 1);
});

test('mrc721_sell_intent_cancel renders the cancellation receipt', async () => {
  const { calls, byName } = makeHarness();
  const result = await byName.mrc721_sell_intent_cancel.handler({ item_pin_id: PINID });
  assert.equal(result.isError, undefined);
  assert.equal(calls.sellIntentCancel.length, 1);
  assert.match(result.content[0].text, /sell intent cancelled/);
  assert.match(result.content[0].text, /active=false/);
});

test('mrc721_sell_intents renders statuses with honest stale reasons', async () => {
  const { byName } = makeHarness({
    sellIntents: [
      { id: 'i1', itemPinId: PINID, status: 'active', intent: { itemPinId: PINID, priceHintSats: 30000, acceptedCurrencies: ['space'], note: 'cheap' }, sellPinId: SELL_PIN_ID },
      { id: 'i2', itemPinId: `${'ff'.repeat(32)}i0`, status: 'stale', reason: 'the item is no longer held by the seller address', intent: { itemPinId: `${'ff'.repeat(32)}i0`, acceptedCurrencies: ['space'] }, sellPinId: SELL_PIN_ID },
      { id: 'i3', itemPinId: `${'ee'.repeat(32)}i0`, status: 'cancelled', intent: { itemPinId: `${'ee'.repeat(32)}i0`, acceptedCurrencies: ['space'] } },
    ],
  });
  const result = await byName.mrc721_sell_intents.handler({});
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /3 sell intent\(s\)/);
  assert.match(result.content[0].text, /ACTIVE/);
  assert.match(result.content[0].text, /STALE/);
  assert.match(result.content[0].text, /no longer held by the seller/);
  assert.match(result.content[0].text, /CANCELLED/);
});

test('mrc721_sell_orders filters by collection through the indexer item view', async () => {
  const { byName } = makeHarness({
    sellOrders: [
      { id: 'o1', status: 'valid', itemPinId: PINID, buyerAddress: OTHER_ADDRESS, priceSats: 22000, outpoint: `${'ab'.repeat(32)}:0` },
      { id: 'o2', status: 'valid', itemPinId: `${'ff'.repeat(32)}i0`, buyerAddress: OTHER_ADDRESS, priceSats: 30000, outpoint: `${'ff'.repeat(32)}:1` },
    ],
  });
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/item/info', (raw) => jsonResponse({
        code: 1,
        data: { itemPinId: PINID, collectionName: String(raw).includes('ff'.repeat(8)) ? 'other-cats' : 'pixel-cats' },
      })],
    ]),
    () => byName.mrc721_sell_orders.handler({ collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Local MRC-721 listings \(1\)/);
  assert.doesNotMatch(result.content[0].text, /30000 sats/);
});

test('mrc721_market_intents renders indexer sell intents with settlement rails', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/sell/intents', () => jsonResponse({
        code: 1,
        data: {
          list: [{
            itemPinId: PINID,
            sellPinId: SELL_PIN_ID,
            active: true,
            collectionName: 'pixel-cats',
            sellerAddress: OTHER_ADDRESS,
            priceHintSats: 30000,
            acceptedCurrencies: ['space', 'fiat:CNY'],
            settlement: ['atomic-swap', 'escrow'],
            note: 'open to offers',
          }],
          total: 1,
        },
      })],
    ]),
    () => byName.mrc721_market_intents.handler({ collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /ACTIVE/);
  assert.match(result.content[0].text, /30000 sats/);
  assert.match(result.content[0].text, /space,fiat:CNY/);
  assert.match(result.content[0].text, /atomic-swap\/escrow/);
  assert.match(result.content[0].text, new RegExp(SELL_PIN_ID));
});

test('mrc721_market_intents degrades honestly when the indexer lacks the endpoint', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    async () => new Response('404 page not found', { status: 404 }),
    () => byName.mrc721_market_intents.handler({ collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /the MetaSo indexer does not serve sell-intent queries/);
  assert.match(result.content[0].text, /check the MetaSo deployment/);
});

// ---------------------------------------------------------------------------
// MetaSo base wiring (indexing architecture: MetaSo serves NFT business
// indexes when IDBOTS_METASO_API_BASE is set)
// ---------------------------------------------------------------------------

test('mrc721_market_intents prefers the configured MetaSo base for sell-intent reads', async () => {
  process.env.IDBOTS_METASO_API_BASE = 'http://metaso.test:8080/';
  try {
    const { byName } = makeHarness();
    const seen = [];
    const result = await withFetchStub(
      async (url) => {
        seen.push(String(url));
        return jsonResponse({
          code: 1,
          data: { list: [{ itemPinId: PINID, sellPinId: SELL_PIN_ID, active: true, sellerAddress: OTHER_ADDRESS, priceHintSats: 30000, acceptedCurrencies: ['space'], settlement: ['atomic-swap', 'escrow'] }], total: 1 },
        });
      },
      () => byName.mrc721_market_intents.handler({ collection_name: 'pixel-cats' }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(seen.length >= 1);
    assert.ok(seen[0].startsWith('http://metaso.test:8080/api/mrc721/sell/intents'), `expected metaso base, got ${seen[0]}`);
    assert.match(result.content[0].text, /ACTIVE/);
  } finally {
    delete process.env.IDBOTS_METASO_API_BASE;
  }
});

test('mrc721_search_collections uses the MetaSo server-side search when configured and degrades on error', async () => {
  process.env.IDBOTS_METASO_API_BASE = 'http://metaso.test:8080';
  try {
    const { byName } = makeHarness();
    const seen = [];
    const result = await withFetchStub(
      async (url) => {
        seen.push(String(url));
        if (String(url).includes('/api/mrc721/collection/search')) {
          return jsonResponse({ code: 1, data: { list: [collectionRow()], total: 1 } });
        }
        return jsonResponse({ code: 1, data: { list: [] } });
      },
      () => byName.mrc721_search_collections.handler({ keyword: 'pixel' }),
    );
    assert.equal(result.isError, undefined);
    assert.ok(seen.some((url) => url.includes('/api/mrc721/collection/search')));
    assert.match(result.content[0].text, /matched: 1/);
    assert.match(result.content[0].text, /scanned 1 registered collection/);

    // Transport error → degrade to the client-side pageList scan.
    const seen2 = [];
    const result2 = await withFetchStub(
      async (url) => {
        seen2.push(String(url));
        if (String(url).includes('/api/mrc721/collection/search')) {
          throw new Error('connection refused');
        }
        return jsonResponse({ code: 1, data: { list: [collectionRow()] } });
      },
      () => byName.mrc721_search_collections.handler({ keyword: 'pixel' }),
    );
    assert.equal(result2.isError, undefined);
    assert.ok(seen2.some((url) => url.includes('/api/mrc721/collection/pageList')), 'must fall back to pageList');
    assert.match(result2.content[0].text, /matched: 1/);
  } finally {
    delete process.env.IDBOTS_METASO_API_BASE;
  }
});

test('mrc721_search_collections serves supply state from MetaSo rows without item paging', async () => {
  process.env.IDBOTS_METASO_API_BASE = 'http://metaso.test:8080';
  try {
    const { byName } = makeHarness();
    const seen = [];
    const result = await withFetchStub(
      async (url) => {
        seen.push(String(url));
        if (String(url).includes('/api/mrc721/collection/search')) {
          return jsonResponse({
            code: 1,
            data: { list: [collectionRow({ totalnum: 10, mintedCount: 10 })], total: 1 },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      },
      () => byName.mrc721_search_collections.handler({ issuer: 'AI_Sunny', supply_state: true }),
    );
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /minted: 10\/10 \(supply exhausted\)/);
    assert.ok(!seen.some((url) => url.includes('items/pageList')), 'server rows must remove the need for per-collection item paging');
  } finally {
    delete process.env.IDBOTS_METASO_API_BASE;
  }
});

// ---------------------------------------------------------------------------
// Issuer-only protocol revision (2026-11-07): acceptance §6.4 string audit —
// no pre-revision minting semantics survive in the agent-facing surface.
// ---------------------------------------------------------------------------

test('no pre-revision minting semantics survive in the mrc721 surface copy', async () => {
  const { readFileSync } = await import('node:fs');
  const sources = [
    new URL('../dist-electron/main/libs/mrc721AgentTools.js', import.meta.url),
    new URL('../dist-electron/main/services/mrc721Service.js', import.meta.url),
  ];
  const banned = [
    /first registration wins globally/i,
    /first-registration-wins/i,
    /open minting/i,
    /any create pin under the collection mints/i,
    /globally unique/i,
  ];
  for (const file of sources) {
    const text = readFileSync(file, 'utf8');
    for (const pattern of banned) {
      assert.doesNotMatch(text, pattern, `${file.pathname} must not carry pre-revision wording (${pattern})`);
    }
  }
});

// -------------------------------------------------------------------------
// mrc721_item_desc_batch + mrc721_issue_estimate (issue wizard tooling)
// -------------------------------------------------------------------------

test('mrc721_item_desc_batch broadcasts through control and appends one card per item', async () => {
  const { calls, byName } = makeHarness();
  const itemA = `${'11'.repeat(32)}i0`;
  const itemB = `${'22'.repeat(32)}i0`;
  const result = await byName.mrc721_item_desc_batch.handler({
    collection_name: 'pixel-cats',
    items: [
      { pin_id: itemA, name: 'Cat #1', desc: 'first', cover: `${'33'.repeat(32)}i0` },
      { pin_id: itemB, name: 'Cat #2' },
    ],
  });
  assert.equal(result.isError, undefined);
  assert.equal(calls.itemDescBatch.length, 1);
  assert.deepEqual(calls.itemDescBatch[0].items[0], {
    pinId: itemA, name: 'Cat #1', desc: 'first', cover: `${'33'.repeat(32)}i0`, metadata: undefined,
  });
  const text = result.content[0].text;
  assert.match(text, /item_desc batch broadcast for collection "pixel-cats" \(2 items referenced\)/);
  assert.match(text, /per-field first-write-wins/);
  assert.equal((text.match(/```nft-card\n/g) || []).length, 2);
  assert.match(text, /Cat #1/);
  assert.match(text, /Cat #2/);
});

test('mrc721_item_desc_batch relays control failures loudly', async () => {
  const { byName } = makeHarness({ itemDescBatchError: new Error('insufficient balance') });
  const result = await byName.mrc721_item_desc_batch.handler({
    collection_name: 'pixel-cats',
    items: [{ pin_id: `${'11'.repeat(32)}i0` }],
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mrc721_item_desc_batch failed: insufficient balance/);
});

test('mrc721_issue_estimate returns the dry-run write plan without broadcasting', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [], total: 0 } })],
    ]),
    () => byName.mrc721_issue_estimate.handler({
      collection_name: 'pixel-cats',
      total_supply: 10,
      royalty_rate: 0,
      items: [{ name: 'Cat #1' }, { name: 'Cat #2' }],
    }),
  );
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /Fee estimate \(dry run\) for "pixel-cats"/);
  assert.match(text, /collection_desc @ \/nft\/mrc721\/pixel-cats\/collection_desc/);
  assert.match(text, /item_desc @ \/nft\/mrc721\/pixel-cats\/item_desc/);
  assert.match(text, /TOTAL est ~\d+ sats \(UPPER BOUND/);
  assert.match(text, /immutable once registered/);
});

test('mrc721_issue_estimate refuses the session bot\'s own duplicate registration', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [collectionRow()], total: 1 } })],
    ]),
    () => byName.mrc721_issue_estimate.handler({ collection_name: 'pixel-cats' }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already issued by this MetaBot/);
});

test('mrc721_issue_estimate surfaces invalid fields before any fee is spent', async () => {
  const { byName } = makeHarness();
  const result = await byName.mrc721_issue_estimate.handler({
    collection_name: 'pixel-cats',
    total_supply: 1.5,
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /integer in \[-1, 1e12\]/);
});

// -------------------------------------------------------------------------
// Zero-confirmation fallbacks + estimate uploads/balance
// -------------------------------------------------------------------------

function rawPinRow(overrides = {}) {
  return {
    id: DESC_PINID,
    path: '/nft/mrc721/pixel-cats/collection_desc',
    operation: 'create',
    address: BOT_ADDRESS,
    genesisHeight: -1,
    contentBody: Buffer.from(JSON.stringify({ name: 'Pixel Cats', totalSupply: 5 })).toString('base64'),
    ...overrides,
  };
}

test('mrc721_collection_info reports a mempool registration as on-chain, pending block', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/info', () => jsonResponse({ code: 100, data: null })],
      [`/api/pin/${DESC_PINID}`, () => jsonResponse({ code: 1, data: rawPinRow() })],
    ]),
    () => byName.mrc721_collection_info.handler({ pin_id: DESC_PINID }),
  );
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /ON-CHAIN, PENDING BLOCK/);
  assert.match(text, /Do NOT wait, poll, or re-issue/);
  assert.match(text, /genesisHeight: -1 \(mempool\)/);
  assert.match(text, /"totalSupply":5/);
});

test('mrc721_collection_info keeps a real miss an error and asks for the collectionid on name-only misses', async () => {
  const { byName } = makeHarness();
  const bad = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/collection/info', () => jsonResponse({ code: 100, data: null })],
      [`/api/pin/${DESC_PINID}`, () => jsonResponse({ code: 404, data: null })],
    ]),
    () => byName.mrc721_collection_info.handler({ pin_id: DESC_PINID }),
  );
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not on-chain as a collection_desc pin/);

  const byNameOnly = await withFetchStub(
    manapiDispatch([['/api/mrc721/collection/info', () => jsonResponse({ code: 100, data: null })]]),
    () => byName.mrc721_collection_info.handler({ name: 'pixel-cats' }),
  );
  assert.equal(byNameOnly.isError, true);
  assert.match(byNameOnly.content[0].text, /pass pin_id/);
});

test('mrc721_item_info reports a mempool mint as on-chain, pending block, and refuses foreign kinds', async () => {
  const { byName } = makeHarness();
  const mint = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/item/info', () => jsonResponse({ code: 100, data: null })],
      [`/api/pin/${PINID}`, () => jsonResponse({ code: 1, data: rawPinRow({ id: PINID, path: '/nft/mrc721/pixel-cats/frame-1', contentBody: Buffer.from('{}').toString('base64') }) })],
    ]),
    () => byName.mrc721_item_info.handler({ pin_id: PINID }),
  );
  assert.equal(mint.isError, undefined);
  assert.match(mint.content[0].text, /item under "pixel-cats": ON-CHAIN, PENDING BLOCK/);

  // A collection_desc pinId passed to item_info is not an item.
  const wrongKind = await withFetchStub(
    manapiDispatch([
      ['/api/mrc721/item/info', () => jsonResponse({ code: 100, data: null })],
      [`/api/pin/${PINID}`, () => jsonResponse({ code: 1, data: rawPinRow({ id: PINID }) })],
    ]),
    () => byName.mrc721_item_info.handler({ pin_id: PINID }),
  );
  assert.equal(wrongKind.isError, true);
});

test('formatMrc721PendingPinSheet distinguishes confirmed-but-unindexed from mempool', () => {
  const sheet = formatMrc721PendingPinSheet({
    kind: 'collection',
    pin: { pinId: DESC_PINID, path: '/nft/mrc721/pixel-cats/collection_desc', operation: 'create', address: BOT_ADDRESS, genesisHeight: 197805, confirmed: true, content: '{}' },
  });
  assert.match(sheet, /CONFIRMED \(height 197805\)/);
  assert.match(sheet, /indexing lag/);
  assert.equal(formatMrc721PendingPinSheet({
    kind: 'collection',
    pin: { pinId: DESC_PINID, path: '/protocols/simplebuzz', operation: 'create', address: BOT_ADDRESS, genesisHeight: -1, confirmed: false, content: '' },
  }), null, 'non-MRC-721 pins never render as pending sheets');
});

test('mrc721_issue_estimate prices upload files from disk and shows the balance line', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'mrc721-est-'));
  try {
    const fileA = pathMod.join(dir, 'a.jpg');
    fs.writeFileSync(fileA, Buffer.alloc(10_000));
    const { byName, control } = makeHarness();
    control.getMvcSpendableSats = async () => 1_000;
    const result = await withFetchStub(
      manapiDispatch([
        ['/api/mrc721/collection/search', () => jsonResponse({ code: 1, data: { list: [], total: 0 } })],
      ]),
      () => byName.mrc721_issue_estimate.handler({
        collection_name: 'pixel-cats',
        items: [{ name: 'Cat #1' }],
        upload_files: [fileA, pathMod.join(dir, 'missing.jpg')],
      }),
    );
    assert.equal(result.isError, undefined);
    const text = result.content[0].text;
    assert.match(text, /upload a\.jpg — payload 10000 B/);
    assert.match(text, /file uploads: ~\d+ sats/);
    assert.match(text, /UPPER BOUND, uploads included/);
    assert.match(text, /NOT priced \(unreadable files\): .*missing\.jpg/);
    assert.match(text, /wallet: 1000 sats spendable — INSUFFICIENT/);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
});
