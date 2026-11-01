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
  formatMrc721TransferResult,
  formatMrc721ItemDetail,
  formatMrc721Items,
  formatMrc721Transfers,
} = require('../dist-electron/main/libs/mrc721AgentTools.js');

process.env.IDBOTS_MAN_P2P_LOCAL_BASE && delete process.env.IDBOTS_MAN_P2P_LOCAL_BASE;

const PINID = `${'ab'.repeat(32)}i0`;
const DESC_PINID = `${'cd'.repeat(32)}i0`;
const BOT_ADDRESS = '1SessionBotAddress1234';
const OTHER_ADDRESS = '1OtherBotAddress5678';

const TOOL_NAMES = [
  'mrc721_collection_create',
  'mrc721_collection_update',
  'mrc721_mint',
  'mrc721_transfer',
  'mrc721_balance',
  'mrc721_collections',
  'mrc721_item_info',
  'mrc721_collection_info',
];

function makeHarness(overrides = {}) {
  const calls = { collectionCreate: [], collectionUpdate: [], mint: [], transfer: [] };
  const control = {
    getMetabotMvcAddress: (id) => (id === 1 ? BOT_ADDRESS : id === 15 ? OTHER_ADDRESS : null),
    resolveMetabotIdByName: (name) => (name === 'AI_Sunny' ? 1 : null),
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

test('registers the seven R6 mrc721_* tools', () => {
  const { byName } = makeHarness();
  for (const name of TOOL_NAMES) {
    assert.ok(byName[name], `${name} should be registered`);
    assert.ok(String(byName[name].description).includes('MRC-721'), `${name} description names the lineage`);
  }
});

test('mrc721_collection_create refuses a taken name before any write', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    async () => jsonResponse({ code: 1, data: { collectionName: 'pixel-cats', pinid: DESC_PINID, createAddress: '1Issuer' } }),
    () => byName.mrc721_collection_create.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /already registered/);
  assert.equal(calls.collectionCreate.length, 0);
});

test('mrc721_collection_create broadcasts on a miss and renders the receipt', async () => {
  const { calls, byName } = makeHarness();
  const result = await withFetchStub(
    async () => jsonResponse({ code: 0, message: 'not found' }),
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

test('mrc721_mint refuses an exhausted collection and warns on unregistered ones', async () => {
  const { calls, byName } = makeHarness();
  const exhausted = await withFetchStub(
    async () => jsonResponse({ code: 1, data: { collectionName: 'pixel-cats', totalSupply: 10, totalnum: 10, pinid: DESC_PINID } }),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(exhausted.isError, true);
  assert.match(exhausted.content[0].text, /exhausted/);
  assert.equal(calls.mint.length, 0);

  const unregistered = await withFetchStub(
    async () => jsonResponse({ code: 0, message: 'not found' }),
    () => byName.mrc721_mint.handler({ collection_name: 'pixel-cats', wait_ms: 0 }),
  );
  assert.equal(unregistered.isError, undefined);
  assert.match(unregistered.content[0].text, /not indexed yet|confirmation wait skipped/);
  assert.equal(calls.mint.length, 1);
});

test('mrc721_mint renders the item receipt with the item_desc pin', async () => {
  const { byName } = makeHarness();
  const result = await withFetchStub(
    async () => jsonResponse({ code: 1, data: { collectionName: 'pixel-cats', totalSupply: -1, totalnum: 0, pinid: DESC_PINID } }),
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
  assert.match(createReceipt, /first-registration-wins/);
  assert.match(createReceipt, /mrc721_collection_info/);

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
  assert.match(detail, /third-party mint/);
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
