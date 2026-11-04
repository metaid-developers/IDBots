import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let nftService;
try {
  nftService = require('../dist-electron/main/services/metabotNftService.js');
} catch {
  nftService = null;
}

const mrc721Item = (overrides = {}) => ({
  itemPinId: 'aaaa…i0',
  collectionName: 'sunny-cats',
  number: 1,
  name: 'Sunny Cat',
  cover: 'metafile://bbbb…i0',
  createTime: 1000,
  ...overrides,
});

test('buildMrc721NftItems filters burned items and sorts by mint time descending', () => {
  const items = nftService.buildMrc721NftItems([
    mrc721Item({ itemPinId: 'old…i0', createTime: 100, number: 3, burned: true }),
    mrc721Item({ itemPinId: 'mid…i0', createTime: 300, number: 2 }),
    mrc721Item({ itemPinId: 'new…i0', createTime: 500, number: 1 }),
  ]);

  assert.deepEqual(items.map((item) => item.key), ['new…i0', 'mid…i0']);
  assert.equal(items[0].kind, 'mrc721');
  assert.equal(items[0].name, 'Sunny Cat');
  assert.equal(items[0].collectionName, 'sunny-cats');
  assert.equal(items[0].imageRef, 'metafile://bbbb…i0');
  assert.equal(items[0].number, 1);
  assert.equal(items[0].raw.itemPinId, 'new…i0');
});

test('buildMrc721NftItems falls back to a #number name when the item has no name', () => {
  const [item] = nftService.buildMrc721NftItems([mrc721Item({ name: '', number: 7 })]);
  assert.equal(item.name, '#7');
});

test('buildMetaContractNftItems flattens per-series groups and sorts by acquiring height', () => {
  const items = nftService.buildMetaContractNftItems([
    {
      genesis: 'gen-1',
      codeHash: 'hash-1',
      seriesName: 'Series One',
      tokenSupply: 100,
      count: 2,
      items: [
        { tokenIndex: '1', name: 'One', satoshi: 1000, txId: 'tx-1', outputIndex: 0, height: 100 },
        { tokenIndex: '5', name: 'Five', satoshi: 1000, txId: 'tx-5', outputIndex: 0, height: 400 },
      ],
    },
    {
      genesis: 'gen-2',
      codeHash: 'hash-2',
      seriesName: '',
      count: 1,
      items: [
        { tokenIndex: '9', name: '', satoshi: 22000, txId: 'tx-9', outputIndex: 0, height: 400, imgUrl: 'https://img/x.png' },
      ],
    },
  ]);

  // Same height 400: higher tokenIndex first; gen-2 #9 precedes gen-1 #5.
  assert.deepEqual(items.map((item) => item.key), ['gen-2:9', 'gen-1:5', 'gen-1:1']);
  assert.equal(items[0].kind, 'metacontract');
  assert.equal(items[0].name, '#9');
  assert.equal(items[0].imageUrl, 'https://img/x.png');
  assert.equal(items[2].collectionName, 'Series One');
  assert.equal(items[2].raw.genesis, 'gen-1');
  assert.equal(items[2].raw.codeHash, 'hash-1');
  assert.equal(items[2].raw.seriesName, 'Series One');
});

test('getMetabotNftItems pages the MRC721 holder endpoint and caps the loop', async () => {
  const fakeStore = {
    getMetabotById: (id) => (id === 7 ? { id, name: 'bot', mvc_address: 'mvc-addr' } : null),
  };
  let calls = 0;
  const items = await nftService.getMetabotNftItems(
    fakeStore,
    { metabotId: 7, kind: 'mrc721' },
    {
      fetchAddressItemsPage: async ({ cursor }) => {
        calls += 1;
        assert.equal(cursor, calls === 1 ? undefined : `cursor-${calls - 1}`);
        return {
          items: Array.from({ length: 100 }, (_, index) =>
            mrc721Item({ itemPinId: `pin-${calls}-${index}…i0`, createTime: 1000 - index })),
          cursor: `cursor-${calls}`,
        };
      },
      fetchMvcNftBalance: async () => { throw new Error('should not be called'); },
    },
  );

  assert.equal(calls, 5);
  assert.equal(items.length, 500);
  // Newest mint first across page boundaries.
  assert.equal(items[0].createTime, 1000);
});

test('getMetabotNftItems returns flattened metacontract items', async () => {
  const fakeStore = {
    getMetabotById: (id) => (id === 7 ? { id, name: 'bot', mvc_address: 'mvc-addr' } : null),
  };
  const items = await nftService.getMetabotNftItems(
    fakeStore,
    { metabotId: 7, kind: 'metacontract' },
    {
      fetchAddressItemsPage: async () => { throw new Error('should not be called'); },
      fetchMvcNftBalance: async (address) => {
        assert.equal(address, 'mvc-addr');
        return {
          address,
          count: 1,
          collections: [{
            genesis: 'gen-1',
            codeHash: 'hash-1',
            seriesName: 'Series One',
            count: 1,
            items: [{ tokenIndex: '2', name: 'Two', satoshi: 1000, txId: 'tx-2', outputIndex: 0, height: 55 }],
          }],
        };
      },
    },
  );

  assert.deepEqual(items.map((item) => item.key), ['gen-1:2']);
  assert.equal(items[0].collectionName, 'Series One');
  assert.equal(items[0].height, 55);
});

test('getMetabotNftItems validates inputs and a missing MVC address', async () => {
  const missingStore = { getMetabotById: () => null };
  const emptyAddressStore = { getMetabotById: (id) => ({ id, name: 'bot', mvc_address: '' }) };

  await assert.rejects(
    () => nftService.getMetabotNftItems(missingStore, { metabotId: 0, kind: 'mrc721' }, {}),
    /metabotId/,
  );
  await assert.rejects(
    () => nftService.getMetabotNftItems(missingStore, { metabotId: 7, kind: 'bad-kind' }, {}),
    /kind/,
  );
  await assert.rejects(
    () => nftService.getMetabotNftItems(emptyAddressStore, { metabotId: 7, kind: 'mrc721' }, {}),
    /MVC address/,
  );
});

test('transferMetabotMvcNft / transferMetabotMrc721 pass through to the underlying services', async () => {
  // Both wrappers delegate; the real transfer math is covered by the
  // mvcNftService / mrc721Service suites. Here we assert wiring via module
  // exports so a rename fails loudly.
  assert.equal(typeof nftService.transferMetabotMvcNft, 'function');
  assert.equal(typeof nftService.transferMetabotMrc721, 'function');
});
