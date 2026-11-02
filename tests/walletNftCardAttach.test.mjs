// S3 chat NFT cards: the wallet NFT action tools (transfer / sell / buy /
// cancel_sell) must append a `nft-card` fenced block to their success results
// so the bot's broadcast message automatically carries a renderable card.
// Dual-format contract: every wallet_* emit carries format:"metacontract";
// a transfer to a locally-known bot name prefills ownerLabel (the emitter
// already knows the name — renderer identity lookup is the fallback, not the
// primary).
// Enrichment (name/series/icon/imgUrl) comes from a best-effort wallet-api
// snapshot via control.listMvcNfts; any failure degrades to an identity-only
// card, never to a missing card or a failed action.

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function loadWalletAgentTools() {
  const originalLoad = Module._load;
  Module._load = function patchedModuleLoad(request, parent, isMain) {
    if (request === 'electron') {
      return { app: { getPath: () => '/tmp', getAppPath: () => process.cwd() } };
    }
    return originalLoad(request, parent, isMain);
  };
  try {
    const path = require.resolve('../dist-electron/main/libs/walletAgentTools.js');
    delete require.cache[path];
    return require(path);
  } finally {
    Module._load = originalLoad;
  }
}

const GENESIS = '2b5f8a84150a74a488f6fff1eee9651ee0eb9eee';
const CODEHASH = 'e205939ad9956673ce7da9fbd40514b30f66dc35';

const balanceSnapshot = (address) => ({
  address,
  count: 1,
  collections: [
    {
      genesis: GENESIS,
      codeHash: CODEHASH,
      seriesName: 'Metabot Gen 2',
      count: 1,
      items: [
        {
          tokenIndex: '5028',
          name: '小明',
          satoshi: 4101,
          txId: 'd4b3d1de5050aa822f14ae0146c607d254db1657c96dfa75f960bdba615a0cba',
          outputIndex: 0,
          height: 195000,
          icon: 'metafile://fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg',
          imgUrl: 'https://metalet.space/metafile/compress/fa43f1b55ca7cec99750bfec6d9d7f71f5951e367cd53368035d3ecc82721dec.jpg',
        },
      ],
    },
  ],
});

function createHarness({ listMvcNftsError = false } = {}) {
  const tools = [];
  const handlers = {};
  const tool = (name, description, schema, handler) => {
    tools.push(name);
    handlers[name] = { description, schema, handler };
    return { name };
  };
  const calls = { listMvcNfts: [] };
  const control = {
    getBalances: async () => ({ entries: [], queried_at: '2026-11-02T00:00:00.000Z' }),
    getBalanceForAddress: async (chain, address) => ({ chain, address, unit: 'SPACE', confirmed_sats: 0, unconfirmed_sats: 0, total_sats: 0, utxo_count: 0 }),
    resolveMetabotIdByName: (name) => (name === 'AI_Sunny' ? 1 : null),
    getMetabotMvcAddress: (id) => (id === 15 ? '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' : id === 1 ? '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za' : null),
    transfer: async () => ({ success: true, txid: 'tx-1', fee_sats: 200, channel: 'local' }),
    listTransfers: () => [],
    listMvcNfts: async (input) => {
      calls.listMvcNfts.push(input);
      if (listMvcNftsError) throw new Error('indexer down');
      const address = input.address?.trim();
      if (!address) return [];
      return [{ metabotId: null, address, balance: balanceSnapshot(address) }];
    },
    transferNft: async (params) => {
      calls.lastTransferNft = params;
      return { txId: 'aa'.repeat(32) };
    },
    sellNft: async (params) => {
      calls.lastSellNft = params;
      return { txId: 'bb'.repeat(32), fundingTxId: 'cc'.repeat(32) };
    },
    cancelNftSell: async (params) => {
      calls.lastCancelNftSell = params;
      return { txId: 'dd'.repeat(32), fundingTxId: 'ee'.repeat(32) };
    },
    buyNft: async (params) => {
      calls.lastBuyNft = params;
      return { txId: 'ff'.repeat(32), fundingTxId: '11'.repeat(32) };
    },
  };
  return { tool, handlers, control, calls };
}

const CARD_FENCE_RE = /```nft-card\n(\{[^\n]*\})\n```/;

const extractCardJson = (text) => {
  const match = text.match(CARD_FENCE_RE);
  assert.ok(match, `result must contain an nft-card fence:\n${text}`);
  return JSON.parse(match[1]);
};

const buildTools = (harness) => {
  const { buildWalletAgentTools } = loadWalletAgentTools();
  buildWalletAgentTools({
    tool: harness.tool,
    control: harness.control,
    sessionId: 's1',
    resolveMetabotId: () => 15,
  });
};

test('wallet_nft_transfer appends an enriched transferred card with the recipient as owner', async () => {
  const harness = createHarness();
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_transfer.handler({
    to: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /NFT transfer broadcast on-chain\./);
  assert.match(text, /include this fenced block verbatim/i);
  // Facts snapshot comes from the SENDER wallet (pre-action), owner is the recipient.
  assert.deepEqual(harness.calls.listMvcNfts, [{ address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }]);
  const card = extractCardJson(text);
  assert.equal(card.format, 'metacontract', 'wallet emits carry the explicit format');
  assert.equal(card.genesis, GENESIS);
  assert.equal(card.codehash, CODEHASH);
  assert.equal(card.tokenIndex, '5028');
  assert.equal(card.name, '小明');
  assert.equal(card.series, 'Metabot Gen 2');
  assert.equal(card.owner, '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za');
  assert.equal(card.ownerLabel, undefined, 'a raw-address recipient has no known label');
  assert.equal(card.action, 'transferred');
  assert.ok(card.imgUrl.startsWith('https://'));
  assert.ok(card.icon.startsWith('metafile://'));
  // Key order is the pinned cross-side contract (renderer parses the same shape).
  assert.equal(Object.keys(card).join(','), 'format,genesis,codehash,tokenIndex,name,series,imgUrl,icon,owner,action');
});

test('wallet_nft_transfer to a local bot name prefills the recipient label', async () => {
  const harness = createHarness();
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_transfer.handler({
    to: 'AI_Sunny',
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
  });
  assert.equal(result.isError, undefined);
  const card = extractCardJson(result.content[0].text);
  assert.equal(card.format, 'metacontract');
  assert.equal(card.owner, '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za');
  assert.equal(card.ownerLabel, 'AI_Sunny', 'emitter-known name rides the fence');
  assert.equal(card.action, 'transferred');
  assert.equal(
    Object.keys(card).join(','),
    'format,genesis,codehash,tokenIndex,name,series,imgUrl,icon,owner,ownerLabel,action',
  );
});

test('wallet_nft_transfer degrades to an identity-only card when the snapshot fails', async () => {
  const harness = createHarness({ listMvcNftsError: true });
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_transfer.handler({
    to: 'AI_Sunny',
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
  });
  assert.equal(result.isError, undefined);
  const card = extractCardJson(result.content[0].text);
  assert.equal(card.format, 'metacontract');
  assert.equal(card.name, undefined);
  assert.equal(card.series, undefined);
  assert.equal(card.imgUrl, undefined);
  assert.equal(card.owner, '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za');
  assert.equal(card.action, 'transferred');
});

test('wallet_nft_sell appends a listed card carrying the ask price and the seller as owner', async () => {
  const harness = createHarness();
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_sell.handler({
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
    price_sats: 100000,
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /NFT listed for sale on-chain\./);
  // Pre-action snapshot: fetched before the listing broadcast.
  assert.deepEqual(harness.calls.listMvcNfts, [{ address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }]);
  const card = extractCardJson(text);
  assert.equal(card.format, 'metacontract');
  assert.equal(card.action, 'listed');
  assert.equal(card.priceSats, 100000);
  assert.equal(card.owner, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
  assert.equal(card.name, '小明');
});

test('wallet_nft_buy appends a bought card with the ask price and the buyer as owner', async () => {
  const harness = createHarness();
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_buy.handler({
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
    sell_txid: 'ab'.repeat(32),
    sell_output_index: 0,
    seller_address: '1GrqX7K9jdnUor8hAoAfDx99uFH2tT75Za',
    sell_price_sats: 100000,
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /NFT purchase broadcast on-chain\./);
  // Post-action snapshot from the buyer's own wallet doubles as the
  // ownership-change check.
  assert.deepEqual(harness.calls.listMvcNfts, [{ address: '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx' }]);
  const card = extractCardJson(text);
  assert.equal(card.format, 'metacontract');
  assert.equal(card.action, 'bought');
  assert.equal(card.priceSats, 100000);
  assert.equal(card.owner, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
});

test('wallet_nft_cancel_sell appends a delisted card without a price', async () => {
  const harness = createHarness();
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_cancel_sell.handler({
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
  });
  assert.equal(result.isError, undefined);
  const text = result.content[0].text;
  assert.match(text, /NFT sell order cancelled on-chain\./);
  const card = extractCardJson(text);
  assert.equal(card.format, 'metacontract');
  assert.equal(card.action, 'delisted');
  assert.equal(card.priceSats, undefined);
  assert.equal(card.owner, '1AxUdSkVdDyDreYSYVoDRFeyS1pvQdvcJx');
});

test('failure results never carry a card and never break the action error path', async () => {
  const harness = createHarness();
  harness.control.sellNft = async () => { throw new Error('insufficient funding utxo'); };
  buildTools(harness);
  const result = await harness.handlers.wallet_nft_sell.handler({
    genesis: GENESIS,
    codehash: CODEHASH,
    token_index: '5028',
    price_sats: 100000,
  });
  assert.equal(result.isError, true);
  assert.doesNotMatch(result.content[0].text, CARD_FENCE_RE);
});
